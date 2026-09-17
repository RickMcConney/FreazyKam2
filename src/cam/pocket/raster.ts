import {   type Pt2 } from '../pathFlattener'
import {   pointInPolygon } from '../geom'
import { JoinType } from 'clipper2-ts'
import { buildPocketClearance } from './clearance'
import type { MotionSegment } from '../../store/toolpathStore'
import { type PocketPlan, type PocketPlanner, type TravelSafetyObstacles, POCKET_FLATTEN_TOL_MM, compoundFinishRings, emitCutTransition, emitRampDescent, growIslands, insetRing, isTravelSafe, rampLeadIn } from './shared'

// ─── Raster utilities ──────────────────────────────────────────────────────────

interface Scanline { p1: Pt2; p2: Pt2; row: number }

function generateScanlines(
  boundary: Pt2[],
  spacingMM: number,
  angleDeg: number,
): Scanline[] {
  if (boundary.length < 3) return []
  const angleRad = (angleDeg * Math.PI) / 180
  const cosA = Math.cos(-angleRad), sinA = Math.sin(-angleRad)
  const cosR = Math.cos(angleRad), sinR = Math.sin(angleRad)
  const rotated = boundary.map(([x, y]) => ({ x: x * cosA - y * sinA, y: x * sinA + y * cosA }))
  const ys = rotated.map(p => p.y)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const n = rotated.length
  const segments: Scanline[] = []
  let row = 0
  for (let y = minY + spacingMM / 2; y <= maxY; y += spacingMM, row++) {
    const hits: number[] = []
    for (let i = 0; i < n; i++) {
      const a = rotated[i], b = rotated[(i + 1) % n]
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        hits.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
      }
    }
    hits.sort((a, b) => a - b)
    for (let i = 0; i + 1 < hits.length; i += 2) {
      segments.push({
        p1: [hits[i] * cosR - y * sinR, hits[i] * sinR + y * cosR],
        p2: [hits[i + 1] * cosR - y * sinR, hits[i + 1] * sinR + y * cosR],
        row,
      })
    }
  }
  return segments
}

/** An island exclusion with its bounding box, in the rotated (scanline-aligned) frame. */
interface Exclusion { ring: Pt2[]; box: [number, number, number, number] }

function boxOf(ring: Pt2[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of ring) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

function clipScanlineAgainstIslands(
  p1: Pt2, p2: Pt2, exclusions: Exclusion[],
): { p1: Pt2; p2: Pt2 }[] {
  if (exclusions.length === 0) return [{ p1, p2 }]
  const y = p1[1]
  const xL = Math.min(p1[0], p2[0]), xR = Math.max(p1[0], p2[0])
  const blocked: [number, number][] = []
  for (const { ring: poly, box } of exclusions) {
    // Islands whose y-band the scanline misses, rejected by box before walking their
    // edges. A scanline is one row of a fill spanning the whole pocket, so on anything
    // with several islands most of them are nowhere near it. Exact, not an approximation:
    // with y outside [y0, y1] no edge can satisfy the half-open crossing test below, so
    // `hits` comes out empty, and no point at that y lies inside the ring either — which
    // is the only other way this iteration has an effect (the pointInPolygon fallback).
    // Kept deliberately loose at both ends (y == y0 can produce a hit off a flat bottom
    // edge; y == y1 cannot, but is cheaper to admit than to reason about).
    //
    // No x test: an island wholly left or right of the span blocks nothing, but its mere
    // presence in `blocked` diverts the function from the `blocked.length === 0` early
    // return to the cursor walk, and only the walk applies the 0.1 mm minimum-span filter.
    // Skipping it would therefore change the output for a sub-0.1 mm scanline.
    if (y < box[1] || y > box[3]) continue
    const hits: number[] = []
    const n = poly.length
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n]
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        hits.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
      }
    }
    hits.sort((a, b) => a - b)
    // An odd hit count means the scanline grazed a vertex and one crossing was
    // double-counted or missed. Pairing the list as-is would leave the island's
    // last span unblocked and cut straight through it, so treat the whole island
    // as blocking the scanline's span instead.
    if (hits.length % 2 === 1) { blocked.push([hits[0], hits[hits.length - 1]]); continue }
    for (let k = 0; k + 1 < hits.length; k += 2) blocked.push([hits[k], hits[k + 1]])
    if (hits.length === 0 && pointInPolygon((xL + xR) / 2, y, poly)) return []
  }
  if (blocked.length === 0) return [{ p1, p2 }]
  blocked.sort((a, b) => a[0] - b[0])
  const result: { p1: Pt2; p2: Pt2 }[] = []
  let cursor = xL
  for (const [bL, bR] of blocked) {
    if (bR <= cursor) continue
    if (bL > cursor) result.push({ p1: [cursor, y], p2: [Math.min(bL, xR), y] })
    cursor = Math.max(cursor, bR)
    if (cursor >= xR) break
  }
  if (cursor < xR) result.push({ p1: [cursor, y], p2: [xR, y] })
  return result.filter(s => Math.abs(s.p2[0] - s.p1[0]) >= 0.1)
}


// A safe hop scores `dist`, one that needs a lift scores `dist * LIFT_PENALTY`. Both are
// bounded below by `dist`, which is what makes the pruning in buildRasterPath exact.
const LIFT_PENALTY = 1.25

// Uniform-grid index over scanline endpoints, supporting removal.
//
// buildRasterPath picks each next scanline by a greedy nearest-neighbour scan over every
// end of every unused scanline, and travel-safety-tests each candidate. That is O(n²)
// tests: a 600 mm compound outline clipped by 20 islands is 4093 spans, so 17 M tests
// against ~8700 obstacle edges — two and a half minutes. Endpoint ids are `scanlineIndex
// * 2 + end`, so iterating a query result in ascending id order visits candidates in
// exactly the (i, r) order the old full scan did, and the winner and its tie-breaks are
// unchanged.
class EndpointGrid {
  private readonly cell: number
  private readonly minX: number
  private readonly minY: number
  private readonly cols: number
  private readonly rows: number
  private readonly buckets: number[][]
  private readonly xs: Float64Array
  private readonly ys: Float64Array
  private readonly alive: Uint8Array

  constructor(pts: Pt2[]) {
    const n = pts.length
    this.xs = new Float64Array(n)
    this.ys = new Float64Array(n)
    this.alive = new Uint8Array(n).fill(1)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i]
      this.xs[i] = x; this.ys[i] = y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    // Aim for roughly one point per cell; guard the degenerate all-coincident case.
    const span = Math.max(maxX - minX, maxY - minY)
    this.cell = span > 0 ? Math.max(span / Math.max(1, Math.ceil(Math.sqrt(n))), 1e-6) : 1
    this.minX = minX; this.minY = minY
    this.cols = Math.max(1, Math.floor((maxX - minX) / this.cell) + 1)
    this.rows = Math.max(1, Math.floor((maxY - minY) / this.cell) + 1)
    this.buckets = Array.from({ length: this.cols * this.rows }, () => [] as number[])
    for (let i = 0; i < n; i++) this.buckets[this.cellIndex(this.xs[i], this.ys[i])].push(i)
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)))
  }
  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)))
  }
  private cellIndex(x: number, y: number): number {
    return this.row(y) * this.cols + this.col(x)
  }

  remove(id: number) { this.alive[id] = 0 }

  /** Distance to the closest live point, or Infinity when none are left. */
  nearestDist(x: number, y: number): number {
    const cx = this.col(x), cy = this.row(y)
    let best = Infinity
    const maxRing = Math.max(this.cols, this.rows)
    for (let r = 0; r <= maxRing; r++) {
      // A point in ring r sits at least (r-1) cells away, so once that exceeds the best
      // distance found no further ring can improve on it.
      if (best < Infinity && (r - 1) * this.cell > best) break
      const y0 = Math.max(0, cy - r), y1 = Math.min(this.rows - 1, cy + r)
      for (let j = y0; j <= y1; j++) {
        const onYEdge = j === cy - r || j === cy + r
        const x0 = Math.max(0, cx - r), x1 = Math.min(this.cols - 1, cx + r)
        for (let i = x0; i <= x1; i++) {
          if (!onYEdge && i !== cx - r && i !== cx + r) continue
          for (const id of this.buckets[j * this.cols + i]) {
            if (!this.alive[id]) continue
            const d = Math.hypot(this.xs[id] - x, this.ys[id] - y)
            if (d < best) best = d
          }
        }
      }
    }
    return best
  }

  /** Live point ids within `radius`, ascending — i.e. in (scanline, end) order. */
  within(x: number, y: number, radius: number): number[] {
    const out: number[] = []
    const c0 = this.col(x - radius), c1 = this.col(x + radius)
    const r0 = this.row(y - radius), r1 = this.row(y + radius)
    for (let j = r0; j <= r1; j++) {
      for (let i = c0; i <= c1; i++) {
        for (const id of this.buckets[j * this.cols + i]) {
          if (!this.alive[id]) continue
          if (Math.hypot(this.xs[id] - x, this.ys[id] - y) <= radius) out.push(id)
        }
      }
    }
    return out.sort((a, b) => a - b)
  }
}

function buildRasterPath(
  scanlines: Scanline[],
  travelObstacles: TravelSafetyObstacles,
  zDepth: number,
  segs: MotionSegment[],
  incomingPos: Pt2 | null,
  rampDistMM?: number,
  prevZ = 0,
  safeZ = 5,
  toolDiameterMM = 0,
  // Where the previous operation left the tool. Used ONLY to choose which scanline to open
  // on — the entry is still a lift and a plunge, because the tool is not actually there and
  // cannot travel at depth from it.
  startNear?: { x: number; y: number },
): Pt2 | null {
  if (scanlines.length === 0) return incomingPos
  const used = new Array(scanlines.length).fill(false)
  let current: Pt2 | null = incomingPos

  // A raster is a linear stack of rows, so it has to be entered at one END of that stack.
  // The hint chooses WHICH end (and which end of that row) — nothing more. Letting it pick
  // the globally nearest row instead opens somewhere in the middle, and everything on the
  // far side is then stranded until a long retrace at the end.
  let minRow = Infinity, maxRow = -Infinity
  for (const sl of scanlines) {
    if (sl.row < minRow) minRow = sl.row
    if (sl.row > maxRow) maxRow = sl.row
  }

  // Endpoint index for the greedy pick below. Ends are interleaved p1, p2 per scanline so
  // that id order is (scanline, end) order.
  const ends: Pt2[] = []
  for (const sl of scanlines) ends.push(sl.p1, sl.p2)
  const grid = new EndpointGrid(ends)

  for (let remaining = scanlines.length; remaining > 0; remaining--) {
    let bestIdx = -1, bestScore = Infinity, bestDist = Infinity, bestReversed = false, bestNeedsLift = true

    // Candidates worth testing. Once the tool is down, every score is at least the
    // straight-line distance and the nearest end scores at most LIFT_PENALTY × that, so
    // anything farther is provably beaten and never needs a travel-safety test. The first
    // pass has no position to measure from (and its row restriction is not a distance), so
    // it stays a full scan — one pass, and with `current` null it does no safety tests.
    let candidates: number[]
    if (current === null) {
      candidates = []
      for (let i = 0; i < scanlines.length; i++) {
        if (used[i]) continue
        if (startNear && scanlines[i].row !== minRow && scanlines[i].row !== maxRow) continue
        candidates.push(i * 2, i * 2 + 1)
      }
    } else {
      const near = grid.nearestDist(current[0], current[1])
      candidates = near === Infinity ? [] : grid.within(current[0], current[1], near * LIFT_PENALTY + 1e-9)
    }

    for (const id of candidates) {
      const i = id >> 1, r = id & 1
      const seg = scanlines[i]
      const start: Pt2 = r === 0 ? seg.p1 : seg.p2
      const needsLift = current === null || !isTravelSafe(current, start, travelObstacles)
      // Measure from where the tool is, or — before the first pass — from the incoming
      // hint, so the raster opens on the scanline nearest where the last operation
      // finished instead of always at scanlines[0].
      const ref: Pt2 | null = current ?? (startNear ? [startNear.x, startNear.y] : null)
      const dist = ref ? Math.hypot(start[0] - ref[0], start[1] - ref[1]) : 0
      const score = needsLift ? dist * LIFT_PENALTY : dist
      if (bestIdx === -1 || score < bestScore || (Math.abs(score - bestScore) < 1e-6 && dist < bestDist)) {
        bestIdx = i; bestScore = score; bestDist = dist; bestReversed = r === 1; bestNeedsLift = needsLift
      }
    }
    if (bestIdx === -1) break
    used[bestIdx] = true
    grid.remove(bestIdx * 2)
    grid.remove(bestIdx * 2 + 1)
    const seg = scanlines[bestIdx]
    const start: Pt2 = bestReversed ? seg.p2 : seg.p1
    const end: Pt2   = bestReversed ? seg.p1 : seg.p2
    if (bestNeedsLift) {
      if (current !== null) segs.push({ x: current[0], y: current[1], z: safeZ, rapid: true })
      if (rampDistMM !== undefined) {
        // Position rampDist forward along the scanline, then ramp backwards to start.
        // When the tool reaches start it is at full depth; the forward cut to end
        // then re-cuts the ramp section, leaving a clean floor.
        const { touchdown, sampleAt } = rampLeadIn([start, end], true, rampDistMM)
        segs.push({ x: touchdown[0], y: touchdown[1], z: safeZ, rapid: true })
        segs.push({ x: touchdown[0], y: touchdown[1], z: prevZ, rapid: true })
        emitRampDescent(segs, sampleAt, prevZ, zDepth, 12)
        // Tool is now at (start, zDepth); fall through to cut forward to end
      } else {
        segs.push({ x: start[0], y: start[1], z: safeZ, rapid: true })
        segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
      }
    } else {
      if (current) emitCutTransition(segs, current, start, zDepth, toolDiameterMM, safeZ)
      else segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
    }
    segs.push({ x: end[0], y: end[1], z: zDepth, rapid: false })
    current = end
  }
  return current
}

// How far short of the tool-centre limit the raster FILL stops (mm).
//
// A row-to-row link is a straight line between two row ends, and those ends sit ON the
// limit ring — which is a POLYGON, flattened from the drawn curve to POCKET_FLATTEN_TOL_MM.
// A straight line between two points on such a polygon cuts across whatever vertices lie
// between them, by up to that same tolerance. So on any curved wall the link reports as
// leaving the region by a few tens of microns, and `isTravelSafe` — whose RING_EPS_MM is a
// 1 um floating-point tolerance — correctly refuses it. On one real project
// (scratch/ovals.fkam: an ellipse pocket, two elliptical islands, rows at 140 degrees)
// that was 40 retracts for a pocket that needs a handful.
//
// Measured, not assumed: flattening ten times finer (0.05 -> 0.005) took the same file's
// grazes from a median of 35 um to 3 um, so the excursion is the flattening, not the
// curvature — a chord across a convex pocket wall lies INSIDE it and violates nothing.
//
// The answer is not a looser test, which would trade a real gouge for these. It is to move
// the FILL: stopping it short by more than the flattening error means a straight link
// between two row ends cannot reach the limit at all, whatever the wall is doing. The
// sliver that leaves standing against every wall and island is removed by the FINISHING
// CONTOUR that always follows the fill — it cuts at the true limit and sweeps a full tool
// width there, so a margin this size is well inside what it already takes. Nothing reaches
// the finished part, and travel is still judged against the true limit, unchanged.
//
// Four times the flattening tolerance. The sweep on ovals.fkam bears the factor out: 41
// retracts at 0, 22 at 1x, 10 at 2x, 5 at 4x, and no further gain at 6x or 10x — the
// margin has absorbed every chord by then. A link needing more than this is still refused
// and still lifts, so the margin can only ever remove an air move, never add a gouge.
export const LINK_MARGIN_MM = 4 * POCKET_FLATTEN_TOL_MM

export const planRasterPocket: PocketPlanner = (boundary, islands, tool, params): PocketPlan | null => {
  const safeZ = params.safeHeightMM ?? 5
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'climb' // inside cut: climb (M3) = CCW travel
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  // Island obstacles: offset ALL island rings together so that sub-rings from a
  // split self-intersecting path are treated as one compound shape — avoids miter
  // spikes at shared crossing vertices that would otherwise make the finishing
  // contour cut through the original island material.
  //
  // ROUND, because these are the rings TRAVEL is judged against and a round offset is what
  // the tool-centre limit actually is (insetRing's own note says as much). At a convex
  // corner of an island the tool rolls around it on an arc of the offset radius; a miter
  // join squares that corner off, so the ring claims a bite of up to r(sqrt2 - 1) — 1.24 mm
  // on a 6 mm cutter — that the tool can legally cross. Every short hop past an island
  // corner was refused for it. The FILL and the FINISHING rings below are left mitered:
  // those are cut geometry, and changing them would move the toolpath rather than the
  // decision about it.
  const islandFinish = growIslands(islands, toolRadius, JoinType.Round)

  const fillIslands = growIslands(islands, toolRadius + LINK_MARGIN_MM)

  // Raster fill: the tool centre may go anywhere a radius inside the wall — the geometric
  // limit, past which it would gouge.
  //
  // This was a full DIAMETER, which cost the fill a whole tool-width of reach on every
  // wall for no reason other than that the finishing contour would cover it. In an open
  // pocket that is invisible. In a region narrower than two diameters it means no scanline
  // fits at all, so the strategy produces nothing and the region comes out as bare wall
  // passes — a raster pocket that looks like a contour one. Nested outlines are made of
  // exactly such regions, which is why a compound path is where this shows up: even-odd
  // resolves it into bands, and the narrow ones had nothing left to raster.
  //
  // The first scanline still lands half a stepover in from there (generateScanlines starts
  // at minY + spacing/2), so it does not sit on top of the finishing pass.
  // Round for the same reason as the island rings above — mirrored: it is the REFLEX
  // corners of the boundary (the step of an L, the notch of a star) where the true limit is
  // an arc and a miter squares it off.
  const rasterBoundary = insetRing(boundary, toolRadius, JoinType.Round)
  // ...but the FILL stops LINK_MARGIN_MM short of that limit, so that the straight link
  // from the end of one row to the start of the next has room to be straight. Travel is
  // still judged against rasterBoundary — the real limit — so the margin buys clearance
  // for the links instead of loosening the test that guards them.
  // Falling back to the unmargined ring matters in a region only just wider than the
  // cutter: the margin is what tips it from "one scanline fits" to "none does", and a
  // region with no scanlines is machined by its wall passes alone.
  const marginBoundary = insetRing(boundary, toolRadius + LINK_MARGIN_MM)
  const fillBoundary = marginBoundary.length >= 3 ? marginBoundary : rasterBoundary
  const rawScanlines = fillBoundary.length >= 3
    ? generateScanlines(fillBoundary, stepoverMM, params.angle ?? 0)
    : []

  // Clip must happen in the rotated frame where scanlines are axis-aligned.
  // Rotate island exclusions into that frame, clip, then rotate results back.
  const angleRad = (params.angle ?? 0) * Math.PI / 180
  const cosF = Math.cos(-angleRad), sinF = Math.sin(-angleRad)
  const cosB = Math.cos(angleRad),  sinB = Math.sin(angleRad)
  const rotPt = ([x, y]: Pt2, c: number, s: number): Pt2 => [x * c - y * s, x * s + y * c]
  // Clipped at the island's own radius offset, matching the boundary inset above: a
  // scanline may run right up to where the tool would touch the island, and no further.
  // Boxed once here rather than per scanline: the clip below runs one pass per row over
  // every island, and each box is a function of the island alone.
  const islandExclusionsRot: Exclusion[] = fillIslands.map(e => {
    const ring = e.map(p => rotPt(p, cosF, sinF))
    return { ring, box: boxOf(ring) }
  })
  const clippedScanlines = rawScanlines.flatMap(s => {
    const p1r = rotPt(s.p1, cosF, sinF)
    const p2r = rotPt(s.p2, cosF, sinF)
    return clipScanlineAgainstIslands(p1r, p2r, islandExclusionsRot).map(seg => ({
      p1: rotPt(seg.p1, cosB, sinB),
      p2: rotPt(seg.p2, cosB, sinB),
      row: s.row,
    }))
  })

  // TRAVEL — both for the fill's row-to-row links and for the finishing contours — is one
  // question with one answer: may the tool centre get from here to there while staying a
  // radius clear of everything that was drawn? `clearance.ts` answers it exactly, off the
  // boundary and islands themselves, so none of the offset rings above are consulted for
  // it. That is what retired the whole family of travel bugs: an offset ring is a
  // *approximation* of the keep-out, and every one of them lived in the difference.
  //
  // The two obstacle sets that used to differ (the fill's, and the finishing pass's islands
  // grown by a full DIAMETER) collapse into this single one. They were never really two
  // questions: the second was sized for stock the fill had already taken, which made the
  // island's own finishing ring unreachable by construction.
  const travelField = { field: buildPocketClearance(boundary, islands), clearanceMM: toolRadius }
  const finishRing = rasterBoundary
  const rasterTravel: TravelSafetyObstacles = {
    field: travelField,
    edgeObstacles: [finishRing.length >= 3 ? finishRing : boundary, ...islandFinish],
    solidObstacles: islandFinish,
    containment: [finishRing.length >= 3 ? finishRing : boundary],
  }

  // Finishing contours: linked without lifts when safe. Compound inset so a near-wall
  // island pinches instead of swinging the tool through the outer wall.
  const finishRings = compoundFinishRings(boundary, islands, toolRadius, wantCCW)
  const travelObstacles: TravelSafetyObstacles = {
    field: travelField,
    edgeObstacles: [...(finishRing.length >= 3 ? [finishRing] : []), ...islandFinish],
    solidObstacles: islandFinish,
    containment: finishRings,
  }

  return {
    finishRings,
    travelObstacles,
    emitCuts: (z: number, prevZ: number, incomingPos: Pt2 | null, segs: MotionSegment[]) =>
      buildRasterPath(clippedScanlines, rasterTravel, z, segs, incomingPos, rampDist,
        prevZ, safeZ, tool.diameterMM, params.startNear),
  }
}
