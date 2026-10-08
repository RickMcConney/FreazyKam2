// The Machine tab: connect to a FluidNC controller through the relay, see where
// the machine is, home, zero and jog it, override feeds and speeds, and click on
// the stock map to send it there. The SD card and the job controls fill the
// sidebar meanwhile (SdCardPanel), so nothing here has to make room for a file list.
//
// Controls in a fixed column on the left, sized to fit without scrolling; the
// go-to map and the console share the rest, the map on top.

import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  ArrowUpLeft, ArrowUpRight, ArrowDownLeft, ArrowDownRight, OctagonX, Check, Home, Power, PowerOff, Wifi, WifiLow, WifiOff, Download,
} from 'lucide-react'
import { ICON } from '../theme'
import { useMachineStore, safeWorkZ, ACTION_MARK } from '../machine/machineStore'
import type { WifiStatus } from '../machine/fluidnc/esp800'
import { useWorkpieceStore, lenValue, fromMM, toMM, zDatumOffsetMM } from '../store/workpieceStore'
import { NumericInput } from '../components/NumericInput'
import { NUMERIC_HINT } from '../components/parseNumeric'
import { JOG_STEPS_MM, JOG_STEPS_Z_MM, type JogMove, type Axis } from '../machine/fluidnc/jog'
import GoToMap, { type StockBox } from './GoToMap'
import ZBar from './ZBar'
import RelaySetupDialog, { downloadRelay } from './RelaySetupDialog'
import { RELAY_FILE_NAME } from '../machine/relayClient'
import OverridesSection from './OverridesSection'

const AXES = ['X', 'Y', 'Z']

const STATE_CLASS: Record<string, string> = {
  Idle: 'bg-green-600 text-white',
  Run: 'bg-blue-600 text-white',
  Jog: 'bg-blue-600 text-white',
  Home: 'bg-blue-600 text-white',
  Hold: 'bg-amber-500 text-black',
  Door: 'bg-amber-500 text-black',
  Alarm: 'bg-red-600 text-white',
}

// Pad icons nearly fill the fixed 36 px (h-9) button: a lucide arrow only draws
// across the middle ~60 % of its box, so the glyph itself still has margin.
const JOG_ICON = 30
// Lucide's default 2 scales up with the size and reads heavy at 30 px.
const JOG_STROKE = 1.25

// The XY pad, read as the machine is seen from the front: +Y away, +X right.
const XY_PAD: { dx: number; dy: number; icon: React.ReactNode }[] = [
  { dx: -1, dy: 1, icon: <ArrowUpLeft size={JOG_ICON} strokeWidth={JOG_STROKE} /> },
  { dx: 0, dy: 1, icon: <ArrowUp size={JOG_ICON} strokeWidth={JOG_STROKE} /> },
  { dx: 1, dy: 1, icon: <ArrowUpRight size={JOG_ICON} strokeWidth={JOG_STROKE} /> },
  { dx: -1, dy: 0, icon: <ArrowLeft size={JOG_ICON} strokeWidth={JOG_STROKE} /> },
  { dx: 0, dy: 0, icon: null },   // centre: jog cancel
  { dx: 1, dy: 0, icon: <ArrowRight size={JOG_ICON} strokeWidth={JOG_STROKE} /> },
  { dx: -1, dy: -1, icon: <ArrowDownLeft size={JOG_ICON} strokeWidth={JOG_STROKE} /> },
  { dx: 0, dy: -1, icon: <ArrowDown size={JOG_ICON} strokeWidth={JOG_STROKE} /> },
  { dx: 1, dy: -1, icon: <ArrowDownRight size={JOG_ICON} strokeWidth={JOG_STROKE} /> },
]

// The controller's WiFi signal, from [ESP420]. Green from 60 % (−70 dBm, the usual
// floor for a reliable link), which also fits the field: at 58 % (−71 dBm) the link
// dropped a quarter of its packets and the socket kept closing; at 62 % (−69 dBm) it
// held. The percentage is not the whole story — interference on a busy channel did
// more harm at 74 % than a clear channel did at 62 % — so amber says "may", not "will".
function WifiSignal({ wifi }: { wifi: WifiStatus }) {
  const pct = wifi.signalPct
  const [Icon, cls] = pct >= 60 ? [Wifi, 'text-green-600 dark:text-green-400']
    : pct >= 45 ? [WifiLow, 'text-amber-600 dark:text-amber-400']
      : [WifiOff, 'text-red-600 dark:text-red-400']
  const detail = [wifi.ssid, wifi.channel ? `channel ${wifi.channel}` : '', `${Math.round(wifi.rssiDbm)} dBm`].filter(Boolean).join(' · ')
  return (
    <span className={`flex items-center gap-1 text-xs tabular-nums flex-shrink-0 ${cls}`}
      title={`Controller WiFi signal: ${detail}${pct < 60 ? ' — weak; the connection may drop' : ''}`}>
      <Icon size={ICON.xs} /> {Math.round(pct)}%
    </span>
  )
}

const sectionCls = 'rounded-lg border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-800'
const headCls = 'px-3 py-1.5 border-b border-gray-300 dark:border-neutral-700 text-label font-semibold uppercase tracking-wider text-gray-600 dark:text-neutral-400'
const padBtnCls = 'flex items-center justify-center h-9 rounded border border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-transparent'
const zStepBtnCls = 'flex-1 h-full flex items-center text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent'
const inputCls = 'min-w-0 flex-1 px-2 py-1 rounded border border-gray-400 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-gray-800 dark:text-neutral-200 text-sm'
const smallBtnCls = 'flex items-center justify-center gap-1 h-7 rounded text-xs font-semibold border border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-transparent'
const btnCls = 'px-3 py-1 rounded text-sm border border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-40'

export default function MachineControlPanel() {
  const m = useMachineStore()
  const units = useWorkpieceStore((s) => s.units)
  const origin = useWorkpieceStore((s) => s.origin)
  const zOrigin = useWorkpieceStore((s) => s.zOrigin)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const [cmd, setCmd] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  const [stockBox, setStockBox] = useState<StockBox | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [m.log])

  const connected = m.link === 'connected'
  const p = m.position
  const len = (mm: number | undefined) => lenValue(mm ?? 0, units, 3)
  // Jogs are refused by the controller outside Idle and Jog (a jog queues behind
  // a running one), so the pad is live only then.
  const canJog = connected && (p.state === 'Idle' || p.state === 'Jog')
  const steps = JOG_STEPS_MM[units]
  const stepMM = steps[Math.min(m.jogStepIndex, steps.length - 1)]
  const stepsZ = JOG_STEPS_Z_MM[units]
  const stepZIndex = Math.min(m.jogStepIndexZ, stepsZ.length - 1)
  const stepZMM = stepsZ[stepZIndex]
  const feedUnit = units === 'in' ? 'in/min' : 'mm/min'
  const jog = (move: JogMove) => { if (canJog) m.jog(move) }
  // The tool tip is in the stock: an XY jog now drags it through the material. Not
  // blocked — jogging at the surface is normal (checking zero, touching off) — only
  // outlined, and only when Z is zeroed, since otherwise "the surface" is unknown.
  const stockTopZ = zDatumOffsetMM(zOrigin, thicknessMM)
  const inStock = connected && m.zeroed.z && p.wpos[2] < stockTopZ - 1e-3
  // Z− the same way, a step early: outlined whenever the next step down ends in the
  // stock, so at Z0 on the surface, and on the way down from just above it.
  const zDownCuts = connected && m.zeroed.z && p.wpos[2] - stepZMM < stockTopZ - 1e-3
  // Zeroing (G10) and go-to are refused mid-motion, so both wait for Idle.
  const idle = connected && p.state === 'Idle'
  // Homing is how a machine with switches leaves the startup Alarm, so Alarm allows it.
  const canHome = connected && (p.state === 'Idle' || p.state === 'Alarm')
  // 0.01, not lenValue's fixed 0.010: these are labels on buttons.
  const stepLabel = (mm: number) => String(Number(lenValue(mm, units, 1)))
  const axisLabel = (axis: string, sign: number) => `${axis}${sign > 0 ? '+' : '−'} ${stepLabel(axis === 'Z' ? stepZMM : stepMM)} ${units}`

  const state = connected ? p.state + (p.subState ? `:${p.subState}` : '') : m.link === 'connecting' ? 'Connecting…' : 'Offline'

  const submit = () => {
    const c = cmd.trim()
    if (!c) return
    m.command(c)
    setCmd('')
  }

  return (
    <div className="flex h-full gap-3 p-3 bg-gray-50 dark:bg-neutral-900 text-sm">
      {setupOpen && <RelaySetupDialog address={m.address} onClose={() => setSetupOpen(false)} />}
      <div className="w-[22rem] flex-shrink-0 space-y-2 overflow-y-auto">
        {/* ONE WAY TO STOP THAT ALWAYS WORKS, whatever is moving and whatever started
            it: a go-to or Safe-Z move is a jog, which the job box's Stop never
            covered, and the jog pad's cancel ignores programs and homing. Pinned
            to the top of the column so scrolling can never put it out of reach.
            It needs the link: it is no substitute for the machine's own E-stop. */}
        <div className="sticky top-0 z-10 bg-gray-50 dark:bg-neutral-900 pb-1">
          <button
            onClick={m.stopMotion}
            disabled={!connected}
            title={!connected
              ? 'Not connected — use the machine\'s own E-stop or power switch'
              : p.state === 'Home'
                ? 'Stop homing (soft reset — the machine will alarm)'
                : 'Stop all motion now: jogs and go-to moves cancel, a running job pauses (then Resume or Cancel)'}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-base font-bold tracking-wider disabled:opacity-40 disabled:hover:bg-red-600">
            <OctagonX size={20} /> STOP
          </button>
        </div>
        <section className={sectionCls}>
          <div className={`${headCls} flex items-center`}>
            <span className="flex-1">Connection</span>
            <button className="normal-case tracking-normal font-normal hover:text-gray-800 dark:hover:text-neutral-200 hover:underline"
              onClick={() => setSetupOpen(true)} title="How to put the relay on the controller (once per controller)">
              Set up…
            </button>
          </div>
          <div className="px-3 py-2 space-y-2">
            <div className="flex gap-2">
              <input
                className={inputCls}
                value={m.address}
                onChange={(e) => m.setAddress(e.target.value)}
                disabled={m.link !== 'disconnected'}
                placeholder="fluidnc.local"
                title="Controller address (host name or IP)"
              />
              {m.link === 'disconnected'
                ? <button className={btnCls} onClick={() => void m.connect()}>Connect</button>
                : <button className={btnCls} onClick={m.disconnect}>Disconnect</button>}
            </div>
            {/* Before the first connection the relay has to be on the controller, so the
                way to get it is on show whenever there is no link — not only after a
                failed Connect, and not only behind the small "Set up…" in the header. */}
            {m.link === 'disconnected' && (
              <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-neutral-400">
                <span>First time on this controller?</span>
                <button className="inline-flex items-center gap-1 text-blue-600 dark:text-sky-400 hover:underline"
                  onClick={() => downloadRelay()} title={`Download the relay, already named ${RELAY_FILE_NAME}, to copy onto the controller's flash (FluidNC v4+; for v3 see How to install)`}>
                  <Download size={ICON.xs} /> Download {RELAY_FILE_NAME}
                </button>
                <span>·</span>
                <button className="text-blue-600 dark:text-sky-400 hover:underline" onClick={() => setSetupOpen(true)}>
                  How to install
                </button>
              </div>
            )}
            {m.error && (
              <p className="text-red-600 dark:text-red-400">
                {m.error}
                {m.relayMissing && (
                  <> {' '}<button className="underline font-semibold" onClick={() => setSetupOpen(true)}>Set up the relay</button></>
                )}
              </p>
            )}
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${STATE_CLASS[p.state] && connected ? STATE_CLASS[p.state] : 'bg-gray-300 dark:bg-neutral-600 text-gray-700 dark:text-neutral-200'}`}>
                {state}
              </span>
              {m.info?.firmware && <span className="text-xs text-gray-600 dark:text-neutral-400 truncate">{m.info.firmware}</span>}
              {connected && m.wifi && <WifiSignal wifi={m.wifi} />}
              {connected && p.state === 'Alarm' && (
                <button className={`${btnCls} ml-auto py-0.5 text-xs`} onClick={() => m.command('$X')} title="Clear the alarm ($X)">Unlock</button>
              )}
            </div>
          </div>
        </section>

        <section className={sectionCls}>
          <div className={headCls}>Position</div>
          <div className="px-3 py-2">
            <table className={`w-full tabular-nums ${connected ? '' : 'opacity-40'}`}>
              <thead className="text-xs text-gray-600 dark:text-neutral-400">
                <tr>
                  <th />
                  <th className="text-right font-normal">Work ({units})</th>
                  <th className="text-right font-normal">Machine</th>
                </tr>
              </thead>
              <tbody>
                {AXES.map((a, i) => (
                  <tr key={a}>
                    <td className="text-lg font-semibold text-gray-700 dark:text-neutral-200">{a}</td>
                    {/* Not zeroed on this connection: the number is the controller's stored
                        offset, which may no longer be where the stock is — shown, since
                        homing can make it good again, but dimmed so it is not read as one. */}
                    <td className={`text-right text-xl font-mono ${m.zeroed[a.toLowerCase() as Axis] ? 'text-gray-800 dark:text-neutral-100' : 'text-gray-400 dark:text-neutral-600'}`}
                      title={m.zeroed[a.toLowerCase() as Axis] ? undefined : `${a} is not zeroed on this connection — the controller's stored work offset, not checked against the stock. Zero ${a} or home to trust it.`}>
                      {len(p.wpos[i])}
                    </td>
                    <td className="text-right font-mono text-gray-600 dark:text-neutral-400">{len(p.mpos[i])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={sectionCls}>
          <div className={`${headCls} flex items-center`}>
            <span className="flex-1">Home &amp; Zero</span>
            <label className="flex items-center gap-1 normal-case tracking-normal font-normal" title="Untick if the machine has no limit switches to home against">
              <input type="checkbox" checked={m.hasHoming} onChange={(e) => m.setHasHoming(e.target.checked)} />
              Limit switches
            </label>
          </div>
          <div className="px-3 py-2 space-y-1">
            <div className="grid grid-cols-[2.5rem_repeat(4,1fr)] items-center gap-1">
              {m.hasHoming && (
                <>
                  <span className="text-xs text-gray-600 dark:text-neutral-400">Home</span>
                  <button className={smallBtnCls} onClick={() => m.home()} disabled={!canHome} title="Home all axes ($H)">
                    <Home size={ICON.xs} /> All
                  </button>
                  {(['x', 'y', 'z'] as Axis[]).map((a) => (
                    <button key={a} className={smallBtnCls} onClick={() => m.home(a)} disabled={!canHome} title={`Home ${a.toUpperCase()} ($H${a.toUpperCase()})`}>
                      {a.toUpperCase()}
                    </button>
                  ))}
                </>
              )}
              <span className="text-xs text-gray-600 dark:text-neutral-400">Zero</span>
              <button className={smallBtnCls} onClick={() => m.zero(['x', 'y', 'z'])} disabled={!idle}
                title="Make the current position work X0 Y0 Z0">
                All
              </button>
              {(['x', 'y', 'z'] as Axis[]).map((a) => (
                <button key={a} className={smallBtnCls} onClick={() => m.zero([a])} disabled={!idle}
                  title={`Make the current ${a.toUpperCase()} position work ${a.toUpperCase()}0`}>
                  {a.toUpperCase()}
                  {m.zeroed[a] && <Check size={ICON.xs} className="text-green-600 dark:text-green-400" />}
                </button>
              ))}
              <span className="text-xs text-gray-600 dark:text-neutral-400">Motors</span>
              <button className={`${smallBtnCls} col-span-2 ${m.motorsCommanded === 'enabled' ? 'ring-1 ring-green-600' : ''}`}
                onClick={() => m.setMotors(true)} disabled={!canHome}
                title="Power the stepper motors ($ME) — they hold position">
                <Power size={ICON.xs} /> Enable
              </button>
              <button className={`${smallBtnCls} col-span-2 ${m.motorsCommanded === 'disabled' ? 'ring-1 ring-amber-500' : ''}`}
                onClick={() => m.setMotors(false)} disabled={!canHome}
                title="Release the stepper motors ($MD) so the axes can be moved by hand. Any jog, go-to or job switches them back on.">
                <PowerOff size={ICON.xs} /> Disable
              </button>
              <span className="text-xs text-gray-600 dark:text-neutral-400">Go</span>
              <button className={`${smallBtnCls} col-span-4`} onClick={() => void m.goToOrigin()}
                disabled={!idle || !m.zeroed.x || !m.zeroed.y || !m.zeroed.z}
                title={m.zeroed.x && m.zeroed.y && m.zeroed.z
                  ? `Raise Z to the safe height (Z${lenValue(safeWorkZ(), units)} ${units}), then go to X0 Y0`
                  : 'Zero X, Y and Z first — the safe height is measured from the Z zero'}>
                <ArrowUp size={ICON.xs} /> Safe Z, then X0 Y0
              </button>
            </div>
            <p className="text-xs text-gray-600 dark:text-neutral-400">
              Zero at the stock's {origin.replace('-', ' ')}, Z on the {zOrigin === 'bottom' ? 'stock bottom' : 'top surface'}.
            </p>
          </div>
        </section>

        <section className={sectionCls}>
          <div className={headCls}>Jog</div>
          <div className="px-3 py-2 space-y-2">
            <div className="flex gap-3">
              <div className="grid grid-cols-3 gap-1 flex-1">
                {XY_PAD.map(({ dx, dy, icon }) => dx === 0 && dy === 0
                  ? (
                    <button key="cancel" className={`${padBtnCls} text-red-600 dark:text-red-400`}
                      onClick={m.jogCancel} disabled={!connected} title="Stop jogging">
                      <OctagonX size={JOG_ICON} strokeWidth={JOG_STROKE} />
                    </button>
                  )
                  : (
                    <button key={`${dx},${dy}`}
                      className={`${padBtnCls} ${inStock ? '!border-orange-500 dark:!border-orange-400' : ''}`}
                      onClick={() => jog({ x: dx * stepMM, y: dy * stepMM })} disabled={!canJog}
                      title={[dx && axisLabel('X', dx), dy && axisLabel('Y', dy)].filter(Boolean).join(', ')
                        + (inStock ? ' — the tool is below the stock surface, so this jog will cut' : '')}>
                      {icon}
                    </button>
                  ))}
              </div>
              <div className="grid grid-rows-3 gap-1 w-16">
                <button className={padBtnCls} onClick={() => jog({ z: stepZMM })} disabled={!canJog} title={axisLabel('Z', 1)}>
                  <ArrowUp size={JOG_ICON} strokeWidth={JOG_STROKE} />
                </button>
                {/* Z's own step, so the big XY step that crosses the stock is never
                    the one Z− plunges by. */}
                <div className="flex flex-col items-center justify-center h-9 leading-none text-gray-600 dark:text-neutral-400"
                  role="group" aria-label="Z jog step">
                  <span className="text-[10px] mb-0.5">Z step</span>
                  {/* Sideways on purpose: up/down marks here, between Z+ and Z−, would read as jogs. */}
                  {/* Each half is its button, so the target runs to the middle; the
                      value sits over the seam and lets clicks through. */}
                  <div className="relative flex w-full h-5 rounded border border-gray-400 dark:border-neutral-600 overflow-hidden">
                    <button className={`${zStepBtnCls} justify-start pl-1`} onClick={() => m.setJogStepIndexZ(stepZIndex - 1)} disabled={stepZIndex === 0}
                      title={stepZIndex === 0 ? 'Smallest Z step' : `Smaller Z step (${stepLabel(stepsZ[stepZIndex - 1])} ${units})`}
                      aria-label="Smaller Z step">−</button>
                    <button className={`${zStepBtnCls} justify-end pr-1`} onClick={() => m.setJogStepIndexZ(stepZIndex + 1)} disabled={stepZIndex === stepsZ.length - 1}
                      title={stepZIndex === stepsZ.length - 1 ? 'Largest Z step' : `Larger Z step (${stepLabel(stepsZ[stepZIndex + 1])} ${units})`}
                      aria-label="Larger Z step">+</button>
                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs font-semibold tabular-nums text-gray-800 dark:text-neutral-100">
                      {stepLabel(stepZMM)}
                    </span>
                  </div>
                </div>
                <button className={`${padBtnCls} ${zDownCuts ? '!border-orange-500 dark:!border-orange-400' : ''}`}
                  onClick={() => jog({ z: -stepZMM })} disabled={!canJog}
                  title={axisLabel('Z', -1) + (zDownCuts ? ' — this step goes below the stock surface' : '')}>
                  <ArrowDown size={JOG_ICON} strokeWidth={JOG_STROKE} />
                </button>
              </div>
            </div>

            {/* The XY step. Z has its own, in the Z column's middle slot. */}
            <div className="flex items-center gap-1 text-xs text-gray-600 dark:text-neutral-400" role="radiogroup" aria-label="XY jog step">
              <span className="w-5">XY</span>
              {steps.map((st, i) => (
                <button key={i} role="radio" aria-checked={i === m.jogStepIndex}
                  onClick={() => m.setJogStepIndex(i)}
                  className={`flex-1 py-0.5 rounded text-xs border tabular-nums ${i === m.jogStepIndex
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700'}`}>
                  {stepLabel(st)}
                </button>
              ))}
              <span className="pl-1">{units}</span>
            </div>

            <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-1.5 text-xs text-gray-600 dark:text-neutral-400"
              title={`Jog feeds, ${feedUnit}`}>
              <span>XY</span>
              <NumericInput value={fromMM(m.jogFeedXY, units)} min={0} unit={feedUnit} title={`XY jog feed (${feedUnit}). ${NUMERIC_HINT}`}
                onChange={(v) => { if (v > 0) m.setJogFeedXY(toMM(v, units)) }} className={inputCls} />
              <span>Z</span>
              <NumericInput value={fromMM(m.jogFeedZ, units)} min={0} unit={feedUnit} title={`Z jog feed (${feedUnit}). ${NUMERIC_HINT}`}
                onChange={(v) => { if (v > 0) m.setJogFeedZ(toMM(v, units)) }} className={inputCls} />
            </div>
          </div>
        </section>

        <OverridesSection sectionCls={sectionCls} headCls={headCls} />
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-3">
      <section className={`${sectionCls} flex-[3] min-h-0 flex flex-col`}>
        <div className={headCls}>Go to</div>
        <div className="flex-1 min-h-0 flex gap-2 p-2">
          <ZBar stockBox={stockBox} />
          <GoToMap enabled={idle && m.zeroed.x && m.zeroed.y} onStockBox={setStockBox} />
        </div>
      </section>

      <section className={`${sectionCls} flex-[2] min-h-0 flex flex-col`}>
        <div className={`${headCls} flex items-center`}>
          <span className="flex-1">Console</span>
          <button className="normal-case tracking-normal font-normal hover:text-gray-800 dark:hover:text-neutral-200" onClick={m.clearLog}>Clear</button>
        </div>
        <div
          ref={logRef}
          className="flex-1 min-h-0 overflow-y-auto m-2 mb-0 rounded bg-white dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 px-2 py-1 font-mono text-xs text-gray-700 dark:text-neutral-300 whitespace-pre-wrap"
        >
          {/* Button actions (realtime control bytes) are set apart from what was typed
              or sent as a line, so nobody tries to type "Feed override +10 %" back in. */}
          {m.log.map((l, i) => l.startsWith(ACTION_MARK)
            ? <div key={i} className="italic text-violet-700 dark:text-violet-300" title="A button action, sent as a realtime control byte — not a command you can type">{l}</div>
            : <div key={i}>{l}</div>)}
        </div>
        <div className="flex gap-2 p-2">
          <input
            className={`${inputCls} font-mono`}
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            disabled={!connected}
            placeholder="G-code or $ command"
          />
          <button className={btnCls} onClick={submit} disabled={!connected}>Send</button>
        </div>
      </section>
      </div>
    </div>
  )
}
