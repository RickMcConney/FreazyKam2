import type { ImportedPath } from '../importers/svgImporter'
import {
  getMultiBBox, getMultiBBoxAt, extractCircles, placedAngleDeg, placementMat, rotatePointAbout,
} from '../canvas/selectionUtils'
import { outerGroupOf } from './pathGroups'

// ─── Constraints ──────────────────────────────────────────────────────────────
//
// WHERE ONE PART SITS RELATIVE TO ANOTHER, held as either is edited. Everything
// else in the document is a property OF an object — `shapeParams`, `definition`,
// `placement`, `corners` — and rides on it. A constraint is the one thing that
// belongs to neither of its ends, so it lives in a store of its own
// (`constraintsStore`) rather than being stamped onto both paths the way a
// clock's spec is onto its parts.
//
// ONE CONSTRAINT PER PAIR, HOLDING A DISTANCE AND AN ANGLE — polar, not X and Y.
// It replaced separate X and Y constraints and is better on three counts:
//
//  - It DRAWS. An X dimension and a Y dimension between the same two centres are
//    two labels fighting for the same midpoint, and on the everyday case — parts
//    standing in a row, so the Y distance is zero — the Y dimension collapses to
//    a point sitting exactly on the X label and one of the two numbers simply
//    cannot be read. A distance goes along the line and an angle goes in an arc
//    at the far end: two different places, always.
//  - It is the way the work is actually described. A centre distance and a
//    direction is what a linkage, a bolt circle or a gear train is dimensioned
//    by — and it is already this app's own model for a clock, whose `ClockSpec`
//    stores `linkAngles` and never the link lengths those angles force.
//  - It makes the graph simple. Two constraints per pair meant reasoning about
//    which of them fixed which degree of freedom; one edge per pair means a
//    component is solvable exactly when it is a forest, and a cycle is the whole
//    of what over-constrained means.
//
// Either half may be left off: distance alone lets the part swing on a circle,
// angle alone lets it slide along the ray, and both together pin it outright.
//
// THERE IS NO ROOT. The solve starts from whatever the current edit moved (see
// `solveConstraints`), so every part of a chain is equally draggable and the
// rest follow. `from`/`to` survives for one question only — which end takes up a
// change to the NUMBERS — and that is what the dot on the dimension's held
// (`from`) end marks. What this buys against a bidirectional sketch solver: the walk is
// exact and identical every run (so a toolpath can be diffed byte-for-byte
// across a constraint edit), a cycle is an error the user is told about rather
// than a system quietly converging on one of several answers, and it emits a
// TRANSLATE — the same road a drag takes — so nothing downstream (CAM, sim,
// save, export) learns a new concept.
//
// EVERY NUMBER IS STATED IN THE `from` PART'S OWN FRAME, and every anchor is a
// corner of that part's box MEASURED IN THAT FRAME. Both used to be world-axis,
// and the everyday case broke: four holes constrained to the corners of a plate
// followed a SCALE correctly and flew apart under a ROTATE, because an
// axis-aligned box round a tilted rectangle grows by √2 and its corners stand
// out in empty space. Stating the offsets in the parent's frame is the other
// half — "10 in from that corner" means along the plate's edges, or it is not
// what a machinist drew. Rotation only, never scale or shear: a typed 10 mm
// stays 10 mm when the plate is stretched, which `placement` makes easy to hold
// because a scale edits the definition and never lands there.
//
// With those two, a chain rotates correctly through a solve that only ever
// TRANSLATES — the target point turns with the parent, so a round hole needs
// nothing more. `alignDeg` is what the parts that are not round need: it holds
// the angle BETWEEN the two parts, so the follower turns as well as moves, and
// the whole chain behaves like the group the user thinks it is.
//
// Nothing here touches the store. Data in, moves out, so it tests in the node
// environment the rest of the suite runs in.

/** Which point of a part a constraint measures from. */
export type Anchor =
  | 'center' | 'minX' | 'maxX' | 'minY' | 'maxY'
  // THE CORNERS, which the edge anchors cannot stand in for: `minX` is the
  // MIDPOINT of the left edge, so "20 mm in from the top-left corner" had no way
  // to be said at all — and a hole in the corner of a plate is the commonest
  // thing there is to place off a rectangle.
  | 'minXminY' | 'maxXminY' | 'minXmaxY' | 'maxXmaxY'

// Deliberately NOT a point index into the `d` string. `corners` already
// documents where that road ends: `treatments` is keyed by corner index and any
// edit that rewrites the outline makes those indices point at different corners,
// so the whole recipe has to be dropped. A bbox anchor and a circle centre
// survive every edit that leaves the part recognisably itself, which is the only
// kind of endpoint worth building on first.
export type GeomRef =
  | { kind: 'path'; id: string; anchor: Anchor }
  /** The centre of the part's roundest subpath — a bore, a hole, a pitch
   *  circle. `extractCircles` already refuses a PLACED shape's parameters and
   *  reads the outline instead, so a rotated bore reports where it actually is. */
  | { kind: 'circle'; id: string }
  /** An edge of the stock. GROUND: nothing moves it, and it outranks even a
   *  drag — a part held 20 mm in from the left edge is 20 mm in from it however
   *  it is dragged. An angle means nothing against an edge (the point on the
   *  edge slides with the part), so a stock constraint holds a distance only. */
  | { kind: 'stock'; edge: 'left' | 'right' | 'bottom' | 'top' }

export interface Constraint {
  id: string
  /** The end a change to the numbers holds still. Either end may be DRAGGED. */
  from: GeomRef
  to: GeomRef
  /**
   * HOW THE RELATIONSHIP IS STATED. Absent means `'polar'`, which is what every
   * constraint was before X/Y came back.
   *
   * Polar — a distance and a direction — is how a linkage, a bolt circle or a
   * gear train is dimensioned, and it draws cleanly (the distance along the
   * line, the angle in an arc at the far end). But it is the wrong description
   * for the commonest job of all: a hole in the corner of a plate is "15 in from
   * that edge and 20 down from that one", two numbers a machinist reads off the
   * drawing, and turning that into a distance and an angle is arithmetic nobody
   * should have to do. Both are the same two degrees of freedom said two ways,
   * so the constraint carries a mode and the panel offers whichever pair suits
   * the part being placed.
   */
  mode?: 'polar' | 'xy'
  /** Centre distance in mm — mm being the only storage unit. Polar only. Absent
   *  means the distance is not held, and the part may swing on its circle. */
  distanceMM?: number
  /** Direction from `from` to `to`, DEGREES CCW (CNC Y-up, CCW positive — the
   *  same convention as everywhere else in this app) FROM THE `from` PART'S OWN
   *  X-AXIS, which is the world +X axis until that part is turned. Polar only.
   *  Absent means the direction is not held, and the part may slide along the
   *  ray. */
  angleDeg?: number
  /** How far `to` sits to the RIGHT of `from`, mm, signed — along the `from`
   *  part's own x-axis, so "10 in from that corner" follows the plate round when
   *  it turns. X/Y mode only. Absent means X is not held. */
  offsetXMM?: number
  /** How far `to` sits ABOVE `from`, mm, signed — the `from` part's own y-axis,
   *  and CNC Y-up, so positive is up. X/Y mode only. Absent means Y is not
   *  held. */
  offsetYMM?: number
  /**
   * HOW FAR `to` STANDS TURNED RELATIVE TO `from`, degrees CCW. Absent means the
   * angle between the parts is not held and each turns on its own.
   *
   * The third degree of freedom, and the one that makes a chain behave like the
   * group the user thinks it is: turn the plate and the slot in it turns with
   * it, rather than sliding to the new corner still standing upright. Held at
   * whatever it was created at, so a part deliberately set at 15° to its parent
   * keeps its 15°.
   *
   * Both modes, and NOT a stock constraint — the stock does not turn, and an
   * angle against ground is what the `angleDeg` comment says it is: meaningless.
   * Set on every new part-to-part constraint, because a follower that does not
   * turn with what holds it is the surprising case, not the other way round.
   */
  alignDeg?: number
}

/** Does this constraint hold anything at all? */
export function isLiveConstraint(c: Constraint): boolean {
  if (c.alignDeg !== undefined) return true
  return c.mode === 'xy'
    ? c.offsetXMM !== undefined || c.offsetYMM !== undefined
    : c.distanceMM !== undefined || c.angleDeg !== undefined
}

/** How a constraint reads in a chip label and a status message. */
export function constraintName(c: Constraint): string {
  if (c.mode === 'xy') {
    if (c.offsetXMM !== undefined && c.offsetYMM !== undefined) return 'Offset'
    if (c.offsetXMM !== undefined) return 'X offset'
    if (c.offsetYMM !== undefined) return 'Y offset'
    return 'Aligned'
  }
  if (c.distanceMM !== undefined && c.angleDeg !== undefined) return 'Position'
  if (c.angleDeg !== undefined) return 'Angle'
  if (c.distanceMM !== undefined) return 'Distance'
  return 'Aligned'
}

export const ANCHOR_NAMES: Record<Anchor, string> = {
  center: 'centre', minX: 'left', maxX: 'right', minY: 'bottom', maxY: 'top',
  minXminY: 'bottom-left', maxXminY: 'bottom-right',
  minXmaxY: 'top-left', maxXmaxY: 'top-right',
}

export interface Stock { widthMM: number; heightMM: number }

export interface ConstraintMove {
  bodyKey: string
  pathIds: string[]
  dx: number
  dy: number
  /**
   * How far the body has to TURN, degrees CCW, when the constraint holds the
   * angle between the parts (`alignDeg`). Absent, and the move is the pure
   * translation it always was.
   *
   * About `pivot`, and the pivot is the very point the constraint measures to —
   * so the turn leaves that point where the translation put it and the two halves
   * of the move are independent. Applied BEFORE the translation, which is the
   * order `enforceConstraints` writes its steps in.
   */
  rotDeg?: number
  pivot?: { x: number; y: number }
}

export interface ConstraintSolution {
  moves: ConstraintMove[]
  /** Human-readable reason the solve was refused, or null. */
  error: string | null
  /** The constraints that error names, so the UI can flag exactly those. */
  badIds: string[]
}

/** Below this a move is nothing — the constraint is already satisfied. */
const EPS = 1e-9
/**
 * …and below THIS a slide is nothing either, because the geometry cannot hold it.
 *
 * A `d` string keeps 4 decimals (`fmt` in svgImporter), so every baked move lands
 * on a 0.0001 mm grid and every point read back off it carries up to half that in
 * rounding. A correction finer than the grid can never be satisfied: the solve
 * asked for 0.00005 mm, rounding put the part back where it was, and the next
 * solve asked again — for ever. Since a solve runs on every edit, a document of
 * turned, constrained parts rewrote two dozen paths' `d` on EVERY edit anywhere
 * and regenerated all of their toolpaths. Five grid steps: clear of anything
 * rounding produces, and still three orders of magnitude inside a cut.
 */
const SETTLED_MM = 5e-4
/** …and below this a turn is nothing. Degrees, so it is a looser figure. */
const ANGLE_EPS = 1e-7

// ─── Bodies ───────────────────────────────────────────────────────────────────

/**
 * The unit a constraint moves.
 *
 * NOT a bare path. A gear is seven paths sharing a `groupId`, and moving its
 * teeth without its bore and spokes would take the gear apart — so the body is
 * the same thing the object strip draws one chip for: the outermost user group
 * if there is one, else the generator's group, else the lone path. A part that
 * has been dragged off on its own is still inside its group and still moves with
 * it, which is right: the drag chose where it sits RELATIVE to the shape, and a
 * constraint moves the shape.
 */
export function bodyKeyOf(p: ImportedPath): string {
  return outerGroupOf(p) ?? p.groupId ?? p.id
}

/** Every path of the body the given path id belongs to. */
export function bodyPathsOf(paths: ImportedPath[], pathId: string): ImportedPath[] {
  const self = paths.find((p) => p.id === pathId)
  if (!self) return []
  const key = bodyKeyOf(self)
  return paths.filter((p) => bodyKeyOf(p) === key)
}

/**
 * The OBJECT a path belongs to — the generator's multi-part shape, or the lone
 * path. The body without its user group.
 *
 * A gear's seven paths are one object because a gear IS seven paths; a user
 * group is a container the user makes and unmakes at will, and the two shapes
 * inside it are still two shapes. That difference is what `endsOf` needs when a
 * constraint's two ends land in the same body — see there.
 */
function objectPathsOf(paths: ImportedPath[], pathId: string): ImportedPath[] {
  const self = paths.find((p) => p.id === pathId)
  if (!self) return []
  const key = self.groupId ?? self.id
  return paths.filter((p) => (p.groupId ?? p.id) === key)
}

/** The paths a ref measures against: its body, or — when the whole constraint
 *  lives inside one body — just its own object. */
function refPathsOf(paths: ImportedPath[], pathId: string, narrow: boolean): ImportedPath[] {
  return narrow ? objectPathsOf(paths, pathId) : bodyPathsOf(paths, pathId)
}

/** The body a ref names, or null for the stock (which is ground). */
function refBodyKey(paths: ImportedPath[], ref: GeomRef): string | null {
  if (ref.kind === 'stock') return null
  const self = paths.find((p) => p.id === ref.id)
  return self ? bodyKeyOf(self) : null
}

// ─── Frames ───────────────────────────────────────────────────────────────────

/** Angles are only ever compared, so they are kept in (−180, 180]. */
function norm180(deg: number): number {
  let d = deg % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return Math.abs(d) < 1e-9 ? 0 : d
}

/**
 * A part's own axes: its x-axis turned `deg` CCW from the world's, and its
 * y-axis a quarter turn further on — or a quarter turn BACK when `flip`, which is
 * what a mirror does to a part.
 *
 * THE MIRROR IS HALF OF THE FRAME, not a detail of it. A mirror flips the part's
 * y-axis and leaves its x-axis where the angle says, so a frame that only knew
 * the angle read a mirrored part's offsets along the wrong half of its own axes:
 * mirror a plate together with the holes constrained to it and every Y offset and
 * every held angle between them came out with the wrong sign, and the next edit
 * anywhere in the document "corrected" the holes into mirror image of where they
 * were cut — sliding them out of the part, and turning the ones held at an angle.
 * Stated along the part's axes AS MIRRORED, a part and its holes mirrored
 * together keep every number they were created with, exactly as a part and its
 * holes turned together do.
 */
export interface Frame { deg: number; flip: boolean }

const WORLD: Frame = { deg: 0, flip: false }

/** Whether a placement recipe mirrors the part — an odd number of reflections,
 *  however they have been folded together with turns. */
function placementFlips(steps: ImportedPath['placement']): boolean {
  if (!steps?.length) return false
  const [a, b, c, d] = placementMat(steps)
  return a * d - b * c < 0
}

/**
 * How a BODY stands — how far turned, in degrees CCW, and whether mirrored.
 *
 * Read off `placement`, which is where a rotate or a mirror lands (neither can be
 * absorbed by any shape's parameters, so they spill into the recipe) and the only
 * place the answer exists — a rotation baked into a polyline is unrecoverable
 * from the polyline. Over the whole body, since a multi-part shape is several
 * paths and they turn together; parts at genuinely DIFFERENT angles, or some
 * mirrored and some not, have no single answer and the world frame is what this
 * can honestly say, which is also what the properties panel's Angle field says
 * about the same selection.
 *
 * Anything that would MOVE a part on the strength of it must refuse when the
 * answer is not `known`: the world frame standing in for "no idea" would turn
 * such a body by the full frame angle on every single solve, and a solve that is
 * not idempotent spins a part further with every edit.
 *
 * A CIRCLE HAS NO VOTE. It looks the same at every angle, so the angle its recipe
 * reads is an accident of how it was made: a group of holes copied and flipped as
 * a set had six reading 90° (turned, then mirrored) and three reading 180°
 * (mirrored only), the same holes on the drawing, and that "disagreement" left the
 * group with no frame — so the frame hung off it rotated and the holes stayed put.
 * The other parts decide. A body of NOTHING but circles has no honest
 * orientation of its own, so its first part's reading stands in. That reading is
 * still a fact rather than the world frame's fallback: a turn adds the same step
 * to every part's recipe, so the next solve reads the angle it just turned to and
 * asks for nothing more.
 */
export function bodyFrame(bodyPaths: ImportedPath[]): Frame & { known: boolean } {
  const shaped = bodyPaths.filter((p) => p.shapeParams?.type !== 'circle')
  const voters = shaped.length > 0 ? shaped : bodyPaths.slice(0, 1)
  let frame: Frame | null = null
  for (const p of voters) {
    const deg = placedAngleDeg(p.placement)
    const flip = placementFlips(p.placement)
    if (frame === null) frame = { deg, flip }
    else if (flip !== frame.flip || Math.abs(norm180(deg - frame.deg)) > 1e-6) {
      return { ...WORLD, known: false }
    }
  }
  return frame ? { ...frame, known: true } : { ...WORLD, known: false }
}

/**
 * The frame a constraint's numbers are stated in: the `from` end's body.
 *
 * The world for the stock, which is ground and square to the world by
 * definition. Exported because the panel and the canvas have to read the same
 * numbers back — a dimension drawn along the world axes under a figure measured
 * along the part's would be a drawing that lies.
 */
export function constraintFrame(paths: ImportedPath[], ref: GeomRef, narrow = false): Frame {
  if (ref.kind === 'stock') return WORLD
  const { deg, flip } = bodyFrame(refPathsOf(paths, ref.id, narrow))
  return { deg, flip }
}

/** A world vector, said along a frame's axes. */
function toFrame(vx: number, vy: number, frame: Frame): { x: number; y: number } {
  const p = rotatePointAbout({ x: vx, y: vy }, ORIGIN, -frame.deg)
  return { x: p.x, y: frame.flip ? -p.y : p.y }
}

/** …and back out again. */
function fromFrame(fx: number, fy: number, frame: Frame): { x: number; y: number } {
  const p = rotatePointAbout({ x: fx, y: frame.flip ? -fy : fy }, ORIGIN, frame.deg)
  return { x: p.x, y: p.y }
}

/** A world direction (degrees CCW) as an angle measured in a frame — mirrored,
 *  a frame measures its angles the other way round. */
function angleInFrame(worldDeg: number, frame: Frame): number {
  return frame.flip ? frame.deg - worldDeg : worldDeg - frame.deg
}

/** …and a frame's angle back out as a world direction. */
function angleFromFrame(localDeg: number, frame: Frame): number {
  return frame.flip ? frame.deg - localDeg : frame.deg + localDeg
}

const ORIGIN = { x: 0, y: 0 }

// ─── Points ───────────────────────────────────────────────────────────────────

/**
 * Where a ref sits, given the offset its body has already accumulated in this
 * solve.
 *
 * `other` is the point at the far end of the same constraint, and it is what a
 * STOCK edge uses for its free coordinate: "50 mm from the left edge" is a
 * perpendicular distance, so the left edge's y is whatever the part's y is. Both
 * ends being stock has no meaning and is refused when the constraint is created.
 */
function pointOf(
  paths: ImportedPath[],
  ref: GeomRef,
  stock: Stock,
  offset: { dx: number; dy: number },
  other: { x: number; y: number } | null,
  /** Measure against the ref's own OBJECT rather than its body — see `endsOf`. */
  narrow = false,
): { x: number; y: number } | null {
  if (ref.kind === 'stock') {
    switch (ref.edge) {
      case 'left': return { x: 0, y: other?.y ?? stock.heightMM / 2 }
      case 'right': return { x: stock.widthMM, y: other?.y ?? stock.heightMM / 2 }
      case 'bottom': return { x: other?.x ?? stock.widthMM / 2, y: 0 }
      case 'top': return { x: other?.x ?? stock.widthMM / 2, y: stock.heightMM }
    }
  }
  if (ref.kind === 'circle') {
    const self = paths.find((p) => p.id === ref.id)
    if (!self) return null
    const circles = extractCircles(self)
    if (circles.length > 0) {
      // The biggest one: a gear's teeth path is a rim with a bore inside it, and
      // the rim is the circle that says where the gear IS.
      const c = circles.reduce((a, b) => (b.radiusMM > a.radiusMM ? b : a))
      return { x: c.cx + offset.dx, y: c.cy + offset.dy }
    }
    // Not round after all — fall back to the middle of it rather than dropping
    // the constraint, which would move a part without saying why.
    const bb = getMultiBBox([self.d])
    return bb ? { x: bb.cx + offset.dx, y: bb.cy + offset.dy } : null
  }
  // A path anchor reads the whole BODY's bounding box — the same extent the
  // properties panel reports as the selection's position, so the number a
  // constraint states and the number the panel shows are the same number.
  //
  // MEASURED IN THE BODY'S OWN FRAME. `maxXmaxY` means the part's top-right
  // CORNER, and on a part standing at 30° the world-axis box has no such point:
  // its corners are out in space where the geometry is not, so a hole hung off
  // one flew outward as the plate turned and came home again at 90°. Taken at
  // the body's own angle and carried back out, the corner is the corner. A
  // square part takes the same road it always did, to the digit.
  //
  // And mirrored with the body, so `maxXmaxY` stays on the same corner of the
  // MATERIAL: the box is taken along the part's axes as mirrored, where the part's
  // own y runs the other way.
  const body = refPathsOf(paths, ref.id, narrow)
  if (body.length === 0) return null
  const frame = bodyFrame(body)
  const turnedBox = getMultiBBoxAt(body.map((p) => p.d), frame.deg)
  if (!turnedBox) return null
  const bb = frame.flip
    ? { ...turnedBox, minY: -turnedBox.maxY, maxY: -turnedBox.minY, cy: -turnedBox.cy }
    : turnedBox
  const local = (() => {
    switch (ref.anchor) {
      case 'center': return { x: bb.cx, y: bb.cy }
      case 'minX': return { x: bb.minX, y: bb.cy }
      case 'maxX': return { x: bb.maxX, y: bb.cy }
      case 'minY': return { x: bb.cx, y: bb.minY }
      case 'maxY': return { x: bb.cx, y: bb.maxY }
      case 'minXminY': return { x: bb.minX, y: bb.minY }
      case 'maxXminY': return { x: bb.maxX, y: bb.minY }
      case 'minXmaxY': return { x: bb.minX, y: bb.maxY }
      case 'maxXmaxY': return { x: bb.maxX, y: bb.maxY }
    }
  })()
  const pt = fromFrame(local.x, local.y, frame)
  return { x: pt.x + offset.dx, y: pt.y + offset.dy }
}

/**
 * Both ends of a constraint, resolved against the offsets so far.
 *
 * BOTH ENDS ON ONE BODY IS A MEASUREMENT, AND IT STILL HAS TO MEASURE
 * SOMETHING. Group two constrained shapes and they become one body — the group
 * is what moves, and `planConstraints` drops the constraint from the solve for
 * exactly that reason. But a bbox anchor resolved against the BODY then reads
 * the group's own box at BOTH ends, so the two ends land on the same point: the
 * dimension collapsed to a dot in the middle of the group and read zero, while
 * the panel went on printing the stored numbers. So when the whole constraint is
 * inside one body, each end falls back to its own OBJECT, which is the shape it
 * was picked on and has not moved. Ungrouping restores the body reading, and
 * neither reading ever changes the geometry.
 */
function endsOf(
  paths: ImportedPath[],
  c: Constraint,
  stock: Stock,
  offsets: Map<string, { dx: number; dy: number }>,
): { p: { x: number; y: number }; q: { x: number; y: number } } | null {
  const ZERO = { dx: 0, dy: 0 }
  const fromKey = refBodyKey(paths, c.from)
  const toKey = refBodyKey(paths, c.to)
  const narrow = sameBody(fromKey, toKey)
  // The non-stock end first, so a stock edge has something to take its free
  // coordinate from.
  if (c.from.kind === 'stock') {
    const q = pointOf(paths, c.to, stock, (toKey && offsets.get(toKey)) || ZERO, null, narrow)
    if (!q) return null
    const p = pointOf(paths, c.from, stock, ZERO, q, narrow)
    return p ? { p, q } : null
  }
  const p = pointOf(paths, c.from, stock, (fromKey && offsets.get(fromKey)) || ZERO, null, narrow)
  if (!p) return null
  const q = pointOf(paths, c.to, stock, (toKey && offsets.get(toKey)) || ZERO, p, narrow)
  return q ? { p, q } : null
}

/** Whether a constraint's two ends sit on the same body — the stock is ground
 *  and never shares one, so a null key is never equal to anything. */
function sameBody(fromKey: string | null, toKey: string | null): boolean {
  return fromKey !== null && fromKey === toKey
}

/**
 * Both ends of a constraint in CNC mm, for drawing the dimension on canvas.
 *
 * The same resolution the solve uses, so what is drawn is what is being held —
 * a dimension line computed a second way would eventually disagree with the
 * geometry and there would be no telling which was right.
 */
export function constraintEnds(
  paths: ImportedPath[],
  c: Constraint,
  stock: Stock,
): { p: { x: number; y: number }; q: { x: number; y: number }; frameDeg: number } | null {
  const ends = endsOf(paths, c, stock, new Map())
  // The frame comes with them: the numbers are stated along the `from` part's
  // axes, so a dimension drawn along the world's would be a drawing that lies
  // about the figures printed on it. Narrowed with the ends when the constraint
  // is inside one body, or the dimension would be drawn between two shapes at
  // the angle of the group around them.
  const narrow = sameBody(refBodyKey(paths, c.from), refBodyKey(paths, c.to))
  return ends ? { ...ends, frameDeg: constraintFrame(paths, c.from, narrow).deg } : null
}

/**
 * The distance and angle two ends currently stand at.
 *
 * A new constraint is created from THIS, so making one never moves anything —
 * the CAD convention, and the only behaviour that lets a constraint be added
 * just to read the numbers off before deciding whether to change them.
 */
export function measureBetween(
  paths: ImportedPath[],
  from: GeomRef,
  to: GeomRef,
  stock: Stock,
): {
  distanceMM: number; angleDeg: number
  offsetXMM: number; offsetYMM: number
  alignDeg: number; frameDeg: number; frameFlip: boolean
} | null {
  const ends = endsOf(paths, { id: '', from, to }, stock, new Map())
  if (!ends) return null
  const narrow = sameBody(refBodyKey(paths, from), refBodyKey(paths, to))
  const dx = ends.q.x - ends.p.x, dy = ends.q.y - ends.p.y
  // IN THE `from` PART'S FRAME, which is the whole point: read back in world
  // axes, a constraint created against a plate standing at 30° would be stored
  // holding numbers the solve then re-reads as frame numbers, and the part would
  // jump 30° round the moment it was made. A part at 0° measures identically to
  // before.
  const frame = constraintFrame(paths, from, narrow)
  const f = toFrame(dx, dy, frame)
  // Both descriptions of the same gap, so a constraint can be created in — or
  // switched to — either mode without ever having to be measured a second way.
  return {
    distanceMM: Math.hypot(dx, dy),
    angleDeg: norm180(angleInFrame(Math.atan2(dy, dx) * 180 / Math.PI, frame)),
    offsetXMM: f.x,
    offsetYMM: f.y,
    // How far `to` stands turned, measured in the `from` part's frame — so the
    // other way round when that part is mirrored, which is what lets a mirrored
    // pair keep the angle it was made at.
    alignDeg: norm180(angleInFrame(constraintFrame(paths, to, narrow).deg, frame)),
    frameDeg: frame.deg,
    frameFlip: frame.flip,
  }
}

/**
 * Where the moving end has to go.
 *
 * `reversed` means the walk arrived from the `to` end and is placing the `from`
 * end — the constraint states `to = from + (distance ∠ angle)`, so read the
 * other way it states `from = to − (distance ∠ angle)`. Getting that backwards
 * is not a subtle error: it puts the far part on the wrong SIDE, and a row of
 * parts constrained left-to-right comes out with whichever one was dragged
 * sitting at the left.
 *
 * Whichever half of the constraint is absent falls back to what the parts
 * currently stand at, so a distance-only constraint turns the part on its circle
 * without touching its direction, and an angle-only one slides it along the ray.
 */
function targetOf(
  c: Constraint,
  held: { x: number; y: number },
  moving: { x: number; y: number },
  reversed: boolean,
  ignoreAngle: boolean,
  frame: Frame,
): { x: number; y: number } {
  const from = reversed ? moving : held
  const to = reversed ? held : moving
  const vx = to.x - from.x, vy = to.y - from.y

  if (c.mode === 'xy') {
    // IN THE FRAME, both ways round: the stored offsets are said along the
    // `from` part's own axes, so the gap the parts currently stand at has to be
    // said the same way before either half can be substituted into it.
    // Whichever offset is absent falls back to what the parts stand at, exactly
    // as an absent distance or angle does — so "hold X, leave Y alone" needs no
    // second concept. Signed, and reversing swaps which way they point, for the
    // same reason an angle turns through 180°.
    const v = toFrame(vx, vy, frame)
    const d = fromFrame(c.offsetXMM ?? v.x, c.offsetYMM ?? v.y, frame)
    return reversed ? { x: to.x - d.x, y: to.y - d.y } : { x: from.x + d.x, y: from.y + d.y }
  }

  const len = c.distanceMM ?? Math.hypot(vx, vy)
  const ang = !ignoreAngle && c.angleDeg !== undefined
    // Frame-relative too, and for the same reason: 0° means "along the parent's
    // own x-axis", so a row of parts laid out at 0° stays a row when the part
    // holding them is turned.
    ? angleFromFrame(c.angleDeg, frame) * Math.PI / 180
    // Coincident points have no direction to hold, and nothing in the drawing
    // has an opinion — +x is at least the same answer every time.
    : (Math.abs(vx) < EPS && Math.abs(vy) < EPS ? 0 : Math.atan2(vy, vx))
  const ux = Math.cos(ang) * len, uy = Math.sin(ang) * len
  return reversed ? { x: to.x - ux, y: to.y - uy } : { x: from.x + ux, y: from.y + uy }
}

// ─── The solve ────────────────────────────────────────────────────────────────

/** The stock, as a node in the axis graphs: ground, and there is one of it. */
const GROUND = '::stock'

/** Which stock edge belongs to which axis. */
const EDGE_AXIS = { left: 'x', right: 'x', bottom: 'y', top: 'y' } as const

/**
 * Which axes a constraint takes the freedom to move in away from its `to` end.
 *
 * A part-to-part constraint counts against BOTH, whether or not both halves are
 * filled in. That is conservative in the one place it matters: a part held to
 * another part AND pinned to the stock is a genuine argument about where it
 * goes, and this is what turns it into an error the user is told about instead
 * of a distance quietly left unsatisfied. A stock constraint counts against its
 * own axis only, which is what lets a part be held off the left edge and the
 * bottom edge at the same time.
 */
function axesOf(c: Constraint): ('x' | 'y')[] {
  if (c.from.kind === 'stock') return [EDGE_AXIS[c.from.edge]]
  if (c.to.kind === 'stock') return [EDGE_AXIS[c.to.edge]]
  return ['x', 'y']
}

/**
 * The constraints that make one axis over-constrained, or null when it is free.
 *
 * ONE AXIS AT A TIME, over an UNDIRECTED graph of bodies with the stock as a
 * single ground node. Each body has one degree of freedom per axis and each
 * constraint takes one away, so an arrangement is solvable exactly when that
 * axis's graph is a FOREST — and a cycle in it is one constraint more than there
 * is freedom to absorb, whichever way round the constraints happen to be
 * written. Per axis rather than over one combined graph, because a combined
 * graph would refuse a part held off two different stock edges, which is
 * perfectly determinate and an ordinary thing to want.
 */
function axisOverConstrained(
  paths: ImportedPath[],
  active: Constraint[],
  axis: 'x' | 'y',
): Constraint[] | null {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let at = k
    while ((parent.get(at) ?? at) !== at) at = parent.get(at)!
    parent.set(k, at)
    return at
  }
  const mine = active.filter((c) => axesOf(c).includes(axis))
  const closing: Constraint[] = []
  for (const c of mine) {
    const a = refBodyKey(paths, c.from) ?? GROUND
    const b = refBodyKey(paths, c.to) ?? GROUND
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a), rb = find(b)
    if (ra === rb) { closing.push(c); continue }
    parent.set(ra, rb)
  }
  if (closing.length === 0) return null
  // Report the WHOLE component, not just the edge that closed it: which of the
  // constraints in a loop is "the extra one" is not a question with an answer,
  // and naming only the last one written would send the user off to fix
  // something no more at fault than its neighbours.
  const guilty = new Set(closing.map((c) => find(refBodyKey(paths, c.to) ?? GROUND)))
  return mine.filter((c) => guilty.has(find(refBodyKey(paths, c.to) ?? GROUND)))
}

// ─── The plan, and running it ─────────────────────────────────────────────────
//
// The solve is split in two so a DRAG can preview it every mousemove frame.
// Resolving where a constraint's ends sit means flattening geometry
// (`getMultiBBox` over every path of a body), which is far too much to repeat at
// pointer rate on a gear. But none of it CHANGES during a drag: the `d` strings
// stay put until mouse-up, and every body moves by a pure translation, so a
// point is its resolved base plus whatever offset its body has picked up.
//
// So `planConstraints` does the flattening and settles the walk ORDER once, and
// `runPlan` is arithmetic over that plan. The real solve is the same two calls
// with no drag offset — one implementation of the ordering, so the preview and
// what lands on mouse-up cannot drift apart.

type PlanEnd =
  | { kind: 'body'; body: string; base: { x: number; y: number } }
  | { kind: 'stock'; edge: 'left' | 'right' | 'bottom' | 'top' }

interface PlanStep {
  c: Constraint
  /** Already placed when this step runs. */
  held: PlanEnd
  /** The body this step places. */
  moving: { kind: 'body'; body: string; base: { x: number; y: number } }
  /** The moving end is the constraint's `from` end, so its numbers reverse. */
  reversed: boolean
  /** How far each end's body stood turned when the plan was made. Resolved here
   *  rather than in `runPlan` for the same reason the points are: reading it
   *  means walking the body's paths, and none of it changes during a drag. */
  heldBaseDeg: number
  movingBaseDeg: number
  /** Whether each end's body is mirrored, which decides which way round its
   *  angles run. A turn never changes it, so it is a constant of the plan. */
  heldFlip: boolean
  movingFlip: boolean
  /** Whether the moving body's angle is a fact or a fallback — see `bodyFrame`.
   *  A body whose parts stand at different angles has no single answer, and
   *  turning it on the strength of a made-up one never converges. */
  movingAngleKnown: boolean
}

export interface ConstraintPlan {
  steps: PlanStep[]
  /** Bodies a drag is holding; `runPlan` seeds these with its offset. */
  anchors: string[]
  pathsByBody: Map<string, string[]>
  stock: Stock
}

/** Where a stock edge sits, taking its free coordinate from the other end. */
function stockPoint(
  edge: 'left' | 'right' | 'bottom' | 'top',
  stock: Stock,
  other: { x: number; y: number } | null,
): { x: number; y: number } {
  switch (edge) {
    case 'left': return { x: 0, y: other?.y ?? stock.heightMM / 2 }
    case 'right': return { x: stock.widthMM, y: other?.y ?? stock.heightMM / 2 }
    case 'bottom': return { x: other?.x ?? stock.widthMM / 2, y: 0 }
    case 'top': return { x: other?.x ?? stock.widthMM / 2, y: stock.heightMM }
  }
}

/**
 * Settle the walk order and resolve every end, once.
 *
 * Everything expensive happens here. The result is valid for as long as the
 * geometry and the constraints are unchanged — which is exactly the life of one
 * drag — and `error` is the same refusal `solveConstraints` reports.
 */
export function planConstraints(
  paths: ImportedPath[],
  constraints: Constraint[],
  stock: Stock,
  anchorIds: string[] = [],
): { plan: ConstraintPlan | null; error: string | null; badIds: string[] } {
  const nothing = { plan: null, error: null, badIds: [] as string[] }
  if (constraints.length === 0) return nothing

  // A constraint whose parts have gone is not an error — deleting a path drops
  // its constraints in the same edit, and a solve running against a half-applied
  // state (a load, an undo) should do nothing rather than complain. Nor is one
  // holding neither a distance nor an angle: that is one the user has switched
  // off, and it holds nothing.
  const live = new Set(paths.map((p) => p.id))
  const active = constraints.filter((c) => {
    if (!isLiveConstraint(c)) return false
    if (c.from.kind !== 'stock' && !live.has(c.from.id)) return false
    if (c.to.kind !== 'stock' && !live.has(c.to.id)) return false
    const fromKey = refBodyKey(paths, c.from)
    const toKey = refBodyKey(paths, c.to)
    // Both ends on one body is not a constraint, it is a measurement.
    return toKey !== null && fromKey !== toKey
  })
  if (active.length === 0) return nothing

  for (const axis of ['x', 'y'] as const) {
    const bad = axisOverConstrained(paths, active, axis)
    if (!bad) continue
    const names = [...new Set(bad.flatMap((c) => [c.from, c.to].flatMap((r) => {
      const k = refBodyKey(paths, r)
      return k ? [nameOfBody(paths, k)] : []
    })))]
    const listed = names.slice(0, 3).join(', ')
      + (names.length > 3 ? ` and ${names.length - 3} more` : '')
    return {
      plan: null, badIds: bad.map((c) => c.id),
      error: `Over-constrained in ${axis.toUpperCase()}: ${listed} `
        + 'are held by more constraints than they have room to satisfy. Delete one.',
    }
  }

  // Every end resolved once, at zero offset. A body's point during the walk is
  // this plus its accumulated offset, because every move is a translation.
  const ZERO = { dx: 0, dy: 0 }
  const endFor = (ref: GeomRef): PlanEnd | null => {
    if (ref.kind === 'stock') return { kind: 'stock', edge: ref.edge }
    const body = refBodyKey(paths, ref)
    const base = pointOf(paths, ref, stock, ZERO, null)
    return body && base ? { kind: 'body', body, base } : null
  }
  const ends = new Map<string, { from: PlanEnd; to: PlanEnd }>()
  for (const c of active) {
    const from = endFor(c.from), to = endFor(c.to)
    if (from && to) ends.set(c.id, { from, to })
  }

  // ── The undirected graph ───────────────────────────────────────────────────
  const adj = new Map<string, { c: Constraint; other: string }[]>()
  const seen = (k: string) => { if (!adj.has(k)) adj.set(k, []) }
  const link = (at: string, c: Constraint, other: string) => { seen(at); adj.get(at)!.push({ c, other }) }
  const driven = new Set<string>()
  const groundedBy = new Map<string, Constraint[]>()
  for (const c of active) {
    if (!ends.has(c.id)) continue
    const fromKey = refBodyKey(paths, c.from)
    const toKey = refBodyKey(paths, c.to)!
    driven.add(toKey)
    if (fromKey === null) {
      seen(toKey)
      const list = groundedBy.get(toKey)
      if (list) list.push(c); else groundedBy.set(toKey, [c])
      continue
    }
    link(fromKey, c, toKey)
    link(toKey, c, fromKey)
  }

  const steps: PlanStep[] = []
  const placed = new Set<string>()
  const queue: string[] = []
  const enqueue = (k: string) => { if (!queue.includes(k)) queue.push(k) }

  const frameOfBody = new Map<string, Frame & { known: boolean }>()
  const baseFrame = (end: PlanEnd): Frame & { known: boolean } => {
    if (end.kind === 'stock') return { ...WORLD, known: true }
    let f = frameOfBody.get(end.body)
    if (!f) {
      f = bodyFrame(paths.filter((p) => bodyKeyOf(p) === end.body))
      frameOfBody.set(end.body, f)
    }
    return f
  }

  const stepFor = (c: Constraint, movingBody: string): PlanStep | null => {
    const e = ends.get(c.id)
    if (!e) return null
    const reversed = refBodyKey(paths, c.to) !== movingBody
    const moving = reversed ? e.from : e.to
    const held = reversed ? e.to : e.from
    if (moving.kind !== 'body') return null
    const movingFrame = baseFrame(moving)
    const heldFrame = baseFrame(held)
    return {
      c, held, moving, reversed,
      heldBaseDeg: heldFrame.deg,
      movingBaseDeg: movingFrame.deg,
      heldFlip: heldFrame.flip,
      movingFlip: movingFrame.flip,
      movingAngleKnown: movingFrame.known,
    }
  }

  const walk = () => {
    while (queue.length > 0) {
      const at = queue.shift()!
      for (const { c, other } of adj.get(at) ?? []) {
        if (placed.has(other)) continue
        const step = stepFor(c, other)
        if (!step) continue
        steps.push(step)
        placed.add(other)
        enqueue(other)
      }
    }
  }

  // Tier 1 — the stock, walked to completion first. Ground wins over a drag.
  for (const [key, list] of groundedBy) {
    for (const c of list) {
      const step = stepFor(c, key)
      if (step) steps.push(step)
    }
    placed.add(key)
    enqueue(key)
  }
  walk()

  // Tier 2 — what this edit moved stays where the edit put it.
  const byId = new Map(paths.map((p) => [p.id, p]))
  const anchors: string[] = []
  for (const id of anchorIds) {
    const p = byId.get(id)
    if (!p) continue
    const key = bodyKeyOf(p)
    if (!adj.has(key)) continue
    // Recorded even when tier 1 has already placed it: a drag still moves it,
    // and its stock steps then correct that — which is what previews a part
    // sliding freely in Y while its X snaps back to the edge it is pinned to.
    if (!anchors.includes(key)) anchors.push(key)
    if (placed.has(key)) continue
    placed.add(key)
    enqueue(key)
    walk()
  }

  // Tier 3 — everything else. A body no constraint drives comes first, then by
  // key, so an unanchored solve never depends on the order the paths sit in.
  const rest = [...adj.keys()].sort((a, b) => {
    const da = driven.has(a) ? 1 : 0, db = driven.has(b) ? 1 : 0
    return da !== db ? da - db : a < b ? -1 : a > b ? 1 : 0
  })
  for (const key of rest) {
    if (placed.has(key)) continue
    placed.add(key)
    enqueue(key)
    walk()
  }

  const pathsByBody = new Map<string, string[]>()
  for (const p of paths) {
    const k = bodyKeyOf(p)
    if (!adj.has(k)) continue
    const list = pathsByBody.get(k)
    if (list) list.push(p.id); else pathsByBody.set(k, [p.id])
  }

  return { plan: { steps, anchors, pathsByBody, stock }, error: null, badIds: [] }
}

/**
 * Walk a plan, with the anchors displaced by `anchorOffset`.
 *
 * Pure arithmetic — no geometry is touched — so this is what a drag calls every
 * frame. `anchorOffset` is the drag so far, and is zero for the real solve,
 * where the anchors' own `d` has already been rewritten.
 */
export function runPlan(
  plan: ConstraintPlan,
  anchorOffset: { dx: number; dy: number } = { dx: 0, dy: 0 },
): ConstraintMove[] {
  // What each body has picked up so far: a turn about `pivot` (in base
  // coordinates) and then a translation. Never the other way round, so the pivot
  // stays a point of the un-moved geometry and both halves compose without
  // either having to know about the other.
  interface BodyMove { dx: number; dy: number; rot: number; pivot: { x: number; y: number } }
  const ZERO: BodyMove = { dx: 0, dy: 0, rot: 0, pivot: ORIGIN }
  const offsets = new Map<string, BodyMove>()
  for (const b of plan.anchors) offsets.set(b, { ...ZERO, dx: anchorOffset.dx, dy: anchorOffset.dy })

  const at = (e: PlanEnd, other: { x: number; y: number } | null) => {
    if (e.kind === 'stock') return stockPoint(e.edge, plan.stock, other)
    const o = offsets.get(e.body) ?? ZERO
    // A turned body carries ALL of its points round, this end's among them —
    // the oriented box of a body turned by δ is its own box turned by δ, so the
    // corner a later step measures from is the resolved corner, turned.
    const p = o.rot === 0 ? e.base : rotatePointAbout(e.base, o.pivot, o.rot)
    return { x: p.x + o.dx, y: p.y + o.dy }
  }
  /** Where a body's frame points NOW: how it was drawn, plus this solve's turn. */
  const angleNow = (body: string, baseDeg: number) => baseDeg + (offsets.get(body)?.rot ?? 0)

  for (const s of plan.steps) {
    // The non-stock end first, so a stock edge has something to take its free
    // coordinate from.
    let held: { x: number; y: number }
    let moving: { x: number; y: number }
    if (s.held.kind === 'stock') {
      moving = at(s.moving, null)
      held = at(s.held, moving)
    } else {
      held = at(s.held, null)
      moving = at(s.moving, held)
    }

    // THE FRAME IS THE `from` END'S BODY, whichever end the walk arrived from.
    // Placing `to` from `from`, that is the held body and it is already final.
    // Placing `from` from `to` — reversed — the frame belongs to the body about
    // to be placed, so it comes from the held (`to`) body's angle less the angle
    // held between them; with no angle held there is nothing to derive it from
    // and the moving body keeps the angle it already stands at.
    const align = s.held.kind === 'stock' || !s.movingAngleKnown ? undefined : s.c.alignDeg
    const heldAbs = s.held.kind === 'stock' ? 0 : angleNow(s.held.body, s.heldBaseDeg)
    const movingAbs = angleNow(s.moving.body, s.movingBaseDeg)
    // Mirrored, a frame measures its angles the other way round, so the `from`
    // body standing `align` short of `to` becomes standing `align` past it.
    const frame: Frame = s.reversed
      ? {
        deg: align === undefined ? movingAbs : s.movingFlip ? heldAbs + align : heldAbs - align,
        flip: s.movingFlip,
      }
      : { deg: heldAbs, flip: s.heldFlip }

    const t = targetOf(s.c, held, moving, s.reversed, s.held.kind === 'stock', frame)
    const cur = offsets.get(s.moving.body) ?? ZERO
    // The turn this step asks of the moving body: stand at the frame's angle
    // (reversed — it IS the `from` end) or at the frame plus what is held
    // between them. Pivoted on the point the constraint measures to, which the
    // translation is computed from, so the two are independent and the
    // arithmetic below needs no second pass.
    const rot = align === undefined
      ? cur.rot
      : cur.rot + norm180((s.reversed ? frame.deg : angleFromFrame(align, frame)) - movingAbs)
    // A slide the d-string grid cannot hold is no slide (see SETTLED_MM). Zeroed
    // HERE, per step, rather than filtered from the moves at the end: a body left
    // where it stands must be where the rest of the chain measures from, or the
    // parts downstream get placed off a position nothing actually moved to.
    let sx = t.x - moving.x, sy = t.y - moving.y
    if (Math.hypot(sx, sy) < SETTLED_MM) { sx = 0; sy = 0 }
    offsets.set(s.moving.body, {
      dx: cur.dx + sx,
      dy: cur.dy + sy,
      rot,
      pivot: cur.rot === 0 && rot !== 0 ? s.moving.base : cur.pivot,
    })
  }

  const moves: ConstraintMove[] = []
  for (const [bodyKey, off] of offsets) {
    const turns = Math.abs(off.rot) > ANGLE_EPS
    if (!turns && Math.abs(off.dx) < EPS && Math.abs(off.dy) < EPS) continue
    const pathIds = plan.pathsByBody.get(bodyKey)
    if (!pathIds || pathIds.length === 0) continue
    moves.push({
      bodyKey, pathIds, dx: off.dx, dy: off.dy,
      ...(turns ? { rotDeg: off.rot, pivot: off.pivot } : {}),
    })
  }
  return moves
}

/**
 * Where every constrained body has to move to, given what the user just touched.
 *
 * THERE IS NO ROOT. `anchorIds` are the paths the current edit moved, and the
 * walk starts from THEM — so dragging any part of a chain carries the rest along
 * and every part is equally draggable. It used to start from the body nothing
 * pointed at, which meant one privileged part could be dragged and every other
 * part followed the cursor and then snapped back the moment the mouse came up,
 * with nothing on screen having said which was which.
 *
 * Breadth-first over the UNDIRECTED graph, one edge per pair. Because a cycle is
 * refused up front, each body is reached exactly once and each constraint is
 * applied exactly once — there is no case where an edge has to fight over a body
 * that is already placed.
 *
 * Seeded in three tiers, which is the whole of the priority order:
 *  1. THE STOCK, ground, walked to completion FIRST — so a part pinned to an
 *     edge wins over a drag, and anything hanging off that part is placed from
 *     it rather than from the cursor.
 *  2. THE ANCHORS: whatever this edit moved stays where the edit put it.
 *  3. Everything else, from the body no constraint drives — so a solve with no
 *     anchors at all (a load, a bare re-solve) is deterministic and never
 *     depends on the order the paths happen to sit in.
 *
 * IDEMPOTENT BY CONSTRUCTION, which is the property everything else leans on: it
 * runs after every path edit, and a solve over already-satisfied constraints
 * emits no moves at all, so the geometry is byte-identical.
 */
export function solveConstraints(
  paths: ImportedPath[],
  constraints: Constraint[],
  stock: Stock,
  anchorIds: string[] = [],
): ConstraintSolution {
  const { plan, error, badIds } = planConstraints(paths, constraints, stock, anchorIds)
  if (!plan) return { moves: [], error, badIds }
  return { moves: runPlan(plan), error: null, badIds: [] }
}

/**
 * The constraints that live INSIDE one body, solved over the OBJECTS in it.
 *
 * A CONSTRAINT BEATS A GROUP. Group two constrained shapes and the group becomes
 * the body — so `planConstraints` drops the constraint, because a body is rigid
 * and there is no freedom left between its parts. That is right for the body
 * graph and wrong for the user: typing a new distance into a constraint did
 * nothing at all once its two parts happened to be grouped together, with the
 * dimension on canvas updating and the shape sitting still. Grouping is a way of
 * handling several shapes at once, not a declaration that they are welded.
 *
 * So a body's internal constraints get their own solve, over the shapes inside
 * it. The unit there is the OBJECT — `groupId ?? id`, the same unit `endsOf`
 * narrows its ends to, so what the dimension is drawn between is what moves.
 * A multi-part shape stays whole (a gear is its seven paths however it is
 * grouped); a user group inside the body does not, because that is the grouping
 * the constraint is being asked to beat.
 *
 * The mechanism is the ordinary solve, handed the body's own paths with their
 * user groups stripped — one implementation of the walk, the tiers and the
 * over-constrained check, so an inner constraint behaves exactly like an outer
 * one and cannot drift from it.
 *
 * RUN AS A SECOND PASS, over the paths the first one has already moved (see
 * `enforceConstraints`), NOT merged into its move list: a body move and a move
 * of one object inside it name overlapping paths, and two moves for one path
 * would have to be composed. Going through the geometry composes them exactly,
 * for the rotations too. Bodies are disjoint, so within this pass no path is
 * named twice.
 */
export function solveInnerConstraints(
  paths: ImportedPath[],
  constraints: Constraint[],
  stock: Stock,
  anchorIds: string[] = [],
): ConstraintSolution {
  const inner = new Map<string, Constraint[]>()
  for (const c of constraints) {
    const fromKey = refBodyKey(paths, c.from)
    if (!sameBody(fromKey, refBodyKey(paths, c.to))) continue
    const list = inner.get(fromKey!)
    if (list) list.push(c); else inner.set(fromKey!, [c])
  }
  if (inner.size === 0) return { moves: [], error: null, badIds: [] }

  const moves: ConstraintMove[] = []
  let error: string | null = null
  const badIds: string[] = []
  for (const [body, cs] of inner) {
    const sub = paths.filter((p) => bodyKeyOf(p) === body).map((p) => ({ ...p, userGroups: undefined }))
    const sol = solveConstraints(sub, cs, stock, anchorIds)
    if (sol.error) {
      error ??= sol.error
      badIds.push(...sol.badIds)
      continue
    }
    moves.push(...sol.moves)
  }
  return { moves, error, badIds }
}

/** What to call a body in an error message. */
function nameOfBody(paths: ImportedPath[], key: string): string {
  const members = paths.filter((p) => bodyKeyOf(p) === key)
  if (members.length === 0) return 'A part'
  return members[0].groupName ?? members[0].name
}


// ─── Reading the graph ────────────────────────────────────────────────────────

/**
 * The other bodies that move with this one when it is dragged.
 *
 * Everything reachable through the constraint graph, in either direction — the
 * graph is undirected as far as a drag is concerned (see solveConstraints), so
 * there is no root and every part of a chain carries the rest. Used only to tell
 * the user how much a drag is about to shift, which is the one thing a drawing
 * of parts with dimension lines between them cannot show.
 */
export function bodiesMovingWith(
  paths: ImportedPath[],
  constraints: Constraint[],
  bodyKey: string,
): Set<string> {
  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    const set = adj.get(a)
    if (set) set.add(b); else adj.set(a, new Set([b]))
  }
  for (const c of constraints) {
    const a = refBodyKey(paths, c.from)
    const b = refBodyKey(paths, c.to)
    if (!a || !b || a === b) continue
    link(a, b); link(b, a)
  }
  const seen = new Set<string>([bodyKey])
  const queue = [bodyKey]
  while (queue.length > 0) {
    for (const next of adj.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  seen.delete(bodyKey)
  return seen
}

/**
 * Whether the stock holds this body in one axis or both — the one case where a
 * drag really is refused, ground being ground.
 */
export function groundedAxes(
  paths: ImportedPath[],
  constraints: Constraint[],
  bodyKey: string,
): Set<'x' | 'y'> {
  const out = new Set<'x' | 'y'>()
  for (const c of constraints) {
    if (c.from.kind !== 'stock') continue
    if (refBodyKey(paths, c.to) !== bodyKey) continue
    for (const ax of axesOf(c)) out.add(ax)
  }
  return out
}

/**
 * The constraints to show for a selection, in the panel and on the canvas.
 *
 * TWO OR MORE PARTS SELECTED MEANS "THIS PAIR": only constraints with both ends
 * inside the selection. ONE PART SELECTED MEANS "WHAT IS HOLDING THIS": every
 * constraint with an end on it.
 *
 * The obvious rule — everything touching the selection — is what made a chain
 * unreadable. With A→B→C constrained and B and C picked, it listed the A→B
 * constraint too; edit the first row and A and B move while the parts actually
 * selected sit still. Worse, every constraint chip selects its own two ends, so
 * every chip in a chain then showed the same list and they all looked alike.
 * Both halves of the rule answer the question the selection is asking.
 */
export function constraintsForSelection(
  paths: ImportedPath[],
  constraints: Constraint[],
  selectedIds: string[],
): Constraint[] {
  if (selectedIds.length === 0) return []
  const byId = new Map(paths.map((p) => [p.id, p]))
  const bodies = new Set<string>()
  for (const id of selectedIds) {
    const p = byId.get(id)
    if (p) bodies.add(bodyKeyOf(p))
  }
  if (bodies.size === 0) return []
  const endIn = (r: GeomRef): boolean => {
    if (r.kind === 'stock') return false
    const p = byId.get(r.id)
    return !!p && bodies.has(bodyKeyOf(p))
  }
  // A stock end is ground, so "both ends selected" only ever asks about the
  // part end — a part held off an edge belongs to that part alone.
  const bothIn = (c: Constraint) =>
    (c.from.kind === 'stock' || endIn(c.from)) && (c.to.kind === 'stock' || endIn(c.to))
  return bodies.size === 1
    ? constraints.filter((c) => endIn(c.from) || endIn(c.to))
    : constraints.filter(bothIn)
}

/**
 * THE ONE SET BOTH THE PANEL AND THE CANVAS DRAW, and the reason it is one
 * function.
 *
 * They answer the same question and must answer it the same way: a canvas
 * showing four dimensions under a panel listing one is not extra information, it
 * is a disagreement, and the user has no way to tell which of the two is lying.
 * The rule has three arms, in this order, because the selection can be empty for
 * two quite different reasons:
 *
 *  1. SOMETHING IS SELECTED — what that selection is asking about, per
 *     `constraintsForSelection`.
 *  2. THE TOOL HAS JUST MADE ONE (`focusConstraintId`) — the whole chain it
 *     belongs to, since the new constraint is only useful alongside whatever
 *     else is holding those parts. The Constrain tool leaves the selection empty
 *     on purpose (a selection puts resize handles back over the parts and blocks
 *     the next pick), so this is how the freshest thing is found at all.
 *  3. THE SUBJECT — what WAS selected when the tool was entered, which is the
 *     part the user is about to work on.
 *
 * Nothing at all otherwise: showing every constraint in the document because the
 * user happens to have nothing picked out is the clutter this rule exists to
 * keep off the drawing.
 */
export function constraintsInFocus(
  paths: ImportedPath[],
  constraints: Constraint[],
  view: { selectedIds: string[]; subjectIds?: string[]; focusConstraintId?: string | null },
): Constraint[] {
  if (view.selectedIds.length > 0) {
    return constraintsForSelection(paths, constraints, view.selectedIds)
  }
  if (view.focusConstraintId) {
    const chain = constraintChains(paths, constraints)
      .find((ch) => ch.constraints.some((c) => c.id === view.focusConstraintId))
    if (chain) return chain.constraints
  }
  const subject = view.subjectIds ?? []
  return subject.length > 0 ? constraintsForSelection(paths, constraints, subject) : []
}

/** Constraints on the selection that `constraintsForSelection` is not showing. */
export function constraintsHiddenBySelection(
  paths: ImportedPath[],
  constraints: Constraint[],
  selectedIds: string[],
): number {
  const byId = new Map(paths.map((p) => [p.id, p]))
  const bodies = new Set<string>()
  for (const id of selectedIds) {
    const p = byId.get(id)
    if (p) bodies.add(bodyKeyOf(p))
  }
  const endIn = (r: GeomRef) => {
    if (r.kind === 'stock') return false
    const p = byId.get(r.id)
    return !!p && bodies.has(bodyKeyOf(p))
  }
  const touching = constraints.filter((c) => endIn(c.from) || endIn(c.to)).length
  return touching - constraintsForSelection(paths, constraints, selectedIds).length
}


// ─── Picking one on canvas ────────────────────────────────────────────────────

/** A point a constraint can be attached to, and the ref that names it. */
export interface AnchorCandidate {
  ref: GeomRef
  x: number
  y: number
  kind: 'center' | 'edge' | 'corner' | 'circle'
  /** Which body it belongs to, so the tool can show one part's points at a time. */
  body: string
}

const BBOX_ANCHOR_KIND: Record<Anchor, 'center' | 'edge' | 'corner'> = {
  center: 'center',
  minX: 'edge', maxX: 'edge', minY: 'edge', maxY: 'edge',
  minXminY: 'corner', maxXminY: 'corner', minXmaxY: 'corner', maxXmaxY: 'corner',
}

/**
 * Every point of a part a constraint may be hung off, for the Constrain tool to
 * put markers on.
 *
 * THE SNAP POINTS ARE THE ANCHORS — that identity is the whole reason the tool
 * is cheap. Clicking a corner picks the part AND which point of it to measure
 * from, in one gesture, where the panel needed a selection and then a dropdown;
 * and because every candidate is already a `GeomRef`, nothing downstream — the
 * solve, the store, the file — learns a new concept.
 *
 * Measured off the BODY's bounding box, which is what the constraint will
 * measure too, so the marker sits exactly where the dimension will attach.
 * Circle centres come last so a bore's own centre wins the nearest-point search
 * against the bbox centre it usually coincides with.
 */
export function anchorCandidates(paths: ImportedPath[], pathId: string): AnchorCandidate[] {
  const self = paths.find((p) => p.id === pathId)
  if (!self) return []
  const bb = getMultiBBox(bodyPathsOf(paths, pathId).map((p) => p.d))
  if (!bb) return []
  const body = bodyKeyOf(self)
  const out: AnchorCandidate[] = []
  for (const a of Object.keys(BBOX_ANCHOR_KIND) as Anchor[]) {
    const pt = pointOf(paths, { kind: 'path', id: pathId, anchor: a }, { widthMM: 0, heightMM: 0 }, { dx: 0, dy: 0 }, null)
    if (pt) out.push({ ref: { kind: 'path', id: pathId, anchor: a }, x: pt.x, y: pt.y, kind: BBOX_ANCHOR_KIND[a], body })
  }
  addCircleOf(out, self, body)
  return out
}

/** Below this two candidates are the same point, and one marker is enough. */
const SAME_POINT_MM = 0.05

/**
 * Add a path's round-feature centre, unless some anchor already stands there.
 *
 * `extractCircles` judges roundness from the BOUNDING BOX aspect (that is all
 * the drill code ever needed), so it calls a SQUARE a circle — which put a
 * second marker exactly on top of a rectangle's centre ring, and the later one
 * won the nearest-point search. Where the two coincide they also resolve to the
 * same point, so dropping one costs nothing; where they do not — a gear's bore
 * against the bbox centre of a body that also contains its pinion — both are
 * real and both are kept.
 */
function addCircleOf(out: AnchorCandidate[], path: ImportedPath, body: string): void {
  const circles = extractCircles(path)
  if (circles.length === 0) return
  const c = circles.reduce((a, b) => (b.radiusMM > a.radiusMM ? b : a))
  if (out.some((o) => Math.hypot(o.x - c.cx, o.y - c.cy) < SAME_POINT_MM)) return
  out.push({ ref: { kind: 'circle', id: path.id }, x: c.cx, y: c.cy, kind: 'circle', body })
}

/**
 * Every pickable point in the drawing, built once per edit.
 *
 * THE TOOL SEARCHES POINTS, NOT PATHS. Finding the path under the cursor first
 * and then offering its anchors only works while the cursor is near an OUTLINE —
 * so the centre of a big circle, or the corner of a large rectangle, could not
 * be reached at all: they are nowhere near the geometry they belong to, and the
 * further you zoom in the worse it gets. Searching the points directly has no
 * such blind spot.
 *
 * The bounding-box anchors are per BODY (a gear is one thing to hold, and
 * flattening its bbox once per part would be seven times the work), while circle
 * centres are per PATH — a gear's bore is its own path, and its centre is
 * exactly the sort of point a constraint wants.
 */
export function allAnchorCandidates(paths: ImportedPath[]): AnchorCandidate[] {
  const out: AnchorCandidate[] = []
  const seenBody = new Set<string>()
  for (const p of paths) {
    const key = bodyKeyOf(p)
    if (!seenBody.has(key)) {
      seenBody.add(key)
      out.push(...anchorCandidates(paths, p.id).filter((c) => c.kind !== 'circle'))
    }
    addCircleOf(out, p, key)
  }
  return out
}

/** The candidate nearest `(x, y)`, within `tolMM`, or null. */
export function nearestCandidate(
  candidates: AnchorCandidate[],
  x: number,
  y: number,
  tolMM: number,
): AnchorCandidate | null {
  let best: AnchorCandidate | null = null
  let bestD2 = tolMM * tolMM
  for (const c of candidates) {
    const d2 = (c.x - x) ** 2 + (c.y - y) ** 2
    if (d2 <= bestD2) { bestD2 = d2; best = c }
  }
  return best
}

/**
 * The connected components of the constraint graph — one CHAIN each.
 *
 * The object strip draws ONE CHIP PER CHAIN rather than one per constraint: a
 * chain is what the user built in one go and what they reason about, and a row
 * of holes placed off a plate is one decision however many links it took.
 *
 * KEYED BY THE CHAIN'S OLDEST CONSTRAINT, which is the only thing about a chain
 * that does not move as it grows. Keying by its smallest body key looks stable
 * and is not: a chain that gains a part sorting before its current first is
 * renamed, and a chip whose key moves reads as a brand new object — the strip's
 * whole premise is that an edit CHANGES a chip rather than adding one. New
 * constraints append to the array, so the oldest stays oldest; and when two
 * chains are joined the merged one keeps the earlier of the two keys, so one
 * chip visibly absorbs the other instead of both vanishing.
 */
export function constraintChains(
  paths: ImportedPath[],
  constraints: Constraint[],
): { key: string; constraints: Constraint[]; bodies: string[] }[] {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let at = k
    while ((parent.get(at) ?? at) !== at) at = parent.get(at)!
    parent.set(k, at)
    return at
  }
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const bodyOf = (c: Constraint) => [c.from, c.to].flatMap((r) => {
    const k = refBodyKey(paths, r)
    return k ? [k] : []
  })
  for (const c of constraints) {
    const keys = bodyOf(c)
    if (keys.length === 0) continue
    // A stock-only end grounds the chain rather than joining it to every other
    // grounded one — the stock is not a part, and two parts held off the same
    // edge are not one chain.
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i])
    if (!parent.has(keys[0])) parent.set(keys[0], keys[0])
  }
  const byRoot = new Map<string, { constraints: Constraint[]; bodies: Set<string> }>()
  // `constraints` is in creation order, so the first one reaching a component is
  // that chain's oldest — which is what keys it.
  for (const c of constraints) {
    const keys = bodyOf(c)
    if (keys.length === 0) continue
    const root = find(keys[0])
    const g = byRoot.get(root) ?? { constraints: [], bodies: new Set<string>() }
    g.constraints.push(c)
    for (const k of keys) g.bodies.add(k)
    byRoot.set(root, g)
  }
  return [...byRoot.entries()].map(([, g]) => ({
    key: g.constraints[0].id,
    constraints: g.constraints,
    bodies: [...g.bodies],
  }))
}

// ─── Describing one ───────────────────────────────────────────────────────────

const STOCK_EDGE_NAMES: Record<'left' | 'right' | 'bottom' | 'top', string> = {
  left: 'Stock left', right: 'Stock right', bottom: 'Stock bottom', top: 'Stock top',
}

/** How a ref reads in the panel and on the chip. */
export function refLabel(paths: ImportedPath[], ref: GeomRef): string {
  if (ref.kind === 'stock') return STOCK_EDGE_NAMES[ref.edge]
  const self = paths.find((p) => p.id === ref.id)
  const name = self ? (self.groupName ?? self.name) : 'missing'
  if (ref.kind === 'circle') return `${name} circle`
  return ref.anchor === 'center' ? name : `${name} ${ANCHOR_NAMES[ref.anchor]}`
}
