import { memo } from 'react'
import { Group, Line } from 'react-konva'
import type { Viewport } from '../CanvasStage'

// Dashed alignment guides shown while a dragged selection is object-snapped.
// Guide coordinates are in CNC mm; lines are drawn in screen space so they
// stay 1px and span the whole stage regardless of zoom.

export interface SnapGuides { x?: number; y?: number }

interface Props {
  viewport: Viewport
  guides: SnapGuides
  width: number
  height: number
}

const GUIDE_COLOR = '#FF00C8'

export const SnapGuideLayer = memo(function SnapGuideLayer({ viewport, guides, width, height }: Props) {
  return (
    <Group listening={false}>
      {guides.x !== undefined && (
        <Line
          points={[viewport.x + guides.x * viewport.scale, 0, viewport.x + guides.x * viewport.scale, height]}
          stroke={GUIDE_COLOR}
          strokeWidth={1}
          dash={[4, 4]}
        />
      )}
      {guides.y !== undefined && (
        <Line
          points={[0, viewport.y - guides.y * viewport.scale, width, viewport.y - guides.y * viewport.scale]}
          stroke={GUIDE_COLOR}
          strokeWidth={1}
          dash={[4, 4]}
        />
      )}
    </Group>
  )
})
