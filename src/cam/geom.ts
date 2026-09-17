// Shared CAM geometry helpers. Canonical home for utilities that were once
// duplicated across the per-operation modules (see tofix.md R2). Note:
// adaptiveClearing.ts is deliberately excluded from this consolidation — it is
// a faithful FreeCAD port and must stay byte-for-byte comparable (tofix.md H6).

import { signedArea, sharesVertex, type Pt2 } from './pathFlattener'
import type { Tool } from '../store/toolStore'

// ─── Tool profile ─────────────────────────────────────────────────────────────
//
// Every rotationally symmetric cutter here is described by ONE pair of inverse
// functions, and no module may write its own version of either:
//
//   toolProfileHeightMM(tool, d)  f(d)  — how far above the tip the tool's surface
//                                         sits at radial distance d. This is the
//                                         shape the cut LEAVES in the material.
//   toolRadiusAtHeight(tool, h)   a(h)  — f's inverse: the half-width of material
//                                         removed at height h above the tip.
//
//  • endmill / drill — flat bottom, full radius at every height (including 0).
//  • vbit — a cone of half-angle θ: a(h) = h·tanθ, capped at the shank radius once
//    the cone runs out (h > R/tanθ).
//  • ballnose — sphere of radius R tangent to the shank: a(h) = √(h(2R−h)) while
//    h < R, then the full radius.
//  • taper — a ball of radius r at the tip blended TANGENTIALLY into a cone of
//    half-angle θ; the general two-parameter family that contains both of the
//    above. The ball and the cone meet at
//        d_t = r·cosθ        h_t = r·(1 − sinθ)
//    and the profile is
//        f(d) = r − √(r² − d²)               d ≤ d_t
//        f(d) = d/tanθ − r·(1/sinθ − 1)      d ≥ d_t
//    which is C1 there (both sides have slope 1/tanθ at d_t). Setting r = 0
//    reproduces the V-bit law exactly and θ → 0 reproduces the ball nose, which is
//    why the V-bit code paths generalise to a taper instead of forking.
//
// A profile that must "just touch" the design line at the stock surface offsets by
// the radius at the surface, i.e. h = depth of cut below that surface — which is why
// a shallow V-bit pass barely offsets at all and a deep one offsets a full radius.

// A cutter whose wall is tapered rather than straight — the question nearly every
// `type === 'vbit'` test in the CAM modules was really asking.
export function isVCutter(tool: Tool): boolean {
  return tool.type === 'vbit' || tool.type === 'taper'
}

// The cone angle in the ONE convention the rest of the app works in: full included
// angle. A V-bit stores that already; a taper is sold and stored per side, so it
// doubles. This is the only place the two conventions meet — see Tool.vbitAngleDeg.
export function includedAngleDeg(tool: Tool): number {
  if (tool.type === 'taper') return (tool.vbitAngleDeg ?? 5) * 2
  return tool.vbitAngleDeg ?? 60
}

// tan of the half (per-side) angle, or null when the angle is degenerate — 0° and
// 180° both make the cone meaningless, and a hand-edited project can hold either.
// Callers fall back to a straight-walled tool (a taper falls back to a ball nose).
export function halfAngleTan(tool: Tool): number | null {
  const halfDeg = includedAngleDeg(tool) / 2
  if (!(halfDeg > 0 && halfDeg < 90)) return null
  return Math.tan((halfDeg * Math.PI) / 180)
}

// Radius of the ball ground on the tip. A taper's stored diameter IS that ball;
// every other type has no tip ball.
export function tipBallRadiusMM(tool: Tool): number {
  return tool.type === 'taper' ? Math.max(0, tool.diameterMM / 2) : 0
}

// ── The V-cutter primitives ───────────────────────────────────────────────────
// A cone of half-angle θ tangent to a ball of radius `tipR` at the tip. tipR = 0 is a
// plain V-bit and both reduce to the bare cone laws. Uncapped — the widest the tool
// actually cuts depends on the tool, so capping is the caller's business.
//
// These take a raw tan and tip rather than a Tool because two callers must not read
// the tool's own angle: a V-carve uses the OPERATION's angle (an inlay's two halves
// share one), and the simulator only ever has what it parsed out of the G-code.

// The constant that slides the cone down to meet the tip ball tangentially:
// r·(1/sinθ − 1), written in terms of tanθ.
export function vConeOffsetMM(halfAngleTan: number, tipR: number): number {
  return tipR <= 0 ? 0 : tipR * (Math.sqrt(1 + halfAngleTan * halfAngleTan) / halfAngleTan - 1)
}

// f(d) — height above the tip at radial distance d.
export function vProfileHeightMM(dMM: number, halfAngleTan: number, tipR: number): number {
  const d = Math.max(0, dMM)
  if (tipR <= 0) return d / halfAngleTan
  const dT = tipR / Math.sqrt(1 + halfAngleTan * halfAngleTan)      // r·cosθ
  if (d <= dT) return tipR - Math.sqrt(Math.max(0, tipR * tipR - d * d))
  return d / halfAngleTan - vConeOffsetMM(halfAngleTan, tipR)
}

// a(h) — f's inverse: the half-width removed at height h above the tip.
export function vRadiusAtHeightMM(hMM: number, halfAngleTan: number, tipR: number): number {
  const h = Math.max(0, hMM)
  if (tipR <= 0) return h * halfAngleTan
  const hT = tipR * (1 - halfAngleTan / Math.sqrt(1 + halfAngleTan * halfAngleTan))  // r·(1 − sinθ)
  if (h <= hT) return Math.sqrt(Math.max(0, h * (2 * tipR - h)))
  return (h + vConeOffsetMM(halfAngleTan, tipR)) * halfAngleTan
}

// The widest radius this tool can cut — for a taper, the radius at the far end of
// its usable taper length (its Max Z). Straight-walled tools are their own radius.
export function maxCutRadiusMM(tool: Tool): number {
  const R = Math.max(0, tool.diameterMM / 2)
  if (tool.type !== 'taper') return R
  const tan = halfAngleTan(tool)
  if (tan === null) return R
  // A hand-edited project can hold a non-positive Max Z. There is no taper length to
  // open out over then, so the tool is just its tip ball — finite, and never wider
  // than the user asked for.
  const L = tool.maxDepthMM > 0 ? tool.maxDepthMM : R
  return vRadiusAtHeightMM(L, tan, R)
}

// Height above the tip of a ball of radius R at radial distance d.
function ballProfile(d: number, R: number): number {
  return R - Math.sqrt(Math.max(0, R * R - d * d))
}

// f(d) — height above the tip at radial distance d; the shape the cut leaves.
// Beyond the tool's widest cutting radius the body is a straight shank, which
// removes nothing further, so the profile is reported at that widest radius.
export function toolProfileHeightMM(tool: Tool, dMM: number): number {
  const d = Number.isFinite(dMM) ? Math.max(0, dMM) : 0
  const R = maxCutRadiusMM(tool)
  const dc = Math.min(d, R)
  switch (tool.type) {
    case 'vbit':
    case 'taper': {
      const tan = halfAngleTan(tool)
      // Degenerate angle: a V-cutter with no usable cone is a flat/ball tool.
      if (tan === null) return tool.type === 'taper' ? ballProfile(dc, R) : 0
      return vProfileHeightMM(dc, tan, tipBallRadiusMM(tool))
    }
    case 'ballnose':
      return ballProfile(dc, R)
    default:
      return 0
  }
}

// a(h) — the inverse of f: the half-width of material removed at height h.
export function toolRadiusAtHeight(tool: Tool, heightAboveTipMM: number): number {
  const R = Math.max(0, tool.diameterMM / 2)
  const h = Number.isFinite(heightAboveTipMM) ? Math.max(0, heightAboveTipMM) : 0
  switch (tool.type) {
    case 'vbit':
    case 'taper': {
      const tan = halfAngleTan(tool)
      // Degenerate angle: a taper with no usable cone is a ball nose of its tip,
      // a V-bit a straight-walled tool of its own radius.
      if (tan === null) {
        if (tool.type === 'vbit') return R
        return h >= R ? R : Math.sqrt(Math.max(0, h * (2 * R - h)))
      }
      return Math.min(maxCutRadiusMM(tool), vRadiusAtHeightMM(h, tan, tipBallRadiusMM(tool)))
    }
    case 'ballnose':
      return h >= R ? R : Math.sqrt(Math.max(0, h * (2 * R - h)))
    default:
      return R
  }
}

// Z levels for multi-pass cutting: -step, -2·step, … then exactly -depth.
// Step is clamped to the UI's 0.01 mm minimum so a zero/negative/NaN value
// (hand-edited or corrupted .fkam project) can't loop forever or allocate
// unboundedly (tofix.md B7).
//
// The loop bound carries an epsilon because repeated `z -= step` accumulates
// float error: for e.g. depth 0.8 / step 0.1 the last iteration lands on
// -0.7999999999999999, which is > -0.8, so the loop pushed it AND the final
// push added -0.8 — two full cutting passes at the same depth (rubbing at
// zero chip load). 1e-9 mm is far below any machine's resolution, so it can
// only ever collapse a duplicate, never drop a real pass.
//
// `startZMM` is the surface the cut begins from — 0 at stock top, negative when the
// operation starts on the floor left by an earlier one (engraving into a pocket). Depth
// is always measured FROM that surface, so the levels shift down with it and every
// depth field keeps meaning what it says.
export function zPasses(depthMM: number, stepDownMM: number, startZMM = 0): number[] {
  const step = Math.max(0.01, Number.isFinite(stepDownMM) ? Math.abs(stepDownMM) : 0)
  const depth = Number.isFinite(depthMM) ? Math.abs(depthMM) : 0
  const passes: number[] = []
  let z = -step
  while (z > -depth + 1e-9) { passes.push(z); z -= step }
  passes.push(-depth)
  const start = Number.isFinite(startZMM) ? Math.min(0, startZMM) : 0
  return start === 0 ? passes : passes.map((p) => start + p)
}

// Ray-cast point-in-polygon (even-odd rule). Polygon may be open or closed —
// the i/j indexing treats it as implicitly closed either way.
export function pointInPolygon(px: number, py: number, poly: Pt2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Is the point ON the ring's outline, to within `tolMM`?
 *
 * Companion to `pointInPolygon`, which uses the standard half-open crossing rule and so
 * answers a point lying exactly ON the outline by which SIDE it sits on: the left wall of
 * an axis-aligned rectangle reads inside, the right wall reads outside. That tie-break is
 * arbitrary, and geometry built by intersecting a ring lands its endpoints exactly on it —
 * so `pointInPolygon || pointOnRing` is what a caller means when it asks whether a point is
 * within a closed region it derived that region's own points from.
 *
 * The tolerance is a floating-point equality one (round-tripping a point through a
 * rotation costs ~1e-13 mm), not a geometric allowance — never widen it into one.
 * Ring may be open or closed; the i/j indexing closes it either way.
 */
export function pointOnRing(px: number, py: number, poly: Pt2[], tolMM = 1e-6): boolean {
  const tol2 = tolMM * tolMM
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (ptSegDistSq(px, py, poly[j][0], poly[j][1], poly[i][0], poly[i][1]) <= tol2) return true
  }
  return false
}

// Cumulative arc length at each vertex of a polyline, plus the total.
export function arcLengths(pts: Pt2[]): { lens: number[]; total: number } {
  const lens: number[] = [0]
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  }
  return { lens, total: lens[lens.length - 1] }
}

// Interpolate a point at arc-length s along a polyline.
export function interpPt(pts: Pt2[], lens: number[], s: number): Pt2 {
  s = Math.max(0, Math.min(lens[lens.length - 1], s))
  for (let i = 1; i < pts.length; i++) {
    if (lens[i] >= s - 1e-10) {
      const t = (lens[i] - lens[i - 1]) > 1e-10 ? (s - lens[i - 1]) / (lens[i] - lens[i - 1]) : 0
      return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]
    }
  }
  return [pts[pts.length - 1][0], pts[pts.length - 1][1]]
}

// Drop a duplicated closing vertex (last == first within epsilon).
export function stripClosingDuplicate(pts: Pt2[]): Pt2[] {
  if (pts.length > 1 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 1e-6) {
    return pts.slice(0, -1)
  }
  return pts
}

// ─── Containment classifier ───────────────────────────────────────────────────
// Groups a flat list of rings into {outer, holes} regions by containment. Lives
// here (not in vcarve.ts, where it started) because pocket.ts needs it too and
// must not pull in vcarve's JSPoly medial-axis code.

export interface Region { outer: Pt2[]; holes: Pt2[][] }

export function centroidX(pts: Pt2[]): number { return pts.reduce((s, p) => s + p[0], 0) / pts.length }
export function centroidY(pts: Pt2[]): number { return pts.reduce((s, p) => s + p[1], 0) / pts.length }

// A point that genuinely lies in the material enclosed by `rings`, for use as a shape's
// stand-in in a containment test.
//
// NOT the centroid. The average of a ring's vertices only lands inside it when the ring is
// convex: on a W/M zigzag the mean falls in the notch between the arms, outside the shape
// entirely. That is not an exotic case — a W nested in a W (any shape and its own inward
// offset) read as not-contained, so the inner ring was classified as a sibling region
// instead of a hole, and a V-carve of the pair cut two separate medial axes, one of them
// straight through the middle of the island.
//
// Method: scan horizontal lines across the shape, collect their crossings with every ring,
// and take the midpoint of the widest even-odd interior span found. Even-odd across all
// rings at once means the point lands in solid material, never in a hole.
export function interiorPoint(rings: Pt2[][]): Pt2 | null {
  const solid = rings.filter((r) => r.length >= 3)
  if (solid.length === 0) return null
  let minY = Infinity, maxY = -Infinity
  for (const r of solid) for (const [, y] of r) { if (y < minY) minY = y; if (y > maxY) maxY = y }
  if (!(maxY > minY)) return null
  // Enough lines that a shape with thin arms gets one through an arm, few enough that this
  // stays a fixed small cost per shape.
  const LINES = 11
  let best: { x: number; y: number; w: number } | null = null
  for (let i = 1; i <= LINES; i++) {
    const y = minY + ((maxY - minY) * i) / (LINES + 1)
    const xs: number[] = []
    for (const ring of solid) {
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, ya] = ring[a]
        const [xb, yb] = ring[b]
        // Same half-open edge rule as pointInPolygon, so a vertex exactly on the scan line
        // is counted once rather than twice.
        if ((ya > y) !== (yb > y)) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa))
      }
    }
    if (xs.length < 2) continue
    xs.sort((p, q) => p - q)
    // Crossings pair up into interior spans: [0,1] is inside, [1,2] is outside, …
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1] - xs[k]
      if (!best || w > best.w) best = { x: (xs[k] + xs[k + 1]) / 2, y, w }
    }
  }
  return best ? [best.x, best.y] : null
}

// Resolves a flat ring list into solid regions by the EVEN-ODD rule — the same rule SVG
// fills with, and the same one groupPathsByContainment applies across separately selected
// paths. Nesting alternates: the area inside the outermost ring is solid, inside the next
// one in is a hole, inside that is solid again. A region's holes are its DIRECT children
// only.
//
// It used to claim every contained ring as a hole of the biggest thing containing it, so
// four concentric rings read as one region with three holes and the solid ring between the
// 3rd and 4th was never machined. Compound paths are exactly where that bites: a traced
// SVG import arrives as one path holding concentric outlines.
//
// `preserveOrder` returns the regions in the order their outers appeared in the input
// instead of by descending area — pocket wants that so cut order (and the travel between
// glyphs of a text path) stays the subpath order of the source.
export function classifySubpaths(subpaths: Pt2[][], opts: { preserveOrder?: boolean } = {}): Region[] {
  const n = subpaths.length
  // One stand-in point per ring, computed once rather than per candidate/outer pair.
  // Vertex mean only as a last resort — a degenerate ring has no interior for a scan line
  // to find, and any point is as good as another there.
  const reps: Pt2[] = subpaths.map((sp) =>
    interiorPoint([sp]) ?? [centroidX(sp), centroidY(sp)])
  const areas = subpaths.map((sp) => Math.abs(signedArea(sp)))

  // Direct parent of each ring: the SMALLEST ring that contains it. Smallest, not largest,
  // is what makes the depth count below a nesting level rather than "is enclosed at all".
  const parent = new Int32Array(n).fill(-1)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (i === j || subpaths[i].length < 3) continue
      // A container is always strictly larger than what it contains. Without this the
      // point test alone inverts nested rings: the stand-in point for a ring that HAS a
      // child can legitimately sit inside that child, which then reads as the parent.
      if (areas[i] <= areas[j]) continue
      // Loops touching at a vertex are siblings (e.g. letter K arms), not holes.
      if (sharesVertex(subpaths[j], subpaths[i])) continue
      if (!pointInPolygon(reps[j][0], reps[j][1], subpaths[i])) continue
      if (parent[j] === -1 || areas[i] < areas[parent[j]]) parent[j] = i
    }
  }

  // Containment by a strictly smaller area is a partial order, so the chain terminates;
  // the seed guards a cycle from degenerate input (identical rings) hanging the walk.
  const depths = new Int32Array(n).fill(-1)
  const depthOf = (i: number): number => {
    if (depths[i] >= 0) return depths[i]
    depths[i] = 0
    return (depths[i] = parent[i] === -1 ? 0 : depthOf(parent[i]) + 1)
  }

  const found: { idx: number; region: Region }[] = []
  for (let i = 0; i < n; i++) {
    if (depthOf(i) % 2 !== 0) continue
    const holes: Pt2[][] = []
    for (let j = 0; j < n; j++) if (parent[j] === i) holes.push(subpaths[j])
    found.push({ idx: i, region: { outer: subpaths[i], holes } })
  }
  // Default order stays largest-first, as it was when regions were discovered by area.
  found.sort((a, b) => areas[b.idx] - areas[a.idx])

  if (opts.preserveOrder) found.sort((a, b) => a.idx - b.idx)
  return found.map(f => f.region)
}

// Squared distance from point (px,py) to segment (ax,ay)-(bx,by).
export function ptSegDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay
  const len2 = abx * abx + aby * aby
  if (len2 === 0) return (px - ax) ** 2 + (py - ay) ** 2
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2))
  return (px - ax - t * abx) ** 2 + (py - ay - t * aby) ** 2
}

/**
 * Append `src` to `dst` in place.
 *
 * Use this, never `dst.push(...src)`, whenever `src` is a generated motion path. Spreading
 * passes every element as a separate function argument and engines cap how many they will
 * take (~65–125k in V8); past that it throws "Maximum call stack size exceeded". Toolpaths
 * cross that line routinely — one inlay socket came to 97k segments with ramp-in, 110k at a
 * 10% stepover, 320k with both — and the limit is engine-dependent, so the same project can
 * work on one machine and fail on another.
 *
 * It fails in the worst possible way: the throw escapes the generator, the form's catch
 * calls setError, and setError clears the segments. The operation ends up with no toolpath
 * at all, and the harder the job the user asked for, the likelier it is to happen. Nothing
 * about the geometry looks wrong, which is why it read as "the inlay just doesn't work".
 */
export function pushAll<T>(dst: T[], src: readonly T[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i])
}
