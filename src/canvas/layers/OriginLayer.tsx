import { memo } from 'react'
import { Group, Arrow, Circle, Text } from 'react-konva'
import type { Viewport } from '../viewport'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
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

const LEN = 32   // arrow length in pixels
const SW = 1.5   // stroke width in pixels
const PTR = 9    // arrowhead size in pixels — larger than the Z label's scale, since the
                 // heads and X/Y letters sit right on the axis lines and were lost there
const AXIS_FS = 14 // X / Y label font size in pixels
const FS = 10    // Z label font size in pixels (it sits off the axes, and reads fine)

export const OriginLayer = memo(function OriginLayer({ viewport }: Props) {
  const { widthMM, heightMM, origin, zOrigin, machineXDir } = useWorkpieceStore()
  const org = originWorldXY(origin, widthMM, heightMM)
  const darkMode = useUIStore((s) => s.darkMode)

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
    x: sx + u.dx * (LEN + AXIS_FS * 0.7) - AXIS_FS * 0.3,
    y: sy + u.dy * (LEN + AXIS_FS * 0.7) - AXIS_FS / 2,
  })

  return (
    <Group listening={false}>
      {/* X axis – red, points right unless the machine's X runs another way */}
      <Arrow
        x={sx} y={sy}
        points={[0, 0, ax.dx * LEN, ax.dy * LEN]}
        stroke={AXIS_COLORS.x} fill={AXIS_COLORS.x}
        strokeWidth={SW}
        pointerLength={PTR} pointerWidth={PTR * 0.75}
      />
      <Text {...label(ax)} text="X" fill={AXIS_COLORS.x} fontSize={AXIS_FS} fontStyle="bold" />

      {/* Y axis – green, a quarter turn anticlockwise from X (up, for an X that points right) */}
      <Arrow
        x={sx} y={sy}
        points={[0, 0, ay.dx * LEN, ay.dy * LEN]}
        stroke={AXIS_COLORS.y} fill={AXIS_COLORS.y}
        strokeWidth={SW}
        pointerLength={PTR} pointerWidth={PTR * 0.75}
      />
      <Text {...label(ay)} text="Y" fill={AXIS_COLORS.y} fontSize={AXIS_FS} fontStyle="bold" />

      {/* Origin dot */}
      {/* White on the dark canvas, near-black on the light one, where white vanished */}
      <Circle x={sx} y={sy} radius={3} fill={darkMode ? '#ffffff' : '#111827'} />

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
