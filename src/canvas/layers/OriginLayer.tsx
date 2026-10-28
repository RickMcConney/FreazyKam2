import { memo } from 'react'
import { Group, Arrow, Circle, Text } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { originWorldXY } from './WorkpieceLayer'
import { Z_DATUM_COLOR, AXIS_COLORS } from '../../colors'
import { fromMachine } from '../../cam/machineFrame'

// Draws the XY axis indicator at the origin point in screen coordinates.
// Being in screen coords means arrows and text are always upright and a
// consistent pixel size regardless of zoom. The arrows are the MACHINE's axes
// (Setup → Machine +X, cam/machineFrame.ts): on a machine whose X runs up the
// drawing they point up and left, which is the only place that setting shows.

interface Props {
  viewport: Viewport
}

const LEN = 28   // arrow length in pixels
const SW = 1.5   // stroke width in pixels
const PTR = 6    // arrowhead size in pixels
const FS = 10    // font size in pixels

export const OriginLayer = memo(function OriginLayer({ viewport }: Props) {
  const { widthMM, heightMM, origin, zOrigin, machineXDir } = useWorkpieceStore()
  const org = originWorldXY(origin, widthMM, heightMM)

  // Convert world → screen (Y flipped: higher world Y = lower screen Y)
  const sx = viewport.x + org.x * viewport.scale
  const sy = viewport.y - org.y * viewport.scale

  // Each machine axis as a unit vector on SCREEN (drawing Y-up, so flip y).
  const axis = (mx: number, my: number) => {
    const [dx, dy] = fromMachine(mx, my, machineXDir ?? 'right')
    return { dx, dy: -dy }
  }
  const ax = axis(1, 0), ay = axis(0, 1)
  // A label sits past its arrow's tip, centred on the line it continues.
  const label = (u: { dx: number; dy: number }) => ({
    x: sx + u.dx * (LEN + FS * 0.7) - FS * 0.3,
    y: sy + u.dy * (LEN + FS * 0.7) - FS / 2,
  })

  return (
    <Group listening={false}>
      {/* X axis – red, points right unless the machine's X runs another way */}
      <Arrow
        x={sx} y={sy}
        points={[0, 0, ax.dx * LEN, ax.dy * LEN]}
        stroke={AXIS_COLORS.x} fill={AXIS_COLORS.x}
        strokeWidth={SW}
        pointerLength={PTR} pointerWidth={PTR * 0.7}
      />
      <Text {...label(ax)} text="X" fill={AXIS_COLORS.x} fontSize={FS} />

      {/* Y axis – green, a quarter turn anticlockwise from X (up, for an X that points right) */}
      <Arrow
        x={sx} y={sy}
        points={[0, 0, ay.dx * LEN, ay.dy * LEN]}
        stroke={AXIS_COLORS.y} fill={AXIS_COLORS.y}
        strokeWidth={SW}
        pointerLength={PTR} pointerWidth={PTR * 0.7}
      />
      <Text {...label(ay)} text="Y" fill={AXIS_COLORS.y} fontSize={FS} />

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
