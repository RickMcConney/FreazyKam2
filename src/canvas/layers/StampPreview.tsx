import { memo } from 'react'
import { Group, Path } from 'react-konva'
import { useCanvasStore } from '../../store/canvasStore'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { canvasTheme } from '../../theme'
import { stampSource } from '../useStampTool'
import type { Viewport } from '../viewport'

// The stamp tool's copy, following the cursor: the originals' outlines moved by the
// offset a click would give them (useStampTool). One Group translated per mouse move,
// so a move costs a translate and not a rebuild; in the simulation's layer, like the
// shape hover, so it does not repaint the drawing.
export const StampPreview = memo(function StampPreview({ viewport }: { viewport: Viewport }) {
  const offset = useCanvasStore((s) => s.stampOffset)
  const on = useUIStore((s) => s.activeTool === 'stamp')
  usePathsStore((s) => s.paths)            // re-read the source when the paths change (undo)
  useUIStore((s) => s.stampIds)
  const colors = canvasTheme(useUIStore((s) => s.darkMode)).shapePreview
  if (!on || !offset) return null
  const src = stampSource()
  if (!src) return null
  return (
    <Group x={offset.x} y={offset.y} listening={false}>
      {src.paths.map((p) => (
        <Path key={p.id} data={p.d}
          stroke={colors.stroke} strokeWidth={1.5 / viewport.scale} fill={colors.fill}
          dash={[6 / viewport.scale, 4 / viewport.scale]}
          listening={false} perfectDrawEnabled={false} shadowForStrokeEnabled={false} />
      ))}
    </Group>
  )
})
