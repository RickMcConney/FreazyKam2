// ─── Common-line detection ────────────────────────────────────────────────────
//
// Which stretches of a set of closed cutter centre-lines lie on top of each other, so a
// combined-line job can cut each of them ONCE instead of once per part.
//
// Ported from WoodCAM (github.com/danielma89/WoodCam, MIT licence,
// woodcam_editor/application/common_line.py — `plan_common_line_cut`), with its tests.
// Only the detection is ported: tab placement and trail building are not.
//
// WHAT GOES IN IS ALREADY COMPENSATED. Two raw part outlines that merely touch do NOT share
// a cut — cutting their common edge on the line eats half a cutter from each part. The
// dimension-preserving arrangement is parts spaced exactly one cutter diameter apart, so
// their OUTSIDE OFFSETS coincide; hand this the offsets. And the offset handed in here
// must be the same one the toolpath is made from: a mitred corner on an obtuse vertex
// overshoots the cutter's real round sweep, so two tips nested one diameter apart pass
// as clear under a round offset and cross under a mitred one (see the first test).
//
// THE PLAN IS ALL OR NOTHING. A positive-length collinear overlap is a common line only
// when exactly two parts own it and their interiors lie on OPPOSITE sides of it. Anything
// else that is unsafe — boundaries that cross, one part's area inside another's, a line
// with three owners, a duplicated, self-crossing or degenerate ring — makes the plan
// invalid, and an invalid plan carries NO segments, so a caller cannot machine half of a
// layout it should have refused. A contact at a single point (a corner meeting a corner,
// a tip meeting the middle of an edge) is allowed and stays ordinary perimeter; it is
// reported in `touchPoints`.
//
// TWO TOLERANCES, NEVER CONFUSED. `tolerance` is the user's matching allowance between
// DIFFERENT borders. It never simplifies a ring — 0.2 mm would flatten the short chords of
// a compensated round corner and could erase an exact straight shared edge — and it is
// capped at `MAX_PHYSICAL_COINCIDENCE_MM` wherever it decides that two segments are the
// same physical line, or that a ring crosses itself (neighbouring chords of one flattened
// arc are a fraction of a millimetre apart and are not touching).
//
// Straight segments only: a curve arrives as its flattening. CNC mm; winding is free.

import type { Pt2 } from './pathFlattener'

/** The most two borders may differ by and still be one physical line, whatever the user's tolerance. */
export const MAX_PHYSICAL_COINCIDENCE_MM = 1e-3

// ─── Public types ─────────────────────────────────────────────────────────────

export type CommonLineIssueCode =
  | 'invalid_contour'
  | 'duplicate_contour'
  | 'self_intersection'
  | 'crossing'
  | 'area_overlap'
  | 'ambiguous_shared_line'

/** A named closed ring. The closing point may be repeated or omitted. Never mutated. */
export interface CommonLineContour {
  id: string
  points: readonly Pt2[]
}

/** One straight cut span. `ownerIds` is sorted; two owners means a shared (common) line. */
export interface CommonLineSegment {
  start: Pt2
  end: Pt2
  ownerIds: string[]
  /** `[contourId, segmentIndex]` of every source edge this span came from, in normalised ring indices. */
  sourceSegments: [string, number][]
}

export interface CommonLineIssue {
  code: CommonLineIssueCode
  message: string
  /** Sorted, de-duplicated. */
  contourIds: string[]
  /** Where the problem is, when it has a place. */
  points: Pt2[]
}

export interface CommonLinePlan {
  /** Spans owned by one contour. Empty when the plan is invalid. */
  perimeterSegments: CommonLineSegment[]
  /** Spans owned by exactly two contours, each emitted once, start ≤ end lexicographically. */
  sharedSegments: CommonLineSegment[]
  /** Point-only contacts that are not on a shared span. */
  touchPoints: Pt2[]
  /** Empty when the plan is safe to cut. */
  issues: CommonLineIssue[]
  tolerance: number
}

export class CommonLinePlanningError extends Error {
  readonly issues: CommonLineIssue[]
  constructor(issues: CommonLineIssue[]) {
    super(issues.map((i) => i.message).join('; ') || 'invalid common-line plan')
    this.name = 'CommonLinePlanningError'
    this.issues = issues
  }
}

export const segmentLength = (s: CommonLineSegment): number => dist(s.start, s.end)
export const isShared = (s: CommonLineSegment): boolean => s.ownerIds.length === 2
export const isPlanValid = (p: CommonLinePlan): boolean => p.issues.length === 0
export const hasCommonLines = (p: CommonLinePlan): boolean => p.sharedSegments.length > 0

/** Total cut length with each shared span counted once. */
export function totalCutLength(p: CommonLinePlan): number {
  let total = 0
  for (const s of p.perimeterSegments) total += segmentLength(s)
  for (const s of p.sharedSegments) total += segmentLength(s)
  return total
}

/** The spans only `contourId` owns. */
export function perimeterFor(p: CommonLinePlan, contourId: string): CommonLineSegment[] {
  return p.perimeterSegments.filter((s) => s.ownerIds.length === 1 && s.ownerIds[0] === contourId)
}

/** Throws a `CommonLinePlanningError` carrying the issues when the plan is not safe to cut. */
export function requireValid(p: CommonLinePlan): CommonLinePlan {
  if (p.issues.length) throw new CommonLinePlanningError(p.issues)
  return p
}

// ─── Vector helpers ───────────────────────────────────────────────────────────

const sub = (a: Pt2, b: Pt2): Pt2 => [a[0] - b[0], a[1] - b[1]]
const add = (a: Pt2, b: Pt2): Pt2 => [a[0] + b[0], a[1] + b[1]]
const mul = (a: Pt2, k: number): Pt2 => [a[0] * k, a[1] * k]
const dot = (a: Pt2, b: Pt2): number => a[0] * b[0] + a[1] * b[1]
const cross = (a: Pt2, b: Pt2): number => a[0] * b[1] - a[1] * b[0]
const len = (a: Pt2): number => Math.hypot(a[0], a[1])
const dist = (a: Pt2, b: Pt2): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const lerp = (a: Pt2, b: Pt2, t: number): Pt2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
const near = (a: Pt2, b: Pt2, tol: number): boolean => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= tol * tol
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
const mod = (i: number, n: number): number => ((i % n) + n) % n

function signedArea(pts: readonly Pt2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) a += cross(pts[i], pts[(i + 1) % pts.length])
  return a * 0.5
}

type Location = 'inside' | 'boundary' | 'outside'

function locate(p: Pt2, poly: readonly Pt2[], tol: number): Location {
  if (poly.length < 3) return 'outside'
  let inside = false
  let prev = poly[poly.length - 1]
  for (const cur of poly) {
    if (pointSegDist(p, prev, cur) <= tol) return 'boundary'
    if ((cur[1] > p[1]) !== (prev[1] > p[1])) {
      const xAtY = prev[0] + ((p[1] - prev[1]) * (cur[0] - prev[0])) / (cur[1] - prev[1])
      if (xAtY > p[0]) inside = !inside
    }
    prev = cur
  }
  return inside ? 'inside' : 'outside'
}

function pointSegDist(p: Pt2, a: Pt2, b: Pt2): number {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  if (l2 === 0) return dist(p, a)
  return dist(p, add(a, mul(ab, clamp01(dot(sub(p, a), ab) / l2))))
}

// ─── Tolerances ───────────────────────────────────────────────────────────────

/** Precision floor that must never inherit the user's match tolerance. */
const numericalEpsilon = (tol: number): number => Math.min(Math.abs(tol), 1e-7)

/**
 * Merge nearby split parameters without collapsing a whole edge. The match tolerance is
 * not a minimum machinable length — a compensated dogbone arc has chords shorter than a
 * 0.2 mm tolerance — so the dimensionless epsilon is capped below half an edge.
 */
const parameterEpsilon = (length: number, tol: number): number =>
  Math.min(0.25, Math.abs(tol) / Math.max(Math.abs(length), Math.abs(tol), 1e-12))

/** Scale-independent parallelism threshold for two non-null segments. */
const angularEpsilon = (la: number, lb: number, tol: number): number =>
  Math.max(1e-9, Math.min(1e-3, Math.abs(tol) / Math.max(Math.abs(la), Math.abs(lb), Math.abs(tol), 1e-12)))

const coincidenceTolerance = (tol: number): number => Math.min(Math.abs(tol), MAX_PHYSICAL_COINCIDENCE_MM)

// ─── Internal types ───────────────────────────────────────────────────────────

interface Ring { id: string; points: Pt2[]; area: number }

interface SegRef {
  contourId: string
  contourIndex: number
  segmentIndex: number
  start: Pt2
  end: Pt2
  /** Signed area of the owning ring — its sign says which side the interior is on. */
  area: number
}

type Relation =
  | { kind: 'overlap'; overlapStart: Pt2; overlapEnd: Pt2; a0: number; a1: number; b0: number; b1: number }
  | { kind: 'touch'; point: Pt2 }
  | { kind: 'cross'; point: Pt2 }

interface Atom { start: Pt2; end: Pt2; ownerId: string; source: [string, number] }

type Bounds = [number, number, number, number]

function issue(code: CommonLineIssueCode, message: string, ids: Iterable<string> = [], points: Pt2[] = []): CommonLineIssue {
  return { code, message, contourIds: [...new Set([...ids].map(String))].sort(), points }
}

function dedupePoints(points: Iterable<Pt2>, tol: number): Pt2[] {
  const out: Pt2[] = []
  for (const p of points) if (!out.some((q) => near(p, q, tol))) out.push(p)
  return out
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function normaliseRing(contour: CommonLineContour, tol: number): Ring | CommonLineIssue {
  const id = contour.id.trim()
  if (!id) return issue('invalid_contour', 'A contour has no id.')

  // Only numerical duplicates and numerically collinear points go — see the header on why
  // the match tolerance must never simplify a ring.
  const eps = Math.min(tol, 1e-7)
  let pts: Pt2[] = contour.points.map((p) => [p[0], p[1]])
  while (pts.length > 1 && near(pts[0], pts[pts.length - 1], eps)) pts.pop()
  const consecutive: Pt2[] = []
  for (const p of pts) if (!consecutive.length || !near(p, consecutive[consecutive.length - 1], eps)) consecutive.push(p)
  pts = consecutive
  if (pts.length > 1 && near(pts[0], pts[pts.length - 1], eps)) pts.pop()

  // Remove only a middle point lying BETWEEN its neighbours. A reversal (A → B → A) is
  // kept on purpose, so the self-overlap it makes is diagnosed below.
  let changed = true
  while (changed && pts.length >= 3) {
    changed = false
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[mod(i - 1, pts.length)]
      const cur = pts[i]
      const next = pts[(i + 1) % pts.length]
      const base = sub(next, prev)
      const baseLen = len(base)
      if (baseLen <= tol) continue
      const off = Math.abs(cross(sub(cur, prev), base)) / baseLen
      const proj = dot(sub(cur, prev), base) / (baseLen * baseLen)
      if (off <= eps && proj >= -eps && proj <= 1 + eps) {
        pts.splice(i, 1)
        changed = true
        break
      }
    }
  }

  if (pts.length < 3) return issue('invalid_contour', `Contour ${id} needs at least three distinct points.`, [id], pts)
  for (let i = 0; i < pts.length; i++) {
    if (dist(pts[i], pts[(i + 1) % pts.length]) <= eps) {
      return issue('invalid_contour', `Contour ${id} has a zero-length segment.`, [id], [pts[i]])
    }
  }

  const area = signedArea(pts)
  const ring: Ring = { id, points: pts, area }
  const segs = segmentsOf(ring, 0)
  const selfTol = coincidenceTolerance(tol)
  const hits: Pt2[] = []
  for (const [i, j] of candidateSegmentPairs(segs.map(segmentBounds), undefined, selfTol)) {
    const adjacent = j === i + 1 || (i === 0 && j === segs.length - 1)
    const rel = segmentRelation(segs[i], segs[j], selfTol)
    if (!rel || (adjacent && rel.kind === 'touch')) continue
    if (rel.kind === 'overlap') hits.push(rel.overlapStart, rel.overlapEnd)
    else hits.push(rel.point)
  }
  if (hits.length) return issue('self_intersection', `Contour ${id} crosses or overlaps itself.`, [id], dedupePoints(hits, tol))
  if (Math.abs(area) <= tol * tol) return issue('invalid_contour', `Contour ${id} has no area.`, [id], pts)
  return ring
}

function segmentsOf(ring: Ring, contourIndex: number): SegRef[] {
  return ring.points.map((p, i) => ({
    contourId: ring.id, contourIndex, segmentIndex: i,
    start: p, end: ring.points[(i + 1) % ring.points.length], area: ring.area,
  }))
}

const segmentBounds = (s: { start: Pt2; end: Pt2 }): Bounds => [
  Math.min(s.start[0], s.end[0]), Math.min(s.start[1], s.end[1]),
  Math.max(s.start[0], s.end[0]), Math.max(s.start[1], s.end[1]),
]

function ringBounds(r: Ring): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of r.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  return [x0, y0, x1, y1]
}

const boundsMayContact = (a: Bounds, b: Bounds, tol: number): boolean =>
  !(a[2] < b[0] - tol || b[2] < a[0] - tol || a[3] < b[1] - tol || b[3] < a[1] - tol)

// ─── Broad phase ──────────────────────────────────────────────────────────────

/**
 * Index pairs whose bounds, grown by `tol`, can meet — by an X sweep, so a dense ring or a
 * sheet of many parts does not compare every chord with every other. With one collection
 * the pairs are `[i, j]` with i < j; with two, `[indexInFirst, indexInSecond]`. Sorted.
 * Exported for its test.
 */
export function candidateSegmentPairs(first: readonly Bounds[], second?: readonly Bounds[], tol = 0): [number, number][] {
  const same = second === undefined
  const other = second ?? first
  // [x, kind (0 = open, 1 = close), collection, index] — opens sort before closes at one x,
  // so bounds that only touch still meet.
  const events: [number, number, number, number][] = []
  first.forEach((b, i) => { events.push([b[0] - tol, 0, 0, i], [b[2] + tol, 1, 0, i]) })
  if (!same) other.forEach((b, i) => { events.push([b[0] - tol, 0, 1, i], [b[2] + tol, 1, 1, i]) })
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3])

  const activeFirst = new Set<number>()
  const activeSecond = new Set<number>()
  const found = new Map<string, [number, number]>()
  const put = (i: number, j: number) => { found.set(`${i},${j}`, [i, j]) }
  for (const [, kind, coll, i] of events) {
    if (kind === 1) { (coll === 0 ? activeFirst : activeSecond).delete(i); continue }
    if (same) {
      for (const o of activeFirst) {
        const lo = Math.min(i, o), hi = Math.max(i, o)
        if (boundsMayContact(first[lo], first[hi], tol)) put(lo, hi)
      }
      activeFirst.add(i)
    } else if (coll === 0) {
      for (const o of activeSecond) if (boundsMayContact(first[i], other[o], tol)) put(i, o)
      activeFirst.add(i)
    } else {
      for (const o of activeFirst) if (boundsMayContact(first[o], other[i], tol)) put(o, i)
      activeSecond.add(i)
    }
  }
  return [...found.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

// ─── Segment relation ─────────────────────────────────────────────────────────

function closestEndpointPair(a: SegRef, b: SegRef): [number, Pt2, Pt2] {
  const c: [number, Pt2, Pt2][] = [
    [dist(a.start, b.start), a.start, b.start],
    [dist(a.start, b.end), a.start, b.end],
    [dist(a.end, b.start), a.end, b.start],
    [dist(a.end, b.end), a.end, b.end],
  ]
  return c.reduce((m, v) => (v[0] < m[0] ? v : m))
}

function segmentRelation(a: SegRef, b: SegRef, tol: number): Relation | null {
  const u = sub(a.end, a.start)
  const v = sub(b.end, b.start)
  const la = len(u)
  const lb = len(v)
  if (la <= numericalEpsilon(tol) || lb <= numericalEpsilon(tol)) return null

  const ua = mul(u, 1 / la)
  const ub = mul(v, 1 / lb)
  const d0 = Math.abs(cross(sub(b.start, a.start), ua))
  const d1 = Math.abs(cross(sub(b.end, a.start), ua))
  const coTol = coincidenceTolerance(tol)
  const angTol = angularEpsilon(la, lb, tol)
  const parallel = Math.abs(cross(ua, ub)) <= angTol

  if (parallel && d0 <= coTol && d1 <= coTol) {
    const p0 = dot(sub(b.start, a.start), ua)
    const p1 = dot(sub(b.end, a.start), ua)
    const low = Math.max(0, Math.min(p0, p1))
    const high = Math.min(la, Math.max(p0, p1))
    const overlap = high - low
    if (overlap > coTol) {
      const start = add(a.start, mul(ua, low))
      const end = add(a.start, mul(ua, high))
      const vv = dot(v, v)
      return {
        kind: 'overlap', overlapStart: start, overlapEnd: end,
        a0: clamp01(low / la), a1: clamp01(high / la),
        b0: clamp01(dot(sub(start, b.start), v) / vv), b1: clamp01(dot(sub(end, b.start), v) / vv),
      }
    }
    const [d, p, q] = closestEndpointPair(a, b)
    if (overlap >= -tol || d <= tol) return { kind: 'touch', point: lerp(p, q, 0.5) }
    return null
  }

  if (parallel) {
    const [d, p, q] = closestEndpointPair(a, b)
    return d <= tol ? { kind: 'touch', point: lerp(p, q, 0.5) } : null
  }

  const denom = cross(u, v)
  const off = sub(b.start, a.start)
  let ta = cross(off, v) / denom
  let tb = cross(off, u) / denom
  const ea = parameterEpsilon(la, tol)
  const eb = parameterEpsilon(lb, tol)
  if (ta >= -ea && ta <= 1 + ea && tb >= -eb && tb <= 1 + eb) {
    ta = clamp01(ta)
    tb = clamp01(tb)
    const point = lerp(add(a.start, mul(u, ta)), add(b.start, mul(v, tb)), 0.5)
    const atEndA = ta <= ea || ta >= 1 - ea
    const atEndB = tb <= eb || tb >= 1 - eb
    return atEndA || atEndB ? { kind: 'touch', point } : { kind: 'cross', point }
  }

  const [d, p, q] = closestEndpointPair(a, b)
  return d <= tol ? { kind: 'touch', point: lerp(p, q, 0.5) } : null
}

// ─── Pair tests ───────────────────────────────────────────────────────────────

/** Same ring whatever the start vertex and direction. */
function ringsEqual(a: Ring, b: Ring, tol: number): boolean {
  const l = a.points, r = b.points
  if (l.length !== r.length) return false
  const n = r.length
  for (let off = 0; off < n; off++) {
    if (!near(l[0], r[off], tol)) continue
    if (l.every((p, i) => near(p, r[(off + i) % n], tol))) return true
    if (l.every((p, i) => near(p, r[mod(off - i, n)], tol))) return true
  }
  return false
}

function inwardNormal(s: SegRef): Pt2 {
  const d = sub(s.end, s.start)
  const l = len(d)
  const left: Pt2 = [-d[1] / l, d[0] / l]
  return s.area > 0 ? left : [-left[0], -left[1]]
}

function interiorProbe(ring: Ring, tol: number): Pt2 | null {
  const pts = ring.points
  const mean: Pt2 = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]
  if (locate(mean, pts, tol) === 'inside') return mean
  const [x0, y0, x1, y1] = ringBounds(ring)
  const inset = Math.max(tol * 2.1, Math.hypot(x1 - x0, y1 - y0) * 1e-7)
  for (const s of segmentsOf(ring, 0)) {
    const c = add(lerp(s.start, s.end, 0.5), mul(inwardNormal(s), inset))
    if (locate(c, pts, tol) === 'inside') return c
  }
  return null
}

/**
 * Where `points` sit relative to `poly`, judged by the first one off its boundary. Called
 * only once no edge crosses, and then every vertex off the shared spans answers the same.
 */
function firstOffBoundaryLocation(points: readonly Pt2[], poly: readonly Pt2[], tol: number): Location {
  for (const p of points) {
    const loc = locate(p, poly, tol)
    if (loc !== 'boundary') return loc
  }
  return 'boundary'
}

function hasPositiveAreaOverlap(a: Ring, b: Ring, overlapPairs: [SegRef, SegRef][], tol: number): boolean {
  // A coincident span with both interiors on the same side overlaps in area. This also
  // catches containment where every vertex happens to lie on the container's boundary.
  for (const [sa, sb] of overlapPairs) if (dot(inwardNormal(sa), inwardNormal(sb)) > 0) return true

  const la = firstOffBoundaryLocation(a.points, b.points, tol)
  if (la === 'inside') return true
  const lb = firstOffBoundaryLocation(b.points, a.points, tol)
  if (lb === 'inside') return true

  // Every vertex on a boundary — fall back to one verified interior point.
  if (la === 'boundary') {
    const p = interiorProbe(a, tol)
    if (p && locate(p, b.points, tol) === 'inside') return true
  }
  if (lb === 'boundary') {
    const p = interiorProbe(b, tol)
    if (p && locate(p, a.points, tol) === 'inside') return true
  }
  return false
}

// ─── Output assembly ──────────────────────────────────────────────────────────

function uniqueParameters(values: number[], eps: number): number[] {
  const out: number[] = []
  for (const v of [...values].sort((x, y) => x - y)) if (!out.length || Math.abs(v - out[out.length - 1]) > eps) out.push(v)
  if (out.length) { out[0] = 0; out[out.length - 1] = 1 }
  return out
}

function sameUnorderedSegment(a: Atom, b: Atom, tol: number): boolean {
  const t = coincidenceTolerance(tol)
  return (near(a.start, b.start, t) && near(a.end, b.end, t)) || (near(a.start, b.end, t) && near(a.end, b.start, t))
}

function pointOnOutputSegment(p: Pt2, s: CommonLineSegment, tol: number): boolean {
  const v = sub(s.end, s.start)
  const l2 = dot(v, v)
  if (l2 <= numericalEpsilon(tol) ** 2) return near(p, s.start, tol)
  const t = dot(sub(p, s.start), v) / l2
  if (t < -tol || t > 1 + tol) return false
  return dist(p, add(s.start, mul(v, clamp01(t)))) <= tol
}

const canonicalDirection = (a: Pt2, b: Pt2): [Pt2, Pt2] =>
  a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a]

const sameOwners = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

const sourceKey = (s: [string, number]): string => `${s[0]}\u0000${s[1]}`

function mergeSources(...lists: [string, number][][]): [string, number][] {
  const m = new Map<string, [string, number]>()
  for (const l of lists) for (const s of l) m.set(sourceKey(s), s)
  return [...m.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
}

function canMerge(a: CommonLineSegment, b: CommonLineSegment, tol: number): CommonLineSegment | null {
  if (!sameOwners(a.ownerIds, b.ownerIds)) return null
  const candidates: [Pt2, Pt2, Pt2, Pt2][] = [
    [a.end, b.start, a.start, b.end],
    [a.end, b.end, a.start, b.start],
    [a.start, b.start, a.end, b.end],
    [a.start, b.end, a.end, b.start],
  ]
  const t = coincidenceTolerance(tol)
  for (const [sa, sb, oa, ob] of candidates) {
    if (!near(sa, sb, t)) continue
    const va = sub(sa, oa)
    const vb = sub(ob, sb)
    const la = len(va)
    const lb = len(vb)
    if (la > numericalEpsilon(tol) && lb > numericalEpsilon(tol) &&
        Math.abs(cross(mul(va, 1 / la), mul(vb, 1 / lb))) <= angularEpsilon(la, lb, tol)) {
      const [start, end] = canonicalDirection(oa, ob)
      return { start, end, ownerIds: a.ownerIds, sourceSegments: mergeSources(a.sourceSegments, b.sourceSegments) }
    }
  }
  return null
}

function compareStrings(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return a.length - b.length
}

function coalesceShared(segments: CommonLineSegment[], tol: number): CommonLineSegment[] {
  const out = [...segments]
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const merged = canMerge(out[i], out[j], tol)
        if (!merged) continue
        out[i] = merged
        out.splice(j, 1)
        changed = true
        break outer
      }
    }
  }
  return out.sort((a, b) =>
    compareStrings(a.ownerIds, b.ownerIds) ||
    a.start[0] - b.start[0] || a.start[1] - b.start[1] || a.end[0] - b.end[0] || a.end[1] - b.end[1])
}

function dedupeIssues(issues: CommonLineIssue[]): CommonLineIssue[] {
  const seen = new Set<string>()
  const r9 = (v: number) => Math.round(v * 1e9) / 1e9
  return issues.filter((i) => {
    const key = JSON.stringify([i.code, i.contourIds, i.points.map((p) => [r9(p[0]), r9(p[1])])])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ─── The planner ──────────────────────────────────────────────────────────────

/**
 * Split a set of closed, already-compensated cutter centre-lines into the spans each owns
 * alone and the spans two of them share. See the header for what makes a plan invalid —
 * an invalid plan carries no segments at all.
 */
export function planCommonLineCut(contours: Iterable<CommonLineContour>, tolerance = 1e-6): CommonLinePlan {
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError('tolerance must be finite and positive')
  const tol = tolerance

  const issues: CommonLineIssue[] = []
  const rings: Ring[] = []
  const seen = new Set<string>()
  for (const c of contours) {
    const id = c.id.trim()
    if (seen.has(id)) {
      issues.push(issue('invalid_contour', `Contour id ${id} is used twice.`, [id]))
      continue
    }
    seen.add(id)
    const r = normaliseRing(c, tol)
    if ('code' in r) issues.push(r)
    else rings.push(r)
  }
  if (issues.length) return { perimeterSegments: [], sharedSegments: [], touchPoints: [], issues: dedupeIssues(issues), tolerance: tol }

  const allSegs = rings.map((r, i) => segmentsOf(r, i))
  const allSegBounds = allSegs.map((segs) => segs.map(segmentBounds))
  const allRingBounds = rings.map(ringBounds)
  // Split parameters per edge, keyed `${contourIndex},${segmentIndex}`; every edge keeps 0 and 1.
  const cuts = new Map<string, number[]>()
  for (const segs of allSegs) for (const s of segs) cuts.set(`${s.contourIndex},${s.segmentIndex}`, [0, 1])
  const addCut = (s: SegRef, t: number) => cuts.get(`${s.contourIndex},${s.segmentIndex}`)!.push(clamp01(t))
  const touches: Pt2[] = []

  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      const a = rings[i], b = rings[j]
      if (!boundsMayContact(allRingBounds[i], allRingBounds[j], tol)) continue
      if (ringsEqual(a, b, tol)) {
        issues.push(issue('duplicate_contour', `Contours ${a.id} and ${b.id} are duplicates.`, [a.id, b.id]))
        continue
      }
      const crossings: Pt2[] = []
      const overlaps: [SegRef, SegRef][] = []
      for (const [si, sj] of candidateSegmentPairs(allSegBounds[i], allSegBounds[j], tol)) {
        const sa = allSegs[i][si], sb = allSegs[j][sj]
        const rel = segmentRelation(sa, sb, tol)
        if (!rel) continue
        if (rel.kind === 'cross') crossings.push(rel.point)
        else if (rel.kind === 'touch') touches.push(rel.point)
        else {
          overlaps.push([sa, sb])
          addCut(sa, rel.a0); addCut(sa, rel.a1)
          addCut(sb, rel.b0); addCut(sb, rel.b1)
        }
      }
      if (crossings.length) {
        issues.push(issue('crossing', `Contours ${a.id} and ${b.id} cross.`, [a.id, b.id], dedupePoints(crossings, tol)))
      } else if (hasPositiveAreaOverlap(a, b, overlaps, tol)) {
        issues.push(issue('area_overlap', `Contours ${a.id} and ${b.id} overlap.`, [a.id, b.id]))
      }
    }
  }

  // Cut every edge at its split parameters into atoms.
  const atoms: Atom[] = []
  const atomEps = numericalEpsilon(tol)
  for (const segs of allSegs) {
    for (const s of segs) {
      const l = dist(s.start, s.end)
      const params = uniqueParameters(cuts.get(`${s.contourIndex},${s.segmentIndex}`)!, parameterEpsilon(l, tol))
      const v = sub(s.end, s.start)
      for (let k = 0; k + 1 < params.length; k++) {
        const start = add(s.start, mul(v, params[k]))
        const end = add(s.start, mul(v, params[k + 1]))
        if (dist(start, end) <= atomEps) continue
        atoms.push({ start, end, ownerId: s.contourId, source: [s.contourId, s.segmentIndex] })
      }
    }
  }

  // Group atoms that are the same physical span. Each atom is compared only with earlier
  // atoms the broad phase says it can meet.
  const earlier = new Map<number, number[]>()
  for (const [i, j] of candidateSegmentPairs(atoms.map(segmentBounds), undefined, coincidenceTolerance(tol))) {
    if (!earlier.has(j)) earlier.set(j, [])
    earlier.get(j)!.push(i)
  }
  const groups: Atom[][] = []
  const groupOf: number[] = []
  atoms.forEach((atom, ai) => {
    const cands = [...new Set((earlier.get(ai) ?? []).map((e) => groupOf[e]))].sort((x, y) => x - y)
    for (const g of cands) {
      if (sameUnorderedSegment(atom, groups[g][0], tol)) {
        groups[g].push(atom)
        groupOf.push(g)
        return
      }
    }
    groupOf.push(groups.length)
    groups.push([atom])
  })

  const perimeter: CommonLineSegment[] = []
  const shared: CommonLineSegment[] = []
  for (const group of groups) {
    const owners = [...new Set(group.map((a) => a.ownerId))].sort()
    const sources = mergeSources(group.map((a) => a.source))
    const rep = group[0]
    if (owners.length > 2) {
      const [start, end] = canonicalDirection(rep.start, rep.end)
      issues.push(issue('ambiguous_shared_line', `A line is shared by more than two parts: ${owners.join(', ')}.`, owners, [start, end]))
      continue
    }
    if (owners.length === 2) {
      const [start, end] = canonicalDirection(rep.start, rep.end)
      shared.push({ start, end, ownerIds: owners, sourceSegments: sources })
    } else {
      perimeter.push({ start: rep.start, end: rep.end, ownerIds: owners, sourceSegments: sources })
    }
  }

  const finalIssues = dedupeIssues(issues)
  const touchPoints = dedupePoints(touches, tol)
  if (finalIssues.length) return { perimeterSegments: [], sharedSegments: [], touchPoints, issues: finalIssues, tolerance: tol }
  const sharedSegments = coalesceShared(shared, tol)
  return {
    perimeterSegments: perimeter,
    sharedSegments,
    touchPoints: touchPoints.filter((p) => !sharedSegments.some((s) => pointOnOutputSegment(p, s, tol))),
    issues: [],
    tolerance: tol,
  }
}
