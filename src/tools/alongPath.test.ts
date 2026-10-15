import { describe, it, expect } from 'vitest'
import { layoutAlongPath, type AlongGlyph, type AlongPathOptions } from './alongPath'
import { flattenPath } from '../cam/pathFlattener'

// Box "letters" 4 wide and 10 tall (the cap height), centred in a 6 mm advance and drawn
// with the pen at the origin, so where each one lands and which way up it stands can be read
// straight off its corners.
const letter = (x: number): AlongGlyph => ({ x, advance: 6, d: 'M 1 0 L 5 0 L 5 10 L 1 10 Z' })
const CAP = 10
// A circle of radius 10 round (50, 50), drawn anticlockwise from its right-hand point.
const CIRCLE = 'M 60 50 A 10 10 0 1 1 40 50 A 10 10 0 1 1 60 50 Z'

const opts = (o: Partial<AlongPathOptions>): AlongPathOptions =>
  ({ side: 'out', at: 0.5, spacingMM: 0, gapMM: 0, rotate: true, ...o })

/** Each letter's four corners, in the order drawn: baseline-left, baseline-right, top-right, top-left. */
function corners(d: string): [number, number][][] {
  return flattenPath(d, 0.01).map((ring) => ring.slice(0, 4))
}
function bbox(d: string) {
  const p = flattenPath(d, 0.01).flat()
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1])
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}
const dist = (p: [number, number]) => Math.hypot(p[0] - 50, p[1] - 50)
// The middles of a letter's baseline and top edge — on the normal through its placing
// point, so their distance from the centre is exact where a corner's is not.
const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const base = (c: [number, number][]) => mid(c[0], c[1])
const top = (c: [number, number][]) => mid(c[2], c[3])

describe('layoutAlongPath on a closed guide', () => {
  it('at 0.5, outside, stands the text on the top of the circle, centred on it', () => {
    const d = layoutAlongPath([letter(0), letter(6)], CAP, CIRCLE, opts({}))!
    const b = bbox(d)
    expect((b.x0 + b.x1) / 2).toBeCloseTo(50, 3)
    expect(b.y0).toBeGreaterThan(55)
    // Baselines sit on the circle, tops 10 mm further out.
    for (const c of corners(d)) {
      expect(dist(base(c))).toBeCloseTo(10, 1)
      expect(dist(top(c))).toBeCloseTo(20, 1)
    }
  })

  it('reads left to right over the top: the first letter is the left one', () => {
    const [a, b] = corners(layoutAlongPath([letter(0), letter(6)], CAP, CIRCLE, opts({}))!)
    expect(a[0][0]).toBeLessThan(b[0][0])
  })

  it('inside at the top hangs the letters inside the circle, cap tops on the line', () => {
    const d = layoutAlongPath([letter(0), letter(6)], CAP, CIRCLE, opts({ side: 'in' }))!
    for (const c of corners(d)) {
      expect(dist(top(c))).toBeCloseTo(10, 1)
      expect(dist(base(c))).toBeLessThan(0.1)
    }
  })

  it('at 0, outside, puts the text under the bottom upright and reading left to right', () => {
    const d = layoutAlongPath([letter(0), letter(6)], CAP, CIRCLE, opts({ at: 0 }))!
    const [a, b] = corners(d)
    expect(bbox(d).y1).toBeLessThan(45)
    for (const c of [a, b]) {
      // Upright: the top of each letter is above its baseline; outside: tops on the line.
      expect(c[3][1]).toBeGreaterThan(c[0][1])
      expect(dist(top(c))).toBeCloseTo(10, 1)
      expect(dist(base(c))).toBeCloseTo(20, 1)
    }
    expect(a[0][0]).toBeLessThan(b[0][0])
  })

  it('at 0, inside, stands the text upright on the inside of the bottom', () => {
    const d = layoutAlongPath([letter(0)], CAP, CIRCLE, opts({ at: 0, side: 'in' }))!
    const [c] = corners(d)
    expect(dist(base(c))).toBeCloseTo(10, 1)
    expect(c[3][1]).toBeGreaterThan(c[0][1])
    expect(bbox(d).y0).toBeGreaterThan(39.9)
  })

  it('goes round clockwise from the bottom: 0.25 is the left side, 0.75 the right', () => {
    const left = bbox(layoutAlongPath([letter(0)], CAP, CIRCLE, opts({ at: 0.25 }))!)
    const right = bbox(layoutAlongPath([letter(0)], CAP, CIRCLE, opts({ at: 0.75 }))!)
    expect(left.x1).toBeCloseTo(40, 1)
    expect((left.y0 + left.y1) / 2).toBeCloseTo(50, 3)
    expect(right.x0).toBeCloseTo(60, 1)
  })

  it('does not care which way the circle was drawn', () => {
    const cw = 'M 60 50 A 10 10 0 1 0 40 50 A 10 10 0 1 0 60 50 Z'
    for (const at of [0, 0.3, 0.5]) {
      const a = bbox(layoutAlongPath([letter(0), letter(6)], CAP, CIRCLE, opts({ at }))!)
      const b = bbox(layoutAlongPath([letter(0), letter(6)], CAP, cw, opts({ at }))!)
      expect(b.x0).toBeCloseTo(a.x0, 3)
      expect(b.y1).toBeCloseTo(a.y1, 3)
    }
  })

  it('on the line centres the capitals on it', () => {
    const [c] = corners(layoutAlongPath([letter(0)], CAP, CIRCLE, opts({ side: 'on' }))!)
    expect(dist(base(c))).toBeCloseTo(5, 1)
    expect(dist(top(c))).toBeCloseTo(15, 1)
  })

  it('the gap moves the letters that far off the line, on either side', () => {
    const [o] = corners(layoutAlongPath([letter(0)], CAP, CIRCLE, opts({ gapMM: 2 }))!)
    expect(dist(base(o))).toBeCloseTo(12, 1)
    const [i] = corners(layoutAlongPath([letter(0)], CAP, CIRCLE, opts({ side: 'in', gapMM: 2 }))!)
    expect(dist(top(i))).toBeCloseTo(8, 1)
  })

  it('letter spacing adds that much arc between letter centres', () => {
    const centreAngle = (c: [number, number][]) => Math.atan2(base(c)[1] - 50, base(c)[0] - 50)
    const gapAt = (sp: number) => {
      const [a, b] = corners(layoutAlongPath([letter(0), letter(6)], CAP, CIRCLE, opts({ spacingMM: sp }))!)
      return (centreAngle(a) - centreAngle(b)) * 10 // arc length on r = 10
    }
    expect(gapAt(4) - gapAt(0)).toBeCloseTo(4, 1)
  })

  it('with rotate off the letters stay square to the page', () => {
    const d = layoutAlongPath([letter(0), letter(6)], CAP, CIRCLE, opts({ at: 0.75, rotate: false }))!
    for (const c of corners(d)) {
      expect(c[1][1]).toBeCloseTo(c[0][1], 9)
      expect(c[3][0]).toBeCloseTo(c[0][0], 9)
    }
  })
})

describe('layoutAlongPath on an open guide', () => {
  // Drawn right to left and sloping, so "above" and "start" have to come from the page.
  const SLOPE = 'M 100 50 L 0 0'

  it('at 0 starts the text at the left-hand end, above the line, reading left to right', () => {
    const [a, b] = corners(layoutAlongPath([letter(0), letter(6)], CAP, SLOPE, opts({ at: 0 }))!)
    expect(Math.hypot(a[0][0], a[0][1])).toBeCloseTo(1, 3) // 1 mm side bearing in from the end
    expect(a[0][0]).toBeLessThan(b[0][0])
    expect(a[3][1]).toBeGreaterThan(a[0][1])
  })

  it('at 1 finishes the text at the right-hand end', () => {
    const [, b] = corners(layoutAlongPath([letter(0), letter(6)], CAP, SLOPE, opts({ at: 1 }))!)
    expect(Math.hypot(b[1][0] - 100, b[1][1] - 50)).toBeCloseTo(1, 3)
  })

  it('below hangs the letters under the line', () => {
    const [c] = corners(layoutAlongPath([letter(0)], CAP, 'M 0 0 L 100 0', opts({ side: 'in', at: 0.5 }))!)
    expect(c[3][1]).toBeCloseTo(0, 9)
    expect(c[0][1]).toBeCloseTo(-10, 9)
  })
})
