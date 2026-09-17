// ─── Involute spur gear ───────────────────────────────────────────────────────
//
// A real involute gear, not a rounded-tooth lookalike: the flanks are the true
// involute of the base circle, which is the only profile that transmits constant
// angular velocity through the mesh and the only one that stays conjugate when
// the centre distance drifts. The involute of a circle of radius r_b is the
// curve traced by the end of a string unwound from it, so the point at radius r
// stands at polar angle
//
//     inv(α_r) = tan α_r − α_r,     α_r = arccos(r_b / r)
//
// A tooth flank is that curve, rotated so it crosses the pitch circle at half
// the tooth thickness. Standard tooth thickness at the pitch circle is half the
// circular pitch, so the half-angle there is π/(2z), and the flank's angle at
// the base circle is
//
//     ψ = π/(2z) + inv(α)
//
// with α the nominal pressure angle. Everything else follows: the flank is
// φ(r) = ψ − inv(α_r), the tooth is that curve and its mirror, and the gear is
// z copies of it.
//
// Proportions are ISO full-depth: addendum = m, dedendum = 1.25 m, so the pitch
// diameter is m·z, the outside diameter m(z+2) and the root m(z−2.5). Module and
// tooth count set the size; the base diameter is m·z·cos α and cannot be dialled
// in independently, which is why it is a READOUT (`gearDims`) rather than a
// parameter.
//
// Two things a gear generator has to get right or it hands you a broken part:
//
//   ROOT. Below the base circle there is no involute — the curve does not exist
//   there — so the flank runs radially down to the root circle. A hobbed gear
//   would undercut instead; a radial root is stronger and is what a cut-on-a-
//   router gear wants. The corner it leaves is filleted by a CLOSING of radius
//   0.38 m, which is the standard rack-tip radius, so every root in the gear is
//   filleted by one pass and the tooth tips (convex) are left untouched.
//
//   POINTED TEETH. On a low tooth count the two flanks meet before they reach
//   the nominal tip, and carrying on regardless crosses them over and produces a
//   self-intersecting outline. The tip is therefore clamped to the radius where
//   the tooth thickness reaches zero, which is what the tooth physically does.
//
// Emitted as separate parts — rim outline, bore, spoke windows, and the engraved
// tooth count — because those are different cuts (`generateGearParts`).

import {
  type Pt, clamp, arcInto, ellipseRing,
  roundConcave, ringToD,
} from './polyOps'
import { seatHub, spokeWindows, pinRing, pinRingHoles, type HubFit, type PinRing } from './spokedWheel'
import { generateTextD, isFontLoaded, SINGLE_LINE_FONT_FAMILY } from './textGenerator'
import { flattenPath } from '../cam/pathFlattener'

export interface GearSpec {
  cx: number; cy: number
  /** Tooth size. Pitch diameter is module × teeth, so this sets the scale. */
  module: number
  teeth: number
  /** Involute for machinery, cycloidal for clocks — see the CYCLOIDAL section. */
  toothProfile: ToothProfile
  /** Degrees. 20° is the modern standard; 14.5° is the old one. Involute only:
   *  a cycloidal mesh has no single pressure angle (it varies through the mesh),
   *  which is why the panels hide the field in that mode. */
  pressureAngle: number
  /** Pins on the MATING lantern pinion. Cycloidal only, and not optional there: a
   *  cycloidal face is conjugate to one particular mate, because the describing
   *  circle that traces it comes from the mate's pitch circle. */
  mateTeeth: number
  /** Pin diameter of that lantern pinion, mm. The face is the pin-centre
   *  epicycloid offset by its RADIUS, so this changes the tooth shape. */
  pinDia: number
  /** Cycloidal only. Cut the BACK of every tooth away as one curve, from part-way
   *  across the tip land down to the root — see the BACK RELIEF section. A clock
   *  runs one way only, so only one flank of a tooth ever touches a pin and the
   *  other is free to be taken back for pin clearance.
   *
   *  It is the fraction of the tip land given up: 0 (or absent) leaves the
   *  symmetric tooth every gear was cut with before this, and 1 starts the back
   *  face at the MIDDLE of the tip, which is the whole of what can be removed
   *  without eating the acting face. */
  backRelief?: number
  /** Cycloidal only, and only meaningful with `backRelief`: which flank of a tooth
   *  a pin actually bears on, CCW positive. The relief is cut on the OTHER one, so
   *  getting this backwards takes the acting face off and nothing errors.
   *
   *  −1 (the default) is the flank this generator draws from the true offset
   *  epicycloid; +1 is its mirror, which is equally conjugate — a symmetric tooth
   *  runs either way, which is exactly why the bit only starts to matter here.
   *
   *  For a wheel that DRIVES its lantern it is the wheel's own direction of
   *  rotation; for one DRIVEN by pins (a motion work, where the cannon pinion
   *  drives) it is the opposite, because the pin then bears on the far flank. */
  actingSense?: 1 | -1
  /** This wheel is DRIVEN by the pins rather than driving them — a motion work,
   *  where the cannon pinion is fixed to the arbor and pushes the wheel round.
   *
   *  It cuts nothing. `actingSense` is the whole of the geometry; this says which
   *  way to READ it, and without it a readout cannot: a driven wheel's teeth face
   *  the opposite way from a driving wheel turning the same way, so reporting the
   *  acting flank as a direction of rotation is right on four wheels of a clock
   *  and backwards on the other two. Rotation is `drivenByPins ? −actingSense :
   *  actingSense`, CCW positive — `gearRotationSense`. */
  drivenByPins?: boolean
  /** Also emit the mating lantern pinion — its cheek disc and pin holes. Cycloidal
   *  only; the wheel's own parameters already say everything about it. */
  emitPinion: boolean
  /** Pins of the lantern pinion that stands on THIS wheel's own arbor — the one
   *  the wheel BEFORE it drives, in a train. The wheel carries them itself: the
   *  holes are drilled through its hub, the pins stand in them, and a single
   *  loose cheek caps the far ends (see spokedWheel's pinRing). 0 or absent for
   *  a wheel that carries nothing, which is every gear drawn on its own.
   *
   *  It GROWS THE HUB, since the holes must fall in solid stock. */
  arborPins?: number
  /** Circle those pins ride, Ø. It is the carried pinion's PITCH circle, which
   *  belongs to the mesh with the wheel before this one — so it is stated rather
   *  than derived, and defaults to this wheel's own module × the pin count when
   *  omitted (right whenever both meshes share a module, as a clock's do). */
  arborPinCircleDia?: number
  /** Those pins' diameter. Defaults to `pinDia`, the pins of the lantern this
   *  wheel DRIVES — one rod size for the whole clock is the usual case. */
  arborPinDia?: number
  /** Axle hole diameter. 0 for none. */
  bore: number
  /** Hub outer diameter — a MINIMUM, not a fixed size: it is grown when the
   *  requested spoke count needs more circumference to land on. See `gearHub`. */
  hubDia: number
  /** 0 for a solid web. */
  spokes: number
  /** Spoke width, mm. Absent (or 0) is the classic `2.5·module`, which is what
   *  every gear was cut with before the field existed — so an old project comes
   *  out byte-identical and only a wheel someone has actually dialled in
   *  differs. Stated in MILLIMETRES rather than in modules because it is a
   *  question about the STOCK: how much wood is left holding the rim on, which
   *  is decided by the material and the cutter, not by the tooth size. It is a
   *  floor under the hub as well as the width of the web (see `gearHub`). */
  spokeWidth?: number
  /** Rim thickness under the root circle, mm — the stock between the bottom of
   *  a tooth and the spoke windows. Absent (or 0) is `2.5·module`, as above.
   *  Thickening it eats the web from the outside, so past a point there is no
   *  room for windows at all and the wheel comes out solid, which `HubFit.
   *  spoked` reports. */
  rimWidth?: number
  /** Circular backlash at the mesh, mm — the play a PAIR of these will have.
   *  Each gear is thinned by half of it, so setting the same figure on both
   *  gears of a pair gives exactly that much play. */
  backlash: number
  /** Engrave the tooth count on the gear — see `gearLabel`. Its own path, so it
   *  is engraved, or deleted, independently of anything that is cut. */
  toothLabel: boolean
  /** Draw the pitch circle as an extra subpath. Two gears mesh when their pitch
   *  circles are TANGENT, so this is the line to snap centres against — the
   *  centre distance is half the sum of the two pitch diameters. It is a
   *  reference, not a cut: the app has no non-cutting path, so split the
   *  compound path and drop this subpath before generating. */
  pitchCircle: boolean
  /** Draw the HUB as a circle of its own. Off for a gear drawn by hand — the
   *  spoke windows already show where the web ends — and on for a clock's drive
   *  wheel, whose hub is the DRUM the cord winds against and so is a diameter
   *  worth cutting to rather than inferring. It is the SEATED hub, so when the
   *  wheel has had to grow it past what was asked, this circle is the one the
   *  cord will really ride on. */
  hubCircle?: boolean
}

export type ToothProfile = 'involute' | 'cycloidal'

export interface GearDims {
  pitchDia: number
  /** Involute only — 0 for a cycloidal gear, which has no base circle. */
  baseDia: number
  /** Cycloidal only — the circle whose rolling traces the faces. 0 for involute. */
  describingDia: number
  /** Tooth SPACE at the pitch line, mm. What a lantern pin has to pass through. */
  spaceAtPitch: number
  outsideDia: number
  rootDia: number
  circularPitch: number
  /** Tooth thickness at the pitch circle, backlash already taken off. */
  toothThickness: number
  /** The tip had to be clamped — the flanks met before the nominal outside
   *  diameter, so the teeth come to a point and the OD is smaller than m(z+2). */
  pointed: boolean
  /** Below the undercut limit for this pressure angle (z < 2/sin²α), so the
   *  generating rack's tip cuts into the flank it has just formed and the tooth
   *  is waisted below the base circle. NOT a fault and not a warning: the roots
   *  are cut that way (`toothProfile` follows the trochoid across the crossing),
   *  which is what lets a mate's tips clear. It is worth reporting only because
   *  an undercut tooth is thinner at the root than its pitch-line thickness
   *  suggests. */
  undercut: boolean
  /** Cycloidal only: the pin has eaten the tooth. A lantern tooth is the circular
   *  pitch less the pin, so a pin approaching the pitch leaves nothing to drive
   *  with — the tooth is clamped to a sliver rather than inverting.
   *
   *  This is NOT the old "the pin will not pass the tooth space" failure. That
   *  one came of cutting the tooth to half the pitch whatever the pin: a fat pin
   *  then jammed. Sized for the pin, the space always admits it and the limit
   *  moves to the other end. */
  pinTooFat: boolean
}

const ADDENDUM = 1.0        // × module
const DEDENDUM = 1.25       // × module
const ROOT_FILLET = 0.38    // × module — the standard rack tip radius
const RIM = 2.5             // × module — default stock left under the root circle
const SPOKE = 2.5           // × module — default spoke width
// Chord tolerance on the involute flank, mm. This is a wooden gear cut on a
// router: it will be sanded, it will move with the seasons, and it is running
// tenths of a millimetre of backlash — so a profile held to 0.02 mm is already
// far beyond anything the part can hold. It buys a lot: the flank sample count
// falls ~20× and with it the cost of the root-fillet closing, which is what
// makes the gear slow.
//
// The chords are INSCRIBED — a gear flank is convex, so a polyline through
// points on it sits just inside the true profile. Every tooth therefore comes
// out a hair thin rather than a hair fat: the error spends itself as a few
// microns of extra backlash instead of as interference, which is the direction
// you want to err in when the part is going to be sanded anyway.
export const FLANK_TOL = 0.02

const inv = (a: number) => Math.tan(a) - a

export type GearHub = HubFit

/**
 * The web's two thicknesses, resolved.
 *
 * Both were fixed multiples of the module and are now the spec's own figures
 * when it gives them — a gear that says nothing is cut exactly as it always
 * was. `0` reads as "say nothing" rather than as a zero-width spoke, because a
 * zero-width spoke is not a thing anyone means and a field cleared to empty
 * would otherwise emit a wheel with no web.
 */
export const gearSpokeW = (module: number, spokeWidth?: number) =>
  spokeWidth != null && spokeWidth > 0 ? spokeWidth : SPOKE * Math.max(0.05, module)
export const gearRimW = (module: number, rimWidth?: number) =>
  rimWidth != null && rimWidth > 0 ? rimWidth : RIM * Math.max(0.05, module)

/**
 * Resolve the hub.
 *
 * The rules live in `spokedWheel.ts`, stated in terms of the spoke width so the
 * escape wheel can use the same ones; this only says what a gear's spoke width
 * and rim are. `SPOKE·m` wide spokes, `WEB·m` of web and `HUB·m` of stock round
 * the bore come out as 1, 0.6 and 0.8 times that width, which is exactly what
 * `seatHub` applies.
 */
export function gearHub(
  module: number, teeth: number, bore: number, hubDia: number, spokes: number,
  /** Hub the carried pinion's pin holes need, if this wheel carries one — see
   *  `carriedPinion`. Another FLOOR, passed through so `seatHub` can say which
   *  one bound rather than folding it in behind the user's own figure. */
  carriedHubDia = 0,
  spokeWidth?: number, rimWidth?: number,
  /** The cycloidal descriptor, when this is a lantern wheel. The rim is measured
   *  in from the ROOT, and the two profiles do not put it in the same place — so
   *  a hub seated without this is seated against a wheel that does not exist.
   *  Omitted reads as involute, which is what every gear was before cycloidal. */
  cyc?: CycMate,
): GearHub {
  const m = Math.max(0.05, module)
  const z = Math.max(4, Math.round(teeth))
  const rf = rootRadius(m, z, cyc)
  return seatHub(
    rf - gearRimW(m, rimWidth), clamp(bore / 2, 0, rf - 1),
    hubDia, spokes, gearSpokeW(m, spokeWidth), carriedHubDia,
  )
}

/** `gearHub` for a whole spec — every caller has one, and it is the only way to
 *  be sure the carried pinion's floor and the web's own widths were all asked
 *  for. */
export function gearHubOf(spec: GearSpec): GearHub {
  return gearHub(
    spec.module, spec.teeth, spec.bore, spec.hubDia, spec.spokes,
    carriedPinion(spec)?.hubDia ?? 0, spec.spokeWidth, spec.rimWidth, cycOf(spec),
  )
}

/**
 * Root radius, for EITHER profile — the one place it is worked out.
 *
 * It is not only the tooth's foot: the rim is measured in from it and the spoke
 * windows stop at it, so everything inside the teeth hangs off this number. The
 * two profiles do not agree on it — a lantern wheel's root clears the pin and
 * stops, which is normally shallower than the involute's 1.25·m — and while
 * `gearDims` and `generateGearParts` asked the profile, `gearHub` had its own
 * copy of the ISO figure and seated every cycloidal hub against a rim that was
 * not there.
 *
 * Needs only these three numbers: neither profile's root moves with pressure
 * angle, and backlash thins the tooth without lowering its foot.
 */
function rootRadius(m: number, z: number, cyc?: CycMate): number {
  if (cyc) return cycloidalRoot(m, z, Math.max(0, cyc.pinDia) / 2)
  return Math.max(0.1, (m * z) / 2 - DEDENDUM * m)
}

/**
 * The one place the gear's numbers are worked out — shared by the generator and by
 * the panels, so the readout can never disagree with the geometry.
 *
 * Pass `cyc` for a cycloidal gear. Its numbers genuinely differ: there is no base
 * circle, undercut is an involute idea and does not apply, the tip can be clamped
 * by the describing circle's arch as well as by the faces meeting, and a lantern's
 * pin can force a deeper root.
 */
export function gearDims(
  module: number, teeth: number, pressureAngle: number, backlash = 0,
  cyc?: CycMate,
): GearDims {
  const m = Math.max(0.05, module)
  const z = Math.max(4, Math.round(teeth))
  const alpha = clamp(pressureAngle, 5, 35) * (Math.PI / 180)
  const rp = (m * z) / 2

  if (cyc) {
    const spec: CycloidalSpec = { m, z, backlash, ...cyc }
    const ra = cycloidalTip(spec)
    const rf = rootRadius(m, z, cyc)
    const thickness = 2 * rp * cycloidalHalfTooth(m, z, backlash, cyc.pinDia)
    return {
      pitchDia: 2 * rp,
      baseDia: 0,
      describingDia: 2 * describingRadius(m, cyc.mateTeeth),
      spaceAtPitch: Math.PI * m - thickness,
      outsideDia: 2 * ra,
      rootDia: 2 * rf,
      circularPitch: Math.PI * m,
      toothThickness: thickness,
      pointed: ra < Math.min(rp + ADDENDUM * m, rp + 2 * describingRadius(m, cyc.mateTeeth)) - 1e-6,
      undercut: false,
      pinTooFat: Math.PI * m - Math.max(0, cyc.pinDia) - Math.max(0, backlash) < Math.PI * m * 0.05,
    }
  }

  const rb = rp * Math.cos(alpha)
  const ra = tipRadius(m, z, alpha, backlash)
  const thickness = 2 * rp * (halfToothAngle(m, z, alpha, backlash) - inv(alpha))
  return {
    pitchDia: 2 * rp,
    baseDia: 2 * rb,
    describingDia: 0,
    spaceAtPitch: Math.PI * m - thickness,
    outsideDia: 2 * ra,
    rootDia: 2 * rootRadius(m, z),
    circularPitch: Math.PI * m,
    toothThickness: thickness,
    pointed: ra < rp + ADDENDUM * m - 1e-6,
    undercut: z < 2 / Math.sin(alpha) ** 2,
    pinTooFat: false,
  }
}

/**
 * Half the tooth's angular width at the base circle.
 *
 * Backlash is taken off HERE — as tooth thinning — and nowhere else. Thinning
 * rotates each flank inward by half the play but leaves it the same involute of
 * the same base circle, so the pair still runs conjugate; it simply has slop.
 * Opening the centre distance instead would move the operating pitch circles and
 * break the one rule that makes the gears placeable (mesh when pitch circles are
 * tangent). Tip and root diameters are untouched for the same reason.
 *
 * `backlash` is the play at the MESH, so each gear takes half: the pitch-circle
 * tooth thickness goes πm/2 → πm/2 − backlash/2, and the half-angle there falls
 * by backlash/(2·m·z).
 */
function halfToothAngle(m: number, z: number, alpha: number, backlash: number): number {
  const nominal = Math.PI / (2 * z)
  const thinned = nominal - Math.max(0, backlash) / (2 * m * z)
  // A tooth thinned past nothing is not a tooth; leave a sliver rather than
  // inverting the profile.
  return Math.max(nominal * 0.05, thinned) + inv(alpha)
}

/** Angle of the flank at radius r, measured from the tooth's centreline. Zero
 *  means the two flanks have met — the tooth has come to a point. */
function flankAngle(r: number, rb: number, psi: number): number {
  if (r <= rb) return psi              // below the base circle the flank is radial
  return psi - inv(Math.acos(clamp(rb / r, -1, 1)))
}

/** The nominal tip, pulled in to where the tooth would come to a point. */
function tipRadius(m: number, z: number, alpha: number, backlash: number): number {
  const rp = (m * z) / 2
  const rb = rp * Math.cos(alpha)
  const psi = halfToothAngle(m, z, alpha, backlash)
  const nominal = rp + ADDENDUM * m
  if (flankAngle(nominal, rb, psi) > 1e-4) return nominal
  // Bisect for flankAngle = 0. It falls monotonically with r, so this is safe.
  let lo = Math.max(rb, rp * 0.5), hi = nominal
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (flankAngle(mid, rb, psi) > 0) lo = mid; else hi = mid
  }
  return lo
}

/**
 * The involute flank, from where it starts up to the tip, as offsets from the
 * tooth centreline. Sampled on the involute's roll angle rather than on radius:
 * the curve turns fastest near the base circle, and rolling uniformly puts the
 * points where the curvature is.
 *
 * The count comes from the ERROR, not from a fixed spacing. An involute's radius
 * of curvature at roll angle t is ρ = r_b·t, so a chord spanning Δt bulges away
 * from the true curve by ρ·Δt²/8 — worst at the tip, where ρ is largest. Solving
 * there for `FLANK_TOL` sizes the whole flank. A fixed spacing cannot do this:
 * it puts the same number of points on the near-straight outer flank as on the
 * tight curl by the base circle, which is where the 20× waste was.
 *
 * The radial run below the base circle is NOT here — `toothedRing` lays that in,
 * because both of its ends have to be placed by hand to keep the tooth
 * symmetric.
 */
function flankPoints(rStart: number, rEnd: number, rb: number, psi: number): { r: number; a: number }[] {
  // r = rb·√(1 + t²) for roll angle t, so t = √((r/rb)² − 1).
  const roll = (r: number) => Math.sqrt(Math.max(0, (r / rb) ** 2 - 1))
  const t0 = roll(Math.max(rStart, rb)), t1 = roll(rEnd)
  const dt = Math.sqrt((8 * FLANK_TOL) / Math.max(rb * t1, 1e-9))
  const steps = Math.round(clamp(Math.ceil((t1 - t0) / dt), 4, 200))

  const out: { r: number; a: number }[] = []
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps
    const r = rb * Math.sqrt(1 + t * t)
    out.push({ r, a: flankAngle(r, rb, psi) })
  }
  return out
}

/**
 * THE TROCHOIDAL ROOT — what a hob actually leaves, and the undercut with it.
 *
 * A gear is generated by a rack rolling on its pitch circle. The rack's straight
 * flank cuts the involute; its TIP, rounded to the rack-tip radius, cuts
 * everything below — and what that leaves is not a circular fillet but the
 * envelope of the tip radius as it sweeps, a trochoid. On a normal tooth count
 * the difference is small. On a low one it is the whole point: the tip swings so
 * far round that it eats into the flank it has just cut, and THAT is undercut.
 *
 * The generator used to run the flank radially to the root and fillet the corner
 * with a closing, which is a fair approximation of a hobbed root and no
 * approximation at all of an undercut one — it left the full flank standing where
 * a hob would have cut it away, so a small mate fouled the wheel it was drawn to
 * run with (0.107 mm on a 24 × 8 pair at 20°, which the mesh preview showed).
 *
 * THE CONSTRUCTION. Roll the rack: the gear turns θ while the rack translates by
 * r·θ along the pitch line. A rack point `(ξ, η)` — ξ along the pitch line, η
 * outward from it — lands in the gear's own frame at
 *
 *     X = (r + η)·cos θ + (ξ + rθ)·sin θ
 *     Y = −(r + η)·sin θ + (ξ + rθ)·cos θ
 *
 * Track the CENTRE of the tip fillet through that, and the cut surface is the
 * point of the fillet circle that is instantaneously in contact. For rolling
 * motion contact lies where the common normal passes through the pitch point —
 * the instant centre — so it is simply the fillet centre pushed a radius directly
 * away from the pitch point:
 *
 *     root(θ) = C(θ) + ρ · unit( C(θ) − P(θ) ),   P(θ) = the pitch point
 *
 * which needs no envelope algebra and no differentiation of the trochoid.
 *
 * Returned as (r, a) against the SPACE's centreline, one side only: the other is
 * its mirror, because the rack tooth is symmetric.
 */
/**
 * The generating rack's tip radius — the standard 0.38 m, but only where it fits.
 *
 * The fillet has to be tangent to both the tip line and the flank, and its
 * tangency on the TIP line has to fall within the tooth's own half width or the
 * two fillets have crossed and the rack tooth has no tip at all. At 20° the
 * standard radius clears by six hundredths of a module; at 25° it does not fit,
 * and the rack comes to a point. Solving ξ_c ≥ 0 gives the ceiling.
 *
 * Found by hobbing, not by reading: `scripts/gear-trochoid-check.mts` builds the
 * rack as a polygon and unions it, so a rack whose fillets crossed came out
 * self-intersecting and clipper returned nothing at all.
 */
function rackTipRadius(m: number, alpha: number, backlash: number): number {
  const h0 = (Math.PI * m / 2 + Math.max(0, backlash)) / 2
  const room = ((h0 - DEDENDUM * m * Math.tan(alpha)) * Math.cos(alpha)) / (1 - Math.sin(alpha))
  return clamp(Math.min(ROOT_FILLET * m, room), 0, ROOT_FILLET * m)
}

function rackTrochoid(m: number, z: number, alpha: number, backlash: number): { r: number; a: number }[] {
  const r = (m * z) / 2
  // The rack tooth is what cuts the gear's SPACE, so it is as thick as the
  // gear's tooth is thin: the pitch less the gear's tooth thickness.
  const h0 = (Math.PI * m / 2 + Math.max(0, backlash)) / 2
  const etaTip = -DEDENDUM * m
  const rho = rackTipRadius(m, alpha, backlash)
  // Fillet centre: a radius up off the tip line, and a radius in from the flank.
  const etaC = etaTip + rho
  const xiC = h0 + etaC * Math.tan(alpha) - rho / Math.cos(alpha)

  const out: { r: number; a: number }[] = []
  // Rolled from before the fillet reaches the tip line (negative θ, where the
  // root arc still has it) FAR ENOUGH PAST THE FORM POINT for the curve to cross
  // the involute, which is what `toothedRing` needs: the crossing is where the
  // root hands over to the flank, and on an undercut tooth it is above the base
  // circle, so a roll that stops at the base circle cannot find it. Two pitches
  // clears it on everything from z6 up; one did not reach the base circle at all
  // (44.55 against 45.11 on the default gear).
  //
  // Rolling further used to be the thing this would not do, on the grounds that
  // `gear-trochoid-check.mts` stamped one rack tooth over one pitch and so
  // stopped being a hob exactly where an undercut begins. It does not: it
  // replicates that one union to all z spaces, and rotating the gear by a pitch
  // is the same as rolling by a pitch, so the reference is a full rack over a
  // full turn either way. The undercut cases (z8, z12 at 20°, z20 at 14.5°) pass
  // it at 0.002 mm, which is the evidence.
  const span = Math.PI / z
  const STEPS = 96
  for (let i = 0; i <= STEPS; i++) {
    const th = -span / 3 + ((span * 7 / 3) * i) / STEPS
    const c = Math.cos(th), s = Math.sin(th)
    const C: Pt = [(r + etaC) * c + (xiC + r * th) * s, -(r + etaC) * s + (xiC + r * th) * c]
    const P: Pt = [r * c, -r * s]
    const dx = C[0] - P[0], dy = C[1] - P[1]
    const d = Math.hypot(dx, dy) || 1
    const q: Pt = [C[0] + (rho * dx) / d, C[1] + (rho * dy) / d]
    out.push({ r: Math.hypot(q[0], q[1]), a: Math.atan2(q[1], q[0]) })
  }
  // CLIPPED AT THE DEEPEST POINT, which is where the fillet hands over to the
  // rack's flat tip: below that θ the contact is on the tip LINE and the root is
  // simply the root circle, but the formula above carries on describing a point
  // of the fillet that is no longer touching anything. Left in, those points
  // climb back off the root circle on the wrong side — 0.2 mm off the hobbed
  // outline, against 0.002 mm for the branch that is real.
  let lo = 0
  for (let i = 1; i < out.length; i++) if (out[i].r <= out[lo].r) lo = i
  return out.slice(lo)
}

/**
 * ONE FLANK OF A TOOTH, deepest point first: the hobbed root, then the involute.
 *
 * Where the two meet is the FORM POINT, and finding it is the whole of this.
 * Walk the trochoid outwards and compare it, at each radius, with the involute
 * that would be there — the involute wins from the first radius at which it lies
 * NEARER the tooth's centreline, because whichever of the two is nearer is the
 * one that cut the material away.
 *
 * On a normal tooth count that crossing lands within a hair of the base circle
 * and the profile is the familiar one. On a low count the trochoid dips inside
 * the involute well ABOVE the base circle and the crossing moves up with it — the
 * flank is cut short and the root undershoots it. THAT IS UNDERCUT, and it falls
 * out of the same two curves rather than being a case.
 *
 * What this replaces is a radial run from the base circle to the root with a
 * fillet closed into the corner. That is a fair approximation of a hobbed root
 * and no approximation at all of an undercut one: it left the full flank standing
 * exactly where a hob cuts it away, so a mate below the undercut limit fouled the
 * wheel it was drawn to run with, and both panels had to warn about it. A radial
 * run also needed its foot placed by hand at each end or the tooth came out
 * lopsided; the trochoid has real ends and needs none of that.
 */
function toothProfile(m: number, z: number, alpha: number, backlash: number): { r: number; a: number }[] {
  const rp = (m * z) / 2
  const rb = rp * Math.cos(alpha)
  const ra = tipRadius(m, z, alpha, backlash)
  const rf = Math.max(0.1, rp - DEDENDUM * m)
  const psi = halfToothAngle(m, z, alpha, backlash)
  const pitch = (2 * Math.PI) / z

  // The trochoid is quoted about the SPACE's centreline, which sits half a pitch
  // from the tooth's; and it is one side only, the side facing this tooth.
  const troch = rackTrochoid(m, z, alpha, backlash)
    .map((q) => ({ r: q.r, a: pitch / 2 - q.a }))
    .filter((q) => Number.isFinite(q.a) && q.r >= rf - 1e-6)

  const out: { r: number; a: number }[] = []
  let formR = rb
  for (let i = 0; i < troch.length; i++) {
    const q = troch[i]
    // Below the base circle there is no involute to hand over to, so the
    // trochoid is the boundary whatever it is doing.
    if (q.r > rb && q.a >= flankAngle(q.r, rb, psi)) { formR = q.r; break }
    if (q.r > ra) break
    out.push(q)
    formR = q.r
  }
  // No crossing found — the roll did not reach far enough, which it should for
  // every count from 6 up. Fall back to the involute from the base circle: the
  // old shape, and a safe one, rather than a tooth with no flank.
  if (out.length === 0) return flankPoints(Math.max(rf, Math.min(rb, ra * 0.999)), ra, rb, psi)

  // THINNED TO `FLANK_TOL`, like the involute beside it. `rackTrochoid` rolls at a
  // fixed step because the roll is where its accuracy lives, and that lands ~97
  // points on a curve a tenth of them describes to 0.02 mm — six times the
  // outline for nothing. Everything downstream pays it twice over: the root
  // fillet closing pushes the whole ring through clipper, and the mesh check
  // walks it per step of a bisection.
  //
  // Douglas–Peucker on the CHORD, not a stride: the trochoid's curvature is all
  // at the bottom, so dropping every other point thins the tight part and the
  // straight part alike.
  const kept = simplify(out.map((q) => [q.r * Math.cos(q.a), q.r * Math.sin(q.a)] as Pt), FLANK_TOL)
  const thin = kept.map((p) => ({ r: Math.hypot(p[0], p[1]), a: Math.atan2(p[1], p[0]) }))

  for (const q of flankPoints(Math.max(formR, rb), ra, rb, psi)) {
    // Skip the handover point itself; the trochoid already ended on it.
    if (q.r <= thin[thin.length - 1].r + 1e-9) continue
    thin.push(q)
  }
  return thin
}

/** Douglas–Peucker, keeping the ends. */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = 1; keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length > 0) {
    const [i, j] = stack.pop()!
    if (j <= i + 1) continue
    const a = pts[i], b = pts[j]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const n = Math.hypot(dx, dy) || 1
    let worst = -1, at = -1
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k][0] - a[0]) * dy - (pts[k][1] - a[1]) * dx) / n
      if (d > worst) { worst = d; at = k }
    }
    if (worst > tol) { keep[at] = 1; stack.push([i, at], [at, j]) }
  }
  return pts.filter((_, i) => keep[i] === 1)
}

/** The toothed outline, CCW, centred on the origin. */
function toothedRing(m: number, z: number, alpha: number, backlash: number): Pt[] {
  const ra = tipRadius(m, z, alpha, backlash)
  const rf = Math.max(0.1, (m * z) / 2 - DEDENDUM * m)
  const pitch = (2 * Math.PI) / z
  const profile = toothProfile(m, z, alpha, backlash)
  const rootA = profile[0].a
  const tipA = profile[profile.length - 1].a

  const ring: Pt[] = []
  const at = (r: number, a: number) => ring.push([r * Math.cos(a), r * Math.sin(a)])


  for (let i = 0; i < z; i++) {
    const c = i * pitch
    // Rising flank: root → tip on the −φ side, which runs CCW. Its foot is
    // already on the ring — the previous tooth's root arc ended exactly there.
    for (const q of profile) at(q.r, c - q.a)
    // Across the tip.
    arcInto(ring, 0, 0, ra, ra, c - tipA, c + tipA)
    // Falling flank: tip → root on the +φ side.
    for (let k = profile.length - 2; k >= 0; k--) at(profile[k].r, c + profile[k].a)
    // The flat the rack's tip line leaves between one trochoid's foot and the
    // next. Short, and it never inverts: rootA < pitch/2 is exactly the condition
    // that the tooth is thinner than the pitch.
    arcInto(ring, 0, 0, rf, rf, c + rootA, c + pitch - rootA)
  }
  return ring
}

// ─── Cycloidal teeth ──────────────────────────────────────────────────────────
//
// A clock wheel is not a machine gear. It turns slowly, it is cut in wood or
// brass by hand-guided tools, and it drives a pinion of six to twelve leaves —
// often a LANTERN pinion, which is not a toothed wheel at all but a cage of round
// pins. An involute wheel run against pins is not conjugate to them: the ratio
// wobbles within each tooth, which in a clock train shows up as a tick in the
// rate and as wear at one spot on every pin. Cycloidal teeth are the answer, and
// they predate involutes in horology by centuries.
//
// The law behind them: if the face of one wheel above its pitch circle is an
// EPICYCLOID traced by a circle rolling on that pitch circle, then the mating
// flank below ITS pitch circle is the HYPOCYCLOID traced by the same describing
// circle rolling inside the mate's pitch circle — and the pair transmits constant
// angular velocity.
//
// This generator cuts wheels for LANTERN pinions, which is what wooden clocks use.
// A pin has no flank; the pin IS the tooth. Relative to the wheel, the pin's CENTRE
// traces the epicycloid of the pinion's FULL pitch circle (a point of that circle
// as it rolls), and the pin's surface stands one radius off it — so the wheel's
// face is that epicycloid OFFSET INWARD by the pin radius, the envelope of the pin
// circles. Which is why pin diameter is a tooth-FORM parameter here and not just a
// detail of the pinion. (A leaved pinion would want a describing circle of HALF the
// pinion's pitch radius, so the hypocycloid inside it degenerates to a straight
// radial flank — the Cardan couple. Nothing here does that; adding it would mean
// generating the pinion too, and verifying the mesh against its leaves.)
//
// Below the pitch circle the wheel's tooth does no driving (with a lantern the
// action is entirely on the recess side), so the flank runs RADIALLY down to the
// root — the same answer, and for the same reason, as the involute generator's
// sub-base-circle run.
//
// Placement is free: rotating a conjugate profile about its own axis only phases
// the mesh, it does not break conjugacy. So the face curve is placed with its
// inner end ON the pitch-line flank, which keeps tooth thickness the designed
// figure (`halfToothAngle`) instead of letting the pin radius eat it.

/** The cycloidal descriptor for a spec, or undefined when it is an involute gear.
 *  One place decides which profile a spec means, so no call site can disagree —
 *  and a project saved before cycloidal existed has no `toothProfile` and reads as
 *  involute, which is what it was. */
export function cycOf(spec: GearSpec): CycMate | undefined {
  if (spec.toothProfile !== 'cycloidal') return undefined
  // Defaulted, not trusted. A gear whose params were written before these fields
  // existed has neither, and an undefined pin diameter does not draw a wrong tooth
  // — it makes every coordinate NaN, so the gear silently stops rendering and the
  // panel field it belongs to disappears along with it.
  const mateTeeth = Number.isFinite(spec.mateTeeth) ? spec.mateTeeth : 8
  const pinDia = Number.isFinite(spec.pinDia) ? spec.pinDia : 1.25 * Math.max(0.05, spec.module)
  const backRelief = Number.isFinite(spec.backRelief) ? clamp(spec.backRelief!, 0, 1) : 0
  const actingSense: 1 | -1 = spec.actingSense === 1 ? 1 : -1
  return { mateTeeth, pinDia, backRelief, actingSense }
}

/**
 * Which way the wheel TURNS, CCW positive — as against which flank acts.
 *
 * The two are the same number on a wheel that drives its lantern and opposite on
 * one the pins drive, and nothing in the geometry distinguishes them: the tooth
 * is cut to the acting flank either way. So this is the one place the inversion
 * lives, and any readout naming a direction goes through it.
 */
export function gearRotationSense(spec: GearSpec): 1 | -1 {
  const acting: 1 | -1 = spec.actingSense === 1 ? 1 : -1
  return spec.drivenByPins ? (acting === 1 ? -1 : 1) : acting
}

/** The lantern pinion a cycloidal wheel is cut for, plus the two things that make
 *  its teeth asymmetric. The last two are absent on every gear cut before back
 *  relief existed, which reads as the symmetric tooth it was. */
export interface CycMate {
  mateTeeth: number
  pinDia: number
  backRelief?: number
  actingSense?: 1 | -1
}

/**
 * Radius of the describing circle: the pinion's FULL pitch radius.
 *
 * That is the lantern case — the pin centres ride the pitch circle, so a point of
 * that circle rolling on the wheel traces the locus the pins follow. (A LEAVED
 * pinion would want half of it, so the hypocycloid inside the pinion degenerates
 * to a radial flank; this generator only cuts for lanterns, which is what wooden
 * clocks use, so half never appears here.)
 */
export function describingRadius(m: number, mateTeeth: number): number {
  return (Math.max(0.05, m) * Math.max(2, Math.round(mateTeeth))) / 2
}

/**
 * A point on the epicycloid, with its unit tangent.
 *
 * A point of the circle of radius `rho` rolling outside the circle of radius
 * `rb`, starting at (rb, 0) and running counter-clockwise:
 *
 *     x = (rb+ρ)·cos t − ρ·cos(kt),  y = (rb+ρ)·sin t − ρ·sin(kt),  k = (rb+ρ)/ρ
 *
 * t = 0 is a CUSP — the velocity vanishes there — and the limiting tangent is
 * radial, which is exactly what lets the face meet a radial flank without a
 * corner.
 */
function epicycloidAt(rb: number, rho: number, t: number): { x: number; y: number; tx: number; ty: number } {
  const k = (rb + rho) / rho
  const x = (rb + rho) * Math.cos(t) - rho * Math.cos(k * t)
  const y = (rb + rho) * Math.sin(t) - rho * Math.sin(k * t)
  let dx = -(rb + rho) * Math.sin(t) + k * rho * Math.sin(k * t)
  let dy = (rb + rho) * Math.cos(t) - k * rho * Math.cos(k * t)
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) { dx = 1; dy = 0 } else { dx /= len; dy /= len }
  return { x, y, tx: dx, ty: dy }
}

/**
 * The face of one tooth as (radius, angle from its pitch-line foot) pairs, the
 * same form `toothedRing` consumes for an involute flank.
 *
 * Sampling is adaptive on the chord: an epicycloid's curvature runs from zero at
 * the cusp to a maximum partway up, so no fixed step in t is right everywhere —
 * midpoints are tested against `FLANK_TOL` and the interval split until they fit.
 * `pinR > 0` offsets the curve into the tooth by the pin radius, which is what
 * turns the pin-centre locus into the face that envelopes the pin.
 */
function cycloidFace(rp: number, rho: number, ra: number, pinR: number): { r: number; a: number }[] {
  // Offset INTO the tooth: the tooth body is on the +y side of this curve (it
  // rises counter-clockwise toward the tooth centreline), so the inward normal is
  // the tangent turned +90°.
  const pt = (t: number): Pt => {
    const e = epicycloidAt(rp, rho, t)
    return [e.x - pinR * e.ty, e.y + pinR * e.tx]
  }
  const rad = (p: Pt) => Math.hypot(p[0], p[1])

  // How far up the curve the tip is. r(t) climbs monotonically over the arch, so
  // bisection finds it; the arch tops out at rp + 2ρ, which is the ceiling on how
  // tall a cycloidal tooth can be for this pinion.
  const tTop = (Math.PI * rho) / (rp + rho)
  let tEnd = tTop
  if (rad(pt(tTop)) > ra) {
    let lo = 0, hi = tTop
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (rad(pt(mid)) < ra) lo = mid; else hi = mid
    }
    tEnd = lo
  }

  // Adaptive subdivision on the chord's sagitta.
  const out: { t: number; p: Pt }[] = [{ t: 0, p: pt(0) }]
  const push = (t0: number, p0: Pt, t1: number, p1: Pt, depth: number) => {
    const tm = (t0 + t1) / 2
    const pm = pt(tm)
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1]
    const len = Math.hypot(dx, dy)
    // Distance of the midpoint from the chord — the error a straight segment makes.
    const err = len < 1e-12
      ? Math.hypot(pm[0] - p0[0], pm[1] - p0[1])
      : Math.abs((pm[0] - p0[0]) * dy - (pm[1] - p0[1]) * dx) / len
    if (depth >= 9 || (err <= FLANK_TOL && len <= (ra - rp) + 0.5)) { out.push({ t: t1, p: p1 }); return }
    push(t0, p0, tm, pm, depth + 1)
    push(tm, pm, t1, p1, depth + 1)
  }
  const steps = 6              // a coarse spine, then refined where it needs it
  let prevT = 0, prevP = out[0].p
  for (let i = 1; i <= steps; i++) {
    const t = (tEnd * i) / steps
    const p = pt(t)
    push(prevT, prevP, t, p, 0)
    prevT = t; prevP = p
  }

  // Re-expressed against the foot, so the caller can place and mirror it: the
  // face's own start angle is the datum, which is what keeps the pin radius out of
  // the tooth thickness.
  const a0 = Math.atan2(out[0].p[1], out[0].p[0])
  return out.map(({ p }) => ({ r: rad(p), a: Math.atan2(p[1], p[0]) - a0 }))
}

// ─── Back relief ──────────────────────────────────────────────────────────────
//
// A CLOCK WHEEL TURNS ONE WAY, SO ONLY ONE FLANK OF A TOOTH IS EVER TOUCHED.
// The other is drawn as the mirror of it only because a gear generator has no
// reason to know which way the wheel will run — and mirroring it is not free:
// the back of the tooth stands in the space the NEXT pin has to drop into.
//
// A lantern pin does not slide into its space along the tooth; it dives almost
// radially at the line of centres and the corner it passes closest to is the
// BACK CORNER OF THE TIP, which is the one part of the tooth that does nothing
// at all. Traditional clock wheels are cut exactly this way — the acting face an
// epicycloid, the back of the tooth one plain curve from the tip down to the
// root, which is what gives a clock wheel its hooked, ratchet-like look.
//
// So `backRelief` replaces the whole back flank — mirrored face, radial run and
// all — with ONE arc, from a point part-way across the tip land down to the foot
// the radial run used to land on. Two things fix that arc and there is no third
// parameter:
//
//   IT ENDS TANGENT TO THE RADIAL at the foot, so it leaves the root exactly as
//   the run it replaces did and curves in only as it climbs. That is also the
//   shape that keeps the tooth THICK where it is loaded: bending stress is at the
//   root, and the arc hugs the original outline down there and takes its material
//   from the tip, where the tooth carries nothing.
//
//   IT ONLY EVER REMOVES MATERIAL. Leaving the foot along the radial and bending
//   toward the tooth's centreline from there, the arc stays inside the flank it
//   replaces — below the pitch line trivially, since that flank is the radial run
//   itself, and above it against the mirrored epicycloid, which leans in as it
//   climbs but never as fast. That last part is a sweep result, not a proof: 6400
//   combinations of module, count, pins, pin size, backlash and relief emit rings
//   byte-identical with and without a clamp to the mirrored face, so the clamp was
//   removed. It is worth knowing WHY it matters, because it is not the size of the
//   number — a symmetric back flank is EXACTLY parallel to the approaching pin's
//   own path, the two differing by the tooth space at every radius, so all a pair
//   has to spare on that side is the backlash and a few hundredths would be a
//   sixth of it. `gear-back-relief-check.mts` measures it on every case.
//
// WHICH FLANK IS THE BACK IS A BIT THAT FAILS SILENTLY (`actingSense`). Both
// flanks are conjugate — one for each direction — so a symmetric wheel runs
// either way and no mesh check can tell them apart. Relieve the wrong one and the
// wheel still looks like a clock wheel and still turns; it simply has no acting
// face left. `scripts/gear-back-relief-check.mts` is what settles it, by running
// the real mesh at both settings and seeing which one the transmission error
// survives.

/**
 * The relieved back of one tooth: the arc from the tip land at `aP` down to the
 * root foot at `aQ`, tangent to the radial at that foot.
 *
 * The circle is determined by the three conditions and solved directly: its
 * centre lies along the TANGENTIAL direction at the foot (perpendicular to the
 * radial the arc leaves along), at the distance that makes it equidistant from
 * both ends. Emitted from just after the tip point through the foot inclusive,
 * which is the convention `arcInto` uses so the pieces chain.
 */
function backReliefArc(ra: number, aP: number, rf: number, aQ: number): Pt[] {
  const P: Pt = [ra * Math.cos(aP), ra * Math.sin(aP)]
  const Q: Pt = [rf * Math.cos(aQ), rf * Math.sin(aQ)]
  const nx = -Math.sin(aQ), ny = Math.cos(aQ)          // tangential at the foot
  const dx = Q[0] - P[0], dy = Q[1] - P[1]
  const d2 = dx * dx + dy * dy
  const nd = nx * dx + ny * dy
  // Degenerate — the two ends line up with the radial, so there is no arc and a
  // straight back face is the honest answer.
  if (d2 < 1e-12 || Math.abs(nd) < 1e-9) return [Q]
  const s = -d2 / (2 * nd)
  const cx = Q[0] + s * nx, cy = Q[1] + s * ny
  const R = Math.abs(s)
  const a0 = Math.atan2(P[1] - cy, P[0] - cx)
  const a1 = Math.atan2(Q[1] - cy, Q[0] - cx)
  let sweep = a1 - a0
  while (sweep > Math.PI) sweep -= 2 * Math.PI
  while (sweep < -Math.PI) sweep += 2 * Math.PI
  // Chord sagitta R·(Δ/2)²/2 held under FLANK_TOL, the same budget the flanks use.
  const step = 2 * Math.sqrt((2 * FLANK_TOL) / Math.max(R, 1e-6))
  const n = clamp(Math.ceil(Math.abs(sweep) / step), 4, 400)
  const out: Pt[] = []
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n
    out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)])
  }
  return out
}

/** The cycloidal toothed outline, CCW, centred on the origin. */
function cycloidalRing(spec: CycloidalSpec): Pt[] {
  const { m, z, backlash, mateTeeth, pinDia } = spec
  const relief = clamp(spec.backRelief ?? 0, 0, 1)
  const rp = (m * z) / 2
  const psi = cycloidalHalfTooth(m, z, backlash, pinDia)
  const pinR = Math.max(0, pinDia) / 2
  const rf = rootRadius(m, z, spec)
  const rho = describingRadius(m, mateTeeth)
  const ra = cycloidalTip(spec)
  const face = cycloidFace(rp, rho, ra, pinR)
  const pitch = (2 * Math.PI) / z

  const ring: Pt[] = []
  const at = (r: number, a: number) => ring.push([r * Math.cos(a), r * Math.sin(a)])

  for (let i = 0; i < z; i++) {
    const c = i * pitch
    // Radial run up to the pitch line. Its foot is already on the ring — the
    // previous tooth's root arc ended exactly there — so only the top is pushed.
    at(face[0].r, c - psi)
    // Rising face, curving toward the tooth's centreline as it climbs. THIS is
    // the acting one; everything `actingSense` does is decide whether the whole
    // ring is handed back mirrored.
    for (let k = 1; k < face.length; k++) at(face[k].r, c - psi + face[k].a)
    const tipA = face[face.length - 1].a
    // Where the tip land ends. Relieved, it stops short of the far corner — all
    // the way at the tooth's centreline when the relief is full.
    const aBack = c + (psi - tipA) * (1 - relief)
    arcInto(ring, 0, 0, ra, ra, c - psi + tipA, aBack)
    if (relief > 0) {
      for (const q of backReliefArc(ra, aBack, rf, c + psi)) ring.push(q)
    } else {
      // Falling face, then the radial run down — its foot placed by hand, for the
      // same reason the involute generator places its own (arcInto skips its start
      // point, and the root arc's start is not where the flank ended).
      for (let k = face.length - 2; k >= 0; k--) at(face[k].r, c + psi - face[k].a)
      at(rf, c + psi)
    }
    arcInto(ring, 0, 0, rf, rf, c + psi, c + pitch - psi)
  }
  // The mirror through y = 0 is the same wheel run the other way: tooth centres
  // sit at i·pitch, so reflecting maps tooth i onto tooth z−i and the outline
  // lands back on itself. Reversed as well as reflected, to stay CCW.
  if ((spec.actingSense ?? -1) > 0) {
    return ring.map(([x, y]) => [x, -y] as Pt).reverse()
  }
  return ring
}

interface CycloidalSpec extends CycMate { m: number; z: number; backlash: number }

/**
 * Half the tooth's angular width at the PITCH circle — where a cycloidal tooth's
 * thickness is defined, there being no base circle to measure it on.
 *
 * A LANTERN TOOTH IS NOT HALF THE PITCH. That is the involute rule, where the
 * mate is another gear presenting a tooth of the same thickness, so the two split
 * the pitch between them. A lantern presents a PIN, and a pin is much thinner
 * than half the pitch — so the wheel's tooth has to fill the whole of what the
 * pin leaves:
 *
 *     thickness = circular pitch − pin diameter − backlash
 *
 * Cut it to half the pitch instead and every surface is where it should be and
 * the pair still turns; it simply rattles. On an m4 wheel with Ø3 pins that is
 * 3.4 mm of play against a 0.3 mm backlash, and nothing on the drawing says so —
 * it took running the pair in the canvas to see it. The whole backlash goes on
 * the wheel here rather than half of it, because the wheel is the only half of
 * this pair that is cut to a thickness at all.
 *
 * Clamped to leave both a tooth and a space: a pin as fat as the circular pitch
 * has eaten the tooth, which `GearDims.pinTooFat` reports.
 */
function cycloidalHalfTooth(m: number, z: number, backlash: number, pinDia: number): number {
  const p = Math.PI * m
  const t = clamp(p - Math.max(0, pinDia) - Math.max(0, backlash), p * 0.05, p * 0.95)
  return t / (m * z)                                   // t / (2·rp), rp = mz/2
}

/**
 * Root radius — set by THE PIN AND NOTHING ELSE, and the ISO dedendum has no say.
 *
 * The pin centre rides the pinion's pitch circle, so at the line of centres it
 * sits exactly on the wheel's pitch circle and the pin's inner edge dips to
 * `rp − pinR`. That is the whole of what has to be cleared: a lantern presents no
 * tooth tip, so there is no addendum on the other side to make room for. A root
 * above `rp − pinR` is a pin bottoming in the wheel — the loudest failure in a
 * clock train, and one that looks fine on the canvas — and a root below it is
 * dead depth that only makes the tooth longer and more fragile.
 *
 * This used to be `min(rp − 1.25m, rp − pinR − c)`, meaning to deepen the root for
 * a fat pin but in fact never letting it come UP: the ISO dedendum is the deeper
 * of the two at every pin a clock actually uses, so it always won and the pin term
 * never bound. On m4 with Ø3 pins that is 5 mm of dedendum where 2.3 mm clears —
 * 2.7 mm of tooth standing for nothing. The flank below the pitch circle is
 * radial and does no driving, so shortening it costs the mesh nothing.
 */
function cycloidalRoot(m: number, z: number, pinR: number): number {
  const rp = (m * z) / 2
  const clearance = 0.2 * m
  return Math.max(0.1, rp - pinR - clearance)
}

/** The tip, pulled in to where the two faces meet or where the epicycloid's arch
 *  ends — whichever comes first. A cycloidal tooth cannot be taller than
 *  `2·ρ` above the pitch circle, however much addendum is asked for. */
function cycloidalTip(spec: CycloidalSpec): number {
  const { m, z, backlash, mateTeeth, pinDia } = spec
  const rp = (m * z) / 2
  const psi = cycloidalHalfTooth(m, z, backlash, pinDia)
  const pinR = Math.max(0, pinDia) / 2
  const rho = describingRadius(m, mateTeeth)
  const arch = rp + 2 * rho
  const nominal = Math.min(rp + ADDENDUM * m, arch)

  // The faces converge as they climb; where their angular offset reaches psi the
  // tooth has come to a point and anything beyond crosses them over.
  const face = cycloidFace(rp, rho, nominal, pinR)
  const meet = face.find((q) => q.a >= psi)
  if (!meet) return nominal
  return Math.max(rp + 0.05 * m, meet.r)
}

// ─── Toothed-outline cache ────────────────────────────────────────────────────
//
// The teeth are ~99% of the cost of a gear: at 24 teeth the outline is 73 ms of
// a 74 ms call, at 80 teeth 330 ms of 332 ms. Almost none of that is the
// involute arithmetic — it is the root-fillet CLOSING, two clipper offset passes
// over a 3.6k–12k point polygon.
//
// But bore, hub, spokes and position do not touch a single tooth, and those are
// exactly the parameters a user nudges with a spinner. So the outline is
// memoised on the four things that DO define it, and stepping the bore or the
// spoke count costs only the windows (1–2 ms). It is centred on the origin and
// translated at emit time, so moving a gear hits the cache too.
//
// Deterministic in, deterministic out — the same four numbers always produce the
// same rings — so this is a pure memo, not a snapshot of anything mutable.
// Callers never mutate what they get back: `generateGearD` copies every point on
// its way out.
const TOOTH_CACHE = new Map<string, Pt[][]>()
const TOOTH_CACHE_MAX = 8

function toothedOutline(
  m: number, z: number, alpha: number, backlash: number,
  cyc?: CycMate,
): Pt[][] {
  // The cycloidal face depends on the mate, so those three go in the key: two
  // gears alike but for the pinion they are cut for have different teeth.
  const key = cyc
    ? `c|${m}|${z}|${backlash}|${cyc.mateTeeth}|${cyc.pinDia}|${cyc.backRelief ?? 0}|${cyc.actingSense ?? -1}`
    : `i|${m}|${z}|${alpha}|${backlash}`
  const hit = TOOTH_CACHE.get(key)
  if (hit) return hit
  const ring = cyc
    ? cycloidalRing({ m, z, backlash, ...cyc })
    : toothedRing(m, z, alpha, backlash)
  // THE ROOT FILLET IS CAPPED BY THE SPACE IT HAS TO SIT IN, and only a
  // cycloidal wheel can hit that cap.
  //
  // `roundConcave` is a closing, so its disc has to be able to ENTER the tooth
  // space at all — past `2f > width` it jams at the mouth and fills the whole
  // slot from the pitch line down, which is the escape wheel's gullet lesson
  // over again. On an involute wheel the space is `π·m/2`-ish and scales with
  // the module, so `0.38·m` (the rack tip radius) always fits. A LANTERN'S space
  // does not scale: the tooth is cut to `π·m − pin Ø − backlash`, so the space is
  // the PIN plus the backlash, an absolute figure. Take the module up with a
  // fixed pin and the disc outgrows the slot — a 30t Ø5 10-pin pair went solid
  // between the teeth above m6.97 (`2 × 0.38m > 5.3`), and the pins then fouled
  // by 2 mm on a wheel whose outline still looked entirely reasonable. It only
  // came up once tooth size started tapering per mesh; at one module for the
  // whole clock the pin was always a sensible fraction of it.
  //
  // 0.45 leaves the disc a tenth of the slot's width clear, and is not binding
  // on any pair where the pin is a normal fraction of the pitch — every gear
  // cut before this is byte-identical.
  const fillet = cyc
    ? Math.min(ROOT_FILLET * m, 0.45 * (Math.max(0.1, cyc.pinDia) + Math.max(0, backlash)))
    : ROOT_FILLET * m
  const rings = roundConcave([ring], fillet)
  if (TOOTH_CACHE.size >= TOOTH_CACHE_MAX) TOOTH_CACHE.delete(TOOTH_CACHE.keys().next().value!)
  TOOTH_CACHE.set(key, rings)
  return rings
}

/** Test hook — the analytic trochoidal root, against the SPACE's centreline, so a
 *  harness can check it against a gear that has actually been hobbed. */
export function __gearTrochoid(m: number, z: number, alpha: number, backlash: number): { r: number; a: number }[] {
  return rackTrochoid(m, z, alpha, backlash)
}

/** Test hook — the memo is module-scope, so a perf test has to be able to clear it. */
export function __resetGearCache(): void { TOOTH_CACHE.clear() }

/** Test hook — the toothed ring BEFORE the root-fillet closing, so a harness can
 *  tell a geometry error from the resampling that closing does to the whole
 *  outline (it offsets a polyline by its own vertex normals, twice). */
export function __gearRingRaw(spec: GearSpec): Pt[] {
  const m = Math.max(0.05, spec.module)
  const z = Math.max(4, Math.round(spec.teeth))
  const cyc = cycOf(spec)
  return cyc
    ? cycloidalRing({ m, z, backlash: Math.max(0, spec.backlash), ...cyc })
    : toothedRing(m, z, clamp(spec.pressureAngle, 5, 35) * (Math.PI / 180), Math.max(0, spec.backlash))
}

// ─── Tooth count and pitch radius ─────────────────────────────────────────────
//
// Two gears of the same module a few teeth apart are hard to tell apart once they
// are off the machine: the outside diameters differ by 2m, and nobody counts 47
// teeth by eye. So the count is engraved on the gear — and with it the PITCH
// RADIUS, because that is the number the pair is actually built around: two gears
// mesh when their pitch circles are tangent, so the centre distance is one gear's
// pitch radius plus the other's, and a gear that carries its own radius can be
// laid out against any partner with one addition and no arithmetic about modules.
//
// It is set in the single-STROKE face (Relief SingleLine), which is what makes it
// worth cutting on a gear at all: the glyphs are open strokes, so a V-bit or an
// engraving bit follows them in one pass — there is no outline to pocket out.
//
// It runs OUTWARD ALONG THE RIGHT-HAND SPOKE, on the axis, starting clear of the
// bore. `spokeWindows` lays window i from angle i·step, so there is always a spoke
// centred on +X — which is the roomiest line on the whole gear, and the reason the
// text can be a line long enough to carry two figures. The material under it is
// the hub disc out to `hubR`, then the spoke: the sides of a spoke are the lines
// y = ±hw (that is what `radial` traces), so everything with |y| ≤ hw and
// 0 ≤ x ≤ rimInner is one continuous run of stock, and the window fillets only add
// to it. A solid web has no spoke to follow and no window to avoid, so there the
// bound is simply the root circle.
//
// Shrunk to fit that run, and DROPPED below `LABEL_MIN_SIZE` — an absent number is
// obvious on the canvas, a number cut through a spoke window is not.

/** Cap height of the text, mm — a size that reads across a workshop. */
export const TOOTH_LABEL_SIZE = 6
/** Shrink no further than this; below it, no text at all. */
const LABEL_MIN_SIZE = 2.5
/** Daylight between the text and the stock it is running down, mm. */
const LABEL_CLEAR = 0.75
/** Daylight from the bore, mm — deliberately more than `LABEL_CLEAR`. The bore is
 *  the edge the eye lines the text up against, and a gap that looks generous
 *  against a straight spoke side looks pinched against a circle. */
const LABEL_BORE_CLEAR = 1.6

/** Ink extents of a `d` string, in the same space as the path. */
function inkBox(d: string): { x0: number; y0: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const poly of flattenPath(d, 0.02)) {
    for (const [x, y] of poly) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (!isFinite(x0)) return null
  return { x0, y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Largest scale at which a w×h box, laid on the +X axis with its left edge at
 * `xl`, stays inside radius `R`. Its far CORNERS are what the circle has to clear:
 *
 *     (xl + s·w)² + (s·h/2)² ≤ R²
 *
 * a quadratic in s. Zero when even a vanishing box would not fit.
 */
/**
 * Largest scale at which a w×h box laid FLAT below the centre fits the annulus
 * [ri, ro], with the inner radius it was seated against. The box is pushed as far
 * in as the ring allows — its inner edge rides ri — so the outer radius has to
 * clear its far CORNERS:
 *
 *     (s·w/2)² + (a + s·h)² ≤ R²,     a = ri + clear,  R = ro − clear
 *
 * the same quadratic as `fitInDisc`, with the roles of the two dimensions swapped.
 * This is the ring between a pinion's arbor and its pin holes; the wheel's marking
 * uses the radial mode instead, because a spoke gives it a longer run.
 */
function fitInRing(w: number, h: number, ri: number, ro: number, inner = LABEL_CLEAR): { s: number; a: number } | null {
  const R = ro - LABEL_CLEAR
  const a = ri + inner
  if (R <= 0 || w <= 0 || h <= 0 || a >= R) return null
  const A = (w * w) / 4 + h * h
  const B = 2 * a * h
  const C = a * a - R * R                      // negative, since a < R
  const s = (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A)
  return s > 0 ? { s, a } : null
}

function fitInDisc(w: number, h: number, xl: number, R: number): number {
  const A = w * w + (h * h) / 4
  const B = 2 * xl * w
  const C = xl * xl - R * R
  if (C >= 0 || A <= 0) return 0
  return (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A)
}

export interface GearLabel {
  d: string
  /** What is engraved — the tooth count and the pitch radius. */
  text: string
  /** Cap height actually used — less than `TOOTH_LABEL_SIZE` when the gear was
   *  tight and the text had to be shrunk to fit the spoke. */
  sizeMM: number
}

/**
 * The engraved tooth count and pitch radius, placed and sized for this gear.
 *
 * Null means there is nothing to emit: it was not asked for, no room beside the
 * bore holds a legible line, or the single-stroke font has not finished loading
 * (it is fetched on demand — a caller that can regenerate should do so once it
 * has, and a caller that is about to REPLACE a gear's paths must wait for it, or
 * the text the gear already carries would be dropped).
 *
 * Always mm, whatever the toolbar is displaying: this is a physical marking on a
 * physical part, so it must not change under a units toggle that touches nothing
 * else about the gear.
 */
export function gearLabel(spec: GearSpec): GearLabel | null {
  if (!spec.toothLabel || !isFontLoaded(SINGLE_LINE_FONT_FAMILY)) return null
  const m = Math.max(0.05, spec.module)
  const z = Math.max(4, Math.round(spec.teeth))
  const rp = (m * z) / 2
  // "24 R48" — count, then the radius to add to a partner's for the centres.
  const text = `${z} R${+rp.toFixed(2)}`

  // The profile's own root: a cycloidal lantern gear may have been cut deeper to
  // clear its pins, and the marking must not run out into that.
  const rf = gearDims(m, z, spec.pressureAngle, spec.backlash, cycOf(spec)).rootDia / 2
  // The bore is only a hole once it is big enough to be emitted; below that the
  // middle is solid stock and the text can start almost at the centre.
  const boreR = clamp(spec.bore / 2, 0, rf - 1)
  const inner = boreR > 0.25 ? boreR : 0
  const xl = inner + (inner > 0 ? LABEL_BORE_CLEAR : LABEL_CLEAR)

  const probe = generateTextD({ type: 'text', x: 0, y: 0, text, fontSize: TOOTH_LABEL_SIZE, fontFamily: SINGLE_LINE_FONT_FAMILY })
  const box = probe ? inkBox(probe) : null
  if (!box || box.w <= 0 || box.h <= 0) return null

  // The line may run all the way out to the root circle: hub disc, then spoke,
  // then — past the window arc — the rim ring, which is solid at every angle. So
  // the disc bound is the same for a spoked gear as for a solid one, and being
  // spoked adds exactly one constraint: the text has to fit BETWEEN the spoke's
  // sides. `hub.spoked` is the same test `spokeWindows` guards on, so it cannot
  // claim a spoke that was not drawn.
  const hub = gearHubOf(spec)
  let s = fitInDisc(box.w, box.h, xl, rf - LABEL_CLEAR)
  if (hub.spoked) {
    const hw = Math.min(gearSpokeW(m, spec.spokeWidth) / 2, (hub.dia / 2) * 0.9)   // as spokeWindows sizes it
    s = Math.min(s, (2 * (hw - LABEL_CLEAR)) / box.h)
  }
  if (!(s > 0)) return null

  s = Math.min(1, s)
  const sizeMM = s * TOOTH_LABEL_SIZE
  if (sizeMM < LABEL_MIN_SIZE) return null

  // `generateTextD` is linear in size about its origin, so the probe's ink box
  // scales with s — the final string needs no second measurement, only the offset
  // that puts its left edge at `xl` and centres it on the spoke's axis.
  const d = generateTextD({
    type: 'text', text, fontSize: sizeMM, fontFamily: SINGLE_LINE_FONT_FAMILY,
    x: spec.cx + xl - s * box.x0,
    y: spec.cy - s * (box.y0 + box.h / 2),
  })
  return d ? { d, text, sizeMM } : null
}

// ─── The lantern pinion ───────────────────────────────────────────────────────
//
// The mate, drawn from the wheel's own parameters — pin count and pin diameter are
// already what shaped the teeth, so there is nothing left to ask for.
//
// A lantern pinion is two round CHEEKS with dowels between them, and the geometry
// only makes sense once you see where the wheel goes: its teeth reach INSIDE the pin
// circle (that is how a tooth gets behind a pin to push it), so the cheeks cannot
// clear the teeth radially at all — the wheel runs between them, axially. Which is
// what frees the cheek to be bigger than the pin circle and to enclose the holes
// properly. Two cheeks per pinion, and the wheel must be thinner than the gap.
//
// It is drawn CLEAR of the wheel rather than at the centre distance. Overlapping
// outlines would be the truth of the assembly — in plan view the cheek does cover
// the wheel's teeth — but they are two parts to be cut, not an assembly drawing,
// and geometry that overlaps is a nuisance to machine. The panels print the real
// centre distance instead, which is the number a clock plate is laid out from.

const PIN_RIM = 0.5        // × module — stock left outside a pin hole (min 1.5 mm)
const PINION_GAP = 0.5     // × module — daylight between wheel tips and cheek (min 2 mm)

export interface PinionDims {
  /** Cheek disc diameter — big enough to enclose the pin holes with a rim. */
  cheekDia: number
  /** Pin centres ride this: the pinion's pitch circle. */
  pinCircleDia: number
  pins: number
  pinDia: number
  /** Where the PAIR runs — pitch circles tangent. NOT where the pinion is drawn. */
  centreDistance: number
  /** Wood left between two neighbouring pin holes, mm. Negative means they merge. */
  pinGap: number
}

/**
 * The pinion this wheel CARRIES on its own arbor, or null for one that carries
 * none. See `GearSpec.arborPins` — the wheel is one of that pinion's two cheeks.
 */
export function carriedPinion(spec: GearSpec): PinRing | null {
  const m = Math.max(0.05, spec.module)
  const pins = Math.round(spec.arborPins ?? 0)
  return pinRing(
    pins,
    // A lantern's pins ride its PITCH circle, radius m·P/2 — the same rule the
    // teeth are cut to, so the default is right whenever the two meshes share a
    // module.
    spec.arborPinCircleDia ?? m * pins,
    spec.arborPinDia ?? spec.pinDia,
  )
}

/** The mating pinion's numbers, or null for a gear that has no lantern mate. */
export function pinionDims(spec: GearSpec): PinionDims | null {
  const cyc = cycOf(spec)
  if (!cyc) return null
  const m = Math.max(0.05, spec.module)
  const z = Math.max(4, Math.round(spec.teeth))
  const pins = Math.max(2, Math.round(cyc.mateTeeth))
  const pinDia = Math.max(0.1, cyc.pinDia)
  const rPin = describingRadius(m, pins)                 // = the pinion's pitch radius
  const rim = Math.max(1.5, PIN_RIM * m)
  return {
    cheekDia: 2 * (rPin + pinDia / 2 + rim),
    pinCircleDia: 2 * rPin,
    pins,
    pinDia,
    centreDistance: (m * z) / 2 + rPin,
    // Chord between neighbouring pin centres, less a pin.
    pinGap: 2 * rPin * Math.sin(Math.PI / pins) - pinDia,
  }
}

/**
 * The pinion's marking: its own PITCH RADIUS, e.g. "R16".
 *
 * Which is the number a clock plate is laid out from — the wheel carries "24 R48",
 * the pinion "R16", and 48 + 16 is the centre distance, arbor to arbor. Marked on
 * the cheek so that arithmetic survives the parts being cut, unpacked and picked up
 * months later, which is why the wheel carries its own.
 *
 * The pin COUNT is deliberately left off, though the wheel engraves its tooth count.
 * The wheel does that because nobody counts 47 teeth by eye — and nobody needs to
 * count six pins. Leaving it off halves the width, and a cheek has very little room:
 * the only solid ground on one is the ring between the arbor hole and the pin holes,
 * and "8 R16" did not fit a 6-pin m4 cheek at any legible size. The mark sits flat
 * below the arbor in that ring, shrunk to fit, dropped if illegible.
 */
export function pinionLabel(spec: GearSpec): GearLabel | null {
  const p = pinionDims(spec)
  if (!p || !spec.emitPinion || !spec.toothLabel) return null
  if (!isFontLoaded(SINGLE_LINE_FONT_FAMILY)) return null
  const rC = p.pinCircleDia / 2
  const text = `R${+rC.toFixed(2)}`

  const probe = generateTextD({ type: 'text', x: 0, y: 0, text, fontSize: TOOTH_LABEL_SIZE, fontFamily: SINGLE_LINE_FONT_FAMILY })
  const box = probe ? inkBox(probe) : null
  if (!box || box.w <= 0 || box.h <= 0) return null

  // Solid ring: outside the arbor hole, inside the pin holes.
  const cheekR = p.cheekDia / 2
  const boreR = clamp(spec.bore / 2, 0, cheekR - 1)
  // Standing off the arbor by the plain clearance rather than the wheel's wider
  // LABEL_BORE_CLEAR: that extra millimetre is an aesthetic nicety on a wheel's open
  // face, and on a cheek this crowded it is the difference between a mark and none.
  const fit = fitInRing(box.w, box.h, boreR > 0.25 ? boreR : 0, rC - p.pinDia / 2)
  if (!fit) return null
  const s = Math.min(1, fit.s)
  const sizeMM = s * TOOTH_LABEL_SIZE
  if (sizeMM < LABEL_MIN_SIZE) return null

  const { cx, cy } = pinionCentre(spec)
  const yc = fit.a + (s * box.h) / 2
  const d = generateTextD({
    type: 'text', text, fontSize: sizeMM, fontFamily: SINGLE_LINE_FONT_FAMILY,
    x: cx - s * (box.x0 + box.w / 2),
    y: cy - yc - s * (box.y0 + box.h / 2),
  })
  return d ? { d, text, sizeMM } : null
}

/**
 * Where the pinion is drawn — clear of the wheel, along +X, and TOP-ALIGNED
 * with it rather than sharing its centre line.
 *
 * Two discs side by side on one centre line come closest exactly along that
 * line, so the daylight between them IS the horizontal gap and nothing more.
 * Offset the smaller one so their tops are level and the centres are
 * `√(dx² + dy²)` apart instead of `dx`, which buys clearance for free: the
 * cutter has to travel between two curved walls, and at the pinch point it was
 * getting only `PINION_GAP` of it. Nothing about the PAIR changes — the pinion
 * is drawn clear of the wheel either way and the centre distance a plate is
 * drilled from is reported, never measured off the drawing.
 *
 * It costs no stock: the cheek is smaller than the wheel on any normal count, so
 * the wheel still sets the bounding box and the whole group is the same height.
 */
function pinionCentre(spec: GearSpec): { cx: number; cy: number } {
  const m = Math.max(0.05, spec.module)
  const p = pinionDims(spec)!
  const raWheel = gearDims(m, spec.teeth, spec.pressureAngle, spec.backlash, cycOf(spec)).outsideDia / 2
  const cheekR = p.cheekDia / 2
  return {
    cx: spec.cx + raWheel + cheekR + Math.max(2, PINION_GAP * m),
    cy: spec.cy + raWheel - cheekR,
  }
}

/** Cheek outline and pin holes, placed clear of the wheel. */
function pinionParts(spec: GearSpec): GearPart[] {
  const p = pinionDims(spec)
  if (!p || !spec.emitPinion) return []
  const cheekR = p.cheekDia / 2
  const { cx, cy } = pinionCentre(spec)

  const out: GearPart[] = [
    { key: 'pinion', d: ringToD(ellipseRing(cx, cy, cheekR, cheekR), true) },
  ]
  const rHole = p.pinDia / 2
  const rC = p.pinCircleDia / 2
  const holes: string[] = []
  for (let i = 0; i < p.pins; i++) {
    const a = (i * 2 * Math.PI) / p.pins
    holes.push(ringToD(ellipseRing(cx + rC * Math.cos(a), cy + rC * Math.sin(a), rHole, rHole), false))
  }
  out.push({ key: 'pinholes', d: holes.join(' ') })

  // The arbor hole, on the same reasoning as the wheel's: its own part, because it
  // is its own cut at its own diameter. Only when the wheel has a bore to copy.
  const boreR = clamp(spec.bore / 2, 0, cheekR - 1)
  if (boreR > 0.25) out.push({ key: 'pinionbore', d: ringToD(ellipseRing(cx, cy, boreR, boreR), false) })

  // The pinion's pitch circle, on the same switch as the wheel's — and it is the
  // one that makes the layout obvious, because it runs exactly THROUGH the pin
  // centres. That is the whole answer to "which radius do I space them by": the
  // pinion's pitch radius is arbor to pin CENTRE, and the two pitch circles are
  // tangent when the pair is correctly spaced. A reference, not a cut.
  if (spec.pitchCircle) {
    out.push({ key: 'pinionpitch', d: ringToD(ellipseRing(cx, cy, rC, rC), false) })
  }

  // Its own marking — the pitch radius to add to the wheel's.
  const label = pinionLabel(spec)
  if (label) out.push({ key: 'pinionlabel', d: label.d })
  return out
}

/** A gear's parts, each of which wants its OWN operation. */
export type GearPartKey = 'teeth' | 'spokes' | 'bore' | 'hub' | 'arborpins' | 'label' | 'pitch' | 'pinion' | 'pinholes' | 'pinionbore' | 'pinionpitch' | 'pinionlabel'

export interface GearPart {
  key: GearPartKey
  d: string
}

/**
 * The gear as separate paths rather than one compound path — teeth, spokes,
 * bore, and the pitch-circle reference if it was asked for. Empty parts are
 * omitted.
 *
 * They are split because they are three different CUTS, and a compound path
 * cannot express that: a profile reads it as one region, so `side: 'outside'`
 * follows the outer boundary and nothing else. Handing the user one path means
 * either the bore and spokes go uncut, or — if the path is split afterwards to
 * reach them — the outside profile is lost with it. Emitting the parts up front
 * lets each take the operation it actually wants: the teeth profiled outside,
 * the spokes and bore profiled inside.
 */
export function generateGearParts(spec: GearSpec): GearPart[] {
  const m = Math.max(0.05, spec.module)
  const z = Math.max(4, Math.round(spec.teeth))
  const alpha = clamp(spec.pressureAngle, 5, 35) * (Math.PI / 180)
  const cyc = cycOf(spec)
  // Everything inside the teeth hangs off the root circle, and the two profiles
  // put it in different places — so ask for the profile's own root.
  const rf = rootRadius(m, z, cyc)
  const place = (r: Pt[]) => r.map(([x, y]) => [x + spec.cx, y + spec.cy] as Pt)

  // One closing fills every root corner at once with the rack-tip radius, and
  // leaves the convex tooth tips exactly where the involute put them — memoised,
  // because it is the whole cost of the gear and none of these four numbers
  // change when the bore, hub or spokes do.
  const outline = toothedOutline(m, z, alpha, Math.max(0, spec.backlash), cyc)
  const out: GearPart[] = [{
    key: 'teeth',
    d: outline.map((r) => ringToD(place(r), true)).join(' '),
  }]

  const boreR = clamp(spec.bore / 2, 0, rf - 1)
  if (boreR > 0.25) out.push({ key: 'bore', d: ringToD(place(ellipseRing(0, 0, boreR, boreR)), false) })

  // Windings stay as they were: these are holes in the blank, so CW, which is
  // what anything reading them as regions expects.
  const hub = gearHubOf(spec)
  const windows = spokeWindows(
    Math.round(spec.spokes), rf - gearRimW(m, spec.rimWidth), hub.dia / 2, gearSpokeW(m, spec.spokeWidth),
  )
  if (windows.length > 0) {
    out.push({ key: 'spokes', d: windows.map((r) => ringToD(place(r), false)).join(' ') })
  }

  // The pins this wheel carries for the pinion on its own arbor. Their own part
  // because they are their own cut — drilled, not profiled — and they fall in
  // the hub, which `gearHub` has already grown to hold them.
  const carried = carriedPinion(spec)
  if (carried) {
    out.push({
      key: 'arborpins',
      d: pinRingHoles(spec.cx, spec.cy, carried).map((r) => ringToD(r, false)).join(' '),
    })
  }

  // Open strokes, already in place — its own path because it is engraved, not
  // profiled, and because a user who does not want it deletes one path.
  const label = gearLabel(spec)
  // The hub as its own circle, when asked. It has to be its own part because
  // nothing else draws it reliably: the spoke windows imply it, but only where
  // there IS a window — take a wheel to a spoke count whose windows come out as
  // slivers and the fillets eat the inner arc entirely, and a solid wheel has no
  // window at all. For the drive wheel that circle is the drum, so inferring it
  // from whatever the spokes happen to leave is not good enough.
  if (spec.hubCircle) {
    const hubR = hub.dia / 2
    if (hubR > boreR + 0.25) out.push({ key: 'hub', d: ringToD(place(ellipseRing(0, 0, hubR, hubR)), false) })
  }

  if (label) out.push({ key: 'label', d: label.d })

  // A reference, not a cut — see GearSpec.pitchCircle. Its own path so it can be
  // deleted without touching anything that is going to be machined.
  if (spec.pitchCircle) {
    out.push({ key: 'pitch', d: ringToD(place(ellipseRing(0, 0, (m * z) / 2, (m * z) / 2)), false) })
  }

  // The mate, if asked for — cheek, pin holes, arbor.
  out.push(...pinionParts(spec))
  return out
}

// ─── Running the pair ─────────────────────────────────────────────────────────
//
// A gear is drawn alone and its mate is drawn CLEAR of it, so the one question a
// drawing cannot answer is the only one that matters: do the two actually run
// together? That is what `gearMesh` and `gearPose` are for, and what the canvas
// Animate button shows — the mate slid onto the true centre distance and the
// pair turned.
//
// PHASE IS THE WHOLE OF IT. Tooth 0 is centred on angle 0 (both profiles build
// their teeth at `i · pitch`), so with the mate placed along +x the gear puts a
// tooth straight down the line of centres. The mate must therefore present a
// SPACE there, or the two are drawn one on top of the other. Which is a half
// pitch of the MATE, not of the gear:
//
//   a mate gear   — teeth at θ + j·2π/z₂, spaces at θ + (j+½)·2π/z₂ → θ₀ = π − π/z₂
//   a lantern     — pins  at θ + j·2π/P,  the gap between two of them → θ₀ = π + π/P
//
// Get it wrong and nothing errors: the preview just shows two solids passing
// through each other, which is why `scripts/gear-mesh-check.mts` measures it.
//
// THAT CENTRES THE MATE IN ITS PLAY, which is not how a pair runs. Under load
// the driver's tooth rests on one flank and the whole of the play shows as a gap
// behind it, and that is worth seeing — it is the only way a drawing tells you
// how much slop the pair has. The play is a length along the common pitch line
// and needs no search to find:
//
//     play = circular pitch − the mate's width there − this gear's tooth
//
// (the mate's width being a tooth for a gear and a PIN for a lantern), which
// measures against the emitted outlines to 0.005 mm. Half of it, taken at the
// mate's pitch radius, is the shift onto the driving flank. Two gears of equal
// backlash come out at exactly the backlash, as they must; a lantern comes out
// at whatever the pin leaves, which is a good deal more.
//
// WHICH FLANK IS THE DRIVING ONE DEPENDS ON WHICH WAY THE GEAR TURNS, so
// `driveSense` says. A cycloidal wheel previewed on its own is turned the way
// its own `actingSense` says (`poseSense`), because a lantern wheel HAS a
// direction — the back relief is cut off the flank that never meets a pin; an
// involute gear has none and keeps the CCW default. A clock train is a chain of
// external meshes and its wheels therefore turn ALTERNATELY, so half of them run
// the other way and take the play up on the other side of the pin. Nothing errors
// when it is wrong — the pair still runs, with the slop drawn ahead of the drive
// instead of behind it, which reads as the PINION driving the WHEEL.

export type GearMateKind = 'lantern' | 'gear'

export interface GearMesh {
  /** A cycloidal wheel is cut for a LANTERN and can only be shown against one;
   *  an involute gear is shown against a second gear of `mateTeeth` teeth. */
  kind: GearMateKind
  /** Teeth on the mate — PINS, for a lantern. */
  mateTeeth: number
  /** Arbor to arbor, pitch circles tangent. Where the pair really runs, as
   *  against where the parts are drawn. */
  centreDistance: number
  pitchRadius: number
  matePitchRadius: number
  /** Mate degrees per degree of the gear. Opposite sense — an external mesh. */
  ratio: number
  /** The mate's rotation, in degrees, when the gear is at zero: the space put on
   *  the line of centres, shifted onto the driving flank by half the play. */
  matePhaseDeg: number
  /** Free play at the mesh, mm at the pitch line — what the pair will lose to
   *  slop before the drive takes up. For two gears this IS the backlash they
   *  were cut with; for a lantern it is whatever the pin leaves in the space,
   *  which the panels report because nothing else shows it. */
  playAtPitch: number
  /** Lantern only, both 0 otherwise. */
  pinDia: number
  cheekDia: number
}

/**
 * How this gear meshes, and with what.
 *
 * `driveSense` is the direction THIS gear turns, CCW positive — it drives, the
 * mate follows. It only moves the mate within its play, onto the flank the gear
 * is actually pushing (see above); every other number here is indifferent to it.
 */
export function gearMesh(spec: GearSpec, driveSense: 1 | -1 = 1): GearMesh {
  const m = Math.max(0.05, spec.module)
  const z = Math.max(4, Math.round(spec.teeth))
  const cyc = cycOf(spec)
  const pitchRadius = (m * z) / 2
  const circularPitch = Math.PI * m
  const tooth = gearDims(m, z, spec.pressureAngle, spec.backlash, cyc).toothThickness
  // Half the play, at the mate's pitch radius, is the turn that takes the mate
  // off centre and onto the flank the gear is driving. With the gear running CCW
  // the mate runs CW, and its material at the pitch point moves −y as its angle
  // grows — the driver's tooth sits BEHIND the mate's, so the mate's teeth stand
  // back by half the play and the shift is POSITIVE on the mate. Reverse the
  // gear and the whole picture mirrors: the drive takes up on the other flank.
  const settle = (play: number, mateR: number) =>
    (driveSense * (Math.max(0, play) / 2 / Math.max(1e-6, mateR)) * 180) / Math.PI

  if (cyc) {
    const p = pinionDims(spec)!
    const mateR = p.pinCircleDia / 2
    // A pin's width at the pitch line is the pin itself — it is a cylinder
    // sitting on the pitch circle, not a tooth spanning it.
    const play = circularPitch - p.pinDia - tooth
    return {
      kind: 'lantern',
      mateTeeth: p.pins,
      centreDistance: p.centreDistance,
      pitchRadius,
      matePitchRadius: mateR,
      ratio: z / p.pins,
      matePhaseDeg: 180 + 180 / p.pins + settle(play, mateR),
      playAtPitch: Math.max(0, play),
      pinDia: p.pinDia,
      cheekDia: p.cheekDia,
    }
  }
  // An involute gear is shown against a second gear. `mateTeeth` is a tooth-FORM
  // parameter on a cycloidal wheel and only a preview setting here — it changes
  // nothing about the gear itself, which is what the panel has to say.
  const z2 = Math.max(4, Math.round(Number.isFinite(spec.mateTeeth) ? spec.mateTeeth : 8))
  const mateR = (m * z2) / 2
  // Both halves of a pair are thinned by half the backlash, so this comes out at
  // the backlash exactly — which is the point of stating it that way.
  const play = circularPitch - gearDims(m, z2, spec.pressureAngle, spec.backlash, undefined).toothThickness - tooth
  return {
    kind: 'gear',
    mateTeeth: z2,
    centreDistance: (m * (z + z2)) / 2,
    pitchRadius,
    matePitchRadius: mateR,
    ratio: z / z2,
    matePhaseDeg: 180 - 180 / z2 + settle(play, mateR),
    playAtPitch: Math.max(0, play),
    pinDia: 0,
    cheekDia: 0,
  }
}

export interface GearPose {
  /** Gear rotation about its own centre, degrees, CCW positive. */
  gearDeg: number
  /** Mate rotation about ITS centre, which sits `centreDistance` along +x. */
  mateDeg: number
}

/**
 * Where the two stand at a given moment. `phase` counts TEETH of the gear and
 * runs on past 1 — nothing resets, so a preview can free-run.
 *
 * A gear train has no kinematics to model beyond its ratio: the whole point of a
 * conjugate profile is that the ratio is constant, which is exactly what the
 * preview is there to let someone check by eye.
 */
export function gearPose(spec: GearSpec, phase: number): GearPose {
  const sense = poseSense(spec)
  const mesh = gearMesh(spec, sense)
  const z = Math.max(4, Math.round(spec.teeth))
  const gearDeg = (sense * phase * 360) / z
  return { gearDeg, mateDeg: mesh.matePhaseDeg - gearDeg * mesh.ratio }
}

/**
 * Which way the preview turns a gear.
 *
 * A CYCLOIDAL wheel has a real direction and the panel's `Runs` field sets it:
 * the back relief is cut off the flank that never touches a pin, so turned the
 * wrong way the preview shows the wheel driving with the flank that was cut
 * away. It also decides which side of its play the mate settles on, which is the
 * only thing in the drawing that says which body is driving. The default
 * `actingSense` of −1 means CW, so the preview was backwards on a default wheel
 * as well as unresponsive to the field.
 *
 * An INVOLUTE gear has no direction: its teeth are symmetric, nothing in the UI
 * sets `actingSense`, and that −1 default is a statement about which flank the
 * cycloidal generator DRAWS, not about a gear with no acting flank. So it keeps
 * the CCW it has always been previewed at.
 */
function poseSense(spec: GearSpec): 1 | -1 {
  return cycOf(spec) ? gearRotationSense(spec) : 1
}

/**
 * The mate's own geometry, in ITS frame with its arbor at the origin and at
 * phase zero — the caller places it at the centre distance and turns it.
 *
 * A lantern is drawn as its PINS, and its cheek only as a dashed circle. That is
 * not a shortcut: a lantern's cheeks are larger than its pin circle and the
 * wheel's teeth reach INSIDE that circle, so in plan view the cheek genuinely
 * covers the teeth — the wheel runs BETWEEN the two cheeks, axially. Drawn solid
 * it reads as a catastrophic collision; drawn dashed it reads as what it is,
 * something on another plane. The pins are the whole of the mesh anyway.
 */
export function gearMateParts(spec: GearSpec): { solid: string; ghost: string } {
  const mesh = gearMesh(spec)
  if (mesh.kind === 'lantern') {
    const rC = mesh.matePitchRadius, rPin = mesh.pinDia / 2
    const pins: string[] = []
    for (let i = 0; i < mesh.mateTeeth; i++) {
      const a = (i * 2 * Math.PI) / mesh.mateTeeth
      pins.push(ringToD(ellipseRing(rC * Math.cos(a), rC * Math.sin(a), rPin, rPin), true))
    }
    const boreR = clamp(spec.bore / 2, 0, mesh.cheekDia / 2 - 1)
    const ghost = [ringToD(ellipseRing(0, 0, mesh.cheekDia / 2, mesh.cheekDia / 2), true)]
    if (boreR > 0.25) ghost.push(ringToD(ellipseRing(0, 0, boreR, boreR), false))
    return { solid: pins.join(' '), ghost: ghost.join(' ') }
  }
  // A second gear, cut to the same module and pressure angle and given the same
  // backlash — both halves of a pair give up half of it, which is what makes the
  // figure on one gear mean the play at the mesh.
  const mate: GearSpec = {
    ...spec, cx: 0, cy: 0, teeth: mesh.mateTeeth,
    emitPinion: false, toothLabel: false, pitchCircle: false,
  }
  return { solid: generateGearParts(mate).map((p) => p.d).join(' '), ghost: '' }
}

/**
 * Both pitch circles of the running pair, placed — the gear at its own centre
 * and the mate at the centre distance.
 *
 * Drawn whatever `spec.pitchCircle` says, because in this one view they are the
 * proof rather than a reference: two gears mesh when their pitch circles are
 * TANGENT, so a pair spaced right shows the two just touching at the mesh, and
 * a lantern's runs exactly through its pin centres.
 */
export function gearMeshRefD(spec: GearSpec): string {
  const mesh = gearMesh(spec)
  const c = (x: number, r: number) => ringToD(ellipseRing(x, spec.cy, r, r), false)
  return [c(spec.cx, mesh.pitchRadius),
    c(spec.cx + mesh.centreDistance, mesh.matePitchRadius)].join(' ')
}

/** Every part in one compound path — the live drag preview, and the fallback for
 *  anywhere that still wants a single `d` for a gear. */
export function generateGearD(spec: GearSpec): string {
  return generateGearParts(spec).map((p) => p.d).join(' ')
}

/** Module that makes a gear of this outer radius — used when placing by drag. */
export function moduleForRadius(radius: number, teeth: number): number {
  const z = Math.max(4, Math.round(teeth))
  return Math.max(0.05, (2 * Math.max(0.5, radius)) / (z + 2 * ADDENDUM))
}
