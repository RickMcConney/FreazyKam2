import { describe, it, expect } from 'vitest'
import { computePatternInstances, patternCopies } from './patternOp'
import { getBBox, getMultiBBox } from '../canvas/selectionUtils'
import type { ImportedPath } from '../importers/svgImporter'

// A 10 × 4 mm box, standing anywhere — the gaps are measured from its edges.
const box = getMultiBBox(['M3,7 L13,7 L13,11 L3,11 Z'])

describe('a linear pattern', () => {
  it('lays copies whose boxes touch when both gaps are 0', () => {
    const inst = computePatternInstances({ type: 'linear', rows: 2, cols: 3, xGapMM: 0, yGapMM: 0 }, box)
    expect(inst.map((i) => [i.dx, i.dy])).toEqual([
      [0, 0], [10, 0], [20, 0],
      [0, -4], [10, -4], [20, -4],
    ])
  })

  // Columns step right from the right edge, rows step DOWN from the bottom edge.
  it('puts each column the X gap past the right edge, and each row the Y gap below the bottom', () => {
    const inst = computePatternInstances({ type: 'linear', rows: 2, cols: 2, xGapMM: 2, yGapMM: 3 }, box)
    expect(inst.map((i) => [i.dx, i.dy])).toEqual([[0, 0], [12, 0], [0, -7], [12, -7]])
  })

  // A pattern saved before gaps stored a centre-to-centre pitch with rows going up, and a
  // saved project's pattern has to keep meaning what it did.
  it('reads a pattern saved as a pitch the old way', () => {
    const inst = computePatternInstances({ type: 'linear', rows: 2, cols: 2, xSpacingMM: 20, ySpacingMM: 15 }, box)
    expect(inst.map((i) => [i.dx, i.dy])).toEqual([[0, 0], [20, 0], [0, 15], [20, 15]])
  })
})

const circular = (count: number, startAngleDeg: number, endAngleDeg: number, rotateItems = true) =>
  ({ type: 'circular' as const, count, radiusMM: 10, startAngleDeg, endAngleDeg, rotateItems })

describe('a circular pattern', () => {
  // The original is the 0° item, so the circle's centre is one radius to the LEFT of it,
  // and a count of 4 is the original plus three copies.
  it('counts the original as the 0° item and turns the copies about a centre one radius to its left', () => {
    const inst = computePatternInstances(circular(4, 0, 360))
    expect(inst).toHaveLength(4)
    expect([inst[0].dx, inst[0].dy, inst[0].angleDeg]).toEqual([0, 0, 0])
    expect(inst[1].dx).toBeCloseTo(-10); expect(inst[1].dy).toBeCloseTo(10)
    expect(inst[2].dx).toBeCloseTo(-20); expect(inst[2].dy).toBeCloseTo(0)
    expect(inst[3].dx).toBeCloseTo(-10); expect(inst[3].dy).toBeCloseTo(-10)
    expect(inst.map((i) => i.angleDeg)).toEqual([0, 90, 180, 270])
  })

  // The copy is the original turned rigidly about the pivot: a lopsided shape at 180°
  // comes out mirrored through the pivot, its long side pointing the other way.
  it('turns each copy rigidly about the pivot, not about its own centre', () => {
    const src: ImportedPath = { id: 's', name: 's', d: 'M15,-1 L35,-1 L35,1 L15,1 Z', visible: true, color: '#888' }
    // Centre (25, 0), radius 10 → pivot (15, 0); turned 180° about it, x 15…35 becomes −5…15.
    const [half] = patternCopies([src], computePatternInstances(circular(2, 0, 360)).slice(1))
    const b = getBBox(half.d)!
    expect(b.minX).toBeCloseTo(-5); expect(b.maxX).toBeCloseTo(15)
    expect(b.minY).toBeCloseTo(-1); expect(b.maxY).toBeCloseTo(1)
  })

  it('spreads an arc from Start to End, the last item on End', () => {
    const inst = computePatternInstances(circular(3, 0, 90))
    expect(inst.map((i) => i.angleDeg)).toEqual([0, 45, 90])
  })

  // Radius 0 puts the pivot ON the selection's centre: the copies turn in place.
  it('turns the copies in place about the selection centre at radius 0', () => {
    const inst = computePatternInstances({ ...circular(4, 0, 360), radiusMM: 0 })
    expect(inst.map((i) => [i.dx, i.dy])).toEqual([[0, 0], [0, 0], [0, 0], [0, 0]])
    expect(inst.map((i) => i.angleDeg)).toEqual([0, 90, 180, 270])
  })

  // A negative radius puts the pivot to the RIGHT: centre (25, 0), radius −10 → pivot
  // (35, 0), and turned 180° about it x 15…35 becomes 35…55.
  it('turns the copies about a pivot to the right of the shape for a negative radius', () => {
    const src: ImportedPath = { id: 's', name: 's', d: 'M15,-1 L35,-1 L35,1 L15,1 Z', visible: true, color: '#888' }
    const [half] = patternCopies([src], computePatternInstances({ ...circular(2, 0, 360), radiusMM: -10 }).slice(1))
    const b = getBBox(half.d)!
    expect(b.minX).toBeCloseTo(35); expect(b.maxX).toBeCloseTo(55)
  })

  it('only moves the copies when Rotate items is off', () => {
    const inst = computePatternInstances(circular(4, 0, 360, false))
    expect(inst.map((i) => i.angleDeg)).toEqual([0, 0, 0, 0])
    expect(inst[2].dx).toBeCloseTo(-20)
  })
})
