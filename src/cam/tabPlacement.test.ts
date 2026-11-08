import { describe, it, expect } from 'vitest'
import { tabPositions } from './tabPlacement'
import { flattenPath } from './pathFlattener'
import { designPathAtT } from './profile'

const SQUARE = 'M 0 0 L 40 0 L 40 40 L 0 40 Z'          // perimeter 160, starts on a corner
// The same square, its start halfway along the bottom side — even spacing then puts
// every tab of four exactly on a corner.
const SQUARE_MID_START = 'M 20 0 L 40 0 L 40 40 L 0 40 L 0 0 Z'
const CIRCLE = 'M 0 0 A 20 20 0 1 0 40 0 A 20 20 0 1 0 0 0 Z'
const CORNERS: [number, number][] = [[0, 0], [40, 0], [40, 40], [0, 40]]

const place = (d: string, count: number, lengthMM: number) => {
  const sp = flattenPath(d, 0.05)
  return tabPositions(sp, count, lengthMM).map((t) => designPathAtT(sp, t)!)
}
const gapsAround = (ts: number[]) => ts.map((t, i) => (ts[(i + 1) % ts.length] - t + 1) % 1)

describe('tab placement', () => {
  it('spreads eight tabs on a square evenly instead of stacking two on each side', () => {
    const ts = tabPositions(flattenPath(SQUARE, 0.05), 8, 5)
    for (const g of gapsAround(ts)) expect(g).toBeCloseTo(1 / 8, 6)
    const pts = place(SQUARE, 8, 5)
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])).toBeGreaterThan(5)
  })

  it('still puts four tabs on a square at the middle of each side', () => {
    const pts = place(SQUARE, 4, 5)
    expect(pts.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]))
      .toEqual([[20, 0], [40, 20], [20, 40], [0, 20]])
  })

  it('slides a tab that would straddle a corner along its side until its whole length clears it', () => {
    const pts = place(SQUARE_MID_START, 4, 5)
    for (const [x, y] of pts)
      for (const [cx, cy] of CORNERS)
        // half the tab (2.5) plus the 1 mm clearance, measured along the side
        expect(Math.hypot(x - cx, y - cy)).toBeGreaterThanOrEqual(3.5 - 1e-6)
    // …and only as far as it must: each stays 3.5 mm from the corner it was on
    const nearest = pts.map(([x, y]) => Math.min(...CORNERS.map(([cx, cy]) => Math.hypot(x - cx, y - cy))))
    for (const n of nearest) expect(n).toBeCloseTo(3.5, 6)
  })

  it('leaves tabs on a circle exactly evenly spaced — a curve\'s facets are not corners', () => {
    const ts = tabPositions(flattenPath(CIRCLE, 0.05), 6, 5)
    for (const g of gapsAround(ts)) expect(g).toBeCloseTo(1 / 6, 9)
  })

  it('centres a tab on a side too short to hold it clear of both corners', () => {
    // A 4 × 40 strip, perimeter 88: one tab's even spot (44) is the corner at the top of
    // the right side, and the run past it is the 4 mm top — too short to clear both ends.
    const sp = flattenPath('M 0 0 L 4 0 L 4 40 L 0 40 Z', 0.05)
    const [x, y] = designPathAtT(sp, tabPositions(sp, 1, 5)[0])!
    expect(x).toBeCloseTo(2, 6)
    expect(y).toBeCloseTo(40, 6)
  })
})
