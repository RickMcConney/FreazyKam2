// Boolean polygon operations (union, intersection, subtract) using polygon-clipping.
// Paths are flattened to polylines, operated on, then converted back to SVG d strings.

import polygonClipping from 'polygon-clipping'
import { flattenPath } from '../cam/pathFlattener'
import { classifySubpaths, stripClosingDuplicate } from '../cam/geom'

type Pair = [number, number]
type Ring = Pair[]
type GeoPolygon = Ring[]
type GeoMultiPoly = GeoPolygon[]

export type BooleanOpType = 'union' | 'intersect' | 'subtract'

function dToMultiPoly(d: string): GeoMultiPoly {
  const rings = flattenPath(d, 0.05).map(stripClosingDuplicate).filter((r) => r.length >= 3)
  if (rings.length === 0) return []
  // Outer rings and holes by NESTING, not by winding. Telling them apart by sign (CCW outer,
  // CW hole) is right for the app's own shapes and wrong for a font, which winds the other
  // way — Roboto's O is −99 outside, +52 in its counter — so the counter read as a second
  // solid and the outline as a hole with nowhere to go, and every boolean on text came back
  // with its counters filled in. classifySubpaths reads the even-odd structure from the
  // rings themselves (an island in a hole is solid again), as the pocket does.
  return classifySubpaths(rings).map(({ outer, holes }) => [outer, ...holes].map((r) => r.map(([x, y]) => [x, y] as Pair)))
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
