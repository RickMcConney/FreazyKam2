// ─── Crash log ────────────────────────────────────────────────────────────────
//
// The "app turns white after the display sleeps" report. A white page is React
// unmounting the whole tree after an error nothing caught — but by the time anyone
// looks, the page has been reloaded and the error is gone with it. So every error
// that reaches the top (the CrashBoundary, `window.onerror`, an unhandled promise
// rejection) is written to localStorage, with how long the page had been hidden
// before it — the one fact that ties a crash to sleep or rules it out.
//
// Read it back from the dev console with `JSON.parse(localStorage['fkam.crashLog'])`,
// or from the crash screen itself.

const KEY = 'fkam.crashLog'
const KEEP = 20

export interface CrashEntry {
  at: string               // ISO time of the error
  source: 'render' | 'error' | 'rejection' | 'boot'
  message: string
  stack?: string
  componentStack?: string
  visibility: string       // document.visibilityState when it happened
  hiddenForS: number | null // how long the page was hidden before it last became visible
  sinceVisibleS: number | null // seconds between becoming visible and the error
}

let hiddenAt: number | null = null
let lastHiddenForS: number | null = null
let visibleAt: number | null = null

/** Remember when the page was last hidden and shown, so an entry can say so. */
function trackVisibility() {
  if (typeof document === 'undefined') return
  document.addEventListener('visibilitychange', () => {
    const now = Date.now()
    if (document.visibilityState === 'hidden') hiddenAt = now
    else {
      lastHiddenForS = hiddenAt !== null ? Math.round((now - hiddenAt) / 1000) : null
      visibleAt = now
      hiddenAt = null
    }
  })
}

export function readCrashLog(): CrashEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export function clearCrashLog() {
  try { globalThis.localStorage?.removeItem(KEY) } catch { /* storage unavailable */ }
}

export function recordCrash(source: CrashEntry['source'], err: unknown, componentStack?: string): CrashEntry {
  const e = err instanceof Error ? err : null
  const entry: CrashEntry = {
    at: new Date().toISOString(),
    source,
    message: e ? `${e.name}: ${e.message}` : String(err),
    stack: e?.stack,
    componentStack: componentStack || undefined,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    hiddenForS: lastHiddenForS,
    sinceVisibleS: visibleAt !== null ? Math.round((Date.now() - visibleAt) / 1000) : null,
  }
  try {
    const log = [...readCrashLog(), entry].slice(-KEEP)
    globalThis.localStorage?.setItem(KEY, JSON.stringify(log))
  } catch { /* storage full or unavailable: the console still has it */ }
  console.error(`[crash:${source}]`, err, componentStack ?? '')
  return entry
}

/** Log every error that escapes to the window. Call once, before rendering. */
export function installCrashLog() {
  if (typeof window === 'undefined') return
  trackVisibility()
  window.addEventListener('error', (ev) => recordCrash('error', ev.error ?? ev.message))
  window.addEventListener('unhandledrejection', (ev) => recordCrash('rejection', ev.reason))
}
