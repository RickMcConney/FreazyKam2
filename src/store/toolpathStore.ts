import { create } from 'zustand'
import { OP_TYPE_COLORS } from '../colors'
import { uid } from '../uid'
import { useTimelineStore } from '../timeline/timelineStore'
import { serializeOp, DERIVED_OP_KEYS, type SerializedOperation } from '../timeline/events'
import { useWorkpieceStore } from './workpieceStore'
import type { CuttingDirection } from './toolStore'
import type { StartFrom } from '../cam/startHeight'
import { resolveStartZForOp } from '../cam/startHeight'
import { usePathsStore } from './pathsStore'
import { useToolStore } from './toolStore'
export type CutSide = 'inside' | 'outside' | 'centerline'
type OperationStatus = 'pending' | 'generating' | 'done' | 'needs-update' | 'error'

export interface MotionSegment {
  x: number
  y: number
  z: number
  rapid: boolean
  travel?: boolean      // stay-down micro-lift transition (not cutting, not full safe-height rapid)
  arc?: { cx: number; cy: number; cw: boolean }  // absolute arc center + direction; G2=cw, G3=ccw
  toolChange?: string  // toolId: emit tool-change gcode at this point, no movement
  feedScale?: number   // multiplier applied to computed feed rate (default 1.0)
}

/** The inputs a set of segments was generated from — see BaseOperation.generatedWith. */
export type GeneratedWith = { entryHint?: { x: number; y: number }; safeHeightMM: number; startZMM?: number }

interface DrillPoint {
  x: number
  y: number
}

interface BaseOperation {
  id: string
  name: string
  toolId: string
  status: OperationStatus
  segments: MotionSegment[]
  color: string
  visible: boolean
  errorMessage?: string
  // Operations created by ONE Generate click over several selected paths share a batchId.
  // They are one decision, so they are one timeline chip and one thing to edit: opening
  // any member in its form edits every operation in the batch. Absent = created alone.
  batchId?: string
  // Which surface the cut starts from. A REFERENCE, not a number: it re-resolves against
  // the preceding operations every time this one generates, so engraving in a pocket
  // follows that pocket when its depth changes. Absent = auto. See cam/startHeight.ts.
  startFrom?: StartFrom
  entryHint?: { x: number; y: number }
  // The generation inputs the CURRENT segments were actually built from, stamped by
  // setSegments. It exists so a simulate or export can tell whether regenerating would
  // change anything at all, and so revalidateStartHeights can tell an op whose floor moved.
  //
  // `entryHint` alone can't answer that: generating from a form ignores the hint, so the
  // stored hint outlives the segments it produced. `safeHeightMM` is here because it is
  // the one setting outside the operation that changes what generation emits, and nothing
  // marks operations stale for it.
  generatedWith?: GeneratedWith
}

export interface ProfileOperation extends BaseOperation {
  type: 'profile'
  pathId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  rampIn: boolean
  /** Stock left on the wall (negative cuts past the line). Ignored for centerline. */
  allowanceMM?: number
}

export interface PocketOperation extends BaseOperation {
  type: 'pocket'
  pathId: string
  islandIds: string[]
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
  direction: CuttingDirection
  strategy: 'raster' | 'contour' | 'adaptive' | 'morph' | 'adaptive2' | 'hybrid'
  /** Auto pass angle (hybrid only); false pins it to passAngleDeg. */
  autoAngle?: boolean
  rampIn: boolean
  allowanceMM?: number   // finish allowance: stock left on all walls (negative grows the pocket)
  // Which half of a nested selection this pocket came from. It is not derivable from
  // `pathId`/`islandIds` afterwards — a boundary and its islands look the same whichever
  // parity produced them — so without it the form reopened un-inverted and the checkbox
  // said the opposite of what the operation had done. Absent on ops saved before this and
  // on every un-inverted pocket; read as false.
  invert?: boolean
}

export interface DrillOperation extends BaseOperation {
  type: 'drill'
  drillMode: 'peck' | 'helical'
  /** Peck: where to plunge. Derived from `pathId`'s circles when it has one. */
  points: DrillPoint[]
  pathId?: string
  /** Helical: every hole this op bores. One path is not one hole — a pinion's pin
   *  ring is eight — so this is a list, like `points`. Derived from `pathId` at
   *  generation. The three singular fields below are what ops saved before this
   *  carry; they are the fallback, never the source when this is set. */
  helicalHoles?: { cx: number; cy: number; radiusMM: number }[]
  helicalCenterX?: number
  helicalCenterY?: number
  helicalRadius?: number
  depthMM: number
  stepDownMM: number
}

export interface SurfaceOperation extends BaseOperation {
  type: 'surface'
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
}

export interface VCarveOperation extends BaseOperation {
  type: 'vcarve'
  pathId: string
  islandIds: string[]
  maxDepthMM: number
  angleDeg: number
}

// Carves a photo as parallel V-grooves whose depth tracks image brightness. `pathId` is
// an image-backed path (ImportedPath.imageSrc) — the picture is pinned to that path's
// rectangle, so moving or resizing it moves the carve. Depths run DOWN FROM the surface
// `startFrom` resolves to (BaseOperation), not from the stock top: a photo dropped into
// the floor of a pocket carves the same greyscale band into that floor. The carve itself
// leaves a groove field, never a flat floor, so nothing can start from it.
export interface PhotoVCarveOperation extends BaseOperation {
  type: 'photovcarve'
  pathId: string
  angleDeg: number       // V-bit included angle (from the tool)
  passAngleDeg: number   // raster direction, CCW from the image's own bottom edge
  minDepthMM: number     // depth cut where the image is white
  maxDepthMM: number     // depth cut where the image is black
  // No line spacing: it is the width of the deepest groove, derived from maxDepthMM and
  // the bit angle at generation time (cam/photoVcarve.ts). Storing it would let a copy
  // drift from the depth that defines it.
}

// vbitToolId sentinel: skip the finish/wall pass entirely (female roughing-only —
// just the raster pocket, no separate wall-finish contour). Only valid for female.
export const INLAY_NO_FINISH = 'none'

export interface InlayOperation extends BaseOperation {
  type: 'inlay'
  role: 'female' | 'male'
  phase: 'vbit' | 'endmill'  // which tool phase this operation represents
  pathId: string
  islandIds: string[]
  // Male only, parallel to islandIds: the paths nested directly inside each island — the
  // next level's plugs, which the male must leave standing inside the hole it cuts.
  // Absent on projects saved before nested inlay support; treated as "no nesting".
  islandPlugIds?: string[][]
  // Male only, inverted grouping: the selected path this plug stands INSIDE. Its interior,
  // minus every plug standing in it, is background the male clears to the mating plane —
  // without it the male board rests on the female's uncut face. Set on ONE op per field
  // (the first of its plugs); `fieldPlugIds` are the others it must leave standing.
  fieldId?: string
  fieldPlugIds?: string[]
  pocketToolId: string    // flat end mill ID (always the endmill, regardless of phase)
  vbitToolId: string      // vbit ID (always the vbit, regardless of phase)
  angleDeg: number
  pocketDepthMM: number
  stepDownMM: number
  stepoverPercent: number
  glueLineMM: number
  clearanceMM: number
  rampIn: boolean         // ramp/helical entry on roughing pockets instead of straight plunge
  mirrorX?: boolean       // male only: mirror shape around vertical axis before cutting
  mirrorAxisX?: number    // male only: X of that axis, shared by every op cut from one board
  linkedOpId?: string     // ID of the paired phase operation
}

export interface Profile3dOperation extends BaseOperation {
  type: 'profile3d'
  pathId: string
  stepoverPercent: number
  rasterAngleDeg: number
  maxDepthMM: number
  roughingToolId?: string
  roughingStepoverPercent?: number
  roughingStepDownMM?: number
  roughingStockAllowanceMM?: number
  roughingRasterAngleDeg?: number
}

export interface TrochoidalOperation extends BaseOperation {
  type: 'trochoidal'
  pathId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  trochStepMM: number
  trochRadiusMM: number
  finishingPass: boolean
  rampIn: boolean
}

export interface GcodeOperation extends BaseOperation {
  type: 'gcode'
  filename: string
  // The imported program itself, so Simulate can reload it after the player is closed —
  // generateGcode skips these ops, and `segments` alone can't be played. Session-only:
  // projectSave strips it, so an op from a loaded project has none.
  gcode?: string
}

export const GCODE_IMPORT_TOOL_ID = '__gcode_import__'

export type AnyOperation = ProfileOperation | PocketOperation | DrillOperation | SurfaceOperation | VCarveOperation | PhotoVCarveOperation | InlayOperation | Profile3dOperation | TrochoidalOperation | GcodeOperation

export type AddPayload =
  | Omit<ProfileOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<PocketOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<DrillOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<SurfaceOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<VCarveOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<PhotoVCarveOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<InlayOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<Profile3dOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<TrochoidalOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<GcodeOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>

interface ToolpathState {
  operations: AnyOperation[]
  // opts.record=false skips timeline recording — for derived/system writes
  // (regenerate's helical-center write-back, G-code import which records its
  // own event after segments are attached).
  addOperation: (op: AddPayload, opts?: { record?: boolean }) => string
  // Several ops from ONE user action (inlay's roughing + finishing phases): added
  // together and recorded as a SINGLE timeline chip. Returns the new ids in the
  // order given; ops[0] is the one a chip click opens for editing.
  addOperations: (ops: AddPayload[], opts?: { record?: boolean }) => string[]
  updateOperation: (id: string, updates: Partial<AnyOperation>, opts?: { record?: boolean }) => void
  deleteOperation: (id: string) => void
  // Recorded variants of replaceOperations for user-facing reorder /
  // group-delete (PathsPanel). replaceOperations itself stays raw — it's for
  // load/undo/import machinery and view-state rewrites.
  reorderOperations: (operations: AnyOperation[]) => void
  deleteOperations: (ids: string[]) => void
  // Swap one generated set of operations for another in a single timeline entry. A form
  // re-Generating with a different grouping (PocketForm's Invert Pocket) is revising the
  // call it already made, not deleting one thing and creating another — so it amends the
  // op.add chip that defined `anchorId` when that is the latest chip, and otherwise
  // records ONE chip (see recordOpReplacement). Either way it is one undo step.
  replaceGeneratedOperations: (args: { anchorId: string; deleteIds: string[]; add: AddPayload[] }) => string[]
  // Add paths to / remove paths from the set one Generate click covers. The unit that
  // HAS a path list is the BATCH, not the operation: a profile and a drill each hold a
  // single `pathId`, so a path added to the set is a new OPERATION and a path taken out
  // of it is a deleted one. Members that stay keep their ids, because other things point
  // at them — a `startFrom: { mode: 'op' }` reference, and the operation's place in the
  // program — and the new members land BESIDE their siblings rather than at the end of
  // the list, so adding a hole that was missed does not move that drilling to the end of
  // the job. Amends the op.add that defined the batch, for the same reason a depth edit
  // does: it is an argument to the call already made, not a second call.
  reviseBatchPaths: (args: { anchorId: string; deleteIds: string[]; add: AddPayload[] }) => string[]
  setSegments: (id: string, segments: MotionSegment[], builtWith?: GeneratedWith) => void
  setError: (id: string, error: string) => void
  // Settles operations whose generation was abandoned (see workers/abortGeneration).
  // 'needs-update' rather than 'error': the user stopped it, nothing went wrong, and the
  // op does need regenerating. Not recorded — status is derived state.
  cancelGenerating: () => void
  // Recorded: an invisible op is skipped by generateGcode, so hiding one edits the
  // exported program. It undoes, and replay restores it.
  toggleVisibility: (id: string) => void
  // Same, for a whole tool run in one event.
  setOperationsVisible: (ids: string[], visible: boolean) => void
  moveOperation: (id: string, dir: 'up' | 'down') => void
  replaceOperations: (operations: AnyOperation[]) => void
  markNeedsUpdate: (pathId: string) => void
  // Flags operations whose start height no longer matches what their segments were cut
  // from — a reorder, a deleted op or an edited depth all move the floor another op
  // sits on, and nothing about THAT op changed. Not recorded: it's derived state.
  revalidateStartHeights: () => void
}

export function refsPathId(op: AnyOperation, pathId: string): boolean {
  if (op.type === 'profile') return op.pathId === pathId
  if (op.type === 'trochoidal') return op.pathId === pathId
  if (op.type === 'pocket') return op.pathId === pathId || op.islandIds.includes(pathId)
  if (op.type === 'drill') return op.pathId === pathId
  if (op.type === 'vcarve') return op.pathId === pathId || op.islandIds.includes(pathId)
  if (op.type === 'photovcarve') return op.pathId === pathId
  // The male's field is geometry it machines (its background clearance), so it counts as a
  // source path like any island: edit it and the op is stale, delete it and the op goes.
  if (op.type === 'inlay') return op.pathId === pathId || op.islandIds.includes(pathId) ||
    op.fieldId === pathId || !!op.fieldPlugIds?.includes(pathId)
  if (op.type === 'profile3d') return op.pathId === pathId
  return false
}

/**
 * Rewrite the operation list when `oldId` is split into `newIds`.
 *
 * An ISLAND reference swaps the one id for all the sub-path ids: the combined
 * island geometry is unchanged, so the toolpath is identical and the segments
 * stay valid.
 *
 * Everything that used the path as its SOURCE is dropped, exactly as a delete
 * would. That looks like lost work — profile a gear, split it to give the bore
 * and spokes their own operations, and the outline's profile goes with it — and
 * cloning the op onto each sub-path is the obvious repair. IT IS WRONG. A
 * profile of a compound path treats it as one region: `side: 'outside'` cuts
 * round the outer boundary only. Clone that onto seven sub-paths and the bore
 * and every spoke get cut on their OUTSIDE too, so the tool takes the spokes
 * off. Silently machining something else is worse than losing an operation the
 * user can see is gone, and one undo of the paths.split event restores it.
 *
 * The fix for the lost work is upstream — emit the gear as separate paths so
 * there is nothing to split — not here.
 */
export function remapOpsForSplit(
  ops: AnyOperation[], oldId: string, newIds: string[],
): { ops: AnyOperation[]; changed: boolean } {
  let changed = false
  const out = ops.flatMap((op): AnyOperation[] => {
    if (!refsPathId(op, oldId)) return [op]
    changed = true
    if ((op.type === 'pocket' || op.type === 'vcarve' || op.type === 'inlay') && op.pathId !== oldId) {
      return [{ ...op, islandIds: op.islandIds.flatMap((iid) => (iid === oldId ? newIds : [iid])) }]
    }
    return []
  })
  return { ops: out, changed }
}

// Every operation created by the same Generate click as `op` — itself included, in
// program order. Unbatched ops (created alone) are just themselves. The type check keeps
// a batch to one operation kind, so a form only ever edits ops it knows how to edit.
export function batchOf(op: AnyOperation, ops: AnyOperation[]): AnyOperation[] {
  if (!op.batchId) return ops.filter((o) => o.id === op.id)
  return ops.filter((o) => o.batchId === op.batchId && o.type === op.type)
}

// Every path an operation is built from — its boundary plus any islands. Accepts both
// live ops and the serialized ones in timeline events; op types with no source paths,
// like surfacing, return nothing.
export function pathIdsOf(op: AnyOperation | SerializedOperation): string[] {
  const ids: string[] = []
  if ('pathId' in op && op.pathId) ids.push(op.pathId)
  if ('islandIds' in op && op.islandIds) ids.push(...op.islandIds)
  // Inlay male: the background outline it clears, and the sibling plugs standing in it.
  if ('fieldId' in op && op.fieldId) ids.push(op.fieldId)
  if ('fieldPlugIds' in op && op.fieldPlugIds) ids.push(...op.fieldPlugIds)
  return ids
}

// Resolved start Z for an op against a given ops list, using the live paths/tools/stock.
// Returns 0 for op types with no start-height support, so their stamp never drifts.
function startZOf(op: AnyOperation, ops: AnyOperation[]): number {
  const { widthMM, heightMM } = useWorkpieceStore.getState()
  return resolveStartZForOp(
    op, ops, usePathsStore.getState().paths, { widthMM, heightMM },
    useToolStore.getState().tools,
  ).zMM
}

// Record a Generate that REPLACED some of an op set: join the step that defined the set
// when it is the tip one (see joinsTip in timelineStore), else record ONE step. One gesture
// is one undo step — this used to record an op.delete and then an op.add, and since both
// snapshots are taken after the whole change, the first undo landed on a state identical to
// the live one and did nothing. The chip is named for what the gesture produced; with
// nothing produced it is the delete.
/**
 * The operations a Generate creates, built the ONE way.
 *
 * Every door into the store — `addOperations`, `replaceGeneratedOperations`,
 * `reviseBatchPaths` — made these by hand, each with a comment saying it matched
 * the others. An op has to be the same whichever door it came through: a missing
 * `status` leaves it out of the generate queue, a missing `color` makes it
 * invisible on the canvas, and a missing `batchId` puts it beyond the later edit
 * that should reach the whole batch.
 *
 * `batchId` stays the CALLER'S to decide, because the three disagree on purpose:
 * a fresh call batches when it makes more than one, while a revision inherits the
 * batch it is revising and may have to mint one for an op that was created alone.
 */
function buildOps(add: AddPayload[], batchId: string | undefined): AnyOperation[] {
  return add.map((op) => ({
    ...op, id: uid('op'), status: 'pending', segments: [],
    color: OP_TYPE_COLORS[op.type] ?? '#94a3b8', visible: true,
    ...(batchId ? { batchId } : {}),
  } as AnyOperation))
}

/** Record a creation as ONE step: the first op carries the rest as `linked`. */
function recordOpAdd(created: AnyOperation[]): void {
  const [first, ...rest] = created
  useTimelineStore.getState().record({
    kind: 'op.add',
    op: serializeOp(first),
    ...(rest.length > 0 ? { linked: rest.map(serializeOp) } : {}),
  })
}

function recordOpReplacement(anchorId: string, deleteIds: string[], created: AnyOperation[]): void {
  const tl = useTimelineStore.getState()
  if (tl.joinsTip([{ op: anchorId }])) return
  if (created.length > 0) {
    recordOpAdd(created)
  } else if (deleteIds.length > 0) {
    tl.record({ kind: 'op.delete', opIds: deleteIds })
  }
}

export const useToolpathStore = create<ToolpathState>()((set, get) => ({
  operations: [],

  addOperation: (op, opts) => get().addOperations([op], opts)[0],

  addOperations: (ops, opts) => {
    if (ops.length === 0) return []
    // One call = one user action, so anything created together is a batch. Single-op
    // calls stay unbatched — a lone operation has nothing to be edited alongside.
    const batchId = ops.length > 1 ? uid('batch') : undefined
    const created = buildOps(ops, batchId)
    set((s) => ({ operations: [...s.operations, ...created] }))
    if (opts?.record !== false) recordOpAdd(created)
    return created.map((o) => o.id)
  },

  updateOperation: (id, updates, opts) => {
    const opType = get().operations.find((o) => o.id === id)?.type
    set((s) => ({ operations: s.operations.map((o) => o.id === id ? { ...o, ...updates } as AnyOperation : o) }))
    if (opts?.record === false) return
    const recordable = { ...updates } as Record<string, unknown>
    for (const k of DERIVED_OP_KEYS) delete recordable[k]
    if (Object.keys(recordable).length > 0) {
      // A settings edit joins the op's defining step (usually its op.add) while that is
      // the latest step — changing a just-made pocket's depth is an argument edit to
      // that call. An op defined further back gets an op.update of its own, so the edit
      // is its own undo step (see joinsTip in timelineStore).
      const tl = useTimelineStore.getState()
      if (!tl.joinsTip([{ op: id }])) {
        tl.record({ kind: 'op.update', opId: id, opType, updates: recordable as Partial<SerializedOperation> })
      }
      // A settings edit here can move this op's floor (depth, boundary, islands, its own
      // start reference), which is a change to everything sitting ON that floor. Derived
      // writes returned above, so this only runs for real edits.
      get().revalidateStartHeights()
    }
  },

  deleteOperation: (id) => {
    const opType = get().operations.find((o) => o.id === id)?.type
    set((s) => ({ operations: s.operations.filter((o) => o.id !== id) }))
    useTimelineStore.getState().record({ kind: 'op.delete', opIds: [id], opType })
    get().revalidateStartHeights()
  },

  reorderOperations: (operations) => {
    set({ operations })
    useTimelineStore.getState().record({ kind: 'op.reorder', order: operations.map((o) => o.id) })
    get().revalidateStartHeights()
  },

  deleteOperations: (ids) => {
    if (ids.length === 0) return
    set((s) => ({ operations: s.operations.filter((o) => !ids.includes(o.id)) }))
    useTimelineStore.getState().record({ kind: 'op.delete', opIds: ids })
    get().revalidateStartHeights()
  },

  replaceGeneratedOperations: ({ anchorId, deleteIds, add }) => {
    const batchId = add.length > 1 ? uid('batch') : undefined
    const created = buildOps(add, batchId)
    const remove = new Set(deleteIds)
    set((s) => ({
      operations: [...s.operations.filter((o) => !remove.has(o.id)), ...created],
    }))
    recordOpReplacement(anchorId, deleteIds, created)
    get().revalidateStartHeights()
    return created.map((o) => o.id)
  },

  reviseBatchPaths: ({ anchorId, deleteIds, add }) => {
    const anchor = get().operations.find((o) => o.id === anchorId)
    if (!anchor) return []
    const remove = new Set(deleteIds)
    const kept = batchOf(anchor, get().operations).filter((o) => !remove.has(o.id))
    const keptIds = new Set(kept.map((o) => o.id))
    // A batchId only exists once there is something to be batched WITH: an operation
    // created alone has none, and a second path joining it is the moment one is needed.
    const batchId = anchor.batchId ?? (kept.length + add.length > 1 ? uid('batch') : undefined)
    const created = buildOps(add, batchId)
    set((s) => {
      const src = s.operations
      // Where the new members go: after the LAST surviving member of the batch, or, when
      // the revision replaced every one of them, where the batch itself stood.
      let at = src.findIndex((o) => o.id === anchorId)
      for (let i = 0; i < src.length; i++) if (keptIds.has(src[i].id)) at = i
      const out: AnyOperation[] = []
      for (let i = 0; i < src.length; i++) {
        const o = src[i]
        // Stamping the survivors is what makes a batch out of an operation that was
        // created alone; every other case already agrees with `batchId`.
        if (!remove.has(o.id)) {
          out.push(batchId && keptIds.has(o.id) && o.batchId !== batchId
            ? { ...o, batchId } as AnyOperation : o)
        }
        if (i === at) out.push(...created)
      }
      return { operations: out }
    })
    recordOpReplacement(anchorId, deleteIds, created)
    get().revalidateStartHeights()
    return created.map((o) => o.id)
  },

  // Stamps `generatedWith` with the inputs these segments were built from. Getting this
  // stamp right is what lets a simulate or export skip work — without it a freshly
  // generated operation looks "unknown" and is regenerated once for nothing — and what lets
  // revalidateStartHeights see that an op's floor has moved.
  //
  // A generator passes `builtWith`: the inputs it READ, before it awaited the worker. The
  // stamp used to be taken here, at write time, and a generation takes seconds. If an
  // earlier op's depth, the order or a path changed meanwhile, revalidateStartHeights
  // skipped this op (it was still `generating`) and then this stamped the NEW start height
  // onto segments cut from the OLD one — marked done, agreeing with every later check,
  // including the export backstop, so the stale toolpath was exported. With the true stamp,
  // an op whose floor moved while it ran is flagged here, exactly as revalidateStartHeights
  // would have flagged it had it been idle. Pinned by `npx vite-node scripts/startz-race.mts`.
  //
  // Without `builtWith` (an imported program, which has no inputs to drift from) the stamp
  // is the current state, as before. A caller that generates without applying op.entryHint
  // must clear it first.
  setSegments: (id, segments, builtWith) => {
    const cur = get().operations.find((o) => o.id === id)
    // The surface these segments are cut from NOW. Recorded because it is derived from the
    // OTHER operations: reorder them, or change the depth of one, and this op's start
    // height silently becomes something else. Comparing the two is the only way to know.
    const startZNow = cur ? startZOf(cur, get().operations) : 0
    const generatedWith: GeneratedWith = builtWith ?? {
      entryHint: cur?.entryHint,
      safeHeightMM: useWorkpieceStore.getState().safeHeightMM,
      startZMM: startZNow,
    }
    const drifted = generatedWith.startZMM !== undefined
      && Math.abs(generatedWith.startZMM - startZNow) >= 1e-9
    set((s) => ({
      operations: s.operations.map((o) =>
        o.id === id
          ? { ...o, segments, status: drifted ? 'needs-update' : 'done', errorMessage: undefined, generatedWith } as AnyOperation
          : o
      ),
    }))
  },

  // Marks the operation failed and clears its segments. It does NOT report anywhere —
  // WHERE a failure is shown depends on who asked for it, and showing it twice is worse
  // than showing it once. A Generate the user just clicked says so in that form's own
  // banner (`useGenerateError` in panels/machine/shared), right under the button; an
  // automatic regeneration has no form open and goes to the status bar instead (see
  // regenerate.ts). `errorMessage` is kept either way — the operations strip shows it on
  // the row, which is where a failure is fixed or thrown away.
  setError: (id, error) =>
    set((s) => ({
      operations: s.operations.map((o) =>
        o.id === id ? { ...o, status: 'error', errorMessage: error, segments: [] } as AnyOperation : o
      ),
    })),

  cancelGenerating: () =>
    set((s) => ({
      operations: s.operations.map((o) =>
        o.status === 'generating'
          ? { ...o, status: 'needs-update', errorMessage: undefined } as AnyOperation
          : o
      ),
    })),

  toggleVisibility: (id) => {
    const op = get().operations.find((o) => o.id === id)
    if (!op) return
    get().setOperationsVisible([id], !op.visible)
  },

  setOperationsVisible: (ids, visible) => {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    const opType = get().operations.find((o) => idSet.has(o.id))?.type
    set((s) => ({
      operations: s.operations.map((o) => idSet.has(o.id) ? { ...o, visible } as AnyOperation : o),
    }))
    useTimelineStore.getState().record({ kind: 'op.setVisible', opIds: ids, visible, opType })
  },

  moveOperation: (id, dir) => {
    const s = get()
    const idx = s.operations.findIndex((o) => o.id === id)
    if (idx < 0) return
    const newIdx = dir === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= s.operations.length) return
    const ops = [...s.operations]
    const [removed] = ops.splice(idx, 1)
    ops.splice(newIdx, 0, removed)
    s.reorderOperations(ops)
  },

  replaceOperations: (operations) => set({ operations }),

  markNeedsUpdate: (pathId) => {
    set((s) => ({
      operations: s.operations.map((o) =>
        o.status === 'done' && refsPathId(o, pathId) ? { ...o, status: 'needs-update' } as AnyOperation : o
      ),
    }))
    // Moving the path that defines a pocket moves the floor of everything sitting in it,
    // and those ops don't reference the path themselves.
    get().revalidateStartHeights()
  },

  revalidateStartHeights: () => {
    const ops = get().operations
    // No per-pass cache: the floor table behind resolveStartZForOp is memoised at module
    // scope for this exact ops/paths/stock state, so the whole sweep shares one build.
    let changed = false
    const next = ops.map((o) => {
      // Only ops that finished generating can go stale, and only if we know what they
      // used. An un-stamped op (older session, mid-generation) is left alone rather than
      // flagged on a guess.
      if (o.status !== 'done' || o.generatedWith?.startZMM === undefined) return o
      if (Math.abs(startZOf(o, ops) - o.generatedWith.startZMM) < 1e-9) return o
      changed = true
      return { ...o, status: 'needs-update' } as AnyOperation
    })
    if (changed) set({ operations: next })
  },
}))

// Re-export OriginPosition so callers can get it from one place
