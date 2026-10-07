// Feed, rapid and spindle overrides — realtime, so they act mid-move on a running
// job. The percentages shown are the controller's own (the status report's `Ov:`
// field), not what was clicked, so a clamp at 10% or 200% reads true.

import { RotateCcw } from 'lucide-react'
import { ICON } from '../theme'
import { useMachineStore } from '../machine/machineStore'
import { useWorkpieceStore, fmtFeed } from '../store/workpieceStore'
import type { OverrideStep } from '../machine/fluidnc/jog'

interface Props { sectionCls: string; headCls: string }

const stepBtn = 'px-1.5 py-0.5 rounded text-xs border tabular-nums border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-transparent'

const STEPS: { step: OverrideStep; label: string }[] = [
  { step: 'minus10', label: '−10' },
  { step: 'minus1', label: '−1' },
  { step: 'plus1', label: '+1' },
  { step: 'plus10', label: '+10' },
]

export default function OverridesSection({ sectionCls, headCls }: Props) {
  const m = useMachineStore()
  const units = useWorkpieceStore((s) => s.units)
  const connected = m.link === 'connected'
  const { ov, feed, spindle } = m.position

  const row = (kind: 'feed' | 'spindle', label: string, pct: number, live: string) => (
    <div className="flex items-center gap-1">
      <span className="w-14 text-xs text-gray-600 dark:text-neutral-400">{label}</span>
      {STEPS.slice(0, 2).map(({ step, label: l }) => (
        <button key={step} className={stepBtn} disabled={!connected} onClick={() => m.override(kind, step)}>{l}</button>
      ))}
      <span className={`w-12 text-center text-sm font-semibold tabular-nums ${pct !== 100 ? 'text-amber-700 dark:text-amber-400' : 'text-gray-800 dark:text-neutral-100'}`}>{pct}%</span>
      {STEPS.slice(2).map(({ step, label: l }) => (
        <button key={step} className={stepBtn} disabled={!connected} onClick={() => m.override(kind, step)}>{l}</button>
      ))}
      <button className={`${stepBtn} ml-0.5`} disabled={!connected || pct === 100} onClick={() => m.override(kind, 'reset')} title="Back to 100%">
        <RotateCcw size={ICON.xs} />
      </button>
      <span className="flex-1 text-right text-xs tabular-nums text-gray-600 dark:text-neutral-400 truncate">{live}</span>
    </div>
  )

  return (
    <section className={sectionCls}>
      <div className={headCls}>Overrides</div>
      <div className={`px-3 py-2 space-y-1.5 ${connected ? '' : 'opacity-40'}`}>
        {row('feed', 'Feed', ov.feed, fmtFeed(feed, units))}
        <div className="flex items-center gap-1">
          <span className="w-14 text-xs text-gray-600 dark:text-neutral-400">Rapid</span>
          {([25, 50, 100] as const).map((pct) => (
            <button key={pct} disabled={!connected} onClick={() => m.rapidOverride(pct)}
              className={`flex-1 py-0.5 rounded text-xs border tabular-nums disabled:opacity-40 ${ov.rapid === pct
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700'}`}>
              {pct}%
            </button>
          ))}
        </div>
        {row('spindle', 'Spindle', ov.spindle, `${Math.round(spindle)} rpm`)}
      </div>
    </section>
  )
}
