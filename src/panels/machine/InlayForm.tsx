// ─── Inlay form ───────────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, StepDownField, GenerateBtn, useSessionOps, toolsOfType, pickToolId, LengthInput, FormError, FormNotice, useGenerateError, discardFailedOps } from './shared'
import { ToolPicker } from './ToolPicker'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, INLAY_NO_FINISH, type AnyOperation, type InlayOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { isWorkCancelled } from '../../workers/workerClient'
import { generateOperation, showGenNotes } from '../../cam/opJob'
import { effectiveStepDownMM, seedStepDownMM } from '../../cam/feeds'
import { includedAngleDeg, isVCutter } from '../../cam/geom'
import { groupPathsByContainment, skipOpenPaths, skippedOpenMsg } from './containment'
import { getMultiBBox } from '../../canvas/selectionUtils'
import { plugCutoutD, cutoutIsOwnOutline, DEFAULT_V_FLOOR_STEP_MM, vFloorRidgeMM } from '../../cam/inlay'
import { flattenPath, signedArea } from '../../cam/pathFlattener'
import { interiorPoint, pointInPolygon } from '../../cam/geom'
import { nextPathColor } from '../../importers/svgImporter'
import { uid } from '../../uid'

interface InlayFormState {
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
function fieldFields(role: 'female' | 'male', field?: ImportedPath, fieldPlugs?: ImportedPath[]) {
  if (role !== 'male') return { fieldId: undefined, fieldPlugIds: undefined }
  return { fieldId: field?.id, fieldPlugIds: fieldPlugs?.map((p) => p.id) }
}

export function InlayForm({ onClose, editOp }: { onClose: () => void; editOp?: InlayOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const paths = usePathsStore((s) => s.paths)
  // Open paths are left out rather than failing the inlay they land in — see skipOpenPaths.
  const { closed: selPaths, skipped: skippedOpen } = skipOpenPaths(useSelectedPaths())
  const addOperations = useToolpathStore((s) => s.addOperations)
  const updateOperation = useToolpathStore((s) => s.updateOperation)
  const replaceGeneratedOperations = useToolpathStore((s) => s.replaceGeneratedOperations)
  const operations = useToolpathStore((s) => s.operations)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
  const autoFeedEnabled = useWorkpieceStore((s) => s.autoFeedEnabled)
  const units = useWorkpieceStore((s) => s.units)

  // An inlay only fits if both halves are cut with a known wall and a flat floor, so both
  // lists are strict — no fallback to the whole library when one comes up empty. Roughing
  // clears the socket / frees the plug: end mills only, since a ball nose leaves a
  // scalloped floor for the plug to bottom on and a drill can't clear at all. The finish
  // tool cuts the WALL, and there are exactly two wall shapes the fit maths knows: sloped
  // (V-bit) and flat (end mill).
  const vbits = tools.filter((t) => isVCutter(t))
  const endmills = toolsOfType(tools, ['endmill'])
  const finishers = toolsOfType(tools, ['endmill', 'vbit', 'taper'])
  const defaultVbit = vbits[0] ?? finishers[0]
  const defaultEndmill = endmills[0]

  const [form, setForm] = useState<InlayFormState>(() => {
    const base = editOp ? {
    vbitToolId: editOp.vbitToolId, pocketToolId: editOp.pocketToolId,
    pocketDepthMM: editOp.pocketDepthMM,
    stepDownMM: editOp.stepDownMM, stepDownManual: editOp.stepDownManual ?? false, stepoverPercent: editOp.stepoverPercent,
    glueLineMM: editOp.glueLineMM, clearanceMM: editOp.clearanceMM,
    vFloorStepMM: editOp.vFloorStepMM ?? DEFAULT_V_FLOOR_STEP_MM,
    role: editOp.role, rampIn: editOp.rampIn ?? false, mirrorX: editOp.mirrorX ?? false,
    invert: false,
    cutout: !!editOp.bandId,
  } : { ...mergeWithDefaults(load('inlay'), {
    vbitToolId: defaultVbit?.id ?? '',
    pocketToolId: defaultEndmill?.id ?? '',
    pocketDepthMM: 5,
    stepDownMM: seedStepDownMM(defaultEndmill),
    stepDownManual: false,
    stepoverPercent: 40,
    glueLineMM: 0.2,
    clearanceMM: 0.1,
    vFloorStepMM: DEFAULT_V_FLOOR_STEP_MM,
    role: 'female' as const,
    rampIn: false,
    mirrorX: false,
    // A grouping choice, never a stored op field — inverting just reads the same selection
    // into a different set of boundaries, so the ops that come out are ordinary ones.
    // Deliberately not restored from saved defaults: which half of a nested selection is
    // the part is a property of THAT selection, not a preference.
    invert: false,
    cutout: true,
  }, tools), invert: false, stepDownManual: false }
    // "None" is an explicit choice, not a stale id — never coerce it to a real tool.
    return { ...base,
      pocketToolId: pickToolId(base.pocketToolId, endmills),
      vbitToolId: base.vbitToolId === INLAY_NO_FINISH
        ? INLAY_NO_FINISH
        : (pickToolId(base.vbitToolId, finishers) || INLAY_NO_FINISH) }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()

  // Finish = "None": roughing tool only, no separate wall-finish pass. Female → flat-walled
  // pocket; male → flat-walled plug freed by the roughing bit. One operation, no pairing.
  const finishIsNone = form.vbitToolId === INLAY_NO_FINISH
  const vbitTool = finishIsNone ? null : tools.find((t) => t.id === form.vbitToolId)
  const pocketTool = tools.find((t) => t.id === form.pocketToolId)
  const editBoundary = editOp ? paths.find((p) => p.id === editOp.pathId) : null
  // Walked in islandIds order, not paths order: islandPlugIds is indexed in parallel with
  // islandIds, so a deleted island has to drop both halves of the pair together.
  const editIslandPairs = editOp
    ? editOp.islandIds
        .map((id, i) => ({
          path: paths.find((p) => p.id === id),
          plugs: (editOp.islandPlugIds?.[i] ?? []).flatMap((pid) => {
            const p = paths.find((x) => x.id === pid)
            return p ? [p] : []
          }),
        }))
        .filter((e): e is { path: typeof paths[number]; plugs: typeof paths } => !!e.path)
    : []
  const editIslands = editIslandPairs.map((e) => e.path)
  const editIslandPlugs = editIslandPairs.map((e) => e.plugs)
  const editField = editOp?.fieldId ? paths.find((p) => p.id === editOp.fieldId) : undefined
  const editFieldPlugs = (editOp?.fieldPlugIds ?? []).flatMap((id) => {
    const p = paths.find((x) => x.id === id)
    return p ? [p] : []
  })
  const groups = editOp && editBoundary
    ? [{ boundary: editBoundary, islands: editIslands, islandPlugs: editIslandPlugs,
         field: editField, fieldPlugs: editFieldPlugs }]
    : groupPathsByContainment(selPaths, { invert: form.invert })
  // Nested outlines alternate solid/hole, so a selection that nests has two valid readings
  // and only the user knows which wood is meant to end up as the plug. Once inverted the
  // row has to stay up whatever the grouping looks like, or there is no way back.
  const nested = form.invert || groups.some((g) => g.islands.length > 0)
  const session = useSessionOps()

  // Session key includes role and pair/solo structure: a female and male op for the same
  // shape is a legit paired workflow, and toggling "None — roughing only" changes the op
  // count, so those combinations create fresh ops instead of updating the counterpart.
  const keyPrefix = `${form.role}:${finishIsNone ? 'solo' : 'pair'}:`
  const groupKey = (boundaryId: string) => `${keyPrefix}${boundaryId}`
  // Ops this form session made, for the SAME role and pairing, from paths still selected.
  // The role has to match: generating a female and then a male for one shape is the normal
  // paired workflow, and those must not read as each other's leftovers.
  const selectedIds = new Set(selPaths.map((p) => p.id))
  const sessionOps = editOp ? [] : session.liveEntries()
    .filter((e) => e.key.startsWith(keyPrefix) && selectedIds.has(e.key.slice(keyPrefix.length)))
  // Boundaries this session already covers that the current grouping no longer has —
  // inverting turns every boundary into an island and vice versa, so the whole set is
  // replaced rather than left behind as a second, contradictory pair of operations.
  const staleOps = sessionOps.filter((e) => !groups.some((g) => g.boundary.id === e.key.slice(keyPrefix.length)))
  // Both phases of a stale pair go: they are one operation to the user.
  const staleDeleteIds = staleOps.flatMap((e) => {
    const op = operations.find((o) => o.id === e.opId) as InlayOperation | undefined
    return op?.linkedOpId ? [e.opId, op.linkedOpId] : [e.opId]
  })
  const updating = !editOp && groups.length > 0 && groups.every(({ boundary }) => {
    const firstId = session.liveOpId(groupKey(boundary.id))
    if (!firstId) return false
    if (finishIsNone) return true
    const first = operations.find((o) => o.id === firstId) as InlayOperation | undefined
    return !!first?.linkedOpId && operations.some((o) => o.id === first.linkedOpId)
  })

  function up<K extends keyof InlayFormState>(k: K, v: InlayFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    clearError()
    if (groups.length === 0 || !pocketTool || (!vbitTool && !finishIsNone)) return
    setGenerating(true)

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
        setGenerating(false)
        save('inlay', form)
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
        setGenerating(false)
        save('inlay', form)
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
      setGenerating(false)
      save('inlay', form)
    }, 0)
  }

  const isEndmillMode = !!vbitTool && !isVCutter(vbitTool)
  const canGenerate = groups.length > 0 && (!!vbitTool || finishIsNone) && !!pocketTool && !generating && form.pocketDepthMM > 0
  const isMale = editOp ? editOp.role === 'male' : form.role === 'male'

  return (
    <FormShell title={editOp ? `Edit Inlay (${editOp.role})` : 'New Inlay'} onClose={onClose}>
      {groups.length === 0 && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a closed path first</p>
      )}
      {/* Roughing tool */}
      <div>
        <label htmlFor="inlay-roughing-tool-end" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Roughing Tool (End Mill)</label>
        <ToolPicker id="inlay-roughing-tool-end"
          tools={endmills}
          value={form.pocketToolId}
          onChange={(id) => {
            const t = tools.find((x) => x.id === id)
            if (t) { up('stepDownMM', seedStepDownMM(t)); up('stepDownManual', false) }
            up('pocketToolId', id)
          }}
          emptyText="No end mill — add one in the Tool Library" />
      </div>
      {/* Finish tool */}
      <div>
        <label htmlFor="inlay-finishing-tool" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Finishing Tool</label>
        {/* None skips the wall-finish pass — the roughing bit alone forms the socket / plug walls. */}
        <ToolPicker id="inlay-finishing-tool"
          tools={finishers}
          value={form.vbitToolId}
          onChange={(id) => up('vbitToolId', id)}
          none={{ value: INLAY_NO_FINISH, label: 'None — roughing only' }} />
        {finishIsNone && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">No finish pass — flat walls left by the roughing tool (corners at its radius).</p>
        )}
        {vbitTool && isVCutter(vbitTool) && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            {vbitTool.type === 'taper' ? 'Taper — sloped bevel walls, rounded at the foot' : 'V-bit — sloped bevel walls'}
          </p>
        )}
        {vbitTool?.type === 'taper' && (
          /* Measured with scripts/inlay-fit.mts: the plug always seats (no interference),
             but the tip ball rounds the foot of the PLUG wall while the socket's own
             rounding sits at its deep end — so the two do not meet at the finished face.
             A V-bit's cone is its own mirror image and closes completely. */
          <p className="text-label text-amber-600 dark:text-amber-500 mt-0.5">
            Leaves a hairline gap around the inlay at the finished face, up to the Ø{fmtLen(vbitTool.diameterMM, units)} tip&rsquo;s radius. A V-bit closes fully.
          </p>
        )}
        {vbitTool && !isVCutter(vbitTool) && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">End mill — flat walls, corners auto-rounded to Ø{fmtLen(vbitTool.diameterMM, units)}</p>
        )}
      </div>
      {vbitTool && isVCutter(vbitTool) && (
        <p className="text-label text-gray-600 dark:text-neutral-400">
          {vbitTool.type === 'taper'
            ? `Taper: ${vbitTool.vbitAngleDeg ?? 5}° per side, Ø${fmtLen(vbitTool.diameterMM, units)} tip (set on tool)`
            : `V-bit angle: ${includedAngleDeg(vbitTool)}° (set on tool)`}
        </p>
      )}
      {/* Depth */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="inlay-inlay-depth" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Inlay Depth</label>
          <LengthInput id="inlay-inlay-depth" valueMM={form.pocketDepthMM} minMM={0.5} stepMM={0.5}
            onChangeMM={(v) => up('pocketDepthMM', v)} />
        </div>
        <StepDownField stepDownMM={form.stepDownMM} onStep={(v) => up('stepDownMM', v)} minMM={0.1}
          autoMM={autoFeedEnabled && pocketTool ? effectiveStepDownMM(pocketTool, form.stepDownMM, form.pocketDepthMM) : null}
          manual={form.stepDownManual} onManual={(v) => up('stepDownManual', v)} />
      </div>
      {/* Stepover */}
      <div>
        <label htmlFor="inlay-stepover" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Stepover <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input id="inlay-stepover" type="range" min={10} max={90} step={5} value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      {/* Glue + clearance */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="inlay-glue-gap" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Glue Gap</label>
          <LengthInput id="inlay-glue-gap" valueMM={form.glueLineMM} minMM={0} stepMM={0.05}
            onChangeMM={(v) => up('glueLineMM', v)} />
        </div>
        <div>
          <label htmlFor="inlay-clearance" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Clearance</label>
          <LengthInput id="inlay-clearance" valueMM={form.clearanceMM} minMM={-1} maxMM={1} stepMM={0.05}
            onChangeMM={(v) => up('clearanceMM', v)} />
        </div>
      </div>
      {/* V-bit floor step (female): how far apart the tip's loops run in the corners the end
          mill cannot reach, and the ridge that leaves — against the glue gap, since a ridge
          under it cannot touch the plug. */}
      {form.role === 'female' && (() => {
        const tanHalf = Math.tan(((vbitTool ? includedAngleDeg(vbitTool) : 60) / 2) * Math.PI / 180)
        const ridge = vFloorRidgeMM(form.vFloorStepMM, tanHalf)
        const tall = ridge > form.glueLineMM + 1e-9
        return (
          <div>
            <label htmlFor="inlay-vfloor-step" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">V-bit Floor Step</label>
            <LengthInput id="inlay-vfloor-step" valueMM={form.vFloorStepMM} minMM={0.01} maxMM={5} stepMM={0.05}
              onChangeMM={(v) => up('vFloorStepMM', v)} />
            <p className={`text-label mt-0.5 ${tall ? 'text-amber-600 dark:text-amber-400' : 'text-gray-600 dark:text-neutral-400'}`}>
              Spacing of the V-bit's passes in corners the end mill can't reach. Leaves ridges {fmtLen(ridge, units, 2)} high
              {tall ? ` — taller than the glue gap, so the plug may sit on them unless they break away` : ' — under the glue gap'}.
            </p>
          </div>
        )
      })()}
      {!editOp && (
        <div>
          <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Generate</div>
          <div className="flex gap-1">
            {(['female', 'male'] as const).map((r) => (
              <button key={r} onClick={() => up('role', r)}
                className={[
                  'flex-1 py-1 text-body rounded border transition-colors capitalize',
                  form.role === r
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-gray-50 dark:bg-neutral-900 border-gray-400 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
                ].join(' ')}>
                {r === 'female' ? 'Female' : 'Male'}
              </button>
            ))}
          </div>
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-1">
            {isEndmillMode
              ? (form.role === 'female' ? 'Socket only — flat pocket, corners rounded to bit radius.' : 'Plug only — flat-sided plug, corners rounded to bit radius.')
              : (form.role === 'female' ? 'Socket only — pocket + V-carved walls.' : 'Plug only — V-carved bevel + profile cutout.')}
          </p>
        </div>
      )}
      {/* Which half of a nested selection is the plug. Same grouping flip as Invert Pocket:
          nested outlines alternate solid/hole, so a field with a design inside it can be
          read either way and only the user knows which wood is meant to show. */}
      {!editOp && nested && (
        <div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="inlay-invert" checked={form.invert}
              onChange={(e) => up('invert', e.target.checked)} className="accent-blue-500" />
            <label htmlFor="inlay-invert" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
              Invert
            </label>
          </div>
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            {form.invert
              ? 'The inner shapes are the plug — they end up in the male board’s wood on a field of the female’s.'
              : 'The field around the inner shapes is the plug — the shapes end up in the female board’s wood.'}
          </p>
        </div>
      )}

      {/* Ramp In — angled/helical entry on roughing pockets and end-mill finish passes */}
      <div className="flex items-center gap-2">
        <input type="checkbox" id="inlay-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="inlay-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-600 dark:text-neutral-400 normal-case">(2× dia, 50% feed)</span>
        </label>
      </div>

      {/* Mirror option — male plug only */}
      {isMale && (
        <div className="flex items-center gap-2">
          <input type="checkbox" id="inlay-mirror" checked={form.mirrorX}
            onChange={(e) => up('mirrorX', e.target.checked)} className="accent-blue-500" />
          <label htmlFor="inlay-mirror" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
            Mirror <span className="text-gray-600 dark:text-neutral-400 normal-case">(flip horizontally — for asymmetric shapes inserted reversed)</span>
          </label>
        </div>
      )}
      {/* Cut-out outline — male only. */}
      {isMale && (
        <div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="inlay-cutout" checked={form.cutout}
              onChange={(e) => up('cutout', e.target.checked)} className="accent-blue-500" />
            <label htmlFor="inlay-cutout" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
              Cut-out Outline <span className="text-gray-600 dark:text-neutral-400 normal-case">(a path round the plug to free it)</span>
            </label>
          </div>
          {form.cutout && (
            <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
              Draws a path round the plug — its own outline for one shape, a band round all of
              them for lettering — clears everything inside it to the plug depth, and adds an
              outside Profile on it right through the stock to cut the piece free. That profile is
              an ordinary operation: open it to add tabs or change its depth. The path is redrawn
              on every Generate; for a boundary of your own, draw it round the plug, select both and
              use Invert.
            </p>
          )}
        </div>
      )}
      {!editOp && <FormNotice msg={skippedOpenMsg(skippedOpen, 'an inlay')} />}
      <FormError msg={errorMsg} />
      <GenerateBtn disabled={!canGenerate} generating={generating} onClick={handleGenerate}
        title={groups.length > 1 ? `Creates ${groups.length * (finishIsNone ? 1 : 2)} operations` : undefined}
        label={editOp
          ? `Regenerate ${editOp.role === 'female' ? 'Female' : 'Male'} Toolpath`
          : `${updating ? 'Update' : 'Generate'} ${form.role === 'female' ? 'Female' : 'Male'} Toolpath`} />
      {/* Below the button — see PathListSection. Islands keep their label because that
          is a real distinction; nothing else needs one. */}
      <PathListSection count={groups.reduce((n, g) => n + 1 + g.islands.length + (isMale && g.field ? 1 : 0), 0)}
        toggle={!editOp}>
        {groups.map(({ boundary, islands, field }) => (
          <div key={boundary.id} className="space-y-0.5">
            <PathChip path={boundary} />
            {islands.map((p) => <PathChip key={p.id} path={p} label="island" />)}
            {/* The male clears the wood between the plug and this path; the female never
                machines outside its socket, so it plays no part there. */}
            {isMale && field && <PathChip path={field} label="field" />}
          </div>
        ))}
      </PathListSection>
    </FormShell>
  )
}
