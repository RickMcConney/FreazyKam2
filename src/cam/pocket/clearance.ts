// Is the tool allowed to travel from here to there? — asked of the DRAWN geometry.
//
// This is the foundation every toolpath rests on, and it replaces a stack of predicates
// that asked the question of OFFSET POLYGONS instead. That distinction is the whole point.
// Six separate bugs came out of the gap between an offset ring and the region it stood for:
// a point lying exactly ON a ring answered by the half-open crossing rule (three times over,
// each surfacing as a different shape that "still lifted"), a bounding box a few ulps off a
// ring, a straight link across a flattened curve, a mitered corner claiming ground the tool
// can legally cross, and an exclusion sized for stock the fill had already removed. None of
// them moved the cut — they lifted the tool, so the geometry always looked right.
//
// THE PREDICATE
//
//   safe(a -> b, r)  <=>  min distance from the segment ab to every ring  >=  r
//                         (given a is already in the region)
//
// and that is exact. If the segment never comes within r of any ring, and r > 0, then it
// never touched one, so it never CROSSED one, so it is still in whatever region a was in.
// One inequality, no sampling, no stepping, and no "is this point inside" question to get
// wrong — the degenerate case simply does not arise:
//
//   * the tool centre touching a wall is  dist == r  ->  allowed, exactly on the limit
//   * the tool centre on the design line is  dist == 0  ->  refused, for any real tool
//
// Compare what it replaces: three heuristics (a segment/edge crossing test, a solid-entry
// test, and a 7-sample containment vote) run against rings that had each been offset,
// flattened and joined, every step of which moved them away from the truth.
//
// WHY IT IS ALSO FASTER. The naive version of this — sample the move densely and measure
// each sample against every edge — is about 20 ms a call, and the call is the hottest in
// the CAM pipeline. But the exact minimum distance between two SEGMENTS is O(1), so the
// whole query is a walk over the edges near the move, which a uniform grid makes a handful.
// Roughly 15 edge tests where the predicate it replaces walked three entire rings.
//
// NOT a signed-distance field: no sphere tracing, no Lipschitz stepping. Marching stalls
// exactly where this code spends its life — travel running ALONG the limit, where the
// clearance is flat at r and every step is the tolerance. The segment-to-segment distance
// answers that case in closed form.

import { pointInPolygon } from '../geom'
import type { Pt2 } from '../pathFlattener'

// ─── exact segment-to-segment distance ─────────────────────────────────────────

/**
 * Squared distance between segment ab and segment cd. Zero when they touch or cross.
 *
 * The standard clamped-parametric solve: minimise |(a + s·u) − (c + t·v)|² over the unit
 * square, clamping s and t to it. `D` is the Gram determinant, zero when the segments are
 * parallel — including the collinear-overlap case travel along a wall produces constantly,
 * which the branch handles by pinning s to a's end and solving for t alone.
 */
export function segSegDistSq(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  const ux = bx - ax, uy = by - ay
  const vx = dx - cx, vy = dy - cy
  const wx = ax - cx, wy = ay - cy
  const a = ux * ux + uy * uy
  const b = ux * vx + uy * vy
  const c = vx * vx + vy * vy
  const d = ux * wx + uy * wy
  const e = vx * wx + vy * wy
  const D = a * c - b * b

  let sN: number, sD: number, tN: number, tD: number
  if (D <= 1e-14) {
    // Parallel, collinear, or one of them degenerate: hold s at 0 and solve t.
    sN = 0; sD = 1; tN = e; tD = c
  } else {
    sD = D; tD = D
    sN = b * e - c * d
    tN = a * e - b * d
    if (sN < 0) { sN = 0; tN = e; tD = c }
    else if (sN > sD) { sN = sD; tN = e + b; tD = c }
  }
  if (tN < 0) {
    tN = 0
    if (-d < 0) sN = 0
    else if (-d > a) sN = sD
    else { sN = -d; sD = a }
  } else if (tN > tD) {
    tN = tD
    const q = -d + b
    if (q < 0) sN = 0
    else if (q > a) sN = sD
    else { sN = q; sD = a }
  }
  const sc = sD <= 1e-14 ? 0 : sN / sD
  const tc = tD <= 1e-14 ? 0 : tN / tD
  const px = wx + sc * ux - tc * vx
  const py = wy + sc * uy - tc * vy
  return px * px + py * py
}

/**
 * Slack on the clearance comparison: one NANOMETRE.
 *
 * A rounding tolerance, not an allowance. It is sized to the coordinates themselves — the
 * offsets that produce the points being tested run through Clipper at `precision: 6`, so
 * they are only meaningful to 1e-6 mm and a comparison finer than that is comparing noise.
 * At 1e-9 a link down a circular pocket's wall measured 2.999999995 and was refused by four
 * PICOMETRES, which cost a plain circle five retracts it did not need.
 *
 * That this can be argued from the arithmetic at all is the point of the file: the
 * predicate it replaces expressed its answer as membership of an offset polygon, where
 * "just barely" had no meaning, and its epsilon was simultaneously too tight (it refused a
 * wall stepover) and unprincipled (widening it traded a gouge for an air move). Here the
 * answer is a distance, so slack means exactly what it says.
 */
export const CLEARANCE_EPS_MM = 1e-6

// ─── the field ─────────────────────────────────────────────────────────────────

/** A ring the tool must stay inside of, or outside of. */
export interface ClearanceRing { pts: Pt2[]; keepInside: boolean }

/**
 * The drawn geometry of one pocket region, indexed for distance queries.
 *
 * Built ONCE per plan and asked tens of thousands of times, so everything is flat typed
 * arrays and the grid is sized for a few edges per cell.
 */
export class ClearanceField {
  // Edges as [ax, ay, bx, by] quads.
  private readonly ex: Float64Array
  private readonly ey: Float64Array
  private readonly fx: Float64Array
  private readonly fy: Float64Array
  private readonly rings: ClearanceRing[]

  private readonly cell: number
  private readonly minX: number
  private readonly minY: number
  private readonly cols: number
  private readonly rows: number
  private readonly cellStart: Int32Array
  private readonly cellEdges: Int32Array

  // Visit stamps, so a query never tests an edge twice without clearing an array.
  private readonly stamp: Int32Array
  private generation = 0

  constructor(rings: ClearanceRing[]) {
    this.rings = rings.filter(r => r.pts.length >= 2)

    let n = 0
    for (const r of this.rings) n += r.pts.length
    this.ex = new Float64Array(n); this.ey = new Float64Array(n)
    this.fx = new Float64Array(n); this.fy = new Float64Array(n)

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let k = 0
    for (const r of this.rings) {
      const p = r.pts
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        this.ex[k] = p[j][0]; this.ey[k] = p[j][1]
        this.fx[k] = p[i][0]; this.fy[k] = p[i][1]
        k++
      }
      for (const [x, y] of p) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (n === 0) { minX = minY = 0; maxX = maxY = 1 }

    // Aim for ~2 edges per occupied cell. A cell much smaller than an edge makes the
    // walk long; much larger makes each cell a linear scan.
    const span = Math.max(maxX - minX, maxY - minY, 1e-6)
    this.cell = Math.max(span / Math.max(4, Math.ceil(Math.sqrt(n / 2))), 1e-6)
    this.minX = minX; this.minY = minY
    this.cols = Math.max(1, Math.floor((maxX - minX) / this.cell) + 1)
    this.rows = Math.max(1, Math.floor((maxY - minY) / this.cell) + 1)

    // Counting sort of edges into cells: every cell an edge's bounding box touches.
    const nCells = this.cols * this.rows
    const counts = new Int32Array(nCells + 1)
    const spans: number[] = []
    for (let i = 0; i < n; i++) {
      const c0 = this.col(Math.min(this.ex[i], this.fx[i])), c1 = this.col(Math.max(this.ex[i], this.fx[i]))
      const r0 = this.row(Math.min(this.ey[i], this.fy[i])), r1 = this.row(Math.max(this.ey[i], this.fy[i]))
      spans.push(c0, c1, r0, r1)
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * this.cols + c + 1]++
    }
    for (let i = 0; i < nCells; i++) counts[i + 1] += counts[i]
    this.cellStart = counts
    this.cellEdges = new Int32Array(counts[nCells])
    const cursor = Int32Array.from(counts.subarray(0, nCells))
    for (let i = 0; i < n; i++) {
      const c0 = spans[i * 4], c1 = spans[i * 4 + 1], r0 = spans[i * 4 + 2], r1 = spans[i * 4 + 3]
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.cellEdges[cursor[r * this.cols + c]++] = i
    }
    this.stamp = new Int32Array(n)
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)))
  }
  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)))
  }

  /**
   * Is the move from `a` to `b` clear of every ring by at least `clearanceMM`?
   *
   * PRECONDITION: `a` is already in the region — inside every keepInside ring and outside
   * every keepOutside one — which is what makes the result exact rather than merely
   * necessary (see the note at the top). Every caller in the pipeline satisfies it by
   * construction: the tool is standing on cut geometry that was itself built inside the
   * region. `containsPoint` is there for the one place that has to establish it.
   */
  isClear(a: Pt2, b: Pt2, clearanceMM: number, tolMM = CLEARANCE_EPS_MM): boolean {
    const limit = clearanceMM - tolMM
    if (limit <= 0) return true
    const limitSq = limit * limit
    const gen = ++this.generation

    const pad = Math.ceil(clearanceMM / this.cell)
    const ax = a[0], ay = a[1], bx = b[0], by = b[1]

    // Cells the segment passes through, dilated by the clearance. Walked as a supercover
    // so a move along a cell boundary cannot slip between two rows of cells.
    const c0 = this.col(Math.min(ax, bx)) - pad, c1 = this.col(Math.max(ax, bx)) + pad
    const r0 = this.row(Math.min(ay, by)) - pad, r1 = this.row(Math.max(ay, by)) + pad
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / this.cell) * 2)

    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t
      const cc = this.col(px), cr = this.row(py)
      const lo = Math.max(0, Math.max(cr - pad - 1, r0)), hi = Math.min(this.rows - 1, Math.min(cr + pad + 1, r1))
      const le = Math.max(0, Math.max(cc - pad - 1, c0)), re = Math.min(this.cols - 1, Math.min(cc + pad + 1, c1))
      for (let r = lo; r <= hi; r++) {
        const base = r * this.cols
        for (let c = le; c <= re; c++) {
          const idx = base + c
          for (let e = this.cellStart[idx]; e < this.cellStart[idx + 1]; e++) {
            const i = this.cellEdges[e]
            if (this.stamp[i] === gen) continue
            this.stamp[i] = gen
            if (segSegDistSq(ax, ay, bx, by, this.ex[i], this.ey[i], this.fx[i], this.fy[i]) < limitSq) return false
          }
        }
      }
    }
    return true
  }

  /** Distance from the segment to the nearest ring — for diagnostics, not the hot path. */
  segmentDistance(a: Pt2, b: Pt2): number {
    let best = Infinity
    for (let i = 0; i < this.ex.length; i++) {
      const d = segSegDistSq(a[0], a[1], b[0], b[1], this.ex[i], this.ey[i], this.fx[i], this.fy[i])
      if (d < best) best = d
    }
    return Math.sqrt(best)
  }

  /** Is this point in the region at all, ignoring clearance? Establishes the precondition. */
  containsPoint(p: Pt2): boolean {
    for (const r of this.rings) {
      if (pointInPolygon(p[0], p[1], r.pts) !== r.keepInside) return false
    }
    return true
  }
}

/** The field for one pocket region: inside its boundary, outside each of its islands. */
export function buildPocketClearance(boundary: Pt2[], islands: Pt2[][]): ClearanceField {
  return new ClearanceField([
    { pts: boundary, keepInside: true },
    ...islands.map(pts => ({ pts, keepInside: false })),
  ])
}
