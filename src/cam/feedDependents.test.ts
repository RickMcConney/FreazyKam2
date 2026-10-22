import { describe, it, expect, beforeEach } from 'vitest'
import { opsWithStaleStepDown } from './feedDependents'
import { effectiveStepDownMM } from './feeds'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { Tool } from '../store/toolStore'
import type { AnyOperation, StepDownStamp } from '../store/toolpathStore'

// A 6 mm end mill 12 mm deep: hardness moves its step-down (oak takes more passes than
// pine). A 1/8" one 3 mm deep is capped by its diameter, the same in every wood.
const big: Tool = { id: 'big', name: '6 mm', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1500, zFeedMmMin: 500, maxDepthMM: 25 }
const small: Tool = { id: 'small', name: '1/8"', type: 'endmill', diameterMM: 3.175, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 12 }
const tools = [big, small]

// An op stamped the way generateOperation stamps one, under the CURRENT settings.
function generated(id: string, tool: Tool, depthMM: number): AnyOperation {
  const stamp: StepDownStamp = { toolId: tool.id, userMM: 1, depthMM, mm: effectiveStepDownMM(tool, 1, depthMM) }
  return { id, name: id, type: 'profile', toolId: tool.id, status: 'done', segments: [], color: '#fff', visible: true,
    pathId: 'p', depthMM, stepDownMM: 1, generatedWith: { safeHeightMM: 5, stepDowns: [stamp] } } as unknown as AnyOperation
}

beforeEach(() => {
  useWorkpieceStore.getState().setAutoFeedEnabled(true)
  useWorkpieceStore.getState().setMaterial('pine')
})

describe('a change to what auto feeds read regenerates the toolpaths whose step-down it moves', () => {
  it('finds nothing stale when nothing changed', () => {
    expect(opsWithStaleStepDown([generated('a', big, 12)], tools)).toEqual([])
  })

  it('a harder material makes a deep cut with a big bit stale — and leaves one capped by its bit alone', () => {
    const ops = [generated('deep', big, 12), generated('capped', small, 3)]
    useWorkpieceStore.getState().setMaterial('oak')
    expect(effectiveStepDownMM(big, 1, 12)).not.toBeCloseTo(ops[0].generatedWith!.stepDowns![0].mm, 6)
    expect(opsWithStaleStepDown(ops, tools).map((o) => o.id)).toEqual(['deep'])
  })

  it('turning Auto Feeds off makes an auto step-down stale — the typed value takes over', () => {
    const ops = [generated('deep', big, 12)]
    useWorkpieceStore.getState().setAutoFeedEnabled(false)
    expect(opsWithStaleStepDown(ops, tools).map((o) => o.id)).toEqual(['deep'])
  })

  it('leaves alone an op with no record, one not finished, and one whose tool is gone', () => {
    const none = { ...generated('none', big, 12), generatedWith: { safeHeightMM: 5 } } as AnyOperation
    const busy = { ...generated('busy', big, 12), status: 'generating' } as AnyOperation
    const orphan = generated('orphan', big, 12)
    useWorkpieceStore.getState().setMaterial('oak')
    expect(opsWithStaleStepDown([none, busy, orphan], [small])).toEqual([])
  })
})
