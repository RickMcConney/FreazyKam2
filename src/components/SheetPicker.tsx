import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ICON } from '../theme'
import { useUIStore } from '../store/uiStore'
import { useSheetCount } from '../canvas/useSheetCount'

/**
 * Which sheet of stock Simulate plays and the machine panel runs, when a nest has spread
 * the parts over several (cam/sheets). Absent for an ordinary one-sheet drawing. The
 * export needs no choice — it writes every sheet, a file each.
 */
export function SheetPicker() {
  const sheets = useSheetCount()
  const active = Math.min(useUIStore((s) => s.activeSheet), sheets - 1)
  const setActive = useUIStore((s) => s.setActiveSheet)
  if (sheets < 2) return null
  const btn = 'p-1 rounded text-gray-600 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent'
  return (
    <div className="flex items-center gap-0.5 text-body text-gray-700 dark:text-neutral-300"
      title="The sheet Simulate plays and the machine panel runs. Export writes every sheet.">
      <button className={btn} disabled={active === 0} onClick={() => setActive(active - 1)} aria-label="Previous sheet">
        <ChevronLeft size={ICON.sm} />
      </button>
      <span className="tabular-nums whitespace-nowrap">Sheet {active + 1} of {sheets}</span>
      <button className={btn} disabled={active >= sheets - 1} onClick={() => setActive(active + 1)} aria-label="Next sheet">
        <ChevronRight size={ICON.sm} />
      </button>
    </div>
  )
}
