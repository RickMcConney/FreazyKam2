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
import { parsePrb, probeDownCommand, zOffsetFromProbe, probeAlarmMessage, type ProbeResult } from './fluidnc/probe'
import { buildGcodeInputs } from '../io/gcodeExport'
import { generateGcode } from '../cam/gcode'
import { asciiFileName } from '../io/filename'
import { useProjectStore } from '../store/projectStore'
import { uid } from '../uid'

export type LinkState = 'disconnected' | 'connecting' | 'connected'

/** A named run of G-code lines the user saved, sent one after another by a button. */
export interface Macro { id: string; name: string; gcode: string }

/** The lines a macro sends: trimmed, blank lines and whole-line comments left out. */
export function macroLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith(';') && !/^\([^)]*\)$/.test(l))
}

const HISTORY_MAX = 50
// One press of a feed or spindle override arrow, percent.
const OV_STEP = 10
// Z probing: back off this far after the fast touch, then touch again slowly; lift this far
// above the plate when done, so it can be taken away.
const PROBE_BACKOFF_MM = 2
const PROBE_LIFT_MM = 5

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
  // 0.1") rather than on an odd converted number. Feeds are mm/min. Z has a step of
  // its own, an index into JOG_STEPS_Z_MM: one shared with XY sent the 10 mm step
  // that crosses the stock in X and Y straight down into it the moment the user
  // reached for Z−.
  jogStepIndex: number
  jogStepIndexZ: number
  jogFeedXY: number
  jogFeedZ: number
  // Which axes the user has zeroed from this panel (or homed) on THIS connection.
  // Not persisted, and cleared whenever the link ends: the work offset lives on the
  // controller, but a check mark says work zero is still where the stock is, and
  // once we stop watching the machine may be power-cycled, moved by hand with its
  // motors off, or driven by another sender. Kept through an automatic reconnect
  // only if the machine reports itself where it was when the socket dropped.
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
  // The file loaded to be cut: where it is on the card, and its toolpath for the map. The
  // map shows this and nothing else — never the design open in FreazyKam, which cannot run
  // until it has been sent to the card and loaded. Unloading leaves the map bare.
  job: { dir: string; name: string; preview: JobPreview } | null
  // Commands typed into the console, oldest first, so ↑ / ↓ can bring one back.
  // Kept between sessions; consecutive repeats are stored once.
  cmdHistory: string[]
  macros: Macro[]
  // How far the go-to map is turned, clockwise, so it matches the table as seen from where
  // the user sits — someone beside the machine sees its X axis running up or down, not
  // across. Display only: positions and clicks stay in work X/Y. Kept between sessions.
  mapRotation: 0 | 90 | 180 | 270
  // The macro whose lines are being sent, if any — one at a time.
  macroRunning: string | null
  // Z touch plate: its thickness, how far down to search, the fast and slow probe feeds
  // (mm, mm/min). Kept between sessions.
  probePlateMM: number
  probeSearchMM: number
  probeFeedMmMin: number
  probeSlowMmMin: number
  // A probe cycle is under way; and why the last one failed, if it did.
  probing: boolean
  probeError: string | null
  // What the Z bar draws while probing, in MACHINE Z (work Z means nothing until the probe
  // has set it): where the tool started, how far it may search, and where it touched the
  // plate once it has. Kept until the lift off the plate has finished.
  // startWorkZ: where it started in work Z, if Z was ✓ zeroed then (else unknown).
  probeView: { startZ: number; startWorkZ: number | null; searchMM: number; contactZ: number | null } | null

  setAddress: (a: string) => void
  connect: () => Promise<void>
  disconnect: () => void
  command: (cmd: string) => void
  clearLog: () => void
  /** Remember a command the user TYPED (buttons are not history). */
  rememberCommand: (cmd: string) => void
  /** Turn the go-to map a further 90° clockwise. */
  rotateMap: () => void
  addMacro: (macro: Omit<Macro, 'id'>) => void
  updateMacro: (id: string, changes: Partial<Omit<Macro, 'id'>>) => void
  deleteMacro: (id: string) => void
  /**
   * Send a macro's lines in order, each once the controller has taken the last. STOP,
   * feed hold, reset and a lost connection end it: the lines after are never sent.
   */
  runMacro: (id: string) => Promise<void>
  setProbe: (changes: Partial<Pick<MachineState, 'probePlateMM' | 'probeSearchMM' | 'probeFeedMmMin' | 'probeSlowMmMin'>>) => void
  /**
   * Find the stock top with a Z touch plate: a fast touch, back off, a slow touch; set work
   * Z0 to the contact point less the plate's thickness; lift clear; mark Z zeroed. Needs the
   * machine Idle and the probe input open. STOP, feed hold, reset or a lost connection end it.
   */
  probeZ: () => Promise<void>
  setJogStepIndex: (i: number) => void
  setJogStepIndexZ: (i: number) => void
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
  /** Feed or spindle override to the next multiple of 10 % up (+1) or down (−1), 10–200 %. */
  overrideStep: (kind: 'feed' | 'spindle', dir: 1 | -1) => void
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
  /** Upload a file to the folder shown and, once it is on the card, make it the job. */
  sdUpload: (file: File) => Promise<void>
  sdDelete: (name: string) => Promise<void>
  /** Download a file from the card and preview its toolpath; it becomes the job to run. */
  sdLoad: (name: string) => Promise<void>
  unloadJob: () => void
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

/** Starts a console line that records a button action rather than a typeable command. */
export const ACTION_MARK = '◆ '

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
// The axes of the homing cycle in progress.
let homingAxes: Axis[] | null = null
// Axes homed since the link came up and not lost since (Disable, Alarm, a drop that
// moved the machine): their machine coordinates are the switches' frame.
let homed: Record<Axis, boolean> = { x: false, y: false, z: false }
// HOMING NEVER CHECKS AN AXIS BY ITSELF — it fixes machine coordinates, and says
// nothing about whether the controller's stored work offset belongs to this stock
// (it may be the last job's, or never set). The one zero it can bring back is one
// the user set in this session on a HOMED axis: re-homing puts the machine back in
// that same frame, so if the controller's offset is still exactly what that Zero
// click made it (G10 L20 sets it to the machine position), it is good again. Kept
// across disconnects, which is the point; a page reload forgets it.
const restorable: Partial<Record<Axis, number>> = {}
// A MACHINE WITHOUT SWITCHES can never home, so a disconnect would cost it every zero
// even when nothing happened. Its motors hold while powered, so if the controller
// comes back reporting EXACTLY the machine position and offset it had when the link
// ended, it has neither restarted (that wakes at machine 0,0,0 — which is why a
// disconnect AT 0,0,0 cannot be told apart and is not restored) nor been moved by
// anything else, and the zeros the user had are still good. Checked against the
// first report that carries WCO; this browser session only; only with Limit
// switches unticked — a machine that can home should home instead.
// The override a 5 % press is on its way to, per kind, so a second press before the
// controller reports the first builds on it rather than on the stale percentage.
const ovHeading: { feed: number | null; spindle: number | null } = { feed: null, spindle: null }
let restoreOnConnect: { mpos: number[]; wco: number[]; zeroed: Record<Axis, boolean> } | null = null
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
// Where the machine was when the socket dropped, checked against the first report
// after it reopens (see `zeroed`). Null while no reconnect is pending a check.
let droppedAt: { mpos: [number, number, number]; moving: boolean } | null = null
let wifiTimer: ReturnType<typeof setInterval> | undefined
// Set by anything that stops the machine, so a macro mid-way sends nothing more.
let macroAbort = false
// A probe cycle under way, and the step of it waiting on the controller: for the PRB line
// a G38.2 ends with, or for the machine to come to rest where a back-off jog was sent.
// Anything that stops the machine rejects it, which ends the cycle there.
let probingNow = false
let probeWait: { resolve: (r: ProbeResult | null) => void; reject: (e: Error) => void } | null = null
const failProbeWait = (why: string) => {
  const w = probeWait
  probeWait = null
  w?.reject(new Error(why))
}

export const useMachineStore = create<MachineState>()(
  persist(
    (set, get) => {
      const log = (line: string) =>
        set((s) => ({ log: s.log.length >= LOG_MAX ? [...s.log.slice(-LOG_MAX + 1), line] : [...s.log, line] }))

      // A BUTTON ACTION, not a command: overrides, jog cancel, STOP and reset go out as
      // realtime control bytes that cannot be typed, so they are logged in words with
      // ACTION_MARK in front (and the byte at the end) — never with "> ", which the
      // console keeps for lines the user could type into the box themselves.
      const logAction = (text: string, bytes: string) => {
        const hex = [...new Set(bytes)].map((c) => `0x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).join(' ')
        log(`${ACTION_MARK}${text} · control byte ${hex}`)
      }

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
        failProbeWait('Probing stopped — the connection was lost')
        if (keepAliveTimer) clearInterval(keepAliveTimer)
        keepAliveTimer = undefined
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        if (attemptTimer) clearTimeout(attemptTimer)
        attemptTimer = undefined
        if (wifiTimer) clearInterval(wifiTimer)
        wifiTimer = undefined
        reconnectTries = 0
        droppedAt = null
        homed = { x: false, y: false, z: false }
        ovHeading.feed = ovHeading.spindle = null
        if (statusTimer) clearInterval(statusTimer)
        statusTimer = undefined
        link = null
        sessionId = ''
        const z = get().zeroed
        const pos = get().position
        // A teardown with nothing zeroed (a failed Connect, say) leaves a pending restore alone.
        if (z.x || z.y || z.z) {
          restoreOnConnect = !get().hasHoming && pos.mpos.some((v) => Math.abs(v) > 1e-3)
            ? { mpos: [...pos.mpos], wco: [...pos.wco], zeroed: { ...z } }
            : null
        }
        if (z.x || z.y || z.z) log(restoreOnConnect
          ? 'Disconnected — zeros will be restored on reconnect only if the machine is exactly where it is now'
          : 'Disconnected — X, Y and Z zeros no longer trusted; home or zero again after reconnecting')
        set({ link: 'disconnected', error, wifi: null, zeroed: { x: false, y: false, z: false }, probeView: null })
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
        const prb = parsePrb(line)
        if (prb) {
          log(line)
          const w = probeWait
          probeWait = null
          w?.resolve(prb)
          return
        }
        if (probeWait) {
          const alarm = /^ALARM:(\d+)/.exec(line)
          if (alarm) failProbeWait(probeAlarmMessage(Number(alarm[1]), get().probeSearchMM) ?? `The controller alarmed while probing (${line})`)
          else if (/^error:/i.test(line)) failProbeWait(`The controller refused the probe move (${line})`)
          // FluidNC answers a G38 with no probe input set up by logging this and not moving
          // (mc_probe_cycle) — without catching it the cycle would wait out its timeout.
          else if (/probe pin is not configured/i.test(line)) failProbeWait('The controller has no probe input set up — add a probe pin to its config file (probe: pin:), then try again.')
          else if (/^\[MSG:ERR:/i.test(line)) failProbeWait(`The controller reported an error while probing: ${line}`)
        }
        const r = parseStatus(line)
        if (r) {
          lastStatusAt = Date.now()
          const prev = get().position
          const next = applyStatus(prev, r)
          set({ position: next })
          if (ovHeading.feed === next.ov.feed) ovHeading.feed = null
          if (ovHeading.spindle === next.ov.spindle) ovHeading.spindle = null
          if (restoreOnConnect && r.wco) {
            const was = restoreOnConnect
            restoreOnConnect = null
            const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 2e-3)
            const z = get().zeroed
            if (!get().hasHoming && !z.x && !z.y && !z.z && (next.state === 'Idle' || next.state === 'Hold')
              && same(next.mpos, was.mpos) && same(next.wco, was.wco)) {
              set({ zeroed: was.zeroed })
              log('Zeros restored: the machine is exactly where it was when the connection ended')
            } else {
              log('The machine is not where it was when the connection ended — zero again')
            }
          }
          if (droppedAt) {
            // A job running through the drop moves the machine legitimately; anything
            // else that moved it, or a restart (which resets machine position), voids
            // the zeros. A job that ends in Alarm meanwhile is no better.
            const moved = next.mpos.some((v, i) => Math.abs(v - droppedAt!.mpos[i]) > 0.01)
            const z = get().zeroed
            if ((moved && !droppedAt.moving) || next.state === 'Alarm') {
              homed = { x: false, y: false, z: false }
              if (z.x || z.y || z.z) {
                log(`The machine ${next.state === 'Alarm' ? 'is in Alarm' : 'moved'} while the connection was down — home or zero X, Y and Z again`)
                set({ zeroed: { x: false, y: false, z: false } })
              }
            }
            droppedAt = null
          }
          // A homing cycle that ends in Idle homes its axes (one that ends in Alarm,
          // a switch not found, does not), and brings back only a zero `restorable`
          // vouches for.
          if (homingAxes && prev.state === 'Home' && next.state !== 'Home') {
            if (next.state === 'Idle') {
              const zeroed = { ...get().zeroed }
              const back: string[] = [], toZero: string[] = []
              for (const a of homingAxes) {
                homed[a] = true
                const want = restorable[a]
                const i = a === 'x' ? 0 : a === 'y' ? 1 : 2
                if (want !== undefined && Math.abs(next.wco[i] - want) < 2e-3) { zeroed[a] = true; back.push(a.toUpperCase()) }
                else if (!zeroed[a]) toZero.push(a.toUpperCase())
              }
              set({ zeroed })
              if (back.length) log(`Homed — ${back.join(', ')} zero${back.length > 1 ? 's' : ''} restored from earlier in this session`)
              if (toZero.length) log(`Homed — now zero ${toZero.join(', ')} on the stock`)
            }
            homingAxes = null
          }
          // An alarm (a limit hit, a reset mid-move) means steps may have been lost:
          // neither the homing nor the zeros can be trusted until redone.
          // A probe's own alarm (4: already touching, 5: no contact) loses no steps — the
          // controller knows exactly where it stopped — so it clears nothing.
          if (next.state === 'Alarm' && prev.state !== 'Alarm' && prev.state !== 'Unknown' && !probingNow) {
            homed = { x: false, y: false, z: false }
            const z = get().zeroed
            if (z.x || z.y || z.z) {
              log('Alarm — position may be lost; X, Y and Z zeros cleared. Unlock, then home or zero again')
              set({ zeroed: { x: false, y: false, z: false } })
            }
          }
          if (liftAfterCancel && next.state !== prev.state && (next.state === 'Idle' || next.state === 'Alarm')) {
            liftAfterCancel = false
            if (next.state === 'Idle') liftOutOfCut(next)
            else log('Cancel ended in Alarm — not lifting Z; check the machine, Unlock, then jog clear')
          }
          // The probe view stays up through the lift off the plate, and goes when it ends.
          if (get().probeView && !probingNow && next.state === 'Idle' && prev.state !== 'Idle') set({ probeView: null })
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
          if (!droppedAt) {
            const p = get().position
            droppedAt = { mpos: [...p.mpos] as [number, number, number], moving: ['Run', 'Jog', 'Home'].includes(p.state) || !!p.sd }
          }
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
        jogStepIndexZ: 2,
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
        cmdHistory: [],
        macros: [],
        mapRotation: 0,
        macroRunning: null,
        probePlateMM: 10,
        probeSearchMM: 25,
        probeFeedMmMin: 100,
        probeSlowMmMin: 25,
        probing: false,
        probeError: null,
        probeView: null,

        setAddress: (address) => set({ address }),
        clearLog: () => set({ log: [] }),

        rememberCommand: (cmd) => {
          const c = cmd.trim()
          if (!c) return
          set((s) => s.cmdHistory[s.cmdHistory.length - 1] === c ? s
            : { cmdHistory: [...s.cmdHistory, c].slice(-HISTORY_MAX) })
        },

        setProbe: (changes) => set(changes),

        probeZ: async () => {
          const s0 = get()
          if (s0.link !== 'connected' || s0.position.state !== 'Idle' || s0.position.sd || s0.probing || s0.macroRunning) return
          if (s0.position.probe) {
            set({ probeError: 'The probe already reads touching — check the clip is on the bit, the plate is clear of it, and the lead is not shorted.' })
            return
          }
          const { probePlateMM: plate, probeSearchMM: search, probeFeedMmMin: fast, probeSlowMmMin: slow } = s0
          // The PRB line comes when the move ends; give it the move's time and a margin.
          const awaitPrb = (distMM: number, feed: number) => new Promise<ProbeResult | null>((resolve, reject) => {
            probeWait = { resolve, reject }
            setTimeout(() => { if (probeWait?.resolve === resolve) failProbeWait('No answer from the controller while probing') }, (distMM / feed) * 60000 * 1.5 + 5000)
          })
          // Backed off: Idle again, and clearly up off the plate — at least half the back-off
          // above the TRIGGER point. Not "at trigger + back-off": the axis decelerates past the
          // trigger before it stops (PRB reports the trigger, not the stop), so the jog, which
          // is relative, ends short of that by the overshoot — 0.03 mm on an MPCNC Z at 50
          // mm/s² and 100 mm/min. Waiting for it within 0.01 mm never ended, on the first real
          // machine. Before the jog the tool sits at or below the trigger, so this cannot be
          // met early.
          const awaitBackedOff = (triggerZ: number) => new Promise<ProbeResult | null>((resolve, reject) => {
            probeWait = { resolve, reject }
            const unsub = useMachineStore.subscribe((s) => {
              if (probeWait?.resolve !== resolve) { unsub(); return }
              if (s.position.state === 'Idle' && s.position.mpos[2] >= triggerZ + PROBE_BACKOFF_MM / 2) {
                unsub(); probeWait = null; resolve(null)
              }
            })
            setTimeout(() => { if (probeWait?.resolve === resolve) { unsub(); failProbeWait('The machine did not back off the plate') } }, 15000)
          })

          probingNow = true
          set({ probing: true, probeError: null, probeView: { startZ: s0.position.mpos[2], startWorkZ: s0.zeroed.z ? s0.position.wpos[2] : null, searchMM: search, contactZ: null } })
          log(`${ACTION_MARK}Probe Z — plate ${plate} mm, searching ${search} mm down`)
          try {
            // 1. Fast, to find the plate.
            const first = awaitPrb(search, fast)
            await send(probeDownCommand(get().position.wpos[2] - search, fast), true)
            const touch1 = await first
            if (!touch1?.ok) throw new Error(probeAlarmMessage(5, search) ?? 'The probe never touched')
            set({ probeView: { ...get().probeView!, contactZ: touch1.mpos[2] } })
            // 2. Off the plate, then 3. slowly back down onto it — the accurate touch.
            const backedOff = awaitBackedOff(touch1.mpos[2])
            await send(jogCommand({ z: PROBE_BACKOFF_MM }, fast)!, true)
            await backedOff
            const second = awaitPrb(PROBE_BACKOFF_MM * 2, slow)
            await send(probeDownCommand(get().position.wpos[2] - PROBE_BACKOFF_MM * 2, slow), true)
            const touch2 = await second
            if (!touch2?.ok) throw new Error('The slow touch missed the plate — it may have moved. Try again.')
            // 4. Work Z0 is the plate's top less its thickness — the stock top.
            const contactZ = touch2.mpos[2]
            set({ probeView: { ...get().probeView!, contactZ } })
            // Z0 is the surface the plate lies on — the stock top, or the table for a
            // bottom-of-stock origin (the user puts it there; see zOffsetFromProbe).
            const ws = useWorkpieceStore.getState()
            await send(zOffsetFromProbe(contactZ, plate), true)
            if (homed.z) restorable.z = contactZ - plate
            else delete restorable.z
            set({ zeroed: { ...get().zeroed, z: true } })
            // 5. Up off the plate, so it can be taken away.
            await send(jogCommand({ z: PROBE_LIFT_MM }, fast)!, true)
            log(`Probed Z: Z0 set on the ${ws.zOrigin === 'bottom' ? 'table (the stock bottom)' : 'stock top'}, ${plate} mm under the plate's top. Remove the plate.`)
            // A lift that ends between two status reports never shows its Jog → Idle, so
            // the view is also let go a moment after the lift should be done.
            setTimeout(() => { if (!probingNow && get().position.state === 'Idle') set({ probeView: null }) }, 3000)
          } catch (e) {
            const why = (e as Error).message
            set({ probeError: why, probeView: null })
            log(`! ${why}`)
          } finally {
            probeWait = null
            probingNow = false
            set({ probing: false })
          }
        },

        rotateMap: () => set((s) => ({ mapRotation: ((s.mapRotation + 90) % 360) as 0 | 90 | 180 | 270 })),

        addMacro: (macro) => set((s) => ({ macros: [...s.macros, { ...macro, id: uid('macro') }] })),
        updateMacro: (id, changes) => set((s) => ({ macros: s.macros.map((x) => (x.id === id ? { ...x, ...changes } : x)) })),
        deleteMacro: (id) => set((s) => ({ macros: s.macros.filter((x) => x.id !== id) })),

        runMacro: async (id) => {
          const macro = get().macros.find((x) => x.id === id)
          // One at a time, never into a running job, and only on a live link.
          if (!macro || get().macroRunning || get().link !== 'connected' || get().position.sd) return
          const lines = macroLines(macro.gcode)
          if (!lines.length) return
          macroAbort = false
          set({ macroRunning: id })
          log(`${ACTION_MARK}Macro "${macro.name}" — ${lines.length} line${lines.length === 1 ? '' : 's'}`)
          try {
            for (const line of lines) {
              if (macroAbort || get().link !== 'connected') {
                log(`${ACTION_MARK}Macro "${macro.name}" stopped — the rest was not sent`)
                break
              }
              await send(line, true)
            }
          } finally {
            set({ macroRunning: null })
          }
        },

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
          macroAbort = true
          failProbeWait('Probing stopped — the connection was closed')
          link?.close()
          teardown(null)
        },

        command: (cmd) => void send(cmd, true),

        setJogStepIndex: (jogStepIndex) => set({ jogStepIndex }),
        setJogStepIndexZ: (jogStepIndexZ) => set({ jogStepIndexZ }),
        setJogFeedXY: (jogFeedXY) => set({ jogFeedXY }),
        setJogFeedZ: (jogFeedZ) => set({ jogFeedZ }),
        jog: (move) => {
          const { jogFeedXY, jogFeedZ } = get()
          const cmd = jogCommand(move, move.z ? jogFeedZ : jogFeedXY)
          if (cmd) void send(cmd, true)
        },
        // A realtime byte: acted on at once, not queued behind the jogs it stops.
        // Above 0x7F it travels in the URL as UTF-8, as WebUI 3 sends it.
        jogCancel: () => {
          if (!link?.isOpen) return
          logAction('Jog cancel', JOG_CANCEL)
          void send(JOG_CANCEL, false)
        },

        zero: (axes) => {
          const cmd = zeroCommand(axes)
          if (!cmd || get().link !== 'connected') return
          void send(cmd, true)
          const zeroed = { ...get().zeroed }
          const mpos = get().position.mpos
          for (const a of axes) {
            zeroed[a] = true
            // G10 L20 makes the offset the current machine position. Only a homed
            // axis's machine position means the same thing after the next homing.
            if (homed[a]) restorable[a] = mpos[a === 'x' ? 0 : a === 'y' ? 1 : 2]
            else delete restorable[a]
          }
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
          // Released motors let the axes be pushed by hand, so no zero survives it.
          if (!enabled) {
            homed = { x: false, y: false, z: false }
            const z = get().zeroed
            if (z.x || z.y || z.z) log('Motors disabled — X, Y and Z zeros cleared; zero or home again before using the map or Safe Z')
            set({ zeroed: { x: false, y: false, z: false } })
          }
        },

        // Overrides are single realtime bytes (0x90–0x9D), unreadable echoed as they are,
        // so the console gets a line in words instead.
        override: (kind, step) => {
          ovHeading[kind] = null
          if (!link?.isOpen) return
          logAction(`${kind === 'feed' ? 'Feed' : 'Spindle'} override ${step === 'reset' ? 'back to 100 %' : step.replace('plus', '+').replace('minus', '−') + ' %'}`, OVERRIDE[kind][step])
          void send(OVERRIDE[kind][step], false)
        },
        // A press goes to the next multiple of OV_STEP: 10 %, the controller's own coarse
        // step (5 % was too modest to be worth a click). Made of the controller's ±10 bytes,
        // then ±1 bytes for whatever is left to land on the round number (103 → 110 is seven
        // +1s), sent in order. The base is where an earlier press is heading, if any.
        overrideStep: async (kind, dir) => {
          const now = ovHeading[kind] ?? get().position.ov[kind]
          const target = Math.max(10, Math.min(200, dir > 0 ? Math.floor(now / OV_STEP) * OV_STEP + OV_STEP : Math.ceil(now / OV_STEP) * OV_STEP - OV_STEP))
          if (target === now) return
          ovHeading[kind] = target
          const up = target > now
          const diff = Math.abs(target - now)
          const tens = Math.floor(diff / 10), ones = diff % 10
          const bytes = [
            ...Array(tens).fill(OVERRIDE[kind][up ? 'plus10' : 'minus10']),
            ...Array(ones).fill(OVERRIDE[kind][up ? 'plus1' : 'minus1']),
          ] as string[]
          if (link?.isOpen) logAction(`${kind === 'feed' ? 'Feed' : 'Spindle'} override ${now} → ${target} %`, bytes.join(''))
          for (const b of bytes) await send(b, false)
        },
        rapidOverride: (pct) => {
          if (link?.isOpen) logAction(`Rapid override ${pct} %`, OVERRIDE.rapid[pct])
          void send(OVERRIDE.rapid[pct], false)
        },

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
          // The file just uploaded is the one about to be run, so it becomes the job and
          // the map shows it — as Send to card does — from the text already in hand, no
          // read back needed. Judged by the listing: only a file that landed is loaded.
          // (This also replaces a loaded job of the same name, whose preview would
          // otherwise be of a file that no longer exists.)
          if (onCard(file.name)) {
            set({ job: { dir, name: file.name, preview: jobPreview(await file.text()) } })
          } else if (r.status === 200) {
            set({ sdError: `${file.name} did not appear on the card after uploading` })
          }
        },

        sdDelete: async (name) => {
          if (!link?.isOpen) return
          const dir = get().sdPath
          set({ sdBusy: `Deleting ${name}…`, sdError: null })
          const r = await link.http({ path: '/upload', query: { path: dir, action: 'delete', filename: name } })
          log(`SD: deleted ${sdJoin(dir, name)} (${r.status === 200 ? 'ok' : `HTTP ${r.status}`})`)
          const job = get().job
          if (job && job.dir === dir && job.name === name) set({ job: null })
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
          set({ sdBusy: null, job: { dir, name, preview } })
          log(`SD: loaded ${sdJoin(dir, name)} — ${preview.segments} moves`)
        },

        unloadJob: () => set({ job: null }),

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
          if (r.status === 200 || onCard(name)) set({ job: { dir, name, preview: jobPreview(gcode) } })
          else set({ sdError: `The design did not reach the card (HTTP ${r.status})` })
        },

        runJob: () => {
          const job = get().job
          // The loaded job — the only thing the map ever shows — and never before X, Y and
          // Z are zeroed (by the Zero buttons or by homing):
          // a program's coordinates mean nothing until work zero sits on the stock.
          const { zeroed } = get()
          if (!zeroed.x || !zeroed.y || !zeroed.z) return
          // Never while the card is busy: during a Load the PREVIOUS job is still the
          // loaded one, so Run would start the file being replaced, not the one just
          // clicked; during an upload the file on the card is still being written.
          if (get().sdBusy) return
          if (job && get().position.state === 'Idle') void send(sdRunCommand(job.dir, job.name), true)
        },
        // Realtime bytes: acted on at once, not queued behind the program.
        feedHold: () => { macroAbort = true; failProbeWait('Probing stopped by a feed hold'); void send('!', true) },
        stopMotion: () => {
          macroAbort = true
          failProbeWait('Probing stopped')
          if (get().link !== 'connected') return
          if (get().position.state === 'Home') {
            logAction('STOP — homing ignores a feed hold, so: soft reset', '\x18')
            homingAxes = null
            void send('\x18', false)
            return
          }
          logAction('STOP (feed hold)', '!')
          void send('!', false)
        },
        resume: () => void send('~', true),
        softReset: () => { macroAbort = true; failProbeWait('Probing stopped by a reset'); logAction('Soft reset', '\x18'); void send('\x18', false) },
        cancelJob: () => {
          if (!holdComplete(get().position)) return
          logAction('Cancel job (reset at Hold:0 — no alarm, position kept)', '\x18')
          liftAfterCancel = true
          void send('\x18', false)
        },
      }
    },
    {
      name: 'freazykam-machine',
      partialize: (s) => ({ address: s.address, jogStepIndex: s.jogStepIndex, jogStepIndexZ: s.jogStepIndexZ, jogFeedXY: s.jogFeedXY, jogFeedZ: s.jogFeedZ, hasHoming: s.hasHoming, cmdHistory: s.cmdHistory, macros: s.macros, mapRotation: s.mapRotation, probePlateMM: s.probePlateMM, probeSearchMM: s.probeSearchMM, probeFeedMmMin: s.probeFeedMmMin, probeSlowMmMin: s.probeSlowMmMin }),
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
