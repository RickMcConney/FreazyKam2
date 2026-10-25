// Renders tab markers on paths. When the Tabs form is open, tabs are draggable along the path.

import { memo, useMemo, useState } from 'react'
import { Group, Rect, Circle, Shape } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useTabStore } from '../../store/tabStore'
import { useUIStore } from '../../store/uiStore'
import { flattenPath } from '../../cam/pathFlattener'
import { regenerateAffected } from '../../cam/regenerate'
import type { Pt2 } from '../../cam/pathFlattener'
import { drawFrame, nativeCtx, overlaps } from '../batchDraw'

interface TabVisual {
  id: string
  pathId: string
  pathD: string
  x: number
  y: number
  tx: number
  ty: number
  lengthMM: number
  heightMM: number
}

// FLATTENING AT 0.05 mm IS NOT SOMETHING TO DO IN A RENDER. A tab is placed by
// arc length, so both helpers below need the path as polylines — and at that
// tolerance a gear outline is thousands of points. Both ran in the component
// body on EVERY render, once per tab, and the stage re-renders on every mouse
// move (the cursor readout alone is enough), so a clock with holding tabs on
// its wheels paid for the whole flatten to move the mouse one pixel. Cached on
// the `d` string, which is what actually decides the answer: an edit gives a
// new string and a new entry, and the map is bounded by how many distinct
// outlines carry tabs.
//
// Two generations rather than a cap-and-clear: a nest has HUNDREDS of tabbed parts, and a
// 64-entry map cleared when full re-flattened every one of them on every render. An outline
// still drawn is carried over from the old generation; one edited away ages out.
const FLAT_GEN_MAX = 4096
let flatCur = new Map<string, Pt2[][]>()
let flatOld = new Map<string, Pt2[][]>()
function flatFor(d: string): Pt2[][] {
  let polys = flatCur.get(d)
  if (polys) return polys
  polys = flatOld.get(d) ?? flattenPath(d, 0.05)
  if (flatCur.size >= FLAT_GEN_MAX) { flatOld = flatCur; flatCur = new Map() }
  flatCur.set(d, polys)
  return polys
}

function evalPathAtT(d: string, t: number): { x: number; y: number; tx: number; ty: number } | null {
  const subpaths = flatFor(d)
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
function nearestTOnPath(d: string, cx: number, cy: number): number {
  const subpaths = flatFor(d)

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

// Perpendicular visual width is driven by tab.heightMM; length along path is tab.lengthMM
const TAB_COLOR = '#f59e0b'
const TAB_HOVER_COLOR = '#fcd34d'
const TAB_DRAG_COLOR = '#fde68a'

// One tab's marker as two paths in CNC mm: the rotated bar and the dot on it.
function tabShapes(v: TabVisual, dotRadius: number): { bar: Path2D; dot: Path2D } {
  const halfLen = v.lengthMM / 2, halfW = v.heightMM / 2
  const ux = v.tx, uy = v.ty, nx = -v.ty, ny = v.tx
  const bar = new Path2D()
  bar.moveTo(v.x - ux * halfLen - nx * halfW, v.y - uy * halfLen - ny * halfW)
  bar.lineTo(v.x + ux * halfLen - nx * halfW, v.y + uy * halfLen - ny * halfW)
  bar.lineTo(v.x + ux * halfLen + nx * halfW, v.y + uy * halfLen + ny * halfW)
  bar.lineTo(v.x - ux * halfLen + nx * halfW, v.y - uy * halfLen + ny * halfW)
  bar.closePath()
  const dot = new Path2D()
  dot.arc(v.x, v.y, dotRadius, 0, 2 * Math.PI)
  return { bar, dot }
}

// THE TABS AS ONE SHAPE while the Tabs form is shut — nothing can be hovered or dragged
// then, and a nest's tabs as three Konva nodes each were repainted on every pan frame.
// Same look as the interactive markers: bar at 0.7, dot rimmed in white.
const TabBatch = memo(function TabBatch({ visuals }: { visuals: TabVisual[] }) {
  const sceneFunc = useMemo(() => {
    const items = visuals.map((v) => {
      const r = Math.max(v.lengthMM, v.heightMM) / 2
      return { ...tabShapes(v, v.heightMM / 2 * 0.6), minX: v.x - r, minY: v.y - r, maxX: v.x + r, maxY: v.y + r }
    })
    return (ctx: Konva.Context, shape: Konva.Shape) => {
      const { ppu, view } = drawFrame(shape)
      const bars = new Path2D(), dots = new Path2D()
      let any = false
      for (const it of items) {
        if (!overlaps(it, view)) continue
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

// Memoised for the same reason DesignLayer is: the stage re-renders on every
// mouse move and this one walks every path in the document looking for tabs.
export const TabLayer = memo(function TabLayer({ viewport }: Props) {
  const paths = usePathsStore((s) => s.paths)
  const allTabs = useTabStore((s) => s.tabs)
  const updateTabT = useTabStore((s) => s.updateTabT)
  const tabsFormActive = useUIStore((s) => s.tabsFormActive)
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
    for (const path of paths) {
      if (!path.visible || path.hidden) continue
      for (const tab of byPath.get(path.id) ?? []) {
        const pos = evalPathAtT(path.d, tab.t)
        if (!pos) continue
        out.push({ id: tab.id, pathId: path.id, pathD: path.d, x: pos.x, y: pos.y, tx: pos.tx, ty: pos.ty, lengthMM: tab.lengthMM, heightMM: tab.heightMM })
      }
    }
    return out
  }, [paths, allTabs])

  if (visuals.length === 0) return null
  if (!tabsFormActive) return <Group name="tabs" listening={false}><TabBatch visuals={visuals} /></Group>

  return (
    <Group name="tabs" listening={tabsFormActive}>
      {visuals.map((v) => {
        const halfLen = v.lengthMM / 2
        const halfW = v.heightMM / 2
        const rotDeg = Math.atan2(v.ty, v.tx) * 180 / Math.PI
        const isDragging = draggingTabId === v.id
        const isHovered = hoveredTabId === v.id
        const fill = isDragging ? TAB_DRAG_COLOR : isHovered ? TAB_HOVER_COLOR : TAB_COLOR
        const dotRadius = tabsFormActive ? halfW * 0.8 : halfW * 0.6

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
              const stage = e.target.getStage()
              if (!stage) return
              setDraggingTabId(v.id)
              document.body.style.cursor = 'grabbing'

              const pathD = v.pathD
              const pathId = v.pathId
              const vp = viewport

              const handleMove = () => {
                const pos = stage.getPointerPosition()
                if (!pos) return
                const cncX = (pos.x - vp.x) / vp.scale
                const cncY = (vp.y - pos.y) / vp.scale
                updateTabT(v.id, nearestTOnPath(pathD, cncX, cncY))
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
            <Rect
              x={-halfLen}
              y={-halfW}
              width={v.lengthMM}
              height={halfW * 2}
              fill={fill}
              opacity={0.7}
            />
            <Circle
              radius={dotRadius}
              fill={fill}
              stroke="#ffffff"
              strokeWidth={0.5 / scale}
            />
          </Group>
        )
      })}
    </Group>
  )
})
