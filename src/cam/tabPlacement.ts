// Where the Tabs form puts `count` tabs on an outline, as `t` — the arc-length fraction
// along the flattened design path that `designPathAtT` (cam/profile.ts) reads back.
//
// EVENLY SPACED, THEN MOVED OFF THE CORNERS. Each tab gets an equal share of the outline
// and sits in the middle of it. A tab straddling a corner is a poor tab (it holds the part
// by a point, and the lift bends round the corner), so one whose span would reach a sharp
// corner slides along its own straight run until it clears it, and only as far as it must.
//
// This replaced snapping every tab to the middle of the flattened segment it landed on.
// That kept tabs off corners, but on a polygon the segment IS the whole side, so every
// tab on one side snapped to the same point: eight tabs on a square were four pairs
// drawn on top of each other.

import type { Pt2 } from './pathFlattener'

// A vertex is a corner when the outline turns by more than this there. A flattened curve
// turns by only a few degrees per vertex at 0.05 mm, so this finds the drawn corners and
// not the facets of a curve (a 0.5 mm radius arc still turns by under 52° per facet).
const CORNER_DEG = 40
// Room left between a tab's end and a corner, mm.
const CORNER_CLEARANCE_MM = 1

export function tabPositions(subpaths: Pt2[][], count: number, lengthMM: number): number[] {
  if (count <= 0) return []
  const runs = subpaths.map(measure)
  const totalLen = runs.reduce((a, r) => a + r.len, 0)
  if (totalLen < 1e-6) return Array.from({ length: count }, (_, i) => (i + 0.5) / count)

  const clear = lengthMM / 2 + CORNER_CLEARANCE_MM
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const target = ((i + 0.5) / count) * totalLen
    // The subpath the target lands on (the last one takes any rounding overshoot).
    let start = 0, k = 0
    while (k < runs.length - 1 && target > start + runs[k].len) { start += runs[k].len; k++ }
    const local = offCorners(target - start, runs[k], clear)
    out.push((start + local) / totalLen)
  }
  return out
}

interface Measured { len: number; closed: boolean; corners: number[] }

function measure(pts: Pt2[]): Measured {
  const n = pts.length
  const cum = [0]
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const len = cum[n - 1] ?? 0
  const closed = n > 2 && Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) < 1e-6
  const corners: number[] = []
  const cosMax = Math.cos((CORNER_DEG * Math.PI) / 180)
  // A closed outline's first point is a vertex like any other (its last point repeats it).
  const first = closed ? 0 : 1
  for (let i = first; i < n - 1; i++) {
    const prev = closed && i === 0 ? pts[n - 2] : pts[i - 1]
    const ax = pts[i][0] - prev[0], ay = pts[i][1] - prev[1]
    const bx = pts[i + 1][0] - pts[i][0], by = pts[i + 1][1] - pts[i][1]
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
    if (la < 1e-9 || lb < 1e-9) continue
    if ((ax * bx + ay * by) / (la * lb) < cosMax) corners.push(cum[i])
  }
  return { len, closed, corners }
}

// Slide `s` along its straight run until a span of ±`clear` round it touches no corner.
// A run too short to hold the tab clear of both its ends gets the tab at its middle.
function offCorners(s: number, m: Measured, clear: number): number {
  const { len, closed, corners } = m
  if (corners.length === 0 && closed) return s
  // Run boundaries: the corners, plus the two ends of an open path.
  const bounds = closed ? corners : [0, ...corners, len]
  let lo: number, hi: number, ss = s
  if (closed) {
    // Runs wrap: the last corner's run ends at the first corner, one lap on.
    if (ss < bounds[0]) ss += len
    let j = bounds.length - 1
    while (j > 0 && bounds[j] > ss) j--
    lo = bounds[j]
    hi = j + 1 < bounds.length ? bounds[j + 1] : bounds[0] + len
  } else {
    let j = 0
    while (j < bounds.length - 2 && bounds[j + 1] < s) j++
    lo = bounds[j]; hi = bounds[j + 1]
  }
  const placed = hi - lo < 2 * clear ? (lo + hi) / 2 : Math.min(Math.max(ss, lo + clear), hi - clear)
  return closed ? ((placed % len) + len) % len : placed
}

/**
 * One tab where the user clicked, as `t`: the nearest point on the outline to (x, y), moved
 * off a corner the way `tabPositions` moves the evenly spaced ones. Null for an outline with
 * no length.
 */
export function tabTAt(subpaths: Pt2[][], x: number, y: number, lengthMM: number): number | null {
  const runs = subpaths.map(measure)
  const totalLen = runs.reduce((a, r) => a + r.len, 0)
  if (totalLen < 1e-6) return null
  let best = Infinity, bestK = 0, bestS = 0
  subpaths.forEach((pts, k) => {
    let cum = 0
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i]
      const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy)
      if (l < 1e-12) continue
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (l * l)))
      const d = Math.hypot(x - ax - u * dx, y - ay - u * dy)
      if (d < best) { best = d; bestK = k; bestS = cum + u * l }
      cum += l
    }
  })
  let start = 0
  for (let k = 0; k < bestK; k++) start += runs[k].len
  const local = offCorners(bestS, runs[bestK], lengthMM / 2 + CORNER_CLEARANCE_MM)
  return (start + local) / totalLen
}
