// In-session undo stacks for the pen and point-edit tools.
//
// These are plain refs (never React state), so entries are pushed in place.
// The old `stack.current = [...stack.current, entry]` form copied the whole
// stack on every node placed or dragged, which is O(n²) across a session — and
// since each entry holds a full snapshot of the node array, an uncapped stack
// also retained every intermediate state until the session ended.

// Deep enough that no realistic editing session hits it, shallow enough that a
// long session doesn't pin unbounded memory.
export const LOCAL_HISTORY_LIMIT = 200

// Push one entry, discarding the oldest once the cap is reached. `shift()` is
// O(n) but only runs at the cap, so the amortized cost stays constant.
export function pushLocalHistory<T>(stack: T[], entry: T, limit = LOCAL_HISTORY_LIMIT): void {
  stack.push(entry)
  if (stack.length > limit) stack.shift()
}

// ── Point-edit steps that also wrote to the GLOBAL history ─────────────────────
//
// A join or split in point edit records one global event, and its local undo replays
// the timeline's undo/redo. That is only right while the gesture's event is still where
// the gesture left it: the session stays open while the rest of the app is usable, so
// an op edit recorded in between would otherwise be the thing taken back. Checked by
// event IDENTITY, never by cursor number — the history sheds old events, which
// renumbers the cursor. `before` is the event the timeline stood on when the gesture
// began (null at genesis).

/** May a local undo replay `timeline.undo()` for this step? Only when the event at the
 *  cursor sits directly on `before` — i.e. it is the gesture's own event, not merged
 *  into an older one, and nothing has been recorded on top of it. */
export function globalStepUndoable<E>(events: E[], cursor: number, before: E | null): boolean {
  return !!events[cursor - 1] && (events[cursor - 2] ?? null) === before
}

/** May a local redo replay `timeline.redo()`? Only when the timeline is back on `before`
 *  and the event after it is still the gesture's — a record since the undo truncates the
 *  redo branch and puts a different event there. */
export function globalStepRedoable<E>(events: E[], cursor: number, before: E | null, event: E | undefined): boolean {
  return !!event && events[cursor] === event && (events[cursor - 1] ?? null) === before
}
