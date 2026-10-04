// A shared-line profile is ONE operation over a whole sheet (`pathId` + `pathIds`) — the
// wiring around cam/sharedLineProfile.ts, driven against the real stores. The worker pool
// does not exist under node, so the call goes straight to the handler table the worker
// dispatches on; what is recorded is which job ran.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToolpathStore, refsPathId, pathIdsOf, type AnyOperation, type ProfileOperation } from '../store/toolpathStore'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { startInputForOp } from './startHeight'

const jobs: string[] = []
vi.mock('../workers/workerClient', async () => {
  const { handlers } = await import('../workers/handlers')
  return {
    runInWorkerFor: vi.fn(async (_key: unknown, name: keyof typeof handlers, ...args: unknown[]) => {
      jobs.push(name)
      return (handlers[name] as (...a: unknown[]) => unknown)(...args)
    }),
    isWorkCancelled: () => false,
  }
})
// Every function the stores reach for after an edit, as the other store tests list them. A
// bare automock left `regenerateAffectedMany` undefined when pathsStore loaded the module
// dynamically after a path edit, and the rejected promise surfaced as an unhandled error.
vi.mock('./regenerate', () => ({
  regenerateOperation: vi.fn(async () => {}),
  regenerateAffectedMany: vi.fn(),
  regenerateAffected: vi.fn(),
  regenerateAll: vi.fn(),
  regenerateMany: vi.fn(),
}))

const { generateOperation } = await import('./opJob')

const tool: Tool = {
  id: 'em', name: 'Endmill 6', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const sq = (x: number) => `M ${x} 0 L ${x + 20} 0 L ${x + 20} 20 L ${x} 20 Z`
const path = (id: string, d: string): ImportedPath => ({ id, name: id, d, visible: true, color: '#fff' })

function sheet(over: Partial<ProfileOperation> = {}): AnyOperation {
  return {
    id: 'S', name: 'Sheet', type: 'profile', toolId: 'em', status: 'needs-update', segments: [], color: '#fff', visible: true,
    pathId: 'a', pathIds: ['b', 'c'], side: 'outside', depthMM: 6, stepDownMM: 3, direction: 'climb', rampIn: false,
    sharedLines: true, ...over,
  } as AnyOperation
}
const get = () => useToolpathStore.getState().operations.find((o) => o.id === 'S') as ProfileOperation | undefined

beforeEach(() => {
  jobs.length = 0
  useToolStore.setState({ tools: [tool] })
  // One cutter apart: the cut paths of a and b meet on x = 23, of b and c on x = 49.
  usePathsStore.setState({ paths: [path('a', sq(0)), path('b', sq(26)), path('c', sq(52))] })
  useToolpathStore.setState({ operations: [sheet()] })
})

describe('a shared-line profile operation', () => {
  it('is generated as one network job over every part of its sheet', async () => {
    await generateOperation('S')
    expect(jobs).toEqual(['generateSharedLineProfile'])
    expect(get()!.status).toBe('done')
    // All three parts are cut: the far ends of a and c are on the toolpath.
    const xs = get()!.segments.filter((s) => !s.rapid).map((s) => s.x)
    expect(Math.min(...xs)).toBeCloseTo(-3, 9)
    expect(Math.max(...xs)).toBeCloseTo(75, 9)
  })

  it('without Shared Lines it is an ordinary profile of its one path', async () => {
    useToolpathStore.setState({ operations: [sheet({ sharedLines: false, pathIds: undefined })] })
    await generateOperation('S')
    expect(jobs).toEqual(['generateProfile'])
  })

  it('every part of the sheet is a source path — editing any of them makes the operation stale', () => {
    for (const id of ['a', 'b', 'c']) expect(refsPathId(get()!, id)).toBe(true)
    expect(pathIdsOf(get()!)).toEqual(['a', 'b', 'c'])
  })

  it('its start height looks at the footprint of every part, not just the first', () => {
    const input = startInputForOp(get()!, usePathsStore.getState().paths, [tool])!
    expect(input.footprintD).toContain(sq(52))
  })

  it('deleting a part takes it out of the sheet, and the rest is still cut', () => {
    usePathsStore.getState().applyPathEdit({ deleteIds: ['b'] })
    expect(get()).toMatchObject({ pathId: 'a', pathIds: ['c'] })
  })

  it('deleting its first part hands the sheet to the next one', () => {
    usePathsStore.getState().applyPathEdit({ deleteIds: ['a'] })
    expect(get()).toMatchObject({ pathId: 'b', pathIds: ['c'] })
  })

  it('it goes only with its last part', () => {
    usePathsStore.getState().applyPathEdit({ deleteIds: ['a', 'b', 'c'] })
    expect(get()).toBeUndefined()
  })
})
