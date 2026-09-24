import { describe, it, expect } from 'vitest'
import { parseD, stringifyD, applyMat, fitViewBox, svgDisplayNone, svgVisibilityHidden, svgToCncMat, type Mat6 } from './svgImporter'

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

// A viewBox whose aspect differs from the page is FITTED (SVG's default xMidYMid meet),
// not stretched: the import used to scale X and Y independently, so a circle in a
// 100×50 mm page over a square viewBox came in as an ellipse.
describe('fitViewBox', () => {
  const vb = { x: 0, y: 0, w: 100, h: 100 }
  // Where a viewBox point lands on the page, in CNC mm.
  const land = (fit: typeof vb, x: number, y: number) => {
    const [a, , , d, e, f] = svgToCncMat(100, 50, fit.x, fit.y, fit.w, fit.h)
    return { x: a * x + e, y: d * y + f }
  }

  it('scales both axes alike and centres the drawing by default', () => {
    const fit = fitViewBox(100, 50, vb, null)
    const [a, , , d] = svgToCncMat(100, 50, fit.x, fit.y, fit.w, fit.h)
    expect(Math.abs(a)).toBeCloseTo(Math.abs(d), 12)
    // A 100-unit square on a 100×50 page, meet: 50 mm wide, centred across the width.
    expect(land(fit, 0, 0).x).toBeCloseTo(25, 9)
    expect(land(fit, 100, 0).x).toBeCloseTo(75, 9)
  })

  it('honours the alignment it is given — xMin puts the drawing at the left edge', () => {
    const fit = fitViewBox(100, 50, vb, 'xMinYMid meet')
    expect(land(fit, 0, 0).x).toBeCloseTo(0, 9)
    expect(land(fit, 100, 0).x).toBeCloseTo(50, 9)
  })

  it('slice fills the page and crops instead', () => {
    const fit = fitViewBox(100, 50, vb, 'xMidYMid slice')
    expect(land(fit, 100, 0).x - land(fit, 0, 0).x).toBeCloseTo(100, 9)
  })

  it('leaves "none", and a page that already matches, exactly as they were', () => {
    expect(fitViewBox(100, 50, vb, 'none')).toBe(vb)
    const same = { x: 3, y: 4, w: 200, h: 100 }
    expect(fitViewBox(100, 50, same, null)).toBe(same)
  })
})

// Inkscape hides a layer with style="display:none" on its <g>; those layers (construction
// lines, a traced photo) were imported as paths to machine.
describe('svg visibility', () => {
  const attrs = (o: Record<string, string>) => (n: string) => o[n] ?? null
  it('reads display:none from the attribute or the style', () => {
    expect(svgDisplayNone(attrs({ display: 'none' }))).toBe(true)
    expect(svgDisplayNone(attrs({ style: 'fill:red;display:none' }))).toBe(true)
    expect(svgDisplayNone(attrs({ style: 'display: none !important' }))).toBe(true)
    expect(svgDisplayNone(attrs({ style: 'display:inline' }))).toBe(false)
    expect(svgDisplayNone(attrs({ style: 'fill:none' }))).toBe(false)
  })
  it('reads visibility:hidden, and leaves visible alone', () => {
    expect(svgVisibilityHidden(attrs({ visibility: 'hidden' }))).toBe(true)
    expect(svgVisibilityHidden(attrs({ style: 'visibility:collapse' }))).toBe(true)
    expect(svgVisibilityHidden(attrs({ style: 'visibility:visible' }))).toBe(false)
  })
})
