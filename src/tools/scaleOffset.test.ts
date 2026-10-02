import { describe, it, expect } from 'vitest'
import { applyScaleOffset, areaCentroid, isExactGap } from './scaleOffset'
import { getBBox } from '../canvas/selectionUtils'
import { flattenPath } from '../cam/pathFlattener'

type Pt = [number, number]
const rect = (x0: number, y0: number, x1: number, y1: number) => `M${x0},${y0} L${x1},${y0} L${x1},${y1} L${x0},${y1} Z`
// Same rectangle travelled the other way round.
const rectCW = (x0: number, y0: number, x1: number, y1: number) => `M${x0},${y0} L${x0},${y1} L${x1},${y1} L${x1},${y0} Z`
const circle = (cx: number, cy: number, r: number) => `M${cx + r},${cy} A${r},${r} 0 1 1 ${cx - r},${cy} A${r},${r} 0 1 1 ${cx + r},${cy} Z`

describe('the area centroid', () => {
  it('sits at the centre of mass of an L, not the middle of its box', () => {
    // A 20×10 bar on a 10×20 post sharing the corner square: area 300, centroid (25/3, 25/3).
    const L: Pt[] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]]
    const c = areaCentroid([L])!
    expect(c[0]).toBeCloseTo(25 / 3); expect(c[1]).toBeCloseTo(25 / 3)
  })

  // A ring inside another is a hole whichever way it is wound — imported SVG gets both.
  it('subtracts a hole whichever way it is wound', () => {
    const outer = flattenPath(rect(0, 0, 20, 20), 0.05) as Pt[][]
    const ccw = areaCentroid([...outer, ...(flattenPath(rect(10, 5, 15, 15), 0.05) as Pt[][])])!
    const cw = areaCentroid([...outer, ...(flattenPath(rectCW(10, 5, 15, 15), 0.05) as Pt[][])])!
    // 400 at x=10, minus 50 at x=12.5 → (4000 − 625) / 350.
    expect(ccw[0]).toBeCloseTo(3375 / 350); expect(ccw[1]).toBeCloseTo(10)
    expect(cw[0]).toBeCloseTo(ccw[0]); expect(cw[1]).toBeCloseTo(ccw[1])
  })
})

describe('a keep-shape offset', () => {
  // A circle is the one shape where scaling IS an exact offset, so the gap is the
  // distance everywhere.
  it('grows a circle into the concentric circle the distance out', () => {
    const r = applyScaleOffset(circle(0, 0, 10), 2)!
    expect(r.scale).toBeCloseTo(1.2, 2)
    expect(r.minGapMM).toBeCloseTo(2, 1); expect(r.maxGapMM).toBeCloseTo(2, 1)
    const b = getBBox(r.d)!
    expect(b.width).toBeCloseTo(24, 1); expect(b.cx).toBeCloseTo(0, 6)
  })

  // The readout must not warn "not exact" on the one shape where it IS exact — in either
  // direction, though shrinking measures a little flattening spread — and must on a shape
  // where the gap genuinely varies, even a small one.
  it('calls a circle exact, growing or shrinking, and a bar not', () => {
    for (const [r, d] of [[2, 1], [10, 2], [10, -5], [300, 50]]) {
      const x = applyScaleOffset(circle(0, 0, r), d)!
      expect(isExactGap(x.minGapMM, x.maxGapMM)).toBe(true)
    }
    const bar = applyScaleOffset(rect(0, 0, 40, 10), 0.1)!
    expect(isExactGap(bar.minGapMM, bar.maxGapMM)).toBe(false)
  })

  it('shrinks for a negative distance', () => {
    const r = applyScaleOffset(circle(0, 0, 10), -3)!
    expect(r.scale).toBeCloseTo(0.7, 2)
  })

  // The distance is the MEAN gap. A 40×10 bar scaled about its centre gets 5(s − 1) along
  // its long sides; mid-end the NEAREST new edge is whichever is closer of the end, 20(s − 1)
  // off, and the long side, 5s away. The readout has to say so rather than pretend the gap
  // is exact.
  it('makes the mean gap the distance, and reports the gap it really left', () => {
    const r = applyScaleOffset(rect(0, 0, 40, 10), 3)!
    expect(r.minGapMM).toBeCloseTo(5 * (r.scale - 1), 1)
    expect(r.maxGapMM).toBeCloseTo(Math.min(20 * (r.scale - 1), 5 * r.scale), 1)
    expect(r.minGapMM).toBeLessThan(3)
    expect(r.maxGapMM).toBeGreaterThan(3)
    const b = getBBox(r.d)!
    expect(b.cx).toBeCloseTo(20); expect(b.cy).toBeCloseTo(5)
    expect(b.width / b.height).toBeCloseTo(4)
  })

  // About the AREA centroid, not the bbox centre: a right triangle's centroid is (10, 10)
  // where its box's centre is (15, 15), and scaling about the box centre would push the
  // border toward the sloping side.
  it('scales about the area centroid, not the middle of the bounding box', () => {
    const r = applyScaleOffset('M0,0 L30,0 L0,30 Z', 2)!
    expect(r.cx).toBeCloseTo(10); expect(r.cy).toBeCloseTo(10)
    const b = getBBox(r.d)!
    expect(b.minX).toBeCloseTo(10 - 10 * r.scale); expect(b.minY).toBeCloseTo(10 - 10 * r.scale)
  })

  // One scale for the whole path, about one centre: a hole keeps its proportion and
  // its place in the shape instead of getting a border of its own.
  it('scales a hole with the shape, in proportion', () => {
    const r = applyScaleOffset(`${rect(0, 0, 20, 20)} ${rect(10, 5, 15, 15)}`, 2)!
    const [outer, hole] = r.d.split(/(?=M)/).map((d) => getBBox(d)!)
    expect(hole.width / outer.width).toBeCloseTo(5 / 20)
    expect(hole.height / outer.height).toBeCloseTo(10 / 20)
    expect((hole.minX - outer.minX) / outer.width).toBeCloseTo(10 / 20)
  })

  // Shrunk to its centroid a shape still has its outline's distance from that point as a
  // gap — an inset beyond that cannot be had by scaling.
  it('refuses an inset larger than scaling can reach', () => {
    expect(applyScaleOffset(circle(0, 0, 10), -10.5)).toBeNull()
  })

  it('refuses an outline with no area to scale about', () => {
    expect(applyScaleOffset('M0,0 L10,0', 2)).toBeNull()
  })
})
