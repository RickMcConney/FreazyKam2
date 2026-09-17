import { describe, it, expect } from 'vitest'
import { evalExpression } from './expr'

describe('evalExpression', () => {
  it('does the arithmetic a shop does on the back of a drawing', () => {
    expect(evalExpression('24/2')).toBe(12)
    expect(evalExpression('25.4/8')).toBe(3.175)
    expect(evalExpression('(18-2)/3')).toBeCloseTo(5.333333, 6)
    expect(evalExpression('6*4')).toBe(24)
    expect(evalExpression('18 - 2.5')).toBe(15.5)
  })

  it('multiplies before it adds', () => {
    expect(evalExpression('2+3*4')).toBe(14)
    expect(evalExpression('2*3+4')).toBe(10)
    expect(evalExpression('12-6/2')).toBe(9)
  })

  it('lets brackets override precedence', () => {
    expect(evalExpression('(2+3)*4')).toBe(20)
    expect(evalExpression('2*(3+4)')).toBe(14)
    expect(evalExpression('((10))')).toBe(10)
  })

  it('subtracts and divides left to right', () => {
    // Right-associating either one silently changes the answer: 10-3-2 would be 9.
    expect(evalExpression('10-3-2')).toBe(5)
    expect(evalExpression('100/5/2')).toBe(10)
  })

  it('raises to a power, right to left, tighter than a leading minus', () => {
    // Both of these are how the expression is written on paper: -2^2 is minus four, not
    // four, and 2^3^2 is 2^9 rather than 8^2.
    expect(evalExpression('2^3')).toBe(8)
    expect(evalExpression('-2^2')).toBe(-4)
    expect(evalExpression('2^3^2')).toBe(512)
    expect(evalExpression('2^-1')).toBe(0.5)
  })

  it('reads a leading sign as a sign', () => {
    expect(evalExpression('-5')).toBe(-5)
    expect(evalExpression('-(2+3)')).toBe(-5)
    expect(evalExpression('3 * -2')).toBe(-6)
    expect(evalExpression('--4')).toBe(4)
  })

  it('takes the decimals the fields already accept', () => {
    expect(evalExpression('.5*4')).toBe(2)
    expect(evalExpression('2.')).toBe(2)
    expect(evalExpression('0.125*8')).toBe(1)
  })

  it('ignores spacing entirely', () => {
    expect(evalExpression('  24  /  2  ')).toBe(12)
    expect(evalExpression('( 2 + 3 )*4')).toBe(20)
  })

  it('refuses a division by zero instead of returning Infinity', () => {
    // Same rule as parseNumeric's 1/0: Infinity must never reach a field that drives a cut.
    expect(evalExpression('1/0')).toBeNull()
    expect(evalExpression('5/(3-3)')).toBeNull()
    // The one the finite-result check at the end cannot catch: divide by that Infinity
    // and the answer is a perfectly respectable 0, so the refusal has to happen AT the
    // division or a zero denominator reaches the field disguised as a real number.
    expect(evalExpression('1/(1/0)')).toBeNull()
  })

  it('refuses a result that is not a real number', () => {
    expect(evalExpression('(0-8)^(1/3)')).toBeNull()   // NaN, not a cube root
  })

  it('refuses malformed arithmetic rather than salvaging part of it', () => {
    expect(evalExpression('')).toBeNull()
    expect(evalExpression('   ')).toBeNull()
    expect(evalExpression('2+')).toBeNull()
    expect(evalExpression('*2')).toBeNull()
    expect(evalExpression('(2+3')).toBeNull()
    expect(evalExpression('2+3)')).toBeNull()
    expect(evalExpression('2 3')).toBeNull()       // no operator between operands
    expect(evalExpression('.')).toBeNull()
    expect(evalExpression('()')).toBeNull()
  })

  it('rejects a trailing suffix instead of reading the number in front of it', () => {
    // The whole point of the '=' switch: it must not behave like parseFloat, which would
    // take '6' out of '6mm' and drop the rest.
    expect(evalExpression('6mm')).toBeNull()
    expect(evalExpression('6 + 1in')).toBeNull()
    expect(evalExpression('module*2')).toBeNull()   // no variables yet, and no pretending
  })

  it('gives up on nesting rather than overflowing the stack', () => {
    expect(evalExpression('('.repeat(200) + '1' + ')'.repeat(200))).toBeNull()
  })
})
