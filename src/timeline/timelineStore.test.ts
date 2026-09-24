// The undo history: a snapshot stack behind an event log. Most of what is pinned here is
// about writes that land WITHOUT recording — a joined edit, generated segments — which
// the snapshot at the cursor has to pick up, or undo/redo quietly hands back an old state.
// See src/store/CLAUDE.md. Clock faked and every action `step()`-ped, as in the store tests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useTimelineStore } from './timelineStore'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolpathStore, type AnyOperation, type AddPayload } from '../store/toolpathStore'
import { useTabStore } from '../store/tabStore'
import { useConstraintsStore } from '../store/constraintsStore'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))

let clock = 1_000_000
async function step(ms = 1000) {
  clock += ms
  vi.setSystemTime(clock)
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

const rectD = (x: number) => `M ${x} 0 L ${x + 10} 0 L ${x + 10} 10 L ${x} 10 Z`
const path = (id: string, x = 0): ImportedPath => ({ id, name: id, d: rectD(x), color: '#000', visible: true })
const pocket = (pathId: string): AddPayload => ({
  name: 'Pocket', type: 'pocket', toolId: 't', pathId, islandIds: [], depthMM: 3, stepDownMM: 3,
  stepoverPercent: 40, passAngleDeg: 0, direction: 'climb', strategy: 'raster', rampIn: false,
} as AddPayload)

const TL = () => useTimelineStore.getState()
const P = () => usePathsStore.getState()
const ids = () => P().paths.map((p) => p.id)
const ops = () => useToolpathStore.getState().operations
const undo = async () => { TL().undo(); await step() }
const redo = async () => { TL().redo(); await step() }
const move = (id: string, x: number) =>
  P().batchUpdatePaths([{ id, d: rectD(x), transforms: [{ kind: 'translate', dx: x, dy: 0 }] }], 'move')

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  usePathsStore.setState({ paths: [], selectedIds: [] })
  useToolpathStore.setState({ operations: [] })
  useTabStore.setState({ tabs: [] })
  useConstraintsStore.setState({ constraints: [] })
  await step()
  TL().resetToCurrentState()
  await step()
})
afterEach(() => { vi.useRealTimers() })

describe('undo and redo', () => {
  it('walks back to where the project was opened, and no further', async () => {
    P().addPaths([path('a')])
    await step()
    expect(TL().canUndo()).toBe(true)
    await undo()
    expect(ids()).toEqual([])
    expect(TL().canUndo()).toBe(false)
    expect(TL().canRedo()).toBe(true)
    await redo()
    expect(ids()).toEqual(['a'])
  })

  it('abandons the redo branch when a new edit is made after an undo', async () => {
    P().addPaths([path('a')])
    await step()
    P().addPaths([path('b')])
    await step()
    await undo()
    P().addPaths([path('c')])
    await step()
    expect(TL().canRedo()).toBe(false)
    expect(TL().events.map((e) => e.seq)).toEqual([1, 2])
    expect(ids()).toEqual(['a', 'c'])
  })

  it('stops calling the project clean once the step it was saved at is abandoned', async () => {
    P().addPaths([path('a')])
    await step()
    TL().markSaved()
    await undo()
    P().addPaths([path('b')])
    await step()
    expect(TL().savedSeq).toBe(-1)
  })
})

describe('what one step is', () => {
  it('merges quick repeat edits of the same paths into one step', async () => {
    P().addPaths([path('a')])
    await step()
    P().updatePathD('a', rectD(1))
    await step(100)
    P().updatePathD('a', rectD(2))
    await step(100)
    expect(TL().events).toHaveLength(2)
    await undo()
    expect(P().paths[0].d).toBe(rectD(0))
  })

  it('keeps slow edits apart', async () => {
    P().addPaths([path('a')])
    await step()
    P().updatePathD('a', rectD(1))
    await step()
    P().updatePathD('a', rectD(2))
    await step()
    expect(TL().events).toHaveLength(3)
  })

  it('merges a run of moves of the same selection however far apart they are', async () => {
    // A reposition done in several drags is one net move.
    P().addPaths([path('a')])
    await step()
    move('a', 5)
    await step(60_000)
    move('a', 9)
    await step()
    expect(TL().events).toHaveLength(2)
    await undo()
    expect(P().paths[0].d).toBe(rectD(0))
  })

  it('never merges into the step the last save captured', async () => {
    P().addPaths([path('a')])
    await step()
    P().updatePathD('a', rectD(1))
    await step(100)
    TL().markSaved()
    P().updatePathD('a', rectD(2))
    await step(100)
    expect(TL().events).toHaveLength(3)
  })

  it('keeps no more than 500 steps, renumbered from 1', async () => {
    P().addPaths([path('a')])
    await step()
    for (let i = 1; i <= 505; i++) {
      P().updatePathD('a', rectD(i))
      await step()
    }
    const ev = TL().events
    expect(ev).toHaveLength(500)
    expect(ev[0].seq).toBe(1)
    expect(TL().cursor).toBe(500)
  })
})

describe('writes that land without recording still reach the history', () => {
  it('redoes an edit that JOINED its step', async () => {
    const [id] = useToolpathStore.getState().addOperations([pocket('a')])
    await step()
    useToolpathStore.getState().updateOperation(id, { depthMM: 5 } as Partial<AnyOperation>)
    await step()
    P().addPaths([path('b')])
    await step()
    await undo()
    await undo()
    await redo()
    expect((ops()[0] as { depthMM: number }).depthMM).toBe(5)
  })

  it('brings an operation back WITH the toolpath generated after its step was recorded', async () => {
    // A snapshot used to be taken only when an event was recorded, so the segments that
    // arrived after it never reached it: undo brought the op back pending, or — worse —
    // done, carrying a toolpath from before a move.
    const [id] = useToolpathStore.getState().addOperations([pocket('a')])
    await step()
    useToolpathStore.getState().setSegments(id, [{ x: 1, y: 2, z: -3, rapid: false }])
    await step()
    P().addPaths([path('b')])
    await step()
    await undo()
    expect(ops()[0]).toMatchObject({ status: 'done', segments: [{ x: 1, y: 2, z: -3, rapid: false }] })
  })

  it('hands back an op caught mid-generation as out of date, not as generating', async () => {
    const [id] = useToolpathStore.getState().addOperations([pocket('a')])
    await step()
    useToolpathStore.getState().updateOperation(id, { status: 'generating' }, { record: false })
    await step()
    P().addPaths([path('b')])
    await step()
    await undo()
    expect(ops()[0].status).toBe('needs-update')
  })
})

describe('selection across an undo', () => {
  it('keeps the selection when the step only changed geometry', async () => {
    P().addPaths([path('a'), path('b')])
    await step()
    move('a', 5)
    await step()
    P().setSelectedIds(['b'])
    await undo()
    expect(P().selectedIds).toEqual(['b'])
  })

  it('selects what an add made when undo brings the paths back', async () => {
    P().addPaths([path('a'), path('b')])
    await step()
    P().setSelectedIds(['a', 'b'])
    P().deleteSelected()
    await step()
    await undo()
    expect(ids()).toEqual(['a', 'b'])
    expect(P().selectedIds).toEqual(['a', 'b'])
  })
})
