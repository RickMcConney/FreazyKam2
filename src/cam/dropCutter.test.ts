// The exact drop-cutter, against a brute-force drop of the same ball onto the same mesh.
import { describe, it, expect } from 'vitest'
import { ballDropCutter } from './dropCutter'
import type { BBox } from '../canvas/selectionUtils'

const W = 40
const box: BBox = { minX: 0, minY: 0, maxX: W, maxY: W, width: W, height: W, cx: W / 2, cy: W / 2 }
type Height = (x: number, y: number) => number

/** A coarse heightfield mesh — big facets, so vertices and edges matter — and its exact
 *  height anywhere. */
function mesh(S: Height, n: number) {
  const c = W / n
  const v = (i: number, j: number) => [i * c, j * c, S(i * c, j * c)]
  const pos: number[] = []
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = v(i, j), b = v(i + 1, j), cc = v(i + 1, j + 1), d = v(i, j + 1)
    pos.push(...a, ...b, ...cc, ...a, ...cc, ...d)
  }
  const at = (x: number, y: number) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(x / c))), j = Math.min(n - 1, Math.max(0, Math.floor(y / c)))
    const fx = x / c - i, fy = y / c - j
    const za = v(i, j)[2], zb = v(i + 1, j)[2], zc = v(i + 1, j + 1)[2], zd = v(i, j + 1)[2]
    return fx >= fy ? za + (zb - za) * fx + (zc - zb) * fy : za + (zc - zd) * fx + (zd - za) * fy
  }
  const positions = new Float32Array(pos)
  let minZ = Infinity, maxZ = -Infinity
  for (let k = 2; k < positions.length; k += 3) { minZ = Math.min(minZ, positions[k]); maxZ = Math.max(maxZ, positions[k]) }
  return { positions, at, bounds: { minX: 0, maxX: W, minY: 0, maxY: W, minZ, maxZ } }
}

/** The ball dropped by brute force: the highest tip any surface point under it allows,
 *  sampled every `step` mm. A lower bound on the true answer, within slope × step of it. */
function bruteDrop(at: Height, R: number, x: number, y: number, step: number): number {
  let best = -Infinity
  for (let u = Math.max(0, x - R); u <= Math.min(W, x + R); u += step) {
    for (let v = Math.max(0, y - R); v <= Math.min(W, y + R); v += step) {
      const d2 = (u - x) ** 2 + (v - y) ** 2
      if (d2 > R * R) continue
      best = Math.max(best, at(u, v) - (R - Math.sqrt(R * R - d2)))
    }
  }
  return best
}

describe('the ball drop-cutter', () => {
  // A faceted dome with a near-vertical foot on a floor, and a 45° pyramid pit: the ball
  // rests on facets, on edges and on vertices. Its answer must never be below the brute
  // force (that would gouge) and never more than the sampling error above it (stock).
  const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 15 ? Math.sqrt(225 - r * r) - 15 : -15 }
  const PIT: Height = (x, y) => -Math.max(0, 10 - Math.max(Math.abs(x - 20), Math.abs(y - 20)))
  for (const [name, S] of [['a faceted dome', DOME], ['a pyramid pit', PIT]] as const) {
    for (const R of [1.5875, 3]) {
      it(`drops a ${R * 2} mm ball onto ${name} exactly where brute force finds it`, () => {
        const m = mesh(S, 20)
        const drop = ballDropCutter(m.positions, null, m.bounds, box, R)
        let below = 0, above = 0
        for (let k = 0; k < 150; k++) {
          const x = 2 + ((k * 7.31) % 36), y = 2 + ((k * 13.17) % 36)
          const exact = drop(x, y)!
          const brute = bruteDrop(m.at, R, x, y, 0.02)
          below = Math.max(below, brute - exact)
          above = Math.max(above, exact - brute)
        }
        // The mesh is Float32 and the brute force reads it in doubles: a micron of rounding.
        expect(below).toBeLessThan(1e-6)
        expect(above).toBeLessThan(0.02)
      })
    }
  }
})
