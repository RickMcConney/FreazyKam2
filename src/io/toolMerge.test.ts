import { describe, it, expect } from 'vitest'
import { mergeProjectTools, sameCut } from './toolMerge'
import type { Tool } from '../store/toolStore'
import type { AnyOperation } from '../store/toolpathStore'

const tool = (id: string, over: Partial<Tool> = {}): Tool => ({
  id, name: id, type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000,
  xyFeedMmMin: 2000, zFeedMmMin: 500, maxDepthMM: 20, ...over,
})
const op = (id: string, over: Record<string, unknown>): AnyOperation =>
  ({ id, type: 'pocket', segments: [], ...over } as unknown as AnyOperation)

describe('mergeProjectTools — opening a project never replaces the library', () => {
  it('keeps every library tool, and adds only the file tools its operations cut with', () => {
    const lib = [tool('mine')]
    const r = mergeProjectTools(lib, [tool('used'), tool('unused')], [op('o', { toolId: 'used' })])
    expect(r.tools.map((t) => t.id)).toEqual(['mine', 'used'])
    expect([r.added, r.renamed]).toEqual([1, 0])
  })

  it('uses the library copy of a tool with the same id and cut — its name and feeds are the user\'s', () => {
    const lib = [tool('t', { name: 'My 1/4', xyFeedMmMin: 1800 })]
    const ops = [op('o', { toolId: 't' })]
    const r = mergeProjectTools(lib, [tool('t', { name: 'Their 1/4', xyFeedMmMin: 3000 })], ops)
    expect(r.tools).toBe(lib)
    expect(r.operations).toBe(ops)
    expect(r.added).toBe(0)
  })

  it('adds a same-id tool with a DIFFERENT cut under a new id and points every tool field at it', () => {
    // Cutting with the library's 1/4" where the file meant its 1/8" would machine every
    // one of those toolpaths with the wrong bit.
    const lib = [tool('t')]
    const ops = [
      op('p', { toolId: 't', segments: [{ x: 0, y: 0, z: 0, rapid: true, toolChange: 't' }, { x: 1, y: 0, z: -1, rapid: false }] }),
      op('i', { type: 'inlay', toolId: 'v', vbitToolId: 'v', pocketToolId: 't' }),
      op('other', { toolId: 'v' }),
    ]
    const r = mergeProjectTools(lib, [tool('t', { diameterMM: 3.175 }), tool('v', { type: 'vbit', vbitAngleDeg: 60 })], ops)
    const newId = r.tools[1].id
    expect(newId).not.toBe('t')
    expect(r.tools.map((t) => [t.id, t.diameterMM])).toEqual([['t', 6.35], [newId, 3.175], ['v', 6.35]])
    expect([r.added, r.renamed]).toEqual([2, 1])
    const [p, i, other] = r.operations as unknown as Record<string, unknown>[]
    expect(p.toolId).toBe(newId)
    expect((p.segments as { toolChange?: string }[]).map((s) => s.toolChange)).toEqual([newId, undefined])
    expect([i.toolId, i.vbitToolId, i.pocketToolId]).toEqual(['v', 'v', newId])
    expect(other).toBe(ops[2])
  })

  it('leaves the inlay "none" finish sentinel and a tool the file does not carry alone', () => {
    const ops = [op('i', { type: 'inlay', toolId: 'gone', vbitToolId: 'none' })]
    const r = mergeProjectTools([tool('t')], [], ops)
    expect(r.operations).toBe(ops)
    expect(r.added).toBe(0)
  })
})

describe('sameCut — what a toolpath is computed from, and nothing else', () => {
  it('ignores name, flutes, rpm and feeds', () => {
    expect(sameCut(tool('a'), tool('a', { name: 'x', fluteCount: 3, rpm: 1, xyFeedMmMin: 1, zFeedMmMin: 1 }))).toBe(true)
  })
  it('differs on type or diameter', () => {
    expect(sameCut(tool('a'), tool('a', { type: 'ballnose' }))).toBe(false)
    expect(sameCut(tool('a'), tool('a', { diameterMM: 3 }))).toBe(false)
  })
  it('differs on a V-bit or taper angle, and on a taper\'s length — it sets how wide the taper opens', () => {
    expect(sameCut(tool('a', { type: 'vbit', vbitAngleDeg: 60 }), tool('a', { type: 'vbit', vbitAngleDeg: 90 }))).toBe(false)
    const taper = (over: Partial<Tool>) => tool('a', { type: 'taper', diameterMM: 1, vbitAngleDeg: 5, ...over })
    expect(sameCut(taper({}), taper({ maxDepthMM: 25 }))).toBe(false)
    expect(sameCut(tool('a'), tool('a', { maxDepthMM: 25 }))).toBe(true)
  })
})
