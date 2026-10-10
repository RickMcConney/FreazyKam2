// The FreazyKam side of controller/relay.html.
//
// FreazyKam is served over HTTPS and the controller speaks plain http/ws, so the
// browser will not let this page reach it (mixed content). Instead we open the
// relay — a tiny page living ON the controller — as a popup, and exchange
// postMessage with it; the relay makes same-origin requests to its own host.
// See scratch/machine-control-relay-plan.md for the whole design.
//
// This layer knows nothing about FluidNC: it is the typed end of a dumb pipe.

export interface HttpRequest {
  method?: 'GET' | 'POST'
  path: string                                  // absolute path on the controller, e.g. "/command"
  query?: Record<string, string>
  body?: string | Blob
  form?: [name: string, value: string | Blob, filename?: string][]
  onProgress?: (loaded: number, total: number) => void
  /**
   * Give up after this long with no answer (and, for an upload, no progress),
   * resolving `{ status: 0, body: 'timeout' }`. A browser request has no deadline of
   * its own: with the controller unreachable, requests piled up unanswered for as
   * long as the outage lasted. Default HTTP_TIMEOUT_MS.
   */
  timeoutMs?: number
}

export const HTTP_TIMEOUT_MS = 10000
/** What a request cut short by close() resolves with. */
export const RELAY_CLOSED = 'relay closed'

export interface HttpResponse { status: number; body: string }

export type WsState = 'connecting' | 'open' | 'closed' | 'error'

export interface RelayHandlers {
  onWsState?: (state: WsState, code?: number) => void
  onWsText?: (text: string) => void
  onWsBinary?: (data: ArrayBuffer) => void
  onClosed?: () => void                         // the relay window went away
}

const READY_TIMEOUT_MS = 15000
/**
 * How long a page from the controller may sit in the window without answering
 * hello before it is taken to be not the relay (a bare 404) and the next path is
 * tried. The relay answers within a tick or two of loading.
 */
const NOT_RELAY_MS = 2000

// How the relay reaches the browser as a PAGE.
// FluidNC v4+ (WebUI/WebDAV.cpp) serves any flash file inline at /flash/<name>, with
// a content type from its extension, so the relay is uploaded as freazyKam.html.
// v3 (WebUI/WebServer.cpp) has no /flash route and serves a file requested by name
// with `Content-Disposition: attachment` — a download, not a page; only its not-found
// page, 404.htm, is served inline. So on v3 the relay goes on flash AS 404.htm.
// One URL covers both: v3 finds no file at /flash/freazyKam.html (it reads that as
// /littlefs/flash/freazyKam.html) and falls back to 404.htm.
// The one case it misses is a v4 controller still holding the relay only as 404.htm
// (an install from before this change): v4's /flash route answers a bare 404, so
// RELAY_LEGACY_PATH — never a file — is tried next to reach the not-found page.
export const RELAY_FILE_NAME = 'freazyKam.html'
export const RELAY_LEGACY_FILE_NAME = '404.htm'
export const RELAY_PATH = '/flash/freazyKam.html'
export const RELAY_LEGACY_PATH = '/freazykam'
// Always in this order, never remembering which one worked last: a remembered legacy
// path kept answering (the old 404.htm stays on flash) after freazyKam.html was
// uploaded, so an upgraded controller was never reached the new way. The detour costs
// a legacy install NOT_RELAY_MS per Connect.
const RELAY_PATHS = [RELAY_PATH, RELAY_LEGACY_PATH]

/** Normalise a user-typed controller address to an origin: "fluidnc.local" → "http://fluidnc.local". */
export function controllerOrigin(address: string): string {
  const a = address.trim()
  return new URL(/^[a-z]+:\/\//i.test(a) ? a : `http://${a}`).origin
}

const RELAY_W = 420
const RELAY_H = 200

/**
 * Centred over the FreazyKam window, so it opens where the user is looking (a
 * page cannot open a window minimised). The browser keeps it on screen.
 */
function relayPlacement(): { left: number; top: number } {
  return {
    left: Math.round(window.screenX + (window.outerWidth - RELAY_W) / 2),
    top: Math.round(window.screenY + (window.outerHeight - RELAY_H) / 2),
  }
}

function relayWindowFeatures(): string {
  const { left, top } = relayPlacement()
  return `popup,width=${RELAY_W},height=${RELAY_H},left=${left},top=${top}`
}

/** The relay did not answer: the controller is unreachable, or the relay is not installed. */
export class RelaySetupError extends Error {}

export class RelayLink {
  readonly origin: string
  private win: Window | null = null
  private ready = false
  private nextId = 1
  private pending = new Map<number, {
    resolve: (r: HttpResponse) => void
    onProgress?: HttpRequest['onProgress']
    timer: ReturnType<typeof setTimeout>
    arm: () => void
  }>()
  private closedPoll: ReturnType<typeof setInterval> | undefined
  private handlers: RelayHandlers

  constructor(address: string, handlers: RelayHandlers) {
    this.origin = controllerOrigin(address)
    this.handlers = handlers
  }

  /**
   * Open the relay window and wait for it to say ready. MUST be called from a
   * click handler, or the popup blocker eats the window.
   */
  open(): Promise<void> {
    window.addEventListener('message', this.onMessage)
    window.addEventListener('pagehide', this.onPageHide)
    // A small popup rather than a tab, so FreazyKam keeps focus in its own tab.
    // Named, so a second Connect reuses the relay already open.
    let attempt = 0
    this.win = window.open(`${this.origin}${RELAY_PATHS[0]}`, 'freazykam-relay', relayWindowFeatures())
    if (!this.win) {
      this.dispose()
      return Promise.reject(new Error('The browser blocked the relay window — allow pop-ups for this site'))
    }
    // The left/top above are not enough: Chrome opened the relay where the last one
    // had been, however far FreazyKam had moved since. So move it as well — now, while
    // it is still the blank page it starts as, which is OURS (same origin) until the
    // controller's page arrives; after that only the relay's own code could move it.
    // A reused relay window is already the controller's, so this throws and is skipped.
    try { const { left, top } = relayPlacement(); this.win.moveTo(left, top) } catch { /* not ours */ }
    return new Promise((resolve, reject) => {
      const started = Date.now()
      let loadedAt = 0
      // The relay greets on load, but a reused window has already loaded, and a
      // fresh one is still about:blank for a moment (a post to it is dropped) —
      // so keep asking until it answers.
      const tick = setInterval(() => {
        if (this.ready) {
          clearInterval(tick); this.watchClosed(); resolve(); return
        }
        if (!this.win || this.win.closed) {
          clearInterval(tick); this.dispose(); reject(new Error('The relay window was closed')); return
        }
        const now = Date.now()
        if (now - started > READY_TIMEOUT_MS) {
          clearInterval(tick); this.dispose()
          reject(new RelaySetupError(`No answer from the relay at ${this.origin}${RELAY_PATH} — is the controller reachable, and is the relay on its flash (${RELAY_FILE_NAME} on FluidNC v4+, ${RELAY_LEGACY_FILE_NAME} on v3)?`))
          return
        }
        // A page from the controller has loaded but is not answering: not the relay.
        // Try the next path. (Until the controller's page commits, the window is still
        // the opener's own about:blank, readable; after, reading it throws.)
        if (attempt < RELAY_PATHS.length - 1 && !this.isBlank()) {
          if (!loadedAt) loadedAt = now
          else if (now - loadedAt > NOT_RELAY_MS) {
            attempt++
            loadedAt = 0
            try { this.win.location.replace(`${this.origin}${RELAY_PATHS[attempt]}`) } catch { /* window gone */ }
            return
          }
        }
        this.post({ op: 'hello' })
      }, 250)
    })
  }

  get isOpen(): boolean { return this.ready && !!this.win && !this.win.closed }

  http(req: HttpRequest): Promise<HttpResponse> {
    const id = this.nextId++
    const ms = req.timeoutMs ?? HTTP_TIMEOUT_MS
    return new Promise((resolve) => {
      // A late answer after the deadline finds nothing pending and is dropped.
      const expire = () => {
        const p = this.pending.get(id)
        if (p) { this.pending.delete(id); p.resolve({ status: 0, body: 'timeout' }) }
      }
      const entry = {
        resolve, onProgress: req.onProgress, timer: setTimeout(expire, ms),
        arm: () => { clearTimeout(entry.timer); entry.timer = setTimeout(expire, ms) },
      }
      this.pending.set(id, entry)
      this.post({ op: 'http', id, method: req.method ?? 'GET', path: req.path, query: req.query, body: req.body, form: req.form })
    })
  }

  wsOpen(port?: number, path?: string, protocol: 'webui-v3' | 'arduino' = 'webui-v3') {
    this.post({ op: 'ws-open', port, path, protocol })
  }
  wsSend(data: string | ArrayBuffer) { this.post({ op: 'ws-send', data }) }
  wsClose() { this.post({ op: 'ws-close' }) }
  /** The relay window's title, so the machine state reads from its title bar. */
  setTitle(text: string) { this.post({ op: 'title', text }) }
  /** Match FreazyKam's light/dark mode, so the relay looks like part of the app. */
  setTheme(dark: boolean) { this.post({ op: 'theme', dark }) }

  /** Close the link, and the relay window with it. */
  close() {
    if (this.win && !this.win.closed) {
      this.post({ op: 'ws-close' })
      this.win.close()
    }
    this.dispose()
  }

  private post(msg: unknown) {
    // An explicit target origin: if the window has navigated elsewhere, the
    // browser drops the message rather than handing it to a stranger.
    try { this.win?.postMessage(msg, this.origin) } catch { /* window gone */ }
  }

  /** True while the window still holds the opener's initial about:blank. */
  private isBlank(): boolean {
    try { return this.win?.location.href === 'about:blank' } catch { return false }
  }

  private watchClosed() {
    // A closed window sends nothing (pagehide's 'closed' is best-effort), so poll.
    this.closedPoll = setInterval(() => {
      if (!this.win || this.win.closed) { this.dispose(); this.handlers.onClosed?.() }
    }, 1000)
  }

  private dispose() {
    window.removeEventListener('message', this.onMessage)
    window.removeEventListener('pagehide', this.onPageHide)
    if (this.closedPoll) clearInterval(this.closedPoll)
    this.closedPoll = undefined
    this.ready = false
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ status: 0, body: RELAY_CLOSED }) }
    this.pending.clear()
  }

  // The relay window outlives a FreazyKam reload unless it is closed here, and the next
  // Connect then REUSES it (it is named) — and window.open only places a window it
  // creates, so the relay stayed wherever it was, however far FreazyKam had moved. Only
  // the relay's own page can move it (as its shrink button does), and that is code on the
  // controller's flash. So close it on the way out, and every Connect opens a new one
  // centred over FreazyKam. The link dies with this page anyway.
  private onPageHide = () => { this.close() }

  private onMessage = (e: MessageEvent) => {
    if (e.origin !== this.origin || e.source !== this.win) return
    const m = e.data
    if (!m || typeof m.op !== 'string') return
    switch (m.op) {
      case 'ready': this.ready = true; break
      case 'http-res': {
        const p = this.pending.get(m.id)
        if (p) { clearTimeout(p.timer); this.pending.delete(m.id); p.resolve({ status: m.status, body: m.body }) }
        break
      }
      case 'http-progress': {
        // Progress is an answer of sorts: an upload that is moving is not timed out.
        const p = this.pending.get(m.id)
        if (p) { p.arm(); p.onProgress?.(m.loaded, m.total) }
        break
      }
      case 'ws-state': this.handlers.onWsState?.(m.state, m.code); break
      case 'ws-msg': this.handlers.onWsText?.(m.text); break
      case 'ws-bin': this.handlers.onWsBinary?.(m.data); break
      case 'closed': this.dispose(); this.handlers.onClosed?.(); break
    }
  }
}
