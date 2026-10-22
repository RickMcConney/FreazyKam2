import { useEffect, useMemo, useState } from 'react'
import { X, GripHorizontal } from 'lucide-react'
import { ICON } from '../theme'
import { restartOptions, type RestartKind, type RestartOption } from '../machine/resume'
import { downloadGcode } from '../cam/gcode'
import { useSimStore } from '../store/simStore'
import { useDraggablePanel } from '../panels/useDraggablePanel'

// Restarting the program in the simulator after a job stopped (machine/resume.ts). The
// line it was opened on is where the job stopped — the viewer's highlighted line — and
// there are four sensible restarts around it: carry on from there, redo the interrupted
// pass, recut the part from its start, or skip to the next part (and recut the damaged
// one later with a program of its own). Choosing one moves the simulator to its line, so
// the tool marker shows where it begins; Cancel puts it back where it was.
//
// A floating, draggable, NON-MODAL panel, not a dialog: the simulator behind it is the
// whole point of choosing — a modal backdrop hid exactly the view the choice moves.
// Opens top right, clear of the sidebar and of the middle of the stock.
const INITIAL_POS = { right: 16, top: 64 }

const LABEL: Record<RestartKind, { title: string; how: string }> = {
  continue: { title: 'Carry on from where it stopped', how: 'Comes straight down through the cut already made.' },
  pass: { title: 'Redo the interrupted pass', how: 'From where the tool last came down from safe height.' },
  part: { title: 'Recut this part from its start', how: 'Runs the passes already cut again, through air.' },
  next: { title: 'Skip to the next part', how: 'Leaves this part as it is, to recut later.' },
}

/** The program's own name — our writer puts it, as a comment, on line 1. */
function programName(gcode: string): string {
  const first = gcode.slice(0, gcode.indexOf('\n') >>> 0).trim()
  const m = first.match(/^\(\s*(.+?)\s*\)$|^;\s*(.+)$/)
  const name = (m?.[1] ?? m?.[2] ?? 'program').replace(/[\\/:*?"<>|]+/g, '_').trim()
  return name || 'program'
}

/** Move the simulator to the start of a line (1-based): the stock as it stands there. */
function seekToLine(line: number) {
  const { segments, seekToTime } = useSimStore.getState()
  const seg = segments.find((s) => s.lineIdx >= line - 1)
  if (seg) seekToTime(seg.startTimeS)
}

function detail(o: RestartOption): string {
  if (o.line === null) return o.kind === 'next' ? 'This is the last part.' : 'Not available.'
  const bits = [`Line ${o.line}`]
  if (o.operation) bits.push(o.operation)
  if (o.pass && o.pass.count > 1) bits.push(`pass ${o.pass.index} of ${o.pass.count}`)
  return bits.join(' · ')
}

export default function ResumeDialog({ gcode, line, onClose }: { gcode: string; line: number; onClose: () => void }) {
  const [pause, setPause] = useState(true)
  const options = useMemo(() => restartOptions(gcode, line, { pauseForSpindle: pause }), [gcode, line, pause])
  const usable = (o: RestartOption) => o.line !== null && !!o.result?.ok
  const [kind, setKind] = useState<RestartKind>(() => (options.find(usable) ?? options[0]).kind)
  const chosen = options.find((o) => o.kind === kind)!
  const r = chosen.result?.ok ? chosen.result : null
  const u = r?.units ?? ''

  const choose = (o: RestartOption) => {
    if (!usable(o)) return
    setKind(o.kind)
    seekToLine(o.line!)
  }
  const cancel = () => { seekToLine(line); onClose() }
  const panel = useDraggablePanel(INITIAL_POS)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div
      className="fixed z-40 w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg shadow-2xl border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800"
      style={panel.style}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-gray-300 dark:border-neutral-700 cursor-move select-none"
        onMouseDown={panel.onHeaderMouseDown}
      >
        <GripHorizontal size={ICON.sm} className="text-gray-600 dark:text-neutral-400" />
        <span className="flex-1 text-sm font-semibold text-gray-700 dark:text-neutral-200">Restart the job</span>
        <button onClick={cancel} title="Close" className="text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200 transition-colors">
          <X size={ICON.sm} />
        </button>
      </div>
      <div className="px-4 py-3 max-h-[calc(100vh-8rem)] overflow-y-auto">
        <p className="text-sm text-gray-500 dark:text-neutral-400 mb-3">
          The job stopped at line {line}. Choose where to restart; the simulator moves to show where it begins.
        </p>

        <div className="flex flex-col gap-2 mb-4" role="radiogroup">
          {options.map((o) => {
            const ok = usable(o)
            const on = o.kind === kind
            return (
              <button
                key={o.kind}
                role="radio"
                aria-checked={on}
                disabled={!ok}
                onClick={() => choose(o)}
                className={[
                  'text-left rounded border px-3 py-2 transition-colors',
                  on ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-gray-300 dark:border-neutral-600',
                  ok ? 'hover:border-blue-400' : 'opacity-60 cursor-not-allowed',
                ].join(' ')}
              >
                <div className="text-sm font-medium text-gray-900 dark:text-neutral-100">{LABEL[o.kind].title}</div>
                <div className="text-sm text-gray-600 dark:text-neutral-400">{detail(o)}</div>
                {o.result && !o.result.ok
                  ? <div className="text-sm text-amber-700 dark:text-amber-400">{o.result.reason}</div>
                  : ok && <div className="text-sm text-gray-500 dark:text-neutral-400">{LABEL[o.kind].how}</div>}
              </button>
            )
          })}
        </div>

        {r && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm mb-3">
              {r.tool && (<><dt className="text-gray-500 dark:text-neutral-400">Tool</dt><dd className="text-gray-900 dark:text-neutral-100">{r.tool.replace(/^Tool:\s*/, '')}</dd></>)}
              <dt className="text-gray-500 dark:text-neutral-400">Enters at</dt>
              <dd className="text-gray-900 dark:text-neutral-100 font-mono">X{+r.entry.x.toFixed(4)} Y{+r.entry.y.toFixed(4)} Z{+r.entry.z.toFixed(4)}</dd>
              <dt className="text-gray-500 dark:text-neutral-400">Path</dt>
              <dd className="text-gray-900 dark:text-neutral-100">
                Up to Z{+r.safeZ.toFixed(4)}{u && ` ${u}`}, across,{' '}
                {r.plungeFeed !== null
                  ? `down at ${+r.plungeFeed.toFixed(1)}${u ? ` ${u}/min` : ''}`
                  : 'then the program\'s own entry'}
              </dd>
            </dl>
            {r.warnings.length > 0 && (
              <ul className="text-sm text-amber-700 dark:text-amber-400 mb-3 list-disc pl-5 space-y-1">
                {r.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
            <p className="text-sm text-gray-700 dark:text-neutral-300 mb-3">
              Before running it, X, Y and Z must be zeroed exactly as for the original run. If the
              machine lost power, alarmed or the stock moved, find zero again first.
            </p>
            {r.spindleOn && (
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-neutral-300 mb-4">
                <input type="checkbox" checked={pause} onChange={(e) => setPause(e.target.checked)} />
                Pause after the spindle command, to check the router is running
              </label>
            )}
          </>
        )}

        <div className="flex gap-2">
          <button
            disabled={!r}
            onClick={() => { if (r) { downloadGcode(r.text, `${programName(gcode)}-resume-L${r.line}`); onClose() } }}
            className="flex-1 px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 text-sm font-medium text-white transition-colors"
          >
            Download resume file
          </button>
          <button onClick={cancel} className="px-3 py-2 rounded bg-gray-100 dark:bg-neutral-700 text-sm text-gray-800 dark:text-neutral-200">Cancel</button>
        </div>
      </div>
    </div>
  )
}
