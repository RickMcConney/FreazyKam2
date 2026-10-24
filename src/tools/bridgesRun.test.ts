import { describe, it, expect, vi } from 'vitest'
import { freedParts } from './bridgesRun'
import type { AnyOperation } from '../store/toolpathStore'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))

const op = (o: Record<string, unknown>) => ({ type: 'profile', toolId: 't', ...o }) as unknown as AnyOperation

describe('freedParts — strips join the parts a cut sets free, not what a drag box caught with them', () => {
  // The reported sheet: every outline, label stroke and hole selected, and every stroke and
  // hole given joins out to its own part's edge — dozens of tabs on a part that needed two.
  it('takes outlines cut through the stock, and leaves labels, holes and shallow cuts out', () => {
    const paths = ['part', 'label', 'hole', 'groove', 'sheetPart'].map((id) => ({ id }))
    const ops = [
      op({ side: 'outside', pathId: 'part', depthMM: 3 }),
      op({ side: 'centerline', pathId: 'label', depthMM: 1 }),
      op({ side: 'inside', pathId: 'hole', depthMM: 3 }),
      op({ side: 'outside', pathId: 'groove', depthMM: 1.5 }),
      op({ side: 'outside', pathId: 'x', pathIds: ['sheetPart'], sharedLines: true, depthMM: 3 }),
      op({ type: 'drill', pathId: 'hole', depthMM: 3 }),
    ]
    expect(freedParts(paths, ops, 2.75).map((p) => p.id)).toEqual(['part', 'sheetPart'])
  })
})
