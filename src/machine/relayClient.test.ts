import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RelayLink, RelaySetupError, RELAY_CLOSED, RELAY_PATH, RELAY_LEGACY_PATH, controllerOrigin } from './relayClient'

// THE BROWSER, FAKED: tests run in node, so `window` and the relay popup are stand-ins.
// The popup records what is posted to it; a test plays the relay by delivering
// messages to the listener the link registered, from the popup and the controller's origin.
const ORIGIN = 'http://fluidnc.local'

interface FakePopup {
  closed: boolean
  posted: { msg: Record<string, unknown>; origin: string }[]
  location: { href: string; replace: (url: string) => void }
  postMessage: (msg: Record<string, unknown>, origin: string) => void
  close: () => void
  moveTo: (x: number, y: number) => void
}

let popup: FakePopup
let listener: ((e: MessageEvent) => void) | null
let pageHide: (() => void) | null
let openUrl: string | null

beforeEach(() => {
  vi.useFakeTimers()
  listener = null
  pageHide = null
  openUrl = null
  popup = {
    closed: false,
    posted: [],
    location: { href: 'about:blank', replace: vi.fn() },
    postMessage(msg, origin) { this.posted.push({ msg, origin }) },
    close() { this.closed = true },
    moveTo: vi.fn(),
  }
  vi.stubGlobal('window', {
    screenX: 0, screenY: 0, outerWidth: 1400, outerHeight: 900,
    addEventListener: (type: string, fn: (e: MessageEvent) => void) => {
      if (type === 'message') listener = fn
      if (type === 'pagehide') pageHide = fn as () => void
    },
    removeEventListener: (type: string, fn: (e: MessageEvent) => void) => {
      if (type === 'message' && listener === fn) listener = null
      if (type === 'pagehide' && pageHide === fn) pageHide = null
    },
    open: (url: string) => { openUrl = url; return popup },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** The relay saying something, from the popup on the controller's origin. */
function relay(data: Record<string, unknown>, from: { origin?: string; source?: unknown } = {}) {
  listener?.({ origin: from.origin ?? ORIGIN, source: from.source ?? popup, data } as MessageEvent)
}

async function opened(handlers = {}) {
  const l = new RelayLink('fluidnc.local', handlers)
  const p = l.open()
  relay({ op: 'ready' })
  await vi.advanceTimersByTimeAsync(250)
  await p
  return l
}

const lastPosted = () => popup.posted[popup.posted.length - 1].msg

describe('controllerOrigin', () => {
  it('takes a bare host name as plain http — the controller serves no https', () => {
    expect(controllerOrigin(' fluidnc.local ')).toBe('http://fluidnc.local')
  })

  it('keeps a given scheme and port and drops any path', () => {
    expect(controllerOrigin('http://192.168.1.5:8080/x')).toBe('http://192.168.1.5:8080')
  })
})

describe('opening the relay', () => {
  it('opens the relay page and resolves once the relay says it is ready', async () => {
    const l = await opened()
    expect(openUrl).toBe(`${ORIGIN}${RELAY_PATH}`)
    expect(l.isOpen).toBe(true)
  })

  it('moves the new relay window to the centre of FreazyKam itself, since Chrome may ignore the left/top it was opened with', async () => {
    vi.stubGlobal('window', { ...window, screenX: 2000, screenY: 100 })
    await opened()
    // A 1400 × 900 FreazyKam window at (2000, 100); the relay is 420 × 200.
    expect(popup.moveTo).toHaveBeenCalledWith(2000 + 490, 100 + 350)
  })

  it('still opens a relay window it is not allowed to move — one already on the controller\'s page', async () => {
    popup.moveTo = () => { throw new DOMException('cross-origin', 'SecurityError') }
    const l = await opened()
    expect(l.isOpen).toBe(true)
  })

  it('closes the relay window when FreazyKam unloads, so the next Connect opens a new one centred over it rather than reusing one left wherever it was', async () => {
    await opened()
    pageHide?.()
    expect(popup.closed).toBe(true)
    expect(pageHide).toBeNull()
  })

  it('posts only to the controller\'s origin, so a window that navigated elsewhere gets nothing', async () => {
    const l = new RelayLink('fluidnc.local', {})
    void l.open()
    await vi.advanceTimersByTimeAsync(250)
    expect(popup.posted[0]).toEqual({ msg: { op: 'hello' }, origin: ORIGIN })
  })

  it('says pop-ups are blocked when the browser gives no window', async () => {
    vi.stubGlobal('window', { ...window, open: () => null })
    await expect(new RelayLink('fluidnc.local', {}).open()).rejects.toThrow(/allow pop-ups/)
  })

  it('tries the legacy path when a page loads at the first one but never answers (FluidNC v3 serves 404.htm there)', async () => {
    const l = new RelayLink('fluidnc.local', {})
    void l.open()
    popup.location.href = `${ORIGIN}${RELAY_PATH}`      // a page from the controller, not the relay
    await vi.advanceTimersByTimeAsync(250)               // first sight of the loaded page
    await vi.advanceTimersByTimeAsync(2250)              // silent for longer than NOT_RELAY_MS
    expect(popup.location.replace).toHaveBeenCalledWith(`${ORIGIN}${RELAY_LEGACY_PATH}`)
  })

  it('gives up with a setup error when nothing answers for 15 s', async () => {
    const p = new RelayLink('fluidnc.local', {}).open()
    const caught = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(15500)
    expect(await caught).toBeInstanceOf(RelaySetupError)
  })

  it('fails at once, not after the timeout, when the user closes the relay window', async () => {
    const p = new RelayLink('fluidnc.local', {}).open()
    const caught = p.catch((e) => e)
    popup.closed = true
    await vi.advanceTimersByTimeAsync(250)
    expect((await caught).message).toMatch(/closed/)
  })
})

describe('requests through the relay', () => {
  it('posts the request with an id and resolves with the answer carrying that id', async () => {
    const l = await opened()
    const p = l.http({ path: '/command', query: { cmd: '$X' } })
    expect(lastPosted()).toMatchObject({ op: 'http', method: 'GET', path: '/command', query: { cmd: '$X' } })
    relay({ op: 'http-res', id: lastPosted().id, status: 200, body: 'ok' })
    expect(await p).toEqual({ status: 200, body: 'ok' })
  })

  it('resolves `timeout` when the controller does not answer in time, and drops the late answer', async () => {
    const l = await opened()
    const p = l.http({ path: '/command', timeoutMs: 1000 })
    const id = lastPosted().id
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toEqual({ status: 0, body: 'timeout' })
    expect(() => relay({ op: 'http-res', id, status: 200, body: 'late' })).not.toThrow()
  })

  it('does not time out an upload that is still making progress', async () => {
    const l = await opened()
    const onProgress = vi.fn()
    let done = false
    const p = l.http({ method: 'POST', path: '/upload', timeoutMs: 1000, onProgress }).then((r) => { done = true; return r })
    const id = lastPosted().id
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(800)
      relay({ op: 'http-progress', id, loaded: i * 100, total: 300 })
    }
    expect(done).toBe(false)                     // 2.4 s in, past a 1 s deadline
    expect(onProgress).toHaveBeenLastCalledWith(300, 300)
    relay({ op: 'http-res', id, status: 200, body: '{}' })
    expect((await p).status).toBe(200)
  })

  it('closing the link answers every request still waiting, and closes the relay window', async () => {
    const l = await opened()
    const p = l.http({ path: '/command' })
    l.close()
    expect(await p).toEqual({ status: 0, body: RELAY_CLOSED })
    expect(popup.closed).toBe(true)
  })
})

describe('messages from the relay', () => {
  it('ignores a message from any other origin or window', async () => {
    const onWsText = vi.fn()
    await opened({ onWsText })
    relay({ op: 'ws-msg', text: 'from elsewhere' }, { origin: 'http://evil.example' })
    relay({ op: 'ws-msg', text: 'from another window' }, { source: {} })
    expect(onWsText).not.toHaveBeenCalled()
    relay({ op: 'ws-msg', text: 'CURRENTID:7' })
    expect(onWsText).toHaveBeenCalledWith('CURRENTID:7')
  })

  it('passes socket state, text and binary frames to their handlers', async () => {
    const onWsState = vi.fn(), onWsBinary = vi.fn()
    await opened({ onWsState, onWsBinary })
    const buf = new ArrayBuffer(2)
    relay({ op: 'ws-state', state: 'closed', code: 1006 })
    relay({ op: 'ws-bin', data: buf })
    expect(onWsState).toHaveBeenCalledWith('closed', 1006)
    expect(onWsBinary).toHaveBeenCalledWith(buf)
  })

  it('reports the relay window closing when the relay says so on its way out', async () => {
    const onClosed = vi.fn()
    const l = await opened({ onClosed })
    relay({ op: 'closed' })
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(l.isOpen).toBe(false)
  })

  it('notices the relay window closing without a word, by polling it', async () => {
    const onClosed = vi.fn()
    const l = await opened({ onClosed })
    popup.closed = true                          // closed without a word, as a window usually is
    await vi.advanceTimersByTimeAsync(1000)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(l.isOpen).toBe(false)
  })
})
