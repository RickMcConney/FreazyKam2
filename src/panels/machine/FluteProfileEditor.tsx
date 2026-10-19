// ─── Fluting height profile editor ────────────────────────────────────────────
//
// A section along the flute: left is the path's start, right its end, the top edge is the
// surface and the bottom the operation's full depth. The shaded area is what the tool
// takes out. Breakpoints are dragged — the two ends only up and down, the ones between
// anywhere between their neighbours — and snap to the surface, to full depth and to the
// depth of the breakpoint either side, so a level run is easy to hit by hand.
import { useMemo, useRef, useState } from 'react'
import { fluteDepthAt, resampleProfile, type FluteBreakpoint } from '../../cam/fluting'
import { NumericInput } from '../../components/NumericInput'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { OP_TYPE_COLORS } from '../../colors'
import { FIELD_CLS, LengthInput } from './shared'

const W = 280, H = 120
const PAD_X = 10, PAD_TOP = 10, PAD_BOTTOM = 16
const PLOT_W = W - 2 * PAD_X, PLOT_H = H - PAD_TOP - PAD_BOTTOM
// Snap distance, in viewBox units (about a pixel each at the sidebar's width).
const SNAP = 4
// The closest two breakpoints may come, as a fraction of the path.
const MIN_GAP = 0.005
export const MIN_BREAKPOINTS = 2
export const MAX_BREAKPOINTS = 24

const sx = (t: number) => PAD_X + t * PLOT_W
const sy = (depth: number) => PAD_TOP + depth * PLOT_H

const labelCls = 'block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1'

export function FluteProfileEditor({ profile, smooth, depthMM, onChange }: {
  profile: FluteBreakpoint[]
  smooth: boolean
  depthMM: number
  onChange: (profile: FluteBreakpoint[]) => void
}) {
  const units = useWorkpieceStore((s) => s.units)
  const svgRef = useRef<SVGSVGElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [selected, setSelected] = useState(0)
  const sel = Math.min(selected, profile.length - 1)
  const color = OP_TYPE_COLORS.fluting

  // The curve the generator will cut, sampled finely enough to look smooth.
  const curve = useMemo(() => {
    const pts: string[] = []
    for (let i = 0; i <= 140; i++) {
      const t = i / 140
      pts.push(`${sx(t).toFixed(2)},${sy(fluteDepthAt(profile, t, smooth)).toFixed(2)}`)
    }
    return pts
  }, [profile, smooth])

  function toPlot(e: React.PointerEvent): { t: number; depth: number } | null {
    const svg = svgRef.current
    if (!svg) return null
    const r = svg.getBoundingClientRect()
    const vx = ((e.clientX - r.left) / r.width) * W
    const vy = ((e.clientY - r.top) / r.height) * H
    return { t: (vx - PAD_X) / PLOT_W, depth: (vy - PAD_TOP) / PLOT_H }
  }

  function move(i: number, t: number, depth: number) {
    const last = profile.length - 1
    // The ends stay at the ends; the others stay in order.
    const tt = i === 0 ? 0 : i === last ? 1
      : Math.min(profile[i + 1].t - MIN_GAP, Math.max(profile[i - 1].t + MIN_GAP, t))
    let dd = Math.min(1, Math.max(0, depth))
    const snaps = [0, 1, profile[i - 1]?.depth, profile[i + 1]?.depth].filter((v): v is number => v !== undefined)
    for (const v of snaps) if (Math.abs(sy(dd) - sy(v)) <= SNAP) { dd = v; break }
    onChange(profile.map((p, k) => (k === i ? { t: round4(tt), depth: round4(dd) } : p)))
  }

  function onPointerDown(i: number, e: React.PointerEvent) {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setDragging(i)
    setSelected(i)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (dragging === null) return
    const p = toPlot(e)
    if (p) move(dragging, p.t, p.depth)
  }
  const endDrag = () => setDragging(null)

  const p = profile[sel]
  const area = `${sx(0)},${sy(0)} ${curve.join(' ')} ${sx(1)},${sy(0)}`

  return (
    <div className="space-y-2">
      <div>
        <label className={labelCls}>Height Profile</label>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full touch-none select-none rounded border border-gray-400 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-900"
          onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
          {/* Quarter-depth grid */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={sx(0)} x2={sx(1)} y1={sy(f)} y2={sy(f)} className="stroke-gray-300 dark:stroke-neutral-700" strokeWidth={0.5} strokeDasharray="2 3" />
          ))}
          <line x1={sx(0)} x2={sx(1)} y1={sy(1)} y2={sy(1)} className="stroke-gray-400 dark:stroke-neutral-600" strokeWidth={0.75} strokeDasharray="4 3" />
          {/* What the tool takes out, under the stock surface */}
          <polygon points={area} fill={color} fillOpacity={0.18} />
          <polyline points={curve.join(' ')} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" />
          <line x1={sx(0)} x2={sx(1)} y1={sy(0)} y2={sy(0)} className="stroke-gray-500 dark:stroke-neutral-400" strokeWidth={1} />
          {profile.map((q, i) => (
            <g key={i}>
              {/* A wider invisible target than the dot, so a point is easy to grab. */}
              <circle cx={sx(q.t)} cy={sy(q.depth)} r={9} fill="transparent" className="cursor-grab"
                onPointerDown={(e) => onPointerDown(i, e)} />
              <circle cx={sx(q.t)} cy={sy(q.depth)} r={i === sel ? 4.5 : 3.5} pointerEvents="none"
                fill={i === sel ? color : 'white'} stroke={color} strokeWidth={1.5} />
            </g>
          ))}
          <text x={sx(0)} y={H - 4} fontSize={8} className="fill-gray-500 dark:fill-neutral-400">Start</text>
          <text x={sx(1)} y={H - 4} fontSize={8} textAnchor="end" className="fill-gray-500 dark:fill-neutral-400">End</text>
          <text x={sx(0.5)} y={H - 4} fontSize={8} textAnchor="middle" className="fill-gray-500 dark:fill-neutral-400">
            {fmtLen(depthMM, units)} max depth
          </text>
        </svg>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label htmlFor="flute-breakpoints" className={labelCls}>Points</label>
          <NumericInput id="flute-breakpoints" value={profile.length} min={MIN_BREAKPOINTS} max={MAX_BREAKPOINTS} step={1} integer
            onChange={(n) => { onChange(resampleProfile(profile, n, smooth)); setSelected(0) }} className={FIELD_CLS} />
        </div>
        <div>
          <label htmlFor="flute-point-pos" className={labelCls}>Point {sel + 1} at</label>
          <NumericInput id="flute-point-pos" value={round4(p.t * 100)} min={0} max={100} step={1} unit="%"
            onChange={(v) => move(sel, v / 100, p.depth)} className={FIELD_CLS} />
        </div>
        <div>
          <label htmlFor="flute-point-depth" className={labelCls}>Depth</label>
          <LengthInput id="flute-point-depth" valueMM={p.depth * depthMM} minMM={0} maxMM={depthMM} stepMM={0.1}
            onChangeMM={(mm) => move(sel, p.t, depthMM > 0 ? mm / depthMM : 0)} />
        </div>
      </div>
    </div>
  )
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4
}
