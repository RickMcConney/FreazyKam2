// ─── Weight-driven clock train ────────────────────────────────────────────────
//
// This is NOT a shape. It is a small designer that emits SEVERAL ordinary shapes
// — cycloidal wheels with lantern pinions, and one escapement — each landing
// as its own chip with its own parameters, so every wheel stays independently
// editable afterwards. That is the whole reason it is not a `ShapeType`: a shape
// is one set of params, and a clock is several sets that only agree about the
// tooth and pin counts.
//
// What it works out, and what it deliberately does not:
//
//   • THE PENDULUM comes from the beat and nothing else. A pendulum's period is
//     T = 2π√(L/g), the beat is half a period, so L = g·(2·beat)²/4π². A one
//     second beat gives the familiar 994 mm seconds pendulum.
//
//   • THE GOING TRAIN is then forced. The escape wheel gives up half a tooth per
//     beat, so it turns once every `2·beat·escapeTeeth` seconds; the great wheel
//     is required to turn once every `greatWheelMin` minutes (60 puts the minute
//     hand straight on it). The ratio between those two is what the train's
//     meshes must produce EXACTLY — a train off by a thousandth is 86 seconds a
//     day —
//     which is why `solveTrain` searches integer factorisations rather than
//     rounding a cube root.
//
//   • THE DRIVE WHEEL is the opposite case, and the distinction matters. It
//     carries the weight drum and drives the great wheel's pinion, so it sets
//     only how long the clock runs between winds. Nothing about the RATE depends
//     on it, so its ratio is simply rounded to a whole tooth and the achieved
//     run time reported back. Asking a search to hit a run time exactly would be
//     solving for a number nobody measures.
//
// Every wheel drives the pinion of the wheel AFTER it, so each gear is emitted
// with `emitPinion` — the pinion beside the great wheel is the SECOND wheel's,
// and the one beside the LAST train wheel is the escape wheel's. The escapement
// generator emits no pinion of its own, which is exactly right: that last
// wheel's is it. The great wheel therefore has a pinion driven by the drive
// wheel, and the drive wheel is the one wheel in the clock with nothing driving
// it but the cord.
//
//   • HOW MANY WHEELS is the spec's (`trainWheels`): three by default — great,
//     second, escape, the classic English longcase train and what a wooden clock
//     wants — or four for a clock designed before there was a choice. It decides
//     more than a part count: every mesh reverses the rotation, so it also fixes
//     which way the escape wheel must run for the minute hand to go clockwise
//     (`escapeClockwiseFor`).

import { getMultiBBox } from '../canvas/selectionUtils'
import { gearDims, gearHub, gearMesh, pinionDims } from './gearGenerator'
import { escapementDims, escapementPose } from './escapementGenerator'
import {
  generateShapeParts, translateShapeParams,
  type ShapeParams, type ShapeToolConfig,
} from './shapeGenerators'
import { clamp } from './polyOps'

/** mm/s². The pendulum length is only as good as this, so it is stated once. */
export const G_MM = 9806.65

/** Wheels in the going train a NEW clock is built with — great, second, escape,
 *  so TWO meshes between the minute arbor and the escapement.
 *
 *  This is the classic English seconds-pendulum going train and it is what a
 *  wooden clock wants. Fewer meshes is fewer pivots and one fewer mesh loss, and
 *  a wooden train has no slack to spend: the torque arriving at the pallets is
 *  what a wooden clock is always short of, and you cannot simply hang more
 *  weight, since the weight is also what wears wooden pivots and crushes the
 *  plates. Every routed wheel also carries its own runout and spacing error,
 *  which shows as a once-a-turn tight spot — three meshes is three chances to
 *  have one deep enough to stall the train, and every arbor is one more centre
 *  distance that walks with the humidity.
 *
 *  WHAT MAKES IT AFFORDABLE IS THE LANTERN, not dropping a wheel. Two meshes
 *  have to split 60:1 as roughly 7.75 each, which needs an 8-pin pinion — and a
 *  lantern takes a low count where a cut pinion will not, the pin being a full
 *  cylinder that the wheel's face is generated against, so there is no undercut
 *  to fight at any count. 8 is comfortable and 6 is done; below 6 the action
 *  goes lumpy. Hence `DEFAULT_CLOCK_SPEC.minPins` of 8: leave it at 12 and the
 *  solver needs ~93-tooth wheels to make two meshes come to 60. */
export const DEFAULT_TRAIN_WHEELS = 3

/** …and what a clock designed before there was a choice has. Absent
 *  `ClockSpec.trainWheels` reads as this, so an old project opens cutting
 *  exactly what it always cut — the same rule `module` and `motionSize` follow. */
export const LEGACY_TRAIN_WHEELS = 4

/** Wheels in this clock's going train, great…escape. */
export function trainWheelsOf(spec: Pick<ClockSpec, 'trainWheels'>): 3 | 4 {
  return spec.trainWheels === 3 || spec.trainWheels === 4 ? spec.trainWheels : LEGACY_TRAIN_WHEELS
}

/** …and the meshes between them, which is what `solveTrain` divides the ratio
 *  across. The drive wheel's mesh is NOT one of these: its count follows the run
 *  time rather than the rate. */
export function meshCountOf(spec: Pick<ClockSpec, 'trainWheels'>): number {
  return trainWheelsOf(spec) - 1
}

/**
 * Which way the escape wheel must run for the MINUTE HAND to run clockwise.
 *
 * Every external mesh reverses the sense, so the great wheel — which carries the
 * minute hand — and the escape wheel agree only when the number of meshes
 * between them is even. At four wheels that is three meshes and they turn
 * opposite ways; at three it is two and they turn together.
 *
 * So this is FORCED by the wheel count and is not the user's Escapement default
 * to give, exactly as `backlash` and `pinDia` are not: which way the hands go is
 * a decision about the clock. Leaving it be would build a three-wheel clock
 * whose minute hand runs backwards — and it fails silently twice over, since
 * back relief makes a wheel handed, so every wheel in the train would have its
 * ACTING flank cut away and still look entirely reasonable on the stock.
 *
 * The pleasant consequence at three wheels: the escape wheel turns clockwise
 * too, so a mark on it reads as a seconds hand going the right way round —
 * which is why a longcase puts its seconds hand on the escape arbor.
 */
export function escapeClockwiseFor(trainWheels: number): boolean {
  return (Math.max(2, Math.round(trainWheels)) - 1) % 2 === 0
}

// Bounds on ONE mesh. A wooden clock wheel much under 1.5:1 is not worth the
// arbor it sits on, and much over 12:1 needs a wheel that will not fit the case.
export const MIN_MESH_RATIO = 1.5
export const MAX_MESH_RATIO = 12
// How far above `minPins` the solver may go looking for an exact train. Each
// extra pin makes every wheel on that mesh bigger for the same ratio, so this is
// a last resort and is priced as one below.
const PIN_HEADROOM = 3

/** Degrees each link of the untouched train leans off vertical, alternating
 *  sides. A DRAWING choice — only the link LENGTHS are forced (a mesh cares
 *  only that the pitch circles are tangent), so this is just where a clock
 *  starts before anyone arranges it. */
const TRAIN_LEAN_DEG = 22

/** Where the MOTION WORK's arbor sits, as one more entry on the end of
 *  `linkAngles`. The train's links run one per pair of neighbouring arbors;
 *  this one is a BRANCH off the great arbor rather than the next link of the
 *  chain, which is why it is indexed past them and why its angle points the
 *  other way — from its host TO the joint, since here the host is what is fixed.
 *
 *  A FIXED SLOT, not `trainWheels` — it is deliberately indexed past the LONGEST
 *  train rather than past this clock's own. A three-wheel train uses links 0–2
 *  and simply leaves slot 3 unused, so switching a clock between three and four
 *  wheels does not slide the motion branch onto a train link (which would fold
 *  the hour hand into the going train) or throw the arrangement away. */
export const MOTION_LINK = LEGACY_TRAIN_WHEELS

/** …and where it starts: straight out to the right of the great arbor, clear of
 *  a train that leans upward. As arbitrary as the train's own lean, and as
 *  arrangeable — only the LENGTH is forced. */
const MOTION_LEAN_DEG = 0

/** The lean as link angles: up and alternately left/right, which keeps the
 *  train compact and vertical and leaves the middle clear for the pendulum. The
 *  motion branch rides on the end, so one array covers the whole arrangement. */
export function defaultLinkAngles(links = MOTION_LINK + 1): number[] {
  return Array.from({ length: links }, (_, i) => i === MOTION_LINK
    ? MOTION_LEAN_DEG
    : 90 + (i % 2 === 0 ? 1 : -1) * TRAIN_LEAN_DEG)
}

/**
 * Link *i*'s angle in RADIANS, defaulted per element.
 *
 * Per element and not `angles ?? defaults` wholesale: a short or sparse array
 * from an older project must fill in the missing ones rather than throw the
 * user's other angles away, and a non-finite entry has to be caught here — it
 * would otherwise NaN every coordinate downstream and the clock would silently
 * stop rendering rather than look wrong.
 */
export function linkAngleAt(angles: number[] | undefined, i: number): number {
  const a = angles?.[i]
  const fallback = i === MOTION_LINK ? MOTION_LEAN_DEG : 90 + (i % 2 === 0 ? 1 : -1) * TRAIN_LEAN_DEG
  const deg = Number.isFinite(a) ? (a as number) : fallback
  return (deg * Math.PI) / 180
}

/** Ratio between one mesh's module and the next one toward the escapement.
 *  Applied from the GREAT wheel on — see `solveModules`. */
export const MODULE_TAPER = 0.8
/** Largest wheel a default clock may cut — a board's width, near enough. */
export const MAX_WHEEL_DIA = 280
/** What a root fillet is cut with, for the reach warning. A cycloidal root is
 *  filled at `0.38·m` like an involute one, so below about m4.2 a 1/8" bit
 *  leaves more material in the root than the drawing shows — which for a lantern
 *  is not cosmetic, since the pin has to reach into that space. */
export const CLOCK_ROOT_BIT_DIA = 25.4 / 8
/**
 * Which of the clock's two dowels a SLOW mesh takes: **the fattest one the tooth
 * can still push.**
 *
 * A lantern mesh has exactly two members and they fail differently. The PIN is a
 * beam between its cheeks and wants to be fat; the wheel's TOOTH is what is left
 * of the circular pitch once the pin and the backlash are taken out
 * (`π·m − pin Ø − backlash`), so every millimetre of pin is a millimetre off the
 * tooth. The dowel is absolute and the pitch is not, so on a fine enough mesh the
 * fat pin stops being the strong answer and starts being the reason the tooth
 * breaks across the grain. The changeover is therefore where the two members are
 * the same size — take the large pin while it leaves a tooth at least as thick as
 * itself, and the small one after that.
 *
 * IT REPLACED A FRACTION-OF-PITCH HEURISTIC (`0.35·π·m`, nearest wins) which had
 * no failure mode behind it and switched over at m4.09 for a Ø6/Ø3 pair. That was
 * fine while a clock's great wheel was m5.6, and stopped being fine when the
 * three-wheel train landed at m4.24 — 3.6% clear of the switch. A `maxWheelDia`
 * an inch narrower put the most heavily loaded lantern in the going train (the
 * one the great wheel drives, at the full weight torque) onto the thin dowel,
 * silently. This rule changes over at m3.92 for the same pair, which on a
 * three-wheel train is a 258 mm board rather than a 270 mm one, and it gives up
 * the fat pin only where the tooth really has become the weaker member.
 *
 * Only asked of the SLOW end; the fast end is pinned small whatever it says (see
 * `LIGHT_PIN_MESHES`).
 */
export function pinForTooth(module: number, large: number, small: number, backlash: number): number {
  const tooth = Math.PI * Math.max(0.05, module) - large - Math.max(0, backlash)
  return tooth >= large ? large : small
}

/** How many meshes at the FAST end are pinned small whatever `pinForTooth`
 *  would say — the last two, which on a four-wheel train are the lanterns carried
 *  by the third wheel and the escape wheel.
 *
 *  IT IS CAPPED SO THE GREAT WHEEL'S OWN MESH IS NEVER IN THE SET (see
 *  `solveModules`): on a three-wheel train there are only three meshes in all,
 *  and taking the last two would put the thin dowel through the lantern the
 *  great wheel drives — the most heavily loaded pinion in the going train. A
 *  three-wheel clock therefore lightens the escape mesh alone.
 *
 *  Fitting the pin to the pitch is a strength argument, and at the fast end
 *  strength is not what is scarce: torque has fallen by the whole train ratio, so
 *  those pins carry almost nothing, while their INERTIA is what the escapement
 *  has to start and stop twice a second. A fat pin there is weight in the worst
 *  place. Nothing is risked by going thin, either — the tooth is
 *  `π·m − pin Ø − backlash`, so a smaller pin only ever leaves MORE tooth. */
export const LIGHT_PIN_MESHES = 2

/** Default arbor spacing for the motion work, mm — a module of 4 at the classic
 *  10/30 and 8/32 counts, which is what a size-2 motion work came to on the old
 *  one-module m4 clock. */
export const MOTION_CENTRE_MM = 80

export interface ClockSpec {
  /** Seconds per beat — HALF the pendulum's period, and the number a clock is
   *  actually described by ("a seconds pendulum"). Sets the pendulum length. */
  beatSeconds: number
  /** Escape wheel teeth. With a one-second beat, 30 turns it once a minute. */
  escapeTeeth: number
  /** Wheels in the going train, great…escape — 3 or 4, so two meshes or three.
   *  Absent means 4, which is what a clock designed before there was a choice
   *  has; a new clock is 3 (see `DEFAULT_TRAIN_WHEELS` for why).
   *
   *  It is not only a count. The number of meshes decides which way each arbor
   *  turns, so it also fixes the escape wheel's handedness — see
   *  `escapeClockwiseFor` — and changing it re-cuts every wheel in the train
   *  mirrored. */
  trainWheels?: 3 | 4
  /** Tooth counts the user is HOLDING, one per mesh (great, second, and third
   *  on a four-wheel train); `null` or absent means the solver chooses. The rate
   *  is still what the search is costed on, so pinning one wheel moves the others to keep the
   *  train exact — pin the wheel you have stock for, or have already cut. Pin
   *  every one of them and there is nothing left to solve: the train is reported
   *  as it stands, in red if it no longer keeps time. See `solveTrain`. */
  lockedTeeth?: (number | null)[]
  /** Fewest pins any lantern pinion in the train may have. A lantern pinion with
   *  too few pins has a coarse, lumpy action, so this is the floor the solver
   *  works up from — it is not a target. */
  minPins: number
  /** Minutes per revolution of the great wheel. 60 puts the minute hand on it. */
  greatWheelMin: number
  /** LEGACY — one tooth size for the whole going train, mm. Clocks designed
   *  before per-mesh modules carry this and no `maxWheelDia`; they are read as a
   *  UNIFORM family at this module, so an old project opens cutting exactly what
   *  it always cut. Nothing writes it any more. */
  module?: number
  /** The biggest wheel this clock may cut, mm — a board's width, near enough,
   *  and the one number a maker actually has. Tooth size is scaled to it rather
   *  than chosen: see `solveModules`. Absent on an older clock, which falls back
   *  to `module`. */
  maxWheelDia?: number
  /** Ratio between one mesh's module and the next one toward the escapement.
   *  0.8 makes each mesh a fifth finer than the one before it, which is what a
   *  real clock does — torque falls by the mesh ratio at every step. 1 is
   *  uniform. Absent reads as MODULE_TAPER, or as 1 on a legacy clock. */
  toothTaper?: number
  /** Tooth sizes the user is HOLDING, one per mesh, drive end first — the same
   *  idea as `lockedTeeth`. A held mesh is taken out of the fit and may exceed
   *  `maxWheelDia`, which the readout says rather than this quietly overruling
   *  a number someone typed. */
  lockedModules?: (number | null)[]
  /** Play at every mesh, mm at the pitch line — tooth THINNING, not a wider
   *  centre distance (see gearGenerator). One figure for the whole clock: it is
   *  a property of how the wheels are cut, and setting it per wheel meant
   *  opening a chip per wheel to change one decision. */
  backlash: number
  /** The LARGER of the two pin diameters, mm — what the coarse end of the train
   *  is pinned with. On a cycloidal wheel this is a tooth-FORM parameter — the
   *  wheel's face is the epicycloid of the pin circle offset inward by the pin
   *  radius — so a wheel and the lantern it drives must agree about it. */
  pinDia: number
  /** The SMALLER pin, for the fine end. Two sizes rather than one because the
   *  tooth is `π·m − pin Ø − backlash` and the pin is an absolute dowel: one
   *  that suits the great wheel is most of the tooth space at the escape end,
   *  and one that suits the escape end rattles in the great wheel's. The slow end
   *  takes the fattest of the two its tooth can still push — see `pinForTooth`;
   *  the fast end takes the small one regardless. Absent on a clock designed before there were two, which
   *  reads as `pinDia` for every mesh and so cuts what it always cut. */
  pinDiaFine?: number
  /** Cut the MOTION WORK too — the two extra wheels that drive an hour hand off
   *  the minute arbor at 12:1 (see `solveMotionWork`). Optional, and absent on a
   *  clock designed before it existed, which reads as off. */
  motionWork?: boolean
  /** How far the minute wheel's stud stands from the minute arbor, mm — ONE
   *  distance, both of the motion work's meshes running at it. It is the number
   *  that moves the stud clear of a big great wheel, and the number a plate is
   *  drilled from, which is why it is stated in millimetres rather than as the
   *  `k` of the count family it used to be: with the counts fixed at the classic
   *  10/30 and 8/32, `C = 10·k·m` makes the MODULE the thing that falls out of a
   *  distance, and k stepped it in 50 mm jumps. Absent on an older clock, where
   *  `motionSize` and the clock's one module say the same thing. */
  motionCentreMM?: number
  /** LEGACY — k in the old `P₁ = 5k / P₂ = 4k` family. Read only to recover
   *  `motionCentreMM` for a clock designed before there was one. */
  motionSize?: number
  /** Hours the clock should run on one wind. */
  runHours: number
  /** How far the weight falls over that run, mm. */
  fallMM: number
  /** Diameter of the drum the cord winds on, on the drive wheel's arbor, mm. */
  drumDia: number
  /** Direction of each link of the going train, DEGREES CCW from +x — link i
   *  runs from arbor i to arbor i+1, so there is one fewer of these than there
   *  are arbors (3 for a three-wheel train's four, 4 for a four-wheel train's
   *  five). The lengths are NOT here and never
   *  will be: they are forced by the meshes, and storing them would let the two
   *  disagree. These are the whole of what a user may arrange.
   *
   *  Read through `linkAngleAt`, never indexed directly — a project saved before
   *  this field existed has none, and an undefined angle does not draw a
   *  slightly wrong plate, it makes every coordinate NaN and the clock silently
   *  stops rendering. Same trap as `cycOf` and `toothCurve`. */
  linkAngles: number[]
}

export const DEFAULT_CLOCK_SPEC: ClockSpec = {
  // A seconds pendulum, a 30-tooth escape wheel and THREE wheels on 8-pin
  // pinions: 64/8 then 60/8 is 8 × 7.5, exactly 60:1, so the great wheel turns
  // once an hour and carries the minute hand while the escape wheel turns once a
  // minute. That is the standard English longcase going train, and both ends of
  // it turn clockwise — so a mark on the escape wheel reads as a seconds hand.
  beatSeconds: 1,
  escapeTeeth: 30,
  trainWheels: DEFAULT_TRAIN_WHEELS,
  // Eight, because two meshes have to come to ~7.75 each and a lantern takes a
  // low count happily. At 12 the same ratio needs ~93-tooth wheels.
  minPins: 8,
  greatWheelMin: 60,
  // Sized to the board rather than to a module: the wheels come out as big as
  // 280 mm allows, tapering toward the escapement.
  maxWheelDia: MAX_WHEEL_DIA,
  toothTaper: MODULE_TAPER,
  // The Gear defaults' own figures, so a clock starts where a hand-drawn gear
  // does; both are now editable in one place for the whole train.
  backlash: 0.3,
  // Two dowels out of the drawer: the fat one for the coarse end of the train,
  // the thin one for the fine end.
  pinDia: 6,
  pinDiaFine: 3,
  // Off: a clock is a going train, and the hands are a thing you add to one.
  motionWork: false,
  // 80 mm between the minute arbor and the stud, which at the classic 10/30 and
  // 8/32 is a module of 4 — what a size-2 motion work came to on the old m4 clock.
  motionCentreMM: MOTION_CENTRE_MM,
  // A day's run off a metre of fall on a 40 mm drum: about eight turns of cord,
  // so the drive wheel wants roughly 3:1 onto the great wheel.
  runHours: 24,
  fallMM: 1000,
  drumDia: 40,
  linkAngles: defaultLinkAngles(),
}

// ─── Pendulum ─────────────────────────────────────────────────────────────────

/**
 * Length of the simple pendulum that beats `beatSeconds`.
 *
 * This is the length to the CENTRE OF OSCILLATION, not to the top of the bob —
 * a real rod-and-bob pendulum is regulated by raising the bob against it, which
 * is what the rating nut is for.
 */
export function pendulumLengthMM(beatSeconds: number): number {
  const period = 2 * Math.max(0.05, beatSeconds)
  return (G_MM * period * period) / (4 * Math.PI * Math.PI)
}

/** Seconds the escape wheel takes for one revolution: half a tooth per beat. */
export function escapeRevSeconds(beatSeconds: number, escapeTeeth: number): number {
  return 2 * Math.max(0.05, beatSeconds) * Math.max(6, Math.round(escapeTeeth))
}

// ─── The going train ──────────────────────────────────────────────────────────

export interface Mesh {
  /** Teeth on the DRIVING wheel of this mesh. */
  teeth: number
  /** Pins on the lantern pinion it drives — which sits on the next arbor. */
  pins: number
}

export interface TrainSolution {
  /** Great→second, then second→escape, or second→third and third→escape on a
   *  four-wheel train. One per mesh of the going train, drive end first. */
  meshes: Mesh[]
  /** Ratio those meshes had to produce, great wheel to escape wheel. */
  targetRatio: number
  /** What they actually produce. */
  actualRatio: number
  /** True when the two are equal — the only case that keeps time. */
  exact: boolean
  /** Seconds a day the hands gain (+) or lose (−) from an inexact train. Zero
   *  when exact. This is the whole reason the search insists on exactness. */
  errorSecPerDay: number
}

/**
 * Split `ratio` across `meshCount` lantern meshes, exactly if it can be done.
 *
 * The search is over integer factorisations, not over rounded roots, because a
 * clock train that is a thousandth out is 86 seconds a day. It walks all but one
 * of the wheels and takes the last from the quotient; anything that lands on a
 * whole tooth costs nothing, everything else pays for its rate error first and
 * its shape second.
 *
 * `meshCount` is `trainWheels − 1`: two for the three-wheel train a new clock
 * gets, three for the four-wheel one an older project carries. At two the
 * classic 64/8 and 60/8 fall straight out of the cost function, the spread term
 * preferring the evenest split of 60 that lands on whole teeth.
 *
 * Cost, in order: rate error, then how far the three ratios are spread apart (an
 * even split gives the smallest wheels overall), then pins above `minPins` — the
 * last priced so that a train needing fatter pinions is only ever chosen when
 * there is no exact one without them.
 *
 * `locked` HOLDS TOOTH COUNTS THE USER HAS CHOSEN, one entry per mesh (great,
 * second, and third where there is one; `null` for free). The search then runs over what is left and
 * the RATE is still what it is costed on, which is the point of the feature: pin
 * the wheel you have stock for, or the one you have already cut, and the others
 * move to keep the train exact. Three things follow from a lock and each would
 * be a bug if it were forgotten:
 *
 *   • the DERIVED wheel is the last FREE one, not always the last — hold all
 *     but one and there is only that one left to solve for, and hold every one
 *     and there is nothing to search at all: the train is simply reported
 *     (inexact and in red, if that is what the user has asked for);
 *   • a locked count IGNORES the mesh-ratio bounds. They exist to stop the
 *     search proposing silly wheels, and a number the user typed is not a
 *     proposal;
 *   • the result is NOT SORTED when anything is locked. The sort puts the
 *     biggest wheel at the great arbor, which is right for a train the solver
 *     chose freely — but the locks are per WHEEL, and sorting would slide the
 *     user's count onto a different arbor.
 */
export function solveTrain(
  ratio: number,
  minPins: number,
  locked?: (number | null)[],
  meshCount = DEFAULT_TRAIN_WHEELS - 1,
): TrainSolution {
  const target = Math.max(1, ratio)
  const floor = Math.max(2, Math.round(minPins))
  const n = Math.max(1, Math.round(meshCount))
  const ideal = Math.log(target) / n

  // One entry per mesh: the count the user is holding, or null.
  const lock = Array.from({ length: n }, (_, i) => {
    const v = locked?.[i]
    return typeof v === 'number' && Number.isFinite(v) && v >= 4 ? Math.round(v) : null
  })
  const anyLocked = lock.some((v) => v !== null)
  // The one the quotient decides — the LAST free mesh, or none when every one of
  // them is held.
  const idx = Array.from({ length: n }, (_, i) => i)
  const freeIdx = idx.filter((i) => lock[i] === null)
  const derive = freeIdx.length > 0 ? freeIdx[freeIdx.length - 1] : -1
  const walk = idx.filter((i) => i !== derive)

  let bestCost = Infinity
  let best: Mesh[] | null = null

  const consider = (t: number[], p: number[], pinCost: number) => {
    const actual = t.reduce((r, ti, i) => r * (ti / p[i]), 1)
    // Rate error dominates by six orders of magnitude: an exact train is always
    // preferred to a prettier inexact one.
    const relErr = Math.abs(actual / target - 1)
    const spread = t.reduce((sum, ti, i) => sum + (Math.log(ti / p[i]) - ideal) ** 2, 0)
    const cost = relErr * 1e6 + spread + pinCost
    if (cost < bestCost) {
      bestCost = cost
      best = t.map((ti, i) => ({ teeth: ti, pins: p[i] }))
    }
  }

  // Every pin count each mesh may take, as one counter over `PIN_HEADROOM + 1`
  // options per mesh — the nested loops this replaced only worked for three.
  const options = PIN_HEADROOM + 1
  const combos = options ** n
  for (let code = 0; code < combos; code++) {
    const pins: number[] = []
    for (let i = 0, c = code; i < n; i++, c = Math.floor(c / options)) {
      pins.push(floor + (c % options))
    }
    const pinCost = 0.01 * pins.reduce((sum, p) => sum + p - floor, 0)
    if (pinCost >= bestCost) continue
    const product = pins.reduce((r, p) => r * p, target)   // what ΠTᵢ must come to

    if (derive < 0) {
      // Every count held: there is nothing to search, only to report.
      consider(lock as number[], pins, pinCost)
      continue
    }
    // A locked count is walked as itself and is NOT held to the ratio bounds; a
    // free one is walked over them.
    const range = (i: number): [number, number] => lock[i] !== null
      ? [lock[i]!, lock[i]!]
      : [Math.ceil(MIN_MESH_RATIO * pins[i]), Math.floor(MAX_MESH_RATIO * pins[i])]
    const [dLo, dHi] = range(derive)
    const t = new Array<number>(n).fill(0)
    // One loop per WALKED mesh, however many that is — the innermost takes the
    // derived count from the quotient.
    const step = (w: number, prod: number) => {
      if (w === walk.length) {
        const d = Math.round(product / prod)
        if (d < dLo || d > dHi) return
        t[derive] = d
        consider(t, pins, pinCost)
        return
      }
      const [lo, hi] = range(walk[w])
      for (let v = lo; v <= hi; v++) {
        t[walk[w]] = v
        step(w + 1, prod * v)
      }
    }
    step(0, 1)
  }

  // Nothing in range at all (an absurd ratio). Fall back to an even split so the
  // caller always has a train to draw and a rate error to report — holding
  // whatever the user locked, since that is not the solver's to give up.
  if (!best) {
    const r = Math.exp(ideal)
    best = Array.from({ length: n }, (_, i) => ({
      teeth: lock[i] ?? Math.max(4, Math.round(floor * r)),
      pins: floor,
    }))
  }

  // Descending, so the biggest wheel is the great wheel — the slow, high-torque
  // end of the train, which is where a wooden clock wants its material. NOT when
  // anything is locked: the locks are per wheel, and this would move them.
  if (!anyLocked) best.sort((a, b) => b.teeth / b.pins - a.teeth / a.pins)

  const actualRatio = best.reduce((r, m) => r * (m.teeth / m.pins), 1)
  // The hands advance as the great wheel turns, so a train that is too SLOW
  // (actual > target) makes the clock lose.
  const errorSecPerDay = 86400 * (target / actualRatio - 1)
  return {
    meshes: best,
    targetRatio: target,
    actualRatio,
    exact: Math.abs(errorSecPerDay) < 1e-6,
    errorSecPerDay,
  }
}

/** The ratio the going train has to produce for this spec. */
export function trainRatio(spec: ClockSpec): number {
  const escSec = escapeRevSeconds(spec.beatSeconds, spec.escapeTeeth)
  return (Math.max(0.1, spec.greatWheelMin) * 60) / escSec
}

// ─── The drive wheel ──────────────────────────────────────────────────────────

export interface DriveSolution {
  teeth: number
  pins: number
  /** Turns of cord the fall gives on this drum. */
  turns: number
  /** Hours the clock really runs, with the wheel rounded to a whole tooth. */
  runHours: number
  /** The requested run needed a wheel smaller than a wheel can be — it has been
   *  held at the floor, so the clock runs LONGER than asked. A shorter run wants
   *  a fatter drum or less fall, not a smaller wheel. */
  clampedSmall: boolean
}

/**
 * The wheel that carries the weight drum.
 *
 * Unlike the going train this is rounded, not solved: it sets running time, and
 * running time is not a rate. What comes back is the wheel and the run it really
 * gives, so the panel can report the difference rather than pretend.
 */
export function solveDrive(spec: ClockSpec, minPins: number): DriveSolution {
  const pins = Math.max(2, Math.round(minPins))
  const drum = Math.max(1, spec.drumDia)
  const turns = Math.max(0.01, spec.fallMM) / (Math.PI * drum)
  const greatHours = Math.max(0.001, spec.greatWheelMin) / 60
  // Hours the drive wheel is given for one revolution, and hence its ratio onto
  // the great wheel's pinion.
  const wanted = Math.max(0.001, spec.runHours) / turns / greatHours
  const floorTeeth = Math.max(8, Math.ceil(pins * MIN_MESH_RATIO))
  const raw = Math.round(pins * wanted)
  const teeth = Math.min(Math.max(raw, floorTeeth), Math.floor(pins * MAX_MESH_RATIO))
  return {
    teeth, pins, turns,
    runHours: turns * (teeth / pins) * greatHours,
    clampedSmall: raw < floorTeeth,
  }
}

// ─── Tooth size: one module per MESH, tapering toward the escapement ──────────
//
// THE CLOCK HAS NO SINGLE MODULE, and the reason is that one module makes wheel
// diameter `m × z` — with `z` forced by the rate — so nothing about how big the
// wheels come out is anyone's choice. The default train (48/48/45 at m4) is
// three ~200 mm wheels on a 300 mm board for exactly that reason.
//
// A mesh only requires that its OWN two members share a module: the wheel's face
// is the epicycloid of the lantern's pin circle, and that circle is the pinion's
// pitch circle at the mesh's module. Nothing couples one mesh to the next, so
// each may have its own. There is no gear cutter here — a router follows an
// outline — so the usual reason to standardise on one pitch does not apply.
//
// TOOTH SIZE FALLS TOWARD THE ESCAPEMENT, which is what a real clock does and is
// about load rather than looks: torque drops by the mesh ratio at every step, so
// the drive end carries some sixty times the escape end's. One module leaves the
// great wheel's teeth marginal for their load or the escape wheel's needlessly
// coarse for theirs. `toothTaper` is the ratio between one mesh's module and the
// next along (0.8 = each mesh a fifth finer than the one before it; 1 = uniform,
// which is what every clock designed before this did).
//
// The family is then SCALED so the biggest wheel just fits `maxWheelDia` — the
// one number a maker actually has, being the width of the board. `outsideDia` is
// NOT linear in the module (an absolute pin diameter and the cycloidal
// addendum's `2ρ` cap both break it), so this bisects rather than dividing.

export interface MeshModule {
  /** Tooth size at this mesh, mm. */
  module: number
  /** Which of the clock's two dowels this mesh is pinned with. */
  pinDia: number
  /** Outside diameter of the wheel it cuts, mm — what has to fit the stock. */
  wheelDia: number
  /** Thickness of a tooth at the pitch line: `π·m − pin Ø − backlash`. The pin
   *  is absolute, so a fine mesh runs out of tooth before it runs out of room. */
  toothMM: number
  /** The user pinned this one; it is outside the fitted family. */
  locked: boolean
}

export interface ModuleFamily {
  /** One per mesh, DRIVE END FIRST: drive→great, great→second, then second→escape
   *  or second→third and third→escape. `trainWheels` long — 3 for a three-wheel
   *  train, 4 for a four-wheel one. */
  meshes: MeshModule[]
  /** Index of the mesh whose wheel set the scale by hitting `maxWheelDia`, or
   *  −1 when every mesh was pinned. */
  binding: number
}

/** Context a mesh needs before its wheel can be measured. */
interface ModuleCtx {
  pressureAngle: number; backlash: number
  /** The two dowels; `pinForTooth` picks between them per mesh. */
  pinDia: number; pinDiaFine: number
}

/**
 * Per-mesh tooth size for a solved train.
 *
 * `meshes` is drive-end first. `locked[i]`, when a finite number, pins that
 * mesh and takes it out of the fit — a pinned mesh may therefore exceed
 * `maxWheelDia`, which the readout reports rather than this silently overruling.
 */
export function solveModules(
  meshes: readonly Mesh[],
  maxWheelDia: number,
  taper: number,
  ctx: ModuleCtx,
  locked?: (number | null)[],
): ModuleFamily {
  const t = Number.isFinite(taper) ? clamp(taper, 0.3, 1) : MODULE_TAPER
  const cap = Math.max(10, Number.isFinite(maxWheelDia) ? maxWheelDia : MAX_WHEEL_DIA)
  const large = Math.max(0.1, ctx.pinDia)
  const small = Math.max(0.1, Math.min(ctx.pinDiaFine, large))

  const diaAt = (m: number, mesh: Mesh, pin: number) =>
    gearDims(m, mesh.teeth, ctx.pressureAngle, ctx.backlash,
      { mateTeeth: mesh.pins, pinDia: pin }).outsideDia

  const pinnedAt = (i: number) => {
    const v = locked?.[i]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  }

  // THE TAPER STARTS AT THE GREAT WHEEL, so mesh 0 and mesh 1 share a module.
  // The drive wheel exists to carry the weight drum and set the running time; it
  // meshes with the great arbor's lantern and nothing else, and there is no load
  // case that wants its teeth COARSER than the great wheel's — the great wheel
  // is what the weight acts through. Tapering from the drive end instead made it
  // the biggest wheel in the clock, for nothing, and it is the one wheel whose
  // hub is not free (see the drum).
  const rel = meshes.map((_, i) => Math.pow(t, Math.max(0, i - 1)))
  const free = meshes.map((_, i) => i).filter((i) => pinnedAt(i) === null)

  // Pin choice depends on the module and the module fit depends on the pin (a
  // cycloidal addendum is cut for the pin it runs against), so this is a small
  // fixed point rather than one pass. It settles in two or three rounds; the
  // cap is only there so a pathological case cannot spin.
  let pins = meshes.map(() => large)
  let k = 1
  for (let round = 0; round < 5; round++) {
    if (free.length > 0) {
      const fits = (kk: number) => free.every((i) => diaAt(kk * rel[i], meshes[i], pins[i]) <= cap)
      let lo = 0.01, hi = 200
      if (fits(hi)) lo = hi
      else {
        for (let n = 0; n < 60; n++) {
          const mid = (lo + hi) / 2
          if (fits(mid)) lo = mid; else hi = mid
        }
      }
      k = lo
    }
    // Mesh 0 is the drive wheel's and mesh 1 the GREAT wheel's; those two carry
    // the weight's torque undivided and are never lightened, however few meshes
    // there are. See LIGHT_PIN_MESHES — and `pinForTooth` for what the slow end
    // takes instead, which is the fattest dowel its tooth can still push.
    const lightFrom = Math.max(2, meshes.length - LIGHT_PIN_MESHES)
    const next = meshes.map((_, i) => {
      if (i >= lightFrom) return small
      const m = pinnedAt(i) ?? Math.max(0.05, k * rel[i])
      return pinForTooth(m, large, small, ctx.backlash)
    })
    if (next.every((p, i) => p === pins[i])) break
    pins = next
  }

  let binding = -1
  let worst = -Infinity
  const out = meshes.map((mesh, i) => {
    const pinned = pinnedAt(i)
    const module = pinned ?? Math.max(0.05, k * rel[i])
    const pinDia = pins[i]
    const wheelDia = diaAt(module, mesh, pinDia)
    if (pinned === null) {
      const slack = cap - wheelDia
      if (-slack > worst) { worst = -slack; binding = i }
    }
    return {
      module, pinDia, wheelDia,
      toothMM: Math.PI * module - pinDia - Math.max(0, ctx.backlash),
      locked: pinned !== null,
    }
  })
  return { meshes: out, binding }
}

// ─── The motion work ──────────────────────────────────────────────────────────
//
// The two extra wheels that drive the HOUR HAND off the minute arbor at 12:1.
// The going train ends at the great wheel turning once an hour, which carries
// the minute hand directly; the hour hand runs on a tube around that same arbor
// and has to be geared down from it.
//
// It is one reduction folded through an intermediate arbor, and it is 3 × 4 for
// a reason that is not taste. BOTH MESHES SPAN THE SAME PAIR OF ARBORS — the
// minute arbor and the intermediate one — because the hour wheel is CONCENTRIC
// with the minute arbor (its tube runs over the cannon pinion's). So the two
// centre distances are the same distance, and with a lantern pinion of P pins
// sitting on a pitch circle of `m·P/2` (`describingRadius`, the same rule the
// wheels' teeth are cut to) that says
//
//     P₁ + T₁ = P₂ + T₂,   T₁ = r₁·P₁,   T₂ = r₂·P₂,   r₁·r₂ = 12
//
// With r₁ = 3 and r₂ = 4 that is 4P₁ = 5P₂, so P₁ = 5k and P₂ = 4k for a whole
// number k and the counts come out 15k / 16k. At k = 2 they are the classic
// 10 / 30 and 8 / 32 of a real motion work, which is where those numbers come
// from. Split any other way — 2 × 6, say — and the same arithmetic gives 3P₁ =
// 7P₂, i.e. a three-pin pinion before anything else fits: the split is forced by
// the geometry, not chosen.
//
// The pin DRIVES THE WHEEL here, the opposite of the going train, so the tooth
// contact is on the wheel's flank rather than its face — and a cycloidal wheel's
// flank is cut radial (see gearGenerator), which is conjugate to nothing in
// particular. It is what a motion work always is: the load is the hands and the
// friction of the cannon-pinion clutch, so the drive is nearly free and the
// action only has to not jam. The readout says so rather than leaving it to be
// discovered.

/** The 12:1 split, and it is forced rather than chosen — see above. */
export const MOTION_RATIOS: readonly [number, number] = [3, 4]

/** k in the P₁ = 5k / P₂ = 4k family — FIXED at 2, the classic 10/30 and 8/32.
 *  1 would ask for a four-pin pinion, and above 2 the counts only get bigger for
 *  no gain now that the SIZE of the motion work is set by its centre distance:
 *  with the counts fixed, `C = 10·k·m` makes the module fall out of the distance,
 *  which is a continuum where k was a 50 mm staircase. */
export const MOTION_SIZE = 2


export interface MotionWork {
  /** Pins on the cannon pinion — the driver, fixed to the minute arbor. */
  cannonPins: number
  /** Teeth on the minute wheel it drives, on the intermediate arbor. */
  minuteTeeth: number
  /** Pins on the pinion beside that wheel, on the same intermediate arbor. */
  minutePins: number
  /** Teeth on the hour wheel it drives, back on the minute arbor. */
  hourTeeth: number
  /** Minute arbor to intermediate arbor. ONE number: both meshes run at it, and
   *  that is the whole constraint the counts satisfy. It is now the INPUT, and
   *  the module below is what falls out of it. */
  centreDistanceMM: number
  /** Tooth size, mm — `2C/(P+T)`, i.e. `C/(10k)`. The motion work is cut at its
   *  own module rather than the great wheel's: it meshes with nothing in the
   *  train (the cannon pinion is fixed TO the arbor, not geared to it), so the
   *  only thing its tooth size has to satisfy is its own two meshes. */
  module: number
  /** Pin diameter for both of its lanterns — the clock's SMALL dowel. The motion
   *  work drives the hands and a cannon-pinion clutch, which is next to no load
   *  at all, so there is nothing here wanting the fat pin; and its module comes
   *  from a distance a maker chose for clearance rather than for strength, so
   *  the fat pin would just as likely be most of the tooth space. */
  pinDia: number
  /** Thickness of a tooth at the pitch line, `π·m − pin Ø − backlash`. */
  toothMM: number
  /** 12, by construction — stated so a caller can check rather than trust. */
  ratio: number
}

/**
 * The motion work for a given arbor spacing.
 *
 * The counts are forced (see above) and fixed at the classic 10/30 and 8/32, so
 * `C = m(P+T)/2 = 10·k·m` leaves exactly one free number — and stating it as the
 * DISTANCE rather than as `k` is what makes it a continuum instead of a 50 mm
 * staircase. It is also the number the plate is drilled from and the number that
 * moves the stud clear of a big great wheel, which is what anyone is actually
 * reaching for when they change it.
 */
export function solveMotionWork(
  centreDistanceMM: number, pinDia: number, backlash = 0,
): MotionWork {
  const k = MOTION_SIZE
  const [r1, r2] = MOTION_RATIOS
  const cannonPins = 5 * k
  const minutePins = 4 * k
  const minuteTeeth = r1 * cannonPins
  const hourTeeth = r2 * minutePins
  const C = Math.max(1, Number.isFinite(centreDistanceMM) ? centreDistanceMM : MOTION_CENTRE_MM)
  // m(P+T)/2 = C either way round — the equality is the point, and it is what
  // makes ONE distance serve both meshes.
  const module = (2 * C) / (cannonPins + minuteTeeth)
  const pin = Math.max(0.1, pinDia)
  return {
    cannonPins, minuteTeeth, minutePins, hourTeeth,
    centreDistanceMM: C,
    module,
    pinDia: pin,
    toothMM: Math.PI * module - pin - Math.max(0, backlash),
    ratio: (minuteTeeth / cannonPins) * (hourTeeth / minutePins),
  }
}

// ─── Emitting the parts ───────────────────────────────────────────────────────

export type ClockPartKey =
  | 'drive' | 'great' | 'second' | 'third' | 'escapement' | 'pendulum'
  // The motion work, present only when it was asked for. Off the great arbor and
  // not in the going train: they change no rate and are on no arbor `clockPlate`
  // walks — see TRAIN_PART_ORDER.
  | 'minute' | 'hour'

/** The going train's WHEELS, great first — the ones `solveTrain` places, one per
 *  mesh. A three-wheel train takes the first two of these and simply has no
 *  third wheel; `TRAIN_PART_ORDER` finds it either way, since it selects by what
 *  is present rather than by a count. The drive wheel and the escapement are not
 *  here: one follows the run time and the other sets the ratio these divide. */
export const TRAIN_WHEEL_KEYS: readonly ClockPartKey[] = ['great', 'second', 'third']

/** …and what each is called, on its chip and in the panel. */
export const TRAIN_WHEEL_NAMES: readonly string[] = ['Great Wheel', 'Second Wheel', 'Third Wheel']

/** The shapes the GOING TRAIN is made of — narrowed so every reader can reach
 *  the tooth counts without re-narrowing the whole ShapeParams union. The
 *  pendulum is deliberately not one of these: it hangs off the anchor and is on
 *  no arbor, so letting it into the type would put it in the mesh chain. */
export type ClockShapeParams = Extract<ShapeParams, { type: 'gear' } | { type: 'escapement' }>

/** …and everything a clock emits, the pendulum included. */
export type ClockPartParams = ClockShapeParams | Extract<ShapeParams, { type: 'pendulum' }>

export interface ClockPart {
  key: ClockPartKey
  /** Chip and group name — "Great Wheel". */
  name: string
  /** Revolutions of this arbor take this many seconds. The escapement's is its
   *  wheel's; the pendulum's is its own period. */
  revSeconds: number
  params: ClockPartParams
}

/** The defaults a clock's parts are built on — the user's own shape defaults,
 *  so a clock inherits whatever bore, hub, spokes and pin diameter they have
 *  already settled on. Only the counts and the module are overridden. */
export type ClockBase = Pick<ShapeToolConfig, 'gear' | 'escapement' | 'pendulum'>

export interface ClockDesign {
  train: TrainSolution
  drive: DriveSolution
  /** Wheels in the going train, great…escape — 3 or 4. */
  trainWheels: 3 | 4
  /** Which way the escape wheel runs, forced by that count so that the minute
   *  hand runs clockwise. At three wheels it is `true` and the escape wheel
   *  turns clockwise with the great wheel; at four it is `false` and they turn
   *  opposite ways. See `escapeClockwiseFor`. */
  escapeClockwise: boolean
  /** Tooth size at every mesh, drive end first — what replaced the one module. */
  modules: ModuleFamily
  pendulumMM: number
  escRevSeconds: number
  /** The hour-hand gearing, when it was asked for. */
  motion: MotionWork | null
  parts: ClockPart[]
}

/**
 * Work out the whole clock and build every part's parameters.
 *
 * Each wheel takes `base.gear` wholesale and overrides exactly four things: the
 * module, its tooth count, the pins of the pinion it drives, and the profile —
 * a clock wheel running a lantern pinion must be cycloidal, since an involute
 * wheel is not conjugate to a pin and its ratio wobbles within every tooth. The
 * escapement takes `base.escapement` and overrides its tooth count, its span,
 * and WHICH WAY IT RUNS — that last because the number of meshes decides it and
 * a wrong one runs the hands backwards (`escapeClockwiseFor`).
 * Everything else — bore, hub, spokes, pin diameter, backlash, markings, the
 * escapement's whole geometry — is the user's default, untouched, and editable
 * per chip afterwards.
 */
export function designClock(spec: ClockSpec, base: ClockBase): ClockDesign {
  const escRev = escapeRevSeconds(spec.beatSeconds, spec.escapeTeeth)
  const wheels = trainWheelsOf(spec)
  const train = solveTrain(trainRatio(spec), spec.minPins, spec.lockedTeeth, wheels - 1)
  const drive = solveDrive(spec, spec.minPins)
  // WHICH WAY THE ESCAPE WHEEL RUNS IS THE WHEEL COUNT'S TO SAY, not the user's
  // Escapement default — see `escapeClockwiseFor`. Every mesh reverses the
  // sense, so the count decides whether the minute hand goes round the right
  // way, and that is a decision about the CLOCK exactly as backlash and pin
  // diameter are. Left to the default, a three-wheel clock would run its hands
  // backwards and every wheel in it would be relieved on its acting flank.
  const escClockwise = escapeClockwiseFor(wheels)

  // Every mesh in the going train, DRIVE END FIRST — which is the order tooth
  // size tapers in, and the order `solveModules` expects.
  const meshChain: Mesh[] = [
    { teeth: drive.teeth, pins: drive.pins },
    ...train.meshes,
  ]
  // A clock designed before per-mesh modules carries `module` and no
  // `maxWheelDia`. Read it as a UNIFORM family at that module — pinning every
  // mesh is exactly what "one module for the whole train" means — so an old
  // project opens cutting what it always cut, rather than being silently
  // resized by a `maxWheelDia` it never had. Same trap as `linkAngles`.
  const legacy = spec.maxWheelDia === undefined && Number.isFinite(spec.module)
  const modules = solveModules(
    meshChain,
    spec.maxWheelDia ?? MAX_WHEEL_DIA,
    legacy ? 1 : (spec.toothTaper ?? MODULE_TAPER),
    {
      pressureAngle: base.gear.pressureAngle,
      backlash: Math.max(0, spec.backlash ?? base.gear.backlash),
      pinDia: Math.max(0.1, spec.pinDia ?? base.gear.pinDia),
      // Absent on a clock designed before there were two, and then every mesh
      // gets the same pin — which is what it was cut with.
      pinDiaFine: Math.max(0.1, spec.pinDiaFine ?? spec.pinDia ?? base.gear.pinDia),
    },
    legacy ? meshChain.map(() => spec.module!) : spec.lockedModules,
  )
  const mod = (i: number) => modules.meshes[i].module

  // Everything the TRAIN forces on a wheel, over the user's own Gear defaults.
  // Backlash and pin diameter are in that list rather than left to the defaults
  // because they are decisions about the CLOCK: every mesh in it runs on the
  // same play, and every lantern is pinned with the same rod — and on a
  // cycloidal wheel the pin diameter shapes the teeth, so wheels disagreeing
  // about it are cut for pins that are not in the clock.
  const pin = (i: number) => modules.meshes[i].pinDia

  // THE DRIVE WHEEL'S HUB IS THE DRUM, so it is the one hub in the clock that may
  // not be grown: the run time was worked out from that diameter, and a hub wider
  // than it puts the cord against the hub instead. `seatHub` treats `hubDia` as a
  // FLOOR and raises it to seat the spokes — right for every other wheel, and
  // exactly backwards here — so the drive wheel gives up SPOKES instead, taking
  // the most it can seat within the drum.
  //
  // It bit as soon as tooth size started tapering. Spokes are `2.5·m` wide and
  // the drive wheel is now the COARSEST mesh in the clock, so its spokes went
  // from 10 mm to 17.5 mm on the default board and the hub floor nearly doubled:
  // at 6 spokes it swallowed the drum outright, which reads as the drum simply no
  // longer being drawn (nothing emits a hub circle of its own — the spoke windows
  // are what makes it visible).
  // `seatHub` takes the largest of three floors — the drum, the stock the arbor
  // needs round it, and what the spokes need to land on — and only the last of
  // those depends on the COUNT. So the rule is: give up spokes until they stop
  // being the binding one. Where the drum is reachable that lands exactly on it;
  // where it is not (a coarse enough wheel needs `HUB_RING · spokeW` round the
  // bore whatever the count) it lands as close as the wheel allows, and the
  // readout says the cord will ride against the hub. Most spokes at that
  // minimum, not fewest — nothing is gained by dropping further.
  // `cyc` because every clock wheel is cycloidal and its root is cut to clear the
  // pin, not to the ISO dedendum — the rim the spokes land on is measured in from
  // that root, so sizing the hub without it sizes it against a different wheel.
  const spokesInDrum = (
    module: number, teeth: number, wanted: number, cyc: { mateTeeth: number; pinDia: number },
  ): number => {
    const drum = Math.max(0, spec.drumDia)
    const bore = base.gear.bore
    const want = Math.max(0, Math.round(wanted))
    if (want < 2) return want
    let best = Infinity
    let pick = want
    for (let n = 2; n <= want; n++) {
      const h = gearHub(module, teeth, bore, drum, n, 0, undefined, undefined, cyc)
      if (!h.spoked) continue
      if (h.dia < best - 0.05) { best = h.dia; pick = n }
      else if (h.dia <= best + 0.05) pick = n          // same hub, more spokes
    }
    return isFinite(best) ? pick : want
  }

  // `pins` is the lantern this wheel DRIVES, on the next arbor; `carries` is the
  // one standing on its OWN arbor, driven by the wheel before it. The wheel is
  // that pinion's near cheek: its pins go through the wheel's hub, which grows
  // to hold them, and the loose cheek emitted by the previous wheel caps the far
  // ends. One part fewer per arbor, and the pins cannot creep round the wheel
  // the way a pinion glued to an arbor can.
  //
  // TWO MODULES REACH A WHEEL, and they are not the same one. `module` is this
  // wheel's OWN mesh — its teeth against the lantern it drives. `carriedModule`
  // belongs to the mesh BEFORE it, because the pins through this wheel's hub are
  // the lantern that the previous wheel drives, and that pin circle is the
  // previous mesh's pitch circle. They were the same number while a clock had one
  // module; with a taper they never are, and using this wheel's own would put the
  // pins on a circle no wheel is cut for.
  //
  // THE PIN COMES WITH THE MESH, exactly as the module does — a clock has two
  // dowel sizes now, and a wheel cut for the fat one will not run on the thin
  // one (a cycloidal face is the epicycloid of the pin circle offset by the pin
  // RADIUS). So `pinDia` is this wheel's own mesh's, and `arborPinDia` — the
  // holes drilled through its hub — is the PREVIOUS mesh's, matching the circle
  // they sit on.
  //
  // Rotation sense per train arbor, off the escapement and alternating back —
  // exactly what `clockPose` runs on, from the one definition.
  // One sense per ARBOR: drive, great, …, escape — `wheels + 1` of them, since
  // the drive wheel is an arbor the going train's wheel count does not include.
  const senses = trainSenses(escClockwise, wheels + 1)
  const sDrive = senses[0]
  const sGreat = senses[1]
  //
  // WHICH FLANK ACTS IS FORCED BY THE TRAIN, and it is the one thing about back
  // relief a wheel cannot be left to decide for itself: every mesh reverses the
  // direction, so half the train turns one way and half the other, and relieving
  // the wrong flank takes the ACTING face off a tooth that still looks like a
  // clock wheel and still turns. `senses[k]` is the same alternation `clockPose`
  // runs, off the escapement, so the drawing and the animation cannot disagree.
  const wheel = (
    module: number, teeth: number, pins: number, pinDia: number,
    actingSense: 1 | -1,
    carries = 0, carriedModule = module, carriedPinDia = pinDia,
  ): ClockShapeParams => ({
    type: 'gear', cx: 0, cy: 0,
    ...base.gear,
    module,
    teeth,
    toothProfile: 'cycloidal',
    mateTeeth: pins,
    actingSense,
    backlash: Math.max(0, spec.backlash ?? base.gear.backlash),
    pinDia,
    emitPinion: true,
    ...(carries >= 2 ? {
      arborPins: carries,
      arborPinCircleDia: carriedModule * carries,
      arborPinDia: carriedPinDia,
    } : {}),
  })

  // Arbor periods, from the escape wheel backwards: each wheel turns its mesh
  // ratio slower than the one it drives. `wheelSec[i]` is the arbor of train
  // wheel *i* (great first); the escape arbor is `escRev` and is not in it.
  const wheelSec: number[] = new Array(train.meshes.length).fill(0)
  for (let i = train.meshes.length - 1; i >= 0; i--) {
    const m = train.meshes[i]
    wheelSec[i] = (wheelSec[i + 1] ?? escRev) * (m.teeth / m.pins)
  }
  const greatActual = wheelSec[0] ?? escRev
  /** The mesh that drives the escape arbor — the last one, whatever the count. */
  const lastMesh = train.meshes[train.meshes.length - 1]

  // The hour hand's gearing, if asked for: two more wheels of the same kind, off
  // the great arbor rather than along the train. Its ratio is 12 whatever the
  // great wheel does, so a great wheel not turning once an hour makes the hour
  // hand wrong — which the readout says, since nothing here can fix it.
  // The motion work hangs off the GREAT ARBOR, so it is cut at the great
  // wheel's own module — mesh 1. It meshes with nothing in the train (the cannon
  // pinion is fixed TO the arbor, not geared to it), so this is a choice rather
  // than a constraint; matching its neighbour is the one that needs no field.
  // Its spacing is a distance now. A clock designed before that says the same
  // thing as `k` against the module it was cut at, which for such a clock is the
  // one module the whole train shared — so `10·k·m` recovers it exactly.
  const motionCentre = spec.motionCentreMM
    ?? (spec.motionSize !== undefined ? 10 * spec.motionSize * mod(1) : MOTION_CENTRE_MM)
  // The SMALL dowel, both meshes. The motion work turns the hands through a
  // cannon-pinion clutch — next to no load — so nothing here wants the fat pin,
  // and its module comes from a clearance distance rather than from strength, so
  // a fat pin would as likely as not be most of the tooth space.
  const motion = spec.motionWork
    ? solveMotionWork(
        motionCentre,
        Math.max(0.1, spec.pinDiaFine ?? spec.pinDia ?? base.gear.pinDia),
        Math.max(0, spec.backlash ?? base.gear.backlash),
      )
    : null

  const parts: ClockPart[] = [
    {
      // Nothing drives the drive wheel but the cord, so its arbor carries no
      // pinion — it is the one wheel in the clock with no pins through its hub.
      // What its hub IS is the drum: the cord winds on that arbor, and cutting
      // the hub to `drumDia` makes the wheel itself the drum's face, so the
      // winding has something to run against and the two cannot disagree about
      // a diameter the RUN TIME was worked out from. A floor like every other
      // hub — `seatHub` still grows it if the spokes need more, which the
      // readout reports, since then the cord would ride against the hub.
      key: 'drive', name: 'Drive Wheel',
      revSeconds: greatActual * (drive.teeth / drive.pins),
      params: {
        ...(wheel(mod(0), drive.teeth, drive.pins, pin(0), sDrive) as Extract<ClockShapeParams, { type: 'gear' }>),
        hubDia: Math.max(0, spec.drumDia),
        spokes: spokesInDrum(mod(0), drive.teeth, base.gear.spokes,
          { mateTeeth: drive.pins, pinDia: pin(0) }),
        // …and drawn as a circle of its own, because it is the DRUM. Nothing
        // else draws it reliably — the spoke windows imply the hub, but only
        // where there is a window, and a solid wheel or a sliver-windowed one
        // leaves no circle at all. It is a diameter the run time was worked out
        // from, so it is worth cutting to rather than inferring.
        hubCircle: true,
      },
    },
    {
      key: 'great', name: 'Great Wheel', revSeconds: greatActual,
      params: wheel(mod(1), train.meshes[0].teeth, train.meshes[0].pins, pin(1), sGreat,
        drive.pins, mod(0), pin(0)),
    },
    // In CLOCK_PART_ORDER position: straight after the wheel whose arbor they
    // hang off. Each is emitted with the lantern it MESHES with, exactly as a
    // train wheel is — the difference is which of the pair drives, which changes
    // nothing about the two parts to be cut.
    ...(motion ? [
      {
        // Its arbor is the stud, and the pinion on it is the one driving the hour
        // wheel — so the minute wheel carries those pins, and the hour wheel's
        // emitted lantern is their cheek.
        // ITS ACTING FLANK IS THE OTHER ONE. The pin DRIVES the wheel here — the
        // only place in a clock where that happens — so the pin bears on the far
        // side of the tooth from a wheel of the same rotation that is driving.
        // The sense handed in is therefore the one `motionPose` hands `gearMesh`,
        // inverted from the wheel's own rotation for exactly the same reason.
        //
        // `drivenByPins` cuts nothing and exists so a READOUT can say which way
        // the wheel turns: with the backs of the teeth cut away these two lean
        // the opposite way from every other wheel in the clock, and reporting the
        // acting flank as a rotation had them named backwards.
        key: 'minute' as const, name: 'Minute Wheel',
        revSeconds: greatActual * (motion.minuteTeeth / motion.cannonPins),
        params: {
          ...(wheel(motion.module, motion.minuteTeeth, motion.cannonPins, motion.pinDia,
            sGreat, motion.minutePins, motion.module, motion.pinDia) as Extract<ClockShapeParams, { type: 'gear' }>),
          drivenByPins: true,
        },
      },
      {
        key: 'hour' as const, name: 'Hour Wheel',
        revSeconds: greatActual * motion.ratio,
        params: {
          ...(wheel(motion.module, motion.hourTeeth, motion.minutePins, motion.pinDia,
            sGreat === 1 ? -1 : 1) as Extract<ClockShapeParams, { type: 'gear' }>),
          drivenByPins: true,
        },
      },
    ] : []),
    // The rest of the going train, one wheel per remaining mesh — the second
    // wheel alone on a three-wheel train, the second and third on a four-wheel
    // one. Written as a walk rather than as a row each because the COUNT is the
    // spec's now: mesh *i* cuts wheel *i*'s teeth, and the pins through its hub
    // belong to mesh *i* − 1, which is the previous wheel's and a different
    // module under a taper.
    ...train.meshes.slice(1).map((m, j) => {
      const i = j + 1
      return {
        key: TRAIN_WHEEL_KEYS[i], name: TRAIN_WHEEL_NAMES[i], revSeconds: wheelSec[i],
        params: wheel(mod(i + 1), m.teeth, m.pins, pin(i + 1), senses[i + 1],
          train.meshes[i - 1].pins, mod(i), pin(i)),
      }
    }),
    {
      key: 'escapement', name: 'Escapement', revSeconds: escRev,
      params: {
        type: 'escapement', cx: 0, cy: 0,
        ...base.escapement,
        teeth: Math.max(6, Math.round(spec.escapeTeeth)),
        // HANDEDNESS IS THE TRAIN'S, not the user's Escapement default: it is
        // what makes the minute hand go round the right way, and at three wheels
        // it also puts the escape wheel clockwise, so a mark on it reads as a
        // seconds hand. See `escapeClockwiseFor`.
        clockwise: escClockwise,
        // It carries the last train wheel's pinion, like every other driven
        // wheel — and it is the one wheel that cannot work the pin circle out
        // for itself, having no module of its own.
        arborPins: lastMesh.pins,
        arborPinCircleDia: mod(train.meshes.length) * lastMesh.pins,
        arborPinDia: pin(train.meshes.length),
      },
    },
    // Last, and on no arbor at all — it hangs from the anchor. Its LENGTH is the
    // whole of it and comes straight back from the beat the clock was designed
    // for; everything else about it (rod width, bob size, the hanging hole) is
    // the user's Pendulum default, untouched, exactly as the wheels take theirs.
    {
      key: 'pendulum', name: 'Pendulum', revSeconds: 2 * Math.max(0.05, spec.beatSeconds),
      params: {
        type: 'pendulum', cx: 0, cy: 0,
        ...base.pendulum,
        length: pendulumLengthMM(spec.beatSeconds),
      },
    },
  ]

  return {
    train, drive, parts, motion, modules,
    trainWheels: wheels,
    escapeClockwise: escClockwise,
    pendulumMM: pendulumLengthMM(spec.beatSeconds),
    escRevSeconds: escRev,
  }
}

// ─── Layout ───────────────────────────────────────────────────────────────────

/**
 * Lay the parts out shelf-packed and CENTRED ON THE STOCK, wrapping downward.
 *
 * Centred rather than run out from a corner because these are big: an m4
 * 48-tooth wheel is 200 mm across against a 300 mm stock, so nearly every part
 * takes a row to itself and a corner-anchored pack comes out as a column hugging
 * one edge and trailing off the bottom. Centred, the block straddles the middle
 * whatever it does not fit.
 *
 * THE PENDULUM IS NOT PACKED WITH THEM — it stands beside the stock. A seconds
 * pendulum is 994 mm of rod against a 300 mm board, so packed in it took a row
 * of its own a metre tall and pushed the entire train off the top of the stock
 * on its way to centring the block: the one part that will never be cut from
 * this board decided where every wheel went. It is not stock-sized furniture
 * and there is nothing to gain by pretending it is, so it is set to the RIGHT
 * of the board, hanging down from the top edge the way it hangs in the clock,
 * and the wheels are then centred on the stock without it.
 *
 * They are placed CLEAR of each other, never at their true centre distances —
 * these are parts to be cut, and two wheels drawn in mesh would overlap on the
 * stock. The spacings a plate is drilled from are reported by the panel instead.
 *
 * Each part is measured from its own emitted geometry rather than from a formula
 * per shape: a gear's bbox includes the pinion drawn beside it and an
 * escapement's includes its anchor, and neither is worth restating here.
 *
 * ORDER IS PRESERVED, including for a part with no geometry — callers index the
 * result against the parts they passed in.
 */
export function layoutClock(
  parts: ClockPart[],
  stock: { widthMM: number; heightMM: number },
  margin: number,
  gap: number,
): ClockPart[] {
  // The stock occupies [0,w]×[0,h] in path space whatever the XY origin says —
  // `originWorldXY` is a display and G-code offset applied on the way out, and
  // subtracting it here would move the whole clock by −origin.
  const centre = { x: stock.widthMM / 2, y: stock.heightMM / 2 }
  const maxWidth = Math.max(50, stock.widthMM - 2 * margin)

  const measured = parts.map((p) => {
    const geo = generateShapeParts(p.params)
    const box = geo ? getMultiBBox(geo.map((g) => g.d)) : null
    return { part: p, box }
  })

  type Item = (typeof measured)[number]
  const packed = measured.filter((m) => m.part.key !== 'pendulum')

  interface Row { items: Item[]; w: number; h: number }
  const rows: Row[] = []
  let row: Row = { items: [], w: 0, h: 0 }

  for (const m of packed) {
    const w = m.box ? m.box.maxX - m.box.minX : 0
    const h = m.box ? m.box.maxY - m.box.minY : 0
    const would = row.items.length === 0 ? w : row.w + gap + w
    if (row.items.length > 0 && would > maxWidth) {
      rows.push(row)
      row = { items: [], w: 0, h: 0 }
    }
    row.w = row.items.length === 0 ? w : row.w + gap + w
    row.h = Math.max(row.h, h)
    row.items.push(m)
  }
  if (row.items.length > 0) rows.push(row)

  const totalH = rows.reduce((t, r) => t + r.h, 0) + gap * Math.max(0, rows.length - 1)
  // Rows stack DOWNWARD from the block's top edge. Centred when the block fits,
  // but a block TALLER than the stock starts at the top edge and trails off the
  // bottom instead of straddling: a row of m4 wheels is 200 mm each on a 300 mm
  // board, so centred, the first row sat entirely ABOVE the stock and the last
  // entirely below it — the arrangement that gets the FEWEST of them onto the
  // board. From the top edge, everything that fits is on it and the rest hangs
  // off one end where it can be seen and dragged.
  let top = Math.min(centre.y + totalH / 2, stock.heightMM - margin)

  // Params are at (0,0); shift so the part's bbox lands where we want it.
  // `translateShapeParams` preserves the variant it is handed — its return type
  // just cannot say so.
  const placed = new Map<ClockPart, ClockPart>()
  for (const r of rows) {
    let x = centre.x - r.w / 2
    for (const { part, box } of r.items) {
      if (!box) continue
      const moved = translateShapeParams(part.params, x - box.minX, top - box.maxY) as ClockPartParams
      placed.set(part, { ...part, params: moved })
      x += (box.maxX - box.minX) + gap
    }
    top -= r.h + gap
  }

  // Beside the board, hanging from the height of its top edge — which is where a
  // pendulum hangs, and keeps its bob down near the wheels rather than a metre
  // above them.
  let asideX = stock.widthMM + margin
  for (const m of measured) {
    if (m.part.key !== 'pendulum' || !m.box) continue
    const moved = translateShapeParams(
      m.part.params, asideX - m.box.minX, stock.heightMM - m.box.maxY,
    ) as ClockPartParams
    placed.set(m.part, { ...m.part, params: moved })
    asideX += (m.box.maxX - m.box.minX) + gap
  }

  return parts.map((p) => placed.get(p) ?? p)
}

// ─── Assembled: where the arbors go, and where everything stands ──────────────
//
// The parts are drawn CLEAR of each other on the stock, which leaves the one
// question a drawing of loose wheels cannot answer: assembled, does the train
// run? `clockPlate` puts the arbors at their true spacings and `clockPose`
// turns everything from the escapement's own kinematics, which is what the
// canvas preview (canvas/layers/ClockAnimLayer.tsx) draws.
//
// TWO THINGS ARE TRUE OF THIS AND EASY TO GET WRONG.
//
// (1) Only the DISTANCES between arbors are forced — the directions are the
//     plate designer's choice, since a mesh only cares that the pitch circles
//     are tangent. So the angles are the USER'S (`ClockSpec.linkAngles`, dragged
//     on the canvas), and `defaultLinkAngles` is only where a clock starts.
//
//     THE CHAIN IS ROOTED AT THE ESCAPE ARBOR and walks BACKWARDS from it to the
//     drive wheel. That is not a convenience. The anchor sits +y from the escape
//     wheel in the escapement's own frame and the pendulum hangs from the anchor,
//     so rooting anywhere else would let a link angle tip the escapement — the
//     anchor would stop being above its wheel and the pendulum would hang
//     sideways, which means rotating the escapement's whole drawn frame and
//     re-checking `escapementPose`. Rooted here, none of that geometry moves at
//     all. It is also how a movement is really laid out: the pendulum defines the
//     vertical, the escapement is fixed to it, and the train is arranged round it.
//
// (2) SUCCESSIVE WHEELS OVERLAP IN PLAN VIEW, and that is correct, not a bug to
//     lay out around. The great wheel's radius plus the second wheel's is 200 mm
//     against a 120 mm centre distance: they cannot help but overlap, because in
//     a real movement each wheel meshes with the NEXT ARBOR'S PINION and the two
//     wheels sit at different depths between the plates. Trying to separate them
//     would mean lying about the spacings. It is the same fact `gearMateParts`
//     handles by drawing a lantern's cheek dashed — the preview draws the wheels
//     translucent and in different hues for the same reason.

/**
 * The least a caller needs to stand a clock up: the parts in TRAIN ORDER with
 * their current parameters. `designClock`'s output satisfies it (less the
 * pendulum, which is on no arbor), and so does a set of live paths gathered back
 * out of the document by their `clockId` — which is the point, since by then each
 * wheel has been edited on its own and the assembly must be read from what is
 * actually there rather than from the spec it came from.
 */
export type ClockAssembly = { key: ClockPartKey; params: ClockShapeParams }[]

/** A gear's parameters, narrowed — the motion work is two of them. */
export type ClockGearParams = Extract<ShapeParams, { type: 'gear' }>

/**
 * The motion work as an assembly: the two wheels, read back out of the document
 * the same way the train is.
 *
 * Separate from `ClockAssembly` because it is a BRANCH, not more of the chain —
 * letting it into the train's array would put its wheels on arbors of their own
 * and `clockPose` would gear the escapement through them. Both wheels or
 * nothing: one of them alone cannot be stood up, since the pair is what fixes
 * the intermediate arbor.
 */
export interface ClockMotion {
  /** On the intermediate arbor, driven by the cannon pinion. */
  minute: ClockGearParams
  /** Back on the minute arbor, driven by the pinion beside the minute wheel. */
  hour: ClockGearParams
}

export interface ClockArbor {
  /** Which part's WHEEL sits on this arbor. The pinion on it (for every arbor
   *  but the first) was emitted by the part BEFORE it. */
  key: ClockPartKey
  x: number
  y: number
  /** Radius of the wheel on this arbor — its tips, for extent and for drawing. */
  wheelRadius: number
  /** Direction to the next arbor, radians CCW from +x. Meaningless on the last. */
  toNext: number
  /** Distance to the next arbor: this wheel's pitch radius plus its pinion's,
   *  which is where the two pitch circles come tangent. 0 on the last. */
  centreDistance: number
}

/** Where the motion work stands, when the clock has one. */
export interface ClockPlateMotion {
  /** Index in `arbors` of the arbor it hangs off — the great wheel's, which is
   *  the minute arbor. The HOUR WHEEL sits on that same arbor, concentric with
   *  it, so it has no position of its own. */
  hostIdx: number
  /** The intermediate arbor, carrying the minute wheel and its pinion. */
  x: number
  y: number
  /** Host to intermediate. ONE distance: both meshes run at it (see
   *  `solveMotionWork`), and it is taken from the MINUTE wheel — if a hand edit
   *  has left the hour wheel wanting a different one, the drawing shows that
   *  mesh standing off rather than quietly splitting the difference. */
  centreDistance: number
  minuteRadius: number
  hourRadius: number
}

export interface ClockPlate {
  /** drive, great, second, third, escape — the going train, in order. */
  arbors: ClockArbor[]
  /** The hour hand's gearing, if the clock has any. */
  motion: ClockPlateMotion | null
  /** The pallet arbor, straight above the escape wheel at the escapement's own
   *  centre distance (which is how the escapement generator lays it out). */
  anchor: { x: number; y: number }
  /** Everything the assembly occupies, for centring it on the canvas. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
}

/**
 * Stand the train up, with the ESCAPE ARBOR AT THE ORIGIN and everything walked
 * back from it to the drive wheel. `clockRoot` says where that origin goes on
 * the stock; nothing here knows about the stock at all.
 *
 * `angles` are `ClockSpec.linkAngles` — link *i* runs from arbor *i* to arbor
 * *i+1*. Omitted or short, it defaults per element (see `linkAngleAt`).
 */
export function clockPlate(parts: ClockAssembly, angles?: number[], motionParts?: ClockMotion | null): ClockPlate | null {
  if (parts.length < 2) return null
  const n = parts.length

  // Each arbor's wheel radius, and the distance to the NEXT arbor — a property
  // of the gear on this one (its pitch radius plus its pinion's, where the two
  // pitch circles come tangent). The escape wheel ends the train: what follows
  // it is the anchor, not another arbor.
  const radius: number[] = []
  const dist: number[] = []
  for (let i = 0; i < n; i++) {
    const p = parts[i]
    if (p.params.type === 'gear') {
      const g = p.params
      const dims = gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, { mateTeeth: g.mateTeeth, pinDia: g.pinDia })
      radius.push(dims.outsideDia / 2)
      dist.push(i === n - 1 ? 0 : (pinionDims(g)?.centreDistance ?? 0))
    } else {
      // Plus the tip round: an escape wheel's material stands one round outside
      // the circle `wheelDia` names, which is where the tips ACT. This radius is
      // what the fouling checks and the plate's own span are measured with, so it
      // wants the material.
      radius.push(p.params.wheelDia / 2 + escapementDims(p.params).tipRound)
      dist.push(0)
    }
  }

  // Backwards from the escape arbor at (0,0).
  const xs = new Array<number>(n).fill(0)
  const ys = new Array<number>(n).fill(0)
  for (let k = n - 2; k >= 0; k--) {
    const th = linkAngleAt(angles, k)
    xs[k] = xs[k + 1] - dist[k] * Math.cos(th)
    ys[k] = ys[k + 1] - dist[k] * Math.sin(th)
  }

  const arbors: ClockArbor[] = parts.map((p, i) => ({
    key: p.key,
    x: xs[i], y: ys[i],
    wheelRadius: radius[i],
    // The last arbor has no next; +y is where its anchor goes.
    toNext: i === n - 1 ? Math.PI / 2 : linkAngleAt(angles, i),
    centreDistance: dist[i],
  }))

  const escPart = parts[n - 1]
  const escArbor = arbors[n - 1]
  const anchorGap = escPart.params.type === 'escapement' ? escapementDims(escPart.params).centreDistance : 0
  const anchor = { x: escArbor.x, y: escArbor.y + anchorGap }

  // The motion work hangs off the GREAT arbor — the minute arbor — at an angle
  // that is the user's, like every other link. Its own wheel is on the host
  // arbor itself, so only the intermediate one has to be placed.
  let motion: ClockPlateMotion | null = null
  const hostIdx = parts.findIndex((p) => p.key === 'great')
  if (motionParts && hostIdx >= 0) {
    const host = arbors[hostIdx]
    const th = linkAngleAt(angles, MOTION_LINK)
    const cd = pinionDims(motionParts.minute)?.centreDistance ?? 0
    const rOf = (g: ClockGearParams) =>
      gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, { mateTeeth: g.mateTeeth, pinDia: g.pinDia })
        .outsideDia / 2
    motion = {
      hostIdx,
      x: host.x + cd * Math.cos(th),
      y: host.y + cd * Math.sin(th),
      centreDistance: cd,
      minuteRadius: rOf(motionParts.minute),
      hourRadius: rOf(motionParts.hour),
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const span = (x: number, y: number, r: number) => {
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r)
    minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r)
  }
  for (const a of arbors) span(a.x, a.y, a.wheelRadius)
  if (motion) {
    span(motion.x, motion.y, motion.minuteRadius)
    span(arbors[motion.hostIdx].x, arbors[motion.hostIdx].y, motion.hourRadius)
  }
  // The anchor's arms reach back over the wheel, so its own arbor is the only
  // point past the wheel that has to be counted.
  maxY = Math.max(maxY, anchor.y)
  return { arbors, anchor, motion, bbox: { minX, minY, maxX, maxY } }
}

/**
 * The angle that swings joint `nodeIdx` as near the cursor as its link allows.
 *
 * The LENGTH is not negotiable — it is the centre distance that mesh runs at —
 * so the joint rides a circle about the arbor it hangs from, and only the angle
 * is free. That arbor is the NEXT one along, toward the escapement, because the
 * chain is rooted there: link *k* runs from arbor *k* to arbor *k+1*, so
 * `angles[k]` is the direction from the dragged joint towards its parent, i.e.
 * `atan2(parent − cursor)` and not the other way round.
 *
 * Writing `angles[k]` alone is the whole of the drag: everything toward the
 * drive wheel is built off this joint with its own angles intact and so
 * translates rigidly, and everything toward the escapement does not move at all.
 *
 * `plate` is in its own frame with the escape arbor at the origin; `root` is
 * where that origin sits, so the cursor can be passed in plain path coordinates.
 * Returns degrees, snapped if asked.
 */
export function dragLinkAngle(
  plate: ClockPlate,
  root: { x: number; y: number },
  nodeIdx: number,
  cursor: { x: number; y: number },
  snapDeg = 0,
): number | null {
  // THE MOTION BRANCH IS MEASURED THE OTHER WAY ROUND. Along the train the
  // dragged joint is the CHILD's arbor and its parent is the next one toward the
  // escapement, so the angle wanted is from the joint to the parent. The motion
  // arbor hangs off a great arbor that is itself fixed by the chain, so here the
  // parent is the anchor point and the angle runs from IT to the cursor.
  if (nodeIdx === MOTION_LINK) {
    const m = plate.motion
    if (!m) return null
    const host = plate.arbors[m.hostIdx]
    const hx = root.x + host.x, hy = root.y + host.y
    if (Math.abs(hx - cursor.x) < 1e-9 && Math.abs(hy - cursor.y) < 1e-9) return null
    const deg = (Math.atan2(cursor.y - hy, cursor.x - hx) * 180) / Math.PI
    return snapDeg > 0 ? Math.round(deg / snapDeg) * snapDeg : deg
  }
  const parent = plate.arbors[nodeIdx + 1]
  if (!parent) return null              // the root itself, or off the end
  const fx = root.x + parent.x, fy = root.y + parent.y
  // Degenerate only if the cursor is exactly on the parent arbor, where every
  // angle is equally good — hold the current one rather than snapping to 0.
  if (Math.abs(fx - cursor.x) < 1e-9 && Math.abs(fy - cursor.y) < 1e-9) return null
  const deg = (Math.atan2(fy - cursor.y, fx - cursor.x) * 180) / Math.PI
  return snapDeg > 0 ? Math.round(deg / snapDeg) * snapDeg : deg
}

/** An arbor running through the space a wheel turns in. `depth` is how far
 *  inside that wheel's tip circle it falls. */
export interface ClockArborClash {
  arbor: ClockPartKey | 'motion' | 'anchor'
  wheel: ClockPartKey | 'minute' | 'hour'
  depthMM: number
}

/**
 * Arbors that pass through a wheel they do not belong to — which is fatal,
 * unlike two wheels overlapping.
 *
 * THE DIFFERENCE IS DEPTH. Wheels a mesh apart always overlap in plan view and
 * are meant to: each meshes with the NEXT arbor's pinion, and the two sit at
 * different depths along their arbors, so the outlines cross and the material
 * never does (`clockWheelClashes` ignores neighbours for exactly this reason).
 * An ARBOR is not at a depth — it is a rod running the whole way from plate to
 * plate, so it sweeps every depth, and a wheel whose tip circle contains one has
 * nowhere to turn.
 *
 * A normal train never trips it, and the reason is worth knowing: the centre
 * distance is the wheel's pitch radius plus its pinion's, while the wheel
 * reaches one addendum past its pitch circle — so it clears the next arbor by
 * `m·(pins/2 − 1)`, which is 20 mm for a 12-pin m4 pinion and shrinks as the
 * pinion does. Folding the linkage tight is what breaks it.
 *
 * TWO SPACES, NOT ONE. The going train runs between the plates; the motion work
 * runs in FRONT of the front plate, its stud fixed to that plate and the hour
 * wheel on a tube over the minute arbor. So the stud landing inside the great
 * wheel is not a clash — they are on opposite sides of the plate, the same way
 * neighbouring wheels are at different depths — and only bodies sharing a space
 * are compared. In front there are just two shafts: the stud, and the minute
 * arbor coming through to carry the cannon pinion.
 */
export function clockArborClashes(plate: ClockPlate): ClockArborClash[] {
  const out: ClockArborClash[] = []
  const a = plate.arbors
  const test = (
    arbor: ClockArborClash['arbor'], ax: number, ay: number,
    wheel: ClockArborClash['wheel'], wx: number, wy: number, r: number,
  ) => {
    const d = Math.hypot(ax - wx, ay - wy)
    if (d < r) out.push({ arbor, wheel, depthMM: r - d })
  }

  // Between the plates: every arbor against every wheel but its own, the PALLET
  // arbor included — it is a rod like the others, and folding a train tight can
  // bring a wheel over it. Its own escape wheel is exempt: the anchor is placed
  // where the tangents to the tip circle cross, so it always stands outside it,
  // and the pallets sweeping that wheel is the whole point of an escapement.
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length; j++) {
      if (i === j) continue
      test(a[j].key, a[j].x, a[j].y, a[i].key, a[i].x, a[i].y, a[i].wheelRadius)
    }
    if (i < a.length - 1) {
      test('anchor', plate.anchor.x, plate.anchor.y, a[i].key, a[i].x, a[i].y, a[i].wheelRadius)
    }
  }

  // In front of it: the minute wheel must clear the minute arbor it is driven
  // from, and the hour wheel must clear the stud the minute wheel turns on.
  // Both hold by construction at any sane size — they are here because a wheel
  // edited by hand can break them, and nothing else would say so.
  const m = plate.motion
  if (m) {
    const host = a[m.hostIdx]
    test(host.key, host.x, host.y, 'minute', m.x, m.y, m.minuteRadius)
    test('motion', m.x, m.y, 'hour', host.x, host.y, m.hourRadius)
  }
  return out
}

/**
 * Pairs of wheels that collide, ignoring neighbours.
 *
 * SUCCESSIVE wheels overlap by design — each meshes with the next arbor's pinion
 * and the two sit at different depths between the plates — so a neighbour
 * overlap is not a fault and is never reported. Two wheels that are NOT
 * neighbours have no reason to share space, though: fold a train far enough and
 * the drive wheel lands on the third, which is a real collision and the thing a
 * maker needs telling about while arranging.
 *
 * A warning, not a block. It is the user's frame, and they may be planning to
 * put those two on different plates.
 */
export function clockWheelClashes(plate: ClockPlate): [number, number][] {
  const out: [number, number][] = []
  const a = plate.arbors
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 2; j < a.length; j++) {
      if (Math.hypot(a[j].x - a[i].x, a[j].y - a[i].y) < a[i].wheelRadius + a[j].wheelRadius) {
        out.push([i, j])
      }
    }
  }
  return out
}

/** Stock left above the escapement. */
const ROOT_MARGIN = 10

/**
 * Where the escape arbor goes on the stock — and it NEVER moves.
 *
 * There is no centring here, at any point: not on entry to a mode, not on
 * commit, not per frame. Centring the assembly's bounding box (which the preview
 * used to do) makes the whole clock slide under the cursor while the user
 * arranges it, because the box changes with the arrangement. Instead:
 *
 *   • X — centred on the stock.
 *   • Y — at the TOP, the escapement's own extent sitting a margin below `h`.
 *     That is where a movement's escapement really is, with the pendulum hanging
 *     below through the frame.
 *
 * It is a pure function of the stock and the ESCAPEMENT ALONE, so it cannot
 * depend on the arrangement and therefore cannot drift as the user drags. Both
 * the preview and the linkage editor call it, so they cannot disagree about
 * where the clock is.
 *
 * Note the stock is `[0,w]×[0,h]` in path space whatever the XY origin says —
 * `originWorldXY` is a DISPLAY and G-code offset and must not appear here. That
 * mistake moved the whole clock by −origin once already.
 *
 * It generates the escapement to measure it, so keep it inside a memo.
 */
export function clockRoot(
  stockW: number,
  stockH: number,
  esc: ClockShapeParams | undefined,
): { x: number; y: number } {
  let top = 0
  if (esc?.type === 'escapement') {
    const geo = generateShapeParts({ ...esc, cx: 0, cy: 0 })
    const box = geo ? getMultiBBox(geo.map((g) => g.d)) : null
    if (box) top = Math.max(0, box.maxY)
  }
  return { x: stockW / 2, y: stockH - ROOT_MARGIN - top }
}

export interface ClockPose {
  /** Wheel rotation on each arbor, degrees CCW, index-matched to `plate.arbors`. */
  wheelDeg: number[]
  /** The lantern pinion standing on each arbor — the one the PREVIOUS wheel
   *  drives. Index 0 is meaningless: nothing drives the drive wheel but the cord. */
  pinionDeg: number[]
  /** The pallets, about the anchor arbor. */
  anchorDeg: number
  /** The motion work, when the clock has one. */
  motion: ClockPoseMotion | null
}

export interface ClockPoseMotion {
  /** The minute wheel AND the pinion beside it — one body on the intermediate
   *  arbor, so one angle (their relative clocking is free, as everywhere else a
   *  wheel and a pinion share an arbor). */
  minuteDeg: number
  /** The hour wheel, about the host arbor it is concentric with. */
  hourDeg: number
  /** The cannon pinion, on that same host arbor — FIXED to it in a real clock
   *  through the friction clutch, so it simply turns with the great wheel. */
  cannonDeg: number
}

/**
 * Where everything stands at a given moment. `phase` counts escapement PERIODS
 * and runs past 1 — the wheel advances one tooth per period and nothing resets.
 *
 * THE ESCAPEMENT IS THE MASTER, and the chain is solved BACKWARDS from it. That
 * is not a convenience: the escapement is the only part of a clock with any
 * kinematics of its own (impulse, drop, lock — see `escapementPose`), and every
 * other arbor is rigidly geared to it. Driving the train forwards and hoping the
 * escape wheel came out where the escapement wanted it would be two answers to
 * one question.
 *
 * THE PHASE OF EACH MESH IS THE WHOLE OF IT AND IT FAILS SILENTLY — get it wrong
 * and nothing errors, the preview just draws pins through teeth. `gearMesh`
 * already solves it for a mate lying along +x; here the mate lies along θ, so
 * the whole two-body assembly is rotated by θ about the wheel's centre, which
 * turns BOTH bodies by θ as well as moving the mate. Hence the θ terms:
 *
 *     pinion = matePhase + θ − (wheel − θ)·ratio
 *
 * which is `gearPose` exactly when θ = 0. Solved the other way round here,
 * because it is the pinion angle that is known and the wheel behind it that is
 * wanted. Proven against the emitted outlines by scripts/clock-mesh-check.mts.
 *
 * Where a wheel and a pinion share an arbor their relative clocking is FREE —
 * a maker glues the lantern on at any angle — so it is taken as zero. Nothing
 * downstream may assume otherwise.
 *
 * EVERY WHEEL TURNS THE OTHER WAY FROM THE ONE IT DRIVES, and each mesh's play
 * has to be taken up on the flank ITS OWN wheel is pushing — so the sense
 * alternates back along the chain from the escape wheel and is handed to
 * `gearMesh`. Its default is a gear running CCW, which is right for half the
 * train and backwards for the other half: the drive shows as slop ahead of the
 * pin instead of behind it, which reads as the pinion driving the wheel. Nothing
 * errors, and no clearance check can see it — the pair runs cleanly either way,
 * it is simply resting on the wrong side of its play.
 */
export function clockPose(
  parts: ClockAssembly,
  plate: ClockPlate,
  phase: number,
  motionParts?: ClockMotion | null,
): ClockPose {
  const n = plate.arbors.length
  const wheelDeg = new Array<number>(n).fill(0)
  const pinionDeg = new Array<number>(n).fill(0)

  const escPart = parts[n - 1]
  const esc = escPart.params.type === 'escapement' ? escapementPose(escPart.params, phase) : { wheelDeg: 0, anchorDeg: 0 }
  wheelDeg[n - 1] = esc.wheelDeg
  // The escape pinion, clocked with the escape wheel (free choice, see above).
  pinionDeg[n - 1] = esc.wheelDeg

  const senses = trainSenses(escPart.params.type === 'escapement' && escPart.params.clockwise === true, n)

  for (let k = n - 2; k >= 0; k--) {
    const p = parts[k]
    if (p.params.type !== 'gear') continue
    // The wheel's OWN `actingSense` in preference to the alternation, because the
    // two are the same fact and must not be able to disagree: it is the flank the
    // play is taken up on AND the flank the teeth were cut to act with. It is
    // stamped from `trainSenses` at design time, so this is the same number — but
    // a wheel edited on its own, or one out of an older file, states its own.
    const mesh = gearMesh(p.params, p.params.actingSense ?? senses[k])
    const th = (plate.arbors[k].toNext * 180) / Math.PI
    wheelDeg[k] = th + (mesh.matePhaseDeg + th - pinionDeg[k + 1]) / mesh.ratio
    pinionDeg[k] = wheelDeg[k]
  }

  return {
    wheelDeg, pinionDeg, anchorDeg: esc.anchorDeg,
    motion: motionPose(motionParts, plate, wheelDeg, senses),
  }
}

/**
 * The motion work's two bodies, solved off the great wheel.
 *
 * Same solve as a train mesh and the same trap: the phase is the whole of it and
 * a wrong one draws pins through teeth without erroring. `gearMesh` puts the
 * mate along +x, so each mesh is turned by the angle it really lies at — from
 * the WHEEL to its mate, which for the minute wheel is back towards the host
 * arbor (θ + 180°) and for the hour wheel is out along the branch (θ).
 *
 * TWO THINGS ARE BACKWARDS HERE COMPARED WITH THE TRAIN, and both follow from
 * the pinion being the driver:
 *
 *   • the KNOWN angle is the mate's, not the wheel's, for both meshes — the
 *     cannon pinion is fixed to the great arbor and the minute pinion is fixed
 *     to the minute wheel — which is the same inversion `clockPose` already does
 *     along the train, so the formula is the same one;
 *   • the SETTLE is inverted (`-sense`). `gearMesh` shifts the mate onto the
 *     flank the GEAR is pushing; here the mate pushes the gear, so the play is
 *     taken up on the other side. Nothing errors either way — it is the same
 *     silent "reads as the pinion driving the wheel" as along the train, except
 *     that here the pinion really is driving.
 */
function motionPose(
  motionParts: ClockMotion | null | undefined,
  plate: ClockPlate,
  wheelDeg: number[],
  senses: (1 | -1)[],
): ClockPoseMotion | null {
  const m = plate.motion
  if (!motionParts || !m) return null

  // The cannon pinion turns WITH the great wheel — it is fixed to that arbor
  // through the clutch that lets the hands be set.
  const cannonDeg = wheelDeg[m.hostIdx]
  const hostSense = senses[m.hostIdx]
  const th = (Math.atan2(m.y - plate.arbors[m.hostIdx].y, m.x - plate.arbors[m.hostIdx].x) * 180) / Math.PI

  // Minute wheel: on the intermediate arbor, its mate (the cannon pinion) lying
  // back along the branch. Driven, so it turns against the great wheel.
  const minuteSense: 1 | -1 = hostSense === 1 ? -1 : 1
  const mm = gearMesh(motionParts.minute, motionParts.minute.actingSense ?? (minuteSense === 1 ? -1 : 1))
  const thMinute = th + 180
  const minuteDeg = thMinute + (mm.matePhaseDeg + thMinute - cannonDeg) / mm.ratio

  // Hour wheel: back on the host arbor, its mate (the pinion beside the minute
  // wheel, clocked with it) out along the branch. Turns with the great wheel
  // again, which is why both hands go round the same way.
  const hm = gearMesh(motionParts.hour, motionParts.hour.actingSense ?? (hostSense === 1 ? -1 : 1))
  const hourDeg = th + (hm.matePhaseDeg + th - minuteDeg) / hm.ratio

  return { minuteDeg, hourDeg, cannonDeg }
}

/** Emission order — everything a clock CAN be cut from. The motion work is in
 *  it only when the spec asks for it, so compare against `designClock`'s output
 *  rather than assuming the whole list. It sits straight after the great wheel
 *  because that is the arbor it hangs off. */
export const CLOCK_PART_ORDER: ClockPartKey[] =
  ['drive', 'great', 'minute', 'hour', 'second', 'third', 'escapement', 'pendulum']

/** …and the subset that is the GOING TRAIN, arbor by arbor. The pendulum is on
 *  no arbor, so it is not here: `clockPlate` would try to mesh it. */
export const TRAIN_PART_ORDER: ClockPartKey[] = ['drive', 'great', 'second', 'third', 'escapement']

/**
 * Which way each train arbor turns, CCW positive, taken off the escape wheel and
 * alternated back down the chain — every external mesh reverses it.
 *
 * `escapementPose` runs a CLOCKWISE wheel through falling angles, which is where
 * the −1 comes from. One definition because two things now need it and they must
 * not disagree: `clockPose` takes up each mesh's play on the flank its own wheel
 * is pushing, and `designClock` CUTS the teeth to it — a cycloidal tooth with
 * back relief acts on one flank only, so a wheel handed the wrong sense has its
 * acting face taken off and nothing errors.
 */
export function trainSenses(escClockwise: boolean, n = TRAIN_PART_ORDER.length): (1 | -1)[] {
  const senses = new Array<1 | -1>(Math.max(1, n)).fill(1)
  let sense: 1 | -1 = escClockwise ? -1 : 1
  senses[senses.length - 1] = sense
  for (let k = senses.length - 2; k >= 0; k--) {
    sense = sense === 1 ? -1 : 1
    senses[k] = sense
  }
  return senses
}

/**
 * Gather a clock back out of the document.
 *
 * The wheels are ordinary independent shapes once emitted — several paths
 * each, all carrying the same `shapeParams` — so this takes the FIRST path of
 * each `clockPart` and reads its current parameters. Which means the assembly
 * reflects every edit made to a wheel since, including edits that break the
 * train; that is the honest answer, and the preview showing a broken mesh is
 * more use than one showing the clock as designed.
 *
 * Returns the parts in train order, dropping any whose paths have been deleted —
 * a caller must handle a short list rather than assume the full train.
 */
export function clockAssemblyFromPaths(
  paths: { clockId?: string; clockPart?: string; shapeParams?: ShapeParams }[],
  clockId: string,
): ClockAssembly {
  const out: ClockAssembly = []
  for (const key of TRAIN_PART_ORDER) {
    const hit = paths.find((p) =>
      p.clockId === clockId && p.clockPart === key &&
      (p.shapeParams?.type === 'gear' || p.shapeParams?.type === 'escapement'))
    if (hit) out.push({ key, params: hit.shapeParams as ClockShapeParams })
  }
  return out
}

/**
 * The motion work, from the same paths — BOTH wheels or nothing.
 *
 * One of them alone cannot be stood up: the intermediate arbor is where the two
 * meshes agree, so a clock with only its hour wheel left has nowhere to put it.
 */
export function clockMotionFromPaths(
  paths: { clockId?: string; clockPart?: string; shapeParams?: ShapeParams }[],
  clockId: string,
): ClockMotion | null {
  const of = (key: ClockPartKey) => {
    const hit = paths.find((p) =>
      p.clockId === clockId && p.clockPart === key && p.shapeParams?.type === 'gear')
    return hit ? (hit.shapeParams as ClockGearParams) : null
  }
  const minute = of('minute'), hour = of('hour')
  return minute && hour ? { minute, hour } : null
}

/**
 * The clock's pendulum, from the same paths.
 *
 * Separate from `clockAssemblyFromPaths` because a pendulum is on NO ARBOR — it
 * hangs from the pallet arbor — so letting it into the assembly would put it in
 * the mesh chain that `clockPlate` walks.
 */
export function clockPendulumFromPaths(
  paths: { clockId?: string; clockPart?: string; shapeParams?: ShapeParams }[],
  clockId: string,
): Extract<ShapeParams, { type: 'pendulum' }> | null {
  const hit = paths.find((p) =>
    p.clockId === clockId && p.clockPart === 'pendulum' && p.shapeParams?.type === 'pendulum')
  return hit ? (hit.shapeParams as Extract<ShapeParams, { type: 'pendulum' }>) : null
}

/** The going-train WHEEL that cuts each mesh, drive end first — the order
 *  `solveModules` returns and the order `ClockSpec.lockedModules` is indexed in.
 *  A three-wheel train uses the first three. The escapement is not here: its
 *  wheel is cut by the mesh BEFORE it and has no module of its own. */
export const MESH_WHEEL_KEYS: readonly ClockPartKey[] = ['drive', 'great', 'second', 'third']

/** How far two tooth sizes — or two arbor spacings — may differ and still be the
 *  same number, mm. Only guards float: anything anyone TYPES differs by orders
 *  of magnitude more. */
const SAME_MM = 1e-6

/**
 * The spec a clock's wheels ACTUALLY are, given the spec they were cut from.
 *
 * A wheel is an ordinary shape once emitted, so its module can be re-typed on
 * its own chip — and nothing carried that back to the clock. The designer went
 * on reporting the tooth size it had solved for, so the arbor spacings in the
 * readout were the ones the plate WAS drilled to rather than the ones it now
 * needs, and the next Update quietly cut the wheel back to the old module.
 *
 * TYPING IS LOCKING, exactly as it is for a tooth count (see `TeethRow`): a
 * module someone has typed on a wheel is a module they want kept, so it comes
 * back as a HELD mesh. Holding it is not merely bookkeeping — the pins it runs
 * against are on the NEXT wheel's hub, cut to this mesh's module, so a wheel
 * re-cut alone meshes with nothing until the clock is rebuilt around it.
 *
 * The MOTION WORK comes back as a distance instead — see below; it is the same
 * fact, stated in the one term its spec keeps.
 *
 * Only a wheel that differs is held: an untouched clock reconciles to its own
 * spec unchanged, so "Max wheel Ø" goes on resizing the family.
 */
export function holdCutModules(
  spec: ClockSpec, base: ClockBase, parts: ClockAssembly, motion?: ClockMotion | null,
): ClockSpec {
  if (parts.length === 0 && !motion) return spec
  const design = designClock(spec, base)
  const designed = design.modules.meshes
  const was = (i: number) => spec.lockedModules?.[i] ?? null
  // A LEGACY clock is read as a uniform family at its one `module` and its
  // `lockedModules` are never consulted (see `designClock`), so holding one mesh
  // there would change nothing at all. It gives up the legacy field instead and
  // holds EVERY mesh at what it is cut to — which is the same clock, since one
  // module throughout is what "uniform family" already meant, and a fully held
  // family has no fit left for `maxWheelDia` to bind.
  const legacy = spec.maxWheelDia === undefined && Number.isFinite(spec.module)
  const cutAt = (i: number): number | null => {
    const p = parts.find((q) => q.key === MESH_WHEEL_KEYS[i])?.params
    if (!p || p.type !== 'gear' || !Number.isFinite(p.module) || p.module <= 0) return null
    return Math.abs(p.module - designed[i].module) > SAME_MM ? p.module : null
  }
  const cut = designed.map((_, i) => cutAt(i))

  // THE MOTION WORK'S ONE FREE NUMBER IS ITS ARBOR SPACING, so a wheel re-cut
  // there comes back as a DISTANCE rather than as a held module. Its counts are
  // fixed at the classic 10/30 and 8/32 and `C = m(P+T)/2`, so the spacing and
  // the module are the same fact stated two ways — and the spacing is the term
  // the spec keeps, the one both meshes must agree about, and the one the plate
  // is drilled from. `pinionDims().centreDistance` IS that arithmetic (pitch
  // radius + the lantern's), so it inverts `solveMotionWork` without repeating
  // its counts.
  //
  // It is also the ONLY handle these two wheels have: neither's size is offered
  // anywhere but its own chip's module, which is why re-typing that is what a
  // maker reaches for — and why leaving it uncarried was worse here than on the
  // train, where "Max wheel Ø" at least asks the question.
  //
  // The MINUTE wheel decides, being the one `clockPlate` measures the branch
  // from; the hour wheel is asked only when the minute wheel still agrees with
  // the design, so that editing either one alone is taken up.
  const motionCut = ((): number | null => {
    if (!motion || !design.motion) return null
    for (const g of [motion.minute, motion.hour]) {
      const c = pinionDims(g)?.centreDistance
      if (c !== undefined && Number.isFinite(c) && c > 0
        && Math.abs(c - design.motion.centreDistanceMM) > SAME_MM) return c
    }
    return null
  })()

  if (cut.every((m) => m === null) && motionCut === null) return spec
  // `motionSize` is left alone: it is read only to RECOVER a spacing for a clock
  // that has none, and a spacing set here takes precedence over it.
  const next: ClockSpec = motionCut === null ? spec : { ...spec, motionCentreMM: motionCut }
  if (cut.every((m) => m === null)) return next
  if (legacy) return {
    ...next,
    module: undefined,
    maxWheelDia: MAX_WHEEL_DIA,
    lockedModules: designed.map((m, i) => cut[i] ?? m.module),
  }
  const held = designed.map((_, i) => cut[i] ?? was(i))
  return { ...next, lockedModules: held.some((m) => m !== null) ? held : undefined }
}
