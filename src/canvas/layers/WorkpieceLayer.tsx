import { memo } from 'react'
import { Group, Rect } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore, type OriginPosition } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { MATERIAL_COLORS } from '../../colors'
import { cellKey, cellOffset } from '../../cam/sheets'
import { useActiveSheet } from '../useSheets'

// In Y-up CNC space: top = high Y (back of machine), bottom = low Y (front)
// With layer scaleY=-scale, world Y=0 appears at screen bottom of workpiece,
// world Y=h appears at screen top.
export function originWorldXY(
  pos: OriginPosition,
  w: number,
  h: number
): { x: number; y: number } {
  const xs: Record<OriginPosition, number> = {
    'top-left': 0,    'top-center': w / 2,    'top-right': w,
    'mid-left': 0,    'center':     w / 2,    'mid-right': w,
    'bottom-left': 0, 'bottom-center': w / 2, 'bottom-right': w,
  }
  const ys: Record<OriginPosition, number> = {
    'top-left': h,    'top-center': h,    'top-right': h,    // high Y = CNC back = screen top
    'mid-left': h / 2,'center':     h / 2,'mid-right': h / 2,
    'bottom-left': 0, 'bottom-center': 0, 'bottom-right': 0, // low Y  = CNC front = screen bottom
  }
  return { x: xs[pos], y: ys[pos] }
}

interface Props {
  viewport: Viewport
}

export const WorkpieceLayer = memo(function WorkpieceLayer({ viewport }: Props) {
  const { widthMM, heightMM, material } = useWorkpieceStore()
  const { scale } = viewport
  const darkMode = useUIStore((s) => s.darkMode)
  const fill = MATERIAL_COLORS[material][darkMode ? 'dark' : 'light']
  // MORE SHEETS, when a nest spread the parts over several (cam/sheets): each the stock's
  // size, in a grid beside and below it — numbered by SheetLabelLayer, above the drawing.
  // The one the simulator and machine panel are on is drawn like the stock; the others
  // thinner and fainter — NOT dashed: a dash
  // pattern is laid along the whole outline however little of it is on screen, and zoomed
  // in on a 4 × 8 ft sheet that is thousands of dashes per sheet on every pan and zoom
  // frame, which a single, undashed sheet never paid.
  const { cells, index: active } = useActiveSheet()

  return (
    <Group listening={false}>
      {cells.map((cell, k) => {
        const { x, y } = cellOffset(cell, { widthMM, heightMM })
        return (
          <Group key={cellKey(cell)}>
            <Rect
              x={x} y={y}
              width={widthMM} height={heightMM}
              stroke={fill}
              strokeWidth={(k === active ? 4 : 2) / scale}
              opacity={k === active ? 1 : 0.55}
              perfectDrawEnabled={false}
              fill="transparent"
            />
          </Group>
        )
      })}
    </Group>
  )
}
)
