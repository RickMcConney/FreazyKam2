import { generatePeckDrill, generateHelicalDrills, type HoleSpec } from './drill'
import { perfLog } from '../debug'
import { runInWorkerFor } from '../workers/workerClient'
import { useToolpathStore } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { tabsForGeneration } from '../store/tabStore'
import { getBBox, extractCircles, extractRectInfo } from '../canvas/selectionUtils'
import { loadImageLuminance } from '../io/imageLuminance'
import { decodeStlMesh } from '../importers/stlImporter'
import { effectiveStepDownMM, trochoidalEngagementFraction } from './feeds'
import { resolveStartZForOp } from './startHeight'
import type { GenNote } from './notes'
import { useUIStore } from '../store/uiStore'

// ONE PLACE THAT TURNS A STORED OPERATION INTO ITS GENERATOR CALL.
//
// There used to be three copies per operation type: the automatic regenerate, and each
// form's Generate twice over (its edit branch and its new-op branch), each building the
// same argument object by hand from its own state. Every new parameter had to be threaded
// through all three and they drifted: the forms passed no holding tabs to profile and
// trochoidal (a re-Generate cut the part free), the new-op branches forgot the entry
// hint, the pocket edit branch never wrote `autoAngle` back, and a profile's start height
// was resolved with a cut margin the stamp compared against did not use.
//
// So a form now does what regenerate always did: WRITE the settings onto the operation,
// then generate from the operation. Whatever the toolpath was built from is, by
// construction, what the operation says — which is what an automatic regenerate, an
// export check and the undo history all assume.

/**
 * The worker key an inlay job runs under: ONE key for both halves of a linked pair.
 *
 * One generation produces both phases and writes BOTH ops (below). The pool serializes jobs
 * per key so a newer generation always lands after an older one — but keyed by the op id,
 * that held for the half that was asked for and not for the one written alongside it. A
 * stale generation of one half could finish after a fresh one of the other and write old
 * settings over both, marked done. Sharing the key puts every generation of the pair in one
 * queue. Pinned by `npx vite-node scripts/inlay-pair-race.mts`.
 */
export function inlayJobKey(op: { id: string; linkedOpId?: string }): string {
  return op.linkedOpId ? `inlay-pair:${[op.id, op.linkedOpId].sort()[0]}` : op.id
}

/**
 * Put a generation's notes on the status bar — for callers that have no banner of their
 * own to say it in. No op-name prefix: StatusBar truncates, and a name like
 * 'Pocket: Path 1 (1/8" End Mill)' would consume the whole line before the note starts.
 */
export function showGenNotes(notes: GenNote[]): void {
  for (const note of notes) useUIStore.getState().showStatus(note.short, 'warn')
}

export interface GenerateOverrides {
  /** Alt-click on PocketForm: run the chosen strategy on a shape it would decline. Not a
   *  setting — an override of a measured verdict for this one Generate. */
  forceStrategy?: boolean
}

export interface GenerateResult {
  /** What the generator skipped or substituted (see cam/notes.ts) — a pocket strategy
   *  that fell back, a v-carve region or inlay sub-cut too small to cut. The CALLER says
   *  so: a form in its own banner, an automatic regenerate on the status bar. */
  notes: GenNote[]
}

/**
 * Generate operation `opId` from its own stored settings and write the result: its
 * segments (stamped by setSegments), and for an inlay the linked half as well.
 *
 * Throws on failure, cancellation included — the caller decides how to report it and
 * whether an operation it just created should be discarded. Resolves with no notes and
 * writes nothing when the operation or its tool no longer exists.
 */
export async function generateOperation(opId: string, overrides: GenerateOverrides = {}): Promise<GenerateResult> {
  const { operations, updateOperation, setSegments } = useToolpathStore.getState()
  const { paths } = usePathsStore.getState()
  const { tools } = useToolStore.getState()
  const { safeHeightMM, widthMM: stockW, heightMM: stockH } = useWorkpieceStore.getState()
  const notes: GenNote[] = []

  const op = operations.find((o) => o.id === opId)
  if (!op) return { notes }
  const tool = tools.find((t) => t.id === op.toolId)
  if (!tool) return { notes }

  // Re-resolved rather than stored: the whole point of holding a reference is that a
  // regenerate picks up a changed pocket depth (or a reorder) instead of replaying a
  // stale number. startInputForOp derives the footprint and cut margin from the op, so
  // this is the same value setSegments stamps and revalidateStartHeights compares against
  // — those three cannot disagree about what an op starts from.
  const startZMM = resolveStartZForOp(
    op, operations, paths, { widthMM: stockW, heightMM: stockH }, tools,
  ).zMM
  // What these segments are built from, captured NOW — before the worker is awaited — and
  // handed to setSegments as the stamp. Stamping at write time instead recorded whatever
  // the other operations said by then, so a floor that moved during the generation was
  // written over segments cut from the old one (see setSegments).
  const builtWith = { entryHint: op.entryHint, safeHeightMM, startZMM }

  const _t0 = performance.now()

  if (op.type === 'profile') {
    const path = paths.find((p) => p.id === op.pathId)
    if (!path) throw new Error('Source path not found')
    setSegments(opId, await runInWorkerFor(opId, 'generateProfile', path.d, tool, {
      side: op.side, depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM), direction: op.direction,
      startNear: op.entryHint, rampIn: op.rampIn, safeHeightMM,
      allowanceMM: op.allowanceMM,
      startZMM,
    }, tabsForGeneration(op.pathId)), builtWith)

  } else if (op.type === 'pocket') {
    const boundary = paths.find((p) => p.id === op.pathId)
    if (!boundary) throw new Error('Boundary path not found')
    const islandDs = op.islandIds.flatMap((id) => {
      const p = paths.find((x) => x.id === id)
      return p ? [p.d] : []
    })
    const pocket = await runInWorkerFor(opId, 'generatePocket', boundary.d, tool, {
      strategy: op.strategy ?? 'raster',
      depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM),
      stepoverPercent: op.stepoverPercent, direction: op.direction,
      islandDs, angle: op.passAngleDeg, autoAngle: op.autoAngle, startNear: op.entryHint, rampIn: op.rampIn,
      finishAllowanceMM: op.allowanceMM,
      startZMM,
      safeHeightMM,
      ...(overrides.forceStrategy ? { forceStrategy: true } : {}),
    })
    setSegments(opId, pocket.segments, builtWith)
    notes.push(...pocket.notes)

  } else if (op.type === 'drill') {
    // Both modes re-read their holes from the source path when they have one, so a
    // hole that moves takes its drilling with it. `extractCircles` returns one per
    // SUBPATH: a pinion's pin ring is eight holes under one id, not one hole the
    // size of the ring.
    const srcPath = op.pathId ? paths.find((p) => p.id === op.pathId) : undefined
    const circles = srcPath ? extractCircles(srcPath) : []
    if (op.drillMode === 'helical') {
      let holes: HoleSpec[] = circles
      if (holes.length === 0) {
        // No source (deleted, or edited into something that is not round): fall back
        // to what the op stored — the list, or the single hole of an older op.
        holes = op.helicalHoles?.length
          ? op.helicalHoles
          : [{ cx: op.helicalCenterX ?? 0, cy: op.helicalCenterY ?? 0, radiusMM: (op.helicalRadius ?? 0) + tool.diameterMM / 2 }]
      } else {
        // Persist what was derived (yes, generation writes op params here): the edit
        // view displays it, and it is the fallback above once the source is gone.
        // Singular fields stay in step for the first hole so an older reader still
        // sees something sane.
        updateOperation(opId, {
          helicalHoles: holes,
          helicalCenterX: holes[0].cx, helicalCenterY: holes[0].cy,
          helicalRadius: Math.max(0, holes[0].radiusMM - tool.diameterMM / 2),
        } as Parameters<typeof updateOperation>[1], { record: false })
      }
      setSegments(opId, generateHelicalDrills(holes, tool, {
        depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM),
        startNear: op.entryHint, safeHeightMM, startZMM,
      }), builtWith)
    } else {
      // Derived, but NOT written back: `points` is the recorded payload of a
      // clicked-points peck op, so it stays out of DERIVED_OP_KEYS and writing it
      // here without recording would make the live op differ from its replay.
      // Nothing else reads it — segments are what cut — so recomputing each time is
      // enough.
      const points = circles.length > 0 ? circles.map((c) => ({ x: c.cx, y: c.cy })) : op.points
      setSegments(opId, generatePeckDrill(points, tool, {
        depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM), startNear: op.entryHint, safeHeightMM, startZMM,
      }), builtWith)
    }

  } else if (op.type === 'surface') {
    setSegments(opId, await runInWorkerFor(opId, 'generateSurface', tool, {
      widthMM: stockW, heightMM: stockH,
      depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM),
      stepoverPercent: op.stepoverPercent, passAngleDeg: op.passAngleDeg,
      safeHeightMM,
    }), builtWith)

  } else if (op.type === 'vcarve') {
    const path = paths.find((p) => p.id === op.pathId)
    if (!path) throw new Error('Source path not found')
    const islandDs = op.islandIds.flatMap((id) => {
      const p = paths.find((x) => x.id === id)
      return p ? [p.d] : []
    })
    // generateVCarve measures depth from stock top (`zStartMM` shifts the datum down and
    // `maxDepthMM` caps the TOTAL) — that convention is load-bearing for the male-inlay
    // path, so the conversion from "depth below the start surface" happens here.
    const zStartMM = -startZMM
    const vcarve = await runInWorkerFor(opId, 'generateVCarve', path.d, tool, {
      angleDeg: op.angleDeg, maxDepthMM: op.maxDepthMM + zStartMM, zStartMM, islandDs,
      startNear: op.entryHint, safeHeightMM,
    })
    setSegments(opId, vcarve.segments, builtWith)
    notes.push(...vcarve.notes)

  } else if (op.type === 'photovcarve') {
    const imgPath = paths.find((p) => p.id === op.pathId)
    if (!imgPath) throw new Error('Image path not found')
    if (!imgPath.imageSrc) throw new Error('Path is not an image import')
    const rect = extractRectInfo(imgPath.d)
    if (!rect) throw new Error('This image is no longer a rectangle — undo the edit that reshaped it, or re-import the image')
    // Decoded here rather than in the worker: pixel decoding needs a canvas, and the
    // loader caches by data URL so a regenerate sweep decodes each photo once.
    const image = await loadImageLuminance(imgPath.imageSrc)
    setSegments(opId, await runInWorkerFor(opId, 'generatePhotoVCarve', image, rect, tool, {
      angleDeg: op.angleDeg, passAngleDeg: op.passAngleDeg,
      // Depths are relative to the surface the photo is carved into, so a picture in a
      // pocket floor cuts the same greyscale band there that it would on bare stock.
      minDepthMM: op.minDepthMM, maxDepthMM: op.maxDepthMM, zStartMM: startZMM, safeHeightMM,
    }), builtWith)

  } else if (op.type === 'profile3d') {
    const stlPath = paths.find((p) => p.id === op.pathId)
    if (!stlPath) throw new Error('STL path not found')
    if (!stlPath.stlSrc || !stlPath.stlModelBounds) throw new Error('Path is not an STL import')
    // Decoded once per model and shared (see decodeStlMesh); the worker call clones them.
    const { positions, indices } = decodeStlMesh(stlPath.stlSrc)
    const cncBbox = getBBox(stlPath.d)
    if (!cncBbox) throw new Error('Could not read the STL outline — the model may be empty')
    // Roughing runs only with a ball nose (the generator models the rougher as a sphere).
    // A rough tool since deleted or retyped in the library is simply no roughing pass —
    // and then no roughing id either, so nothing downstream announces a tool that never
    // cuts. The G-code reads the handover from the segments anyway (initialToolId).
    const roughCandidate = op.roughingToolId ? tools.find((t) => t.id === op.roughingToolId) : undefined
    const roughingTool = roughCandidate?.type === 'ballnose' ? roughCandidate : undefined
    setSegments(opId, await runInWorkerFor(opId, 'generateProfile3d', positions, indices, stlPath.stlModelBounds, cncBbox, tool, {
      stepoverPercent: op.stepoverPercent,
      rasterAngleDeg: op.rasterAngleDeg,
      maxDepthMM: op.maxDepthMM,
      roughingBallRadius: roughingTool ? roughingTool.diameterMM / 2 : undefined,
      roughingStepoverPercent: op.roughingStepoverPercent,
      roughingStepDownMM: roughingTool != null && op.roughingStepDownMM != null
        ? effectiveStepDownMM(roughingTool, op.roughingStepDownMM, op.maxDepthMM)
        : op.roughingStepDownMM,
      roughingStockAllowanceMM: op.roughingStockAllowanceMM,
      roughingRasterAngleDeg: op.roughingRasterAngleDeg,
      roughingToolId: roughingTool?.id,
      finishingToolId: op.toolId,
      safeHeightMM,
    }), builtWith)

  } else if (op.type === 'trochoidal') {
    const path = paths.find((p) => p.id === op.pathId)
    if (!path) throw new Error('Source path not found')
    setSegments(opId, await runInWorkerFor(opId, 'generateTrochoidal', path.d, tool, {
      side: op.side, depthMM: op.depthMM,
      stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM, trochoidalEngagementFraction(tool, op.trochStepMM)),
      direction: op.direction, trochStepMM: op.trochStepMM, trochRadiusMM: op.trochRadiusMM,
      finishingPass: op.finishingPass, rampIn: op.rampIn, startNear: op.entryHint, safeHeightMM,
    }, tabsForGeneration(op.pathId)), builtWith)

  } else if (op.type === 'inlay') {
    const path = paths.find((p) => p.id === op.pathId)
    if (!path) throw new Error('Source path not found')
    // vbitToolId === 'none' (INLAY_NO_FINISH) → female roughing-only, no finish tool.
    const noFinish = op.vbitToolId === 'none'
    const vbitTool: Tool | null = noFinish ? null : (tools.find((t) => t.id === op.vbitToolId) ?? null)
    const pocketTool = tools.find((t) => t.id === op.pocketToolId)
    if (!noFinish && !vbitTool) throw new Error('V-bit tool not found')  // male/finish always needs it
    if (!pocketTool) throw new Error('Pocket/profile tool not found')
    // islandDs and islandPlugDs are indexed in parallel, so a deleted island drops both.
    const islandEntries = op.islandIds.flatMap((id, i) => {
      const p = paths.find((x) => x.id === id)
      if (!p) return []
      const plugs = (op.islandPlugIds?.[i] ?? []).flatMap((pid) => {
        const q = paths.find((x) => x.id === pid)
        return q ? [q.d] : []
      })
      return [{ d: p.d, plugs }]
    })
    const inlayParams = {
      angleDeg: op.angleDeg, pocketDepthMM: op.pocketDepthMM,
      stepDownMM: effectiveStepDownMM(pocketTool, op.stepDownMM, op.pocketDepthMM), stepoverPercent: op.stepoverPercent,
      glueLineMM: op.glueLineMM, clearanceMM: op.clearanceMM,
      rampIn: op.rampIn, mirrorX: op.mirrorX, mirrorAxisX: op.mirrorAxisX,
      islandDs: islandEntries.map((e) => e.d),
      islandPlugDs: islandEntries.map((e) => e.plugs),
      // Male, inverted grouping: the background outline and the other plugs standing in
      // it. A deleted field simply drops the clearance rather than failing the op.
      fieldD: op.fieldId ? paths.find((p) => p.id === op.fieldId)?.d : undefined,
      fieldPlugDs: (op.fieldPlugIds ?? []).flatMap((id) => {
        const p = paths.find((x) => x.id === id)
        return p ? [p.d] : []
      }),
      safeHeightMM,
    }
    // The linked half is built by this same call, so its stamp is taken now as well.
    const linkedAtStart = op.linkedOpId ? operations.find((o) => o.id === op.linkedOpId) : undefined
    const linkedBuiltWith = {
      entryHint: linkedAtStart?.entryHint, safeHeightMM,
      startZMM: linkedAtStart
        ? resolveStartZForOp(linkedAtStart, operations, paths, { widthMM: stockW, heightMM: stockH }, tools).zMM
        : 0,
    }
    const result = op.role === 'female'
      ? await runInWorkerFor(inlayJobKey(op), 'generateInlayFemale', path.d, pocketTool, vbitTool, inlayParams)
      : await runInWorkerFor(inlayJobKey(op), 'generateInlayMale', path.d, pocketTool, vbitTool, inlayParams)
    setSegments(opId, op.phase === 'vbit' ? result.vbitSegs : result.endmillSegs, builtWith)
    notes.push(...result.notes)
    if (op.linkedOpId) {
      const linkedOp = useToolpathStore.getState().operations.find((o) => o.id === op.linkedOpId)
      if (linkedOp?.type === 'inlay') {
        setSegments(op.linkedOpId, op.phase === 'vbit' ? result.endmillSegs : result.vbitSegs, linkedBuiltWith)
      }
    }
  }

  // No generatedWith overwrite here: setSegments already stamps the entry hint, safe height
  // AND start height these segments were built from. The regenerate this replaced wrote
  // `{ entryHint, safeHeightMM }` over that stamp afterwards, which threw away startZMM —
  // so any op it regenerated off stock top read as drifted to the start optimizer and was
  // generated again on every simulate/export, and revalidateStartHeights never checked it.
  const _segs = useToolpathStore.getState().operations.find((o) => o.id === opId)?.segments.length ?? 0
  const _label = op.type === 'pocket' ? `pocket/${op.strategy ?? 'raster'}` : op.type
  perfLog(`[perf] toolpath-gen ${_label}: ${(performance.now() - _t0).toFixed(0)}ms → ${_segs} segs`)
  return { notes }
}
