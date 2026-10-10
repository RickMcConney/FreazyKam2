import { useState } from 'react'
import { ArrowDownToLine, ArrowUp, Check, ChevronDown, ChevronRight, Home, Power, PowerOff } from 'lucide-react'
import { ICON } from '../theme'
import { useMachineStore, safeWorkZ } from '../machine/machineStore'
import { useWorkpieceStore, lenValue, fromMM, toMM } from '../store/workpieceStore'
import { NumericInput } from '../components/NumericInput'
import { NUMERIC_HINT } from '../components/parseNumeric'
import type { Axis } from '../machine/fluidnc/jog'

// HOME & ZERO — homing, work zero, the motors, the move back to work zero, and the Z
// touch plate. It sits in the control column right under the jog pad, since zeroing is
// jogging to the stock and then pressing Zero; the ✓ marks say at a glance why Run (in the
// sidebar's job box) is or is not ready. Home stays with Zero because homing can bring
// back a zero set earlier in the session, and the ✓ marks show it.

const sectionCls = 'rounded-lg border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-800'
const headCls = 'px-3 py-1.5 border-b border-gray-300 dark:border-neutral-700 text-label font-semibold uppercase tracking-wider text-gray-600 dark:text-neutral-400'
// A compact number field for the probe's settings, in the display units.
const fieldCls = 'w-full min-w-0 px-1 py-0.5 rounded border border-gray-400 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-gray-800 dark:text-neutral-200 text-xs text-right'

const smallBtnCls = 'flex items-center justify-center gap-1 h-7 rounded text-xs font-semibold border border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-transparent'

export default function HomeZeroSection() {
  const m = useMachineStore()
  const units = useWorkpieceStore((s) => s.units)
  const origin = useWorkpieceStore((s) => s.origin)
  const zOrigin = useWorkpieceStore((s) => s.zOrigin)
  const connected = m.link === 'connected'
  const p = m.position
  // Zeroing (G10) and go-to are refused mid-motion, so both wait for Idle.
  const idle = connected && p.state === 'Idle'
  // Homing is how a machine with switches leaves the startup Alarm, so Alarm allows it.
  const canHome = connected && (p.state === 'Idle' || p.state === 'Alarm')
  const [probeOpen, setProbeOpen] = useState(false)
  const canProbe = idle && !p.sd && !m.probing && m.macroRunning === null && !p.probe
  const lenUnit = units === 'in' ? 'in' : 'mm'
  const feedUnit = units === 'in' ? 'in/min' : 'mm/min'
  // A probe setting, shown in the display units, stored in mm.
  const probeField = (key: 'probePlateMM' | 'probeSearchMM' | 'probeFeedMmMin' | 'probeSlowMmMin', label: string, unit: string,
    minMM: number, step: number, title?: string) => (
    <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-neutral-400" title={title}>
      <span className="w-20 flex-shrink-0">{label}</span>
      <NumericInput value={fromMM(m[key], units)} min={fromMM(minMM, units)} step={step}
        onChange={(v) => m.setProbe({ [key]: toMM(v, units) })} className={fieldCls} title={NUMERIC_HINT} />
      <span className="w-12 flex-shrink-0">{unit}</span>
    </label>
  )

  // Probe Z's tooltip. When it is ready to go it names the plate thickness too: that is what
  // decides where Z0 lands, and it now lives behind Settings.
  const search = `${lenValue(m.probeSearchMM, units, 1)} ${lenUnit}`
  const probeTitle = !connected ? 'Connect first'
    : p.probe ? 'The probe reads touching already — clear the plate from the bit, or check the clip and lead'
    : m.probing ? 'Probing…'
    : !idle ? 'Wait for the machine to stop'
    : (zOrigin === 'bottom'
      ? `Plate on the TABLE beside the stock, under the bit, clip on the bit, then probe down up to ${search}: Z0 goes on the table, the stock's bottom`
      : `Plate on the stock under the bit, clip on the bit, then probe down up to ${search}: Z0 goes on the stock top`)
      + ` — plate ${lenValue(m.probePlateMM, units, 3)} ${lenUnit} (Settings)`

  return (
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
          {/* Z touch plate: its settings and any probe error sit right under it. The probe
              light is on the go-to map above STOP (ProbeLight), big enough to read from the
              machine. */}
          <span className="text-xs text-gray-600 dark:text-neutral-400">Probe</span>
          <button className={`${smallBtnCls} col-span-2`} onClick={() => void m.probeZ()} disabled={!canProbe}
            title={probeTitle}>
            <ArrowDownToLine size={ICON.xs} /> {m.probing ? 'Probing…' : 'Probe Z'}
          </button>
          {/* The probe's settings open right under its row: the plate first (it decides
              where Z0 lands), then how far to search and how fast. */}
          <button className={`${smallBtnCls} col-span-2`} onClick={() => setProbeOpen(!probeOpen)}
            title={`Probe settings — plate ${lenValue(m.probePlateMM, units, 3)} ${lenUnit}, search ${lenValue(m.probeSearchMM, units, 1)} ${lenUnit}`}>
            {probeOpen ? <ChevronDown size={ICON.xs} /> : <ChevronRight size={ICON.xs} />} Settings
          </button>
          {probeOpen && (
            <div className="col-span-5 space-y-1 rounded border border-gray-300 dark:border-neutral-700 p-1.5">
              {probeField('probePlateMM', 'Plate', lenUnit, 0, units === 'in' ? 0.001 : 0.1,
                'Touch plate thickness — measure yours: Z0 is set this far below where the bit touches the plate')}
              {probeField('probeSearchMM', 'Search', lenUnit, 1, units === 'in' ? 0.1 : 1, 'How far down to look for the plate before giving up')}
              {probeField('probeFeedMmMin', 'Fast feed', feedUnit, 5, units === 'in' ? 0.1 : 1, 'The first touch, to find the plate')}
              {probeField('probeSlowMmMin', 'Slow feed', feedUnit, 1, units === 'in' ? 0.1 : 1, 'The second touch, for accuracy')}
            </div>
          )}
          {m.probeError && <p className="col-span-5 text-xs text-red-600 dark:text-red-400">{m.probeError}</p>}
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
  )
}
