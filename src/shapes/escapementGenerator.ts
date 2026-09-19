// ─── Recoil and deadbeat escapements, with the pallets that suit them ────────
//
// An escapement is a PAIR, and neither half means anything on its own: the
// pallet faces are the loci of the wheel's tooth tips, so a wheel and an anchor
// drawn from different numbers do not run together at all. Both come out of one
// spec here for that reason — the same call that cuts the wheel cuts its anchor.
//
// THE CLASSIC CONSTRUCTION. The pallets sit `span` teeth apart, so they subtend
// β = span·2π/N at the wheel centre. Put the anchor arbor where the two TANGENTS
// to the tip circle at those points cross:
//
//     L = R / cos(β/2)     arbor to wheel centre
//     ρ = R · tan(β/2)     arbor to either pallet
//
// Everything good about the escapement follows from that tangency. AP ⟂ OP, so a
// face concentric with the arbor is RADIAL to the wheel — the tooth pushes it
// edge-on and cannot unlock itself, which is what "dead" means. And the arms lie
// along tangent lines, so they clear the tip circle everywhere except at the one
// point where they are supposed to touch it.
//
// SPAN MUST BE A HALF-INTEGER. The wheel advances exactly half a tooth per beat,
// so the two pallets have to stand an odd number of half-pitches apart or one
// releases without the other catching. 7.5 teeth of 30 is the everyday case.
//
// THE FACES ARE GENERATED, NOT DRAWN. A tooth acts by its TIP, which is a point,
// so the face it slides on is simply the path that point takes in the anchor's
// own frame — the same reasoning that makes a lantern pinion's epicycloid the
// path of a pin centre. Roll the wheel forward by the impulse angle while the
// anchor turns by the lift, transform the tip into anchor coordinates as you go,
// and the curve you get IS the impulse face. Both escapements share it:
//
//   DEADBEAT — before impulse, the wheel is held. Freeze it and let the anchor
//   carry on: the locus becomes an arc about the arbor, which is the dead lock,
//   with `draw` tilting it a couple of degrees so the tooth pulls the pallet in
//   rather than pushing it out.
//
//   RECOIL — nothing is held. Let both keep turning past the start of impulse
//   and the wheel is driven BACKWARDS, which is exactly what a recoil escapement
//   does with the pendulum's supplementary arc.
//
// One consequence worth knowing: the entry and exit faces are NOT mirror images.
// The wheel turns the same way for both, so the two loci genuinely differ. Every
// hand construction draws them symmetric; this one does not have to.
//
// The wheel advances half a tooth per beat and that is all it has, so
//
//     impulse at the wheel = 180°/N − drop
//
// which is why `drop` is an input and the wheel's share of the impulse is not.
//
// DROP LOCK. A tooth arrives by falling, and it has to fall onto DEAD FACE. Lay
// the two loci out as above and it does not: each pallet's impulse begins at the
// exact anchor angle at which the other one releases, so the arriving tooth
// meets the corner where the locking face turns into the impulse face — and the
// running clearance then carries it a few tenths PAST that corner, onto a face
// lying some 50° off the wheel's radius. It does not lock there; it slides, and
// the escapement trips through every beat. The drawing shows nothing wrong.
//
// The fix is not to extend the dead face past the corner. That is the obvious
// move and it cannot work: past the corner is where the impulse face goes, so
// the extension is buried by the boolean and the pallet comes out exactly as it
// was. What has to move is the corner. Each pallet's whole profile is turned
// about the arbor — the entry by +D/2, the exit by −D/2 — so the two embrace
// D more of the anchor's travel than the bare loci do, and a tooth released by
// one lands D deep on the other's dead face. That D is the DROP LOCK: the lock
// the escapement has at the instant of the drop, as against the lock it runs to
// once the pendulum has carried the pallet the rest of the way in.
//
// It costs D/2 of extra swing before either pallet will unlock, which is what a
// real escapement pays for it too. D is a LENGTH of face (`LANDING_DEPTH`), and
// it is the margin every error in the build is paid out of.
//
// THE ANCHOR CLEARS THE WHEEL BY WHERE IT IS PUT, not by being cut back. Each arm
// runs along its tangent line, rotated off it by the half swing so it lands ON
// the tangent at the extreme and outside it everywhere else; only the pallets go
// inside the tip circle, which is what pallets are for. Relieving the body with
// the swept tip circle instead — the obvious move — is wrong twice over: it is
// far too conservative (the teeth are thin spikes and an anchor sits BETWEEN
// them) and it cuts the pallets off the arms it was meant to leave them on.
// Whether the two really clear is settled by running the mesh, not by the
// outline: `scripts/escapement-check.mts`.
//
// Emitted as separate parts — wheel, spokes, bore, anchor, anchor bore — because
// they are different cuts, and drawn CLEAR of each other rather than in mesh:
// these are two parts to go on the stock, and the number that matters (the true
// centre distance) is a readout, not something to scale off the drawing.

import {
  type Pt, clamp, arcInto, ellipseRing, roundRectRing,
  boolRings, roundConcave, ringToD,
} from './polyOps'
import { seatHub, spokeWindows, pinRing, pinRingHoles, type HubFit, type PinRing } from './spokedWheel'
import { getTreatableCorners, applyCornerTreatments } from '../tools/cornerTreatment'

export type EscapementType = 'recoil' | 'deadbeat'

export interface EscapementSpec {
  cx: number; cy: number
  escType: EscapementType
  /** Escape wheel tooth count. 30 makes a seconds pendulum beat seconds. */
  teeth: number
  /** Tip circle diameter — the wheel's overall size. */
  wheelDia: number
  /** Tip circle to root circle, mm. */
  toothDepth: number
  /** Free travel of the wheel between one tooth releasing and the next locking,
   *  in WHEEL degrees. What is left of the half tooth pitch is the impulse. */
  drop: number
  /** Impulse measured at the ANCHOR, degrees — the swing the escapement gives
   *  back to the pendulum. */
  lift: number
  /** Deadbeat only: how deep the tooth locks, in anchor degrees. */
  lock: number
  /** Deadbeat only: degrees the locking face leans off concentric so the tooth
   *  draws the pallet IN. Without it the escapement can trip on its own. */
  draw: number
  /** Recoil only: anchor degrees of supplementary swing the faces can absorb.
   *  The wheel is pushed back through all of it. */
  recoilArc: number
  /** Anchor arm and pallet width, mm. */
  armWidth: number
  /** Wheel bore Ø. 0 for none. */
  bore: number
  /** Wheel hub Ø — a FLOOR, grown if the spokes need more room to land on. */
  hubDia: number
  /** 0 for a solid wheel. */
  spokes: number
  /** Anchor arbor Ø. 0 for none. */
  anchorBore: number
  /** The lantern pinion the WHEEL carries on its own arbor — in a clock, the one
   *  the third wheel drives. Its pins go through the wheel's hub and a single
   *  loose cheek caps them; see spokedWheel's pinRing. Stated in PIN CIRCLE Ø
   *  rather than in module, because an escapement has no module of its own —
   *  that circle belongs to the mesh with the wheel before it. Absent for an
   *  escapement drawn on its own, which carries nothing.
   *
   *  It GROWS THE HUB, since the holes must fall in solid stock. */
  arborPins?: number
  arborPinCircleDia?: number
  arborPinDia?: number
  /** Wheel turns clockwise. The teeth lean the way it runs, so this is not
   *  cosmetic — a wheel cut the wrong way round will not lock at all. */
  clockwise: boolean
}

export interface EscapementDims {
  /** Arbor to wheel centre, R/cos(β/2) — the number the clock plate is drilled
   *  from. The two are drawn clear of each other, never at this spacing. */
  centreDistance: number
  /** Arbor to either pallet face, R·tan(β/2). */
  palletRadius: number
  /** Degrees of wheel per tooth, and per beat (half of it). */
  toothPitchDeg: number
  beatDeg: number
  /** Wheel degrees of impulse — the half pitch less the drop. */
  wheelImpulseDeg: number
  /** How far the anchor must swing each side of centre before the escapement
   *  will unlock and impulse. The pendulum has to beat wider than this. */
  minHalfSwingDeg: number
  /** Inclination of the impulse face to the dead arc. The escapement's working
   *  angle: too flat and it will not unlock, too steep and it wastes the drive. */
  impulseAngleDeg: number
  /** Acting face length, mm — what the tooth actually slides along. THE WHOLE of
   *  it: the locking face and the impulse face are one curve with a corner in it,
   *  so this is both, and `impulseWidth` is the impulse part alone. Reporting
   *  this one AS the impulse face is how a 0.6 mm locking face and a 4.6 mm
   *  "impulse face" came to be on screen together, 4.6 being the sum of them. */
  faceWidth: number
  /** The impulse face alone, mm — the acting face less its locking part. */
  impulseWidth: number
  /** Recoil only: wheel degrees pushed back per anchor degree of overswing. */
  recoilRatio: number
  wheelRootDia: number
  hub: HubFit
  /** Teeth spanned by the pallets — derived from the tooth count, not asked for.
   *  See `escapementSpan`. Reported because it is what sets the arbor's distance
   *  and the whole shape of the anchor. */
  span: number
  /** The round on each tooth tip, mm, and the circle its CENTRES lie on. That
   *  circle is the TIP circle — `wheelDia`/2, what the pallets are laid out on
   *  and what `centreDistance` is a question about — and the wheel's material
   *  stands one round proud of it, so it measures `wheelDia` + 2·`tipRound`
   *  across the teeth. See `tipRound`. */
  tipRound: number
  actingRadius: number
  /** The round on each pallet's locking corner, mm — where its locking face turns
   *  into its impulse face, which a tooth has to get over on every beat. Zero on
   *  a recoil anchor, which has no such corner. See `LOCK_ROUND`. */
  lockRound: number
  /** Drop eats the whole half pitch — there is no impulse left. Fatal. */
  noImpulse: boolean
  /** The anchor's hub reaches into the wheel; the relief cut will eat it. */
  hubFouls: boolean
  /** The faces are steep enough that the drive may not unlock them. */
  faceTooSteep: boolean
  /** How far past the tip circle a pallet goes at the end of its swing, mm —
   *  ρ·Φ. The impulse face has to share the tooth SPACE with the tooth it just
   *  locked, so this is the number that decides whether the pair jams. */
  palletDive: number
  /** That dive is too much of the tooth depth to fit in the space beside a
   *  tooth: the pair will bind. Bigger teeth, less lock or lift, or less span. */
  divesTooDeep: boolean
  /** Tooth thickness where it leaves the gullet, mm — the first section that is
   *  the tooth's own material and not the stock joining it to its neighbours.
   *  What has to carry the drive across the grain, and what `TOOTH_BOW` is for.
   *  Measured at the top of the fill, not at the root circle: the fill reaches
   *  well above that, so a thickness taken there is a thickness of solid wheel. */
  toothBase: number
  /** The gullet, mm — the radius of the round that fills the bottom of each tooth
   *  space, sized from the room the pallet leaves rather than from the cutter,
   *  since the pallet never reaches down there. It is also the tightest inside
   *  radius on the wheel, so it says what the biggest cutter that can finish the
   *  teeth is: 2× this. */
  gulletRadius: number
  /** What a tooth locks by at the extreme of the swing, mm — the lock the
   *  escapement really runs to, as against the one that was asked for. Measured
   *  from the pallet's own locking corner, so the round on that corner and the
   *  tip round's own offset are both already taken off. */
  lockDepth: number
  /** What it is already locked by at the instant it LANDS, mm — the drop lock.
   *  The one that decides whether the escapement is a deadbeat at all: land on
   *  no dead face and the tooth arrives on the impulse face and trips. Zero for
   *  a recoil anchor, which is meant to land on its impulse face. */
  dropLockDepth: number
  /** Nothing for the arriving tooth to land on. A deadbeat wants dead face
   *  there and has none; a recoil wants face of any kind and its own does not
   *  reach past the clearance. Either way the wheel runs straight through. */
  noLock: boolean
  /** Deadbeat only: it lands, but on less than `LANDING_DEPTH` — the lock cannot
   *  seat the full landing and still leave the run margin above it. Not fatal on
   *  paper; it is the margin the build's errors are spent from. */
  landingShort: boolean
  /** Deadbeat only: the lock, anchor degrees, that seats the full landing. */
  fullLandingLockDeg: number
}

/** Wheel-side clearance the arms are held off their tangent line by, mm, on top
 *  of the swing they are already rotated back through. Read through `armClear`,
 *  never on its own: the tangent is a tangent to the ACTING circle, and the
 *  wheel's material stands one tip round proud of that. */
const ARM_CLEAR = 0.2
/** What the ENTRY arm's wheel-side flank is held off that tangent by at the
 *  pallet end instead — see `entryTaper`. Set from the measured skim, not
 *  guessed (`scripts/esc-arm-clearance.mts`): it takes that arm from 0.68 mm of
 *  clearance to 1.87 mm, which is where the exit arm already sits, and it is what
 *  stops a RECOIL anchor's entry arm touching the teeth outright. */
const ENTRY_CLEAR = 1.5
/** Fillet on each arm's toe — its far corner, away from the wheel — as a
 *  fraction of the arm width. Nothing touches it: shape only. */
const ARM_TOE = 0.35
/** What a RECOIL's entry blade may stand past the far end of its own acting face,
 *  mm. An eye judgement with a hard floor under it. At 0 the cut is flush with
 *  the end of the acting face — no material past it at all — and the
 *  `carries the locking face straight on into the arm` test fails, which is the
 *  right answer: the face has to run ON past its working end or the tooth reaches
 *  the very edge of it. This is that flush point plus 2 mm of margin. Going the
 *  other way, BELOW zero, the cut eats the acting face itself, and a recoil face
 *  is the travel the pendulum's overswing runs on — `recoilArc` is the honest way
 *  to shorten that. */
const RECOIL_TIP_LAND = 2
/** The RECOIL's entry toe, as a fraction of the arm width — 6 mm on a standard
 *  8 mm arm, against `ARM_TOE`'s 2.8. On that profile the toe IS the spear the
 *  run-out leaves, and rounding it is what takes the point off. See `filletToes`. */
const RECOIL_TOE = 0.75
/** How sharply a vertex must turn to be a corner rather than a sample on a
 *  curve, radians. */
const TOE_MIN_TURN = 0.7
/** Floor on the gullet fillet, mm. Not a design choice: a cutter leaves this much
 *  whatever is drawn. The radius actually used is sized from the room — see
 *  `gulletFillet`. */
const ROOT_FILLET = 0.6
/** Extra depth, as a fraction of the tooth, left clear UNDER the pallet's reach
 *  before the gullet fill is allowed to stand — see `gulletFillet`. The fill's
 *  widest section sits at this depth, so it is the real running clearance
 *  between the pallet's deepest dive and the stock below it. */
const GULLET_KEEP = 0.2
/** The most of the tooth depth the radial tip land may take. It is sized from the
 *  lock; this is the ceiling for a wheel whose lock is a large part of its own
 *  tooth. Past it the land is most of the leading face and the undercut has
 *  nowhere left to run. */
const TIP_LAND_MAX = 0.35
/** Degrees the tip land is relieved off radial. Small on purpose — see the tip
 *  land in `toothGeom`: radial is the angle that beds on the LOCKING face, and
 *  this is the least that keeps the land's inner corner out of the IMPULSE face,
 *  which stands at 53° to it. Calibrated against the mesh, and it is a knee, not a
 *  slope: 0° binds at 0.061 mm, 2° clears at 0.024, 4° is back to the 0.010 the
 *  wheel measures with no land at all, and 6° buys another four thousandths. */
const TIP_RELIEF = 4
/** The round on a tooth TIP, as a fraction of the tooth depth — see `tipRound`.
 *  0.3 mm on the default wheel, which is a tip you can run a thumb along. */
const TIP_ROUND = 0.05
/** Floor and ceiling on it, mm, so that a 40 mm wheel does not get a radius it
 *  cannot spare and a 300 mm one does not get a tip like a thumb. */
const TIP_ROUND_MIN = 0.15
const TIP_ROUND_MAX = 0.8
/** How many tip radii of FLAT land must survive the round, on top of what the
 *  round itself eats — the floor the tip land is grown to when the lock alone
 *  would not leave that much. Under it the round reaches past the land and into
 *  the undercut face below it, and the tooth's own leading face, not the round,
 *  is what a locking face would then meet. */
const LAND_KEEP = 1.2
/** The most of the tooth depth the round's SET-BACK may take — what it costs in
 *  tooth length, which is nothing like its radius. A round inscribed in a corner
 *  sets back r·cot(half the angle), and a deep-toothed wheel comes to a very fine
 *  point: 39° on the default, 8° on a 24 mm tooth, where a third of a millimetre
 *  of radius would eat four and a half millimetres of tooth. So the radius is
 *  capped by what it costs rather than only by itself, which is also what keeps
 *  the apex within reach of the tip circle — see `toothGeom`. */
const TIP_SETBACK = 0.25
/** …and past this many radii of set-back per radius of round, give the round up
 *  altogether. A tooth that comes to a 1° point (a 12 mm tooth on a 40 mm blank,
 *  which is pathological for other reasons) would pay three millimetres of its
 *  own length for thirty microns of radius — the round would be eating the tooth
 *  rather than protecting it, and the corner is so fine that the arc no longer
 *  meets the flanks in any useful way. Leave those tips as they were. */
const TIP_SETBACK_MAX = 30
/** How much of a tooth pitch a pallet may occupy around the wheel — see
 *  `palletNib`. The rest of the space is the drop and the tooth itself. */
const NIB_SPACE = 0.12
/** Degrees the back of a pallet is relieved by — see `palletNib`. */
const BACK_RELIEF = 75
/** How much of the root land the bowed flank may take, so a strip of land is
 *  always left between the two gullet walls — see `flankAngle`.
 *
 *  It is 0.6 rather than 0.3 because there is only ONE bowed flank now: the
 *  leading face is dead straight from the tip round to the root (see
 *  `faceAngle`), so the back takes the whole share the two used to split. That is
 *  what pays for flattening the leading face — it costs 4–8% of the tooth's
 *  section below the pallet's reach, and the back puts most of it back from the
 *  side nothing acts against (`scripts/esc-tooth-shape.mts`: the default wheel's
 *  base goes 4.35 → 4.01 → 4.17, and the section a tenth of the way up from the
 *  root comes out FATTER than before at 6.34). */
const BOW_SHARE = 0.6
/** How far the tooth flanks bow outward, 0…1. Fixed rather than asked for: the
 *  gullet fill buries most of what the bow used to add, so it moves the tooth's
 *  section by ~13% over its whole range — not a decision worth a field.
 *
 *  REMOVING IT WAS TRIED AND REVERTED, 2026-08-13. The apparatus is real
 *  complexity for a small effect, but the effect is not as small as `toothBase`
 *  alone suggests: measured at five depths on eight wheels
 *  (`scripts/esc-tooth-shape.mts`), taking the bow out leaves the tooth IDENTICAL
 *  over its top half — everything the pallet works against — and about a ninth
 *  thinner in the bottom quarter (5.76 → 5.14 mm at a tenth of the depth on the
 *  default wheel, 12.15 → 10.48 on a 200 mm one), with the gullet fill shrinking
 *  2.39 → 2.15 alongside it for reasons that were not run down. Not worth chasing
 *  for the lines it saves. */
const TOOTH_BOW = 0.6
/** Extra depth, as a fraction of the tooth, kept clear below the pallet's reach
 *  before a flank is allowed to bow — see `toothGeom`'s `start`. */
const BOW_KEEP = 0.08
/** Fraction of the tooth pitch taken by the back slope; the rest is root land. */
const BACK_FRAC = 0.55
/** How much of the tooth depth a pallet may dive past the tip circle before its
 *  impulse face starts to reach the tooth it has just locked. Calibrated against
 *  the mesh, not guessed: at 0.44 of the depth both profiles measure exactly
 *  zero interference and at 0.51 the recoil is into the tooth by half a
 *  millimetre. See the sweep in `scripts/escapement-check.mts`. */
const DIVE_LIMIT = 0.45
/** Dead face wanted UNDER a tooth at the instant it lands, mm — the drop lock
 *  the pallets' embrace is built to deliver. See `dropLock`.
 *
 *  This is the margin every build error spends, and all of them spend it the
 *  same way: a centre distance a little long (≈0.7 mm of it per mm), tips cut or
 *  sanded short, pivot slop, a locking corner crushed by the drop. Once it is
 *  gone the tooth lands on the impulse face and the wheel runs through. A wooden
 *  clock ran through on 2026-09-13 when the 0.5 mm then asked for was SHARED with
 *  the run margin below, which left far less than that under the tooth; the two
 *  are separate since, which is also why raising `lock` now deepens the landing.
 *
 *  0.5 mm, down from the 1 mm it was raised to after that failure. The 1 mm was a
 *  safety margin rather than a measured need — a 0.5 mm landing has not failed
 *  (Rick, 2026-09-18) — and it was not free: the embrace that seats the landing
 *  turns both pallets deeper, which is what closes the pallet tip onto the tooth
 *  backs (`escapementToothClearance`), and the lock it takes adds friction. On
 *  the default wheel it cost about 2% of the drive and most of the tip clearance,
 *  and energy and clearance matter more than margin past this. */
export const LANDING_DEPTH = 0.5
/** Below this landing, mm, a short landing is a WARNING; between it and
 *  `LANDING_DEPTH` it is only a note — a working escapement under target, not one
 *  about to fail (Rick, 2026-09-18). Half the target: under it there is little
 *  enough dead face that a quarter of a millimetre of centre distance, or a tip
 *  sanded short, puts the tooth on the corner. */
export const LANDING_WARN = 0.25
/** Landing lost per mm the centre distance is built LONG — what the readout
 *  turns a landing into, since "0.70 mm of landing" says nothing to someone
 *  laying out a plate and "about 1 mm of centre distance" does. */
export const LANDING_PER_CENTRE_MM = 0.7
/** Dead face wanted ABOVE the landing, mm, for the pendulum's supplementary arc
 *  to run the tooth deeper through before it reaches the deep end of the face. */
const RUN_MARGIN = 0.5
/** How much short of `LANDING_DEPTH` the measured landing may come before it is
 *  called short, mm.
 *
 *  It exists because the two pallets do not land the same. Their faces are not
 *  mirror images (the wheel turns the same way for both), so at any embrace one
 *  lands 0.07 mm shallower than the other — and `deadFace` reports the WORSE, as
 *  it should. Without the slack the worse side can never reach the target, so
 *  `landingShort` would fire a few hundredths under the target and `fullLandingLockDeg`
 *  would quote a lock that still warned when it was taken — advice that cannot be
 *  satisfied, which is worse than none. */
const LANDING_SLACK = 0.1
/** The sliding friction assumed at the two acting contacts, for the energy budget
 *  — see `escapementEnergy`. Wood on polished wood, dry: 0.2 is the middle of the
 *  quoted range (0.15 waxed, 0.3 rough), and a wooden movement is what this app
 *  cuts. It is stated in the readout because the ABSOLUTE efficiency moves with
 *  it while the comparison between two sets of parameters barely does, which is
 *  what the number is for. */
const ESC_FRICTION = 0.2

/** A standard 1/8" end mill. The exit pallet's deep-lock corner is relieved to
 *  its radius at the one corner that would otherwise put that radius on an
 *  acting face — see `lockCorner`. */
const LOCK_RELIEF_BIT_DIA = 3.175
/** How much clear face is left beyond the fillet at that corner, mm. */
const LOCK_LAND = 0.4

const rad = (deg: number) => (deg * Math.PI) / 180
const rot = (p: Pt, a: number): Pt => {
  const c = Math.cos(a), s = Math.sin(a)
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}
const norm = (p: Pt): Pt => {
  const n = Math.hypot(p[0], p[1]) || 1
  return [p[0] / n, p[1] / n]
}

/**
 * How many teeth the pallets span — DERIVED from the tooth count, never asked
 * for, because only one family of values works and the user cannot see which.
 *
 * The span must be an ODD NUMBER OF HALF TEETH. The wheel gives up half a tooth
 * per beat, so at 7.5 of 30 (fifteen halves) one pallet locks as the other
 * releases; at 8.0 (sixteen) one releases with nothing to catch it and the wheel
 * runs. This used to be a field with a red warning under it, which is a bad trade
 * — a number the form can compute is not a decision, and a third of the values a
 * spinner offered were fatal.
 *
 * A quarter of the teeth is the classic choice: it puts the pallets a quarter
 * turn apart, so the arms meet at about a right angle and the anchor looks like
 * an anchor. Round that to the nearest odd half — NOT to the nearest half, which
 * lands on a whole tooth for every other count and is exactly the broken case.
 * 30 teeth gives 7.5, which is what the field's default always was.
 */
export function escapementSpan(teeth: number): number {
  const N = Math.max(6, Math.round(teeth))
  return clamp(Math.round(N / 4 - 0.5) + 0.5, 0.5, N / 2 - 0.5)
}

/**
 * THE TOOTH ACTS BY AN ARC, NOT A POINT, and this is that arc's radius.
 *
 * A tooth that comes to a knife edge chips, and the escape wheel's tip is a 39°
 * sliver of end grain with the whole drive on it — so it goes blunt on the first
 * hard lock, and a tip that has lost a tenth of a millimetre has spent a tenth of
 * the landing (`LANDING_DEPTH`). Rounding it is not free, though, because the
 * pallet faces are the loci of the POINT it used to come to: round the tip and
 * leave the faces alone and the tooth beds on a curve the escapement was never
 * drawn for, which is lock and release given away for nothing. So the round is
 * carried all the way through the construction instead:
 *
 *   THE CENTRE OF THE ROUND IS THE ACTING POINT. The classic construction is laid
 *   out on the circle those centres lie on — `frame`'s R, one radius inside the
 *   tip circle — and each pallet face is the locus of that centre OFFSET by the
 *   radius. The same relation a lantern pinion's flank has to the epicycloid of
 *   its pin CENTRE, and for the same reason: what acts is a circle, so the curve
 *   it acts on is the one every one of those circles touches.
 *
 * Nothing about the lock or the impulse changes under that, and neither is an
 * approximation. A face offset from an arc concentric with the arbor is still
 * concentric with it, so the contact normal still runs through the arbor and the
 * lock is still DEAD; and an offset face is exactly conjugate to the round, so
 * the wheel still gives up μ for the anchor's λ and releases at the same angle.
 * What it costs is the CENTRE DISTANCE, which comes in by the radius over
 * cos(β/2) — the acting circle really is that much smaller than the wheel.
 *
 * Sized from the TOOTH rather than from the cutter, because a convex corner is
 * the one thing a cutter can cut sharp: this is a strength choice, so it scales
 * with the tooth it is strengthening.
 *
 * Deliberately independent of `frame`, which depends on THIS — so it is written
 * off the tip circle and the spec, and never off the acting circle.
 */
function tipRound(spec: EscapementSpec): number {
  const R = Math.max(2, spec.wheelDia / 2)
  const depth = Math.min(0.75 * R, Math.max(0.5, spec.toothDepth))
  const N = Math.max(6, Math.round(spec.teeth))
  const backSpan = clamp((BACK_FRAC * 2 * Math.PI) / N, 0.02, 0.9)
  // What a unit of radius costs in tooth LENGTH — the set-back is linear in the
  // radius, so one corner tells us the whole trade. See `TIP_SETBACK`. Taken on
  // the tip circle and the asked-for depth rather than on the apex and the real
  // root, which are both downstream of THIS: a cap that is a percent out is
  // still a cap.
  const per = tipCorner(R, tipDirs(R, R - depth, backSpan), 1).t
  if (per > TIP_SETBACK_MAX) return 0
  return Math.min(
    Math.max(TIP_ROUND * depth, TIP_ROUND_MIN), TIP_ROUND_MAX,
    (TIP_SETBACK * depth) / Math.max(1, per),
    0.15 * depth, 0.1 * R,
  )
}

/**
 * The tooth's own radii.
 *
 * `R` is the TIP circle — the acting one, which the pallets are laid out on and
 * the tooth tips' rounds are centred on. `rMat` is as far as the wheel's material
 * actually reaches, one round proud of it, and the root hangs off THAT so a tooth
 * is as deep as it was asked for in the wood. `rTip` (in `toothGeom`) is neither:
 * it is the virtual apex the flanks are drawn to, further out again.
 *
 * Its own function because `toothGeom` and the readouts both need these, and a
 * second copy of the arithmetic is the one that would go stale.
 */
function toothStock(spec: EscapementSpec) {
  const R = Math.max(2, spec.wheelDia / 2)
  const tipR = tipRound(spec)
  const rMat = R + tipR
  const N = Math.max(6, Math.round(spec.teeth))
  const pitch = (2 * Math.PI) / N
  const rRoot = Math.max(rMat * 0.25, rMat - Math.max(0.5, spec.toothDepth))
  const backSpan = clamp(BACK_FRAC * pitch, 0.02, pitch * 0.9)
  return { R, tipR, rMat, rRoot, backSpan, pitch, depth: rMat - rRoot }
}

/** The geometry every other function here starts from.
 *
 *  `R` is the TIP circle, and it is the ACTING circle: the tooth tips' rounds are
 *  centred on it, so it is what the classic construction below is laid out on and
 *  what every pallet is placed by. The wheel's own material stands one round
 *  proud of it (`Rm`) — see `tipRound`, and note that a centre distance is a
 *  question about `R`, never about `Rm`. */
function frame(spec: EscapementSpec) {
  const tipR = tipRound(spec)
  const R = Math.max(2, spec.wheelDia / 2)
  const Rm = R + tipR
  const N = Math.max(6, Math.round(spec.teeth))
  const pitch = (2 * Math.PI) / N
  // Span is clamped short of a half turn: β → π sends the arbor to infinity.
  const span = clamp(escapementSpan(N), 0.5, N / 2 - 0.5)
  const beta = span * pitch
  const L = R / Math.cos(beta / 2)
  const rho = R * Math.tan(beta / 2)
  const beat = pitch / 2
  // The wheel's whole share of a beat is half a tooth; drop is taken out of it
  // first, and what is left is the impulse. A drop that eats the lot is a fatal
  // input, flagged in dims — clamped here only so the geometry stays drawable.
  const mu = Math.max(rad(0.1), beat - rad(Math.max(0, spec.drop)))
  const lam = rad(Math.max(0.2, spec.lift))
  return { R, Rm, tipR, N, pitch, beta, L, rho, beat, mu, lam }
}

// ─── The acting faces ─────────────────────────────────────────────────────────

type Side = 'entry' | 'exit'

/**
 * The DROP LOCK, in anchor radians — how deep a tooth is already locked at the
 * instant it lands, before the pendulum's supplementary arc drives it deeper.
 *
 * Without it a tooth lands exactly on the corner where the locking face turns
 * into the impulse face, because the bare loci give each pallet an impulse
 * starting at the very anchor angle at which the other releases. That is a
 * knife edge: the running clearance is enough to carry the landing past the
 * corner and onto the impulse face, where nothing locks.
 *
 * So the amount is not a taste. A tooth cut `clearance` short has to travel
 * that much further along the face before it is caught, so the pallets must
 * embrace the clearance PLUS the dead face we actually want under the tooth —
 * a LENGTH, turned into an angle at the pallet radius. Given the room it comes
 * out at exactly `LANDING_DEPTH` of real dead face however the teeth are cut.
 *
 * It is spent OUT of the lock, so the lock is shared: the tooth lands on the
 * drop lock and the supplementary arc runs it through what is left. The run end
 * keeps its `RUN_MARGIN` first and the landing takes the rest up to
 * `LANDING_DEPTH` — so a lock too small for both lands SHALLOW, which
 * `landingShort` reports, and one too small to land at all is `noLock`.
 *
 * Zero for a recoil anchor, which has no dead face to land on and is not
 * supposed to have one — its tooth lands on the impulse face and drives the
 * wheel back, which is the whole of what a recoil escapement does.
 */
function dropLock(spec: EscapementSpec): number {
  if (spec.escType !== 'deadbeat') return 0
  const { rho } = frame(spec)
  // The landing wanted, plus what the offset's own corner costs — see
  // `cornerBlunt`. Asked for as a LENGTH and turned into an angle here, the same
  // as it always was.
  const want = (LANDING_DEPTH + cornerBlunt(spec)) / rho
  const room = rad(Math.max(0, spec.lock)) - RUN_MARGIN / rho
  return Math.max(0, Math.min(want, room))
}

/**
 * The tooth tip's path in the anchor's own frame — the pallet face.
 *
 * `t` runs −0.5 → +0.5 across the impulse: the wheel turns −μ·t (it always runs
 * the same way) and the anchor ±λ·t, the sign being whichever WITHDRAWS that
 * pallet from the wheel. Entry retreats clockwise and exit anticlockwise, which
 * is the whole reason the thing oscillates, and it falls out of the geometry
 * rather than being asserted: the pallets sit either side of the arbor, so one
 * rises as the other dips.
 *
 * `freezeWheel` holds the wheel at the start of impulse, which turns the same
 * expression into the deadbeat's concentric lock.
 *
 * The extra half drop lock is a CONSTANT in `t`, so it is a rigid turn of the
 * whole face about the arbor — lock arc and impulse face together, in the
 * direction that buries this pallet deeper. Both pallets get it, in opposite
 * senses, which is what widens the embrace without moving the anchor's neutral.
 */
function locus(
  spec: EscapementSpec, side: Side, t: number, freezeWheel: boolean,
): Pt {
  return locusAt(spec, side, t, freezeWheel, dropLock(spec) / 2)
}

/** The same, with the drop lock's rigid turn handed in rather than taken from
 *  `dropLock` — which is how `cornerBlunt` asks about the profile's own shape
 *  without asking `dropLock`, which asks IT. */
function locusAt(
  spec: EscapementSpec, side: Side, t: number, freezeWheel: boolean, turn: number,
): Pt {
  const { R, beta, L, mu, lam } = frame(spec)
  const sgn = side === 'entry' ? -1 : 1
  const anchorDir = side === 'entry' ? -1 : 1
  const P0: Pt = [sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2)]
  const T = rot(P0, -mu * (freezeWheel ? -0.5 : t))
  const V: Pt = [T[0], T[1] - L]                 // anchor-local, anchor at neutral
  return rot(V, -anchorDir * (lam * t + turn))
}

/**
 * THE DEAD FACE A TOOTH REALLY HAS, measured on the profile that gets cut rather
 * than estimated from it: how long the locking face is between the round on its
 * corner and its deep end (`total`), and how much of that is under the tooth at
 * the instant it LANDS (`landing`).
 *
 * Measured, because the estimate was wrong where it matters most. `cornerBlunt`
 * is a first-order figure — the two rounds' set-back along the face's own tangent
 * — and it is fine when the face is a couple of millimetres long, but at 1° of
 * lock the whole dead face is 0.6 mm and the estimate took 0.33 of it: the
 * readout said a tooth landed on 0.07 mm when it really lands on 0.15
 * (Rick, 2026-09-17, checking it against the animation). Erring pessimistic on
 * the landing is the right direction, but not by two and a half times, and not on
 * the one number the panel tells people to add lock for.
 *
 * `dropLock` still runs on the ESTIMATE, and has to: it decides the embrace that
 * this then measures, so it cannot wait for the answer. The estimate is accurate
 * where the embrace is actually deciding anything (1.000 against 1.004 measured
 * at the full landing), and this is what gets reported.
 *
 * The WORSE of the two pallets, because an escapement is only as good as its
 * shallower landing, and the entry's and exit's faces are not mirror images.
 */
function deadFace(spec: EscapementSpec): { total: number; landing: number; impulse: number } {
  const whole = (side: Side) => {
    const f = actingProfile(spec, side)
    let s = 0
    for (let i = 1; i < f.length; i++) s += Math.hypot(f[i][0] - f[i - 1][0], f[i][1] - f[i - 1][1])
    return s
  }
  if (spec.escType !== 'deadbeat') {
    const { rho } = frame(spec)
    const lockLen = Math.max(0, rho * rad(Math.max(0, spec.recoilArc)))
    return { total: lockLen, landing: 0, impulse: Math.max(0, whole('entry') - lockLen) }
  }
  // THE WORSE PALLET, and BOTH numbers from that one pallet — taking the minimum
  // of each independently can report a total from the entry and a landing from
  // the exit, and then `total − landing` is not the run margin on either of them.
  // No lock asked for is no dead face, whatever the profile's first points do.
  // With `lock` at zero the dead arc is a run of COINCIDENT points — the loop
  // that draws it steps an angle of nothing — and offsetting coincident points
  // is undefined: it comes out as a third of a millimetre of numerical noise,
  // which then reads as a landing on an escapement that has no lock at all.
  const { rho: rhoA } = frame(spec)
  if (!(rhoA * rad(Math.max(0, spec.lock)) > 1e-6)) {
    return { total: 0, landing: 0, impulse: whole('entry') }
  }
  let worst: { total: number; landing: number; impulse: number } | null = null
  for (const side of ['entry', 'exit'] as const) {
    const { pts, corner } = actingFace(spec, side)
    const end = clamp(corner, 1, pts.length - 1)
    // Arc length along the locking face, deep end to the corner's round.
    const at: number[] = [0]
    for (let i = 1; i <= end; i++) {
      at.push(at[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    }
    const total = at[end]
    // Where the tooth rests at the landing: its acting point is `dropLock` deep
    // along the dead arc, and the face is one tip round off that point — so the
    // contact is the face's own closest approach to it.
    const B = locus(spec, side, -0.5, true)
    const C = deadArc(spec, side, B, dropLock(spec))
    let best = { d: Infinity, s: 0 }
    for (let i = 1; i <= end; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1]
      const len = Math.hypot(dx, dy) || 1
      const u = clamp(((C[0] - pts[i - 1][0]) * dx + (C[1] - pts[i - 1][1]) * dy) / (len * len), 0, 1)
      const d = Math.hypot(pts[i - 1][0] + u * dx - C[0], pts[i - 1][1] + u * dy - C[1])
      if (d < best.d) best = { d, s: at[i - 1] + u * len }
    }
    const landing = clamp(at[end] - best.s, 0, total)
    // The impulse face is the REST of the same curve — the two together are the
    // one acting face the pallet has, which is what `faceWidth` reports and what
    // makes reading either of them off the drawing ambiguous.
    const impulse = Math.max(0, whole(side) - total)
    if (!worst || landing < worst.landing) worst = { total, landing, impulse }
  }
  return worst ?? { total: 0, landing: 0, impulse: 0 }
}

/**
 * How much the offset BLUNTS the locking corner, mm.
 *
 * The two offset stretches cross `f·cot(ψ/2)` back along the dead arc, where ψ is
 * the angle the dead arc and the impulse face leave the corner at — so the
 * pallet's corner is no longer at the end of the dead arc, and a landing measured
 * from it starts that much further in. See `offsetFace`.
 *
 * `dropLock` buys it back, because the landing is the margin every build error is
 * spent from and quietly handing a sixth of it to the tip round is exactly the
 * sort of thing that runs a clock through. Taken as the WORSE of the two pallets:
 * the embrace is one number and both have to land.
 */
function cornerBlunt(spec: EscapementSpec): number {
  const { tipR } = frame(spec)
  if (!(tipR > 1e-9) || spec.escType !== 'deadbeat') return 0
  let worst = 0
  for (const side of ['entry', 'exit'] as const) {
    const B = locusAt(spec, side, -0.5, true, 0)
    const d = deadArc(spec, side, B, 1e-5)
    const i = locusAt(spec, side, -0.5 + 1e-5, false, 0)
    const a = norm([d[0] - B[0], d[1] - B[1]])
    const b = norm([i[0] - B[0], i[1] - B[1]])
    const psi = Math.acos(clamp(a[0] * b[0] + a[1] * b[1], -1, 1))
    // The offset's crossing and the corner's own fillet stand back along the dead
    // face by the same factor, so they are one number — see `LOCK_ROUND`.
    worst = Math.max(worst, (tipR + lockRound(spec)) / Math.max(0.05, Math.tan(psi / 2)))
  }
  return worst
}

/**
 * One point of the deadbeat's dead arc, at anchor depth `a` past the start of
 * impulse. Its own function because the LOCKING FACE and the run-out past it
 * are one curve — see `faceBeyond` — and two copies of this law would drift.
 *
 * `draw` leans the arc off concentric so the drive tightens the lock instead of
 * picking it. WHICH WAY IT LEANS IS PER PALLET, and taking it as "shrink the
 * radius" for both is the one mistake here that looks right on the drawing. The
 * two pallets keep their stock on OPPOSITE sides of their faces — the entry's
 * lies towards the arbor, the exit's away from it — so the same radial lean
 * buries one face in its own material (a lock that tightens) and drives the
 * other out through its face into the tooth (a lock that trips, and that shows
 * up as the exit tooth embedded in the pallet while the entry stands off by the
 * same amount). Lean it towards the STOCK on each, which is what `anchorDir`
 * says here, and both draw.
 *
 * The test of it is not the outline but the wheel: with the lock deepening, a
 * drawing face lets the wheel creep FORWARD to stay in touch — the drive is
 * doing the work of pulling the pallet in, which is what draw means. Push the
 * wheel back instead and the drive is resisting, which is a repel.
 */
function deadArc(spec: EscapementSpec, side: Side, B: Pt, a: number): Pt {
  const anchorDir = side === 'entry' ? -1 : 1
  const drawT = Math.tan(rad(clamp(spec.draw, 0, 15)))
  const p = rot(B, anchorDir * a)
  const k = clamp(1 + anchorDir * a * drawT, 0.5, 1.5)
  return [p[0] * k, p[1] * k]
}

/**
 * One pallet's acting profile, ordered from the deep-lock end to release.
 *
 * The lock end lies INSIDE the tip circle — that is what stops the tooth — and
 * the release end outside it, where the tooth gets away. Both come out of the
 * same locus; only what happens before impulse differs between the two
 * escapements.
 *
 * ACTING is the word: it ends where the tooth's reach ends. The pallet carries
 * on past both ends — a tip land at one, the run-out into the arm at the other
 * — and neither belongs here, because `faceWidth` and the mesh check's "is this
 * contact on an acting face?" both read this and would quietly count them.
 */
function actingFace(spec: EscapementSpec, side: Side): { pts: Pt[]; corner: number } {
  const off = offsetFace(rawLocus(spec, side), frame(spec).tipR, stockSide(spec, side),
    spec.escType === 'deadbeat' ? LOCK_STEPS - 1 : -1)
  return roundLockCorner(off.pts, off.corner, lockRound(spec))
}

/** The acting profile alone — what nearly everything wants. */
function actingProfile(spec: EscapementSpec, side: Side): Pt[] {
  return actingFace(spec, side).pts
}

/**
 * The locus of the tooth's ACTING POINT — the curve the face is offset from, and
 * the whole of the classic construction. On its own so that a test can ask what
 * the face was offset from: the action is unchanged by the tip round exactly as
 * long as the face stands one round off THIS.
 */
function rawLocus(spec: EscapementSpec, side: Side): Pt[] {
  const { lam } = frame(spec)
  const out: Pt[] = []

  if (spec.escType === 'deadbeat') {
    // Dead lock: the wheel is held, so the locus degenerates to an arc about the
    // arbor — see `deadArc`, which is that arc and its lean.
    const B = locus(spec, side, -0.5, true)
    // NEVER QUITE ZERO. At no lock the arc's samples all fall on one point, and
    // that point has no direction — yet the run-out takes its direction from the
    // dead face, so the pallet came out bent whichever way the arithmetic fell
    // (Rick, 2026-09-18, lock 0). A few microns of arc give it the dead face's
    // own tangent, and `offsetFace` then trims that to nothing, the same as any
    // lock too short for the offset's corner. Nothing measured sees it:
    // `deadFace` reports a lock of zero as zero face before it looks at a point.
    const lock = Math.max(rad(Math.max(0, spec.lock)), 1e-4)
    // The arc runs from the deep end down to the start of impulse and STOPS
    // there. Running it on past that point is the tempting way to give a
    // late-landing tooth somewhere dead to arrive — and it does nothing: past
    // that point is the impulse face's own ground, so the extension doubles
    // back over it, the boolean drops the resulting zero-width spur, and the
    // pallet comes out with the same bare corner it had before. Where the tooth
    // lands is fixed by the EMBRACE instead; see `dropLock`.
    //
    // So it stops one step short of a = 0, because that point IS the start of
    // impulse and the shared loop below opens with it. Emitting it here as well
    // would leave a duplicated vertex in the middle of the acting face.
    const steps = LOCK_STEPS
    for (let i = steps - 1; i >= 1; i--) out.push(deadArc(spec, side, B, (lock * i) / (steps - 1)))
  } else {
    // Recoil: nothing is held, so the same locus simply continues. Every degree
    // of supplementary swing drives the wheel back the way it came.
    const steps = RECOIL_STEPS
    const t0 = -0.5 - rad(Math.max(0, spec.recoilArc)) / lam
    for (let i = 0; i < steps; i++) out.push(locus(spec, side, t0 + ((-0.5 - t0) * i) / steps, false))
  }

  for (let i = 0; i <= IMPULSE_STEPS; i++) {
    out.push(locus(spec, side, -0.5 + i / IMPULSE_STEPS, false))
  }
  return out
}

/**
 * Which side of its face a pallet's own stock lies on — and so the direction the
 * face is offset in for the tooth's tip round.
 *
 * It is the same answer on both pallets, and the tooth says why: at the contact
 * its velocity runs exactly along the arm (AP ⟂ OP), so it pushes the entry
 * pallet TOWARDS the arbor and the exit pallet AWAY from it, and both of those
 * are the way the wheel is trying to go. A pallet's stock stands in front of the
 * tooth, because that is what stopping it means.
 */
function stockSide(spec: EscapementSpec, side: Side): Pt {
  const { R, beta, L } = frame(spec)
  const sgn = side === 'entry' ? -1 : 1
  const u = norm([sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2) - L])
  return side === 'entry' ? [-u[0], -u[1]] : u
}

/** The radius of that round, mm. See `LOCK_ROUND`. */
function lockRound(spec: EscapementSpec): number {
  return spec.escType === 'deadbeat' ? LOCK_ROUND * frame(spec).tipR : 0
}

/**
 * Round the locking corner off, and say where the locking face now ENDS.
 *
 * The corner is the crossing the offset leaves, so both stretches into it are
 * straight-ish lines and this is an ordinary corner fillet — except that the
 * tangency lands 0.53·g back along each, which on the dead side is past two or
 * three of its samples (they are 0.07 mm apart). So the points the fillet covers
 * are DROPPED rather than kept: left in, they stand outside the arc that is
 * supposed to have replaced them, and the corner is still sharp where it counts.
 *
 * Returns the index of the fillet's first point, which is where the LOCKING FACE
 * proper now ends — everything from there on is the corner or the impulse, and a
 * tooth that lands on any of it has not landed on dead face. That is the index
 * the landing is measured from, so it is the honest place to draw the line.
 */
function roundLockCorner(pts: Pt[], corner: number, g: number): { pts: Pt[]; corner: number } {
  if (corner < 1 || corner > pts.length - 2) return { pts, corner: corner < 0 ? LOCK_STEPS - 1 : corner }
  if (!(g > 1e-6)) return { pts, corner }
  const X = pts[corner]
  // The two rays out of the corner — the TANGENTS there, so take the nearest
  // sample that is far enough off to be a direction at all and no further. Walk
  // out to a multiple of the radius instead and the ray is the arc's CHORD over
  // that run, tilted by half its turn, which puts the tangency point a thousandth
  // of a millimetre off the face it is supposed to be tangent to — enough to
  // unpin `locks on an arc concentric with the arbor`.
  const rayTo = (from: number, step: number): Pt => {
    let i = from
    for (; i > 0 && i < pts.length - 1; i += step) {
      if (Math.hypot(pts[i][0] - X[0], pts[i][1] - X[1]) > Math.max(1e-3, 0.05 * g)) break
    }
    return norm([pts[i][0] - X[0], pts[i][1] - X[1]])
  }
  const r1 = rayTo(corner - 1, -1), r2 = rayTo(corner + 1, 1)
  const half = Math.acos(clamp(r1[0] * r2[0] + r1[1] * r2[1], -1, 1)) / 2
  const tan = Math.tan(half)
  if (!(tan > 0.05)) return { pts, corner }
  // THE ROUND HAS TO FIT ON THE DEAD FACE THERE IS. Its tangency stands t back
  // from the corner, and below about half a degree of lock (on the default wheel)
  // the dead face the offset leaves is shorter than that: the tangency lands PAST
  // the face's deep end, the profile's first step comes out pointing backwards,
  // and the run-out that carries the face on into the arm follows it the wrong
  // way — a spike through the wheel (Rick, 2026-09-18, lock under 0.5°). So the
  // round shrinks to what the face can hold. This is NOT the cap `LOCK_ROUND`
  // warns against: it only ever bites where there is no dead face worth the name
  // — `noLock` already says so — far below the lock `fullLandingLockDeg` quotes,
  // and `cornerBlunt` is untouched, so that figure stays a fixed point.
  let run = 0
  for (let i = 1; i <= corner; i++) run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  if (g / tan > 0.9 * run) g = 0.9 * run * tan
  if (!(g > 0.01)) return { pts, corner }
  const t = g / tan
  const T1: Pt = [X[0] + t * r1[0], X[1] + t * r1[1]]
  const T2: Pt = [X[0] + t * r2[0], X[1] + t * r2[1]]
  const bis = norm([r1[0] + r2[0], r1[1] + r2[1]])
  const c: Pt = [X[0] + (g / Math.sin(half)) * bis[0], X[1] + (g / Math.sin(half)) * bis[1]]
  // Everything the fillet covers, on both sides of the corner.
  let lo = corner, hi = corner
  while (lo > 1 && Math.hypot(pts[lo - 1][0] - X[0], pts[lo - 1][1] - X[1]) < t) lo--
  while (hi < pts.length - 2 && Math.hypot(pts[hi + 1][0] - X[0], pts[hi + 1][1] - X[1]) < t) hi++
  const a1 = Math.atan2(T1[1] - c[1], T1[0] - c[0])
  const a2 = Math.atan2(T2[1] - c[1], T2[0] - c[0])
  let sweep = a2 - a1
  while (sweep > Math.PI) sweep -= 2 * Math.PI
  while (sweep < -Math.PI) sweep += 2 * Math.PI
  const arc: Pt[] = []
  const steps = 6
  for (let i = 0; i <= steps; i++) {
    const a = a1 + (sweep * i) / steps
    arc.push([c[0] + g * Math.cos(a), c[1] + g * Math.sin(a)])
  }
  const out = pts.slice(0, lo).concat(arc, pts.slice(hi + 1))
  return { pts: out, corner: lo }
}

/**
 * One acting profile, offset by the tooth's tip round — the step that turns the
 * locus of a POINT into the face a rounded tip really bears on. See `tipRound`.
 *
 * The tooth acts by an arc of radius `f` whose centre traces `pts`, so the face
 * is the curve every one of those arcs touches: `pts` offset by `f` along its own
 * normal, towards the pallet's stock. Offsetting the WHOLE profile in one pass —
 * dead arc, impulse face and the drop lock's rigid turn together — is what keeps
 * the pair conjugate, and it is why neither the lock nor the release moves: an
 * arc concentric with the arbor offsets to another arc concentric with the arbor.
 *
 * THE LOCK-TO-IMPULSE CORNER IS THE ONE PLACE THE PROFILE REALLY TURNS — 55° of
 * it — and it turns TOWARDS the stock, so the two offset stretches CROSS. The
 * crossing is the pallet's real corner and everything between is inside the
 * pallet, which is why this resolves the crossing rather than treating each
 * vertex on its own: the crossing lands 0.16 mm back along the dead arc, two
 * whole samples short of the corner, and those two samples left standing are
 * 0.08 mm of pallet inside the tooth's round — a bind that measures on the mesh
 * and shows nothing in the outline. Per-vertex arithmetic cannot see it, because
 * each of those vertices is a perfectly good offset of its own segment.
 *
 * What the crossing costs is `cornerBlunt`: the corner is no longer at the end of
 * the dead arc, so the landing is measured from further in and the embrace has to
 * buy that back.
 */
function offsetFace(pts: Pt[], f: number, m: Pt, knee = -1): { pts: Pt[]; corner: number } {
  if (!(f > 1e-9) || pts.length < 3) return { pts, corner: -1 }
  const nrm: Pt[] = []
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1]
    const len = Math.hypot(dx, dy) || 1
    const q: Pt = [-dy / len, dx / len]
    nrm.push(q[0] * m[0] + q[1] * m[1] >= 0 ? q : [-q[0], -q[1]])
  }
  // A flat `f` along each vertex's own bisector. Flat on purpose: a sampled arc
  // offsets to a sampled arc about the same centre this way, and `locks on an arc
  // concentric with the arbor` is pinned to nine places.
  //
  // An END vertex has only one chord, so its normal is carried half a step back
  // from its neighbour's turn — which for a sampled arc IS the radius through it.
  // Left on the chord's own normal it stands f·(1−cos) off the arc, a
  // ten-millionth of a millimetre and enough to unpin that test.
  const turn = (a: Pt, b: Pt) => Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])
  const end = nrm.length - 1
  const at = (i: number): Pt => {
    if (i === 0) return nrm.length > 1 ? rot(nrm[0], -turn(nrm[0], nrm[1]) / 2) : nrm[0]
    if (i === pts.length - 1) return end > 0 ? rot(nrm[end], turn(nrm[end - 1], nrm[end]) / 2) : nrm[end]
    const a = nrm[i - 1], b = nrm[i]
    const bis: Pt = [a[0] + b[0], a[1] + b[1]]
    const len = Math.hypot(bis[0], bis[1])
    return len < 1e-12 ? a : [bis[0] / len, bis[1] / len]
  }
  const out: Pt[] = pts.map((p, i) => {
    const n = at(i)
    return [p[0] + f * n[0], p[1] + f * n[1]] as Pt
  })
  // Where the offset crosses itself, the boundary is the crossing and the run
  // between is buried. At most one crossing here — a recoil profile's sharpest
  // turn is a quarter of a degree — but written as a sweep because a crossing
  // left in is a bind, and the length falls every time so it cannot loop.
  let corner = -1
  for (let i = 0; i + 3 < out.length; i++) {
    for (let j = out.length - 2; j > i + 1; j--) {
      const x = segCross(out[i], out[i + 1], out[j], out[j + 1])
      if (!x) continue
      out.splice(i + 1, j - i, x)
      corner = i + 1
      break
    }
  }
  // NO CROSSING, BUT THERE SHOULD BE ONE: the dead arc is shorter than the
  // offset's own trim (f·cot(ψ/2), about 0.19 mm on the default wheel — a fifth
  // of a degree of lock). The crossing then lies past the deep end, on the dead
  // face's line carried on — which is the pallet's real edge there, since the
  // run-out continues it straight into the arm — so the whole dead offset is
  // buried and the corner is where that line meets the impulse offset. Left in,
  // the buried stretch stood in the outline as a spur, and was measured as a
  // locking face longer than the one at twice the lock.
  //
  // `knee` is where the dead arc hands over to the impulse in `pts`; only a
  // deadbeat has one. The profile keeps a stub a micron long on the dead line
  // before the corner, so the run-out still leaves in the dead face's direction
  // and there is a corner index for the rest of the code to read — a locking
  // face of nothing, which is what there is.
  if (corner < 0 && knee > 1 && knee < out.length - 1) {
    const u = norm([out[0][0] - out[1][0], out[0][1] - out[1][1]])
    if (Math.hypot(out[knee - 1][0] - out[0][0], out[knee - 1][1] - out[0][1]) > 1e-4) {
      const far: Pt = [out[0][0] + 10 * f * u[0], out[0][1] + 10 * f * u[1]]
      for (let j = knee - 1; j + 1 < out.length; j++) {
        const x = segCross(out[0], far, out[j], out[j + 1])
        if (!x) continue
        const stub: Pt = [x[0] + 1e-3 * u[0], x[1] + 1e-3 * u[1]]
        return { pts: [stub, x, ...out.slice(j + 1)], corner: 1 }
      }
    }
  }
  return { pts: out, corner }
}

/**
 * THE ROUND ON THE PALLET'S LOCKING CORNER, as a multiple of the tooth's own tip
 * round — the corner where the locking face turns into the impulse face.
 *
 * A tooth has to get over that corner on every single beat, and it does it at the
 * worst possible moment: the pallet is at its deepest in the tooth and the whole
 * drive is crossing one edge. Sharp, that edge is what crushes — and a crushed
 * locking corner is one of the four errors `LANDING_DEPTH` exists to pay for
 * (Rick, 2026-09-17). Round on round, the tooth's tip and the corner hand over
 * smoothly instead, on a contact with some length to it.
 *
 * It is not free. The fillet's tangency stands back along the dead face by 0.53
 * of its radius — the same factor the offset's own corner trim costs, and
 * `cornerBlunt` counts both together so `dropLock` can buy them back.
 *
 * SIZED ONLY FROM THE TIP ROUND, and capping it against the locking face's own
 * length was tried and taken back out: a wheel with little lock does need a
 * smaller corner, but `lock` then appears in `cornerBlunt`, and the landing the
 * panel quotes as the fix (`fullLandingLockDeg`) stops being a fixed point — it
 * says 2.01°, and at 2.01° of lock the corner is bigger and the landing is short
 * again. A readout that does not answer its own question is worse than a corner
 * that is generous on a wheel with no lock to spare, and that wheel is told:
 * `landingShort` and `noLock` are measured from the dead face it really has.
 *
 * A RECOIL HAS NO SUCH CORNER and gets none of this: nothing is held, so its
 * locus simply carries on through the start of impulse as one smooth curve.
 */
const LOCK_ROUND = 1.0

/** Samples in a deadbeat's dead arc and in a recoil's pre-impulse run. Named
 *  because `lockPoints` has to agree with what `actingProfile` emitted. */
const LOCK_STEPS = 20
const RECOIL_STEPS = 24
/** …and in the impulse face, which both the profile and the energy budget walk. */
const IMPULSE_STEPS = 32

/**
 * How many points of a profile are the LOCKING face rather than the impulse one
 * — which of the two a tooth is riding is the whole difference between a deadbeat
 * and a recoil, so the mesh check has to be able to ask.
 *
 * TAKEN FROM THE PROFILE BUILDER, not counted off the construction: the offset's
 * corner trim drops the samples its crossing overshoots and the corner fillet
 * drops several more, so the corner is nowhere near where the loop that drew it
 * put it (index 17 of 49, against 19 of 52 with no round at all). A recoil has no
 * corner to find, because its locus simply carries on through the start of
 * impulse.
 *
 * The boundary is the start of the corner FILLET — the last point of true dead
 * face. A tooth landing past it has landed on the corner, which is not dead, so
 * this is the line the landing has to be measured from.
 */
function lockPoints(spec: EscapementSpec, side: Side): number {
  if (spec.escType !== 'deadbeat') return RECOIL_STEPS
  return actingFace(spec, side).corner + 1
}

/** Where two segments properly cross, or null. Strictly interior on both, so
 *  that segments sharing an end are not reported as crossing there. */
function segCross(p: Pt, p2: Pt, q: Pt, q2: Pt): Pt | null {
  const r: Pt = [p2[0] - p[0], p2[1] - p[1]]
  const s: Pt = [q2[0] - q[0], q2[1] - q[1]]
  const den = r[0] * s[1] - r[1] * s[0]
  if (Math.abs(den) < 1e-12) return null
  const dx = q[0] - p[0], dy = q[1] - p[1]
  const t = (dx * s[1] - dy * s[0]) / den
  const u = (dx * r[1] - dy * r[0]) / den
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null
  return [p[0] + t * r[0], p[1] + t * r[1]]
}

/**
 * The pallet nib: the acting face, given substance.
 *
 * A pallet is a BLADE standing in the path of the teeth. It has to be — its face
 * is where a tooth tip comes to rest — and that fixes both of its dimensions
 * from the wheel rather than from taste:
 *
 *   ACROSS the wheel it spans what the face spans, which is the lock and the
 *   impulse and nothing else. The face is RADIAL to the wheel (that is what the
 *   tangency gives), so the tooth slides along it in and out: on the entry it
 *   slides inwards and drops off the inner corner, on the exit outwards.
 *
 *   AROUND the wheel it is `depth` thick, and that thickness has to pass through
 *   a tooth SPACE. Make it as thick as the arm and it is most of a tooth pitch:
 *   it fouls the tooth ahead of the one it is working with and the escapement
 *   jams solid. This is the one dimension that looks arbitrary and is not — see
 *   `nibDepth`.
 *
 * Which side of the face the stock lies on is decided by the tooth. At the
 * pallet the tooth's velocity runs exactly along the arm (AP ⟂ OP), so it pushes
 * the entry pallet TOWARDS the arbor and the exit pallet AWAY from it: the entry
 * nib is the end of its arm, and the exit nib hangs off the far side of its own.
 *
 * THE PALLET IS PART OF THE ARM, not a blade let into it. It is drawn as a wedge
 * whose front is the acting face and whose back is a single relieved line, run
 * OUTWARDS far enough to bury itself in the arm and then cut off flush with the
 * arm's outer edge. Nothing of it is left standing outside the arm's silhouette,
 * so wheel and anchor come off the saw as two pieces of wood rather than four.
 * (Extending the face's ends by a fixed reach instead leaves a spur poking out
 * past the arm and a step where the wedge crosses it — geometry that says
 * "mortise" to anyone reading the drawing, and means nothing to the escapement.)
 */
function nibFrame(spec: EscapementSpec, side: Side, depth: number) {
  const { L } = frame(spec)
  const m = stockSide(spec, side)                           // the stock's side of the face
  const O: Pt = [0, -L]

  const face = actingProfile(spec, side)
  const distO = (p: Pt) => Math.hypot(p[0] - O[0], p[1] - O[1])
  // Which end is the outer one is a fact about the pallet, so ask rather than
  // encode a guess — it is the opposite way round on the two sides.
  const outerFirst = distO(face[0]) > distO(face[face.length - 1])
  const inner = outerFirst ? face[face.length - 1] : face[0]
  const outer = outerFirst ? face[0] : face[face.length - 1]
  const away = norm([outer[0] - O[0], outer[1] - O[1]])       // radially out of the wheel
  const line = outerFirst ? face.slice().reverse() : face.slice()   // inner → outer

  // The BACK of the pallet is relieved — it leans outwards, away from the wheel,
  // as it runs back from the face. It has to: the back sits a pallet's thickness
  // around the wheel from the face, which is where the NEXT tooth is coming, and
  // a back cut square catches it and stops the escapement dead. Nothing in the
  // outline shows that; the mesh check is what finds it.
  const th = rad(clamp(BACK_RELIEF, 0, 85))
  const rel: Pt = norm([
    Math.cos(th) * m[0] + Math.sin(th) * away[0],
    Math.cos(th) * m[1] + Math.sin(th) * away[1],
  ])
  // THE PALLET ENDS AT THE RELEASE CORNER. There is no tip land: the relieved
  // back starts at `inner` itself and runs straight back into the arm, so the
  // blade comes to a point at the one end a tooth has to get past.
  //
  // It used to carry a square land a whole `nibDepth` thick there, and the land
  // was where the blade was widest around the wheel at exactly the point it has
  // least room — the release corner sits deepest inside the tooth space, and the
  // land added its thickness on the side the NEXT tooth is arriving from. That
  // is a pallet that fits the space on paper and fouls it in wood, where the
  // teeth are never quite where the drawing says. Ending at the corner instead
  // costs nothing: nothing acts on the land (the tooth leaves by the corner) and
  // the blade is still `depth`-worth of wedge by the time it reaches the arm.
  const far = 2 * (armClear(spec) + Math.max(1, spec.armWidth)) + depth
  // THE WEDGE'S LEADING EDGE CARRIES ON ALONG THE FACE, and this is the
  // direction it leaves in: the acting face's own, taken from its last step.
  //
  // Not the wheel's radial, which is what it used to be. The two are the same
  // only at the tangency point the whole construction is built on, and the deep
  // lock is a lock's worth of arc past that — 6° of it by the far end of the
  // entry pallet. Leaving along the radial breaks off the face by that 6° at
  // exactly the point the face ends, and the drawing shows the pallet swinging
  // away from the arbor there for no reason a reader can see. Along the face
  // there is no break at all: face and run-out are one straight run to the top
  // of the arm, which is also how a pallet's locking face is actually cut.
  //
  // Straight, rather than the locking arc genuinely continued, because both
  // ends of this edge get filleted — the deep-lock corner to the cutter's radius
  // and the arm's toe to its own — and a fillet needs millimetres of clean run
  // to sit on. Sampled as an arc it has none, and both fillets silently do
  // nothing (which is what `leaves no sharp node at either corner it rounds`
  // caught). Over the 5 mm to the arm the arc leaves its tangent by 0.29 mm, on
  // a face that is itself straight to four microns over its own length.
  const lead = norm([line[line.length - 1][0] - line[line.length - 2][0],
                     line[line.length - 1][1] - line[line.length - 2][1]])
  return { m, away, lead, rel, inner, outer, line, far }
}

/** The nib as a ring: the acting face in front, the relieved back behind, both
 *  run out far enough to bury themselves in the arm and cut off flush with the
 *  arm's outer edge — so the wedge disappears into the arm rather than sprouting
 *  out of the far side of it.
 *
 *  A TRIANGLE, not a quadrilateral: the two edges MEET at the release end, which
 *  is the whole of the tip land's removal. The ring closes from the last point
 *  back to `line[0]`, which is that corner. */
function palletNib(spec: EscapementSpec, side: Side, depth: number): Pt[][] {
  const { lead, rel, outer, inner, line, far } = nibFrame(spec, side, depth)
  const ring: Pt[] = [
    ...line,                                             // the acting face
    [outer[0] + far * lead[0], outer[1] + far * lead[1]], // on along it, past the arm
    [inner[0] + far * rel[0], inner[1] + far * rel[1]],  // and back down the relief
  ]
  return boolRings('difference', [ring], [beyondArm(spec, side)])
}



/**
 * One arm's flank, as a line in the anchor's frame. `n` is the offset in the
 * arm's own frame, so the arm runs from `ARM_CLEAR` (the flank facing the wheel)
 * to `ARM_CLEAR + width` (its outer edge). `p` is a point on that line, `dir` the
 * unit direction along it pointing AWAY from the arbor, and `out` the unit normal
 * across the arm, from the wheel-side flank towards the outer edge.
 *
 * One definition, because two things have to agree with where the arm actually
 * is: the wedge's stop (`beyondArm`, the outer edge) and the corner the exit
 * pallet's face makes with the arm (`lockCorner`, the wheel-side flank).
 */
function armFlank(spec: EscapementSpec, side: Side, n: number): { p: Pt; dir: Pt; out: Pt } {
  const { R, beta, L } = frame(spec)
  const sgn = side === 'entry' ? -1 : 1
  const dir = side === 'entry' ? -1 : 1
  const P: Pt = [sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2) - L]
  const u = norm(P)
  const across = norm([sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2)])
  const sw = dir * halfSwing(spec)
  return { p: rot([across[0] * n, across[1] * n], sw), dir: rot(u, sw), out: rot(across, sw) }
}

/**
 * Everything past a line square across one arm, `reach` from the arbor — the
 * RECOIL entry blade's second stop.
 *
 * `beyondArm` catches the run-out along `lead` at the arm's outer EDGE, which is
 * a line running the length of the arm. That works on a deadbeat, whose dead arc
 * is concentric with the arbor so its tangent crosses that edge almost at once —
 * a fifth of a millimetre past the acting face. A RECOIL has no dead arc: the
 * locus is still climbing at the deep end, the run-out points nearly straight out
 * along the arm, and it is 9.45 mm past the face before the edge catches it.
 * Rounding that off (`RECOIL_TOE`) takes the point away but not the length.
 *
 * So this cuts it square instead, across the arm rather than along it, and the
 * toe fillet then rounds what is left. What must NOT be done is to shorten the
 * run-out itself: the blade would stop before it reached the arm at all, its end
 * face would cross the arm's TOE, and a deadbeat would come out with a jog in the
 * silhouette where a rounded toe used to be. Tried; it broke the profile that was
 * already right.
 */
function beyondTip(spec: EscapementSpec, side: Side, reach: number): Pt[] {
  const { R, L } = frame(spec)
  const { p, dir, out } = armFlank(spec, side, armClear(spec))
  const big = 4 * (L + R)
  return ([[0, -big], [big, -big], [big, big], [0, big]] as Pt[])
    .map(([u, v]) => [
      p[0] + dir[0] * (reach + u) + out[0] * v,
      p[1] + dir[1] * (reach + u) + out[1] * v,
    ] as Pt)
}

/**
 * How far from the arbor a RECOIL's entry blade may reach — its acting face's own
 * far end, plus a land. Infinite on a deadbeat, which needs none of this.
 */
function recoilTipReach(spec: EscapementSpec): number {
  if (spec.escType !== 'recoil') return Infinity
  const face = actingProfile(spec, 'entry')
  return Math.max(...face.map((q) => Math.hypot(q[0], q[1]))) + RECOIL_TIP_LAND
}

/** Everything past the outer edge of one arm — the wedge's stop. */
function beyondArm(spec: EscapementSpec, side: Side): Pt[] {
  const { R, L } = frame(spec)
  const { p, dir, out } = armFlank(spec, side, armClear(spec) + Math.max(1, spec.armWidth))
  const big = 4 * (L + R)
  // The half plane beyond the edge, as a box far larger than the anchor.
  return ([[-big, 0], [big, 0], [big, big], [-big, big]] as Pt[])
    .map(([s, t]) => [p[0] + dir[0] * s + out[0] * t, p[1] + dir[1] * s + out[1] * t] as Pt)
}

/**
 * Where the exit pallet's face runs into its own arm — the corner that has to be
 * moved — and how far the arm's wheel-side flank must be SET BACK to move it.
 *
 * The two pallets end differently, and that is the whole of this. The entry nib
 * is the end of its own arm, so its deep-lock end stands in open air. The exit
 * nib hangs off the SIDE of its arm, and at the lock the face is RADIAL to the
 * wheel while the arm lies along the tangent (AP ⟂ OP), so the arm's flank
 * crosses the face's own line barely two tenths past the end of the face.
 *
 * That is an inside corner, and no cutter cuts an inside corner: a 1/8" bit
 * leaves 1.6 mm of radius in it whatever the drawing says. Which would not
 * matter, except for WHERE it is — the whole locking face is barely 1.3 mm, and
 * a tooth lands part way down it, so the radius lands on working face and the
 * tooth rides a lump instead of the curve the escapement was drawn from.
 *
 * So move the corner AWAY FROM THE WHEEL, by taking the flank back, until the
 * corner stands a whole fillet clear of the end of the face. Then the fillet has
 * room and the landing keeps every millimetre. The set-back is a TAPER — nothing
 * at the hub, everything at the pallet — which is where an arm can spare it: the
 * bending it carries is largest at the hub, and this is the far end.
 *
 * What must NOT be done instead is to cut the relief out of the corner itself.
 * That is the obvious move and it is a gouge: it takes its bite out of the arm
 * right behind the landing, exactly where the pallet needs to be solid.
 */
/**
 * How far the ENTRY arm's wheel-side flank is set back at the pallet end.
 *
 * The exit arm needs no such thing and already has one: `lockCorner` takes its
 * flank back to get an inside corner off the acting face, and that set-back
 * incidentally leaves it 3.5 mm clear of the teeth. The entry arm has nothing,
 * and it is the arm that runs closest to the wheel — measured over a full period
 * it skims the tips by 0.44 mm on a deadbeat and TOUCHES on a recoil, whose
 * pallet is the longer blade and whose arm therefore reaches further in.
 * `escapement-check` cannot see it: grazing is not interference, so it reports
 * both as clear. `scripts/esc-arm-clearance.mts` is the harness that can.
 *
 * A TAPER, not a wider `ARM_CLEAR`: the clearance is wanted at the pallet end
 * and nowhere else, and that is the end an arm can spare — the bending it carries
 * is largest at the hub. Same shape of answer as `lockCorner`'s, for the same
 * reason, which is why `palletArm` already takes it.
 *
 * It moves NOTHING that acts. The pallet nib is its own ring, unioned on
 * afterwards and cut off only at the arm's OUTER edge (`beyondArm`), so neither
 * face moves and neither does the tip land. What does move is `backCorner`, which
 * is where the nib's relieved back runs into this flank — it reads the taper, or
 * it would round a corner that is no longer there and silently do nothing.
 */
/**
 * What an arm is really held off its tangent line by.
 *
 * The tangent is to the TIP circle, which is where the tooth tips' rounds are
 * CENTRED — so the wheel's material comes a whole round further out, and an arm
 * laid out on `ARM_CLEAR` alone gives up exactly that much of its air. Measured:
 * every flank clearance in `scripts/esc-arm-clearance.mts` fell by 0.300 mm on a
 * 0.3 mm round, entry and exit, deadbeat and recoil alike, taking the entry arm
 * to 1.26 mm — and 0.68 mm was the skim `ENTRY_CLEAR` was introduced to fix.
 * Carrying the round here puts all four back where they were calibrated.
 *
 * It moves nothing that acts: a nib is its own ring, unioned onto the arm
 * afterwards and cut off only at the arm's outer edge, which moves with it.
 */
function armClear(spec: EscapementSpec): number {
  return ARM_CLEAR + tipRound(spec)
}

function entryTaper(spec: EscapementSpec): number {
  return Math.min(Math.max(1, spec.armWidth) / 2, Math.max(0, ENTRY_CLEAR - ARM_CLEAR))
}

function lockCorner(spec: EscapementSpec, side: Side): { taper: number; at: Pt } | null {
  if (side !== 'exit') return null
  const r = LOCK_RELIEF_BIT_DIA / 2
  const w = Math.max(1, spec.armWidth)
  const reach = armReach(spec, side, w)
  const A = actingProfile(spec, side)[0]                  // the deep-lock end
  // The line the corner slides along is the nib's OWN leading edge, which is the
  // acting face continued (`faceBeyond`) — taken as its tangent here, since the
  // corner sits a couple of millimetres along it and the arc leaves the tangent
  // by four hundredths in that distance.
  const t = nibFrame(spec, side, nibDepth(spec)).lead
  const { p, dir, out } = armFlank(spec, side, armClear(spec))

  // Where the face's line crosses the flank, as a function of the set-back —
  // linear in it, so two evaluations solve it exactly.
  const cross = (taper: number): number | null => {
    const near: Pt = [p[0] - dir[0] * w / 2, p[1] - dir[1] * w / 2]
    const far: Pt = [
      p[0] + dir[0] * (reach + w / 2) + out[0] * taper,
      p[1] + dir[1] * (reach + w / 2) + out[1] * taper,
    ]
    const e = norm([far[0] - near[0], far[1] - near[1]])
    const den = t[0] * e[1] - t[1] * e[0]
    if (Math.abs(den) < 1e-6) return null
    return ((near[0] - A[0]) * e[1] - (near[1] - A[1]) * e[0]) / den
  }

  const s0 = cross(0), s1 = cross(1)
  if (s0 === null || s1 === null || Math.abs(s1 - s0) < 1e-6) return null
  // The corner has to clear the end of the face by the fillet's own set-back,
  // plus a hair so the fillet's near end lands past it rather than on it.
  const want = r + LOCK_LAND
  const taper = Math.max(0, Math.min(w / 2, (want - s0) / (s1 - s0)))
  const s = cross(taper)
  if (s === null) return null
  return { taper, at: [A[0] + t[0] * s, A[1] + t[1] * s] }
}

/**
 * Where the pallet's relieved BACK runs into its own arm — the other inside
 * corner, on the entry pallet, and the other one no cutter can cut sharp.
 *
 * It needs nothing like the trouble the deep-lock corner does. Nothing acts on
 * the back of a pallet, and the corner has a whole arm along one side of it and
 * most of the relief along the other, so there is room for the fillet exactly
 * where it stands: no point has to move, only the corner has to be rounded to
 * the bit that will cut it. `filletToes` does that.
 *
 * Null when the back does not reach that flank at all, which is the exit pallet:
 * its stock lies on the far side of its arm, so its back runs out through the
 * OUTER edge and is cut off there by `beyondArm` instead.
 */
function backCorner(spec: EscapementSpec, side: Side): Pt | null {
  const w = Math.max(1, spec.armWidth)
  const { inner, rel, far } = nibFrame(spec, side, nibDepth(spec))
  // The TAPERED flank, not the nominal one: the entry arm's is set back at the
  // pallet end (`entryTaper`) and this corner is at the pallet end. Read the
  // nominal line here and the corner lands off the outline, where `filletToes`
  // matches by coordinate and so rounds nothing at all — silently.
  const [hub, tip] = __escArmFlank(spec, side)
  const p = hub
  const dir = norm([tip[0] - hub[0], tip[1] - hub[1]])
  const den = rel[0] * dir[1] - rel[1] * dir[0]
  if (Math.abs(den) < 1e-6) return null
  const s = ((p[0] - inner[0]) * dir[1] - (p[1] - inner[1]) * dir[0]) / den
  if (!(s > 0.05 && s < far)) return null
  const at: Pt = [inner[0] + rel[0] * s, inner[1] + rel[1] * s]
  // Two infinite lines always cross. It is only a corner of the anchor if the
  // crossing lands on the arm that is actually there — which on the exit side it
  // does not: that one is out past the end of its own arm. Measured from the HUB
  // end of the flank, which is where `palletArm` starts its bar, so the window is
  // the bar's own length; taking it from `armFlank`'s own origin instead is half
  // an arm width out, and half an arm width is the difference between finding
  // this corner and returning null.
  const along = (at[0] - p[0]) * dir[0] + (at[1] - p[1]) * dir[1]
  return along > 0 && along < armReach(spec, side, w) + w ? at : null
}

/** How thick a pallet may be around the wheel — a fraction of the tooth pitch at
 *  the tip circle, so it always has a tooth space to stand in. */
function nibDepth(spec: EscapementSpec): number {
  const { R, pitch } = frame(spec)
  return Math.min(Math.max(1, spec.armWidth), NIB_SPACE * pitch * R)
}

/** Half the swing the faces are drawn for — the anchor never goes outside it,
 *  and everything that must stay clear of the wheel is set back by it.
 *
 *  The drop lock comes OUT of it: a tooth lands D deep and only the rest of the
 *  lock is left for the supplementary arc to run through, so the anchor reaches
 *  the deep end of the dead face half a drop lock sooner than it used to. */
function halfSwing(spec: EscapementSpec): number {
  const { lam } = frame(spec)
  return lam / 2 - dropLock(spec) / 2
    + rad(Math.max(0, spec.escType === 'deadbeat' ? spec.lock : spec.recoilArc))
}

/** How far each arm reaches from the arbor. The entry arm stops at the pallet
 *  circle and its nib is the last of it; the exit arm has to reach PAST that
 *  circle, because its nib's stock lies on the far side of the face — which is
 *  where the tooth pushes it. Each stops short of the face by its own cap
 *  radius, so no arm end can stand in front of a pallet. */
function armReach(spec: EscapementSpec, side: Side, width: number): number {
  const { rho } = frame(spec)
  return side === 'entry' ? rho - nibDepth(spec) - width / 2 : rho + nibDepth(spec) - width / 2
}

/**
 * An arm from the arbor out to `reach`, along its tangent line but ROTATED off
 * it by the half swing.
 *
 * A constant offset is not enough, and the reason is the whole shape of an
 * anchor's arms: it rocks about the arbor, so a point d from it crosses the
 * tangent by d·φ, and the far end of an arm is exactly where that is largest.
 * Setting the arm back by the swing itself puts it ON the tangent at the extreme
 * of the swing and outside it everywhere else, so the clearance scales with the
 * arm instead of being a number someone guessed. Only the pallets go inside,
 * which is what pallets are for.
 *
 * `taper` takes the WHEEL-SIDE flank back at the far end, nothing at the hub —
 * the set-back that moves the exit pallet's deep-lock corner out of the way of
 * its own fillet. See `lockCorner`.
 *
 * The arms are STRAIGHT, and bowing them is a change that has been tried and
 * rejected. It is tempting — a straight bar is the weakest arm that fits between
 * the two things that fix its ends, and swelling it through the middle would
 * both strengthen it and hand the wheel some clearance back. It does not look
 * like an anchor afterwards. There is also a mechanical cost to know about
 * before trying again: `beyondArm`, `lockCorner` and `backCorner` all read this
 * arm as a straight LINE, and all three work at the pallet end, so a bow that
 * reaches them puts the wedge's flush cut off the edge it is flush with and the
 * two inside corners off the outline their fillets are meant to round.
 */
function palletArm(spec: EscapementSpec, side: Side, reach: number, width: number, taper = 0): Pt[] {
  const { R, beta, L } = frame(spec)
  const sgn = side === 'entry' ? -1 : 1
  const dir = side === 'entry' ? -1 : 1
  const P: Pt = [sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2) - L]
  const u = norm(P)
  // The wheel lies on the far side of the tangent line from `n`: it is the
  // outward radius of the tip circle at the contact point.
  const n = norm([sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2)])
  const off = armClear(spec) + width / 2
  const a = Math.atan2(u[1], u[0])
  // WHICH LOCAL EDGE FACES THE WHEEL IS NOT THE SAME ON THE TWO ARMS, and it has
  // to be asked rather than assumed. The bar is laid out along `u` and rotated by
  // `a`, so local +y lands on the CCW perpendicular of `u` — which is `+n` on the
  // exit arm and `−n` on the entry one, the two contact points being either side
  // of the arbor. So local −y is the wheel side of the exit arm and the OUTER
  // side of the entry arm.
  //
  // The taper existed for `lockCorner`, which is exit-only, so it was written as
  // a flat `−width/2 + taper` and was right by luck. Handed to the entry arm that
  // sets its OUTER edge back: the pallet wedge is still cut flush at the real
  // outer edge (`beyondArm` works in `n`, not in local y, and is unaffected), so
  // a taper's worth of wedge is left standing outside the arm's silhouette as a
  // spur, with a notch behind it. It is visible in the outline and in nothing
  // else — the mesh does not care what happens on the far side of an arm.
  const ws = Math.sign(rot([0, 1], a)[0] * n[0] + rot([0, 1], a)[1] * n[1]) || 1
  const near = (-ws * width) / 2                       // the wheel-side edge
  const far = (ws * width) / 2                         // the outer edge
  // Square-ended, not a stadium: the pallet wedge is cut off flush with this
  // arm's OUTER edge, and a rounded end curves away from that line and leaves a
  // step sticking out of the silhouette. The corner it makes with the wedge is
  // rounded later, on the assembled anchor — see `anchorRings`.
  const bar: Pt[] = taper > 0
    ? [[-width / 2, near], [reach + width / 2, near + ws * taper],
       [reach + width / 2, far], [-width / 2, far]]
    : roundRectRing(-width / 2, -width / 2, reach + width, width, 0)
  return bar.map(([x, y]) => {
    const p = rot([x, y], a)
    return rot([p[0] + off * n[0], p[1] + off * n[1]], dir * halfSwing(spec))
  })
}

/**
 * The anchor, in its own frame: arbor at the origin, pallets hanging below.
 *
 * The arms clear the wheel BY CONSTRUCTION rather than by being cut back —
 * every one lies along a tangent to the tip circle, held off it by ARM_CLEAR,
 * so nothing but the two pallet faces ever reaches inside. That is what the
 * classic construction buys: put the arbor where the tangents cross and the
 * clearance comes free.
 *
 * The obvious-looking alternative — relieve the body by everything the tip
 * circle sweeps through — is wrong twice over. It is far too conservative (the
 * teeth are thin spikes; an anchor sits BETWEEN them, and no real one clears
 * the whole swept annulus) and it cuts the pallets off the arms it is supposed
 * to leave them on. What actually has to be checked is the anchor against the
 * teeth along the motion they really make together, which is what
 * `scripts/escapement-check.mts` does.
 */
function anchorRings(spec: EscapementSpec): Pt[][] {
  const { rho } = frame(spec)
  const w = Math.max(1, spec.armWidth)
  const hubR = Math.max(w * 0.75, spec.anchorBore / 2 + Math.max(1.5, w * 0.4))

  const body: Pt[][] = [ellipseRing(0, 0, hubR, hubR)]
  const add = (r: Pt[]) => { for (const p of boolRings('union', body.splice(0), [r])) body.push(p) }
  add(palletArm(spec, 'entry', armReach(spec, 'entry', w), w, entryTaper(spec)))
  add(palletArm(spec, 'exit', armReach(spec, 'exit', w), w, lockCorner(spec, 'exit')?.taper ?? 0))

  // Fillet the arm-to-hub junctions, and ONLY those: the nibs go on afterwards,
  // untouched. A closing of a couple of millimetres is nothing on an arm and
  // everything on a pallet — the whole acting face is a few millimetres long, so
  // filleting it rounds the locking corner away and turns a dead lock into a
  // recoiling one. It still LOOKS like a deadbeat escapement.
  let out: Pt[][] = roundConcave(body, Math.min(w * 0.35, rho * 0.05))
  const addTo = (r: Pt[]) => { for (const p of boolRings('union', out.splice(0), [r])) out.push(p) }
  for (const r of palletNib(spec, 'entry', nibDepth(spec))) addTo(r)
  for (const r of palletNib(spec, 'exit', nibDepth(spec))) addTo(r)

  // Square off a recoil's entry end — AFTER the nibs, so the blade and the arm
  // under it are cut to the same length. Cutting the arm first leaves the nib's
  // own run-out standing past it, which is most of what there was to remove.
  const cap = recoilTipReach(spec)
  if (Number.isFinite(cap)) out = boolRings('difference', out, [beyondTip(spec, 'entry', cap)])

  return out
}

/** Test hooks — one pallet's acting profile in anchor coordinates, and how many
 *  of its points are the LOCKING face rather than the impulse face. The mesh
 *  harness has to tell those apart: which one a tooth is riding is the whole
 *  difference between a deadbeat and a recoil. */
export function __escFaces(spec: EscapementSpec, side: Side): Pt[] { return actingProfile(spec, side) }
/** Test hooks — the two corners rounded to the cutter's radius: the one the
 *  exit pallet's face makes with its arm (with the set-back that put it where it
 *  is), and the one the entry pallet's back makes with its own. Each is null on
 *  the side that has no such corner. */
export function __escLockCorner(spec: EscapementSpec, side: Side): { taper: number; at: Pt } | null {
  return lockCorner(spec, side)
}
export function __escBackCorner(spec: EscapementSpec, side: Side): Pt | null { return backCorner(spec, side) }
/** Test hook — one arm's WHEEL-SIDE flank, hub end to pallet end, in anchor
 *  coordinates. The edge that runs closest to the teeth along its whole length,
 *  and the only part of an anchor that is neither an acting face nor set by the
 *  construction, so it is the one a clearance measurement can act on. */
export function __escArmFlank(spec: EscapementSpec, side: Side): [Pt, Pt] {
  const w = Math.max(1, spec.armWidth)
  const { p, dir, out } = armFlank(spec, side, armClear(spec))
  const taper = side === 'exit' ? lockCorner(spec, 'exit')?.taper ?? 0 : entryTaper(spec)
  const reach = armReach(spec, side, w)
  return [
    [p[0] - dir[0] * w / 2, p[1] - dir[1] * w / 2],
    [p[0] + dir[0] * (reach + w / 2) + out[0] * taper, p[1] + dir[1] * (reach + w / 2) + out[1] * taper],
  ]
}
/** Test hook — the toothed ring BEFORE the root-fillet closing, so a test can
 *  tell a break in the profile from the resampling clipper does to the whole
 *  outline on its way through. */
export function __escToothRing(spec: EscapementSpec): Pt[] { return toothedRing(spec) }
export function __escLockPoints(spec: EscapementSpec, side: Side): number { return lockPoints(spec, side) }
/** Test hook — the locus the acting face is offset from, for the tooth's tip
 *  round. See `rawLocus`: the face standing exactly one round off this curve is
 *  what says the lock and the impulse are the ones the construction drew. */
export function __escLocus(spec: EscapementSpec, side: Side): Pt[] { return rawLocus(spec, side) }
/** Test hook — the first stretch of the pallet's relieved BACK, from the release
 *  corner outwards. With no tip land between them, this edge starts AT the
 *  working corner, so it is what now stands closest to a tooth at release and
 *  the tooth must drop clear of it. Measuring that is the only way to see the
 *  relief doing its job: grazing is not interference, so the binding check
 *  cannot see it, and the outline just shows a thin wedge. */
export function __escBackEdge(spec: EscapementSpec, side: Side): [Pt, Pt] {
  const { inner, rel } = nibFrame(spec, side, nibDepth(spec))
  const k = 2 * nibDepth(spec)
  return [inner, [inner[0] + k * rel[0], inner[1] + k * rel[1]]]
}

// ─── The escape wheel ─────────────────────────────────────────────────────────

/**
 * THE TWO FLANK DIRECTIONS AT THE TIP, and they are stated at the TIP CIRCLE and
 * held there whatever the apex does.
 *
 * Held, because the apex MOVES: it is drawn out past the tip circle to pay for
 * the round (see `toothGeom`), and a flank's slope in polar terms depends on
 * where it is drawn from. Re-derive the directions at the new apex and the two
 * chase each other — extending the apex makes the corner finer, a finer corner
 * needs a longer extension — which on a deep-toothed wheel runs away outright
 * (a 24 mm tooth comes to 3°, and the apex walked off to 58 mm on a wheel of 50).
 * Fixed here, the apex is a closed form and the teeth are the shape the laws say
 * at every depth.
 *
 * The land runs inwards at `TIP_RELIEF` off radial and the back at the slope
 * `flankAngle` gives it — whose bow term cancels exactly at the tip, so this is
 * the drawn edge and not an approximation of it. Both run BACK from the apex,
 * which is what makes the corner between them the one the tooth acts by. `y` is
 * behind the tooth.
 */
function tipDirs(Rm: number, rRoot: number, backSpan: number) {
  // The land's own slope, as its angular span over its length times a radius —
  // one number, so `uLand` can be written against whatever apex comes out and
  // still leave the land lying at this angle.
  const relief = (Rm * Math.tan(rad(TIP_RELIEF))) / Math.max(0.5, rRoot)
  const slope = (Rm * backSpan) / Math.max(0.5, Rm - rRoot)
  return { relief, slope, d1: norm([-1, relief]), d2: norm([-1, slope]) }
}

/**
 * Where the apex's own ray — the tip land's line, and now the WHOLE leading face
 * — crosses a given radius, as an angle off the tooth's ray. `fallback` for a
 * radius the ray never reaches, which only a degenerate tooth can ask for.
 */
function rayAngle(rApex: number, dirs: ReturnType<typeof tipDirs>, r: number, fallback: number): number {
  const b = rApex * dirs.d1[0]
  const disc = b * b - (rApex * rApex - r * r)
  if (!(disc > 0)) return fallback
  const t = -b - Math.sqrt(disc)                      // the first crossing, going in
  return Math.atan2(t * dirs.d1[1], rApex + t * dirs.d1[0])
}

/**
 * THE ROUND ON THE TOOTH TIP, inscribed in the corner the two flanks make at the
 * apex — everything about it, in the frame where the apex sits at (`rApex`, 0).
 *
 * The corner is a 39° point on a standard wheel, so a round of radius `f` sets
 * back 2.8·f along each edge and its centre stands 3·f in: the round is much
 * bigger than it looks, which is why the land has to be floored against it
 * (`LAND_KEEP`), why the radius has to be capped by what it costs in tooth
 * length (`TIP_SETBACK`), and why the apex has to be drawn out past the tip
 * circle at all.
 */
function tipCorner(rApex: number, dirs: ReturnType<typeof tipDirs>, f: number) {
  const { d1, d2 } = dirs
  const half = Math.acos(clamp(d1[0] * d2[0] + d1[1] * d2[1], -1, 1)) / 2
  const sin = Math.max(1e-4, Math.sin(half))
  const t = (f * Math.cos(half)) / sin                       // set-back along each edge
  const bis = norm([d1[0] + d2[0], d1[1] + d2[1]])
  const c: Pt = [rApex + (f / sin) * bis[0], (f / sin) * bis[1]]
  return {
    t,
    c,
    bis,
    h: f / sin,
    p1: [rApex + t * d1[0], t * d1[1]] as Pt,               // tangency on the land
    p2: [rApex + t * d2[0], t * d2[1]] as Pt,               // tangency on the back
    // How far behind the tooth's own ray the round's centre — the ACTING point —
    // ends up. The corner is not symmetric about the ray (a near-radial land on
    // one side, a 43° back on the other), so the centre leans back by better
    // than a radius, and the teeth are phased by this so that the acting point,
    // not the apex, lands on the contact point.
    dA: Math.atan2(c[1], c[0]),
  }
}

/**
 * THE TIP ROUND, FITTED — its centre, its two tangency points, and the apex the
 * flanks are drawn to, all at once.
 *
 * Three things have to come out exactly right, and they are what the three
 * unknowns (the centre, two numbers, and the apex, one) are spent on:
 *
 *   THE CROWN sits on the material circle and THE CENTRE on the acting circle,
 *   which is one constraint each way round: |Oc| = R. That is what makes the
 *   wheel the diameter it was asked for and puts the acting point where the
 *   pallets were laid out for it.
 *   TANGENT TO THE TIP LAND, which is a straight ray out of the apex, so this is
 *   one distance: |c to the ray| = f.
 *   TANGENT TO THE BACK, which is NOT a straight line — it is drawn in polar
 *   terms, so it swings as it runs — and that is the one the apex is solved for.
 *
 * Inscribing the round in the corner's two TANGENTS instead (which is what
 * `tipCorner` does, and what this used to do) misses the last of those: the back
 * has swung by the time the tangency reaches it — 2° on the default wheel, 7° on
 * a 40 mm one — and it swings towards the round, so the arc ends up crossing the
 * flank it should touch. Cut at the tangency, the tail of the arc then stands
 * 25 µm outside the back of the tooth; cut at the crossing instead, the arc is
 * short and meets the back at a 13° kink. Neither is visible and neither breaks
 * anything, which is exactly why it is worth solving properly rather than
 * carrying a caveat: a tip round that is tangent to both flanks is a claim a test
 * can pin, and an arc that crosses its own flank is not.
 *
 * Solved by bracketing rather than by iterating to a fixed point: the apex used
 * to be chased by re-deriving the corner at each trial, and on a deep-toothed
 * wheel that ran away outright (the corner gets finer as the apex goes out, which
 * asks for more apex). The flanks' DIRECTIONS are fixed by `tipDirs` and only the
 * apex moves, so what is left is one continuous function of one variable with a
 * sign change in it.
 */
function tipFit(rMat: number, R: number, rRoot: number, dirs: ReturnType<typeof tipDirs>, f: number) {
  const { d1, slope } = dirs
  // Into the tooth's own material, across the land: the body is BEHIND the land.
  const n: Pt = norm([d1[1], -d1[0]])
  /** The back flank, at its own parameter, drawn from apex `rA`. Linear in both r
   *  and angle over the tip — `flankAngle`'s bow does not start until well below
   *  it — so this is the drawn flank and not a straight-line stand-in for it. */
  const backAt = (rA: number, t: number): Pt => {
    const span = (slope * (rA - rRoot)) / Math.max(1e-6, rA)
    const r = rA - (rA - rRoot) * t
    const a = span * t
    return [r * Math.cos(a), r * Math.sin(a)]
  }
  /** The centre, for a trial apex: f off the land's ray and on the acting circle. */
  const centreFor = (rA: number): Pt => {
    const P: Pt = [rA + f * n[0], f * n[1]]
    const b = P[0] * d1[0] + P[1] * d1[1]
    const disc = b * b - (P[0] * P[0] + P[1] * P[1] - R * R)
    const u = disc > 0 ? -b - Math.sqrt(disc) : 0
    return [P[0] + u * d1[0], P[1] + u * d1[1]]
  }
  /** How close the back comes to that centre, and where. */
  const nearest = (rA: number, c: Pt) => {
    let best = { d: Infinity, t: 0 }
    const STEP = 240
    for (let i = 0; i <= STEP; i++) {
      const t = (0.5 * i) / STEP
      const q = backAt(rA, t)
      const d = Math.hypot(q[0] - c[0], q[1] - c[1])
      if (d < best.d) best = { d, t }
    }
    // Refine by ternary search on the bracket the scan leaves.
    let lo = Math.max(0, best.t - 0.5 / STEP), hi = Math.min(0.5, best.t + 0.5 / STEP)
    for (let i = 0; i < 40; i++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3
      const da = Math.hypot(backAt(rA, a)[0] - c[0], backAt(rA, a)[1] - c[1])
      const db = Math.hypot(backAt(rA, b)[0] - c[0], backAt(rA, b)[1] - c[1])
      if (da < db) hi = b; else lo = a
    }
    const t = (lo + hi) / 2
    const q = backAt(rA, t)
    return { d: Math.hypot(q[0] - c[0], q[1] - c[1]), t, at: q }
  }
  const gap = (rA: number) => nearest(rA, centreFor(rA)).d - f

  const fit = (rA: number) => {
    const c = centreFor(rA)
    const near = nearest(rA, c)
    // The tangency on the land is the foot of the perpendicular from the centre.
    const s = (c[0] - rA) * d1[0] + c[1] * d1[1]
    return {
      rApex: rA,
      c,
      p1: [rA + s * d1[0], s * d1[1]] as Pt,
      p2: near.at,
      past: near.t,
      dA: Math.atan2(c[1], c[0]),
    }
  }
  if (!(f > 1e-9)) return fit(rMat)
  // The apex is somewhere between the material circle and a few of the round's
  // own set-backs past it; scan for the sign change and close on it.
  const span = Math.max(4 * f, 8 * tipCorner(rMat, dirs, f).h)
  let lo = rMat, loG = gap(rMat)
  const STEP = 60
  for (let i = 1; i <= STEP; i++) {
    const rA = rMat + (span * i) / STEP
    const g = gap(rA)
    if (loG === 0) break
    if ((loG < 0) !== (g < 0)) {
      let a = lo, b = rA
      for (let j = 0; j < 50; j++) {
        const mid = (a + b) / 2
        if ((gap(mid) < 0) === (loG < 0)) a = mid; else b = mid
      }
      return fit((a + b) / 2)
    }
    lo = rA; loG = g
  }
  // No crossing anywhere in range — fall back to the corner's own tangents, which
  // is the construction this replaced and is right to within that swing.
  return fit(tipApex(rMat, dirs, f))
}

/**
 * WHERE THE FLANKS ARE DRAWN TO — the virtual apex, out past the tip circle.
 *
 * Its whole job is to pay for the round: the round is inscribed in the corner up
 * there, so its crown comes back down to the tip circle and its centre lands on
 * the ACTING circle a radius inside it. Both of those are exact here, which is
 * what lets the wheel be the diameter it was asked for and the pallets be laid
 * out on the circle the teeth really bear on.
 *
 * Closed form, because the corner's own shape does not move with the apex (see
 * `tipDirs`): the centre stands a fixed offset from the apex, so asking for
 * |OC| = Rm − f is one quadratic.
 */
function tipApex(Rm: number, dirs: ReturnType<typeof tipDirs>, f: number): number {
  const { bis, h } = tipCorner(0, dirs, f)
  const want = Math.max(0.5, Rm - f)
  const side = h * bis[1]
  return Math.max(Rm, -h * bis[0] + Math.sqrt(Math.max(0, want * want - side * side)))
}

/**
 * The tooth geometry every tooth-side function starts from: the two radii, the
 * angular spans of the two edges, and where the pallet's reach ends.
 *
 * One definition, because `toothedRing`, `gulletFillet`, `toothSpace` and the
 * readouts all have to be talking about the same tooth — they each had their own
 * copy of this arithmetic, and the readouts' copy is the one that would have gone
 * stale.
 */
function toothGeom(spec: EscapementSpec) {
  const { rho } = frame(spec)
  const { R, tipR, rMat, rRoot, backSpan: span0, pitch } = toothStock(spec)
  const dirs = tipDirs(rMat, rRoot, span0)
  // THE TIP ROUND AND THE APEX TOGETHER — the round tangent to both flanks with
  // its crown on the material circle, and the apex out past that circle to pay
  // for it. See `tipFit`.
  const fit = tipFit(rMat, R, rRoot, dirs, tipR)
  const rTip = fit.rApex
  const depth = rTip - rRoot
  // The spans the flanks are DRAWN with, re-stated for the apex they are now
  // drawn from so that each still leaves it on the direction `tipDirs` fixed —
  // which is what the round was inscribed against. Written once, here: every
  // tooth-side function reads these, so the drawn tooth, the gullet's walls and
  // the readouts cannot disagree about which tooth they mean.
  const backSpan = (dirs.slope * (rTip - rRoot)) / rTip
  // THE TIP LAND — the top of the leading face, cut almost RADIAL so the tooth
  // BEDS on the locking face instead of standing on a corner.
  //
  // Almost radial because the locking face IS radial. The construction puts the
  // arbor where the tangents to the tip circle cross, so at the contact point the
  // triangle centre–tip–arbor is right-angled AT THE TIP: the arbor radius and
  // the wheel radius are perpendicular there, and a face concentric with the
  // arbor is therefore radial to the wheel. That is what makes a deadbeat dead,
  // and it is the same answer for both pallets — no need to pick one. Without the
  // land the tooth meets that face at the full undercut and takes all the drive
  // through one line of end grain, which in a wooden wheel is how a tip goes
  // blunt.
  //
  // ALMOST, and the couple of degrees matter: a truly radial land FOULS THE
  // IMPULSE FACE. That face stands 53° off the locking face, so a land lying flat
  // on one is at 53° to the other and its inner corner ploughs into it — 0.061 mm
  // at the default, growing dead linearly with the land, which is the fingerprint.
  // `TIP_RELIEF` degrees of relief lifts that corner clear while opening the bed
  // by only its own length × the tangent, a few hundredths over the whole land.
  // Shortening the land instead works too and is the worse trade: it clears at
  // half the lock, which is half a bed.
  //
  // Sized from the LOCK, since that is how deep the pallet actually comes into
  // the tooth; a land shorter than that would bed on part of it only.
  //
  // AND IT HAS TO OUTLIVE THE TIP ROUND. The round is inscribed in the corner at
  // the top of this land, so it eats `t` of it — a good two radii, since the
  // corner is a 39° point — and a land shorter than that is one the round has
  // swallowed, leaving the undercut face below to meet the locking face instead.
  // So the land is floored at what the round takes plus a strip of its own,
  // measured at the tip circle (the apex is not known yet, and it moves this by
  // a few microns).
  const lock = rho * rad(Math.max(0, spec.escType === 'deadbeat' ? spec.lock : spec.recoilArc))
  const cap = TIP_LAND_MAX * depth
  const keep = Math.hypot(fit.p1[0] - rTip, fit.p1[1]) + LAND_KEEP * tipR
  const land = clamp(lock, Math.min(keep, cap), cap)
  const rLand = rTip - land
  // THE LAND IS THE APEX'S OWN RAY, so this is where that ray crosses the land's
  // inner radius — not `land·relief/rTip`, which is the same line only in the
  // limit. The two part company by a hundredth of a millimetre over a couple of
  // millimetres of land, which is nothing until the flat left over is short: the
  // land is then a chord between a point on the ray and a point off it, and on a
  // 40 mm wheel that chord runs 3° off the ray — so 3° off tangent to the very
  // round it is supposed to run into. Nothing in the outline shows it; the
  // tangency test does.
  const uLand = rayAngle(rTip, dirs, rLand, (land * dirs.relief) / rTip)
  // The undercut, as an angle at the root, taken over the face's OWN span below
  // the land. Increasing angle is BEHIND the tooth — the wheel runs clockwise —
  // so both of a tooth's edges run back from the tip: the leading face to a0+u
  // and the back to a0+backSpan. The tooth is the sliver between them, and the
  // tip still OVERHANGS the space in front of it, because nothing reaches in
  // front of the land.
  //
  // Put the undercut's foot in front of the tip instead and the tooth's root
  // projects forward into exactly the space the pallet's impulse face has to
  // occupy at the lock, and the escapement binds harder the more undercut it is
  // asked for — which is the tell.
  const u = clamp(rayAngle(rTip, dirs, rRoot, uLand), 0, backSpan * 0.9)
  // The root land, as an angle: what is left of the pitch once the back slope is
  // taken out and the undercut given back.
  const landAng = pitch - backSpan + u
  // How far a flank may bow, as an ANGLE at the root. Angular, not perpendicular
  // to the flank, so a bowed foot stays ON the root circle and the land between
  // two teeth simply runs between the feet it is given. Displace the foot off
  // that circle instead and the land still starts where the foot used to be,
  // which leaves a step in the outline at every tooth.
  //
  // The bowed flank eats the root land, so it is held to a share of it — all of
  // the share now, since the leading face no longer bows at all.
  const bowAng = TOOTH_BOW * BOW_SHARE * landAng
  // WHERE THE TOOTH'S OWN GROUND BEGINS, as a fraction of the tooth depth below
  // the APEX. A pallet dives ρ·Φ past the ACTING circle at the end of its swing,
  // so above that depth nothing may be added — stock there goes straight into the
  // pallet's way, and it is the recoil (whose pallet is the longer blade) that
  // finds it first. Below it the space is the tooth's own, and that is where the
  // strength is wanted. Both the flank bow and the gullet fill are held to it.
  //
  // Measured from the acting circle, not from the apex: the two are a tip round
  // plus the apex's own stand-off apart, and taken from the apex the floor would
  // sit that much higher than the pallet really reaches.
  const floor = R - rho * halfSwing(spec)
  const start = clamp((rTip - floor) / Math.max(0.5, depth) + BOW_KEEP, 0, 0.92)
  return {
    rRoot, rTip, rLand, depth, backSpan, u, uLand, landAng, bowAng, start, tipR, dirs,
    // The tip's round, from the same fit the apex and the land floor came out of
    // — so what is drawn, what the pallets were laid out for and what the land
    // was sized against are all one thing.
    corner: fit,
  }
}

/**
 * The angle of one bowed edge, `s` of the way along it. The law, on its own,
 * because `flank` draws with it and `toothSpace` measures with it, and the two
 * disagreeing would size the gullet against a tooth that is not there.
 *
 * The bow grows as the SQUARE of the depth below `start`, which is the whole
 * trick: at that depth it is zero and so is its slope, so the flank leaves the
 * pallet's region on exactly the line it would have taken and only fattens
 * further down. `dir` is which way is out of the tooth, and the foot angles
 * handed in already include the bow, so the curve lands on them.
 */
function flankAngle(
  a0: number, a1: number, s: number, dir: number,
  bowAng: number, start: number, tipFirst: boolean,
): number {
  const t = tipFirst ? s : 1 - s               // depth below the tip, 0…1
  const g = Math.max(0, (t - start) / Math.max(1e-6, 1 - start))
  return a0 + (a1 - a0) * s + dir * bowAng * (g * g - t)
}

/**
 * How wide the tooth SPACE is, in mm, at depth fraction `at` below the tip
 * circle — one tooth's back on one side and the next tooth's leading face on the
 * other, measured on the arc at that radius.
 *
 * This is what sizes the gullet fill, so it reads the two edges through
 * `flankAngle` rather than approximating them: a linearised back is a tenth of a
 * millimetre out where it matters, which is a tenth of a millimetre of fill
 * standing in the pallet's way.
 */
function toothSpace(spec: EscapementSpec, at: number): number {
  const { pitch } = frame(spec)
  const g = toothGeom(spec)
  const r = g.rTip - g.depth * at
  return (pitch + faceAngle(g, at) - backAngle(g, at)) * r
}

type Tooth = ReturnType<typeof toothGeom>

/** This tooth's back, at depth fraction `at` — from its own tip (0) to its foot
 *  (1), as an angle off the tip. */
function backAngle(g: Tooth, at: number): number {
  return flankAngle(0, g.backSpan + g.bowAng, clamp(at, 0, 1), 1, g.bowAng, g.start, true)
}

/**
 * The leading face, at depth fraction `at` — as an angle off its OWN tip.
 *
 * ONE LAW FOR THE WHOLE FACE, because the whole face is one straight line: the
 * apex's own ray, from the tip round's tangency down to the root. It used to be
 * three — a relieved land, then a radial stretch below it, then a bow flaring
 * forward to the root — and the face they made was DISHED (Rick, 2026-09-17: it
 * should be flat from the tip radius to the root). The kink where the land met
 * the radial stretch was 4.4° of it and the flare was the rest: measured against
 * the land's own line, the surface stood 0.035 mm forward at a sixth of the depth
 * and 1.12 mm forward at the root.
 *
 * Which matters for more than looks. This is the face a pallet's locking face
 * beds on, and a dished face beds on its two ends — so the drive lands on the
 * tip's round and on the root's flare rather than along the face. It is also the
 * face that must stay out of the way of the impulse face as the pallet dives,
 * and a flat face relieved at the tip is relieved at every depth below it, which
 * is the property the three-piece version only had near the tip.
 */
function faceAngle(g: Tooth, at: number): number {
  return rayAngle(g.rTip, g.dirs, g.rTip - g.depth * clamp(at, 0, 1), g.uLand)
}

/**
 * The GULLET — the round that fills the bottom of each tooth space, and the one
 * dimension of a wooden escape wheel that decides whether a tooth snaps off.
 *
 * It used to be a flat `ROOT_FILLET` of 0.6 mm, which was the cutter's radius and
 * nothing else: it left the one place a tooth actually breaks — its root, across
 * the grain — as sharp as the drawing, with a deep narrow slot behind it.
 *
 * **The pallet never reaches the gullet.** It dives ρ·Φ past the tip circle, and
 * everything below that is the tooth's own ground. So this is not a fillet in a
 * corner any more: at the radius that room allows, the closing that draws it
 * stops rounding the two corners and starts BRIDGING the space, filling it from
 * the bottom up — which is the whole point, material at the base of the tooth,
 * where nothing has to pass.
 *
 * WHICH MAKES IT A QUESTION ABOUT REACH, not about a width and not about a corner
 * radius. A closing by f is a disc of radius f rolled through the space, filling
 * everything it cannot reach — so a point of a wall SURVIVES if some f-disc can
 * still touch it, and is buried otherwise. The rule is then exactly one line: the
 * largest f that buries nothing above the pallet's floor. That is the closing's
 * own definition, run forwards, and it is monotone in f, so it bisects.
 *
 * Three sizings that look right and are not, all found by measuring the emitted
 * outline (`scripts/esc-gullet-sweep.mts`) rather than by reading:
 *
 *   HALF THE SPACE'S WIDTH at the floor is wrong by a third of a millimetre to a
 *   whole one, always in the direction that puts stock in the pallet's way. The
 *   width is measured along the ARC and the two walls are nothing like equally
 *   steep — between a near-radial leading face and a back at 40°, the arc gap is
 *   far wider than any disc that fits between them.
 *
 *   THE LARGEST DISC THAT FITS BELOW THE FLOOR is wrong the other way, and gives
 *   up half the fillet. A disc bigger than that does not overshoot: it cannot get
 *   down there at all, so it jams higher and fills MORE, which is the mechanism.
 *   Fitting below the floor is not the constraint.
 *
 *   THE DEEPEST DISC THAT JAMS BETWEEN THE WALLS misses the case that matters. A
 *   disc resting on the root circle with slack to both walls is jammed by nothing
 *   and passes any test written about its tangencies, while being far too big —
 *   it fills the whole gullet up to the tips. Reach has to be asked of every
 *   point, not of one disc.
 *
 * Floored at `ROOT_FILLET`, which is not a design choice: a cutter leaves that
 * much whatever is drawn. That floor is what a wheel whose pallet dives too deep
 * to fit falls back to — `divesTooDeep` is the honest report of that, not this.
 */
function gulletFillet(spec: EscapementSpec): number {
  const { pitch } = frame(spec)
  const g = toothGeom(spec)
  const rFloor = g.rTip - g.depth * Math.min(0.98, g.start + GULLET_KEEP)
  if (!(rFloor > g.rRoot + 0.05)) return ROOT_FILLET

  // The two walls of one gullet: this tooth's back running down from its tip at
  // angle 0, and the next tooth's leading face running up to its own tip at angle
  // `pitch`. Sampled over the whole depth, so a disc sitting high in the space
  // still sees the wall above it.
  const WALL = 40
  const sample = (off: number, ang: (at: number) => number): Pt[] => {
    const out: Pt[] = []
    for (let i = 0; i <= WALL; i++) {
      const at = i / WALL
      const r = g.rTip - g.depth * at
      const a = off + ang(at)
      out.push([r * Math.cos(a), r * Math.sin(a)])
    }
    return out
  }
  const near = sample(0, (at) => backAngle(g, at))
  const far = sample(pitch, (at) => faceAngle(g, at))
  const toWall = (p: Pt, w: Pt[]) => {
    let best = Infinity
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1], b = w[i]
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1)
      best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]))
    }
    return best
  }
  // How big a disc fits with its centre here: clear of both walls, and never
  // below the root circle.
  const room = (p: Pt) => Math.min(toWall(p, near), toWall(p, far), Math.hypot(p[0], p[1]) - g.rRoot)

  // Can a disc of radius f descend until it TOUCHES THE ROOT CIRCLE, clearing
  // both walls on the way? Its centre is then at rRoot + f by definition, so
  // there is only the angle to search.
  //
  // THIS IS WHAT KEEPS `toothDepth` HONEST, and it is the constraint the first
  // version of this was missing. Sizing the fill by "the largest disc that buries
  // nothing above the pallet's floor" bounds the TOP of the fill and says nothing
  // about its bottom — and a big disc cannot descend into a deep narrow gullet at
  // all, so it jams high and everything under it becomes solid. Deepening the
  // tooth makes the gullet deeper AND narrower, which lets a bigger disc jam
  // higher still, so past about 10 mm the floor rose faster than the root fell
  // and asking for a deeper tooth gave a SHALLOWER one: 24 mm of tooth depth
  // emitted a 1.26 mm tooth, and the wheel came out very nearly a circle.
  //
  // Tangency to the root circle fixes the floor at rRoot at every depth, so the
  // tooth is as tall as it was asked to be and the fill is only ever as fat as
  // the space at the bottom allows.
  const touchesRoot = (f: number): boolean => {
    const rc = g.rRoot + f
    const STEPS = 72
    for (let j = 0; j <= STEPS; j++) {
      const a = g.backSpan + ((pitch - g.backSpan) * j) / STEPS
      const p: Pt = [rc * Math.cos(a), rc * Math.sin(a)]
      if (toWall(p, near) >= f - 1e-6 && toWall(p, far) >= f - 1e-6) return true
    }
    return false
  }

  // Can an f-disc still touch this point? Stand one off along the wall's inward
  // Can an f-disc still touch this point? Stand one off along the wall's inward
  // normal and ask whether it fits. The normal's sign is taken by trying both and
  // keeping the roomier — the two walls face opposite ways and a sign rule would
  // be one more thing to get backwards.
  const reaches = (w: Pt[], i: number, f: number): boolean => {
    const p = w[i]
    const a = w[Math.max(0, i - 1)], b = w[Math.min(w.length - 1, i + 1)]
    const tx = b[0] - a[0], ty = b[1] - a[1]
    const n = Math.hypot(tx, ty) || 1
    for (const s of [1, -1]) {
      const c: Pt = [p[0] - (s * ty * f) / n, p[1] + (s * tx * f) / n]
      if (room(c) >= f - 1e-3) return true
    }
    return false
  }
  const buriesNothing = (f: number): boolean => {
    for (const w of [near, far]) {
      for (let i = 0; i < w.length; i++) {
        if (Math.hypot(w[i][0], w[i][1]) <= rFloor) continue
        if (!reaches(w, i, f)) return false
      }
    }
    return true
  }

  // Both, and both are monotone in f: a bigger disc needs more clearance to get
  // down, and leaves more behind when it cannot.
  const ok = (f: number) => touchesRoot(f) && buriesNothing(f)
  let lo = ROOT_FILLET, hi = g.depth + pitch * g.rTip
  if (!ok(lo)) return ROOT_FILLET
  for (let i = 0; i < 26; i++) {
    const m = (lo + hi) / 2
    if (ok(m)) lo = m; else hi = m
  }
  return Number.isFinite(lo) ? Math.max(ROOT_FILLET, lo) : ROOT_FILLET
}

/**
 * One toothed ring, centred on the origin.
 *
 * The tooth leans the way the wheel runs and its leading face is undercut, so the
 * only thing that can reach a pallet is its tip — which is what makes the pallet
 * face the locus of ONE point of the tooth and the whole construction above
 * possible. That point is not on the tooth's surface: the tip is ROUNDED, and
 * what the faces are drawn from is the CENTRE of the round (see `tipRound`). Under
 * the round the tip still carries a short almost-radial land, so what beds on a
 * locking face is a round blending into a land rather than a knife edge, and the
 * back is a long slope from the root land up to the next tip.
 *
 * The two flanks are drawn to the VIRTUAL APEX, out past the tip circle, and the
 * round is inscribed in the corner they make there — which is what puts the
 * round's own crown on the tip circle and its centre on the acting circle.
 *
 * Drawn for an anticlockwise wheel; a clockwise one is the mirror of it, applied
 * to the whole assembly at the end.
 */
function toothedRing(spec: EscapementSpec): Pt[] {
  const { N, pitch, beta } = frame(spec)
  const { rRoot, rTip, backSpan, u, bowAng, start, corner } = toothGeom(spec)
  // Phase the teeth so one ACTING POINT lands exactly on the entry contact point
  // — the round's centre, which is what the faces were generated from, and which
  // leans `dA` behind its tooth's own ray. It costs nothing and it makes the
  // drawing mean something: wheel and anchor are then shown in the relative
  // position they are actually in, mid-impulse, rather than at whichever phase
  // the tooth loop happened to start at.
  const phase = Math.PI / 2 + beta / 2 - corner.dA
  // Where the round hands over to the back — the fit's own tangency, which is on
  // the drawn flank and not on a straight-line stand-in for it.
  const past = corner.past
  const ring: Pt[] = []
  const at = (r: number, a: number) => ring.push([r * Math.cos(a), r * Math.sin(a)])
  at(rRoot, phase - pitch + backSpan + bowAng)   // foot of the back before the first tooth
  for (let i = 0; i < N; i++) {
    const a0 = phase + i * pitch
    arcInto(ring, 0, 0, rRoot, rRoot, a0 - pitch + backSpan + bowAng, a0 + u)
    faceInto(ring, rRoot, a0 + u, corner, a0)                           // up the leading face
    tipInto(ring, corner, a0)                                           // and round the tip
    flank(ring, rTip, rRoot, a0, a0 + backSpan + bowAng, 1, bowAng, start, past)  // down the back
  }
  return ring
}

/**
 * The top of one tooth: what is left of the tip land, then the round itself.
 *
 * The round is emitted with its CROWN as a sample on purpose — the outermost
 * point of the whole wheel is that crown, and the tip circle is measured off the
 * emitted outline, so a round sampled at arbitrary stations comes out a few
 * microns under the diameter that was asked for.
 *
 * `end` is where the back flank crosses the round, which is where the arc stops:
 * see `toothedRing`.
 */
function tipInto(ring: Pt[], corner: ReturnType<typeof tipFit>, a0: number): void {
  const c = rot(corner.c, a0)
  const f = Math.hypot(corner.p1[0] - corner.c[0], corner.p1[1] - corner.c[1])
  if (!(f > 1e-9)) { ring.push(rot([corner.rApex, 0], a0)); return }   // no round: the apex
  const a1 = Math.atan2(corner.p1[1] - corner.c[1], corner.p1[0] - corner.c[0]) + a0
  const a2 = Math.atan2(corner.p2[1] - corner.c[1], corner.p2[0] - corner.c[0]) + a0
  // From the land's tangency round to the back's, the short way — which is the
  // way over the crown, since the crown's own direction lies between the two.
  let sweep = a2 - a1
  while (sweep > Math.PI) sweep -= 2 * Math.PI
  while (sweep < -Math.PI) sweep += 2 * Math.PI
  const steps = 8
  const angs: number[] = []
  for (let i = 0; i <= steps; i++) angs.push(a1 + (sweep * i) / steps)
  // THE CROWN GOES IN WHEREVER IT FALLS, built as a list rather than pushed as
  // the arc is walked: the outermost point of the whole wheel is the crown, the
  // tip circle is measured off the emitted outline, and a walk that tested every
  // gap BUT THE LAST ONE left it out on any wheel whose round happens to end
  // just past it — which is a shallow tooth on a big wheel, where the back runs
  // so obliquely that its tangency is only a few degrees past the crown.
  const crown = Math.atan2(c[1], c[0])
  for (let i = 1; i < angs.length; i++) {
    const wrap = (x: number) => {
      let v = x
      while (v > Math.PI) v -= 2 * Math.PI
      while (v < -Math.PI) v += 2 * Math.PI
      return v
    }
    if (wrap(crown - angs[i - 1]) * wrap(crown - angs[i]) < 0) { angs.splice(i, 0, crown); break }
  }
  for (const a of angs) ring.push([c[0] + f * Math.cos(a), c[1] + f * Math.sin(a)])
}


/**
 * The leading face: one STRAIGHT run from its foot on the root circle up to the
 * tip round's tangency.
 *
 * Straight in CARTESIAN terms, which is the whole point — `flank`'s polar-linear
 * interpolation between the same two ends bulges 0.08 mm out of the face on the
 * default wheel, and a face that is meant to be flat should not be 0.08 mm proud
 * in the middle. Sampled rather than emitted as one edge so the gullet closing
 * has something to work with along it, the same reason `flank` samples a straight
 * flank.
 */
function faceInto(ring: Pt[], rRoot: number, aRoot: number, corner: ReturnType<typeof tipFit>, a0: number): void {
  const foot: Pt = [rRoot * Math.cos(aRoot), rRoot * Math.sin(aRoot)]
  const top = rot(corner.p1, a0)
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    ring.push([foot[0] + (top[0] - foot[0]) * t, foot[1] + (top[1] - foot[1]) * t])
  }
}

/** One flank, from (r0,a0) to (r1,a1), bowed outward from the tooth by
 *  `flankAngle`'s law. Always sampled, even dead straight: it costs nothing, it
 *  keeps the outline uniform for the gullet closing, and it means a genuine break
 *  in the profile shows up as one long edge instead of hiding among the flanks. */
function flank(
  out: Pt[], r0: number, r1: number, a0: number, a1: number,
  dir: number, bowAng: number, start: number, from = 0,
): void {
  const steps = 12
  const tipFirst = r0 > r1                     // the tip is the larger radius
  for (let i = 1; i <= steps; i++) {
    const s = i / steps
    if (s <= from) continue
    const a = flankAngle(a0, a1, s, dir, bowAng, start, tipFirst)
    const r = r0 + (r1 - r0) * s
    out.push([r * Math.cos(a), r * Math.sin(a)])
  }
}
// ─── Readouts ─────────────────────────────────────────────────────────────────

/**
 * The pinion this wheel CARRIES on its own arbor, or null. The escape wheel is
 * one of that pinion's two cheeks — see `EscapementSpec.arborPins`.
 */
export function carriedPinion(spec: EscapementSpec): PinRing | null {
  return pinRing(spec.arborPins, spec.arborPinCircleDia, spec.arborPinDia)
}

/** What the escapement does with the drive's work, per beat — see
 *  `escapementEnergy`. Everything is per unit of TORQUE at the escape wheel, so
 *  the figures are angles in radians: multiply by the wheel's own torque for real
 *  energy, or read the percentages, which is what they are for. */
export interface EscapementEnergy {
  /** What the drive spends per beat: the wheel turns half a tooth under its
   *  torque, whatever the escapement does with it. */
  driveWork: number
  /** What the anchor receives from the impulse before friction. It equals the
   *  wheel's impulse share EXACTLY for a conjugate pair, which is the identity
   *  that says the integration has the contact normal right — get that wrong and
   *  this stops matching `wheelImpulseDeg`. */
  impulseWork: number
  /** What reaches the pendulum. */
  delivered: number
  /** …as a fraction of `driveWork`. The number to watch. */
  efficiency: number
  /** Thrown away accelerating the wheel through the drop, and lost when the tooth
   *  lands. Dead loss, and it is the tick you hear. */
  dropLoss: number
  /** Taken by sliding friction on each of the two faces. */
  impulseFriction: number
  lockFriction: number
  /** How far the tooth slides on each face per beat, mm — what the friction is
   *  charged on, and the only part of this a caliper could check. */
  impulseSlide: number
  lockSlide: number
  /** The friction coefficient the two above were charged at. */
  friction: number
}

/**
 * THE ENERGY BUDGET, PER BEAT — does the pendulum get anything back?
 *
 * The drive spends the same amount every beat whatever the escapement is like:
 * the wheel gives up half a tooth under its own torque, so `driveWork` = M·beat
 * and that is the whole of what there is to spend. Three things happen to it.
 *
 *   THE DROP IS DEAD LOSS. The wheel runs free through `drop`, so the drive
 *   accelerates it through that angle and every bit of that kinetic energy is
 *   spent landing the tooth on the next pallet. It is the loudest thing an
 *   escapement does and it is pure waste: M·drop, a third of the budget at the
 *   defaults, and 1° → 4° of it takes the pendulum's share from 39% to 14%. This is the term a geometry-only reading of an escapement misses
 *   entirely, and it is why `drop` costs twice — less impulse AND more loss.
 *
 *   THE IMPULSE IS THE ONLY THING THAT PAYS. The tooth slides along the impulse
 *   face and the pallet turns: M·μ goes in, and for a frictionless conjugate pair
 *   ALL of it comes out at the anchor (∫F·d_A dφ = M·μ exactly, which is the
 *   check this integration is worth doing — get the contact normal wrong and that
 *   identity breaks).
 *
 *   THE TWO SLIDES TAKE THEIR CUT. At each contact the normal passes through the
 *   pair's instant centre, which gives the force from the wheel's torque balance
 *   (F = M/d_O), the torque it hands the anchor (F·d_A) and the slip speed. The
 *   slide on the impulse face is charged once; whatever the tooth rubs on BEFORE
 *   the impulse is charged twice, out to the extreme of the swing and back again
 *   — a deadbeat's dead face, or a RECOIL's recoil face, which is the longer rub
 *   under the higher force and makes a recoil the LESS efficient escapement, not
 *   the more (12.8% against 35% at modest settings).
 *
 * DRAW COSTS ALMOST NOTHING HERE, which is worth knowing because it looks like it
 * should cost everything: the drawn lock is a SPRING, not a brake. It does work
 * on the pendulum as the lock deepens and takes the same work back as it comes
 * out, so 6° of draw moves the budget by a fraction of a percent (it costs rate
 * and unlocking FORCE, not energy). What a deep LOCK costs is the slide it adds:
 * 6° of it takes the efficiency from 41% to 21%.
 *
 * What this cannot know is the drive torque and what the pendulum loses to air
 * and suspension, so it cannot say "it will run" — it says what fraction of
 * whatever the drive gives is still there when the pendulum gets it, which is
 * what moves when the parameters move.
 */
export function escapementEnergy(spec: EscapementSpec): EscapementEnergy {
  const { R, rho, mu, lam, beat, tipR } = frame(spec)
  const L = escapementDims(spec).centreDistance
  const drop = Math.max(0, rad(spec.drop))
  const anchorDir = -1                                  // the entry pallet's sense
  /**
   * One stretch of the acting locus, walked: what the tooth slides, what friction
   * takes, and what the anchor receives. The slip is the relative velocity of the
   * two material points in contact, which in the anchor's frame is just how fast
   * the acting point is moving — so the locus's own step, and its normal is the
   * contact normal. (The tip round adds ω_rel·r to that, a tenth of a percent,
   * and it is the same normal either way, which is why the FACE is this curve
   * offset by r.)
   */
  const walk = (tA: number, tB: number, steps: number) => {
    let slide = 0, friction = 0, work = 0
    let prev = locus(spec, 'entry', tA, false)
    for (let i = 1; i <= steps; i++) {
      const t = tA + ((tB - tA) * i) / steps
      const cur = locus(spec, 'entry', t, false)
      const step: Pt = [cur[0] - prev[0], cur[1] - prev[1]]
      const ds = Math.hypot(step[0], step[1])
      const C: Pt = [(cur[0] + prev[0]) / 2, (cur[1] + prev[1]) / 2]
      prev = cur
      if (!(ds > 1e-12)) continue
      const n: Pt = [-step[1] / ds, step[0] / ds]
      // Where the wheel's centre sits at this instant, in the anchor's frame —
      // the drop lock's rigid turn included, because the locus this walks was
      // built with it. Left out, the arm about the wheel is a few tenths of a
      // degree wrong all the way through and the conservation identity comes out
      // 3% off.
      const tm = tA + ((tB - tA) * (i - 0.5)) / steps
      const O = rot([0, -L], -anchorDir * (lam * tm + dropLock(spec) / 2))
      const P: Pt = [C[0] + tipR * n[0], C[1] + tipR * n[1]]
      const dA = Math.abs(P[0] * n[1] - P[1] * n[0])            // arbor at the origin
      const dO = Math.abs((P[0] - O[0]) * n[1] - (P[1] - O[1]) * n[0])
      if (!(dO > 1e-9)) continue
      const F = 1 / dO                                          // unit torque at the wheel
      work += F * dA * Math.abs((lam * (tB - tA)) / steps)
      slide += ds
      friction += ESC_FRICTION * F * ds
    }
    return { slide, friction, work }
  }
  const impulse = walk(-0.5, 0.5, IMPULSE_STEPS)
  const impulseFriction = impulse.friction
  const impulseSlide = impulse.slide
  const anchorWork = impulse.work
  // ── WHAT THE PENDULUM RUBS ON BEFORE THE IMPULSE ──
  //
  // A DEADBEAT's tooth rests on a face whose normal runs through the arbor, so
  // the force's arm about the WHEEL is the tip circle and the slip is the pallet
  // radius times the angle it travels. IT IS NOT OUT-AND-BACK ABOUT THE LANDING:
  // the tooth lands D deep, slides DEEPER by (lock − D) to the extreme of the
  // swing, and then slides all the way out THROUGH D to the corner, because the
  // corner is where it releases. So ρ·(2·lock − D), and the last term is the drop
  // lock's own depth — 0.8 mm of rub a beat at the defaults, charged once.
  //
  // Modelling it as 2·(lock − D) was the first cut and it hid a real effect
  // (Rick, 2026-09-17: "the wheel also slides 0.79 mm along the locking face and
  // then back — why is that not included"). It also made the figure DEAD FLAT
  // under about 2.1° of lock, because `dropLock` gives the run margin its half
  // millimetre first and lands the tooth deeper with whatever is left — so the
  // run-on alone cannot move there. Written properly it comes to ρ·lock +
  // RUN_MARGIN, which tracks the lock one for one at every lock, and the missing
  // rub was the reason it looked otherwise.
  //
  // A RECOIL has no dead face and rubs on its RECOIL face instead, through the
  // whole supplementary arc, driving the wheel backwards the while. That slide
  // was charged NOTHING here at first (Rick spotted it: `recoilArc` moved no
  // number on the readout, which for a recoil's biggest parameter cannot be
  // right), and it is the same integral as the impulse — the locus simply carries
  // on past t = −0.5 — so it is walked the same way. The drive's own work over it
  // cancels, as draw's does: the pendulum pushes the wheel back and gets it back.
  const recoil = spec.escType === 'recoil'
    ? walk(-0.5 - rad(Math.max(0, spec.recoilArc)) / lam, -0.5, RECOIL_STEPS)
    : null
  // A recoil needs no such term: with no drop lock its tooth lands ON the corner,
  // so its rub really is symmetric about where it landed.
  const lockSlide = recoil
    ? 2 * recoil.slide
    : rho * Math.max(0, 2 * rad(Math.max(0, spec.lock)) - dropLock(spec))
  const lockFriction = recoil ? 2 * recoil.friction : (ESC_FRICTION * lockSlide) / R
  const driveWork = beat
  const delivered = Math.max(0, Math.min(anchorWork, mu) - impulseFriction - lockFriction)
  return {
    driveWork,
    impulseWork: anchorWork,
    delivered,
    efficiency: driveWork > 0 ? delivered / driveWork : 0,
    dropLoss: Math.min(drop, beat),
    impulseFriction,
    lockFriction,
    impulseSlide,
    lockSlide,
    friction: ESC_FRICTION,
  }
}

export function escapementDims(spec: EscapementSpec): EscapementDims {
  const { R, Rm, tipR, N, L, rho, beat, mu, lam, pitch: pitchR } = frame(spec)
  const t = toothGeom(spec)
  const rRoot = t.rRoot
  const rimInner = rRoot - Math.max(2, spec.wheelDia / 30)
  const carried = carriedPinion(spec)
  const hub = seatHub(
    rimInner, clamp(spec.bore / 2, 0, rRoot - 1),
    // Three floors, and the largest wins: the stock the arbor wants round it,
    // what the spokes need to land on, and what the carried pinion's pin holes
    // need to fall in. They are passed separately so `HubFit.grownFor` can name
    // the one that bound — folded together, a hub raised by a floor reads as a
    // hub that simply ignored what was typed.
    spec.hubDia, spec.spokes, spokeWidth(spec), carried?.hubDia ?? 0,
  )

  // The impulse face's inclination to the dead arc: the angle its chord makes
  // with the perpendicular to the arbor radius.
  const a = locus(spec, 'entry', -0.5, false)
  const b = locus(spec, 'entry', 0.5, false)
  const chord: Pt = [b[0] - a[0], b[1] - a[1]]
  const mid = norm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
  const len = Math.hypot(chord[0], chord[1]) || 1
  const impulseAngleDeg = (Math.asin(clamp(Math.abs((chord[0] * mid[0] + chord[1] * mid[1]) / len), 0, 1)) * 180) / Math.PI

  const face = actingProfile(spec, 'entry')
  let faceWidth = 0
  for (let i = 1; i < face.length; i++) faceWidth += Math.hypot(face[i][0] - face[i - 1][0], face[i][1] - face[i - 1][1])

  const dive = rho * halfSwing(spec)
  // Tooth thickness WHERE IT LEAVES THE GULLET — at the top of the fill, which is
  // the first section that is the tooth's own material rather than the stock
  // joining it to its neighbours. Not at the root circle: the fill reaches well
  // above that now, so a thickness measured there is a thickness of solid wheel.
  const gFill = Math.min(0.98, t.start + GULLET_KEEP)
  const rSec = t.rTip - t.depth * gFill
  const toothBase = Math.max(0, pitchR * rSec - toothSpace(spec, gFill))
  // The lock actually left: what the anchor's swing buries the pallet by, less
  // the clearance the teeth were cut short by. And the part of it that is there
  // the moment the tooth lands, which is what the pallets' embrace buys.
  // Both MEASURED on the emitted profile — see `deadFace`. They are the dead face
  // a tooth can really rest on, not what the bare loci would have had: the round
  // on the locking corner and the tip round's own offset have taken their bite
  // out of it, and at a small lock that bite is most of the face.
  const deadRun = deadFace(spec)
  const dead = spec.escType === 'deadbeat'
  const lockDepth = deadRun.total
  const dropLockDepth = dead ? deadRun.landing : 0
  const w = Math.max(1, spec.armWidth)
  const hubR = Math.max(w * 0.75, spec.anchorBore / 2 + Math.max(1.5, w * 0.4))
  return {
    centreDistance: L,
    palletRadius: rho,
    toothPitchDeg: 360 / N,
    beatDeg: 180 / N,
    wheelImpulseDeg: ((beat - rad(Math.max(0, spec.drop))) * 180) / Math.PI,
    // What the pendulum has to beat to UNLOCK: half the lift to run the impulse
    // out, plus the half drop lock that the embrace puts in front of it. Any
    // swing past that is run to lock, which the escapement does not need.
    minHalfSwingDeg: ((lam / 2 + dropLock(spec) / 2) * 180) / Math.PI,
    impulseAngleDeg,
    faceWidth,
    impulseWidth: deadRun.impulse,
    recoilRatio: mu / lam,
    wheelRootDia: 2 * rRoot,
    hub,
    span: escapementSpan(spec.teeth),
    tipRound: tipR,
    actingRadius: R,
    lockRound: lockRound(spec),
    noImpulse: rad(Math.max(0, spec.drop)) >= beat - 1e-9,
    // The arbor sits L from the wheel centre and the teeth reach the TIP circle,
    // so there is only L−Rm of daylight for the anchor's own hub.
    hubFouls: hubR > L - Rm - 0.5,
    faceTooSteep: impulseAngleDeg > 60,
    palletDive: dive,
    toothBase,
    gulletRadius: gulletFillet(spec),
    lockDepth,
    dropLockDepth,
    // A deadbeat is judged on the DROP lock — it is never more than the total,
    // so this catches the clearance eating the whole lock as well as the
    // narrower case of it eating only what was there at the landing. A recoil
    // has no drop lock to judge and is asked the older question instead.
    noLock: (dead ? dropLockDepth : lockDepth) <= 0.02,
    landingShort: dead && dropLockDepth > 0.02 && dropLockDepth < LANDING_DEPTH - LANDING_SLACK,
    // The lock that seats the full landing, from the same estimate `dropLock`
    // spends — which is what makes it a fixed point: quote it, set it, and the
    // landing really does come out full. (It has to be the estimate and not
    // `deadFace`'s measurement, because it is answering "what lock WOULD seat
    // it", and there is no profile for a lock nobody has asked for yet.)
    fullLandingLockDeg: dead
      ? (((LANDING_DEPTH + cornerBlunt(spec) + RUN_MARGIN) / rho) * 180) / Math.PI
      : 0,
    // Measured against the mesh: past about half the tooth depth the impulse
    // face starts to reach the tooth it has just locked. See the sweep in
    // `scripts/escapement-check.mts`.
    divesTooDeep: dive > DIVE_LIMIT * (Rm - rRoot),
  }
}

/** The least room, mm, the anchor may leave the teeth anywhere they are NOT meant
 *  to be touched — see `escapementToothClearance`. Under this it is a warning:
 *  the pair runs on paper, and the build's errors decide whether it runs in wood.
 *
 *  The two margins are spent by OPPOSITE errors, which is why both are needed: a
 *  centre distance that is LONG lands the tooth shallower (`LANDING_DEPTH`), and
 *  one that is SHORT drives the pallet's tip at the tooth's back — about one for
 *  one on the default wheel (0.40 → 0.10 mm for 0.3 mm short, measured by moving
 *  the arbor on the drawn parts; at 2° of lock the same 0.3 mm puts the tip into
 *  the back). So this is the build's tolerance on the short side, as the landing
 *  is on the long side. */
export const TOOTH_CLEAR = 0.25

export interface ToothClearance {
  /** The closest the anchor comes to any part of a tooth other than its tip round
   *  and leading face, over the whole swing, mm. Zero is touching or worse. */
  clearance: number
  /** Which pallet comes that close. */
  side: Side
  /** How far below the tip circle the tooth is where it does, mm — which says
   *  WHAT is being hit: a fraction of a millimetre is the back just behind the
   *  tip, most of the tooth depth is the gullet. */
  depth: number
}

/**
 * THE ROOM BETWEEN THE ANCHOR AND THE BACKS OF THE TEETH — the one clearance the
 * other checks do not see.
 *
 * A pallet sits in a tooth space with the tooth it acts on in front of it and
 * the BACK of the next tooth behind it, and its tip (the release corner) is the
 * part that reaches deepest into that space. `divesTooDeep` asks only about the
 * impulse face against the tooth it just locked, and the pallet-tip test in the
 * suite only about the relieved back against the tooth TIPS at release. Nothing
 * asked about the pallet's tip against the back of a tooth — and that is what
 * the embrace spends: the drop lock turns both pallets deeper into the wheel, so
 * seating the full landing on the default wheel (Rick, 2026-09-18: at 2.1° of
 * lock "the tip of the pallet looks like it will hit the back of the tooth")
 * takes the exit pallet's tip from 0.40 mm off the back at 1.5° to 0.02 mm. DROP
 * is what pays for it — the drop is the free travel that is meant to carry the
 * tooth's back clear of the pallet — at about 0.3 mm of room per half degree.
 *
 * MEASURED on the real parts through the real motion: the anchor's outline and
 * the gulleted wheel, stepped through `escapementPose` — the same kinematics the
 * preview animates — so it cannot disagree with what is drawn. Only the tip round
 * and the leading face are left out, since a tooth is meant to touch the pallets
 * there; everything else on the wheel counts. The anchor is taken before
 * `filletToes`, whose rounds all sit well away from the wheel — checked against
 * the emitted outline, which gives the same figure to the micron.
 *
 * BOTH WAYS ROUND: the wheel's points against the anchor's edges AND the anchor's
 * points against the wheel's. The pallet's tip is one sharp vertex and a tooth's
 * back is sampled half a millimetre apart, so measuring from the wheel's points
 * alone misses the tip coming at the middle of a flank — which is how the first
 * harness read 0.13 mm where there are 0.08.
 *
 * Unmirrored, in the construction's own frame: a clockwise wheel is the
 * anticlockwise one's reflection, anchor and all, so the clearance is the same.
 *
 * Its own function rather than a field of `escapementDims`, which the preview
 * and the clock layers call every frame: this builds both parts and sweeps a
 * whole period — some 70 ms on the default wheel — and only the readouts want
 * it. They call it on every render, so the answer is kept for the last few
 * specs; position and hand are no part of it, so moving the shape is free.
 */
export function escapementToothClearance(spec: EscapementSpec): ToothClearance {
  const { cx: _cx, cy: _cy, clockwise: _cw, ...shape } = spec
  const key = JSON.stringify(shape)
  const hit = clearanceCache.get(key)
  if (hit) return hit
  const out = measureToothClearance(spec)
  clearanceCache.set(key, out)
  if (clearanceCache.size > 8) clearanceCache.delete(clearanceCache.keys().next().value!)
  return out
}
const clearanceCache = new Map<string, ToothClearance>()

function measureToothClearance(spec: EscapementSpec): ToothClearance {
  const S: EscapementSpec = { ...spec, clockwise: true }
  const { R, tipR, L, pitch, beta } = frame(S)
  const g = toothGeom(S)
  const { corner } = g
  const a00 = Math.PI / 2 + beta / 2 - corner.dA           // tooth 0, as `toothedRing` phases it
  const f = Math.hypot(corner.p1[0] - corner.c[0], corner.p1[1] - corner.c[1])

  // The wheel, split into what a pallet may touch and what it may not.
  const wheel = roundConcave([toothedRing(S)], gulletFillet(S))
    .reduce((a, b) => (b.length > a.length ? b : a), [] as Pt[])
  const TOL = 0.02
  const acting = (p: Pt) => {
    const k0 = Math.round((Math.atan2(p[1], p[0]) - a00) / pitch)
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      const a0 = a00 + k * pitch
      const c = rot(corner.c, a0)
      if (Math.hypot(p[0] - c[0], p[1] - c[1]) <= f + TOL) return true
      const foot: Pt = [g.rRoot * Math.cos(a0 + g.u), g.rRoot * Math.sin(a0 + g.u)]
      if (segDist(p, foot, rot(corner.p1, a0)) <= TOL) return true
    }
    return false
  }
  const free = wheel.map((p) => !acting(p))
  // Nothing on the wheel reaches past its material circle, so the anchor is only
  // asked about the stretch of it that comes within reach.
  const reach = R + tipR + 1
  const wIdx: number[] = []
  for (let i = 0; i < wheel.length; i++) if (free[i]) wIdx.push(i)

  // The anchor, in its own frame: arbor at the origin, wheel centre at (0, −L).
  const near: { pts: Pt[]; side: Side }[] = []
  for (const ring of anchorRings(S)) {
    let run: Pt[] = []
    const flush = () => {
      if (run.length > 0) near.push({ pts: run, side: run[0][0] < 0 ? 'entry' : 'exit' })
      run = []
    }
    for (let i = 0; i <= ring.length; i++) {
      const p = ring[i % ring.length]
      if (Math.hypot(p[0], p[1] + L) < reach + 3) run.push(p)
      else flush()
    }
    flush()
  }

  let best: ToothClearance = { clearance: Infinity, side: 'entry', depth: 0 }
  const pose = (phase: number) => {
    const p = escapementPose(S, phase)
    return { phi: rad(p.anchorDeg), back: -rad(p.wheelDeg) }
  }
  const at = (phi: number, back: number) => {
    for (const run of near) {
      // Into the wheel's frame: turn with the anchor, shift to its arbor, undo the wheel.
      const q = run.pts.map((p) => rot(((r) => [r[0], r[1] + L] as Pt)(rot(p, phi)), back))
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (const p of q) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
      const box = (p: Pt) => p[0] > x0 - 2 && p[0] < x1 + 2 && p[1] > y0 - 2 && p[1] < y1 + 2
      for (const i of wIdx) {
        const w = wheel[i]
        if (!box(w)) continue
        const note = (d: number) => {
          if (d < best.clearance) best = { clearance: d, side: run.side, depth: R - Math.hypot(w[0], w[1]) }
        }
        // The wheel's point against the anchor's edges…
        for (let k = 1; k < q.length; k++) note(segDist(w, q[k - 1], q[k]))
        // …and the anchor's points against the wheel's edge, which is what finds
        // a sharp pallet tip coming at the middle of a straight flank.
        const j = (i + 1) % wheel.length
        if (free[j]) for (const p of q) note(segDist(p, w, wheel[j]))
      }
    }
  }
  // A whole period covers both pallets, and a coarse sweep finds the worst step
  // for a fine one to pin down.
  //
  // THE DROP IS WALKED, NOT JUMPED. `escapementPose` moves the wheel through its
  // drop in one step, which is right for a preview and wrong here: the real wheel
  // passes through every angle in between with the anchor all but still, and a
  // tooth's back swinging past a pallet's tip mid-drop is exactly the collision
  // this is for. Neither the animation nor a sampled pose would ever show it.
  const STEPS = 360
  const dropRad = rad(Math.max(0, S.drop))
  let worstPhase = 0
  let prev = pose(0)
  for (let i = 0; i <= STEPS; i++) {
    const ph = i / STEPS
    const cur = pose(ph)
    if (i > 0 && dropRad > 0 && Math.abs(cur.back - prev.back) > dropRad / 2) {
      // Find the release itself, then turn the wheel through the drop there.
      let lo = (i - 1) / STEPS, hi = ph
      const b0 = prev.back
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2
        if (Math.abs(pose(mid).back - b0) > dropRad / 2) hi = mid
        else lo = mid
      }
      const a = pose(lo), b = pose(hi)
      for (let k = 0; k <= 40; k++) at(a.phi, a.back + ((b.back - a.back) * k) / 40)
    }
    const before = best.clearance
    at(cur.phi, cur.back)
    if (best.clearance < before) worstPhase = ph
    prev = cur
  }
  for (let i = -20; i <= 20; i++) {
    const p = pose(worstPhase + i / (20 * STEPS))
    at(p.phi, p.back)
  }
  return { ...best, clearance: Math.max(0, best.clearance) }
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const u = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1)
  return Math.hypot(a[0] + u * dx - p[0], a[1] + u * dy - p[1])
}

/** Spoke and rim widths are proportions of the wheel — an escape wheel has no
 *  module to state them in, and nobody wants two more fields to set them. */
function spokeWidth(spec: EscapementSpec): number {
  return Math.max(3, spec.wheelDia / 25)
}

/** How far above the wheel the anchor is drawn — clear of the teeth by a margin,
 *  on the line it really sits on, so the drawing still reads as an escapement. */
export function anchorOffset(spec: EscapementSpec): number {
  const { Rm, beta, rho } = frame(spec)
  const w = Math.max(1, spec.armWidth)
  const gap = Math.max(3, Rm * 0.06)
  return Rm + gap + Math.cos(beta / 2) * (rho + 2 * w)
}

// ─── Motion ───────────────────────────────────────────────────────────────────

export interface EscapementPose {
  /** Anchor rotation about its arbor, degrees, CCW positive. */
  anchorDeg: number
  /** Wheel rotation about its own centre, degrees, CCW positive. */
  wheelDeg: number
}

/**
 * Where the two stand at a given moment — the escapement's own kinematics, so a
 * preview shows what it really does rather than an animator's impression of it.
 *
 * `phase` counts PERIODS (two beats, one full swing out and back), and runs on
 * past 1 — the wheel advances exactly one tooth per period, so the pose is
 * continuous across the join with nothing to reset.
 *
 * Within a beat the anchor rocks φ = Φ·cos, and the wheel is carried by whichever
 * pallet has hold of it:
 *
 *   IMPULSE, φ within the pallet's own λ-wide window — the tooth is on the impulse
 *   face and the wheel turns μ for the anchor's λ, which is the ratio the faces
 *   were generated from.
 *   LOCKED, outside it — a deadbeat holds the wheel dead still; a recoil has no
 *   dead face, so the same straight-line relation carries on and drives the wheel
 *   BACKWARDS through the supplementary arc.
 *   RELEASE, at the low end of that window — the tooth drops off, the wheel runs
 *   free by `drop`, and the other pallet catches the next tooth.
 *
 * The two windows are not the same window: the drop lock slides the entry's down
 * by D/2 and the exit's up by D/2 (see `dropLock`), so one pallet releases D of
 * anchor travel BEFORE the other's impulse could begin — which is exactly the
 * dead face the arriving tooth lands on. The pair stays symmetric about the
 * anchor's neutral, so a pendulum still swings evenly.
 *
 * Which comes out at exactly half a tooth per beat, as it must.
 */
export function escapementPose(spec: EscapementSpec, phase: number): EscapementPose {
  const { lam, mu, pitch } = frame(spec)
  const Phi = halfSwing(spec)
  const drop = Math.max(0, rad(spec.drop))
  const half = lam / 2
  const shift = dropLock(spec) / 2
  const dead = spec.escType === 'deadbeat'

  const cycles = Math.floor(phase)
  const tau = phase - cycles
  const phi = Phi * Math.cos(2 * Math.PI * tau)
  const falling = tau < 0.5

  // What one pallet has moved the wheel by at anchor angle φ. Outside the
  // impulse a dead face holds it; a recoil face does not. Each pallet reads φ
  // through its own half of the embrace.
  const lim = (v: number) => (dead ? clamp(v, -mu / 2, mu / 2) : v)
  const entry = (p: number) => lim((-mu * (p + shift)) / lam)
  const exit = (p: number) => lim((mu * (p - shift)) / lam)
  const eRel = -half - shift          // where the entry lets go, falling
  const xRel = half + shift           // where the exit lets go, rising

  // Each pallet's own law, used DIRECTLY — no re-zeroing at the extreme of the
  // swing. A deadbeat is unaffected either way (its law is flat out there), but
  // a recoil face has no flat part, so re-zeroing shifts the wheel by μΦ/λ − μ/2
  // and the pair reads as binding through the whole supplementary arc.
  let adv: number
  if (falling) {
    // The entry works and lets go at eRel; the exit takes the next tooth, one
    // free `drop` further on — and takes it a drop lock deep, since its own
    // impulse cannot start until φ has climbed back to −λ/2 + D/2.
    if (phi >= eRel) adv = entry(phi)
    else adv = entry(eRel) + drop + exit(phi) - exit(eRel)
  } else {
    // Coming back: the exit is still on until xRel, then the entry catches.
    const handover = entry(eRel) + drop - exit(eRel)
    if (phi <= xRel) adv = handover + exit(phi)
    else adv = handover + exit(xRel) + drop + entry(phi) - entry(xRel)
  }
  adv += cycles * pitch

  // The construction runs clockwise, so advance is a NEGATIVE rotation — and the
  // anticlockwise wheel is its mirror, which flips both.
  const mir = spec.clockwise ? 1 : -1
  return {
    anchorDeg: (mir * phi * 180) / Math.PI,
    wheelDeg: (-mir * adv * 180) / Math.PI,
  }
}

// ─── Emission ─────────────────────────────────────────────────────────────────

export type EscapementPartKey =
  | 'wheel' | 'spokes' | 'bore' | 'arborpins' | 'anchor' | 'anchorbore' | 'ref'

export interface EscapementPart { key: EscapementPartKey; d: string }

/**
 * Wheel and anchor as separate paths — the teeth are profiled outside, the
 * spokes and bores inside, and the anchor is its own part on its own stock.
 * Drawn clear of each other; `escapementDims().centreDistance` is the spacing.
 */
export function generateEscapementParts(spec: EscapementSpec): EscapementPart[] {
  const d = escapementDims(spec)
  const rRoot = d.wheelRootDia / 2
  const yA = anchorOffset(spec)
  // The teeth lean the way the wheel runs, so the two directions are mirror
  // images and the whole assembly is mirrored together — anchor with wheel, or
  // they would no longer be cut for each other. The construction is laid out
  // CLOCKWISE (`locus` advances the wheel through negative angles), so it is the
  // anticlockwise wheel that is the reflection.
  const mir = spec.clockwise ? 1 : -1
  const place = (r: Pt[], dy = 0) =>
    r.map(([x, y]) => [spec.cx + mir * x, spec.cy + y + dy] as Pt)

  const out: EscapementPart[] = [{
    key: 'wheel',
    d: roundConcave([toothedRing(spec)], gulletFillet(spec)).map((r) => ringToD(place(r), true)).join(' '),
  }]

  const boreR = clamp(spec.bore / 2, 0, rRoot - 1)
  const anchorBoreR = Math.max(0, spec.anchorBore / 2)
  const holes: string[] = []
  if (boreR > 0.25) holes.push(ringToD(place(ellipseRing(0, 0, boreR, boreR)), false))
  if (holes.length > 0) out.push({ key: 'bore', d: holes.join(' ') })

  const rimInner = rRoot - Math.max(2, spec.wheelDia / 30)
  const windows = spokeWindows(Math.round(spec.spokes), rimInner, d.hub.dia / 2, spokeWidth(spec))
  if (windows.length > 0) {
    out.push({ key: 'spokes', d: windows.map((r) => ringToD(place(r), false)).join(' ') })
  }

  // The pins this wheel carries for the pinion on its own arbor — their own cut,
  // drilled rather than profiled, falling in the hub the dims have grown to hold
  // them. Placed unmirrored about the centre: a ring of holes is symmetric, and
  // `place`'s mirror is for the teeth's lean.
  const carried = carriedPinion(spec)
  if (carried) {
    out.push({
      key: 'arborpins',
      d: pinRingHoles(spec.cx, spec.cy, carried).map((r) => ringToD(r, false)).join(' '),
    })
  }

  out.push({
    key: 'anchor',
    d: filletToes(
      anchorRings(spec).map((r) => ringToD(place(r, yA), true)).join(' '),
      [spec.cx, spec.cy + yA],
      ARM_TOE * Math.max(1, spec.armWidth),
      spec, mir,
    ),
  })
  if (anchorBoreR > 0.25) {
    out.push({ key: 'anchorbore', d: ringToD(place(ellipseRing(0, 0, anchorBoreR, anchorBoreR), yA), false) })
  }

  return out
}

/**
 * Round the toe of each arm — the far corner where its outer edge turns down
 * towards the pallet, which nothing ever touches.
 *
 * Done with the app's own corner treatment, the same operation the corner tool
 * applies by hand, so there is no second implementation of a fillet here to get
 * the material side wrong.
 *
 * Picking WHICH corner is the whole problem, and the answer is the simplest one:
 * the toe is the point of each arm FURTHEST FROM THE ARBOR. Nearest-to-a-computed
 * point is not good enough — the two arms reach different distances, so on one of
 * them the extreme point is the arm's own end rather than where the stem crosses
 * its edge, and a calculation for the latter misses by the better part of a
 * centimetre. Distance from the arbor is true of both, and of a mirrored wheel.
 *
 * Two more are found the opposite way: by GEOMETRY rather than by rule, because
 * each is a specific named point the rest of this file already computes, and
 * both are rounded to the BIT rather than to the toe radius because they are
 * tight for the cutter rather than for the tooth — the deep-lock corner
 * (`lockCorner`) and the one the pallet's back makes with its arm
 * (`backCorner`). The first only works because `lockCorner` has already moved
 * that corner away from the wheel — rounded where it sits naturally, the
 * set-back would run back along the acting face and take the lock with it. The
 * second needs no such help; there is room where it stands. They are matched by
 * nearest coordinate in the PLACED (mirrored) outline, not by index — the raw
 * ring can come out with its winding reversed by the mirror (`ringToD`'s
 * CCW-forcing `reverse()`), which renumbers every vertex, so an index computed
 * before placement would not point at the same corner after it.
 *
 * NOTHING rounds the release corner where the acting face meets the relieved
 * back. That corner is the pallet's tip now that the tip land is gone, and it is
 * a working corner: it is where the tooth leaves. The land's own far corner used
 * to be rounded here, which is why this reads as one fillet short of the shape.
 */
function filletToes(d: string, arbor: Pt, r: number, spec: EscapementSpec, mir: number): string {
  if (r < 0.05) return d
  const corners = getTreatableCorners(d)
  if (corners.length === 0) return d

  // Every vertex of an outline this dense is technically a corner — hundreds of
  // short segments, each turning a fraction of a degree — so they are ranked by
  // how sharply they actually turn. The path is straight segments at this point,
  // before any treatment has put curves in it.
  const pts = d.replace(/[MZ]/g, ' ').split('L')
    .map((t) => t.trim().split(',').map(Number))
    .filter((q) => q.length === 2 && q.every(Number.isFinite)) as Pt[]
  const turn = (i: number) => {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length]
    let t = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])
    while (t > Math.PI) t -= 2 * Math.PI
    while (t < -Math.PI) t += 2 * Math.PI
    return Math.abs(t)
  }

  // A RECOIL'S ENTRY TOE IS ROUNDED HARDER — `RECOIL_TOE` rather than `ARM_TOE`,
  // 6 mm against 2.8 on a standard arm.
  //
  // The run-out along `lead` is what buries the wedge in its arm, and the entry
  // nib is the END of its arm, so on that side the run goes out into open air
  // with only the arm's outer edge to catch it. On a DEADBEAT it is caught a
  // fifth of a millimetre past the acting face, because the dead arc is
  // concentric with the arbor and its tangent runs across the arm. A RECOIL has
  // no dead arc: the locus is still climbing at the deep end, the same run-out
  // points nearly straight out, and the arm ends in a long thin spear.
  //
  // Rounding it is the right lever because that spear tip is ALREADY the corner
  // this picks as the arm's toe — the furthest point from the arbor on its side —
  // so nothing new has to be found or matched, and nothing that acts is touched.
  // What must NOT be done instead is to shorten the run-out: the blade then stops
  // before it reaches the arm, its end face crosses the arm's toe, and a DEADBEAT
  // comes out with a jog in the silhouette where a rounded toe used to be. That
  // was tried, and it broke the one profile that was already right.
  //
  // The size is an eye judgement and cannot be anything else: winding `drop` up
  // shortens the spear too, but by changing the angle it comes to a point at, so
  // there is no length to calibrate a radius against.
  //
  // The entry pallet sits at negative x in the anchor's own frame, so it lands on
  // the −mir side of the placed outline.
  const entryToe = spec.escType === 'recoil' ? RECOIL_TOE * Math.max(1, spec.armWidth) : r
  const pick = new Map<number, { type: 'outerRound'; radiusMM: number }>()
  for (const sideSign of [-1, 1]) {
    let far = 0, at = -1
    for (const c of corners) {
      if (Math.sign(c.x - arbor[0]) !== sideSign) continue
      if (c.idx >= pts.length || turn(c.idx) < TOE_MIN_TURN) continue
      const dist = Math.hypot(c.x - arbor[0], c.y - arbor[1])
      if (dist > far) { far = dist; at = c.idx }
    }
    if (at >= 0) {
      pick.set(at, { type: 'outerRound', radiusMM: sideSign === -mir ? entryToe : r })
    }
  }

  const place = (p: Pt): Pt => [arbor[0] + mir * p[0], arbor[1] + p[1]]
  const nearestCorner = (target: Pt, tol = 0.2): number => {
    let best = Infinity, at = -1
    for (const c of corners) {
      const dd = Math.hypot(c.x - target[0], c.y - target[1])
      if (dd < best) { best = dd; at = c.idx }
    }
    return best <= tol ? at : -1
  }

  for (const side of ['entry', 'exit'] as const) {
    // The two corners that are tight for the CUTTER rather than for the tooth,
    // so both are rounded to the bit rather than to the arm's toe radius: where
    // the face runs into the arm at the deep lock (`lockCorner` has already
    // taken the arm back far enough that this radius lands clear of the face),
    // and where the pallet's back does (`backCorner`, which needs no such room
    // made for it). Either can be absent, and then nothing is picked.
    for (const target of [lockCorner(spec, side)?.at, backCorner(spec, side)]) {
      const at = target && nearestCorner(place(target), 0.3)
      if (at !== undefined && at !== null && at >= 0) {
        pick.set(at, { type: 'outerRound', radiusMM: LOCK_RELIEF_BIT_DIA / 2 })
      }
    }
  }

  return pick.size === 0 ? d : applyCornerTreatments(d, pick)
}

/** Every part in one compound path — the live drag preview. */
export function generateEscapementD(spec: EscapementSpec): string {
  return generateEscapementParts(spec).map((p) => p.d).join(' ')
}

/** Wheel diameter for a drag box of this radius. The box sizes the WHEEL, which
 *  is what a user is thinking about; the anchor comes along above it. */
export function wheelDiaForRadius(radius: number): number {
  return Math.max(4, 2 * Math.max(1, radius))
}
