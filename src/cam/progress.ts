// Generation progress reporting.
//
// Toolpath generators run inside a worker, so they can't be handed a callback (functions
// don't survive postMessage). Instead the worker installs an ambient reporter for the
// duration of a job and the generators call `reportProgress` wherever they know how far
// along they are. Outside a worker — the script harnesses import the CAM modules directly —
// no reporter is installed and every call is a no-op.
//
// Reporting is throttled here rather than at each call site: the adaptive march would
// otherwise report on every one of a hundred thousand steps, and each report is a
// postMessage.

type Reporter = (frac: number, label?: string) => void

let reporter: Reporter | null = null
let lastSentAt = 0
let lastSentFrac = -1

const MIN_INTERVAL_MS = 60
const MIN_DELTA = 0.005

export function setProgressReporter(r: Reporter | null): void {
  reporter = r
  lastSentAt = 0
  lastSentFrac = -1
}

export function reportProgress(frac: number, label?: string): void {
  if (!reporter) return
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac
  const now = performance.now()
  // Always let the ends through: they start and finish the bar.
  const isEdge = f <= 0 || f >= 1
  if (!isEdge && now - lastSentAt < MIN_INTERVAL_MS && Math.abs(f - lastSentFrac) < MIN_DELTA) return
  lastSentAt = now
  lastSentFrac = f
  reporter(f, label)
}

/**
 * A reporter for one stage of a longer job: `sub(0.2, 0.6)` maps a stage's own 0→1 onto
 * the 20%→60% band of the whole. Lets a generator hand a stage a plain 0→1 callback
 * without the stage knowing where it sits in the job.
 */
export function subProgress(lo: number, hi: number, label?: string): Reporter {
  return (frac, subLabel) => reportProgress(lo + (hi - lo) * frac, subLabel ?? label)
}
