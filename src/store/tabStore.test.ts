// Tabs over a whole selection: one store write and one undo step, however many paths.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useTabStore } from './tabStore'
import { usePathsStore, type ImportedPath } from './pathsStore'
import { useToolpathStore } from './toolpathStore'
import { useTimelineStore } from '../timeline/timelineStore'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))

let clock = 1_000_000
async function step() {
  clock += 1000
  vi.setSystemTime(clock)
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

const square = (id: string, x: number): ImportedPath =>
  ({ id, name: id, color: '#000', visible: true, d: `M ${x} 0 L ${x + 10} 0 L ${x + 10} 10 L ${x} 10 Z` })
const PARTS = [square('a', 0), square('b', 20), square('c', 40)]

const Tb = () => useTabStore.getState()
const tabsOf = (id: string) => Tb().tabs.filter((t) => t.pathId === id)
const events = () => useTimelineStore.getState().events.length
const undo = async () => { useTimelineStore.getState().undo(); await step() }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  usePathsStore.setState({ paths: PARTS, selectedIds: [] })
  useToolpathStore.setState({ operations: [] })
  useTabStore.setState({ tabs: [] })
  await step()
  useTimelineStore.getState().resetToCurrentState()
  await step()
})
afterEach(() => { vi.useRealTimers() })

describe('tabbing several paths at once', () => {
  it('gives every path its own evenly spaced tabs', async () => {
    Tb().applyTabsMany(PARTS, 4, 5, 2)
    await step()
    for (const p of PARTS) {
      expect(tabsOf(p.id).map((t) => t.t)).toEqual([0.125, 0.375, 0.625, 0.875])
      expect(tabsOf(p.id).every((t) => t.lengthMM === 5 && t.heightMM === 2)).toBe(true)
    }
  })

  it('replaces the tabs the paths already had and leaves other paths alone', async () => {
    Tb().applyTabsMany(PARTS, 4, 5, 2)
    await step()
    Tb().applyTabsMany([PARTS[0], PARTS[1]], 2, 5, 2)
    await step()
    expect(tabsOf('a')).toHaveLength(2)
    expect(tabsOf('b')).toHaveLength(2)
    expect(tabsOf('c')).toHaveLength(4)
  })

  it('is ONE undo step, and one undo takes every path\'s tabs away', async () => {
    Tb().applyTabsMany(PARTS, 4, 5, 2)
    await step()
    expect(events()).toBe(1)
    await undo()
    expect(Tb().tabs).toEqual([])
  })

  it('joins its own step when applied again to the same paths, not one that tabbed only some of them', async () => {
    Tb().applyTabsMany(PARTS, 4, 5, 2)
    await step()
    Tb().applyTabsMany(PARTS, 3, 5, 2) // a change of count straight after: still the one step
    await step()
    expect(events()).toBe(1)
    Tb().applyTabs('a', 2, PARTS[0].d, 5, 2)
    await step()
    expect(events()).toBe(1) // 'a' was tabbed by that step, so this edits it
    Tb().applyTabsMany([PARTS[0], square('d', 60)], 2, 5, 2)
    await step()
    expect(events()).toBe(2) // 'd' was not, so this is a step of its own
  })

  it('marks one click\'s tabs as one batch — and a lone path\'s as none', async () => {
    Tb().applyTabsMany(PARTS, 2, 5, 2)
    await step()
    expect(new Set(Tb().tabs.map((t) => t.batchId)).size).toBe(1)
    expect(Tb().tabs[0].batchId).toBeTruthy()
    Tb().applyTabs('a', 2, PARTS[0].d, 5, 2) // re-tabbed alone: out of the batch
    await step()
    expect(tabsOf('a').every((t) => t.batchId === undefined)).toBe(true)
    expect(new Set(tabsOf('b').concat(tabsOf('c')).map((t) => t.batchId)).size).toBe(1)
  })

  it('clears every selected path\'s tabs as one undo step', async () => {
    Tb().applyTabsMany(PARTS, 4, 5, 2)
    await step()
    usePathsStore.getState().addPaths([square('e', 80)]) // something since, so the clear cannot join
    await step()
    Tb().deleteTabsOf(['a', 'b'])
    await step()
    expect(events()).toBe(3)
    expect(Tb().tabs.map((t) => t.pathId)).toEqual(['c', 'c', 'c', 'c'])
    await undo()
    expect(Tb().tabs).toHaveLength(12)
  })
})
