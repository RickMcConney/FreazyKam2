import { create } from 'zustand'
import { uid } from '../uid'
import { labelFor, TRANSFORM_GESTURES, type TimelineEvent, type TimelineEventPayload } from './events'
import type { ImportedPath, PathUpdate } from '../store/pathsStore'
import { usePathsStore } from '../store/pathsStore'
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

// The undo history: an event log with a cursor, one event per undo step, and a
// snapshot of the whole project behind each one (see below). Every project mutation
// records a TimelineEvent — or joins the step it is editing (see joinsTip) — and
// undo/redo move the cursor.

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
// finishing its generation, a `generating` status, an edit joining its step, a second drag merged
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

// Nothing recorded this batch: it was a derived write or an edit joining the tip step, so it IS the state at the
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
  // state. Used by new project and by project load.
  resetToCurrentState: () => void
  markSaved: () => void
  // Force "unsaved" — -1 is the store's idiom for "no event matches the last save".
  // Needed after an autosave restore: loadProject ends by marking the document clean,
  // which is right for a file on disk and wrong for a recovered snapshot — that
  // document matches nothing on disk, and reporting it as saved would stop the next
  // snapshot from being offered back.
  markUnsaved: () => void
  // Undo/redo: install the snapshot at `seq` (0 = genesis).
  goTo: (seq: number) => void
  // Does this edit belong to the step the cursor is on? True when that step made or
  // re-defined one of `refs` — changing a just-made pocket's depth, stepping a gear's
  // bore, dragging a tab of the Tabs just applied — and then the caller records
  // NOTHING: the edit lands in the stores and the mirror folds it into that step's
  // snapshot, so one undo takes back the thing and its edits together. False for any
  // older step, which must not absorb a later edit (see joinsTip below), and the
  // caller then records an ordinary event of its own.
  joinsTip: (refs: TipRef[]) => boolean
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
    void import('../cam/regenerate').then(({ regenerateMany }) => {
      regenerateMany(useToolpathStore.getState().operations.filter((op) => op.status === 'needs-update'))
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

/** A thing an edit touches: an operation, a path, or the tabs on a path. */
export type TipRef = { op: string } | { path: string } | { tabsOf: string }

// Did event `ev` make or re-define `ref`? Moves, rotates and the other geometry gestures
// are edits OF a path, not its definition, so a parameter change after one is a step of
// its own.
function defines(ev: TimelineEvent, ref: TipRef): boolean {
  if ('op' in ref) {
    if (ev.kind === 'op.add') return ev.op.id === ref.op || !!ev.linked?.some((o) => o.id === ref.op)
    return ev.kind === 'op.update' && ev.opId === ref.op
  }
  if ('tabsOf' in ref) return ev.kind === 'tabs.apply' && ev.pathId === ref.tabsOf
  const id = ref.path
  switch (ev.kind) {
    case 'paths.add': return ev.paths.some((p) => p.id === id)
    case 'shape.params': return ev.pathId === id
    case 'paths.split': return ev.subPaths.some((p) => p.id === id)
    case 'paths.edit':
      return !ev.gesture && (
        ev.updates.some((u) => u.id === id && !u.transforms?.length && !u.corner?.length)
        || !!ev.add?.some((p) => p.id === id)
        || !!ev.deleteIds?.includes(id))
    default: return false
  }
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
    // The state at the cursor is whatever is live RIGHT NOW — edits that joined it,
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

  // ONLY THE STEP THE CURSOR IS ON. An edit that joins a step records nothing; the mirror
  // (noteWrite / settleBatch) folds it into the CURSOR's snapshot, which is that step's
  // own snapshot only when that step is the cursor's. Joining an OLDER step — the
  // pocket's op.add with a rectangle drawn since — left the pocket's snapshot holding the
  // old depth and parked the new one in the rectangle's step: one undo took back the
  // rectangle AND the depth edit (scratch/review.md B2). Not genesis either (cursor 0,
  // just after a load): folding an edit into it made the edit impossible to undo. And
  // not the step the last save captured, which must stay what was saved.
  // Pinned by `npx vite-node scripts/undo-amend.mts`.
  joinsTip: (refs) => {
    const s = get()
    if (s.cursor === 0) return false
    const tip = s.events[s.cursor - 1]
    if (tip.seq === s.savedSeq) return false
    return refs.some((r) => defines(tip, r))
  },

  undo: () => get().goTo(get().cursor - 1),
  redo: () => get().goTo(get().cursor + 1),
  canUndo: () => get().cursor > 0,
  canRedo: () => get().cursor < get().events.length,
}))
