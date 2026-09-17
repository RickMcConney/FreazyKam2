import { cancelAllWork } from './workerClient'
import { useToolpathStore } from '../store/toolpathStore'
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
export function abortGeneration(): number {
  const stopped = cancelAllWork()
  if (stopped === 0) return 0
  useToolpathStore.getState().cancelGenerating()
  useUIStore.getState().showStatus(
    `Generation cancelled (${stopped} operation${stopped === 1 ? '' : 's'})`,
  )
  return stopped
}
