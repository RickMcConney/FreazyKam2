// The registration holes drill themselves (tools/registrationOps): every hole path of a
// double-sided or tiled job has its drill op, at the job's depth and tool, in one batch,
// first in the program — and it lands in the SAME undo step as the change that called for
// it, so undo never meets the drilling on its own and puts it straight back. Real stores
// and history; regeneration stubbed; the clock faked and every action `step()`-ped.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { holeTool, installRegistrationSync } from './registrationOps'
import { applyTiling } from './tilingRun'
import { applyDoubleSided } from './doubleSidedRun'
import { useWorkpieceStore } from '../store/workpieceStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore, type AnyOperation, type DrillOperation } from '../store/toolpathStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { evenSeams, TILING_DEFAULTS, type Tiling } from '../cam/tiling'
import { DOUBLE_SIDED_DEFAULTS } from '../cam/doubleSided'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))

let clock = 1_000_000
async function step() {
  clock += 1000
  vi.setSystemTime(clock)
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const tool = (id: string, type: Tool['type'], diameterMM: number): Tool =>
  ({ id, name: id, type, diameterMM, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25 } as Tool)
const QUARTER = tool('quarter', 'endmill', 6.35)
const EIGHTH = tool('eighth', 'endmill', 3.175)
const HALF = tool('half', 'endmill', 12.7)
const DRILL = tool('drill', 'drill', 6)

const ops = () => useToolpathStore.getState().operations
const drills = () => ops().filter((o): o is DrillOperation => o.type === 'drill')
/** Each station's drilling depth, in station order. */
const depths = () => { const ids = useWorkpieceStore.getState().tiling!.pinPathIds!; return ids.map((id) => drills().find((o) => o.pathId === id)!.depthMM) }
const undo = async () => { useTimelineStore.getState().undo(); await step() }
let unsub: () => void = () => {}

async function makeTiled() {
  const base: Tiling = { axis: 'x', maxTravelMM: 200, seamsMM: [], ...TILING_DEFAULTS }
  applyTiling({ ...base, seamsMM: evenSeams(base, useWorkpieceStore.getState()) }, true)
  await step()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  useWorkpieceStore.setState({ widthMM: 600, heightMM: 300, thicknessMM: 12, safeHeightMM: 5, tiling: null, doubleSided: null })
  useToolStore.setState({ tools: [DRILL, EIGHTH, QUARTER, HALF] })
  usePathsStore.setState({ paths: [{ id: 'part', name: 'Part', d: 'M 50 50 L 550 50 L 550 250 L 50 250 Z', visible: true, color: '#000' }], selectedIds: [] })
  useToolpathStore.setState({ operations: [{ id: 'cut', name: 'Profile', type: 'profile', toolId: 'quarter', pathId: 'part', segments: [], status: 'done', visible: true, color: '#000', depthMM: 12, stepDownMM: 3 } as unknown as AnyOperation] })
  await step()
  useTimelineStore.getState().resetToCurrentState()
  await step()
  unsub = installRegistrationSync()
  await step()
})
afterEach(() => { unsub(); vi.useRealTimers() })

describe('the end mill that bores the holes', () => {
  it('is the largest end mill that fits the small hole', () => {
    expect(holeTool([DRILL, EIGHTH, QUARTER, HALF], undefined, 8)?.id).toBe('quarter')
  })

  it('is the job’s own choice while that still fits, and not once it does not', () => {
    expect(holeTool([EIGHTH, QUARTER], 'eighth', 8)?.id).toBe('eighth')
    expect(holeTool([EIGHTH, QUARTER, HALF], 'half', 8)?.id).toBe('quarter')
  })

  it('is no tool at all when none fits — never a drill bit, which would peck both holes one size', () => {
    expect(holeTool([DRILL, HALF], undefined, 8)).toBeUndefined()
  })
})

describe('a tiled job', () => {
  it('has every pin hole drilled the moment it is made, first in the program, in one batch', async () => {
    await makeTiled()
    const pinIds = useWorkpieceStore.getState().tiling!.pinPathIds!
    expect(drills().map((o) => o.pathId)).toEqual(pinIds)
    expect(ops().slice(0, pinIds.length).every((o) => o.type === 'drill')).toBe(true)
    expect(ops()[ops().length - 1].id).toBe('cut')
    expect(new Set(drills().map((o) => o.batchId)).size).toBe(1)
    for (const d of drills()) {
      expect(d.toolId).toBe('quarter')
      expect(d.drillMode).toBe('helical')
    }
    // The first pair into the spoilboard, for the pins; the rest only through the board.
    expect(depths()).toEqual([12 + TILING_DEFAULTS.spoilDepthMM, 12.5, 12.5, 12.5])
  })

  it('keeps the drilling at the job’s depth and tool as they change', async () => {
    await makeTiled()
    applyTiling({ ...useWorkpieceStore.getState().tiling!, spoilDepthMM: 3, toolId: 'eighth' })
    await step()
    for (const d of drills()) expect(d.toolId).toBe('eighth')
    expect(depths()).toEqual([15, 12.5, 12.5, 12.5])
    useWorkpieceStore.getState().setThickness(18)
    await step()
    expect(depths()).toEqual([21, 18.5, 18.5, 18.5])
  })

  it('drills a station added with a tile, in the same batch, at its own depth', async () => {
    await makeTiled()
    const t = useWorkpieceStore.getState().tiling!
    applyTiling({ ...t, seamsMM: evenSeams(t, useWorkpieceStore.getState(), 5) })
    await step()
    expect(drills()).toHaveLength(5)
    expect(depths()).toEqual([20, 12.5, 12.5, 12.5, 12.5])
    expect(new Set(drills().map((o) => o.batchId)).size).toBe(1)
  })

  it('takes its drilling back in the same undo step as the change that made it — nothing reappears', async () => {
    await makeTiled()
    applyTiling({ ...useWorkpieceStore.getState().tiling!, spoilDepthMM: 3 })
    await step()
    await undo()
    expect(depths()).toEqual([20, 12.5, 12.5, 12.5])
    await undo()
    expect(useWorkpieceStore.getState().tiling).toBeNull()
    expect(drills()).toHaveLength(0)
    await step()
    expect(drills()).toHaveLength(0)
  })

  it("keeps each station's own depth when another station's path is missing", async () => {
    await makeTiled()
    const ids = useWorkpieceStore.getState().tiling!.pinPathIds!
    // Station 1's path gone from under the setting (a stray delete); station 2 onward must
    // stay "through the board only", not shuffle up into station 1's spoilboard depth.
    usePathsStore.getState().applyPathEdit({ deleteIds: [ids[0]] })
    await step()
    const left = ids.slice(1).map((id) => drills().find((o) => o.pathId === id)!.depthMM)
    expect(left).toEqual([12.5, 12.5, 12.5])
  })
})

describe('a double-sided job', () => {
  it('has its dowel holes drilled the moment it is made, through the stock and into the spoilboard', async () => {
    applyDoubleSided({ flip: 'left-right', ...DOUBLE_SIDED_DEFAULTS }, true)
    await step()
    expect(drills()).toHaveLength(1)
    expect(ops()[0]).toBe(drills()[0])
    expect(drills()[0].pathId).toBe(useWorkpieceStore.getState().doubleSided!.dowelPathId)
    expect(drills()[0].depthMM).toBe(12 + DOUBLE_SIDED_DEFAULTS.spoilDepthMM)
  })
})
