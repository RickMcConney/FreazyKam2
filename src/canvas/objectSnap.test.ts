import { describe, it, expect } from 'vitest'
import { nudgeStopDelta, nextStepPoint } from './objectSnap'

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
