import { useMemo } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { constraintFrame, type AnchorCandidate } from '../store/constraints'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { fmtLen, useWorkpieceStore } from '../store/workpieceStore'
import { ConstraintLayer } from './layers/ConstraintLayer'
import { originWorldXY } from './layers/WorkpieceLayer'
import type { PathNode } from './nodeUtils'
import { snapPoint, type Viewport } from './viewport'

// The things drawn over the stage that subscribe for themselves, so that what changes on
// every mouse move re-renders them and not CanvasStage.

export function NodeEditDimensionOverlay({
  viewport,
  nodes,
  closed,
  dragNodeIdx,
  hoverSegIdx,
}: {
  viewport: Viewport
  nodes: PathNode[]
  closed: boolean
  dragNodeIdx: number | null
  hoverSegIdx: number | null
}) {
  const { units } = useWorkpieceStore()
  if (nodes.length < 2) return null

  const fmt = (d: number) => fmtLen(d, units)

  const segLabel = (fromIdx: number, toIdx: number) => {
    const a = nodes[fromIdx], b = nodes[toIdx]
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    if (dist < 0.01) return null
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    return { sx: viewport.x + mx * viewport.scale, sy: viewport.y - my * viewport.scale, text: fmt(dist) }
  }

  const labels: { sx: number; sy: number; text: string }[] = []

  if (dragNodeIdx !== null && nodes[dragNodeIdx]) {
    const prevIdx = dragNodeIdx > 0 ? dragNodeIdx - 1 : closed ? nodes.length - 1 : -1
    if (prevIdx >= 0) {
      const l = segLabel(prevIdx, dragNodeIdx)
      if (l) labels.push(l)
    }
    const nextIdx = dragNodeIdx < nodes.length - 1 ? dragNodeIdx + 1 : closed ? 0 : -1
    if (nextIdx >= 0 && nextIdx !== prevIdx) {
      const l = segLabel(dragNodeIdx, nextIdx)
      if (l) labels.push(l)
    }
  } else if (hoverSegIdx !== null) {
    const toIdx = (hoverSegIdx + 1) % nodes.length
    if (closed || toIdx !== 0) {
      const l = segLabel(hoverSegIdx, toIdx)
      if (l) labels.push(l)
    }
  }

  if (labels.length === 0) return null

  return (
    <>
      {labels.map((l, i) => (
        <div
          key={i}
          className="absolute pointer-events-none bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-mono whitespace-nowrap z-10"
          style={{ left: l.sx, top: l.sy - 36, transform: 'translateX(-50%)' }}
        >
          {l.text}
        </div>
      ))}
    </>
  )
}

// THE CONSTRAIN TOOL'S LIVE DIMENSION — the one thing the stage drew that follows the bare
// cursor. It reads `cursorMM` HERE rather than in CanvasStage: subscribed there, the cursor
// re-ran the whole stage body and rebuilt every layer's JSX on EVERY mouse move, whatever
// tool was in use, for the sake of this one line. The selector hands back null unless a
// first point is held with no candidate under the pointer, so even this stays still until
// the line actually has to track the cursor.
export function ConstraintLayerLive({ viewport, hideCommitted, held, hot, drag }: {
  viewport: Viewport
  hideCommitted: boolean
  held: AnchorCandidate | null
  hot: AnchorCandidate | null
  drag: { dx: number; dy: number } | null
}) {
  const activeTool = useUIStore((s) => s.activeTool)
  const constrainMode = useUIStore((s) => s.constrainMode)
  const paths = usePathsStore((s) => s.paths)
  const following = activeTool === 'constrain' && !!held && !hot
  const cursorMM = useCanvasStore((s) => (following ? s.cursorMM : null))

  // THE DIMENSION BEING MADE, in CNC mm, or null when nothing is half-made.
  //
  // The far end is the point a mouse-up would take: the hot candidate when one
  // is under the cursor — so what is drawn is what will be stored, to the digit
  // — displaced by the drag when the part is being dragged there, and the bare
  // cursor otherwise, which is what makes the line follow the pointer across
  // empty canvas the way it always did.
  const pending = useMemo(() => {
    if (activeTool !== 'constrain' || !held) return null
    const q = hot
      ? { x: hot.x + (drag?.dx ?? 0), y: hot.y + (drag?.dy ?? 0) }
      : cursorMM
    if (!q) return null
    // Stated in the first part's frame, which is what the constraint will hold.
    const frame = constraintFrame(paths, held.ref)
    return {
      p: { x: held.x, y: held.y }, q, mode: constrainMode,
      frameDeg: frame.deg, frameFlip: frame.flip,
    }
  }, [activeTool, held, hot, drag, cursorMM, constrainMode, paths])

  return <ConstraintLayer viewport={viewport} hideCommitted={hideCommitted} pending={pending} />
}

export function PenLengthOverlay({ viewport, draggingHandle, snappedCursor }: { viewport: Viewport; draggingHandle: boolean; snappedCursor?: { x: number; y: number } | null }) {
  const activeTool = useUIStore((s) => s.activeTool)
  const penNodes = useUIStore((s) => s.penNodes)
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const cursorMM = useCanvasStore((s) => s.cursorMM)
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()

  if (activeTool !== 'pen' || penNodes.length === 0 || !cursorMM || draggingHandle) return null

  let cursor = cursorMM
  if (snappedCursor) {
    cursor = snappedCursor
  } else if (snapEnabled) {
    const org = originWorldXY(origin, widthMM, heightMM)
    cursor = snapPoint(cursorMM, viewport, units, org)
  }

  const last = penNodes[penNodes.length - 1]
  const dist = Math.hypot(cursor.x - last.x, cursor.y - last.y)
  if (dist < 0.01) return null

  const sx = viewport.x + cursor.x * viewport.scale
  const sy = viewport.y - cursor.y * viewport.scale
  const label = fmtLen(dist, units)

  return (
    <div
      className="absolute pointer-events-none bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-mono whitespace-nowrap z-10"
      style={{ left: sx + 14, top: sy - 22 }}
    >
      {label}
    </div>
  )
}
