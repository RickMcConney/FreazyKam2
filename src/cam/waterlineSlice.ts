// Waterline rings for a FLAT END MILL by slicing the mesh, the way a 3D-printer slicer does.
//
// A flat end mill with its tip at z touches the model wherever some point of the model at
// or above z lies within R of its axis (its bottom is level out to the rim, and anything
// lower than z is under it). So the tip surface stands at or above z exactly over
//
//     shadow(z) grown by R,    shadow(z) = the XY projection of the mesh where Z ≥ z
//
// and the level-z ring is that region's boundary — no surface queries at all. The shadow
// is the union of every triangle clipped to Z ≥ z, projected; going DOWN the levels it
// only grows, so each level is the last one's shadow plus the triangles that reach below
// it. Undersides and overhangs project inside the shadow anyway, so every triangle is
// taken as it comes, whichever way it faces — as `flatDropCutter` tests them.
//
// The region is grown by R + GROW_EXTRA_MM, not R: Clipper's round joins are chords inside
// their arcs (by up to ARC_TOL_MM) and its coordinates are rounded to PRECISION places, and
// a ring a few microns outside the exact one is a ring that never cuts in.

import type { StlModelBounds } from '../importers/svgImporter'
import type { BBox } from '../canvas/selectionUtils'
import { stlToCnc } from './stlMapping'
import { unionD, inflatePathsD, ramerDouglasPeuckerPathsD, FillRule, JoinType, EndType, type PathsD, type PathD } from 'clipper2-ts'

const PRECISION = 4
const ARC_TOL_MM = 0.002
const GROW_EXTRA_MM = 0.003
/** How far the shadow's outline may move when it is simplified for growing. The outline is
 *  a zigzag of clipped triangle edges, every reflex jog of which Clipper's offset loops
 *  back over and then has to resolve; most of the grow's cost. Ramer–Douglas–Peucker keeps
 *  every point of the outline within this of the simplified one, so growing that by this
 *  much more still covers all the shadow does. The shadow itself is kept exact, so nothing
 *  accumulates from one level to the next. */
const SIMPLIFY_MM = 0.002
/** A projected piece with less area than this is a vertical facet: its edges are the
 *  facets beside it. */
const MIN_AREA_MM2 = 1e-9

/** Level z: `region`, where the tip surface stands at or above z (Clipper's winding, not
 *  clipped to any box), and `rings`, its boundary as closed x/y rings with that material on
 *  their RIGHT. Call with z falling; a rise starts the shadow again from the top. */
export type FlatSlicer = (z: number) => { rings: number[][]; region: PathsD }

export function flatWaterlineSlicer(
  positions: Float32Array,
  indices: Uint32Array | null,
  bounds: StlModelBounds,
  bbox: BBox,
  radiusMM: number,
  zOffsetMM = 0,
): FlatSlicer {
  const map = stlToCnc(bounds, bbox, zOffsetMM)
  const triCount = indices ? indices.length / 3 : positions.length / 9
  // Each triangle in CNC mm, and the triangles ordered by their LOWEST corner, highest
  // first: going down the levels, a triangle joins once a level falls below its top and
  // must be re-clipped at each level until the level falls below its bottom.
  const T = new Float64Array(triCount * 9)
  const top = new Float64Array(triCount), bot = new Float64Array(triCount)
  for (let t = 0; t < triCount; t++) {
    let lo = Infinity, hi = -Infinity
    for (let v = 0; v < 3; v++) {
      const i = indices ? indices[t * 3 + v] : t * 3 + v
      const z = map.z(positions[i * 3 + 2])
      T[t * 9 + v * 3] = map.x(positions[i * 3])
      T[t * 9 + v * 3 + 1] = map.y(positions[i * 3 + 1])
      T[t * 9 + v * 3 + 2] = z
      if (z < lo) lo = z
      if (z > hi) hi = z
    }
    top[t] = hi; bot[t] = lo
  }
  const byTop = Array.from({ length: triCount }, (_, t) => t).sort((a, b) => top[b] - top[a])

  let shadow: PathsD = []
  let lastZ = Infinity
  let next = 0                       // byTop[next] is the first triangle not yet reached
  let active: number[] = []          // reached, but reaching below the last level

  return (z: number) => {
    if (z > lastZ) { shadow = []; next = 0; active = []; lastZ = Infinity }
    // Triangles whose top the level has now passed join the active ones.
    while (next < triCount && top[byTop[next]] >= z) active.push(byTop[next++])
    const pieces: PathsD = []
    const still: number[] = []
    for (const t of active) {
      const piece = clipAbove(T, t, z)
      if (piece) pieces.push(piece)
      // Wholly above z, it is in the shadow for good: nothing lower changes it.
      if (bot[t] < z) still.push(t)
    }
    active = still
    lastZ = z
    if (pieces.length) shadow = unionD(shadow, pieces, FillRule.NonZero, PRECISION)
    if (!shadow.length) return { rings: [], region: [] }
    const grown = inflatePathsD(ramerDouglasPeuckerPathsD(shadow, SIMPLIFY_MM), radiusMM + SIMPLIFY_MM + GROW_EXTRA_MM, JoinType.Round, EndType.Polygon, 2, PRECISION, ARC_TOL_MM)
    // Clipper's outers run anticlockwise (Y-up) with the region on their LEFT, its holes
    // clockwise likewise: reversed, the region is on the right of every one.
    const rings = grown.map((path) => {
      const out: number[] = []
      for (let k = path.length - 1; k >= 0; k--) out.push(path[k].x, path[k].y)
      return out
    })
    return { rings, region: grown }
  }
}

/** Triangle t clipped to Z ≥ z and projected, anticlockwise; null if nothing is left of
 *  it (or only a sliver with no area). */
function clipAbove(T: Float64Array, t: number, z: number): PathD | null {
  const o = t * 9
  const out: { x: number; y: number }[] = []
  for (let v = 0; v < 3; v++) {
    const a = o + v * 3, b = o + ((v + 1) % 3) * 3
    const az = T[a + 2], bz = T[b + 2]
    if (az >= z) out.push({ x: T[a], y: T[a + 1] })
    if ((az >= z) !== (bz >= z)) {
      const s = (z - az) / (bz - az)
      out.push({ x: T[a] + (T[b] - T[a]) * s, y: T[a + 1] + (T[b + 1] - T[a + 1]) * s })
    }
  }
  if (out.length < 3) return null
  let area2 = 0
  for (let k = 0; k < out.length; k++) {
    const p = out[k], q = out[(k + 1) % out.length]
    area2 += p.x * q.y - q.x * p.y
  }
  if (Math.abs(area2) < 2 * MIN_AREA_MM2) return null
  // NonZero union: a clockwise piece (a facet facing down) would cancel the winding of an
  // anticlockwise one over it and punch a hole in the shadow.
  if (area2 < 0) out.reverse()
  return out
}
