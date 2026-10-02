// ─── Snapping a nest to one cutter's gap ──────────────────────────────────────
//
// The raster nest (nestOp.ts) can only place a part to the nearest cell, and every mask is
// a superset of its part, so two parts asked to stand 6 mm apart come out anywhere from
// 6 mm to 6 mm and a cell or so. For an ordinary nest that slack is harmless. For SHARED
// LINES it is everything: two neighbours share a cut only when their cut paths lie on the
// SAME line (cam/sharedLineProfile.ts), and a gap 0.3 mm too wide leaves two cuts 0.3 mm
// apart instead of one.
//
// So, after the raster, every part SLIDES toward the edge the nest grows from — along one
// axis, then the other, until nothing moves — and stops at exact contact. "Contact" is
// measured between the parts' CUT PATHS: each part's outline offset by half the gap with
// `offsetClosedSubpaths`, the very offset an outside profile cuts along. Two cut paths
// that touch along a pair of parallel edges are then one line to the shared-line planner,
// and two that merely touch at a corner are allowed by it. Using any other offset here
// (a round one, say) would let a mitred corner of the real cut path poke past its
// neighbour's — see the mitre test in commonLine.test.ts.
//
// The sweep only ever moves a part into free space and stops at the first contact, so it
// can never make two cut paths cross; the raster's guarantee survives. A part that starts
// out overlapping another's cut path — one nested inside another's hole, whose cut path
// is the hole filled in — fails the very first overlap test of its slide, so it is left
// exactly where the raster put it, and so is the part around it.

import type { Pt2 } from '../cam/pathFlattener'
import { offsetClosedSubpaths } from '../cam/profile'
import { pointInPolygon, pointOnRing } from '../cam/geom'

export interface SnapPart {
  id: string
  /** The part's rings where the nest placed it, CNC mm. */
  rings: Pt2[][]
}

export interface SnapParams {
  /** The gap two neighbours end up at along facing edges: one cutter diameter. */
  gapMM: number
  sheetWidthMM: number
  sheetHeightMM: number
  marginMM: number
  /** The edge the nest grew from — and so the direction parts slide toward first. */
  packFrom: 'left' | 'bottom'
}

/** Rounds of slide-left-then-down. A grid of rectangles settles in two; this is a backstop. */
const MAX_ROUNDS = 8
const EPS = 1e-9

type Box = { minX: number; minY: number; maxX: number; maxY: number }

function boxOf(rings: Pt2[][]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of rings) for (const [x, y] of r) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

interface Body {
  /** The cut path(s): the outline grown by half the gap. */
  rings: Pt2[][]
  box: Box
}

function bodyOf(rings: Pt2[][], half: number): Body {
  const grown = offsetClosedSubpaths(rings.filter((r) => r.length >= 3), half)
  return { rings: grown, box: boxOf(grown) }
}

const shiftBody = (b: Body, dx: number, dy: number): Body => ({
  rings: b.rings.map((r) => r.map(([x, y]) => [x + dx, y + dy] as Pt2)),
  box: { minX: b.box.minX + dx, minY: b.box.minY + dy, maxX: b.box.maxX + dx, maxY: b.box.maxY + dy },
})

const boxesOverlap = (a: Box, b: Box) => a.minX < b.maxX - EPS && b.minX < a.maxX - EPS && a.minY < b.maxY - EPS && b.minY < a.maxY - EPS

function strictlyInside(p: Pt2, rings: Pt2[][]): boolean {
  let inside = false
  for (const r of rings) {
    if (pointOnRing(p[0], p[1], r, 1e-7)) return false
    if (pointInPolygon(p[0], p[1], r)) inside = !inside
  }
  return inside
}

/** Do the INTERIORS of two bodies meet? Touching along an edge or at a point does not count. */
export function interiorsOverlap(a: Body, b: Body): boolean {
  if (!boxesOverlap(a.box, b.box)) return false
  for (const ra of a.rings) for (let i = 0; i < ra.length; i++) {
    const p = ra[i], q = ra[(i + 1) % ra.length]
    for (const rb of b.rings) for (let j = 0; j < rb.length; j++) {
      const r = rb[j], s = rb[(j + 1) % rb.length]
      const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0])
      if (Math.abs(d) < 1e-12) continue
      const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d
      const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) return true
    }
  }
  // No proper crossing: either apart, touching, or one inside the other. Vertices and edge
  // midpoints catch the last, including rings that share every vertex.
  const probes = (x: Body) => x.rings.flatMap((r) => r.flatMap((p, i) => {
    const q = r[(i + 1) % r.length]
    return [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Pt2]
  }))
  return probes(a).some((p) => strictlyInside(p, b.rings)) || probes(b).some((p) => strictlyInside(p, a.rings))
}

/**
 * Every distance `mover` could travel toward −axis before a vertex of one body reaches an
 * edge of the other — the only places a slide can come to a stop.
 */
function contactDistances(mover: Body, fixed: Body, axis: 0 | 1, out: number[]): void {
  const o = axis === 0 ? 1 : 0
  // Ray from point `v`, travelling −axis, to edge p–q. Returns the travel, or NaN.
  const hit = (v: Pt2, p: Pt2, q: Pt2): number => {
    if ((p[o] - v[o]) * (q[o] - v[o]) > 0) return NaN
    if (Math.abs(q[o] - p[o]) < 1e-12) return NaN // parallel to the motion: a slide, never a stop
    const at = p[axis] + ((v[o] - p[o]) * (q[axis] - p[axis])) / (q[o] - p[o])
    return v[axis] - at
  }
  for (const rm of mover.rings) for (const v of rm) for (const rf of fixed.rings) for (let j = 0; j < rf.length; j++) {
    const t = hit(v, rf[j], rf[(j + 1) % rf.length])
    if (t >= -1e-9) out.push(Math.max(0, t))
  }
  // A fixed vertex meeting a mover's edge: the same ray, run the other way.
  for (const rf of fixed.rings) for (const w of rf) for (const rm of mover.rings) for (let j = 0; j < rm.length; j++) {
    const t = -hit(w, rm[j], rm[(j + 1) % rm.length])
    if (t >= -1e-9) out.push(Math.max(0, t))
  }
}

/** How far `mover` can slide toward −axis, at most `limit`, without its interior meeting any of `others`. */
function slideDistance(mover: Body, others: Body[], axis: 0 | 1, limit: number): number {
  if (limit <= EPS) return 0
  // Only what the swept box can reach.
  const swept: Box = axis === 0
    ? { ...mover.box, minX: mover.box.minX - limit }
    : { ...mover.box, minY: mover.box.minY - limit }
  const near = others.filter((b) => boxesOverlap(swept, b.box))
  const cands: number[] = [0, limit]
  for (const b of near) contactDistances(mover, b, axis, cands)
  const stops = [...new Set(cands.filter((t) => t <= limit).map((t) => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y)
  // A contact stops the slide only if going PAST it overlaps; test between consecutive stops.
  for (let k = 0; k + 1 < stops.length; k++) {
    const mid = (stops[k] + stops[k + 1]) / 2
    const moved = axis === 0 ? shiftBody(mover, -mid, 0) : shiftBody(mover, 0, -mid)
    if (near.some((b) => interiorsOverlap(moved, b))) return stops[k]
  }
  return limit
}

/**
 * Slide each part toward the edge the nest grows from until its cut path meets another's
 * or its outline reaches the margin. Returns each part's extra translation; parts that
 * could not move are absent.
 */
export function snapToGap(parts: SnapPart[], obstacles: Pt2[][][], params: SnapParams): Map<string, { dx: number; dy: number }> {
  const half = params.gapMM / 2
  const bodies = parts.map((p) => bodyOf(p.rings, half))
  const outlines = parts.map((p) => boxOf(p.rings))
  const fixedBodies = obstacles.map((o) => bodyOf(o, half))

  const shift = parts.map(() => ({ dx: 0, dy: 0 }))
  const axes: (0 | 1)[] = params.packFrom === 'left' ? [0, 1] : [1, 0]
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let moved = false
    for (const axis of axes) {
      // Nearest the destination edge first, so each part slides up against parts that
      // have already settled rather than ones still on their way.
      const order = parts.map((_, i) => i)
        .sort((a, b) => axis === 0 ? outlines[a].minX - outlines[b].minX || outlines[a].minY - outlines[b].minY
          : outlines[a].minY - outlines[b].minY || outlines[a].minX - outlines[b].minX)
      for (const i of order) {
        const limit = (axis === 0 ? outlines[i].minX : outlines[i].minY) - params.marginMM
        const others = [...bodies.filter((_, j) => j !== i), ...fixedBodies]
        const t = slideDistance(bodies[i], others, axis, limit)
        if (t <= 1e-7) continue
        const dx = axis === 0 ? -t : 0, dy = axis === 1 ? -t : 0
        bodies[i] = shiftBody(bodies[i], dx, dy)
        outlines[i] = { minX: outlines[i].minX + dx, minY: outlines[i].minY + dy, maxX: outlines[i].maxX + dx, maxY: outlines[i].maxY + dy }
        shift[i].dx += dx
        shift[i].dy += dy
        moved = true
      }
    }
    if (!moved) break
  }

  const out = new Map<string, { dx: number; dy: number }>()
  parts.forEach((p, i) => { if (shift[i].dx !== 0 || shift[i].dy !== 0) out.set(p.id, shift[i]) })
  return out
}
