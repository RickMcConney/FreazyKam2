// Bridges ("holding strips" in the UI): short strips of a nested sheet that no through-cut
// crosses at full depth, joining the parts into one network that hangs on the sheet's edge.
//
// Tabs belong to ONE part and hold it to whatever is beside it — which on a tight nest is
// waste the neighbouring cuts have already cut loose, so the part and its "holder" fly off
// together. What keeps a part in place is a chain of material out to the edge of the sheet,
// and a BRIDGE is that chain made on purpose: every outside or centerline cut THROUGH the
// stock that crosses one lifts to the bridge's height while it does (a shallower cut — a
// label — is not held off: it frees nothing). An INSIDE cut does not lift: a hole lies within
// its part, so cutting it cannot part a strip the part itself carries on.
//
// THE NETWORK (`planBridges`). Strips used to be whole lines across the sheet, and a line pays
// for every part it passes through, not only the ones it is there to hold: busy sheets took
// dozens. Now each strip is a JOIN between two neighbouring parts, or a part and the sheet's
// edge, laid square across the gap between them:
//   - Candidates come from points along every part's outline: the NEAREST other outline (or
//     sheet edge), wherever that direction is square to the part's own edge. The nearest
//     point is square to the far outline too, and nothing else lies between the two — so a
//     join is two short square crossings, never a slant or a run along an edge.
//   - A spanning forest of the cheapest joins (Kruskal) hangs every part on the frame — not
//     by a join each, by a chain of parts and joins.
//   - Then each part takes joins until it has `count` of them (the Tabs form's count), each
//     well apart from the part's others, so a long part is held at two stations and not
//     pivoting about one.
//   - The frame is one node for connectivity, but a network meeting it on only one side
//     takes a join to a second side when one is on offer.
// A join's length costs nothing: across open stock it lifts no cut at all.
//
// A toolpath is held off the bridges AFTER it is generated (`clampToBridges`): every move
// is clipped against each strip grown by the cutter's radius, and what lies inside is raised
// to the bridge's top. The cutter's edge must stay out of the strip, so its CENTRE must stay
// out of the grown strip — exact for any shape and any crossing angle, and blind to how the
// moves were made. Lift RANGES worked out along the cut path, the way tabs are, were tried
// first and each generator's own moves found a way past them: the plunge at a loop's start,
// a ramp descending into a strip, an open stroke's first point, a trochoidal loop swinging
// off its guide.
//
// Pure, so it runs in the worker and under the node tests.
import { flattenPath } from './pathFlattener'
import { pointInPolygon } from './geom'
import type { MotionSegment } from '../store/toolpathStore'
import { cellOfPoint, cellOffset, cellKey, type Cell } from './sheets'

/** One strip: its centreline from (x1, y1) to (x2, y2). */
export interface BridgeLine { x1: number; y1: number; x2: number; y2: number }

export interface BridgeSet {
  lines: BridgeLine[]
  /** How wide each strip is. */
  widthMM: number
  /** How high it stands above the bottom of the cut — a tab's height. */
  heightMM: number
  /** The parts it was placed for: what its chip selects, and what Place re-places over. */
  pathIds: string[]
}

export const BRIDGE_DEFAULTS = { widthMM: 5, heightMM: 2, count: 2 }

/** A stored bridge set read back safely — null when it is absent or has no lines. A line
 *  saved as a whole-sheet axis line (`axis`, `at`, `from`, `to`) reads as that segment. */
export function normalizeBridges(raw: unknown): BridgeSet | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const fin = (...v: unknown[]) => v.every((x) => typeof x === 'number' && Number.isFinite(x))
  const lines = (Array.isArray(r.lines) ? r.lines : []).flatMap((l): BridgeLine[] => {
    if (!l || typeof l !== 'object') return []
    const o = l as Record<string, number | string>
    if (fin(o.x1, o.y1, o.x2, o.y2)) return [{ x1: +o.x1, y1: +o.y1, x2: +o.x2, y2: +o.y2 }]
    if ((o.axis === 'x' || o.axis === 'y') && fin(o.at, o.from, o.to)) {
      return [o.axis === 'x' ? { x1: +o.at, y1: +o.from, x2: +o.at, y2: +o.to } : { x1: +o.from, y1: +o.at, x2: +o.to, y2: +o.at }]
    }
    return []
  })
  if (lines.length === 0) return null
  return {
    lines,
    widthMM: Math.max(0.5, num(r.widthMM, BRIDGE_DEFAULTS.widthMM)),
    heightMM: Math.max(0.1, num(r.heightMM, BRIDGE_DEFAULTS.heightMM)),
    pathIds: Array.isArray(r.pathIds) ? r.pathIds.filter((v): v is string => typeof v === 'string') : [],
  }
}

/** What placement needs beyond the parts. */
export interface BridgePlacement {
  /** Joins each part should have — its tab count. */
  count: number
  /** How far the cutter reaches past its centre, for how near a join may sit to another. */
  toolRadiusMM: number
  widthMM: number
}

/** Where a join meets the frame, or the part at its far end. */
export type JoinEnd = { part: number } | { side: 'left' | 'right' | 'bottom' | 'top' }

/** One join of the network: its strip, the part it starts on, and what it reaches. */
export interface Join { line: BridgeLine; a: number; b: JoinEnd; gapMM: number; sheet: string }

// Sampling along each outline for candidate joins, how square a join must leave its part,
// how far a join may reach, and how far apart two joins on one part must stand (as a share
// of the part's larger dimension) — halved, then dropped, when a part cannot get its count.
const SAMPLE_MM = 3
const SAMPLES_PER_RING = 24
// A join facing off a part at least 60° from every join it already has faces a NEW way.
const NEW_WAY_COS = Math.cos(60 * Math.PI / 180)
const SQUARE_COS = Math.sin(15 * Math.PI / 180)
const MAX_JOIN_MM = 60
const SPREAD = 0.5
// How far a strip reaches into each part past the outline — the cut beside the outline is
// inside the strip whatever the gap, and the clamp grows it by the cutter besides.
const OVERLAP_MM = 1
// How far a join to the frame reaches out from its part (see planBridges).
const FRAME_STUB_MM = 20

// The least distance between segments p→q and a→b.
function segSegDist(px: number, py: number, qx: number, qy: number, ax: number, ay: number, bx: number, by: number): number {
  const d1 = (qx - px) * (ay - py) - (qy - py) * (ax - px), d2 = (qx - px) * (by - py) - (qy - py) * (bx - px)
  const d3 = (bx - ax) * (py - ay) - (by - ay) * (px - ax), d4 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax)
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0
  const toSeg = (x: number, y: number, ux: number, uy: number, vx: number, vy: number) => {
    const dx = vx - ux, dy = vy - uy, l2 = dx * dx + dy * dy
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ux) * dx + (y - uy) * dy) / l2)) : 0
    return Math.hypot(x - ux - t * dx, y - uy - t * dy)
  }
  return Math.min(toSeg(px, py, ax, ay, bx, by), toSeg(qx, qy, ax, ay, bx, by), toSeg(ax, ay, px, py, qx, qy), toSeg(bx, by, px, py, qx, qy))
}

type Seg = { ax: number; ay: number; bx: number; by: number; owner: number }

/**
 * The bridge network for `parts` (see the header), sheet by sheet. Each join records the
 * part it starts on and the part or frame side it reaches — what the tests check the
 * network by; `placeBridges` is just its strips.
 */
export function planBridges(
  parts: { id: string; d: string }[], stock: { widthMM: number; heightMM: number },
  opts: BridgePlacement = { count: BRIDGE_DEFAULTS.count, toolRadiusMM: 3.175 / 2, widthMM: BRIDGE_DEFAULTS.widthMM },
): Join[] {
  type Part = { index: number; rings: [number, number][][]; size: number }
  const bySheet = new Map<string, { cell: Cell; parts: Part[] }>()
  parts.forEach((p, index) => {
    const rings = flattenPath(p.d, 0.25).filter((r) => r.length >= 2) as [number, number][][]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const r of rings) for (const [x, y] of r) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    if (!(maxX > minX) && !(maxY > minY)) return
    const cell = cellOfPoint((minX + maxX) / 2, (minY + maxY) / 2, stock)
    const key = cellKey(cell)
    let s = bySheet.get(key)
    if (!s) { s = { cell, parts: [] }; bySheet.set(key, s) }
    s.parts.push({ index, rings, size: Math.max(maxX - minX, maxY - minY) })
  })

  const joins: Join[] = []
  for (const [sheet, { cell, parts: sheetParts }] of bySheet) {
    const o = cellOffset(cell, stock)
    const X0 = o.x, Y0 = o.y, X1 = o.x + stock.widthMM, Y1 = o.y + stock.heightMM
    const SIDES = ['left', 'right', 'bottom', 'top'] as const
    // Every outline and the four sheet edges, in a grid of cells for nearest-point queries.
    // A side is owner -1 … -4.
    const segs: Seg[] = []
    sheetParts.forEach((p, k) => {
      for (const r of p.rings) for (let i = 1; i < r.length; i++) segs.push({ ax: r[i - 1][0], ay: r[i - 1][1], bx: r[i][0], by: r[i][1], owner: k })
    })
    segs.push({ ax: X0, ay: Y0, bx: X0, by: Y1, owner: -1 }, { ax: X1, ay: Y0, bx: X1, by: Y1, owner: -2 },
      { ax: X0, ay: Y0, bx: X1, by: Y0, owner: -3 }, { ax: X0, ay: Y1, bx: X1, by: Y1, owner: -4 })
    const CELL = 4
    const CONE_TAN = Math.tan(Math.asin(SQUARE_COS))
    const seenAt = new Int32Array(segs.length + 4)
    let queries = 0
    const grid = new Map<string, number[]>()
    const cellKeyOf = (i: number, j: number) => `${i},${j}`
    segs.forEach((sg, si) => {
      const i0 = Math.floor(Math.min(sg.ax, sg.bx) / CELL), i1 = Math.floor(Math.max(sg.ax, sg.bx) / CELL)
      const j0 = Math.floor(Math.min(sg.ay, sg.by) / CELL), j1 = Math.floor(Math.max(sg.ay, sg.by) / CELL)
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = cellKeyOf(i, j); const l = grid.get(k); if (l) l.push(si); else grid.set(k, [si])
      }
    })
    // The nearest point IN FRONT of (x, y) — within SQUARE_COS of the outward normal (nx, ny)
    // — on anything but part `self`, out to MAX_JOIN_MM. Only a segment's perpendicular foot
    // counts, so the join meets the far outline square as well. (Searching every direction
    // found the part on the far side of `self`, through `self` itself.)
    const nearest = (x: number, y: number, self: number, nx: number, ny: number, reach = MAX_JOIN_MM) => {
      let best: { d: number; x: number; y: number; owner: number } | null = null
      const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL)
      const query = ++queries
      for (let ring = 0; ring * CELL <= reach + CELL; ring++) {
        if (best && (ring - 1) * CELL > best.d) break
        for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue
          // Only cells that can hold something in front of the edge: a cell's centre more
          // than a cell's half-diagonal off the search cone holds nothing in it.
          if (ring > 1) {
            const vx = (i + 0.5) * CELL - x, vy = (j + 0.5) * CELL - y, dist = Math.hypot(vx, vy)
            const ahead = vx * nx + vy * ny, aside = Math.abs(vx * ny - vy * nx)
            if (ahead < -CELL || aside > ahead * CONE_TAN + CELL * 0.75 + 1e-9 && dist > 0) continue
          }
          for (const si of grid.get(cellKeyOf(i, j)) ?? []) {
            if (seenAt[si] === query) continue
            seenAt[si] = query
            const sg = segs[si]
            if (sg.owner === self) continue
            const dx = sg.bx - sg.ax, dy = sg.by - sg.ay, l2 = dx * dx + dy * dy
            if (l2 === 0) continue
            const u = ((x - sg.ax) * dx + (y - sg.ay) * dy) / l2
            if (u < 0 || u > 1) continue
            const px = sg.ax + u * dx, py = sg.ay + u * dy, d = Math.hypot(x - px, y - py)
            if (d > reach || (best && d >= best.d)) continue
            if (d > 1e-6 && ((px - x) * nx + (py - y) * ny) / d < Math.cos(Math.asin(SQUARE_COS))) continue
            best = { d, x: px, y: py, owner: sg.owner }
          }
        }
      }
      return best
    }
    // The frame side (x, y) faces along its outward normal (nx, ny), within the cone, and the
    // foot of the perpendicular on it — or null.
    const COS = Math.cos(Math.asin(SQUARE_COS))
    const frameAhead = (x: number, y: number, nx: number, ny: number) => {
      const hits = [
        -nx >= COS && y >= Y0 && y <= Y1 ? { d: x - X0, x: X0, y, owner: -1 } : null,
        nx >= COS && y >= Y0 && y <= Y1 ? { d: X1 - x, x: X1, y, owner: -2 } : null,
        -ny >= COS && x >= X0 && x <= X1 ? { d: y - Y0, x, y: Y0, owner: -3 } : null,
        ny >= COS && x >= X0 && x <= X1 ? { d: Y1 - y, x, y: Y1, owner: -4 } : null,
      ].filter((h): h is { d: number; x: number; y: number; owner: number } => !!h && h.d >= 0)
      return hits.sort((p, q) => p.d - q.d)[0] ?? null
    }
    // Whether the strip p→q would lift any cut but those of parts `a` and `b`: whether any
    // other outline crosses it or comes within `stripReach` of it. Crossing was all it asked
    // once, and a join out to the frame ran ALONGSIDE a neighbour's edge, a few mm off, and
    // lifted that cut the whole way — a long tab on a part it was not joining. The frame's own
    // edges are not cuts.
    const stripReach = opts.widthMM / 2 + 2 * opts.toolRadiusMM
    const blocked = (px: number, py: number, qx: number, qy: number, a: number, b: number) => {
      const i0 = Math.floor((Math.min(px, qx) - stripReach) / CELL), i1 = Math.floor((Math.max(px, qx) + stripReach) / CELL)
      const j0 = Math.floor((Math.min(py, qy) - stripReach) / CELL), j1 = Math.floor((Math.max(py, qy) + stripReach) / CELL)
      const query = ++queries
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        for (const si of grid.get(cellKeyOf(i, j)) ?? []) {
          if (seenAt[si] === query) continue
          seenAt[si] = query
          const sg = segs[si]
          if (sg.owner === a || sg.owner === b || sg.owner < 0) continue
          if (segSegDist(px, py, qx, qy, sg.ax, sg.ay, sg.bx, sg.by) < stripReach) return true
        }
      }
      return false
    }
    const crosses = (px: number, py: number, qx: number, qy: number, a: number, b: number) => {
      const i0 = Math.floor(Math.min(px, qx) / CELL), i1 = Math.floor(Math.max(px, qx) / CELL)
      const j0 = Math.floor(Math.min(py, qy) / CELL), j1 = Math.floor(Math.max(py, qy) / CELL)
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        for (const si of grid.get(cellKeyOf(i, j)) ?? []) {
          const sg = segs[si]
          if (sg.owner === a || sg.owner === b || sg.owner < 0) continue
          if (segSegDist(px, py, qx, qy, sg.ax, sg.ay, sg.bx, sg.by) === 0) return true
        }
      }
      return false
    }

    // Candidate joins: square samples along each part's OUTER outline. A hole is skipped — a
    // join from its edge would run across the hole, whose inside cut does not lift, so the
    // strip would be cut through.
    // `lifts`: the strip would lift a third part's cut too (see `blocked`) — kept, but only
    // for when nothing else will do.
    type Cand = { a: number; b: number; sx: number; sy: number; qx: number; qy: number; d: number; nx: number; ny: number; lifts: boolean }
    const candidatesFrom = (ks: number[], reach: number): Cand[] => {
     const cands: Cand[] = []
     for (const k of ks) {
      const p = sheetParts[k]
      for (const r of p.rings) {
        if (p.rings.some((o) => o !== r && pointInPolygon(r[0][0], r[0][1], o))) continue
        // Outward is to the right of travel on a counter-clockwise ring, the left on a clockwise.
        let area = 0
        for (let i = 1; i < r.length; i++) area += r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1]
        const out = area > 0 ? 1 : -1
        // At least SAMPLES_PER_RING round even a tiny part: at 3 mm a 25 mm outline had eight
        // points, few of them square to anything, and its count went unmet.
        let perimeter = 0
        for (let i = 1; i < r.length; i++) perimeter += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1])
        const step = Math.min(SAMPLE_MM, perimeter / SAMPLES_PER_RING)
        let run = 0
        for (let i = 1; i < r.length; i++) {
          const [ax, ay] = r[i - 1], [bx, by] = r[i]
          const len = Math.hypot(bx - ax, by - ay)
          if (len === 0) continue
          const tx = (bx - ax) / len, ty = (by - ay) / len
          for (let t = (step - (run % step)) % step; t < len; t += step) {
            const sx = ax + tx * t, sy = ay + ty * t
            const nx = out * ty, ny = -out * tx
            // The frame, whatever its distance, where this edge faces one of its sides squarely:
            // the search below stops at `reach`, and an edge facing open stock (the outer side
            // of an outer part) found nothing and could never be held there.
            const frame = frameAhead(sx, sy, nx, ny)
            const q0 = nearest(sx, sy, k, nx, ny, reach)
            const q = q0 && (!frame || q0.d <= frame.d) ? q0 : frame
            if (!q) continue
            // Nothing else between the two ends: a strip across one gap, not through a part.
            // Crossing another outline is never a join; only passing near one is a last resort.
            if (q.d > 1e-6 && crosses(sx, sy, q.x, q.y, k, q.owner)) continue
            cands.push({ a: k, b: q.owner, sx, sy, qx: q.x, qy: q.y, d: q.d, nx, ny, lifts: blocked(sx, sy, q.x, q.y, k, q.owner) })
          }
          run += len
        }
      }
     }
     return cands
    }
    const cands = candidatesFrom(sheetParts.map((_, k) => k), MAX_JOIN_MM)

    // Union-find over the parts and the frame (one node: the stock round a sheet is one piece).
    const FRAME = sheetParts.length
    const up = Array.from({ length: FRAME + 1 }, (_, i) => i)
    const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i])))
    const node = (owner: number) => (owner < 0 ? FRAME : owner)
    // Where each part's joins land on it, and which way each faces off it (its outward normal
    // there; the far end of a join faces back along it).
    const at: [number, number][][] = sheetParts.map(() => [])
    const facing: [number, number][][] = sheetParts.map(() => [])
    const chosen: Cand[] = []
    const take = (c: Cand) => {
      chosen.push(c)
      at[c.a].push([c.sx, c.sy]); facing[c.a].push([c.nx, c.ny])
      if (c.b >= 0) { at[c.b].push([c.qx, c.qy]); facing[c.b].push([-c.nx, -c.ny]) }
      up[find(c.a)] = find(node(c.b))
    }
    // Apart from every join a part already has — and not on top of a join either end.
    const clear = (c: Cand, spread: number) => {
      const far = (k: number, x: number, y: number) =>
        at[k].every(([px, py]) => Math.hypot(px - x, py - y) >= spread * sheetParts[k].size)
      return far(c.a, c.sx, c.sy) && (c.b < 0 || far(c.b, c.qx, c.qy))
    }
    let byGap = [...cands].sort((p, q) => p.d - q.d)
    // 1. Hang everything on the frame: the cheapest joins that connect something new.
    const hang = () => {
      // As far apart on each part as the counting pass asks (a quarter of the part let the
      // middle of a stack take both its joins 30 mm apart on a 120 mm part, and be full).
      for (const c of byGap) if (!c.lifts && find(c.a) !== find(node(c.b)) && clear(c, SPREAD)) take(c)
      for (const c of byGap) if (!c.lifts && find(c.a) !== find(node(c.b))) take(c)
      for (const c of byGap) if (find(c.a) !== find(node(c.b))) take(c)
    }
    hang()
    // Parts that still do not reach it — a group out in open stock, further than a join is
    // looked for — search again with no limit: a join across open stock lifts no cut, so its
    // length costs nothing, and the cap is only there to keep the everyday search quick.
    const loose = sheetParts.map((_, k) => k).filter((k) => find(k) !== find(FRAME))
    if (loose.length > 0) {
      byGap = [...cands, ...candidatesFrom(loose, Math.hypot(stock.widthMM, stock.heightMM))].sort((p, q) => p.d - q.d)
      hang()
    }
    // 2. Up to its count for every part, ROUND ROBIN — one more join each per round, so joins
    // between neighbours are shared out evenly. Each is the candidate facing a NEW way off the
    // part (60° or more from every join it has) if there is one, and of those the FARTHEST from
    // its joins: by distance alone a thin bent part took joins all along the side facing its
    // neighbour and none on the other, held on one side only. Never nearer another join,
    // at either end, than a strip and the cut either side of it: past what the outline offers
    // well apart, a part stops short of its count. (A last pass with no spacing at all put
    // five of six joins on one spot, and a higher count only stacked more there.)
    // A strip and the cut either side — or, on a part too small for that, two thirds of it.
    const minSepOf = (k: number) => Math.min(opts.widthMM + 2 * opts.toolRadiusMM + 2, 0.66 * sheetParts[k].size)
    const nearestJoin = (k: number, x: number, y: number) =>
      at[k].reduce((m, [px, py]) => Math.min(m, Math.hypot(px - x, py - y)), Infinity)
    const touching = sheetParts.map(() => [] as Cand[])
    for (const c of byGap) { touching[c.a].push(c); if (c.b >= 0) touching[c.b].push(c) }
    const taken = new Set<Cand>(chosen)
    // Three TIERS, each run over the whole sheet until nothing grows before the next opens:
    // first only joins that suit both ends (onto a neighbour short of its count, and facing a
    // new way off it); then onto any neighbour, for a small part ringed by full ones; last at
    // half the spacing — a small part asked for three gets three, closer together than a big
    // one's. Tier by tier and not part by part, or one part out of good joins fell to the
    // looser tiers and spent its neighbour's free joins before the neighbour had its turn.
    // A fourth tier takes the joins that lift a third part's cut as well; a fifth, a quarter
    // of the spacing — a small part wedged among crowded neighbours, every join of theirs
    // already near where its own would land, is better held close than left short.
    const tiers: [boolean, number, boolean][] = [[true, 1, false], [false, 1, false], [false, 0.5, false], [false, 0.5, true], [false, 0.25, true]]
    for (const [respectFull, room, lifting] of tiers) {
    for (let grew = true; grew;) {
      grew = false
      for (let k = 0; k < sheetParts.length; k++) {
        if (at[k].length >= opts.count) continue
        let best: Cand | null = null, bestSep = -1, bestFresh = -1
        for (const c of touching[k]) {
          if (taken.has(c) || (c.lifts && !lifting)) continue
          const [x, y] = c.a === k ? [c.sx, c.sy] : [c.qx, c.qy]
          const sep = nearestJoin(k, x, y)
          if (sep < room * minSepOf(k)) continue
          const o = c.a === k ? c.b : c.a
          // Not onto a part that has its count while there is any other way: the joins a
          // neighbour took onto a thin part filled its count from one side before it chose any
          // of its own.
          if (o >= 0 && ((respectFull && at[o].length >= opts.count) || nearestJoin(o, c.a === k ? c.qx : c.sx, c.a === k ? c.qy : c.sy) < room * minSepOf(o))) continue
          const [nx, ny] = c.a === k ? [c.nx, c.ny] : [-c.nx, -c.ny]
          const freshAt = (e: number, fx: number, fy: number) => facing[e].every(([gx, gy]) => gx * fx + gy * fy <= NEW_WAY_COS)
          // Nor onto a neighbour a join facing a way it already has (until the later tiers): the
          // middle of a stack, out of new ways itself, spent the top one's free joins on more of
          // the side facing it, and the top one was never held on its open side.
          if (respectFull && o >= 0 && !freshAt(o, -nx, -ny)) continue
          // New both ends beats new this end beats neither; then the farthest apart.
          const fresh = (freshAt(k, nx, ny) ? 2 : 0) + (o < 0 || freshAt(o, -nx, -ny) ? 1 : 0)
          if (fresh > bestFresh || (fresh === bestFresh && sep > bestSep + 1e-9)) { best = c; bestSep = sep; bestFresh = fresh }
        }
        if (best) { take(best); taken.add(best); grew = true }
      }
    }
    }
    // 3. A network meeting the frame on one side only: one more join, to another side.
    const sides = new Set(chosen.filter((c) => c.b < 0).map((c) => c.b))
    if (sides.size === 1) {
      const other = byGap.find((c) => c.b < 0 && !c.lifts && !sides.has(c.b) && clear(c, SPREAD / 2))
      if (other) take(other)
    }

    for (const c of chosen) {
      // Across the gap — or, where two outlines touch and there is no gap to cross, along the
      // outward normal: a zero-length strip was counted as a join and held nothing.
      const ux = c.d > 1e-6 ? (c.qx - c.sx) / c.d : c.nx, uy = c.d > 1e-6 ? (c.qy - c.sy) / c.d : c.ny
      // A join to the frame stops FRAME_STUB_MM out. Its whole way to the edge was checked
      // clear of every other cut, so it runs through one stretch of uncut stock that is
      // joined to the edge already: the strip only has to bridge the part's own cut.
      const len = c.b < 0 ? Math.min(c.d, FRAME_STUB_MM) : c.d + OVERLAP_MM
      joins.push({
        line: { x1: c.sx - ux * OVERLAP_MM, y1: c.sy - uy * OVERLAP_MM, x2: c.sx + ux * len, y2: c.sy + uy * len },
        a: sheetParts[c.a].index,
        b: c.b < 0 ? { side: SIDES[-c.b - 1] } : { part: sheetParts[c.b].index },
        gapMM: c.d, sheet,
      })
    }
  }
  return joins
}

/** The strips of the bridge network for `parts` (see `planBridges`). */
export function placeBridges(
  parts: { id: string; d: string }[], stock: { widthMM: number; heightMM: number }, opts?: BridgePlacement,
): BridgeLine[] {
  return planBridges(parts, stock, opts).map((j) => j.line)
}

// A strip grown by the cutter, in its own frame: `along` from `lo` to `hi` from the origin
// in the direction (ux, uy), `across` within ±`half`.
type Box = { ox: number; oy: number; ux: number; uy: number; lo: number; hi: number; half: number }
const local = (b: Box, x: number, y: number): [number, number] =>
  [(x - b.ox) * b.ux + (y - b.oy) * b.uy, -(x - b.ox) * b.uy + (y - b.oy) * b.ux]
// The part of move a→b inside box `b`, as [u0, u1] along the move, or null.
function clipBox(bx: Box, ax: number, ay: number, cx: number, cy: number): [number, number] | null {
  const [p, q] = local(bx, ax, ay), [r, s] = local(bx, cx, cy)
  return clip(p, q, r, s, bx.lo, bx.hi, -bx.half, bx.half)
}
const insideBox = (bx: Box, x: number, y: number) => {
  const [p, q] = local(bx, x, y)
  return p > bx.lo && p < bx.hi && q > -bx.half && q < bx.half
}

// Liang–Barsky: the part of segment a→b inside the box, as [u0, u1] along it, or null.
function clip(ax: number, ay: number, bx: number, by: number, x0: number, x1: number, y0: number, y1: number): [number, number] | null {
  const dx = bx - ax, dy = by - ay
  let u0 = 0, u1 = 1
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]] as const) {
    if (p === 0) { if (q < 0) return null; continue }
    const r = q / p
    if (p < 0) { if (r > u1) return null; if (r > u0) u0 = r }
    else { if (r < u0) return null; if (r < u1) u1 = r }
  }
  return u1 - u0 > 1e-12 ? [u0, u1] : null
}

/**
 * The cut `segs` with every move kept out of every strip below `topZ`: wherever the tool
 * centre comes within `clearMM` of a strip, the move is raised to `topZ` — split at the strip's
 * edges, with a straight step up and down there. This is how bridges reach a toolpath: ONE
 * pass over the finished moves, so a plunge, a ramp, an open stroke, a trochoidal loop, a
 * finishing pass and a link through the kerf are all held off by the same test, exactly,
 * whatever made them. An arc that could reach a strip below `topZ` is followed as a polyline
 * (0.25 mm steps), since only a straight move can be raised part of the way.
 */
export function clampToBridges(segs: MotionSegment[], set: BridgeSet, clearMM: number, topZ: number): MotionSegment[] {
  const half = set.widthMM / 2 + clearMM
  const boxes = set.lines.flatMap((l): Box[] => {
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1)
    if (len < 1e-9) return []
    const ux = (l.x2 - l.x1) / len, uy = (l.y2 - l.y1) / len
    return [{ ox: l.x1, oy: l.y1, ux, uy, lo: -clearMM, hi: len + clearMM, half }]
  })
  const out: MotionSegment[] = []
  let prev: MotionSegment | null = null
  for (const s of segs) {
    if (!prev || s.rapid || s.toolChange !== undefined || (prev.z >= topZ && s.z >= topZ)) { out.push(s); prev = s; continue }
    const from: MotionSegment = prev
    const pieces = s.arc ? arcAsLines(from, s) : [s]
    if (s.arc && !pieces.some((q, i) => touches(i === 0 ? from : pieces[i - 1], q, boxes))) { out.push(s); prev = s; continue }
    let at: MotionSegment = from
    for (const q of pieces) {
      for (const m of raiseMove(at, q, boxes, topZ)) out.push(m)
      at = q
    }
    prev = s
  }
  return out
}

function touches(a: MotionSegment, b: MotionSegment, boxes: Box[]): boolean {
  return boxes.some((bx) => clipBox(bx, a.x, a.y, b.x, b.y) !== null || (a.x === b.x && a.y === b.y && insideBox(bx, a.x, a.y)))
}

// One straight move a→b, raised to `topZ` over the stretches of it inside any box.
function raiseMove(a: MotionSegment, b: MotionSegment, boxes: Box[], topZ: number): MotionSegment[] {
  const { arc: _arc, ...base } = b
  const spans: [number, number][] = []
  for (const bx of boxes) {
    if (a.x === b.x && a.y === b.y) {
      if (insideBox(bx, a.x, a.y)) spans.push([0, 1])
    } else {
      const c = clipBox(bx, a.x, a.y, b.x, b.y)
      if (c) spans.push(c)
    }
  }
  if (spans.length === 0) return [b]
  spans.sort((p, q) => p[0] - q[0])
  const merged: [number, number][] = []
  for (const sp of spans) {
    const last = merged[merged.length - 1]
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp] as [number, number])
  }
  const pt = (u: number) => ({ x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y), z: a.z + u * (b.z - a.z) })
  const out: MotionSegment[] = []
  const put = (x: number, y: number, z: number) => {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - x) < 1e-9 && Math.abs(last.y - y) < 1e-9 && Math.abs(last.z - z) < 1e-9) return
    out.push({ ...base, x, y, z })
  }
  for (const [u0, u1] of merged) {
    const p0 = pt(u0), p1 = pt(u1)
    if (u0 > 0) put(p0.x, p0.y, p0.z)
    // Inside: never below the top. A move that crosses the top inside the strip (a ramp)
    // keeps its slope above it, so the kink where it meets the top is a point too. A move
    // that STARTS inside starts where the tool already is (raised by the move before), so
    // that point is not repeated.
    if (u0 > 0 || Math.max(p0.z, topZ) !== a.z) put(p0.x, p0.y, Math.max(p0.z, topZ))
    if ((p0.z - topZ) * (p1.z - topZ) < 0) {
      const uc = u0 + (u1 - u0) * (topZ - p0.z) / (p1.z - p0.z)
      const c = pt(uc)
      put(c.x, c.y, topZ)
    }
    put(p1.x, p1.y, Math.max(p1.z, topZ))
    if (u1 < 1) put(p1.x, p1.y, p1.z)
  }
  // The end, unless the last raised stretch runs right to it — then the tool ENDS raised,
  // and dropping it to the move's own depth there would cut into the strip.
  if (merged[merged.length - 1][1] < 1) put(b.x, b.y, b.z)
  return out
}

// An arc move from→to as straight moves 0.25 mm long: a sagitta of 0.25² / 8r, under 0.01 mm
// on any arc of 1 mm radius or more.
function arcAsLines(from: MotionSegment, to: MotionSegment): MotionSegment[] {
  const { cx, cy, cw } = to.arc!
  const r = Math.hypot(from.x - cx, from.y - cy)
  const a0 = Math.atan2(from.y - cy, from.x - cx), a1 = Math.atan2(to.y - cy, to.x - cx)
  let sweep = a1 - a0
  if (cw && sweep >= 0) sweep -= 2 * Math.PI
  if (!cw && sweep <= 0) sweep += 2 * Math.PI
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * r) / 0.25))
  const { arc: _arc, ...base } = to
  const out: MotionSegment[] = []
  for (let k = 1; k <= n; k++) {
    const u = k / n
    out.push(k === n
      ? { ...base, x: to.x, y: to.y, z: to.z }
      : { ...base, x: cx + r * Math.cos(a0 + u * sweep), y: cy + r * Math.sin(a0 + u * sweep), z: from.z + u * (to.z - from.z) })
  }
  return out
}
