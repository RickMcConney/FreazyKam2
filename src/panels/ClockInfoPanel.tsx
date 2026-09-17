// The clock readout, in a window big enough to read it.
//
// Same answer as EscapementInfoPanel's, for a worse case: the clock's numbers ran
// to four sections and a five-column parts table in a 320 px sidebar, set in the
// app's smallest type — and they pushed the Add/Update button off the bottom of
// the tab, so building the clock meant scrolling past everything first.
//
// NON-MODAL AND LIVE: it does not take focus, does not stop the designer being
// used, and re-derives on every render, so a spinner can be held down with the
// numbers changing in view.
//
// Its subject is the spec ClockPanel is editing (published as `uiStore.clockDraft`
// — a clock being designed lives in that panel's form state, unlike an escapement,
// which is found in the selection or the shape-tool config). Failing that it reads
// a SELECTED clock's own spec, so the numbers for a clock already in the document
// can be consulted without reopening the designer.

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, GripHorizontal } from 'lucide-react'
import { ICON } from '../theme'
import { useUIStore } from '../store/uiStore'
import { usePathsStore } from '../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../store/workpieceStore'
import { clockAssemblyFromPaths, clockMotionFromPaths, holdCutModules } from '../shapes/clockTrain'
import { clockReadout, fmtPeriod } from './clockReadout'
import { TONE_CLASS } from './readout'

export default function ClockInfoPanel() {
  const open = useUIStore((s) => s.clockInfoOpen)
  const setOpen = useUIStore((s) => s.setClockInfoOpen)
  const draft = useUIStore((s) => s.clockDraft)
  const toolConfig = useUIStore((s) => s.shapeToolConfig)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const paths = usePathsStore((s) => s.paths)
  const units = useWorkpieceStore((s) => s.units)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)

  // Dragged by its header, because it hangs over the drawing and the one place
  // it is never wanted is on top of the part being looked at.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return
      setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy })
    }
    const up = () => { drag.current = null }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  // The draft wins: while the designer is open, that is the clock being decided.
  // A clock read out of the SELECTION is read as it now stands: a wheel re-cut on
  // its own chip since is taken up as a held module, so the parts table gives the
  // arbor spacings of the wheels that are actually there. `ClockPanel` does the
  // same to the spec it loads, so a draft has already been through this.
  const own = paths.find((p) => selectedIds.includes(p.id) && p.clockSpec)
  // Memoised only for its IDENTITY: it feeds the self-closing effect below, and
  // a fresh object every render would re-run that on every render.
  const fromSelection = useMemo(
    () => (own?.clockSpec
      ? holdCutModules(
        own.clockSpec, toolConfig,
        clockAssemblyFromPaths(paths, own.clockId ?? ''),
        clockMotionFromPaths(paths, own.clockId ?? ''),
      )
      : undefined),
    [own?.clockSpec, own?.clockId, paths, toolConfig],
  )
  const spec = draft ?? fromSelection ?? null

  // IT CLOSES ITSELF when its subject goes away — the designer is shut and no
  // clock is selected. A readout with nothing to read from is not worth leaving
  // over the drawing.
  useEffect(() => {
    if (open && !spec) setOpen(false)
  }, [open, spec, setOpen])

  if (!open || !spec) return null

  const len = (mm: number) => fmtLen(mm, units)
  const r = clockReadout(spec, toolConfig, { widthMM, heightMM }, len)

  return (
    <div
      /* Wide enough for the parts table's five columns and for the warnings,
         which are sentences and are meant to wrap. */
      className="fixed z-40 w-[46rem] max-w-[calc(100vw-2rem)] rounded-lg shadow-2xl border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-800"
      style={pos ? { left: pos.x, top: pos.y } : { left: 340, bottom: 120 }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-gray-300 dark:border-neutral-700 cursor-move select-none"
        onMouseDown={(e) => {
          const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
          drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }
          setPos({ x: box.left, y: box.top })
        }}
      >
        <GripHorizontal size={ICON.sm} className="text-gray-600 dark:text-neutral-400" />
        <span className="flex-1 text-sm font-semibold text-gray-700 dark:text-neutral-200">Clock</span>
        <button
          onClick={() => setOpen(false)}
          title="Close"
          className="text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200 transition-colors"
        >
          <X size={ICON.sm} />
        </button>
      </div>

      <div className="px-3 py-2 max-h-[70vh] overflow-y-auto space-y-3 text-sm leading-relaxed">
        {r.sections.map((sec) => (
          <div key={sec.title} className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-neutral-400">
              {sec.title}
            </p>
            {sec.lines.map((l, i) => <p key={i} className={TONE_CLASS[l.tone]}>{l.text}</p>)}
            {/* The parts table belongs under its own heading, and it is the one
                part of this readout that is not a sentence. */}
            {sec.title === 'Parts' && (
              <div className="overflow-x-auto">
                <table className="w-full tabular-nums">
                  <thead className="text-gray-600 dark:text-neutral-400">
                    <tr>
                      <th className="text-left font-normal pr-2">Part</th>
                      <th className="text-left font-normal pr-2">Counts</th>
                      <th className="text-right font-normal pr-2">Size</th>
                      <th className="text-right font-normal pr-2">One turn</th>
                      <th className="text-right font-normal">Arbor</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-600 dark:text-neutral-300">
                    {r.rows.map((row) => (
                      <tr key={row.name}>
                        <td className="pr-2 text-gray-700 dark:text-neutral-200">{row.name}</td>
                        <td className="pr-2">{row.counts}</td>
                        <td className="pr-2 text-right">{len(row.size)}</td>
                        <td className="pr-2 text-right">{fmtPeriod(row.period)}</td>
                        <td className="text-right" title={`Arbor to arbor, ${row.drives}`}>
                          {row.centre > 0 ? len(row.centre) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
