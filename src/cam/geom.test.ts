import { describe, it, expect } from 'vitest'
import { zPasses, pointInPolygon, pointOnRing, arcLengths, interpPt, stripClosingDuplicate, ptSegDistSq, toolRadiusAtHeight,
  toolProfileHeightMM, maxCutRadiusMM, includedAngleDeg, isVCutter, vProfileHeightMM, vRadiusAtHeightMM } from './geom'
import type { Pt2 } from './pathFlattener'
import type { Tool } from '../store/toolStore'

const mkTool = (over: Partial<Tool>): Tool => ({
  id: 't', name: 't', type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000,
  xyFeedMmMin: 2000, zFeedMmMin: 400, maxDepthMM: 20,
  ...over,
})

describe('zPasses', () => {
  it('steps down by stepDown then finishes exactly at -depth', () => {
    expect(zPasses(10, 3)).toEqual([-3, -6, -9, -10])
  })

  it('does not duplicate the final pass when depth is an exact multiple of step', () => {
    expect(zPasses(6, 2)).toEqual([-2, -4, -6])
  })

  // Regression: `z -= step` accumulates float error, so for these ratios the
  // last iteration landed a few ULPs above -depth (e.g. -0.7999999999999999)
  // and was pushed, then the unconditional final push added -depth again —
  // two full cutting passes at the same Z. Ordinary settings, not edge cases.
  it('does not duplicate the final pass when float drift overshoots -depth', () => {
    expect(zPasses(0.8, 0.1)).toEqual([-0.1, -0.2, -0.30000000000000004, -0.4, -0.5, -0.6, -0.7, -0.8])
    expect(zPasses(0.5, 0.05)).toHaveLength(10)
    expect(zPasses(0.4, 0.05)).toHaveLength(8)
  })

  it('never emits two passes at the same depth across the realistic parameter space', () => {
    const dupes: string[] = []
    for (let di = 1; di <= 400; di++) {
      for (let si = 1; si <= 100; si++) {
        const passes = zPasses(di / 10, si / 100)
        for (let i = 1; i < passes.length; i++) {
          if (Math.abs(passes[i] - passes[i - 1]) < 1e-9) dupes.push(`depth=${di / 10} step=${si / 100}`)
        }
      }
    }
    expect(dupes).toEqual([])
  })

  it('cuts a single pass when step exceeds depth', () => {
    expect(zPasses(5, 10)).toEqual([-5])
  })

  it('treats negative step as its magnitude', () => {
    expect(zPasses(10, -3)).toEqual([-3, -6, -9, -10])
  })

  it('clamps a zero step to the 0.01 mm minimum instead of looping forever', () => {
    const passes = zPasses(10, 0)
    // ~1000 passes at the 0.01 clamp (float drift may add one), never unbounded
    expect(passes.length).toBeGreaterThanOrEqual(1000)
    expect(passes.length).toBeLessThanOrEqual(1001)
    expect(passes[passes.length - 1]).toBe(-10)
  })

  it('clamps a NaN step to the 0.01 mm minimum', () => {
    const passes = zPasses(1, NaN)
    expect(passes.length).toBeGreaterThanOrEqual(100)
    expect(passes.length).toBeLessThanOrEqual(101)
    expect(passes[0]).toBe(-0.01)
    expect(passes[passes.length - 1]).toBe(-1)
  })

  it('treats NaN depth as zero depth', () => {
    expect(zPasses(NaN, 2)).toEqual([-0])
  })
})

describe('pointInPolygon', () => {
  const square: Pt2[] = [[0, 0], [10, 0], [10, 10], [0, 10]]

  it('detects interior points', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true)
    expect(pointInPolygon(0.1, 9.9, square)).toBe(true)
  })

  it('rejects exterior points', () => {
    expect(pointInPolygon(-1, 5, square)).toBe(false)
    expect(pointInPolygon(11, 5, square)).toBe(false)
    expect(pointInPolygon(5, 20, square)).toBe(false)
  })

  it('works whether the polygon repeats the closing vertex or not', () => {
    const closed: Pt2[] = [...square, [0, 0]]
    expect(pointInPolygon(5, 5, closed)).toBe(true)
    expect(pointInPolygon(15, 5, closed)).toBe(false)
  })

  it('handles concave polygons (even-odd rule)', () => {
    // L-shape: notch at the top-right quadrant
    const ell: Pt2[] = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]]
    expect(pointInPolygon(2, 8, ell)).toBe(true)
    expect(pointInPolygon(8, 8, ell)).toBe(false) // inside the notch
  })
})

describe('pointOnRing', () => {
  const square: Pt2[] = [[0, 0], [10, 0], [10, 10], [0, 10]]

  // The reason this function exists: pointInPolygon settles a point lying exactly ON the
  // outline by the half-open crossing rule, so the answer depends on which wall it is —
  // and a raster's scanline endpoints are built by intersecting the very ring they are
  // then tested against. Every one of them lands on it.
  it('answers both walls the same, where pointInPolygon does not', () => {
    expect(pointInPolygon(0, 5, square)).toBe(true)   // left wall reads inside
    expect(pointInPolygon(10, 5, square)).toBe(false) // right wall reads outside
    expect(pointOnRing(0, 5, square)).toBe(true)
    expect(pointOnRing(10, 5, square)).toBe(true)
  })

  it('finds a point on every edge and on a vertex', () => {
    expect(pointOnRing(5, 0, square)).toBe(true)
    expect(pointOnRing(5, 10, square)).toBe(true)
    expect(pointOnRing(10, 10, square)).toBe(true)
  })

  it('is not a containment test — the interior is not ON the ring', () => {
    expect(pointOnRing(5, 5, square)).toBe(false)
    expect(pointOnRing(0, -5, square)).toBe(false)
  })

  it('holds the tolerance to floating-point slop, not a machining allowance', () => {
    expect(pointOnRing(10 + 1e-9, 5, square)).toBe(true)
    expect(pointOnRing(10.001, 5, square)).toBe(false) // a micron out is already out
  })

  it('closes the ring, so the last-to-first edge counts', () => {
    expect(pointOnRing(0, 5, square)).toBe(true) // the [0,10]→[0,0] edge
  })
})

describe('arcLengths / interpPt', () => {
  const pts: Pt2[] = [[0, 0], [3, 0], [3, 4]]

  it('accumulates cumulative lengths', () => {
    const { lens, total } = arcLengths(pts)
    expect(lens).toEqual([0, 3, 7])
    expect(total).toBe(7)
  })

  it('interpolates a point at a given arc length', () => {
    const { lens } = arcLengths(pts)
    const mid = interpPt(pts, lens, 5)
    expect(mid[0]).toBeCloseTo(3)
    expect(mid[1]).toBeCloseTo(2)
  })

  it('clamps s to the polyline ends', () => {
    const { lens } = arcLengths(pts)
    expect(interpPt(pts, lens, -5)).toEqual([0, 0])
    expect(interpPt(pts, lens, 100)).toEqual([3, 4])
  })
})

describe('stripClosingDuplicate', () => {
  it('drops a duplicated closing vertex', () => {
    const pts: Pt2[] = [[0, 0], [10, 0], [10, 10], [0, 0]]
    expect(stripClosingDuplicate(pts)).toEqual([[0, 0], [10, 0], [10, 10]])
  })

  it('leaves an open polyline untouched', () => {
    const pts: Pt2[] = [[0, 0], [10, 0], [10, 10]]
    expect(stripClosingDuplicate(pts)).toBe(pts)
  })
})

describe('ptSegDistSq', () => {
  it('measures perpendicular distance to the segment interior', () => {
    expect(ptSegDistSq(5, 3, 0, 0, 10, 0)).toBeCloseTo(9)
  })

  it('clamps to the nearest endpoint beyond the segment', () => {
    expect(ptSegDistSq(13, 4, 0, 0, 10, 0)).toBeCloseTo(25)
  })

  it('handles a degenerate zero-length segment', () => {
    expect(ptSegDistSq(3, 4, 1, 1, 1, 1)).toBeCloseTo(13)
  })
})

describe('toolRadiusAtHeight', () => {
  it('is constant for flat-bottomed tools', () => {
    const em = mkTool({ type: 'endmill', diameterMM: 6 })
    expect(toolRadiusAtHeight(em, 0)).toBe(3)
    expect(toolRadiusAtHeight(em, 0.5)).toBe(3)
    expect(toolRadiusAtHeight(em, 100)).toBe(3)
  })

  it('follows the cone of a V-bit, then the shank', () => {
    // 90° included → 45° half-angle → radius equals depth until the shank.
    const v90 = mkTool({ type: 'vbit', diameterMM: 6, vbitAngleDeg: 90 })
    expect(toolRadiusAtHeight(v90, 1)).toBeCloseTo(1)
    expect(toolRadiusAtHeight(v90, 2.5)).toBeCloseTo(2.5)
    expect(toolRadiusAtHeight(v90, 10)).toBeCloseTo(3)   // capped at the full radius
    // 60° included → 30° half-angle.
    const v60 = mkTool({ type: 'vbit', diameterMM: 6.35, vbitAngleDeg: 60 })
    expect(toolRadiusAtHeight(v60, 2)).toBeCloseTo(2 * Math.tan(Math.PI / 6))
  })

  it('follows the ball of a ball nose, then the shank', () => {
    const ball = mkTool({ type: 'ballnose', diameterMM: 6 })
    expect(toolRadiusAtHeight(ball, 0)).toBeCloseTo(0)
    expect(toolRadiusAtHeight(ball, 3)).toBeCloseTo(3)   // equator
    expect(toolRadiusAtHeight(ball, 1)).toBeCloseTo(Math.sqrt(5))
    expect(toolRadiusAtHeight(ball, 20)).toBeCloseTo(3)
  })

  it('clamps a negative height and survives a degenerate V angle', () => {
    expect(toolRadiusAtHeight(mkTool({ type: 'ballnose', diameterMM: 6 }), -1)).toBe(0)
    expect(toolRadiusAtHeight(mkTool({ type: 'vbit', diameterMM: 6, vbitAngleDeg: 0 }), 5)).toBe(3)
    expect(toolRadiusAtHeight(mkTool({ type: 'vbit', diameterMM: 6, vbitAngleDeg: 180 }), 5)).toBe(3)
  })

  it('starts a taper at zero: its tip is a ball, so it can enter a stroke of any width', () => {
    // The whole reason a taper needs no "too narrow to carve" case — unlike a flat tip,
    // its cutting radius goes to zero at the very point.
    const t = mkTool({ type: 'taper', diameterMM: 1, vbitAngleDeg: 5, maxDepthMM: 25 })
    expect(toolRadiusAtHeight(t, 0)).toBe(0)
    expect(toolRadiusAtHeight(t, 0.01)).toBeGreaterThan(0)
  })

  it('follows the tip ball, then the cone tangent to it, then caps at Max Z', () => {
    // 15° per side; tip ball Ø1 (r = 0.5). The ball runs to h = r(1 − sinθ), the cone
    // from there out. Values are the ball and cone laws written independently.
    const th = 15 * Math.PI / 180
    const t = mkTool({ type: 'taper', diameterMM: 1, vbitAngleDeg: 15, maxDepthMM: 20 })
    const hT = 0.5 * (1 - Math.sin(th))
    expect(toolRadiusAtHeight(t, hT / 2)).toBeCloseTo(Math.sqrt((hT / 2) * (2 * 0.5 - hT / 2)), 12)
    expect(toolRadiusAtHeight(t, hT)).toBeCloseTo(0.5 * Math.cos(th), 12)          // tangency
    expect(toolRadiusAtHeight(t, 10)).toBeCloseTo((10 + 0.5 * (1 / Math.sin(th) - 1)) * Math.tan(th), 12)
    // Past its usable length the body is a straight shank — it never opens out further.
    expect(toolRadiusAtHeight(t, 999)).toBeCloseTo(maxCutRadiusMM(t), 12)
    expect(maxCutRadiusMM(t)).toBeCloseTo(toolRadiusAtHeight(t, 20), 12)
  })

  it('is the exact inverse of the profile height, across the ball/cone join', () => {
    const t = mkTool({ type: 'taper', diameterMM: 1.5, vbitAngleDeg: 8, maxDepthMM: 25 })
    const dT = 0.75 * Math.cos(8 * Math.PI / 180)
    for (const d of [0, dT / 2, dT, dT * 1.5, dT * 4, maxCutRadiusMM(t)]) {
      expect(toolRadiusAtHeight(t, toolProfileHeightMM(t, d))).toBeCloseTo(d, 9)
    }
  })

  it('degenerates to a V-bit at zero tip radius and to a ball nose at zero angle', () => {
    // The taper is the two-parameter family containing both, which is why the V-bit code
    // paths generalise to it rather than forking. Compared through the raw primitives so
    // the tool-level diameter caps do not mask a difference.
    const tan30 = Math.tan(30 * Math.PI / 180)
    for (const h of [0, 0.5, 2, 5]) {
      expect(vRadiusAtHeightMM(h, tan30, 0)).toBeCloseTo(h * tan30, 12)
      expect(vProfileHeightMM(h * tan30, tan30, 0)).toBeCloseTo(h, 12)
    }
    // θ → 0: the cone stands vertical at the ball's equator, i.e. a ball nose of the tip.
    const tiny = Math.tan(1e-6)
    for (const h of [0.1, 1, 2.9]) {
      expect(vRadiusAtHeightMM(h, tiny, 3)).toBeCloseTo(Math.sqrt(h * (6 - h)), 4)
    }
  })
})

describe('the two angle conventions', () => {
  it('reads a V-bit angle as included and a taper angle as per side', () => {
    // A taper is sold by its per-side angle and a V-bit by its included one. Everything
    // downstream works in included angle, so this is where the two meet — and getting it
    // backwards would halve or double every taper wall in the app.
    expect(includedAngleDeg(mkTool({ type: 'vbit', vbitAngleDeg: 60 }))).toBe(60)
    expect(includedAngleDeg(mkTool({ type: 'taper', vbitAngleDeg: 5 }))).toBe(10)
  })

  it('counts both a V-bit and a taper as tapered-wall cutters, and nothing else', () => {
    expect(isVCutter(mkTool({ type: 'vbit' }))).toBe(true)
    expect(isVCutter(mkTool({ type: 'taper' }))).toBe(true)
    expect(isVCutter(mkTool({ type: 'endmill' }))).toBe(false)
    expect(isVCutter(mkTool({ type: 'ballnose' }))).toBe(false)
    expect(isVCutter(mkTool({ type: 'drill' }))).toBe(false)
  })
})
