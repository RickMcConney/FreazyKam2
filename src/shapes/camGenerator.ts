// ─── Archimedean cam with a lever ─────────────────────────────────────────────
//
// A snail cam: a spiral face that lifts a follower as the cam turns, with a lever
// to turn it by and a bore for its pivot. The workbench version of this is a cam
// clamp; the same part shows up as a lift cam, a hold-down and an eccentric stop.
//
// The face is an ARCHIMEDEAN spiral, r(θ) = r₀ + kθ, and that choice is the whole
// point of the shape: r grows linearly with angle, so the follower rises the same
// amount for every degree of handle movement. `k` is set by the rise the user asks
// for over a full revolution, k = rise/2π, which is the honest way to state it —
// lift per degree is a property of the spiral, not of how far this particular cam
// happens to sweep.
//
// Two numbers decide whether it works, and both are readouts rather than inputs:
//
//   PRESSURE ANGLE. The face's slope against the follower, tan φ = (dr/dθ)/r =
//   k/r. It is WORST at the base circle, where r is smallest, and it decides
//   whether the cam holds what it clamps: the follower pushes back along the
//   normal, and unless tan φ is under the coefficient of friction the cam unwinds
//   itself. Wood on wood is µ ≈ 0.3 (φ ≈ 17°), so a cam wants to be well under
//   that — a big base circle and a modest rise, not the other way round.
//
//   USABLE STROKE. The spiral may sweep less than a full turn (`sweepDeg`), and
//   the lever will foul the work long before a full turn anyway, so the stroke
//   actually available is rise × sweep/360 — never the rise per revolution.
//
// The lever is UNIONED onto the body and the junction smoothed by a morphological
// closing, the same way the cutting board blends its handle: one code path that
// blends a bar into a spiral without any case analysis. It sits on the STEP — the
// radial drop from the crest back to the base circle — where the body is at its
// thickest and the handle reinforces the one sharp corner in the shape.
//
// Emitted as separate parts: the outline is profiled, the bore is bored.

import {
  type Pt, clamp, arcInto, ellipseRing, roundRectRing,
  boolRings, roundConcave, ringToD,
} from './polyOps'

export interface CamSpec {
  cx: number; cy: number
  /** The starting circle — the follower's height at zero rotation. */
  baseDia: number
  /** Rise over a FULL revolution, mm. This is what sets the spiral's slope; the
   *  stroke actually reachable is this × sweep/360. */
  riseMM: number
  /** How far the spiral runs, degrees. 360 is a full snail; less leaves a relief
   *  arc at the base circle. */
  sweepDeg: number
  /** Pivot bore diameter. 0 for none. */
  boreDia: number
  /** Centre of the bore to the TIP of the lever, mm. */
  handleLength: number
  /** Lever width, mm. */
  handleWidth: number
}

export interface CamDims {
  baseDia: number
  /** Largest diameter — the crest of the spiral. */
  maxDia: number
  /** Rise per full revolution (the input). */
  risePerRev: number
  /** What this cam can actually lift, over its own sweep. */
  usableStroke: number
  /** Lift per degree of rotation — constant, which is why the spiral is used. */
  liftPerDeg: number
  /** Worst pressure angle, at the base circle, degrees. */
  pressureAngleDeg: number
  /** Best pressure angle, at the crest, degrees. */
  pressureAngleAtCrestDeg: number
  /** The lever is no longer than the crest — it is inside the cam, not a lever. */
  handleTooShort: boolean
  /** Friction cannot hold this: the follower will drive it back. µ ≈ 0.3 for wood
   *  on wood, and a clamp wants margin on that, so the flag trips at 10°. */
  wontHold: boolean
}

/** Chord tolerance on the spiral face, mm — a wooden cam, cut on a router. */
const FACE_TOL = 0.02
/** Fillet blending the lever into the body, as a fraction of the lever width. */
const BLEND = 0.35

export function camDims(spec: CamSpec): CamDims {
  const r0 = Math.max(0.5, spec.baseDia / 2)
  const rise = Math.max(0, spec.riseMM)
  const sweep = clamp(spec.sweepDeg, 5, 360)
  const k = rise / (2 * Math.PI)                    // mm per radian
  const stroke = (rise * sweep) / 360
  const crest = r0 + stroke
  return {
    baseDia: 2 * r0,
    maxDia: 2 * crest,
    risePerRev: rise,
    usableStroke: stroke,
    liftPerDeg: rise / 360,
    pressureAngleDeg: (Math.atan2(k, r0) * 180) / Math.PI,
    pressureAngleAtCrestDeg: (Math.atan2(k, crest) * 180) / Math.PI,
    handleTooShort: spec.handleLength <= crest + 0.5,
    wontHold: (Math.atan2(k, r0) * 180) / Math.PI > 10,
  }
}

/** The cam body: spiral face, radial step, and the relief arc if it sweeps short. */
function camBodyRing(spec: CamSpec): Pt[] {
  const r0 = Math.max(0.5, spec.baseDia / 2)
  const rise = Math.max(0, spec.riseMM)
  const sweep = clamp(spec.sweepDeg, 5, 360) * (Math.PI / 180)
  const k = rise / (2 * Math.PI)
  const crest = r0 + k * sweep

  const ring: Pt[] = []
  const at = (r: number, a: number) => ring.push([r * Math.cos(a), r * Math.sin(a)])

  // The face. Step size comes from the chord error of the local radius — the
  // spiral's curvature is close enough to a circle's at these proportions that
  // r·Δθ²/8 is the right measure, and it is taken at the crest, the worst case.
  const dt = Math.sqrt((8 * FACE_TOL) / Math.max(crest, 0.5))
  const steps = Math.max(24, Math.ceil(sweep / dt))
  for (let i = 0; i <= steps; i++) {
    const t = (sweep * i) / steps
    at(r0 + k * t, t)
  }

  // The step: straight back down to the base circle at the crest angle. This is
  // the one sharp corner in the shape, and the lever lands on it.
  at(r0, sweep)

  // Relief arc back to the start, when the spiral does not go all the way round.
  if (sweep < 2 * Math.PI - 1e-9) {
    arcInto(ring, 0, 0, r0, r0, sweep, 2 * Math.PI)
    ring.pop()   // the sweep closes on the first point
  }
  return ring
}

/** The lever, as a stadium along +X reaching from the pivot to its tip. */
function handleRing(spec: CamSpec): Pt[] {
  const hw = Math.max(0.5, spec.handleWidth) / 2
  const len = Math.max(1, spec.handleLength)
  // From the centre outward: the inner cap is buried in the body, so only the tip
  // shape matters — a fully rounded rect is a stadium.
  return roundRectRing(-hw, -hw, len + hw, 2 * hw, hw)
}

/** A cam's parts, each wanting its own operation. */
export type CamPartKey = 'cam' | 'bore'

export interface CamPart { key: CamPartKey; d: string }

/**
 * Outline and bore as separate paths.
 *
 * The outline is profiled and the bore is bored, which one compound path cannot
 * say — see the gear for the same reasoning and what it cost before.
 */
export function generateCamParts(spec: CamSpec): CamPart[] {
  const place = (r: Pt[]) => r.map(([x, y]) => [x + spec.cx, y + spec.cy] as Pt)

  // Union, then a closing to fill the concave corners the union leaves where the
  // lever meets the spiral and the base circle. Convex corners — the tip, the
  // crest — come through untouched, which is what makes this one call rather than
  // a case for each junction.
  const body = boolRings('union', [camBodyRing(spec)], [handleRing(spec)])
  const blend = Math.min(BLEND * Math.max(0.5, spec.handleWidth), Math.max(0.5, spec.baseDia / 2) * 0.4)
  const rings = roundConcave(body, blend)

  const out: CamPart[] = [{
    key: 'cam',
    d: rings.map((r) => ringToD(place(r), true)).join(' '),
  }]

  const boreR = clamp(spec.boreDia / 2, 0, Math.max(0.5, spec.baseDia / 2) - 0.5)
  if (boreR > 0.25) out.push({ key: 'bore', d: ringToD(place(ellipseRing(0, 0, boreR, boreR)), false) })
  return out
}

/** Every part in one compound path — the live drag preview. */
export function generateCamD(spec: CamSpec): string {
  return generateCamParts(spec).map((p) => p.d).join(' ')
}

/** Base diameter that makes a cam of this crest radius, holding the rise. */
export function baseDiaForRadius(radius: number, riseMM: number, sweepDeg: number): number {
  const stroke = (Math.max(0, riseMM) * clamp(sweepDeg, 5, 360)) / 360
  return Math.max(1, 2 * (Math.max(1, radius) - stroke))
}
