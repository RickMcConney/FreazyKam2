import { generateTextD } from './textGenerator'
import { generateMazeD } from './mazeGenerator'
import { generateCuttingBoardD, type BoardShape, type BoardHandle } from './cuttingBoardGenerator'
import { generateGearD, generateGearParts, moduleForRadius, type ToothProfile } from './gearGenerator'
import { generateCamD, generateCamParts, baseDiaForRadius } from './camGenerator'
import {
  generateEscapementD, generateEscapementParts, wheelDiaForRadius, type EscapementType,
} from './escapementGenerator'
import { generatePendulumD, generatePendulumParts, lengthForHeight } from './pendulumGenerator'
import {
  generateTrackD, generateTrackParts, BRIO,
  type TrackKind, type TrackEnd, type TrackHand,
} from './trackGenerator'

export type ShapeType = 'rectangle' | 'roundrect' | 'inroundrect' | 'circle' | 'ellipse' | 'polygon' | 'star' | 'heart' | 'slot' | 'shield' | 'spirograph' | 'maze' | 'board' | 'gear' | 'cam' | 'escapement' | 'pendulum' | 'track' | 'text'

export type ShapeParams =
  | { type: 'rectangle'; x: number; y: number; w: number; h: number }
  | { type: 'roundrect'; x: number; y: number; w: number; h: number; r: number }
  | { type: 'inroundrect'; x: number; y: number; w: number; h: number; r: number }
  | { type: 'circle'; cx: number; cy: number; radius: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { type: 'polygon'; cx: number; cy: number; radius: number; sides: number }
  | { type: 'star'; cx: number; cy: number; outerRadius: number; innerRadius: number; points: number }
  | { type: 'heart'; cx: number; cy: number; curveRadius: number; angle: number }
  | { type: 'slot'; cx: number; cy: number; length: number; width: number }
  | { type: 'shield'; cx: number; cy: number; w: number; h: number }
  | { type: 'spirograph'; cx: number; cy: number; radius: number; ratio: number; p: number }
  | { type: 'maze'; x: number; y: number; w: number; h: number; spacing: number; corner: number; seed: number; loops: number }
  | {
      type: 'board'; x: number; y: number; w: number; h: number
      shape: BoardShape; corner: number
      handle: BoardHandle; handleW: number; handleL: number; handleInset: number
      hole: boolean; holeDia: number
      groove: boolean; grooveInset: number
    }
  // `arborPins`/`arborPinCircleDia`/`arborPinDia`: the lantern pinion this wheel
  // CARRIES on its own arbor — its pins go through the wheel's hub. Optional, and
  // absent on every gear drawn by hand; see GearSpec.
  | { type: 'gear'; cx: number; cy: number; module: number; teeth: number; toothProfile: ToothProfile; mateTeeth: number; pinDia: number; backRelief?: number; actingSense?: 1 | -1; drivenByPins?: boolean; emitPinion: boolean; pressureAngle: number; bore: number; hubDia: number; spokes: number; spokeWidth?: number; rimWidth?: number; backlash: number; toothLabel: boolean; pitchCircle: boolean; hubCircle?: boolean; arborPins?: number; arborPinCircleDia?: number; arborPinDia?: number }
  | { type: 'cam'; cx: number; cy: number; baseDia: number; riseMM: number; sweepDeg: number; boreDia: number; handleLength: number; handleWidth: number }
  | {
      type: 'escapement'; cx: number; cy: number
      escType: EscapementType; teeth: number; wheelDia: number
      toothDepth: number; drop: number; lift: number
      lock: number; draw: number; recoilArc: number
      armWidth: number
      bore: number; hubDia: number; spokes: number; anchorBore: number
      clockwise: boolean
      // The lantern pinion the escape wheel carries on its own arbor — the one
      // the third wheel drives. Stated in PIN CIRCLE rather than module, because
      // an escapement has none of its own: that circle belongs to the mesh with
      // the wheel before it. See spokedWheel's pinRing.
      arborPins?: number; arborPinCircleDia?: number; arborPinDia?: number
    }
  // cx,cy is the SUSPENSION POINT — see pendulumGenerator.ts.
  | { type: 'pendulum'; cx: number; cy: number; length: number; rodWidth: number; bobRx: number; bobRy: number; bore: number }
  // A fit against pieces somebody else made, so the socket is DERIVED from the
  // peg (see trackGenerator.ts) — `clearance` is the one slack, and socket Ø,
  // throat width and throat length are readouts.
  | {
      type: 'track'; cx: number; cy: number
      kind: TrackKind; length: number; radius: number; sweepDeg: number
      hand: TrackHand; crotch: number
      width: number; gauge: number
      endA: TrackEnd; endB: TrackEnd; endC: TrackEnd
      pegDia: number; neckW: number; neckL: number
      clearance: number
      treads: boolean; treadPitch: number
    }
  | { type: 'text'; x: number; y: number; text: string; fontSize: number; fontFamily: string }
export interface ShapeToolConfig {
  rectangle: { w: number; h: number }
  roundrect: { w: number; h: number; r: number }
  inroundrect: { w: number; h: number; r: number }
  circle: { radius: number }
  ellipse: { rx: number; ry: number }
  polygon: { radius: number; sides: number }
  star: { outerRadius: number; innerRadius: number; points: number }
  heart: { curveRadius: number; angle: number }
  slot: { length: number; width: number }
  shield: { w: number; h: number }
  spirograph: { radius: number; ratio: number; p: number }
  maze: { w: number; h: number; spacing: number; corner: number; seed: number; loops: number }
  board: {
    w: number; h: number; shape: BoardShape; corner: number
    handle: BoardHandle; handleW: number; handleL: number; handleInset: number
    hole: boolean; holeDia: number; groove: boolean; grooveInset: number
  }
  gear: { module: number; teeth: number; toothProfile: ToothProfile; mateTeeth: number; pinDia: number; backRelief: number; actingSense: 1 | -1; emitPinion: boolean; pressureAngle: number; bore: number; hubDia: number; spokes: number; spokeWidth?: number; rimWidth?: number; backlash: number; toothLabel: boolean; pitchCircle: boolean }
  cam: { baseDia: number; riseMM: number; sweepDeg: number; boreDia: number; handleLength: number; handleWidth: number }
  escapement: {
    escType: EscapementType; teeth: number; wheelDia: number
    toothDepth: number; drop: number; lift: number
    lock: number; draw: number; recoilArc: number
    armWidth: number
    bore: number; hubDia: number; spokes: number; anchorBore: number
    clockwise: boolean
  }
  pendulum: { length: number; rodWidth: number; bobRx: number; bobRy: number; bore: number }
  track: {
    kind: TrackKind; length: number; radius: number; sweepDeg: number
    hand: TrackHand; crotch: number
    width: number; gauge: number
    endA: TrackEnd; endB: TrackEnd; endC: TrackEnd
    pegDia: number; neckW: number; neckL: number
    clearance: number
    treads: boolean; treadPitch: number
  }
  text: { text: string; fontSize: number; fontFamily: string }
}

export const DEFAULT_SHAPE_CONFIG: ShapeToolConfig = {
  rectangle: { w: 50, h: 30 },
  roundrect: { w: 50, h: 30, r: 5 },
  inroundrect: { w: 50, h: 30, r: 8 },
  circle: { radius: 20 },
  ellipse: { rx: 25, ry: 15 },
  polygon: { radius: 20, sides: 6 },
  star: { outerRadius: 20, innerRadius: 8, points: 5 },
  heart: { curveRadius: 15, angle: 90 },
  slot: { length: 40, width: 15 },
  shield: { w: 40, h: 50 },
  spirograph: { radius: 25, ratio: 7, p: 6 },  // a 7-lobe rosette with the pen on the centre (p = loops−1)
  maze: { w: 150, h: 150, spacing: 12, corner: 4, seed: 1, loops: 0 },  // 12 mm pitch = 6 mm walls under a 6 mm ball
  board: {
    w: 350, h: 250, shape: 'rect', corner: 25,
    handle: 'paddle', handleW: 60, handleL: 110, handleInset: 22,
    hole: true, holeDia: 22, groove: true, grooveInset: 20,
  },
  // Module 4 because of the cutter, not the gear: the designed root fillet is
  // 0.38·m — the standard rack tip radius — and at m4 that is 1.52 mm against a
  // 1/8" end mill's 1.59 mm, so the bit cuts the root essentially as drawn. Below
  // m3 it cannot reach into the root at all and leaves a fillet twice the size.
  // hubDia follows: bore + 4·m is the least hub the axle wants, so 8 + 16 = 24.
  // Cycloidal defaults are a clock train, not machinery: 8 pins is a common wooden-
  // clock lantern pinion, and a 5 mm pin (1.25·m here) is a dowel that fits the
  // 6.3 mm tooth space with room to pass. `backRelief` is full, since a clock
  // wheel turns one way and its back flank does nothing but crowd the pin.
  // Inert until the profile is switched.
  gear: {
    module: 4, teeth: 24, toothProfile: 'involute', mateTeeth: 8, pinDia: 5, backRelief: 1, actingSense: -1, emitPinion: false,
    pressureAngle: 20, bore: 8, hubDia: 24, spokes: 5, backlash: 0.3, toothLabel: true, pitchCircle: false,
  },
  // A workbench cam clamp: Ø40 base with 12 mm of rise gives a 5.5° pressure angle
  // at the base circle — well inside what wood-on-wood friction holds — and a 100 mm
  // lever on a Ø32 crest is a lever rather than a lump.
  cam: { baseDia: 40, riseMM: 12, sweepDeg: 360, boreDia: 8, handleLength: 100, handleWidth: 18 },
  // A 30-tooth Graham deadbeat on a Ø100 wheel: the standard seconds-pendulum
  // escape wheel. 2° of drop out of the 6° beat leaves 4° of impulse at the
  // wheel for 3° of lift at the anchor. The span the pallets stand at is derived
  // from the tooth count rather than set here — see `escapementSpan`. Lock 2 is
  // what seats the full 1 mm landing (`LANDING_DEPTH`) on this wheel with the run
  // margin still above it; 1.5 landed the tooth on 0.81.
  escapement: {
    escType: 'deadbeat', teeth: 30, wheelDia: 100,
    toothDepth: 6, drop: 2, lift: 3, lock: 2, draw: 2, recoilArc: 1.5,
    armWidth: 8, bore: 6, hubDia: 20, spokes: 5, anchorBore: 6,
    clockwise: false,
  },
  // THE seconds pendulum — 993.6 mm beats exactly one second, which is the
  // length every clock book quotes and the one a 30-tooth escape wheel is sized
  // around. The panel shows the beat, so any other length explains itself.
  // The bob's MAJOR AXIS LIES ACROSS the rod — a pendulum bob is a lens seen
  // edge-on, so it is wider than it is tall. Both radii stay editable; this is
  // only which way round the default lies.
  pendulum: { length: 993.62, rodWidth: 12, bobRx: 60, bobRy: 45, bore: 5 },
  // Real BRIO, straight out of the published dimensions: the A-track medium
  // straight, male one end and female the other, which is the piece a set has
  // most of. `clearance` is the one slack in the joint: at 2 it puts a Ø15.5
  // socket and a 10 mm throat round the Ø11.5 peg on its 6 mm neck.
  track: {
    kind: 'straight', length: 144, radius: BRIO.radius, sweepDeg: BRIO.sweepDeg,
    hand: 'left', crotch: BRIO.crotch,
    width: BRIO.width, gauge: BRIO.gauge,
    endA: 'female', endB: 'male', endC: 'male',
    pegDia: BRIO.pegDia, neckW: BRIO.neckW, neckL: BRIO.neckL,
    clearance: BRIO.clearance,
    // Decoration, and the only thing on a track that is: marked by default
    // because an unmarked piece reads as a plank, off in one click when it is
    // one.
    treads: true, treadPitch: BRIO.treadPitch,
  },
  text: { text: 'Hello', fontSize: 10, fontFamily: 'Roboto' },
}

function f(n: number): string { return String(+n.toFixed(4)) }

// ─── Spirograph (hypotrochoid) ────────────────────────────────────────────────
//
// A wheel of radius r rolls inside a ring of radius R with the pen held at
// fraction p of the way out to the wheel's rim:
//
//   x(θ) = (R−r)·cos θ + p·r·cos(((R−r)/r)·θ)
//   y(θ) = (R−r)·sin θ − p·r·sin(((R−r)/r)·θ)
//
// p is NOT capped at 1 — the pen may sit on an arm out past the rim. A real
// spirograph's holes are drilled inside the wheel, and that cap is exactly what
// keeps the pattern out at the rim: the curve's inner radius is (R−r) − p·r, so
// with p ≤ 1 it can only reach the middle when R ≤ 2r. Every ratio above 2 —
// which is where the interesting rosettes are — would leave a hole. The pen
// crosses the centre at p = ratio−1 (`spirographCentrePen`) and loops through it
// beyond that.
//
// R and r are NOT the stored parameters, because they are not independent to
// the eye: the pen never reaches the ring, so the drawn curve's outer radius is
// R − r(1−p) and growing the wheel shrinks the shape while R sits still. What
// the user picks instead is `radius` — the outer radius of the curve as drawn,
// i.e. the size it occupies on the stock — and `ratio` = R/r, the gear ratio
// that selects the pattern. R and r are derived from those, so size and pattern
// move independently and canvas scaling only touches `radius`.
//
// **THE RATIO IS A WHOLE NUMBER, AND IT IS THE LOOP COUNT.** θ closes the curve
// after r/gcd(R,r) turns, so a fractional ratio in lowest terms num/den takes
// `den` turns to close — a 40/13 draws thirteen laps of the ring, interleaving
// thirteen sets of lobes, and the number the user typed says nothing about what
// comes out. An integer N closes in ONE turn with exactly N lobes, so the
// control means what it shows: `ratio` IS the loop count. That also removes the
// point budget's whole problem — one turn instead of up to sixty — and with it
// the continued-fraction rationalizer that used to derive the turn count.
//
// Emitted as a polyline — there is no closed form in arcs/béziers, and the CAM
// pipeline flattens everything to polylines anyway.

const SPIRO_MIN_RATIO = 2       // r = R/2 is the smallest wheel that draws lobes
const SPIRO_MAX_RATIO = 360
// Max chord deviation, mm. Matched to `flattenPath`'s own default tolerance:
// every consumer downstream — CAM, bbox, the canvas — re-flattens at 0.1 mm, so
// a polyline emitted finer than that is points nothing will ever look at.
const SPIRO_TOL = 0.1
const SPIRO_MIN_PER_LOOP = 12   // steps per lobe, so a tiny lobe still reads as one
const SPIRO_MAX_POINTS = 4000   // hard ceiling, only reached by an extreme loop count

// The one place the whole-number rule lives, so no caller can disagree about
// what a stored ratio means. Old projects carry fractional ratios (the default
// was 40/13) and are rounded here rather than migrated — `d` is stored, so an
// untouched path keeps its curve and only a re-edit re-cuts it.
export function spirographLoops(ratio: number): number {
  const n = Math.round(ratio)
  return Math.max(SPIRO_MIN_RATIO, Math.min(SPIRO_MAX_RATIO, Number.isFinite(n) ? n : SPIRO_MIN_RATIO))
}

export const SPIRO_RATIO_RANGE = { min: SPIRO_MIN_RATIO, max: SPIRO_MAX_RATIO }

// Ring and wheel radii behind a given drawn size — shown in the panel so the
// numbers a physical spirograph set is labelled with are still visible.
export function spirographRadii(radius: number, ratio: number, p: number): { R: number; r: number } {
  const k = 1 / spirographLoops(ratio)   // r/R
  // outer radius = (R−r) + p·r = R(1 − k(1−p)), solved for R. The bracket stays
  // positive for every p ≥ 0, so an arm past the rim is well defined.
  const R = Math.max(0.1, radius) / (1 - k * (1 - Math.max(0, p)))
  return { R, r: k * R }
}

// The pen offset at which the curve passes exactly through the centre: the
// inner radius (R−r) − p·r hits zero at p = (R−r)/r = ratio−1. Ratio-dependent,
// so the panel shows it rather than making the user hunt for it.
export function spirographCentrePen(ratio: number): number {
  return spirographLoops(ratio) - 1
}

function spirographD(cx: number, cy: number, radius: number, ratio: number, p0: number): string {
  const p = Math.max(0, p0)
  const loops = spirographLoops(ratio)
  const { R, r } = spirographRadii(radius, ratio, p)
  const A = R - r         // the wheel's centre orbits at this radius
  const B = p * r         // pen offset from the wheel's centre
  const freq = A / r      // wiggles per turn — i.e. loops − 1
  const thetaMax = 2 * Math.PI   // an integer ratio closes in exactly one turn

  const px = (t: number) => cx + A * Math.cos(t) + B * Math.cos(freq * t)
  const py = (t: number) => cy + A * Math.sin(t) - B * Math.sin(freq * t)
  // |d²P/dθ²|. A chord spanning Δt bulges from the curve by |P''|·Δt²/8, so
  // solving that for SPIRO_TOL sizes each step by the curvature under it —
  // fine through a cusp, coarse along a near-straight run. The old sampler
  // stepped by SPEED instead, holding the CHORD LENGTH constant, which spends
  // exactly as many points on a lazy outer sweep as on a tight cusp and had no
  // tolerance in it at all: the budget was the tolerance, so it always emitted
  // its full 6000 points however simple the curve.
  const accel = (t: number) => Math.hypot(
    -A * Math.cos(t) - B * freq * freq * Math.cos(freq * t),
    -A * Math.sin(t) + B * freq * freq * Math.sin(freq * t)
  )

  const maxStep = (2 * Math.PI) / Math.max(1, loops * SPIRO_MIN_PER_LOOP)
  const minStep = thetaMax / SPIRO_MAX_POINTS

  const pts: string[] = []
  for (let t = 0; t < thetaMax; ) {
    pts.push(`${pts.length === 0 ? 'M' : 'L'}${f(px(t))},${f(py(t))}`)
    // maxStep first, then minStep — so the point ceiling is the LAST word and an
    // extreme loop count gives up steps-per-lobe rather than the budget.
    const step = Math.sqrt((8 * SPIRO_TOL) / Math.max(accel(t), 1e-9))
    t += Math.max(Math.min(step, maxStep), minStep)
  }
  return pts.join(' ') + ' Z'
}

// All paths in CNC Y-up space. Arc sweep=0 matches what svgImporter produces after Y-flip.
export function generateShapeD(p: ShapeParams): string {
  switch (p.type) {
    case 'rectangle': {
      const { x, y, w, h } = p
      return `M${f(x)},${f(y)} L${f(x+w)},${f(y)} L${f(x+w)},${f(y+h)} L${f(x)},${f(y+h)} Z`
    }
    case 'roundrect': {
      const { x, y, w, h } = p
      const r = Math.min(Math.abs(p.r), Math.abs(w) / 2, Math.abs(h) / 2)
      if (r < 0.001) return `M${f(x)},${f(y)} L${f(x+w)},${f(y)} L${f(x+w)},${f(y+h)} L${f(x)},${f(y+h)} Z`
      // sweep=1 because the path traces CCW in CNC Y-up — corners need CW arcs to bulge outward
      return [
        `M${f(x+r)},${f(y)}`,
        `L${f(x+w-r)},${f(y)}`,
        `A${f(r)},${f(r)},0,0,1,${f(x+w)},${f(y+r)}`,
        `L${f(x+w)},${f(y+h-r)}`,
        `A${f(r)},${f(r)},0,0,1,${f(x+w-r)},${f(y+h)}`,
        `L${f(x+r)},${f(y+h)}`,
        `A${f(r)},${f(r)},0,0,1,${f(x)},${f(y+h-r)}`,
        `L${f(x)},${f(y+r)}`,
        `A${f(r)},${f(r)},0,0,1,${f(x+r)},${f(y)} Z`,
      ].join(' ')
    }
    case 'inroundrect': {
      const { x, y, w, h } = p
      const r = Math.min(Math.abs(p.r), Math.abs(w) / 2, Math.abs(h) / 2)
      if (r < 0.001) return `M${f(x)},${f(y)} L${f(x+w)},${f(y)} L${f(x+w)},${f(y+h)} L${f(x)},${f(y+h)} Z`
      // sweep=0: arcs curve inward toward each corner (concave corners)
      return [
        `M${f(x+r)},${f(y)}`,
        `L${f(x+w-r)},${f(y)}`,
        `A${f(r)},${f(r)},0,0,0,${f(x+w)},${f(y+r)}`,
        `L${f(x+w)},${f(y+h-r)}`,
        `A${f(r)},${f(r)},0,0,0,${f(x+w-r)},${f(y+h)}`,
        `L${f(x+r)},${f(y+h)}`,
        `A${f(r)},${f(r)},0,0,0,${f(x)},${f(y+h-r)}`,
        `L${f(x)},${f(y+r)}`,
        `A${f(r)},${f(r)},0,0,0,${f(x+r)},${f(y)} Z`,
      ].join(' ')
    }
    case 'circle': {
      const { cx, cy, radius: r } = p
      return `M${f(cx-r)},${f(cy)} A${f(r)},${f(r)},0,0,0,${f(cx+r)},${f(cy)} A${f(r)},${f(r)},0,0,0,${f(cx-r)},${f(cy)} Z`
    }
    case 'ellipse': {
      const { cx, cy, rx, ry } = p
      return `M${f(cx-rx)},${f(cy)} A${f(rx)},${f(ry)},0,0,0,${f(cx+rx)},${f(cy)} A${f(rx)},${f(ry)},0,0,0,${f(cx-rx)},${f(cy)} Z`
    }
    case 'polygon': {
      const { cx, cy, radius, sides } = p
      const pts: string[] = []
      for (let i = 0; i < sides; i++) {
        const angle = (i / sides) * 2 * Math.PI - Math.PI / 2
        pts.push(`${i === 0 ? 'M' : 'L'}${f(cx + radius * Math.cos(angle))},${f(cy + radius * Math.sin(angle))}`)
      }
      return pts.join(' ') + ' Z'
    }
    case 'star': {
      const { cx, cy, outerRadius, innerRadius, points } = p
      const pts: string[] = []
      for (let i = 0; i < points * 2; i++) {
        const angle = (i / (points * 2)) * 2 * Math.PI - Math.PI / 2
        const r = i % 2 === 0 ? outerRadius : innerRadius
        pts.push(`${i === 0 ? 'M' : 'L'}${f(cx + r * Math.cos(angle))},${f(cy + r * Math.sin(angle))}`)
      }
      return pts.join(' ') + ' Z'
    }
    case 'heart': {
      // Based on MakerJS Heart(r, a2): a = a2/2, lobe centers at (±r·cosA, oy),
      // lobes arc upward (high CNC Y → top of screen via scaleY=-1), tip points down.
      // Each 180° lobe arc is split into two 90° CW arcs (sweep=0) to avoid SVG ambiguity.
      const { cx, cy, curveRadius: r, angle: a2 } = p
      const a = (Math.max(1, Math.min(179, a2)) / 2) * (Math.PI / 180)
      const ca = Math.cos(a), sa = Math.sin(a)
      // Bounding box height = 2r/ca − r·sa + r; center oy places bbox centre at cy
      const oy = cy + (2 * r / ca - r * sa - r) / 2
      // Key Y values in CNC space (high Y → top of screen)
      const vNotchY = oy + r * sa              // V-notch cleft at top of heart
      const junctY  = oy - r * sa             // where lobe arc meets straight side
      const tipY    = oy - 2 * r / ca + r * sa // pointed tip at bottom
      const arcMidY = oy + r * ca             // mid-arc point (top of each lobe circle)
      // Key X offsets from cx
      const junctX  = 2 * r * ca
      const arcMidX = r * (ca + sa)
      return [
        `M${f(cx)},${f(vNotchY)}`,
        // Right lobe: two 90° CW arcs sweeping up and over, sweep=0 large-arc=0
        `A${f(r)},${f(r)},0,0,0,${f(cx + arcMidX)},${f(arcMidY)}`,
        `A${f(r)},${f(r)},0,0,0,${f(cx + junctX)},${f(junctY)}`,
        // Straight lines meeting at tip
        `L${f(cx)},${f(tipY)}`,
        `L${f(cx - junctX)},${f(junctY)}`,
        // Left lobe: two 90° CW arcs, sweep=0
        `A${f(r)},${f(r)},0,0,0,${f(cx - arcMidX)},${f(arcMidY)}`,
        `A${f(r)},${f(r)},0,0,0,${f(cx)},${f(vNotchY)}`,
        'Z',
      ].join(' ')
    }
    case 'slot': {
      const { cx, cy, length, width } = p
      const r = width / 2
      const hl = Math.max(0, (length - width) / 2)
      if (hl < 0.001) {
        // Degenerate to a circle when length ≤ width
        return `M${f(cx - r)},${f(cy)} A${f(r)},${f(r)},0,0,0,${f(cx + r)},${f(cy)} A${f(r)},${f(r)},0,0,0,${f(cx - r)},${f(cy)} Z`
      }
      return [
        `M${f(cx - hl)},${f(cy - r)}`,
        `A${f(r)},${f(r)},0,1,0,${f(cx - hl)},${f(cy + r)}`,
        `L${f(cx + hl)},${f(cy + r)}`,
        `A${f(r)},${f(r)},0,1,0,${f(cx + hl)},${f(cy - r)}`,
        'Z',
      ].join(' ')
    }
    case 'shield': {
      const { cx, cy, w, h } = p
      // Lucide Shield icon (24×24): content spans x=[4..20] (16 wide), y=[2.28..21.95] (19.67 tall).
      // Center of content: SVG (12, 12.115) → CNC (cx, cy). Y is flipped.
      const sx = w / 16, sy = h / 19.67
      const X  = (x: number) => cx + (x - 12) * sx
      const Y  = (y: number) => cy - (y - 12.115) * sy
      const RX = (r: number) => r * sx
      const RY = (r: number) => r * sy
      // All SVG arcs use sweep=1; after Y-flip that becomes sweep=0 in CNC Y-up.
      return [
        `M${f(X(20))},${f(Y(13))}`,
        `C${f(X(20))},${f(Y(18))} ${f(X(16.5))},${f(Y(20.5))} ${f(X(12.34))},${f(Y(21.95))}`,
        `A${f(RX(1))},${f(RY(1))},0,0,0,${f(X(11.67))},${f(Y(21.94))}`,
        `C${f(X(7.5))},${f(Y(20.5))} ${f(X(4))},${f(Y(18))} ${f(X(4))},${f(Y(13))}`,
        `L${f(X(4))},${f(Y(6))}`,
        `A${f(RX(1))},${f(RY(1))},0,0,0,${f(X(5))},${f(Y(5))}`,
        `C${f(X(7))},${f(Y(5))} ${f(X(9.5))},${f(Y(3.8))} ${f(X(11.24))},${f(Y(2.28))}`,
        `A${f(RX(1.17))},${f(RY(1.17))},0,0,0,${f(X(12.76))},${f(Y(2.28))}`,
        `C${f(X(14.51))},${f(Y(3.81))} ${f(X(17))},${f(Y(5))} ${f(X(19))},${f(Y(5))}`,
        `A${f(RX(1))},${f(RY(1))},0,0,0,${f(X(20))},${f(Y(6))}`,
        'Z',
      ].join(' ')
    }
    case 'spirograph': return spirographD(p.cx, p.cy, p.radius, p.ratio, p.p)
    case 'maze': return generateMazeD(p)
    case 'board': return generateCuttingBoardD(p)
    case 'gear': return generateGearD(p)
    case 'cam': return generateCamD(p)
    case 'escapement': return generateEscapementD(p)
    case 'pendulum': return generatePendulumD(p)
    case 'track': return generateTrackD(p)
    case 'text': return generateTextD(p)
  }
}

/**
 * A shape that is really several paths, because its pieces want different
 * operations. Null for every ordinary shape — one shape, one path.
 *
 * A gear is the case: its teeth are profiled OUTSIDE and its bore and spokes
 * INSIDE, and one compound path cannot say that (a profile reads a compound path
 * as a single region and follows the outer boundary only). Handing over one path
 * means the bore and spokes go uncut, and splitting it afterwards to reach them
 * drops the profile already set up on the teeth.
 *
 * Every part carries the SAME `shapeParams`, plus its own `part` key, so the set
 * stays editable as one shape — see `updateShapeParams`, which regenerates the
 * whole group and adds or removes parts as they appear and vanish.
 */
export interface ShapePart {
  part: string
  /** Suffix for the path name — "Gear Teeth". */
  label: string
  d: string
}

const CAM_PART_LABELS: Record<string, string> = { cam: 'Outline', bore: 'Bore' }

// The outline is profiled and the grooves are not — a groove is a 3 mm deep
// slot cut with a different tool, which is the gear's argument for parts.
// ...and the treads are a third: a V bit a millimetre down, which is neither of
// the other two operations either.
const TRACK_PART_LABELS: Record<string, string> = { body: 'Outline', groove: 'Grooves', tread: 'Treads' }

const PENDULUM_PART_LABELS: Record<string, string> = { rod: 'Rod', bore: 'Suspension Hole', bob: 'Bob' }

const ESCAPEMENT_PART_LABELS: Record<string, string> = {
  wheel: 'Escape Wheel', spokes: 'Spokes', bore: 'Bore',
  anchor: 'Pallets', anchorbore: 'Pallet Arbor', ref: 'Reference Circles',
}

const GEAR_PART_LABELS: Record<string, string> = {
  teeth: 'Teeth', spokes: 'Spokes', bore: 'Bore', label: 'Marking', pitch: 'Pitch Circle',
  pinion: 'Pinion Cheek', pinholes: 'Pin Holes', pinionbore: 'Pinion Bore',
  pinionpitch: 'Pinion Pitch Circle', pinionlabel: 'Pinion Marking',
}

// ─── The parts that are annotation, and the switch that draws each ───────────
//
// A MARKING OR A REFERENCE CIRCLE IS THE ONE KIND OF PART THAT IS NOT CUT. Both
// already get a path of their own expressly so they can be deleted without
// touching anything that will be machined — and deleting one is a DECISION, so
// the switch that draws it goes off with it (`applyPathEdit`) and a rebuild is
// not entitled to bring it back (`carryAnnotationSwitches`, which is how Update
// clock keeps a wheel the user has unmarked unmarked).
//
// Only switches that change NOTHING ELSE about the shape belong here: deleting
// one regenerates nothing, so a switch that moved or resized another part would
// leave the drawing disagreeing with its own parameters.
export const ANNOTATION_SWITCH: Partial<Record<ShapeType, Record<string, Record<string, unknown>>>> = {
  // One `toothLabel` draws the wheel's number AND its pinion's, and one
  // `pitchCircle` draws both pitch circles — so deleting either half takes the
  // other with it, which is what "off" has to mean for a switch covering two
  // parts.
  gear: {
    label: { toothLabel: false },
    pinionlabel: { toothLabel: false },
    pitch: { pitchCircle: false },
    pinionpitch: { pitchCircle: false },
  },
}

/** The annotation switches of `from`, written onto `to` — for a rebuild that
 *  derives its parameters afresh and would otherwise hand back an annotation
 *  the user has thrown away. Same shape type only; anything else is `to`. */
export function carryAnnotationSwitches(from: ShapeParams | undefined, to: ShapeParams): ShapeParams {
  if (!from || from.type !== to.type) return to
  const switches = ANNOTATION_SWITCH[to.type]
  if (!switches) return to
  const carried: Record<string, unknown> = {}
  for (const patch of Object.values(switches)) {
    for (const field of Object.keys(patch)) {
      if (field in from) carried[field] = (from as unknown as Record<string, unknown>)[field]
    }
  }
  return { ...to, ...carried } as ShapeParams
}

export function generateShapeParts(p: ShapeParams): ShapePart[] | null {
  if (p.type === 'gear') {
    return generateGearParts(p).map((g) => ({
      part: g.key,
      label: GEAR_PART_LABELS[g.key] ?? g.key,
      d: g.d,
    }))
  }
  if (p.type === 'escapement') {
    return generateEscapementParts(p).map((g) => ({
      part: g.key,
      label: ESCAPEMENT_PART_LABELS[g.key] ?? g.key,
      d: g.d,
    }))
  }
  if (p.type === 'cam') {
    return generateCamParts(p).map((g) => ({
      part: g.key,
      label: CAM_PART_LABELS[g.key] ?? g.key,
      d: g.d,
    }))
  }
  if (p.type === 'pendulum') {
    return generatePendulumParts(p).map((g) => ({
      part: g.key,
      label: PENDULUM_PART_LABELS[g.key] ?? g.key,
      d: g.d,
    }))
  }
  if (p.type === 'track') {
    return generateTrackParts(p).map((g) => ({
      part: g.key,
      label: TRACK_PART_LABELS[g.key] ?? g.key,
      d: g.d,
    }))
  }
  return null
}

// Shapes a drag-scale must not touch. Each is a MECHANISM whose parameters are
// standards or rates, cut to match a part made separately from the same
// numbers, so a scale changes the mechanism while looking like a resize:
//   gear       module is a cutter standard, and the pinion drawn beside it was
//              cut for THIS module — m4 dragged to m4.37 meshes with nothing.
//   escapement the anchor's faces are loci of THIS wheel's teeth.
//   pendulum   `length` IS the rate; dragging it bigger silently retimes the
//              clock, which is the one thing a drawing cannot show.
//   track      every number in it is a fit against pieces made by somebody
//              else — scaled, it is a good drawing of something that connects
//              to nothing.
// Everything else scales: a cam has no mate and stays a valid spiral, and
// dragging a board or a maze to fit the stock is the natural gesture.
// The canvas suppresses the resize handles for these (their size is set by
// their own parameters), so nothing has to refuse a gesture mid-drag.
export const SCALE_LOCKED_SHAPES: ReadonlySet<ShapeType> = new Set<ShapeType>(['gear', 'escapement', 'pendulum', 'track'])

export function isScaleLocked(params: ShapeParams | undefined | null): boolean {
  return !!params && SCALE_LOCKED_SHAPES.has(params.type)
}

export function shapeDisplayName(type: ShapeType): string {
  switch (type) {
    case 'rectangle': return 'Rectangle'
    case 'roundrect': return 'Rounded Rect'
    case 'inroundrect': return 'Sign'
    case 'circle': return 'Circle'
    case 'ellipse': return 'Ellipse'
    case 'polygon': return 'Polygon'
    case 'star': return 'Star'
    case 'heart': return 'Heart'
    case 'slot': return 'Slot'
    case 'shield': return 'Shield'
    case 'spirograph': return 'Spirograph'
    case 'maze': return 'Maze'
    case 'board': return 'Cutting Board'
    case 'gear': return 'Gear'
    case 'cam': return 'Cam'
    case 'escapement': return 'Escapement'
    case 'pendulum': return 'Pendulum'
    case 'track': return 'Train Track'
    case 'text': return 'Text'
  }
}

// Build ShapeParams from a canvas drag box
/**
 * `fromCenter`: the drag's ORIGIN is the shape's centre and the cursor gives its
 * half-extent, instead of the two points being opposite corners of its box.
 * Dragging repeatedly from one point then leaves concentric shapes, which
 * corner-to-corner cannot do at all — you would have to work out each corner.
 *
 * It is done by reflecting the origin through the cursor rather than by casing
 * every shape: with `start' = 2·start − end`, the existing arithmetic below
 * yields centre = start and width = 2·|end − start|, which IS the centred box.
 * So every shape follows, including ones added later, and nothing in the switch
 * has to know the mode exists.
 */
export function shapeParamsFromDrag(
  type: ShapeType,
  origin: { x: number; y: number },
  end: { x: number; y: number },
  config: ShapeToolConfig,
  fromCenter = false,
): ShapeParams {
  // Reflecting the origin makes the drag box the CENTRED one. Nothing is recorded
  // here — the preference lives on the PATH (ImportedPath.fromCenter), because it
  // has to outlive the params: a rotate or a mirror drops shapeParams entirely.
  return dragParams(type, fromCenter ? { x: 2 * origin.x - end.x, y: 2 * origin.y - end.y } : origin, end, config)
}

function dragParams(
  type: ShapeType,
  start: { x: number; y: number },
  end: { x: number; y: number },
  config: ShapeToolConfig,
): ShapeParams {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const w = Math.max(Math.abs(end.x - start.x), 0.1)
  const h = Math.max(Math.abs(end.y - start.y), 0.1)
  const cx = (start.x + end.x) / 2
  const cy = (start.y + end.y) / 2
  const radius = Math.min(w, h) / 2

  switch (type) {
    case 'rectangle': return { type, x, y, w, h }
    case 'roundrect': {
      const maxR = Math.min(w, h) / 2
      return { type, x, y, w, h, r: Math.min(config.roundrect.r, maxR) }
    }
    case 'inroundrect': {
      const maxR = Math.min(w, h) / 2
      return { type, x, y, w, h, r: Math.min(config.inroundrect.r, maxR) }
    }
    case 'circle': return { type: 'circle', cx, cy, radius }
    case 'ellipse': return { type: 'ellipse', cx, cy, rx: w / 2, ry: h / 2 }
    case 'polygon': return { type: 'polygon', cx, cy, radius, sides: config.polygon.sides }
    case 'star': {
      const ratio = config.star.innerRadius / Math.max(config.star.outerRadius, 0.001)
      return { type: 'star', cx, cy, outerRadius: radius, innerRadius: radius * ratio, points: config.star.points }
    }
    case 'heart': {
      const { angle } = config.heart
      const a = (Math.max(1, Math.min(179, angle)) / 2) * (Math.PI / 180)
      const ca = Math.cos(a), sa = Math.sin(a)
      const r_from_W = w / (2 * (1 + ca))
      const r_from_H = h / (2 / ca - sa + 1)
      const r = Math.max(0.5, Math.min(r_from_W, r_from_H))
      return { type: 'heart', cx, cy, curveRadius: r, angle }
    }
    case 'slot': {
      const clampedWidth = Math.min(h, w)
      return { type: 'slot', cx, cy, length: w, width: clampedWidth }
    }
    case 'shield': return { type: 'shield', cx, cy, w, h }
    case 'spirograph':
      // `radius` IS the drawn outer radius, so the drag box fits exactly;
      // ratio and pen position (the pattern) come from the panel untouched.
      return { type: 'spirograph', cx, cy, radius, ratio: config.spirograph.ratio, p: config.spirograph.p }
    case 'maze':
      // The drag box is the maze's outer extent; corridor spacing comes from
      // the panel untouched, so the box decides how MANY cells fit, never how
      // wide they are (see mazeGenerator.ts — spacing is a tool constraint).
      return {
        type: 'maze', x, y, w, h,
        spacing: config.maze.spacing, corner: config.maze.corner,
        seed: config.maze.seed, loops: config.maze.loops,
      }
    case 'board':
      // The drag box is the board's OVERALL extent, so a paddle handle eats into
      // it — and it reaches out the RIGHT end, so it comes off the width. `w`
      // stays the cutting field, which is the number that means something
      // ("a 350×250 board"), and the handle grows out past it.
      return {
        type: 'board', x, y, ...config.board, h,
        w: Math.max(10, w - (config.board.handle === 'paddle' ? config.board.handleL : 0)),
      }
    case 'cam':
      // The drag box sizes the cam's CREST — its largest radius — and the base
      // circle is what gives way, since rise is a mechanism figure the panel sets
      // and the crest is base + stroke. The lever scales with it, so a dragged cam
      // stays a lever and not a lump.
      return {
        type: 'cam', cx, cy,
        baseDia: baseDiaForRadius(radius, config.cam.riseMM, config.cam.sweepDeg),
        riseMM: config.cam.riseMM, sweepDeg: config.cam.sweepDeg, boreDia: config.cam.boreDia,
        handleLength: config.cam.handleLength * (radius / Math.max(0.5, config.cam.baseDia / 2 + (config.cam.riseMM * config.cam.sweepDeg) / 360)),
        handleWidth: config.cam.handleWidth,
      }
    case 'escapement':
      // The drag box sizes the WHEEL, which is what a user is thinking about.
      // Everything else is the mechanism and comes from the panel untouched —
      // the anchor is drawn from those same numbers and follows along above it.
      return { type: 'escapement', cx, cy, ...config.escapement, wheelDia: wheelDiaForRadius(radius) }
    case 'pendulum':
      // The drag box is the whole ROD, hung from its top edge — a pendulum is
      // placed by where it hangs from, not by its middle. Length is solved back
      // out of that height, since length is what sets the beat and the rest of
      // the drawing hangs off it.
      return {
        type: 'pendulum', cx, cy: y + h, ...config.pendulum,
        length: lengthForHeight(h, config.pendulum.rodWidth, config.pendulum.bobRy),
      }
    case 'gear':
      // The drag box sizes the gear's outside diameter; tooth count and pressure
      // angle are the pattern and come from the panel, so `module` is what the
      // drag actually sets (a gear's size IS module × teeth).
      return {
        type: 'gear', cx, cy, ...config.gear,
        module: moduleForRadius(radius, config.gear.teeth),
      }
    case 'track':
      // Scale-locked, so CanvasStage places it from the config and never gets
      // here (see SCALE_LOCKED_SHAPES). Answering with the designed piece is
      // the only answer that is still a BRIO track.
      return { type: 'track', cx, cy, ...config.track }
    case 'text': {
      // drag height → font size; left edge and lower y as baseline position
      const h = Math.abs(end.y - start.y)
      const fontSize = h > 1 ? h : config.text.fontSize
      return { type: 'text', x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), text: config.text.text, fontSize, fontFamily: config.text.fontFamily }
    }
  }
}

// Build ShapeParams for click-to-place using panel-configured defaults
export function shapeParamsFromConfig(
  type: ShapeType,
  cx: number,
  cy: number,
  config: ShapeToolConfig
): ShapeParams {
  switch (type) {
    case 'rectangle': {
      const { w, h } = config.rectangle
      return { type, x: cx - w / 2, y: cy - h / 2, w, h }
    }
    case 'roundrect': {
      const { w, h, r } = config.roundrect
      return { type, x: cx - w / 2, y: cy - h / 2, w, h, r }
    }
    case 'inroundrect': {
      const { w, h, r } = config.inroundrect
      return { type, x: cx - w / 2, y: cy - h / 2, w, h, r }
    }
    case 'circle': return { type: 'circle', cx, cy, radius: config.circle.radius }
    case 'ellipse': return { type: 'ellipse', cx, cy, rx: config.ellipse.rx, ry: config.ellipse.ry }
    case 'polygon': return { type: 'polygon', cx, cy, radius: config.polygon.radius, sides: config.polygon.sides }
    case 'star': return { type: 'star', cx, cy, outerRadius: config.star.outerRadius, innerRadius: config.star.innerRadius, points: config.star.points }
    case 'heart': return { type: 'heart', cx, cy, curveRadius: config.heart.curveRadius, angle: config.heart.angle }
    case 'slot': return { type: 'slot', cx, cy, length: config.slot.length, width: config.slot.width }
    case 'shield': return { type: 'shield', cx, cy, w: config.shield.w, h: config.shield.h }
    case 'spirograph': return { type: 'spirograph', cx, cy, radius: config.spirograph.radius, ratio: config.spirograph.ratio, p: config.spirograph.p }
    case 'maze': {
      const { w, h, spacing, corner, seed, loops } = config.maze
      return { type: 'maze', x: cx - w / 2, y: cy - h / 2, w, h, spacing, corner, seed, loops }
    }
    case 'board': {
      const { w, h } = config.board
      return { type: 'board', ...config.board, x: cx - w / 2, y: cy - h / 2 }
    }
    case 'gear': return { type: 'gear', cx, cy, ...config.gear }
    case 'cam': return { type: 'cam', cx, cy, ...config.cam }
    case 'escapement': return { type: 'escapement', cx, cy, ...config.escapement }
    case 'pendulum': return { type: 'pendulum', cx, cy, ...config.pendulum }
    case 'track': return { type: 'track', cx, cy, ...config.track }
    case 'text': return { type: 'text', x: cx, y: cy, text: config.text.text, fontSize: config.text.fontSize, fontFamily: config.text.fontFamily }
  }
}

// Translate shape params by (dx, dy) — keeps params in sync with canvas moves
export function translateShapeParams(p: ShapeParams, dx: number, dy: number): ShapeParams {
  switch (p.type) {
    case 'rectangle': return { ...p, x: p.x + dx, y: p.y + dy }
    case 'roundrect': return { ...p, x: p.x + dx, y: p.y + dy }
    case 'inroundrect': return { ...p, x: p.x + dx, y: p.y + dy }
    case 'circle': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'ellipse': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'polygon': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'star': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'heart': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'slot': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'shield': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'spirograph': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'maze': return { ...p, x: p.x + dx, y: p.y + dy }
    case 'board': return { ...p, x: p.x + dx, y: p.y + dy }
    case 'gear': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'cam': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'escapement': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'pendulum': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'track': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'text': return { ...p, x: p.x + dx, y: p.y + dy }
  }
}

// Scale shape params — returns null for shapes that don't support the given scale (e.g. non-uniform circle)
export function scaleShapeParams(
  p: ShapeParams,
  ax: number,
  ay: number,
  sx: number,
  sy: number
): ShapeParams | null {
  const asx = Math.abs(sx), asy = Math.abs(sy)
  switch (p.type) {
    case 'rectangle': {
      const nx = ax + sx * (p.x - ax), ny = ay + sy * (p.y - ay)
      return { ...p, x: Math.min(nx, nx + p.w * sx), y: Math.min(ny, ny + p.h * sy), w: p.w * asx, h: p.h * asy }
    }
    case 'roundrect': {
      const nx = ax + sx * (p.x - ax), ny = ay + sy * (p.y - ay)
      const nw = p.w * asx, nh = p.h * asy
      const nr = p.r * Math.min(asx, asy)
      return { ...p, x: Math.min(nx, nx + p.w * sx), y: Math.min(ny, ny + p.h * sy), w: nw, h: nh, r: Math.min(nr, nw / 2, nh / 2) }
    }
    case 'inroundrect': {
      const nx = ax + sx * (p.x - ax), ny = ay + sy * (p.y - ay)
      const nw = p.w * asx, nh = p.h * asy
      const nr = p.r * Math.min(asx, asy)
      return { ...p, x: Math.min(nx, nx + p.w * sx), y: Math.min(ny, ny + p.h * sy), w: nw, h: nh, r: Math.min(nr, nw / 2, nh / 2) }
    }
    case 'circle': {
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      if (Math.abs(asx - asy) > 0.001)
        return { type: 'ellipse', cx: ncx, cy: ncy, rx: p.radius * asx, ry: p.radius * asy }
      return { ...p, cx: ncx, cy: ncy, radius: p.radius * asx }
    }
    case 'ellipse': {
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, rx: p.rx * asx, ry: p.ry * asy }
    }
    case 'polygon': {
      if (Math.abs(asx - asy) > 0.001) return null // non-uniform distorts polygon
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, radius: p.radius * asx }
    }
    case 'star': {
      if (Math.abs(asx - asy) > 0.001) return null
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, outerRadius: p.outerRadius * asx, innerRadius: p.innerRadius * asx }
    }
    case 'heart': {
      if (Math.abs(asx - asy) > 0.001) return null
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, curveRadius: p.curveRadius * asx }
    }
    case 'slot': {
      // Allow non-uniform scale: X axis → length, Y axis → width (slot is always horizontal)
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      const newWidth = p.width * asy
      const newLength = Math.max(p.length * asx, newWidth)
      return { ...p, cx: ncx, cy: ncy, length: newLength, width: newWidth }
    }
    case 'shield': {
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, w: p.w * asx, h: p.h * asy }
    }
    case 'spirograph': {
      if (Math.abs(asx - asy) > 0.001) return null // non-uniform isn't a spirograph any more
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, radius: p.radius * asx } // ratio/pen fixed — scaling resizes, never re-patterns
    }
    case 'maze': {
      // Spacing and corner radius do NOT scale — both are set from the cutter,
      // and stretching a maze to fit the stock must not thin its walls. A
      // resized maze therefore holds its corridor width and re-lays itself with
      // more (or fewer) cells; the seed keeps that deterministic.
      const nx = ax + sx * (p.x - ax), ny = ay + sy * (p.y - ay)
      return { ...p, x: Math.min(nx, nx + p.w * sx), y: Math.min(ny, ny + p.h * sy), w: p.w * asx, h: p.h * asy }
    }
    case 'board': {
      // Unlike the maze, every feature here is a proportion of the design rather
      // than a tool constraint, so they all ride along. Under a non-uniform
      // scale the round ones follow the SMALLER factor — that keeps a handle,
      // a hole and a groove that already fit still fitting.
      const nx = ax + sx * (p.x - ax), ny = ay + sy * (p.y - ay)
      const k = Math.min(asx, asy)
      return {
        ...p,
        x: Math.min(nx, nx + p.w * sx), y: Math.min(ny, ny + p.h * sy),
        w: p.w * asx, h: p.h * asy,
        corner: p.corner * k, handleW: p.handleW * k, handleL: p.handleL * k,
        handleInset: p.handleInset * k, holeDia: p.holeDia * k, grooveInset: p.grooveInset * k,
      }
    }
    case 'gear': {
      // A gear stretched on one axis is not a gear — the involute is defined off
      // a circular base. Non-uniform therefore drops the params and leaves a
      // plain path, the same answer polygon/star/spirograph give.
      if (Math.abs(asx - asy) > 0.001) return null
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      // Teeth and pressure angle are the pattern; module and bore are lengths.
      // The web's two widths are lengths too when they have been dialled in;
      // left absent they follow the module, so there is nothing to scale.
      return {
        ...p, cx: ncx, cy: ncy, module: p.module * asx, bore: p.bore * asx, hubDia: p.hubDia * asx,
        backlash: p.backlash * asx, pinDia: p.pinDia * asx,
        ...(p.spokeWidth != null ? { spokeWidth: p.spokeWidth * asx } : {}),
        ...(p.rimWidth != null ? { rimWidth: p.rimWidth * asx } : {}),
      }
    }
    case 'cam': {
      // A cam stretched on one axis is not an Archimedean spiral — the lift stops
      // being linear in the angle, which is the only reason to use one. Same answer
      // as the gear gives.
      if (Math.abs(asx - asy) > 0.001) return null
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return {
        ...p, cx: ncx, cy: ncy,
        baseDia: p.baseDia * asx, riseMM: p.riseMM * asx, boreDia: p.boreDia * asx,
        handleLength: p.handleLength * asx, handleWidth: p.handleWidth * asx,
      }
    }
    case 'escapement': {
      // Stretched on one axis the pallets no longer stand on tangents to the tip
      // circle, which is the one thing the whole construction rests on — so the
      // params go and a plain path is left, as the gear and cam do.
      if (Math.abs(asx - asy) > 0.001) return null
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      // Teeth and every angle are the mechanism; only lengths scale.
      return {
        ...p, cx: ncx, cy: ncy,
        wheelDia: p.wheelDia * asx, toothDepth: p.toothDepth * asx,
        armWidth: p.armWidth * asx,
        bore: p.bore * asx, hubDia: p.hubDia * asx, anchorBore: p.anchorBore * asx,
      }
    }
    case 'pendulum': {
      // Non-uniform would stretch the rod against the bob and, worse, change the
      // length by a different factor from everything else — the rate would move
      // for a reason the drawing does not show. Same answer as the gear's.
      if (Math.abs(asx - asy) > 0.001) return null
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return {
        ...p, cx: ncx, cy: ncy,
        length: p.length * asx, rodWidth: p.rodWidth * asx,
        bobRx: p.bobRx * asx, bobRy: p.bobRy * asx, bore: p.bore * asx,
      }
    }
    case 'track':
      // Unlike the gear, a track does not scale even uniformly: its every
      // dimension is a fit against a piece cut by somebody else, and a 90%
      // track is not a smaller track but a track that does not connect. So the
      // params go and a plain path is left, which at least says what it is.
      return null
    case 'text': {
      if (Math.abs(asx - asy) > 0.001) return null
      const nx = ax + sx * (p.x - ax), ny = ay + sy * (p.y - ay)
      return { ...p, x: nx, y: ny, fontSize: p.fontSize * asx }
    }
  }
}
