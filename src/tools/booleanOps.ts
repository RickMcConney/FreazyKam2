// Boolean polygon operations (union, intersection, subtract) using polygon-clipping.
// Paths are flattened to polylines, operated on, then converted back to SVG d strings.

import polygonClipping from 'polygon-clipping'
import { flattenPath, signedArea } from '../cam/pathFlattener'
import type { Pt2 } from '../cam/pathFlattener'

type Pair = [number, number]
type Ring = Pair[]
type GeoPolygon = Ring[]
type GeoMultiPoly = GeoPolygon[]

export type BooleanOpType = 'union' | 'intersect' | 'subtract'

function ringFromPts(pts: Pt2[]): Ring | null {
  let ring: Ring = pts.map(([x, y]) => [x, y])
  // Remove closing duplicate if present
  if (ring.length > 1) {
    const [x0, y0] = ring[0]
    const [xl, yl] = ring[ring.length - 1]
    if (Math.abs(x0 - xl) < 1e-6 && Math.abs(y0 - yl) < 1e-6) ring = ring.slice(0, -1)
  }
  return ring.length >= 3 ? ring : null
}

function dToMultiPoly(d: string): GeoMultiPoly {
  const subpaths = flattenPath(d, 0.05)
  const rings: Ring[] = []
  for (const sp of subpaths) {
    const r = ringFromPts(sp)
    if (r) rings.push(r)
  }
  if (rings.length === 0) return []

  // Group rings: outer rings + holes.
  // In CNC Y-up space, CCW = positive area = outer ring, CW = negative = hole.
  // For polygon-clipping we need to group holes under their containing outer ring.
  // Simple approach: each ring that is "outer" (or whose sign doesn't obviously indicate a hole)
  // becomes its own single-ring Polygon. Holes are appended to the nearest outer polygon.
  const polygons: GeoPolygon[] = []
  const outerRings: { ring: Ring; area: number; polyIdx: number }[] = []

  for (const ring of rings) {
    const area = signedArea(ring)
    if (area > 0) {
      // CCW = outer ring
      const polyIdx = polygons.length
      polygons.push([ring])
      outerRings.push({ ring, area, polyIdx })
    } else {
      // CW = hole — find smallest outer ring that contains this hole
      let bestIdx = -1
      let bestArea = Infinity
      const [hx, hy] = ring[0]
      for (const { ring: outer, area: oa, polyIdx } of outerRings) {
        if (oa < bestArea && ptInRing(hx, hy, outer)) {
          bestArea = oa
          bestIdx = polyIdx
        }
      }
      if (bestIdx >= 0) {
        polygons[bestIdx].push(ring)
      } else {
        // No outer ring found — treat as outer (reversed)
        polygons.push([ring])
      }
    }
  }

  return polygons
}

function ptInRing(px: number, py: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function multiPolyToD(mp: GeoMultiPoly): string {
  return mp.flatMap(poly =>
    poly.map(ring => {
      if (ring.length < 3) return ''
      const parts: string[] = [`M ${ring[0][0].toFixed(4)} ${ring[0][1].toFixed(4)}`]
      for (let i = 1; i < ring.length; i++) {
        parts.push(`L ${ring[i][0].toFixed(4)} ${ring[i][1].toFixed(4)}`)
      }
      parts.push('Z')
      return parts.join(' ')
    })
  ).filter(Boolean).join(' ')
}

export function applyBooleanOp(
  type: BooleanOpType,
  ds: string[]
): { resultD: string } | { error: string } {
  if (ds.length < 2) return { error: 'Select at least 2 paths' }

  try {
    const multiPolys: GeoMultiPoly[] = ds.map(dToMultiPoly)
    if (multiPolys.some(mp => mp.length === 0)) {
      return { error: 'One or more paths contain no valid geometry' }
    }

    const [subject, ...clips] = multiPolys
    let result: GeoMultiPoly

    if (type === 'union') {
      result = polygonClipping.union(subject as Parameters<typeof polygonClipping.union>[0], ...clips as Parameters<typeof polygonClipping.union>[0][])
    } else if (type === 'intersect') {
      result = polygonClipping.intersection(subject as Parameters<typeof polygonClipping.union>[0], ...clips as Parameters<typeof polygonClipping.union>[0][])
    } else {
      result = polygonClipping.difference(subject as Parameters<typeof polygonClipping.union>[0], ...clips as Parameters<typeof polygonClipping.union>[0][])
    }

    if (result.length === 0) return { error: 'Boolean operation produced empty result (paths may not overlap)' }
    return { resultD: multiPolyToD(result) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Boolean operation failed' }
  }
}
