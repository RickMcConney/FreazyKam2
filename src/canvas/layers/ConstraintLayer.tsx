import { memo, useMemo } from 'react'
import { Group, Line, Text, Rect, Circle } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useConstraintsStore } from '../../store/constraintsStore'
import { constraintEnds, constraintsInFocus, type Constraint } from '../../store/constraints'
import { useWorkpieceStore, fmtLen as formatLen } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'

// Dimensions for the constraints on the current selection.
//
// SCREEN SPACE, so the line stays one pixel and the label readable at every
// zoom — this sits in the stage's screen-space overlay layer, not the Y-flipped
// CNC layer, which is also what lets the label be drawn the right way up
// without a counter-flip.
//
// EVERY NUMBER HAS ITS OWN PLACE TO BE DRAWN, always. A polar constraint puts
// the distance along the line and the angle in an arc at the held end; an X/Y
// one draws an L — across, then up — and puts each offset beside its own leg.
// That is not decoration: the first cut of this drew an X and a Y dimension both
// as the line joining the two centres, so they landed exactly on top of each
// other, and on the everyday case (parts standing in a row, Y distance zero) one
// of the two numbers simply could not be read.
//
// A DOT MARKS THE HELD END — the one that stays put when the numbers change — and
// the lines carry ordinary drawing arrowheads at BOTH ends. It used to be a single
// arrowhead pointing at the end that takes up the change, plus a tick at each end;
// in X/Y mode that arrow pointed along a diagonal nothing was drawn on. The marker
// does NOT say which part may be dragged — the solve anchors at whatever the user
// grabbed and carries the rest of the chain along, so every part is equally
// draggable (see store/constraints.ts). But typing a new distance has to move
// something, and the dot is the whole of what says which end does not.
//
// ONLY WHILE THE CONSTRAIN TOOL IS ON. Dimensions are a drawing OF the
// constraints, and the moment you are doing something else they are clutter over
// the top of the work: selecting a part to give it a toolpath put purple lines,
// arcs and number plates across the very geometry being aimed at, and the
// selection is how every operation in the app is started. The panel still lists
// what holds a selected part — that is a list, and it is off to the side — but
// the canvas draws them only when the tool that makes them is in hand.
//
// AND THEN EXACTLY THE SET THE PANEL LISTS, through the one function both ask
// (`constraintsInFocus`). Drawing everything while the tool is on read as extra
// information and was a disagreement: pick out one corner hole holding one
// constraint and the panel said one while the canvas drew all four of the
// plate's, with nothing to say which of the two was answering the question.
//
// THE ONE BEING MADE IS DRAWN BY THIS SAME CODE, in green, from `pending`. The
// Constrain tool's second point can be DRAGGED, and what the user is dragging
// towards is a pair of numbers rather than a position — so the preview has to be
// the finished dimension, digits and all, not the dashed line to the cursor it
// started as. Drawn here rather than in the pick layer because that layer is
// inside the Y-flipped CNC layer, where a label comes out upside down, and
// because a preview that is drawn a second way would eventually stop matching
// what the constraint lands holding.

const CONSTRAINT_COLOR = '#a855f7'
/** The one being made — the same green as the held marker under the cursor. */
const PENDING_COLOR = '#22c55e'
/** The datum dot on the held end. */
const HELD_DOT_PX = 3
const ARROW_PX = 7
const ARC_PX = 24
/** Clear air between the arc and the NEAREST EDGE of the angle label. */
const ARC_LABEL_GAP = 8
const LABEL_H = 16

/** The numbers a dimension draws. A pending one has no id and no ends yet. */
type DimSpec = Pick<Constraint, 'mode' | 'distanceMM' | 'angleDeg' | 'offsetXMM' | 'offsetYMM'>

/** Where the second point of a half-made constraint currently is, in CNC mm. */
export interface PendingDim {
  p: { x: number; y: number }
  q: { x: number; y: number }
  mode: 'polar' | 'xy'
  /** The frame it will be stated in — the first part's own angle… */
  frameDeg: number
  /** …and whether that part is mirrored, which turns its y-axis the other way. */
  frameFlip: boolean
}

interface Props {
  viewport: Viewport
  /** The constraint being placed, drawn live. */
  pending?: PendingDim | null
  /** Committed dimensions are stale mid-drag — see the call site. */
  hideCommitted?: boolean
}

/**
 * An arc as a polyline, from screen angle `fromDeg` to `toDeg` about (cx, cy).
 *
 * Hand-built rather than a Konva `Arc`, which is a filled wedge with a stroke
 * round it: pinching its radii together to leave only the stroke still paints
 * the interior on one of the two sweep directions, so a positive angle came out
 * as a solid pie. Generating the points also settles the sweep outright —
 * `Arc` takes a rotation and a positive angle and sweeps one fixed way, so the
 * two signs needed opposite arguments and one of them was wrong. Here the
 * interpolation runs from `fromDeg` to `toDeg` whichever way round they are.
 */
function arcPoints(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): number[] {
  const steps = Math.max(6, Math.ceil(Math.abs(toDeg - fromDeg) / 5))
  const pts: number[] = []
  for (let i = 0; i <= steps; i++) {
    const a = (fromDeg + (toDeg - fromDeg) * (i / steps)) * Math.PI / 180
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  return pts
}

/** The two short strokes of an arrowhead at `(x2,y2)`, pointing away from `(x1,y1)`. */
function arrowStrokes(x1: number, y1: number, x2: number, y2: number): number[][] {
  const a = Math.atan2(y2 - y1, x2 - x1)
  const spread = 0.42
  return [
    [x2, y2, x2 - ARROW_PX * Math.cos(a - spread), y2 - ARROW_PX * Math.sin(a - spread)],
    [x2, y2, x2 - ARROW_PX * Math.cos(a + spread), y2 - ARROW_PX * Math.sin(a + spread)],
  ]
}

/**
 * A DRAWING'S DIMENSION ARROWS: a head at each end of a measured line, pointing out to
 * the two points it measures between. Nothing when the line is too short to hold two
 * heads, which would only draw a knot on top of the number.
 */
function dimensionArrows(x1: number, y1: number, x2: number, y2: number): number[][] {
  if (Math.hypot(x2 - x1, y2 - y1) < 2 * ARROW_PX) return []
  return [...arrowStrokes(x2, y2, x1, y1), ...arrowStrokes(x1, y1, x2, y2)]
}

/** How wide `Label` will draw this text. Same estimate the strip uses. */
function labelW(text: string): number {
  return text.length * 6.5 + 8
}

function Label({ x, y, text }: { x: number; y: number; text: string }) {
  const w = labelW(text)
  return (
    <>
      <Rect x={x - w / 2} y={y - 9} width={w} height={16} fill="rgba(0,0,0,0.72)" cornerRadius={3} />
      <Text
        x={x - w / 2} y={y - 6} width={w} align="center"
        text={text} fontSize={11} fontFamily="monospace" fill="#ffffff"
      />
    </>
  )
}

/** One dimension: the ends in SCREEN px, and the numbers it states. */
function Dimension({ c, px, py, qx, qy, color, fmtLen, frameDeg, scale }: {
  c: DimSpec
  px: number; py: number; qx: number; qy: number
  color: string
  fmtLen: (mm: number) => string
  /** The part's own angle, CNC CCW — the axes these numbers are said along. */
  frameDeg: number
  /** Screen px per mm, for laying the legs out along those axes. */
  scale: number
}) {
  const dx = qx - px, dy = qy - py
  const span = Math.hypot(dx, dy)
  // The frame's x-axis in SCREEN terms. Screen y runs the other way up, so a
  // part standing at +30° in CNC has its axis 30° clockwise here — the same flip
  // the dimension line's own angle goes through below, taken once.
  const fr = -frameDeg * Math.PI / 180
  const fx = Math.cos(fr), fy = Math.sin(fr)
  // Screen y runs the other way up, so the stored CNC angle (CCW from +X)
  // is its negative here. Taken off the screen coordinates directly rather
  // than negating the stored number, so there is one place the flip
  // happens and it is the same place every other layer does it.
  const screenAngleDeg = Math.atan2(dy, dx) * 180 / Math.PI
  return (
    <>
      {/* THE HELD END, as a datum dot — the `from` end, which stays put when the
          numbers change (a stock edge included). Arrowheads at both ends are what a
          drawing's dimension looks like, and they say nothing about which end that is,
          which the geometry cannot say either. See the header. */}
      <Circle x={px} y={py} radius={HELD_DOT_PX} fill={color} listening={false} />
      {c.mode !== 'xy' && span >= 2 && (
        <Line points={[px, py, qx, qy]} stroke={color} strokeWidth={1} dash={[5, 3]} />
      )}
      {c.mode !== 'xy' && dimensionArrows(px, py, qx, qy).map((pts, i) => (
        <Line key={`ah${i}`} points={pts} stroke={color} strokeWidth={1.5} />
      ))}

      {/* AN X/Y CONSTRAINT DRAWS AS AN L — across, then up — so its two
          numbers sit on two different legs and can never land on top of
          each other.

          ALONG THE PART'S OWN AXES, not the world's, because that is what the
          two numbers mean: 10 in from the corner of a plate standing at 30° is
          10 along the plate's edge. The elbow is therefore computed from the
          stored X rather than taken as (qx, py) — those coincide only while the
          part is square to the world.

          THE LABELS ARE BARE NUMBERS. They used to read "X 10.00" and "Y 5.00",
          and on a turned part that lettering contradicted the drawing: the leg
          marked X ran in whatever direction the part's own x-axis happened to
          point, which on a part at 90° is straight up the screen. The leg says
          which way it measures; a lettered dimension said it twice and wrongly.
          The Constraints panel still names the axes, where a list needs to.

          A LEG OF ZERO IS NOT DRAWN AT ALL, line or label. It has no length to
          show and no direction to read a bare "0.00" against, so its label only
          floated beside the corner — and a zero on one axis is the commonest
          case there is (a row of holes, a part centred on another). The panel
          still lists the held zero. */}
      {c.mode === 'xy' && (() => {
        const legs = []
        // Below what fmtLen prints as anything but zero.
        const shown = (mm: number | undefined): mm is number => mm !== undefined && Math.abs(mm) >= 0.005
        // Where the across leg ends: X along the frame's own axis. With X not
        // held (or held at zero) there is no across leg, and the up leg runs from
        // the start point.
        const lx = (shown(c.offsetXMM) ? c.offsetXMM : 0) * scale
        const ex = px + fx * lx, ey = py + fy * lx
        // Perpendicular to the FRAME, not to the leg, so a negative offset does
        // not flip the label to the other side of its own line.
        const nx = fy * 14, ny = -fx * 14
        if (shown(c.offsetXMM)) {
          legs.push(
            <Line key="lx" points={[px, py, ex, ey]} stroke={color} strokeWidth={1} dash={[5, 3]} />,
            ...dimensionArrows(px, py, ex, ey).map((pts, i) => (
              <Line key={`ax${i}`} points={pts} stroke={color} strokeWidth={1.5} />
            )),
            <Label key="tx" x={(px + ex) / 2 + nx} y={(py + ey) / 2 + ny} text={fmtLen(c.offsetXMM)} />,
          )
        }
        if (shown(c.offsetYMM)) {
          const text = fmtLen(c.offsetYMM)
          const off = labelW(text) / 2 + 10
          legs.push(
            <Line key="ly" points={[ex, ey, qx, qy]} stroke={color} strokeWidth={1} dash={[5, 3]} />,
            ...dimensionArrows(ex, ey, qx, qy).map((pts, i) => (
              <Line key={`ay${i}`} points={pts} stroke={color} strokeWidth={1.5} />
            )),
            <Label key="ty" x={(ex + qx) / 2 + fx * off} y={(ey + qy) / 2 + fy * off} text={text} />,
          )
        }
        return <>{legs}</>
      })()}

      {/* The ANGLE, at the held end: a reference line along +X, an arc
          swept round to the dimension line, and the number outside it. Off
          at the end rather than on the line, so it can never sit on top of
          the distance. */}
      {c.mode !== 'xy' && c.angleDeg !== undefined && (() => {
        const text = `${+c.angleDeg.toFixed(1)}°`
        // Swept from the PART'S x-axis, so the arc spans exactly the number
        // printed beside it however far the part itself has been turned.
        const fromDeg = -frameDeg
        const bisect = (fromDeg + screenAngleDeg) / 2 * Math.PI / 180
        // PUSHED OUT BY THE LABEL'S EDGE, NOT ITS CENTRE. Placing the
        // centre a fixed distance beyond the arc is not enough: the box
        // is far wider than it is tall, so on a shallow angle — where the
        // bisector lies nearly along +X and the box's width points
        // straight back at the arc — its left edge reaches back over the
        // very arc it is labelling. This is the box's support distance in
        // the bisector's direction, which is exact for an axis-aligned
        // rectangle and therefore clears at every angle and every number
        // of digits.
        const reach = Math.abs(Math.cos(bisect)) * labelW(text) / 2
          + Math.abs(Math.sin(bisect)) * LABEL_H / 2
        const lr = ARC_PX + ARC_LABEL_GAP + reach
        return (
          <>
            <Line
              points={[px, py, px + fx * (ARC_PX + 6), py + fy * (ARC_PX + 6)]}
              stroke={color} strokeWidth={1} opacity={0.45} dash={[3, 3]}
            />
            <Line
              points={arcPoints(px, py, ARC_PX, fromDeg, screenAngleDeg)}
              stroke={color} strokeWidth={1}
            />
            <Label x={px + lr * Math.cos(bisect)} y={py + lr * Math.sin(bisect)} text={text} />
          </>
        )
      })()}

      {/* The DISTANCE, in the middle of the line. */}
      {c.mode !== 'xy' && c.distanceMM !== undefined && (
        <Label x={(px + qx) / 2} y={(py + qy) / 2} text={fmtLen(c.distanceMM)} />
      )}
    </>
  )
}

/** What a constraint made between these two points would hold. */
function pendingSpec(pending: PendingDim): DimSpec {
  const dx = pending.q.x - pending.p.x, dy = pending.q.y - pending.p.y
  // Said in the first part's frame, exactly as `measureBetween` will say it when
  // the click lands — the preview and the stored constraint are the same numbers
  // or the preview is worth nothing.
  // A mirrored part's y-axis runs the other way, and so do its angles.
  const r = -pending.frameDeg * Math.PI / 180
  const cos = Math.cos(r), sin = Math.sin(r)
  const sy = pending.frameFlip ? -1 : 1
  const worldDeg = Math.atan2(dy, dx) * 180 / Math.PI
  return pending.mode === 'xy'
    ? { mode: 'xy', offsetXMM: dx * cos - dy * sin, offsetYMM: sy * (dx * sin + dy * cos) }
    : {
      distanceMM: Math.hypot(dx, dy),
      angleDeg: sy * (worldDeg - pending.frameDeg),
    }
}

export const ConstraintLayer = memo(function ConstraintLayer({ viewport, pending, hideCommitted }: Props) {
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const constraints = useConstraintsStore((s) => s.constraints)
  const constraining = useUIStore((s) => s.activeTool === 'constrain')
  const subjectIds = useUIStore((s) => s.constrainSubjectIds)
  const focusConstraintId = useUIStore((s) => s.focusConstraintId)
  const { units, widthMM, heightMM } = useWorkpieceStore()

  const dims = useMemo(() => {
    if (constraints.length === 0 || hideCommitted || !constraining) return []
    const stock = { widthMM, heightMM }
    const shown = constraintsInFocus(paths, constraints, { selectedIds, subjectIds, focusConstraintId })
    return shown.flatMap((c) => {
      const ends = constraintEnds(paths, c, stock)
      return ends ? [{ c, ...ends }] : []
    })
  }, [paths, constraints, constraining, widthMM, heightMM, hideCommitted,
      selectedIds, subjectIds, focusConstraintId])

  if (dims.length === 0 && !pending) return null

  const toScreenX = (x: number) => viewport.x + x * viewport.scale
  const toScreenY = (y: number) => viewport.y - y * viewport.scale
  const fmtLen = (mm: number) => formatLen(mm, units)

  return (
    <Group listening={false}>
      {dims.map(({ c, p, q, frameDeg }) => (
        <Group key={c.id}>
          <Dimension
            c={c} color={CONSTRAINT_COLOR} fmtLen={fmtLen}
            frameDeg={frameDeg} scale={viewport.scale}
            px={toScreenX(p.x)} py={toScreenY(p.y)}
            qx={toScreenX(q.x)} qy={toScreenY(q.y)}
          />
        </Group>
      ))}
      {pending && (
        <Group key="::pending">
          <Dimension
            c={pendingSpec(pending)} color={PENDING_COLOR} fmtLen={fmtLen}
            frameDeg={pending.frameDeg} scale={viewport.scale}
            px={toScreenX(pending.p.x)} py={toScreenY(pending.p.y)}
            qx={toScreenX(pending.q.x)} qy={toScreenY(pending.q.y)}
          />
        </Group>
      )}
    </Group>
  )
})
