// Machine connection state, and the FluidNC session that feeds it.
//
// The session over the relay (relayClient.ts):
//   1. open the relay popup on the controller
//   2. `[ESP800]json=yes` over HTTP → which port the WebSocket is on
//   3. open the WebSocket; the controller's first text frame is `CURRENTID:<id>`,
//      which goes on every command as PAGEID so the REPLY comes back on OUR socket
//   4. commands are `GET /command?cmd=…&PAGEID=…`; their output arrives as binary
//      WebSocket frames (the controller's serial stream), never in the HTTP body
//   5. `ACTIVEID:<other>` means another WebUI session took over — we are dropped
//
// Status: ask the controller to push reports (`$Report/Interval`), and fall back to
// polling `?` whenever none has arrived for a moment — that covers firmware that
// ignores the setting without double-polling firmware that honours it.
//
// Positions are mm, as the controller reports them (FreazyKam never puts the
// controller in G20 reporting); the panel converts for display.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { RelayLink, RelaySetupError, RELAY_CLOSED, type WsState } from './relayClient'
import { useUIStore } from '../store/uiStore'
import { parseEsp800, parseEsp420Wifi, wsSessionPath, type ControllerInfo, type WifiStatus } from './fluidnc/esp800'
import { parseStatus, applyStatus, holdComplete, EMPTY_POSITION, type Position } from './fluidnc/status'
import { jogCommand, JOG_CANCEL, zeroCommand, goToCommands, homeCommand, zMoveCommand, OVERRIDE, type OverrideStep, type JogMove, type Axis } from './fluidnc/jog'
import { useWorkpieceStore, zDatumOffsetMM } from '../store/workpieceStore'
import { parseSdListing, sdDownloadPath, sdJoin, sdRunCommand, sdUploadForm, type SdListing } from './fluidnc/sdFiles'
import { jobPreview, type JobPreview } from './jobPreview'
import { buildGcodeInputs } from '../io/gcodeExport'
import { generateGcode } from '../cam/gcode'
import { asciiFileName } from '../io/filename'
import { useProjectStore } from '../store/projectStore'

export type LinkState = 'disconnected' | 'connecting' | 'connected'

const LOG_MAX = 300
const REPORT_INTERVAL_MS = 200
// FluidNC's auto-report (Channel.cpp autoReport) sends at the interval only while
// MOVING; idle, it sends a report only when something changes (state, WCO,
// overrides). So silence from an idle machine is normal and must not be read as a
// stale DRO. Once the controller confirms auto-reporting, FreazyKam stops polling
// `?` altogether — it used to poll four times a second for as long as the machine
// sat idle, an HTTP request every 250 ms against an ESP32 that is also serving WiFi.
// Firmware that never confirms gets the slow fallback poll below instead.
const AUTO_REPORT_CONFIRMED = /auto report interval set to \d+/i
const POLL_STALE_MOVING_MS = 400
const POLL_STALE_IDLE_MS = 1000
// The keep-alive PING is answered by the controller, so a socket that has carried
// nothing for this long is dead even if the browser has not noticed (a half-open
// TCP connection can take minutes to report 1006).
const SILENT_SOCKET_MS = 12000
// A socket that opens but never names our session: carry on without a PAGEID.
const SESSION_ID_WAIT_MS = 2000
// As WebUI 3 does (Services/WebSocketService.ts): a `PING:<session>` text frame every
// 5 s keeps the socket busy in both directions, and a dropped socket is reopened up
// to 4 times, 2 s apart, before the connection is given up. FluidNC drops sockets
// for reasons the browser cannot prevent — WiFi hiccups (close 1006), and its own
// cap of 4 WebSocket clients, evicting the OLDEST every 10 s (WebUIServer.cpp
// cleanupClients). The relay window stays open throughout; only the socket is redone.
const KEEPALIVE_MS = 5000
const RECONNECT_TRIES = 4
const RECONNECT_DELAY_MS = 2000
// A reopened socket that has neither connected nor failed by now counts as a failed
// attempt: a browser can wait a long time on a host that does not answer, and the
// reconnect sat at "1/4" for as long as it did.
const RECONNECT_ATTEMPT_MS = 8000
// A command the controller has not answered by now gets an error line, not a hang.
const COMMAND_TIMEOUT_MS = 5000
// The controller's WiFi signal, read with [ESP420] (it answers in the HTTP body, no
// socket needed). Every 30 s is plenty for a number that changes when something is
// moved, and it is skipped while the machine moves, to keep traffic off the
// controller mid-cut.
const WIFI_POLL_MS = 30000

interface MachineState {
  address: string
  link: LinkState
  error: string | null
  // The last Connect got no answer from the relay — most likely it is not on the
  // controller yet, so the panel offers the setup instructions with the error.
  relayMissing: boolean
  info: ControllerInfo | null
  // The controller's WiFi link, from the last [ESP420]; null on Ethernet, in AP
  // mode, or before the first reading.
  wifi: WifiStatus | null
  position: Position
  log: string[]
  // Jog settings, kept between sessions. The step is an INDEX into JOG_STEPS_MM
  // for the current units, so flipping mm/in lands on the matching row (10 mm ↔
  // 0.1") rather than on an odd converted number. Feeds are mm/min.
  jogStepIndex: number
  jogFeedXY: number
  jogFeedZ: number
  // Which axes the user has zeroed from this panel. Not persisted, and not cleared
  // on reconnect: the work offset lives on the controller, but only a zero set
  // since FreazyKam loaded is one we know matches the stock on the canvas.
  zeroed: Record<Axis, boolean>
  // Whether this machine has homing switches. Kept between sessions; off hides the
  // Home buttons, since on a machine without switches $H only ever answers error:5.
  hasHoming: boolean
  // The last $ME / $MD sent this session — NOT the motors' actual state, which no
  // status report carries: any move re-enables them, and FluidNC's stepping
  // idle_ms can disable them on its own. Null until one is pressed.
  motorsCommanded: 'enabled' | 'disabled' | null
  // The SD card: the directory shown, its listing, and what the card is busy doing
  // (a status line, e.g. "Uploading a.nc 40%"); null when idle.
  sdPath: string
  sdListing: SdListing | null
  sdBusy: string | null
  sdError: string | null
  // The file loaded to be cut: where it is on the card, and its toolpath for the map.
  job: { dir: string; name: string; preview: JobPreview } | null
  // What the go-to map draws: the design open in FreazyKam, or the loaded job. A
  // loaded job stays loaded while the design is shown, so switching back is instant.
  mapSource: 'design' | 'job'

  setAddress: (a: string) => void
  connect: () => Promise<void>
  disconnect: () => void
  command: (cmd: string) => void
  clearLog: () => void
  setJogStepIndex: (i: number) => void
  setJogFeedXY: (mmPerMin: number) => void
  setJogFeedZ: (mmPerMin: number) => void
  /** Relative jog, mm. A move with Z in it runs at the Z feed. */
  jog: (move: JogMove) => void
  jogCancel: () => void
  /** Make the current position the work zero on these axes (active coordinate system). */
  zero: (axes: Axis[]) => void
  setHasHoming: (v: boolean) => void
  /** Home every axis (the configured cycle), or just one. */
  home: (axis?: Axis) => void
  /** `$ME` / `$MD`. FluidNC accepts them only when Idle or in Alarm. */
  setMotors: (enabled: boolean) => void
  /** Step the feed or spindle override (realtime: takes effect mid-move). */
  override: (kind: 'feed' | 'spindle', step: OverrideStep) => void
  rapidOverride: (pct: 100 | 50 | 25) => void
  /**
   * Jog to work position (x, y), mm. When Z has been zeroed and the tool is below
   * the safe height, it is raised to the safe height first.
   */
  goTo: (x: number, y: number) => Promise<void>
  /**
   * Z to the safe height (up OR down — it is a height above the stock either way),
   * then X0 Y0. Needs all three axes zeroed: without a Z zero there is no knowing
   * where the safe height is.
   */
  goToOrigin: () => Promise<void>

  sdRefresh: (path?: string) => Promise<void>
  sdUpload: (file: File) => Promise<void>
  sdDelete: (name: string) => Promise<void>
  /** Download a file from the card and preview its toolpath; it becomes the job to run. */
  sdLoad: (name: string) => Promise<void>
  unloadJob: () => void
  showDesign: () => void
  /**
   * Write the design's G-code to the card as `<project>.nc` in the folder shown,
   * and load it — the step between designing a job and running it.
   */
  sendDesignToCard: () => Promise<void>
  /** `$SD/Run=` the loaded job. */
  runJob: () => void
  feedHold: () => void
  /**
   * The panel's STOP: stop whatever is moving, the gentlest way that works for it.
   * A feed hold for a jog (Grbl 1.1 turns a hold during a jog into a jog cancel)
   * and for a running program (decelerates and holds — no alarm, position kept,
   * then Resume or Cancel). Homing ignores a hold, so a homing cycle is reset.
   */
  stopMotion: () => void
  resume: () => void
  /** Soft reset (Ctrl-X): stops everything at once, the running job included. */
  softReset: () => void
  /**
   * Abandon a paused job without an alarm: the same reset, but sent only once the
   * hold has come to a complete stop (Hold:0). Does nothing at any other time.
   */
  cancelJob: () => void
}

const fmtDuration = (ms: number) => {
  const sec = Math.round(ms / 1000)
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
}

// The live session is not state anyone renders — keep it out of the store.
let link: RelayLink | null = null
let sessionId = ''
let lastStatusAt = 0
let statusTimer: ReturnType<typeof setInterval> | undefined
let lineBuf = ''
// The axes of the homing cycle in progress, marked zeroed when it ends in Idle.
let homingAxes: Axis[] | null = null
// Set by Cancel job: once the reset lands and the machine reports Idle, lift the
// tool out of the cut to the safe height.
let liftAfterCancel = false
let decoder = new TextDecoder()
let keepAliveTimer: ReturnType<typeof setInterval> | undefined
let autoReport = false      // the controller confirmed $Report/Interval on this socket
let lastRxAt = 0            // last frame of any kind on the socket
let reconnectTries = 0
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let attemptTimer: ReturnType<typeof setTimeout> | undefined
let upSince = 0             // when the socket last came up, for the drop log
let wifiTimer: ReturnType<typeof setInterval> | undefined

export const useMachineStore = create<MachineState>()(
  persist(
    (set, get) => {
      const log = (line: string) =>
        set((s) => ({ log: s.log.length >= LOG_MAX ? [...s.log.slice(-LOG_MAX + 1), line] : [...s.log, line] }))

      // Resolves once the controller has taken the line, so a caller that awaits
      // one send before the next gets them queued in order.
      const send = async (cmd: string, echo: boolean): Promise<void> => {
        if (!link?.isOpen) return
        if (echo) log(`> ${cmd}`)
        const query: Record<string, string> = { cmd }
        if (sessionId) query.PAGEID = sessionId
        await link.http({ path: '/command', query, timeoutMs: COMMAND_TIMEOUT_MS }).then((r) => {
          // Cut short by our own Disconnect: not news.
          if (r.status === 0 && r.body === RELAY_CLOSED) return
          if (r.status === 0 && r.body === 'timeout') {
            if (echo) log(`! no answer from the controller: ${cmd}`)
            return
          }
          // The controller no longer has the socket our PAGEID names: it dropped it
          // (WSChannel.cpp closes a socket whose send queue stalls > 250 ms — slow
          // WiFi, or the ESP32 busy streaming a file). The browser may not notice for
          // a long while, so reconnect now rather than keep sending into nothing.
          if (r.status === 500 && /WebSocket dead/i.test(r.body)) {
            if (get().link === 'connected') socketLost('dropped by the controller')
            else if (echo) log(`! not sent while reconnecting: ${cmd}`)
            return
          }
          if (r.status !== 200) log(`! HTTP ${r.status} ${r.body}`)
          else if (r.body.trim() && r.body.trim() !== 'ok') r.body.trim().split('\n').forEach((l) => log(l))
        })
      }

      // Whether the folder shown lists this file — how an upload is known to have landed.
      const onCard = (name: string) => !!get().sdListing?.files.some((f) => !f.isDir && f.name === name)

      // Every SD action answers with the directory's new listing.
      const takeListing = (status: number, body: string, dir: string) => {
        const listing = status === 200 ? parseSdListing(body) : null
        if (listing) set({ sdListing: listing, sdPath: listing.path || dir, sdBusy: null })
        else set({ sdBusy: null, sdError: status === 200 ? `The card did not answer with a listing: ${body.slice(0, 80)}` : `SD: HTTP ${status} ${body.slice(0, 80)}` })
      }

      // The relay window's title carries the machine state (Idle, Run, Hold:0, Alarm),
      // so its title bar says what the machine is doing. Sent only when the state
      // changes, not on every report.
      const showStateInTitle = (p: Position) => link?.setTitle(p.subState ? `${p.state}:${p.subState}` : p.state)

      const teardown = (error: string | null) => {
        liftAfterCancel = false
        if (keepAliveTimer) clearInterval(keepAliveTimer)
        keepAliveTimer = undefined
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        if (attemptTimer) clearTimeout(attemptTimer)
        attemptTimer = undefined
        if (wifiTimer) clearInterval(wifiTimer)
        wifiTimer = undefined
        reconnectTries = 0
        if (statusTimer) clearInterval(statusTimer)
        statusTimer = undefined
        link = null
        sessionId = ''
        set({ link: 'disconnected', error, wifi: null })
      }

      const readWifi = async () => {
        if (!link?.isOpen || ['Run', 'Jog', 'Home'].includes(get().position.state)) return
        const r = await link.http({ path: '/command', query: { plain: '[ESP420]json=yes' }, timeoutMs: COMMAND_TIMEOUT_MS })
        if (r.status !== 200) return
        const wifi = parseEsp420Wifi(r.body)
        if (wifi) set({ wifi })
      }

      // Up only: a tool already above the safe height stays where it is. Without a Z
      // zero there is no knowing where the safe height is, so nothing moves.
      const liftOutOfCut = (p: Position) => {
        const { zeroed, jogFeedZ } = get()
        if (!zeroed.z) { log('Job cancelled — Z is not zeroed, so not lifting; jog Z clear by hand'); return }
        const safeZ = safeWorkZ()
        if (p.wpos[2] >= safeZ - 1e-3) return
        const cmd = zMoveCommand(safeZ, jogFeedZ)
        if (cmd) void send(cmd, true)
      }

      const onLine = (line: string) => {
        if (AUTO_REPORT_CONFIRMED.test(line)) autoReport = true
        const r = parseStatus(line)
        if (r) {
          lastStatusAt = Date.now()
          const prev = get().position
          const next = applyStatus(prev, r)
          set({ position: next })
          // A completed homing cycle puts the machine back on its stored work
          // offset, so the work position means something again: count those axes as
          // zeroed. One that ends in Alarm (a switch not found) does not count.
          if (homingAxes && prev.state === 'Home' && next.state !== 'Home') {
            if (next.state === 'Idle') {
              const zeroed = { ...get().zeroed }
              for (const a of homingAxes) zeroed[a] = true
              set({ zeroed })
            }
            homingAxes = null
          }
          if (liftAfterCancel && next.state !== prev.state && (next.state === 'Idle' || next.state === 'Alarm')) {
            liftAfterCancel = false
            if (next.state === 'Idle') liftOutOfCut(next)
            else log('Cancel ended in Alarm — not lifting Z; check the machine, Unlock, then jog clear')
          }
          if (next.state !== prev.state || next.subState !== prev.subState) showStateInTitle(next)
          return
        }
        log(line)
      }

      const onWsBinary = (data: ArrayBuffer) => {
        lastRxAt = Date.now()
        lineBuf += decoder.decode(data, { stream: true })
        let i
        while ((i = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, i).replace(/\r$/, '')
          lineBuf = lineBuf.slice(i + 1)
          if (line) onLine(line)
        }
      }

      // The socket is up and has named our session (or never will): live again.
      const onSocketReady = () => {
        if (attemptTimer) clearTimeout(attemptTimer)
        attemptTimer = undefined
        if (reconnectTries) log(`Reconnected (attempt ${reconnectTries})`)
        reconnectTries = 0
        upSince = Date.now()
        void readWifi()
        if (!wifiTimer) wifiTimer = setInterval(() => void readWifi(), WIFI_POLL_MS)
        autoReport = false
        lastRxAt = Date.now()
        set({ link: 'connected', error: null })
        // Report intervals are per channel, so a new socket needs asking again. The
        // controller answers with a full status report and the confirmation line.
        void send(`$Report/Interval=${REPORT_INTERVAL_MS}`, false)
        if (!keepAliveTimer) {
          keepAliveTimer = setInterval(() => {
            if (get().link !== 'connected') return
            if (Date.now() - lastRxAt > SILENT_SOCKET_MS) { socketLost('silent — no reply to the keep-alive'); return }
            link?.wsSend(`PING:${sessionId || 'none'}`)
          }, KEEPALIVE_MS)
        }
      }

      // Reopen the socket (the relay window stays), up to RECONNECT_TRIES times; then
      // give up. Only a socket that WAS up is retried: one that never opened means
      // the controller is unreachable, and retrying would only delay saying so.
      const socketLost = (why: string) => {
        const info = get().info
        const wasUp = get().link === 'connected' || reconnectTries > 0
        if (attemptTimer) clearTimeout(attemptTimer)
        attemptTimer = undefined
        // How long it had been up says whether drops come on a rhythm or at random.
        const upFor = get().link === 'connected' && upSince ? ` after ${fmtDuration(Date.now() - upSince)}` : ''
        if (link?.isOpen && info && wasUp && reconnectTries < RECONNECT_TRIES) {
          reconnectTries++
          sessionId = ''
          log(`Controller connection ${why}${upFor} — reconnecting (${reconnectTries}/${RECONNECT_TRIES})`)
          set({ link: 'connecting', error: `Connection ${why} — reconnecting (${reconnectTries}/${RECONNECT_TRIES})…` })
          if (reconnectTimer) clearTimeout(reconnectTimer)
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined
            // Opening a new socket also closes the old one, half-open or not.
            if (!link?.isOpen) return
            link.wsOpen(info.wsPort, wsSessionPath(info.wsPath), info.wsProtocol)
            attemptTimer = setTimeout(() => {
              attemptTimer = undefined
              if (get().link === 'connecting') socketLost('did not reopen')
            }, RECONNECT_ATTEMPT_MS)
          }, RECONNECT_DELAY_MS)
          return
        }
        link?.close()
        teardown(`Controller connection ${why}${reconnectTries ? ` — gave up after ${reconnectTries} reconnects` : ''}`)
      }

      // FluidNC ends some control frames with a newline ("PING\n").
      const onWsText = (raw: string) => {
        lastRxAt = Date.now()
        const text = raw.trim()
        const [kind, arg] = text.split(':')
        switch (kind.toUpperCase()) {
          case 'CURRENTID':
            sessionId = arg
            onSocketReady()
            break
          case 'ACTIVEID':
            if (arg && arg !== sessionId) {
              link?.close()
              teardown('Another WebUI session took over the controller')
            }
            break
          case 'PING':
          case 'CURRENT_ID':   // the WebUI 2 spelling, sent alongside currentID
          case 'ACTIVE_ID':
            break
          default:
            log(text)
        }
      }

      const onWsState = (state: WsState, code?: number) => {
        if (state === 'open') {
          setTimeout(() => {
            if (get().link === 'connecting' && link) onSocketReady()
          }, SESSION_ID_WAIT_MS)
          return
        }
        // A browser always follows a socket 'error' with 'close', so act on the close
        // alone — handling both counted every drop as two reconnect attempts.
        if (state === 'closed') {
          if (get().link === 'disconnected') return
          socketLost(`closed${code ? ` (${code})` : ''}`)
        }
      }

      return {
        address: 'fluidnc.local',
        link: 'disconnected',
        error: null,
        relayMissing: false,
        info: null,
        wifi: null,
        position: EMPTY_POSITION,
        log: [],
        jogStepIndex: 2,
        jogFeedXY: 1000,
        jogFeedZ: 300,
        zeroed: { x: false, y: false, z: false },
        hasHoming: true,
        motorsCommanded: null,
        sdPath: '/',
        sdListing: null,
        sdBusy: null,
        sdError: null,
        job: null,
        mapSource: 'design',

        setAddress: (address) => set({ address }),
        clearLog: () => set({ log: [] }),

        connect: async () => {
          if (link) return
          set({ link: 'connecting', error: null, relayMissing: false, info: null, position: EMPTY_POSITION })
          lineBuf = ''
          decoder = new TextDecoder()
          let l: RelayLink
          try {
            l = new RelayLink(get().address, {
              onWsState, onWsText, onWsBinary,
              onClosed: () => { if (link === l) teardown('The relay window was closed') },
            })
          } catch {
            teardown(`"${get().address}" is not a valid address`)
            return
          }
          link = l
          try {
            await l.open()   // first await: the popup is opened inside the click
          } catch (e) {
            teardown((e as Error).message)
            if (e instanceof RelaySetupError) set({ relayMissing: true })
            return
          }
          l.setTheme(useUIStore.getState().darkMode)
          const r = await l.http({ path: '/command', query: { cmd: '[ESP800]json=yes' } })
          const info = r.status === 200 ? parseEsp800(r.body) : null
          if (!info) {
            l.close()
            teardown(r.status === 200
              ? `The controller's [ESP800] reply did not name a WebSocket port: ${r.body.slice(0, 120)}`
              : `[ESP800] failed: HTTP ${r.status} ${r.body}`)
            return
          }
          set({ info })
          l.wsOpen(info.wsPort, wsSessionPath(info.wsPath), info.wsProtocol)
          void get().sdRefresh()
          // 'connected' is set on CURRENTID; from then on keep the DRO fed.
          lastStatusAt = 0
          // Polls `?` in two cases. (1) Firmware that never confirms auto-reporting.
          // (2) An UNSETTLED HOLD, whatever the firmware: auto-report pushes only on a
          // state change (System.cpp set_state → notifyState), and a hold coming to a
          // stop changes no state — it sets suspend.holdComplete, which Report.cpp
          // shows as Hold:1 → Hold:0. Unpolled, the panel sat at "Hold:1" for good and
          // Cancel never unlocked. Door:N settles the same way.
          statusTimer = setInterval(() => {
            if (get().link !== 'connected') return
            const { state, subState } = get().position
            const settling = (state === 'Hold' || state === 'Door') && subState !== '0'
            if (settling) {
              if (Date.now() - lastStatusAt > POLL_STALE_MOVING_MS) void send('?', false)
              return
            }
            if (autoReport) return
            const moving = ['Run', 'Jog', 'Home'].includes(state)
            if (Date.now() - lastStatusAt > (moving ? POLL_STALE_MOVING_MS : POLL_STALE_IDLE_MS)) void send('?', false)
          }, 250)
        },

        disconnect: () => {
          link?.close()
          teardown(null)
        },

        command: (cmd) => void send(cmd, true),

        setJogStepIndex: (jogStepIndex) => set({ jogStepIndex }),
        setJogFeedXY: (jogFeedXY) => set({ jogFeedXY }),
        setJogFeedZ: (jogFeedZ) => set({ jogFeedZ }),
        jog: (move) => {
          const { jogFeedXY, jogFeedZ } = get()
          const cmd = jogCommand(move, move.z ? jogFeedZ : jogFeedXY)
          if (cmd) void send(cmd, true)
        },
        // A realtime byte: acted on at once, not queued behind the jogs it stops.
        // Above 0x7F it travels in the URL as UTF-8, as WebUI 3 sends it.
        jogCancel: () => void send(JOG_CANCEL, false),

        zero: (axes) => {
          const cmd = zeroCommand(axes)
          if (!cmd || get().link !== 'connected') return
          void send(cmd, true)
          const zeroed = { ...get().zeroed }
          for (const a of axes) zeroed[a] = true
          set({ zeroed })
        },

        goToOrigin: async () => {
          const { zeroed, position, jogFeedXY, jogFeedZ } = get()
          if (!zeroed.x || !zeroed.y || !zeroed.z || position.state !== 'Idle') return
          for (const cmd of goToCommands(0, 0, jogFeedXY, { z: safeWorkZ(), feedZ: jogFeedZ })) await send(cmd, true)
        },

        setHasHoming: (hasHoming) => set({ hasHoming }),
        home: (axis) => {
          if (get().link !== 'connected') return
          homingAxes = axis ? [axis] : ['x', 'y', 'z']
          void send(homeCommand(axis), true)
        },

        setMotors: (enabled) => {
          const st = get().position.state
          if (get().link !== 'connected' || (st !== 'Idle' && st !== 'Alarm')) return
          void send(enabled ? '$ME' : '$MD', true)
          set({ motorsCommanded: enabled ? 'enabled' : 'disabled' })
        },

        override: (kind, step) => void send(OVERRIDE[kind][step], false),
        rapidOverride: (pct) => void send(OVERRIDE.rapid[pct], false),

        goTo: async (x, y) => {
          const { zeroed, position, jogFeedXY, jogFeedZ } = get()
          if (!zeroed.x || !zeroed.y) return
          const safeZ = safeWorkZ()
          const lift = zeroed.z && position.wpos[2] < safeZ - 1e-3 ? { z: safeZ, feedZ: jogFeedZ } : undefined
          for (const cmd of goToCommands(x, y, jogFeedXY, lift)) await send(cmd, true)
        },

        sdRefresh: async (path) => {
          const dir = path ?? get().sdPath
          if (!link?.isOpen) return
          set({ sdBusy: 'Reading the card…', sdError: null })
          const r = await link.http({ path: '/upload', query: { path: dir, action: 'list' } })
          takeListing(r.status, r.body, dir)
        },

        sdUpload: async (file) => {
          if (!link?.isOpen) return
          const dir = get().sdPath
          set({ sdBusy: `Uploading ${file.name}…`, sdError: null })
          const r = await link.http({
            method: 'POST', path: '/upload',
            form: sdUploadForm(dir, file, file.name, new Date(file.lastModified)),
            onProgress: (loaded, total) => {
              if (total > 0) set({ sdBusy: `Uploading ${file.name} ${Math.round((100 * loaded) / total)}%` })
            },
          })
          log(`SD: uploaded ${sdJoin(dir, file.name)} (${r.status === 200 ? 'ok' : `HTTP ${r.status}`})`)
          takeListing(r.status, r.body, dir)
          // Overwriting the loaded job: its preview is now of a file that no longer
          // exists, so load the new contents (already in hand, no read back needed).
          const job = get().job
          if (job && job.dir === dir && job.name === file.name && onCard(file.name)) {
            set({ job: { dir, name: file.name, preview: jobPreview(await file.text()) } })
          }
        },

        sdDelete: async (name) => {
          if (!link?.isOpen) return
          const dir = get().sdPath
          set({ sdBusy: `Deleting ${name}…`, sdError: null })
          const r = await link.http({ path: '/upload', query: { path: dir, action: 'delete', filename: name } })
          log(`SD: deleted ${sdJoin(dir, name)} (${r.status === 200 ? 'ok' : `HTTP ${r.status}`})`)
          const job = get().job
          if (job && job.dir === dir && job.name === name) set({ job: null, mapSource: 'design' })
          takeListing(r.status, r.body, dir)
        },

        sdLoad: async (name) => {
          if (!link?.isOpen) return
          const dir = get().sdPath
          set({ sdBusy: `Loading ${name}…`, sdError: null })
          // A download reports no progress, and a big program over weak WiFi is slow.
          const r = await link.http({ path: sdDownloadPath(dir, name), timeoutMs: 120000 })
          if (r.status !== 200) {
            set({ sdBusy: null, sdError: r.status === 0 && r.body === 'timeout'
              ? `Could not read ${name}: the controller stopped answering`
              : `Could not read ${name}: HTTP ${r.status} ${r.body.slice(0, 80)}` })
            return
          }
          const preview = jobPreview(r.body)
          set({ sdBusy: null, job: { dir, name, preview }, mapSource: 'job' })
          log(`SD: loaded ${sdJoin(dir, name)} — ${preview.segments} moves`)
        },

        unloadJob: () => set({ job: null, mapSource: 'design' }),
        showDesign: () => set({ mapSource: 'design' }),

        sendDesignToCard: async () => {
          if (!link?.isOpen) return
          const dir = get().sdPath
          set({ sdBusy: 'Generating G-code…', sdError: null })
          const project = useProjectStore.getState().name
          const base = asciiFileName(project === 'Untitled Project' ? 'design' : project, 'design')
          const { operations, toolsById, profile } = await buildGcodeInputs()
          if (!operations.some((o) => o.visible && o.status === 'done' && o.segments.length > 0)) {
            set({ sdBusy: null, sdError: 'The design has no toolpaths to send — generate some first' })
            return
          }
          const gcode = generateGcode(operations, toolsById, base, profile)
          const name = `${base}.nc`
          const file = new File([gcode], name, { type: 'text/plain' })
          set({ sdBusy: `Uploading ${name}…` })
          const r = await link.http({
            method: 'POST', path: '/upload',
            form: sdUploadForm(dir, file, name, new Date()),
            onProgress: (loaded, total) => {
              if (total > 0) set({ sdBusy: `Uploading ${name} ${Math.round((100 * loaded) / total)}%` })
            },
          })
          log(`SD: sent the design as ${sdJoin(dir, name)} (${r.status === 200 ? 'ok' : `HTTP ${r.status}`})`)
          takeListing(r.status, r.body, dir)
          // The text is in hand, so it loads without reading it back off the card —
          // REPLACING a loaded job of the same name, which is the usual case after an
          // edit. Success is judged by the listing, not one exact HTTP status.
          if (r.status === 200 || onCard(name)) set({ job: { dir, name, preview: jobPreview(gcode) }, mapSource: 'job' })
          else set({ sdError: `The design did not reach the card (HTTP ${r.status})` })
        },

        runJob: () => {
          const job = get().job
          // Only the job the map is showing: never one hidden behind the design.
          // And never before X, Y and Z are zeroed (by the Zero buttons or by homing):
          // a program's coordinates mean nothing until work zero sits on the stock.
          const { zeroed } = get()
          if (!zeroed.x || !zeroed.y || !zeroed.z) return
          // Never while the card is busy: during a Load the PREVIOUS job is still the
          // loaded one, so Run would start the file being replaced, not the one just
          // clicked; during an upload the file on the card is still being written.
          if (get().sdBusy) return
          if (job && get().mapSource === 'job' && get().position.state === 'Idle') void send(sdRunCommand(job.dir, job.name), true)
        },
        // Realtime bytes: acted on at once, not queued behind the program.
        feedHold: () => void send('!', true),
        stopMotion: () => {
          if (get().link !== 'connected') return
          if (get().position.state === 'Home') {
            log('> STOP — homing ignores a feed hold, so: soft reset')
            homingAxes = null
            void send('\x18', false)
            return
          }
          log('> STOP (feed hold)')
          void send('!', false)
        },
        resume: () => void send('~', true),
        softReset: () => { log('> stop (soft reset)'); void send('\x18', false) },
        cancelJob: () => {
          if (!holdComplete(get().position)) return
          log('> cancel job (reset at Hold:0 — no alarm, position kept)')
          liftAfterCancel = true
          void send('\x18', false)
        },
      }
    },
    {
      name: 'freazykam-machine',
      partialize: (s) => ({ address: s.address, jogStepIndex: s.jogStepIndex, jogFeedXY: s.jogFeedXY, jogFeedZ: s.jogFeedZ, hasHoming: s.hasHoming }),
    },
  ),
)

/**
 * The safe height in WORK Z. It is measured above the Z datum the toolpaths use, so
 * with a stock-bottom Z origin it sits a stock thickness higher.
 */
export function safeWorkZ(): number {
  const ws = useWorkpieceStore.getState()
  return ws.safeHeightMM + zDatumOffsetMM(ws.zOrigin, ws.thicknessMM)
}

// The relay window follows the toolbar's light/dark toggle while it is open.
useUIStore.subscribe((s, prev) => {
  if (s.darkMode !== prev.darkMode) link?.setTheme(s.darkMode)
})
