// Marching squares isoline tracer for the spiral field (spiralField.ts).
//
// Extracts the closed level-set loops (isotherms) of the Poisson field at a given
// level, in CNC mm. The field is 0 on the domain border ring, so every isotherm
// at a level > 0 closes inside the domain. Loops are returned unoriented; the
// caller winds them for climb/conventional.

import type { Pt2 } from './pathFlattener'
import type { FieldGrid } from './spiralField'

// Per case (corner-inside bitmask c0|c1<<1|c2<<2|c3<<3), the pairs of cell edges
// the contour connects. Edges: 0 bottom, 1 right, 2 top, 3 left. Cases 5 and 10
// are saddles, resolved at run time by the cell-centre value.
const EDGE_PAIRS: number[][][] = [
  [],                 // 0
  [[3, 0]],           // 1
  [[0, 1]],           // 2
  [[3, 1]],           // 3
  [[1, 2]],           // 4
  [],                 // 5 saddle
  [[0, 2]],           // 6
  [[3, 2]],           // 7
  [[2, 3]],           // 8
  [[0, 2]],           // 9
  [],                 // 10 saddle
  [[1, 2]],           // 11
  [[1, 3]],           // 12
  [[0, 1]],           // 13
  [[0, 3]],           // 14
  [],                 // 15
]

function key(x: number, y: number): number {
  // Pack rounded grid-edge coordinates into one number for exact endpoint match.
  return Math.round(x * 1e4) * 4e7 + Math.round(y * 1e4)
}

// Interpolated CNC point on cell edge `e` of cell (ix,iy) for the given level.
function edgePoint(g: FieldGrid, ix: number, iy: number, e: number, level: number, v: number[]): Pt2 {
  const { x0, y0, cell } = g
  const interp = (va: number, vb: number) => {
    const d = vb - va
    return Math.abs(d) < 1e-12 ? 0.5 : (level - va) / d
  }
  switch (e) {
    case 0: { const t = interp(v[0], v[1]); return [x0 + (ix + t) * cell, y0 + iy * cell] }
    case 1: { const t = interp(v[1], v[2]); return [x0 + (ix + 1) * cell, y0 + (iy + t) * cell] }
    case 2: { const t = interp(v[3], v[2]); return [x0 + (ix + t) * cell, y0 + (iy + 1) * cell] }
    default: { const t = interp(v[0], v[3]); return [x0 + ix * cell, y0 + (iy + t) * cell] }
  }
}

export function traceIsolines(g: FieldGrid, level: number): Pt2[][] {
  if (g.gw < 2 || g.gh < 2) return []
  const segA: Pt2[] = []
  const segB: Pt2[] = []

  for (let iy = 0; iy < g.gh - 1; iy++) {
    for (let ix = 0; ix < g.gw - 1; ix++) {
      const v = [
        g.T[iy * g.gw + ix],
        g.T[iy * g.gw + ix + 1],
        g.T[(iy + 1) * g.gw + ix + 1],
        g.T[(iy + 1) * g.gw + ix],
      ]
      let c = 0
      if (v[0] >= level) c |= 1
      if (v[1] >= level) c |= 2
      if (v[2] >= level) c |= 4
      if (v[3] >= level) c |= 8
      if (c === 0 || c === 15) continue
      let pairs = EDGE_PAIRS[c]
      if (c === 5 || c === 10) {
        const centerInside = (v[0] + v[1] + v[2] + v[3]) / 4 >= level
        if (c === 5) pairs = centerInside ? [[1, 2], [3, 0]] : [[0, 1], [2, 3]]
        else pairs = centerInside ? [[0, 1], [2, 3]] : [[1, 2], [3, 0]]
      }
      for (const [ea, eb] of pairs) {
        segA.push(edgePoint(g, ix, iy, ea, level, v))
        segB.push(edgePoint(g, ix, iy, eb, level, v))
      }
    }
  }

  // Stitch segments into closed loops by matching endpoints (exact, since shared
  // edge points come from the same interpolation in both adjacent cells).
  const n = segA.length
  const adj = new Map<number, number[]>()
  const push = (k: number, i: number) => { const a = adj.get(k); if (a) a.push(i); else adj.set(k, [i]) }
  for (let i = 0; i < n; i++) { push(key(segA[i][0], segA[i][1]), i); push(key(segB[i][0], segB[i][1]), i) }

  const used = new Uint8Array(n)
  const loops: Pt2[][] = []
  for (let start = 0; start < n; start++) {
    if (used[start]) continue
    const loop: Pt2[] = []
    let segIdx = start
    let from: Pt2 = segA[start]
    let to: Pt2 = segB[start]
    loop.push(from)
    while (true) {
      used[segIdx] = 1
      loop.push(to)
      const k = key(to[0], to[1])
      const cands = adj.get(k)
      let next = -1
      if (cands) for (const ci of cands) { if (!used[ci]) { next = ci; break } }
      if (next === -1) break
      // Continue from the far endpoint of the next segment.
      const na = segA[next], nb = segB[next]
      if (key(na[0], na[1]) === k) { from = na; to = nb } else { from = nb; to = na }
      segIdx = next
    }
    if (loop.length >= 4) loops.push(loop)
  }
  return loops
}
