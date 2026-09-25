import { describe, it, expect, vi, beforeEach } from 'vitest'

// A pass-through spy, so the count of real measurements is observable. Kept in its own
// file so the mock cannot reach the geometry tests in selectionUtils.test.ts.
vi.mock('../cam/pathFlattener', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../cam/pathFlattener')>()
  return { ...mod, pathExtents: vi.fn((d: string) => mod.pathExtents(d)) }
})

import { pathExtents } from '../cam/pathFlattener'
import { getBBox } from './selectionUtils'

const measured = vi.mocked(pathExtents)
const square = (i: number) => `M${i},0 L${i + 1},0 L${i + 1},1 L${i},1 Z`

describe('the getBBox cache', () => {
  beforeEach(() => { measured.mockClear() })

  // The old 256-entry FIFO evicted every entry of a larger sweep before it came round
  // again, so the second sweep re-measured all of them.
  it('measures each path once across repeated sweeps of a drawing larger than 256 paths', () => {
    const ds = Array.from({ length: 600 }, (_, i) => square(i + 1_000_000))
    for (const d of ds) getBBox(d)
    expect(measured).toHaveBeenCalledTimes(600)
    for (const d of ds) getBBox(d)
    for (const d of ds) getBBox(d)
    expect(measured).toHaveBeenCalledTimes(600)
  })

  it('still answers correctly for a path that has aged out of both generations', () => {
    const d = square(2_000_000)
    getBBox(d)
    for (let i = 0; i < 10_000; i++) getBBox(square(3_000_000 + i))
    measured.mockClear()
    expect(getBBox(d)).toMatchObject({ minX: 2_000_000, maxX: 2_000_001, minY: 0, maxY: 1 })
    expect(measured).toHaveBeenCalledTimes(1)
  })
})
