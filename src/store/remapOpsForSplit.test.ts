import { describe, it, expect } from 'vitest'
import { remapOpsForSplit } from './toolpathStore'
import type { AnyOperation } from './toolpathStore'

const base = {
  id: 'op1', name: 'Op', toolId: 't1', status: 'done' as const,
  segments: [{}] as never, color: '#fff', visible: true,
}
const SUBS = ['s1', 's2', 's3']

const profile = (over: Partial<AnyOperation> = {}) =>
  ({ ...base, type: 'profile', pathId: 'gear', side: 'outside', depthMM: 6,
     stepDownMM: 2, direction: 'climb', rampIn: false, ...over }) as AnyOperation

describe('remapOpsForSplit', () => {
  it('leaves operations that never referenced the path alone', () => {
    const other = profile({ id: 'other', pathId: 'elsewhere' })
    const { ops, changed } = remapOpsForSplit([other], 'gear', SUBS)
    expect(changed).toBe(false)
    expect(ops).toEqual([other])
  })

  it('swaps an island reference for all the sub-paths, segments intact', () => {
    // The combined island geometry is unchanged, so the toolpath is identical.
    const pocket = { ...base, type: 'pocket', pathId: 'plate', islandIds: ['gear', 'other'],
      depthMM: 5, stepDownMM: 2, stepoverPercent: 40, passAngleDeg: 0,
      direction: 'climb', strategy: 'raster', rampIn: false } as AnyOperation
    const { ops, changed } = remapOpsForSplit([pocket], 'gear', SUBS)
    expect(changed).toBe(true)
    expect(ops).toHaveLength(1)
    expect((ops[0] as { islandIds: string[] }).islandIds).toEqual([...SUBS, 'other'])
    expect(ops[0].segments).toEqual(base.segments)
    expect(ops[0].status).toBe('done')
  })

  it('DROPS a source operation — it must never be cloned onto the sub-paths', () => {
    // Cloning looks like the obvious repair for the lost work and is wrong: a
    // profile of a compound path treats it as ONE region, so `outside` cuts
    // round the outer boundary only. Cloned onto every sub-path, the bore and
    // the spokes get cut on their outside too and the tool takes the spokes
    // off. Losing an operation the user can see is gone beats silently
    // machining something else; one undo restores it.
    for (const op of [profile(), profile({ type: 'trochoidal' })]) {
      const { ops, changed } = remapOpsForSplit([op], 'gear', SUBS)
      expect(changed).toBe(true)
      expect(ops).toHaveLength(0)
    }
  })

  it('keeps the rest of the program in order around a dropped op', () => {
    const before = profile({ id: 'a', pathId: 'other' })
    const after = profile({ id: 'c', pathId: 'another' })
    const { ops } = remapOpsForSplit([before, profile({ id: 'b' }), after], 'gear', SUBS)
    expect(ops.map((o) => o.id)).toEqual(['a', 'c'])
  })
})
