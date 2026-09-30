// ─── Rounding a profile's inside corners ───────────────────────────────────────
//
// The cutter is round, so an inside corner of a part is never sharp: it comes out with
// the tool's radius whatever the toolpath does. But the tool's CENTRE path does have a
// sharp corner there, and a Grbl-family controller has to brake almost to a stop to
// turn it (the junction-deviation rule — see sim/motionPlanner.ts) while the spindle
// keeps turning. On a small part with many inside corners — an escape wheel's roots —
// that is where plastic melts. Replace each sharp corner of the centre path with a
// small arc and the machine carries its feed through it; the only cost is a sliver of
// material left in the very bottom of the corner.
//
// Which corners, and which way, falls out of one rule: move the centre path AWAY from
// the part, never towards it. The region the tool centre sweeps is
//   outside profile — the part grown by the tool radius: its sharp corners are the
//                     DENTS at the part's inside corners. Fill them: a morphological
//                     CLOSING (grow by ρ, shrink by ρ) — the region only gets bigger.
//   inside profile  — the hole shrunk by the tool radius: its sharp corners are the
//                     POINTS reaching into the hole's corners. Trim them: an OPENING
//                     (shrink by ρ, grow by ρ) — the region only gets smaller.
// Either way the tool is pulled back from the wall, so this can leave stock but does not
// cut into the part — to within a few microns, since the circles both steps turn corners
// with are drawn as chords (ARC_TOLERANCE_MM); a sharp convex corner is bevelled by ~4 µm,
// which on an outside profile only trims the miter point that already stands well clear
// of the part. The G-code the profile then writes is fitted to 10 µm (profile.ts
// FINE_FIT_TOL_MM), and that fit is what bounds the finished path: on the escape-wheel
// project it comes at most 8.9 µm nearer the part than the tool radius. Both steps must be ROUND: a true closing by a
// disc. An earlier version grew with a MITER join so that corners it should not touch
// would come back exactly; on an escape wheel's tooth tip — a curve made of many small
// outward bends — the mitred grow and Clipper's clean-up did not come back, and a stretch
// of the tip was replaced by a straight chord and an 88° corner, which the machine had to
// stop for. With a disc, a region the disc can already roll round is left as it was.
//
// ρ is not assumed from a corner angle. It is found by BISECTION against the result:
// the largest ρ for which no point of the path moved more than `toleranceMM`. That
// bound is what makes it safe on any shape — a closing also fills a narrow channel,
// and a sharp V needs a far smaller ρ than a right angle for the same deviation, and
// the measured deviation catches both. One ρ serves a whole operation; the tightest
// corner sets it.

import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { mergeClosePoints, type Pt2 } from './pathFlattener'
import { stripClosingDuplicate } from './geom'

// Largest rounding radius tried, mm. Past this the arcs are long enough to change a part
// visibly, and the speed gained levels off.
const RHO_MAX_MM = 2
// Bisection steps: 2 mm / 2^9 ≈ 4 µm.
const BISECT_STEPS = 9
// How finely the round joins sample their arcs, mm. Fine enough that the G-code arc
// fitter sees a true circle and emits a G2/G3 rather than a run of chords, and that
// shrinking a chorded circle back bevels a corner by microns, not tens of them (2 µm
// here left a sharp corner 22 µm short).
const ARC_TOLERANCE_MM = 0.0002

type Ring = Pt2[]

function offsetRings(rings: Ring[], delta: number, join: JoinType): Ring[] {
  const out = inflatePathsD(
    rings.map((r) => r.map(([x, y]) => ({ x, y }))),
    delta, join, EndType.Polygon, 1000, 6, ARC_TOLERANCE_MM,
  )
  // Merged, as polyOps.inflateRings does: a round offset turns each gently bending vertex
  // into a pair of points a micron apart (see pathFlattener MERGE_POINTS_MM).
  return out
    .map((p) => mergeClosePoints(stripClosingDuplicate(p.map(({ x, y }) => [x, y] as Pt2)), undefined, true))
    .filter((p) => p.length >= 3)
}

// An edge this short that the path doubles back across is an offsetting artefact, not
// geometry — see dropSpikes.
const SPIKE_EDGE_MM = 0.05
const SPIKE_TURN_DEG = 60

/**
 * Remove the hooks offsetting leaves behind: a vertex where the path turns sharply over
 * an edge shorter than SPIKE_EDGE_MM. On an escape wheel, the closing left ONE of them in
 * the whole project — a 0.013 mm edge doubling back 100° where a corner arc began. It was
 * within tolerance of the part, but a near-reversal makes the machine stop dead, so it
 * showed as a jog in the path with a hot spot on it. A real rounding arc turns a few
 * degrees per vertex and is never touched. Dropping a vertex moves the path by at most
 * the short edge; the tolerance check that follows still bounds the result.
 */
export function dropSpikes(ring: Ring): Ring {
  let pts = ring.filter((q, i) => {
    const r = ring[(i - 1 + ring.length) % ring.length]
    return Math.hypot(q[0] - r[0], q[1] - r[1]) > 1e-6
  })
  for (let changed = true; changed && pts.length > 3;) {
    changed = false
    const n = pts.length
    for (let k = 0; k < n; k++) {
      const a = pts[(k - 1 + n) % n], b = pts[k], c = pts[(k + 1) % n]
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1])
      if (Math.min(l1, l2) >= SPIKE_EDGE_MM) continue
      const t = ((Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])) * 180) / Math.PI
      if (Math.abs(((t + 540) % 360) - 180) <= SPIKE_TURN_DEG) continue
      pts = pts.filter((_, i) => i !== k)
      changed = true
      break
    }
  }
  return pts
}

/** Close (outside) or open (inside) the tool-centre region by `rho`. */
export function roundCornersBy(rings: Ring[], rho: number, side: 'inside' | 'outside'): Ring[] {
  const s = side === 'outside' ? 1 : -1
  return offsetRings(offsetRings(rings, s * rho, JoinType.Round), -s * rho, JoinType.Round).map(dropSpikes)
}

// ── Distance from points to a set of rings, with a uniform grid of edges ──

class EdgeGrid {
  private cells = new Map<string, number[]>()
  private edges: number[] = []   // x0,y0,x1,y1 per edge
  constructor(rings: Ring[], private cell: number) {
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length]
        const k = this.edges.length / 4
        this.edges.push(a[0], a[1], b[0], b[1])
        const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell)
        const y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell)
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
          const key = `${gx},${gy}`
          const list = this.cells.get(key)
          if (list) list.push(k)
          else this.cells.set(key, [k])
        }
      }
    }
  }

  /** Distance from (x, y) to the nearest edge, if one lies within `reach`; else Infinity. */
  near(x: number, y: number, reach: number): number {
    const c = this.cell
    let best = Infinity
    const gx0 = Math.floor((x - reach) / c), gx1 = Math.floor((x + reach) / c)
    const gy0 = Math.floor((y - reach) / c), gy1 = Math.floor((y + reach) / c)
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const list = this.cells.get(`${gx},${gy}`)
      if (!list) continue
      for (const k of list) {
        const e = this.edges
        const ax = e[4 * k], ay = e[4 * k + 1], bx = e[4 * k + 2], by = e[4 * k + 3]
        const dx = bx - ax, dy = by - ay
        const L2 = dx * dx + dy * dy
        const u = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0
        const d = Math.hypot(x - (ax + u * dx), y - (ay + u * dy))
        if (d < best) best = d
      }
    }
    return best
  }
}

/**
 * Whether every point of `a` lies within `tol` of `b` AND every point of `b` within `tol`
 * of `a` — the two paths are the same shape to within the tolerance. (Vertices only: the
 * rounded arcs are sampled far finer than `tol`, and a straight edge between two vertices
 * that are both within `tol` stays within it of a straight-edged original.)
 */
export function withinTolerance(a: Ring[], b: Ring[], tol: number): boolean {
  const cell = Math.max(tol * 4, 0.5)
  const one = (from: Ring[], to: Ring[]) => {
    const grid = new EdgeGrid(to, cell)
    for (const r of from) for (const [x, y] of r) if (grid.near(x, y, tol) > tol) return false
    return true
  }
  return one(a, b) && one(b, a)
}

/**
 * The profile's tool-centre rings with their sharp corners rounded, as far as
 * `toleranceMM` allows — and the radius used (0 when nothing could be rounded, in which
 * case the rings come back unchanged).
 */
export function roundInsideCorners(
  rings: Ring[], side: 'inside' | 'outside', toleranceMM: number,
): { rings: Ring[]; rhoMM: number } {
  if (!(toleranceMM > 0) || rings.length === 0) return { rings, rhoMM: 0 }
  const accept = (rho: number): Ring[] | null => {
    const out = roundCornersBy(rings, rho, side)
    // A closing can merge two rings and an opening can split or delete one; either is a
    // change of shape no tolerance covers.
    if (out.length !== rings.length) return null
    return withinTolerance(rings, out, toleranceMM) ? out : null
  }
  const top = accept(RHO_MAX_MM)
  if (top) return { rings: top, rhoMM: RHO_MAX_MM }
  let lo = 0, hi = RHO_MAX_MM
  let best: Ring[] | null = null
  for (let k = 0; k < BISECT_STEPS; k++) {
    const mid = (lo + hi) / 2
    const out = accept(mid)
    if (out) { lo = mid; best = out } else hi = mid
  }
  return best ? { rings: best, rhoMM: lo } : { rings, rhoMM: 0 }
}
