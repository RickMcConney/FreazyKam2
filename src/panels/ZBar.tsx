// The Z bar beside the go-to map: where the tool tip is against the stock, side on.
// The scale runs from the stock bottom, level with the bottom edge of the stock as the
// map draws it, to twice the safe height, level with the stock's top edge — so the band the job actually works in
// fills the bar, and the tool sitting at the safe height is always halfway between
// the stock and the top. A tool beyond either end pins there with a chevron; the
// readout beside the tip always says where it really is.
//
// The safe height and the depth come from whatever the map is showing: a job off
// the card says its own (the Z its rapids travel at, its deepest feed move), the
// design says the stock's safe height and its toolpaths' deepest cut.

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { useMachineStore } from '../machine/machineStore'
import { useWorkpieceStore, lenValue, zDatumOffsetMM } from '../store/workpieceStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useUIStore } from '../store/uiStore'
import { MATERIAL_COLORS } from '../colors'
import type { StockBox } from './GoToMap'

export default function ZBar({ stockBox }: { stockBox: StockBox | null }) {
  // Lined up with the stock on the map, and centred between the Go to box's left
  // edge and the stock's: px within this column, which only reserves the room.
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ top: number; height: number; cx: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const panel = el?.closest('section')
    if (!el || !panel || !stockBox) { setPlace(null); return }
    const o = el.getBoundingClientRect()
    setPlace({
      top: stockBox.top - o.top,
      height: stockBox.bottom - stockBox.top,
      cx: (panel.getBoundingClientRect().left + stockBox.left) / 2 - o.left,
    })
  }, [stockBox])

  const connected = useMachineStore((s) => s.link === 'connected')
  const zeroedZ = useMachineStore((s) => s.zeroed.z)
  const toolZ = useMachineStore((s) => s.position.wpos[2])
  const loadedJob = useMachineStore((s) => s.job)
  const job = useMachineStore((s) => s.mapSource === 'job') ? loadedJob : null
  const operations = useToolpathStore((s) => s.operations)
  const { thicknessMM, zOrigin, safeHeightMM, material, units } = useWorkpieceStore()
  const darkMode = useUIStore((s) => s.darkMode)
  const stockFill = MATERIAL_COLORS[material][darkMode ? 'dark' : 'light']

  const zOff = zDatumOffsetMM(zOrigin, thicknessMM)
  const top = zOff, bottom = zOff - thicknessMM
  // Design toolpaths are stored with Z from the stock top; the G-code adds the datum offset.
  const designDeepest = useMemo(() => {
    let min = Infinity
    for (const o of operations) {
      if (!o.visible || o.status !== 'done') continue
      for (const s of o.segments) if (!s.rapid && !s.toolChange) min = Math.min(min, s.z)
    }
    return Number.isFinite(min) ? min : null
  }, [operations])
  const safe = (job ? job.preview.safeZ : null) ?? safeHeightMM + zOff
  const deepest = job ? job.preview.deepestZ : designDeepest === null ? null : designDeepest + zOff
  // The stock bottom, level with the map's: scaling to the deepest cut instead made
  // every job look like it cut through. A cut that really does go deeper still shows.
  const zMin = Math.min(bottom, deepest ?? bottom)
  const zMax = Math.max(2 * safe, top + 1, zMin + 1)
  // Percent from the top of the bar.
  const at = (z: number) => `${((zMax - Math.max(zMin, Math.min(zMax, z))) / (zMax - zMin)) * 100}%`
  const fmt = (mm: number) => lenValue(mm, units, 1)

  const showTool = connected && zeroedZ
  const above = toolZ > zMax, below = toolZ < zMin

  // The indicator is a 20 px column centred in the bar; numbers go to its left,
  // names to its right.
  const left = 'absolute right-[calc(50%+14px)] -translate-y-1/2 text-[10px] leading-none whitespace-nowrap tabular-nums'
  const right = 'absolute left-[calc(50%+14px)] -translate-y-1/2 text-[10px] leading-none whitespace-nowrap'
  const tick = 'absolute left-1/2 -translate-x-1/2 w-7 border-t'
  return (
    <div ref={ref} className="relative w-20 flex-shrink-0 text-gray-600 dark:text-neutral-400">
      <div className={place ? 'absolute w-20' : 'absolute inset-0'}
        style={place ? { top: place.top, height: place.height, left: place.cx - 40 } : undefined}>
        {/* The stock, side on. */}
        <div className="absolute left-1/2 -translate-x-1/2 w-5 border border-black/40 dark:border-white/40"
          style={{ top: at(top), bottom: `calc(100% - ${at(bottom)})`, background: stockFill }}
          title={`Stock: top Z${fmt(top)}, bottom Z${fmt(bottom)} ${units}`} />
        <span className={left} style={{ top: at(top) }}>{fmt(top)}</span>
        {bottom >= zMin && <span className={left} style={{ top: at(bottom) }}>{fmt(bottom)}</span>}
        {/* Work zero, unless the stock's own top or bottom already labels it. */}
        <div className={`${tick} border-gray-500 dark:border-neutral-400`} style={{ top: at(0) }} />
        {top !== 0 && bottom !== 0 && <span className={left} style={{ top: at(0) }}>0</span>}
        <div className={`${tick} border-dashed border-green-600 dark:border-green-400`} style={{ top: at(safe) }}
          title={`Safe height: Z${fmt(safe)} ${units}${job?.preview.safeZ != null ? ' (the job\'s rapids)' : ''}`} />
        <span className={`${right} text-green-700 dark:text-green-400`} style={{ top: at(safe) }}>Safe</span>
        <span className={left} style={{ top: at(safe) }}>{fmt(safe)}</span>
        {deepest !== null && (
          <>
            <div className={`${tick} border-dashed border-blue-600 dark:border-sky-400`} style={{ top: at(deepest) }}
              title={`Deepest cut: Z${fmt(deepest)} ${units}`} />
            <span className={`${right} text-blue-700 dark:text-sky-400`} style={{ top: at(deepest) }}>Max</span>
            <span className={left} style={{ top: at(deepest) }}>{fmt(deepest)}</span>
          </>
        )}
        {/* The tool, its tip at the current Z and its shank running up off the bar. */}
        {showTool && (
          <div className="absolute left-1/2 -translate-x-1/2 w-4 top-0 pointer-events-none" style={{ height: at(toolZ) }}>
            <div className="absolute inset-x-0 top-0 bottom-2 bg-blue-600 dark:bg-sky-400 rounded-t-sm" />
            <div className="absolute inset-x-0 bottom-0 h-2 bg-blue-600 dark:bg-sky-400 [clip-path:polygon(0_0,100%_0,50%_100%)]" />
          </div>
        )}
        {showTool && above && <ChevronUp size={14} className="absolute -top-3.5 left-1/2 -translate-x-1/2" />}
        {showTool && below && <ChevronDown size={14} className="absolute -bottom-3.5 left-1/2 -translate-x-1/2" />}
        {showTool && (
          <span className="absolute left-[calc(50%+12px)] -translate-y-1/2 z-10 px-1 rounded text-[10px] leading-tight font-mono tabular-nums bg-blue-600 text-white dark:bg-sky-400 dark:text-neutral-900 pointer-events-none"
            style={{ top: at(toolZ) }} title="Tool tip, work Z">
            {fmt(toolZ)}
          </span>
        )}
      </div>
    </div>
  )
}
