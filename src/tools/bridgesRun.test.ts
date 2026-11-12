import { describe, it, expect, vi } from 'vitest'
import { holdableParts, applyBridges, addStrip, moveStrip } from './bridgesRun'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolpathStore } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import type { AnyOperation } from '../store/toolpathStore'
import type { ImportedPath } from '../store/pathsStore'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))

const op = (o: Record<string, unknown>) => ({ type: 'profile', toolId: 't', ...o }) as unknown as AnyOperation
const rect = (x: number, y: number, w: number, h: number) => `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
const circle = (cx: number, cy: number, r: number) =>
  `M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} Z`
const path = (id: string, d: string): ImportedPath => ({ id, name: id, d, color: '#000', visible: true } as ImportedPath)

// A sheet as a drag box catches it: a part with a label stroke and a hole in it, a shallow
// engraved outline, a part cut by Optimize Path, and a part nobody has profiled yet.
const part = path('part', rect(0, 0, 100, 60))
const label = path('label', 'M 10 30 L 40 30')
const hole = path('hole', circle(70, 30, 10))
const groove = path('groove', rect(150, 0, 40, 40))
const sheetPart = path('sheetPart', rect(0, 100, 80, 50))
const unprofiled = path('unprofiled', rect(150, 100, 60, 40))
const ops = [
  op({ side: 'outside', pathId: 'part', depthMM: 18 }),
  op({ side: 'centerline', pathId: 'label', depthMM: 1 }),
  op({ side: 'inside', pathId: 'hole', depthMM: 18 }),
  op({ side: 'outside', pathId: 'groove', depthMM: 1.5 }),
  op({ side: 'outside', pathId: 'x', pathIds: ['sheetPart'], sharedLines: true, depthMM: 18 }),
  op({ type: 'drill', pathId: 'hole', depthMM: 18 }),
]
const ids = (ps: ImportedPath[]) => ps.map((p) => p.id)

describe('holdableParts — strips join the PARTS, not what a drag box caught with them', () => {
  // The reported sheet: every outline, label stroke and hole selected, and every stroke and
  // hole given joins out to its own part's edge — dozens of tabs on a part that needed two.
  it('leaves out labels, holes and outlines only engraved shallower than the stock', () => {
    expect(ids(holdableParts([part, label, hole, groove, sheetPart], ops, 18, 2))).toEqual(['part', 'sheetPart'])
  })

  // Strips may be placed BEFORE the profiles, as tabs can: they only take effect on a cut
  // through the stock, decided when that cut is generated.
  it('joins a part outline nobody has profiled yet — read off the geometry, not the cuts', () => {
    expect(ids(holdableParts([part, label, hole, unprofiled], [], 18, 2))).toEqual(['part', 'unprofiled'])
  })

  it('joins a part cut to an onion skin — deep enough to reach the strips\' top', () => {
    const skin = [op({ side: 'outside', pathId: 'part', depthMM: 17.9 }), op({ side: 'outside', pathId: 'groove', depthMM: 15.9 })]
    // 0.1 mm of skin reaches a 2 mm strip's top; 2.1 mm of it does not, so that one is engraved.
    expect(ids(holdableParts([part, groove], skin, 18, 2))).toEqual(['part'])
  })

  it('still joins a part cut through the stock that sits in another part\'s hole', () => {
    const disc = path('disc', circle(70, 30, 5))
    const cut = [...ops, op({ side: 'outside', pathId: 'disc', depthMM: 18 })]
    expect(ids(holdableParts([part, hole, disc], cut, 18, 2))).toEqual(['part', 'disc'])
  })
})

describe('applying strips again over hand-placed ones', () => {
  const A = path('A', rect(10, 10, 60, 60)), B = path('B', rect(76, 10, 60, 60))
  const reset = () => {
    usePathsStore.setState({ paths: [A, B], selectedIds: [] })
    useToolpathStore.setState({ operations: [] })
    useWorkpieceStore.setState({ widthMM: 200, heightMM: 100, thicknessMM: 18, bridges: null })
  }
  const lines = () => useWorkpieceStore.getState().bridges!.lines
  const HAND = { x1: 69, y1: 22, x2: 77, y2: 22 }

  it('keeps a strip placed by a click exactly where it was put', () => {
    reset()
    addStrip(HAND, 'A', 'B', 5, 2)
    applyBridges([A, B], 6, 3, 2)
    expect(lines()).toContainEqual({ ...HAND, manual: true })
    // The width and height are the set's, so they follow the form; the network is laid as well.
    expect(useWorkpieceStore.getState().bridges).toMatchObject({ widthMM: 6, heightMM: 3 })
    expect(lines().length).toBeGreaterThan(1)
  })

  it('keeps a strip the user dragged, and replaces the ones the network laid', () => {
    reset()
    applyBridges([A, B], 5, 2, 2)
    const laid = lines()
    moveStrip(0, HAND)
    applyBridges([A, B], 5, 2, 2)
    expect(lines().filter((l) => l.manual)).toEqual([{ ...HAND, manual: true }])
    // Laid again from scratch: the same network as the first time, none of it doubled.
    expect(lines().filter((l) => !l.manual).length).toBeLessThanOrEqual(laid.length)
  })

  it('lays no network strip on top of a hand-placed one', () => {
    reset()
    applyBridges([A, B], 5, 2, 2)
    const first = lines()[0]
    reset()
    addStrip(first, 'A', 'B', 5, 2)
    applyBridges([A, B], 5, 2, 2)
    const same = lines().filter((l) => Math.hypot((l.x1 + l.x2 - first.x1 - first.x2) / 2, (l.y1 + l.y2 - first.y1 - first.y2) / 2) < 5)
    expect(same).toHaveLength(1)
    expect(same[0].manual).toBe(true)
  })
})
