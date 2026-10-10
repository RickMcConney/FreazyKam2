// Feed, rapid and spindle overrides — realtime, so they act mid-move on a running
// job. The percentages shown are the controller's own (the status report's `Ov:`
// field), not what was clicked, so a clamp at 10% or 200% reads true.
//
// Each row's live value sits UNDER its label rather than at the end of the row: the
// end of the row was what was left after the buttons, and a feed was cut to "120…".

import { RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react'
import { ICON } from '../theme'
import { useMachineStore } from '../machine/machineStore'
import { useWorkpieceStore, fmtFeed } from '../store/workpieceStore'
import { SPINDLE_INFO, spindleDialLabel } from '../store/spindle'

interface Props { sectionCls: string; headCls: string }

const stepBtn = 'flex items-center justify-center px-1.5 py-0.5 rounded text-xs border tabular-nums border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-transparent'
const labelCol = 'flex-1 min-w-0 flex flex-col leading-tight'
const labelCls = 'text-xs text-gray-600 dark:text-neutral-400'
const liveCls = 'text-[10px] tabular-nums text-gray-500 dark:text-neutral-500 whitespace-nowrap'


export default function OverridesSection({ sectionCls, headCls }: Props) {
  const m = useMachineStore()
  const units = useWorkpieceStore((s) => s.units)
  const spindleType = useWorkpieceStore((s) => s.spindleType)
  const connected = m.link === 'connected'
  const { ov, feed, spindle } = m.position

  // The status report's feed is the ACTUAL one, override included; what the program
  // asked for is that divided back out, shown beside it while the two differ.
  const feedLive = ov.feed !== 100 && feed > 0
    ? `${units === 'in' ? (feed / (ov.feed / 100) / 25.4).toFixed(1) : Math.round(feed / (ov.feed / 100))} → ${fmtFeed(feed, units)}`
    : fmtFeed(feed, units)

  const row = (kind: 'feed' | 'spindle', label: string, pct: number, live: string) => (
    <div className="flex items-center gap-1">
      <div className={labelCol}>
        <span className={labelCls}>{label}</span>
        <span className={liveCls}>{live}</span>
      </div>
      {/* 10 % a press, to the next multiple of 10. */}
      <button className={stepBtn} disabled={!connected || pct <= 10} onClick={() => m.overrideStep(kind, -1)}
        title={`${label} −10 %`} aria-label={`${label} down 10 percent`}>
        <ChevronLeft size={ICON.sm} />
      </button>
      {/* Blue, not amber, when changed: amber is Hold on this tab, and 115% is a
          choice, not a fault. */}
      <span className={`w-12 text-center text-sm font-semibold tabular-nums ${pct !== 100 ? 'text-blue-600 dark:text-sky-400' : 'text-gray-800 dark:text-neutral-100'}`}>{pct}%</span>
      <button className={stepBtn} disabled={!connected || pct >= 200} onClick={() => m.overrideStep(kind, 1)}
        title={`${label} +10 %`} aria-label={`${label} up 10 percent`}>
        <ChevronRight size={ICON.sm} />
      </button>
      <button className={`${stepBtn} ml-0.5`} disabled={!connected || pct === 100} onClick={() => m.override(kind, 'reset')} title="Back to 100%">
        <RotateCcw size={ICON.xs} />
      </button>
    </div>
  )

  // A router set by its own dial ignores S, so a spindle override would change a
  // number nothing reads. Say instead what to turn the dial to for the speed the
  // program asks for — the thing an operator can act on mid-job.
  const byHand = spindleType !== 'vfd'
  // The reported speed includes any spindle override left over; the dial wants the program's S.
  const asked = ov.spindle > 0 ? spindle / (ov.spindle / 100) : spindle
  const dial = asked > 0 ? spindleDialLabel(spindleType, asked) : null
  const spindleRow = byHand
    ? (
      <div className="flex items-center gap-1" title={`${SPINDLE_INFO[spindleType].label}: its speed is set by hand, so a spindle override would do nothing. Change the spindle type in Setup if the controller drives it.`}>
        <div className={labelCol}>
          <span className={labelCls}>{SPINDLE_INFO[spindleType].dial ? 'Router' : 'Spindle'}</span>
          <span className={liveCls}>set by hand</span>
        </div>
        <span className="text-sm font-semibold tabular-nums text-gray-800 dark:text-neutral-100">
          {asked > 0 ? (dial ? `${dial[0].toUpperCase()}${dial.slice(1)}` : `${Math.round(asked)} rpm`) : '—'}
        </span>
        {asked > 0 && dial && <span className="text-xs tabular-nums text-gray-600 dark:text-neutral-400">({Math.round(asked).toLocaleString()} rpm)</span>}
        {asked <= 0 && <span className="text-xs text-gray-500 dark:text-neutral-500">no speed asked for yet</span>}
      </div>
    )
    : row('spindle', 'Spindle', ov.spindle, `${Math.round(spindle)} rpm`)

  return (
    <section className={sectionCls}>
      <div className={headCls}>Overrides</div>
      <div className={`px-3 py-2 space-y-1.5 ${connected ? '' : 'opacity-40'}`}>
        {row('feed', 'Feed', ov.feed, feedLive)}
        <div className="flex items-center gap-1">
          <div className={labelCol}><span className={labelCls}>Rapid</span></div>
          {/* The same width as the other rows' controls, so the three line up. */}
          <div className="flex gap-1 w-[8.5rem] flex-shrink-0">
          {([25, 50, 100] as const).map((pct) => (
            <button key={pct} disabled={!connected} onClick={() => m.rapidOverride(pct)}
              className={`flex-1 py-0.5 rounded text-xs border tabular-nums disabled:opacity-40 ${ov.rapid === pct
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700'}`}>
              {pct}%
            </button>
          ))}
          </div>
        </div>
        {spindleRow}
      </div>
    </section>
  )
}
