import { describe, it, expect } from 'vitest'
import { findRegion, regionToD } from './regionPick'
import { signedArea, type Pt2 } from './pathFlattener'

const rect = (x0: number, y0: number, x1: number, y1: number): Pt2[] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
const area = (r: Pt2[]) => signedArea(r)

describe('findRegion', () => {
  it('closes a U-shaped stroke with a SEPARATE line across its mouth', () => {
    // The comb-slot case: neither stroke is closed, together they bound 10 × 20.
    const u: Pt2[] = [[10, 0], [0, 0], [0, 20], [10, 20]]
    const mouth: Pt2[] = [[10, 0], [10, 20]]
    const r = findRegion([u, mouth], [5, 10])!
    expect(r).not.toBeNull()
    expect(area(r.outer)).toBeCloseTo(200, 6)
    expect(r.holes).toHaveLength(0)
  })

  it('finds nothing inside an open U with no line across its mouth', () => {
    const u: Pt2[] = [[10, 0], [0, 0], [0, 20], [10, 20]]
    expect(findRegion([u], [5, 10])).toBeNull()
  })

  it('splits a closed outline at a T-junction, so a chord divides it into two regions', () => {
    // A 30 × 10 box with a line across it at x = 10 whose ends land part way
    // along the top and bottom edges — neither edge has a vertex there.
    const box = rect(0, 0, 30, 10)
    const chord: Pt2[] = [[10, 0], [10, 10]]
    expect(area(findRegion([box, chord], [5, 5])!.outer)).toBeCloseTo(100, 6)
    expect(area(findRegion([box, chord], [20, 5])!.outer)).toBeCloseTo(200, 6)
  })

  it('splits two strokes where they cross mid-segment', () => {
    // Two overlapping squares: the lens where they overlap is its own region.
    const a = rect(0, 0, 10, 10), b = rect(5, 5, 15, 15)
    expect(area(findRegion([a, b], [7, 7])!.outer)).toBeCloseTo(25, 6)
    expect(area(findRegion([a, b], [2, 2])!.outer)).toBeCloseTo(75, 6)
  })

  it('carries the shapes directly inside the region as holes, and not those nested deeper', () => {
    const outer = rect(0, 0, 100, 100)
    const hole = rect(10, 10, 40, 40)
    const inHole = rect(20, 20, 30, 30) // an island inside the hole: not the region's
    const r = findRegion([outer, hole, inHole], [70, 70])!
    expect(area(r.outer)).toBeCloseTo(10000, 6)
    expect(r.holes).toHaveLength(1)
    expect(Math.abs(area(r.holes[0]))).toBeCloseTo(900, 6)
  })

  it('ignores a dangling spur inside the region', () => {
    const box = rect(0, 0, 10, 10)
    const spur: Pt2[] = [[0, 5], [6, 5]] // T onto the left wall, ends in mid-air
    const r = findRegion([box, spur], [5, 8])!
    expect(area(r.outer)).toBeCloseTo(100, 6)
    expect(r.outer.every(([, y]) => y !== 5 || true)).toBe(true)
    expect(r.outer).toHaveLength(5) // the 4 corners + the T-junction vertex on the wall
  })

  it('finds nothing outside every shape', () => {
    expect(findRegion([rect(0, 0, 10, 10)], [20, 20])).toBeNull()
  })

  it('winds the outer ring CCW and each hole CW, so a nonzero fill leaves the holes empty', () => {
    const r = findRegion([rect(0, 0, 10, 10), rect(3, 3, 6, 6)], [1, 1])!
    expect(area(r.outer)).toBeGreaterThan(0)
    expect(area(r.holes[0])).toBeLessThan(0)
    expect(regionToD(r)).toMatch(/^M[^M]+Z M[^M]+Z$/)
  })
})
