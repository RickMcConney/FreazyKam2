// A helical drill generation, driven against the real stores. The worker pool does not
// exist under node, so the call goes straight to the handler table the worker dispatches
// on (as in opJob.sharedLines.test.ts); what is recorded is which job ran.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToolpathStore, type AnyOperation, type DrillOperation } from '../store/toolpathStore'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { extractCircles } from '../canvas/selectionUtils'

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
vi.mock('./regenerate', () => ({
  regenerateOperation: vi.fn(async () => {}),
  regenerateAffectedMany: vi.fn(),
  regenerateAffected: vi.fn(),
  regenerateAll: vi.fn(),
  regenerateMany: vi.fn(),
}))

const { generateOperation } = await import('./opJob')

const tool: Tool = {
  id: 'em', name: 'Endmill 3', type: 'endmill', diameterMM: 3, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const r = 4
const circle = (id: string, cx: number): ImportedPath => ({
  id, name: id, visible: true, color: '#fff',
  d: `M ${cx + r} 10 A ${r} ${r} 0 1 0 ${cx - r} 10 A ${r} ${r} 0 1 0 ${cx + r} 10 Z`,
})
function drill(holes = extractCircles(circle('h', 10))): AnyOperation {
  return {
    id: 'D', name: 'Drill', type: 'drill', drillMode: 'helical', toolId: 'em', status: 'needs-update', segments: [],
    color: '#fff', visible: true, pathId: 'h', points: [], depthMM: 6, stepDownMM: 2, helicalHoles: holes,
  } as AnyOperation
}
const get = () => useToolpathStore.getState().operations.find((o) => o.id === 'D') as DrillOperation

beforeEach(() => {
  jobs.length = 0
  useToolStore.setState({ tools: [tool] })
  usePathsStore.setState({ paths: [circle('h', 10)] })
  useToolpathStore.setState({ operations: [drill()] })
})

describe('a helical drill generation', () => {
  it('bores its holes in the worker, not on the main thread', async () => {
    await generateOperation('D')
    expect(jobs).toEqual(['generateHelicalDrills'])
    expect(get().status).toBe('done')
  })

  it('writes nothing to the operations when its holes have not moved — one write, the toolpath itself', async () => {
    // Each write re-renders everything that draws the program, so a no-op write-back per
    // op cost 100 ms apiece once a thousand other toolpaths were on the canvas.
    let writes = 0
    const off = useToolpathStore.subscribe((s, prev) => { if (s.operations !== prev.operations) writes++ })
    await generateOperation('D')
    off()
    expect(writes).toBe(1)
  })

  it('still writes the holes back when the circle has moved since they were stored', async () => {
    usePathsStore.setState({ paths: [circle('h', 30)] })
    await generateOperation('D')
    expect(get().helicalHoles!.map((h) => h.cx)).toEqual([expect.closeTo(30)])
  })

  it('records its auto step-down on the stamp, so a material change can find it — and not a manual one', async () => {
    await generateOperation('D')
    expect(get().generatedWith!.stepDowns).toEqual([
      expect.objectContaining({ toolId: 'em', userMM: 2, depthMM: 6, mm: expect.any(Number) }),
    ])
    useToolpathStore.setState({ operations: [{ ...drill(), stepDownManual: true } as AnyOperation] })
    await generateOperation('D')
    expect(get().generatedWith!.stepDowns).toEqual([])
  })
})
