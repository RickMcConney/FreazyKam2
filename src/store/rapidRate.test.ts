// Rapids carry no F: the controller runs them at its own X/Y max rate, which the app is told
// as Rapid Rate. Left unset it is Max Feed Rate, as every estimate assumed before.
import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkpieceStore, rapidRateMmMin, machineMotionLimits } from './workpieceStore'
import { parseGcode } from '../sim/gcodeParser'

const NO_ACCEL = { accelXYMmS2: 0, accelZMmS2: 0 }

beforeEach(() => {
  useWorkpieceStore.setState({ maxFeedMmMin: 3000, rapidRateXYMmMin: 0, ...NO_ACCEL })
})

describe('Rapid Rate', () => {
  it('is Max Feed Rate until it is set, and its own number once it is', () => {
    expect(rapidRateMmMin({ maxFeedMmMin: 3000, rapidRateXYMmMin: 0 })).toBe(3000)
    expect(rapidRateMmMin({ maxFeedMmMin: 3000, rapidRateXYMmMin: 8000 })).toBe(8000)
  })

  it('times a rapid at the controller\'s rate, not at the cutting ceiling', () => {
    const metre = 'G21 G90\nG0 X1000 Y0 Z5'
    const time = () => parseGcode(metre, 5, machineMotionLimits()).totalTimeS
    expect(time()).toBeCloseTo(20, 6)            // unset: 1000 mm at Max Feed Rate's 3000 mm/min
    useWorkpieceStore.setState({ rapidRateXYMmMin: 6000 })
    expect(time()).toBeCloseTo(10, 6)            // a 6000 mm/min controller does it in half
  })

  it('times a written feed at its own F, up to the controller\'s rate — Max Feed Rate caps what is WRITTEN, not how it is timed', () => {
    // An imported program's F4000 on a 6000 mm/min controller runs at 4000, whatever this
    // app's own cutting ceiling (3000) says.
    useWorkpieceStore.setState({ rapidRateXYMmMin: 6000 })
    expect(parseGcode('G21 G90\nG1 X1000 Y0 Z5 F4000', 5, machineMotionLimits()).totalTimeS).toBeCloseTo(15, 6)
  })
})
