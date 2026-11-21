import { Group, Path } from 'react-konva'
import { useUIStore } from '../../store/uiStore'
import { canvasTheme } from '../../theme'
import type { Viewport } from '../viewport'

interface Props {
  viewport: Viewport
  d: string | null
}

export function ShapePreviewLayer({ viewport, d }: Props) {
  // Per theme — see canvasTheme().shapePreview; the same colours as the hover preview.
  const colors = canvasTheme(useUIStore((s) => s.darkMode)).shapePreview
  if (!d) return null
  const { scale } = viewport
  return (
    <Group listening={false}>
      <Path
        data={d}
        stroke={colors.stroke}
        strokeWidth={1.5 / scale}
        fill={colors.fill}
        dash={[6 / scale, 4 / scale]}
        listening={false}
      />
    </Group>
  )
}
