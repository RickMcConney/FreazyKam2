import { describe, it, expect } from 'vitest'
import { nudgeStopDelta, nextStepPoint, equalSpacingSnap } from './objectSnap'

const ON_LINE = 0.005

describe('nextStepPoint', () => {
  it('continues from a guide stop to the next whole step, not a step past the guide', () => {
    expect(nextStepPoint(12.4, 1, 1, ON_LINE)).toBeCloseTo(13, 9)
    expect(nextStepPoint(12.4, 1, -1, ON_LINE)).toBeCloseTo(12, 9)
  })

  it('moves a whole step off a point it already sits on, float noise included', () => {
    expect(nextStepPoint(12.999999, 1, 1, ON_LINE)).toBeCloseTo(14, 9)
    expect(nextStepPoint(13.000001, 1, -1, ON_LINE)).toBeCloseTo(12, 9)
  })

  it('uses the step it is given, so Alt and Shift keep their own spacing', () => {
    expect(nextStepPoint(0.43, 0.1, 1, ON_LINE)).toBeCloseTo(0.5, 9)
    expect(nextStepPoint(-7, 10, -1, ON_LINE)).toBeCloseTo(-10, 9)
  })
})

describe('nudgeStopDelta', () => {
  it('stops on a line the step would jump over', () => {
    expect(nudgeStopDelta([0], [0.4], 0, 1, ON_LINE)).toBeCloseTo(0.4, 9)
  })

  it('takes the full step when no line lies within it', () => {
    expect(nudgeStopDelta([0], [5], 0, 1, ON_LINE)).toBe(1)
  })

  it('leaves a line the edge already sits on', () => {
    expect(nudgeStopDelta([0], [0.4], 0.4, 1.4, ON_LINE)).toBe(1.4)
  })

  it('ignores a line behind the direction of travel', () => {
    expect(nudgeStopDelta([0], [-0.5], 0, 1, ON_LINE)).toBe(1)
  })

  it('stops at the nearest line over every edge when moving left', () => {
    // The right edge (10) meets 9.5 after 0.5; the left edge (0) would meet -3 only after 3.
    expect(nudgeStopDelta([0, 10], [-3, 9.5], 0, -4, ON_LINE)).toBeCloseTo(-0.5, 9)
  })

  it('lands on a line the step reaches exactly', () => {
    expect(nudgeStopDelta([0], [1], 0, 1, ON_LINE)).toBe(1)
  })
})

describe('equalSpacingSnap', () => {
  // A w × h box with its lower-left corner at (x, y).
  const box = (x: number, y = 0, w = 10, h = 10) => ({ minX: x, maxX: x + w, minY: y, maxY: y + h })

  it('centres a box between two neighbours so both gaps are equal, and marks both gaps', () => {
    const r = equalSpacingSnap(box(21), [box(0), box(40)], 'x', 2)!
    expect(r.correction).toBeCloseTo(-1, 9)
    expect(r.marks.map((m) => [m.from, m.to])).toEqual([[10, 20], [30, 40]])
  })

  it('takes the gap of the pair beside it, on the right of the pair', () => {
    const r = equalSpacingSnap(box(59), [box(0), box(30)], 'x', 2)!
    expect(r.correction).toBeCloseTo(1, 9)
    expect(r.marks.map((m) => m.to - m.from)).toEqual([20, 20])
  })

  it('takes the gap of the pair beside it, on the left of the pair', () => {
    const r = equalSpacingSnap(box(-31), [box(0), box(30)], 'x', 2)!
    expect(r.correction).toBeCloseTo(1, 9)
    expect(r.marks.map((m) => [m.from, m.to])).toEqual([[-20, 0], [10, 30]])
  })

  it('spaces a column the same way along y', () => {
    const r = equalSpacingSnap(box(0, 59), [box(0, 0), box(0, 30)], 'y', 2)!
    expect(r.correction).toBeCloseTo(1, 9)
    expect(r.marks.every((m) => m.axis === 'y')).toBe(true)
  })

  it('ignores boxes outside the dragged box\'s row', () => {
    expect(equalSpacingSnap(box(59, 50), [box(0), box(30)], 'x', 2)).toBeNull()
  })

  it('offers nothing further away than the tolerance', () => {
    expect(equalSpacingSnap(box(63), [box(0), box(30)], 'x', 2)).toBeNull()
  })

  it('does not offer a zero gap between touching neighbours', () => {
    // A and B touch, so "the same gap as A–B" would butt C against B.
    expect(equalSpacingSnap(box(20.5), [box(0), box(10)], 'x', 2)).toBeNull()
  })

  it('picks the nearer of two candidates', () => {
    // At 21: between A (0–10) and B (40–50) wants 20, 1 away; beside the pair to its left
    // (−15–−5 and A, a 5 gap) wants 15, 6 away. Both are within 8 — the nearer wins.
    const r = equalSpacingSnap(box(21), [box(-15), box(0), box(40)], 'x', 8)!
    expect(r.correction).toBeCloseTo(-1, 9)
  })
})
