import { describe, it, expect } from 'vitest'
import { jobPreview, segmentCuts, longLines } from './jobPreview'
import type { MotionSegment } from '../store/toolpathStore'

describe('jobPreview', () => {
  it('draws feed moves and breaks the line at a rapid, so travel moves are not drawn as cuts', () => {
    const p = jobPreview(['G21 G90', 'G0 X0 Y0', 'G1 Z-1 F300', 'G1 X10', 'G1 Y10', 'G0 Z5', 'G0 X20 Y20', 'G1 Z-1', 'G1 X30'].join('\n'))
    expect(p.cuts).toEqual([[[0, 0], [10, 0], [10, 10]], [[20, 20], [30, 20]]])
  })

  it('bounds the cuts only, not the rapids that lead to them', () => {
    const p = jobPreview(['G0 X-50 Y-50', 'G0 X0 Y0', 'G1 X10 Y5 F500'].join('\n'))
    expect(p.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 5 })
  })

  it('converts an inch program to mm, as the map is drawn in mm', () => {
    const p = jobPreview(['G20 G90', 'G0 X0 Y0', 'G1 X1 F10'].join('\n'))
    expect(p.cuts[0][1][0]).toBeCloseTo(25.4)
  })

  it('thins points closer than the step but always keeps the end of each cut', () => {
    const lines = ['G0 X0 Y0', 'G1 F500']
    for (let i = 1; i <= 100; i++) lines.push(`G1 X${(i * 0.01).toFixed(2)}`)
    const cut = jobPreview(lines.join('\n'), 0.2).cuts[0]
    expect(cut.length).toBeLessThan(10)
    expect(cut[cut.length - 1][0]).toBeCloseTo(1)
  })

  it('takes the safe height from the Z its XY rapids travel at most often, not the higher first and last ones', () => {
    const p = jobPreview(['G0 Z20', 'G0 X0 Y0', 'G0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G0 Z5', 'G0 X20', 'G1 Z-1', 'G1 X30',
      'G0 Z5', 'G0 X40', 'G1 Z-1', 'G0 Z20', 'G0 X0 Y0'].join('\n'))
    expect(p.safeZ).toBe(5)
  })

  it('reports the deepest feed move, plunges included', () => {
    const p = jobPreview(['G0 X0 Y0 Z5', 'G1 Z-3 F300', 'G1 X10', 'G1 Z-6.5', 'G0 Z5'].join('\n'))
    expect(p.deepestZ).toBe(-6.5)
  })
})

describe('segmentCuts', () => {
  const seg = (x: number, y: number, z: number, extra: Partial<MotionSegment> = {}): MotionSegment => ({ x, y, z, rapid: false, ...extra })

  it('draws cutting moves shifted into work coordinates, broken at rapids and stay-down travel', () => {
    const cuts = segmentCuts([[
      seg(0, 0, 5, { rapid: true }), seg(0, 0, -1), seg(10, 0, -1),
      seg(10, 0, 1, { travel: true }), seg(20, 0, 1, { travel: true }), seg(20, 0, -1), seg(20, 10, -1),
    ]], -5, -5)
    expect(cuts).toEqual([[[-5, -5], [5, -5]], [[15, -5], [15, 5]]])
  })

  it('follows an arc around its centre rather than cutting the chord', () => {
    // A half circle of radius 10 about (10, 0), counter-clockwise from (20, 0) to (0, 0) through (10, 10).
    const cuts = segmentCuts([[seg(20, 0, -1), seg(0, 0, -1, { arc: { cx: 10, cy: 0, cw: false } })]], 0, 0)
    const top = Math.max(...cuts[0].map(([, y]) => y))
    expect(top).toBeCloseTo(10, 1)
    for (const [x, y] of cuts[0]) expect(Math.hypot(x - 10, y)).toBeCloseTo(10, 6)
  })
})

describe('long lines', () => {
  it('finds the lines a controller may refuse as too long, by line number', () => {
    const text = ['G21', `(${'x'.repeat(100)})`, 'G0 X0', `; ${'y'.repeat(90)}`].join('\n')
    expect(longLines(text)).toEqual([2, 4])
  })

  it('warns about them when a job is loaded, before Run', () => {
    expect(jobPreview(['G21', `(NOTE: ${'z'.repeat(130)})`, 'G0 X0 Y0', 'G1 X1 F100'].join('\n')).warnings[0]).toMatch(/^line 2 longer than 80/)
    expect(jobPreview('G0 X0 Y0\nG1 X1 F100').warnings).toEqual([])
  })
})
