// The button that replaced the escapement's inline readout.
//
// IT CARRIES THE STATUS, which is what makes replacing the readout safe. The text
// went into a floating window (`EscapementInfoPanel`) because it could not be
// read in a 320 px sidebar — but a fatal warning that only appears in a window
// nobody has opened is worse than one nobody can read. So the button takes the
// colour of the worst line: red means it will not run, yellow means look, blue is
// a note, and grey means there is nothing to say.

import { Info } from 'lucide-react'
import { ICON } from '../theme'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore, fmtLen } from '../store/workpieceStore'
import { escapementReadout, worstTone, type Tone } from './escapementReadout'
import type { EscapementSpec } from '../shapes/escapementGenerator'

const TONE_BTN: Record<Tone, string> = {
  plain: 'border-gray-300 dark:border-neutral-600 text-gray-600 dark:text-neutral-300 hover:bg-gray-300 dark:hover:bg-neutral-700',
  note: 'border-blue-500/60 text-blue-500 dark:text-blue-400 hover:bg-blue-500/10',
  warn: 'border-yellow-500/60 text-yellow-600 dark:text-yellow-500 hover:bg-yellow-500/10',
  error: 'border-red-500/70 text-red-600 dark:text-red-400 hover:bg-red-500/10',
}

const TONE_HINT: Record<Tone, string> = {
  plain: 'Escapement numbers',
  note: 'Escapement numbers — something was adjusted to fit',
  warn: 'Escapement numbers — worth a look',
  error: 'This escapement will not run — open for why',
}

export default function EscapementInfoButton({ spec }: { spec: EscapementSpec }) {
  const open = useUIStore((s) => s.escapementInfoOpen)
  const setOpen = useUIStore((s) => s.setEscapementInfoOpen)
  const units = useWorkpieceStore((s) => s.units)
  const tone = worstTone(escapementReadout(spec, (mm) => fmtLen(mm, units as 'mm' | 'in')))

  return (
    <button
      onClick={() => setOpen(!open)}
      title={TONE_HINT[tone]}
      className={[
        'col-span-2 w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded border text-body transition-colors',
        TONE_BTN[tone],
        open ? 'bg-gray-300/60 dark:bg-neutral-700/60' : '',
      ].join(' ')}
    >
      <Info size={ICON.sm} />
      <span>{open ? 'Hide numbers' : 'Numbers'}</span>
      {tone === 'error' && <span className="font-semibold">· will not run</span>}
    </button>
  )
}
