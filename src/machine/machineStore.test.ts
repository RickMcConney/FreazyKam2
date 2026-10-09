import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HttpRequest, HttpResponse, RelayHandlers } from './relayClient'

vi.mock('../cam/regenerate')

// THE CONTROLLER, FAKED AT THE RELAY. The store talks to a RelayLink; this one answers
// as FluidNC does over the relay — [ESP800] names the socket port, commands answer "ok",
// /upload keeps an in-memory SD card — and hands the test the socket callbacks, so a
// status report or a dropped socket can be delivered exactly when a test wants one.
interface FakeLink {
  handlers: RelayHandlers
  calls: HttpRequest[]
  wsOpens: unknown[][]
  isOpen: boolean
  closed: boolean
}
const g = globalThis as unknown as {
  __link: FakeLink | null
  __openError: Error | null
  __respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>
}

vi.mock('./relayClient', () => {
  class RelaySetupError extends Error {}
  class RelayLink {
    calls: HttpRequest[] = []
    wsOpens: unknown[][] = []
    isOpen = false
    closed = false
    constructor(public address: string, public handlers: RelayHandlers) { g.__link = this as unknown as FakeLink }
    open() {
      if (g.__openError) return Promise.reject(g.__openError)
      this.isOpen = true
      return Promise.resolve()
    }
    http(req: HttpRequest) { this.calls.push(req); return Promise.resolve(g.__respond(req)) }
    wsOpen(...a: unknown[]) { this.wsOpens.push(a) }
    wsSend() {}
    wsClose() {}
    setTitle() {}
    setTheme() {}
    close() { this.isOpen = false; this.closed = true }
  }
  return { RelayLink, RelaySetupError, RELAY_CLOSED: 'relay closed' }
})

const ESP800 = JSON.stringify({ cmd: '800', status: 'ok', data: { FWVersion: '3.9.1', WebCommunication: 'Synchronous', WebSocketPort: '82' } })
const PROGRAM = 'G21 G90\nG0 Z5\nG0 X0 Y0\nG1 Z-1 F300\nG1 X10 Y0 F1000\nG1 X10 Y10\nG0 Z5\n'

// The SD card and the controller's answers. Tests replace pieces of `respond` per case.
let card: Map<string, string>
const listing = (dir: string) => JSON.stringify({
  path: dir, status: 'Ok', total: '7 GB', used: '1 MB', occupation: '1',
  files: [...card.keys()].filter((k) => k.startsWith(dir === '/' ? '/' : `${dir}/`)).map((k) => ({ name: k.slice(k.lastIndexOf('/') + 1), size: '1 KB' })),
})
async function controller(req: HttpRequest): Promise<HttpResponse> {
  if (req.path === '/command') {
    if (req.query?.cmd === '[ESP800]json=yes') return { status: 200, body: ESP800 }
    return { status: 200, body: 'ok' }
  }
  if (req.path === '/upload') {
    const dir = req.query?.path ?? (req.form?.find((f) => f[0] === 'path')?.[1] as string) ?? '/'
    if (req.method === 'POST') {
      // The file field is named by its FULL path on the card, as sdUploadForm sends it.
      const file = req.form!.find((f) => typeof f[1] !== 'string')!
      card.set(file[2]!, await (file[1] as Blob).text())
    } else if (req.query?.action === 'delete') {
      card.delete(`${dir === '/' ? '' : dir}/${req.query.filename}`)
    }
    return { status: 200, body: listing(dir) }
  }
  if (req.path.startsWith('/sd/')) {
    const text = card.get(decodeURIComponent(req.path.slice(3)))
    return text === undefined ? { status: 404, body: 'not found' } : { status: 200, body: text }
  }
  return { status: 404, body: '' }
}

type Store = typeof import('./machineStore')['useMachineStore']
let useMachineStore: Store
let workpiece: typeof import('../store/workpieceStore')['useWorkpieceStore']

const link = () => g.__link!
const flush = () => vi.advanceTimersByTimeAsync(0)
const store = () => useMachineStore.getState()

/** A status report arriving on the socket, as the controller's serial stream. */
function report(line: string) {
  link().handlers.onWsBinary!(new TextEncoder().encode(`${line}\n`).buffer as ArrayBuffer)
}

/** The commands sent since the last call, the background traffic (`?`, $Report, [ESP…]) left out. */
let seen = 0
function sent(): string[] {
  const cmds = link().calls.slice(seen)
    .filter((c) => c.path === '/command' && c.query?.cmd !== undefined)
    .map((c) => c.query!.cmd)
    .filter((c) => c !== '?' && !c.startsWith('$Report') && !c.startsWith('[ESP'))
  seen = link().calls.length
  return cmds
}

/** Connect, have the socket name our session, and report the machine Idle at `mpos` with offset `wco`. */
async function connect(mpos = '0.000,0.000,0.000', wco = '0.000,0.000,0.000') {
  const p = store().connect()
  await flush()
  await p
  link().handlers.onWsText!('CURRENTID:7')
  await flush()
  report(`<Idle|MPos:${mpos}|FS:0,0|WCO:${wco}>`)
  await flush()
  seen = link().calls.length
}

const zeroAll = async () => { store().zero(['x', 'y', 'z']); await flush(); sent() }

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  g.__link = null
  g.__openError = null
  g.__respond = controller
  card = new Map([['/a.nc', PROGRAM]])
  seen = 0
  // An empty localStorage per test: the store persists its settings, and under node with
  // none zustand warns on every set, which buries any real output.
  const mem = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
  })
  // A fresh module per test: the store keeps its session (and the zeros it may restore)
  // in module variables that would otherwise carry from one test to the next.
  useMachineStore = (await import('./machineStore')).useMachineStore
  workpiece = (await import('../store/workpieceStore')).useWorkpieceStore
  workpiece.setState({ safeHeightMM: 5, zOrigin: 'top' })
})

afterEach(() => {
  store().disconnect()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('connecting', () => {
  it('asks [ESP800] for the socket port, opens the socket there, and reads the SD card', async () => {
    const p = store().connect()
    await flush(); await p
    expect(link().calls[0].query).toEqual({ cmd: '[ESP800]json=yes' })
    expect(link().wsOpens[0][0]).toBe(82)
    expect(link().calls.some((c) => c.path === '/upload' && c.query?.action === 'list')).toBe(true)
    expect(store().sdListing?.files.map((f) => f.name)).toEqual(['a.nc'])
  })

  it('is connected only once the socket names the session, and every command then carries that PAGEID', async () => {
    const p = store().connect()
    await flush(); await p
    expect(store().link).toBe('connecting')
    link().handlers.onWsText!('CURRENTID:7')
    expect(store().link).toBe('connected')
    store().command('$X')
    await flush()
    expect(link().calls[link().calls.length - 1].query).toEqual({ cmd: '$X', PAGEID: '7' })
  })

  it('gives up, closing the relay, when [ESP800] names no socket', async () => {
    g.__respond = (req) => (req.query?.cmd === '[ESP800]json=yes' ? { status: 200, body: '{"status":"error"}' } : controller(req))
    const p = store().connect()
    await flush(); await p
    expect(store().link).toBe('disconnected')
    expect(store().error).toMatch(/did not name a WebSocket port/)
    expect(link().closed).toBe(true)
  })

  it('offers the relay setup when the relay never answers', async () => {
    const { RelaySetupError } = await import('./relayClient')
    g.__openError = new RelaySetupError('No answer from the relay')
    await store().connect()
    expect(store()).toMatchObject({ link: 'disconnected', relayMissing: true })
  })

  it('drops the connection when another WebUI session takes the controller over', async () => {
    await connect()
    link().handlers.onWsText!('ACTIVEID:9')
    expect(store().link).toBe('disconnected')
    expect(store().error).toMatch(/Another WebUI session/)
  })

  it('reads a status report split across two socket frames', async () => {
    await connect()
    const bytes = new TextEncoder().encode('<Run|MPos:1.000,2.000,3.000|FS:500,0>\n')
    link().handlers.onWsBinary!(bytes.slice(0, 9).buffer as ArrayBuffer)
    expect(store().position.state).toBe('Idle')
    link().handlers.onWsBinary!(bytes.slice(9).buffer as ArrayBuffer)
    expect(store().position).toMatchObject({ state: 'Run', mpos: [1, 2, 3] })
  })
})

describe('work zero', () => {
  it('zeroes in the active coordinate system and marks the axes zeroed', async () => {
    await connect()
    store().zero(['x', 'y'])
    await flush()
    expect(sent()).toEqual(['G10 L20 P0 X0 Y0'])
    expect(store().zeroed).toEqual({ x: true, y: true, z: false })
  })

  it('sends nothing and marks nothing while not connected', () => {
    store().zero(['x'])
    expect(store().zeroed.x).toBe(false)
  })

  it('clears every zero on an Alarm — steps may have been lost', async () => {
    await connect()
    await zeroAll()
    report('<Alarm|MPos:0.000,0.000,0.000|FS:0,0>')
    expect(store().zeroed).toEqual({ x: false, y: false, z: false })
  })

  it('clears every zero when the motors are released — the axes can be pushed by hand', async () => {
    await connect()
    await zeroAll()
    store().setMotors(false)
    await flush()
    expect(sent()).toEqual(['$MD'])
    expect(store().zeroed).toEqual({ x: false, y: false, z: false })
  })

  it('refuses $ME/$MD while a job runs — FluidNC takes them only Idle or in Alarm', async () => {
    await connect()
    report('<Run|MPos:0.000,0.000,0.000|FS:500,0>')
    store().setMotors(false)
    await flush()
    expect(sent()).toEqual([])
  })

  it('does not trust any zero after a disconnect', async () => {
    await connect()
    await zeroAll()
    store().disconnect()
    expect(store().zeroed).toEqual({ x: false, y: false, z: false })
  })
})

describe('jogging and Go to', () => {
  it('a jog with Z in it runs at the Z feed, an XY jog at the XY feed', async () => {
    await connect()
    store().jog({ x: 10 }); store().jog({ z: -1 }); await flush()
    expect(sent()).toEqual(['$J=G91 G21 X10 F1000', '$J=G91 G21 Z-1 F300'])
  })

  it('Go to lifts the tool to the safe height FIRST when it is below it, so it is not dragged through the stock', async () => {
    await connect()
    await zeroAll()
    report('<Idle|MPos:0.000,0.000,-2.000|FS:0,0>')
    await store().goTo(40, 30)
    expect(sent()).toEqual(['$J=G90 G21 Z5 F300', '$J=G90 G21 X40 Y30 F1000'])
  })

  it('Go to measures the safe height from the stock bottom when the Z origin is there', async () => {
    workpiece.setState({ zOrigin: 'bottom', thicknessMM: 19 })
    await connect()
    await zeroAll()
    await store().goTo(40, 30)
    expect(sent()).toEqual(['$J=G90 G21 Z24 F300', '$J=G90 G21 X40 Y30 F1000'])
  })

  it('Go to leaves Z alone when the tool is already above the safe height', async () => {
    await connect()
    await zeroAll()
    report('<Idle|MPos:0.000,0.000,20.000|FS:0,0>')
    await store().goTo(40, 30)
    expect(sent()).toEqual(['$J=G90 G21 X40 Y30 F1000'])
  })

  it('Go to does not lift without a Z zero — there is no knowing where the safe height is', async () => {
    await connect()
    store().zero(['x', 'y']); await flush(); sent()
    await store().goTo(40, 30)
    expect(sent()).toEqual(['$J=G90 G21 X40 Y30 F1000'])
  })

  it('Go to goes nowhere until X and Y are zeroed', async () => {
    await connect()
    await store().goTo(40, 30)
    expect(sent()).toEqual([])
  })

  it('Go to origin needs all three zeros and an Idle machine', async () => {
    await connect()
    store().zero(['x', 'y']); await flush(); sent()
    await store().goToOrigin()
    expect(sent()).toEqual([])
    store().zero(['z']); await flush(); sent()
    report('<Jog|MPos:0.000,0.000,0.000|FS:500,0>')
    await store().goToOrigin()
    expect(sent()).toEqual([])
  })

  it('Go to origin moves Z to the safe height, down as well as up, then to X0 Y0', async () => {
    await connect()
    await zeroAll()
    report('<Idle|MPos:0.000,0.000,30.000|FS:0,0>')
    await store().goToOrigin()
    expect(sent()).toEqual(['$J=G90 G21 Z5 F300', '$J=G90 G21 X0 Y0 F1000'])
  })
})

describe('homing', () => {
  it('a homing cycle that ends Idle asks for the axes to be zeroed — homing alone zeroes nothing', async () => {
    await connect()
    store().home()
    await flush()
    expect(sent()).toEqual(['$H'])
    report('<Home|MPos:0.000,0.000,0.000|FS:0,0>')
    report('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>')
    expect(store().zeroed).toEqual({ x: false, y: false, z: false })
    expect(store().log[store().log.length - 1]).toMatch(/now zero X, Y, Z/)
  })

  it('brings back a zero set on a homed axis when re-homing finds the controller\'s offset unchanged', async () => {
    await connect()
    store().home(); await flush()
    report('<Home|MPos:0.000,0.000,0.000|FS:0,0>')
    report('<Idle|MPos:10.000,20.000,-5.000|FS:0,0|WCO:0.000,0.000,0.000>')
    await zeroAll()       // G10 L20 makes the offset the machine position: 10, 20, -5
    store().disconnect()
    await connect('0.000,0.000,0.000', '10.000,20.000,-5.000')
    expect(store().zeroed).toEqual({ x: false, y: false, z: false })
    store().home(); await flush()
    report('<Home|MPos:0.000,0.000,0.000|FS:0,0>')
    report('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:10.000,20.000,-5.000>')
    expect(store().zeroed).toEqual({ x: true, y: true, z: true })
  })

  it('does not bring a zero back when the controller\'s offset has changed since', async () => {
    await connect()
    store().home(); await flush()
    report('<Home|MPos:0.000,0.000,0.000|FS:0,0>')
    report('<Idle|MPos:10.000,20.000,-5.000|FS:0,0|WCO:0.000,0.000,0.000>')
    await zeroAll()
    store().disconnect()
    await connect('0.000,0.000,0.000', '99.000,20.000,-5.000')
    store().home(); await flush()
    report('<Home|MPos:0.000,0.000,0.000|FS:0,0>')
    report('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:99.000,20.000,-5.000>')
    expect(store().zeroed).toEqual({ x: false, y: true, z: true })
  })

  it('STOP during homing soft-resets — homing ignores a feed hold', async () => {
    await connect()
    report('<Home|MPos:0.000,0.000,0.000|FS:0,0>')
    store().stopMotion(); await flush()
    expect(sent()).toEqual(['\x18'])
  })
})

describe('a machine without homing switches', () => {
  beforeEach(() => { useMachineStore.setState({ hasHoming: false }) })

  it('keeps its zeros across a reconnect when it comes back exactly where it was', async () => {
    await connect('12.000,34.000,-2.000', '12.000,34.000,-2.000')
    await zeroAll()
    store().disconnect()
    await connect('12.000,34.000,-2.000', '12.000,34.000,-2.000')
    expect(store().zeroed).toEqual({ x: true, y: true, z: true })
  })

  it('drops its zeros when it comes back anywhere else (a restart wakes at machine 0)', async () => {
    await connect('12.000,34.000,-2.000', '12.000,34.000,-2.000')
    await zeroAll()
    store().disconnect()
    await connect('0.000,0.000,0.000', '12.000,34.000,-2.000')
    expect(store().zeroed).toEqual({ x: false, y: false, z: false })
  })
})

describe('running a job', () => {
  async function loaded() {
    await connect()
    await store().sdLoad('a.nc')
    sent()
  }

  it('loading a file reads it off the card, previews it and shows it on the map', async () => {
    await loaded()
    expect(store().job).toMatchObject({ dir: '/', name: 'a.nc' })
    expect(store().job!.preview.segments).toBeGreaterThan(0)
    expect(store().mapSource).toBe('job')
  })

  it('runs the loaded file by its full path once X, Y and Z are zeroed', async () => {
    await loaded()
    await zeroAll()
    store().runJob(); await flush()
    expect(sent()).toEqual(['$SD/Run=/a.nc'])
  })

  it('will not run before all three axes are zeroed', async () => {
    await loaded()
    store().zero(['x', 'y']); await flush(); sent()
    store().runJob(); await flush()
    expect(sent()).toEqual([])
  })

  it('will not run a job hidden behind the design on the map', async () => {
    await loaded()
    await zeroAll()
    store().showDesign()
    store().runJob(); await flush()
    expect(sent()).toEqual([])
  })

  it('will not run while the card is busy — the file may still be the one being replaced', async () => {
    await loaded()
    await zeroAll()
    useMachineStore.setState({ sdBusy: 'Loading b.nc…' })
    store().runJob(); await flush()
    expect(sent()).toEqual([])
  })

  it('will not run unless the machine is Idle', async () => {
    await loaded()
    await zeroAll()
    report('<Jog|MPos:0.000,0.000,0.000|FS:500,0>')
    store().runJob(); await flush()
    expect(sent()).toEqual([])
  })
})

describe('stopping and cancelling', () => {
  it('STOP is a feed hold while running — decelerates and keeps position, no alarm', async () => {
    await connect()
    report('<Run|MPos:0.000,0.000,0.000|FS:500,0>')
    store().stopMotion(); await flush()
    expect(sent()).toEqual(['!'])
  })

  it('Cancel does nothing while the hold is still decelerating (Hold:1), where a reset would alarm', async () => {
    await connect()
    report('<Hold:1|MPos:0.000,0.000,0.000|FS:0,0>')
    store().cancelJob(); await flush()
    expect(sent()).toEqual([])
  })

  it('Cancel at Hold:0 resets, then lifts the tool to the safe height once Idle', async () => {
    await connect()
    await zeroAll()
    report('<Hold:0|MPos:0.000,0.000,-3.000|FS:0,0|WCO:0.000,0.000,0.000>')
    store().cancelJob(); await flush()
    expect(sent()).toEqual(['\x18'])
    report('<Idle|MPos:0.000,0.000,-3.000|FS:0,0>')
    await flush()
    expect(sent()).toEqual(['$J=G90 G21 Z5 F300'])
  })

  it('a Cancel that ends in Alarm does not lift', async () => {
    await connect()
    await zeroAll()
    report('<Hold:0|MPos:0.000,0.000,-3.000|FS:0,0|WCO:0.000,0.000,0.000>')
    store().cancelJob(); await flush(); sent()
    report('<Alarm|MPos:0.000,0.000,-3.000|FS:0,0>')
    await flush()
    expect(sent()).toEqual([])
  })
})

describe('overrides', () => {
  it('a 5 % step goes to the next multiple of 5, in 1 % bytes', async () => {
    await connect()
    report('<Idle|MPos:0.000,0.000,0.000|FS:0,0|Ov:103,100,100>')
    await store().overrideStep5('feed', 1)
    expect(sent()).toEqual(Array(2).fill('\x93'))      // 103 → 105
  })

  it('a second press before the controller reports the first builds on where the first was heading', async () => {
    await connect()
    report('<Idle|MPos:0.000,0.000,0.000|FS:0,0|Ov:103,100,100>')
    await store().overrideStep5('feed', 1); sent()
    await store().overrideStep5('feed', 1)             // the report still says 103 %
    expect(sent()).toEqual(Array(5).fill('\x93'))      // 105 → 110, not 103 → 105 again
  })
})

describe('the SD card', () => {
  it('a failed load says why and keeps the job that was loaded', async () => {
    await connect()
    await store().sdLoad('a.nc')
    await store().sdLoad('missing.nc')
    expect(store().sdError).toMatch(/Could not read missing.nc: HTTP 404/)
    expect(store().job?.name).toBe('a.nc')
  })

  it('deleting the loaded job unloads it and puts the design back on the map', async () => {
    await connect()
    await store().sdLoad('a.nc')
    await store().sdDelete('a.nc')
    expect(store().job).toBeNull()
    expect(store().mapSource).toBe('design')
    expect(store().sdListing?.files).toEqual([])
  })

  it('uploading over the loaded job replaces its preview with the new contents', async () => {
    await connect()
    await store().sdLoad('a.nc')
    const before = store().job!.preview.segments
    await store().sdUpload(new File([`${PROGRAM}G1 X0 Y10\nG1 X0 Y0\n`], 'a.nc'))
    expect(store().job!.preview.segments).toBeGreaterThan(before)
    expect(card.get('/a.nc')).toContain('G1 X0 Y10')
  })

  it('an upload lands in the folder shown and lists it', async () => {
    await connect()
    await store().sdUpload(new File(['G0 X0\n'], 'b.nc'))
    expect(store().sdListing?.files.map((f) => f.name)).toEqual(['a.nc', 'b.nc'])
    expect(store().sdBusy).toBeNull()
  })

  it('sending the design with no toolpaths says so and uploads nothing', async () => {
    await connect()
    await store().sendDesignToCard()
    expect(store().sdError).toMatch(/no toolpaths/)
    expect(link().calls.some((c) => c.method === 'POST')).toBe(false)
  })
})

describe('a dropped socket', () => {
  it('reopens the socket after a pause, keeping the relay window', async () => {
    await connect()
    link().handlers.onWsState!('closed', 1006)
    expect(store().link).toBe('connecting')
    await vi.advanceTimersByTimeAsync(2000)
    expect(link().wsOpens).toHaveLength(2)
    link().handlers.onWsText!('CURRENTID:8')
    expect(store().link).toBe('connected')
  })

  it('gives up after four reconnects', async () => {
    await connect()
    for (let i = 0; i < 5; i++) {
      link().handlers.onWsState!('closed', 1006)
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(store().link).toBe('disconnected')
    expect(store().error).toMatch(/gave up after 4 reconnects/)
  })

  it('keeps the zeros when the machine reports itself where it was', async () => {
    await connect('5.000,5.000,0.000', '5.000,5.000,0.000')
    await zeroAll()
    link().handlers.onWsState!('closed', 1006)
    await vi.advanceTimersByTimeAsync(2000)
    link().handlers.onWsText!('CURRENTID:8')
    report('<Idle|MPos:5.000,5.000,0.000|FS:0,0>')
    expect(store().zeroed).toEqual({ x: true, y: true, z: true })
  })

  it('drops the zeros when the idle machine moved while the socket was down', async () => {
    await connect('5.000,5.000,0.000', '5.000,5.000,0.000')
    await zeroAll()
    link().handlers.onWsState!('closed', 1006)
    await vi.advanceTimersByTimeAsync(2000)
    link().handlers.onWsText!('CURRENTID:8')
    report('<Idle|MPos:0.000,0.000,0.000|FS:0,0>')
    expect(store().zeroed).toEqual({ x: false, y: false, z: false })
  })

  it('reconnects when the socket has carried nothing for 12 s — a half-open connection the browser has not noticed', async () => {
    await connect()
    await vi.advanceTimersByTimeAsync(15000)
    expect(store().link).toBe('connecting')
    expect(store().log.some((l) => /silent/.test(l))).toBe(true)
  })

    it('reconnects when the controller says the socket a command named is dead', async () => {
    await connect()
    g.__respond = (req) => (req.query?.cmd === '$X' ? { status: 500, body: 'WebSocket dead' } : controller(req))
    store().command('$X'); await flush()
    expect(store().link).toBe('connecting')
  })
})

describe('status polling', () => {
  const polls = () => link().calls.filter((c) => c.query?.cmd === '?').length

  it('polls `?` when the controller never confirmed auto-reporting', async () => {
    await connect()
    await vi.advanceTimersByTimeAsync(1500)
    expect(polls()).toBeGreaterThan(0)
  })

  it('stays quiet while Idle once auto-reporting is confirmed — an idle machine reports only changes', async () => {
    await connect()
    report('[MSG: Auto report interval set to 200 ms]')
    await vi.advanceTimersByTimeAsync(3000)
    expect(polls()).toBe(0)
  })

  it('polls an unsettled hold even with auto-reporting — Hold:1 → Hold:0 changes no state, so nothing is pushed', async () => {
    await connect()
    report('[MSG: Auto report interval set to 200 ms]')
    report('<Hold:1|MPos:0.000,0.000,0.000|FS:0,0>')
    await vi.advanceTimersByTimeAsync(1000)
    expect(polls()).toBeGreaterThan(0)
  })
})
