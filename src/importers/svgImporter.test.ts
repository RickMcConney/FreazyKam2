import { describe, it, expect } from 'vitest'
import { parseD, stringifyD, applyMat, type Mat6 } from './svgImporter'

describe('parseD', () => {
  it('parses absolute M/L/Z', () => {
    expect(parseD('M0,0 L10,0 L10,5 Z')).toEqual([
      { t: 'M', x: 0, y: 0 },
      { t: 'L', x: 10, y: 0 },
      { t: 'L', x: 10, y: 5 },
      { t: 'Z' },
    ])
  })

  it('resolves relative commands against the current point', () => {
    expect(parseD('m5,5 l10,0 l0,10')).toEqual([
      { t: 'M', x: 5, y: 5 },
      { t: 'L', x: 15, y: 5 },
      { t: 'L', x: 15, y: 15 },
    ])
  })

  it('expands H and V to L', () => {
    expect(parseD('M1,2 H10 V20 h-1 v-2')).toEqual([
      { t: 'M', x: 1, y: 2 },
      { t: 'L', x: 10, y: 2 },
      { t: 'L', x: 10, y: 20 },
      { t: 'L', x: 9, y: 20 },
      { t: 'L', x: 9, y: 18 },
    ])
  })

  it('treats extra M coordinate pairs as implicit L', () => {
    expect(parseD('M0,0 10,10 20,0')).toEqual([
      { t: 'M', x: 0, y: 0 },
      { t: 'L', x: 10, y: 10 },
      { t: 'L', x: 20, y: 0 },
    ])
  })

  it('parses cubic and arc commands with all fields', () => {
    expect(parseD('M0,0 C1,2,3,4,5,6 A7,8,45,1,0,9,10')).toEqual([
      { t: 'M', x: 0, y: 0 },
      { t: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 },
      { t: 'A', rx: 7, ry: 8, ang: 45, lg: 1, sw: 0, x: 9, y: 10 },
    ])
  })

  it('resets the current point to subpath start after Z', () => {
    expect(parseD('M0,0 L10,0 Z l5,5')).toEqual([
      { t: 'M', x: 0, y: 0 },
      { t: 'L', x: 10, y: 0 },
      { t: 'Z' },
      { t: 'L', x: 5, y: 5 },
    ])
  })
})

describe('stringifyD', () => {
  it('round-trips a canonical absolute d string', () => {
    const d = 'M0,0 L10,0 L10,5 Z'
    expect(stringifyD(parseD(d))).toBe(d)
  })

  it('round-trips curves and arcs', () => {
    const d = 'M0,0 C1,2,3,4,5,6 Q1,1,2,2 A7,8,45,1,0,9,10 Z'
    expect(stringifyD(parseD(d))).toBe(d)
  })

  it('rounds coordinates to 4 decimals', () => {
    expect(stringifyD([{ t: 'M', x: 1.00004, y: 2.00006 }])).toBe('M1,2.0001')
  })
})

describe('applyMat', () => {
  it('translates all command coordinates', () => {
    const m: Mat6 = [1, 0, 0, 1, 5, -2]
    expect(applyMat(parseD('M0,0 C1,2,3,4,5,6'), m)).toEqual([
      { t: 'M', x: 5, y: -2 },
      { t: 'C', x1: 6, y1: 0, x2: 8, y2: 2, x: 10, y: 4 },
    ])
  })

  it('rotates 90° CCW about the origin', () => {
    // x' = -y, y' = x
    const m: Mat6 = [0, 1, -1, 0, 0, 0]
    const out = applyMat(parseD('M1,0 L0,2'), m)
    expect(out[0]).toEqual({ t: 'M', x: 0, y: 1 })
    const l = out[1] as { t: 'L'; x: number; y: number }
    expect(l.x).toBeCloseTo(-2)
    expect(l.y).toBeCloseTo(0)
  })
})
