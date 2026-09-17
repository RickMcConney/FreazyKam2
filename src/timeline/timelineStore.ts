import { create } from 'zustand'
import { uid } from '../uid'
import { labelFor, TRANSFORM_GESTURES, type SerializedOperation, type TimelineEvent, type TimelineEventPayload } from './events'
import type { ImportedPath, PathUpdate } from '../store/pathsStore'
import { usePathsStore } from '../store/pathsStore'
import type { ShapeParams } from '../shapes/shapeGenerators'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { abortGeneration } from '../workers/abortGeneration'
import { useTabStore, type Tab } from '../store/tabStore'
import { useConstraintsStore } from '../store/constraintsStore'
import type { Constraint } from '../store/constraints'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { WorkpieceEventChanges } from './events'
import { consolidateSteps, getBBox } from '../canvas/selectionUtils'
import { evictHistorySegments } from './historyBudget'

// The operation timeline: an append-only event log ("the program") with a
// cursor. Every project mutation records one TimelineEvent; undo/redo and the
// TimelinePanel scrub the cursor. Replay correctness can be checked any time
// with window.__fkamReplayCheck().

const COALESCE_MS = 800
// Past this many entries the oldest are dropped, so history stays bounded.
const HISTORY_LIMIT = 500

// ─── State snapshots ──────────────────────────────────────────────────────────
//
// Undo is a snapshot stack, NOT a replay of the event log. `stateAt[seq]` is the
// whole project as of event `seq` (0 = genesis), and undo installs one.
//
// The stores replace objects rather than mutating them, so a snapshot is a
// capture of four array references — near-free to take, and an operation nobody
// touched comes back as LITERALLY THE SAME OBJECT, segments and all. That is
// what pays for this: the replay it replaced had to rebuild every op from its
// settings and then work out, by comparing settings, source geometry and tabs,
// which of the rebuilt ops could inherit the live one's segments — plus park the
// ones a scrub was about to drop, because scrubbing past an op.add left nothing
// live to inherit from. None of that question exists when the old objects are
// simply still there.
//
// The event log lives on beside it, as the strip's display and as the record of
// what each object was made from. It is no longer replayed, so it no longer has
// to be replayABLE: a new mutating action needs a chip that reads well, not an
// applyEvent case that reproduces it exactly.
// Operations are held LIVE here — the actual objects, segments and all — not
// serialized settings. That is the point: an op nobody touched comes back as
// the same object, so seconds-long adaptive/vcarve generations survive an undo
// for free. (The .fkam genesis is a serialized Checkpoint; see genesisCheckpoint.)
interface Snapshot {
  paths: ImportedPath[]
  operations: AnyOperation[]
  tabs: Tab[]
  // Constraints ride here for the same reason paths do: they are document
  // state, they change outside their own actions (a deleted path drops the
  // constraints that named it, inside somebody else's atomic edit), and undo
  // has to put both halves back in one press.
  constraints: Constraint[]
  workpiece?: WorkpieceEventChanges
}
const stateAt: (Snapshot | undefined)[] = [{ paths: [], operations: [], tabs: [], constraints: [] }]

function captureWorkpiece(): Required<WorkpieceEventChanges> {
  const { widthMM, heightMM, thicknessMM, units, origin, zOrigin, material } = useWorkpieceStore.getState()
  return { widthMM, heightMM, thicknessMM, units, origin, zOrigin, material }
}

function captureSnapshot(): Snapshot {
  return {
    paths: usePathsStore.getState().paths,
    operations: useToolpathStore.getState().operations,
    tabs: useTabStore.getState().tabs,
    constraints: useConstraintsStore.getState().constraints,
    workpiece: captureWorkpiece(),
  }
}


// The boot genesis above can't capture the workpiece: this module evaluates
// inside an import cycle with the stores, so reading them here would hit
// uninitialized bindings. Backfill once the module graph has finished loading
// (before any user interaction) — otherwise undoing back past the first
// workpiece.set event has no baseline to restore and leaves the new value.
const backfillGenesis = () => {
  const g = stateAt[0]
  if (!g || g.workpiece) return
  // Async module loaders (vitest/vite-node) flush microtasks between module
  // evaluations, so this can fire while the cycle's bindings are still
  // undefined — retry on the next tick until the stores exist.
  if (!useWorkpieceStore || !usePathsStore || !useToolpathStore || !useTabStore || !useConstraintsStore) {
    setTimeout(backfillGenesis, 0)
    return
  }
  if (useTimelineStore.getState().events.length === 0) stateAt[0] = captureSnapshot()
}
queueMicrotask(backfillGenesis)

// Record the state as of `seq`, discarding any snapshots past it — a fresh edit
// after an undo abandons the branch that was there.
function snapshotAt(seq: number): void {
  stateAt.length = Math.min(stateAt.length, seq)
  stateAt[seq] = captureSnapshot()
  enforceSegmentBudget()
}

// Bound the toolpaths only history is keeping alive (see historyBudget.ts). Run wherever an
// array can become history-only: a new snapshot (the op it captured may be regenerated
// next) and an undo/redo (what was live is now only in the snapshot it was refreshed into).
function enforceSegmentBudget(): void {
  evictHistorySegments(stateAt, useToolpathStore.getState().operations)
}

// ─── Keeping the cursor's snapshot live ───────────────────────────────────────
//
// THE SNAPSHOT AT THE CURSOR IS WHATEVER IS LIVE — and it has to stay that way however the
// cursor is LEFT, not only when it is left by undo. A snapshot used to be taken only when
// an event was appended, so everything that lands WITHOUT one never reached it: a toolpath
// finishing its generation, a `generating` status, an amended chip, a second drag merged
// into the first. goTo refreshed the cursor's snapshot on the way out, but recording the
// NEXT edit left it as it was. So: pocket a circle, drag it, draw another circle, undo —
// the circle came back where it was dragged to carrying the toolpath from BEFORE the drag,
// marked done, and nothing regenerated it (the snapshot was captured the moment the drag was
// recorded, before its regeneration ran). And undoing past the pocket's creation always
// regenerated, because that snapshot was taken while the op was still pending.
//
// So every write to the document stores is mirrored into the cursor's snapshot — batched
// per synchronous turn, settled in a microtask. The one thing that must NOT be mirrored is
// the write a recorded action makes just before calling record(): that belongs to the NEW
// step, and the step being left must keep the state from before it. Every recording action
// writes first and records second (pathsStore, toolpathStore, tabStore, constraintsStore,
// workpieceStore all do), so the batch remembers the stores as they stood before its first
// write, and record() hands exactly that to the step it is leaving.
let batchOpen = false
let preBatch: Snapshot | null = null
const preSeen = new Set<keyof Snapshot>()

function noteWrite<K extends keyof Snapshot>(key: K, before: Snapshot[K]): void {
  if (!batchOpen) {
    batchOpen = true
    preBatch = captureSnapshot()   // the other stores are still as they were
    preSeen.clear()
    queueMicrotask(settleBatch)
  }
  // The store that wrote already holds its NEW value, so take its previous one — once, at
  // its first write of the batch.
  if (!preSeen.has(key)) {
    preSeen.add(key)
    preBatch![key] = before
  }
}

// Nothing recorded this batch: it was a derived write or an amend, so it IS the state at the
// cursor.
function settleBatch(): void {
  if (!batchOpen) return
  closeBatch()
  const cursor = useTimelineStore.getState().cursor
  if (stateAt[cursor]) stateAt[cursor] = captureSnapshot()
}

function closeBatch(): void {
  batchOpen = false
  preBatch = null
}

let mirrorInstalled = false
function installCursorMirror(): void {
  if (mirrorInstalled) return
  // Same import-cycle guard as backfillGenesis: the stores may not exist yet.
  if (!useWorkpieceStore || !usePathsStore || !useToolpathStore || !useTabStore || !useConstraintsStore || !useTimelineStore) {
    setTimeout(installCursorMirror, 0)
    return
  }
  mirrorInstalled = true
  usePathsStore.subscribe((s, p) => { if (s.paths !== p.paths) noteWrite('paths', p.paths) })
  useToolpathStore.subscribe((s, p) => { if (s.operations !== p.operations) noteWrite('operations', p.operations) })
  useTabStore.subscribe((s, p) => { if (s.tabs !== p.tabs) noteWrite('tabs', p.tabs) })
  useConstraintsStore.subscribe((s, p) => { if (s.constraints !== p.constraints) noteWrite('constraints', p.constraints) })
  useWorkpieceStore.subscribe((s, p) => {
    const { widthMM, heightMM, thicknessMM, units, origin, zOrigin, material } = p
    const before = { widthMM, heightMM, thicknessMM, units, origin, zOrigin, material }
    if ((Object.keys(before) as (keyof typeof before)[]).some((k) => s[k] !== before[k])) noteWrite('workpiece', before)
  })
}
queueMicrotask(installCursorMirror)

// Drop the oldest entries so the stack stays bounded. Returns how many events
// were shed, which the caller renumbers by.
function trimHistory(events: TimelineEvent[]): number {
  if (events.length <= HISTORY_LIMIT) return 0
  const drop = events.length - HISTORY_LIMIT
  stateAt.splice(0, drop)
  return drop
}

export function stateSnapshotAt(seq: number): Snapshot | undefined { return stateAt[seq] }


export interface RecordMeta {
  label?: string
  gestureId?: string
  // Override the captured selection. Needed when the selection change lands
  // AFTER the recording store action (CanvasStage does addPaths → selectPath),
  // and for add-events generally: scrubbing to one should select what it created.
  selectionAfter?: string[]
}

interface TimelineState {
  events: TimelineEvent[]
  cursor: number    // seq of last applied event; invariant: events[i].seq === i + 1
  savedSeq: number  // seq at last project save (dirty = cursor !== savedSeq)

  record: (payload: TimelineEventPayload, meta?: RecordMeta) => void
  // Rebuild the log as an empty program whose genesis is the CURRENT store
  // state. Used by new project, and by project load when the file carries no
  // usable timeline (v1 files, corrupt/newer-version logs).
  resetToCurrentState: () => void
  markSaved: () => void
  // Force "unsaved". -1 is the store's own idiom for "no event matches the last
  // save" (see amend/undo below). Needed after an autosave restore: loadProject
  // ends by marking the document clean, which is right for a file on disk and
  // wrong for a recovered snapshot — that document matches nothing on disk, and
  // reporting it as saved would stop the next snapshot from being offered back.
  markUnsaved: () => void
  // Install a timeline from a saved project (v2 .fkam). The stores must
  // already hold the state at `cursor` (the file's snapshot block) — nothing is
  // replayed here. Returns false when the timeline is invalid or from a newer
  // version, in which case the caller should resetToCurrentState() instead.

  // Time travel: restore project state as of event `seq` (0 = genesis).
  // Replays from the nearest checkpoint, preserves toolpath segments for ops
  // whose settings + source geometry are unchanged, and schedules debounced
  // regeneration for the rest.
  //
  // `intent` decides what a NEW edit does while the cursor sits in the past:
  //   'undo'   — classic undo semantics: the edit truncates the future
  //   'browse' — timeline browsing: the edit is INSERTED at the cursor and the
  //              later events are kept, renumbered, and replayable on top
  //              (self-contained payloads make this safe: events about other
  //              paths/ops apply unchanged; events whose target was removed
  //              no-op).
  // Undo/redo only — there is no scrubbing. Installs the snapshot at `seq`.
  goTo: (seq: number) => void
  // Delete one event from the timeline: later events are renumbered and state
  // is re-derived by replaying without it. NOT undoable — it edits the history
  // itself, not the project.

  // Edit-in-place: parameter changes (shape/text params, op settings) are
  // argument edits to the call that created the thing — they AMEND the payload
  // of the last event ≤ cursor that wrote the target instead of appending a
  // new chip. Replay stays consistent because nothing between that event and
  // the cursor touches those fields (it wouldn't be the last writer otherwise).
  // Returns false when no defining event exists (caller falls back to
  // recording a normal event). NOT undoable — the chip IS the record.
  amendPathDefinition: (pathId: string, upd: { d: string; shapeParams?: ShapeParams | null; name?: string }) => boolean
  // Same idea for a MULTI-PART shape (a gear): its parts are one shape sharing one
  // set of params, so a params edit rewrites the chip that last DEFINED the group
  // — wholesale, because parts appear and vanish with the parameters (spokes → 0,
  // a marking that no longer fits) and a per-path merge cannot express that.
  //
  // That chip is either the `paths.add` that placed the shape or a later group
  // `paths.edit`; `removedIds` names the parts this edit drops, and it is the
  // reason both kinds are handled. Their operations and tabs die with them, and
  // that cleanup only replays from a paths.edit's `deleteIds` — so a drop is
  // FOLDED INTO an existing group paths.edit, and refused against a bare
  // paths.add (the caller then records one, which becomes the definer from then
  // on, so the chip count stops growing after that one). Also refused when an
  // update in the way carries a transform/corner recipe, since replay recomposes
  // from the recipe and would discard a stamped `d`.
  amendShapeGroup: (groupId: string, paths: ImportedPath[], removedIds?: string[]) => boolean
  // Re-running the clock designer on an existing clock: its chip carries the
  // SPEC, so a new spec replaces it in place. Same rule as every other form —
  // re-running over the same thing amends the chip that created it — and it is
  // what keeps a session of trying beats from leaving a chip per attempt. The
  // parts are rewritten by the caller through updateShapeParams, which amends
  // their own chips. Returns false when no clock.design chip exists (loaded or
  // compacted project), and the caller records one.
  amendOpSettings: (opId: string, updates: Partial<SerializedOperation>) => boolean
  // Re-Generate that changes WHICH operations a form produced, not just their settings:
  // PocketForm's Invert Pocket toggle re-reads the same selection into a different set of
  // boundaries. Same reasoning as amendOpSettings — it is an argument edit to the call
  // that created them — but the op set itself changes, so the op.add chip's payload is
  // rewritten wholesale instead of merged field-by-field. Returns false when no defining
  // op.add exists (loaded/compacted project), and the caller records delete+add normally.
  amendOpAddEvent: (anchorOpId: string, patch: { removeIds: string[]; add: SerializedOperation[] }) => boolean
  // BooleanForm edit mode: rewrite a boolean chip's op type + result geometry.
  // Keyed by event id (seqs shift on insert/remove/compact while the form is
  // open). The live result path is rewritten by the caller (rewritePathRaw).
  // Offset/Pattern edit modes: replace a paths.add chip's generated paths and
  // generator metadata wholesale. The live paths are rewritten by the caller
  // (rewriteGeneratedRaw).
  // Tab edits are in-place: the last tabs.apply chip (or snapshot/genesis
  // entry) that defined this path's tabs gets its payload replaced with the
  // path's CURRENT tabs. Returns false when a legacy tabs.moveT/tabs.delete
  // chip sits in between (amending beneath it would be overridden on replay) —
  // the caller then records a normal event.
  amendTabsForPath: (pathId: string, tabs: Tab[]) => boolean
  // PropertiesPanel's transform-chip editor: replace a move/scale/rotate/
  // skew/mirror (or merged 'transform') event's TransformStep recipe,
  // recomposing every affected path from its state just BEFORE this event —
  // not its current state — so this stays a true in-place edit of that one
  // historical step rather than stacking a new transform on top. Returns
  // false when the event isn't a transform-recipe paths.edit event.
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
}

function mergePathUpdate(older: PathUpdate, newer: PathUpdate): PathUpdate {
  // Transform recipes concatenate (older steps first) rather than the newer
  // one winning — replay needs the FULL step chain to recompose correctly
  // against whatever the base geometry is at that point; dropping the older
  // steps would reintroduce the stale-absolute-d bug for merged chips. The
  // concatenated chain then collapses to its canonical net scale/skew/
  // rotate/mirror/translate parameters, pivoted at the path's own (current,
  // fully-baked) bounding box — see consolidateSteps. Gestures with no
  // recipe concept (corner/points/join/…) never set `transforms`, so this
  // stays undefined for them, same as before.
  const transforms = (older.transforms?.length || newer.transforms?.length)
    ? consolidateSteps(
        [...(older.transforms ?? []), ...(newer.transforms ?? [])],
        getBBox(newer.d) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0, cx: 0, cy: 0 },
      )
    : undefined
  return {
    id: newer.id,
    d: newer.d,
    // undefined means "leave untouched" — the older event's value survives.
    // `corner` is newer-wins-outright (not concatenated like transforms) —
    // NodeEditForm always sends the full current per-corner map, not a delta.
    shapeParams: newer.shapeParams !== undefined ? newer.shapeParams : older.shapeParams,
    name: newer.name !== undefined ? newer.name : older.name,
    hidden: newer.hidden !== undefined ? newer.hidden : older.hidden,
    corner: newer.corner !== undefined ? newer.corner : older.corner,
    ...(transforms ? { transforms } : {}),
  }
}

// Merge a rapid-fire follow-up event into the tip event (numeric spinners,
// tab drags) so the timeline records gestures, not keystrokes. Returns the
// merged event, or null when the pair is not coalescible.
function coalesce(last: TimelineEvent, payload: TimelineEventPayload): TimelineEvent | null {
  if (last.kind !== payload.kind) return null
  switch (payload.kind) {
    case 'op.update': {
      if (last.kind !== 'op.update' || last.opId !== payload.opId) return null
      return { ...last, updates: { ...last.updates, ...payload.updates } }
    }
    case 'tabs.moveT': {
      if (last.kind !== 'tabs.moveT' || last.tabId !== payload.tabId) return null
      return { ...last, t01: payload.t01 }
    }
    case 'shape.params': {
      if (last.kind !== 'shape.params' || last.pathId !== payload.pathId) return null
      return { ...last, params: payload.params }
    }
    case 'constraint.update': {
      // Same rule as op.update: dialling one constraint's distance is one
      // decision, however many keystrokes it took to reach the number.
      if (last.kind !== 'constraint.update' || last.constraintId !== payload.constraintId) return null
      return { ...last, changes: { ...last.changes, ...payload.changes } }
    }
    case 'op.setVisible': {
      if (last.kind !== 'op.setVisible') return null
      const sameIds = last.opIds.length === payload.opIds.length &&
        [...last.opIds].sort().join() === [...payload.opIds].sort().join()
      // Toggling the same operations again just overwrites the earlier answer; toggling
      // MORE operations the same way extends the set. Anything else (different ops, other
      // direction) is a separate decision and gets its own entry.
      if (!sameIds && last.visible !== payload.visible) return null
      const opIds = sameIds ? payload.opIds : [...new Set([...last.opIds, ...payload.opIds])]
      const merged = { ...last, opIds, visible: payload.visible }
      return { ...merged, label: labelFor(merged) }
    }
    case 'op.reorder': {
      if (last.kind !== 'op.reorder') return null
      // The payload is the COMPLETE order, so the newer one wins outright and every
      // intermediate arrangement is dead weight — the same reason workpiece.set merges.
      return { ...last, order: payload.order }
    }
    case 'workpiece.set': {
      if (last.kind !== 'workpiece.set') return null
      const changes = { ...last.changes, ...payload.changes }
      // Recompute the label — merging can widen it (width-only → Stock Size → Workpiece)
      return { ...last, changes, label: labelFor({ kind: 'workpiece.set', changes }) }
    }
    case 'paths.edit': {
      if (last.kind !== 'paths.edit') return null
      // A chain of pure-geometry transforms (Move/Scale/Rotate/Skew/Mirror) on
      // the same path set merges even when the gesture kind changes — only
      // the net geometry matters, so Move-then-Rotate-then-Move collapses to
      // one "Transform" chip. Anything else (corner/points/join/weld/trim/
      // text/boolean, or an untagged edit) still requires an exact gesture
      // match, matching the old keystroke-rate-only behavior.
      const bothTransforms = last.gesture !== undefined && payload.gesture !== undefined &&
        TRANSFORM_GESTURES.has(last.gesture) && TRANSFORM_GESTURES.has(payload.gesture)
      if (!bothTransforms && last.gesture !== payload.gesture) return null
      const pureLast = !(last.add?.length) && !(last.deleteIds?.length)
      const pureNew = !(payload.add?.length) && !(payload.deleteIds?.length)
      if (!pureLast || !pureNew) return null
      const lastIds = last.updates.map((u) => u.id).sort().join(' ')
      const newIds = payload.updates.map((u) => u.id).sort().join(' ')
      if (lastIds !== newIds) return null
      const olderById = new Map(last.updates.map((u) => [u.id, u]))
      const gesture = bothTransforms && last.gesture !== payload.gesture ? 'transform' : payload.gesture
      return {
        ...last,
        gesture,
        updates: payload.updates.map((u) => mergePathUpdate(olderById.get(u.id)!, u)),
        label: labelFor({ ...payload, gesture }),
      }
    }
    default:
      return null
  }
}

let regenTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRegen() {
  if (regenTimer) clearTimeout(regenTimer)
  regenTimer = setTimeout(() => {
    regenTimer = null
    // Dynamic import avoids a module cycle (regenerate → stores → timelineStore)
    void import('../cam/regenerate').then(({ regenerateOperation }) => {
      for (const op of useToolpathStore.getState().operations) {
        if (op.status === 'needs-update') void regenerateOperation(op.id)
      }
    })
  }, 300)
}

// Install the project state as of event `seq`. Undo/redo only — the snapshot
// IS the state, so there is nothing to fold, nothing to rebuild and nothing to
// decide about which generated segments may survive: the operations coming back
// are the same objects that went in.
function restoreStateAt(seq: number, events: TimelineEvent[]): boolean {
  const state = stateAt[seq]
  // A project loaded from a file has its event log for display but no snapshots
  // behind it — history begins at the load. Nothing to restore, so refuse
  // rather than installing an empty document over the user's project.
  if (!state) return false

  const pathIds = new Set(state.paths.map((p) => p.id))
  // Selection is view state, not document state, and selecting is not a recorded event —
  // so `selectionAfter` is only ever the selection as it stood at some OTHER edit. Applying
  // it over a step that did not change which paths exist throws away a selection the user
  // made by hand since: generate an inlay over two selected paths, undo it, and the ops go
  // (right) but the selection collapses to whatever was selected at the previous recorded
  // event — usually the single path that was added last — so the paths have to be picked
  // again before the operation can be retried.
  //
  // Restore it only when the set of paths itself differs, which is the case it exists for:
  // undoing an add or a delete, where carrying the current selection forward would be
  // meaningless. A pure `d` change (move, scale, node edit) keeps the same ids and so keeps
  // the selection, which is what you want anyway — undoing a move should leave the thing
  // you moved selected.
  const curPaths = usePathsStore.getState()
  const samePathSet = curPaths.paths.length === state.paths.length
    && curPaths.paths.every((p) => pathIds.has(p.id))
  const selection = (samePathSet
    ? curPaths.selectedIds
    : (seq > 0 ? events[seq - 1].selectionAfter : []))
    .filter((id) => pathIds.has(id))

  // The snapshot's operations go straight back in — same objects, same segments.
  // The one exception is an op whose generation had not finished when the
  // snapshot was taken: its segments are stale or absent, so it is asked to
  // regenerate rather than being restored mid-flight.
  const operations = state.operations.map((o) =>
    o.status === 'generating' || o.status === 'pending' ? { ...o, status: 'needs-update' as const } : o)

  usePathsStore.setState({ paths: state.paths, selectedIds: selection })
  useToolpathStore.setState({ operations })
  useTabStore.setState({ tabs: state.tabs })
  useConstraintsStore.setState({ constraints: state.constraints })

  // Restore workpiece fields when the snapshot carries them (timelines from
  // before Phase 6 don't — leave the workpiece as-is then). setState bypasses
  // the recording setters; the surface-op auto-regen subscription
  // (App.useSurfaceWorkpieceSync) fires only on actual width/height/origin
  // changes, which is exactly when surface toolpaths need a rebuild.
  const wp = state.workpiece
  if (wp) {
    const cur = useWorkpieceStore.getState()
    const changed = (Object.keys(wp) as (keyof WorkpieceEventChanges)[])
      .some((k) => wp[k] !== undefined && cur[k] !== wp[k])
    if (changed) useWorkpieceStore.setState({ ...wp })
  }

  if (operations.some((o) => o.status === 'needs-update')) scheduleRegen()
  return true
}

export const useTimelineStore = create<TimelineState>()((set, get) => ({
  events: [],
  cursor: 0,
  savedSeq: 0,

  record: (payload, meta) => {
    const s = get()
    const selectionAfter = meta?.selectionAfter ?? [...usePathsStore.getState().selectedIds]
    const now = Date.now()

    // Coalesce with the event AT the cursor (the one just applied), so a run of
    // spinner keystrokes records one chip. Merging leaves the cursor where it
    // is, so its snapshot is refreshed on the way out of it (see goTo) rather
    // than here. Never merge into the event the last save captured — rewriting
    // it would make a clean project report as clean while holding different
    // content.
    //
    // Exception: a run of pure-geometry transforms (Move/Scale/Rotate/Skew/
    // Mirror) on the same path set merges regardless of elapsed time — a
    // reposition done in several separate drags is still just one net move
    // as long as nothing else happened between them, so the 800 ms window
    // doesn't apply here.
    //
    // Exception: consecutive workpiece.set events merge regardless of
    // elapsed time too — each one just overwrites whichever fields it
    // touched (coalesce's workpiece.set case is a plain object spread), so
    // there's never anything meaningful in an intermediate value; setting
    // width, then later setting height, then later still changing width
    // again should end up as one "Workpiece" chip holding the final values,
    // not three chips where the first two are dead weight.
    const prev = s.cursor > 0 ? s.events[s.cursor - 1] : undefined
    const isTransformChain = prev?.kind === 'paths.edit' && payload.kind === 'paths.edit' &&
      prev.gesture !== undefined && payload.gesture !== undefined &&
      TRANSFORM_GESTURES.has(prev.gesture) && TRANSFORM_GESTURES.has(payload.gesture)
    const isWorkpieceChain = prev?.kind === 'workpiece.set' && payload.kind === 'workpiece.set'
    // Exception: consecutive reorders merge regardless of elapsed time, for the same
    // reason as workpiece.set — each event holds the whole order, so a program dragged
    // into shape over several separate drags is one "Reorder ops" chip rather than one
    // per drag. Anything else happening in between breaks the chain, which is right:
    // that reorder then has work depending on it and deserves its own entry.
    const isReorderChain = prev?.kind === 'op.reorder' && payload.kind === 'op.reorder'
    // Visibility merges on the same terms and for the same reason: each event states the
    // final answer for its operations, so a session of hiding and showing while judging a
    // program is one decision, not one entry per click.
    const isVisibleChain = prev?.kind === 'op.setVisible' && payload.kind === 'op.setVisible'
    if (
      prev &&
      (isTransformChain || isWorkpieceChain || isReorderChain || isVisibleChain || now - prev.t < COALESCE_MS) &&
      prev.seq !== s.savedSeq
    ) {
      const merged = coalesce(prev, payload)
      if (merged) {
        const events = [...s.events]
        events[s.cursor - 1] = { ...merged, t: now, selectionAfter }
        set({ events })
        // The cursor stays on the merged event, so its snapshot is now the live state —
        // a second drag of the same selection used to leave it at the FIRST drag, and
        // recording anything afterwards made that permanent.
        closeBatch()
        if (stateAt[s.cursor]) stateAt[s.cursor] = captureSnapshot()
        return
      }
    }

    const event: TimelineEvent = {
      ...payload,
      seq: s.cursor + 1,
      id: uid('ev'),
      t: now,
      label: meta?.label ?? labelFor(payload),
      selectionAfter,
      ...(meta?.gestureId ? { gestureId: meta.gestureId } : {}),
    }

    // Classic undo semantics: an edit made after an undo abandons the branch
    // that was there, events and snapshots alike. (There is no third case any
    // more — inserting an edit into the middle of the log existed only so a
    // browse-scrub could be edited from, and scrubbing is gone.) A save that
    // pointed into the discarded branch no longer describes any state we can
    // reach, so it stops counting as clean.
    // The step being left keeps the stores as they stood before THIS edit's writes — every
    // settled change before them was already mirrored into it (see noteWrite). Closing the
    // batch here means whatever this action writes after recording (a start-height
    // revalidation, a regeneration's `generating`) opens a new one and lands in the NEW step.
    if (batchOpen && preBatch && stateAt[s.cursor]) stateAt[s.cursor] = preBatch
    closeBatch()
    const events = [...s.events.slice(0, s.cursor), event]
    const shed = trimHistory(events)
    set({
      events: (shed ? events.slice(shed).map((ev) => ({ ...ev, seq: ev.seq - shed })) : events),
      cursor: event.seq - shed,
      ...(s.savedSeq > s.cursor ? { savedSeq: -1 } : s.savedSeq >= 0 ? { savedSeq: s.savedSeq - shed } : {}),
    })
    snapshotAt(event.seq - shed)
  },

  resetToCurrentState: () => {
    closeBatch()
    stateAt.length = 0
    stateAt[0] = captureSnapshot()
    set({ events: [], cursor: 0, savedSeq: 0 })
  },

  markSaved: () => set({ savedSeq: get().cursor }),

  markUnsaved: () => set({ savedSeq: -1 }),

  goTo: (seq) => {
    const s = get()
    const target = Math.max(0, Math.min(s.events.length, Math.round(seq)))
    if (target === s.cursor) return
    // The state at the cursor is whatever is live RIGHT NOW — amended chips,
    // freshly generated segments and every other derived write land there
    // without recording anything. Refreshing it on the way out is what lets all
    // of those be redone, and is why nothing else in the app has to remember to
    // keep a snapshot up to date.
    stateAt[s.cursor] = captureSnapshot()
    // Undo and redo both replace the geometry any running generation was started
    // from — its result would be written against state that no longer exists.
    // After the no-op check, so a move that goes nowhere doesn't kill one.
    abortGeneration()
    if (!restoreStateAt(target, s.events)) {
      useUIStore.getState().showStatus('Nothing further to undo — history starts where this project was opened', 'info')
      return
    }
    set({ cursor: target })
    // Restoring wrote every store, which opened a batch holding the state from BEFORE the
    // undo. The restored state is the target step's by definition (with any mid-generation
    // op already turned into needs-update), so it is captured as such and that batch is
    // closed — a record in this same turn must not hand the pre-undo state to this step.
    closeBatch()
    stateAt[target] = captureSnapshot()
    // The toolpaths that were live a moment ago now survive only in the snapshot just
    // refreshed above — the budget has to see them as history.
    enforceSegmentBudget()
  },

  amendPathDefinition: (pathId, upd) => {
    const s = get()
    const amendPath = (p: ImportedPath): ImportedPath => ({
      ...p,
      d: upd.d,
      ...(upd.shapeParams !== undefined ? { shapeParams: upd.shapeParams ?? undefined } : {}),
      ...(upd.name !== undefined ? { name: upd.name } : {}),
    })
    const amendUpdate = (u: PathUpdate): PathUpdate => ({
      ...u,
      d: upd.d,
      ...(upd.shapeParams !== undefined ? { shapeParams: upd.shapeParams } : {}),
      ...(upd.name !== undefined ? { name: upd.name } : {}),
    })

    const commit = (idx: number, amended: TimelineEvent) => {
      const events = [...s.events]
      events[idx] = amended
      // Checkpoints at/after the amended event captured the old payload's state
      set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
    }

    for (let i = s.cursor - 1; i >= 0; i--) {
      const ev = s.events[i]
      if (ev.kind === 'paths.add' && ev.paths.some((p) => p.id === pathId)) {
        commit(i, { ...ev, paths: ev.paths.map((p) => p.id === pathId ? amendPath(p) : p) })
        return true
      }
      if (ev.kind === 'shape.params' && ev.pathId === pathId) {
        if (!upd.shapeParams) return false // a bare-d change can't live in a params event
        commit(i, { ...ev, params: upd.shapeParams })
        return true
      }
      if (ev.kind === 'paths.edit' && ev.updates.some((u) => u.id === pathId)) {
        commit(i, { ...ev, updates: ev.updates.map((u) => u.id === pathId ? amendUpdate(u) : u) })
        return true
      }
      if (ev.kind === 'paths.split' && ev.subPaths.some((p) => p.id === pathId)) {
        commit(i, { ...ev, subPaths: ev.subPaths.map((p) => p.id === pathId ? amendPath(p) : p) })
        return true
      }
    }
    // The path predates this session's history — amend genesis if we still hold it.
    // A project loaded from a file has no genesis snapshot, so this returns false and
    // the caller records a chip normally, which is the documented fallback.
    const g = stateAt[0]
    if (g && g.paths.some((p) => p.id === pathId)) {
      const amended = { ...g, paths: g.paths.map((p) => p.id === pathId ? amendPath(p) : p) }
      stateAt[0] = amended
      set({ savedSeq: -1 }) // genesis is part of the saved file
      return true
    }
    return false
  },

  amendShapeGroup: (groupId, groupPaths, removedIds = []) => {
    const s = get()
    const live = new Map(groupPaths.map((p) => [p.id, p]))
    const gone = new Set(removedIds)
    // A group path by id (its parts all carry the groupId) or by having just been
    // dropped — `gone` ids are no longer anywhere in the store to be looked up.
    const mineId = (id: string) => live.has(id) || gone.has(id)
    const mine = (p: ImportedPath) => p.groupId === groupId || mineId(p.id)

    // The group's entries go back where the first of them sat, so an edit that
    // adds a part does not shuffle the paths list.
    const replace = (list: ImportedPath[]): ImportedPath[] => {
      const out: ImportedPath[] = []
      let placed = false
      for (const p of list) {
        if (!mine(p)) { out.push(p); continue }
        if (!placed) { out.push(...groupPaths); placed = true }
      }
      if (!placed) out.push(...groupPaths)
      return out
    }
    // Scrubbing to an add-event selects what it created, so a part that has just
    // appeared or gone has to be reflected there too.
    const reselect = (ev: TimelineEvent, before: ImportedPath[]): string[] => {
      const was = new Set(before.filter(mine).map((p) => p.id))
      if (!ev.selectionAfter.some((id) => was.has(id))) return ev.selectionAfter
      return [...ev.selectionAfter.filter((id) => !was.has(id)), ...groupPaths.map((p) => p.id)]
    }

    const commit = (idx: number, amended: TimelineEvent) => {
      const events = [...s.events]
      events[idx] = amended
      set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
    }

    for (let i = s.cursor - 1; i >= 0; i--) {
      const ev = s.events[i]

      if (ev.kind === 'paths.add' && ev.paths.some(mine)) {
        // Nothing here can carry a deletion's op/tab cleanup — see the interface.
        if (gone.size > 0) return false
        commit(i, { ...ev, paths: replace(ev.paths), selectionAfter: reselect(ev, ev.paths) })
        return true
      }

      if (ev.kind === 'paths.edit' && (
        ev.updates.some((u) => mineId(u.id))
        || ev.add?.some(mine)
        || ev.deleteIds?.some(mineId)
      )) {
        // Recipes recompose on replay and would ignore a stamped d.
        if (ev.updates.some((u) => mineId(u.id) && (u.transforms?.length || u.corner?.length))) return false
        // Every part this event already knew keeps its slot, updated to its
        // current geometry — or leaves, taking its operations with it.
        const knew = new Set([...ev.updates.map((u) => u.id), ...(ev.add ?? []).map((p) => p.id)])
        const updates = ev.updates.flatMap((u) => {
          if (!mineId(u.id)) return [u]
          const p = live.get(u.id)
          return p ? [{ ...u, d: p.d, shapeParams: p.shapeParams ?? null }] : []
        })
        const add = (ev.add ?? []).flatMap((p) => {
          if (!mine(p)) return [p]
          const cur = live.get(p.id)
          return cur ? [cur] : []
        })
        // Parts that appeared since this event join its add list.
        for (const p of groupPaths) if (!knew.has(p.id)) add.push(p)
        const deleteIds = [...new Set([...(ev.deleteIds ?? []), ...removedIds])]
        commit(i, {
          ...ev,
          updates,
          ...(add.length > 0 ? { add } : {}),
          ...(deleteIds.length > 0 ? { deleteIds } : {}),
          selectionAfter: [...ev.selectionAfter.filter((id) => !gone.has(id))],
        })
        return true
      }


      // Anything else that writes this group's geometry would override an amend
      // made beneath it, so stop and let the caller record a normal event.
      if (ev.kind === 'paths.split' && (mineId(ev.pathId) || ev.subPaths.some(mine))) return false
      if (ev.kind === 'shape.params' && mineId(ev.pathId)) return false
    }

    // The group predates recorded history (loaded or compacted project) — amend
    // genesis, exactly as amendPathDefinition does.
    const g = stateAt[0]
    if (g && g.paths.some(mine)) {
      if (gone.size > 0) return false
      stateAt[0] = { ...g, paths: replace(g.paths) }
      set({ savedSeq: -1 })
      return true
    }
    return false
  },

  amendOpSettings: (opId, updates) => {
    const s = get()
    const commit = (idx: number, amended: TimelineEvent) => {
      const events = [...s.events]
      events[idx] = amended
      set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
    }

    for (let i = s.cursor - 1; i >= 0; i--) {
      const ev = s.events[i]
      if (ev.kind === 'op.update' && ev.opId === opId) {
        commit(i, { ...ev, updates: { ...ev.updates, ...updates } })
        return true
      }
      if (ev.kind === 'op.add' && ev.op.id === opId) {
        commit(i, { ...ev, op: { ...ev.op, ...updates } as SerializedOperation })
        return true
      }
      // A sibling op created by the same action (inlay's second phase) is defined
      // by this chip too — amend it in place rather than recording a new chip.
      if (ev.kind === 'op.add' && ev.linked?.some((o) => o.id === opId)) {
        commit(i, {
          ...ev,
          linked: ev.linked.map((o) => o.id === opId ? { ...o, ...updates } as SerializedOperation : o),
        })
        return true
      }
    }
    const g = stateAt[0]
    if (g && g.operations.some((o) => o.id === opId)) {
      const amended = {
        ...g,
        operations: g.operations.map((o) => o.id === opId ? { ...o, ...updates } as AnyOperation : o),
      }
      stateAt[0] = amended
      set({ savedSeq: -1 })
      return true
    }
    return false
  },

  amendOpAddEvent: (anchorOpId, patch) => {
    const s = get()
    for (let i = s.cursor - 1; i >= 0; i--) {
      const ev = s.events[i]
      if (ev.kind !== 'op.add') continue
      const members = [ev.op, ...(ev.linked ?? [])]
      if (!members.some((o) => o.id === anchorOpId)) continue
      const remove = new Set(patch.removeIds)
      const next = [...members.filter((o) => !remove.has(o.id)), ...patch.add]
      // An op.add with nothing in it has no meaning; leave the chip alone and let the
      // caller record the delete and the add as ordinary events.
      if (next.length === 0) return false
      const amended: TimelineEvent = {
        ...ev,
        op: next[0],
        ...(next.length > 1 ? { linked: next.slice(1) } : { linked: undefined }),
      }
      const events = [...s.events]
      events[i] = amended
      set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
      return true
    }
    return false
  },

  amendTabsForPath: (pathId, tabs) => {
    const s = get()
    const commit = (idx: number, amended: TimelineEvent) => {
      const events = [...s.events]
      events[idx] = amended
      set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
    }
    for (let i = s.cursor - 1; i >= 0; i--) {
      const ev = s.events[i]
      // Legacy per-gesture tab chips in the way — amending beneath them would
      // be overridden on replay; bail to normal recording.
      if (ev.kind === 'tabs.moveT' || ev.kind === 'tabs.delete') return false
      if (ev.kind === 'tabs.apply' && ev.pathId === pathId) {
        commit(i, {
          ...ev,
          tabs,
          label: labelFor({ kind: 'tabs.apply', pathId, tabs }),
        })
        return true
      }
    }
    const g = stateAt[0]
    if (g && g.tabs.some((t) => t.pathId === pathId)) {
      stateAt[0] = { ...g, tabs: [...g.tabs.filter((t) => t.pathId !== pathId), ...tabs] }
      set({ savedSeq: -1 })
      return true
    }
    return false
  },

  undo: () => get().goTo(get().cursor - 1),
  redo: () => get().goTo(get().cursor + 1),
  canUndo: () => get().cursor > 0,
  canRedo: () => get().cursor < get().events.length,
}))
