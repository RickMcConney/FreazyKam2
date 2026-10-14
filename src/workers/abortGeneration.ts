import { cancelAllWork } from './workerClient'
import { useToolpathStore, flushDerived } from '../store/toolpathStore'
import { useUIStore } from '../store/uiStore'

// Stop everything the generation pool is doing and leave the store consistent.
//
// Two things make this necessary rather than merely tidy. A pocket or V-carve on a big
// compound path runs for seconds with no way to yield, so a user who has changed their
// mind has nothing to do but wait; and a result that lands AFTER an undo or a New Project
// would write segments computed from geometry that no longer exists.
//
// The store is reconciled in the same synchronous turn as the cancel: cancelAllWork
// rejects the promises immediately, but the `catch` blocks awaiting them run a microtask
// later, so flipping the statuses here happens first and those catches (which skip
// cancellations, see isWorkCancelled) leave it alone.
// How many times generation has been stopped. A Stop pressed while a generate loop is
// BETWEEN jobs — awaiting the start optimizer, decoding a photo — finds nothing in a worker
// to terminate, so the loop would carry straight on to its next operation. Loops read this
// before each job instead (`stopsSoFar`) and stop if it has moved.
let stops = 0
/** The stop count now — compare a later reading to see whether Stop was pressed between. */
export const stopsSoFar = () => stops

export function abortGeneration(): number {
  stops++
  // Toolpaths a batch has finished but not yet written go in first, against the state they
  // were generated from — an undo files them in the snapshot it is leaving.
  flushDerived()
  const stopped = cancelAllWork()
  if (stopped === 0) return 0
  useToolpathStore.getState().cancelGenerating()
  useUIStore.getState().showStatus(
    `Generation cancelled (${stopped} operation${stopped === 1 ? '' : 's'})`,
  )
  return stopped
}
