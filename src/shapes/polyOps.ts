// ─── Polygon plumbing for the compound-path shape generators ─────────────────
//
// Shapes that are assembled rather than drawn — the cutting board, the gear —
// build their geometry as rings of points and lean on clipper for the hard
// parts. Everything is in CNC mm, Y-up, and every ring here is a SIMPLE closed
// polygon with no closing duplicate: outer rings CCW, and the caller decides
// which of them get emitted CW as holes.
//
// The two morphological operations are the reason this file exists. `roundConcave`
// (a closing) fills every concave corner with a tangent arc and leaves convex
// ones exactly as they are; `roundConvex` (an opening) does the reverse. Between
// them they fillet an assembled shape without anyone having to solve a tangent
// arc by hand, which is what lets one code path blend a handle into three
// different board bodies and fillet a gear's tooth roots and spoke webs.

import polygonClipping from 'polygon-clipping'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { signedArea } from '../cam/pathFlattener'
import { stripClosingDuplicate } from '../cam/geom'

export type Pt = [number, number]

/** Chord tolerance when sampling an arc into a polyline, mm. */
export const TOL = 0.05

export function fmt(n: number): string { return String(+n.toFixed(4)) }
export function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)) }

export function ccw(ring: Pt[]): Pt[] {
  const r = stripClosingDuplicate(ring) as Pt[]
  return signedArea(r) < 0 ? r.slice().reverse() : r
}

// ─── Sampling ─────────────────────────────────────────────────────────────────

/** Append an elliptical arc, skipping the start point so it chains onto `out`. */
export function arcInto(out: Pt[], cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): void {
  const r = Math.max(rx, ry)
  const step = r <= TOL ? Math.PI / 2 : 2 * Math.acos(clamp(1 - TOL / r, -1, 1))
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / Math.max(step, 1e-3)))
  for (let i = 1; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n)
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
}

export function roundRectRing(x: number, y: number, w: number, h: number, r0: number): Pt[] {
  const r = clamp(r0, 0, Math.min(w, h) / 2)
  if (r < 1e-6) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
  const ring: Pt[] = [[x + r, y], [x + w - r, y]]
  arcInto(ring, x + w - r, y + r, r, r, -Math.PI / 2, 0)
  ring.push([x + w, y + h - r])
  arcInto(ring, x + w - r, y + h - r, r, r, 0, Math.PI / 2)
  ring.push([x + r, y + h])
  arcInto(ring, x + r, y + h - r, r, r, Math.PI / 2, Math.PI)
  ring.push([x, y + r])
  arcInto(ring, x + r, y + r, r, r, Math.PI, 1.5 * Math.PI)
  return ring
}

export function ellipseRing(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const ring: Pt[] = [[cx + rx, cy]]
  arcInto(ring, cx, cy, rx, ry, 0, 2 * Math.PI)
  ring.pop()   // the sweep closes on the start point
  return ring
}

// ─── Boolean / offset ─────────────────────────────────────────────────────────
//
// Callers assemble by unioning a feature on, biting one out of an edge, or
// clipping with a shape that reaches past the body — never by subtracting
// something that lands wholly inside — so no result carries a hole. That is why
// these pass flat lists of simple rings rather than outer/hole trees, and why
// `boolRings` may keep just each result polygon's outer ring.

export function inflateRings(rings: Pt[][], delta: number): Pt[][] {
  if (rings.length === 0 || Math.abs(delta) < 1e-9) return rings
  const out = inflatePathsD(
    rings.map((r) => r.map(([x, y]) => ({ x, y }))),
    delta, JoinType.Round, EndType.Polygon, 2, 6,
  )
  return out
    .map((p) => ccw(p.map((q) => [q.x, q.y] as Pt)))
    .filter((r) => r.length >= 3 && signedArea(r) > 1e-6)
}

/** Mean width of a ring, mm — 2·area/perimeter, which for a long thin sliver is
 *  the thickness and for anything real is a working dimension. */
function meanWidth(ring: Pt[]): number {
  let per = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    per += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1])
  }
  return per < 1e-12 ? 0 : (2 * Math.abs(signedArea(ring))) / per
}

export function boolRings(op: 'union' | 'difference', a: Pt[][], b: Pt[][]): Pt[][] {
  if (a.length === 0) return []
  if (b.length === 0) return a
  const A = a.map((r) => [r]) as never
  const B = b.map((r) => [r]) as never
  const out = op === 'union' ? polygonClipping.union(A, B) : polygonClipping.difference(A, B)
  // Drop the slivers clipper leaves along a coincident edge. They carry seven or
  // eight points, so a point count cannot see them, and they survive all the way
  // to the canvas — where a ring with no width still draws, as a stray line
  // lying across the part. The test is WIDTH, not area: 2·area/perimeter is the
  // mean width of a long thin ring, and these come out around half a micron
  // against millimetres for anything real.
  return out
    .map((poly) => ccw(poly[0] as Pt[]))
    .filter((r) => r.length >= 3 && signedArea(r) > 1e-6 && meanWidth(r) > 1e-3)
}

/** Morphological closing — fills concave corners with a tangent arc of radius f,
 *  and leaves convex corners untouched (they dilate and erode straight back). */
export function roundConcave(rings: Pt[][], f: number): Pt[][] {
  if (f < 0.05) return rings
  return inflateRings(inflateRings(rings, f), -f)
}

/** Opening — the dual: rounds convex corners SHARPER than f up to radius f, and
 *  leaves concave ones. Returns the input unchanged if eroding would wipe the
 *  shape out, which is the only way it can fail. */
export function roundConvex(rings: Pt[][], f: number): Pt[][] {
  if (f < 0.05) return rings
  const eroded = inflateRings(rings, -f)
  if (eroded.length === 0) return rings
  return inflateRings(eroded, f)
}

// ─── Emission ─────────────────────────────────────────────────────────────────

/** One closed subpath. `wantCCW` false emits it CW, the repo's convention for a
 *  ring that is a hole inside the one before it. */
export function ringToD(ring: Pt[], wantCCW: boolean): string {
  const r = signedArea(ring) < 0 === wantCCW ? ring.slice().reverse() : ring
  return 'M' + r.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L') + ' Z'
}
