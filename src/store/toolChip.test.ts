import { describe, it, expect } from 'vitest'
import { chipLoadFromFeeds, withRatedChip, DEFAULT_TOOLS, type Tool } from './toolStore'
import { mergeProjectTools } from '../io/toolMerge'
import type { AnyOperation } from './toolpathStore'

// A tool's RATED chip load is fixed once it has one; these are the ways it is filled in
// where there is none — always from the tool's own numbers, never kept in step with them.

const tool = (over: Partial<Tool> = {}): Tool => ({
  id: 't', name: 'T', type: 'endmill', diameterMM: 6.35, fluteCount: 2,
  rpm: 19000, xyFeedMmMin: 1778, zFeedMmMin: 762, maxDepthMM: 25.4, ...over,
})

describe('filling in a chip rating', () => {
  it('is the tool\'s feed over its rpm times its flutes', () => {
    expect(chipLoadFromFeeds(tool())).toBeCloseTo(1778 / (19000 * 2), 5)
  })

  it('gives a drill, and a tool with no feed or speed, none', () => {
    expect(chipLoadFromFeeds(tool({ type: 'drill' }))).toBeUndefined()
    expect(chipLoadFromFeeds(tool({ xyFeedMmMin: 0 }))).toBeUndefined()
    expect(chipLoadFromFeeds(tool({ rpm: 0 }))).toBeUndefined()
  })

  it('never replaces a rating the tool already has', () => {
    expect(withRatedChip(tool({ chipLoadMM: 0.01 })).chipLoadMM).toBe(0.01)
  })

  it('takes over the maker\'s figure an earlier build stored, rather than recomputing', () => {
    const old = { ...tool(), makerChipLoadMM: 0.02 } as Tool
    const r = withRatedChip(old)
    expect(r.chipLoadMM).toBe(0.02)
    expect('makerChipLoadMM' in r).toBe(false)
  })

  it('rates every factory tool but the drill from its own numbers', () => {
    for (const t of DEFAULT_TOOLS) {
      if (t.type === 'drill') expect(t.chipLoadMM).toBeUndefined()
      else expect(t.chipLoadMM).toBeCloseTo(t.xyFeedMmMin / (t.rpm * t.fluteCount), 5)
    }
  })

  it('rates a tool a project brings in that carries none', () => {
    const op = { id: 'o', type: 'profile', toolId: 'p1' } as unknown as AnyOperation
    const r = mergeProjectTools([], [tool({ id: 'p1' })], [op])
    expect(r.tools[0].chipLoadMM).toBeCloseTo(1778 / 38000, 5)
  })
})
