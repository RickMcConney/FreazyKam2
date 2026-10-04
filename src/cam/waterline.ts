// Waterline finishing for the 3D Profile: the tool runs round the model at constant Z,
// level by level, from each peak's tip down to its base.
//
// Everything is traced on the TIP surface — the lowest gouge-free tip height at (x, y)
// (`cl`, an exact drop-cutter for a ball nose) — so a ring at level z is simply where that
// surface crosses z, and the tool standing on it touches the model without cutting into it.
// The surface is sampled once on a grid, each level is contoured by marching squares, and
// every crossing of a level that is actually cut is then refined against `cl` itself, so
// the rings sit on the exact surface rather than on the grid's straight-line reading of it.
//
// SPACING IS A DISTANCE BETWEEN RINGS, NOT A Z STEP. The stepover is how far apart
// neighbouring passes are on the part. On a wall that is nearly the Z step; on gentle
// ground two levels a Z step apart can be a long way apart across the surface, and on a
// crown further still. So levels start a stepover apart in Z and an interval is halved
// wherever any point of one ring is further than the stepover (in 3D) from the ring at the
// other level. A ring with no neighbour at the next level — the crown of a peak, the
// bottom of a pit — is fine once it is no wider than the stepover; until then its interval
// keeps being halved, which is what carries the levels up to the top. The top level sits
// just under the highest point, so a crown is cut, not left standing.
//
// What the bisection cannot close is a FLAT: nothing at constant Z crosses it, however
// close the levels. Its interval stops at MIN_DZ_MM and the flat is left to another pass.
//
// ORDER. A ring is cut once every ring touching it from the level above is done, so each
// peak is cut tip to base and two peaks are both finished before the ring they share
// below. Going down one ring to the next is a RAMP along the next ring, and the ring is
// then cut on past where it started by the ramp's length to take what the ramp left: each
// ring therefore starts that much further round than the last, and the step-downs do not
// line up into a seam down the side of the part.

import type { BBox } from '../canvas/selectionUtils'
import { ptSegDistSq } from './geom'
import { inflatePathsD, unionD, differenceD, intersectD, FillRule, JoinType, EndType, type PathsD } from 'clipper2-ts'
import { perfLog } from '../debug'

/** The emitter a waterline drives — `PassEmitter` in profile3d.ts. */
export interface WaterlineEmitter {
  at: { x: number; y: number; z: number } | null
  /** Get to (x, y, z) from wherever the tool is: along the surface or over the top — never
   *  along a surface that climbs more than `maxClimbMM` above both ends. */
  arrive(x: number, y: number, z: number, overCleared?: boolean, maxClimbMM?: number): void
  cut(x: number, y: number, z: number): void
}

export interface WaterlineParams {
  stepoverMM: number
  maxDepthMM: number
  toolDiameterMM: number
  /** The gouge-free tip height at (x, y); null where there is no surface under the tool. */
  cl: (x: number, y: number) => number | null
  /** Whether a cut at (x, y, z) takes anything. Unset: always. A ring that takes nothing
   *  anywhere — a floor ring on a flat the roughing end mill already finished — is skipped. */
  needsCut?: (x: number, y: number, z: number) => boolean
  /** Where the tool centre may go, when a boundary sets it (rings, holes by even–odd).
   *  Unset: the box. Every flat's rings are cut inside it. */
  limit?: [number, number][][]
}

/** Below this the two levels of an interval are the same height to the machine. */
const MIN_DZ_MM = 0.002
/** How far inside the surface's top and bottom the outermost levels sit. */
const END_EPS_MM = 0.001
/** How far above the lowest point of the surface the lowest level stands. */
const BOTTOM_LIFT_MM = 0.02
/** Grid nodes the tip surface is sampled at, at most. */
const MAX_NODES = 800_000

interface Chain {
  /** x, y, z per point. */
  pts: number[]
  closed: boolean
  minX: number; minY: number; maxX: number; maxY: number
}

// ─── The tip surface on a grid ────────────────────────────────────────────────

class TipGrid {
  readonly nx: number
  readonly ny: number
  readonly cx: number
  readonly cy: number
  readonly v: Float64Array
  readonly zMin: number
  readonly zMax: number
  private readonly nextEdge: Int32Array
  private readonly isTo: Uint8Array

  constructor(readonly bbox: BBox, cell: number, private readonly cl: (x: number, y: number) => number) {
    if ((bbox.width / cell + 1) * (bbox.height / cell + 1) > MAX_NODES) {
      cell = Math.sqrt((bbox.width * bbox.height) / MAX_NODES) * 1.01
    }
    this.nx = Math.max(2, Math.ceil(bbox.width / cell) + 1)
    this.ny = Math.max(2, Math.ceil(bbox.height / cell) + 1)
    this.cx = bbox.width / (this.nx - 1)
    this.cy = bbox.height / (this.ny - 1)
    const { nx, ny } = this
    this.v = new Float64Array(nx * ny)
    let lo = Infinity, hi = -Infinity
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const z = cl(bbox.minX + i * this.cx, bbox.minY + j * this.cy)
        this.v[j * nx + i] = z
        if (z === z) { if (z < lo) lo = z; if (z > hi) hi = z }
      }
    }
    this.zMin = lo
    this.zMax = hi
    this.nextEdge = new Int32Array(2 * nx * ny).fill(-1)
    this.isTo = new Uint8Array(2 * nx * ny)
  }

  // The two nodes of an edge. Horizontal edges are numbered j·nx + i (node (i, j) to
  // (i + 1, j)); vertical ones nx·ny + j·nx + i (node (i, j) to (i, j + 1)).
  private edgeNodes(e: number): [number, number] {
    const n = this.nx * this.ny
    return e < n ? [e, e + 1] : [e - n, e - n + this.nx]
  }

  private nodeXY(k: number): [number, number] {
    const i = k % this.nx, j = (k - i) / this.nx
    return [this.bbox.minX + i * this.cx, this.bbox.minY + j * this.cy]
  }

  /** Where level z crosses edge e — read off the grid, or refined against the surface. */
  private crossing(e: number, z: number, refine: boolean, out: number[], vals: Float64Array): void {
    const [a, b] = this.edgeNodes(e)
    const va = vals[a], vb = vals[b]
    const [ax, ay] = this.nodeXY(a), [bx, by] = this.nodeXY(b)
    let t = (z - va) / (vb - va)
    if (refine) {
      // Illinois regula falsi on f(t) = cl(t) − z, bracketed by the two nodes. Where the
      // surface turns sharply inside the edge (the foot of a wall) it may not converge in
      // the iterations it is given, and then the point is put at the end of the bracket
      // that is still known to be CLEAR of the surface — a little stock, never a gouge.
      let t0 = 0, f0 = va - z, t1 = 1, f1 = vb - z, g0 = f0, side = 0
      let done = false
      for (let it = 0; it < 5; it++) {
        const ft = this.cl(ax + (bx - ax) * t, ay + (by - ay) * t) - z
        if (!(ft === ft)) break
        if (Math.abs(ft) < 1e-4) { done = ft <= 1e-5; if (done) break }
        if ((ft >= 0) === (g0 >= 0)) {
          t0 = t; f0 = g0 = ft
          if (side === -1) f1 /= 2
          side = -1
        } else {
          t1 = t; f1 = ft
          if (side === 1) f0 /= 2
          side = 1
        }
        t = (t0 * f1 - t1 * f0) / (f1 - f0)
      }
      if (!done) t = g0 < 0 ? t0 : t1
    }
    out.push(ax + (bx - ax) * t, ay + (by - ay) * t, z)
  }

  /**
   * The contours of level z, each with the material (the surface above z) on its RIGHT —
   * climb, for a clockwise spindle. A contour reaching the edge of the box, or a stretch
   * with no surface under it, is an open chain: the tool stays inside the box, as the
   * raster does, and is never sent round a hole in the model.
   */
  trace(z: number, refine: boolean, vals: Float64Array = this.v): Chain[] {
    const { nx, ny, nextEdge, isTo } = this
    const v = vals
    // Refinement reads the tip surface, so only its own contours can be refined.
    refine = refine && vals === this.v
    const n = nx * ny
    const froms: number[] = []
    const tos: number[] = []
    const add = (from: number, to: number) => { nextEdge[from] = to; isTo[to] = 1; froms.push(from); tos.push(to) }
    const ins = [false, false, false, false]
    const eid = [0, 0, 0, 0]
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i
        const v0 = v[k], v1 = v[k + 1], v2 = v[k + nx + 1], v3 = v[k + nx]
        if (!(v0 === v0 && v1 === v1 && v2 === v2 && v3 === v3)) continue
        // Corners counter-clockwise from (i, j); edge c runs from corner c to corner c + 1.
        ins[0] = v0 >= z; ins[1] = v1 >= z; ins[2] = v2 >= z; ins[3] = v3 >= z
        const code = (ins[0] ? 1 : 0) | (ins[1] ? 2 : 0) | (ins[2] ? 4 : 0) | (ins[3] ? 8 : 0)
        if (code === 0 || code === 15) continue
        eid[0] = k; eid[1] = n + k + 1; eid[2] = k + nx; eid[3] = n + k
        // An edge walked counter-clockwise from outside to inside is where the contour
        // ENTERS the cell; it leaves by an edge from inside to outside. Entering → leaving
        // keeps the material on the right.
        if (code === 5 || code === 10) {
          const centreIn = (v0 + v1 + v2 + v3) / 4 >= z
          for (let c = 0; c < 4; c++) {
            if (ins[c] || !ins[(c + 1) & 3]) continue
            add(eid[c], eid[(c + (centreIn ? 3 : 1)) & 3])
          }
        } else {
          let enter = -1, leave = -1
          for (let c = 0; c < 4; c++) {
            const a = ins[c], b = ins[(c + 1) & 3]
            if (!a && b) enter = c
            else if (a && !b) leave = c
          }
          add(eid[enter], eid[leave])
        }
      }
    }

    const chains: Chain[] = []
    const walk = (start: number, closed: boolean) => {
      const pts: number[] = []
      let e = start
      for (;;) {
        this.crossing(e, z, refine, pts, v)
        const nxt = nextEdge[e]
        nextEdge[e] = -1
        if (nxt < 0 || (closed && nxt === start)) break
        e = nxt
      }
      if (pts.length >= 6) chains.push(withBounds(pts, closed))
    }
    // Open chains first, from their heads; whatever is left is a closed loop.
    for (const f of froms) if (nextEdge[f] >= 0 && !isTo[f]) walk(f, false)
    for (const f of froms) if (nextEdge[f] >= 0) walk(f, true)
    for (const t of tos) isTo[t] = 0
    return chains
  }
}

/** How far above a chord's level the surface may stand at its middle before the chord is
 *  bent out round it. */
const CHORD_TOL_MM = 0.002

/**
 * Bend a contour out wherever the straight move between two of its points would cut into
 * the surface. The points are exact, but a faceted model is not smooth between them: the
 * ball rolling over a facet's corner stands higher than either neighbour, and a 1/8" ball
 * round a polygonal boss's rim cut 0.03 mm in at the corners. Each segment's middle is
 * read; where it stands above the level, a point is put out to the left (away from the
 * material) at the first place the surface is back down to the level, and both halves are
 * checked again.
 */
function tighten(c: Chain, z: number, cl: (x: number, y: number) => number, reach: number): Chain {
  const p = c.pts, m = p.length / 3
  const out: number[] = []
  const bend = (ax: number, ay: number, bx: number, by: number, depth: number) => {
    const mx = (ax + bx) / 2, my = (ay + by) / 2
    const cm = cl(mx, my)
    if (!(cm > z + CHORD_TOL_MM) || depth > 3) return
    const L = Math.hypot(bx - ax, by - ay)
    if (L < 1e-6) return
    const lx = -(by - ay) / L, ly = (bx - ax) / L   // the left: away from the material
    let lo = 0, hi = reach
    if (!(cl(mx + lx * hi, my + ly * hi) <= z)) return   // nothing clear within reach: leave it
    for (let it = 0; it < 6; it++) {
      const s = (lo + hi) / 2
      if (cl(mx + lx * s, my + ly * s) <= z) hi = s
      else lo = s
    }
    const qx = mx + lx * hi, qy = my + ly * hi
    bend(ax, ay, qx, qy, depth + 1)
    out.push(qx, qy, z)
    bend(qx, qy, bx, by, depth + 1)
  }
  const segs = c.closed ? m : m - 1
  for (let s = 0; s < segs; s++) {
    const a = s * 3, b = ((s + 1) % m) * 3
    out.push(p[a], p[a + 1], p[a + 2])
    bend(p[a], p[a + 1], p[b], p[b + 1], 0)
  }
  if (!c.closed) out.push(p[(m - 1) * 3], p[(m - 1) * 3 + 1], p[(m - 1) * 3 + 2])
  return withBounds(out, c.closed)
}

/** Taubin smoothing of a ring: its passes, and the shrink and inflate factors. */
const SMOOTH_PASSES = 20
const SMOOTH_LAMBDA = 0.5
const SMOOTH_MU = -0.53
/** How far a smoothed point may stand above the surface's level before it is pulled back. */
const SMOOTH_TOL_MM = 0.003

/**
 * Smooth a contour sideways, keeping it on the surface.
 *
 * Where the tip surface is nearly level — the ball rolling off a wall onto the floor at
 * its foot, or over a flat top's edge — a contour at fixed height is ill-conditioned: the
 * STL's facets ripple that surface by microns, and a ring at one height wanders sideways
 * by tenths of a millimetre, round a shape that is a perfect circle. A machine follows
 * those wanders as jerks. But that is exactly where a sideways move costs almost nothing
 * in height (the surface is level there), so the ring is smoothed (Taubin: alternate
 * shrink and inflate, so a round ring keeps its size) and every point that moved checked
 * against the exact surface: one that would now stand more than SMOOTH_TOL_MM below the
 * surface is pulled back toward where it was until it does not. On a steep wall the rings
 * are smooth already and the smoothing hardly moves them.
 */
function smoothRing(c: Chain, z: number, cl: (x: number, y: number) => number): Chain {
  const p = c.pts, m = p.length / 3
  if (m < 5) return c
  const x0 = new Float64Array(m), y0 = new Float64Array(m)
  for (let k = 0; k < m; k++) { x0[k] = p[k * 3]; y0[k] = p[k * 3 + 1] }
  let x = Float64Array.from(x0), y = Float64Array.from(y0)
  const nx = new Float64Array(m), ny = new Float64Array(m)
  for (let it = 0; it < 2 * SMOOTH_PASSES; it++) {
    const f = it % 2 === 0 ? SMOOTH_LAMBDA : SMOOTH_MU
    for (let k = 0; k < m; k++) {
      if (!c.closed && (k === 0 || k === m - 1)) { nx[k] = x[k]; ny[k] = y[k]; continue }   // an open contour's ends stay on the box
      const a = (k + m - 1) % m, b = (k + 1) % m
      nx[k] = x[k] + f * ((x[a] + x[b]) / 2 - x[k])
      ny[k] = y[k] + f * ((y[a] + y[b]) / 2 - y[k])
    }
    x = Float64Array.from(nx); y = Float64Array.from(ny)
  }
  const out: number[] = []
  for (let k = 0; k < m; k++) {
    let sx = x[k], sy = y[k]
    if (!(cl(sx, sy) <= z + SMOOTH_TOL_MM)) {
      // Back toward where it was, as far as the surface allows.
      let lo = 0, hi = 1   // fraction of the move kept
      for (let i = 0; i < 6; i++) {
        const t = (lo + hi) / 2
        const hx = x0[k] + (x[k] - x0[k]) * t, hy = y0[k] + (y[k] - y0[k]) * t
        if (cl(hx, hy) <= z + SMOOTH_TOL_MM) lo = t
        else hi = t
      }
      sx = x0[k] + (x[k] - x0[k]) * lo; sy = y0[k] + (y[k] - y0[k]) * lo
    }
    out.push(sx, sy, z)
  }
  return withBounds(out, c.closed)
}

function withBounds(pts: number[], closed: boolean): Chain {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  return { pts, closed, minX, minY, maxX, maxY }
}

// ─── Distance from a point to a level's contours ──────────────────────────────

/** The segments of one level's contours, bucketed so a nearest-distance query is local. */
class SegIndex {
  private readonly bins = new Map<number, number[]>()   // bin → [chain, segStart, …]
  constructor(readonly chains: Chain[], private readonly bin: number) {
    chains.forEach((c, ci) => {
      const p = c.pts, m = p.length / 3
      const segs = c.closed ? m : m - 1
      for (let s = 0; s < segs; s++) {
        const a = s * 3, b = ((s + 1) % m) * 3
        const i0 = Math.floor(Math.min(p[a], p[b]) / bin), i1 = Math.floor(Math.max(p[a], p[b]) / bin)
        const j0 = Math.floor(Math.min(p[a + 1], p[b + 1]) / bin), j1 = Math.floor(Math.max(p[a + 1], p[b + 1]) / bin)
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const key = i * 1_000_003 + j
          let list = this.bins.get(key)
          if (!list) this.bins.set(key, list = [])
          list.push(ci, s)
        }
      }
    })
  }

  /** The nearest chain within `r` of (x, y), and its squared distance; chain −1 if none. */
  nearest(x: number, y: number, r: number): { chain: number; d2: number } {
    const { bin } = this
    let best = r * r, chain = -1
    const i0 = Math.floor((x - r) / bin), i1 = Math.floor((x + r) / bin)
    const j0 = Math.floor((y - r) / bin), j1 = Math.floor((y + r) / bin)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const list = this.bins.get(i * 1_000_003 + j)
      if (!list) continue
      for (let q = 0; q < list.length; q += 2) {
        const c = this.chains[list[q]], s = list[q + 1]
        const p = c.pts, m = p.length / 3
        const a = s * 3, b = ((s + 1) % m) * 3
        const d2 = ptSegDistSq(x, y, p[a], p[a + 1], p[b], p[b + 1])
        if (d2 <= best) { best = d2; chain = list[q] }
      }
    }
    return { chain, d2: best }
  }
}

/** Every point of `from` lies within `h` of `to` — or belongs to a contour no wider than
 *  the stepover that has nothing near it at all (a crown, or the bottom of a pit). */
function covered(from: Chain[], to: SegIndex, h: number, stepover: number): boolean {
  for (const c of from) {
    const small = Math.hypot(c.maxX - c.minX, c.maxY - c.minY) <= stepover
    let hit = 0, miss = 0
    for (let i = 0; i < c.pts.length; i += 3) {
      if (to.nearest(c.pts[i], c.pts[i + 1], h).chain >= 0) hit++
      else miss++
      if (miss && (hit || !small)) return false
    }
  }
  return true
}

// ─── Choosing the levels ──────────────────────────────────────────────────────

function chooseLevels(grid: TipGrid, zTop: number, zBot: number, stepover: number): { levels: number[]; flats: [number, number][] } {
  const traces = new Map<number, { chains: Chain[]; index: SegIndex }>()
  const at = (z: number) => {
    let t = traces.get(z)
    if (!t) {
      const chains = grid.trace(z, false)
      t = { chains, index: new SegIndex(chains, Math.max(stepover, grid.cx * 2)) }
      traces.set(z, t)
    }
    return t
  }
  const ok = (hi: number, lo: number): boolean => {
    const dz = hi - lo
    const h2 = stepover * stepover - dz * dz
    if (h2 <= 0) return false
    const h = Math.sqrt(h2)
    const A = at(hi), B = at(lo)
    return covered(B.chains, A.index, h, stepover) && covered(A.chains, B.index, h, stepover)
  }

  const levels: number[] = [zTop]
  // Intervals the bisection could not close: a flat lies between their two levels.
  const flats: [number, number][] = []
  const split = (hi: number, lo: number) => {
    if (hi - lo < MIN_DZ_MM || ok(hi, lo)) {
      if (hi - lo < MIN_DZ_MM) flats.push([lo, hi])
      levels.push(lo)
      return
    }
    const mid = (hi + lo) / 2
    split(hi, mid)
    split(mid, lo)
  }
  const n = Math.max(1, Math.ceil((zTop - zBot) / stepover))
  for (let k = 0; k < n; k++) split(zTop - (zTop - zBot) * k / n, zTop - (zTop - zBot) * (k + 1) / n)
  return { levels, flats }
}

// ─── Flats ─────────────────────────────────────────────────────────────────────
//
// Nothing at constant Z crosses a flat, so the level search stops at its edge and leaves
// the middle standing — on the steep-walls test, the whole floor round the boss and dome.
// A flat is cut like a pocket floor instead: rings stepped in from its edge by the
// stepover, which are the contours of each point's distance from that edge. Every point of
// such a ring reads the surface (`cl`) for its height, so a ring that passes close to a wall
// rides up over its foot rather than into it, and it is cut after the rings round its edge.

/** Flats this near the stock top are the top itself: nothing to cut. */
const STOCK_TOP_MM = -0.01

/** A flat ring put on the surface: each point at the surface's height, and a point added
 *  wherever the straight move between two would cut into it. */
function onSurface(c: Chain, cl: (x: number, y: number) => number): Chain {
  const p = c.pts, m = p.length / 3
  const zAt = (x: number, y: number, fallback: number) => { const z = cl(x, y); return z === z ? z : fallback }
  const out: number[] = []
  const bend = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, depth: number) => {
    const mx = (ax + bx) / 2, my = (ay + by) / 2
    const mz = zAt(mx, my, Math.max(az, bz))
    if (!(mz > (az + bz) / 2 + CHORD_TOL_MM) || depth > 3) return
    bend(ax, ay, az, mx, my, mz, depth + 1)
    out.push(mx, my, mz)
    bend(mx, my, mz, bx, by, bz, depth + 1)
  }
  const z: number[] = []
  for (let k = 0; k < m; k++) z.push(zAt(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]))
  const segs = c.closed ? m : m - 1
  for (let s = 0; s < segs; s++) {
    const b = (s + 1) % m
    out.push(p[s * 3], p[s * 3 + 1], z[s])
    bend(p[s * 3], p[s * 3 + 1], z[s], p[b * 3], p[b * 3 + 1], z[b], 0)
  }
  if (!c.closed) out.push(p[(m - 1) * 3], p[(m - 1) * 3 + 1], z[m - 1])
  return withBounds(out, c.closed)
}

/** A ring made of `pts` (x, y) at the surface, with the bounds a Chain carries. */
function chainOf(pts: { x: number; y: number }[], cl: (x: number, y: number) => number): Chain {
  // Dense enough that `onSurface` reads the surface all along it: an offset of a straight
  // edge is two points however long it is.
  const dense: number[] = []
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length]
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5))
    for (let i = 0; i < n; i++) dense.push(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n, 0)
  }
  return onSurface(withBounds(dense, true), cl)
}

/**
 * The region {tip surface ≥ z} inside the box, as Clipper polygons, from that level's
 * contours — which keep the material on their right. A contour that runs off the box is
 * closed along the box's edge, walking it clockwise (the box's inside on the right) from
 * where the contour leaves to where the next one comes back in.
 */
function regionOf(chains: Chain[], box: BBox, edgeIn: boolean): PathsD {
  const W = box.width, H = box.height, L = 2 * (W + H)
  // Position along the edge, clockwise from the bottom-left corner.
  const param = (x: number, y: number) => {
    const dl = x - box.minX, dt = box.maxY - y, dr = box.maxX - x, db = y - box.minY
    const m = Math.min(dl, dt, dr, db)
    if (m === dl) return y - box.minY
    if (m === dt) return H + (x - box.minX)
    if (m === dr) return H + W + (box.maxY - y)
    return 2 * H + W + (box.maxX - x)
  }
  const corner = (q: number): { x: number; y: number } =>
    q === 0 ? { x: box.minX, y: box.minY } : q === H ? { x: box.minX, y: box.maxY }
      : q === H + W ? { x: box.maxX, y: box.maxY } : { x: box.maxX, y: box.minY }
  const corners = [H, H + W, 2 * H + W, L]
  const out: PathsD = []
  const open: { pts: { x: number; y: number }[]; ps: number; pe: number }[] = []
  for (const c of chains) {
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i < c.pts.length; i += 3) pts.push({ x: c.pts[i], y: c.pts[i + 1] })
    if (c.closed) { out.push(pts); continue }
    open.push({ pts, ps: param(pts[0].x, pts[0].y), pe: param(pts[pts.length - 1].x, pts[pts.length - 1].y) })
  }
  // No contour reaches the box's edge, so the edge is all on one side of the level: when it
  // is the material's side, the box itself is the region's outside (clockwise, material on
  // the right) and the closed contours are its holes. Missing it, a pit's lowest level read
  // as no region at all, and its "floor" became the whole box — rings down the pit's walls.
  if (!open.length && edgeIn) out.push([
    { x: box.minX, y: box.minY }, { x: box.minX, y: box.maxY }, { x: box.maxX, y: box.maxY }, { x: box.maxX, y: box.minY },
  ])
  const used = new Array(open.length).fill(false)
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue
    const loop: { x: number; y: number }[] = []
    let k = i
    for (let guard = 0; guard <= open.length; guard++) {
      used[k] = true
      loop.push(...open[k].pts)
      // The next contour to come back in, clockwise from where this one left.
      const pe = open[k].pe
      let next = -1, best = Infinity
      for (let j = 0; j < open.length; j++) {
        if (used[j] && j !== i) continue
        const d = ((open[j].ps - pe) % L + L) % L
        if (d < best) { best = d; next = j }
      }
      if (next < 0) break
      // The box's corners passed on the way, in clockwise order from where it left.
      corners.map((q) => ({ q, d: ((q - pe) % L + L) % L }))
        .filter((c) => c.d > 0 && c.d < best).sort((a, b) => a.d - b.d)
        .forEach((c) => loop.push(corner(c.q % L === 0 ? 0 : c.q)))
      if (next === i) break
      k = next
    }
    out.push(loop)
  }
  // Material on the right is clockwise: the region is where the winding is negative.
  return out.length ? unionD(out, FillRule.Negative) : []
}

/**
 * Add the rings that cut every flat — the floor below the lowest level, a sunk model's
 * top above the highest, and each interval the level search stopped at — to `rings`.
 *
 * A flat's region comes from the contours either side of it, which are refined against
 * the exact surface, and its rings are that region pulled in by one stepover, two, … —
 * Clipper offsets with round joins. Round a round shape they are true circles. (They were
 * once the contours of each grid node's distance to the nearest node off the flat; that
 * distance is stepped by the grid, and its contours wandered round a perfect circle.)
 *
 * The first ring waits on the rings round the flat's edge (those above it), each one after
 * on the ring outside it. Returns how many flats got rings.
 */
function addFlats(
  grid: TipGrid, rings: Ring[], levels: number[], intervals: [number, number][],
  stepover: number, reach: number, cl: (x: number, y: number) => number,
  limit?: [number, number][][],
): number {
  const box = grid.bbox
  // Where the tool may go: the boundary's limit when there is one — a flat's region built
  // from the box alone ran its rings straight out past a heart-shaped boundary — else the box.
  const boxPath: PathsD = limit?.length
    ? unionD(limit.map((r) => r.map(([x, y]) => ({ x, y }))), FillRule.EvenOdd)
    : [[{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }]]
  const within = (region: PathsD) => limit?.length ? intersectD(region, boxPath, FillRule.NonZero) : region
  const regular = rings.length
  const chainsAt = (z: number) => rings.filter((r) => r.z === z).map((r) => r.chain)
  // Whether the box's edge stands at or above level z (read where the grid meets it).
  const edgeAt = (z: number) => { const v0 = grid.v[0]; return v0 === v0 && v0 >= z }
  const regionAt = (z: number) => regionOf(chainsAt(z), box, edgeAt(z))
  const zTop = levels[0], zLowest = levels[levels.length - 1]

  // The regions to cut, each with the height it is cut at.
  const flats: { region: PathsD; z: number }[] = []
  if (grid.zMax < STOCK_TOP_MM) flats.push({ region: within(regionAt(zTop)), z: grid.zMax })
  if (grid.zMin < STOCK_TOP_MM) flats.push({ region: differenceD(boxPath, regionAt(zLowest), FillRule.NonZero), z: grid.zMin })
  for (const [lo, hi] of intervals) {
    if (hi > STOCK_TOP_MM) continue
    const region = within(differenceD(regionAt(lo), regionAt(hi), FillRule.NonZero))
    if (region.length) flats.push({ region, z: (lo + hi) / 2 })
  }

  const all = new SegIndex(rings.map((r) => r.chain), Math.max(stepover, grid.cx * 2))
  // The level at a flat's upper edge: the lowest level at or above it.
  const edgeZ = (z: number) => { let e = Infinity; for (const l of levels) if (l >= z && l < e) e = l; return e }
  let made = 0
  for (const flat of flats) {
    let prev: { index: SegIndex; first: number } | null = null
    for (let k = 1; ; k++) {
      const inset = inflatePathsD(flat.region, -k * stepover, JoinType.Round, EndType.Polygon, 2, 4, 0.002)
      if (!inset.length) break
      // Each ring with the flat's uncut middle on its right: against Clipper's winding.
      const chains = inset.filter((r) => r.length >= 3).map((r) => chainOf([...r].reverse(), cl))
      if (!chains.length) break
      const first = rings.length
      for (const chain of chains) rings.push({ z: flat.z, chain, up: [], down: [], done: false, waiting: 0, flat: true })
      for (let r = first; r < rings.length; r++) {
        const p = rings[r].chain.pts
        const seen = new Set<number>()
        for (let i = 0; i < p.length; i += 3) {
          if (prev) {
            const hit = prev.index.nearest(p[i], p[i + 1], reach)
            if (hit.chain >= 0) seen.add(prev.first + hit.chain)
          } else {
            const hit = all.nearest(p[i], p[i + 1], reach)
            if (hit.chain >= 0 && hit.chain < regular && rings[hit.chain].z >= flat.z) seen.add(hit.chain)
          }
        }
        // A first ring with no wall beside it — the one along the box's edge, offset in from
        // the box rather than from a wall — still waits on every ring at the flat's edge, or
        // it was cut first, before the walls standing on the floor it clears.
        if (!prev && !seen.size) for (let u = 0; u < regular; u++) if (rings[u].z === edgeZ(flat.z)) seen.add(u)
        for (const u of seen) { rings[r].up.push(u); rings[u].down.push(r) }
      }
      prev = { index: new SegIndex(chains, Math.max(stepover, grid.cx * 2)), first }
    }
    if (prev) made++
  }
  return made
}

// ─── Cutting the rings ────────────────────────────────────────────────────────

interface Ring { z: number; chain: Chain; up: number[]; down: number[]; done: boolean; waiting: number; flat?: boolean }

function bboxDist(c: Chain, x: number, y: number): number {
  const dx = Math.max(c.minX - x, 0, x - c.maxX), dy = Math.max(c.minY - y, 0, y - c.maxY)
  return Math.hypot(dx, dy)
}

/** The point of a closed chain nearest (x, y): the segment it lies on, and where. */
function nearestOnChain(c: Chain, x: number, y: number): { seg: number; t: number; d2: number } {
  const p = c.pts, m = p.length / 3
  const segs = c.closed ? m : m - 1
  let best = Infinity, seg = 0, bt = 0
  for (let s = 0; s < segs; s++) {
    const a = s * 3, b = ((s + 1) % m) * 3
    const ex = p[b] - p[a], ey = p[b + 1] - p[a + 1]
    const L2 = ex * ex + ey * ey
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - p[a]) * ex + (y - p[a + 1]) * ey) / L2)) : 0
    const d2 = (p[a] + ex * t - x) ** 2 + (p[a + 1] + ey * t - y) ** 2
    if (d2 < best) { best = d2; seg = s; bt = t }
  }
  return { seg, t: bt, d2: best }
}

/** A closed chain as a point list starting at the given place on it, and ending there. */
function rotateTo(c: Chain, seg: number, t: number): number[] {
  const p = c.pts, m = p.length / 3
  const a = seg * 3, b = ((seg + 1) % m) * 3
  const sx = p[a] + (p[b] - p[a]) * t, sy = p[a + 1] + (p[b + 1] - p[a + 1]) * t
  const sz = Math.max(p[a + 2], p[b + 2])
  const out = [sx, sy, sz]
  for (let k = 1; k <= m; k++) {
    const q = ((seg + k) % m) * 3
    out.push(p[q], p[q + 1], p[q + 2])
  }
  out.push(sx, sy, sz)
  return out
}

export function generateWaterline(em: WaterlineEmitter, bbox: BBox, params: WaterlineParams): { levels: number; rings: number; flats: number } {
  const { stepoverMM, maxDepthMM } = params
  const floor = -maxDepthMM
  const cl = (x: number, y: number) => {
    const z = params.cl(x, y)
    return z === null ? NaN : Math.max(z, floor)
  }
  const t0 = performance.now()
  const grid = new TipGrid(bbox, Math.min(stepoverMM, 0.5), cl)
  const t1 = performance.now()
  if (!(grid.zMax - grid.zMin > 2 * END_EPS_MM)) return { levels: 0, rings: 0, flats: 0 }

  const zTop = grid.zMax - END_EPS_MM
  // The lowest level stands a little off the floor: right at it, the ball is rolling off the
  // wall onto the floor and the surface is so nearly level that the ring is ill-defined.
  const zBot = grid.zMin + Math.max(END_EPS_MM, Math.min(BOTTOM_LIFT_MM, (grid.zMax - grid.zMin) / 4))
  // Levels within STOCK_TOP_MM of the stock top cut nothing worth a pass — the model's top
  // IS the stock's there — and they are the worst-conditioned of all: hugging the edge of a
  // flat top, the surface beside them is level, and they wander. The level search still
  // runs from the true top, so the levels below are spaced from it.
  const chosen = chooseLevels(grid, zTop, zBot, stepoverMM)
  const levels = chosen.levels.filter((z) => z <= STOCK_TOP_MM)
  const flats = chosen.flats
  if (!levels.length) return { levels: 0, rings: 0, flats: 0 }
  const t2 = performance.now()

  // The rings of every level, refined against the exact surface, and which rings touch
  // which across neighbouring levels.
  const rings: Ring[] = []
  let prev: { index: SegIndex; first: number } | null = null
  const reach = stepoverMM * 1.5
  for (let li = 0; li < levels.length; li++) {
    const chains = grid.trace(levels[li], true).map((c) => tighten(smoothRing(c, levels[li], cl), levels[li], cl, stepoverMM))
    const first = rings.length
    for (const chain of chains) rings.push({ z: levels[li], chain, up: [], down: [], done: false, waiting: 0 })
    if (prev) {
      for (let r = first; r < rings.length; r++) {
        const p = rings[r].chain.pts
        const seen = new Set<number>()
        for (let i = 0; i < p.length; i += 3) {
          const hit = prev.index.nearest(p[i], p[i + 1], reach)
          if (hit.chain >= 0) seen.add(prev.first + hit.chain)
        }
        for (const u of seen) { rings[r].up.push(u); rings[u].down.push(r) }
      }
    }
    prev = { index: new SegIndex(chains, Math.max(stepoverMM, grid.cx * 2)), first }
  }
  const flatCount = addFlats(grid, rings, levels, flats, stepoverMM, reach, cl, params.limit)
  for (const r of rings) r.waiting = r.up.length
  const t3 = performance.now()

  // Cut them: down the ring just finished when it is ready, else the nearest ring whose
  // neighbours above are all done.
  const rampLen = (dz: number, perim: number) => Math.min(perim / 2, Math.max(params.toolDiameterMM, dz / Math.tan(10 * Math.PI / 180)))
  let last: Ring | null = null
  for (let cut = 0; cut < rings.length; cut++) {
    const x = em.at?.x ?? bbox.minX, y = em.at?.y ?? bbox.minY
    let next: Ring | null = null, bestD = Infinity
    if (last) {
      for (const d of last.down as number[]) {
        const r: Ring = rings[d]
        if (r.done || r.waiting > 0) continue
        const dd = bboxDist(r.chain, x, y)
        if (dd < bestD) { bestD = dd; next = r }
      }
    }
    const chainStep = next !== null
    if (!next) {
      for (const r of rings) {
        if (r.done || r.waiting > 0) continue
        const dd = bboxDist(r.chain, x, y)
        if (dd < bestD) { bestD = dd; next = r }
      }
    }
    if (!next) break
    next.done = true
    for (const d of next.down) rings[d].waiting--
    const c = next.chain
    const z = next.z
    if (params.needsCut) {
      const p = c.pts, m = p.length / 3
      const need = new Uint8Array(m)
      let any = false
      for (let k = 0; k < m; k++) if (params.needsCut(p[k * 3], p[k * 3 + 1], p[k * 3 + 2])) { need[k] = 1; any = true }
      if (!any) continue
    }

    if (!c.closed) {
      // An open chain is cut from whichever end is nearer.
      const p = c.pts, m = p.length / 3
      const dHead = Math.hypot(p[0] - x, p[1] - y), dTail = Math.hypot(p[(m - 1) * 3] - x, p[(m - 1) * 3 + 1] - y)
      const order = dTail < dHead ? Array.from({ length: m }, (_, k) => m - 1 - k) : Array.from({ length: m }, (_, k) => k)
      em.arrive(p[order[0] * 3], p[order[0] * 3 + 1], p[order[0] * 3 + 2], false, stepoverMM)
      for (let k = 1; k < m; k++) em.cut(p[order[k] * 3], p[order[k] * 3 + 1], p[order[k] * 3 + 2])
      last = next
      continue
    }

    const near = nearestOnChain(c, x, y)
    const loop = rotateTo(c, near.seg, near.t)
    const at = em.at
    const stepDown = chainStep && at && Math.sqrt(near.d2) <= reach && at.z > z
    if (!stepDown) {
      em.arrive(loop[0], loop[1], loop[2], false, stepoverMM)
    } else {
      // Across to the next ring at the height of the last — or over whatever rises
      // between them — then down along it.
      const n = Math.max(1, Math.ceil(Math.sqrt(near.d2) / (stepoverMM / 4)))
      for (let k = 1; k <= n; k++) {
        const qx = at!.x + (loop[0] - at!.x) * k / n, qy = at!.y + (loop[1] - at!.y) * k / n
        const h = cl(qx, qy)
        em.cut(qx, qy, Math.max(at!.z, h === h ? h : at!.z))
      }
    }
    // The ring's arc length, for the ramp and the overlap.
    const m = loop.length / 3
    const cum = new Float64Array(m)
    for (let k = 1; k < m; k++) cum[k] = cum[k - 1] + Math.hypot(loop[k * 3] - loop[k * 3 - 3], loop[k * 3 + 1] - loop[k * 3 - 2])
    const perim = cum[m - 1]
    const zFrom = em.at!.z
    const ramp = zFrom > loop[2] + 1e-6 ? rampLen(zFrom - z, perim) : 0
    for (let k = 1; k < m; k++) {
      const zk = loop[k * 3 + 2]
      const zr = ramp > 0 && cum[k] < ramp ? zk + (zFrom - zk) * (1 - cum[k] / ramp) : zk
      em.cut(loop[k * 3], loop[k * 3 + 1], zr)
    }
    // On past the start, over the stretch the ramp cut high.
    if (ramp > 0) {
      for (let k = 1; k < m && cum[k - 1] < ramp; k++) {
        if (cum[k] <= ramp) { em.cut(loop[k * 3], loop[k * 3 + 1], loop[k * 3 + 2]); continue }
        const f = (ramp - cum[k - 1]) / (cum[k] - cum[k - 1])
        const ax = loop[k * 3 - 3], ay = loop[k * 3 - 2]
        em.cut(ax + (loop[k * 3] - ax) * f, ay + (loop[k * 3 + 1] - ay) * f, Math.max(loop[k * 3 - 1], loop[k * 3 + 2]))
      }
    }
    last = next
  }
  const t4 = performance.now()
  perfLog(`[waterline] grid ${grid.nx}×${grid.ny} ${(t1 - t0).toFixed(0)}ms | ${levels.length} levels (${flatCount} flats) ${(t2 - t1).toFixed(0)}ms | ${rings.length} rings ${(t3 - t2).toFixed(0)}ms | cut ${(t4 - t3).toFixed(0)}ms`)
  return { levels: levels.length, rings: rings.length, flats: flatCount }
}
