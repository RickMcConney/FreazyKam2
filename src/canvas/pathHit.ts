import { useCallback, useEffect, useRef } from 'react'
import { ptSegDistSq, pointInPolygon } from '../cam/geom'
import { flattenPath } from '../cam/pathFlattener'
import { getBBox, type BBox } from './selectionUtils'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'

// ── Path proximity helpers ────────────────────────────────────────────────────
// DesignLayer is listening={false}: a click on a path is not a Konva hit-test but a
// proximity search through these.

// A path participates in canvas hit-tests/snaps only when it's actually drawn.
// `hidden` paths (soft-hidden by boolean ops) render nowhere, so they must not
// be clickable, editable, weldable, or snappable (bugs.md B1).
export const onCanvas = (p: ImportedPath) => p.visible && !p.hidden

export type FlatOf = (p: ImportedPath, tol: number) => [number, number][][]

function distToPolylines(px: number, py: number, polys: [number, number][][]): number {
  let minSq = Infinity
  for (const poly of polys) {
    for (let i = 1; i < poly.length; i++) {
      const [ax, ay] = poly[i - 1], [bx, by] = poly[i]
      const d = ptSegDistSq(px, py, ax, ay, bx, by)
      if (d < minSq) minSq = d
    }
  }
  return Math.sqrt(minSq)
}

// Each path's exact box, by path OBJECT (paths are replaced, never mutated).
const boxOf = new WeakMap<ImportedPath, BBox | null>()
function pathBox(p: ImportedPath): BBox | null {
  let b = boxOf.get(p)
  if (b === undefined) { b = getBBox(p.d); boxOf.set(p, b) }
  return b
}

// Slack on the box test: the flattened points lie ON the curve, so inside its exact box,
// but they are computed separately and may sit a few ulps outside it.
const BOX_SLACK_MM = 1e-6

export function closestVisiblePath(
  px: number, py: number,
  paths: ImportedPath[],
  thresholdMM: number,
  getPolys: (p: ImportedPath) => [number, number][][],
): ImportedPath | null {
  let best: ImportedPath | null = null
  let bestDist = thresholdMM
  for (const p of paths) {
    // The polylines lie inside the path's box, so the distance to the box is a lower
    // bound: a path whose box is no nearer than the best so far cannot win (the test
    // below is strict), and is skipped without walking — or flattening — it. On a nest
    // this was every segment of every path per press and per tab-placing hover frame.
    const b = pathBox(p)
    if (b) {
      const dx = Math.max(b.minX - px, 0, px - b.maxX)
      const dy = Math.max(b.minY - py, 0, py - b.maxY)
      if (Math.hypot(dx, dy) - BOX_SLACK_MM >= bestDist) continue
    }
    const dist = distToPolylines(px, py, getPolys(p))
    if (dist < bestDist) { bestDist = dist; best = p }
  }
  return best
}

// The topmost image whose picture lies under the point. An image is a solid thing on
// screen, so a click anywhere on it takes it — not only within reach of its frame, as an
// outline needs. Asked only after no outline is near, so a trace lying over its picture
// still picks by its own lines.
export function imageUnder(
  px: number, py: number,
  paths: ImportedPath[],
  getPolys: (p: ImportedPath) => [number, number][][],
): ImportedPath | null {
  for (let i = paths.length - 1; i >= 0; i--) {
    const p = paths[i]
    if (p.imageSrc && getPolys(p).some((poly) => pointInPolygon(px, py, poly))) return p
  }
  return null
}

/** Flattened polylines per path for hit-testing and vertex snap. */
export function useFlatCache(): FlatOf {
  // Flattened-polyline cache for hit-testing/vertex-snap, keyed by path id and
  // invalidated when the path's d changes. (The old cache keyed on the full d
  // string never evicted, so every baked transform grew it — tofix.md H2.)
  const flatCacheRef = useRef(new Map<string, { d: string; byTol: Map<number, [number, number][][]> }>())
  const getFlat = useCallback((p: ImportedPath, tol: number): [number, number][][] => {
    const cache = flatCacheRef.current
    let entry = cache.get(p.id)
    if (!entry || entry.d !== p.d) {
      entry = { d: p.d, byTol: new Map() }
      cache.set(p.id, entry)
    }
    let polys = entry.byTol.get(tol)
    if (!polys) {
      polys = flattenPath(p.d, tol)
      entry.byTol.set(tol, polys)
    }
    return polys
  }, [])

  // Drop cache entries for paths that no longer exist (updates are already
  // replaced in place by the id+d check in getFlat).
  const paths = usePathsStore((s) => s.paths)
  useEffect(() => {
    const cache = flatCacheRef.current
    if (cache.size === 0) return
    const live = new Set(paths.map((p) => p.id))
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id)
  }, [paths])

  return getFlat
}
