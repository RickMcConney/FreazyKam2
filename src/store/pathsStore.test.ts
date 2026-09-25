// The paths store: every rule in src/store/CLAUDE.md that came from a bug. The persisted
// stores load fine under node (zustand falls back without localStorage), so these drive
// the REAL stores and the real undo history — no stubs but regeneration, which would
// otherwise reach for the worker pool.
//
// Two pieces of timing matter. The history merges edits under 800 ms apart into one
// step, so the clock is faked and each action is `step()`-ped a second apart. And the
// snapshot at the cursor is refreshed in a microtask after every write, so `step()`
// flushes those before the next action reads anything.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { usePathsStore, bakePathsStep, type ImportedPath } from './pathsStore'
import { regenerateAffectedMany } from '../cam/regenerate'
import { useToolpathStore, type AnyOperation } from './toolpathStore'
import { useTabStore, type Tab } from './tabStore'
import { useConstraintsStore } from './constraintsStore'
import type { Constraint } from './constraints'
import { useTimelineStore } from '../timeline/timelineStore'
import { shapeParamsFromConfig, DEFAULT_SHAPE_CONFIG, generateShapeD, generateShapeParts, type ShapeParams } from '../shapes/shapeGenerators'
import { getBBox } from '../canvas/selectionUtils'

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

const rectD = (x: number, y: number, w: number, h: number) =>
  `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
const path = (id: string, over: Partial<ImportedPath> = {}): ImportedPath =>
  ({ id, name: id, d: rectD(0, 0, 10, 10), color: '#000', visible: true, ...over })
const op = (id: string, pathId: string, over: Record<string, unknown> = {}): AnyOperation => ({
  id, name: id, type: 'pocket', toolId: 't', status: 'done', segments: [{ x: 0, y: 0, z: -1, rapid: false }],
  color: '#fff', visible: true, pathId, islandIds: [], depthMM: 3, stepDownMM: 3, stepoverPercent: 40,
  passAngleDeg: 0, direction: 'climb', strategy: 'raster', rampIn: false, ...over,
} as AnyOperation)
const tab = (id: string, pathId: string): Tab => ({ id, pathId, t: 0.5, lengthMM: 5, heightMM: 2 })
const between = (id: string, a: string, b: string): Constraint =>
  ({ id, from: { kind: 'path', id: a, anchor: 'center' }, to: { kind: 'path', id: b, anchor: 'center' } } as Constraint)

const S = () => usePathsStore.getState()
const ids = () => S().paths.map((p) => p.id)
const events = () => useTimelineStore.getState().events.length
const undo = async () => { useTimelineStore.getState().undo(); await step() }
const redo = async () => { useTimelineStore.getState().redo(); await step() }

/** Install a document and make it the start of history, as a project load does. */
async function load(doc: { paths?: ImportedPath[]; ops?: AnyOperation[]; tabs?: Tab[]; constraints?: Constraint[]; selected?: string[] } = {}) {
  usePathsStore.setState({ paths: doc.paths ?? [], selectedIds: doc.selected ?? [] })
  useToolpathStore.setState({ operations: doc.ops ?? [] })
  useTabStore.setState({ tabs: doc.tabs ?? [] })
  useConstraintsStore.setState({ constraints: doc.constraints ?? [] })
  await step()
  useTimelineStore.getState().resetToCurrentState()
  await step()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await load()
})
afterEach(() => { vi.useRealTimers() })

describe('applyPathEdit — one gesture is one undo step', () => {
  it('updates, adds and deletes in ONE step, and one undo takes all three back', async () => {
    await load({ paths: [path('a'), path('b')] })
    S().applyPathEdit({ updates: [{ id: 'a', d: rectD(5, 5, 10, 10) }], add: [path('c')], deleteIds: ['b'] })
    await step()
    expect(events()).toBe(1)
    expect(ids()).toEqual(['a', 'c'])
    await undo()
    expect(ids()).toEqual(['a', 'b'])
    expect(S().paths[0].d).toBe(rectD(0, 0, 10, 10))
    await redo()
    expect(ids()).toEqual(['a', 'c'])
    expect(S().paths[0].d).toBe(rectD(5, 5, 10, 10))
  })

  it('records nothing for an edit that changes nothing', async () => {
    S().applyPathEdit({})
    await step()
    expect(events()).toBe(0)
  })

  it('drops the operations, tabs and constraints of a deleted path — and one undo brings them all back', async () => {
    // An operation naming a path that is gone is a cut against geometry nobody can see,
    // and it survives into the G-code.
    const doc = {
      paths: [path('a'), path('b'), path('c')],
      ops: [op('onA', 'a'), op('islandOfB', 'c', { islandIds: ['a'] }), op('onB', 'b')],
      tabs: [tab('tA', 'a'), tab('tB', 'b')],
      constraints: [between('k1', 'a', 'b'), between('k2', 'b', 'c')],
    }
    await load(doc)
    const before = useToolpathStore.getState().operations
    S().deletePath('a')
    await step()
    // 'islandOfB' only used 'a' as an island, so it stays — without it (see below).
    expect(useToolpathStore.getState().operations.map((o) => o.id)).toEqual(['islandOfB', 'onB'])
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(['tB'])
    expect(useConstraintsStore.getState().constraints.map((c) => c.id)).toEqual(['k2'])
    await undo()
    expect(ids()).toEqual(['a', 'b', 'c'])
    // The SAME operation objects — segments and all — not rebuilt ones.
    const after = useToolpathStore.getState().operations
    expect(after).toHaveLength(3)
    after.forEach((o, i) => expect(o).toBe(before[i]))
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(['tA', 'tB'])
    expect(useConstraintsStore.getState().constraints.map((c) => c.id)).toEqual(['k1', 'k2'])
  })

  it('deleting an island keeps its pocket, takes the island out of it, and regenerates it', async () => {
    // Dropping the whole pocket for one inner path threw away its settings, and its chip
    // reopened a form that still showed the island.
    await load({
      paths: [path('outer', { d: rectD(-50, -50, 100, 100) }), path('i1'), path('i2', { d: rectD(20, 20, 5, 5) })],
      ops: [op('pocket', 'outer', { islandIds: ['i1', 'i2'] }),
        op('carve', 'outer', { type: 'vcarve', islandIds: ['i1'] })],
    })
    vi.mocked(regenerateAffectedMany).mockClear()
    S().deletePath('i1')
    await step()
    const ops = useToolpathStore.getState().operations
    expect(ops.map((o) => o.id)).toEqual(['pocket', 'carve'])
    expect((ops[0] as { islandIds: string[] }).islandIds).toEqual(['i2'])
    expect((ops[1] as { islandIds: string[] }).islandIds).toEqual([])
    expect(vi.mocked(regenerateAffectedMany)).toHaveBeenCalledWith([], ['pocket', 'carve'])
    await undo()
    expect((useToolpathStore.getState().operations[0] as { islandIds: string[] }).islandIds).toEqual(['i1', 'i2'])
  })

  it('deleting a boundary together with its island still drops the pocket', async () => {
    await load({
      paths: [path('outer', { d: rectD(-50, -50, 100, 100) }), path('i1')],
      ops: [op('pocket', 'outer', { islandIds: ['i1'] })],
    })
    S().applyPathEdit({ deleteIds: ['i1', 'outer'] })
    await step()
    expect(useToolpathStore.getState().operations).toEqual([])
  })

  it('deleting an inlay island drops that inlay half — the pair is cut to fit as one', async () => {
    await load({
      paths: [path('outer', { d: rectD(-50, -50, 100, 100) }), path('i1')],
      ops: [op('female', 'outer', { type: 'inlay', islandIds: ['i1'] })],
    })
    S().deletePath('i1')
    await step()
    expect(useToolpathStore.getState().operations).toEqual([])
  })

  it('records nothing for an edit whose updates would leave every path as it is', async () => {
    // An undo step that undoes nothing costs a press of Ctrl+Z to find out (review2 Q2).
    await load({ paths: [path('a', { name: 'A', hidden: false, userGroups: ['g'] })] })
    const a = S().paths[0]
    S().applyPathEdit({ updates: [{ id: 'a', d: a.d, name: 'A', hidden: false, userGroups: ['g'] }] })
    await step()
    expect(events()).toBe(0)
    expect(S().paths[0]).toBe(a)
  })

  it('still records an update that keeps the outline but changes a field — a rename, a hide, a group', async () => {
    await load({ paths: [path('a'), path('b'), path('c')] })
    S().applyPathEdit({ updates: [{ id: 'a', d: S().paths[0].d, name: 'renamed' }] })
    await step()
    S().applyPathEdit({ updates: [{ id: 'b', d: S().paths[1].d, hidden: true }] })
    await step()
    S().applyPathEdit({ updates: [{ id: 'c', d: S().paths[2].d, userGroups: ['g'] }] })
    await step()
    expect(events()).toBe(3)
    expect(S().paths.map((p) => [p.name, !!p.hidden, p.userGroups])).toEqual([['renamed', false, undefined], ['b', true, undefined], ['c', false, ['g']]])
  })

  it('keeps only the updates that change something, and still records a delete riding with a no-op', async () => {
    await load({ paths: [path('a'), path('b'), path('c')] })
    S().applyPathEdit({ updates: [{ id: 'a', d: S().paths[0].d }, { id: 'b', d: rectD(5, 5, 10, 10) }] })
    await step()
    const evs = useTimelineStore.getState().events
    const ev = evs[evs.length - 1] as { updates: { id: string }[] }
    expect(ev.updates.map((u) => u.id)).toEqual(['b'])
    S().applyPathEdit({ updates: [{ id: 'a', d: S().paths[0].d }], deleteIds: ['c'] })
    await step()
    expect(events()).toBe(2)
    expect(ids()).toEqual(['a', 'b'])
  })

  it('takes deleted paths out of the selection, and leaves the selection alone on a plain edit', async () => {
    await load({ paths: [path('a'), path('b')], selected: ['a', 'b'] })
    const sel = S().selectedIds
    S().updatePathD('a', rectD(1, 1, 10, 10))
    await step()
    // Same array: a fresh one re-renders every selection subscriber for nothing.
    expect(S().selectedIds).toBe(sel)
    S().deleteSelected()
    await step()
    expect(S().selectedIds).toEqual([])
    expect(ids()).toEqual([])
  })

  it("clears a path's user groups with [] and leaves them alone when omitted", async () => {
    await load({ paths: [path('a', { userGroups: ['g1'] }), path('b', { userGroups: ['g1'] })] })
    S().applyPathEdit({ updates: [{ id: 'a', d: rectD(1, 1, 10, 10), userGroups: [] }, { id: 'b', d: rectD(2, 2, 10, 10) }] })
    await step()
    expect(S().paths[0].userGroups).toBeUndefined()
    expect(S().paths[1].userGroups).toEqual(['g1'])
  })
})

describe('the store regenerates what an edit changed — callers do not', () => {
  const regen = vi.mocked(regenerateAffectedMany)
  // Ids per call, sorted, so an assertion reads as "which ops were rebuilt, in how many goes".
  const calls = () => regen.mock.calls.map(([ids]) => [...ids].sort())
  // b's centre held 50 mm to the right of a's.
  const held: Constraint = { ...between('k', 'a', 'b'), mode: 'xy', offsetXMM: 50, offsetYMM: 0 }
  beforeEach(() => { regen.mockClear() })

  it('regenerates every path whose outline changed, in ONE call for the whole edit', async () => {
    await load({ paths: [path('a'), path('b'), path('c')] })
    regen.mockClear()
    S().applyPathEdit({ updates: [{ id: 'a', d: rectD(5, 5, 10, 10) }, { id: 'b', d: rectD(1, 1, 10, 10) }] })
    await step()
    expect(calls()).toEqual([['a', 'b']])
  })

  it('does not regenerate an update that restates the outline — a group, a checkbox, a soft-hide', async () => {
    await load({ paths: [path('a'), path('b')], selected: ['a', 'b'] })
    regen.mockClear()
    S().groupSelected()
    S().applyPathEdit({ updates: [{ id: 'a', d: rectD(0, 0, 10, 10), hidden: true }] })
    await step()
    expect(calls()).toEqual([])
  })

  it('rebuilds a dragged part and the part a constraint carried along in the SAME call', async () => {
    await load({ paths: [path('a'), path('b', { d: rectD(50, 0, 10, 10) })], constraints: [held] })
    regen.mockClear()
    S().applyPathEdit({ updates: [{ id: 'a', d: rectD(5, 0, 10, 10) }] })
    await step()
    expect(getBBox(S().paths[1].d)!.minX).toBeCloseTo(55)
    expect(calls()).toEqual([['a', 'b']])
  })

  it("leaves the edit's own paths to the caller with regenerate: false, but still rebuilds what a constraint moved", async () => {
    await load({ paths: [path('a'), path('b', { d: rectD(50, 0, 10, 10) })], constraints: [held] })
    regen.mockClear()
    S().applyPathEdit({ updates: [{ id: 'a', d: rectD(5, 0, 10, 10) }], regenerate: false })
    await step()
    expect(getBBox(S().paths[1].d)!.minX).toBeCloseTo(55)
    expect(calls()).toEqual([['b']])
  })

  it('regenerates the path a point-edit trim split, and nothing for the piece it added', async () => {
    await load({ paths: [path('a')] })
    regen.mockClear()
    S().applyPathEdit({ gesture: 'trim', updates: [{ id: 'a', d: 'M 0 0 L 10 0', shapeParams: null }], add: [path('t', { d: 'M 10 10 L 0 10' })] })
    await step()
    expect(calls()).toEqual([['a']])
  })
})

describe('bakePathsStep — every gesture bake, dragged or typed', () => {
  const regen = vi.mocked(regenerateAffectedMany)
  beforeEach(() => { regen.mockClear() })

  it('moves the named paths in one step and regenerates them', async () => {
    await load({ paths: [path('a'), path('b'), path('c')] })
    regen.mockClear()
    bakePathsStep(['a', 'b'], { kind: 'translate', dx: 5, dy: 0 }, 'move')
    await step()
    expect(events()).toBe(1)
    expect(getBBox(S().paths[0].d)!.minX).toBeCloseTo(5)
    expect(getBBox(S().paths[1].d)!.minX).toBeCloseTo(5)
    expect(getBBox(S().paths[2].d)!.minX).toBeCloseTo(0)
    expect(regen.mock.calls.map(([ids]) => [...ids].sort())).toEqual([['a', 'b']])
  })

  it('records nothing and regenerates nothing for a step that leaves every point where it is', async () => {
    await load({ paths: [path('a')] })
    regen.mockClear()
    bakePathsStep(['a'], { kind: 'translate', dx: 0, dy: 0 }, 'move')
    bakePathsStep(['a'], { kind: 'scale', sx: 1, sy: 1, ax: 0, ay: 0 }, 'scale')
    bakePathsStep(['a'], { kind: 'rotate', angle: 0, cx: 5, cy: 5 }, 'rotate')
    await step()
    expect(events()).toBe(0)
    expect(regen).not.toHaveBeenCalled()
  })

})

describe('a corner treatment is a recipe that lives as long as its outline', () => {
  const treated = () => path('a', {
    d: 'M 0 0 L 8 0 L 10 2 L 10 10 L 0 10 Z',
    corners: { baseD: rectD(0, 0, 10, 10), treatments: [[1, { type: 'chamfer', radiusMM: 2 }]] },
  })

  it('is carried by a move — the base outline moves with the path', async () => {
    await load({ paths: [treated()] })
    S().batchUpdatePaths([{ id: 'a', d: 'M 5 0 L 13 0 L 15 2 L 15 10 L 5 10 Z', transforms: [{ kind: 'translate', dx: 5, dy: 0 }] }], 'move')
    await step()
    const c = S().paths[0].corners!
    expect(getBBox(c.baseD)).toMatchObject({ minX: 5, minY: 0, maxX: 15, maxY: 10 })
    expect(c.treatments).toEqual([[1, { type: 'chamfer', radiusMM: 2 }]])
  })

  it('scales its radii with a uniform scale', async () => {
    await load({ paths: [treated()] })
    S().batchUpdatePaths([{ id: 'a', d: 'M 0 0 L 16 0 L 20 4 L 20 20 L 0 20 Z', transforms: [{ kind: 'scale', sx: 2, sy: 2, ax: 0, ay: 0 }] }], 'scale')
    await step()
    expect(S().paths[0].corners!.treatments[0][1].radiusMM).toBeCloseTo(4, 9)
  })

  it('is dropped by any other rewrite of the outline — its corner indices now point elsewhere', async () => {
    await load({ paths: [treated()] })
    S().updatePathD('a', 'M 0 0 L 10 0 L 10 10 L 5 12 L 0 10 Z')
    await step()
    expect(S().paths[0].corners).toBeUndefined()
  })

  it('is replaced whole by a corner edit, since the form always sends the full map', async () => {
    await load({ paths: [treated()] })
    S().applyPathEdit({ updates: [{ id: 'a', d: 'M 0 0 L 10 0 L 10 7 L 7 10 L 0 10 Z', corner: [{ idx: 2, type: 'chamfer', radiusMM: 3 }] }], gesture: 'corner' })
    await step()
    expect(S().paths[0].corners).toEqual({ baseD: rectD(0, 0, 10, 10), treatments: [[2, { type: 'chamfer', radiusMM: 3 }]] })
  })
})

describe('selection', () => {
  it('replaces on a click, toggles on an extend-click, and clears on null', async () => {
    await load({ paths: [path('a'), path('b'), path('c')] })
    S().selectPath('a')
    S().selectPath('c', true)
    S().selectPath('b', true)
    // Pick ORDER is kept: a subtraction keeps the first pick and cuts the rest from it.
    expect(S().selectedIds).toEqual(['a', 'c', 'b'])
    S().selectPath('c', true)
    expect(S().selectedIds).toEqual(['a', 'b'])
    S().selectPath('c')
    expect(S().selectedIds).toEqual(['c'])
    S().selectPath(null)
    expect(S().selectedIds).toEqual([])
  })
})

describe('user groups nest', () => {
  it('groups by PREPENDING a group id, in one undo step', async () => {
    await load({ paths: [path('a'), path('b'), path('c')], selected: ['a', 'b'] })
    S().groupSelected()
    await step()
    const [a, b, c] = S().paths
    expect(a.userGroups).toHaveLength(1)
    expect(b.userGroups).toEqual(a.userGroups)
    expect(c.userGroups).toBeUndefined()
    expect(events()).toBe(1)
    await undo()
    expect(S().paths.every((p) => p.userGroups === undefined)).toBe(true)
  })

  it('gives back the group and the shape it was grouped with — not three loose paths', async () => {
    await load({ paths: [path('a', { userGroups: ['inner'] }), path('b', { userGroups: ['inner'] }), path('c')], selected: ['a', 'b', 'c'] })
    S().groupSelected()
    await step()
    const outer = S().paths[2].userGroups![0]
    expect(S().paths.map((p) => p.userGroups)).toEqual([[outer, 'inner'], [outer, 'inner'], [outer]])
    S().setSelectedIds(['c'])
    S().ungroupSelected()
    await step()
    expect(S().paths.map((p) => p.userGroups)).toEqual([['inner'], ['inner'], undefined])
  })

  it('ungroups the WHOLE group when only one member is selected, and selects all of it', async () => {
    await load({ paths: [path('a', { userGroups: ['g'] }), path('b', { userGroups: ['g'] })], selected: ['a'] })
    S().ungroupSelected()
    await step()
    expect(S().paths.every((p) => p.userGroups === undefined)).toBe(true)
    expect(S().selectedIds).toEqual(['a', 'b'])
  })

  it('does not wrap exactly one whole group in another level with nothing else in it', async () => {
    await load({ paths: [path('a', { userGroups: ['g'] }), path('b', { userGroups: ['g'] })], selected: ['a', 'b'] })
    S().groupSelected()
    await step()
    expect(S().paths.map((p) => p.userGroups)).toEqual([['g'], ['g']])
    expect(events()).toBe(0)
  })

  it('hides a group whose members are all visible, and shows it otherwise', async () => {
    await load({ paths: [path('a', { groupId: 'imp' }), path('b', { groupId: 'imp', visible: false })] })
    S().toggleGroupVisibility('imp')
    expect(S().paths.map((p) => p.visible)).toEqual([true, true])
    S().toggleGroupVisibility('imp')
    expect(S().paths.map((p) => p.visible)).toEqual([false, false])
  })
})

describe('duplicateSelected', () => {
  it('reissues every id a copy shares with its original, so copies join no group of the original', async () => {
    // A copy that kept groupId left six paths in one gear, and the next parameter edit
    // regenerated whichever three `byPart` happened to land on.
    await load({ paths: [path('a', { groupId: 'gear1', clockId: 'clk', userGroups: ['u1'] }), path('b', { groupId: 'gear1', clockId: 'clk', userGroups: ['u1'] })], selected: ['a', 'b'] })
    S().duplicateSelected()
    await step()
    const [a, , ca, cb] = S().paths
    for (const key of ['groupId', 'clockId'] as const) {
      expect(ca[key]).toBeDefined()
      expect(ca[key]).not.toBe(a[key])
      expect(cb[key]).toBe(ca[key])   // …but the copies still share one among themselves
    }
    expect(ca.userGroups![0]).not.toBe('u1')
    expect(cb.userGroups).toEqual(ca.userGroups)
  })

  it('nudges the copies and selects them — only the copies of what was selected', async () => {
    const operand = path('op', { hidden: true })
    const result = path('res', { d: rectD(20, 0, 10, 10), definition: { id: 'def', kind: 'boolean', op: 'union', sourceIds: ['op'] } })
    await load({ paths: [operand, result], selected: ['res'] })
    S().duplicateSelected(5)
    await step()
    // The hidden operand comes too — a duplicated boolean is a real one — but is not selected.
    expect(S().paths).toHaveLength(4)
    const copy = S().paths.find((p) => p.name === 'res copy')!
    expect(S().selectedIds).toEqual([copy.id])
    // Up and to the right — CNC Y is up.
    const b = getBBox(copy.d)!
    expect([b.minX, b.minY]).toEqual([25, 5])
    const opCopy = S().paths.find((p) => p.name === 'op copy')!
    expect(opCopy.hidden).toBe(true)
    expect(copy.definition).toMatchObject({ kind: 'boolean', sourceIds: [opCopy.id] })
  })

  it('takes tabs along, copies a constraint only when both ends came, and is one undo step', async () => {
    await load({
      paths: [path('a'), path('b'), path('c')],
      tabs: [tab('t', 'a')],
      constraints: [between('ab', 'a', 'b'), between('bc', 'b', 'c')],
      selected: ['a', 'b'],
    })
    S().duplicateSelected()
    await step()
    expect(useTabStore.getState().tabs).toHaveLength(2)
    const cs = useConstraintsStore.getState().constraints
    expect(cs).toHaveLength(3)
    const copied = cs[2]
    const copyIds = S().selectedIds
    expect(copyIds).toContain((copied.from as { id: string }).id)
    expect(copyIds).toContain((copied.to as { id: string }).id)
    await undo()
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(useConstraintsStore.getState().constraints).toHaveLength(2)
  })
})

describe('splitPath', () => {
  it('drops the operations cutting the path, keeps the ones using it as an island, and is one undo', async () => {
    // Cloning a profile onto each piece would cut every spoke of a gear on its outside.
    await load({
      paths: [path('outer', { d: rectD(-50, -50, 100, 100) }), path('c')],
      ops: [op('cutsC', 'c'), op('aroundC', 'outer', { islandIds: ['c'] })],
      tabs: [tab('t', 'c')],
      constraints: [between('k', 'outer', 'c')],
    })
    S().splitPath('c', [rectD(0, 0, 4, 4), rectD(6, 6, 4, 4)])
    await step()
    const pieces = S().selectedIds
    expect(pieces).toHaveLength(2)
    expect(ids()).toEqual(['outer', ...pieces])
    const ops = useToolpathStore.getState().operations
    expect(ops.map((o) => o.id)).toEqual(['aroundC'])
    expect((ops[0] as { islandIds: string[] }).islandIds).toEqual(pieces)
    expect(useTabStore.getState().tabs).toEqual([])
    expect(useConstraintsStore.getState().constraints).toEqual([])
    await undo()
    expect(ids()).toEqual(['outer', 'c'])
    expect(useToolpathStore.getState().operations.map((o) => o.id)).toEqual(['cutsC', 'aroundC'])
    expect(useConstraintsStore.getState().constraints).toHaveLength(1)
  })

  it('does nothing for a path with a single subpath', async () => {
    await load({ paths: [path('c')] })
    S().splitPath('c', [rectD(0, 0, 10, 10)])
    await step()
    expect(ids()).toEqual(['c'])
    expect(events()).toBe(0)
  })
})

describe('updateShapeParams', () => {
  const star = (points: number): ShapeParams => ({ ...shapeParamsFromConfig('star', 50, 50, DEFAULT_SHAPE_CONFIG), points } as ShapeParams)

  it("regenerates the shape's outline from its parameters", async () => {
    await load({ paths: [path('s', { d: generateShapeD(star(5)), shapeParams: star(5) })] })
    await step()
    S().updateShapeParams('s', star(7))
    await step()
    expect(S().paths[0].d).toBe(generateShapeD(star(7)))
    expect(S().paths[0].shapeParams).toEqual(star(7))
  })

  it('keeps a turned shape turned — the placement carries the new outline out to where it stands', async () => {
    const turn = [{ kind: 'rotate' as const, angle: 90, cx: 50, cy: 50 }]
    await load({ paths: [path('s', { d: generateShapeD(star(5)), shapeParams: star(5), placement: turn })] })
    S().updateShapeParams('s', star(7))
    await step()
    const upright = getBBox(generateShapeD(star(7)))!
    const placed = getBBox(S().paths[0].d)!
    // A 7-point star is not symmetric under a quarter turn, so its box shows the turn.
    expect(placed.width).toBeCloseTo(upright.height, 6)
    expect(placed.height).toBeCloseTo(upright.width, 6)
    expect(S().paths[0].placement).toEqual(turn)
  })

  it('joins the step that created the shape rather than adding one per keystroke', async () => {
    await load()
    S().addPaths([path('s', { d: generateShapeD(star(5)), shapeParams: star(5) })])
    await step()
    S().updateShapeParams('s', star(6))
    await step()
    S().updateShapeParams('s', star(7))
    await step()
    expect(events()).toBe(1)
    // …and one undo takes back the shape AND its edits together.
    await undo()
    expect(ids()).toEqual([])
  })

  it('records a step of its own when the shape was made by an older step', async () => {
    await load()
    S().addPaths([path('s', { d: generateShapeD(star(5)), shapeParams: star(5) })])
    await step()
    S().addPaths([path('other')])
    await step()
    S().updateShapeParams('s', star(7))
    await step()
    expect(events()).toBe(3)
    // Undoing the edit leaves the rectangle drawn since — it did not take it back too.
    await undo()
    expect(ids()).toEqual(['s', 'other'])
    expect(S().paths[0].shapeParams).toEqual(star(5))
  })

  describe('a multi-part shape', () => {
    const gear = (over: Record<string, unknown> = {}) =>
      ({ ...shapeParamsFromConfig('gear', 50, 50, DEFAULT_SHAPE_CONFIG), toothLabel: false, ...over } as ShapeParams)
    const gearPaths = (params: ShapeParams): ImportedPath[] =>
      generateShapeParts(params)!.map((pt) => path(`g-${pt.part}`, { d: pt.d, shapeParams: params, shapePart: pt.part, groupId: 'gear1', groupName: 'Gear' }))

    it('regenerates every part, keeping the ids of the parts that stay', async () => {
      await load({ paths: gearPaths(gear()), ops: [op('onTeeth', 'g-teeth')] })
      S().updateShapeParams('g-bore', gear({ bore: 12 }))
      await step()
      expect(ids()).toEqual(['g-teeth', 'g-bore', 'g-spokes'])
      expect(S().paths.every((p) => (p.shapeParams as { bore: number }).bore === 12)).toBe(true)
      expect(useToolpathStore.getState().operations.map((o) => o.id)).toEqual(['onTeeth'])
    })

    it('drops a part that goes away, with its operations', async () => {
      await load({ paths: gearPaths(gear()), ops: [op('onSpokes', 'g-spokes'), op('onTeeth', 'g-teeth')] })
      S().updateShapeParams('g-teeth', gear({ spokes: 0 }))
      await step()
      expect(ids()).toEqual(['g-teeth', 'g-bore'])
      expect(useToolpathStore.getState().operations.map((o) => o.id)).toEqual(['onTeeth'])
    })

    it('brings a part back turned with the rest of a turned gear', async () => {
      const turn = [{ kind: 'rotate' as const, angle: 30, cx: 50, cy: 50 }]
      const noSpokes = gear({ spokes: 0 })
      await load({ paths: gearPaths(noSpokes).map((p) => ({ ...p, placement: turn })) })
      S().updateShapeParams('g-teeth', gear())
      await step()
      const spokes = S().paths.find((p) => p.shapePart === 'spokes')!
      expect(spokes.placement).toEqual(turn)
      expect(spokes.groupId).toBe('gear1')
    })

    it('switches an annotation OFF when the user deletes it, so a regeneration does not bring it back', async () => {
      await load({ paths: gearPaths(gear({ pitchCircle: true })) })
      expect(ids()).toContain('g-pitch')
      S().deletePath('g-pitch')
      await step()
      expect(S().paths.every((p) => (p.shapeParams as { pitchCircle: boolean }).pitchCircle === false)).toBe(true)
      S().updateShapeParams('g-bore', { ...(S().paths[0].shapeParams as object), bore: 10 } as ShapeParams)
      await step()
      expect(ids()).not.toContain('g-pitch')
      expect(S().paths.some((p) => p.shapePart === 'pitch')).toBe(false)
    })

    it('does NOT switch anything off when a machined part is deleted', async () => {
      await load({ paths: gearPaths(gear()) })
      S().deletePath('g-spokes')
      await step()
      expect(S().paths.every((p) => (p.shapeParams as { spokes: number }).spokes === 5)).toBe(true)
    })
  })
})

describe('raw rewrites and loads', () => {
  it('rewriteGeneratedRaw changes the document without recording, and still drops what a delete orphans', async () => {
    await load({ paths: [path('a'), path('b')], ops: [op('onB', 'b')], selected: ['b'] })
    S().rewriteGeneratedRaw({ updates: [{ id: 'a', d: rectD(3, 3, 3, 3), name: 'moved' }], deleteIds: ['b'] })
    await step()
    expect(events()).toBe(0)
    expect(S().paths).toMatchObject([{ id: 'a', d: rectD(3, 3, 3, 3), name: 'moved' }])
    expect(useToolpathStore.getState().operations).toEqual([])
    expect(S().selectedIds).toEqual([])
  })

  it('replacePaths drops the constraints of the previous document and clears the selection', async () => {
    await load({ paths: [path('a'), path('b')], constraints: [between('ab', 'a', 'b'), { id: 'st', from: { kind: 'stock', edge: 'left' }, to: { kind: 'path', id: 'x', anchor: 'center' } } as Constraint], selected: ['a'] })
    S().replacePaths([path('x')])
    expect(ids()).toEqual(['x'])
    expect(S().selectedIds).toEqual([])
    expect(useConstraintsStore.getState().constraints.map((c) => c.id)).toEqual(['st'])
  })
})
