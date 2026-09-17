import { memo } from 'react'
import { Group, Circle, Rect, Line } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import type { AnchorCandidate } from '../../store/constraints'

// The Constrain tool's markers: every point of the hovered part a constraint can
// be hung off, with the nearest one picked out.
//
// THE MARKERS ARE THE ANCHORS. Clicking one picks the part AND which point of it
// to measure from, in a single gesture — the panel needed a selection, then a
// mode, then two dropdowns, and the anchor was chosen away from the geometry it
// described. Every marker here is already a `GeomRef`, so nothing downstream
// learns a new concept; see `anchorCandidates`.
//
// The SHAPE says what kind of point it is, because at marker size a colour
// difference is not enough to tell a corner from an edge midpoint: a square for
// a corner, a bar for the middle of an edge, a ring for a centre, and a
// crosshair for the centre of a round feature.

const PICK_COLOR = '#a855f7'
const HOT_COLOR = '#f59e0b'
const HELD_COLOR = '#22c55e'

interface Props {
  viewport: Viewport
  /** Every candidate on the part under the pointer. */
  candidates: AnchorCandidate[]
  /** The one a click would take. */
  hot: AnchorCandidate | null
  /** The first point, once it has been picked. */
  held: AnchorCandidate | null
  /** How far the part these candidates belong to has been dragged, in CNC mm.
   *  Every candidate rides with it — they were measured off the body's bounding
   *  box and the body is moving by a pure translation — so the marker under the
   *  cursor stays under the cursor instead of hanging back where the part was
   *  when the drag started. */
  drag?: { dx: number; dy: number } | null
}

function Marker({ c, s, color, big }: {
  c: AnchorCandidate
  s: number
  color: string
  big: boolean
}) {
  const r = (big ? 6 : 4) / s
  const w = 1.5 / s
  switch (c.kind) {
    case 'corner':
      return <Rect x={c.x - r} y={c.y - r} width={r * 2} height={r * 2} stroke={color} strokeWidth={w} listening={false} />
    case 'edge':
      return <Rect x={c.x - r} y={c.y - r / 2} width={r * 2} height={r} stroke={color} strokeWidth={w} listening={false} />
    case 'circle':
      return (
        <Group listening={false}>
          <Circle x={c.x} y={c.y} radius={r} stroke={color} strokeWidth={w} />
          <Line points={[c.x - r * 1.6, c.y, c.x + r * 1.6, c.y]} stroke={color} strokeWidth={w} />
          <Line points={[c.x, c.y - r * 1.6, c.x, c.y + r * 1.6]} stroke={color} strokeWidth={w} />
        </Group>
      )
    default:
      return <Circle x={c.x} y={c.y} radius={r} stroke={color} strokeWidth={w} listening={false} />
  }
}

export const ConstraintPickLayer = memo(function ConstraintPickLayer({
  viewport, candidates, hot, held, drag,
}: Props) {
  const s = viewport.scale
  return (
    <Group listening={false}>
      <Group x={drag?.dx ?? 0} y={drag?.dy ?? 0} listening={false}>
        {candidates.map((c, i) => (
          <Marker
            key={i} c={c} s={s} big={hot === c}
            color={hot === c ? HOT_COLOR : PICK_COLOR}
          />
        ))}
      </Group>
      {held && <Marker c={held} s={s} color={HELD_COLOR} big />}
      {/* The dimension being drawn is NOT here. It carries the numbers the
          constraint is about to hold, and this layer is inside the Y-flipped CNC
          layer where a label comes out upside down — so `ConstraintLayer` draws
          it, in screen space, with the same code that draws the finished ones.
          See its `pending` prop. */}
    </Group>
  )
})
