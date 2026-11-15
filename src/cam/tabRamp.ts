// ─── Ramping over tabs ────────────────────────────────────────────────────────
//
// Used for a profile's own tabs (profile.ts `rampedPass`) and for the sheet's holding
// strips (bridges.ts `rampOverStrips`).
//
// A square tab costs four full stops per pass: the machine brakes to nothing to lift
// straight up, again to set off along the top, again to drop, and again to set off at
// depth — with Z, the slowest axis by far on a hobby machine, doing all of the lifting.
// A ramped tab climbs to the tab top and back down at `deg` from horizontal while it
// keeps travelling, and each of its four knees is a circular arc drawn as chords a few
// degrees apart, since the planner carries its speed through a small bend and brakes
// hard for a big one.
//
// The tab itself is untouched: the range a square tab holds the tool up over (the tab's
// length plus the cutter's clearance either side) is held at exactly the tab top here
// too. The ramps lie OUTSIDE it, so what changes is that a wedge of stock is left at
// the tab's foot each side — about (tab height above the pass) / tan(deg) long — which
// is trimmed off with the tab. The top knee's arc dips below the corner it rounds, so
// the corner is moved out by the arc's tangent length and the arc ends exactly where
// the hold begins.
//
// The ramp line is the same for every pass: a deeper pass only extends it further
// down, so each pass cuts one step-down slab under the last, as everywhere else.

/** Ramp over tabs instead of lifting straight up: the slope, and the radius of the knees. */
export interface TabRamp { deg: number; kneeMM: number }

/** Radius of a ramped tab's knees, mm, in the plane of the path and Z. */
export const TAB_KNEE_MM = 3
/** How finely a knee's arc is drawn: one chord per this many degrees of turn. */
const KNEE_STEP_DEG = 3

export function tabRampOf(params: { tabRampDeg?: number }): TabRamp | undefined {
  const deg = params.tabRampDeg ?? 0
  return deg > 0 && deg < 89 ? { deg, kneeMM: TAB_KNEE_MM } : undefined
}

/** How far past its hold a ramped tab reaches down to a floor `h` below its top. */
export function tabRampReachMM(h: number, ramp: TabRamp): number {
  if (h <= 0) return 0
  const th = ramp.deg * Math.PI / 180
  return 2 * ramp.kneeMM * Math.tan(th / 2) + h / Math.tan(th)
}

export interface RampShape { zAt: (s: number) => number; knots: number[] }

/** One tab's ramped profile over a floor at `zf`: Z as a function of arc length. */
export function tabRampShape(r: { start: number; end: number; tabZ: number }, zf: number, ramp: TabRamp): RampShape | null {
  const h = r.tabZ - zf
  if (h <= 1e-9 || r.end < r.start) return null
  const th = ramp.deg * Math.PI / 180
  const tn = Math.tan(th), c = Math.cos(th), half = Math.tan(th / 2)
  const rho = ramp.kneeMM
  const tt = rho * half                 // the top corner sits this far out from the hold
  const topArcU = rho * Math.sin(th)    // where the top arc meets the ramp
  const uc = tt + h / tn                // where the ramp line meets the floor
  // The bottom knee may not reach up past the top arc's foot.
  const rampFree = (uc - topArcU) / c
  const rb = rampFree > 0 ? Math.min(rho, rampFree / half) : 0
  const tb = rb * half
  // Profile by distance `u` outward from the hold's edge.
  const g = (u: number): number => {
    if (u <= 0) return r.tabZ
    let z: number
    if (u <= topArcU) z = r.tabZ - rho + Math.sqrt(Math.max(0, rho * rho - u * u))
    else if (rb > 0 && u >= uc - tb * c) {
      const du = u - (uc + tb)
      z = du >= 0 ? zf : zf + rb - Math.sqrt(Math.max(0, rb * rb - du * du))
    } else z = r.tabZ - (u - tt) * tn
    return Math.max(zf, z)
  }
  const us: number[] = [0]
  const n = Math.max(2, Math.ceil(ramp.deg / KNEE_STEP_DEG))
  for (let k = 1; k <= n; k++) us.push(rho * Math.sin(th * k / n))
  if (rb > 0) for (let k = 0; k <= n; k++) us.push(uc + tb - rb * Math.sin(th * k / n))
  else us.push(uc)
  const knots: number[] = []
  for (const u of us) knots.push(r.start - u, r.end + u)
  return {
    zAt: (s) => (s >= r.start && s <= r.end ? r.tabZ : g(s < r.start ? r.start - s : s - r.end)),
    knots,
  }
}

