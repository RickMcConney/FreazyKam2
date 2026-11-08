import { describe, it, expect } from 'vitest'
import { feedFromMM, feedToMM, feedValue, fmtFeed, feedStep, feedUnit } from './workpieceStore'

describe('feed display units (stored mm/min, shown per minute or per second)', () => {
  it('names the unit from both toggles', () => {
    expect(feedUnit('mm', 'min')).toBe('mm/min')
    expect(feedUnit('mm', 's')).toBe('mm/s')
    expect(feedUnit('in', 'min')).toBe('in/min')
    expect(feedUnit('in', 's')).toBe('in/s')
  })

  it('shows 1200 mm/min as 20 mm/s and 0.7874 in/s', () => {
    expect(feedFromMM(1200, 'mm', 's')).toBe(20)
    expect(feedFromMM(1200, 'in', 's')).toBeCloseTo(0.7874, 4)
  })

  it('stores a typed per-second feed as sixty times as many mm/min', () => {
    expect(feedToMM(20, 'mm', 's')).toBe(1200)
    expect(feedToMM(1, 'in', 's')).toBeCloseTo(1524, 6)
  })

  it('leaves the per-minute display exactly as it was', () => {
    expect(feedFromMM(1234, 'mm', 'min')).toBe(1234)
    expect(feedToMM(1234, 'mm', 'min')).toBe(1234)
    expect(fmtFeed(3000, 'mm', 'min')).toBe('3000 mm/min')
    expect(fmtFeed(3000, 'in', 'min')).toBe('118.1 in/min')
  })

  it('reads a per-second feed to a tenth of a mm or a hundredth of an inch', () => {
    expect(feedValue(1000, 'mm', 's')).toBe('16.7')
    expect(feedValue(1000, 'in', 's')).toBe('0.66')
    expect(fmtFeed(3000, 'mm', 's')).toBe('50.0 mm/s')
  })

  it('snaps a per-second arrow-key step to a 1-2-5 number rather than 0.8333', () => {
    expect(feedStep(50, 'mm', 's')).toBe(1)
    expect(feedStep(10, 'mm', 's')).toBe(0.2)
    expect(feedStep(50, 'mm', 'min')).toBe(50)
    expect(feedStep(50, 'in', 'min')).toBe(2)
  })
})
