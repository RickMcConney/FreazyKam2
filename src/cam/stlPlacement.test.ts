import { describe, it, expect } from 'vitest'
import { placeStlModel } from './stlPlacement'
import { stlToCnc } from './stlMapping'
import { getBBox, rotateAroundD, scaleAroundD } from '../canvas/selectionUtils'
import type { StlModelBounds } from '../importers/svgImporter'

// A model that does NOT fill its own box in either axis, and is not symmetric, so a model
// stretched, mirrored or turned the wrong way all land somewhere measurably different.
const POS = new Float32Array([
  10, 20, 0,   // the box's min corner, at the model's lowest point
  50, 20, -2,
  40, 45, -5,
  18, 38, -1,
  30, 30, 0,   // an interior point at the top
])
const BOUNDS: StlModelBounds = { minX: 10, maxX: 50, minY: 20, maxY: 45, minZ: -5, maxZ: 0 }
// The import's outline: the model's box at 2 mm per model unit, centred at (100, 80).
const D0 = 'M60,55 L140,55 L140,105 L60,105 Z'

/** Where every vertex lands in CNC, as the cut reads it (the mapping buildHeightMap uses). */
function landed(d: string): [number, number, number][] {
  const p = placeStlModel(POS, BOUNDS, d)
  const map = stlToCnc(p.bounds, getBBox(d)!)
  const out: [number, number, number][] = []
  for (let i = 0; i < p.positions.length; i += 3) out.push([map.x(p.positions[i]), map.y(p.positions[i + 1]), map.z(p.positions[i + 2])])
  return out
}
const turn = ([x, y, z]: [number, number, number], deg: number, cx: number, cy: number): [number, number, number] => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c, z]
}

describe('an STL stands as its outline does', () => {
  it('hands an unturned model back untouched, so its cut is byte-for-byte what it was', () => {
    const p = placeStlModel(POS, BOUNDS, D0)
    expect(p.positions).toBe(POS)
    expect(p.bounds).toBe(BOUNDS)
    expect(p.turned).toBe(false)
  })

  for (const deg of [30, 90, 135, -60]) {
    it(`turns the model with an outline turned ${deg}°, unstretched, about the outline's centre`, () => {
      const want = landed(D0).map((v) => turn(v, deg, 100, 80))
      const got = landed(rotateAroundD(D0, 100, 80, deg))
      // d strings carry four decimals, so the box the model is fitted to is good to ~1e-4 mm
      for (let i = 0; i < want.length; i++)
        for (let k = 0; k < 3; k++) expect(got[i][k]).toBeCloseTo(want[i][k], 3)
    })
  }

  it('calls a turn of a multiple of 90° untouched corners, and any other turn not', () => {
    expect(placeStlModel(POS, BOUNDS, rotateAroundD(D0, 100, 80, 90)).turned).toBe(false)
    expect(placeStlModel(POS, BOUNDS, rotateAroundD(D0, 100, 80, 30)).turned).toBe(true)
  })

  it('keeps a turned model\'s own aspect when the outline was stretched before the turn', () => {
    const stretched = scaleAroundD(D0, 100, 80, 1.5, 1)  // 120 × 50 mm: 3 mm per unit in X, 2 in Y
    const want = landed(stretched).map((v) => turn(v, 30, 100, 80))
    const got = landed(rotateAroundD(stretched, 100, 80, 30))
    for (let i = 0; i < want.length; i++)
      for (let k = 0; k < 3; k++) expect(got[i][k]).toBeCloseTo(want[i][k], 3)
  })

  it('leaves a model under an outline mirrored on the axes exactly where it was (Send to Other Side)', () => {
    for (const [sx, sy] of [[-1, 1], [1, -1]]) {
      const mirrored = scaleAroundD(D0, 100, 80, sx, sy)
      const p = placeStlModel(POS, BOUNDS, mirrored)
      expect(p.positions).toBe(POS)
      expect(p.bounds).toBe(BOUNDS)
    }
  })
})
