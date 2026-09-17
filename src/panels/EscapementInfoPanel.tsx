// The escapement readout, in a window big enough to read it.
//
// The sidebar is 320 px wide and the readout is a dozen lines of numbers that a
// user is stepping a parameter AGAINST — so it was set in the smallest type the
// app has, wrapped three ways, under the very controls being clicked. This is the
// same text at body size, floating over the canvas.
//
// NON-MODAL AND LIVE, which is the whole point: it does not take focus, it does
// not stop the panels being used, and it re-derives from whatever escapement is
// being edited on every render. So a spinner can be held down with the numbers
// changing in view — which is what a readout is for and what the sidebar version
// could not do.
//
// It finds its own subject rather than being handed one, so either panel can open
// it: a selected escapement path if there is one, else the shape tool's own
// config while the escapement tool is active. That also means it survives placing
// a shape — the selection takes over from the tool config with nothing to wire up.

import { useEffect, useRef, useState } from 'react'
import { X, GripHorizontal } from 'lucide-react'
import { ICON } from '../theme'
import { useUIStore } from '../store/uiStore'
import { usePathsStore } from '../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../store/workpieceStore'
import { escapementReadout, type Tone } from './escapementReadout'
import type { EscapementSpec } from '../shapes/escapementGenerator'

const TONE_CLASS: Record<Tone, string> = {
  plain: 'text-gray-600 dark:text-neutral-300',
  note: 'text-blue-500 dark:text-blue-400',
  warn: 'text-yellow-600 dark:text-yellow-500',
  error: 'text-red-600 dark:text-red-400 font-medium',
}

export default function EscapementInfoPanel() {
  const open = useUIStore((s) => s.escapementInfoOpen)
  const setOpen = useUIStore((s) => s.setEscapementInfoOpen)
  const activeTool = useUIStore((s) => s.activeTool)
  const toolConfig = useUIStore((s) => s.shapeToolConfig)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const paths = usePathsStore((s) => s.paths)
  const units = useWorkpieceStore((s) => s.units)

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

  // ANY selected path carrying escapement params, not just a lone one.
  //
  // An escapement is a MULTI-PART shape — wheel, bore, spokes, anchor, arbor
  // bore — and every part carries the same params, so selecting it on the canvas
  // or clicking its timeline chip selects the whole group. A `length === 1` test
  // therefore found the shape only when a single part had been picked out of it,
  // which is the one case a user does not do on purpose. Take the first part that
  // has them and the group, the single part and a mixed selection all work.
  const fromPath = paths.find(
    (p) => selectedIds.includes(p.id) && p.shapeParams?.type === 'escapement',
  )?.shapeParams
  // The selection wins over the tool config: once a shape is on the canvas, that
  // is the one being edited.
  const spec: EscapementSpec | null = fromPath
    ? (fromPath as unknown as EscapementSpec)
    : activeTool === 'escapement'
      ? ({ cx: 0, cy: 0, ...toolConfig.escapement } as unknown as EscapementSpec)
      : null

  // IT CLOSES ITSELF when its subject goes away — the tool is put down and
  // nothing is selected. A readout with nothing to read from is not a window
  // worth leaving over the drawing, and there is no other way to shut it than
  // finding its X, which is a poor trade for a panel this size. Note it survives
  // the HANDOVER between the two sources (place a shape and the selection takes
  // over from the tool config), because that is a frame where `spec` is non-null
  // either way.
  useEffect(() => {
    if (open && !spec) setOpen(false)
  }, [open, spec, setOpen])

  if (!open || !spec) return null

  const len = (mm: number) => fmtLen(mm, units as 'mm' | 'in')
  const lines = escapementReadout(spec, len)

  return (
    <div
      /* Wide enough that every stat sits on ONE line — the longest is the span /
         arbors / pallet-radius row, about 75 characters. The red warnings are
         sentences and are meant to wrap. */
      className="fixed z-40 w-[44rem] max-w-[calc(100vw-2rem)] rounded-lg shadow-2xl border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-800"
      style={pos ? { left: pos.x, top: pos.y } : { left: 340, bottom: 120 }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-gray-300 dark:border-neutral-700 cursor-move select-none"
        onMouseDown={(e) => {
          const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
          drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
          setPos({ x: r.left, y: r.top })
        }}
      >
        <GripHorizontal size={ICON.sm} className="text-gray-600 dark:text-neutral-400" />
        <span className="flex-1 text-sm font-semibold text-gray-700 dark:text-neutral-200">Escapement</span>
        <button
          onClick={() => setOpen(false)}
          title="Close"
          className="text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200 transition-colors"
        >
          <X size={ICON.sm} />
        </button>
      </div>

      <div className="px-3 py-2 max-h-[60vh] overflow-y-auto space-y-1 text-sm leading-relaxed">
        {lines.map((l, i) => <p key={i} className={TONE_CLASS[l.tone]}>{l.text}</p>)}
      </div>
    </div>
  )
}
