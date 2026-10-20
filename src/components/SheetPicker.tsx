import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ICON } from '../theme'
import { useUIStore } from '../store/uiStore'
import { sheetName, useActiveSheet } from '../canvas/useSheets'
import { useWorkpieceStore } from '../store/workpieceStore'
import { tileCount } from '../cam/tiling'

/**
 * Which sheet of stock Simulate plays and the machine panel runs, when a nest has spread
 * the parts over several (cam/sheets) — or which TILE, on a tiled job (cam/tiling), whose
 * programs are its tiles. Absent for an ordinary one-program job. The export needs no
 * choice — it writes every one, a file each.
 */
export function SheetPicker() {
  const { cells, index: activeSheet } = useActiveSheet()
  const ds = useWorkpieceStore((s) => s.doubleSided)
  const tiling = useWorkpieceStore((s) => s.tiling)
  const activeTileRaw = useUIStore((s) => s.activeTile)
  const tiles = tiling ? tileCount(tiling) : 0
  const count = tiling ? tiles : cells.length
  const active = tiling ? Math.max(0, Math.min(tiles - 1, activeTileRaw)) : activeSheet
  const setActive = (k: number) => tiling
    ? useUIStore.getState().setActiveTile(k)
    : useUIStore.getState().setActiveSheet(cells[k])
  if (count < 2) return null
  const label = tiling ? `Tile ${active + 1} of ${tiles}`
    : ds ? sheetName(cells[active], active, ds) : `Sheet ${active + 1} of ${count}`
  const what = tiling ? 'tile' : 'sheet'
  const btn = 'p-1 rounded text-gray-600 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent'
  return (
    <div className="flex items-center gap-0.5 text-body text-gray-700 dark:text-neutral-300"
      title={`The ${what} Simulate plays and the machine panel runs. Export writes every ${what}.`}>
      <button className={btn} disabled={active === 0} onClick={() => setActive(active - 1)} aria-label={`Previous ${what}`}>
        <ChevronLeft size={ICON.sm} />
      </button>
      <span className="tabular-nums whitespace-nowrap">{label}</span>
      <button className={btn} disabled={active >= count - 1} onClick={() => setActive(active + 1)} aria-label={`Next ${what}`}>
        <ChevronRight size={ICON.sm} />
      </button>
    </div>
  )
}
