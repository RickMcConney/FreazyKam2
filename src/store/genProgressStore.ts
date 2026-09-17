import { create } from 'zustand'
import { addWorkerProgressListener } from '../workers/workerClient'

// Live progress of toolpath generations, fed by the worker (see cam/progress.ts).
//
// `overall` stays null until a generation has been running longer than SHOW_AFTER_MS, so
// the button only grows a progress bar on the operations that actually take a while — a
// bar that appears and completes in 50 ms is noise. Below that threshold the button keeps
// its plain spinner.

const SHOW_AFTER_MS = 400

interface Entry { frac: number; label?: string; startedAt: number }

interface GenProgressState {
  byOp: Record<string, Entry>
  /** Mean progress across everything generating, or null while nothing is slow enough. */
  overall: number | null
  label: string | null
}

const KEYLESS = '__no_op__'

function summarize(byOp: Record<string, Entry>): { overall: number | null; label: string | null } {
  const now = performance.now()
  const slow = Object.values(byOp).filter((e) => now - e.startedAt >= SHOW_AFTER_MS)
  if (slow.length === 0) return { overall: null, label: null }
  const overall = slow.reduce((s, e) => s + e.frac, 0) / slow.length
  // One operation names its stage; several at once would just flicker between them.
  return { overall, label: slow.length === 1 ? (slow[0].label ?? null) : null }
}

export const useGenProgressStore = create<GenProgressState>()(() => ({
  byOp: {},
  overall: null,
  label: null,
}))

addWorkerProgressListener(({ opId, frac, label, done }) => {
  const key = opId ?? KEYLESS
  const state = useGenProgressStore.getState()
  const byOp = { ...state.byOp }
  if (done) {
    delete byOp[key]
  } else {
    byOp[key] = { frac, label, startedAt: byOp[key]?.startedAt ?? performance.now() }
  }
  useGenProgressStore.setState({ byOp, ...summarize(byOp) })
})
