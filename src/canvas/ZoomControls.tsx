import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { usePathsStore } from '../store/pathsStore'
import { ICON } from '../theme'

// One click of the zoom buttons. Coarser than a wheel notch (1.12) on purpose: a button
// is pressed a few times, not spun, so a notch-sized step would feel like nothing moved.
const ZOOM_BUTTON_STEP = 1.4

// bg-panel/bg-raised/border-ridge/text-norm were never defined in the Tailwind config or
// any stylesheet, so these buttons had no fill and no border colour — just `border`'s
// default gray-200, which reads on a dark canvas and disappears on a light one. Same
// treatment as the simulator's floating controls, which sit over the same canvas.
const ZOOM_BTN_CLASS = 'bg-gray-50/95 dark:bg-neutral-900/95 hover:bg-gray-200 dark:hover:bg-neutral-800 border border-gray-400 dark:border-neutral-700 rounded p-1.5 text-gray-600 dark:text-neutral-300 transition-colors'

export function ZoomControls({ zoomBy, fitToWorkpiece, zoomToActualSize, realPx }: {
  zoomBy: (factor: number) => void
  fitToWorkpiece: () => void
  zoomToActualSize: () => void
  realPx: number | null
}) {
  const hasSelection = usePathsStore((s) => s.selectedIds.length !== 0)
  // Zoom in / fit / out, in that order top to bottom — fit is the middle of the range, so
  // the stack reads as one zoom axis. The two step buttons exist because pinch-zooming a
  // trackpad over the canvas is awkward; they do the same thing the wheel does, anchored on
  // the selected part (or the centre of the view) rather than on the cursor.
  return (
    <div className="absolute bottom-3 right-3 flex flex-col gap-1.5">
      <button onClick={() => zoomBy(ZOOM_BUTTON_STEP)} title={hasSelection ? 'Zoom in on the selection' : 'Zoom in'} className={ZOOM_BTN_CLASS}>
        <ZoomIn size={ICON.md} />
      </button>
      <button onClick={fitToWorkpiece} title="Zoom to fit stock" className={ZOOM_BTN_CLASS}>
        <Maximize2 size={ICON.md} />
      </button>
      <button onClick={() => zoomBy(1 / ZOOM_BUTTON_STEP)} title={hasSelection ? 'Zoom out from the selection' : 'Zoom out'} className={ZOOM_BTN_CLASS}>
        <ZoomOut size={ICON.md} />
      </button>
      {/* Text rather than an icon: "1:1" says what it does, where a ruler glyph would not. */}
      <button onClick={zoomToActualSize}
        title={realPx === null ? 'Actual size — calibrate this screen first' : 'Actual size — parts at their real size on this screen'}
        className={`${ZOOM_BTN_CLASS} font-mono text-[11px] leading-[18px] font-semibold`}>
        1:1
      </button>
    </div>
  )
}
