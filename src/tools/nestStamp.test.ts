import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nestIdFor, forgetNest } from './nestRun'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useTimelineStore } from '../timeline/timelineStore'

vi.mock('../cam/regenerate')

let clock = 1_000_000
async function step() {
  clock += 1000
  vi.setSystemTime(clock)
  for (let i = 0; i < 3; i++) await Promise.resolve()
}
const stamp = (id: string) => ({ id, spacingMM: 3, marginMM: 3, rotationStepDeg: 90, packFrom: 'left' as const, useHoles: false, avoidOthers: true, multiSheet: true })
const sq = (id: string, nest?: string): ImportedPath =>
  ({ id, name: id, color: '#000', visible: true, d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', ...(nest ? { nest: stamp(nest) } : {}) }) as ImportedPath
const PATHS = [sq('a', 'n1'), sq('b', 'n1'), sq('c', 'n2'), sq('d')]

describe('which nest a re-run belongs to', () => {
  it('is the earlier nest when the parts are exactly its parts', () => {
    expect(nestIdFor(PATHS, ['a', 'b'])).toBe('n1')
  })

  it('is a new nest for only some of an earlier nest\'s parts, or for more than them', () => {
    expect(nestIdFor(PATHS, ['a'])).toBeUndefined()
    expect(nestIdFor(PATHS, ['a', 'b', 'd'])).toBeUndefined()
  })

  it('is a new nest for parts never nested', () => {
    expect(nestIdFor(PATHS, ['d'])).toBeUndefined()
  })
})

describe('deleting a nest\'s chip', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    usePathsStore.setState({ paths: PATHS, selectedIds: [] })
    await step()
    useTimelineStore.getState().resetToCurrentState()
    await step()
  })
  afterEach(() => { vi.useRealTimers() })
  const of = (id: string) => usePathsStore.getState().paths.find((p) => p.id === id)!

  it('forgets the nest on its own parts and leaves them where they are', async () => {
    forgetNest('n1'); await step()
    expect([of('a').nest, of('b').nest]).toEqual([undefined, undefined])
    expect(of('a').d).toBe(PATHS[0].d)
    expect(of('c').nest?.id).toBe('n2')
  })

  it('comes back in one undo', async () => {
    forgetNest('n1'); await step()
    useTimelineStore.getState().undo(); await step()
    expect([of('a').nest?.id, of('b').nest?.id]).toEqual(['n1', 'n1'])
  })
})
