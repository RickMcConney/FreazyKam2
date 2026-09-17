// Spiral morphing for the pocket "spiral" strategy.
//
// Given a set of nested offset loops (the same concentric rings the `contour`
// strategy cuts, spaced one stepover apart), this builds a single continuous
// curvilinear spiral by linearly interpolating between corresponding points of
// adjacent loops — the morph of Bieterman's curvilinear-spiral method
// (Leroy et al. 2024, eq. 11), but seeded from Clipper offset rings instead of
// the isotherms of a solved temperature field.
//
// All geometry is CNC mm, Y-up (same space as ImportedPath.d and every other
// toolpath stage). Winding of the input loops is preserved, so the caller picks
// climb/conventional upstream and we never flip it.

import { stripClosingDuplicate, pointInPolygon } from './geom'
import { type Pt2 } from './pathFlattener'

function ringPerimeter(loop: Pt2[]): number {
  let p = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    p += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return p
}

// Resample a closed loop to exactly `n` points equally spaced by arc length.
// The first sample is the point whose direction from `center` is nearest
// `refAngle` (radians) — this keeps the once-per-revolution seam of the spiral
// radial and consistent across loops, which is what makes the point-to-point
// morph between adjacent loops line up instead of twisting.
//
// Traversal direction (winding) is preserved from the input loop.
function resampleLoop(loop: Pt2[], n: number, center: Pt2, refAngle: number): Pt2[] {
  const ring = stripClosingDuplicate(loop)
  if (ring.length < 2) {
    // Degenerate (collapsed) loop — emit n copies of the single point so the
    // morph still has a partner of matching length.
    const p: Pt2 = ring.length ? ring[0] : center
    return Array.from({ length: n }, () => [p[0], p[1]] as Pt2)
  }

  // Cumulative arc length around the closed ring (wrapping back to the start).
  const m = ring.length
  const cum: number[] = new Array(m + 1)
  cum[0] = 0
  for (let i = 0; i < m; i++) {
    const a = ring[i], b = ring[(i + 1) % m]
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  const total = cum[m]
  if (total < 1e-9) {
    const p = ring[0]
    return Array.from({ length: n }, () => [p[0], p[1]] as Pt2)
  }

  // Choose the start vertex nearest the reference angle.
  let startIdx = 0
  let bestDelta = Infinity
  for (let i = 0; i < m; i++) {
    const ang = Math.atan2(ring[i][1] - center[1], ring[i][0] - center[0])
    let d = Math.abs(ang - refAngle)
    if (d > Math.PI) d = 2 * Math.PI - d
    if (d < bestDelta) { bestDelta = d; startIdx = i }
  }
  const startS = cum[startIdx]

  // Walk arc length from startS in the loop's own direction, sampling n points.
  const out: Pt2[] = []
  let seg = 0
  for (let k = 0; k < n; k++) {
    let s = startS + (k * total) / n
    if (s >= total) s -= total
    // Advance the segment cursor to the edge containing arc length s.
    while (cum[seg + 1] < s) seg++
    while (seg > 0 && cum[seg] > s) seg--
    const a = ring[seg % m], b = ring[(seg + 1) % m]
    const segLen = cum[seg + 1] - cum[seg]
    const t = segLen > 1e-12 ? (s - cum[seg]) / segLen : 0
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
  }
  return out
}

// Pick a sample count per revolution from the largest loop's perimeter so the
// outer (longest) turn meets the chord tolerance; inner turns are oversampled,
// which is harmless. Clamped to keep segment counts sane.
function spiralSampleCount(loops: Pt2[][], chordToleranceMM: number): number {
  let maxPerim = 0
  for (const l of loops) maxPerim = Math.max(maxPerim, ringPerimeter(l))
  const n = Math.round(maxPerim / Math.max(0.05, chordToleranceMM))
  return Math.max(48, Math.min(1024, n))
}

function distToBoundary(px: number, py: number, poly: Pt2[]): number {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    let t = l2 > 1e-12 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = px - (a[0] + t * dx), ey = py - (a[1] + t * dy)
    best = Math.min(best, Math.hypot(ex, ey))
  }
  return best
}

// Inscribed circle (pole of inaccessibility): the interior point farthest from
// the loop boundary, and that distance. Grid search with one refinement pass —
// the innermost loops this runs on are small and simple. Unlike the centroid,
// this point is always strictly inside, even for a non-convex (e.g. L-shaped)
// loop whose centroid falls outside the material.
function inscribedCircle(loop: Pt2[]): { center: Pt2; radius: number } {
  const ring = stripClosingDuplicate(loop)
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const [x, y] of ring) {
    if (x < minx) minx = x; if (x > maxx) maxx = x
    if (y < miny) miny = y; if (y > maxy) maxy = y
  }
  let best: Pt2 = centroidOf(ring)
  let bestR = pointInPolygon(best[0], best[1], ring) ? distToBoundary(best[0], best[1], ring) : -1
  let lo: Pt2 = [minx, miny], hi: Pt2 = [maxx, maxy]
  for (let pass = 0; pass < 2; pass++) {
    const cells = 16
    const sx = (hi[0] - lo[0]) / cells, sy = (hi[1] - lo[1]) / cells
    for (let i = 0; i <= cells; i++) {
      for (let j = 0; j <= cells; j++) {
        const px = lo[0] + i * sx, py = lo[1] + j * sy
        if (!pointInPolygon(px, py, ring)) continue
        const d = distToBoundary(px, py, ring)
        if (d > bestR) { bestR = d; best = [px, py] }
      }
    }
    // Refine in a window around the current best.
    lo = [best[0] - sx, best[1] - sy]
    hi = [best[0] + sx, best[1] + sy]
  }
  return { center: best, radius: Math.max(0, bestR) }
}

function shoelace(loop: Pt2[]): number {
  let a = 0
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

// Rotate `cur`'s index origin to the cyclic shift that best lines it up with
// `prev` (minimum summed squared distance over a coarse set of samples, then a
// local refinement). Both arrays are the same length n. Registering each loop to
// the previous one this way makes corresponding indices land at the same place
// radially, so the index-based morph connects neighbours instead of crossing the
// shape — essential on non-convex loops (an L) where a fixed reference ray does
// not put inner and outer index-0 in the same spot.
function alignToPrev(prev: Pt2[], cur: Pt2[]): Pt2[] {
  const n = cur.length
  if (n === 0) return cur
  const m = Math.min(n, 48)
  const probe = (s: number): number => {
    let cost = 0
    for (let i = 0; i < m; i++) {
      const pi = Math.round((i * n) / m) % n
      const a = prev[pi], b = cur[(pi + s) % n]
      const dx = a[0] - b[0], dy = a[1] - b[1]
      cost += dx * dx + dy * dy
    }
    return cost
  }
  const stride = Math.max(1, Math.floor(n / 180))
  let bestS = 0, bestCost = Infinity
  for (let s = 0; s < n; s += stride) {
    const c = probe(s)
    if (c < bestCost) { bestCost = c; bestS = s }
  }
  for (let s = Math.max(0, bestS - stride); s <= bestS + stride; s++) {
    const ss = ((s % n) + n) % n
    const c = probe(ss)
    if (c < bestCost) { bestCost = c; bestS = ss }
  }
  return bestS === 0 ? cur : [...cur.slice(bestS), ...cur.slice(0, bestS)]
}

// Build one continuous outward spiral from a chain of nested loops.
//
// `loopsInnerToOuter` must be ordered innermost → outermost and already wound to
// the caller's climb/conventional choice. Each loop is resampled and then
// registered to the previous one (alignToPrev) so the morph between them tiles
// cleanly even when the loops are non-convex. The spiral traces the innermost
// loop, then morphs each loop into the next over one full revolution so the
// radius grows ~one stepover per turn with no retracts. Winding is inherited
// from the loops throughout, so there is never a direction reversal.
//
// `seedCenter` (a leaf chain only) clears the disk left inside the innermost
// loop. It is done by prepending shrunk copies of that loop — scaled toward its
// inscribed-circle centre, one stepover apart — and spiralling through them like
// any other loops. Scaling *inward* keeps every point inside the shape, so the
// centre fill never cuts across a concave corner (a point-to-loop seed does).
// It runs only when the innermost loop is a genuinely round, tool-wide disk
// (inscribed radius > tool radius AND nearly that disk's area); an elongated or
// non-convex innermost loop (an L sliver) is simply traced and left with at most
// a tiny nub, never a cross-corner gouge.
export function morphChainToSpiral(
  loopsInnerToOuter: Pt2[][],
  chordToleranceMM: number,
  stepoverMM: number,
  toolRadiusMM: number,
  seedCenter: boolean,
  // Fraction of each revolution over which the step to the next loop is spread.
  // 0.25 (offset spiral) keeps most of the loop exactly on-contour for coverage on
  // extent-mismatched loops, at the cost of an engagement spike in the seam window.
  // 1.0 (field spiral) spreads the step over the whole revolution — constant ~one
  // stepover engagement — which is safe when consecutive loops are near-concentric.
  transitionFrac = 0.25,
): Pt2[] {
  const base = loopsInnerToOuter.filter(l => stripClosingDuplicate(l).length >= 2)
  if (base.length === 0) return []

  const insc = inscribedCircle(base[0])
  const center = insc.center

  // Centre fill: shrunk copies of the innermost loop, only when it is round.
  const areaAbs = Math.abs(shoelace(stripClosingDuplicate(base[0])))
  const round = insc.radius > toolRadiusMM && areaAbs < 1.5 * Math.PI * insc.radius * insc.radius
  const fill: Pt2[][] = []
  if (seedCenter && round) {
    for (let rr = toolRadiusMM; rr < insc.radius - 1e-3; rr += stepoverMM) {
      const s = rr / insc.radius
      fill.push(base[0].map(p => [center[0] + s * (p[0] - center[0]), center[1] + s * (p[1] - center[1])] as Pt2))
    }
  }
  const loops = [...fill, ...base]   // innermost (smallest fill) → outermost

  const refAngle = 0
  const n = spiralSampleCount(loops, chordToleranceMM)

  // Resample, then chain-register each loop to the previous for clean morphing.
  const sampled: Pt2[][] = []
  for (let i = 0; i < loops.length; i++) {
    const s = resampleLoop(loops[i], n, center, refAngle)
    sampled.push(i === 0 ? s : alignToPrev(sampled[i - 1], s))
  }

  // Trace every loop almost all the way round (staying exactly on the contour, so
  // coverage equals the contour strategy's), then step out to the next loop only
  // within a small seam window. Blending over the whole revolution instead — the
  // pure Bieterman morph — rides between the loops and never reaches features
  // where consecutive loops differ in extent (a rounded arm tip), leaving a gap.
  const L = sampled.length
  const jWin = transitionFrac >= 1 ? 0 : Math.max(1, Math.floor((1 - transitionFrac) * n))

  const spiral: Pt2[] = []
  for (let k = 0; k < L; k++) {
    const cur = sampled[k]
    const nxt = k < L - 1 ? sampled[k + 1] : null
    const startJ = k === 0 ? 0 : 1            // avoid re-emitting the shared seam point
    for (let j = startJ; j <= n; j++) {
      const idx = j % n
      if (nxt && j > jWin) {
        const t = (j - jWin) / (n - jWin)     // 0→1 across the seam window
        spiral.push([
          cur[idx][0] + t * (nxt[idx][0] - cur[idx][0]),
          cur[idx][1] + t * (nxt[idx][1] - cur[idx][1]),
        ])
      } else {
        spiral.push([cur[idx][0], cur[idx][1]])
      }
    }
  }
  // Fillet the sharp concave-corner turns the round-join offsets leave behind.
  return roundSharpCorners(spiral, 2, toolRadiusMM * 0.5)
}

// Round only the sharp turns of an open polyline with Chaikin-style corner cuts.
// Inward Clipper offsets round convex corners (Round join) but leave the L's
// concave corner as a sharp convex vertex of the tool path; this fillets those.
// Smooth (already-rounded) vertices are left untouched, so the point count grows
// only at the few sharp corners. Endpoints are preserved. `maxCutMM` caps how far
// a cut may pull in from a vertex so the fillet radius stays bounded.
function roundSharpCorners(pts: Pt2[], iterations: number, maxCutMM: number): Pt2[] {
  let cur = pts
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) return cur
    const out: Pt2[] = [cur[0]]
    for (let i = 1; i < cur.length - 1; i++) {
      const a = cur[i - 1], p = cur[i], b = cur[i + 1]
      const v1x = p[0] - a[0], v1y = p[1] - a[1]
      const v2x = b[0] - p[0], v2y = b[1] - p[1]
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y)
      const cos = l1 > 1e-9 && l2 > 1e-9 ? (v1x * v2x + v1y * v2y) / (l1 * l2) : 1
      if (cos < 0.8) {                 // turn sharper than ~37° → fillet it
        const f1 = Math.min(0.25, maxCutMM / Math.max(l1, 1e-9))
        const f2 = Math.min(0.25, maxCutMM / Math.max(l2, 1e-9))
        out.push([p[0] - v1x * f1, p[1] - v1y * f1])
        out.push([p[0] + v2x * f2, p[1] + v2y * f2])
      } else {
        out.push(p)
      }
    }
    out.push(cur[cur.length - 1])
    cur = out
  }
  return cur
}

function centroidOf(loop: Pt2[]): Pt2 {
  const ring = stripClosingDuplicate(loop)
  let area2 = 0, cx = 0, cy = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % ring.length]
    const cross = x0 * y1 - x1 * y0
    area2 += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross
  }
  if (Math.abs(area2) < 1e-9) {
    const s = ring.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as Pt2, [0, 0] as Pt2)
    return [s[0] / ring.length, s[1] / ring.length]
  }
  return [cx / (3 * area2), cy / (3 * area2)]
}
