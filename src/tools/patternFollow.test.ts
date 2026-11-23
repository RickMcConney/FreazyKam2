import { describe, it, expect } from 'vitest'
import type { ImportedPath } from '../importers/svgImporter'
import { generateShapeD } from '../shapes/shapeGenerators'
import { getBBox, getMultiBBox, translateD } from '../canvas/selectionUtils'
import { computePatternInstances, patternCopies, type PatternParams } from './patternOp'
import { followPatternSources } from './patternFollow'

function circle(id: string, cx: number, cy: number, radius = 3): ImportedPath {
  const shapeParams = { type: 'circle' as const, cx, cy, radius }
  return { id, name: id, visible: true, color: '#000', d: generateShapeD(shapeParams), shapeParams }
}
function pattern(sources: ImportedPath[], params: PatternParams, defId = 'def1'): ImportedPath[] {
  const copies = patternCopies(sources, computePatternInstances(params, getMultiBBox(sources.map((s) => s.d))).slice(1))
  const definition = { id: defId, kind: 'pattern' as const, sourceIds: sources.map((s) => s.id), params }
  return copies.map((c, i) => ({ ...c, id: `${defId}-c${i + 1}`, definition }) as ImportedPath)
}
const RING: PatternParams = { type: 'circular', count: 6, radiusMM: 30, startAngleDeg: 0, endAngleDeg: 360, rotateItems: false }
const sizeOf = (p: ImportedPath) => getBBox(p.d)!.width
const centreOf = (p: ImportedPath) => { const b = getBBox(p.d)!; return [+b.cx.toFixed(4), +b.cy.toFixed(4)] }

describe('a pattern follows its source', () => {
  const src = circle('h0', 80, 40)
  const before = [src, ...pattern([src], RING)]

  it('resizes every copy when the original hole is resized, each where it was', () => {
    const big = circle('h0', 80, 40, 5)
    const after = [big, ...before.slice(1)]
    const r = followPatternSources(before, after, ['h0'])
    expect(r.refreshedIds).toEqual(before.slice(1).map((p) => p.id))
    for (const [i, p] of r.paths.slice(1).entries()) {
      expect(sizeOf(p)).toBeCloseTo(10, 6)
      expect(centreOf(p)).toEqual(centreOf(before[i + 1]))
      // The copy is still the shape it was copied from, so its Properties still edit it.
      expect(p.shapeParams).toMatchObject({ type: 'circle', radius: 5 })
      expect(p.definition).toBe(before[i + 1].definition)
    }
  })

  it('leaves the copies alone when the original is only moved', () => {
    const moved = { ...src, d: translateD(src.d, 7, 3) }
    const r = followPatternSources(before, [moved, ...before.slice(1)], ['h0'])
    expect(r.refreshedIds).toEqual([])
    expect(r.paths.slice(1)).toEqual(before.slice(1))
  })

  it('leaves the copies alone when the same edit writes them too', () => {
    // The Pattern form's own re-run, or a drag of the whole pattern.
    const big = circle('h0', 80, 40, 5)
    const r = followPatternSources(before, [big, ...before.slice(1)], ['h0', 'def1-c1'])
    expect(r.refreshedIds).toEqual([])
  })

  it('does not re-run a pattern that has lost a copy, and says so', () => {
    const big = circle('h0', 80, 40, 5)
    const gappy = before.filter((p) => p.id !== 'def1-c2')
    const r = followPatternSources(gappy, [big, ...gappy.slice(1)], ['h0'])
    expect(r.refreshedIds).toEqual([])
    expect(r.skipped).toEqual(['def1'])
  })

  it('carries a resize on through a pattern made from another pattern’s copy', () => {
    const grid = pattern([before[1]], { type: 'linear', rows: 1, cols: 3, xGapMM: 4, yGapMM: 0 }, 'def2')
    const doc = [...before, ...grid]
    const big = circle('h0', 80, 40, 5)
    const r = followPatternSources(doc, [big, ...doc.slice(1)], ['h0'])
    for (const p of r.paths.filter((q) => q.definition?.id === 'def2')) expect(sizeOf(p)).toBeCloseTo(10, 6)
  })

  it('rebuilds a pattern made of the WHOLE first pattern from the first one’s new copies', () => {
    // A grid of the bolt circle, original and copies together — what selecting the
    // circle's chip and patterning it makes. Both read the original, and the grid
    // used to be rebuilt in the same round as the circle, from its OLD copies.
    const grid = pattern(before, { type: 'linear', rows: 1, cols: 2, xGapMM: 10, yGapMM: 0 }, 'def2')
    const doc = [...before, ...grid]
    const big = circle('h0', 80, 40, 5)
    const r = followPatternSources(doc, [big, ...doc.slice(1)], ['h0'])
    const second = r.paths.filter((q) => q.definition?.id === 'def2')
    expect(second).toHaveLength(6)   // the 6 holes of the circle, once more
    for (const p of second) expect(sizeOf(p)).toBeCloseTo(10, 6)
    // …and each is still where a grid of the REBUILT circle puts it.
    const expected = pattern(r.paths.slice(0, 6), { type: 'linear', rows: 1, cols: 2, xGapMM: 10, yGapMM: 0 }, 'def2')
    expect(second.map((p) => p.d)).toEqual(expected.map((p) => p.d))
  })

  it('rebuilds them in order even when the second pattern’s copies sit FIRST in the drawing', () => {
    // Drawing order is z-order, which the user rearranges; it says nothing about
    // which pattern is built on which.
    const grid = pattern(before, { type: 'linear', rows: 1, cols: 2, xGapMM: 10, yGapMM: 0 }, 'def2')
    const doc = [before[0], ...grid, ...before.slice(1)]
    const big = circle('h0', 80, 40, 5)
    const r = followPatternSources(doc, [big, ...doc.slice(1)], ['h0'])
    const circleNow = r.paths.filter((q) => q.id === 'h0' || q.definition?.id === 'def1')
    const expected = pattern(circleNow, { type: 'linear', rows: 1, cols: 2, xGapMM: 10, yGapMM: 0 }, 'def2')
    expect(r.paths.filter((q) => q.definition?.id === 'def2').map((p) => p.d)).toEqual(expected.map((p) => p.d))
  })

  it('carries a pattern built on another along when that one is re-run from its form', () => {
    // The circle's radius changed in the Pattern form: its copies MOVE (and the
    // edit wrote them, with a new definition); the grid made from one of them follows.
    const grid = pattern([before[1]], { type: 'linear', rows: 1, cols: 2, xGapMM: 4, yGapMM: 0 }, 'def2')
    const doc = [...before, ...grid]
    const wider = pattern([src], { ...RING, radiusMM: 40 } as PatternParams)
    const after = [src, ...wider, ...grid]
    const r = followPatternSources(doc, after, wider.map((p) => p.id))
    const g = r.paths.find((q) => q.definition?.id === 'def2')!
    const from = r.paths.find((q) => q.id === 'def1-c1')!
    expect(getBBox(g.d)!.minX - getBBox(from.d)!.maxX).toBeCloseTo(4, 6)
  })

  it('leaves a pattern built on another alone when that one is only dragged', () => {
    const grid = pattern([before[1]], { type: 'linear', rows: 1, cols: 2, xGapMM: 4, yGapMM: 0 }, 'def2')
    const doc = [...before, ...grid]
    const dragged = before.map((p) => ({ ...p, d: translateD(p.d, 20, 0) }))
    const r = followPatternSources(doc, [...dragged, ...grid], dragged.map((p) => p.id))
    expect(r.refreshedIds).toEqual([])
  })

  it('touches nothing in a document with no patterns', () => {
    const lone = [circle('a', 0, 0)]
    const after = [circle('a', 0, 0, 9)]
    const r = followPatternSources(lone, after, ['a'])
    expect(r.paths).toBe(after)
    expect(r.refreshedIds).toEqual([])
  })
})
