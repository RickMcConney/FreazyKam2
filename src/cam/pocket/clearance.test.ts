// The travel predicate, tested against answers worked out by hand rather than against
// another implementation. Everything downstream trusts this, so the cases below are the
// ones that broke the thing it replaces: travel exactly along a wall, travel along an
// island's left flank as against its right, a point on a ring, a corner cut, and the
// degenerate collinear overlap.
import { describe, it, expect } from 'vitest'
import { buildPocketClearance, segSegDistSq } from './clearance'
import type { Pt2 } from '../pathFlattener'

const rect = (x0: number, y0: number, x1: number, y1: number): Pt2[] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const circle = (cx: number, cy: number, r: number, n = 256): Pt2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt2
  })

const dist = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) =>
  Math.sqrt(segSegDistSq(ax, ay, bx, by, cx, cy, dx, dy))

describe('segSegDistSq', () => {
  it('is zero for segments that cross', () => {
    expect(dist(0, 0, 10, 10, 0, 10, 10, 0)).toBeCloseTo(0, 12)
  })

  it('is zero for segments that merely touch at an endpoint', () => {
    expect(dist(0, 0, 5, 0, 5, 0, 5, 5)).toBeCloseTo(0, 12)
  })

  it('measures parallel segments across the gap', () => {
    expect(dist(0, 0, 10, 0, 0, 3, 10, 3)).toBeCloseTo(3, 12)
  })

  it('is zero for COLLINEAR OVERLAP — travel straight down a wall', () => {
    // The case that made three predicates disagree with each other. A move lying on top
    // of an edge is at distance zero from it, and that is the whole answer.
    expect(dist(0, 0, 10, 0, 4, 0, 12, 0)).toBeCloseTo(0, 12)
  })

  it('measures collinear segments that do NOT overlap along the line', () => {
    expect(dist(0, 0, 4, 0, 7, 0, 12, 0)).toBeCloseTo(3, 12)
  })

  it('clamps to the nearest endpoints when neither projects onto the other', () => {
    expect(dist(0, 0, 1, 0, 5, 4, 6, 4)).toBeCloseTo(Math.hypot(4, 4), 12)
  })

  it('handles a degenerate zero-length segment as a point', () => {
    expect(dist(3, 4, 3, 4, 0, 0, 10, 0)).toBeCloseTo(4, 12)
  })

  it('handles both segments degenerate', () => {
    expect(dist(0, 0, 0, 0, 3, 4, 3, 4)).toBeCloseTo(5, 12)
  })
})

describe('a rectangular pocket', () => {
  // Tool centre may go anywhere at least r from the wall: the box [13,13]-[67,47].
  const field = buildPocketClearance(rect(10, 10, 70, 50), [])
  const R = 3

  it('allows a stepover straight down the LEFT wall', () => {
    expect(field.isClear([13, 20], [13, 30], R)).toBe(true)
  })

  it('allows the identical stepover down the RIGHT wall', () => {
    // The bug that started all of this: pointInPolygon's half-open rule answered an
    // on-limit point by which wall it was, so one of these two was refused.
    expect(field.isClear([67, 20], [67, 30], R)).toBe(true)
  })

  it('gives the same answer at the top and bottom walls', () => {
    expect(field.isClear([20, 13], [30, 13], R)).toBe(true)
    expect(field.isClear([20, 47], [30, 47], R)).toBe(true)
  })

  it('refuses a move that comes closer to the wall than the tool radius', () => {
    expect(field.isClear([13, 20], [12.9, 30], R)).toBe(false)
    expect(field.isClear([67, 20], [67.1, 30], R)).toBe(false)
  })

  it('refuses by a hair, and allows by a hair, around exactly the radius', () => {
    expect(field.isClear([13.001, 20], [13.001, 30], R)).toBe(true)
    expect(field.isClear([12.999, 20], [12.999, 30], R)).toBe(false)
  })

  it('does not care which way round the move is stated', () => {
    expect(field.isClear([67, 30], [67, 20], R)).toBe(true)
    expect(field.isClear([12.9, 30], [13, 20], R)).toBe(false)
  })

  it('allows a long diagonal across the open middle', () => {
    expect(field.isClear([15, 15], [65, 45], R)).toBe(true)
  })

  it('refuses a diagonal that clips a corner', () => {
    // Cuts across the bottom-left corner of the pocket, where the tool would touch both
    // walls at once. Distance from the corner (10,10) to that chord is under 3.
    expect(field.isClear([14, 11.5], [11.5, 14], R)).toBe(false)
  })

  it('is insensitive to a few ulps, which a rotated raster produces', () => {
    // A scanline end computed by rotating into the pass frame and back lands just outside
    // the wall it was derived from. Distance answers that with no special case.
    expect(field.isClear([13 - 2e-15, 20], [13 - 2e-15, 30], R)).toBe(true)
  })
})

describe('a pocket with a square island', () => {
  const field = buildPocketClearance(rect(20, 20, 140, 100), [rect(60, 45, 100, 75)])
  const R = 3

  it('allows a stepover down the island\'s RIGHT flank', () => {
    expect(field.isClear([103, 50], [103, 70], R)).toBe(true)
  })

  it('allows the identical stepover down its LEFT flank', () => {
    // The third site of the same bug: the half-open rule read a midpoint on the left
    // flank as solid material and the right flank as open air.
    expect(field.isClear([57, 50], [57, 70], R)).toBe(true)
  })

  it('refuses a move that cuts through the island', () => {
    expect(field.isClear([57, 60], [103, 60], R)).toBe(false)
  })

  it('refuses a move that grazes the island closer than the radius', () => {
    expect(field.isClear([57.5, 50], [57.5, 70], R)).toBe(false)
  })

  it('allows travel past the corner where a MITERED ring claimed ground', () => {
    // Up the right flank and on past the island's (100,75) corner. Every point is at least
    // 3 from the island — along the flank exactly 3, past the corner more — so it is legal.
    // A miter join squares that corner off at (103,78) and refuses the whole move, claiming
    // r(sqrt2 - 1) = 1.24 mm of ground the tool can cross.
    expect(field.isClear([103, 70], [103, 78], R)).toBe(true)
    expect(field.isClear([103, 78], [96, 78], R)).toBe(true)
  })

  it('but refuses the DIAGONAL across that corner, which really does cut it', () => {
    // Worth stating, because it is the trap: the corner limit is an ARC, so a straight
    // line between any two points on it passes inside — at 45 degrees it comes within
    // r/sqrt2 = 2.12 mm of the corner. Rounding the ring does not make the diagonal legal.
    expect(field.isClear([103, 70], [98, 78], R)).toBe(false)
    expect(field.isClear([103, 75], [100, 78], R)).toBe(false)
  })

  it('allows travel between the island and the wall where there is room', () => {
    expect(field.isClear([103, 30], [103, 90], R)).toBe(true)
  })
})

describe('a pocket with a round island — the curved case', () => {
  const field = buildPocketClearance(circle(80, 80, 45), [circle(80, 80, 18)])
  const R = 3

  it('allows a chord along the outer wall, which is convex inward', () => {
    // Two points near the tool-centre limit of a convex pocket; the chord between them
    // lies INSIDE the pocket, so it is legal and the distance test says so.
    //
    // At radius 41.9, not 42: the ring is a 256-gon, whose edges sit 3.4 um inside the
    // circle they approximate, so a point at exactly 42 measures 2.9966 from it and is
    // rightly refused. That is the flattening, and the answer to it is LINK_MARGIN_MM in
    // raster.ts — stop the fill short — not a fudge here.
    const a: Pt2 = [80 + 41.9 * Math.cos(0.1), 80 + 41.9 * Math.sin(0.1)]
    const b: Pt2 = [80 + 41.9 * Math.cos(0.3), 80 + 41.9 * Math.sin(0.3)]
    expect(field.isClear(a, b, R)).toBe(true)
  })

  it('refuses a chord across the ISLAND, which curves the other way', () => {
    // The mirror image: two points on the island's limit, and the chord between them cuts
    // into the island. This is the one that genuinely has to lift.
    const a: Pt2 = [80 + 21 * Math.cos(0), 80 + 21 * Math.sin(0)]
    const b: Pt2 = [80 + 21 * Math.cos(1.2), 80 + 21 * Math.sin(1.2)]
    expect(field.isClear(a, b, R)).toBe(false)
  })

  it('allows a short enough chord past the island, where the bulge stays under the radius', () => {
    const a: Pt2 = [80 + 21.3 * Math.cos(0), 80 + 21.3 * Math.sin(0)]
    const b: Pt2 = [80 + 21.3 * Math.cos(0.08), 80 + 21.3 * Math.sin(0.08)]
    expect(field.isClear(a, b, R)).toBe(true)
  })
})

describe('containsPoint', () => {
  const field = buildPocketClearance(rect(20, 20, 140, 100), [rect(60, 45, 100, 75)])

  it('separates the pocket from its island and from the outside', () => {
    expect(field.containsPoint([30, 30])).toBe(true)
    expect(field.containsPoint([80, 60])).toBe(false) // in the island
    expect(field.containsPoint([10, 10])).toBe(false) // outside the boundary
  })
})

describe('the grid index finds the same edges a full scan would', () => {
  // The index is an optimisation, so it is checked against the unindexed answer rather
  // than trusted: any move whose exact distance is above the clearance must be allowed,
  // and any move below it refused, with no disagreement anywhere in the shape.
  const boundary = circle(100, 100, 60, 300)
  const islands = [circle(70, 100, 14, 120), circle(135, 112, 11, 120), rect(90, 60, 118, 78)]
  const field = buildPocketClearance(boundary, islands)
  const R = 4

  it('agrees with the exact minimum distance over a sweep of moves', () => {
    let checked = 0, disagreements = 0
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 60; j++) {
        const a: Pt2 = [55 + (i % 10) * 10, 55 + Math.floor(i / 10) * 10]
        const b: Pt2 = [55 + (j % 10) * 10, 55 + Math.floor(j / 10) * 10]
        if (a[0] === b[0] && a[1] === b[1]) continue
        const exact = field.segmentDistance(a, b)
        // Skip moves sitting within a rounding of the threshold, where the two can
        // legitimately land either side of it.
        if (Math.abs(exact - R) < 1e-9) continue
        checked++
        if (field.isClear(a, b, R) !== exact >= R) disagreements++
      }
    }
    expect(`${disagreements} disagreements in ${checked} moves`).toBe(`0 disagreements in ${checked} moves`)
    expect(checked).toBeGreaterThan(2000)
  })
})
