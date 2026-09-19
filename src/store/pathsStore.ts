import { useMemo } from 'react'
import { create } from 'zustand'
import type { ImportedPath, PathDefinition } from '../importers/svgImporter'
import type { ClockSpec } from '../shapes/clockTrain'
import { applyPlacementD, placementMat, foldPlacement, isPlacementOnly, getBBox, applyTransformSteps, type TransformStep } from '../canvas/selectionUtils'
import { generateShapeD, generateShapeParts, shapeDisplayName, ANNOTATION_SWITCH, type ShapeParams } from '../shapes/shapeGenerators'
import { useToolpathStore, refsPathId, remapOpsForSplit } from './toolpathStore'
import { useTabStore } from './tabStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { serializeOp, type PathsAddSource, type PathEditGesture } from '../timeline/events'
import type { CornerTreatmentType } from '../tools/cornerTreatment'
import { inGroup, outerGroupOf } from './pathGroups'
import { useConstraintsStore, constraintsTouching } from './constraintsStore'
import type { Constraint } from './constraints'
import { copyPaths, withHiddenSources } from './copyPaths'
import { solveConstraints, solveInnerConstraints, type ConstraintSolution } from './constraints'
import { useWorkpieceStore } from './workpieceStore'
import { useUIStore } from './uiStore'
import { uid } from '../uid'

export type { ImportedPath }
// User-group helpers live in their own module (pure, no store), and are
// re-exported here so call sites have one place to import path things from.
export { groupKeyOf, inGroup, outerGroupOf, expandUserGroups } from './pathGroups'

// `transforms`: the geometric-transform recipe that produced `d`/`shapeParams`
// (move/scale/rotate/skew/mirror only) — see selectionUtils.ts's
// applyTransformStep. `corner`: the per-corner treatment recipe (gesture
// 'corner' only) — see tools/cornerTreatment.ts's applyCornerTreatments.
// `d`/`shapeParams` remain the immediately-applied baked value for live
// editing and for gestures with no recipe concept (points/join/weld/trim/
// text/boolean); timeline replay prefers a recipe when present so it
// recomposes against the CURRENT geometry at that point in history instead
// of stamping back a stale absolute value.
export type PathUpdate = {
  id: string
  d: string
  shapeParams?: ShapeParams | null
  name?: string
  hidden?: boolean
  transforms?: TransformStep[]
  corner?: { idx: number; type: CornerTreatmentType; radiusMM: number }[]
  // The untreated outline `corner` was cut from. Stored with it so the
  // treatment stays a recipe rather than baked geometry — see
  // ImportedPath.corners.
  cornerBaseD?: string
  fromCenter?: boolean
  // Group membership, outermost first (see ImportedPath.userGroups). An empty
  // array clears it; `undefined` (omitted) leaves it alone, the same convention
  // shapeParams uses.
  userGroups?: string[]
}

export type PathsAddMeta = { source?: PathsAddSource; label?: string }

interface PathsState {
  paths: ImportedPath[]
  selectedIds: string[]
  collapsedGroups: Set<string>

  addPaths: (newPaths: ImportedPath[], meta?: PathsAddMeta) => void
  deletePath: (id: string) => void
  deleteGroup: (groupId: string) => void
  toggleVisibility: (id: string) => void
  toggleGroupVisibility: (groupId: string) => void
  toggleGroupCollapsed: (groupId: string) => void
  selectPath: (id: string | null, extend?: boolean) => void
  setSelectedIds: (ids: string[]) => void
  // Tie the selected paths together / dissolve the groups the selection touches.
  // Both go through applyPathEdit, so each is ONE undo step.
  groupSelected: () => void
  ungroupSelected: () => void
  deleteSelected: () => void
  updatePathD: (id: string, newD: string) => void
  batchUpdatePaths: (updates: PathUpdate[], gesture?: PathEditGesture) => void
  // Atomic update + add + delete in ONE history entry. Use for gestures that
  // touch multiple paths at once (node-edit join/weld) so a single undo reverts
  // the whole gesture. Deleted paths' operations and tabs are cleaned up.
  applyPathEdit: (edit: { updates?: PathUpdate[]; add?: ImportedPath[]; deleteIds?: string[]; label?: string; gesture?: PathEditGesture; selectAfter?: string[] }) => void
  // Raw, NON-recording path rewrite for edit-in-place flows that amend the
  // timeline themselves (e.g. BooleanForm edit mode) — never use for normal
  // edits, which must record events.
  rewritePathRaw: (id: string, upd: { d: string; name?: string }) => void
  // Raw, NON-recording bulk update+add+delete (Offset/Pattern chip edit —
  // pattern cardinality changes add/remove result paths). Cleans up ops, tabs,
  // and selection for deleted ids like applyPathEdit, but records nothing.
  // `fields` is for a generator that REBUILDS a path rather than editing it —
  // a pattern reworked to a new spacing produces a whole new copy of its source
  // and keeps only the id, so ops on that copy survive. Everything but the id is
  // replaced, undefineds included, which is the point: a copy whose source lost
  // its parameters must lose them too.
  rewriteGeneratedRaw: (edit: { updates?: { id: string; d: string; name?: string; shapeParams?: ShapeParams | null; definition?: PathDefinition; clockSpec?: ClockSpec; fields?: Omit<ImportedPath, 'id'> }[]; add?: ImportedPath[]; deleteIds?: string[] }) => void
  updateShapeParams: (id: string, params: ShapeParams) => void
  duplicateSelected: (offsetMM?: number) => void
  splitPath: (id: string, subDs: string[]) => void
  showPath: (id: string) => void
  replacePaths: (paths: ImportedPath[]) => void
}

// Undo/redo lives in the timeline (src/timeline/timelineStore.ts): every
// mutating action here records a TimelineEvent, and undo/redo scrub the
// timeline cursor. There is no separate history stack anymore.

/**
 * The extra deletes and parameter updates that a delete of annotation parts
 * implies, or null if it implies none.
 *
 * A MARKING OR A REFERENCE CIRCLE THE USER DELETES IS A DECISION, NOT A GESTURE
 * — the parameter that draws it goes off with it (`ANNOTATION_SWITCH`). Without
 * that, the definition still says "draw the marking" and the next regeneration
 * is entitled to bring it back: delete a clock wheel's tooth-count number,
 * press Update clock, and there it is again. Every other part of a shape is
 * machined and its parameter is a number the user dials — a bore, a spoke count
 * — so deleting one of THOSE says nothing about the definition and is left
 * alone.
 *
 * The switch is written to every surviving part of the group — they share one
 * definition — and the OTHER parts that switch was drawing go in the same
 * atomic edit, so the drawing and the parameters agree at once and one undo
 * puts the lot back. Which parts those are is asked of the generator rather
 * than kept in a second table: regenerate with the switch off and drop whatever
 * the shape no longer has. Measured against a regeneration with the switch
 * still ON, because a marking is missing from BOTH when the single-stroke font
 * has yet to load, and "gone because the font is not here" must not read as
 * "gone because the user turned it off".
 */
function annotationSwitchOff(
  paths: ImportedPath[],
  deleteIds: string[],
  updates: PathUpdate[],
): { deleteIds: string[]; updates: PathUpdate[] } | null {
  const doomed = new Set(deleteIds)
  const patches = new Map<string, Record<string, unknown>>()
  for (const p of paths) {
    if (!doomed.has(p.id) || !p.groupId || p.shapePart === undefined || !p.shapeParams) continue
    const patch = ANNOTATION_SWITCH[p.shapeParams.type]?.[p.shapePart]
    if (patch) patches.set(p.groupId, { ...(patches.get(p.groupId) ?? {}), ...patch })
  }
  if (patches.size === 0) return null

  // A caller already writing the group's definition in this same edit speaks for
  // it — `updateShapeParams` drops a part BECAUSE its switch went off, and
  // re-deriving the params from the old ones here would undo whatever else it
  // changed.
  const spoken = new Set(updates.filter((u) => u.shapeParams !== undefined).map((u) => u.id))

  const nextDeletes = [...deleteIds]
  const nextUpdates = [...updates]
  const byId = new Map(nextUpdates.map((u, i) => [u.id, i]))
  for (const [groupId, patch] of patches) {
    const members = paths.filter((p) => p.groupId === groupId && p.shapePart !== undefined && p.shapeParams)
    if (members.length === 0 || members.some((m) => spoken.has(m.id))) continue
    const params = members[0].shapeParams!
    const next = { ...params, ...patch } as ShapeParams
    const before = new Set((generateShapeParts(params) ?? []).map((pt) => pt.part))
    const after = new Set((generateShapeParts(next) ?? []).map((pt) => pt.part))
    for (const m of members) {
      if (doomed.has(m.id)) continue
      if (before.has(m.shapePart!) && !after.has(m.shapePart!)) { nextDeletes.push(m.id); continue }
      const at = byId.get(m.id)
      if (at !== undefined) nextUpdates[at] = { ...nextUpdates[at], shapeParams: next }
      else nextUpdates.push({ id: m.id, d: m.d, shapeParams: next })
    }
  }
  return { deleteIds: nextDeletes, updates: nextUpdates }
}

/**
 * Drop everything hanging off paths that are going away, in the SAME edit that
 * removes them.
 *
 * An operation or a tab naming a path that no longer exists is not merely
 * stale — it is a cut against geometry nobody can see, and it survives into the
 * G-code. So it goes visibly, and the one snapshot the caller records puts it
 * back in one undo. Each store is only written when something actually changed,
 * because a fresh array re-renders every subscriber.
 */
function dropDependentsOf(deleteIds: string[]): void {
  if (deleteIds.length === 0) return
  const opsBefore = useToolpathStore.getState().operations
  const newOps = opsBefore.filter((op) => !deleteIds.some((id) => refsPathId(op, id)))
  if (newOps.length !== opsBefore.length) useToolpathStore.getState().replaceOperations(newOps)
  const tabsBefore = useTabStore.getState().tabs
  const newTabs = tabsBefore.filter((t) => !deleteIds.includes(t.pathId))
  if (newTabs.length !== tabsBefore.length) useTabStore.getState().replaceTabs(newTabs)
}

/**
 * Drop the constraints with an end on any of `ids`, and hand back what is left.
 *
 * Same doctrine as the operations above: a constraint with a deleted end has
 * nothing left to say, it goes visibly, and one undo restores it. Returns the
 * surviving list so a caller mid-solve can carry on with it rather than reading
 * the store back.
 */
function dropConstraintsTouching(ids: string[]): Constraint[] {
  const cs = useConstraintsStore.getState()
  const doomed = new Set(constraintsTouching(cs.constraints, ids).map((c) => c.id))
  if (doomed.size === 0) return cs.constraints
  const kept = cs.constraints.filter((c) => !doomed.has(c.id))
  cs.replaceConstraints(kept)
  return kept
}

/**
 * One path, with one update applied.
 *
 * Lifted out of `applyPathEdit`'s map so the CONSTRAINT SOLVE can go through it
 * too. A constraint moves a part by emitting a translate — and, when it holds
 * the angle between two parts, a rotate before it — exactly as a drag does, and
 * it must land the same way: folded into `placement` when the path has
 * parameters that cannot absorb it, absorbed into those parameters when they
 * can, carrying the corner recipe either way. A second copy of these rules would
 * be a second set of them to keep in step. It matters more for the rotate than
 * for the translate: `placement` is where a part's ANGLE is recorded, and the
 * angle is what the next solve reads back to work out the frame it measures in.
 */
function applyUpdateToPath(p: ImportedPath, upd: PathUpdate): ImportedPath {
  const newPath = { ...p, d: upd.d }
  // Repositioning one part of a multi-part shape is recorded as that
  // part's PLACEMENT. Its params are the whole GROUP's definition, so
  // translating them here made the group's copies disagree and the next
  // parameter step regenerated everything from one of them, throwing the
  // arrangement away — and a rotate cleared them outright, which took the
  // part out of the group for good. Neither now happens: the definition
  // is untouched and the offset from it is remembered.
  //
  // A SINGLE parametric shape takes the same road, and the rule for it is
  // that PARAMETERS ARE NEVER LOST TO A GESTURE. `shapeParams: null` used
  // to mean "throw them away"; it now means only "the parameters could
  // not absorb this step" — a rotate, a skew, a mirror, or a stretch of
  // something with no aspect ratio to stretch — and the step SPILLS into
  // the placement recipe instead. The definition goes on regenerating
  // from the parameters and the recipe carries it back out to where the
  // shape actually sits, so a spirograph that has been turned, stretched
  // and dragged still opens with its loop count and still has it applied.
  //
  // Absorbing is preferred wherever it works, because it is what keeps
  // the panel's own fields live: a plain drag moves x/y, and a scale a
  // shape CAN express changes its size (a gear's module, a rectangle's
  // W/H). Once a placement exists, repositioning must fold into it rather
  // than splitting across the two — leaving the recipe's pivots in
  // coordinates the parameters had since moved out of would throw the
  // shape across the stock on the next parameter edit.
  //
  // A path with NO parameters — a pen path, an imported outline — records
  // its transforms here too, and that is the whole of what makes the
  // properties panel's Transform section work the same way for every
  // path. Nothing regenerates such a path (there is no definition to
  // regenerate FROM, so `d` stays baked and `applyPlacementD` is never
  // called on it), which makes this a RECORD rather than a recipe. It is
  // still the only place the answer to "how far is this turned?" exists:
  // without it a rotated pen path reports 0°, because a rotation baked
  // into a polyline is unrecoverable from the polyline.
  const spilled = upd.shapeParams === null && p.shapeParams !== undefined
  const reposition = (upd.transforms?.length ?? 0) > 0 && (
    spilled
    || p.shapeParams === undefined
    || (isPlacementOnly(upd.transforms) &&
        (p.shapePart !== undefined || (p.placement?.length ?? 0) > 0))
  )
  if (reposition) {
    newPath.placement = foldPlacement(p, upd.transforms!)
  } else if (upd.shapeParams !== undefined) {
    newPath.shapeParams = upd.shapeParams ?? undefined
    // The PLACEMENT IS NOT CLEARED WITH THEM. It was, on the reasoning
    // that a recipe with no definition left to carry is dead weight —
    // true while only a parametric shape had one, and wrong now that a
    // path without parameters keeps its placement as the RECORD of how far
    // it has been turned. Chamfering a rotated rectangle is exactly that
    // case: `d` is rewritten and the parameters go (a chamfered rectangle
    // is no longer {x,y,w,h}), but the rectangle is still standing at 37°
    // and the record is the only place that number exists — cleared, the
    // panel read 0° under a visibly rotated shape. Nothing re-applies it,
    // so a `d` rewrite cannot put it out of step with the geometry; only a
    // gesture that actually turns the path changes what it says.
  }
  // Corner treatments are a recipe over an untreated outline, so they
  // survive exactly as long as that outline still describes this path:
  //  - an edit carrying a `corner` recipe REPLACES them (the form always
  //    sends the full cumulative map, never a delta);
  //  - a pure transform CARRIES them, base outline and radii together, so
  //    moving a treated path does not cost it its chip;
  //  - anything else that rewrites `d` — node edits, weld, trim, boolean —
  //    DROPS them, because `treatments` is keyed by corner index into the
  //    base outline and those indices now point at different corners.
  if (upd.corner) {
    const baseD = upd.cornerBaseD ?? p.corners?.baseD
    newPath.corners = baseD && upd.corner.length > 0
      ? { baseD, treatments: upd.corner.map((c) => [c.idx, { type: c.type, radiusMM: c.radiusMM }]) }
      : undefined
  } else if (p.corners && upd.transforms?.length) {
    // Still moved with the path, even though the transform is now ALSO
    // recorded in the placement. Nothing applies a non-parametric path's
    // placement (see above — it is a record, not a recipe), so the corner
    // form re-cuts straight from this base and writes `d` itself; leaving
    // the base behind would put a re-chamfered rectangle back where it was
    // first drawn. Pinned by `a move carries the base outline with it` in
    // scripts/corner-recipe-check.mts.
    newPath.corners = transformCorners(p.corners, upd.transforms)
  } else if (p.corners && upd.d !== p.d) {
    newPath.corners = undefined
  }
  if (upd.name !== undefined) {
    newPath.name = upd.name
  }
  if (upd.hidden !== undefined) {
    newPath.hidden = upd.hidden
  }
  if (upd.fromCenter !== undefined) {
    newPath.fromCenter = upd.fromCenter
  }
  if (upd.userGroups !== undefined) {
    newPath.userGroups = upd.userGroups.length > 0 ? upd.userGroups : undefined
  }
  return newPath
}

// The last constraint failure reported, so a document left over-constrained
// says so ONCE rather than on every subsequent edit. Cleared when a solve
// succeeds, so the next genuine failure is announced again.
let lastConstraintError: string | null = null

/**
 * Drop the constraints a delete has orphaned, then move whatever the surviving
 * ones say has to move.
 *
 * Runs inside the caller's atomic edit, on the paths as they will BE, and
 * returns the paths as they will FINALLY be. Both halves matter: dropping the
 * constraints here means the snapshot taken by the caller's `record` already has
 * them gone, so one undo brings back the path AND the constraints that named it;
 * and applying the moves here means the constrained part moves in the same
 * timeline entry as the part that drove it, rather than appearing as a second
 * mysterious Move chip the user did not make.
 *
 * A solve is IDEMPOTENT (see solveConstraints), so running it on every edit —
 * including the edits it itself caused, on the next gesture — costs nothing and
 * changes nothing once everything sits where it belongs.
 */
function enforceConstraints(
  paths: ImportedPath[],
  deleteIds: string[],
  anchorIds: string[] = [],
): { paths: ImportedPath[]; movedIds: string[] } {
  const cs = useConstraintsStore.getState()
  let constraints = cs.constraints
  if (constraints.length === 0) return { paths, movedIds: [] }
  if (deleteIds.length > 0) constraints = dropConstraintsTouching(deleteIds)
  if (constraints.length === 0) return { paths, movedIds: [] }
  const { widthMM, heightMM } = useWorkpieceStore.getState()
  // THE PARTS THIS EDIT TOUCHED ARE THE ANCHORS. There is no root in the
  // constraint graph — the walk starts from whatever the user just moved and
  // everything else follows it — so a chain can be dragged by any of its parts.
  const sol = solveConstraints(paths, constraints, { widthMM, heightMM }, anchorIds)
  if (sol.error) {
    // Refused, not half-applied: a loop or a contradiction has no answer, and
    // moving the parts anyway would be worse than leaving them where they are.
    if (sol.error !== lastConstraintError) {
      lastConstraintError = sol.error
      useUIStore.getState().showStatus(sol.error, 'warn')
    }
    return { paths, movedIds: [] }
  }
  lastConstraintError = null
  // A SECOND PASS FOR THE CONSTRAINTS THAT LIVE INSIDE ONE BODY — a pair of
  // shapes the user has since grouped. The first pass could not move them (a
  // body is rigid), and its moves and this one's name overlapping paths, so
  // this runs over the geometry the first pass leaves behind rather than being
  // merged into its list: going through the paths composes the two exactly,
  // rotations included. See `solveInnerConstraints`.
  const first = applyMoves(paths, sol)
  const inner = solveInnerConstraints(first.paths, constraints, { widthMM, heightMM }, anchorIds)
  if (inner.error) {
    if (inner.error !== lastConstraintError) {
      lastConstraintError = inner.error
      useUIStore.getState().showStatus(inner.error, 'warn')
    }
    return first
  }
  if (inner.moves.length === 0) return first
  const second = applyMoves(first.paths, inner)
  return {
    paths: second.paths,
    movedIds: [...new Set([...first.movedIds, ...second.movedIds])],
  }
}

/** Rewrite the paths one solve's moves name, leaving the rest untouched. */
function applyMoves(
  paths: ImportedPath[],
  sol: ConstraintSolution,
): { paths: ImportedPath[]; movedIds: string[] } {
  if (sol.moves.length === 0) return { paths, movedIds: [] }
  const byId = new Map<string, PathUpdate>()
  for (const mv of sol.moves) {
    // A TURN FIRST, THEN THE SLIDE, and the turn is about the very point the
    // constraint measures to — so the slide is the same number whether or not
    // the body also turned, which is what lets `runPlan` work them out
    // independently. A constraint that holds no angle between the parts emits
    // the pure translate it always did, and the geometry is byte-identical.
    const steps: TransformStep[] = []
    if (mv.rotDeg !== undefined && mv.pivot) {
      steps.push({ kind: 'rotate', angle: mv.rotDeg, cx: mv.pivot.x, cy: mv.pivot.y })
    }
    if (mv.dx !== 0 || mv.dy !== 0) steps.push({ kind: 'translate', dx: mv.dx, dy: mv.dy })
    if (steps.length === 0) continue
    for (const id of mv.pathIds) {
      const p = paths.find((q) => q.id === id)
      if (!p) continue
      const r = applyTransformSteps(p, steps)
      byId.set(id, { id, d: r.d, shapeParams: r.shapeParams, transforms: steps })
    }
  }
  if (byId.size === 0) return { paths, movedIds: [] }
  return {
    paths: paths.map((p) => { const u = byId.get(p.id); return u ? applyUpdateToPath(p, u) : p }),
    movedIds: [...byId.keys()],
  }
}

/**
 * Move whatever the constraints now say has to move, recording NOTHING.
 *
 * `anchorIds` is what must NOT move — for a constraint whose number has been
 * changed, that is its `from` end, which is the whole of what the dot on the
 * dimension line means: this end is held, the other one is derived.
 *
 * For the constraint actions themselves (`constraintsStore`): adding a
 * constraint or changing its distance has to move the parts, but the constraint
 * event is already the record of that decision — a second `paths.edit` would put
 * a Move chip in the strip for something the user did not do by hand, and cost a
 * second press of undo to get back. So this writes the paths and leaves the
 * history to the caller, which records afterwards so its snapshot holds both.
 */
export function applyConstraintSolve(anchorIds: string[] = []): void {
  const solved = enforceConstraints(usePathsStore.getState().paths, [], anchorIds)
  if (solved.movedIds.length === 0) return
  usePathsStore.setState({ paths: solved.paths })
  regenerateConstrained(solved.movedIds)
}

/**
 * Regenerate the toolpaths on parts a constraint moved.
 *
 * The gesture's own caller regenerates what IT touched (see bakeTransform) and
 * has no way to know a constraint carried something else along, so this is the
 * only place that owes those operations a rebuild. Dynamically imported for the
 * same reason the timeline's scheduled regen is: cam/regenerate reads this store
 * back, and a static import would close the cycle at module-evaluation time.
 */
function regenerateConstrained(ids: string[]): void {
  if (ids.length === 0) return
  void import('../cam/regenerate').then(({ regenerateAffectedMany }) => regenerateAffectedMany(ids))
}

export const usePathsStore = create<PathsState>()((set, get) => ({
  paths: [],
  selectedIds: [],
  collapsedGroups: new Set<string>(),

  addPaths: (newPaths, meta) => {
    set((s) => ({
      paths: [...s.paths, ...newPaths],
    }))
    useTimelineStore.getState().record(
      {
        kind: 'paths.add',
        paths: newPaths,
        source: meta?.source,
      },
      // Scrubbing to an add-event selects what it created (the caller's own
      // selectPath often runs after this record — see RecordMeta.selectionAfter)
      { label: meta?.label, selectionAfter: newPaths.map((p) => p.id) },
    )
  },

  // The delete actions all delegate to applyPathEdit — it owns the snapshot-
  // before-cleanup invariant (history, ops, tabs, selection) so the sequence
  // exists in exactly one place (bugs.md R1).
  deletePath: (id) => get().applyPathEdit({ deleteIds: [id] }),

  toggleVisibility: (id) => set((s) => ({
    paths: s.paths.map((p) => p.id === id ? { ...p, visible: !p.visible } : p),
  })),

  toggleGroupVisibility: (groupId) => set((s) => {
    const groupPaths = s.paths.filter((p) => inGroup(p, groupId))
    const allVisible = groupPaths.every((p) => p.visible)
    return { paths: s.paths.map((p) => inGroup(p, groupId) ? { ...p, visible: !allVisible } : p) }
  }),

  toggleGroupCollapsed: (groupId) => set((s) => {
    const next = new Set(s.collapsedGroups)
    if (next.has(groupId)) next.delete(groupId); else next.add(groupId)
    return { collapsedGroups: next }
  }),

  deleteGroup: (groupId) => {
    const s = get()
    const ids = s.paths.filter((p) => inGroup(p, groupId)).map((p) => p.id)
    if (ids.length === 0) return
    s.applyPathEdit({ deleteIds: ids })
  },

  selectPath: (id, extend = false) => set((s) => {
    if (id === null) return { selectedIds: [] }
    if (extend) {
      const already = s.selectedIds.includes(id)
      return { selectedIds: already ? s.selectedIds.filter((sid) => sid !== id) : [...s.selectedIds, id] }
    }
    return { selectedIds: [id] }
  }),

  setSelectedIds: (ids) => set({ selectedIds: ids }),

  // Groups NEST, so grouping PREPENDS: a group and a shape put together give a
  // group holding that group and that shape, and one Ungroup gives them back —
  // flattening instead handed back three loose paths, which is not what the user
  // put together.
  groupSelected: () => {
    const s = get()
    const members = s.paths.filter((p) => s.selectedIds.includes(p.id))
    if (members.length < 2) return
    // Already exactly one whole group and nothing else: grouping it again would
    // only add a level with nothing else in it.
    const gid0 = outerGroupOf(members[0])
    if (gid0 && members.every((p) => outerGroupOf(p) === gid0)
      && s.paths.filter((p) => outerGroupOf(p) === gid0).length === members.length) return
    const gid = uid('ugroup')
    s.applyPathEdit({
      updates: members.map((p) => ({ id: p.id, d: p.d, userGroups: [gid, ...(p.userGroups ?? [])] })),
      label: 'Group',
    })
  },

  // Takes ONE level off every group the selection touches, whole — a group is one
  // thing, so taking one path out of one is not what "ungroup" means, and
  // selecting a member is already selecting all of them anyway. What was inside
  // is now what the members belong to.
  ungroupSelected: () => {
    const s = get()
    const gids = new Set(s.paths
      .filter((p) => s.selectedIds.includes(p.id))
      .flatMap((p) => { const g = outerGroupOf(p); return g ? [g] : [] }))
    if (gids.size === 0) return
    const members = s.paths.filter((p) => { const g = outerGroupOf(p); return !!g && gids.has(g) })
    s.applyPathEdit({
      updates: members.map((p) => ({ id: p.id, d: p.d, userGroups: p.userGroups!.slice(1) })),
      label: 'Ungroup',
      selectAfter: members.map((p) => p.id),
    })
  },

  deleteSelected: () => {
    const s = get()
    if (s.selectedIds.length === 0) return
    s.applyPathEdit({ deleteIds: s.selectedIds })
  },

  updatePathD: (id, newD) => get().applyPathEdit({ updates: [{ id, d: newD }] }),

  batchUpdatePaths: (updates, gesture) => get().applyPathEdit({ updates, gesture }),

  rewritePathRaw: (id, upd) => set((s) => ({
    paths: s.paths.map((p) => p.id === id ? { ...p, d: upd.d, ...(upd.name !== undefined ? { name: upd.name } : {}) } : p),
  })),

  rewriteGeneratedRaw: ({ updates = [], add = [], deleteIds = [] }) => {
    const s = get()
    dropDependentsOf(deleteIds)
    const map = new Map(updates.map((u) => [u.id, u]))
    const paths = s.paths
      .filter((p) => !deleteIds.includes(p.id))
      .map((p) => {
        const upd = map.get(p.id)
        if (!upd) return p
        return {
          ...p, ...(upd.fields ?? {}), id: p.id, d: upd.d,
          ...(upd.name !== undefined ? { name: upd.name } : {}),
          ...(upd.shapeParams !== undefined ? { shapeParams: upd.shapeParams ?? undefined } : {}),
          ...(upd.definition !== undefined ? { definition: upd.definition } : {}),
          ...(upd.clockSpec !== undefined ? { clockSpec: upd.clockSpec } : {}),
        }
      })
    // A group amend moves real geometry — a gear's module is stepped and its rim
    // grows — so the constraints hanging off it are re-solved here as well. This
    // path records nothing (the chip it amends already stands for the edit), and
    // neither does the solve.
    const solved = enforceConstraints(
      add.length > 0 ? [...paths, ...add] : paths, deleteIds,
      [...updates.map((u) => u.id), ...add.map((a) => a.id)])
    set({
      paths: solved.paths,
      ...(deleteIds.length > 0
        ? { selectedIds: s.selectedIds.filter((sid) => !deleteIds.includes(sid)) }
        : {}),
    })
    regenerateConstrained(solved.movedIds)
  },

  applyPathEdit: ({ updates = [], add = [], deleteIds = [], label, gesture, selectAfter }) => {
    if (updates.length === 0 && add.length === 0 && deleteIds.length === 0) return
    const s = get()
    // Deleting a marking or a pitch circle turns its switch off across the whole
    // shape, in THIS edit — so the ops/tabs cleanup below covers the parts that
    // go with it and one undo puts everything back. See ANNOTATION_SWITCH.
    if (deleteIds.length > 0) {
      const off = annotationSwitchOff(s.paths, deleteIds, updates)
      if (off) { deleteIds = off.deleteIds; updates = off.updates }
    }
    dropDependentsOf(deleteIds)
    const map = new Map(updates.map((u) => [u.id, u]))
    let paths = s.paths
      .filter((p) => !deleteIds.includes(p.id))
      .map((p) => {
        const upd = map.get(p.id)
        return upd ? applyUpdateToPath(p, upd) : p
      })
    if (add.length > 0) paths = [...paths, ...add]
    // EVERY CONSTRAINT IS RE-SOLVED HERE, INSIDE THIS SAME EDIT. Every gesture
    // that moves geometry comes through applyPathEdit — a canvas drag, a typed
    // position, a boolean, a node edit, an offset — so this is the one place it
    // has to happen, and doing it here rather than afterwards is what makes a
    // constrained part follow in ONE timeline entry and come back in ONE undo.
    // It is a pure pre-pass over the paths as they will BE, so there is no
    // re-entrancy: nothing here calls back into applyPathEdit.
    const solved = enforceConstraints(
      paths, deleteIds, [...updates.map((u) => u.id), ...add.map((a) => a.id)])
    paths = solved.paths
    set({
      paths,
      // Only touch selection when the caller asks (selectAfter) or something
      // was deleted — a fresh array reference here would needlessly re-render
      // every selectedIds subscriber on plain batch updates.
      ...(selectAfter
        ? { selectedIds: selectAfter }
        : deleteIds.length > 0
          ? { selectedIds: s.selectedIds.filter((sid) => !deleteIds.includes(sid)) }
          : {}),
    })
    useTimelineStore.getState().record(
      {
        kind: 'paths.edit',
        updates,
        ...(add.length > 0 ? { add } : {}),
        ...(deleteIds.length > 0 ? { deleteIds } : {}),
        ...(gesture ? { gesture } : {}),
      },
      { label, selectionAfter: selectAfter },
    )
    regenerateConstrained(solved.movedIds)
  },

  updateShapeParams: (id, params) => {
    const s0 = get()
    const self = s0.paths.find((p) => p.id === id)
    // A multi-part shape (a gear's teeth/bore/spokes) is several paths sharing
    // one set of params, so editing any one of them has to regenerate all of
    // them — and add or drop paths as parts appear and vanish, since turning the
    // spokes to 0 or the bore to 0 removes a part outright.
    const parts = self?.shapePart !== undefined ? generateShapeParts(params) : null
    if (self && parts) {
      const siblings = s0.paths.filter((p) => p.groupId === self.groupId && p.shapePart !== undefined)
      const byPart = new Map(siblings.map((p) => [p.shapePart!, p]))
      const updates: PathUpdate[] = []
      const add: ImportedPath[] = []
      // The placement the WHOLE group shares, if it shares one — a gear turned
      // 37° gives every part the same recipe, and a part that appears mid-edit
      // has to be turned with them or the spokes come back lying flat inside a
      // rotated rim. Only when they ALL agree: once a part has been dragged off
      // on its own the group has no single answer, and inheriting one part's
      // displacement would drop the new part wherever that one was moved to —
      // so a group that disagrees answers per-part instead, below.
      const agreed = siblings.length > 0 && (() => {
        const first = JSON.stringify(siblings[0].placement ?? null)
        return siblings.every((p) => JSON.stringify(p.placement ?? null) === first)
      })()
      const groupPlacement = agreed ? siblings[0].placement : undefined
      // …and when they DON'T agree, the placement of the BODY the new part sits
      // on. A group can be several bodies drawn apart — a clock wheel's group is
      // the wheel AND the pinion it drives, laid out side by side — so dragging
      // one of them and leaving the other is an ordinary thing to do, and it
      // left the group with no single answer: a marking deleted and then brought
      // back by an Update clock came back at the spot the wheel was GENERATED
      // at, while every part that still existed stayed where it had been dragged
      // to. Nearest in DEFINITION space, which is where this regeneration
      // measures everything anyway, so there is no per-shape table of which part
      // belongs to which body: a gear's marking lands on its teeth and a
      // pinion's marking on the pinion. Lazy, because it flattens every part of
      // the shape and nothing but an appearing part needs it.
      let nominal: Map<string, { x: number; y: number }> | null = null
      const placementForNew = (part: string): TransformStep[] | undefined => {
        if (agreed || siblings.length === 0) return groupPlacement
        if (!nominal) {
          nominal = new Map()
          for (const pt of parts) {
            const b = getBBox(pt.d)
            if (b) nominal.set(pt.part, { x: b.cx, y: b.cy })
          }
        }
        const c = nominal.get(part)
        if (!c) return undefined
        let best: ImportedPath | undefined
        let bestD = Infinity
        for (const sib of siblings) {
          const sc = nominal.get(sib.shapePart!)
          if (!sc) continue
          const d = Math.hypot(sc.x - c.x, sc.y - c.y)
          if (d < bestD) { bestD = d; best = sib }
        }
        if (!best) return undefined
        // NEAREST IS ONLY AN ANSWER WHEN IT IS AN UNAMBIGUOUS ONE. Bodies laid out
        // side by side are a body's width apart, but the parts WITHIN one body sit
        // on top of each other — a gear's teeth, bore and spokes share a centre to
        // within a fraction of a millimetre, and which of them comes out "nearest"
        // is decided by the asymmetry of a tooth. So a gear whose BORE had been
        // dragged off on its own handed the returning spokes the bore's
        // displacement, by a margin of 0.1 mm on a 200 mm gear: the spokes came
        // back 25 mm out of the rim they belong in, and nothing said so.
        //
        // A sibling this close to the winner is just as good a candidate as the
        // winner, so if it disagrees there is NO answer and the part goes back at
        // its nominal spot — visible, and where a regeneration would put it. The
        // floor covers exact concentricity, where the ratio alone collapses to
        // "only a sibling at the identical centre counts".
        const SAME_BODY_RATIO = 3
        const SAME_BODY_FLOOR_MM = 1
        const asClose = bestD * SAME_BODY_RATIO + SAME_BODY_FLOOR_MM
        const winner = JSON.stringify(best.placement ?? null)
        for (const sib of siblings) {
          const sc = nominal.get(sib.shapePart!)
          if (!sc) continue
          if (Math.hypot(sc.x - c.x, sc.y - c.y) > asClose) continue
          if (JSON.stringify(sib.placement ?? null) !== winner) return undefined
        }
        return best.placement
      }
      for (const pt of parts) {
        const existing = byPart.get(pt.part)
        // Generated geometry is where the definition NOMINALLY puts this part;
        // carrying it out to where the user actually dragged it is what keeps a
        // gear's pinion still on the far side of the stock after the module is
        // stepped.
        if (existing) { updates.push({ id: existing.id, d: applyPlacementD(pt.d, existing.placement), shapeParams: params }); continue }
        const placement = placementForNew(pt.part)
        add.push({
          id: uid('shape'), name: `${self.groupName ?? self.name} ${pt.label}`,
          d: applyPlacementD(pt.d, placement), placement,
          visible: true, color: self.color, shapeParams: params, shapePart: pt.part,
          groupId: self.groupId, groupName: self.groupName,
          // A part that appears mid-edit (spokes turned back on) belongs to the
          // same clock wheel as its siblings — without this the link is on some
          // of a group's paths and not others.
          clockId: self.clockId, clockPart: self.clockPart, clockSpec: self.clockSpec,
          // …and to the user groups the shape was put in, for the same reason.
          userGroups: self.userGroups,
        })
      }
      const live = new Set(parts.map((pt) => pt.part))
      const deleteIds = siblings.filter((p) => !live.has(p.shapePart!)).map((p) => p.id)
      // A params edit is an argument edit to the call that created the shape, so while
      // the step that placed or last re-defined it is the LATEST one, the edit JOINS that
      // step rather than recording — stepping a gear's bore must not leave an undo step
      // per keystroke, the same rule single-path shapes follow below. An older step is
      // left alone and this records its own, so the edit has an undo step of its own (see
      // joinsTip in timelineStore); the next keystroke then joins THAT.
      const tl = useTimelineStore.getState()
      if (self.groupId && tl.joinsTip(siblings.map((p) => ({ path: p.id })))) {
        // Nothing is recorded, so the live paths move raw — rewriteGeneratedRaw still
        // drops the operations and tabs of a part that has gone.
        get().rewriteGeneratedRaw({
          updates: updates.map((u) => ({ id: u.id, d: u.d!, shapeParams: params })),
          add, deleteIds,
        })
      } else {
        // One atomic edit: one undo step, and operations on a part that has gone away
        // are cleaned up with it. Later keystrokes join this step.
        get().applyPathEdit({ updates, add, deleteIds, label: shapeDisplayName(params.type) })
      }
      return
    }
    // Same rule as the multi-part branch above: what `generateShapeD` returns is
    // where the DEFINITION puts the shape, and the placement recipe is what
    // carries it out to where it actually sits — so a rotated spirograph stays
    // rotated when its loop count is stepped.
    const d = applyPlacementD(generateShapeD(params), self?.placement)
    const solved = enforceConstraints(
      s0.paths.map((p) => p.id === id ? { ...p, d, shapeParams: params } : p), [], [id])
    set({ paths: solved.paths })
    regenerateConstrained(solved.movedIds)
    // Parameter edits join the step that created/last defined the shape when it is the
    // latest step — changing text or a star's point count is an argument edit to that
    // call. Otherwise (an older definer, or none) this records a shape.params step, which
    // later keystrokes join.
    const tl = useTimelineStore.getState()
    if (!tl.joinsTip([{ path: id }])) {
      tl.record({ kind: 'shape.params', pathId: id, params })
    }
  },

  // Soft-HIDING is not a standalone action anymore — the boolean op (its only
  // user) hides originals inside its atomic applyPathEdit via PathUpdate.hidden.
  // Un-hiding from the paths panel stays a user-visible event.
  showPath: (id) => {
    set((s) => ({
      paths: s.paths.map((p) => p.id === id ? { ...p, hidden: false } : p),
    }))
    useTimelineStore.getState().record({ kind: 'paths.setHidden', ids: [id], hidden: false })
  },

  splitPath: (id, subDs) => {
    const s = get()
    if (subDs.length <= 1) return
    const idx = s.paths.findIndex((p) => p.id === id)
    if (idx === -1) return
    const orig = s.paths[idx]
    const newPaths: ImportedPath[] = subDs.map((subD, i) => ({
      id: uid('path-split'),
      name: `${orig.name} ${i + 1}`,
      d: subD,
      color: orig.color,
      visible: orig.visible,
      hidden: orig.hidden,
      groupId: orig.groupId,
      groupName: orig.groupName,
      userGroups: orig.userGroups,
    }))
    const opsBefore = useToolpathStore.getState().operations
    const tabsBefore = useTabStore.getState().tabs
    // How each operation follows the split — cloned, remapped or dropped — is
    // decided by `remapOpsForSplit`, which is pure and tested. One undo of the
    // paths.split event puts any of it back.
    const { ops: newOps, changed: opsChanged } =
      remapOpsForSplit(opsBefore, id, newPaths.map((p) => p.id))
    if (opsChanged) useToolpathStore.getState().replaceOperations(newOps)
    // Tab positions are arc-length fractions along the whole compound path — they
    // don't map onto the sub-paths, so drop them.
    const newTabs = tabsBefore.filter((t) => t.pathId !== id)
    if (newTabs.length !== tabsBefore.length) useTabStore.getState().replaceTabs(newTabs)
    // A constraint on the compound path goes with it, for the reason an
    // operation does (see remapOpsForSplit): its endpoint was a bbox or a circle
    // of the WHOLE outline, and no one sub-path inherits that. Cloning it onto
    // each piece would silently start moving parts to a distance the user never
    // asked for; losing it is visible, and one undo brings it back.
    dropConstraintsTouching([id])
    set({
      paths: [...s.paths.slice(0, idx), ...newPaths, ...s.paths.slice(idx + 1)],
      selectedIds: newPaths.map((p) => p.id),
    })
    useTimelineStore.getState().record({
      kind: 'paths.split',
      pathId: id,
      subPaths: newPaths,
      opsAfter: opsChanged ? newOps.map(serializeOp) : null,
    })
  },

  duplicateSelected: (offsetMM = 5) => {
    const s = get()
    if (s.selectedIds.length === 0) return

    // THE SAME COPY PASTE MAKES (store/copyPaths) — ids reissued consistently, recipes kept
    // when their ingredients come too, the nudge through placement or params, corner
    // recipes moved. The selection takes the HIDDEN paths it is generated from along, so a
    // duplicated boolean is a real one; a recipe that cannot come records where the copy was
    // copied FROM, since the original is in this document.
    const copySet = withHiddenSources(s.selectedIds, s.paths)
    const { paths: newPaths, tabs, constraints, newIdOf } = copyPaths(
      copySet, useTabStore.getState().tabs, useConstraintsStore.getState().constraints,
      { offsetMM, pathIdPrefix: 'path-dup', rename: (n) => `${n} copy`, lostRecipe: 'copied-from' },
    )
    // Installed raw, inside this one edit, so a single undo takes them back with the paths.
    // Holding tabs travel now — Duplicate used to leave them on the original only, which
    // Paste never did.
    if (constraints.length > 0) {
      const cs = useConstraintsStore.getState()
      cs.replaceConstraints([...cs.constraints, ...constraints])
    }
    if (tabs.length > 0) {
      const ts = useTabStore.getState()
      ts.replaceTabs([...ts.tabs, ...tabs])
    }
    set({
      paths: [...s.paths, ...newPaths],
      // Only the copies of what was actually SELECTED: an operand dragged along
      // is hidden, and selecting something invisible leaves the panel describing
      // a thing that is not on screen.
      selectedIds: s.selectedIds.flatMap((id) => {
        const made = newIdOf.get(id)
        return made ? [made] : []
      }),
    })
    useTimelineStore.getState().record({ kind: 'paths.add', paths: newPaths, source: 'duplicate' })
  },

  replacePaths: (paths) => {
    // Load machinery: the constraints for THIS document are installed separately
    // (projectLoad), so drop any left over from the last one rather than letting
    // them point at ids that no longer exist.
    const live = new Set(paths.map((p) => p.id))
    const cs = useConstraintsStore.getState()
    const kept = cs.constraints.filter((c) =>
      (c.from.kind === 'stock' || live.has(c.from.id))
      && (c.to.kind === 'stock' || live.has(c.to.id)))
    if (kept.length !== cs.constraints.length) cs.replaceConstraints(kept)
    set({ paths, selectedIds: [] })
  },
}))

// A clock's spec, carried by every one of its parts (see ImportedPath.clockSpec).
// Any part will do — they are stamped together and restamped together.
export function clockSpecOf(paths: ImportedPath[], clockId: string | null | undefined): ClockSpec | undefined {
  if (!clockId) return undefined
  return paths.find((p) => p.clockId === clockId && p.clockSpec)?.clockSpec
}

// Restamp a clock's spec across all of its parts. Deliberately NOT recorded: it
// is a property of the parts, not an edit in its own right, and the arrangement
// it usually carries moves no geometry at all.
export function setClockSpec(clockId: string, spec: ClockSpec): void {
  const paths = usePathsStore.getState().paths.filter((p) => p.clockId === clockId)
  if (paths.length === 0) return
  usePathsStore.getState().rewriteGeneratedRaw({
    updates: paths.map((p) => ({ id: p.id, d: p.d, clockSpec: spec })),
  })
}

// Carry a corner recipe through a transform: the base outline moves with the
// path and the radii scale with it. √|det| is the uniform scale factor — exact
// for move/rotate/mirror/uniform-scale, which is every transform that leaves a
// corner recognisably the same corner. Under skew or a non-uniform scale it is
// only the best available answer, and NodeEditForm's own validity check
// (does the recipe still reproduce `d`?) is the authority when the form reopens.
function transformCorners(
  corners: NonNullable<ImportedPath['corners']>,
  steps: TransformStep[],
): NonNullable<ImportedPath['corners']> {
  const m = placementMat(steps)
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1
  return {
    baseD: applyPlacementD(corners.baseD, steps),
    treatments: corners.treatments.map(([i, t]) => [i, { ...t, radiusMM: t.radiusMM * scale }]),
  }
}

/** Undo a path's corner treatments, restoring the outline they were cut from. */
export function clearCorners(pathId: string): void {
  const p = usePathsStore.getState().paths.find((q) => q.id === pathId)
  if (!p?.corners) return
  usePathsStore.getState().applyPathEdit({
    updates: [{ id: p.id, d: p.corners.baseD, corner: [] }],
    label: 'Remove corners',
    gesture: 'corner',
  })
}

// The selected paths, in canvas z-order. Every operation form and the
// properties panel needs this, and each used to spell out
// `paths.filter((p) => selectedIds.includes(p.id))` — an O(paths × selection)
// scan re-run on every render.
//
// Memoized rather than selected inline: a selector that builds a new array
// would hand useSyncExternalStore a fresh reference on every store read, so
// the component would re-render on unrelated store changes.
export function useSelectedPaths(): ImportedPath[] {
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  return useMemo(() => {
    const sel = new Set(selectedIds)
    return paths.filter((p) => sel.has(p.id))
  }, [paths, selectedIds])
}

// The selected paths in the order they were PICKED, not in z-order — `selectPath`
// appends each extend-click, so `selectedIds` already records it.
//
// For an operation whose operands are interchangeable (union, intersection, a
// properties edit) z-order is the better reading and `useSelectedPaths` is the
// one to use. This is for the ones where the FIRST pick means something: a
// subtraction keeps path 1 and cuts the rest away from it, and taking that from
// z-order silently subtracts the wrong way round whenever the tool happens to sit
// below the workpiece in the list. A rubber-band selection has no pick order to
// record, so it still lands in z-order; the form shows the roles so it is visible
// either way.
export function useSelectedPathsInOrder(): ImportedPath[] {
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  return useMemo(() => {
    const byId = new Map(paths.map((p) => [p.id, p]))
    return selectedIds.flatMap((id) => { const p = byId.get(id); return p ? [p] : [] })
  }, [paths, selectedIds])
}
