// The operations store: how a Generate lands in the program and in the undo history, and
// how an operation learns that the surface it was cut from has moved. Drives the real
// stores and history; only regeneration is stubbed (it would reach for the worker pool).
// See pathsStore.test.ts for why the clock is faked and every action is `step()`-ped.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useToolpathStore, batchOf, nothingToCut, type AnyOperation, type AddPayload } from './toolpathStore'
import { usePathsStore, type ImportedPath } from './pathsStore'
import { useToolStore } from './toolStore'
import { useWorkpieceStore } from './workpieceStore'
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

const rectD = (x: number, y: number, w: number, h: number) =>
  `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
const path = (id: string, d = rectD(0, 0, 10, 10)): ImportedPath => ({ id, name: id, d, color: '#000', visible: true })
const pocket = (pathId: string, over: Record<string, unknown> = {}): AddPayload => ({
  name: `Pocket ${pathId}`, type: 'pocket', toolId: 't', pathId, islandIds: [], depthMM: 3, stepDownMM: 3,
  stepoverPercent: 40, passAngleDeg: 0, direction: 'climb', strategy: 'raster', rampIn: false, ...over,
} as AddPayload)
const SEGS = [{ x: 0, y: 0, z: -3, rapid: false }]

const T = () => useToolpathStore.getState()
const ops = () => T().operations
const opIds = () => ops().map((o) => o.id)
const get = (id: string) => ops().find((o) => o.id === id)!
const events = () => useTimelineStore.getState().events.length
const undo = async () => { useTimelineStore.getState().undo(); await step() }

async function load(doc: { paths?: ImportedPath[]; ops?: AnyOperation[] } = {}) {
  usePathsStore.setState({ paths: doc.paths ?? [], selectedIds: [] })
  useToolpathStore.setState({ operations: doc.ops ?? [] })
  await step()
  useTimelineStore.getState().resetToCurrentState()
  await step()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  useWorkpieceStore.setState({ widthMM: 200, heightMM: 200, safeHeightMM: 5 })
  useToolStore.setState({ tools: [{ id: 't', name: 't', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25 }] })
  await load()
})
afterEach(() => { vi.useRealTimers() })

describe('adding operations', () => {
  it('makes every op the same way: pending, no segments, visible, coloured', () => {
    const [id] = T().addOperations([pocket('a')])
    expect(get(id)).toMatchObject({ status: 'pending', segments: [], visible: true })
    expect(get(id).color).toMatch(/^#/)
  })

  it('batches ops made by one click, as ONE undo step — and leaves a lone op unbatched', async () => {
    const made = T().addOperations([pocket('a'), pocket('b'), pocket('c')])
    await step()
    expect(events()).toBe(1)
    expect(new Set(made.map((id) => get(id).batchId)).size).toBe(1)
    expect(get(made[0]).batchId).toBeDefined()
    expect(batchOf(get(made[1]), ops()).map((o) => o.id)).toEqual(made)
    const [lone] = T().addOperations([pocket('d')])
    expect(get(lone).batchId).toBeUndefined()
    await step()
    await undo()
    await undo()
    expect(ops()).toEqual([])
  })

  it('records nothing when asked not to', async () => {
    T().addOperations([pocket('a')], { record: false })
    await step()
    expect(events()).toBe(0)
  })
})

describe('editing an operation', () => {
  it('records nothing for a derived write — status, segments, entry hint', async () => {
    // With something done since, so the write cannot hide inside the op's own step.
    const [id] = T().addOperations([pocket('a')])
    await step()
    usePathsStore.getState().addPaths([path('rect')])
    await step()
    T().updateOperation(id, { status: 'done', segments: SEGS, entryHint: { x: 1, y: 1 } })
    await step()
    expect(events()).toBe(2)
  })

  it("joins the step that just made it, so one undo takes the op and its edit away", async () => {
    // Changing a just-made pocket's depth is an argument edit to the call that made it.
    const [id] = T().addOperations([pocket('a')])
    await step()
    T().updateOperation(id, { depthMM: 5 } as Partial<AnyOperation>)
    await step()
    expect(events()).toBe(1)
    expect((get(id) as { depthMM: number }).depthMM).toBe(5)
    await undo()
    expect(ops()).toEqual([])
  })

  it('records its own step when something was done since — and undoing it takes back only the edit', async () => {
    // Joining the OLDER step took back the rectangle drawn since along with the depth edit.
    const [id] = T().addOperations([pocket('a')])
    await step()
    usePathsStore.getState().addPaths([path('rect')])
    await step()
    T().updateOperation(id, { depthMM: 5 } as Partial<AnyOperation>)
    await step()
    expect(events()).toBe(3)
    await undo()
    expect((get(id) as { depthMM: number }).depthMM).toBe(3)
    expect(usePathsStore.getState().paths.map((p) => p.id)).toEqual(['rect'])
  })

  it('never joins the step the last save captured — that step must stay what was saved', async () => {
    const [id] = T().addOperations([pocket('a')])
    await step()
    useTimelineStore.getState().markSaved()
    T().updateOperation(id, { depthMM: 5 } as Partial<AnyOperation>)
    await step()
    expect(events()).toBe(2)
  })
})

describe('replacing and revising a generated set', () => {
  it('replaces the ops of a just-made Generate without a new step', async () => {
    const [id] = T().addOperations([pocket('a')])
    await step()
    const made = T().replaceGeneratedOperations({ anchorId: id, deleteIds: [id], add: [pocket('a', { invert: true }), pocket('b')] })
    await step()
    expect(events()).toBe(1)
    expect(opIds()).toEqual(made)
  })

  it('records a replacement of an OLDER Generate as one step, which one undo reverts', async () => {
    // It used to record a delete and then an add, and the first undo did nothing.
    const [id] = T().addOperations([pocket('a')])
    await step()
    usePathsStore.getState().addPaths([path('rect')])
    await step()
    T().replaceGeneratedOperations({ anchorId: id, deleteIds: [id], add: [pocket('a', { invert: true })] })
    await step()
    expect(events()).toBe(3)
    await undo()
    expect(opIds()).toEqual([id])
  })

  it('keeps surviving members, splices new ones BESIDE them, and mints a batch for a lone op', async () => {
    // Appending would move a drill hole added as an afterthought to the end of the job.
    const [first] = T().addOperations([pocket('a')])
    const [after] = T().addOperations([pocket('z')])
    await step()
    expect(get(first).batchId).toBeUndefined()
    const [added] = T().reviseBatchPaths({ anchorId: first, deleteIds: [], add: [pocket('b')] })
    await step()
    expect(opIds()).toEqual([first, added, after])
    expect(get(first).batchId).toBeDefined()
    expect(get(added).batchId).toBe(get(first).batchId)
    expect(get(after).batchId).toBeUndefined()
  })

  it('puts the new members where the batch stood when every old member is removed', async () => {
    const [before] = T().addOperations([pocket('x')])
    const batch = T().addOperations([pocket('a'), pocket('b')])
    const [after] = T().addOperations([pocket('z')])
    await step()
    const made = T().reviseBatchPaths({ anchorId: batch[0], deleteIds: batch, add: [pocket('c')] })
    expect(opIds()).toEqual([before, ...made, after])
  })
})

describe('setSegments and start heights', () => {
  // A 100 mm pocket 3 deep, and a smaller pocket inside it that starts on its floor.
  const outer = path('outer', rectD(0, 0, 100, 100))
  const inner = path('inner', rectD(30, 30, 20, 20))
  const done = (id: string, pathId: string, over: Record<string, unknown> = {}): AnyOperation => ({
    ...pocket(pathId), id, status: 'done', segments: SEGS, color: '#fff', visible: true, ...over,
  } as AnyOperation)
  // No `startFrom` means stock top, so a project from before the feature cuts as it did;
  // an op that sits on another's floor says so.
  const AUTO = { startFrom: { mode: 'auto' } }

  it('stamps what the segments were built from and marks the op done', async () => {
    await load({ paths: [outer], ops: [{ ...done('A', 'outer'), status: 'generating', segments: [] } as AnyOperation] })
    T().setSegments('A', SEGS)
    expect(get('A')).toMatchObject({ status: 'done', segments: SEGS, generatedWith: { safeHeightMM: 5, startZMM: 0 } })
  })

  it("resolves an op's start from the floor it sits on", async () => {
    await load({ paths: [outer, inner], ops: [done('A', 'outer'), { ...done('B', 'inner', AUTO), status: 'generating' } as AnyOperation] })
    T().setSegments('B', SEGS)
    expect(get('B').generatedWith?.startZMM).toBeCloseTo(-3, 9)
  })

  it('marks an op out of date when the floor moved WHILE it generated', async () => {
    // It used to stamp the NEW start onto segments cut from the old one, marked done, and
    // the stale toolpath was exported.
    await load({ paths: [outer, inner], ops: [done('A', 'outer'), { ...done('B', 'inner', AUTO), status: 'generating' } as AnyOperation] })
    T().setSegments('B', SEGS, { safeHeightMM: 5, startZMM: -3 })
    expect(get('B').status).toBe('done')
    T().setSegments('B', SEGS, { safeHeightMM: 5, startZMM: 0 })
    expect(get('B').status).toBe('needs-update')
  })

  it('marks an op out of date when the op beneath it changes depth, and leaves others alone', async () => {
    await load({
      paths: [outer, inner, path('far', rectD(150, 150, 10, 10))],
      ops: [
        done('A', 'outer', { generatedWith: { safeHeightMM: 5, startZMM: 0 } }),
        done('B', 'inner', { ...AUTO, generatedWith: { safeHeightMM: 5, startZMM: -3 } }),
        done('C', 'far', { ...AUTO, generatedWith: { safeHeightMM: 5, startZMM: 0 } }),
        done('D', 'inner', AUTO),   // never stamped: left alone rather than flagged on a guess
      ],
    })
    T().revalidateStartHeights()
    expect(ops().map((o) => o.status)).toEqual(['done', 'done', 'done', 'done'])
    T().updateOperation('A', { depthMM: 5 } as Partial<AnyOperation>)
    expect(get('B').status).toBe('needs-update')
    expect(get('C').status).toBe('done')
    expect(get('D').status).toBe('done')
  })

  it('marks an op out of date when a reorder takes its floor out from under it', async () => {
    await load({
      paths: [outer, inner],
      ops: [done('A', 'outer', { generatedWith: { safeHeightMM: 5, startZMM: 0 } }), done('B', 'inner', { ...AUTO, generatedWith: { safeHeightMM: 5, startZMM: -3 } })],
    })
    T().revalidateStartHeights()
    expect(get('B').status).toBe('done')
    T().moveOperation('B', 'up')
    expect(opIds()).toEqual(['B', 'A'])
    expect(get('B').status).toBe('needs-update')
  })
})

describe('status', () => {
  const op = (id: string, status: string, over: Record<string, unknown> = {}) =>
    ({ ...pocket('a'), id, status, segments: SEGS, color: '#fff', visible: true, ...over } as AnyOperation)

  it('records a failure on the op and drops its segments', () => {
    useToolpathStore.setState({ operations: [op('A', 'generating')] })
    T().setError('A', 'too small for the selected tool diameter')
    expect(get('A')).toMatchObject({ status: 'error', errorMessage: 'too small for the selected tool diameter', segments: [] })
  })

  it('settles only the ops that were generating when a generation is cancelled', () => {
    useToolpathStore.setState({ operations: [op('A', 'generating'), op('B', 'done'), op('C', 'error')] })
    T().cancelGenerating()
    expect(ops().map((o) => o.status)).toEqual(['needs-update', 'done', 'error'])
  })

  it('marks only done ops that use the path, as source or as island', () => {
    useToolpathStore.setState({ operations: [op('src', 'done', { pathId: 'p' }), op('isl', 'done', { pathId: 'q', islandIds: ['p'] }), op('other', 'done', { pathId: 'q' }), op('pending', 'pending', { pathId: 'p' })] })
    T().markNeedsUpdate('p')
    expect(ops().map((o) => o.status)).toEqual(['needs-update', 'needs-update', 'done', 'pending'])
  })
})

describe('program order and visibility', () => {
  const three = () => ['A', 'B', 'C'].map((id) => ({ ...pocket(id), id, status: 'done', segments: [], color: '#fff', visible: true } as AnyOperation))

  it('moves an op up or down, and not past either end', async () => {
    await load({ ops: three() })
    T().moveOperation('A', 'up')
    T().moveOperation('C', 'down')
    expect(opIds()).toEqual(['A', 'B', 'C'])
    T().moveOperation('A', 'down')
    expect(opIds()).toEqual(['B', 'A', 'C'])
  })

  it('makes a session of reordering ONE undo step, however far apart the drags', async () => {
    await load({ ops: three() })
    T().moveOperation('A', 'down')
    await step()
    T().moveOperation('A', 'down')
    await step()
    expect(events()).toBe(1)
    await undo()
    expect(opIds()).toEqual(['A', 'B', 'C'])
  })

  it('records hiding an op — it changes the exported program — and merges a run of toggles', async () => {
    await load({ ops: three() })
    T().toggleVisibility('A')
    await step()
    T().setOperationsVisible(['B', 'C'], false)
    await step()
    expect(ops().map((o) => o.visible)).toEqual([false, false, false])
    expect(events()).toBe(1)
    await undo()
    expect(ops().map((o) => o.visible)).toEqual([true, true, true])
  })
})

// An inlay half whose partner cuts everything (thin text) is EMPTY BY DESIGN, and every
// report on empty operations — the export check, the chip, the project audit — asks this
// before calling it missing.
describe('nothingToCut', () => {
  const seg = { x: 0, y: 0, z: -1, rapid: false }
  const half = (id: string, linkedOpId: string | undefined, segments: unknown[], over: Record<string, unknown> = {}) =>
    ({ id, type: 'inlay', status: 'done', linkedOpId, segments, ...over }) as unknown as AnyOperation

  it('is true for a generated, empty inlay half whose linked half has motion', () => {
    const ops = [half('v', 'e', [seg]), half('e', 'v', [])]
    expect(nothingToCut(ops[1], ops)).toBe(true)
    expect(nothingToCut(ops[0], ops)).toBe(false)   // the half WITH motion
  })

  it('is false when both halves are empty — that pair cut nothing at all', () => {
    const ops = [half('v', 'e', []), half('e', 'v', [])]
    expect(nothingToCut(ops[1], ops)).toBe(false)
  })

  it('is false until the op has actually generated, and for an unlinked or non-inlay op', () => {
    const pending = [half('v', 'e', [seg]), half('e', 'v', [], { status: 'pending' })]
    expect(nothingToCut(pending[1], pending)).toBe(false)
    const alone = [half('e', undefined, [])]
    expect(nothingToCut(alone[0], alone)).toBe(false)
    const pocket = [half('v', 'e', [seg]), half('e', 'v', [], { type: 'pocket' })]
    expect(nothingToCut(pocket[1], pocket)).toBe(false)
  })
})
