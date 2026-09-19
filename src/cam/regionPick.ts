// Region pick — the closed area around a point, built from whatever strokes bound it.
//
// A drawing often encloses an area that no single path encloses: the slots of a comb cut
// into a panel's edge are bounded by part of the outline AND a separate line across their
// mouth, and neither path is closed on its own terms around the slots. An area operation
// must refuse an open path (see `requireClosedSubpaths`), and quietly closing one is the
// failure that rule exists to prevent — so instead of guessing, this finds the face the
// user clicked in from the strokes that are actually drawn:
//
//   1. flatten every stroke into segments;
//   2. split them wherever they meet — crossings, T-junctions (an end landing part way
//      along another segment) and overlaps — and merge points within `tol`;
//   3. prune dangling ends, which bound nothing;
//   4. walk every face of the resulting planar graph (face on the LEFT, so a bounded
//      face comes out CCW and a component's outside comes out CW);
//   5. the region is the smallest CCW face containing the point, with the components
//      directly inside it as holes.
//
// Nothing is invented: every edge of the result lies on a drawn stroke.

import { signedArea, type Pt2 } from './pathFlattener'
import { pointInPolygon } from './geom'
import { round4 } from '../util/num'

export interface Region {
  /** Outer boundary, CCW. */
  outer: Pt2[]
  /** Islands directly inside the region, CW. */
  holes: Pt2[][]
}

type Seg = { a: Pt2; b: Pt2 }

export type RegionFinder = (p: Pt2) => Region | null

/**
 * The closed region around `p` bounded by `strokes` (polylines in CNC mm; a closed
 * one repeats its first point at the end, as `flattenPath` returns it), or null when
 * `p` is not enclosed.
 */
export function findRegion(strokes: Pt2[][], p: Pt2, tol = 1e-3): Region | null {
  return createRegionFinder(strokes, tol)(p)
}

/**
 * Build the planar graph and its faces once, and return a lookup for any point —
 * the canvas previews the region under the cursor, so the lookup is what runs per
 * mouse move and the graph only when the drawing changes.
 */
export function createRegionFinder(strokes: Pt2[][], tol = 1e-3): RegionFinder {
  const graph = buildGraph(strokes, tol)
  if (!graph) return () => null
  const faces = walkFaces(graph)
  const bounded = faces.filter((f) => f.area > 0)
  const outsides = faces.filter((f) => f.area < 0)

  // The tightest CCW face containing q, skipping faces of component `skipComp`.
  const tightest = (q: Pt2, skipComp: number): Face | null => {
    let best: Face | null = null
    for (const f of bounded) {
      if (f.comp === skipComp || (best && f.area >= best.area)) continue
      if (pointInPolygon(q[0], q[1], f.ring)) best = f
    }
    return best
  }

  // Which bounded face directly encloses each component — the same for every
  // lookup, so worked out once.
  const holesOf = new Map<Face, Pt2[][]>()
  for (const f of outsides) {
    const encl = tightest(f.ring[0], f.comp)
    if (!encl) continue
    const list = holesOf.get(encl)
    if (list) list.push(f.ring); else holesOf.set(encl, [f.ring])
  }

  return (p) => {
    // The tightest CCW face around p is the region's outer boundary; the
    // components directly inside it are its holes.
    const outer = tightest(p, -1)
    return outer ? { outer: outer.ring, holes: holesOf.get(outer) ?? [] } : null
  }
}

/** A region as an absolute, uppercase SVG d string: outer ring, then each hole. */
export function regionToD(r: Region): string {
  const ring = (pts: Pt2[]) =>
    pts.map((q, i) => `${i === 0 ? 'M' : 'L'}${round4(q[0])},${round4(q[1])}`).join(' ') + ' Z'
  return [r.outer, ...r.holes].map(ring).join(' ')
}

// ── Planar graph ─────────────────────────────────────────────────────────────

interface Graph {
  pts: Pt2[]
  /** Neighbours of each vertex, sorted CCW by angle. */
  adj: number[][]
  /** Connected-component id of each vertex. */
  comp: number[]
}

function buildGraph(strokes: Pt2[][], tol: number): Graph | null {
  const segs: Seg[] = []
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.length; i++) {
      const a = s[i], b = s[i + 1]
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > tol) segs.push({ a, b })
    }
  }
  if (segs.length < 3) return null

  // ── Split at every meeting point ──
  const splits: number[][] = segs.map(() => [])
  forEachNearPair(segs, tol, (i, j) => {
    const s = segs[i], t = segs[j]
    // An end of one lying on the other: T-junctions, and (both ways) overlaps.
    for (const q of [t.a, t.b]) { const u = paramOnSeg(s, q, tol); if (u !== null) splits[i].push(u) }
    for (const q of [s.a, s.b]) { const u = paramOnSeg(t, q, tol); if (u !== null) splits[j].push(u) }
    // A proper crossing.
    const x = crossing(s, t)
    if (x) { splits[i].push(x[0]); splits[j].push(x[1]) }
  })

  // ── Vertices (merged within tol) and deduplicated edges ──
  const pts: Pt2[] = []
  const grid = new Map<string, number[]>()
  const cell = (v: number) => Math.floor(v / tol)
  const vertex = (q: Pt2): number => {
    const cx = cell(q[0]), cy = cell(q[1])
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const k of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (Math.abs(pts[k][0] - q[0]) <= tol && Math.abs(pts[k][1] - q[1]) <= tol) return k
        }
      }
    }
    const k = pts.length
    pts.push(q)
    const key = `${cx},${cy}`
    const list = grid.get(key)
    if (list) list.push(k); else grid.set(key, [k])
    return k
  }
  const edgeSet = new Set<string>()
  const nbrs: Set<number>[] = []
  const link = (u: number, v: number) => {
    if (u === v) return
    const key = u < v ? `${u},${v}` : `${v},${u}`
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    ;(nbrs[u] ??= new Set()).add(v)
    ;(nbrs[v] ??= new Set()).add(u)
  }
  for (let i = 0; i < segs.length; i++) {
    const { a, b } = segs[i]
    const ts = [0, ...splits[i].sort((x, y) => x - y), 1]
    let prev = vertex(a)
    for (let k = 1; k < ts.length; k++) {
      const t = ts[k]
      const v = t === 1 ? vertex(b) : vertex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      link(prev, v)
      prev = v
    }
  }

  // ── Prune dangling ends: an open stroke, or a spur off a loop, bounds nothing ──
  const n = pts.length
  for (let v = 0; v < n; v++) nbrs[v] ??= new Set()
  const stack: number[] = []
  for (let v = 0; v < n; v++) if (nbrs[v].size === 1) stack.push(v)
  while (stack.length) {
    const v = stack.pop()!
    if (nbrs[v].size !== 1) continue
    const [u] = nbrs[v]
    nbrs[v].delete(u)
    nbrs[u].delete(v)
    if (nbrs[u].size === 1) stack.push(u)
  }

  const adj = nbrs.map((set, v) => {
    const [vx, vy] = pts[v]
    return [...set].sort((a, b) =>
      Math.atan2(pts[a][1] - vy, pts[a][0] - vx) - Math.atan2(pts[b][1] - vy, pts[b][0] - vx))
  })

  // Components, so a hole can be told from a face of its own enclosing component.
  const comp = new Array<number>(n).fill(-1)
  let nc = 0
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1 || adj[s].length === 0) continue
    const q = [s]
    comp[s] = nc
    while (q.length) {
      const v = q.pop()!
      for (const u of adj[v]) if (comp[u] === -1) { comp[u] = nc; q.push(u) }
    }
    nc++
  }
  return { pts, adj, comp }
}

// Calls fn(i, j), i < j, once for each pair of segments whose tol-expanded bounding
// boxes share a grid cell — the only pairs that can meet.
function forEachNearPair(segs: Seg[], tol: number, fn: (i: number, j: number) => void) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const { a, b } of segs) {
    minX = Math.min(minX, a[0], b[0]); maxX = Math.max(maxX, a[0], b[0])
    minY = Math.min(minY, a[1], b[1]); maxY = Math.max(maxY, a[1], b[1])
  }
  const extent = Math.max(maxX - minX, maxY - minY, tol)
  const size = Math.max(extent / Math.ceil(Math.sqrt(segs.length)), tol * 4)
  const cells = new Map<string, number[]>()
  const cellsOf = (s: Seg): string[] => {
    const x0 = Math.floor((Math.min(s.a[0], s.b[0]) - tol - minX) / size)
    const x1 = Math.floor((Math.max(s.a[0], s.b[0]) + tol - minX) / size)
    const y0 = Math.floor((Math.min(s.a[1], s.b[1]) - tol - minY) / size)
    const y1 = Math.floor((Math.max(s.a[1], s.b[1]) + tol - minY) / size)
    const out: string[] = []
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`)
    return out
  }
  const segCells = segs.map(cellsOf)
  segCells.forEach((cs, i) => {
    for (const c of cs) { const l = cells.get(c); if (l) l.push(i); else cells.set(c, [i]) }
  })
  const seen = new Int32Array(segs.length).fill(-1)
  for (let i = 0; i < segs.length; i++) {
    for (const c of segCells[i]) {
      for (const j of cells.get(c)!) {
        if (j <= i || seen[j] === i) continue
        seen[j] = i
        fn(i, j)
      }
    }
  }
}

// Parameter along s of q's foot, when q lies on s strictly between its ends (within tol).
function paramOnSeg(s: Seg, q: Pt2, tol: number): number | null {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1]
  const len2 = dx * dx + dy * dy
  const t = ((q[0] - s.a[0]) * dx + (q[1] - s.a[1]) * dy) / len2
  const len = Math.sqrt(len2)
  if (t * len <= tol || (1 - t) * len <= tol) return null
  const fx = s.a[0] + dx * t, fy = s.a[1] + dy * t
  return Math.hypot(q[0] - fx, q[1] - fy) <= tol ? t : null
}

// Parameters on s and t of a proper crossing (interiors only), or null.
function crossing(s: Seg, t: Seg): [number, number] | null {
  const rx = s.b[0] - s.a[0], ry = s.b[1] - s.a[1]
  const qx = t.b[0] - t.a[0], qy = t.b[1] - t.a[1]
  const den = rx * qy - ry * qx
  if (Math.abs(den) < 1e-12) return null
  const wx = t.a[0] - s.a[0], wy = t.a[1] - s.a[1]
  const u = (wx * qy - wy * qx) / den
  const v = (wx * ry - wy * rx) / den
  const eps = 1e-9
  return u > eps && u < 1 - eps && v > eps && v < 1 - eps ? [u, v] : null
}

// ── Faces ────────────────────────────────────────────────────────────────────

interface Face { ring: Pt2[]; area: number; comp: number }

// Walk every face with the face on the LEFT: arriving at v from u, leave by the first
// edge CLOCKWISE from the way back to u — the sharpest left turn. A bounded face then
// comes out CCW (positive area) and a component's outside CW (negative).
function walkFaces(g: Graph): Face[] {
  const { pts, adj, comp } = g
  const visited = new Set<string>()
  const faces: Face[] = []
  for (let u0 = 0; u0 < pts.length; u0++) {
    for (const v0 of adj[u0]) {
      if (visited.has(`${u0},${v0}`)) continue
      const idx: number[] = []
      let u = u0, v = v0
      for (let guard = 0; guard < 4 * pts.length + 8; guard++) {
        visited.add(`${u},${v}`)
        idx.push(u)
        const around = adj[v]
        const back = around.indexOf(u)
        const w = around[(back - 1 + around.length) % around.length]
        u = v; v = w
        if (u === u0 && v === v0) break
      }
      const ring = idx.map((k) => pts[k])
      faces.push({ ring, area: signedArea(ring), comp: comp[u0] })
    }
  }
  return faces
}
