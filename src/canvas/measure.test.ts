import { describe, it, expect } from 'vitest'
import { measureGaps, measureReadout, snapAngle } from './measure'

// A w × h box with its lower-left corner at (x, y).
const box = (x: number, y: number, w: number, h: number) => ({ minX: x, minY: y, maxX: x + w, maxY: y + h })
const spans = (gaps: ReturnType<typeof measureGaps>) => gaps.map((g) => [g.axis, g.from, g.to])

describe('measureGaps (Alt-hover)', () => {
  it('measures the one gap between two parts side by side, drawn through where they overlap', () => {
    const g = measureGaps(box(0, 0, 10, 10), box(30, 4, 10, 10))
    expect(spans(g)).toEqual([['x', 10, 30]])
    expect(g[0].at).toBeCloseTo(7, 9) // the middle of y 4–10, where both boxes are
  })

  it('measures the gap whichever side the hovered part is on', () => {
    expect(spans(measureGaps(box(30, 0, 10, 10), box(0, 0, 10, 10)))).toEqual([['x', 10, 30]])
    expect(spans(measureGaps(box(0, 30, 10, 10), box(0, 0, 10, 10)))).toEqual([['y', 10, 30]])
  })

  it('measures both gaps to a part that is apart diagonally, through the selection\'s middle', () => {
    const g = measureGaps(box(0, 0, 10, 10), box(30, 40, 10, 10))
    expect(spans(g)).toEqual([['x', 10, 30], ['y', 10, 40]])
    expect(g.map((m) => m.at)).toEqual([5, 5])
  })

  it('measures all four insets of a part sitting inside a plate', () => {
    const g = measureGaps(box(20, 10, 10, 10), box(0, 0, 100, 50))
    expect(spans(g)).toEqual([['x', 0, 20], ['x', 30, 100], ['y', 0, 10], ['y', 20, 50]])
    // Drawn through the inner part, not the plate's middle.
    expect(g.map((m) => m.at)).toEqual([15, 15, 25, 25])
  })

  it('measures the same insets when the hovered part is the one inside the selection', () => {
    expect(spans(measureGaps(box(0, 0, 100, 50), box(20, 10, 10, 10))))
      .toEqual([['x', 0, 20], ['x', 30, 100], ['y', 0, 10], ['y', 20, 50]])
  })

  it('says nothing for parts that partly overlap', () => {
    expect(measureGaps(box(0, 0, 10, 10), box(5, 5, 10, 10))).toEqual([])
  })

  it('leaves out an inset of zero — a part flush with the plate edge', () => {
    expect(spans(measureGaps(box(0, 10, 10, 10), box(0, 0, 100, 50))))
      .toEqual([['x', 10, 100], ['y', 0, 10], ['y', 20, 50]])
  })
})

describe('measureReadout (Measure tool)', () => {
  it('gives length, signed run and rise, and the angle CCW from +X', () => {
    const r = measureReadout({ x: 10, y: 10 }, { x: 40, y: -30 })
    expect(r.distMM).toBeCloseTo(50, 9)
    expect(r.dxMM).toBeCloseTo(30, 9)
    expect(r.dyMM).toBeCloseTo(-40, 9)
    expect(r.angleDeg).toBeCloseTo(-53.1301, 3)
  })

  it('reads 90° straight up and 180° straight left (Y-up)', () => {
    expect(measureReadout({ x: 0, y: 0 }, { x: 0, y: 5 }).angleDeg).toBeCloseTo(90, 9)
    expect(measureReadout({ x: 0, y: 0 }, { x: -5, y: 0 }).angleDeg).toBeCloseTo(180, 9)
  })
})

describe('snapAngle (Shift on the Measure tool)', () => {
  it('turns the end onto the nearest 15° step, keeping its distance', () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 10, y: 1 }, 15)
    expect(p.y).toBeCloseTo(0, 9)
    expect(p.x).toBeCloseTo(Math.hypot(10, 1), 9)
    const q = snapAngle({ x: 5, y: 5 }, { x: 15, y: 14 }, 15) // 42° → 45°
    expect(Math.atan2(q.y - 5, q.x - 5) * 180 / Math.PI).toBeCloseTo(45, 9)
    expect(Math.hypot(q.x - 5, q.y - 5)).toBeCloseTo(Math.hypot(10, 9), 9)
  })

  it('leaves a zero-length line alone', () => {
    expect(snapAngle({ x: 3, y: 4 }, { x: 3, y: 4 }, 15)).toEqual({ x: 3, y: 4 })
  })
})
