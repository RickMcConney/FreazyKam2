import { Group, Path } from 'react-konva'
import type { Viewport } from '../CanvasStage'

interface Props {
  viewport: Viewport
  d: string | null
}

export function ShapePreviewLayer({ viewport, d }: Props) {
  if (!d) return null
  const { scale } = viewport
  return (
    <Group listening={false}>
      <Path
        data={d}
        stroke="#60a5fa"
        strokeWidth={1.5 / scale}
        fill="#60a5fa22"
        dash={[4 / scale, 3 / scale]}
        listening={false}
      />
    </Group>
  )
}
