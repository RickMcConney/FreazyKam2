// The one door to a program (io/gcodeExport): on a tiled job its programs are the TILES,
// so everything that walks programs — the export, the picker, the machine, the MCP tools —
// gets tiles without knowing. Drives the real stores; regeneration stubbed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { programForSheet, programCount, programFileName } from './gcodeExport'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useUIStore } from '../store/uiStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { STOCK_CELL } from '../cam/sheets'
import { TILING_DEFAULTS, type Tiling } from '../cam/tiling'
import type { AnyOperation } from '../store/toolpathStore'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))

const tiling: Tiling = { axis: 'x', maxTravelMM: 200, seamsMM: [150, 300, 450], ...TILING_DEFAULTS }
const slot = { id: 'slot', name: 'Slot', type: 'profile', toolId: 't', visible: true, status: 'done', segments: [
  { x: 10, y: 100, z: 5, rapid: true }, { x: 10, y: 100, z: -3, rapid: false }, { x: 590, y: 100, z: -3, rapid: false }, { x: 590, y: 100, z: 5, rapid: true },
] } as unknown as AnyOperation
const prepared = () => ({ all: [slot], toolsById: {}, profile: usePostProcessorStore.getState().getActiveProfile(), cells: [STOCK_CELL] })

beforeEach(() => {
  useWorkpieceStore.setState({ widthMM: 600, heightMM: 300, safeHeightMM: 5, tiling: null, doubleSided: null })
  useUIStore.setState({ activeTile: 0, activeSheet: STOCK_CELL })
})

describe('the programs of a tiled job', () => {
  it('are its tiles: one per tile, named for the tile', () => {
    useWorkpieceStore.setState({ tiling })
    expect(programCount(prepared())).toBe(4)
    const p = programForSheet(prepared(), 2)
    expect(p).toMatchObject({ tile: 2, sheet: 2, sheets: 4 })
    expect(programFileName('job', p)).toBe('job_tile3')
  })

  it("are each the board's toolpaths cut to the tile and moved to the machine's spot", () => {
    useWorkpieceStore.setState({ tiling })
    const [op] = programForSheet(prepared(), 1).operations
    const xs = op.segments.map((g) => g.x)
    expect(Math.min(...xs)).toBeCloseTo(0, 9)
    expect(Math.max(...xs)).toBeCloseTo(150, 9)
  })

  it('default to the tile picked in the toolbar', () => {
    useWorkpieceStore.setState({ tiling })
    useUIStore.setState({ activeTile: 3 })
    expect(programForSheet(prepared()).tile).toBe(3)
  })
})

describe('the program of an ordinary job', () => {
  it('is the whole job, untouched, with the base name', () => {
    expect(programCount(prepared())).toBe(1)
    const p = programForSheet(prepared())
    expect(p.tile).toBeUndefined()
    expect(p.operations[0]).toBe(slot)
    expect(programFileName('job', p)).toBe('job')
  })
})
