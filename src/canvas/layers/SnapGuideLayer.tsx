import { memo } from 'react'
import { Group, Line, Text, Rect } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import type { Box, GapMark } from '../objectSnap'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'

// Dashed alignment guides shown while a dragged selection is object-snapped.
// Guide coordinates are in CNC mm; lines are drawn in screen space so they
// stay 1px and span the whole stage regardless of zoom.
//
// `gaps`: the equal-spacing snap's matched gaps (objectSnap equalSpacingSnap), each drawn
// as a solid measured span with end ticks and its length, so it reads as "these are equal".
// The Alt-hover measurement (canvas/measure) draws its gaps the same way, in its own colour,
// with `boxes` outlining what it is measuring against.

export interface SnapGuides { x?: number; y?: number; gaps?: GapMark[]; boxes?: Box[] }

interface Props {
  viewport: Viewport
  guides: SnapGuides
  width: number
  height: number
  color?: string
}

const SNAP_COLOR = '#FF00C8'
const TICK_PX = 4

export const SnapGuideLayer = memo(function SnapGuideLayer({ viewport, guides, width, height, color }: Props) {
  const GUIDE_COLOR = color ?? SNAP_COLOR
  const units = useWorkpieceStore((s) => s.units)
  const sx = (x: number) => viewport.x + x * viewport.scale
  const sy = (y: number) => viewport.y - y * viewport.scale
  return (
    <Group listening={false}>
      {guides.x !== undefined && (
        <Line
          points={[sx(guides.x), 0, sx(guides.x), height]}
          stroke={GUIDE_COLOR}
          strokeWidth={1}
          dash={[4, 4]}
        />
      )}
      {guides.y !== undefined && (
        <Line
          points={[0, sy(guides.y), width, sy(guides.y)]}
          stroke={GUIDE_COLOR}
          strokeWidth={1}
          dash={[4, 4]}
        />
      )}
      {guides.boxes?.map((b, i) => (
        <Rect key={`box${i}`} x={sx(b.minX)} y={sy(b.maxY)} width={(b.maxX - b.minX) * viewport.scale}
          height={(b.maxY - b.minY) * viewport.scale} stroke={GUIDE_COLOR} strokeWidth={1} dash={[3, 3]} />
      ))}
      {guides.gaps?.map((g, i) => {
        const label = fmtLen(g.to - g.from, units, 1)
        if (g.axis === 'x') {
          const x1 = sx(g.from), x2 = sx(g.to), y = sy(g.at)
          return (
            <Group key={i}>
              <Line points={[x1, y, x2, y]} stroke={GUIDE_COLOR} strokeWidth={1} />
              <Line points={[x1, y - TICK_PX, x1, y + TICK_PX]} stroke={GUIDE_COLOR} strokeWidth={1} />
              <Line points={[x2, y - TICK_PX, x2, y + TICK_PX]} stroke={GUIDE_COLOR} strokeWidth={1} />
              <Text x={(x1 + x2) / 2 - 40} y={y - 16} width={80} align="center" text={label} fontSize={11} fill={GUIDE_COLOR} />
            </Group>
          )
        }
        const y1 = sy(g.from), y2 = sy(g.to), x = sx(g.at)
        return (
          <Group key={i}>
            <Line points={[x, y1, x, y2]} stroke={GUIDE_COLOR} strokeWidth={1} />
            <Line points={[x - TICK_PX, y1, x + TICK_PX, y1]} stroke={GUIDE_COLOR} strokeWidth={1} />
            <Line points={[x - TICK_PX, y2, x + TICK_PX, y2]} stroke={GUIDE_COLOR} strokeWidth={1} />
            <Text x={x + 6} y={(y1 + y2) / 2 - 6} text={label} fontSize={11} fill={GUIDE_COLOR} />
          </Group>
        )
      })}
    </Group>
  )
})
