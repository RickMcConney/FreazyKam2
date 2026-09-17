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
