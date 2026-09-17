// A memory budget for the toolpaths the undo history keeps alive.
//
// Undo is a snapshot stack of LIVE objects (see timelineStore.ts), which is what makes it
// instant: an operation nobody touched is the very same object in every snapshot, segments
// and all, so undoing past a thirty-second adaptive costs nothing. The flip side is that the
// history was bounded by COUNT, not by size. Every regeneration makes a NEW segments array,
// and each snapshot taken since holds on to its own — nudge a path a hundred times under a
// big program and a hundred copies of its toolpath stay reachable, which is how a tab ends
// up discarded by the browser or killed outright.
//
// Only arrays held by history ALONE cost anything: one the live program still references is
// alive regardless, and one shared by several snapshots is one array. So those are what is
// counted, and when they pass the budget the ones whose most recent snapshot is OLDEST lose
// their segments first. An evicted op comes back from undo as `needs-update`, which
// restoreStateAt already regenerates — so recent undo stays instant, far undo costs a
// regeneration, and nothing is lost that cannot be rebuilt.
//
// Pure, and imports nothing at runtime, so it runs under the node test environment.
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'

/** History-only segments kept before the oldest are evicted (~100-200 MB of MotionSegment). */
export const HISTORY_SEGMENT_BUDGET = 2_000_000

/**
 * Evict the oldest history-only toolpaths until the rest fit `budget` segments.
 *
 * Mutates `snapshots` IN PLACE (slots are replaced with new snapshot objects, never edited)
 * because the caller's stack is a module-level array. Returns how many segment arrays were
 * evicted.
 *
 * An imported G-code operation is never touched: nothing can regenerate it, so its
 * segments ARE the operation.
 */
export function evictHistorySegments<S extends { operations: AnyOperation[] }>(
  snapshots: (S | undefined)[],
  liveOps: readonly AnyOperation[],
  budget: number = HISTORY_SEGMENT_BUDGET,
): number {
  const live = new Set<MotionSegment[]>()
  for (const op of liveOps) live.add(op.segments)

  // Each history-only array → the index of the NEWEST snapshot holding it. Counted once
  // however many snapshots share it.
  const newest = new Map<MotionSegment[], number>()
  let total = 0
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]
    if (!snap) continue
    for (const op of snap.operations) {
      const segs = op.segments
      if (op.type === 'gcode' || !segs || segs.length === 0 || live.has(segs)) continue
      if (!newest.has(segs)) total += segs.length
      newest.set(segs, i)
    }
  }
  if (total <= budget) return 0

  const victims = new Set<MotionSegment[]>()
  const byAge = [...newest.entries()].sort((a, b) => a[1] - b[1])
  for (const [segs] of byAge) {
    if (total <= budget) break
    victims.add(segs)
    total -= segs.length
  }

  // One stripped replacement per original op object, so snapshots that shared an op still
  // share it afterwards.
  const stripped = new Map<AnyOperation, AnyOperation>()
  const strip = (op: AnyOperation): AnyOperation => {
    let out = stripped.get(op)
    if (!out) {
      out = { ...op, segments: [], status: 'needs-update' } as AnyOperation
      stripped.set(op, out)
    }
    return out
  }
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]
    if (!snap || !snap.operations.some((o) => victims.has(o.segments))) continue
    snapshots[i] = {
      ...snap,
      operations: snap.operations.map((o) => (victims.has(o.segments) ? strip(o) : o)),
    }
  }
  return victims.size
}
