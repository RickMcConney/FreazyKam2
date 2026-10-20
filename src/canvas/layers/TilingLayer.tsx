import { memo, useMemo, useRef, useState } from 'react'
import { Group, Label, Line, Rect, Tag, Text } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { useToolpathStore, type AnyOperation } from '../../store/toolpathStore'
import { useToolStore } from '../../store/toolStore'
import { useUIStore } from '../../store/uiStore'
import { opCell, sameCell, STOCK_CELL } from '../../cam/sheets'
import { maxCutRadiusMM } from '../../cam/geom'
import { cutSpans, normalizeTiling, seamLimits, spanAt, tileBounds, tileCount } from '../../cam/tiling'
import { applyTiling } from '../../tools/tilingRun'
import { OP_TYPE_COLORS } from '../../colors'

const HIT_PX = 12          // how thick a seam's grab strip is
const SNAP_PX = 12         // how near a clean break must be to pull a seam onto it
const FONT_PX = 12

/**
 * A TILED job's seams (cam/tiling), in SCREEN space on the interactive layer: a line
 * across the board at each seam, each tile's number and length, the picked tile shaded,
 * and a grab strip per seam to drag it along the slide axis.
 *
 * A dragged seam SNAPS — to whole mm (whole inches in inch mode) of tile length, for
 * marking the spoilboard by hand, and, when the cursor is inside a stretch the toolpaths
 * cut, out to the nearest edge of it, where the seam crosses no cut and so leaves no
 * seam mark. Alt drags freely. It is held to `seamLimits`: no tile longer than the machine
 * can reach with its pins, none too short for them.
 */
export const TilingLayer = memo(function TilingLayer({ viewport }: { viewport: Viewport }) {
  const raw = useWorkpieceStore((s) => s.tiling)
  const t = useMemo(() => normalizeTiling(raw), [raw])
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const units = useWorkpieceStore((s) => s.units)
  const dark = useUIStore((s) => s.darkMode)
  const activeTile = useUIStore((s) => s.activeTile)
  const [drag, setDrag] = useState<{ i: number; u: number; clean: boolean } | null>(null)
  const spansRef = useRef<[number, number][]>([])
  // Where the dragged seam is now — read on release, so the commit never sees a stale render.
  const lastU = useRef(0)
  if (!t) return null

  const stock = { widthMM, heightMM }
  const { x: vx, y: vy, scale } = viewport
  const across = t.axis === 'y' ? widthMM : heightMM
  const seams = drag ? t.seamsMM.map((v, i) => (i === drag.i ? drag.u : v)) : t.seamsMM
  const b = tileBounds({ ...t, seamsMM: seams }, stock)
  const n = tileCount(t)
  const picked = Math.max(0, Math.min(n - 1, activeTile))
  const color = OP_TYPE_COLORS.tiling
  // (u along the axis, a across it) in CNC → screen.
  const sx = (u: number, a: number) => vx + (t.axis === 'y' ? a : u) * scale
  const sy = (u: number, a: number) => vy - (t.axis === 'y' ? u : a) * scale

  const startDrag = () => {
    const tools = new Map(useToolStore.getState().tools.map((x) => [x.id, x]))
    const ops = useToolpathStore.getState().operations.filter((op) => op.visible && sameCell(opCell(op, stock), STOCK_CELL))
    const radius = (op: AnyOperation) => { const tool = tools.get(op.toolId); return tool ? maxCutRadiusMM(tool) : 0 }
    spansRef.current = cutSpans(ops, t.axis, radius)
  }

  const snap = (i: number, rawU: number, free: boolean) => {
    const lim = seamLimits(t, stock, i)
    const spans = spansRef.current
    let u = rawU
    if (!free) {
      const unit = units === 'in' ? 25.4 : 1
      u = b[i] + Math.round((rawU - b[i]) / unit) * unit
      const j = spanAt(spans, rawU)
      if (j >= 0) {
        const [e0, e1] = spans[j]
        const near = Math.abs(rawU - e0) <= Math.abs(rawU - e1) ? e0 - 0.5 : e1 + 0.5
        if (Math.abs(near - rawU) * scale <= SNAP_PX) u = near
      }
    }
    u = Math.max(lim.min, Math.min(lim.max, u))
    return { u, clean: spanAt(spans, u) < 0 }
  }

  const setCursor = (e: Konva.KonvaEventObject<MouseEvent>, c: string) => {
    const el = e.target.getStage()?.container()
    if (el) el.style.cursor = c
  }

  const fg = dark ? '#e5e5e5' : '#111827'
  const tagFill = dark ? '#262626' : '#f3f4f6'

  return (
    <Group>
      {/* The picked tile, shaded: what Simulate plays and the machine panel runs. */}
      {n > 1 && (() => {
        const x0 = sx(b[picked], 0), x1 = sx(b[picked + 1], across)
        const y0 = sy(b[picked], 0), y1 = sy(b[picked + 1], across)
        return <Rect x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)}
          fill={color} opacity={0.06} listening={false} />
      })()}

      {Array.from({ length: n }, (_, k) => {
        const mid = (b[k] + b[k + 1]) / 2
        const tx = t.axis === 'y' ? sx(mid, 0) + 6 : sx(mid, across) - 30
        const ty = t.axis === 'y' ? sy(mid, 0) - FONT_PX / 2 : sy(mid, across) + 6
        return (
          <Label key={`l${k}`} x={tx} y={ty} listening={false}>
            <Tag fill={tagFill} opacity={0.85} cornerRadius={3} />
            <Text text={`Tile ${k + 1} · ${fmtLen(b[k + 1] - b[k], units, 0)}`} fontSize={FONT_PX} padding={2}
              fontStyle={k === picked ? 'bold' : 'normal'} fill={fg} />
          </Label>
        )
      })}

      {seams.map((u, i) => {
        const pts = [sx(u, 0), sy(u, 0), sx(u, across), sy(u, across)]
        const dragging = drag?.i === i
        const lineColor = dragging && !drag.clean ? '#dc2626' : color
        // The grab strip, centred on the seam, as wide as the board.
        const strip = t.axis === 'y'
          ? { x: sx(u, 0), y: sy(u, 0) - HIT_PX / 2, width: across * scale, height: HIT_PX }
          : { x: sx(u, 0) - HIT_PX / 2, y: sy(u, across), width: HIT_PX, height: across * scale }
        return (
          <Group key={`s${i}`}>
            <Line points={pts} stroke={lineColor} strokeWidth={dragging ? 2 : 1.5} dash={[8, 5]} listening={false} />
            <Rect {...strip} fill="rgba(0,0,0,0)" draggable
              dragBoundFunc={(pos) => (t.axis === 'y' ? { x: strip.x, y: pos.y } : { x: pos.x, y: strip.y })}
              onMouseEnter={(e) => setCursor(e, t.axis === 'y' ? 'ns-resize' : 'ew-resize')}
              onMouseLeave={(e) => { if (!drag) setCursor(e, '') }}
              onMouseDown={(e) => { e.cancelBubble = true }}
              onMouseUp={(e) => { e.cancelBubble = true }}
              onDragStart={(e) => { e.cancelBubble = true; startDrag(); lastU.current = u; setDrag({ i, u, clean: spanAt(spansRef.current, u) < 0 }) }}
              onDragMove={(e) => {
                e.cancelBubble = true
                const node = e.target
                const rawU = t.axis === 'y'
                  ? (vy - (node.y() + HIT_PX / 2)) / scale
                  : (node.x() + HIT_PX / 2 - vx) / scale
                const s = snap(i, rawU, e.evt.altKey)
                // Hold the strip on the snapped seam.
                if (t.axis === 'y') node.y(sy(s.u, 0) - HIT_PX / 2)
                else node.x(sx(s.u, 0) - HIT_PX / 2)
                lastU.current = s.u
                setDrag({ i, u: s.u, clean: s.clean })
              }}
              onDragEnd={(e) => {
                e.cancelBubble = true
                setCursor(e, '')
                const u2 = lastU.current
                setDrag(null)
                if (Math.abs(u2 - t.seamsMM[i]) > 1e-6) {
                  const next = [...t.seamsMM]
                  next[i] = Math.round(u2 * 1000) / 1000
                  applyTiling({ ...t, seamsMM: next })
                }
              }}
            />
            {dragging && (
              <Label x={sx(u, across) + (t.axis === 'y' ? 8 : 6)} y={sy(u, across) - (t.axis === 'y' ? FONT_PX / 2 + 2 : -6)} listening={false}>
                <Tag fill={tagFill} opacity={0.95} cornerRadius={3} />
                <Text fontSize={FONT_PX} padding={3} fill={drag.clean ? fg : '#dc2626'}
                  text={`${fmtLen(u, units, 1)} · ${drag.clean ? 'clean break' : 'cuts through a toolpath'}`} />
              </Label>
            )}
          </Group>
        )
      })}
    </Group>
  )
})
