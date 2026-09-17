// Shared pocket-clearing infrastructure: params/types, the sub-stage profiler,
// polygon offset helpers, travel-safety tests, ramp/helix entry emission,
// offset-level building and contour-ring linking. Imported by every strategy
// module under this directory; the public entry point is ../pocket.ts.
import {  signedArea, ensureWinding, douglasPeucker, type Pt2 } from '../pathFlattener'
import { perfLog } from '../../debug'
import { inflatePathsD, differenceD, intersectD, JoinType, EndType, FillRule } from 'clipper2-ts'
import {  arcLengths, interpPt, stripClosingDuplicate, pointInPolygon, pointOnRing, ptSegDistSq } from '../geom'
import type { ClearanceField } from './clearance'
import type { MotionSegment } from '../../store/toolpathStore'
import type {  CuttingDirection, Tool } from '../../store/toolStore'

// 'morph' is the field-based curvilinear spiral (Poisson isotherms, helix entry — cf.
// Fusion's "Morphed Spiral") — best for chunky pockets and islands.
// 'adaptive' is the FreeCAD Adaptive2d port (slow on large pockets, kept intact);
// 'adaptive2' is the fast raster-marching constant-engagement engine (./adaptive2);
// 'hybrid' is that same engine clearing the open core with raster passes first, so the
// march only pays its steering cost near walls and in tight regions.
// Dropped 2026-07: the offset-ring spiral ('spiral', earlier 'spiralOffset'), which left
// stock even at 50% stepover. generatePocket regenerates those operations as 'morph', and
// project load rewrites the stored id — see loadProject.
export type PocketStrategy = 'raster' | 'contour' | 'adaptive' | 'morph' | 'adaptive2' | 'hybrid'

export interface PocketParams {
  /** Run the chosen strategy even where it would normally decline the shape as a poor fit
   *  (see REDUNDANCY_LIMIT in fieldSpiral). Set by an explicit user gesture — alt-clicking
   *  Generate — never by default: the whole point of declining is that the path it would
   *  have produced is one nobody would run. */
  forceStrategy?: boolean
  strategy?: PocketStrategy
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  direction: CuttingDirection
  islandDs: string[]
  angle: number
  /**
   * Let the strategy choose the raster pass angle instead of using `angle`. Only 'hybrid'
   * honours it — it picks, per sub-area, the angle that makes the passes longest. Default
   * (undefined) is auto; false pins the angle to `angle`.
   */
  autoAngle?: boolean
  startNear?: { x: number; y: number }
  rampIn?: boolean
  safeHeightMM?: number
  // Surface the cut starts from (0 = stock top, negative = the floor an earlier op left).
  // depthMM is measured from here, and the first pass ramps/plunges from here.
  startZMM?: number
  // Finish allowance: stock left on every wall. Positive insets the boundary and grows
  // islands (leaves stock for a finish pass); negative does the reverse and grows the
  // pocket. Applied per resolved sub-ring, so self-intersecting boundaries keep all
  // their regions. Inlay sockets pass −clearanceMM here instead of pre-offsetting the
  // (possibly self-intersecting) path, which would merge its loops.
  finishAllowanceMM?: number
}

export interface TravelSafetyObstacles {
  /**
   * The answer, when the caller can supply one: the DRAWN geometry plus the clearance the
   * tool centre must keep from it. When present every ring set below is ignored — see
   * ./clearance.ts for why that is not merely faster but a different question, and for the
   * six bugs that came out of asking the ring sets instead. A strategy that has its
   * boundary and islands to hand should set this; the rest still go the old way.
   */
  field?: { field: ClearanceField; clearanceMM: number }
  edgeObstacles: Pt2[][]
  solidObstacles?: Pt2[][]
  /** The move must stay INSIDE at least one of these — the tool-centre allowed region.
   *  Without it a move can start and end exactly ON a boundary and pass outside in
   *  between: every crossing is then at an endpoint, and the edge test skips those (ring
   *  entry/exit points legitimately sit on the boundary), so it reports the move safe.
   *  That is how a link across the inner corner of an L-shaped pocket gouged the corner
   *  while both of its endpoints were legal ring positions. */
  containment?: Pt2[][]
}

// ─── The plan/emit contract ────────────────────────────────────────────────────
//
// A pocket's geometry does not change with depth: the same 2D path is cut at every Z
// level. Strategies therefore split in two — a PLANNER that resolves all the geometry
// once per boundary, and an emitter that replays it at each depth. Before this split
// every strategy was called once per level and rebuilt its offsets, finishing rings and
// rest-detection from scratch each time (~95% of contour's runtime was rest detection,
// recomputed to produce a bit-identical result), and the two strategies that could not
// afford that — morph and adaptive2 — worked around it with module-level caches keyed
// by a hand-rolled geometry hash. Both caches are gone with the split; so is the chance
// of a hash collision emitting the wrong toolpath.
//
// generatePocket owns the common tail: rest cleanup then the wall/island finishing
// contours, at every level, for every strategy.

export interface PocketPlan {
  /** Emit this strategy's roughing cuts for one depth level; returns the ending XY. */
  emitCuts(z: number, prevZ: number, incomingPos: Pt2 | null, segs: MotionSegment[]): Pt2 | null
  /** Wall + island finishing contours, cut last at each level by generatePocket. */
  finishRings: Pt2[][]
  /** Obstacles for the rest/finishing link-safety tests. */
  travelObstacles: TravelSafetyObstacles
  /** Set when the strategy emits its own wall pass and needs no shared tail. */
  selfFinishing?: boolean
}

export type PocketPlanner = (
  boundary: Pt2[],
  islands: Pt2[][],
  tool: Tool,
  params: PocketParams,
  /** Optional 0→1 progress for the planning stage; the slow strategies drive it. */
  onProgress?: (frac: number, label?: string) => void,
) => PocketPlan | null

export const MICRO_LIFT_MM = 0.5

// ─── temporary sub-stage profiling (remove once pocket perf work is done) ────────
// Accumulates wall-clock time per named stage across one generatePocket call.
export const _perf = new Map<string, number>()
export function _timed<T>(stage: string, fn: () => T): T {
  const t = performance.now()
  try { return fn() } finally { _perf.set(stage, (_perf.get(stage) ?? 0) + (performance.now() - t)) }
}
export function _perfReset() { _perf.clear() }
export function _perfLog(label: string) {
  if (_perf.size === 0) return
  const parts = [..._perf.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}ms`)
  perfLog(`[perf] pocket/${label} substages: ${parts.join(' | ')}`)
}
// ─── Shared utilities ──────────────────────────────────────────────────────────

export function pointOnSegment(p: Pt2, a: Pt2, b: Pt2, eps = 1e-6): boolean {
  const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])
  if (Math.abs(cross) > eps) return false
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])
  if (dot < -eps) return false
  const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
  return dot <= lenSq + eps
}

export function segmentEdgeIntersectionParams(a: Pt2, b: Pt2, c: Pt2, d: Pt2): number[] {
  const r: Pt2 = [b[0] - a[0], b[1] - a[1]]
  const s: Pt2 = [d[0] - c[0], d[1] - c[1]]
  const denom = r[0] * s[1] - r[1] * s[0]
  const qmp: Pt2 = [c[0] - a[0], c[1] - a[1]]
  const eps = 1e-8

  if (Math.abs(denom) > eps) {
    const t = (qmp[0] * s[1] - qmp[1] * s[0]) / denom
    const u = (qmp[0] * r[1] - qmp[1] * r[0]) / denom
    return t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps
      ? [Math.max(0, Math.min(1, t))]
      : []
  }

  const collinear = Math.abs(qmp[0] * r[1] - qmp[1] * r[0]) <= eps
  if (!collinear) return []

  const lenSq = r[0] ** 2 + r[1] ** 2
  if (lenSq <= eps) return []
  const t0 = ((c[0] - a[0]) * r[0] + (c[1] - a[1]) * r[1]) / lenSq
  const t1 = ((d[0] - a[0]) * r[0] + (d[1] - a[1]) * r[1]) / lenSq
  const lo = Math.max(0, Math.min(t0, t1))
  const hi = Math.min(1, Math.max(t0, t1))
  return lo <= hi + eps ? [lo, hi] : []
}

export function addUniqueParam(params: number[], t: number) {
  if (t <= 1e-6 || t >= 1 - 1e-6) return
  if (!params.some(existing => Math.abs(existing - t) < 1e-5)) params.push(t)
}

export function transitionCrossesPolygonEdge(from: Pt2, to: Pt2, poly: Pt2[]): boolean {
  const tDX = to[0] - from[0], tDY = to[1] - from[1]
  const ftMinX = Math.min(from[0], to[0])
  const ftMaxX = Math.max(from[0], to[0])
  const ftMinY = Math.min(from[1], to[1])
  const ftMaxY = Math.max(from[1], to[1])
  for (let i = 0; i < poly.length; i++) {
    const edgeStart = poly[i]
    const edgeEnd = poly[(i + 1) % poly.length]
    // Reject edges whose bounding box can't overlap the travel segment's bounding box.
    if (Math.max(edgeStart[0], edgeEnd[0]) < ftMinX ||
        Math.min(edgeStart[0], edgeEnd[0]) > ftMaxX ||
        Math.max(edgeStart[1], edgeEnd[1]) < ftMinY ||
        Math.min(edgeStart[1], edgeEnd[1]) > ftMaxY) continue
    // Skip collinear/parallel edges: travel along (or parallel to) an edge is not a
    // transversal crossing — collinear slides along a boundary are always safe.
    const eDX = edgeEnd[0] - edgeStart[0], eDY = edgeEnd[1] - edgeStart[1]
    if (Math.abs(tDX * eDY - tDY * eDX) < 1e-8) continue
    for (const t of segmentEdgeIntersectionParams(from, to, edgeStart, edgeEnd)) {
      if (t <= 1e-6 || t >= 1 - 1e-6) continue
      const p: Pt2 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
      if (pointOnSegment(p, edgeStart, edgeEnd)) return true
    }
  }
  return false
}

export function transitionEntersSolidPolygon(from: Pt2, to: Pt2, poly: Pt2[]): boolean {
  const ftMinX = Math.min(from[0], to[0])
  const ftMaxX = Math.max(from[0], to[0])
  const ftMinY = Math.min(from[1], to[1])
  const ftMaxY = Math.max(from[1], to[1])
  const params = [0, 1]
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    if (Math.max(a[0], b[0]) < ftMinX ||
        Math.min(a[0], b[0]) > ftMaxX ||
        Math.max(a[1], b[1]) < ftMinY ||
        Math.min(a[1], b[1]) > ftMaxY) continue
    for (const t of segmentEdgeIntersectionParams(from, to, a, b)) {
      addUniqueParam(params, t)
    }
  }
  params.sort((a, b) => a - b)

  for (let i = 0; i + 1 < params.length; i++) {
    const lo = params[i], hi = params[i + 1]
    if (hi - lo < 1e-5) continue
    const t = (lo + hi) / 2
    const p: Pt2 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
    // withinForbidden, not pointInPolygon: a move that runs ALONG this island's flank has
    // every midpoint exactly on the ring, and the half-open rule calls that solid material
    // on the left flank and open air on the right. See "Where the boundary belongs".
    if (withinForbidden(p[0], p[1], poly)) return true
  }
  return false
}

// Whole-ring bounding box, memoised on the ring array itself. The obstacle sets handed to
// isTravelSafe are rebuilt once per plan and then queried tens of thousands of times, so
// the box is computed once per ring and reused for every query against it.
const ringBBoxCache = new WeakMap<Pt2[], [number, number, number, number]>()
function ringBBox(poly: Pt2[]): [number, number, number, number] {
  const hit = ringBBoxCache.get(poly)
  if (hit) return hit
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < poly.length; i++) {
    const [x, y] = poly[i]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const box: [number, number, number, number] = [minX, minY, maxX, maxY]
  ringBBoxCache.set(poly, box)
  return box
}

// How finely a pocket's boundary and islands are flattened to polylines (mm). Named
// because it is not just an import detail: it is the accuracy of every ring downstream, and
// therefore the size of the discrepancies the travel-safety tests have to tolerate. A link
// between two points on a ring flattened this coarsely cuts across the vertices between
// them by up to this much — see LINK_MARGIN_MM in raster.ts, which is derived from it.
export const POCKET_FLATTEN_TOL_MM = 0.05

// ─── Where the boundary belongs ────────────────────────────────────────────────
//
// Every ring in this file is a TOOL-CENTRE LIMIT, and a limit is REACHABLE: the centre may
// stand exactly on the inset wall or exactly on a grown island, because that is where it
// stands while cutting them. The raster relies on it — scanlines are built by INTERSECTING
// those rings, so a stepover at a wall or beside an island is collinear with one by
// construction, and virtually every travel it proposes lies exactly on a boundary.
//
// `pointInPolygon` cannot express that on its own. Its half-open crossing rule answers an
// on-outline point by WHICH SIDE of the shape it is, so a rectangle's left wall reads
// inside and its right wall reads outside — and the same is true of an island, whose left
// flank then reads as solid material. Getting it wrong never moves the cut: it makes the
// SAME move legal at one wall and illegal at the other, and the tool lifts, rapids one
// stepover and plunges for nothing. Three separate predicates had it wrong, each showing up
// as a different shape that "still lifts", which is why this is stated once here instead of
// at the call sites.
//
// So: the boundary belongs to the ALLOWED side, always. Inside a region the tool must stay
// within, outside a region it must stay out of.

// The slack allowed in "on". A floating-point equality tolerance, NOT a geometric
// allowance — rotating a point into the raster's scanline-aligned frame and back costs a
// few ulps (a wall at x = 13 comes back as 12.999999999999998) and that is the entire
// quantity being absorbed. Widen it into a real allowance and it starts admitting
// excursions past the tool-centre limit, which is a gouge.
const RING_EPS_MM = 1e-6

/** Inside a region the tool must stay WITHIN — on the ring counts as in. */
function withinAllowed(x: number, y: number, ring: Pt2[]): boolean {
  return pointInPolygon(x, y, ring) || pointOnRing(x, y, ring, RING_EPS_MM)
}

/** Inside a region the tool must stay OUT of — on the ring counts as out. */
function withinForbidden(x: number, y: number, ring: Pt2[]): boolean {
  return pointInPolygon(x, y, ring) && !pointOnRing(x, y, ring, RING_EPS_MM)
}

// Scratch for the containment scan in isTravelSafe — see the comment at its use. Grows to
// the largest containment set seen and is then reused; entries past `liveCount` are stale
// and never read.
const liveScratch: Pt2[][] = []

export function isTravelSafe(from: Pt2, to: Pt2, obstacles: TravelSafetyObstacles): boolean {
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1e-6) return true

  // One exact inequality against the drawn geometry, when the caller gave us that.
  // Everything below is the older approximation of the same question.
  if (obstacles.field) return obstacles.field.field.isClear(from, to, obstacles.field.clearanceMM)

  // Most travel moves are one stepover long and most obstacles are islands metres away
  // from them. Rejecting such a ring by its own box costs four comparisons instead of a
  // walk over every one of its edges; the per-edge box test inside the two predicates
  // below only ever saw the ring after that walk had already started.
  //
  // Slack by RING_EPS_MM, because a move that runs ALONG a ring has a degenerate box lying
  // exactly on that ring's own — and a few ulps the wrong way then rejected the one ring
  // that contained it, leaving the containment scan with nothing live and reporting a
  // stepover down a wall unsafe. Erring inclusive is the safe direction both ways round:
  // an extra edge/solid ring can only find more crossings, and an extra containment ring
  // still has to pass the exact test below.
  const mnX = Math.min(from[0], to[0]) - RING_EPS_MM, mxX = Math.max(from[0], to[0]) + RING_EPS_MM
  const mnY = Math.min(from[1], to[1]) - RING_EPS_MM, mxY = Math.max(from[1], to[1]) + RING_EPS_MM
  const misses = (poly: Pt2[]): boolean => {
    const [bx0, by0, bx1, by1] = ringBBox(poly)
    return bx1 < mnX || bx0 > mxX || by1 < mnY || by0 > mxY
  }

  for (const poly of obstacles.edgeObstacles) {
    if (misses(poly)) continue
    if (transitionCrossesPolygonEdge(from, to, poly)) return false
  }

  for (const poly of obstacles.solidObstacles ?? []) {
    // A segment lying wholly inside a ring still has its box inside the ring's box, so
    // this rejects only rings the segment cannot touch at all.
    if (misses(poly)) continue
    if (transitionEntersSolidPolygon(from, to, poly)) return false
  }

  // Sampled containment test — see TravelSafetyObstacles.containment. Sampling (rather
  // than an exact clip) is enough because it backs up the exact edge-crossing test above:
  // the only thing it has to catch is an excursion whose crossings all sit at the
  // endpoints, and such an excursion spans a large fraction of the move.
  const containment = obstacles.containment
  if (containment && containment.length > 0) {
    // Only rings whose box overlaps the move can contain any of its sample points, so the
    // per-sample scan runs over those instead of over every finishing ring in the pocket.
    // The overlapping set is gathered ONCE per call (the box test is a WeakMap lookup, so
    // re-testing it per sample would cost more than it saves) into a scratch array reused
    // across calls — this is the hottest function in the module, tens of thousands of
    // calls per plan, and that array was its only allocation. Safe to share: there is no
    // await and no reentry between filling it and finishing with it.
    let liveCount = 0
    for (let i = 0; i < containment.length; i++) {
      const poly = containment[i]
      if (!misses(poly)) liveScratch[liveCount++] = poly
    }
    if (liveCount === 0) return false
    const N = 8
    for (let k = 1; k < N; k++) {
      const t = k / N
      const x = from[0] + (to[0] - from[0]) * t
      const y = from[1] + (to[1] - from[1]) * t
      // withinAllowed is the rule (see "Where the boundary belongs"), but it is applied in
      // two passes, not once per ring: this is the hottest loop in the module, and the
      // cheap half settles almost every sample. Only a sample that no ring plainly
      // contains pays for the ring walks — which, before this, was every sample of every
      // stepover run down a wall or past an island.
      let inside = false
      for (let i = 0; i < liveCount; i++) {
        if (pointInPolygon(x, y, liveScratch[i])) { inside = true; break }
      }
      if (!inside) {
        for (let i = 0; i < liveCount; i++) {
          if (withinAllowed(x, y, liveScratch[i])) { inside = true; break }
        }
      }
      if (!inside) return false
    }
  }

  return true
}

export function offsetRing(pts: Pt2[], delta: number, joinType: JoinType = JoinType.Miter): Pt2[] {
  const clean = stripClosingDuplicate(pts)
  if (clean.length < 3) return []
  const ccw = signedArea(clean) >= 0 ? clean : [...clean].reverse()
  const result = inflatePathsD(
    [ccw.map(([x, y]) => ({ x, y }))],
    delta, joinType, EndType.Polygon, 4, 6,
  )
  if (result.length === 0) return []
  const best = result.reduce((a, b) => (b.length > a.length ? b : a))
  return stripClosingDuplicate(best.map(({ x, y }) => [x, y] as Pt2))
}

// Shrink polygon inward by delta. Returns [] if it collapses or inverts.
//
// The join type matters when the result is used as a legal tool-centre region. At a
// REFLEX vertex of the pocket (an inner corner, e.g. the step of an L) the true limit
// for the tool centre is an arc of the tool radius around that vertex — the tool rolls
// around the corner. A MITER join replaces that arc with a sharp spike reaching past it,
// so a tool centre placed on the spike gouges the corner. Pass JoinType.Round wherever
// the offset is a keep-out the toolpath is clamped or snapped onto.
export function insetRing(pts: Pt2[], delta: number, joinType: JoinType = JoinType.Miter): Pt2[] {
  const origArea = Math.abs(signedArea(pts))
  const result = offsetRing(pts, -delta, joinType)
  if (result.length < 3) return []
  if (Math.abs(signedArea(result)) >= origArea) return []
  return result
}

export function growRing(pts: Pt2[], delta: number): Pt2[] {
  return offsetRing(pts, delta)
}

// Offset multiple island rings together as a compound shape. This is important
// for sub-rings produced by splitSelfIntersecting (e.g. a figure-8 island) —
// offsetting them as a unit avoids miter spikes at shared crossing vertices that
// would otherwise make the finishing contour cut through the original island.
export function growIslands(islands: Pt2[][], delta: number, joinType: JoinType = JoinType.Miter): Pt2[][] {
  if (islands.length === 0) return []
  const result = inflatePathsD(
    islands.map(isl => {
      const clean = stripClosingDuplicate(isl)
      const ccw = signedArea(clean) >= 0 ? clean : [...clean].reverse()
      return ccw.map(([x, y]) => ({ x, y }))
    }),
    delta, joinType, EndType.Polygon, 4, 6,
  )
  return result
    .map(r => stripClosingDuplicate(r.map(({ x, y }) => [x, y] as Pt2)))
    .filter(r => r.length >= 3)
}

// Finishing contours for a pocket with islands: ONE compound inset — boundary ⊖ R with
// the islands as CW holes — so an island closer than a tool diameter to the outer wall
// (or to another island) pinches/merges into a contour that never swings the tool centre
// past a wall. Growing island rings independently of the boundary gouges the outer wall
// in exactly that case. Output: outer-type loops wound to `wantCCW`, island (hole-type)
// loops wound opposite, so climb stays climb on island walls (material is on the inside
// of an island ring, so the traversal direction must flip to keep the same chip formation).
export function compoundFinishRings(
  boundary: Pt2[],
  islands: Pt2[][],
  toolRadius: number,
  wantCCW: boolean,
  joinType: JoinType = JoinType.Miter,
): Pt2[][] {
  const toCP = (pts: Pt2[], ccw: boolean) =>
    ensureWinding(stripClosingDuplicate(pts), ccw).map(([x, y]) => ({ x, y }))
  return inflatePathsD(
    [toCP(boundary, true), ...islands.map(isl => toCP(isl, false))],
    -toolRadius, joinType, EndType.Polygon, 4, 6,
  )
    .map(r => stripClosingDuplicate(r.map(({ x, y }) => [x, y] as Pt2)))
    .filter(r => r.length >= 3)
    .map(r => ensureWinding(r, signedArea(r) < 0 ? !wantCCW : wantCCW))
}

export function emitCutTransition(
  segs: MotionSegment[],
  from: Pt2,
  to: Pt2,
  z: number,
  toolDiameterMM: number,
  safeZ: number,
) {
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1])
  if (dist > toolDiameterMM * 2) {
    const liftZ = Math.min(safeZ, z + MICRO_LIFT_MM)
    segs.push({ x: from[0], y: from[1], z: liftZ, rapid: false, travel: true })
    segs.push({ x: to[0], y: to[1], z: liftZ, rapid: false, travel: true })
    segs.push({ x: to[0], y: to[1], z, rapid: false })
  } else {
    segs.push({ x: to[0], y: to[1], z, rapid: false })
  }
}

export function centroidOfRing(pts: Pt2[]): Pt2 {
  let area2 = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    const cross = x0 * y1 - x1 * y0
    area2 += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (Math.abs(area2) < 1e-8) {
    const sum = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as Pt2, [0, 0])
    return [sum[0] / pts.length, sum[1] / pts.length]
  }
  return [cx / (3 * area2), cy / (3 * area2)]
}

export function emitHelicalRamp(
  center: Pt2,
  radius: number,
  fromZ: number,
  toZ: number,
  wantCCW: boolean,
  segs: MotionSegment[],
  safeZ = 5,
): Pt2 {
  const turns = Math.max(1, Math.ceil(Math.abs(toZ - fromZ) / 1.5))
  const stepsPerTurn = 28
  const totalSteps = turns * stepsPerTurn
  const dir = wantCCW ? 1 : -1
  const start: Pt2 = [center[0] + radius, center[1]]

  segs.push({ x: start[0], y: start[1], z: safeZ, rapid: true })
  segs.push({ x: start[0], y: start[1], z: fromZ, rapid: true })

  let last: Pt2 = start
  for (let i = 1; i <= totalSteps; i++) {
    const t = i / totalSteps
    const a = dir * t * turns * 2 * Math.PI
    last = [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]
    segs.push({ x: last[0], y: last[1], z: fromZ + (toZ - fromZ) * t, rapid: false, feedScale: 0.45 })
  }

  return last
}

// Descend a helical bore about `center` (tool-centre radius `radius`), finishing at
// `endAngle` on the circle at `toZ`. Integer turns ⇒ the plunge point is also at
// `endAngle`, so the bore is a clean circle entered and exited at the same place; the
// full revolutions clear the disk of radius radius+toolRadius. A final FLAT revolution
// at `toZ` removes the spiral ramp the descent leaves on the floor (each angle bottoms
// out at a different Z, so without it the bored centre isn't flat). Returns the end point.
export function emitHelixBore(
  center: Pt2,
  radius: number,
  endAngle: number,
  fromZ: number,
  toZ: number,
  wantCCW: boolean,
  segs: MotionSegment[],
  safeZ = 5,
): Pt2 {
  const dir = wantCCW ? 1 : -1
  const stepsPerTurn = 28
  const turns = Math.max(1, Math.ceil(Math.abs(toZ - fromZ) / 1.5))
  const totalSteps = turns * stepsPerTurn
  const pt = (a: number): Pt2 => [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]
  const startPt = pt(endAngle)
  segs.push({ x: startPt[0], y: startPt[1], z: safeZ, rapid: true })
  segs.push({ x: startPt[0], y: startPt[1], z: fromZ, rapid: true })
  let last = startPt
  for (let i = 1; i <= totalSteps; i++) {
    const t = i / totalSteps
    last = pt(endAngle - dir * (1 - t) * turns * 2 * Math.PI)
    segs.push({ x: last[0], y: last[1], z: fromZ + (toZ - fromZ) * t, rapid: false, feedScale: 0.45 })
  }
  // Flat finishing revolution at full depth: levels the helical ramp groove so the bored
  // floor is flat before the spiral takes over. Full 2π back to `endAngle`.
  for (let i = 1; i <= stepsPerTurn; i++) {
    last = pt(endAngle - dir * (1 - i / stepsPerTurn) * 2 * Math.PI)
    segs.push({ x: last[0], y: last[1], z: toZ, rapid: false, feedScale: 0.45 })
  }
  return last
}

// First spiral index whose tool pass removes material the helix bore didn't already
// clear. A helix of tool-centre radius `hr` about `center` clears a solid disk of
// radius hr+toolRadius (hr ≤ toolRadius), so a spiral point only cuts new stock once
// its centre exceeds hr from `center`. The morph's seeded-centre turn hugs the bore for
// a whole revolution (centre-distance ≈ hr with small numerical wobble), so we walk the
// CONTIGUOUS leading run within hr+margin and stop at the first point that escapes it —
// only the leading run, so a spiral that later loops back near the centre (around an
// island) is never skipped. The margin absorbs the wobble; whatever is skipped leaves
// at most `margin` of stock at the bore edge (negligible, within tolerance).
export function firstUncutSpiralIndex(spiral: Pt2[], center: Pt2, hr: number): number {
  const band = hr + 0.1
  let k = 1
  while (k < spiral.length - 1 &&
         Math.hypot(spiral[k][0] - center[0], spiral[k][1] - center[1]) <= band) k++
  return k
}

// Integrated helix entry for a centre-seeded spiral, bored CONCENTRIC with the spiral's
// innermost loop: `center` is that loop's centroid. The bore (radius `hr`) clears the
// middle; the descent ends at the angle of the first point the bore didn't already clear,
// so — because the spiral winds concentrically about `center` — the helix and the spiral
// share a tangent there and join cleanly, with the whole redundant inner turn skipped and
// no offset/backtrack. Returns that cut-start index; the caller cuts `spiral` from it on.
export function emitSpiralHelixEntry(
  spiral: Pt2[],
  center: Pt2,
  hr: number,
  fromZ: number,
  toZ: number,
  wantCCW: boolean,
  segs: MotionSegment[],
  safeZ: number,
): number {
  const cutFrom = firstUncutSpiralIndex(spiral, center, hr)
  const join = spiral[cutFrom]
  const endAngle = Math.atan2(join[1] - center[1], join[0] - center[0])
  emitHelixBore(center, hr, endAngle, fromZ, toZ, wantCCW, segs, safeZ)
  return cutFrom
}

// ─── Linear ramp lead-in (shared by every strategy) ──────────────────────────────
//
// A ramp lead-in descends the tool from prevZ to zDepth while moving along a portion
// of the geometry that is (or will be) cut at full depth, so the ramp groove is left
// clean. The lead-in is min(rampDistMM, total*0.45) long and always ENDS at the cut
// start point. Two flavours:
//   open=true  → the first window of an open path (spiral / scanline), traversed
//                backward so it ends at geom[0].
//   open=false → the final window of a closed ring, approaching its start vertex.
// `sampleAt(t)` gives the XY position at descent fraction t (t=0 touchdown, t=1 start).
export function rampLeadIn(
  geom: Pt2[],
  open: boolean,
  rampDistMM: number,
): { touchdown: Pt2; sampleAt: (t: number) => Pt2 } {
  if (open) {
    const { lens, total } = arcLengths(geom)
    const rampDist = Math.min(rampDistMM, total * 0.45)
    return {
      touchdown: interpPt(geom, lens, rampDist),
      sampleAt: (t: number) => interpPt(geom, lens, rampDist * (1 - t)),
    }
  }
  const closed: Pt2[] = [...geom, geom[0]]
  const { lens, total } = arcLengths(closed)
  const rampDist = Math.min(rampDistMM, total * 0.45)
  const rampStartS = total - rampDist
  return {
    touchdown: interpPt(closed, lens, rampStartS),
    sampleAt: (t: number) => interpPt(closed, lens, rampStartS + t * rampDist),
  }
}

// The inner ramp descent: the tool is already positioned at the touchdown point at
// `prevZ`; step down to `zDepth` over `steps` increments at reduced feed, tracing the
// lead-in via `sampleAt`. Ends at (cut start, zDepth). The lift/plunge that gets the
// tool to the touchdown point stays at each call site (it varies per strategy).
export function emitRampDescent(
  segs: MotionSegment[],
  sampleAt: (t: number) => Pt2,
  prevZ: number,
  zDepth: number,
  steps: number,
  feedScale = 0.5,
): void {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const p = sampleAt(t)
    segs.push({ x: p[0], y: p[1], z: prevZ + (zDepth - prevZ) * t, rapid: false, feedScale })
  }
}

// ─── Contour utilities ─────────────────────────────────────────────────────────

export function rotateRingAt(pts: Pt2[], index: number): Pt2[] {
  return index === 0 ? pts : [...pts.slice(index), ...pts.slice(0, index)]
}



export type RingContainment = {
  /** parent[i] = index of the smallest ring that strictly contains ring i, or -1. */
  parent: number[]
  /** pendingInside[i] = number of not-yet-emitted rings lying inside ring i. */
  pendingInside: number[]
}

/** True when every sampled vertex of `inner` lies inside `outer`. Rings from a nested
 *  offset family never cross, so a few samples settle containment. */
function ringInsideRing(inner: Pt2[], outer: Pt2[]): boolean {
  let hits = 0
  const samples = Math.min(3, inner.length)
  for (let s = 0; s < samples; s++) {
    const v = inner[Math.floor((s * inner.length) / samples)]
    if (pointInPolygon(v[0], v[1], outer)) hits++
  }
  return hits * 2 > samples
}

// Nesting forest of a set of non-intersecting rings, so a caller can cut them
// innermost-first PER REGION: a ring is only safe to cut once every ring inside it is
// already cut. Without that gate a proximity walk can open an outer ring of a region
// whose middle is still solid — a full-width slot instead of a stepover-wide pass.
export function buildRingContainment(rings: Pt2[][]): RingContainment {
  const n = rings.length
  const areas = rings.map(r => Math.abs(signedArea(r)))
  const boxes = rings.map(r => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of r) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
    return [x0, y0, x1, y1] as const
  })
  // Smallest ring first: the first larger ring that contains it is its immediate parent,
  // and a parent always has a strictly later position here, so the forest is acyclic.
  const order = rings.map((_, i) => i).sort((a, b) => areas[a] - areas[b])
  const parent = new Array<number>(n).fill(-1)
  const EPS = 1e-6

  for (let oi = 0; oi < n; oi++) {
    const i = order[oi]
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj]
      const a = boxes[i], b = boxes[j]
      if (a[0] < b[0] - EPS || a[1] < b[1] - EPS || a[2] > b[2] + EPS || a[3] > b[3] + EPS) continue
      if (ringInsideRing(rings[i], rings[j])) { parent[i] = j; break }
    }
  }

  const pendingInside = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let p = parent[i]; p !== -1; p = parent[p]) pendingInside[p]++
  }
  return { parent, pendingInside }
}

// Post-order walk of the containment forest. Keep cutting OUTWARD from the ring just
// finished — its parent — as long as that parent's interior is fully cleared. The moment it
// isn't (the parent also encloses an uncut branch, i.e. the current region is exhausted at a
// medial-axis merge), drop back to the innermost ring still pending: `pendingIdx` is ordered
// innermost-offset-level first, so the first entry with a cleared interior IS that ring — the
// next medial-axis junction. An outer ring is never cut while it contains an uncut ring.
// `jumped` marks the drop-back: the tool leaves the cleared chain it was walking and lands on
// a ring whose surroundings are still solid, so the link has to go over the top — only the
// outward step into a parent is safe to travel at depth.
function nextContainmentRing(
  c: RingContainment,
  pendingIdx: number[],
  lastRingIdx: number,
): { index: number; jumped: boolean } {
  if (lastRingIdx >= 0) {
    const parent = c.parent[lastRingIdx]
    if (parent !== -1 && c.pendingInside[parent] === 0 && pendingIdx.includes(parent)) {
      return { index: parent, jumped: false }
    }
  }
  for (const i of pendingIdx) if (c.pendingInside[i] === 0) return { index: i, jumped: true }
  // No leaf left only if the forest is malformed; keeps the loop finite.
  return { index: pendingIdx[0], jumped: true }
}

// ─── Ring entry: where a lap starts, in ARC LENGTH along the ring ────────────────
//
// Everything here works in arc length rather than in vertex indices. Vertex indices make
// the entry as coarse as the ring's own geometry, and an offset ring of a rectangular
// pocket has FOUR vertices: the nearest "vertex" to the tool is a corner up to half a
// side away — often behind it — and the smallest "downstream" step available was a whole
// 89 mm side. Both flaws pushed the entry far past what planRingLink will travel at
// depth, so every ring of a square or rectangular pocket got a lift instead of a link.

/** Cumulative arc length at each vertex (cum[i] = length from ring[0] to ring[i]), + total. */
function ringArc(ring: Pt2[]): { cum: number[]; total: number } {
  const cum = new Array<number>(ring.length)
  let acc = 0
  for (let i = 0; i < ring.length; i++) {
    cum[i] = acc
    const j = (i + 1) % ring.length
    acc += Math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1])
  }
  return { cum, total: acc }
}

/** The edge index and fraction along it at arc length `s` (wrapping). */
function arcToEdge(ring: Pt2[], cum: number[], total: number, s: number): { idx: number; t: number } {
  const n = ring.length
  if (total <= 1e-12) return { idx: 0, t: 0 }
  let u = s % total
  if (u < 0) u += total
  // cum is ascending: find the last vertex at or before u.
  let lo = 0, hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cum[mid] <= u) lo = mid
    else hi = mid - 1
  }
  const j = (lo + 1) % n
  const len = Math.hypot(ring[j][0] - ring[lo][0], ring[j][1] - ring[lo][1])
  return { idx: lo, t: len > 1e-12 ? Math.max(0, Math.min(1, (u - cum[lo]) / len)) : 0 }
}

function ringPointAtArc(ring: Pt2[], cum: number[], total: number, s: number): Pt2 {
  const { idx, t } = arcToEdge(ring, cum, total, s)
  const j = (idx + 1) % ring.length
  return [ring[idx][0] + (ring[j][0] - ring[idx][0]) * t, ring[idx][1] + (ring[j][1] - ring[idx][1]) * t]
}

/** Arc length of the closest point on the ring to (px,py) — projected onto the EDGES, not
 *  snapped to a vertex. */
function nearestArcOnRing(ring: Pt2[], cum: number[], px: number, py: number): number {
  let bestS = 0
  let bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length
    const ax = ring[i][0], ay = ring[i][1]
    const dx = ring[j][0] - ax, dy = ring[j][1] - ay
    const l2 = dx * dx + dy * dy
    let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const qx = ax + t * dx, qy = ay + t * dy
    const d = (px - qx) ** 2 + (py - qy) ** 2
    if (d < bestD) { bestD = d; bestS = cum[i] + t * Math.sqrt(l2) }
  }
  return bestS
}

/** `ring` rotated to begin at arc length `s`, SPLITTING the edge when `s` lands mid-edge.
 *  Every original vertex is kept, so the lap still traces the same closed path — only
 *  where it begins moves. */
function ringStartingAtArc(ring: Pt2[], cum: number[], total: number, s: number): Pt2[] {
  const n = ring.length
  const { idx, t } = arcToEdge(ring, cum, total, s)
  if (t <= 1e-9) return rotateRingAt(ring, idx)
  const next = (idx + 1) % n
  const p: Pt2 = [
    ring[idx][0] + (ring[next][0] - ring[idx][0]) * t,
    ring[idx][1] + (ring[next][1] - ring[idx][1]) * t,
  ]
  if (Math.hypot(ring[next][0] - p[0], ring[next][1] - p[1]) <= 1e-9) return rotateRingAt(ring, next)
  // Start at the split point, walk the rest of the ring in its own traversal direction, and
  // end on the vertex just before it — the caller closes the lap back to the start point.
  const out: Pt2[] = [p]
  for (let m = 0; m < n; m++) out.push(ring[(next + m) % n])
  return out
}

// How far DOWNSTREAM of the closest point to advance the entry, so the link becomes a shallow
// diagonal in the direction of travel rather than a square step across the stepover (see
// LINK_LEAD_DIAMETERS). "Downstream" is +s, i.e. the direction the tool will cut this ring, so
// the link runs with the motion and the tool never has to reverse onto the new lap.
//
// Of the offsets within the lead distance, take the one the tool can drive into most
// straight-on. Blindly walking the full lead is right on a long ring but wrong on a tight one,
// where the ring curves away and the "downstream" point ends up behind the tool — turning a 90°
// step into a 137° one. `fromDir` is the direction the tool is travelling as it leaves the ring
// it just finished; without it there's nothing to optimise and the full lead is used.
function bestLeadOffset(
  ring: Pt2[], cum: number[], total: number, s0: number,
  from: Pt2, fromDir: Pt2 | null, leadDiameterMM: number,
): number {
  if (leadDiameterMM <= 0 || ring.length < 3) return 0
  const lead = leadLength(ring, leadDiameterMM)
  if (lead <= 1e-6) return 0
  if (!fromDir) return lead

  const SAMPLES = 12
  let best = 0
  let bestCos = -Infinity
  for (let k = 1; k <= SAMPLES; k++) {
    const ds = (lead * k) / SAMPLES
    const p = ringPointAtArc(ring, cum, total, s0 + ds)
    const dx = p[0] - from[0], dy = p[1] - from[1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) continue
    // cos of the turn the tool makes onto the link — bigger is straighter.
    const cos = (fromDir[0] * dx + fromDir[1] * dy) / len
    if (cos > bestCos) { bestCos = cos; best = ds }
  }
  return best
}

/** Rotate `ring` to start at the point with the shortest travel from `from`, advanced
 *  downstream by the link lead, preferring a start reachable without a lift when obstacles
 *  are supplied. */
function pickRingStart(
  ring: Pt2[], from: Pt2 | null, travelObstacles: TravelSafetyObstacles | null,
  leadDiameterMM = 0, fromDir: Pt2 | null = null,
): Pt2[] {
  if (from === null) return ring
  const { cum, total } = ringArc(ring)
  let s0 = nearestArcOnRing(ring, cum, from[0], from[1])
  if (travelObstacles && !isTravelSafe(from, ringPointAtArc(ring, cum, total, s0), travelObstacles)) {
    // The closest point is blocked. Walk the vertices by distance and take the first the
    // tool can reach at depth; if none can, keep the closest and let the caller lift.
    const order = ring.map((_, i) => i)
      .sort((a, b) => ((ring[a][0] - from[0]) ** 2 + (ring[a][1] - from[1]) ** 2)
                    - ((ring[b][0] - from[0]) ** 2 + (ring[b][1] - from[1]) ** 2))
    const safe = order.find(i => isTravelSafe(from, ring[i], travelObstacles))
    if (safe !== undefined) s0 = cum[safe]
  }
  return ringStartingAtArc(ring, cum, total, s0 + bestLeadOffset(ring, cum, total, s0, from, fromDir, leadDiameterMM))
}

export function chooseNextContourRing(
  rings: Pt2[][],
  lastPos: Pt2 | null,
  startNear: { x: number; y: number } | undefined,
  travelObstacles: TravelSafetyObstacles,
  // Non-zero shifts the entry point downstream so the link runs with the direction of travel
  // instead of square across the gap (see bestLeadOffset). `lastDir` is that direction.
  leadDiameterMM = 0,
  lastDir: Pt2 | null = null,
): { index: number; ring: Pt2[] } {
  if (lastPos === null && startNear === undefined) return { index: 0, ring: rings[0] }

  const target: Pt2 = lastPos ?? [startNear!.x, startNear!.y]

  // Rank rings by the distance to their CLOSEST POINT — projected onto the edges, not
  // snapped to a vertex. On a low-vertex ring (a rectangular pocket's offsets have four)
  // the nearest vertex is a corner most of a side away, which both picks the wrong ring
  // and lands the entry behind the tool.
  const ranked = rings.map((ring, index) => {
    const arc = ringArc(ring)
    const p = ringPointAtArc(ring, arc.cum, arc.total, nearestArcOnRing(ring, arc.cum, target[0], target[1]))
    return { index, ring, p, distSq: (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2 }
  }).sort((a, b) => a.distSq - b.distSq)

  const entry = (c: typeof ranked[number], lead: number) => ({
    index: c.index,
    ring: pickRingStart(c.ring, target, lastPos !== null ? travelObstacles : null, lead, lastDir),
  })

  // No travel safety to check — the nearest ring wins.
  if (lastPos === null) return entry(ranked[0], leadDiameterMM)

  // First ring reachable without a lift is the best choice.
  for (const c of ranked) {
    if (isTravelSafe(lastPos, c.p, travelObstacles)) return entry(c, leadDiameterMM)
  }

  // Every entry requires a lift, so there is no link to aim: land on the nearest point.
  return entry(ranked[0], 0)
}

// ─── Ring-to-ring linking ──────────────────────────────────────────────────────

// How far downstream on the next ring a link aims, in tool diameters.
//
// Entering at the NEAREST point makes the link run straight out across the stepover: the tool
// meets the uncut band square on, takes its full width at once, then turns hard onto the new
// ring. Aiming at a point this far along the ring instead turns the same move into a shallow
// diagonal — with a 6 mm tool at 70% stepover, roughly 20° off the direction of travel instead
// of 90° — so the cut widens gradually and the direction change at each end is small. The
// whole ring is still cut; only where the lap begins moves.
const LINK_LEAD_DIAMETERS = 2

// A link may not eat more than this fraction of the ring it enters — on a small ring a
// several-diameter lead would swallow most of the lap.
const LINK_MAX_RING_FRACTION = 0.35

const unitVec = (from: Pt2, to: Pt2): Pt2 | null => {
  const dx = to[0] - from[0], dy = to[1] - from[1]
  const len = Math.hypot(dx, dy)
  return len < 1e-9 ? null : [dx / len, dy / len]
}

export function ringPerimeter(ring: Pt2[]): number {
  let p = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    p += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1])
  }
  return p
}

/** Lead distance for a link into `ring`, bounded so it can't swallow a small ring. */
function leadLength(ring: Pt2[], toolDiameterMM: number): number {
  return Math.min(LINK_LEAD_DIAMETERS * toolDiameterMM, LINK_MAX_RING_FRACTION * ringPerimeter(ring))
}

/**
 * The move that takes the tool from one ring to the next at depth, or null if it has to lift.
 *
 * A link aimed downstream is longer than a radial one but no more exposed: it runs inside the
 * corridor between two adjacent rings rather than cutting across open pocket, so it gets a
 * ceiling of its own lead plus a couple of diameters, where an unaimed straight move stays
 * capped at two (past that, a move at depth risks crossing stock nothing has cleared yet).
 * `isTravelSafe` still has the final say.
 */
function planRingLink(
  from: Pt2, to: Pt2,
  toolDiameterMM: number, leadMM: number,
  travelObstacles: TravelSafetyObstacles,
): Pt2[] | null {
  const span = Math.hypot(to[0] - from[0], to[1] - from[1])
  const ceiling = Math.max(leadMM + 2 * toolDiameterMM, 2 * toolDiameterMM)
  return span <= ceiling && isTravelSafe(from, to, travelObstacles) ? [to] : null
}

// Emit a sequence of closed contour rings at depth `z`, linking consecutive rings
// with a rapid-at-depth when the direct travel is safe, lifting only when it isn't.
// Each ring's start vertex is rotated to minimise travel from the previous endpoint.
// `obstacles` = [finishingRing, ...islandObstacles] — both already offset by toolRadius.
// When `rampDistMM` is provided each ring entry is a diagonal ramp instead of a plunge.
export function emitLinkedContourRings(
  rings: Pt2[][],
  z: number,
  travelObstacles: TravelSafetyObstacles,
  segs: MotionSegment[],
  startNear?: { x: number; y: number },
  rampDistMM?: number,
  prevZ = 0,
  safeZ = 5,
  toolDiameterMM = 0,
  incomingPos: Pt2 | null = null,
  // Cut `rings` strictly in the order given, instead of walking them by proximity. For a
  // set whose order already encodes the cutting sequence — an offset family that must be
  // taken from the outside in, because only its outer side is cleared — proximity is free
  // to start anywhere, which is exactly the ring whose both sides are still solid.
  sequential = false,
  // Mark `rings` as a multi-level roughing set ordered innermost-offset-level first (contour's
  // roughing rings). Ring ORDER is then driven by nesting instead of proximity: the cut opens
  // at the innermost ring and walks outward, and a ring is never cut while it still contains an
  // uncut ring. When the current region runs into a medial-axis merge, the cut drops back to
  // the innermost ring still pending — the next medial-axis junction — and works outward from
  // there, so every pass has cleared material on one side instead of slotting full width.
  // The start VERTEX is still chosen for shortest travel; only the ring order is constrained.
  startInnermost = false,
): Pt2 | null {
  if (rings.length === 0) return incomingPos
  let lastPos: Pt2 | null = incomingPos
  const containment = startInnermost ? buildRingContainment(rings) : null
  const pendingIdx = rings.map((_, i) => i)   // innermost-level-first when startInnermost
  let lastRingIdx = -1
  let emittedCount = 0
  // Direction of travel as the tool completes a ring (its closing move) — what the next link
  // is aimed to continue.
  let lastDir: Pt2 | null = null

  while (pendingIdx.length > 0) {
    let ringIdx: number
    let ring: Pt2[]
    // Set when the next ring is NOT the outward continuation of the one just cut: the link
    // crosses material that is still solid, so it must be made above the workpiece.
    let forceLift = false
    if (containment) {
      const pick = nextContainmentRing(containment, pendingIdx, lastRingIdx)
      ringIdx = pick.index
      forceLift = pick.jumped && lastPos !== null
      const target: Pt2 | null = lastPos ?? (startNear ? [startNear.x, startNear.y] : null)
      const staysDown = lastPos !== null && !forceLift
      ring = pickRingStart(rings[ringIdx], target, staysDown ? travelObstacles : null,
        staysDown ? toolDiameterMM : 0, lastDir)
    } else if (sequential) {
      ringIdx = pendingIdx[0]
      const target: Pt2 | null = lastPos ?? (startNear ? [startNear.x, startNear.y] : null)
      ring = pickRingStart(rings[ringIdx], target, lastPos !== null ? travelObstacles : null,
        lastPos !== null ? toolDiameterMM : 0, lastDir)
    } else {
      const next = chooseNextContourRing(pendingIdx.map(i => rings[i]), lastPos, startNear, travelObstacles,
        lastPos !== null ? toolDiameterMM : 0, lastDir)
      ringIdx = pendingIdx[next.index]
      ring = next.ring
    }
    pendingIdx.splice(pendingIdx.indexOf(ringIdx), 1)
    if (containment) {
      for (let p = containment.parent[ringIdx]; p !== -1; p = containment.parent[p]) {
        containment.pendingInside[p]--
      }
    }
    lastRingIdx = ringIdx
    const [sx, sy]: Pt2 = ring[0]
    // Plan the link before deciding whether to lift: a downstream-aimed link may stay at depth
    // over a longer span than a radial one.
    const linkPath = lastPos !== null && !forceLift
      ? planRingLink(lastPos, [sx, sy], toolDiameterMM, leadLength(ring, toolDiameterMM), travelObstacles)
      : null
    const emitLink = () => {
      for (const p of linkPath ?? []) segs.push({ x: p[0], y: p[1], z, rapid: false })
    }

    if (rampDistMM !== undefined) {
      // Ramp starts rampDist BEFORE the ring's start vertex and cuts toward it,
      // arriving at full depth exactly at (sx, sy). The first ring of every depth
      // level must ramp from prevZ to z even when linked from the prior level.
      const { touchdown, sampleAt } = rampLeadIn(ring, false, rampDistMM)
      const [rampStartX, rampStartY] = touchdown
      const firstRingAtDepth = emittedCount === 0 && Math.abs(z - prevZ) > 1e-6
      const canTravelAtDepth = linkPath !== null
      const rampNeeded = firstRingAtDepth || !canTravelAtDepth

      if (rampNeeded) {
        if (lastPos !== null && !canTravelAtDepth) {
          segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
          segs.push({ x: rampStartX, y: rampStartY, z: safeZ, rapid: true })
          segs.push({ x: rampStartX, y: rampStartY, z: prevZ, rapid: true })
        } else if (lastPos === null) {
          segs.push({ x: rampStartX, y: rampStartY, z: safeZ, rapid: true })
          segs.push({ x: rampStartX, y: rampStartY, z: prevZ, rapid: true })
        } else {
          segs.push({ x: rampStartX, y: rampStartY, z: prevZ, rapid: false })
        }

        emitRampDescent(segs, sampleAt, prevZ, z, 12)
      } else {
        if (lastPos) emitLink()
        else segs.push({ x: sx, y: sy, z, rapid: false })
      }
      // Tool is now at (sx, sy, z) — cut full perimeter; this also re-cuts the ramp
      // groove section at full depth, leaving a clean finish.
      for (let j = 1; j < ring.length; j++) segs.push({ x: ring[j][0], y: ring[j][1], z, rapid: false })
      segs.push({ x: sx, y: sy, z, rapid: false })

      lastPos = [sx, sy]
    } else {
      if (linkPath === null) {
        if (lastPos !== null) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
        segs.push({ x: sx, y: sy, z, rapid: false })
      } else {
        emitLink()
      }

      for (let j = 1; j < ring.length; j++) segs.push({ x: ring[j][0], y: ring[j][1], z, rapid: false })
      segs.push({ x: sx, y: sy, z, rapid: false })
      lastPos = [sx, sy]
    }
    lastDir = unitVec(ring[ring.length - 1], ring[0])
    emittedCount++
  }

  return lastPos
}


export function buildOffsetLevels(
  boundary: Pt2[],
  islands: Pt2[][],
  toolRadius: number,
  stepoverMM: number,
  wantCCW: boolean,
  joinType: JoinType = JoinType.Miter,
): Pt2[][][] {
  const toCP = (pts: Pt2[]) => pts.map(([x, y]) => ({ x, y }))
  const fromCP = (r: { x: number; y: number }[]) =>
    stripClosingDuplicate(r.map(({ x, y }) => [x, y] as Pt2))

  // Compound polygon: CCW outer boundary + CW island holes.
  // inflatePathsD with a negative delta shrinks the outer boundary inward and
  // grows the island holes outward simultaneously, so each offset level is a
  // topologically correct ring that avoids every island automatically.
  const subject = [
    toCP(ensureWinding(boundary, true)),
    ...islands.map(isl => toCP(ensureWinding(isl, false))),
  ]

  // Incremental offset (feed each result into the next) keeps vertex counts low for
  // MITRE joins — the polygon shrinks in complexity each step, so chaining is cheap.
  // But ROUND joins ADD arc vertices at every corner on each pass, so chaining makes
  // the vertex count grow without bound: ~O(passes²) total, seconds of Clipper time
  // on a big pocket. For round joins, offset the ORIGINAL by a cumulative delta each
  // pass instead, so every ring's vertex count stays bounded by the source geometry.
  // Clipper correctly shrinks the CCW boundary and grows CW island holes either way.
  const fromOriginal = joinType === JoinType.Round
  const maxPasses = Math.ceil((Math.sqrt(Math.abs(signedArea(boundary))) / stepoverMM) * 2) + 50
  const levels: Pt2[][][] = []   // levels[0] = finishing (outermost), levels[last] = innermost
  let current = subject
  let incDelta = toolRadius   // incremental step from the previous ring (mitre path)
  let cumDelta = toolRadius   // cumulative offset from the original (round path)

  for (let pass = 0; pass < maxPasses; pass++) {
    const result = fromOriginal
      ? inflatePathsD(subject, -cumDelta, joinType, EndType.Polygon, 4, 6)
      : inflatePathsD(current, -incDelta, joinType, EndType.Polygon, 4, 6)
    if (result.length === 0) break
    const level = result
      .map(r => fromCP(r))
      .filter(pts => pts.length >= 3 && Math.abs(signedArea(pts)) > 0.01)
      .map(pts => ensureWinding(pts, wantCCW))
    if (level.length === 0) break
    levels.push(level)
    if (!fromOriginal) current = result
    incDelta = stepoverMM
    cumDelta += stepoverMM
  }

  return levels
}


/**
 * The polylines the tool actually cut at depth `z`, taken from emitted motion. Rest detection
 * works from these rather than from a strategy's internal rings so it serves any strategy —
 * contour rings, spiral runs, raster passes — and measures what was really machined,
 * including the links between passes.
 */
export function cutPathsAtDepth(segs: MotionSegment[], fromIdx: number, z: number): Pt2[][] {
  const paths: Pt2[][] = []
  let cur: Pt2[] = []
  const atDepth = (s: MotionSegment) => Math.abs(s.z - z) < 1e-6
  for (let i = Math.max(1, fromIdx); i < segs.length; i++) {
    const s = segs[i], prev = segs[i - 1]
    // travel moves ride above the floor, and a ramp's ends differ in Z — neither removes
    // material at full depth, so neither counts as coverage.
    if (!s.rapid && !s.travel && atDepth(s) && atDepth(prev)) {
      if (cur.length === 0) cur.push([prev.x, prev.y])
      cur.push([s.x, s.y])
    } else if (cur.length > 0) {
      paths.push(cur)
      cur = []
    }
  }
  if (cur.length > 0) paths.push(cur)
  return paths
}

/** Closed ring → polyline that returns to its start, so its swath includes the closing edge. */
export const closedPath = (ring: Pt2[]): Pt2[] => (ring.length > 0 ? [...ring, ring[0]] : ring)

/**
 * Rings that clear the stock a pass cannot reach — the pocket's "rest".
 *
 * A pass cuts a swath reaching `toolRadius` either side of its path. For offset rings there is
 * a neat proof of coverage: any point lies exactly (h - d) from the ring at inset d ≤ h, where
 * h is its own distance to the nearest wall, so a ring always clears everything with h in
 * [d, d + toolRadius]. Points SHALLOWER than a ring get no such guarantee — the next ring in
 * only stays a matching distance away while the level sets run parallel. At a medial-axis
 * peak, a junction cusp, or a tight corner it curves away or vanishes and a ridge of
 * full-height stock survives, up to (stepoverMM - toolRadius) wide. Spiral strategies lose
 * coverage the same way wherever their turn spacing opens up.
 *
 * Rather than predict where that happens per strategy, subtract every swath from the region
 * and cut what is left by tracing its OWN outline. One lap clears a patch up to 2·toolRadius
 * wide; anything wider gets peeled a radius per round until nothing remains. Two constraints:
 *   - the traced loop is clipped to the tool-centre zone (a radius inside every wall), or the
 *     tool eats into a finished edge wherever a patch reaches a corner;
 *   - the caller must cut these AFTER its ordinary passes. Cut first, a patch is solid stock
 *     on every side and the entry is a full-width plunge; cut last, its surroundings are
 *     already clear and the pass is a light skim.
 *
 * `cutPaths` must include the finishing rings the caller is about to emit (via `closedPath`),
 * or the untouched finish allowance reads as leftover stock.
 *
 * Runs at every stepover, not just above 50%: the coverage proof above holds for offset RINGS,
 * and a spiral's turn spacing is only nominally the stepover — measured, `spiral` left 58 mm²
 * of stock at 50%. Detection costs one clipper difference and finds nothing on the strategies
 * that are already complete.
 */
// Narrowest real leftover worth a pass. Also the guard that makes the swath approximations
// above safe: they can only invent slivers thinner than their own error (≤0.05 mm), while a
// genuine leftover is a good fraction of (stepover - toolRadius) wide.
const MIN_REST_WIDTH_MM = 0.15

// Mean width of a thin patch: for a w × L sliver, 2·area/perimeter = w.
function patchWidth(pts: Pt2[]): number {
  const area = Math.abs(signedArea(pts))
  let perim = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    perim += Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
  }
  return perim > 0 ? (2 * area) / perim : 0
}

export function restCleanupRings(
  boundary: Pt2[],
  islands: Pt2[][],
  toolRadius: number,
  cutPaths: Pt2[][],
  wantCCW: boolean,
): Pt2[][] {
  if (cutPaths.length === 0) return []

  const toCP = (pts: Pt2[]) => pts.map(([x, y]) => ({ x, y }))
  const fromCP = (r: { x: number; y: number }[]) =>
    stripClosingDuplicate(r.map(({ x, y }) => [x, y] as Pt2))
  // µm precision and a 0.05 mm arc tolerance: a spiral pocket's cut path runs to thousands of
  // points, and offsetting it at nanometre precision with default arc refinement dominated
  // generation time (≈1 s per depth level). Both approximations shrink the swath slightly, so
  // the error is on the safe side — it can only report leftover stock that isn't there, never
  // hide some that is.
  const swathOf = (paths: Pt2[][]) =>
    inflatePathsD(paths.map(p => toCP(douglasPeucker(p, 0.05))), toolRadius, JoinType.Round, EndType.Round, 2, 3, 0.05)

  const subject = [
    toCP(ensureWinding(boundary, true)),
    ...islands.map(isl => toCP(ensureWinding(isl, false))),
  ]
  // Where the tool centre is allowed to be: one radius inside every wall.
  const toolZone = inflatePathsD(subject, -toolRadius, JoinType.Round, EndType.Polygon, 4, 6)
  if (toolZone.length === 0) return []

  const rings: Pt2[][] = []
  // Swaths accumulate by union so each round only inflates the rings it just added — the cut
  // path of a spiral pocket runs to thousands of points and re-inflating it every round is the
  // one thing here that would show up in generation time.
  // The leftover shrinks round by round: subtract each new pass's swath from the PREVIOUS
  // leftover rather than rebuilding and re-differencing the full swath union, which grows with
  // every ring added.
  let rest = differenceD(subject, swathOf(cutPaths), FillRule.NonZero, 3)
  for (let round = 0; round < 8 && rest.length > 0; round++) {
    // Stock closer to a wall than the tool radius (a corner the cutter cannot enter) drops out
    // here rather than being traced into the wall.
    const reachable = intersectD(rest, toolZone, FillRule.NonZero, 3)
      .map(r => fromCP(r))
      .filter(pts => pts.length >= 3 && patchWidth(pts) > MIN_REST_WIDTH_MM)
      .map(pts => ensureWinding(pts, wantCCW))
    if (reachable.length === 0) break
    rings.push(...reachable)
    rest = differenceD(rest, swathOf(reachable.map(closedPath)), FillRule.NonZero, 3)
  }
  return rings
}


// Largest distance from a set of inner loops out to the nearest edge of a set of
// outer loops (the paper's D_isoHQ, eq. 10, generalized to multiple components).
// Distance is to the nearest EDGE, not vertex — a low-vertex outer loop (e.g. an
// inset square's 4 corners) would otherwise read points mid-edge as far away and
// break the stepover spacing. Inner points subsampled; outer kept as edges.
// Uniform grid over the outer EDGES, so the distance query below can afford to keep every
// one of them. A segment is filed in every cell its bounding box touches, so a ring-r cell
// holds nothing closer than (r-1) cells and the search can stop the moment that exceeds the
// best distance found.
class SegmentGrid {
  private readonly cell: number
  private readonly minX: number
  private readonly minY: number
  private readonly cols: number
  private readonly rows: number
  private readonly buckets: number[][]
  private readonly segs: readonly [Pt2, Pt2][]

  constructor(segs: readonly [Pt2, Pt2][]) {
    this.segs = segs
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [a, b] of segs) {
      if (a[0] < minX) minX = a[0]; if (a[0] > maxX) maxX = a[0]
      if (b[0] < minX) minX = b[0]; if (b[0] > maxX) maxX = b[0]
      if (a[1] < minY) minY = a[1]; if (a[1] > maxY) maxY = a[1]
      if (b[1] < minY) minY = b[1]; if (b[1] > maxY) maxY = b[1]
    }
    const span = Math.max(maxX - minX, maxY - minY)
    this.cell = span > 0 ? Math.max(span / Math.max(1, Math.ceil(Math.sqrt(segs.length))), 1e-6) : 1
    this.minX = minX; this.minY = minY
    this.cols = Math.max(1, Math.floor((maxX - minX) / this.cell) + 1)
    this.rows = Math.max(1, Math.floor((maxY - minY) / this.cell) + 1)
    this.buckets = Array.from({ length: this.cols * this.rows }, () => [] as number[])
    for (let i = 0; i < segs.length; i++) {
      const [a, b] = segs[i]
      const c0 = this.col(Math.min(a[0], b[0])), c1 = this.col(Math.max(a[0], b[0]))
      const r0 = this.row(Math.min(a[1], b[1])), r1 = this.row(Math.max(a[1], b[1]))
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.buckets[r * this.cols + c].push(i)
    }
  }

  private col(x: number) { return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell))) }
  private row(y: number) { return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell))) }

  nearestDistSq(x: number, y: number): number {
    const cx = this.col(x), cy = this.row(y)
    let best = Infinity
    const maxRing = Math.max(this.cols, this.rows)
    for (let r = 0; r <= maxRing; r++) {
      if (best < Infinity) { const reach = (r - 1) * this.cell; if (reach > 0 && reach * reach > best) break }
      const y0 = Math.max(0, cy - r), y1 = Math.min(this.rows - 1, cy + r)
      for (let j = y0; j <= y1; j++) {
        const onYEdge = j === cy - r || j === cy + r
        const x0 = Math.max(0, cx - r), x1 = Math.min(this.cols - 1, cx + r)
        for (let i = x0; i <= x1; i++) {
          if (!onYEdge && i !== cx - r && i !== cx + r) continue
          for (const id of this.buckets[j * this.cols + i]) {
            const [a, b] = this.segs[id]
            const d = ptSegDistSq(x, y, a[0], a[1], b[0], b[1])
            if (d < best) best = d
          }
        }
      }
    }
    return best
  }
}

/**
 * Largest distance from a set of inner loops out to the nearest EDGE of a set of outer
 * loops (the paper's D_isoHQ, eq. 10, generalized to multiple components). Distance is to
 * the nearest edge, not vertex — a low-vertex outer loop (an inset square's 4 corners)
 * would otherwise read points mid-edge as far away and break the stepover spacing.
 *
 * Both sides are kept at FULL resolution. They used to be decimated to a fixed vertex count
 * (outers to 200, inners to 40) and that silently destroyed the measurement on any detailed
 * outline: decimating a 4598-vertex island 22x leaves chords cutting straight across its
 * detail, so an isotherm hugging the real boundary reads as tens of mm from it. On the dog's
 * 22-island pocket that made the reported gap NON-MONOTONIC in the temperature step — 21 mm
 * at a step where the true gap was 0.39 mm — which is the one property buildIsothermChains'
 * bisection relies on. Every candidate level was rejected, the march died having traced zero
 * isotherms, and the "spiral" came out as a single loop. Exact distances are monotonic and
 * land in the window as intended.
 *
 * Keeping every edge is only affordable with the index above; brute force over them ran ~3 s
 * per call. Inner loops are sampled by ARC LENGTH rather than by count, so the spacing of
 * the samples is a property of the geometry and not of how densely that particular loop
 * happened to be tessellated.
 */
export function setGap(inners: Pt2[][], outers: Pt2[][], sampleMM = 0.25): number {
  const outerSegs: [Pt2, Pt2][] = []
  for (const o of outers) {
    for (let i = 0; i < o.length; i++) outerSegs.push([o[i], o[(i + 1) % o.length]])
  }
  if (outerSegs.length === 0) return Infinity
  const grid = new SegmentGrid(outerSegs)
  const step = Math.max(sampleMM, 1e-6)

  let maxMin = 0
  const take = (dSq: number) => { if (dSq > maxMin) maxMin = dSq }
  for (const inner of inners) {
    if (inner.length === 0) continue
    // Walk the loop at a fixed arc-length spacing, always including the vertices themselves
    // so a corner is never stepped over.
    let carried = 0
    for (let i = 0; i < inner.length; i++) {
      const a = inner[i], b = inner[(i + 1) % inner.length]
      take(grid.nearestDistSq(a[0], a[1]))
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      for (let s = step - carried; s < len; s += step) {
        const t = s / len
        take(grid.nearestDistSq(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
      }
      carried = len > 0 ? (len + carried) % step : carried
    }
  }
  return Math.sqrt(maxMin)
}
