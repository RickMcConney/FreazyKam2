// PLACING ONE STRIP BY HAND: the Tabs form's click-to-place, and dragging a strip that is
// already there. The network (`planBridges`) lays every join at once; this lays ONE, where
// the user points, by the same rules — square off the part it starts from, across one gap to
// the next outline, its ends kept off both parts' corners — so a strip placed by hand is the
// same kind of thing as one the network chose, and the clamp holds it the same way.
//
// The point picked is projected onto the nearest outline; the strip leaves there along the
// outward normal and runs to the first outline it meets. If that spot is at a corner, or
// meets nothing within reach, the search slides along the outline a little either way
// (`searchMM`) — nearest first — so a click just off a good spot still lands on it.
//
// Pure, and the index is built once per state: a nest is thousands of outlines, and a drag
// asks again on every mouse move.
import { flattenPath } from './pathFlattener'
import { pointInPolygon } from './geom'
import { cellOfPoint, cellOffset, type Stock } from './sheets'
import { ringCorners, nearCorner, cornerClearMM, OVERLAP_MM, FRAME_STUB_MM, MAX_JOIN_MM, type BridgeLine } from './bridges'

type P = [number, number]
interface Ring { pts: P[]; cum: number[]; len: number; out: 1 | -1 }
// `hole`: a hole's outline, whose strips run INTO it — stubs into its slug (planSlugStrips).
interface Part { id: string; rings: Ring[]; corners: P[]; hole: boolean }
interface Seg { ax: number; ay: number; bx: number; by: number; part: number; ring: number; i: number }

export interface HoldIndex {
  parts: Part[]
  segs: Seg[]
  grid: Map<string, number[]>
  stock: Stock
}

const CELL = 4
const key = (i: number, j: number) => `${i},${j}`

// Flattened outlines by `d`, two generations: the index is rebuilt on every edit that moves a
// part with strips, and re-flattening a nest's every outline each time is most of the cost.
const FLAT_MAX = 4096
let flatCur = new Map<string, P[][]>(), flatOld = new Map<string, P[][]>()
function flat(d: string): P[][] {
  let r = flatCur.get(d)
  if (r) return r
  r = flatOld.get(d) ?? (flattenPath(d, 0.25).filter((x) => x.length >= 3) as P[][])
  if (flatCur.size >= FLAT_MAX) { flatOld = flatCur; flatCur = new Map() }
  flatCur.set(d, r)
  return r
}

/** The outer outlines of `parts`, and the outlines of `holes` (facing inward), gridded for
 *  nearest-point and ray queries. */
export function buildHoldIndex(parts: { id: string; d: string }[], stock: Stock, holes: { id: string; d: string }[] = []): HoldIndex {
  const out: Part[] = []
  const segs: Seg[] = []
  const grid = new Map<string, number[]>()
  const holeIds = new Set(holes.map((h) => h.id))
  for (const p of [...parts, ...holes]) {
    const hole = holeIds.has(p.id)
    const all = flat(p.d)
    // Outer rings only, as the network joins them: a strip from a hole's edge would run across
    // the hole, whose inside cut does not lift.
    const outer = all.filter((r) => !all.some((o) => o !== r && pointInPolygon(r[0][0], r[0][1], o)))
    const rings: Ring[] = outer.map((r) => {
      const pts = r.slice()
      const n = pts.length
      if (Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) > 1e-6) pts.push(pts[0])
      const cum = [0]
      let area = 0
      for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
        area += pts[i - 1][0] * pts[i][1] - pts[i][0] * pts[i - 1][1]
      }
      // Outward from a part; INTO a hole.
      const ccw = area > 0
      return { pts, cum, len: cum[cum.length - 1], out: (ccw !== hole ? 1 : -1) as 1 | -1 }
    })
    const k = out.length
    out.push({ id: p.id, rings, corners: outer.flatMap(ringCorners), hole })
    rings.forEach((r, ri) => {
      for (let i = 1; i < r.pts.length; i++) {
        const [ax, ay] = r.pts[i - 1], [bx, by] = r.pts[i]
        const si = segs.length
        segs.push({ ax, ay, bx, by, part: k, ring: ri, i: i - 1 })
        const i0 = Math.floor(Math.min(ax, bx) / CELL), i1 = Math.floor(Math.max(ax, bx) / CELL)
        const j0 = Math.floor(Math.min(ay, by) / CELL), j1 = Math.floor(Math.max(ay, by) / CELL)
        for (let gi = i0; gi <= i1; gi++) for (let gj = j0; gj <= j1; gj++) {
          const l = grid.get(key(gi, gj)); if (l) l.push(si); else grid.set(key(gi, gj), [si])
        }
      }
    })
  }
  return { parts: out, segs, grid, stock }
}

/** The nearest point on any outline (of part `only`, when given) within `maxD` of (x, y). */
function nearestOn(ix: HoldIndex, x: number, y: number, maxD: number, only?: number) {
  if (!Number.isFinite(maxD)) maxD = Math.hypot(ix.stock.widthMM, ix.stock.heightMM) * 2
  let best: { part: number; ring: number; s: number; d: number } | null = null
  const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL)
  const rings = Math.ceil(maxD / CELL) + 1
  const seen = new Set<number>()
  for (let ring = 0; ring <= rings; ring++) {
    if (best && (ring - 1) * CELL > best.d) break
    for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) {
      if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue
      for (const si of ix.grid.get(key(i, j)) ?? []) {
        if (seen.has(si)) continue
        seen.add(si)
        const g = ix.segs[si]
        if (only !== undefined && g.part !== only) continue
        const dx = g.bx - g.ax, dy = g.by - g.ay, l2 = dx * dx + dy * dy
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - g.ax) * dx + (y - g.ay) * dy) / l2)) : 0
        const d = Math.hypot(x - g.ax - u * dx, y - g.ay - u * dy)
        if (d > maxD || (best && d >= best.d)) continue
        const r = ix.parts[g.part].rings[g.ring]
        best = { part: g.part, ring: g.ring, s: r.cum[g.i] + u * Math.sqrt(l2), d }
      }
    }
  }
  return best
}

/** The point `s` mm round a closed ring, and its outward normal there. */
function pointAt(r: Ring, s: number): { x: number; y: number; nx: number; ny: number } {
  const t = ((s % r.len) + r.len) % r.len
  let lo = 0, hi = r.cum.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r.cum[m] <= t) lo = m; else hi = m }
  const [ax, ay] = r.pts[lo], [bx, by] = r.pts[hi]
  const l = Math.hypot(bx - ax, by - ay) || 1
  const u = (t - r.cum[lo]) / l
  const tx = (bx - ax) / l, ty = (by - ay) / l
  return { x: ax + u * (bx - ax), y: ay + u * (by - ay), nx: r.out * ty, ny: -r.out * tx }
}

/** The first outline the ray from (x, y) along (nx, ny) meets within `reach`, past `from`'s own edge. */
function rayHit(ix: HoldIndex, x: number, y: number, nx: number, ny: number, reach: number) {
  if (!Number.isFinite(reach)) reach = Math.hypot(ix.stock.widthMM, ix.stock.heightMM) * 2
  let best: { t: number; part: number; x: number; y: number } | null = null
  const seen = new Set<number>()
  const steps = Math.ceil(reach / (CELL / 2)) + 1
  for (let k = 0; k <= steps; k++) {
    const t = Math.min(reach, k * CELL / 2)
    if (best && t - CELL > best.t) break
    const ci = Math.floor((x + nx * t) / CELL), cj = Math.floor((y + ny * t) / CELL)
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      for (const si of ix.grid.get(key(i, j)) ?? []) {
        if (seen.has(si)) continue
        seen.add(si)
        const g = ix.segs[si]
        const ex = g.bx - g.ax, ey = g.by - g.ay
        const den = nx * ey - ny * ex
        if (Math.abs(den) < 1e-12) continue
        const wx = g.ax - x, wy = g.ay - y
        const tt = (wx * ey - wy * ex) / den
        const uu = (wx * ny - wy * nx) / den
        // Past the start's own edge (a hair), within the segment, within reach.
        if (tt <= 1e-3 || tt > reach || uu < 0 || uu > 1) continue
        if (!best || tt < best.t) best = { t: tt, part: g.part, x: x + nx * tt, y: y + ny * tt }
      }
    }
  }
  return best
}

/** How far the frame (the sheet's edges) lies along the ray, or Infinity when the ray leaves the sheet another way. */
function frameDist(ix: HoldIndex, x: number, y: number, nx: number, ny: number): number {
  const o = cellOffset(cellOfPoint(x, y, ix.stock), ix.stock)
  const X0 = o.x, Y0 = o.y, X1 = o.x + ix.stock.widthMM, Y1 = o.y + ix.stock.heightMM
  const ts = [
    nx < -1e-9 ? (X0 - x) / nx : Infinity, nx > 1e-9 ? (X1 - x) / nx : Infinity,
    ny < -1e-9 ? (Y0 - y) / ny : Infinity, ny > 1e-9 ? (Y1 - y) / ny : Infinity,
  ]
  const t = Math.min(...ts)
  return t >= 0 ? t : Infinity
}

export interface StripPick {
  line: BridgeLine
  /** The part the strip leaves from, and what it reaches: another part's id, or the frame. */
  a: string
  b: string | 'frame'
}

export interface StripPickOpts {
  widthMM: number
  toolRadiusMM: number
  /** The widest gap a strip will cross to another part. */
  reachMM: number
  /** How far along the outline to look either side of the point picked. */
  searchMM: number
  /** How far the point picked may be from an outline at all. */
  pickMM: number
  /** Dragging an existing strip: keep it on this part … */
  fromPart?: string
  /** … and joining this one (or the frame). */
  toPart?: string | 'frame'
}

/**
 * A strip square across the gap at (x, y), or null — no outline near, or no neighbour across
 * it, or nowhere near the point that clears the corners. See the header.
 */
export function stripAt(ix: HoldIndex, x: number, y: number, o: StripPickOpts): StripPick | null {
  const only = o.fromPart !== undefined ? ix.parts.findIndex((p) => p.id === o.fromPart) : undefined
  if (only === -1) return null
  const near = nearestOn(ix, x, y, o.pickMM, only)
  if (!near) return null
  const a = near.part
  const ring = ix.parts[a].rings[near.ring]
  const clear = cornerClearMM(o.widthMM, o.toolRadiusMM)
  const toB = o.toPart !== undefined && o.toPart !== 'frame' ? ix.parts.findIndex((p) => p.id === o.toPart) : undefined
  const STEP = 0.5
  for (let k = 0; k * STEP <= o.searchMM; k++) {
    for (const sign of k === 0 ? [1] : [1, -1]) {
      const p = pointAt(ring, near.s + sign * k * STEP)
      if (nearCorner(ix.parts[a].corners, p.x, p.y, clear)) continue
      if (ix.parts[a].hole) {
        // A hole's strip is a stub into its slug, whatever was asked: across the inside cut's
        // kerf (a tool diameter and a millimetre), up to FRAME_STUB_MM, stopping a strip's
        // reach short of anything in the hole — its own far side included.
        const free = rayHit(ix, p.x, p.y, p.nx, p.ny, FRAME_STUB_MM + o.widthMM + 4 * o.toolRadiusMM)
        const len = Math.min(FRAME_STUB_MM, (free ? free.t : Infinity) - (o.widthMM / 2 + 2 * o.toolRadiusMM))
        if (!(len >= 2 * o.toolRadiusMM + 1)) continue
        return { a: ix.parts[a].id, b: 'frame', line: { x1: p.x - p.nx * OVERLAP_MM, y1: p.y - p.ny * OVERLAP_MM, x2: p.x + p.nx * len, y2: p.y + p.ny * len } }
      }
      const toFrame = o.toPart === 'frame'
      const fd = toFrame ? frameDist(ix, p.x, p.y, p.nx, p.ny) : Infinity
      const hit = rayHit(ix, p.x, p.y, p.nx, p.ny, toFrame ? Math.min(fd, MAX_JOIN_MM) : o.reachMM)
      if (toFrame) {
        // A stub into OPEN STOCK, as the network's frame and open-stock joins are: nothing
        // within reach in front (or before the edge), so the waste there is joined to the
        // sheet's edge, and FRAME_STUB_MM of strip — less where the edge is nearer — holds.
        if (hit || !Number.isFinite(fd)) continue
        const len = Math.min(fd, FRAME_STUB_MM)
        return { a: ix.parts[a].id, b: 'frame', line: { x1: p.x - p.nx * OVERLAP_MM, y1: p.y - p.ny * OVERLAP_MM, x2: p.x + p.nx * len, y2: p.y + p.ny * len } }
      }
      // Back into its own part (a concave edge facing itself), past a different part than the
      // one being dragged along, or on a corner of the far part: not here.
      if (!hit || hit.part === a || (toB !== undefined && hit.part !== toB)) continue
      if (nearCorner(ix.parts[hit.part].corners, hit.x, hit.y, clear)) continue
      return {
        a: ix.parts[a].id, b: ix.parts[hit.part].id,
        line: { x1: p.x - p.nx * OVERLAP_MM, y1: p.y - p.ny * OVERLAP_MM, x2: hit.x + p.nx * OVERLAP_MM, y2: hit.y + p.ny * OVERLAP_MM },
      }
    }
  }
  return null
}

/**
 * Which parts an existing strip joins: the part each END sits on (an end reaches OVERLAP_MM
 * into its part), or the frame for an end that is on none. Null when its start is on no part
 * in the index — then it cannot be dragged along one.
 */
export function stripEnds(ix: HoldIndex, l: BridgeLine): { a: string; b: string | 'frame' } | null {
  const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1)
  if (len < 1e-9) return null
  const ux = (l.x2 - l.x1) / len, uy = (l.y2 - l.y1) / len
  const tol = 0.25
  const s = nearestOn(ix, l.x1 + ux * OVERLAP_MM, l.y1 + uy * OVERLAP_MM, tol)
  if (!s) return null
  const e = nearestOn(ix, l.x2 - ux * OVERLAP_MM, l.y2 - uy * OVERLAP_MM, tol)
  return { a: ix.parts[s.part].id, b: e && e.part !== s.part ? ix.parts[e.part].id : 'frame' }
}

/**
 * A strip re-fitted after the parts it joins have moved or changed — 'keep' when neither
 * end's part changed. It is re-laid FROM THE SAME PLACE on the part it leaves (the same
 * fraction of the way round the same outline, so a part dragged anywhere carries its strips
 * with it, and a strip moved by hand stays where it was put on the part), and joining:
 *   1. the same neighbour, if it is still within reach across a clear gap;
 *   2. otherwise open stock — the neighbour has gone, and nothing in front means waste joined
 *      to the sheet's edge, which holds as well (see stripAt's frame case);
 *   3. otherwise whatever part now stands in front;
 * each within a corner's clearance of the spot either way. None of those: null, and it goes.
 */
export function refitStrip(
  before: HoldIndex, after: HoldIndex, l: BridgeLine, changed: Set<string>, o: { widthMM: number; toolRadiusMM: number },
): 'keep' | { line: BridgeLine | null; ends: string[] } {
  const ends = stripEnds(before, l)
  if (!ends) return 'keep'
  const ids = [ends.a, ...(ends.b === 'frame' ? [] : [ends.b])]
  if (!ids.some((id) => changed.has(id))) return 'keep'
  const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1)
  const ux = (l.x2 - l.x1) / len, uy = (l.y2 - l.y1) / len
  const was = nearestOn(before, l.x1 + ux * OVERLAP_MM, l.y1 + uy * OVERLAP_MM, 0.5)
  const k = after.parts.findIndex((p) => p.id === ends.a)
  if (!was || k < 0) return { line: null, ends: ids }
  const oldRing = before.parts[was.part].rings[was.ring]
  const rings = after.parts[k].rings
  if (rings.length === 0) return { line: null, ends: ids }
  const ring = rings[Math.min(was.ring, rings.length - 1)]
  const at = pointAt(ring, (was.s / oldRing.len) * ring.len)
  const base = {
    widthMM: o.widthMM, toolRadiusMM: o.toolRadiusMM, pickMM: 1, reachMM: MAX_JOIN_MM,
    searchMM: 2 * cornerClearMM(o.widthMM, o.toolRadiusMM) + 2, fromPart: ends.a,
  }
  const tries: (string | 'frame' | undefined)[] = ends.b === 'frame' ? ['frame', undefined] : [ends.b, 'frame', undefined]
  for (const toPart of tries) {
    const p = stripAt(after, at.x, at.y, { ...base, toPart })
    if (p) return { line: p.line, ends: [...new Set([...ids, p.b === 'frame' ? p.a : p.b])] }
  }
  return { line: null, ends: ids }
}
