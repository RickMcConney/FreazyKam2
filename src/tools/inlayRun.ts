// The Inlay form's Generate, out of the form: the operations for each group (a female
// socket or a male plug, as a linked V-bit/end mill pair or one roughing-only op), the
// male cut-out outline round each outermost plug and the through profile that frees it —
// written onto the operations and generated from there (cam/opJob), exactly as an
// automatic regenerate would. The form runs it with its own session (what this form
// already made, so a re-Generate updates rather than duplicates); the MCP bridge runs it
// with an empty one, which always makes fresh operations.

import type { Tool } from '../store/toolStore'
import { useToolpathStore, type AnyOperation, type InlayOperation } from '../store/toolpathStore'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { isWorkCancelled } from '../workers/workerClient'
import { generateOperation, showGenNotes } from '../cam/opJob'
import { seedStepDownMM } from '../cam/feeds'
import { includedAngleDeg, isVCutter, interiorPoint, pointInPolygon } from '../cam/geom'
import { getMultiBBox } from '../canvas/selectionUtils'
import { plugCutoutD, cutoutIsOwnOutline } from '../cam/inlay'
import { flattenPath, signedArea } from '../cam/pathFlattener'
import { nextPathColor } from '../importers/svgImporter'
import { uid } from '../uid'
import { discardFailedOps } from '../panels/machine/batchGenerate'
import type { groupPathsByContainment } from '../panels/machine/containment'

export interface InlaySettings {
  vbitToolId: string
  pocketToolId: string
  pocketDepthMM: number
  stepDownMM: number
  /** The step-down was typed over the auto one (see BaseOperation.stepDownManual). */
  stepDownManual: boolean
  stepoverPercent: number
  glueLineMM: number
  clearanceMM: number
  /** Female: V-bit floor loop spacing (cam/inlay vFloorFinish). */
  vFloorStepMM: number
  role: 'female' | 'male'
  rampIn: boolean
  mirrorX: boolean
  invert: boolean
  /** Male: draw a cut-out outline round the plug and clear to it — see plugCutoutD. */
  cutout: boolean
}

// The field a group's plug stands in — only an inverted grouping has one, and only on the
// first plug of each field (see groupPathsByContainment). Carried on the operation so a
// regenerate can find it again, and handed to the male generator as geometry. MALE ONLY:
// the female never machines outside its socket, and an op that names a path is regenerated
// (and deleted) with it. Always spread, never conditionally — a group that has stopped
// having a field (Invert unticked, re-generated over the same op) has to lose the stale one.
export function fieldFields(role: 'female' | 'male', field?: ImportedPath, fieldPlugs?: ImportedPath[]) {
  if (role !== 'male') return { fieldId: undefined, fieldPlugIds: undefined }
  return { fieldId: field?.id, fieldPlugIds: fieldPlugs?.map((p) => p.id) }
}

/**
 * The group an existing inlay operation cuts, read back off it: its boundary, its islands
 * with the plugs that fill them, and the field its plug stands in — what an edit regenerates.
 * Null when the boundary has gone.
 */
export function inlayEditGroup(op: InlayOperation, paths: ImportedPath[]) {
  const boundary = paths.find((p) => p.id === op.pathId)
  if (!boundary) return null
  // Walked in islandIds order, not paths order: islandPlugIds is indexed in parallel with
  // islandIds, so a deleted island has to drop both halves of the pair together.
  const pairs = op.islandIds
    .map((id, i) => ({
      path: paths.find((p) => p.id === id),
      plugs: (op.islandPlugIds?.[i] ?? []).flatMap((pid) => {
        const p = paths.find((x) => x.id === pid)
        return p ? [p] : []
      }),
    }))
    .filter((e): e is { path: ImportedPath; plugs: ImportedPath[] } => !!e.path)
  return {
    boundary,
    islands: pairs.map((e) => e.path),
    islandPlugs: pairs.map((e) => e.plugs),
    field: op.fieldId ? paths.find((p) => p.id === op.fieldId) : undefined,
    fieldPlugs: (op.fieldPlugIds ?? []).flatMap((id) => {
      const p = paths.find((x) => x.id === id)
      return p ? [p] : []
    }),
  }
}

/** What a Generate works from — the form's state and what it has worked out from it. */
export interface InlayRunArgs {
  form: InlaySettings
  groups: ReturnType<typeof groupPathsByContainment>
  /** The paths the groups were read from — the mirror axis is the whole selection's. */
  selPaths: ImportedPath[]
  editOp?: InlayOperation
  editBoundary?: ImportedPath | null
  vbitTool: Tool | null | undefined
  pocketTool: Tool | undefined
  finishIsNone: boolean
  /** What this Generate's form already made, by group key; empty for a fresh run. */
  session: { liveOpId: (key: string) => string | undefined; remember: (key: string, opId: string) => void; forget: (keys: string[]) => void }
  groupKey: (boundaryId: string) => string
  /** Session ops the current grouping no longer covers (an Invert toggle), and their op ids to replace. */
  staleOps: { key: string; opId: string }[]
  staleDeleteIds: string[]
  reportError: (opId: string, err: unknown) => void
  /** Called once everything this Generate started has finished. */
  onDone: () => void
}

/** Make and generate the inlay; resolves when every operation it started has finished. */
export function runInlayGenerate(args: InlayRunArgs): Promise<void> {
  const { form, groups, selPaths, editOp, editBoundary, vbitTool, pocketTool, finishIsNone, session, groupKey, staleOps, staleDeleteIds, reportError } = args
  const operations = useToolpathStore.getState().operations
  const { addOperations, updateOperation, replaceGeneratedOperations } = useToolpathStore.getState()
  let finish!: () => void
  const finished = new Promise<void>((r) => { finish = r })
  const done = () => { args.onDone(); finish() }
  void (() => {
    // One flip axis for the whole selection: the male board is turned over once, so a
    // nested design's inner groups must mirror about the same line as the outer one, not
    // about their own centres (which would slide them across the part).
    const mirrorAxisX = editOp
      ? (editOp.mirrorAxisX ?? getMultiBBox([editBoundary?.d ?? ''])?.cx)
      // The whole SELECTION, not the current grouping's boundaries: turning the male board
      // over is one rigid motion for the part, and inverting changes which paths are
      // boundaries without moving anything.
      : getMultiBBox(selPaths.map((p) => p.d))?.cx
    const angleDeg = vbitTool ? includedAngleDeg(vbitTool) : 60
    // Everything a generation of these operations needs is WRITTEN onto them — tools, angle,
    // depths, mirror axis, islands, plugs, field and the pair link — and generated from there
    // (cam/opJob), so an automatic regenerate of either half reproduces this Generate.
    const sharedOpFields = {
      pocketToolId: form.pocketToolId,
      vbitToolId: form.vbitToolId,
      angleDeg,
      pocketDepthMM: form.pocketDepthMM,
      stepDownMM: form.stepDownMM,
      stepDownManual: form.stepDownManual,
      stepoverPercent: form.stepoverPercent,
      glueLineMM: form.glueLineMM,
      clearanceMM: form.clearanceMM,
      vFloorStepMM: form.vFloorStepMM,
      rampIn: form.rampIn,
      mirrorX: form.mirrorX,
      mirrorAxisX,
    }

    // ── Cut-out outlines (male) ──
    // One per OUTERMOST group, written onto the group's ops as `bandId` so the male clears to
    // it and a through Profile frees the piece along it. A group nested inside another
    // selected one stands in the same piece of board (its plugs are the next level, in the
    // outer plug's holes), so it gets none — a cut-out of its own would cut the piece apart.
    // A group with a field already has its background outline; one without the option, or a
    // female, gets none (and loses a band it had).
    //
    // Where the cut-out is just the plug's own outline (cutoutIsOwnOutline) the band IS the
    // plug's path and nothing is drawn: a copy laid exactly over the original put every line
    // on the canvas twice. Otherwise — lettering's band, or a mirrored asymmetric plug — it
    // is a path of its own, redrawn on every Generate (it follows the plug, the end mill and
    // the mirror); a boundary of the user's own is what Invert's field is for.
    const opBandIds = new Map<string, string | undefined>()
    {
      const ps = usePathsStore.getState()
      const add: ImportedPath[] = []
      const updates: { id: string; d: string }[] = []
      const dropIds: string[] = []
      const axis = form.mirrorX ? (mirrorAxisX ?? null) : null
      // Outer rings of every male boundary in play — this selection's groups, and in an edit
      // the other male inlays' boundaries — to tell a nested group from an outermost one.
      const outerRing = (d: string) => {
        const subs = flattenPath(d, 0.1).filter((r) => r.length >= 3)
        return subs.reduce((a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a), subs[0] ?? [])
      }
      const otherBoundaries = editOp
        ? operations.flatMap((o) => o.type === 'inlay' && o.role === 'male' && o.pathId !== editOp.pathId
          ? ps.paths.filter((p) => p.id === o.pathId) : [])
        : groups.map((g) => g.boundary)
      const nested = (b: ImportedPath) => {
        const pt = interiorPoint(flattenPath(b.d, 0.1).filter((r) => r.length >= 3))
        return !!pt && otherBoundaries.some((o) => o.id !== b.id && pointInPolygon(pt[0], pt[1], outerRing(o.d)))
      }
      for (const g of groups) {
        const ownOp = editOp ?? (() => {
          const id = session.liveOpId(groupKey(g.boundary.id))
          return id ? (operations.find((o) => o.id === id) as InlayOperation | undefined) : undefined
        })()
        // A cut-out path a previous Generate drew for this group — never the plug itself.
        const drawn = ownOp?.bandId && ownOp.bandId !== g.boundary.id ? ps.paths.find((p) => p.id === ownOp.bandId) : undefined
        const wanted = form.role === 'male' && form.cutout && !g.field && !!pocketTool && !nested(g.boundary)
        const own = wanted && cutoutIsOwnOutline(g.boundary.d, axis)
        const bandD = wanted && !own ? plugCutoutD(g.boundary.d, pocketTool!.diameterMM, axis) : null
        if (own) opBandIds.set(g.boundary.id, g.boundary.id)
        else if (!bandD) opBandIds.set(g.boundary.id, undefined)
        else if (drawn) {
          if (drawn.d !== bandD) updates.push({ id: drawn.id, d: bandD })
          opBandIds.set(g.boundary.id, drawn.id)
        } else {
          const id = uid('path-cutout')
          add.push({ id, name: `${g.boundary.name} cut-out`, d: bandD, visible: true, color: nextPathColor() })
          opBandIds.set(g.boundary.id, id)
        }
        // A drawn cut-out this group no longer uses goes, with the profile on it.
        if (drawn && opBandIds.get(g.boundary.id) !== drawn.id) dropIds.push(drawn.id)
      }
      // The ops are generated below; the edit must not set off a regenerate of its own.
      if (updates.length || dropIds.length) ps.applyPathEdit({ updates, deleteIds: dropIds, label: 'Inlay cut-out', regenerate: false })
      if (add.length) ps.addPaths(add, { label: 'Inlay cut-out' })
    }
    const bandOf = (boundaryId: string) => ({ bandId: opBandIds.get(boundaryId) })

    // …and the cut that frees the piece along it: an ordinary outside Profile, right
    // through the stock, with the roughing end mill — a real operation, so it takes tabs,
    // a depth edit or a delete like any other. Added AFTER the plug's own ops (it runs
    // last, once everything is cleared) and only where the band has none yet: a profile
    // already on it is the user's, edited or not. Returns every profile on a band, new or
    // not, so the caller regenerates them after the plug — a redrawn band moves them.
    const addCutoutProfiles = (): string[] => {
      const bandIds = [...new Set([...opBandIds.values()].filter((x): x is string => !!x))]
      if (bandIds.length === 0 || !pocketTool) return []
      const thicknessMM = useWorkpieceStore.getState().thicknessMM
      const ops = useToolpathStore.getState().operations
      const bandPaths = usePathsStore.getState().paths
      const fresh = bandIds.filter((id) => !ops.some((o) => o.type === 'profile' && o.pathId === id))
      const created = fresh.length ? addOperations(fresh.map((id) => ({
        type: 'profile' as const,
        name: `Profile: ${bandPaths.find((p) => p.id === id)?.name ?? 'cut-out'} (${pocketTool.name})`,
        toolId: pocketTool.id, pathId: id, side: 'outside' as const,
        depthMM: thicknessMM > 0 ? thicknessMM : form.pocketDepthMM,
        stepDownMM: seedStepDownMM(pocketTool), stepDownManual: false,
        direction: 'climb' as const, rampIn: false, allowanceMM: 0, cornerToleranceMM: 0,
        startFrom: { mode: 'stock' as const },
      }))) : []
      const existing = useToolpathStore.getState().operations
        .filter((o) => o.type === 'profile' && bandIds.includes(o.pathId) && !created.includes(o.id))
        .map((o) => o.id)
      return [...existing, ...created]
    }
    const runCutouts = async (ids: string[]) => {
      for (const id of ids) {
        try { showGenNotes((await generateOperation(id)).notes) } catch (err) {
          if (isWorkCancelled(err)) return
          reportError(id, err)
        }
      }
    }

    if (editOp && editBoundary) {
      // Update both the edited op and its linked counterpart with new params.
      const linkedOp = editOp.linkedOpId
        ? (operations.find((o) => o.id === editOp.linkedOpId) as InlayOperation | undefined)
        : undefined
      const sharedUpdate = {
        ...sharedOpFields, ...bandOf(editBoundary.id),
        toolId: editOp.phase === 'vbit' ? form.vbitToolId : form.pocketToolId,
        status: 'generating' as const,
      }
      updateOperation(editOp.id, sharedUpdate as Partial<AnyOperation>)
      if (linkedOp) {
        updateOperation(linkedOp.id, {
          ...sharedOpFields, ...bandOf(editBoundary.id),
          toolId: linkedOp.phase === 'vbit' ? form.vbitToolId : form.pocketToolId,
          status: 'generating',
        } as Partial<AnyOperation>)
      }
      const cutoutIds = addCutoutProfiles()
      setTimeout(async () => {
        try {
          // Generated from the settings just written — the same call an automatic
          // regenerate makes (cam/opJob), which also writes the linked half.
          showGenNotes((await generateOperation(editOp.id)).notes)
        } catch (err) {
          if (!isWorkCancelled(err)) {
            reportError(editOp.id, err)
            // The two halves of an inlay fail together — one plug, one socket.
            if (linkedOp) reportError(linkedOp.id, err)
          }
        }
        await runCutouts(cutoutIds)
        done()
      }, 0)
      return
    }

    // Finish = None (roughing-only): one end-mill op per group, no finish phase and no
    // pairing. Female → the raster pocket forms the flat-walled socket; male → the roughing
    // bit profiles the flat-walled plug and pockets any island sockets. All segs are endmill.
    if (finishIsNone) {
      const role = form.role
      const roleLabel = role === 'female' ? 'Female' : 'Male'
      const opBase = { type: 'inlay' as const, role, ...sharedOpFields }
      // Built as slots (an existing op's id, or an index into `soloNew`) so every new op
      // goes in ONE call — and so an Invert toggle REPLACES the set it made last time
      // instead of appending a contradictory second one. Replacing amends the chip that
      // created them, the way a depth edit does, rather than recording a delete and an add.
      const soloPayloads: Parameters<typeof addOperations>[0] = []
      const soloSlots = groups.map(({ boundary, islands, islandPlugs, field, fieldPlugs }) => {
        // Re-Generate on a boundary this form already generated for updates that op in place.
        const existingId = session.liveOpId(groupKey(boundary.id))
        const name = `Inlay ${roleLabel} (End Mill): ${boundary.name}`
        if (existingId) {
          updateOperation(existingId, { ...sharedOpFields, phase: 'endmill', toolId: form.pocketToolId,
            islandIds: islands.map((p) => p.id), islandPlugIds: islandPlugs.map((ps) => ps.map((p) => p.id)),
            ...fieldFields(role, field, fieldPlugs), ...bandOf(boundary.id),
            name, status: 'generating' } as Partial<AnyOperation>)
          return existingId
        }
        return soloPayloads.push({ ...opBase, phase: 'endmill', toolId: form.pocketToolId,
          pathId: boundary.id, islandIds: islands.map((p) => p.id),
          islandPlugIds: islandPlugs.map((ps) => ps.map((p) => p.id)),
          ...fieldFields(role, field, fieldPlugs), ...bandOf(boundary.id), name }) - 1
      })
      const soloNew = staleDeleteIds.length > 0
        ? replaceGeneratedOperations({ anchorId: staleDeleteIds[0], deleteIds: staleDeleteIds, add: soloPayloads })
        : addOperations(soloPayloads)
      if (staleOps.length > 0) session.forget(staleOps.map((e) => e.key))
      for (const id of soloNew) updateOperation(id, { status: 'generating' })
      const ids = soloSlots.map((slot) => typeof slot === 'string' ? slot : soloNew[slot])
      groups.forEach(({ boundary }, i) => {
        if (typeof soloSlots[i] === 'number') session.remember(groupKey(boundary.id), ids[i])
      })
      const cutoutIds = addCutoutProfiles()
      setTimeout(async () => {
        for (let i = 0; i < groups.length; i++) {
          try {
            // Generated from the fields just written (roughing-only: vbitToolId is
            // INLAY_NO_FINISH, phase endmill) — the same call an automatic regenerate makes.
            showGenNotes((await generateOperation(ids[i])).notes)
          } catch (err) {
            // A cancel abandons the whole Generate, not just this group.
            if (isWorkCancelled(err)) break
            reportError(ids[i], err)
          }
        }
        await runCutouts(cutoutIds)
        // A Generate that failed leaves nothing behind — only the ops this click made.
        discardFailedOps(ids.filter((_, i) => typeof soloSlots[i] === 'number'))
        done()
      }, 0)
      return
    }

    // For new ops: create all first-phase ops first, then all second-phase ops, so
    // the operations list naturally orders roughing before finishing.
    // Female (any): endmill (roughing pocket) first, vbit/finish (walls) second.
    // Male V-bit: vbit (bevel profile) first, endmill (release cut) second.
    // Male endmill-only: endmill (roughing release) first, vbit/finish (release) second.
    const role = form.role
    const isEndmillOnly = !vbitTool || !isVCutter(vbitTool)
    const firstPhase  = (role === 'female' || isEndmillOnly) ? 'endmill' : 'vbit'   as 'vbit' | 'endmill'
    const secondPhase = (role === 'female' || isEndmillOnly) ? 'vbit'    : 'endmill' as 'vbit' | 'endmill'
    const firstToolId  = firstPhase  === 'vbit' ? form.vbitToolId : form.pocketToolId
    const secondToolId = secondPhase === 'vbit' ? form.vbitToolId : form.pocketToolId
    const roleLabel = role === 'female' ? 'Female' : 'Male'
    const phaseLabel = (phase: 'vbit' | 'endmill') => phase === 'vbit' ? 'V-bit' : 'End Mill'

    const opBase = { type: 'inlay' as const, role, ...sharedOpFields }

    // Re-Generate on a boundary this form already generated for updates the existing pair
    // in place (both phases; phase/tool fields are refreshed since the finish tool type
    // can flip which phase runs first).
    const existingPairs = groups.map(({ boundary }) => {
      const firstId = session.liveOpId(groupKey(boundary.id))
      const first = firstId ? (operations.find((o) => o.id === firstId) as InlayOperation | undefined) : undefined
      const second = first?.linkedOpId ? (operations.find((o) => o.id === first.linkedOpId) as InlayOperation | undefined) : undefined
      return first && second ? { firstId: first.id, secondId: second.id } : null
    })

    // Create all first-phase ops, then all second-phase ops — so the operations list
    // orders roughing before finishing rather than alternating tools per group.
    // The new ops go in ONE addOperations call: an inlay's two phases are two
    // operations but a single user action, so they belong on a single timeline chip
    // (they used to record one chip each). A slot is either an existing op's id or
    // an index into `newOps`, resolved once the ids come back.
    const newOps: Parameters<typeof addOperations>[0] = []
    const phaseSlots = ([firstPhase, secondPhase] as const).map((phase) => {
      const toolId = phase === firstPhase ? firstToolId : secondToolId
      return groups.map(({ boundary, islands, islandPlugs, field, fieldPlugs }, i) => {
        const name = `Inlay ${roleLabel} (${phaseLabel(phase)}): ${boundary.name}`
        const pair = existingPairs[i]
        if (pair) {
          const id = phase === firstPhase ? pair.firstId : pair.secondId
          updateOperation(id, { ...sharedOpFields, phase, toolId,
            islandIds: islands.map((p) => p.id), islandPlugIds: islandPlugs.map((ps) => ps.map((p) => p.id)),
            ...fieldFields(role, field, fieldPlugs), ...bandOf(boundary.id),
            name, status: 'generating' } as Partial<AnyOperation>)
          return id
        }
        return newOps.push({ ...opBase, phase, toolId,
          pathId: boundary.id, islandIds: islands.map((p) => p.id),
          islandPlugIds: islandPlugs.map((ps) => ps.map((p) => p.id)),
          ...fieldFields(role, field, fieldPlugs), ...bandOf(boundary.id), name }) - 1
      })
    })
    // Same replace-don't-append rule as the roughing-only path above: an Invert toggle
    // re-reads the SAME selection into a different set of boundaries, so the pair this
    // session made for the old reading is a revision of this Generate, not a separate one.
    const newIds = staleDeleteIds.length > 0
      ? replaceGeneratedOperations({ anchorId: staleDeleteIds[0], deleteIds: staleDeleteIds, add: newOps })
      : addOperations(newOps)
    if (staleOps.length > 0) session.forget(staleOps.map((e) => e.key))
    const resolve = (slot: string | number) => typeof slot === 'number' ? newIds[slot] : slot
    const firstIds = phaseSlots[0].map(resolve)
    const secondIds = phaseSlots[1].map(resolve)
    for (const id of newIds) updateOperation(id, { status: 'generating' })
    groups.forEach(({ boundary }, i) => session.remember(groupKey(boundary.id), firstIds[i]))

    // Link paired ops so edit/regenerate can update both together.
    for (let i = 0; i < groups.length; i++) {
      updateOperation(firstIds[i],  { linkedOpId: secondIds[i]  } as Partial<AnyOperation>)
      updateOperation(secondIds[i], { linkedOpId: firstIds[i]   } as Partial<AnyOperation>)
    }

    const cutoutIds = addCutoutProfiles()
    setTimeout(async () => {
      for (let i = 0; i < groups.length; i++) {
        try {
          // Generated from the fields and links just written — the same call an automatic
          // regenerate makes (cam/opJob). It writes the first op by its phase and the linked
          // second op with the other half — exactly what this loop's own two writes used to do.
          showGenNotes((await generateOperation(firstIds[i])).notes)
        } catch (err) {
          if (isWorkCancelled(err)) break
          reportError(firstIds[i], err)
          reportError(secondIds[i], err)
        }
      }
      await runCutouts(cutoutIds)
      // Both halves of a failed pair go: one plug without its socket is not a thing.
      discardFailedOps([
        ...firstIds.filter((_, i) => typeof phaseSlots[0][i] === 'number'),
        ...secondIds.filter((_, i) => typeof phaseSlots[1][i] === 'number'),
      ])
      done()
    }, 0)
  })()
  return finished
}
