import { Group, Path, Line, Circle } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import type { PenNode } from '../../store/uiStore'
import { penNodesToPathD, liveSegmentD, type PenCurveType } from '../../cam/penCurves'
import { useCanvasStore } from '../../store/canvasStore'
import { useUIStore } from '../../store/uiStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { majorStepMM, minorStepMM } from '../gridUtils'
import { originWorldXY } from './WorkpieceLayer'


interface Props {
  viewport: Viewport
  penNodes: PenNode[]
  livePen: { anchor: { x: number; y: number }; handle: { x: number; y: number } | null } | null
  penClosing: boolean
  curveType: PenCurveType
  // Object-snapped cursor from CanvasStage (vertex/edge snapping); when set it
  // replaces the local grid-snap so the preview matches where a click lands.
  snappedCursor?: { x: number; y: number } | null
}

export function PenLayer({ viewport, penNodes, livePen, penClosing, curveType, snappedCursor }: Props) {
  const rawCursorCNC = useCanvasStore((s) => s.cursorMM)
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const penCurveType = useUIStore((s) => s.penCurveType)
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()
  const { scale: s } = viewport

  let cursorCNC = rawCursorCNC
  if (rawCursorCNC && snappedCursor) {
    cursorCNC = snappedCursor
  } else if (snapEnabled && rawCursorCNC) {
    const org = originWorldXY(origin, widthMM, heightMM)
    const step = minorStepMM(majorStepMM(s, units), units)
    if (step > 0) {
      cursorCNC = {
        x: Math.round((rawCursorCNC.x - org.x) / step) * step + org.x,
        y: Math.round((rawCursorCNC.y - org.y) / step) * step + org.y,
      }
    }
  }

  const last = penNodes.length > 0 ? penNodes[penNodes.length - 1] : null
  const cursorMovedFromLast =
    !!last &&
    !!cursorCNC &&
    Math.hypot(cursorCNC.x - last.x, cursorCNC.y - last.y) * s >= 8

  // When hovering over the first node to close, show the full closed path so the
  // preview matches exactly what committing will produce (auto-curve algorithms
  // reshape segment 0 when closed because pPrev changes from a ghost to the last node).
  const showAsClosed = penClosing && penNodes.length >= 2
  // Pass cursor as lookahead so auto-curve modes (catmull-rom, cubic-spline) use it
  // as p3 for the last committed segment — the preview then exactly matches what
  // placing the next node will produce (no reshape-on-commit surprise).
  const lookahead = (!showAsClosed && cursorCNC && cursorMovedFromLast) ? cursorCNC : undefined
  const committedD = penNodesToPathD(penNodes, showAsClosed, penCurveType, lookahead)

  let previewD: string | null = null
  if (last && !showAsClosed) {
    if (livePen) {
      // bezier mode shows the incoming reflected handle; other modes pass undefined
      const inH =
        curveType === 'bezier' && livePen.handle
          ? {
              x: livePen.anchor.x - (livePen.handle.x - livePen.anchor.x),
              y: livePen.anchor.y - (livePen.handle.y - livePen.anchor.y),
            }
          : undefined
      previewD = liveSegmentD(penNodes, livePen.anchor, inH, curveType)
    } else if (cursorCNC && cursorMovedFromLast) {
      previewD = liveSegmentD(penNodes, cursorCNC, undefined, curveType)
    }
  }

  if (penNodes.length === 0 && !livePen) return null

  const isBezier = penCurveType === 'bezier'

  return (
    <Group listening={false}>
      {/* Committed path so far */}
      {committedD && (
        <Path data={committedD} stroke="#38bdf8" strokeWidth={1.5 / s} fill="transparent" listening={false} />
      )}

      {/* Live preview to cursor or closing node */}
      {previewD && (
        <Path
          data={previewD}
          stroke="#38bdf8"
          strokeWidth={1.5 / s}
          opacity={0.5}
          dash={[4 / s, 3 / s]}
          fill="transparent"
          listening={false}
        />
      )}

      {/* Outgoing handle of last committed node — bezier mode only */}
      {isBezier && last?.outHandle && (
        <>
          <Line
            points={[last.x, last.y, last.outHandle.x, last.outHandle.y]}
            stroke="#94a3b8"
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle x={last.outHandle.x} y={last.outHandle.y} radius={3 / s} fill="#94a3b8" listening={false} />
        </>
      )}

      {/* Live handle lines during drag — bezier mode only */}
      {isBezier && livePen?.handle && (
        <>
          <Line
            points={[livePen.anchor.x, livePen.anchor.y, livePen.handle.x, livePen.handle.y]}
            stroke="#94a3b8"
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle x={livePen.handle.x} y={livePen.handle.y} radius={3 / s} fill="#94a3b8" listening={false} />
          <Line
            points={[
              livePen.anchor.x,
              livePen.anchor.y,
              livePen.anchor.x - (livePen.handle.x - livePen.anchor.x),
              livePen.anchor.y - (livePen.handle.y - livePen.anchor.y),
            ]}
            stroke="#94a3b8"
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle
            x={livePen.anchor.x - (livePen.handle.x - livePen.anchor.x)}
            y={livePen.anchor.y - (livePen.handle.y - livePen.anchor.y)}
            radius={3 / s}
            fill="#94a3b8"
            listening={false}
          />
        </>
      )}

      {/* Committed anchor point circles — corner nodes are orange */}
      {penNodes.map((node, i) => (
        <Circle
          key={i}
          x={node.x}
          y={node.y}
          radius={4 / s}
          fill={i === 0 && penClosing ? '#38bdf8' : '#1e293b'}
          stroke={
            i === 0 && penClosing ? '#ffffff'
            : node.corner ? '#f97316'
            : '#38bdf8'
          }
          strokeWidth={1.5 / s}
          listening={false}
        />
      ))}

      {/* Ghost anchor being placed (during mousedown-drag) */}
      {livePen && (
        <Circle
          x={livePen.anchor.x}
          y={livePen.anchor.y}
          radius={4 / s}
          fill="#1e293b"
          stroke="#38bdf8"
          strokeWidth={1.5 / s}
          listening={false}
        />
      )}
    </Group>
  )
}
