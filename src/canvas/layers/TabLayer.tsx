// Renders tab markers on paths. When the Tabs form is open, tabs are draggable along the path.

import { memo, useState } from 'react'
import { Group, Rect, Circle } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useTabStore } from '../../store/tabStore'
import { useUIStore } from '../../store/uiStore'
import { flattenPath } from '../../cam/pathFlattener'
import { regenerateAffected } from '../../cam/regenerate'
import type { Pt2 } from '../../cam/pathFlattener'

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
const flatCache = new Map<string, Pt2[][]>()
function flatFor(d: string): Pt2[][] {
  const hit = flatCache.get(d)
  if (hit) return hit
  const polys = flattenPath(d, 0.05)
  // A tabbed path that has been edited away is landfill; keep the map small
  // rather than tracking which strings are still live.
  if (flatCache.size > 64) flatCache.clear()
  flatCache.set(d, polys)
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

  const visuals: TabVisual[] = []
  for (const path of paths) {
    if (!path.visible || path.hidden) continue
    const tabs = allTabs.filter((t) => t.pathId === path.id)
    for (const tab of tabs) {
      const pos = evalPathAtT(path.d, tab.t)
      if (!pos) continue
      visuals.push({ id: tab.id, pathId: path.id, pathD: path.d, x: pos.x, y: pos.y, tx: pos.tx, ty: pos.ty, lengthMM: tab.lengthMM, heightMM: tab.heightMM })
    }
  }

  if (visuals.length === 0) return null

  return (
    <Group listening={tabsFormActive}>
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
