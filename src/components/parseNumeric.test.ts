import { describe, it, expect } from 'vitest'
import { parseNumeric, isPartialFraction, isExpression } from './parseNumeric'

describe('parseNumeric', () => {
  it('reads plain decimals as before', () => {
    expect(parseNumeric('12.7')).toBe(12.7)
    expect(parseNumeric('.5')).toBe(0.5)
    expect(parseNumeric('2.')).toBe(2)
    expect(parseNumeric('-3')).toBe(-3)
    expect(parseNumeric(' 6 ')).toBe(6)
  })

  it('reads the fractions a shop writes', () => {
    expect(parseNumeric('1/2')).toBe(0.5)
    expect(parseNumeric('1/8')).toBe(0.125)
    expect(parseNumeric('3/16')).toBe(0.1875)
    expect(parseNumeric('1/4')).toBe(0.25)
  })

  it('reads mixed numbers, space or hyphen separated', () => {
    expect(parseNumeric('1 1/2')).toBe(1.5)
    expect(parseNumeric('1-1/2')).toBe(1.5)
    expect(parseNumeric('2 3/8')).toBe(2.375)
    expect(parseNumeric('10-1/16')).toBe(10.0625)
  })

  it('applies a leading sign to the whole quantity', () => {
    // The hyphen inside a mixed number is a separator, so the sign has to be read first
    // or -1-1/2 comes out as -1 + 0.5.
    expect(parseNumeric('-1/2')).toBe(-0.5)
    expect(parseNumeric('-1 1/2')).toBe(-1.5)
    expect(parseNumeric('-1-1/2')).toBe(-1.5)
    expect(parseNumeric('+1/2')).toBe(0.5)
  })

  it('ignores trailing inch marks', () => {
    expect(parseNumeric('1/2"')).toBe(0.5)
    expect(parseNumeric('1-1/2″')).toBe(1.5)
    expect(parseNumeric('0.375"')).toBe(0.375)
  })

  it('rejects what is not a number rather than guessing', () => {
    expect(parseNumeric('')).toBeNull()
    expect(parseNumeric('   ')).toBeNull()
    expect(parseNumeric('abc')).toBeNull()
    expect(parseNumeric('1/0')).toBeNull()   // must not reach a field as Infinity
    expect(parseNumeric('/2')).toBeNull()
    // A slash means it is a fraction or it is nothing — never parseFloat's leading digits.
    expect(parseNumeric('1/')).toBeNull()
    expect(parseNumeric('1/2/3')).toBeNull()
    expect(parseNumeric('a/b')).toBeNull()
  })

  it('never silently truncates a fraction the way parseFloat does', () => {
    // The regression this exists to prevent: parseFloat('1/8') is 1, so a typed 1/8 used
    // to become a 1 mm cut.
    expect(parseFloat('1/8')).toBe(1)
    expect(parseNumeric('1/8')).toBe(0.125)
    expect(parseFloat('1-1/2')).toBe(1)
    expect(parseNumeric('1-1/2')).toBe(1.5)
  })
})

describe('parseNumeric with a leading =', () => {
  it('hands an = expression to the arithmetic parser', () => {
    expect(parseNumeric('=24/2')).toBe(12)
    expect(parseNumeric('=(18-2)/3')).toBeCloseTo(5.333333, 6)
    expect(parseNumeric(' = 6 * 4 ')).toBe(24)
  })

  it('reads the hyphen as MINUS once there is an =, unlike the bare field', () => {
    // The one place the two notations disagree, and the reason '=' is a switch rather
    // than a convenience: without it a shop's 1-1/2 is one and a half.
    expect(parseNumeric('1-1/2')).toBe(1.5)
    expect(parseNumeric('=1-1/2')).toBe(0.5)
  })

  it('still strips inch marks before deciding what the text is', () => {
    expect(parseNumeric('=1/2"')).toBe(0.5)
  })

  it('rejects a bad expression outright — never falls back to the fraction reading', () => {
    expect(parseNumeric('=')).toBeNull()
    expect(parseNumeric('=2+')).toBeNull()
    expect(parseNumeric('=1/0')).toBeNull()
    expect(parseNumeric('=1 1/2')).toBeNull()   // a mixed number is not an expression
  })
})

describe('isExpression', () => {
  it('claims anything opening with an =, so it can be held back until Enter', () => {
    expect(isExpression('=24/2')).toBe(true)
    expect(isExpression('  =2')).toBe(true)
    expect(isExpression('=')).toBe(true)        // incomplete, and still an expression
  })

  it('leaves ordinary entry alone', () => {
    expect(isExpression('24/2')).toBe(false)
    expect(isExpression('1-1/2')).toBe(false)
    expect(isExpression('')).toBe(false)
  })
})

describe('isPartialFraction', () => {
  it('holds off while a fraction is still being typed', () => {
    expect(isPartialFraction('1/')).toBe(true)
    expect(isPartialFraction('1 1/')).toBe(true)
    expect(isPartialFraction('-3/')).toBe(true)
    expect(isPartialFraction('1/0')).toBe(true)   // not yet a value; keep waiting
  })

  it('lets a complete number through', () => {
    expect(isPartialFraction('1/8')).toBe(false)
    expect(isPartialFraction('1')).toBe(false)
    expect(isPartialFraction('1.5')).toBe(false)
    expect(isPartialFraction('')).toBe(false)
  })
})
