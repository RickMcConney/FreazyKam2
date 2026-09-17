import { useState } from 'react'
import { Group, Line, Circle } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import type { HandleType, LiveTransform } from '../types'
import { transformPoint } from '../selectionUtils'
import type { BBox } from '../selectionUtils'

const HANDLE_R = 8
const ROT_OFFSET_PX = 22

function applyLT(x: number, y: number, lt: LiveTransform | null): { x: number; y: number } {
  if (!lt) return { x, y }
  return transformPoint(x, y, lt as Parameters<typeof transformPoint>[2])
}

interface SharedProps {
  viewport: Viewport
  // Selection bbox, computed ONCE in CanvasStage (memoized on the selected
  // paths). Both selection layers re-render every mousemove during a live
  // transform — computing the bbox here re-flattened every selected path twice
  // per frame (tofix.md H1).
  bbox: BBox
  liveTransform: LiveTransform | null
}

function handlePositions(viewport: Viewport, bbox: BBox, liveTransform: LiveTransform | null) {
  const { x: vx, y: vy, scale } = viewport
  const { minX, minY, maxX, maxY, cx, cy } = bbox

  function lt(px: number, py: number) { return applyLT(px, py, liveTransform) }
  function toS(p: { x: number; y: number }) { return { x: vx + p.x * scale, y: vy - p.y * scale } }

  const corners = {
    tl: toS(lt(minX, maxY)), tr: toS(lt(maxX, maxY)),
    bl: toS(lt(minX, minY)), br: toS(lt(maxX, minY)),
    t:  toS(lt(cx,   maxY)), b:  toS(lt(cx,   minY)),
    l:  toS(lt(minX, cy)),   r:  toS(lt(maxX, cy)),
  }

  const topEdgeCNC = lt(cx, maxY)
  const rotOffsetCNC = ROT_OFFSET_PX / scale
  const rotHandle = toS({ x: topEdgeCNC.x, y: topEdgeCNC.y + rotOffsetCNC })
  const rotBase = toS(lt(cx, maxY))

  return { corners, rotHandle, rotBase }
}

// Decorative layer: bounding box outline + rotation handle line (non-interactive)
export function SelectionLayer({ viewport, bbox, liveTransform }: SharedProps) {
  const { corners: c, rotHandle, rotBase } = handlePositions(viewport, bbox, liveTransform)

  const outline = [c.tl.x, c.tl.y, c.tr.x, c.tr.y, c.br.x, c.br.y, c.bl.x, c.bl.y, c.tl.x, c.tl.y]

  return (
    <Group listening={false}>
      <Line points={outline} stroke="#60a5fa" strokeWidth={1} dash={[4, 3]} />
      <Line points={[rotBase.x, rotBase.y, rotHandle.x, rotHandle.y]} stroke="#60a5fa" strokeWidth={1} />
    </Group>
  )
}

// Interactive handle layer: resize circles + rotation circle
interface HandleLayerProps extends SharedProps {
  onResizeHandleDown: (handle: HandleType, e: Konva.KonvaEventObject<MouseEvent>) => void
  onRotateHandleDown: (e: Konva.KonvaEventObject<MouseEvent>) => void
  // A mechanism whose size comes from its own parameters (see
  // SCALE_LOCKED_SHAPES) draws no resize handles — its module or its rate is
  // not something to arrive at by dragging a corner. Rotation stays: turning a
  // gear on the stock changes nothing about the gear.
  scaleLocked?: boolean
}

export function SelectionHandleLayer({ viewport, bbox, liveTransform, onResizeHandleDown, onRotateHandleDown, scaleLocked }: HandleLayerProps) {
  const [hoveredId, setHoveredId] = useState<HandleType | 'rot' | null>(null)
  const { corners: c, rotHandle } = handlePositions(viewport, bbox, liveTransform)

  const handles: { id: HandleType; pos: { x: number; y: number } }[] = scaleLocked ? [] : [
    { id: 'tl', pos: c.tl }, { id: 'tr', pos: c.tr },
    { id: 'bl', pos: c.bl }, { id: 'br', pos: c.br },
    { id: 't',  pos: c.t  }, { id: 'b',  pos: c.b  },
    { id: 'l',  pos: c.l  }, { id: 'r',  pos: c.r  },
  ]

  return (
    <Group>
      {handles.map(({ id, pos: p }) => (
        <Circle
          key={id}
          x={p.x} y={p.y}
          radius={HANDLE_R}
          fill={hoveredId === id ? '#60a5fa' : '#1e293b'}
          stroke="#60a5fa" strokeWidth={1.5}
          onMouseEnter={() => setHoveredId(id)}
          onMouseLeave={() => setHoveredId(null)}
          onMouseDown={(e) => { e.cancelBubble = true; onResizeHandleDown(id, e) }}
        />
      ))}
      <Circle
        x={rotHandle.x} y={rotHandle.y}
        radius={HANDLE_R}
        fill={hoveredId === 'rot' ? '#a78bfa' : '#1e293b'}
        stroke="#a78bfa" strokeWidth={1.5}
        onMouseEnter={() => setHoveredId('rot')}
        onMouseLeave={() => setHoveredId(null)}
        onMouseDown={(e) => { e.cancelBubble = true; onRotateHandleDown(e) }}
      />
    </Group>
  )
}
