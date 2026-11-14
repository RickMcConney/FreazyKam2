// Which drawn paths can bound a 3D Profile: the ones that completely enclose the model,
// tightest first, a few at most — the rest of a drawing (part outlines, text, a gear) is
// not a boundary for this model and only crowds the list.
import { flattenPath, isOpenSubpath, signedArea } from './pathFlattener'
import { pointInPolygon } from './geom'
import { getBBox } from '../canvas/selectionUtils'
import { tabOutline } from './stlOutline'
import type { ImportedPath } from '../store/pathsStore'

/**
 * The paths that enclose `stl` completely — an STL's outline seen from above, a picture's
 * box — in order of how closely they fit, the smallest area round it first, at most `max`.
 *
 * By points, no polygon booleans: this runs whenever the form re-renders. A path encloses
 * the box when all four of its corners are inside the path (even–odd over its subpaths, so
 * a hole counts as outside) AND no segment of the path passes through the box. The corners
 * alone would pass a C whose notch bites into the model between two corners, and a ring
 * whose hole is over the middle of it; testing segments rather than points also catches a
 * straight-sided slot right across the box, which has no point inside it.
 */
export function enclosingBoundaries(paths: ImportedPath[], stl: ImportedPath, max = 3): ImportedPath[] {
  const box = getBBox(stl.d)
  if (!box) return []
  // AN STL IS ENCLOSED BY ITS OUTLINE, NOT ITS BOX (cam/stlOutline): a circle drawn round a
  // round model leaves the box's corners outside it, and was never offered. The same two
  // tests, against the silhouette's points and edges.
  const outline = stl.stlSrc && stl.stlModelBounds ? tabOutline(stl).filter((r) => r.length >= 3) : []
  const corners: [number, number][] = outline.length
    ? outline.flat()
    : [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]]
  const boxArea = outline.length ? outline.reduce((a, r) => a + Math.abs(signedArea(r)), 0) : box.width * box.height
  const crosses = outline.length
    ? (a: [number, number], b: [number, number]) => crossesRings(a, b, outline, box)
    : (a: [number, number], b: [number, number]) => crossesBox(a, b, box)
  const fits: { path: ImportedPath; margin: number }[] = []
  for (const p of paths) {
    if (p.id === stl.id || p.stlSrc || p.imageSrc) continue
    const rings = flattenPath(p.d, 0.05).filter((r) => r.length >= 2)
    if (!rings.length || rings.some(isOpenSubpath)) continue
    const inside = (x: number, y: number) => rings.reduce((n, r) => n + (pointInPolygon(x, y, r) ? 1 : 0), 0) % 2 === 1
    if (!corners.every(([x, y]) => inside(x, y))) continue
    if (rings.some((r) => r.some((a, k) => k > 0 && crosses(r[k - 1], a)))) continue
    // Even–odd area: outers less holes.
    let area = 0
    for (const r of rings) area += Math.abs(signedArea(r)) * (rings.some((o) => o !== r && pointInPolygon(r[0][0], r[0][1], o)) ? -1 : 1)
    fits.push({ path: p, margin: area - boxArea })
  }
  return fits.sort((a, b) => a.margin - b.margin).slice(0, max).map((f) => f.path)
}

/** Whether segment a–b crosses an edge of any ring (none can outside the rings' box). */
function crossesRings(a: [number, number], b: [number, number], rings: [number, number][][], box: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  if (Math.max(a[0], b[0]) < box.minX || Math.min(a[0], b[0]) > box.maxX || Math.max(a[1], b[1]) < box.minY || Math.min(a[1], b[1]) > box.maxY) return false
  const side = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  for (const ring of rings) {
    for (let k = 1; k < ring.length; k++) {
      const c = ring[k - 1], d = ring[k]
      if (side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0) return true
    }
  }
  return false
}

/** Whether segment a–b passes through the box's open interior (Liang–Barsky). */
function crossesBox(a: [number, number], b: [number, number], box: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  let t0 = 0, t1 = 1
  for (const [p, q] of [[-dx, a[0] - box.minX], [dx, box.maxX - a[0]], [-dy, a[1] - box.minY], [dy, box.maxY - a[1]]]) {
    if (p === 0) { if (q <= 0) return false; continue }
    const r = q / p
    if (p < 0) { if (r > t0) t0 = r } else if (r < t1) t1 = r
    if (t0 >= t1) return false
  }
  return true
}
