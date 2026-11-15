// Renders tab markers on paths. When the Tabs form is open, tabs are draggable along the path,
// and Shift-click (or Alt-click) deletes one.

import { memo, useMemo, useState } from 'react'
import { useCutHiddenKey, partsOut } from '../holdVisibility'
import { Group, Rect, Circle, Shape } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../viewport'
import { usePathsStore } from '../../store/pathsStore'
import { useTabStore } from '../../store/tabStore'
import { useUIStore } from '../../store/uiStore'
import { tabOutline } from '../../cam/stlOutline'
import { regenerateAffected } from '../../cam/regenerate'
import type { Pt2 } from '../../cam/pathFlattener'
import { drawFrame, nativeCtx, overlaps } from '../batchDraw'
import { pointInPolygon } from '../../cam/geom'

interface TabVisual {
  id: string
  pathId: string
  outline: Pt2[][]
  x: number
  y: number
  tx: number
  ty: number
  lengthMM: number
  heightMM: number
  /** Which side of the path is OUTSIDE the shape: +1 its left (the tangent turned CCW), −1
   *  its right. The handle points that way, into open stock rather than across the part. */
  outSide: 1 | -1
}

// The left of the tangent is outside when a point a hair that way is in none — or an even
// number — of the outline's rings.
export function outsideSide(outline: Pt2[][], x: number, y: number, tx: number, ty: number): 1 | -1 {
  const e = 0.01
  let inside = false
  for (const ring of outline) if (ring.length > 2 && pointInPolygon(x - ty * e, y + tx * e, ring)) inside = !inside
  return inside ? -1 : 1
}

// FLATTENING AT 0.05 mm IS NOT SOMETHING TO DO IN A RENDER — the stage re-renders on every
// mouse move. `tabOutline` (cam/stlOutline) caches the flattened outline per `d` string, and
// an STL model's silhouette per model and box.
function evalPathAtT(subpaths: Pt2[][], t: number): { x: number; y: number; tx: number; ty: number } | null {
  if (subpaths.length === 0) return null

  let totalLen = 0
  const segments: { pts: Pt2[]; startLen: number; segLen: number }[] = []

  for (const sp of subpaths) {
    let len = 0
    for (let i = 1; i < sp.length; i++) {
      len += Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1])
    }
    segments.push({ pts: sp, startLen: totalLen, segLen: len })
    totalLen += len
  }

  if (totalLen < 1e-6) return null
  const target = t * totalLen

  for (const seg of segments) {
    if (target > seg.startLen + seg.segLen && seg !== segments[segments.length - 1]) continue
    let cumLen = seg.startLen
    for (let i = 1; i < seg.pts.length; i++) {
      const dx = seg.pts[i][0] - seg.pts[i - 1][0]
      const dy = seg.pts[i][1] - seg.pts[i - 1][1]
      const edgeLen = Math.hypot(dx, dy)
      if (cumLen + edgeLen >= target || i === seg.pts.length - 1) {
        const u = edgeLen > 1e-10 ? Math.min(1, (target - cumLen) / edgeLen) : 0
        const x = seg.pts[i - 1][0] + u * dx
        const y = seg.pts[i - 1][1] + u * dy
        const mag = Math.max(edgeLen, 1e-10)
        return { x, y, tx: dx / mag, ty: dy / mag }
      }
      cumLen += edgeLen
    }
  }
  return null
}

// Given a CNC-space point, return the arc-length t (0..1) of the nearest point on the path.
function nearestTOnPath(subpaths: Pt2[][], cx: number, cy: number): number {

  let totalLen = 0
  const edges: { x0: number; y0: number; x1: number; y1: number; startLen: number; edgeLen: number }[] = []

  for (const sp of subpaths) {
    for (let i = 1; i < sp.length; i++) {
      const x0 = sp[i - 1][0], y0 = sp[i - 1][1]
      const x1 = sp[i][0], y1 = sp[i][1]
      const edgeLen = Math.hypot(x1 - x0, y1 - y0)
      if (edgeLen < 1e-10) continue
      edges.push({ x0, y0, x1, y1, startLen: totalLen, edgeLen })
      totalLen += edgeLen
    }
  }

  if (totalLen < 1e-6 || edges.length === 0) return 0

  let bestDist = Infinity
  let bestArcLen = 0

  for (const edge of edges) {
    const dx = edge.x1 - edge.x0
    const dy = edge.y1 - edge.y0
    const len2 = edge.edgeLen * edge.edgeLen
    const u = Math.max(0, Math.min(1, ((cx - edge.x0) * dx + (cy - edge.y0) * dy) / len2))
    const px = edge.x0 + u * dx
    const py = edge.y0 + u * dy
    const dist = Math.hypot(cx - px, cy - py)
    if (dist < bestDist) {
      bestDist = dist
      bestArcLen = edge.startLen + u * edge.edgeLen
    }
  }

  return bestArcLen / totalLen
}

interface Props {
  viewport: Viewport
}

// A TAB IS DRAWN AT A SIZE YOU CAN GRAB, NOT AT ITS HEIGHT. Its length along the path is
// real — that is where it holds the part — but never under TAB_MIN_LEN_PX on screen; across
// the path it is TAB_BAR_PX at every zoom, and the dot a fixed size. Height is a Z figure:
// drawn as the bar's width it made a 3 mm tab a sliver a few pixels wide on a large part
// zoomed out, and impossible to find, drag or delete. The strips are drawn the same way
// (never thinner than their grab width — BridgeLayer).
export const TAB_COLOR = '#f59e0b'
const TAB_HOVER_COLOR = '#fcd34d'
const TAB_DRAG_COLOR = '#fde68a'
const TAB_BAR_PX = 10
const TAB_MIN_LEN_PX = 18
const TAB_DOT_PX = 4

/** The marker's half length along the path and half width across it, mm, at `ppu` px/mm. */
function tabMarker(v: { lengthMM: number }, ppu: number): { halfLen: number; halfW: number; dotR: number } {
  return {
    halfLen: Math.max(v.lengthMM, TAB_MIN_LEN_PX / ppu) / 2,
    halfW: TAB_BAR_PX / ppu / 2,
    dotR: TAB_DOT_PX / ppu,
  }
}

// One tab's marker as two paths in CNC mm: the rotated bar and the dot on it.
function tabShapes(v: TabVisual, ppu: number): { bar: Path2D; dot: Path2D } {
  const { halfLen, halfW, dotR } = tabMarker(v, ppu)
  const ux = v.tx, uy = v.ty, nx = -v.ty, ny = v.tx
  const bar = new Path2D()
  bar.moveTo(v.x - ux * halfLen - nx * halfW, v.y - uy * halfLen - ny * halfW)
  bar.lineTo(v.x + ux * halfLen - nx * halfW, v.y + uy * halfLen - ny * halfW)
  bar.lineTo(v.x + ux * halfLen + nx * halfW, v.y + uy * halfLen + ny * halfW)
  bar.lineTo(v.x - ux * halfLen + nx * halfW, v.y - uy * halfLen + ny * halfW)
  bar.closePath()
  const dot = new Path2D()
  dot.arc(v.x, v.y, dotR, 0, 2 * Math.PI)
  return { bar, dot }
}

// THE TABS AS ONE SHAPE while the Tabs form is shut — nothing can be hovered or dragged
// then, and a nest's tabs as three Konva nodes each were repainted on every pan frame.
// Same look as the interactive markers: bar at 0.7, dot rimmed in white.
const TabBatch = memo(function TabBatch({ visuals }: { visuals: TabVisual[] }) {
  const sceneFunc = useMemo(() => {
    return (ctx: Konva.Context, shape: Konva.Shape) => {
      const { ppu, view } = drawFrame(shape)
      const bars = new Path2D(), dots = new Path2D()
      let any = false
      // The marker's size is in screen pixels, so it is built for this frame's zoom.
      const reach = Math.max(TAB_MIN_LEN_PX, TAB_BAR_PX) / ppu
      for (const v of visuals) {
        const r = Math.max(v.lengthMM / 2, reach)
        if (!overlaps({ minX: v.x - r, minY: v.y - r, maxX: v.x + r, maxY: v.y + r }, view)) continue
        const it = tabShapes(v, ppu)
        bars.addPath(it.bar)
        dots.addPath(it.dot)
        any = true
      }
      if (!any) return
      const c = nativeCtx(ctx)
      c.save()
      c.fillStyle = TAB_COLOR
      c.globalAlpha = 0.7
      c.fill(bars)
      c.globalAlpha = 1
      c.fill(dots)
      c.strokeStyle = '#ffffff'
      c.lineWidth = 0.5 / ppu
      c.stroke(dots)
      c.restore()
    }
  }, [visuals])
  return <Shape sceneFunc={sceneFunc} listening={false} perfectDrawEnabled={false} />
})

// Radius, in screen px, a tab can be grabbed within while the Tabs form is open.
const TAB_GRAB_PX = 16
// THE HANDLE: a stem out from the dot, away from the part, to a knob — something to take
// hold of that is not sitting on the outline, where a press is easily read as one on the
// part. Screen pixels, so it is the same size at every zoom. Only while the form is open.
const HANDLE_STEM_PX = 20
const HANDLE_KNOB_PX = 8

/**
 * A tab's marker in its own frame (x along the path, +y to its left): the bar, and the dot and
 * the handle's knob as one shape. TabLayer draws placed tabs with it; HoldPreviewLayer draws
 * the ghost of the one a click would place, so the two are the same size on screen.
 */
export function TabMarker({ lengthMM, outSide, scale, fill }: { lengthMM: number; outSide: 1 | -1; scale: number; fill: string }) {
  const { halfLen, halfW, dotR } = tabMarker({ lengthMM }, scale)
  return (
    <>
      <Rect
        x={-halfLen}
        y={-halfW}
        width={halfLen * 2}
        height={halfW * 2}
        fill={fill}
        opacity={0.7}
      />
      {/* The dot and the knob as ONE filled shape: the two circles and the two lines
          tangent to both, outlined in white round the outside only. */}
      <Shape
        sceneFunc={(ctx, shape) => {
          const r1 = dotR * 1.4, r2 = HANDLE_KNOB_PX / scale
          const d = HANDLE_STEM_PX / scale
          const uy = outSide                    // the knob's centre is at (0, uy·d)
          // A line tangent to both circles on the same side has normal n with
          // n·u = (r1 − r2) / d; the two such normals mirror each other across the stem.
          const k = (r1 - r2) / d, q = Math.sqrt(Math.max(0, 1 - k * k))
          const nA = [q, k * uy], nB = [-q, k * uy]
          const ang = (n: number[]) => Math.atan2(n[1], n[0])
          // Round each circle on the side away from the other: angles increase from +x
          // toward +y, so turning from nA toward +u is increasing when nA × u > 0.
          const far = nA[0] * uy > 0
          ctx.beginPath()
          ctx.moveTo(r1 * nA[0], r1 * nA[1])
          ctx.lineTo(r2 * nA[0], uy * d + r2 * nA[1])
          ctx.arc(0, uy * d, r2, ang(nA), ang(nB), !far)
          ctx.lineTo(r1 * nB[0], r1 * nB[1])
          ctx.arc(0, 0, r1, ang(nB), ang(nA), !far)
          ctx.closePath()
          ctx.fillStrokeShape(shape)
        }}
        fill={fill}
        stroke="#ffffff"
        strokeWidth={1.5 / scale}
      />
    </>
  )
}

// Memoised for the same reason DesignLayer is: the stage re-renders on every
// mouse move and this one walks every path in the document looking for tabs.
export const TabLayer = memo(function TabLayer({ viewport }: Props) {
  const paths = usePathsStore((s) => s.paths)
  const allTabs = useTabStore((s) => s.tabs)
  const updateTabT = useTabStore((s) => s.updateTabT)
  const tabsFormActive = useUIStore((s) => s.tabsFormActive)
  const cutHiddenKey = useCutHiddenKey()
  const { scale } = viewport

  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)

  // Off the paths and tabs alone, so a pan (the viewport prop) recomputes nothing. Tabs are
  // indexed by path once: filtering the whole tab list per path is paths × tabs.
  const visuals = useMemo(() => {
    const byPath = new Map<string, typeof allTabs>()
    for (const t of allTabs) {
      const l = byPath.get(t.pathId)
      if (l) l.push(t)
      else byPath.set(t.pathId, [t])
    }
    const out: TabVisual[] = []
    if (byPath.size === 0) return out
    // Not the tabs of a part that is hidden, or whose every profile is (canvas/holdVisibility).
    const gone = partsOut(paths, cutHiddenKey)
    for (const path of paths) {
      if (gone.has(path.id)) continue
      for (const tab of byPath.get(path.id) ?? []) {
        // A model's tabs sit on its silhouette, every other path's on its own outline.
        const outline = tabOutline(path)
        const pos = evalPathAtT(outline, tab.t)
        if (!pos) continue
        out.push({ id: tab.id, pathId: path.id, outline, x: pos.x, y: pos.y, tx: pos.tx, ty: pos.ty, lengthMM: tab.lengthMM, heightMM: tab.heightMM, outSide: outsideSide(outline, pos.x, pos.y, pos.tx, pos.ty) })
      }
    }
    return out
  }, [paths, allTabs, cutHiddenKey])

  if (visuals.length === 0) return null
  if (!tabsFormActive) return <Group name="tabs" listening={false}><TabBatch visuals={visuals} /></Group>

  return (
    <Group name="tabs" listening={tabsFormActive}>
      {visuals.map((v) => {
        const { halfLen, halfW } = tabMarker(v, scale)
        const rotDeg = Math.atan2(v.ty, v.tx) * 180 / Math.PI
        const isDragging = draggingTabId === v.id
        const isHovered = hoveredTabId === v.id
        const fill = isDragging ? TAB_DRAG_COLOR : isHovered ? TAB_HOVER_COLOR : TAB_COLOR

        return (
          <Group
            key={v.id}
            x={v.x}
            y={v.y}
            rotation={rotDeg}
            onMouseEnter={() => {
              setHoveredTabId(v.id)
              document.body.style.cursor = 'grab'
            }}
            onMouseLeave={() => {
              setHoveredTabId(null)
              if (!isDragging) document.body.style.cursor = ''
            }}
            onMouseDown={(e) => {
              e.cancelBubble = true
              // Shift-click takes the tab away — the same gesture as a strip's. Alt still
              // works, but some Linux window managers keep Alt+click for moving windows, so
              // it never reaches the page there.
              if (e.evt.shiftKey || e.evt.altKey) {
                useTabStore.getState().deleteTab(v.id)
                regenerateAffected(v.pathId)
                document.body.style.cursor = ''
                return
              }
              const stage = e.target.getStage()
              if (!stage) return
              setDraggingTabId(v.id)
              document.body.style.cursor = 'grabbing'

              const outline = v.outline
              const pathId = v.pathId
              const vp = viewport

              const handleMove = () => {
                const pos = stage.getPointerPosition()
                if (!pos) return
                const cncX = (pos.x - vp.x) / vp.scale
                const cncY = (vp.y - pos.y) / vp.scale
                updateTabT(v.id, nearestTOnPath(outline, cncX, cncY))
              }

              const handleUp = () => {
                setDraggingTabId(null)
                setHoveredTabId(null)
                document.body.style.cursor = ''
                stage.off('mousemove', handleMove)
                stage.off('mouseup', handleUp)
                regenerateAffected(pathId)
              }

              stage.on('mousemove', handleMove)
              stage.on('mouseup', handleUp)
            }}
          >
            {/* The grab area: at least TAB_GRAB_PX round the tab on screen whatever the
                zoom. Drawn to scale a 5 mm tab is a few pixels wide zoomed out, and a press
                that missed it landed on the part instead. Invisible — opacity does not
                reach Konva's hit canvas. */}
            <Circle
              radius={Math.max(halfLen, halfW, TAB_GRAB_PX / scale)}
              fill="#000"
              opacity={0}
            />
            <TabMarker lengthMM={v.lengthMM} outSide={v.outSide} scale={scale} fill={fill} />
            {/* Its grab area, a little bigger than the knob. */}
            <Circle
              y={v.outSide * HANDLE_STEM_PX / scale}
              radius={(HANDLE_KNOB_PX + 6) / scale}
              fill="#000"
              opacity={0}
            />
          </Group>
        )
      })}
    </Group>
  )
})
