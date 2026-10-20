// Writing a tiling setting keeps its pin-hole paths in step — one per station, moved with
// the seams, added and removed with tiles, strays cleared — as ONE undo step each. Drives
// the real stores and history; only regeneration is stubbed (it reaches for the worker
// pool). The clock is faked and every action `step()`-ped, as in pathsStore.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyTiling, removeTiling } from './tilingRun'
import { useWorkpieceStore } from '../store/workpieceStore'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { evenSeams, stationPins, TILING_DEFAULTS, type Tiling } from '../cam/tiling'
import { getBBox } from '../canvas/selectionUtils'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))

let clock = 1_000_000
async function step() {
  clock += 1000
  vi.setSystemTime(clock)
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

const tiling = () => useWorkpieceStore.getState().tiling!
const pins = () => usePathsStore.getState().paths.filter((p) => p.registration === 'tile-pins')
const centreX = (p: ImportedPath) => getBBox(p.d)!.cx
const undo = async () => { useTimelineStore.getState().undo(); await step() }

async function makeTiled() {
  const base: Tiling = { axis: 'x', maxTravelMM: 200, seamsMM: [], ...TILING_DEFAULTS }
  applyTiling({ ...base, seamsMM: evenSeams(base, useWorkpieceStore.getState()) }, true)
  await step()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  useWorkpieceStore.setState({ widthMM: 600, heightMM: 300, thicknessMM: 12, safeHeightMM: 5, tiling: null, doubleSided: null })
  usePathsStore.setState({ paths: [{ id: 'part', name: 'Part', d: 'M 50 50 L 550 50 L 550 250 L 50 250 Z', visible: true, color: '#000' }], selectedIds: [] })
  useToolpathStore.setState({ operations: [] })
  await step()
  useTimelineStore.getState().resetToCurrentState()
  await step()
})
afterEach(() => { vi.useRealTimers() })

describe('the pin-hole paths of a tiled job', () => {
  it('are one marked path per tile, each at its station', async () => {
    await makeTiled()
    const t = tiling()
    expect(pins().map((p) => p.id)).toEqual(t.pinPathIds)
    pins().forEach((p, k) => expect(centreX(p)).toBeCloseTo(stationPins(t, useWorkpieceStore.getState(), k)[0].x, 6))
  })

  it("follow a moved seam — that station's path moves, and no other", async () => {
    await makeTiled()
    const before = pins().map(centreX)
    applyTiling({ ...tiling(), seamsMM: [120, 300, 450] })
    await step()
    const after = pins().map(centreX)
    expect(after[1]).toBeCloseTo(before[1] - 30, 6)
    expect([after[0], after[2], after[3]]).toEqual([before[0], before[2], before[3]])
  })

  it('gain a station with a tile and lose one with it', async () => {
    await makeTiled()
    applyTiling({ ...tiling(), seamsMM: evenSeams(tiling(), useWorkpieceStore.getState(), 5) })
    await step()
    expect(pins()).toHaveLength(5)
    applyTiling({ ...tiling(), seamsMM: evenSeams(tiling(), useWorkpieceStore.getState(), 3) })
    await step()
    expect(pins()).toHaveLength(3)
    expect(tiling().pinPathIds).toEqual(pins().map((p) => p.id))
  })

  it('clear a stray pin-hole path the setting lost track of at the next change', async () => {
    await makeTiled()
    usePathsStore.setState({ paths: [...usePathsStore.getState().paths, { id: 'stray', name: 'Tile Pins 2', d: 'M 160 20 L 161 20', visible: true, color: '#000' }] })
    applyTiling({ ...tiling(), seamsMM: [164, 300, 450] })
    await step()
    expect(usePathsStore.getState().paths.some((p) => p.id === 'stray')).toBe(false)
    expect(pins()).toHaveLength(4)
  })

  it('move with the setting in ONE undo step', async () => {
    await makeTiled()
    const before = pins().map((p) => p.d)
    applyTiling({ ...tiling(), seamsMM: [120, 300, 450] })
    await step()
    await undo()
    expect(tiling().seamsMM).toEqual([150, 300, 450])
    expect(pins().map((p) => p.d)).toEqual(before)
  })

  it('go when the job is made a single board, and one undo brings the job and its holes back', async () => {
    await makeTiled()
    removeTiling(tiling())
    await step()
    expect(useWorkpieceStore.getState().tiling).toBeNull()
    expect(pins()).toHaveLength(0)
    expect(usePathsStore.getState().paths.map((p) => p.id)).toEqual(['part'])
    await undo()
    expect(useWorkpieceStore.getState().tiling).not.toBeNull()
    expect(pins()).toHaveLength(4)
  })
})
