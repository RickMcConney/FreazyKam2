import { memo } from 'react'
import { Group, Line, Circle, Label, Tag, Text } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { measureReadout } from '../measure'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'

// The Measure tool's line (canvas/measure): a solid line from the first click to the
// second (or to the cursor while the second is pending), its run and rise as a dashed
// right angle, and a label with the length, ΔX, ΔY and angle. Drawn in screen space so
// it stays the same weight at every zoom. `hot` marks the point a click would take.

const COLOR = '#F97316'

interface Props {
  viewport: Viewport
  a: { x: number; y: number } | null
  b: { x: number; y: number } | null
  hot: { x: number; y: number } | null
}

export const MeasureLayer = memo(function MeasureLayer({ viewport, a, b, hot }: Props) {
  const units = useWorkpieceStore((s) => s.units)
  const sx = (x: number) => viewport.x + x * viewport.scale
  const sy = (y: number) => viewport.y - y * viewport.scale
  const r = a && b ? measureReadout(a, b) : null
  const signed = (mm: number) => `${mm < 0 ? '−' : ''}${fmtLen(Math.abs(mm), units, 2)}`
  return (
    <Group listening={false}>
      {a && b && r && r.distMM > 1e-9 && (
        <>
          {Math.abs(r.dxMM) > 1e-9 && Math.abs(r.dyMM) > 1e-9 && (
            <Line points={[sx(a.x), sy(a.y), sx(b.x), sy(a.y), sx(b.x), sy(b.y)]}
              stroke={COLOR} strokeWidth={1} dash={[4, 4]} opacity={0.7} />
          )}
          <Line points={[sx(a.x), sy(a.y), sx(b.x), sy(b.y)]} stroke={COLOR} strokeWidth={1.5} />
          <Label x={(sx(a.x) + sx(b.x)) / 2 + 10} y={(sy(a.y) + sy(b.y)) / 2 + 10}>
            <Tag fill="rgba(17,17,17,0.85)" cornerRadius={3} />
            <Text padding={5} fontSize={12} lineHeight={1.35} fill="#fff"
              text={`${fmtLen(r.distMM, units, 2)}\nΔX ${signed(r.dxMM)}   ΔY ${signed(r.dyMM)}\n${r.angleDeg.toFixed(1)}°`} />
          </Label>
        </>
      )}
      {a && <Circle x={sx(a.x)} y={sy(a.y)} radius={3.5} fill={COLOR} />}
      {b && <Circle x={sx(b.x)} y={sy(b.y)} radius={3.5} fill={COLOR} />}
      {hot && <Circle x={sx(hot.x)} y={sy(hot.y)} radius={6} stroke={COLOR} strokeWidth={1.5} />}
    </Group>
  )
})
