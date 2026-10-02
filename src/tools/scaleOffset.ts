// "Keep shape" offset: the same outline, scaled until the AVERAGE gap between it and
// the original is the distance asked for.
//
// An exact offset moves every point the same distance, and that changes the
// proportions — a heart's lobes fatten and its notch fills in going out, the notch
// opens and the lobes go round coming in. No corner style fixes that, because the
// corners are not where the shape changes. Scaling keeps the shape exactly, at the
// price of the gap no longer being constant, so the result reports the smallest and
// largest gap it actually left: the distance is an average, and must never be
// mistaken for an exact offset (inlay clearance, a cut's gap — those are Offset's job).
//
// ONE scale for the whole path, about its AREA centroid, holes included: a heart with
// a hole keeps the hole in proportion rather than giving it a border of its own. The
// centroid rather than the bbox centre, because a heart's bulk sits above its bbox
// centre and scaling about the bbox centre leaves the border visibly lopsided.

import { flattenPath, signedArea } from '../cam/pathFlattener'
import { interiorPoint, pointInPolygon, ptSegDistSq } from '../cam/geom'
import { scaleAroundD } from '../canvas/selectionUtils'

type Pt = [number, number]

// The outline is flattened at this tolerance to be measured, so a spread of gaps within it
// is the flattening, not the shape: a circle — the one shape scaling offsets EXACTLY —
// measures up to ~0.02 mm of spread on an inset.
const FLATTEN_TOL_MM = 0.05

/** True when the gap a keep-shape offset left is the same everywhere, to within what the
 *  measurement can tell apart — a circle, scaled, is an exact offset. */
export function isExactGap(minGapMM: number, maxGapMM: number): boolean {
  return maxGapMM - minGapMM <= FLATTEN_TOL_MM
}

export interface ScaleOffsetResult {
  d: string
  scale: number
  /** The pivot the outline was scaled about — the area centroid, holes subtracted. */
  cx: number
  cy: number
  /** The gap actually left, smallest and largest, measured from the original. */
  minGapMM: number
  maxGapMM: number
}

/** Area centroid of a set of rings, a ring nested in an odd number of others being a hole. */
export function areaCentroid(rings: Pt[][]): Pt | null {
  let sa = 0, sx = 0, sy = 0
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]
    if (r.length < 3) continue
    const inner = interiorPoint([r])
    const depth = inner ? rings.filter((o, j) => j !== i && o.length >= 3 && pointInPolygon(inner[0], inner[1], o)).length : 0
    const sign = depth % 2 === 0 ? 1 : -1
    // Shoelace centroid; |A| with the ring's own sign of travel taken out, so winding
    // direction does not matter — only nesting does.
    const a = signedArea(r)
    if (a === 0) continue
    let cx = 0, cy = 0
    for (let k = 0; k < r.length; k++) {
      const [x0, y0] = r[k], [x1, y1] = r[(k + 1) % r.length]
      const cr = x0 * y1 - x1 * y0
      cx += (x0 + x1) * cr
      cy += (y0 + y1) * cr
    }
    cx /= 6 * a; cy /= 6 * a
    const w = sign * Math.abs(a)
    sa += w; sx += w * cx; sy += w * cy
  }
  return sa > 1e-12 ? [sx / sa, sy / sa] : null
}

/** Points every `step` mm of arc length along each ring, closing segment included —
 *  evenly spaced however finely the flattener cut the curve, so the mean is a mean over
 *  the outline and not over wherever the flattener put its points. */
function resample(rings: Pt[][], step: number): Pt[] {
  const out: Pt[] = []
  for (const r of rings) {
    let toNext = 0
    for (let k = 0; k < r.length; k++) {
      const [ax, ay] = r[k], [bx, by] = r[(k + 1) % r.length]
      const len = Math.hypot(bx - ax, by - ay)
      let t = toNext
      while (t < len) {
        out.push([ax + (bx - ax) * t / len, ay + (by - ay) * t / len])
        t += step
      }
      toNext = t - len
    }
  }
  return out
}

/** Distance from each sample to the nearest edge of the rings scaled by `s` about `c`. */
function gaps(samples: Pt[], rings: Pt[][], c: Pt, s: number): number[] {
  const scaled = rings.map((r) => r.map(([x, y]): Pt => [c[0] + (x - c[0]) * s, c[1] + (y - c[1]) * s]))
  return samples.map(([px, py]) => {
    let best = Infinity
    for (const r of scaled) {
      for (let k = 0; k < r.length; k++) {
        const a = r[k], b = r[(k + 1) % r.length]
        const d2 = ptSegDistSq(px, py, a[0], a[1], b[0], b[1])
        if (d2 < best) best = d2
      }
    }
    return Math.sqrt(best)
  })
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * The outline scaled so the mean gap to the original is `|distanceMM|` — larger for a
 * positive distance, smaller for a negative one. Null when there is no area to scale
 * about, or an inset larger than the shape can shrink by.
 */
export function applyScaleOffset(d: string, distanceMM: number): ScaleOffsetResult | null {
  const rings = flattenPath(d, FLATTEN_TOL_MM).filter((r) => r.length >= 3) as Pt[][]
  const c = areaCentroid(rings)
  if (!c) return null
  if (distanceMM === 0) return { d, scale: 1, cx: c[0], cy: c[1], minGapMM: 0, maxGapMM: 0 }

  // ~400 samples whatever the size: plenty for a mean, cheap enough to solve on every Apply.
  let perimeter = 0
  for (const r of rings) for (let k = 0; k < r.length; k++) {
    const a = r[k], b = r[(k + 1) % r.length]
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  const samples = resample(rings, Math.max(perimeter / 400, 1e-3))
  const target = Math.abs(distanceMM)
  const meanAt = (s: number) => mean(gaps(samples, rings, c, s))

  // The mean gap grows as the scale moves away from 1, so bisect on the scale.
  let lo: number, hi: number
  if (distanceMM > 0) {
    lo = 1; hi = 2
    for (let i = 0; i < 30 && meanAt(hi) < target; i++) { lo = hi; hi *= 2 }
    if (meanAt(hi) < target) return null
  } else {
    // Shrunk all the way to its centroid, the gap is the outline's mean distance to that
    // point; an inset beyond it cannot be reached by scaling.
    if (meanAt(0) <= target) return null
    lo = 0; hi = 1
  }
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    const far = meanAt(mid) >= target
    // Outward the gap rises with the scale; inward it rises as the scale falls.
    if (distanceMM > 0 ? far : !far) hi = mid; else lo = mid
  }
  const scale = (lo + hi) / 2
  const g = gaps(samples, rings, c, scale)
  return {
    d: scaleAroundD(d, c[0], c[1], scale, scale),
    scale, cx: c[0], cy: c[1],
    minGapMM: Math.min(...g), maxGapMM: Math.max(...g),
  }
}
