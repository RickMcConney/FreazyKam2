import { describe, it, expect } from 'vitest'
import { offsetGeneratedShape, offsetShapeParams, CORNER_GROWTH } from './shapeOffset'
import { applyOffset } from './offsetOp'
import { generateShapeD, type ShapeParams } from '../shapes/shapeGenerators'
import { applyPlacementD, getBBox, type TransformStep } from '../canvas/selectionUtils'
import { flattenPath } from '../cam/pathFlattener'
import { ptSegDistSq } from '../cam/geom'
import type { ImportedPath } from '../importers/svgImporter'

const shape = (p: ShapeParams, extra: Partial<ImportedPath> = {}): ImportedPath => ({
  id: 's', name: 's', visible: true, color: '#888', shapeParams: p,
  d: applyPlacementD(generateShapeD(p), extra.placement), ...extra,
})

/** The furthest any point of either outline is from the other — 0 for the same outline. */
function hausdorff(a: string, b: string): number {
  const ra = flattenPath(a, 0.01), rb = flattenPath(b, 0.01)
  const oneWay = (from: [number, number][][], to: [number, number][][]) => {
    let worst = 0
    for (const ring of from) for (const [px, py] of ring) {
      let best = Infinity
      for (const r of to) for (let k = 0; k < r.length; k++) {
        const [ax, ay] = r[k], [bx, by] = r[(k + 1) % r.length]
        best = Math.min(best, ptSegDistSq(px, py, ax, ay, bx, by))
      }
      worst = Math.max(worst, Math.sqrt(best))
    }
    return worst
  }
  return Math.max(oneWay(ra, rb), oneWay(rb, ra))
}

// What "exact" means: the same outline the ordinary miter offset gives — but as the shape,
// with parameters.
const EXACT: [string, ShapeParams][] = [
  ['rectangle', { type: 'rectangle', x: 10, y: 20, w: 60, h: 30 }],
  ['circle', { type: 'circle', cx: 5, cy: 5, radius: 12 }],
  ['hexagon', { type: 'polygon', cx: 0, cy: 0, radius: 20, sides: 6 }],
  ['pentagon', { type: 'polygon', cx: 3, cy: -4, radius: 15, sides: 5 }],
  ['star', { type: 'star', cx: 0, cy: 0, outerRadius: 30, innerRadius: 14, points: 5 }],
  ['slot', { type: 'slot', cx: 0, cy: 0, length: 50, width: 12 }],
]

describe('a generated shape offset in its parameters', () => {
  for (const [name, p] of EXACT) {
    for (const d of [3, -2]) {
      it(`gives a ${name} the exact miter offset at ${d} mm, as a ${name}`, () => {
        const r = offsetGeneratedShape(shape(p), d)
        if (r.kind !== 'exact') throw new Error(`came out ${r.kind}`)
        expect(r.shapeParams.type).toBe(p.type)
        expect(hausdorff(r.d, applyOffset(generateShapeD(p), { distanceMM: d, cornerStyle: 'miter' }))).toBeLessThan(0.05)
      })
    }
  }

  // A rounded rect's and a Sign's straight edges are exact; their corners grow at
  // (√2 − 1)·d, not the exact offset's d, which made a Sign's coves balloon. A deep inset
  // runs the radius out and leaves the corners sharp.
  for (const type of ['roundrect', 'inroundrect'] as const) {
    it(`grows a ${type}'s corners at (√2 − 1) of the offset, its edges exactly`, () => {
      const p: ShapeParams = { type, x: 0, y: 0, w: 100, h: 60, r: 10 }
      const out = offsetGeneratedShape(shape(p), 15)
      if (out.kind !== 'near') throw new Error(`came out ${out.kind}`)
      if (out.shapeParams.type !== type) throw new Error('changed type')
      expect(out.shapeParams).toMatchObject({ x: -15, y: -15, w: 130, h: 90 })
      expect(CORNER_GROWTH).toBeCloseTo(0.41421356)
      expect(out.shapeParams.r).toBeCloseTo(10 + 0.41421356 * 15)
      const inset = offsetShapeParams(p, -4)
      expect(inset).toMatchObject({ w: 92, h: 52 })
      expect(inset && 'r' in inset && inset.r).toBeCloseTo(10 - 0.41421356 * 4)
      expect(offsetShapeParams(p, -25)).toMatchObject({ r: 0 })
    })
  }

  it('grows an ellipse by the distance on both axes', () => {
    const out = offsetGeneratedShape(shape({ type: 'ellipse', cx: 0, cy: 0, rx: 30, ry: 10 }), 2)
    expect(out.kind).toBe('near')
    expect(out.kind !== 'outline' && out.kind !== 'none' && out.shapeParams).toMatchObject({ rx: 32, ry: 12 })
  })

  // No parameter of a heart offsets exactly, so it stays a heart by being scaled to the
  // mean gap — and says what gap that left.
  it('keeps a heart a heart by scaling it', () => {
    const heart: ShapeParams = { type: 'heart', cx: 0, cy: 0, curveRadius: 20, angle: 90 }
    const out = offsetGeneratedShape(shape(heart), 5)
    if (out.kind !== 'scaled') throw new Error(`came out ${out.kind}`)
    if (out.shapeParams.type !== 'heart') throw new Error('not a heart')
    expect(out.shapeParams.curveRadius).toBeGreaterThan(20)
    expect(out.shapeParams.angle).toBe(90)
    expect(out.minGapMM).toBeLessThan(5)
    expect(out.maxGapMM).toBeGreaterThan(5)
    expect(hausdorff(out.d, generateShapeD(out.shapeParams))).toBeLessThan(1e-6)
  })

  // A turned shape keeps its turn: the offset is worked out on the definition and put back
  // through the placement — and a placement that scales divides the distance by its scale.
  it('keeps a rotated or scaled placement, and offsets by the distance on the canvas', () => {
    const rect: ShapeParams = { type: 'rectangle', x: 0, y: 0, w: 40, h: 20 }
    for (const placement of [
      [{ kind: 'rotate', angle: 30, cx: 20, cy: 10 }],
      [{ kind: 'scale', sx: 2, sy: 2, ax: 0, ay: 0 }, { kind: 'rotate', angle: -50, cx: 0, cy: 0 }],
      [{ kind: 'mirror', axis: 'x', cx: 0, cy: 0 }],
    ] as TransformStep[][]) {
      const src = shape(rect, { placement })
      const out = offsetGeneratedShape(src, 4)
      if (out.kind !== 'exact') throw new Error(`came out ${out.kind}`)
      expect(hausdorff(out.d, applyOffset(src.d, { distanceMM: 4, cornerStyle: 'miter' }))).toBeLessThan(0.05)
    }
  })

  it('leaves a stretched placement, a re-cut corner and a multi-part piece to the outline offset', () => {
    const rect: ShapeParams = { type: 'rectangle', x: 0, y: 0, w: 40, h: 20 }
    expect(offsetGeneratedShape(shape(rect, { placement: [{ kind: 'skew', kx: 0.3, ky: 0, ax: 0, ay: 0 }] }), 2).kind).toBe('outline')
    expect(offsetGeneratedShape(shape(rect, { corners: { baseD: generateShapeD(rect), treatments: [] } }), 2).kind).toBe('outline')
    expect(offsetGeneratedShape(shape(rect, { shapePart: 'teeth' }), 2).kind).toBe('outline')
  })

  // Only the plain outlines are offered it; a gear or a maze is too specific for "the same
  // shape, bigger" to mean anything.
  it('offsets every other generator as an outline', () => {
    const spiro: ShapeParams = { type: 'spirograph', cx: 0, cy: 0, radius: 20, ratio: 0.3, p: 0.5 }
    expect(offsetGeneratedShape(shape(spiro), 2).kind).toBe('outline')
    const shield: ShapeParams = { type: 'shield', cx: 0, cy: 0, w: 30, h: 40 }
    expect(offsetGeneratedShape(shape(shield), 2).kind).toBe('scaled')
  })

  it('reports an inset that leaves nothing of the shape', () => {
    expect(offsetGeneratedShape(shape({ type: 'circle', cx: 0, cy: 0, radius: 5 }), -5).kind).toBe('none')
    expect(offsetGeneratedShape(shape({ type: 'rectangle', x: 0, y: 0, w: 40, h: 8 }), -4).kind).toBe('none')
  })
})

// Sanity on the harness itself: a miter offset of a 40×20 box is a 48×28 box.
it('the miter outline offset of a box is the box grown by the distance', () => {
  const b = getBBox(applyOffset('M0,0 L40,0 L40,20 L0,20 Z', { distanceMM: 4, cornerStyle: 'miter' }))!
  expect([b.width, b.height]).toEqual([48, 28])
})
