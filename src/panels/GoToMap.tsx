// The go-to map on the Machine tab: the stock, the tool, and the job loaded from the SD
// card — and nothing else. The design open in FreazyKam is NOT drawn: it cannot run until
// it has been sent to the card and loaded (Send to card does both), and a map showing it
// read as though it could. With no job loaded the stock is bare. Only TOOLPATHS are drawn,
// never shapes: a job off the card has none.
// Drawn in WORK coordinates (work zero = the stock's origin point), turned by
// machineStore.mapRotation so it matches the table as the user sees it from where they sit
// — watched from beside the machine, an unturned map runs 90° out from the real one, and a
// job's tool marker looked to be well ahead of (or behind) the bit when it was not. Clicking
// it jogs the tool there in X and Y — only once X and Y have been zeroed from the
// panel, since until then a work position says nothing about where the stock is.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMachineStore } from '../machine/machineStore'
import { stockRectInWork } from '../machine/stockMap'
import { workToMap } from '../machine/mapRotation'
import { useWorkpieceStore, lenValue, MM_PER_INCH } from '../store/workpieceStore'
import { useUIStore } from '../store/uiStore'
import { MATERIAL_COLORS } from '../colors'

// A 1-2-5 grid step giving roughly ten lines across the larger side, in the
// display unit so an inch user gets an inch grid.
function gridStepMM(spanMM: number, units: 'mm' | 'in'): number {
  const unit = units === 'in' ? MM_PER_INCH : 1
  const raw = spanMM / unit / 10
  const pow = 10 ** Math.floor(Math.log10(raw))
  const m = raw / pow
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow * unit
}

// Where the stock rectangle lands on screen, in client px — the Z bar lines up with it.
export interface StockBox { top: number; bottom: number; left: number }

interface Props {
  enabled: boolean
  onStockBox?: (box: StockBox) => void
}

export default function GoToMap({ enabled, onStockBox }: Props) {
  const goTo = useMachineStore((s) => s.goTo)
  const wpos = useMachineStore((s) => s.position.wpos)
  const connected = useMachineStore((s) => s.link === 'connected')
  const zeroed = useMachineStore((s) => s.zeroed)
  const loadedJob = useMachineStore((s) => s.job)
  const job = loadedJob
  const { widthMM, heightMM, origin, units, material } = useWorkpieceStore()
  // The stock in its material's colour, as the canvas draws it — the amber this
  // replaced read as a warning on a tab where amber and red mean Hold and Alarm.
  const darkMode = useUIStore((s) => s.darkMode)
  const stockFill = MATERIAL_COLORS[material][darkMode ? 'dark' : 'light']
  const svgRef = useRef<SVGSVGElement>(null)
  const groupRef = useRef<SVGGElement>(null)
  const stockRef = useRef<SVGRectElement>(null)
  const rotation = useMachineStore((s) => s.mapRotation)
  // The letterboxed view moves the stock with the panel's size as well as with the
  // stock's, so measure after every render and on every resize, reporting changes only.
  const [, setResized] = useState(0)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const ro = new ResizeObserver(() => setResized((n) => n + 1))
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])
  const lastBox = useRef('')
  useLayoutEffect(() => {
    const r = stockRef.current?.getBoundingClientRect()
    if (!r || !onStockBox) return
    const box = { top: r.top, bottom: r.bottom, left: r.left }
    const key = `${box.top.toFixed(1)},${box.bottom.toFixed(1)},${box.left.toFixed(1)}`
    if (key !== lastBox.current) { lastBox.current = key; onStockBox(box) }
  })
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  // Where a click sent the tool, drawn with a dashed line from the tool until that
  // jog is over. Over means the machine went into Jog and came out again — not
  // "the tool is at the target", which a cancelled jog, a soft limit or a job
  // started afterwards would never satisfy, leaving the marker up for good.
  const [target, setTarget] = useState<{ x: number; y: number } | null>(null)
  const machineState = useMachineStore((s) => s.position.state)
  const sawJog = useRef(false)
  useEffect(() => {
    if (!target) return
    if (machineState === 'Jog') sawJog.current = true
    else if (sawJog.current || machineState !== 'Idle') { sawJog.current = false; setTarget(null) }
  }, [machineState, target])
  useEffect(() => { if (!connected) setTarget(null) }, [connected])

  const stock = stockRectInWork(origin, widthMM, heightMM)
  // The view takes in the stock and the loaded job, so a job that runs off the
  // stock is seen to.
  const jb = job?.preview.bounds
  const ext = jb
    ? { minX: Math.min(stock.minX, jb.minX), minY: Math.min(stock.minY, jb.minY), maxX: Math.max(stock.maxX, jb.maxX), maxY: Math.max(stock.maxY, jb.maxY) }
    : stock
  const pad = Math.max(10, 0.08 * Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY))
  const view = { minX: ext.minX - pad, minY: ext.minY - pad, w: ext.maxX - ext.minX + 2 * pad, h: ext.maxY - ext.minY + 2 * pad }
  // The drawing group's transform: Y-flip (work Y up), then the turn, clockwise on screen.
  // The SVG's viewBox is the turned view rectangle's bounds, so the turned map fills the box.
  const toSvg = (x: number, y: number) => workToMap(x, y, rotation)
  const corners = [[view.minX, view.minY], [view.minX + view.w, view.minY], [view.minX, view.minY + view.h], [view.minX + view.w, view.minY + view.h]]
    .map(([x, y]) => toSvg(x, y))
  const vb = {
    x: Math.min(...corners.map((c) => c[0])), y: Math.min(...corners.map((c) => c[1])),
    w: Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0])),
    h: Math.max(...corners.map((c) => c[1])) - Math.min(...corners.map((c) => c[1])),
  }
  const offStock = !!jb && (jb.minX < stock.minX - 0.01 || jb.minY < stock.minY - 0.01 || jb.maxX > stock.maxX + 0.01 || jb.maxY > stock.maxY + 0.01)
  const step = gridStepMM(Math.max(widthMM, heightMM), units)

  // The loaded job's cuts; none without one.
  const jobPolys = useMemo(() => (job ? job.preview.cuts : [])
    .map((poly) => poly.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')), [job])

  const gridLines = useMemo(() => {
    const xs: number[] = [], ys: number[] = []
    for (let x = Math.ceil(stock.minX / step) * step; x <= stock.maxX + 1e-6; x += step) xs.push(x)
    for (let y = Math.ceil(stock.minY / step) * step; y <= stock.maxY + 1e-6; y += step) ys.push(y)
    return { xs, ys }
  }, [stock.minX, stock.minY, stock.maxX, stock.maxY, step])

  // Pointer → work mm, through the DRAWING GROUP's own screen transform: that includes the
  // Y-flip and the turn, so a click on a turned map still lands on the work X/Y under it.
  const toWork = (e: React.PointerEvent | React.MouseEvent) => {
    const ctm = groupRef.current?.getScreenCTM()
    if (!ctm) return null
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    // Tenths of a mm: finer than anyone can click, and keeps the console readable.
    return { x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 }
  }

  const onClick = (e: React.MouseEvent) => {
    if (!enabled) return
    const p = toWork(e)
    if (!p) return
    sawJog.current = false
    setTarget(p)
    void goTo(p.x, p.y)
  }

  // Only against a trusted X/Y zero: otherwise the work position may not be on this stock at all.
  const showTool = connected && zeroed.x && zeroed.y
  const fmt = (mm: number) => lenValue(mm, units, 1)
  const reason = !connected ? 'Connect to the controller'
    : !zeroed.x || !zeroed.y ? 'Zero X and Y on the stock to click-to-go'
    : !enabled ? 'The machine must be Idle'
    : null

  // Marker sizes in mm, scaled to the view so they read the same at any stock size.
  const r = view.w / 120

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <svg
        ref={svgRef}
        className={`w-full h-full ${enabled ? 'cursor-crosshair' : 'cursor-not-allowed'}`}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={(e) => setHover(toWork(e))}
        onPointerLeave={() => setHover(null)}
        onClick={onClick}
      >
        <g ref={groupRef} transform={`rotate(${rotation}) scale(1,-1)`}>
          <rect ref={stockRef} x={stock.minX} y={stock.minY} width={widthMM} height={heightMM}
            fill={stockFill} className="stroke-black/40 dark:stroke-white/40" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {gridLines.xs.map((x) => (
            <line key={`x${x}`} x1={x} x2={x} y1={stock.minY} y2={stock.maxY}
              className="stroke-black/15 dark:stroke-white/15" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {gridLines.ys.map((y) => (
            <line key={`y${y}`} y1={y} y2={y} x1={stock.minX} x2={stock.maxX}
              className="stroke-black/15 dark:stroke-white/15" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {jobPolys.map((pts, i) => (
            <polyline key={`j${i}`} points={pts} fill="none" strokeLinejoin="round"
              className="stroke-blue-600 dark:stroke-sky-400" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
          ))}
          {/* Work zero: X axis red, Y axis green, as on the canvas. */}
          <line x1={0} y1={0} x2={r * 4} y2={0} className="stroke-red-600" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={0} x2={0} y2={r * 4} className="stroke-green-600" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {target && (
            <g className="stroke-blue-600 dark:stroke-blue-400" strokeWidth={1.5} vectorEffect="non-scaling-stroke">
              <circle cx={target.x} cy={target.y} r={r} fill="none" vectorEffect="non-scaling-stroke" />
              <line x1={wpos[0]} y1={wpos[1]} x2={target.x} y2={target.y} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
            </g>
          )}
          {showTool && (
            <g className="stroke-blue-600 dark:stroke-sky-400" strokeWidth={2} vectorEffect="non-scaling-stroke">
              <circle cx={wpos[0]} cy={wpos[1]} r={r * 0.8} className="fill-blue-600/25 dark:fill-sky-400/25" vectorEffect="non-scaling-stroke" />
              <line x1={wpos[0] - r * 1.6} x2={wpos[0] + r * 1.6} y1={wpos[1]} y2={wpos[1]} vectorEffect="non-scaling-stroke" />
              <line y1={wpos[1] - r * 1.6} y2={wpos[1] + r * 1.6} x1={wpos[0]} x2={wpos[0]} vectorEffect="non-scaling-stroke" />
            </g>
          )}
        </g>
      </svg>
      <div className="absolute top-1 left-2 text-xs tabular-nums text-gray-600 dark:text-neutral-400 pointer-events-none">
        {hover ? `X ${fmt(hover.x)}  Y ${fmt(hover.y)} ${units}` : `Grid ${String(Number(lenValue(step, units, 1)))} ${units}`}
      </div>
      {job && (
        <div className="absolute top-1 right-2 text-xs text-right pointer-events-none">
          <div className="text-blue-700 dark:text-sky-400 font-mono">{job.name}</div>
          {jb && (
            <div className="tabular-nums text-gray-600 dark:text-neutral-400">
              X {fmt(jb.minX)}…{fmt(jb.maxX)}  Y {fmt(jb.minY)}…{fmt(jb.maxY)} {units}
            </div>
          )}
          {offStock && <div className="text-amber-700 dark:text-amber-400">Runs off the stock</div>}
        </div>
      )}
      {!job && (
        // The design is never drawn here (it is not on the machine until sent and loaded),
        // so the corner says what IS shown: nothing yet.
        <div className="absolute top-1 right-2 text-xs text-right pointer-events-none text-gray-500 dark:text-neutral-500">
          No job loaded
        </div>
      )}
      {reason && (
        <div className="absolute bottom-1 left-2 text-xs text-amber-700 dark:text-amber-400 pointer-events-none">{reason}</div>
      )}
    </div>
  )
}
