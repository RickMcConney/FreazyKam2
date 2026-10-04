// Drop-cutter for a ball nose against the model's own triangles.
//
// The 3D profile's grid stores the highest point in each cell, which is what keeps it
// from gouging — and also why it leaves stock: on a 70° wall it reads as much as 0.16 mm
// high, the same for every finishing strategy, which hides the difference between them.
// Dropping the ball straight down onto the triangles answers the question exactly: the
// lowest tip height at (x, y) at which the ball touches no triangle. It is the maximum of
// three tests over every triangle within reach —
//
//   VERTEX  the ball's surface resting on a corner:   tip = vz − f(d)
//   FACET   the ball tangent to the triangle's plane, at a point inside the triangle
//   EDGE    the ball tangent to the edge's line, at a point inside the edge
//
// — where f(d) = R − √(R² − d²) is how far above its tip the ball's surface is at
// horizontal distance d. A triangle facing down is tested as if from above: the ball
// coming down onto it from above is still a constraint, and a closed model's undersides
// are always below its top.
//
// The STL → CNC mapping is `stlToCnc`, the one `buildHeightMap` uses.
//
// SPEED. Every finishing point is one query, so this is the cost of a 3D finish. The
// vertices and edges are DEDUPED (a closed mesh shares each vertex among ~6 triangles and
// each edge between 2, and every copy used to be tested), everything per-triangle is
// precomputed, and each bucket holds its features sorted HIGHEST FIRST: no feature can lift
// the tool above its own highest point, so a bucket is abandoned at the first feature that
// stands no higher than the best answer so far.

import type { StlModelBounds } from '../importers/svgImporter'
import type { BBox } from '../canvas/selectionUtils'
import { stlToCnc } from './stlMapping'

/** The most buckets the features are filed in. */
const MAX_BUCKETS = 1_000_000

export function ballDropCutter(
  positions: Float32Array,
  indices: Uint32Array | null,
  bounds: StlModelBounds,
  bbox: BBox,
  radiusMM: number,
  /** How far below the stock top the model's highest point sits. */
  zOffsetMM = 0,
): (x: number, y: number) => number | null {
  const R = radiusMM, R2 = R * R
  const map = stlToCnc(bounds, bbox, zOffsetMM)

  // ── Unique vertices ──
  const triCount = indices ? indices.length / 3 : positions.length / 9
  const vertId = new Int32Array(triCount * 3)
  const VX: number[] = [], VY: number[] = [], VZ: number[] = []
  {
    // Equal coordinates are one vertex (−0 and 0 included). Hashed on the float bits, not on
    // a string of them — a string per corner was most of the setup on a large mesh — with
    // ids handed out in first-seen order, so every edge keeps the same endpoint order.
    const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length)
    const b = (k: number) => bits[k] === 0x80000000 ? 0 : bits[k]
    const byHash = new Map<number, number>()      // hash → first vertex id with it
    const chain: number[] = []                    // vertex id → next id with the same hash
    const srcOf: number[] = []                    // vertex id → its position index
    for (let t = 0; t < triCount; t++) {
      for (let v = 0; v < 3; v++) {
        const i = indices ? indices[t * 3 + v] : t * 3 + v
        const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2]
        const h = (Math.imul(b(i * 3), 73856093) ^ Math.imul(b(i * 3 + 1), 19349663) ^ Math.imul(b(i * 3 + 2), 83492791)) >>> 0
        let id = byHash.get(h) ?? -1
        while (id >= 0) {
          const q = srcOf[id] * 3
          if (positions[q] === px && positions[q + 1] === py && positions[q + 2] === pz) break
          id = chain[id]
        }
        if (id < 0) {
          id = VX.length
          chain.push(byHash.get(h) ?? -1)
          byHash.set(h, id)
          srcOf.push(i)
          VX.push(map.x(px))
          VY.push(map.y(py))
          VZ.push(map.z(pz))
        }
        vertId[t * 3 + v] = id
      }
    }
  }

  // ── Features: one record each, kind + numbers, all in one list ──
  //   vertex: x y z
  //   edge:   ax ay az ux uy L m k        (u: unit XY direction, m: dz per XY mm, k = √(1+m²))
  //   facet:  nx ny nz  A B C  l1x l1y l1c  l2x l2y l2c   (plane z = Ax + By + C; barycentrics)
  const STRIDE = 12
  const kind: number[] = []
  const data: number[] = []
  const box: number[] = []     // minX maxX minY maxY maxZ per feature
  const push = (k: number, vals: number[], x0: number, x1: number, y0: number, y1: number, zTop: number) => {
    kind.push(k)
    for (let i = 0; i < STRIDE; i++) data.push(vals[i] ?? 0)
    box.push(x0, x1, y0, y1, zTop)
  }
  for (let v = 0; v < VX.length; v++) push(0, [VX[v], VY[v], VZ[v]], VX[v], VX[v], VY[v], VY[v], VZ[v])
  {
    const seenEdge = new Set<number>()
    const nv = VX.length
    for (let t = 0; t < triCount; t++) {
      for (let e = 0; e < 3; e++) {
        let a = vertId[t * 3 + e], b = vertId[t * 3 + (e + 1) % 3]
        if (a === b) continue
        if (a > b) { const tmp = a; a = b; b = tmp }
        const key = a * nv + b
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        const ex = VX[b] - VX[a], ey = VY[b] - VY[a]
        const L = Math.hypot(ex, ey)
        if (L < 1e-9) continue           // vertical: its top vertex is the constraint
        const m = (VZ[b] - VZ[a]) / L
        push(1, [VX[a], VY[a], VZ[a], ex / L, ey / L, L, m, Math.sqrt(1 + m * m)],
          Math.min(VX[a], VX[b]), Math.max(VX[a], VX[b]), Math.min(VY[a], VY[b]), Math.max(VY[a], VY[b]), Math.max(VZ[a], VZ[b]))
      }
    }
  }
  for (let t = 0; t < triCount; t++) {
    const a = vertId[t * 3], b = vertId[t * 3 + 1], c = vertId[t * 3 + 2]
    const ax = VX[a], ay = VY[a], az = VZ[a], bx = VX[b], by = VY[b], bz = VZ[b], cx = VX[c], cy = VY[c], cz = VZ[c]
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    const nl = Math.hypot(nx, ny, nz)
    if (!(nl > 1e-18)) continue
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz }
    nx /= nl; ny /= nl; nz /= nl
    if (!(nz > 1e-9)) continue          // vertical: its edges and corners are the constraint
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (den === 0) continue
    // Barycentrics as affine functions of (x, y), and the plane through the triangle.
    const l1x = (by - cy) / den, l1y = (cx - bx) / den, l1c = -(l1x * cx + l1y * cy)
    const l2x = (cy - ay) / den, l2y = (ax - cx) / den, l2c = -(l2x * cx + l2y * cy)
    // z = l1·az + l2·bz + (1 − l1 − l2)·cz
    const A = l1x * (az - cz) + l2x * (bz - cz), B = l1y * (az - cz) + l2y * (bz - cz)
    const C = l1c * (az - cz) + l2c * (bz - cz) + cz
    push(2, [nx, ny, nz, A, B, C, l1x, l1y, l1c, l2x, l2y, l2c],
      Math.min(ax, bx, cx), Math.max(ax, bx, cx), Math.min(ay, by, cy), Math.max(ay, by, cy), Math.max(az, bz, cz))
  }
  const F = kind.length
  const K = Int8Array.from(kind)
  const D = Float64Array.from(data)
  const BX = Float64Array.from(box)

  // Bucket the features by their XY footprint, in CSR form, each bucket highest first.
  //
  // A bucket no smaller than the typical facet: a facet is listed in every bucket it
  // covers, and buckets sized off the ball alone (R/2) put a coarse mesh's facets in ~76
  // buckets each — 89% of a query's visits were to features it had already tested. The
  // bucket size cannot change the answer (every prune is exact), only how fast it comes.
  const facetExtents: number[] = []
  for (let f = 0; f < F; f++) {
    if (K[f] !== 2) continue
    const o = f * 5
    facetExtents.push(Math.max(BX[o + 1] - BX[o], BX[o + 3] - BX[o + 2]))
  }
  facetExtents.sort((a, b) => a - b)
  const medianFacet = facetExtents.length ? facetExtents[facetExtents.length >> 1] : 0
  // And never so many buckets that building them dominates: a 600 mm relief at R/2 = 0.25
  // was 5.8 M of them, each sorted.
  const B = Math.max(0.25, R / 2, medianFacet, Math.sqrt((bbox.width * bbox.height) / MAX_BUCKETS))
  const bw = Math.max(1, Math.ceil(bbox.width / B) + 1)
  const bh = Math.max(1, Math.ceil(bbox.height / B) + 1)
  const span = (f: number) => {
    const o = f * 5
    return [
      Math.max(0, Math.floor((BX[o] - bbox.minX) / B)), Math.min(bw - 1, Math.floor((BX[o + 1] - bbox.minX) / B)),
      Math.max(0, Math.floor((BX[o + 2] - bbox.minY) / B)), Math.min(bh - 1, Math.floor((BX[o + 3] - bbox.minY) / B)),
    ]
  }
  const counts = new Int32Array(bw * bh + 1)
  for (let f = 0; f < F; f++) {
    const [i0, i1, j0, j1] = span(f)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * bw + i + 1]++
  }
  for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1]
  const ids = new Int32Array(counts[counts.length - 1])
  const fill = counts.slice(0, bw * bh)
  for (let f = 0; f < F; f++) {
    const [i0, i1, j0, j1] = span(f)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) ids[fill[j * bw + i]++] = f
  }
  for (let b = 0; b < bw * bh; b++) {
    if (counts[b + 1] - counts[b] < 2) continue
    const slice = Array.from(ids.subarray(counts[b], counts[b + 1]))
    slice.sort((p, q) => BX[q * 5 + 4] - BX[p * 5 + 4])
    ids.set(slice, counts[b])
  }
  // A feature spans several buckets; test it once per query.
  const seen = new Int32Array(F)
  let stamp = 0

  // Every feature lies in the model's box (to rounding): a ball that cannot reach the box
  // rests on nothing — the floor of a boundary drawn round the model, most of it.
  const reachMinX = bbox.minX - R - 1e-6, reachMaxX = bbox.maxX + R + 1e-6
  const reachMinY = bbox.minY - R - 1e-6, reachMaxY = bbox.maxY + R + 1e-6
  return (x, y) => {
    if (x < reachMinX || x > reachMaxX || y < reachMinY || y > reachMaxY) return null
    stamp++
    if (stamp === 0x7fffffff) { seen.fill(0); stamp = 1 }
    const i0 = Math.max(0, Math.floor((x - R - bbox.minX) / B)), i1 = Math.min(bw - 1, Math.floor((x + R - bbox.minX) / B))
    const j0 = Math.max(0, Math.floor((y - R - bbox.minY) / B)), j1 = Math.min(bh - 1, Math.floor((y + R - bbox.minY) / B))
    let best = -Infinity
    // The bucket under the tool first: it holds what the tool most likely rests on, and a
    // high best from it lets every other bucket stop early.
    const ic = Math.min(bw - 1, Math.max(0, Math.floor((x - bbox.minX) / B)))
    const jc = Math.min(bh - 1, Math.max(0, Math.floor((y - bbox.minY) / B)))
    for (let pass = 0; pass < 2; pass++) for (let j = pass ? j0 : jc; j <= (pass ? j1 : jc); j++) {
      for (let i = pass ? i0 : ic; i <= (pass ? i1 : ic); i++) {
        if (pass && i === ic && j === jc) continue
        const b = j * bw + i
        if (counts[b] === counts[b + 1]) continue
        // The bucket's own distance from the tool bounds what its features can give HERE: a
        // feature's nearest point to the tool lies in some bucket of this window, and in
        // THAT bucket it is no nearer than the bucket. Pruned elsewhere, it is still tested
        // there, so the answer is the same — only the visits are fewer. (The edge buckets
        // also hold whatever rounds off the box, so they reach outward without limit.)
        const bdx = Math.max(i === 0 ? 0 : bbox.minX + i * B - x, 0, i === bw - 1 ? 0 : x - (bbox.minX + (i + 1) * B))
        const bdy = Math.max(j === 0 ? 0 : bbox.minY + j * B - y, 0, j === bh - 1 ? 0 : y - (bbox.minY + (j + 1) * B))
        const bd2 = bdx * bdx + bdy * bdy
        if (bd2 > R2) continue
        const rise = R - Math.sqrt(R2 - bd2)
        for (let q = counts[b]; q < counts[b + 1]; q++) {
          const f = ids[q]
          const bo = f * 5
          // Highest first: nothing further down this bucket can beat the best so far.
          if (BX[bo + 4] - rise <= best) break
          if (seen[f] === stamp) continue
          seen[f] = stamp
          // Out of reach in XY, or too far off to the side to beat the best: the most a
          // feature can lift the tool is its highest point less the ball's rise at the
          // feature's nearest approach.
          const ddx = Math.max(BX[bo] - x, 0, x - BX[bo + 1]), ddy = Math.max(BX[bo + 2] - y, 0, y - BX[bo + 3])
          const dd2 = ddx * ddx + ddy * ddy
          if (dd2 > R2 || BX[bo + 4] - (R - Math.sqrt(R2 - dd2)) <= best) continue
          const o = f * STRIDE
          let h = -Infinity
          const k = K[f]
          if (k === 0) {
            // VERTEX: the ball's surface resting on a corner.
            const d2 = (D[o] - x) ** 2 + (D[o + 1] - y) ** 2
            if (d2 <= R2) h = D[o + 2] - (R - Math.sqrt(R2 - d2))
          } else if (k === 1) {
            // EDGE: in the edge's vertical plane the ball is a circle of radius r centred
            // at s0; its centre sits r along the line's upward normal (−m, 1)/k from where
            // it touches, so the contact is r·m/k ALONG from the centre's foot.
            const ax = D[o], ay = D[o + 1], az = D[o + 2], ux = D[o + 3], uy = D[o + 4]
            const L = D[o + 5], m = D[o + 6], kk = D[o + 7]
            const s0 = (x - ax) * ux + (y - ay) * uy
            const d = Math.abs((x - ax) * uy - (y - ay) * ux)
            if (d < R) {
              const r = Math.sqrt(R2 - d * d)
              const sc = s0 + r * m / kk
              if (sc >= 0 && sc <= L) h = az + m * s0 + r * kk - R
            }
          } else {
            // FACET: the ball tangent to the plane, at a point inside the triangle.
            const nx = D[o], ny = D[o + 1], nz = D[o + 2]
            const px = x - R * nx, py = y - R * ny
            const l1 = D[o + 6] * px + D[o + 7] * py + D[o + 8]
            const l2 = D[o + 9] * px + D[o + 10] * py + D[o + 11]
            if (l1 >= 0 && l2 >= 0 && 1 - l1 - l2 >= 0) {
              h = D[o + 3] * px + D[o + 4] * py + D[o + 5] + R * nz - R
            }
          }
          if (h > best) best = h
        }
      }
    }
    return best === -Infinity ? null : best
  }
}
