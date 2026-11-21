import { memo } from 'react'
import { Group, Label, Line, Tag, Text } from 'react-konva'
import type { ShapeParams } from '../../shapes/shapeGenerators'
import { shapeDragReadout, type ReadoutItem } from '../../shapes/dragReadout'
import { fmtLen, useWorkpieceStore, type Units } from '../../store/workpieceStore'
import { getBBox } from '../selectionUtils'
import type { Viewport } from '../viewport'

// The dimensions of a shape while it is being DRAGGED OUT: the width of its box
// below it, the height beside it, and the figures that define it (radius, sides,
// module…) in a plate at its top-right corner. Drawn in screen space, like the
// Measure tool, so it stays the same weight at every zoom. The box is the drawn
// outline's, so it is what the stock has to hold — the same W/H the Transform
// section shows once the shape lands.

const COLOR = '#60a5fa'
const GAP = 22       // px from the box to its dimension line — clear of the 8 px selection handles
const TICK = 5       // px half-length of the end ticks
const PLATE = 'rgba(17,17,17,0.85)'

interface Props {
  viewport: Viewport
  shape: { d: string; params: ShapeParams } | null
}

export const ShapeDimLayer = memo(function ShapeDimLayer({ viewport, shape }: Props) {
  const units = useWorkpieceStore((s) => s.units)
  if (!shape) return null
  const bb = getBBox(shape.d)
  if (!bb) return null
  return <BoxDims viewport={viewport} box={bb} readout={readoutText(shapeDragReadout(shape.params), units)} />
})

/** The figures of a readout, one per line, lengths in the toolbar's units. */
export function readoutText(items: ReadoutItem[], units: Units): string {
  return items
    .map((it) => `${it.label} ${'mm' in it ? fmtLen(it.mm, units, 2) : it.count}`)
    .join('\n')
}

/** A dark number plate, positioned by `align`/`vAlign` about (x, y) in screen px. */
export function Plate({ x, y, text, align = 'left', vAlign = 'top' }: {
  x: number; y: number; text: string; align?: 'center' | 'right' | 'left'; vAlign?: 'top' | 'middle'
}) {
  // Konva Labels anchor top-left, so centre or right-align by an estimated width.
  const fontSize = 12, padding = 4
  const lines = text.split('\n')
  const w = Math.max(...lines.map((l) => l.length)) * fontSize * 0.6 + 2 * padding
  const h = lines.length * fontSize * 1.3 + 2 * padding
  const lx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x
  const ly = vAlign === 'middle' ? y - h / 2 : y
  return (
    <Label x={lx} y={ly}>
      <Tag fill={PLATE} cornerRadius={3} />
      <Text padding={padding} fontSize={fontSize} lineHeight={1.3} fill="#fff" text={text} />
    </Label>
  )
}

/** Width and height dimension lines round a CNC-space box, and `readout` in a
 *  plate at its top-right corner. Shared by the shape drag-out and the resize handles. */
export function BoxDims({ viewport, box: bb, readout }: {
  viewport: Viewport
  box: { minX: number; minY: number; maxX: number; maxY: number }
  readout: string
}) {
  const units = useWorkpieceStore((s) => s.units)
  const sx = (x: number) => viewport.x + x * viewport.scale
  const sy = (y: number) => viewport.y - y * viewport.scale
  const left = sx(bb.minX), right = sx(bb.maxX)
  const top = sy(bb.maxY), bottom = sy(bb.minY)
  const wy = bottom + GAP     // width line, below the box
  const hx = left - GAP       // height line, left of the box
  return (
    <Group listening={false}>
      {/* Width: extension ticks at both ends, the line between, the figure under it. */}
      <Line points={[left, wy - TICK, left, wy + TICK]} stroke={COLOR} strokeWidth={1} />
      <Line points={[right, wy - TICK, right, wy + TICK]} stroke={COLOR} strokeWidth={1} />
      <Line points={[left, wy, right, wy]} stroke={COLOR} strokeWidth={1} />
      <Plate x={(left + right) / 2} y={wy + 4} text={fmtLen(bb.maxX - bb.minX, units, 2)} align="center" />
      {/* Height: the same, up the left side, the figure to its left. */}
      <Line points={[hx - TICK, top, hx + TICK, top]} stroke={COLOR} strokeWidth={1} />
      <Line points={[hx - TICK, bottom, hx + TICK, bottom]} stroke={COLOR} strokeWidth={1} />
      <Line points={[hx, top, hx, bottom]} stroke={COLOR} strokeWidth={1} />
      <Plate x={hx - 4} y={(top + bottom) / 2} text={fmtLen(bb.maxY - bb.minY, units, 2)} align="right" vAlign="middle" />
      {readout && <Plate x={right + 8} y={top} text={readout} />}
    </Group>
  )
}
