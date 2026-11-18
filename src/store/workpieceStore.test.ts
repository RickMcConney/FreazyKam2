// displayFieldBounds: a length field holds and takes mm, and shows the user's units. Its
// limits and step are given in mm too, and must be converted with the value — handed over
// unconverted, an inch-mode min of 10 (mm) is a 10-INCH floor, and the field clamps every
// stepper click and every blur up to it.
import { describe, it, expect } from 'vitest'
import { displayFieldBounds } from './workpieceStore'

describe('a length field\'s min, max and step are mm, shown in the user\'s units', () => {
  it('converts a 10 mm minimum to 0.3937 in, not a 10 in floor', () => {
    expect(displayFieldBounds('in', { min: 10 }).min).toBeCloseTo(10 / 25.4, 4)
  })

  it('converts the maximum the same way', () => {
    expect(displayFieldBounds('in', { min: 0, max: 254 }).max).toBeCloseTo(10, 4)
  })

  it('leaves mm-mode bounds exactly as given', () => {
    expect(displayFieldBounds('mm', { min: 10, max: 300, step: 0.5 })).toEqual({ min: 10, max: 300, step: 0.5 })
  })

  it('turns an mm step into a usable inch step rather than a 10 in one', () => {
    // Max wheel Ø steps by 10 mm: about 0.39 in, which snaps to 0.25 in.
    expect(displayFieldBounds('in', { step: 10 }).step).toBe(0.25)
    // A 0.05 mm clearance step is about 0.002 in.
    expect(displayFieldBounds('in', { step: 0.05 }).step).toBe(0.002)
  })

  it('steps a length by 1 mm, or 1/16 in, when no step is given', () => {
    expect(displayFieldBounds('mm', {}).step).toBe(1)
    expect(displayFieldBounds('in', {}).step).toBe(0.0625)
  })

  it('never converts a count: 12 teeth minimum is 12 in either unit', () => {
    expect(displayFieldBounds('in', { min: 12, max: 200, integer: true })).toEqual({ min: 12, max: 200, step: 1 })
  })
})
