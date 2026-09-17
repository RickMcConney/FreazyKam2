import { describe, it, expect } from 'vitest'
import { evictHistorySegments } from './historyBudget'
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'

const segs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ x: i, y: 0, z: -1, rapid: false })) as unknown as MotionSegment[]
const op = (id: string, segments: MotionSegment[], type = 'profile') =>
  ({ id, type, status: 'done', segments }) as unknown as AnyOperation
type Snap = { operations: AnyOperation[] }

describe('evictHistorySegments', () => {
  it('keeps every toolpath while the history-only segments fit the budget', () => {
    const a = op('a', segs(10)), b = op('b', segs(10))
    const snaps: Snap[] = [{ operations: [a] }, { operations: [b] }]
    const before = [...snaps]
    expect(evictHistorySegments(snaps, [], 20)).toBe(0)
    expect(snaps[0]).toBe(before[0])
    expect(snaps[1]).toBe(before[1])
  })

  it('never counts or evicts a toolpath the live program still holds', () => {
    const big = op('a', segs(1000))
    const snaps: Snap[] = [{ operations: [big] }, { operations: [big] }]
    expect(evictHistorySegments(snaps, [big], 10)).toBe(0)
    expect(snaps[0].operations[0].segments).toHaveLength(1000)
  })

  it('evicts the toolpaths whose newest snapshot is oldest first, and stops once the rest fit', () => {
    // Three generations of one op, each left behind by a regeneration.
    const g1 = op('a', segs(10)), g2 = op('a', segs(10)), g3 = op('a', segs(10))
    const snaps: Snap[] = [{ operations: [g1] }, { operations: [g2] }, { operations: [g3] }]
    expect(evictHistorySegments(snaps, [op('a', segs(10))], 15)).toBe(2)
    expect(snaps[0].operations[0].segments).toHaveLength(0)
    expect(snaps[1].operations[0].segments).toHaveLength(0)
    expect(snaps[2].operations[0]).toBe(g3)
  })

  it('marks an evicted op needs-update and leaves the other ops in its snapshot as the same objects', () => {
    const old = op('a', segs(50)), other = op('b', segs(5))
    const snaps: Snap[] = [{ operations: [old, other] }]
    evictHistorySegments(snaps, [other], 10)
    const [stripped, kept] = snaps[0].operations
    expect(stripped.status).toBe('needs-update')
    expect(stripped.segments).toEqual([])
    expect(stripped.id).toBe('a')
    expect(kept).toBe(other)
  })

  it('counts a toolpath shared by several snapshots once and strips it everywhere as one shared object', () => {
    const shared = op('a', segs(12))
    const snaps: Snap[] = [{ operations: [shared] }, { operations: [shared] }, { operations: [shared] }]
    // 12 segments once, not 36: within a budget of 12 nothing goes.
    expect(evictHistorySegments(snaps, [], 12)).toBe(0)
    expect(evictHistorySegments(snaps, [], 11)).toBe(1)
    expect(snaps[0].operations[0]).toBe(snaps[1].operations[0])
    expect(snaps[1].operations[0]).toBe(snaps[2].operations[0])
    expect(snaps[2].operations[0].segments).toHaveLength(0)
  })

  it('never evicts an imported G-code program, which nothing can regenerate', () => {
    const prog = op('g', segs(1000), 'gcode')
    const snaps: Snap[] = [{ operations: [prog] }]
    expect(evictHistorySegments(snaps, [], 10)).toBe(0)
    expect(snaps[0].operations[0]).toBe(prog)
  })
})
