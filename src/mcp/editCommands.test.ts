// The MCP commands that edit a shape, group paths and change the tool library — driven
// against the REAL stores, as the store tests are: regeneration is the only stub (it reaches
// for the worker pool), the clock is faked a second per action (the history merges edits
// under 800 ms apart), and each action is followed by a microtask flush (the snapshot at the
// cursor settles in one).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { useTabStore } from '../store/tabStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { regenerateAffectedMany, regenerateMany } from '../cam/regenerate'
import { shapeParamsFromConfig, DEFAULT_SHAPE_CONFIG, type ShapeToolConfig } from '../shapes/shapeGenerators'
import { placeShape } from '../shapes/placeShape'
import { commands } from './commands'

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

const paths = () => usePathsStore.getState().paths
const byId = (id: string) => paths().find((p) => p.id === id)!
const events = () => useTimelineStore.getState().events.length
const run = async (name: string, params: Record<string, unknown>) => { const r = await commands[name](params); await step(); return r as Record<string, unknown> }

/** Place a shape as the canvas does, with the shape tool's defaults overridden. */
async function place<K extends keyof ShapeToolConfig>(type: K, over: Partial<ShapeToolConfig[K]> = {}, at = 100): Promise<string[]> {
  const cfg = { ...DEFAULT_SHAPE_CONFIG, [type]: { ...DEFAULT_SHAPE_CONFIG[type], ...over } }
  const ids = placeShape(shapeParamsFromConfig(type, at, at, cfg))
  await step()
  return ids
}

// No tooth number: it needs the single-stroke font, which is fetched over the network.
const plainGear = { teeth: 24, spokes: 0, toothLabel: false, pitchCircle: false }

const tool = (id: string, over: Partial<Tool> = {}): Tool => ({
  id, name: id, type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1500,
  zFeedMmMin: 400, maxDepthMM: 20, ...over,
})

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
  vi.mocked(regenerateAffectedMany).mockClear()
  vi.mocked(regenerateMany).mockClear()
  usePathsStore.setState({ paths: [], selectedIds: [] })
  useToolpathStore.setState({ operations: [] })
  useTabStore.setState({ tabs: [] })
  useToolStore.setState({ tools: [tool('mine', { name: '1/4" End Mill' }), tool('cat', { name: 'Vendor 6mm', folder: 'Vendor' })] })
  await step()
  useTimelineStore.getState().resetToCurrentState()
  await step()
})
afterEach(() => vi.useRealTimers())

describe('get_shape', () => {
  it('names the whole multi-part shape from any one of its paths, with every part id', async () => {
    const ids = await place('gear', plainGear)
    const r = await run('get_shape', { id: ids[ids.length - 1] })
    expect(r.shape).toBe('gear')
    expect([...(r.partIds as string[])].sort()).toEqual([...ids].sort())
  })

  it('leaves the shape\'s position out of its settings — moving is transform_paths\' job', async () => {
    const [id] = await place('circle', { radius: 10 })
    const settings = (await run('get_shape', { id })).settings as Record<string, unknown>
    expect(settings).toEqual({ radius: 10 })
  })

  it('refuses a path that no shape tool drew', async () => {
    usePathsStore.getState().addPaths([{ id: 'imp', name: 'Imported', d: 'M 0 0 L 10 0 L 10 10 Z', color: '#000', visible: true }])
    await step()
    expect(() => commands.get_shape({ id: 'imp' })).toThrow(/no shape settings/)
  })
})

describe('update_shape', () => {
  it('redraws every part of a gear from one part\'s id, and a part the settings call for appears', async () => {
    const ids = await place('gear', plainGear)
    const before = byId(ids[0]).d
    await run('update_shape', { id: ids[1] ?? ids[0], settings: { teeth: 30, spokes: 5 } })
    const gear = paths().filter((p) => p.groupId === byId(ids[0]).groupId)
    expect(gear.every((p) => p.shapeParams?.type === 'gear' && p.shapeParams.teeth === 30)).toBe(true)
    expect(gear.some((p) => p.shapePart === 'spokes')).toBe(true)
    expect(byId(ids[0]).d).not.toBe(before)
  })

  it('is one undo step, and undo puts the old settings and parts back', async () => {
    const ids = await place('gear', plainGear)
    // Something drawn since: an edit to what the LATEST step made joins that step instead.
    await place('circle', {}, 300)
    const n = events()
    await run('update_shape', { id: ids[0], settings: { teeth: 30, spokes: 5 } })
    expect(events()).toBe(n + 1)
    useTimelineStore.getState().undo()
    await step()
    expect(paths().filter((p) => p.shapeParams?.type === 'gear').map((p) => p.id).sort()).toEqual([...ids].sort())
    expect(ids.every((id) => { const sp = byId(id).shapeParams; return sp?.type === 'gear' && sp.teeth === 24 })).toBe(true)
  })

  it('regenerates the toolpaths of every part, including one that just appeared', async () => {
    const ids = await place('gear', plainGear)
    await run('update_shape', { id: ids[0], settings: { spokes: 5 } })
    const spokes = paths().find((p) => p.shapePart === 'spokes')!
    expect(vi.mocked(regenerateAffectedMany).mock.lastCall![0]).toEqual(expect.arrayContaining([...ids, spokes.id]))
  })

  it('refuses a position as a setting, an unknown setting, and a value of the wrong type — changing nothing', async () => {
    const [id] = await place('rectangle', { w: 80, h: 40 })
    const d = byId(id).d
    await expect(commands.update_shape({ id, settings: { x: 5 } })).rejects.toThrow(/transform_paths/)
    await expect(commands.update_shape({ id, settings: { width: 5 } })).rejects.toThrow(/no setting "width".*w, h/)
    await expect(commands.update_shape({ id, settings: { w: '90' } })).rejects.toThrow(/must be a number/)
    expect(byId(id).d).toBe(d)
  })

  it('refuses settings that leave the shape flat, rather than drawing a line to cut', async () => {
    const [id] = await place('rectangle', { w: 80, h: 40 })
    const d = byId(id).d
    await expect(commands.update_shape({ id, settings: { w: 0 } })).rejects.toThrow(/flat/)
    expect(byId(id).d).toBe(d)
  })

  it('grows a rectangle from its bottom-left corner, as the Properties panel does', async () => {
    const [id] = await place('rectangle', { w: 80, h: 40 })
    await run('update_shape', { id, settings: { w: 100 } })
    const p = byId(id).shapeParams as { x: number; w: number }
    expect([p.x, p.w]).toEqual([60, 100])
  })

  it('grows a rectangle drawn from its centre about its centre', async () => {
    const [id] = await place('rectangle', { w: 80, h: 40 })
    usePathsStore.setState({ paths: paths().map((p) => p.id === id ? { ...p, fromCenter: true } : p) })
    await run('update_shape', { id, settings: { w: 100 } })
    const p = byId(id).shapeParams as { x: number; w: number }
    expect(p.x + p.w / 2).toBe(100)
  })
})

describe('group_paths and ungroup_paths', () => {
  it('one part of a gear brings the whole gear into the group, as a click on the canvas would', async () => {
    const gear = await place('gear', plainGear)
    const [rect] = await place('rectangle', {}, 300)
    await run('group_paths', { ids: [gear[0], rect] })
    const g = byId(rect).userGroups?.[0]
    expect(g).toBeDefined()
    expect([...gear, rect].every((id) => byId(id).userGroups?.[0] === g)).toBe(true)
  })

  it('is one undo step each way', async () => {
    const [a] = await place('circle', {}, 50)
    const [b] = await place('circle', {}, 150)
    const n = events()
    await run('group_paths', { ids: [a, b] })
    expect(events()).toBe(n + 1)
    await run('ungroup_paths', { ids: [a] })
    expect(events()).toBe(n + 2)
    expect(byId(a).userGroups ?? []).toEqual([])
    expect(byId(b).userGroups ?? []).toEqual([])
  })

  it('ungroup refuses paths that are in no group', async () => {
    const [a] = await place('circle')
    expect(() => commands.ungroup_paths({ ids: [a] })).toThrow(/not.*in a group|None of those/)
  })
})

describe('add_tool', () => {
  it('files the tool in My Tools, starting from the library\'s New tool numbers and a rated chip load from them', async () => {
    const r = await run('add_tool', { name: '1/8" Down Cut', type: 'endmill', diameterMM: 3.175 })
    const t = useToolStore.getState().tools.find((x) => x.name === '1/8" Down Cut')!
    expect(t.folder).toBeUndefined()
    expect([t.fluteCount, t.rpm, t.xyFeedMmMin, t.zFeedMmMin, t.maxDepthMM]).toEqual([2, 18000, 2000, 500, 20])
    expect(t.chipLoadMM).toBeCloseTo(2000 / (18000 * 2), 5)
    expect((r.added as { folder: string }).folder).toBe('My Tools')
  })

  it('needs a V-bit\'s angle and a bull nose\'s corner radius, and refuses either on a tool without one', async () => {
    expect(() => commands.add_tool({ name: 'V', type: 'vbit', diameterMM: 12 })).toThrow(/angleDeg/)
    expect(() => commands.add_tool({ name: 'B', type: 'bullnose', diameterMM: 12 })).toThrow(/cornerRadiusMM/)
    expect(() => commands.add_tool({ name: 'E', type: 'endmill', diameterMM: 6, angleDeg: 60 })).toThrow(/only for a vbit or a taper/)
  })

  it('refuses a name My Tools already has, whatever its case', async () => {
    expect(() => commands.add_tool({ name: '1/4" END MILL', type: 'endmill', diameterMM: 6.35 })).toThrow(/already has/)
  })
})

describe('update_tool', () => {
  it('changes only the fields given', async () => {
    await run('update_tool', { id: 'mine', rpm: 20000 })
    const t = useToolStore.getState().tools.find((x) => x.id === 'mine')!
    expect([t.rpm, t.diameterMM, t.name]).toEqual([20000, 6, '1/4" End Mill'])
  })

  it('refuses a catalogue tool — the user\'s catalogue is not theirs to rewrite', async () => {
    await expect(commands.update_tool({ id: 'cat', rpm: 20000 })).rejects.toThrow(/catalogue/)
  })

  it('regenerates every toolpath that cuts with the tool, and only those', async () => {
    const op = (id: string, toolId: string) => ({ id, name: id, type: 'profile', toolId, status: 'done', segments: [], visible: true, pathId: 'p' }) as unknown as AnyOperation
    useToolpathStore.setState({ operations: [op('a', 'mine'), op('b', 'cat'), op('c', 'mine')] })
    await run('update_tool', { id: 'mine', diameterMM: 6.35 })
    expect(vi.mocked(regenerateMany).mock.lastCall![0].map((o: AnyOperation) => o.id)).toEqual(['a', 'c'])
  })
})
