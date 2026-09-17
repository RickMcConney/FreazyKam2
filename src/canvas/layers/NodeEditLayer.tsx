import { memo, useState } from 'react'
import { Group, Path, Line, Circle, Shape } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import type { PathNode } from '../nodeUtils'
import { nodesToD, nearestSegmentOnPath, nearestPointOnSegment, segmentMidpoint } from '../nodeUtils'

export type CrossPathEntry = {
  pathId: string
  nodeIdx: number
  x: number
  y: number
  nodes: PathNode[]
  closed: boolean
}

interface Props {
  viewport: Viewport
  nodes: PathNode[]
  closed: boolean
  hoveredNodeIdx: number | null
  weldTargetIdx?: number | null
  crossPathCandidates?: CrossPathEntry[]
  crossPathWeldTarget?: CrossPathEntry | null
  connectSourceIdx?: number | null
  connectPreviewTo?: { x: number; y: number } | null
  connectSnapTargetIdx?: number | null
  /** Live view of the stage's space key — a pan press must not be swallowed here. */
  spaceHeldRef?: { readonly current: boolean }
  onNodeMouseDown: (nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => void
  onSegmentMouseDown: (segIdx: number, cncX: number, cncY: number) => void
  onHoveredNodeChange: (idx: number | null) => void
  onHoverSegChange?: (segIdx: number | null) => void
}

const ANCHOR_R = 7
const HANDLE_R = 5
const STROKE_COLOR = '#38bdf8'
const HANDLE_COLOR = '#94a3b8'
const HOVERED_COLOR = '#ef4444'
const WELD_COLOR = '#22c55e'
const CONNECT_COLOR = '#f59e0b'
const INSERT_COLOR = '#38bdf8'
const INSERT_CENTER_COLOR = '#f59e0b'
const INSERT_THRESHOLD_PX = 8
const CENTER_SNAP_THRESHOLD_PX = 12

type HoverInsert = { x: number; y: number; segIdx: number; snapCenter: boolean }

// A press that belongs to the STAGE, not to this layer: middle button, or left
// button with space held, both of which start a pan (`handleStageMouseDown`
// owns that rule; this only has to agree with it). Konva children run BEFORE
// the stage handler and every one of ours cancels the bubble, so swallowing one
// of these presses kills the pan before it starts — which is why a pan could
// not be begun anywhere over the path being point-edited.
function isStagePress(e: Konva.KonvaEventObject<MouseEvent>, spaceHeld?: { readonly current: boolean }) {
  return e.evt.button !== 0 || spaceHeld?.current === true
}

export function NodeEditLayer({
  viewport,
  nodes,
  closed,
  hoveredNodeIdx,
  spaceHeldRef,
  weldTargetIdx,
  crossPathCandidates,
  crossPathWeldTarget,
  connectSourceIdx,
  connectPreviewTo,
  connectSnapTargetIdx,
  onNodeMouseDown,
  onSegmentMouseDown,
  onHoveredNodeChange,
  onHoverSegChange,
}: Props) {
  const { scale: s } = viewport
  const [hoverInsert, setHoverInsert] = useState<HoverInsert | null>(null)

  const updateHoverInsert = (h: HoverInsert | null) => {
    setHoverInsert(h)
    onHoverSegChange?.(h?.segIdx ?? null)
  }

  if (nodes.length === 0) return null

  const pathD = nodesToD(nodes, closed)

  const toCNC = (pointer: { x: number; y: number }) => ({
    x: (pointer.x - viewport.x) / viewport.scale,
    y: (viewport.y - pointer.y) / viewport.scale,
  })

  const handleSegmentMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) { updateHoverInsert(null); return }
    const { x: cncX, y: cncY } = toCNC(pointer)

    const nearest = nearestSegmentOnPath(nodes, closed, cncX, cncY)
    if (!nearest) { updateHoverInsert(null); return }

    const pt = nearestPointOnSegment(nodes, nearest.segIdx, cncX, cncY)
    const threshSq = (INSERT_THRESHOLD_PX / s) ** 2
    if (pt.distSq > threshSq) { updateHoverInsert(null); return }

    const mid = segmentMidpoint(nodes, nearest.segIdx)
    const midScreenDistSq = ((mid.x - pt.x) * s) ** 2 + ((mid.y - pt.y) * s) ** 2
    const snapCenter = midScreenDistSq < CENTER_SNAP_THRESHOLD_PX ** 2

    updateHoverInsert({
      x: snapCenter ? mid.x : pt.x,
      y: snapCenter ? mid.y : pt.y,
      segIdx: nearest.segIdx,
      snapCenter,
    })
  }

  const handleSegmentMouseLeave = () => updateHoverInsert(null)

  const handleSegmentMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (isStagePress(e, spaceHeldRef)) return
    e.cancelBubble = true

    if (hoverInsert?.snapCenter) {
      onSegmentMouseDown(hoverInsert.segIdx, hoverInsert.x, hoverInsert.y)
      return
    }

    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const { x: cncX, y: cncY } = toCNC(pointer)

    const nearest = nearestSegmentOnPath(nodes, closed, cncX, cncY)
    if (!nearest) return
    const threshSq = (INSERT_THRESHOLD_PX / s) ** 2
    if (nearest.distSq > threshSq) return
    onSegmentMouseDown(nearest.segIdx, cncX, cncY)
  }

  return (
    <Group>
      {/* Wide invisible hit area for segment hover + clicks */}
      {pathD && (
        <Path
          data={pathD}
          stroke="transparent"
          strokeWidth={12 / s}
          // NOT `fill="transparent"`: a fill Konva can see makes the whole
          // INTERIOR a hit region, so every press inside a closed path landed
          // here and had its bubble cancelled — a pan, a drag box or a click
          // meaning "leave point edit" could never start there. Only the
          // stroke band is a segment, so only the stroke band is hittable.
          fillEnabled={false}
          hitStrokeWidth={12 / s}
          listening
          onMouseMove={handleSegmentMouseMove}
          onMouseLeave={handleSegmentMouseLeave}
          onMouseDown={handleSegmentMouseDown}
        />
      )}

      {/* Visible path outline */}
      {pathD && (
        <Path
          data={pathD}
          stroke={STROKE_COLOR}
          strokeWidth={1.5 / s}
          fill="transparent"
          listening={false}
        />
      )}

      {/* Handle lines and circles */}
      {nodes.map((node, i) => (
        <NodeHandles
          key={i}
          node={node}
          nodeIdx={i}
          scale={s}
          spaceHeldRef={spaceHeldRef}
          onMouseDown={onNodeMouseDown}
        />
      ))}

      {/* Connect mode preview line */}
      {connectSourceIdx != null && connectPreviewTo && nodes[connectSourceIdx] && (
        <Line
          points={[nodes[connectSourceIdx].x, nodes[connectSourceIdx].y, connectPreviewTo.x, connectPreviewTo.y]}
          stroke={CONNECT_COLOR}
          strokeWidth={1.5 / s}
          dash={[4 / s, 3 / s]}
          listening={false}
        />
      )}

      {/* Anchor circles (rendered last = on top) */}
      {nodes.map((node, i) => {
        const isWeldTarget = weldTargetIdx === i
        const isConnectSrc = connectSourceIdx === i
        const isConnectSnap = connectSnapTargetIdx === i
        const isHovered = hoveredNodeIdx === i
        const fill = isWeldTarget ? WELD_COLOR : isConnectSrc ? CONNECT_COLOR : isConnectSnap ? CONNECT_COLOR : isHovered ? HOVERED_COLOR : i === 0 ? '#0f172a' : '#1e293b'
        const stroke = isWeldTarget ? WELD_COLOR : isConnectSrc ? CONNECT_COLOR : isConnectSnap ? CONNECT_COLOR : isHovered ? HOVERED_COLOR : i === 0 ? '#ffffff' : STROKE_COLOR
        const r = (isWeldTarget || isConnectSrc || isConnectSnap) ? (ANCHOR_R + 3) / s : ANCHOR_R / s
        return (
          <Circle
            key={i}
            x={node.x}
            y={node.y}
            radius={r}
            fill={fill}
            stroke={stroke}
            strokeWidth={1.5 / s}
            listening
            onMouseEnter={() => onHoveredNodeChange(i)}
            onMouseLeave={() => onHoveredNodeChange(null)}
            onMouseDown={(e) => {
              if (isStagePress(e, spaceHeldRef)) return
              e.cancelBubble = true
              onNodeMouseDown(i, 'anchor', e)
            }}
          />
        )
      })}

      {/* Insert preview point */}
      {hoverInsert && (
        <Circle
          x={hoverInsert.x}
          y={hoverInsert.y}
          radius={ANCHOR_R / s}
          fill={hoverInsert.snapCenter ? INSERT_CENTER_COLOR : 'transparent'}
          stroke={hoverInsert.snapCenter ? INSERT_CENTER_COLOR : INSERT_COLOR}
          strokeWidth={1.5 / s}
          opacity={0.85}
          listening={false}
        />
      )}

      {/* Cross-path weld candidates (faint rings shown during endpoint drag) */}
      <CrossPathRings candidates={crossPathCandidates} scale={s} />
      {crossPathWeldTarget && (
        <Circle
          x={crossPathWeldTarget.x}
          y={crossPathWeldTarget.y}
          radius={(ANCHOR_R + 3) / s}
          fill={WELD_COLOR}
          stroke={WELD_COLOR}
          strokeWidth={1.5 / s}
          listening={false}
        />
      )}
    </Group>
  )
}

// ALL THE CANDIDATE RINGS ARE TWO SHAPES, NOT ONE SHAPE EACH.
//
// This is the whole of the point-edit lag, measured rather than reasoned about:
// with the rings drawn the canvas ran at 34 fps and a mouse move took 53 ms to
// reach the screen; with them suppressed, 50 fps and 11 ms. The main thread was
// idle throughout (no long task in five seconds, ~20 ms of JS in the whole
// window) and the layer's own draw call measured 0.7 ms — the cost is what the
// GPU is then asked to do, which no main-thread timer can see.
//
// It was never the pixels. 171 rings meant 171 Konva nodes, each with its own
// transform, its own stroke state and its own dash pass, restroked every frame
// the preview line moved. Collapsing them into one path per STYLE — one arc()
// per ring between a single beginPath and a single strokeShape — leaves two
// draw calls whatever the count, and the dash is set up twice instead of 171
// times. Same rings on screen, to the pixel.
//
// `perfectDrawEnabled={false}` and `shadowForStrokeEnabled={false}` keep Konva
// off its buffer-canvas path, which it would otherwise take for a stroked shape
// drawn at partial opacity — a second full-size canvas per frame, for nothing.
//
// RASTERISING THE LOT TO A BITMAP (`Group.cache()`) was the obvious next step and
// is deliberately NOT here: measured back to back it moved nothing — 41 fps and
// 0.22 ms a draw either way — while costing an explicit cache box (a custom
// `sceneFunc` has no self-rect for Konva to infer), a `pixelRatio` that has to
// track the zoom or the rings come back blurred, and a re-cache on every zoom
// change. The two draw calls are already cheap enough.
//
// Memoised on the array identity too: the set is gathered once on mousedown and
// does not change during the gesture, while the target under the cursor changes
// on every move and is drawn as one ring on top (see the caller).
const CrossPathRings = memo(function CrossPathRings(
  { candidates, scale: s }: { candidates?: CrossPathEntry[]; scale: number },
) {
  const r = ANCHOR_R / s
  if (!candidates || candidates.length === 0) return null
  const closed = candidates.filter((c) => c.closed)
  const open = candidates.filter((c) => !c.closed)
  // moveTo before each arc, or the arcs are joined by a chord across the canvas.
  const rings = (list: CrossPathEntry[]) => (ctx: Konva.Context, shape: Konva.Shape) => {
    ctx.beginPath()
    for (const c of list) {
      ctx.moveTo(c.x + r, c.y)
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2, false)
    }
    ctx.strokeShape(shape)
  }
  return (
    <>
      {closed.length > 0 && (
        <Shape
          sceneFunc={rings(closed)}
          stroke={WELD_COLOR}
          strokeWidth={1 / s}
          dash={[3 / s, 2 / s]}
          opacity={0.5}
          listening={false}
          perfectDrawEnabled={false}
          shadowForStrokeEnabled={false}
        />
      )}
      {open.length > 0 && (
        <Shape
          sceneFunc={rings(open)}
          stroke={WELD_COLOR}
          strokeWidth={1.5 / s}
          opacity={0.5}
          listening={false}
          perfectDrawEnabled={false}
          shadowForStrokeEnabled={false}
        />
      )}
    </>
  )
})

function NodeHandles({
  node,
  nodeIdx,
  scale: s,
  spaceHeldRef,
  onMouseDown,
}: {
  node: PathNode
  nodeIdx: number
  scale: number
  spaceHeldRef?: { readonly current: boolean }
  onMouseDown: (nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => void
}) {
  const [hoveredIn, setHoveredIn] = useState(false)
  const [hoveredOut, setHoveredOut] = useState(false)

  return (
    <>
      {node.handleIn && (
        <>
          <Line
            points={[node.x, node.y, node.handleIn.x, node.handleIn.y]}
            stroke={HANDLE_COLOR}
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle
            x={node.handleIn.x}
            y={node.handleIn.y}
            radius={HANDLE_R / s}
            fill={hoveredIn ? '#ffffff' : HANDLE_COLOR}
            listening
            onMouseEnter={() => setHoveredIn(true)}
            onMouseLeave={() => setHoveredIn(false)}
            onMouseDown={(e) => {
              if (isStagePress(e, spaceHeldRef)) return
              e.cancelBubble = true
              onMouseDown(nodeIdx, 'handle-in', e)
            }}
          />
        </>
      )}
      {node.handleOut && (
        <>
          <Line
            points={[node.x, node.y, node.handleOut.x, node.handleOut.y]}
            stroke={HANDLE_COLOR}
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle
            x={node.handleOut.x}
            y={node.handleOut.y}
            radius={HANDLE_R / s}
            fill={hoveredOut ? '#ffffff' : HANDLE_COLOR}
            listening
            onMouseEnter={() => setHoveredOut(true)}
            onMouseLeave={() => setHoveredOut(false)}
            onMouseDown={(e) => {
              if (isStagePress(e, spaceHeldRef)) return
              e.cancelBubble = true
              onMouseDown(nodeIdx, 'handle-out', e)
            }}
          />
        </>
      )}
    </>
  )
}
