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
import { usePathsStore, bakePathsStep, bakePathsSteps, applyConstraintSolve, type ImportedPath } from './pathsStore'
import { regenerateAffectedMany } from '../cam/regenerate'
import { useToolpathStore, type AnyOperation } from './toolpathStore'
import { useTabStore, type Tab } from './tabStore'
import { useConstraintsStore } from './constraintsStore'
import type { Constraint } from './constraints'
import { useTimelineStore } from '../timeline/timelineStore'
import { shapeParamsFromConfig, DEFAULT_SHAPE_CONFIG, generateShapeD, generateShapeParts, type ShapeParams } from '../shapes/shapeGenerators'
import { getBBox, translateD } from '../canvas/selectionUtils'
import { useWorkpieceStore } from './workpieceStore'
import { computePatternInstances, patternCopies, type PatternParams } from '../tools/patternOp'
import { patternCentreOf } from './patternBodies'
import { useConstraintsStore as constraintsStore } from './constraintsStore'
import { linkedOriginalOf } from '../tools/duplicateFollow'
import { applyCorners, cornerSession, createBoolean } from '../tools/pathToolActions'
import { getMultiBBox } from '../canvas/selectionUtils'

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

  it('deleting an inlay male\'s cut-out outline keeps the inlay and only drops the outline from it', async () => {
    // The outline is a convenience drawn for the plug, not part of it: losing it puts the
    // male back on its own release ring rather than throwing the plug away.
    await load({
      paths: [path('plug'), path('band', { d: rectD(-5, -5, 20, 20) })],
      ops: [op('male', 'plug', { type: 'inlay', role: 'male', phase: 'vbit', bandId: 'band' })],
    })
    S().deletePath('band')
    await step()
    const ops = useToolpathStore.getState().operations
    expect(ops.map((o) => o.id)).toEqual(['male'])
    expect((ops[0] as { bandId?: string }).bandId).toBeUndefined()
    // …and the plug itself still takes the inlay with it.
    S().deletePath('plug')
    await step()
    expect(useToolpathStore.getState().operations).toHaveLength(0)
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

describe('locationSelection — a drag box\'s order, remembered while it is still the selection', () => {
  it('describes the selection only while it is the same array: any other way of selecting leaves it stale', () => {
    S().setLocationSelection(['b', 'a'])
    expect(S().selectedIds).toBe(S().locationSelection)
    S().setSelectedIds(['b', 'a'])
    expect(S().selectedIds).not.toBe(S().locationSelection)
    S().setLocationSelection(['a'])
    S().selectPath('b', true)
    expect(S().selectedIds).not.toBe(S().locationSelection)
  })
})

describe('bakePathsSteps — scale each object about its own centre', () => {
  const regen = vi.mocked(regenerateAffectedMany)
  beforeEach(() => { regen.mockClear() })
  const centre = (id: string) => {
    const b = getBBox(S().paths.find((p) => p.id === id)!.d)!
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxX - b.minX]
  }

  it('grows two labels 100 mm apart where they stand: centres fixed, each three times as wide, one undo step', async () => {
    // A label of two strokes beside each part. One scale about the selection's centre
    // would push them to 300 mm apart; scaled each, they stay 100 mm apart.
    await load({ paths: [path('a1', { d: rectD(0, 0, 4, 1) }), path('a2', { d: rectD(5, 0, 4, 1) }), path('b1', { d: rectD(100, 0, 9, 1) })] })
    regen.mockClear()
    bakePathsSteps([
      { pathIds: ['a1', 'a2'], step: { kind: 'scale', sx: 3, sy: 3, ax: 4.5, ay: 0.5 } },
      { pathIds: ['b1'], step: { kind: 'scale', sx: 3, sy: 3, ax: 104.5, ay: 0.5 } },
    ], 'scale')
    await step()
    expect(events()).toBe(1)
    const [bx, by, bw] = centre('b1')
    expect([bx, by, bw]).toEqual([expect.closeTo(104.5), expect.closeTo(0.5), expect.closeTo(27)])
    // The two strokes of label A spread about THEIR shared centre, not each about its own.
    expect(getBBox(S().paths.find((p) => p.id === 'a1')!.d)!.minX).toBeCloseTo(4.5 - 3 * 4.5)
    expect(getBBox(S().paths.find((p) => p.id === 'a2')!.d)!.maxX).toBeCloseTo(4.5 + 3 * 4.5)
    expect(S().paths.every((p) => Math.abs((p.scalePct ?? 100) - 300) < 1e-6)).toBe(true)
    expect(regen.mock.calls.map(([ids]) => [...ids].sort())).toEqual([['a1', 'a2', 'b1']])
    await undo()
    expect(centre('b1')[2]).toBeCloseTo(9)
  })
})

describe('a path remembers how big it stands against its original size', () => {
  const scale = (s: number, sy = s) => bakePathsStep(['a'], { kind: 'scale', sx: s, sy, ax: 0, ay: 0 }, 'scale')

  it('compounds uniform scales, so 50% then ×2 is back to 100% and the record is gone', async () => {
    await load({ paths: [path('a')] })
    scale(0.5); await step()
    expect(S().paths[0].scalePct).toBeCloseTo(50)
    scale(2); await step()
    expect(S().paths[0].scalePct).toBeUndefined()
    expect(getBBox(S().paths[0].d)!.width).toBeCloseTo(10)
  })

  it('leaves the record alone for a stretch, which has no single percentage', async () => {
    await load({ paths: [path('a', { scalePct: 50 })] })
    scale(2, 1); await step()
    expect(S().paths[0].scalePct).toBe(50)
  })

  it('counts a mirrored uniform scale by its size, not its sign', async () => {
    await load({ paths: [path('a')] })
    scale(-1.5, 1.5); await step()
    expect(S().paths[0].scalePct).toBeCloseTo(150)
  })

  it('undoes the record with the scale', async () => {
    await load({ paths: [path('a')] })
    scale(0.5); await step()
    await undo()
    expect(S().paths[0].scalePct).toBeUndefined()
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
    const copy = S().paths.find((p) => p.name === 'res' && p.id !== 'res')!
    expect(S().selectedIds).toEqual([copy.id])
    // Up and to the right — CNC Y is up.
    const b = getBBox(copy.d)!
    expect([b.minX, b.minY]).toEqual([25, 5])
    const opCopy = S().paths.find((p) => p.name === 'op' && p.id !== 'op')!
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

  it('keeps each piece on its layer, in its source group and user group, but not the whole outline\'s recipe', async () => {
    await load({ paths: [path('c', {
      layer: 'Holes', sourceGroups: ['g1'], sourceGroupNames: ['Bracket'], sourceElement: 'e1',
      userGroups: ['u1'], groupLabels: { u1: 'Left side' },
      corners: { baseD: rectD(0, 0, 10, 10), treatments: {} } as ImportedPath['corners'],
    })] })
    S().splitPath('c', [rectD(0, 0, 4, 4), rectD(6, 6, 4, 4)])
    await step()
    for (const p of S().paths) {
      expect(p).toMatchObject({
        layer: 'Holes', sourceGroups: ['g1'], sourceGroupNames: ['Bracket'], sourceElement: 'e1',
        userGroups: ['u1'], groupLabels: { u1: 'Left side' },
      })
      expect(p.corners).toBeUndefined()
    }
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

describe('strips follow the parts they hold', () => {
  const STRIP_Y = 70
  // Two parts profiled through 18 mm stock, 6 mm apart, joined by one strip at y = 70.
  async function joined() {
    useWorkpieceStore.setState({
      widthMM: 300, heightMM: 200, thicknessMM: 18,
      bridges: { lines: [{ x1: 69, y1: STRIP_Y, x2: 77, y2: STRIP_Y }], widthMM: 5, heightMM: 2, pathIds: ['a', 'b'] },
    })
    const through = { type: 'profile', side: 'outside', depthMM: 18 }
    await load({
      paths: [path('a', { d: rectD(10, 50, 60, 40) }), path('b', { d: rectD(76, 50, 60, 40) })],
      ops: [op('pa', 'a', through), op('pb', 'b', through)],
    })
  }
  afterEach(() => { useWorkpieceStore.setState({ bridges: null }) })
  const strip = () => useWorkpieceStore.getState().bridges!.lines[0]

  it('a moved part carries its strips with it, in the same undo step as the move', async () => {
    await joined()
    S().applyPathEdit({ updates: [{ id: 'a', d: rectD(10, 60, 60, 40) }, { id: 'b', d: rectD(76, 60, 60, 40) }] })
    await step()
    expect(events()).toBe(1)
    expect(strip().y1).toBeCloseTo(STRIP_Y + 10, 6)
    expect(strip().y2).toBeCloseTo(STRIP_Y + 10, 6)
    await undo()
    expect(strip().y1).toBe(STRIP_Y)
    await redo()
    expect(strip().y1).toBeCloseTo(STRIP_Y + 10, 6)
  })

  it('regenerates the cuts of both parts a re-fitted strip joins, not only the one that moved', async () => {
    await joined()
    vi.mocked(regenerateAffectedMany).mockClear()
    S().applyPathEdit({ updates: [{ id: 'b', d: rectD(80, 50, 60, 40) }] })
    await step()
    const asked = vi.mocked(regenerateAffectedMany).mock.calls.flatMap((c) => c[0])
    expect(asked).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('a shape whose parameters are edited carries its strips too, and its partner is regenerated', async () => {
    // The single-path branch of updateShapeParams wrote `paths` itself and skipped the
    // re-fit applyPathEdit does: type a rectangle wider and its strips stayed where the
    // old outline was, and the part it is held to was never regenerated for it.
    await joined()
    const p0 = { ...shapeParamsFromConfig('rectangle', 106, 70, DEFAULT_SHAPE_CONFIG), w: 60, h: 40 } as ShapeParams & { x: number; y: number }
    const bb = getBBox(generateShapeD(p0))!
    const rect = { ...p0, x: p0.x + 76 - bb.minX, y: p0.y + 50 - bb.minY } as ShapeParams & { x: number }
    S().updatePathD('b', generateShapeD(rect))
    usePathsStore.setState({ paths: S().paths.map((p) => p.id === 'b' ? { ...p, shapeParams: rect } : p) })
    await step()
    const before = { ...strip() }
    vi.mocked(regenerateAffectedMany).mockClear()
    S().updateShapeParams('b', { ...rect, x: rect.x + 4 } as ShapeParams)
    await step()
    expect(strip()).not.toEqual(before)
    expect(Math.max(strip().x1, strip().x2)).toBeCloseTo(Math.max(before.x1, before.x2) + 4, 6)
    const asked = vi.mocked(regenerateAffectedMany).mock.calls.flatMap((c) => c[0])
    expect(asked).toEqual(expect.arrayContaining(['a']))
  })

  it('a part a constraint carries along carries its strips too', async () => {
    // applyConstraintSolve is the constraint actions' own write of the paths, and it
    // skipped the re-fit the same way.
    await joined()
    usePathsStore.setState({ paths: [...S().paths, path('c', { d: rectD(200, 150, 10, 10) })] })
    // b's centre is (106, 70); c's is (205, 155). Hold b 4 mm further right of c than it is.
    useConstraintsStore.setState({ constraints: [{
      id: 'cb', mode: 'xy', offsetXMM: 110 - 205, offsetYMM: 70 - 155,
      from: { kind: 'path', id: 'c', anchor: 'center' }, to: { kind: 'path', id: 'b', anchor: 'center' },
    } as Constraint] })
    const before = { ...strip() }
    vi.mocked(regenerateAffectedMany).mockClear()
    applyConstraintSolve(['c'])
    await step()
    expect(getBBox(S().paths.find((p) => p.id === 'b')!.d)!.minX).toBeCloseTo(80, 6)
    expect(Math.max(strip().x1, strip().x2)).toBeCloseTo(Math.max(before.x1, before.x2) + 4, 6)
    const asked = vi.mocked(regenerateAffectedMany).mock.calls.flatMap((c) => c[0])
    expect(asked).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('leaves the strips alone when an edit moves no part they hold', async () => {
    await joined()
    const before = useWorkpieceStore.getState().bridges
    S().applyPathEdit({ add: [path('c', { d: rectD(200, 150, 10, 10) })] })
    await step()
    expect(useWorkpieceStore.getState().bridges).toBe(before)
  })
})

describe('duplicatePaths — the stamp tool\'s click (Cmd+D)', () => {
  it('copies the named paths by any offset, x and y apart, and selects the copies', async () => {
    await load({ paths: [path('a'), path('b', { d: rectD(50, 0, 10, 10) })], selected: ['b'] })
    S().duplicatePaths(['a'], { dx: 30, dy: -12 })
    await step()
    const copy = S().paths.find((p) => p.name === 'a' && p.id !== 'a')!
    expect(copy.name).toBe('a')   // a copy keeps its original's name — no " copy" suffix
    const b = getBBox(copy.d)!
    expect([b.minX, b.minY]).toEqual([30, -12])
    expect(S().selectedIds).toEqual([copy.id])
  })

  it('stamping the same originals twice makes two copies, each one undo step', async () => {
    await load({ paths: [path('a')] })
    const before = events()
    S().duplicatePaths(['a'], { dx: 20, dy: 0 }); await step()
    S().duplicatePaths(['a'], { dx: 40, dy: 0 }); await step()
    expect(S().paths.filter((p) => p.id !== 'a')).toHaveLength(2)
    expect(events()).toBe(before + 2)
    await undo()
    expect(S().paths.filter((p) => p.id !== 'a')).toHaveLength(1)
  })

  it('every copy one click makes shares one copyBatch, and the next click gets a new one', async () => {
    await load({ paths: [path('a'), path('b')] })
    S().duplicatePaths(['a', 'b'], { dx: 20, dy: 0 }); await step()
    S().duplicatePaths(['a', 'b'], { dx: 40, dy: 0 }); await step()
    const batches = S().paths.filter((p) => p.id !== 'a' && p.id !== 'b').map((p) => p.copyBatch)
    expect(batches[0]).toBeDefined()
    expect(batches[1]).toBe(batches[0])
    expect(batches[2]).toBe(batches[3])
    expect(batches[2]).not.toBe(batches[0])
    expect(S().paths.find((p) => p.id === 'a')!.copyBatch).toBeUndefined()
  })

  it('an id no longer in the document is skipped, and none left makes nothing', async () => {
    await load({ paths: [path('a')] })
    const before = events()
    S().duplicatePaths(['gone'], { dx: 5, dy: 5 }); await step()
    expect(S().paths).toHaveLength(1)
    expect(events()).toBe(before)
  })
})

describe('re-running a bolt circle that is held to its plate', () => {
  // The Pattern form's edit: the copies are rewritten around the source, which
  // stays put — so a bigger radius moves the circle's CENTRE, off the plate's.
  const hole = (cx: number, cy: number): ImportedPath => {
    const shapeParams = { type: 'circle' as const, cx, cy, radius: 3 }
    return path('h0', { d: generateShapeD(shapeParams), shapeParams })
  }
  const ring = (r: number): PatternParams =>
    ({ type: 'circular', count: 6, radiusMM: r, startAngleDeg: 0, endAngleDeg: 360, rotateItems: false })
  const copiesOf = (src: ImportedPath, r: number) => {
    const params = ring(r)
    const definition = { id: 'def1', kind: 'pattern' as const, sourceIds: [src.id], params }
    return patternCopies([src], computePatternInstances(params, getMultiBBox([src.d])).slice(1))
      .map((c, i) => ({ ...c, id: `c${i + 1}`, definition }) as ImportedPath)
  }
  const plate = path('plate', { d: rectD(0, 0, 100, 80) })
  const src = hole(80, 40)            // a 30 mm bolt circle centred on the plate (50, 40)
  const held: Constraint = {
    id: 'k', mode: 'xy', offsetXMM: 0, offsetYMM: 0,
    from: { kind: 'path', id: 'plate', anchor: 'center' }, to: { kind: 'pattern', id: 'h0' },
  }
  const rerun = (holdOthers: boolean) => S().rewriteGeneratedRaw({
    updates: copiesOf(src, 40).map((p) => ({ id: p.id, d: p.d, name: p.name, definition: p.definition, fields: p })),
    holdOthers,
  })

  beforeEach(async () => {
    vi.useFakeTimers()
    useWorkpieceStore.setState({ widthMM: 300, heightMM: 200 })
    await load({ paths: [plate, src, ...copiesOf(src, 30)], constraints: [held] })
  })
  afterEach(() => { vi.useRealTimers() })

  it('brings the circle back onto the plate and leaves the plate where it was', async () => {
    rerun(true)
    await step()
    const c = patternCentreOf(S().paths, 'h0')!
    expect(c.x).toBeCloseTo(50, 3)
    expect(c.y).toBeCloseTo(40, 3)
    expect(S().paths.find((p) => p.id === 'plate')!.d).toBe(plate.d)
  })

  it('would shift the plate to the circle instead if the pattern were the anchor', async () => {
    // The default, right for a gear whose mates should follow its new size, and
    // the reason the Pattern form asks for `holdOthers`.
    rerun(false)
    await step()
    expect(S().paths.find((p) => p.id === 'plate')!.d).not.toBe(plate.d)
  })
})

describe('resizing the original of a pattern in Properties', () => {
  const src = (() => {
    const shapeParams = { type: 'circle' as const, cx: 80, cy: 40, radius: 3 }
    return path('h0', { d: generateShapeD(shapeParams), shapeParams })
  })()
  const params: PatternParams = { type: 'circular', count: 4, radiusMM: 30, startAngleDeg: 0, endAngleDeg: 360, rotateItems: false }
  const copies = patternCopies([src], computePatternInstances(params, getMultiBBox([src.d])).slice(1))
    .map((c, i) => ({ ...c, id: `c${i + 1}`, definition: { id: 'def1', kind: 'pattern' as const, sourceIds: ['h0'], params } }) as ImportedPath)
  const width = (id: string) => getBBox(S().paths.find((p) => p.id === id)!.d)!.width

  beforeEach(async () => {
    vi.useFakeTimers()
    await load({ paths: [src, ...copies] })
  })
  afterEach(() => { vi.useRealTimers() })

  it('resizes every copy in the same edit, and one undo puts them all back', async () => {
    S().updateShapeParams('h0', { type: 'circle', cx: 80, cy: 40, radius: 5 })
    await step()
    for (const id of ['h0', 'c1', 'c2', 'c3']) expect(width(id)).toBeCloseTo(10, 4)
    await undo()
    for (const id of ['h0', 'c1', 'c2', 'c3']) expect(width(id)).toBeCloseTo(6, 4)
  })

  it('rebuilds the copies’ toolpaths with the original’s', async () => {
    vi.mocked(regenerateAffectedMany).mockClear()
    S().updateShapeParams('h0', { type: 'circle', cx: 80, cy: 40, radius: 5 })
    await step()
    const asked = vi.mocked(regenerateAffectedMany).mock.calls.flatMap((c) => c[0] as string[])
    expect(asked).toEqual(expect.arrayContaining(['c1', 'c2', 'c3']))
  })
})

describe('typing a new number into a constraint inside a patterned assembly', () => {
  // A plate (big circle), a bolt circle held to its centre, and a grid made of the
  // two together. The constraint is the assembly's own layout: changing it has to
  // move the bolt circle AND every copy of it in the grid.
  const circ = (id: string, cx: number, cy: number, radius: number) => {
    const shapeParams = { type: 'circle' as const, cx, cy, radius }
    return path(id, { d: generateShapeD(shapeParams), shapeParams })
  }
  const make = (sources: ImportedPath[], params: PatternParams, defId: string) =>
    patternCopies(sources, computePatternInstances(params, getMultiBBox(sources.map((s) => s.d))).slice(1))
      .map((c, i) => ({ ...c, id: `${defId}-c${i + 1}`, definition: { id: defId, kind: 'pattern' as const, sourceIds: sources.map((s) => s.id), params } }) as ImportedPath)
  const plate = circ('C', 50, 40, 45)
  const h0 = circ('h0', 80, 40, 3)
  const ring = make([h0], { type: 'circular', count: 4, radiusMM: 30, startAngleDeg: 0, endAngleDeg: 360, rotateItems: false }, 'def1')
  const assembly = [plate, h0, ...ring]
  const grid = make(assembly, { type: 'linear', rows: 1, cols: 2, xGapMM: 10, yGapMM: 0 }, 'def2')
  const held: Constraint = {
    id: 'k', mode: 'xy', offsetXMM: 0, offsetYMM: 0,
    from: { kind: 'path', id: 'C', anchor: 'center' }, to: { kind: 'pattern', id: 'h0' },
  }
  const centreX = (id: string) => getBBox(S().paths.find((p) => p.id === id)!.d)!.cx

  beforeEach(async () => {
    vi.useFakeTimers()
    useWorkpieceStore.setState({ widthMM: 400, heightMM: 200 })
    await load({ paths: [...assembly, ...grid], constraints: [held] })
  })
  afterEach(() => { vi.useRealTimers() })

  it('moves the bolt circle off the plate’s centre, and the grid’s copy of it with it', async () => {
    const plateBefore = S().paths.find((p) => p.id === 'C')!.d
    // The grid's copy of h0 is the second item of its one instance (C, h0, ring…).
    const copyOfH0 = grid[1].id
    const was = centreX(copyOfH0)
    constraintsStore.getState().updateConstraint('k', { offsetXMM: 5 })
    await step()
    expect(S().paths.find((p) => p.id === 'C')!.d).toBe(plateBefore)
    expect(centreX('h0')).toBeCloseTo(85, 3)
    expect(centreX(copyOfH0)).toBeCloseTo(was + 5, 3)
  })
})

describe('a duplicate made with Duplicate follows its original', () => {
  const orig = (() => {
    const shapeParams = { type: 'circle' as const, cx: 20, cy: 20, radius: 3 }
    return path('o', { d: generateShapeD(shapeParams), shapeParams })
  })()
  const copyId = () => S().paths.find((p) => p.id !== 'o')!.id
  const radiusOf = (id: string) => (S().paths.find((p) => p.id === id)!.shapeParams as { radius: number }).radius
  const centreOf = (id: string) => { const b = getBBox(S().paths.find((p) => p.id === id)!.d)!; return [b.cx, b.cy] }

  beforeEach(async () => {
    vi.useFakeTimers()
    await load({ paths: [orig], selected: ['o'] })
    S().duplicatePaths(['o'], { dx: 40, dy: 0 })
    await step()
  })
  afterEach(() => { vi.useRealTimers() })

  it('takes the original’s new diameter in the same step, and one undo puts both back', async () => {
    const c = copyId()
    S().updateShapeParams('o', { type: 'circle', cx: 20, cy: 20, radius: 6 })
    await step()
    expect(radiusOf(c)).toBe(6)
    const [cx, cy] = centreOf(c)
    expect(cx).toBeCloseTo(60, 4)
    expect(cy).toBeCloseTo(20, 4)
    await undo()
    expect(radiusOf('o')).toBe(3)
    expect(radiusOf(c)).toBe(3)
  })

  it('stays linked after it is moved, and stops following once its own diameter is changed', async () => {
    const c = copyId()
    bakePathsStep([c], { kind: 'translate', dx: 10, dy: 15 }, 'move')
    await step()
    expect(linkedOriginalOf(S().paths, S().paths.find((p) => p.id === c)!)?.id).toBe('o')
    S().updateShapeParams(c, { type: 'circle', cx: 70, cy: 35, radius: 9 })
    await step()
    expect(S().paths.find((p) => p.id === c)!.copyOf).toMatchObject({ sourceId: 'o', unlinked: true })
    S().updateShapeParams('o', { type: 'circle', cx: 20, cy: 20, radius: 4 })
    await step()
    expect(radiusOf(c)).toBe(9)
  })

  it('stops following when unlinked by hand, keeping its shape', async () => {
    const c = copyId()
    const p = S().paths.find((q) => q.id === c)!
    S().applyPathEdit({ updates: [{ id: c, d: p.d, copyOf: { sourceId: 'o', unlinked: true } }] })
    await step()
    S().updateShapeParams('o', { type: 'circle', cx: 20, cy: 20, radius: 5 })
    await step()
    expect(radiusOf(c)).toBe(3)
  })
})

describe('a duplicate of a rectangle given corners in the Corners form', () => {
  const rect = (() => {
    const shapeParams = { type: 'rectangle' as const, x: 0, y: 0, w: 20, h: 10 }
    return path('o', { d: generateShapeD(shapeParams), shapeParams })
  })()
  const copy = () => S().paths.find((p) => p.id !== 'o')!
  const orig = () => S().paths.find((p) => p.id === 'o')!
  const round = (r: number) => applyCorners(orig(), cornerSession(orig()), [], 'outerRound', r)
  const boxOf = (d: string) => getBBox(d)!

  beforeEach(async () => {
    vi.useFakeTimers()
    await load({ paths: [rect], selected: ['o'] })
    S().duplicatePaths(['o'], { dx: 40, dy: 0 })
    await step()
  })
  afterEach(() => { vi.useRealTimers() })

  it('gets the corners too, cut where the copy stands, and follows a new radius', async () => {
    round(2)
    await step()
    expect(copy().corners?.treatments).toEqual(orig().corners?.treatments)
    expect(boxOf(copy().d).minX).toBeCloseTo(40, 4)
    // The copy's outline is the original's, moved 40 across.
    const nums = (d: string) => (d.match(/-?\d+\.?\d*/g) ?? []).map((n) => Math.round(+n * 1e4) / 1e4)
    expect(nums(copy().d)).toEqual(nums(translateD(orig().d, 40, 0)))
    round(4)
    await step()
    expect(copy().corners?.treatments[0][1].radiusMM).toBe(4)
    expect(linkedOriginalOf(S().paths, copy())?.id).toBe('o')
    await undo()
    expect(copy().corners?.treatments[0][1].radiusMM).toBe(2)
  })
})

describe('a duplicate of a boolean follows a resize of the original', () => {
  // A union of two rectangles, made with the real Boolean action — a flattened result
  // with HIDDEN operands — duplicated with the real Duplicate, which pulls the hidden
  // operands along so the copy is a boolean of its own. Then the original result is
  // resized with the handles. Nothing here is special-cased for booleans: the copy is
  // the original moved, so it becomes the original's new state moved.
  const a = path('a', { d: rectD(0, 0, 20, 10) })
  const b = path('b', { d: rectD(10, 0, 10, 20) })
  const result = () => S().paths.find((p) => p.definition?.kind === 'boolean' && !p.copyOf)!
  const copy = () => S().paths.find((p) => p.definition?.kind === 'boolean' && p.copyOf)!

  beforeEach(async () => {
    vi.useFakeTimers()
    await load({ paths: [a, b] })
    createBoolean([a, b], 'union')
    await step()
    S().duplicatePaths([result().id], { dx: 50, dy: 0 })
    await step()
  })
  afterEach(() => { vi.useRealTimers() })

  it('is linked, and doubles in size with the original, staying where it was put', async () => {
    expect(linkedOriginalOf(S().paths, copy())?.id).toBe(result().id)
    const box0 = getBBox(copy().d)!
    bakePathsStep([result().id], { kind: 'scale', sx: 2, sy: 2, ax: 0, ay: 0 }, 'scale')
    await step()
    const box1 = getBBox(copy().d)!
    expect(box1.width).toBeCloseTo(box0.width * 2, 3)
    expect(box1.height).toBeCloseTo(box0.height * 2, 3)
    expect(box1.minX).toBeCloseTo(box0.minX, 3)
    expect(box1.minY).toBeCloseTo(box0.minY, 3)
    await undo()
    expect(getBBox(copy().d)!.width).toBeCloseTo(box0.width, 3)
  })
})
