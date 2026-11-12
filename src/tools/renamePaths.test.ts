import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renamePath, renameGroup } from './renamePaths'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { useTimelineStore } from '../timeline/timelineStore'

vi.mock('../cam/regenerate')

let clock = 1_000_000
async function step() {
  clock += 1000
  vi.setSystemTime(clock)
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

const sq = (id: string, name: string, extra: Partial<ImportedPath> = {}): ImportedPath =>
  ({ id, name, color: '#000', visible: true, d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', ...extra }) as ImportedPath
const op = (id: string, name: string, pathId: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, type: 'profile', toolId: 't', pathId, side: 'outside', depthMM: 3, status: 'done', segments: [], color: '#000', visible: true, ...extra }) as unknown as AnyOperation

const pathName = (id: string) => usePathsStore.getState().paths.find((p) => p.id === id)!.name
const opName = (id: string) => useToolpathStore.getState().operations.find((o) => o.id === id)!.name
const events = () => useTimelineStore.getState().events.length

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  usePathsStore.setState({ selectedIds: [], paths: [
    sq('a', 'Rectangle'), sq('b', 'Rectangle'),
    sq('g1', 'one', { groupId: 'imp', groupName: 'drawing' }), sq('g2', 'two', { groupId: 'imp', groupName: 'drawing' }),
    sq('u1', 'x', { userGroups: ['ug'] }), sq('u2', 'y', { userGroups: ['ug'] }),
  ] })
  useToolpathStore.setState({ operations: [
    op('o1', 'Profile: Rectangle (1/8" End Mill)', 'a'),
    op('o2', 'Rough: Rectangle first', 'a', { nameIsCustom: true }),
    op('o3', 'Profile: Rectangle (1/8" End Mill)', 'b'),
  ] })
  await step()
  useTimelineStore.getState().resetToCurrentState()
  await step()
})
afterEach(() => { vi.useRealTimers() })

describe('renaming a path from the Paths list', () => {
  it('renames the toolpaths cut from it, whose automatic names carry the path\'s', async () => {
    renamePath('a', 'Side panel'); await step()
    expect(pathName('a')).toBe('Side panel')
    expect(opName('o1')).toBe('Profile: Side panel (1/8" End Mill)')
  })

  // The typed name mentions the path, and the other path has the SAME name: neither is this
  // path's automatic name, and matching on the text alone would rewrite both.
  it('leaves alone a toolpath name the user typed, even one that mentions the path', async () => {
    renamePath('a', 'Side panel'); await step()
    expect(opName('o2')).toBe('Rough: Rectangle first')
  })

  it('leaves alone the toolpath of another path that happens to share the name', async () => {
    renamePath('a', 'Side panel'); await step()
    expect(pathName('b')).toBe('Rectangle')
    expect(opName('o3')).toBe('Profile: Rectangle (1/8" End Mill)')
  })

  it('is one undo step for the path and its toolpaths together', async () => {
    const before = events()
    renamePath('a', 'Side panel'); await step()
    expect(events()).toBe(before + 1)
    useTimelineStore.getState().undo(); await step()
    expect(pathName('a')).toBe('Rectangle')
    expect(opName('o1')).toBe('Profile: Rectangle (1/8" End Mill)')
  })

  it('does nothing for a blank or unchanged name', async () => {
    const before = events()
    renamePath('a', '   '); renamePath('a', 'Rectangle'); await step()
    expect(pathName('a')).toBe('Rectangle')
    expect(events()).toBe(before)
  })
})

describe('renaming a folder of the Paths list', () => {
  const of = (id: string) => usePathsStore.getState().paths.find((p) => p.id === id)!

  it('renames an import on every member, in one step', async () => {
    const before = events()
    renameGroup('imp', 'Chair parts'); await step()
    expect([of('g1').groupName, of('g2').groupName]).toEqual(['Chair parts', 'Chair parts'])
    expect(events()).toBe(before + 1)
  })

  it('names a user group by its id on every member, leaving the import name alone', async () => {
    renameGroup('ug', 'Legs'); await step()
    expect([of('u1').groupLabels, of('u2').groupLabels]).toEqual([{ ug: 'Legs' }, { ug: 'Legs' }])
    expect(of('u1').groupName).toBeUndefined()
  })
})
