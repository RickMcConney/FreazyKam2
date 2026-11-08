// An M4 post turns the spindle the other way, and with it every climb (cam/spindleHand.ts).
// Driven against the real stores and the real generators, as opJob.drill.test.ts is: the
// worker call goes straight to the handler table the worker dispatches on.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolStore, type Tool, type CuttingDirection } from '../store/toolStore'
import { usePostProcessorStore, BUILTIN_PROFILES } from '../store/postProcessorStore'
import type { MotionSegment } from '../store/toolpathStore'

vi.mock('../workers/workerClient', async () => {
  const { handlers } = await import('../workers/handlers')
  return {
    runInWorkerFor: vi.fn(async (_key: unknown, name: keyof typeof handlers, ...args: unknown[]) =>
      (handlers[name] as (...a: unknown[]) => unknown)(...args)),
    isWorkCancelled: () => false,
  }
})
vi.mock('./regenerate', () => ({
  regenerateOperation: vi.fn(async () => {}), regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(),
  regenerateAll: vi.fn(), regenerateMany: vi.fn(),
}))

const { generateOperation } = await import('./opJob')

const tool: Tool = { id: 'em', name: 'Endmill 3', type: 'endmill', diameterMM: 3, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25 }
const square: ImportedPath = { id: 'sq', name: 'sq', visible: true, color: '#fff', d: 'M 10 10 L 50 10 L 50 40 L 10 40 Z' }
const base = { id: 'OP', name: 'op', toolId: 'em', pathId: 'sq', status: 'needs-update', segments: [], color: '#fff', visible: true, depthMM: 3, stepDownMM: 3, rampIn: false }

const OPS: Record<string, (direction: CuttingDirection) => AnyOperation> = {
  profile: (direction) => ({ ...base, type: 'profile', side: 'outside', direction }) as AnyOperation,
  'profile with Optimize Path': (direction) => ({ ...base, type: 'profile', side: 'outside', sharedLines: true, pathIds: [], direction }) as AnyOperation,
  pocket: (direction) => ({ ...base, type: 'pocket', islandIds: [], stepoverPercent: 40, passAngleDeg: 0, strategy: 'contour', direction }) as AnyOperation,
  trochoidal: (direction) => ({ ...base, type: 'trochoidal', side: 'outside', direction, trochStepMM: 0.5, trochRadiusMM: 1, finishingPass: false }) as AnyOperation,
}

function post(spindleOnTemplate: string) {
  const p = { ...BUILTIN_PROFILES[0], spindleOnTemplate }
  usePostProcessorStore.setState({ profiles: [p], activeId: p.id })
}
async function cut(op: AnyOperation): Promise<MotionSegment[]> {
  useToolpathStore.setState({ operations: [op] })
  await generateOperation('OP')
  const done = useToolpathStore.getState().operations[0]
  expect(done.status).toBe('done')
  return done.segments
}

beforeEach(() => {
  useToolStore.setState({ tools: [tool] })
  usePathsStore.setState({ paths: [square] })
})

describe('an M4 post turns climb and conventional round', () => {
  for (const [type, make] of Object.entries(OPS)) {
    it(`a ${type}'s climb on M4 is cut exactly as its conventional on M3 — and not as its climb`, async () => {
      post('M3 S{s}')
      const climbM3 = await cut(make('climb'))
      const convM3 = await cut(make('conventional'))
      expect(convM3).not.toEqual(climbM3)
      post('M4 S{s}')
      expect(await cut(make('climb'))).toEqual(convM3)
      expect(await cut(make('conventional'))).toEqual(climbM3)
    })
  }
})
