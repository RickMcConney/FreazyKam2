import { describe, it, expect } from 'vitest'
import { measureReadout, snapAngle } from './measure'

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
