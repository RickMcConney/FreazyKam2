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
  installWakeLog()
  window.addEventListener('error', (ev) => recordCrash('error', ev.error ?? ev.message))
  window.addEventListener('unhandledrejection', (ev) => recordCrash('rejection', ev.reason))
}

// ─── Wake log ────────────────────────────────────────────────────────────────
//
// The white page after sleep came back with an EMPTY crash log, and the bridge kept
// logging its reconnect attempts throughout — so no error escaped, and the main thread
// was alive. That leaves two explanations, and this log separates them: the DOM was
// emptied (root has no children) or the DOM is intact and the browser is not PAINTING
// it (frames stop arriving, or the GPU took a WebGL context away). Each wake after a
// hide of 30 s or more writes one entry, plus the page-lifecycle events around it.
//
// Read it with `JSON.parse(localStorage['fkam.wakeLog'])`.

const WAKE_KEY = 'fkam.wakeLog'
const WAKE_KEEP = 40
const WAKE_MIN_HIDDEN_S = 30

function pushWake(entry: Record<string, unknown>) {
  try {
    const raw = globalThis.localStorage?.getItem(WAKE_KEY)
    const log = raw ? JSON.parse(raw) : []
    const next = [...(Array.isArray(log) ? log : []), { at: new Date().toISOString(), ...entry }].slice(-WAKE_KEEP)
    globalThis.localStorage?.setItem(WAKE_KEY, JSON.stringify(next))
  } catch { /* storage full or unavailable */ }
  console.info('[wake]', entry)
}

export function readWakeLog(): unknown[] {
  try { const v = JSON.parse(globalThis.localStorage?.getItem(WAKE_KEY) ?? '[]'); return Array.isArray(v) ? v : [] }
  catch { return [] }
}

/** Count frames for `ms` — zero means the page is not being composited at all. */
function countFrames(ms: number): Promise<number> {
  return new Promise((resolve) => {
    let n = 0
    const end = performance.now() + ms
    const tick = () => { n++; if (performance.now() < end) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    setTimeout(() => resolve(n), ms + 50)
  })
}

function snapshotPage() {
  const root = document.getElementById('root')
  const canvases = [...document.querySelectorAll('canvas')]
  const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
  return {
    rootChildren: root?.childElementCount ?? -1,
    bodyRect: `${document.body.clientWidth}x${document.body.clientHeight}`,
    window: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    canvases: canvases.map((c) => `${c.width}x${c.height}${c.isConnected ? '' : '(detached)'}`).join(' '),
    centerElement: hit ? `${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''}.${String(hit.className).slice(0, 40)}` : null,
  }
}

function installWakeLog() {
  let hiddenAt: number | null = null
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
    const hiddenForS = hiddenAt !== null ? Math.round((Date.now() - hiddenAt) / 1000) : null
    hiddenAt = null
    if (hiddenForS === null || hiddenForS < WAKE_MIN_HIDDEN_S) return
    const page = snapshotPage()
    void countFrames(1000).then((framesIn1s) => {
      // A second look after the first frames: did the page come back by itself?
      pushWake({ event: 'wake', hiddenForS, framesIn1s, ...page, after1s: snapshotPage().rootChildren })
    })
  })
  // Page-lifecycle events (Chrome): a frozen-then-resumed or bfcache-restored page
  // is a different path back from sleep than a plain visibility change.
  document.addEventListener('freeze', () => pushWake({ event: 'freeze' }))
  document.addEventListener('resume', () => pushWake({ event: 'resume' }))
  window.addEventListener('pageshow', (e) => { if (e.persisted) pushWake({ event: 'pageshow-bfcache' }) })
  // webglcontextlost does not bubble, but a capture listener on the document sees it.
  document.addEventListener('webglcontextlost', () => pushWake({ event: 'webglcontextlost' }), true)
  document.addEventListener('webglcontextrestored', () => pushWake({ event: 'webglcontextrestored' }), true)
}
