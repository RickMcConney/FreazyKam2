// What makes an open simulator rebuild its program. Driven against the real stores; the
// key is compared by identity, entry for entry, exactly as the auto-reload compares it.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolStore, type Tool } from '../store/toolStore'
import type { AnyOperation } from '../store/toolpathStore'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))
const { programKey } = await import('./simAutoReload')

const tool: Tool = {
  id: 'em', name: 'Endmill 3', type: 'endmill', diameterMM: 3, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const op = {
  id: 'p', name: 'Profile', type: 'profile', toolId: 'em', status: 'done', visible: true, color: '#fff',
  segments: [{ x: 0, y: 0, z: -1, rapid: false }], pathId: 'a',
} as unknown as AnyOperation
const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i])

beforeEach(() => {
  useToolStore.setState({ tools: [tool] })
  useWorkpieceStore.getState().setMaterial('pine')
  useWorkpieceStore.getState().setAutoFeedEnabled(true)
})

describe('the simulator rebuilds when the program it plays would come out different', () => {
  it('rebuilds nothing when nothing changed', () => {
    expect(same(programKey([op]), programKey([op]))).toBe(true)
  })

  it('rebuilds when the material changes — auto feeds work the feed out from it when the G-code is written', () => {
    const before = programKey([op])
    useWorkpieceStore.getState().setMaterial('basswood')
    expect(same(before, programKey([op]))).toBe(false)
  })

  it('rebuilds when auto feeds is switched, or the machine rigidity it trims by changes', () => {
    let before = programKey([op])
    useWorkpieceStore.getState().setAutoFeedEnabled(false)
    expect(same(before, programKey([op]))).toBe(false)
    before = programKey([op])
    useWorkpieceStore.getState().setMachineRigidity(useWorkpieceStore.getState().machineRigidity === 5 ? 4 : 5)
    expect(same(before, programKey([op]))).toBe(false)
  })

  it('rebuilds when the tool an operation uses is edited — its feed and rpm are in the program', () => {
    const before = programKey([op])
    useToolStore.getState().updateTool('em', { xyFeedMmMin: 1500 })
    expect(same(before, programKey([op]))).toBe(false)
  })
})
