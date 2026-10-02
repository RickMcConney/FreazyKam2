// Ported from WoodCAM's tests/vector2d/unit/test_common_line.py (MIT) — the detection
// cases. The two performance cases there spy on private functions; here they pin the
// broad phase directly instead.

import { describe, it, expect } from 'vitest'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import {
  planCommonLineCut, perimeterFor, totalCutLength, segmentLength, requireValid, isPlanValid, hasCommonLines,
  candidateSegmentPairs, CommonLinePlanningError,
  type CommonLineContour, type CommonLinePlan,
} from './commonLine'
import type { Pt2 } from './pathFlattener'

function rect(id: string, x0: number, y0: number, x1: number, y1: number, clockwise = false): CommonLineContour {
  const points: Pt2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  return { id, points: clockwise ? points.reverse() : points }
}

const codes = (p: CommonLinePlan) => new Set(p.issues.map((i) => i.code))

/** Outside offset of one closed ring, as the profile op would make it but with the given corner join. */
function offset(ring: Pt2[], delta: number, join: JoinType): Pt2[] {
  const out = inflatePathsD([ring.map(([x, y]) => ({ x, y }))], delta, join, EndType.Polygon, 4, 6)
  expect(out).toHaveLength(1)
  return out[0].map(({ x, y }) => [x, y] as Pt2)
}

describe('planCommonLineCut — compensated outlines', () => {
  // Two blunt tips facing each other, one 4 mm cutter diameter apart. The cutter's real
  // sweep round each tip only just touches the other part's; a mitred offset runs past it.
  const leftTip: Pt2[] = [[0, 0], [20, 100], [0, 200]]
  const rightTip: Pt2[] = [[44, 0], [24, 100], [44, 200]]

  it('a round-cornered offset of two tips one diameter apart does not cross', () => {
    const plan = planCommonLineCut([
      { id: 'left', points: offset(leftTip, 2, JoinType.Round) },
      { id: 'right', points: offset(rightTip, 2, JoinType.Round) },
    ], 0.02)
    expect(plan.issues).toEqual([])
  })

  it('a mitred offset of the same tips overshoots the cutter and crosses', () => {
    const plan = planCommonLineCut([
      { id: 'left', points: offset(leftTip, 2, JoinType.Miter) },
      { id: 'right', points: offset(rightTip, 2, JoinType.Miter) },
    ], 0.02)
    expect(codes(plan)).toContain('crossing')
  })

  it('round compensation keeps the straight shared centre-line of two squares one diameter apart', () => {
    const plan = planCommonLineCut([
      { id: 'left', points: offset([[0, 0], [20, 0], [20, 20], [0, 20]], 2, JoinType.Round) },
      { id: 'right', points: offset([[24, 0], [44, 0], [44, 20], [24, 20]], 2, JoinType.Round) },
    ], 0.02)
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.sharedSegments).toHaveLength(1)
    expect(segmentLength(plan.sharedSegments[0])).toBeCloseTo(20, 9)
  })

  it('a 0.2 mm matching tolerance does not flatten the round corners away from the shared edge', () => {
    const plan = planCommonLineCut([
      { id: 'left', points: offset([[0, 0], [80, 0], [80, 40], [0, 40]], 3, JoinType.Round) },
      { id: 'right', points: offset([[86, 0], [166, 0], [166, 40], [86, 40]], 3, JoinType.Round) },
    ], 0.2)
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.sharedSegments).toHaveLength(1)
    expect(segmentLength(plan.sharedSegments[0])).toBeCloseTo(40, 9)
  })

  it('a hole orbit with chords shorter than the matching tolerance is not read as self-touching', () => {
    // A Ø5.3 mm hole cut with a Ø4 mm cutter: a 0.65 mm centre-line radius in 36 chords of
    // ~0.11 mm, shorter than the 0.2 mm tolerance but neither duplicated nor null.
    const r = 0.649425
    const orbit: Pt2[] = Array.from({ length: 36 }, (_, i) => [r * Math.cos((2 * Math.PI * i) / 36), r * Math.sin((2 * Math.PI * i) / 36)])
    expect(planCommonLineCut([{ id: 'internal-0001', points: orbit }], 0.2).issues).toEqual([])
  })
})

describe('planCommonLineCut — what is shared', () => {
  it('a lone part is all perimeter', () => {
    const plan = planCommonLineCut([rect('A', 0, 0, 10, 10)])
    expect(isPlanValid(plan)).toBe(true)
    expect(hasCommonLines(plan)).toBe(false)
    expect(plan.perimeterSegments).toHaveLength(4)
    expect(perimeterFor(plan, 'A')).toHaveLength(4)
    expect(totalCutLength(plan)).toBeCloseTo(40, 12)
  })

  it('a whole common edge is cut once, owned by both parts', () => {
    const plan = planCommonLineCut([rect('left', 0, 0, 10, 10), rect('right', 10, 0, 20, 10)])
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.perimeterSegments).toHaveLength(6)
    expect(plan.sharedSegments).toHaveLength(1)
    const s = plan.sharedSegments[0]
    expect(s.ownerIds).toEqual(['left', 'right'])
    expect(s.start).toEqual([10, 0])
    expect(s.end).toEqual([10, 10])
    expect(totalCutLength(plan)).toBeCloseTo(70, 12)
    expect(plan.touchPoints).toEqual([])
  })

  it('opposite windings and extra collinear points on the edge still share it as one span', () => {
    const left: CommonLineContour = { id: 'left', points: [[0, 0], [10, 0], [10, 4], [10, 10], [0, 10], [0, 0]] }
    const right: CommonLineContour = { id: 'right', points: [[10, 10], [20, 10], [20, 0], [10, 0], [10, 5], [10, 10]] }
    const plan = planCommonLineCut([left, right])
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.sharedSegments).toHaveLength(1)
    expect(segmentLength(plan.sharedSegments[0])).toBeCloseTo(10, 12)
  })

  it('a partly common edge is split so only the owned intervals are shared', () => {
    const plan = planCommonLineCut([rect('main', 0, 0, 10, 10), rect('low', 10, 0, 20, 4), rect('high', 10, 6, 20, 10)])
    expect(isPlanValid(plan)).toBe(true)
    const shared = [...plan.sharedSegments]
      .sort((a, b) => a.start[0] - b.start[0] || a.start[1] - b.start[1])
      .map((s) => [s.start, s.end, s.ownerIds])
    expect(shared).toEqual([
      [[10, 0], [10, 4], ['low', 'main']],
      [[10, 6], [10, 10], ['high', 'main']],
    ])
    const gap = perimeterFor(plan, 'main').filter((s) => s.start[0] === 10 && s.end[0] === 10)
    expect(gap).toHaveLength(1)
    expect(gap[0].start).toEqual([10, 4])
    expect(gap[0].end).toEqual([10, 6])
  })

  it('collinear points on either side of a shared edge do not split it', () => {
    const left: CommonLineContour = { id: 'left', points: [[0, 0], [10, 0], [10, 3], [10, 7], [10, 10], [0, 10]] }
    const right: CommonLineContour = { id: 'right', points: [[10, 0], [20, 0], [20, 10], [10, 10], [10, 5]] }
    const plan = planCommonLineCut([left, right])
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.sharedSegments).toHaveLength(1)
    expect(plan.sharedSegments[0].start).toEqual([10, 0])
    expect(plan.sharedSegments[0].end).toEqual([10, 10])
  })

  // The case above never reaches the merge: normalisation deletes those collinear points
  // first. A vertex just off the line (beyond the 1e-7 normalisation floor, within the
  // 1e-6 match) survives normalisation and really does split the edge in two.
  it('two shared pieces with the same two owners, split at a vertex just off the line, are merged into one span', () => {
    const right: CommonLineContour = { id: 'right', points: [[10, 0], [20, 0], [20, 10], [10, 10], [10.0000003, 5]] }
    const plan = planCommonLineCut([rect('left', 0, 0, 10, 10), right], 1e-6)
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.sharedSegments).toHaveLength(1)
    expect(plan.sharedSegments[0].start).toEqual([10, 0])
    expect(plan.sharedSegments[0].end).toEqual([10, 10])
    expect(plan.sharedSegments[0].sourceSegments).toHaveLength(3)
  })

  it('corners that only meet at a point are allowed, reported as a touch, and share nothing', () => {
    const plan = planCommonLineCut([rect('a', 0, 0, 10, 10), rect('b', 10, 10, 20, 20)])
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.sharedSegments).toEqual([])
    expect(plan.touchPoints).toEqual([[10, 10]])
    expect(plan.perimeterSegments).toHaveLength(8)
  })

  it('a tip meeting the middle of an edge (a T contact) is allowed', () => {
    const plan = planCommonLineCut([rect('plate', 0, 0, 10, 10), { id: 'tip', points: [[10, 5], [15, 3], [15, 7]] }])
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.sharedSegments).toEqual([])
    expect(plan.touchPoints).toEqual([[10, 5]])
  })

  it('edges within the tolerance of each other are one shared line', () => {
    const plan = planCommonLineCut([rect('a', 0, 0, 10, 10), rect('b', 10.0000005, 0, 20, 10)], 1e-6)
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.sharedSegments).toHaveLength(1)
    expect(segmentLength(plan.sharedSegments[0])).toBeCloseTo(10, 6)
  })

  it('a gap wider than the tolerance neither shares nor touches', () => {
    const plan = planCommonLineCut([rect('a', 0, 0, 10, 10), rect('b', 10.01, 0, 20, 10)], 1e-4)
    expect(isPlanValid(plan)).toBe(true)
    expect(plan.sharedSegments).toEqual([])
    expect(plan.touchPoints).toEqual([])
    expect(plan.perimeterSegments).toHaveLength(8)
  })
})

describe('planCommonLineCut — what blocks the whole plan', () => {
  it('a duplicated part is refused even when reversed and re-segmented, and the plan carries no segments', () => {
    const second: CommonLineContour = { id: 'second', points: [[10, 10], [10, 5], [10, 0], [0, 0], [0, 10], [10, 10]] }
    const plan = planCommonLineCut([rect('first', 0, 0, 10, 10), second])
    expect(isPlanValid(plan)).toBe(false)
    expect(codes(plan)).toContain('duplicate_contour')
    expect(plan.perimeterSegments).toEqual([])
    expect(plan.sharedSegments).toEqual([])
  })

  it('boundaries that really cross are refused, with the crossing points', () => {
    const plan = planCommonLineCut([rect('a', 0, 0, 10, 10), rect('b', 5, -5, 15, 5)])
    expect(isPlanValid(plan)).toBe(false)
    const crossing = plan.issues.find((i) => i.code === 'crossing')!
    expect(crossing).toBeDefined()
    const pts = crossing.points.map((p) => p.join(',')).sort()
    expect(pts).toEqual(['10,5', '5,0'])
  })

  it('one part wholly inside another is an area overlap even though no edge crosses', () => {
    const outer = rect('outer', 0, 0, 20, 20), inside = rect('inside', 5, 5, 15, 15)
    expect(codes(planCommonLineCut([outer, inside]))).toContain('area_overlap')
    expect(codes(planCommonLineCut([inside, outer]))).toContain('area_overlap')
  })

  it('a coincident edge with both interiors on the same side is an area overlap, not a common line', () => {
    const plan = planCommonLineCut([rect('large', 0, 0, 10, 10), rect('lower-half', 0, 0, 10, 5)])
    expect(codes(plan)).toContain('area_overlap')
    expect(plan.sharedSegments).toEqual([])
  })

  it('a bow-tie ring is refused as self-intersecting', () => {
    const plan = planCommonLineCut([{ id: 'bow', points: [[0, 0], [10, 10], [0, 10], [10, 0]] }])
    expect(codes(plan)).toContain('self_intersection')
  })

  it('an edge that doubles back along itself is refused as self-intersecting', () => {
    const plan = planCommonLineCut([{ id: 'backtrack', points: [[0, 0], [10, 0], [5, 0], [10, 10], [0, 10]] }])
    expect(codes(plan)).toContain('self_intersection')
  })

  it('a line with three owners is ambiguous, and the issue names all three', () => {
    const plan = planCommonLineCut([rect('left', 0, 0, 10, 10), rect('right-wide', 10, 0, 20, 10), rect('right-narrow', 10, 0, 15, 10)])
    const amb = plan.issues.find((i) => i.code === 'ambiguous_shared_line')
    expect(amb?.contourIds).toEqual(['left', 'right-narrow', 'right-wide'])
  })

  it('requireValid throws a CommonLinePlanningError carrying the issues', () => {
    const plan = planCommonLineCut([rect('outer', 0, 0, 20, 20), rect('inner', 2, 2, 3, 3)])
    let caught: unknown
    try { requireValid(plan) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(CommonLinePlanningError)
    expect((caught as CommonLinePlanningError).issues).toEqual(plan.issues)
  })

  it('a repeated id is refused, and a non-positive or non-finite tolerance throws', () => {
    const plan = planCommonLineCut([rect('same', 0, 0, 1, 1), rect('same', 2, 0, 3, 1)])
    expect(codes(plan)).toContain('invalid_contour')
    for (const t of [0, -1, Infinity, NaN]) expect(() => planCommonLineCut([], t)).toThrow(RangeError)
  })

  it('a ring with fewer than three distinct points is refused', () => {
    const plan = planCommonLineCut([{ id: 'line', points: [[0, 0], [10, 0], [0, 0]] }])
    expect(codes(plan)).toContain('invalid_contour')
  })
})

describe('planCommonLineCut — purity and determinism', () => {
  it('normalising a ring does not mutate the caller\'s points', () => {
    const points: Pt2[] = [[0, 0], [10, 0], [10, 5], [10, 10], [0, 10], [0, 0]]
    const snapshot = JSON.stringify(points)
    expect(isPlanValid(planCommonLineCut([{ id: 'source', points }]))).toBe(true)
    expect(JSON.stringify(points)).toBe(snapshot)
  })

  it('shared spans and their owner order do not depend on input order or winding', () => {
    const z = rect('z-piece', 0, 0, 10, 10, true)
    const a = rect('a-piece', 10, 0, 20, 10)
    const direct = planCommonLineCut([z, a])
    const reversed = planCommonLineCut([a, z])
    expect(isPlanValid(direct) && isPlanValid(reversed)).toBe(true)
    expect(direct.sharedSegments.map((s) => [s.start, s.end, s.ownerIds])).toEqual(reversed.sharedSegments.map((s) => [s.start, s.end, s.ownerIds]))
    expect(direct.sharedSegments[0].ownerIds).toEqual(['a-piece', 'z-piece'])
    const { start, end } = direct.sharedSegments[0]
    expect(start[0] < end[0] || (start[0] === end[0] && start[1] <= end[1])).toBe(true)
  })
})

describe('candidateSegmentPairs — the broad phase', () => {
  const bounds = (a: Pt2, b: Pt2): [number, number, number, number] =>
    [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]

  it('a dense 720-chord circle yields a handful of candidates per chord, not every pair', () => {
    const n = 720
    const pts: Pt2[] = Array.from({ length: n }, (_, i) => [100 * Math.cos((2 * Math.PI * i) / n), 100 * Math.sin((2 * Math.PI * i) / n)])
    const pairs = candidateSegmentPairs(pts.map((p, i) => bounds(p, pts[(i + 1) % n])), undefined, 0.001)
    expect(pairs.length).toBeLessThan(n * 10)
    expect(isPlanValid(planCommonLineCut([{ id: 'dense-circle', points: pts }], 0.02))).toBe(true)
  })

  it('eighty separate parts in a row do not compare every edge with every other', () => {
    const contours = Array.from({ length: 80 }, (_, i) => rect(`piece-${i}`, i * 20, 0, i * 20 + 10, 10))
    const edges = contours.flatMap((c) => c.points.map((p, i) => bounds(p, c.points[(i + 1) % 4])))
    expect(candidateSegmentPairs(edges, undefined, 0.001).length).toBeLessThan(1000)
    expect(isPlanValid(planCommonLineCut(contours, 0.02))).toBe(true)
  })

  it('bounds that only touch are still a candidate pair', () => {
    expect(candidateSegmentPairs([[0, 0, 1, 1]], [[1, 0, 2, 1]])).toEqual([[0, 0]])
    expect(candidateSegmentPairs([[0, 0, 1, 1]], [[1.5, 0, 2, 1]])).toEqual([])
  })
})
