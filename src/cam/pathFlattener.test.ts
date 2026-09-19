import { describe, it, expect } from 'vitest'
import { flattenPath, pathExtents } from './pathFlattener'

const allFinite = (rings: [number, number][][]) => rings.every((r) => r.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)))

describe('flattenPath — an arc with a zero radius is a straight line (SVG F.6.2)', () => {
  it('flattens a zero-radius arc to its endpoint, with no NaN', () => {
    expect(flattenPath('M0 0 A0 0 0 0 1 10 0')).toEqual([[[0, 0], [10, 0]]])
  })

  it('treats ONE zero radius the same as both', () => {
    expect(flattenPath('M0 0 A0 5 0 0 1 10 0')).toEqual([[[0, 0], [10, 0]]])
    expect(flattenPath('M0 0 A5 0 30 1 0 10 0')).toEqual([[[0, 0], [10, 0]]])
  })

  it('keeps a closed shape with a zero-radius corner intact and finite', () => {
    // A rounded-rectangle generator with its corner radius dialled to 0 emits exactly this.
    const rings = flattenPath('M0 0 L10 0 A0 0 0 0 1 10 10 L0 10 Z')
    expect(allFinite(rings)).toBe(true)
    expect(rings[0]).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]])
  })

  it('agrees with pathExtents on the box', () => {
    const d = 'M2 3 A0 0 0 0 1 12 7 L2 7 Z'
    const xs = flattenPath(d).flat()
    const box = [Math.min(...xs.map((p) => p[0])), Math.min(...xs.map((p) => p[1])),
      Math.max(...xs.map((p) => p[0])), Math.max(...xs.map((p) => p[1]))]
    expect(pathExtents(d)).toEqual(box)
  })

  it('leaves a real arc curved', () => {
    const [ring] = flattenPath('M0 0 A5 5 0 0 1 10 0', 0.01)
    expect(ring.length).toBeGreaterThan(4)
    expect(allFinite([ring])).toBe(true)
    // A semicircle of radius 5 bulges a full radius off its chord. Vertices sit ON the
    // circle, spaced for a chord error within the 0.01 tolerance, so the highest one is
    // within that of the apex — and never past it.
    const bulge = Math.max(...ring.map(([, y]) => Math.abs(y)))
    expect(bulge).toBeGreaterThanOrEqual(5 - 0.01)
    expect(bulge).toBeLessThanOrEqual(5 + 1e-9)
  })
})
