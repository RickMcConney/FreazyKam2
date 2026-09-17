import { memo } from 'react'
import { Group, Arrow, Circle, Text } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { originWorldXY } from './WorkpieceLayer'
import { Z_DATUM_COLOR } from '../../colors'

// Draws the XY axis indicator at the origin point in screen coordinates.
// Being in screen coords means arrows and text are always upright and a
// consistent pixel size regardless of zoom.

interface Props {
  viewport: Viewport
}

const LEN = 28   // arrow length in pixels
const SW = 1.5   // stroke width in pixels
const PTR = 6    // arrowhead size in pixels
const FS = 10    // font size in pixels

export const OriginLayer = memo(function OriginLayer({ viewport }: Props) {
  const { widthMM, heightMM, origin, zOrigin } = useWorkpieceStore()
  const org = originWorldXY(origin, widthMM, heightMM)

  // Convert world → screen (Y flipped: higher world Y = lower screen Y)
  const sx = viewport.x + org.x * viewport.scale
  const sy = viewport.y - org.y * viewport.scale

  return (
    <Group listening={false}>
      {/* X axis – red, points right */}
      <Arrow
        x={sx} y={sy}
        points={[0, 0, LEN, 0]}
        stroke="#ef4444" fill="#ef4444"
        strokeWidth={SW}
        pointerLength={PTR} pointerWidth={PTR * 0.7}
      />
      <Text x={sx + LEN + 3} y={sy - FS / 2} text="X" fill="#ef4444" fontSize={FS} />

      {/* Y axis – green, points UP on screen (negative screen-Y) */}
      <Arrow
        x={sx} y={sy}
        points={[0, 0, 0, -LEN]}
        stroke="#22c55e" fill="#22c55e"
        strokeWidth={SW}
        pointerLength={PTR} pointerWidth={PTR * 0.7}
      />
      <Text x={sx + 3} y={sy - LEN - FS - 2} text="Y" fill="#22c55e" fontSize={FS} />

      {/* Origin dot */}
      <Circle x={sx} y={sy} radius={3} fill="white" />

      {/* Z origin label — which stock face Z0 sits on (top surface vs. bottom) */}
      <Text
        x={sx + 6} y={sy + 5}
        text={`Z ${zOrigin}`}
        fill={Z_DATUM_COLOR} fontSize={FS}
      />
    </Group>
  )
}
)
