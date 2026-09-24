// Chaining operations so each starts where the previous one left the tool.
//
// Regeneration itself runs in the worker pool, which does not exist under node, so it is
// replaced by a fake that behaves like the real one where it matters here: it stamps
// `generatedWith` with the inputs it used, and its exit point depends on the entry hint
// it was given — so a hint that changes visibly moves the next operation's hint too.
// What is under test is the decision: WHICH operations get regenerated, and with what.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToolpathStore, type AnyOperation, type MotionSegment } from '../store/toolpathStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { usePathsStore } from '../store/pathsStore'

const regenerated: { id: string; hint: { x: number; y: number } | undefined }[] = []
const failing = new Set<string>()

// Where the fake's toolpath ends: 10 mm right of wherever it was told to start (or of
// (100, 100) with no hint). The real exit depends on the entry the same way in kind.
const exitFor = (hint?: { x: number; y: number }) => ({ x: (hint?.x ?? 100) + 10, y: hint?.y ?? 100 })

vi.mock('./regenerate', () => ({
  regenerateOperation: vi.fn(async (id: string) => {
    const { operations } = useToolpathStore.getState()
    const op = operations.find((o) => o.id === id)!
    regenerated.push({ id, hint: op.entryHint })
    if (failing.has(id)) {
      useToolpathStore.setState({ operations: operations.map((o) => (o.id === id ? { ...o, status: 'error' } as AnyOperation : o)) })
      return
    }
    const e = exitFor(op.entryHint)
    const segments: MotionSegment[] = [
      { x: e.x - 10, y: e.y, z: 5, rapid: true },
      { x: e.x - 10, y: e.y, z: -3, rapid: false },
      { x: e.x, y: e.y, z: -3, rapid: false },
      { x: e.x, y: e.y, z: 5, rapid: true },
    ]
    const generatedWith = { entryHint: op.entryHint, safeHeightMM: useWorkpieceStore.getState().safeHeightMM, startZMM: 0 }
    useToolpathStore.setState({
      operations: operations.map((o) => (o.id === id ? { ...o, segments, status: 'done', generatedWith } as AnyOperation : o)),
    })
  }),
}))

const { entryHintAt, optimizeStartPoints } = await import('./startOptimizer')

// A generated operation whose toolpath leaves the tool at `exit` by a final rapid.
function op(id: string, exit: { x: number; y: number } | null, over: Record<string, unknown> = {}): AnyOperation {
  const segments: MotionSegment[] = exit
    ? [{ x: 0, y: 0, z: -3, rapid: false }, { x: exit.x, y: exit.y, z: 5, rapid: true }]
    : []
  return {
    id, name: id, type: 'pocket', toolId: 't', status: 'done', segments, color: '#fff', visible: true,
    pathId: 'nowhere', islandIds: [], depthMM: 3, stepDownMM: 3, stepoverPercent: 40, passAngleDeg: 0,
    direction: 'climb', strategy: 'raster', rampIn: false,
    ...over,
  } as AnyOperation
}

// An operation generated exactly as optimizeStartPoints would want it: hinted at the
// previous one's exit (none for the first), at the current safe height and stock top.
function upToDate(o: AnyOperation, hint: { x: number; y: number } | undefined): AnyOperation {
  return { ...o, entryHint: hint, generatedWith: { entryHint: hint, safeHeightMM: 5, startZMM: 0 } } as AnyOperation
}

const setOps = (...operations: AnyOperation[]) => useToolpathStore.setState({ operations })
const get = (id: string) => useToolpathStore.getState().operations.find((o) => o.id === id)!

beforeEach(() => {
  regenerated.length = 0
  failing.clear()
  useWorkpieceStore.setState({ widthMM: 200, heightMM: 100, origin: 'bottom-left', safeHeightMM: 5 })
  useToolStore.setState({
    tools: [{ id: 't', name: 't', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25 }],
  })
  usePathsStore.setState({ paths: [] })
  setOps()
})

describe('entryHintAt — where the operation before this one left the tool', () => {
  it('gives the first operation no hint, rather than dragging it toward the origin', () => {
    setOps(op('a', { x: 40, y: 30 }), op('b', { x: 0, y: 0 }))
    expect(entryHintAt('a')).toBeUndefined()
  })

  it("hints each later operation at its predecessor's final rapid", () => {
    setOps(op('a', { x: 40, y: 30 }), op('b', { x: 70, y: 10 }), op('c', { x: 0, y: 0 }))
    expect(entryHintAt('b')).toEqual({ x: 40, y: 30 })
    expect(entryHintAt('c')).toEqual({ x: 70, y: 10 })
  })

  it('skips operations that are not generated — they are not in the program', () => {
    setOps(op('a', { x: 40, y: 30 }), op('b', { x: 70, y: 10 }, { status: 'error' }), op('c', null))
    expect(entryHintAt('c')).toEqual({ x: 40, y: 30 })
  })

  it('uses the cut point nearest the running position when an operation ends without a rapid', () => {
    const noRapid = op('a', null, { segments: [
      { x: 190, y: 90, z: -3, rapid: false },
      { x: 20, y: 15, z: -3, rapid: false },
      { x: 100, y: 50, z: -3, rapid: false },
    ] })
    setOps(noRapid, op('b', null))
    // Nearest to the origin, which is where the chain starts — bottom-left here…
    expect(entryHintAt('b')).toEqual({ x: 20, y: 15 })
    // …and the top-right corner of the stock when the origin is set there.
    useWorkpieceStore.setState({ origin: 'top-right' })
    expect(entryHintAt('b')).toEqual({ x: 190, y: 90 })
  })

  it('leaves the position where it was after a V-carve that ends without a rapid', () => {
    setOps(op('a', { x: 40, y: 30 }), op('v', null, { type: 'vcarve', segments: [{ x: 5, y: 5, z: -1, rapid: false }] }), op('c', null))
    expect(entryHintAt('c')).toEqual({ x: 40, y: 30 })
  })

  it('returns nothing for an operation that is not in the program', () => {
    setOps(op('a', { x: 40, y: 30 }))
    expect(entryHintAt('missing')).toBeUndefined()
  })
})

describe('optimizeStartPoints — rebuilding exactly the operations the chain invalidated', () => {
  it('regenerates nothing when every operation was generated with the hint it would get', () => {
    setOps(upToDate(op('a', { x: 40, y: 30 }), undefined), upToDate(op('b', { x: 70, y: 10 }), { x: 40, y: 30 }))
    return optimizeStartPoints().then(() => expect(regenerated).toEqual([]))
  })

  it('regenerates an operation whose hint no longer matches, with the new hint', async () => {
    // Generated from a form, which ignores the hint, and then the program was reordered.
    setOps(upToDate(op('a', { x: 40, y: 30 }), undefined), upToDate(op('b', { x: 70, y: 10 }), { x: 1, y: 1 }))
    await optimizeStartPoints()
    expect(regenerated).toEqual([{ id: 'b', hint: { x: 40, y: 30 } }])
    expect(get('b').generatedWith?.entryHint).toEqual({ x: 40, y: 30 })
  })

  it('carries a regenerated exit on down the chain', async () => {
    // a is out of date; regenerating it moves its exit, so b — up to date against a's OLD
    // exit — has to follow.
    setOps(op('a', { x: 40, y: 30 }), upToDate(op('b', { x: 70, y: 10 }), { x: 40, y: 30 }))
    await optimizeStartPoints()
    expect(regenerated).toEqual([
      { id: 'a', hint: undefined },
      { id: 'b', hint: exitFor(undefined) },
    ])
  })

  it('regenerates everything after the safe height changes', async () => {
    setOps(upToDate(op('a', { x: 40, y: 30 }), undefined), upToDate(op('b', { x: 70, y: 10 }), { x: 40, y: 30 }))
    useWorkpieceStore.setState({ safeHeightMM: 10 })
    await optimizeStartPoints()
    expect(regenerated.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('regenerates an operation whose start height drifted since it was generated', async () => {
    const a = upToDate(op('a', { x: 40, y: 30 }), undefined)
    setOps({ ...a, generatedWith: { ...a.generatedWith!, startZMM: -2 } } as AnyOperation)
    await optimizeStartPoints()
    expect(regenerated.map((r) => r.id)).toEqual(['a'])
  })

  it('regenerates an operation already marked out of date, even though it is not done', async () => {
    // The one this pass exists for. It used to skip everything not `done`, so a V-carve
    // marked stale by the pocket it sits in was left out of the export instead.
    setOps(upToDate(op('a', { x: 40, y: 30 }), undefined), upToDate(op('b', { x: 70, y: 10 }, { status: 'needs-update' }), { x: 40, y: 30 }))
    await optimizeStartPoints()
    expect(regenerated.map((r) => r.id)).toEqual(['b'])
    expect(get('b').status).toBe('done')
  })

  it('leaves out operations that are neither done nor stale', async () => {
    setOps(op('a', null, { status: 'pending' }), op('b', null, { status: 'error' }))
    await optimizeStartPoints()
    expect(regenerated).toEqual([])
  })

  for (const type of ['surface', 'inlay', 'profile3d', 'photovcarve', 'gcode']) {
    it(`never regenerates ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type} operation for a hint it ignores — but does when it is stale`, async () => {
      setOps(op('x', { x: 40, y: 30 }, { type }), upToDate(op('b', { x: 70, y: 10 }), { x: 40, y: 30 }))
      await optimizeStartPoints()
      expect(regenerated).toEqual([])
      setOps(op('x', { x: 40, y: 30 }, { type, status: 'needs-update' }))
      await optimizeStartPoints()
      expect(regenerated.map((r) => r.id)).toEqual(['x'])
    })
  }

  it("still moves the chain along past an operation it doesn't regenerate", async () => {
    setOps(op('s', { x: 40, y: 30 }, { type: 'surface' }), op('b', { x: 70, y: 10 }))
    await optimizeStartPoints()
    expect(regenerated).toEqual([{ id: 'b', hint: { x: 40, y: 30 } }])
  })

  it('does not chain from an operation whose regeneration failed — it is not in the program', async () => {
    failing.add('b')
    setOps(upToDate(op('a', { x: 40, y: 30 }), undefined), op('b', { x: 70, y: 10 }), op('c', { x: 0, y: 0 }))
    await optimizeStartPoints()
    expect(regenerated).toEqual([
      { id: 'b', hint: { x: 40, y: 30 } },
      { id: 'c', hint: { x: 40, y: 30 } },
    ])
  })
})
