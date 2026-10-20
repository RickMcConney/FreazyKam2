// Writing a double-sided setting keeps its dowel holes on the pins and side B's parts on
// the back of the board — each change ONE undo step. Real stores and history; regeneration
// stubbed; the clock faked and every action `step()`-ped, as in pathsStore.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyDoubleSided, changeFlip, makeSingleSided } from './doubleSidedRun'
import { useWorkpieceStore } from '../store/workpieceStore'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { backCell, otherSideBox, pinCentres, DOUBLE_SIDED_DEFAULTS } from '../cam/doubleSided'
import { cellOffset } from '../cam/sheets'
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

const stock = { widthMM: 300, heightMM: 200 }
const ds = () => useWorkpieceStore.getState().doubleSided!
const paths = () => usePathsStore.getState().paths
const byId = (id: string) => paths().find((p) => p.id === id)!
const box = (p: ImportedPath) => { const b = getBBox(p.d)!; return { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY } }
const undo = async () => { useTimelineStore.getState().undo(); await step() }
const close = (a: Record<string, number>, b: Record<string, number>) => { for (const k of Object.keys(b)) expect(a[k]).toBeCloseTo(b[k], 6) }

// A part on side B: on the sheet to the right of the stock.
const back = cellOffset(backCell('left-right'), stock)
const sideBPart: ImportedPath = { id: 'b', name: 'B part', d: `M ${back.x + 20} 30 L ${back.x + 80} 30 L ${back.x + 80} 60 L ${back.x + 20} 60 Z`, visible: true, color: '#000' }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  useWorkpieceStore.setState({ ...stock, thicknessMM: 12, safeHeightMM: 5, tiling: null, doubleSided: null })
  usePathsStore.setState({ paths: [{ id: 'a', name: 'A part', d: 'M 20 30 L 80 30 L 80 60 L 20 60 Z', visible: true, color: '#000' }], selectedIds: [] })
  useToolpathStore.setState({ operations: [] })
  await step()
  useTimelineStore.getState().resetToCurrentState()
  await step()
  applyDoubleSided({ flip: 'left-right', ...DOUBLE_SIDED_DEFAULTS }, true)
  await step()
})
afterEach(() => { vi.useRealTimers() })

describe('a double-sided job', () => {
  it('puts a marked dowel-holes path on the pins the moment it is made', () => {
    const holes = byId(ds().dowelPathId!)
    expect(holes.registration).toBe('dowel')
    const [small, big] = pinCentres(ds(), stock)
    const b = box(holes)
    expect(b.minY).toBeCloseTo(small.y - small.diaMM / 2, 6)
    expect(b.maxY).toBeCloseTo(big.y + big.diaMM / 2, 6)
  })

  it('moves the dowel holes with the pins, and one undo puts the setting and the holes back', async () => {
    const before = byId(ds().dowelPathId!).d
    applyDoubleSided({ ...ds(), pin1MM: 40 })
    await step()
    expect(byId(ds().dowelPathId!).d).not.toBe(before)
    await undo()
    expect(ds().pin1MM).toBe(DOUBLE_SIDED_DEFAULTS.pin1MM)
    expect(byId(ds().dowelPathId!).d).toBe(before)
  })

  it("carries side B's parts to the new back sheet when the flip changes — still the same face of the same part", async () => {
    usePathsStore.setState({ paths: [...paths(), sideBPart] })
    await step()
    // Where the part is on the BOARD: its image on side A, which a change of flip must keep.
    const onA = otherSideBox('left-right', stock, box(byId('b')))!
    changeFlip(ds(), 'top-bottom')
    await step()
    expect(ds().flip).toBe('top-bottom')
    close(otherSideBox('top-bottom', stock, box(byId('b')))!, onA)
    // Side A's parts never move.
    close(box(byId('a')), { minX: 20, maxX: 80, minY: 30, maxY: 60 })
  })

  it('moves the dowel holes onto the new flip axis in the same undo step as the flip', async () => {
    usePathsStore.setState({ paths: [...paths(), sideBPart] })
    await step()
    const holesBefore = byId(ds().dowelPathId!).d, partBefore = byId('b').d
    changeFlip(ds(), 'top-bottom')
    await step()
    const b = box(byId(ds().dowelPathId!))
    expect((b.minY + b.maxY) / 2).toBeCloseTo(stock.heightMM / 2, 6)
    await undo()
    expect(ds().flip).toBe('left-right')
    expect(byId(ds().dowelPathId!).d).toBe(holesBefore)
    expect(byId('b').d).toBe(partBefore)
  })

  it('made single-sided, loses its dowel holes — and any stray dowel holes — but keeps every part', async () => {
    usePathsStore.setState({ paths: [...paths(), sideBPart, { id: 'stray', name: 'Dowel Holes', d: 'M 1 1 L 2 2', visible: true, color: '#000', registration: 'dowel' }] })
    await step()
    makeSingleSided(ds())
    await step()
    expect(useWorkpieceStore.getState().doubleSided).toBeNull()
    expect(paths().map((p) => p.id).sort()).toEqual(['a', 'b'])
  })
})
