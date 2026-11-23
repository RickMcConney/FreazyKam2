import { describe, it, expect } from 'vitest'
import type { ImportedPath } from '../importers/svgImporter'
import { generateShapeD, type ShapeParams } from '../shapes/shapeGenerators'
import { applyPlacementD, getBBox, translateD } from '../canvas/selectionUtils'
import { followDuplicates as follow, linkedOriginalOf, linkedCopiesOf, linkHighlights, rigidSteps } from './duplicateFollow'
import { transformPathBy } from '../store/pathsStore'

/** The store's own gesture transform — what derive hands the follow in the app. */
const followDuplicates = (b: ImportedPath[], a: ImportedPath[], e: string[]) => follow(b, a, e, transformPathBy)
import { applyCornerTreatments, type CornerTreatmentType } from './cornerTreatment'

function shape(id: string, params: ShapeParams, extra: Partial<ImportedPath> = {}): ImportedPath {
  const d = applyPlacementD(generateShapeD(params), extra.placement)
  return { id, name: id, visible: true, color: '#000', d, shapeParams: params, ...extra }
}
const dupOf = (sourceId: string, extra: Partial<ImportedPath['definition'] & object> = {}) =>
  ({ definition: { id: 'dd', kind: 'duplicate' as const, sourceId, offsetMM: 5, ...extra } }) as Partial<ImportedPath>
const circle = (id: string, cx: number, cy: number, radius: number, extra: Partial<ImportedPath> = {}) =>
  shape(id, { type: 'circle', cx, cy, radius }, extra)
const box = (id: string, x: number, y: number, w: number, h: number, extra: Partial<ImportedPath> = {}) =>
  shape(id, { type: 'rectangle', x, y, w, h }, extra)
const at = (paths: ImportedPath[], id: string) => paths.find((p) => p.id === id)!
/** Two outlines the same to the 0.001 mm the d strings can hold. */
const close = (a: string, b: string) => {
  const na = (a.match(/-?\d+\.?\d*/g) ?? []).map(Number), nb = (b.match(/-?\d+\.?\d*/g) ?? []).map(Number)
  return na.length === nb.length && na.every((v, i) => Math.abs(v - nb[i]) < 1e-3)
}

describe('a duplicate follows its original’s shape', () => {
  it('takes the original’s new size, and stays where it was placed', () => {
    const before = [circle('o', 10, 10, 3), circle('c', 60, 20, 3, dupOf('o'))]
    const after = [circle('o', 10, 10, 5), before[1]]
    const r = followDuplicates(before, after, ['o'])
    expect(r.refreshedIds).toEqual(['c'])
    expect(at(r.paths, 'c').shapeParams).toEqual({ type: 'circle', cx: 60, cy: 20, radius: 5 })
    expect(at(r.paths, 'c').d).toBe(generateShapeD({ type: 'circle', cx: 60, cy: 20, radius: 5 }))
  })

  it('keeps a copy’s own turn: the new shape is drawn through ITS placement', () => {
    const turn = [{ kind: 'rotate' as const, cx: 80, cy: 15, angle: 30 }]
    const before = [box('o', 0, 0, 20, 10), box('c', 70, 10, 20, 10, { ...dupOf('o'), placement: turn })]
    // Linked although turned: the turn is in the placement, not the shape.
    expect(linkedOriginalOf(before, before[1])?.id).toBe('o')
    const after = [box('o', 0, 0, 30, 10), before[1]]
    const r = followDuplicates(before, after, ['o'])
    expect(close(at(r.paths, 'c').d, applyPlacementD(generateShapeD({ type: 'rectangle', x: 70, y: 10, w: 30, h: 10 }), turn))).toBe(true)
    // …and still turned in its RECIPE, so its Properties still read the angle.
    expect(at(r.paths, 'c').placement?.length).toBeGreaterThan(0)
  })

  it('moves nothing when the original is only moved or turned', () => {
    const before = [circle('o', 10, 10, 3), circle('c', 60, 20, 3, dupOf('o'))]
    const moved = [circle('o', 30, 40, 3), before[1]]
    expect(followDuplicates(before, moved, ['o']).refreshedIds).toEqual([])
    const turned = [box('o', 0, 0, 20, 10, { placement: [{ kind: 'rotate', cx: 10, cy: 5, angle: 45 }] }), box('c', 50, 0, 20, 10, dupOf('o'))]
    const flat = [box('o', 0, 0, 20, 10), turned[1]]
    expect(followDuplicates(flat, turned, ['o']).refreshedIds).toEqual([])
  })

  it('keeps a MIRRORED copy mirrored', () => {
    // An L-shape (so a mirror is visible), its copy flipped left-to-right and moved.
    const L = (id: string, s: number, extra: Partial<ImportedPath> = {}): ImportedPath =>
      ({ id, name: id, visible: true, color: '#000', d: `M 0 0 L ${20 * s} 0 L ${20 * s} ${5 * s} L ${5 * s} ${5 * s} L ${5 * s} ${15 * s} L 0 ${15 * s} Z`, ...extra })
    const flip = (d: string) => translateD(d.replace(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g, (_m, x, y) => `${-x} ${y}`), 100, 0)
    const before = [L('o', 1), { ...L('c', 1, dupOf('o')), d: flip(L('x', 1).d) }]
    const r = followDuplicates(before, [L('o', 2), before[1]], ['o'])
    expect(r.refreshedIds).toEqual(['c'])
    expect(close(at(r.paths, 'c').d, flip(L('x', 2).d))).toBe(true)
  })

  it('carries a change on through a copy of a copy', () => {
    const before = [circle('o', 10, 10, 3), circle('c1', 60, 20, 3, dupOf('o')), circle('c2', 90, 20, 3, dupOf('c1'))]
    const r = followDuplicates(before, [circle('o', 10, 10, 4), before[1], before[2]], ['o'])
    expect(r.refreshedIds).toEqual(['c1', 'c2'])
    expect(at(r.paths, 'c2').shapeParams).toMatchObject({ radius: 4, cx: 90 })
  })

  it('follows a plain outline while the copy is the original shifted', () => {
    const tri = (dx: number, s = 1) => translateD(`M 0 0 L ${10 * s} 0 L 0 ${10 * s} Z`, dx, 0)
    const plain = (id: string, d: string, extra: Partial<ImportedPath> = {}): ImportedPath =>
      ({ id, name: id, visible: true, color: '#000', d, ...extra })
    const before = [plain('o', tri(0)), plain('c', tri(50), dupOf('o'))]
    const r = followDuplicates(before, [plain('o', tri(0, 2)), before[1]], ['o'])
    expect(getBBox(at(r.paths, 'c').d)).toMatchObject({ minX: 50, width: 20, height: 20 })
  })
})

describe('when a duplicate stops following', () => {
  it('is unlinked when the user reshapes the copy itself, and then ignores the original', () => {
    const before = [circle('o', 10, 10, 3), circle('c', 60, 20, 3, dupOf('o'))]
    const r = followDuplicates(before, [before[0], circle('c', 60, 20, 8, dupOf('o'))], ['c'])
    expect(r.unlinkedIds).toEqual(['c'])
    expect(at(r.paths, 'c').copyOf).toMatchObject({ sourceId: 'o', unlinked: true })
    // Even set back to the same size, it stays its own.
    const later = [r.paths[0], { ...circle('c', 60, 20, 3), definition: at(r.paths, 'c').definition, copyOf: at(r.paths, 'c').copyOf }]
    const r2 = followDuplicates(later, [circle('o', 10, 10, 6), later[1]], ['o'])
    expect(r2.refreshedIds).toEqual([])
  })

  it('stays linked when the copy is only moved or turned', () => {
    const before = [circle('o', 10, 10, 3), box('b', 0, 0, 4, 2), circle('c', 60, 20, 3, dupOf('o'))]
    const r = followDuplicates(before, [before[0], before[1], circle('c', 80, 50, 3, dupOf('o'))], ['c'])
    expect(r.unlinkedIds).toEqual([])
    const tb = box('t', 50, 0, 4, 2, dupOf('b'))
    const turned = { ...tb, placement: [{ kind: 'rotate' as const, cx: 52, cy: 1, angle: 90 }] }
    const r2 = followDuplicates([before[1], tb], [before[1], { ...turned, d: applyPlacementD(tb.d, turned.placement) }], ['t'])
    expect(r2.unlinkedIds).toEqual([])
  })

  it('writes nothing to a copy that already differed when it is only moved', () => {
    // An old project's copy, edited long ago: a drag is not a reshape, so it must
    // not come back marked (and regenerated) as though it were.
    const before = [circle('o', 10, 10, 3), circle('c', 60, 20, 7, dupOf('o'))]
    const r = followDuplicates(before, [before[0], circle('c', 70, 25, 7, dupOf('o'))], ['c'])
    expect(r.unlinkedIds).toEqual([])
  })

  it('stays linked when the copy and the original are resized together', () => {
    const before = [circle('o', 10, 10, 3), circle('c', 60, 20, 3, dupOf('o'))]
    const r = followDuplicates(before, [circle('o', 10, 10, 5), circle('c', 60, 20, 5, dupOf('o'))], ['o', 'c'])
    expect(r.unlinkedIds).toEqual([])
  })

  it('never reshapes a copy that already differed (an old project) or was unlinked', () => {
    const before = [circle('o', 10, 10, 3), circle('c', 60, 20, 7, dupOf('o')), circle('u', 90, 20, 3, dupOf('o', { unlinked: true }))]
    const r = followDuplicates(before, [circle('o', 10, 10, 4), before[1], before[2]], ['o'])
    expect(r.refreshedIds).toEqual([])
    expect(at(r.paths, 'c')).toBe(before[1])
    expect(at(r.paths, 'u')).toBe(before[2])
    expect(linkedOriginalOf(before, before[1])).toBeNull()
    expect(linkedOriginalOf(before, before[2])).toBeNull()
  })

  it('finds the motion between two outlines, and refuses a different size', () => {
    const a = box('a', 0, 0, 20, 10).d
    expect(rigidSteps(a, translateD(a, 7, -3))).toEqual([{ kind: 'translate', dx: 7, dy: -3 }])
    expect(rigidSteps(a, box('b', 0, 0, 20.5, 10).d)).toBeNull()
  })
})

/** The numbers of a path, so two spellings of one outline compare equal. */
const nums = (d: string) => (d.match(/-?\d+\.?\d*/g) ?? []).map((n) => Math.round(+n * 1e4) / 1e4)

describe('a duplicate of a corner-treated shape', () => {
  // A treated rectangle is a plain outline plus its recipe: the untreated outline and
  // what was done to each corner (applying the treatment dropped its parameters).
  const rectD = (x: number, y: number, w: number, h: number) => generateShapeD({ type: 'rectangle', x, y, w, h })
  const treated = (id: string, x: number, w: number, r: number, type: CornerTreatmentType = 'outerRound', extra: Partial<ImportedPath> = {}): ImportedPath => {
    const baseD = rectD(x, 0, w, 10)
    const treatments: [number, { type: CornerTreatmentType; radiusMM: number }][] = [0, 1, 2, 3].map((i) => [i, { type, radiusMM: r }])
    return { id, name: id, visible: true, color: '#000', d: applyCornerTreatments(baseD, new Map(treatments)), corners: { baseD, treatments }, ...extra }
  }

  it('takes a new corner radius, re-cut where the copy stands', () => {
    const before = [treated('o', 0, 20, 2), treated('c', 50, 20, 2, 'outerRound', dupOf('o'))]
    expect(linkedOriginalOf(before, before[1])?.id).toBe('o')
    const r = followDuplicates(before, [treated('o', 0, 20, 4), before[1]], ['o'])
    expect(r.refreshedIds).toEqual(['c'])
    const want = treated('c', 50, 20, 4)
    expect(nums(at(r.paths, 'c').d)).toEqual(nums(want.d))
    // The recipe moved with it, so reopening Corners on the copy re-cuts it in place.
    expect(at(r.paths, 'c').corners).toEqual(want.corners)
  })

  it('takes a change of treatment, and a new size', () => {
    const before = [treated('o', 0, 20, 2), treated('c', 50, 20, 2, 'outerRound', dupOf('o'))]
    const r = followDuplicates(before, [treated('o', 0, 30, 2, 'chamfer'), before[1]], ['o'])
    expect(nums(at(r.paths, 'c').d)).toEqual(nums(treated('c', 50, 30, 2, 'chamfer').d))
  })

  it('gains corners when the plain rectangle it was copied from is given them', () => {
    const before = [box('o', 0, 0, 20, 10), box('c', 50, 0, 20, 10, dupOf('o'))]
    const r = followDuplicates(before, [treated('o', 0, 20, 3), before[1]], ['o'])
    const c = at(r.paths, 'c')
    expect(nums(c.d)).toEqual(nums(treated('c', 50, 20, 3).d))
    expect(c.shapeParams).toBeUndefined()
    expect(linkedOriginalOf(r.paths, c)?.id).toBe('o')
  })

  it('is unlinked when the copy’s own corners are changed', () => {
    const before = [treated('o', 0, 20, 2), treated('c', 50, 20, 2, 'outerRound', dupOf('o'))]
    const r = followDuplicates(before, [before[0], treated('c', 50, 20, 5, 'outerRound', dupOf('o'))], ['c'])
    expect(r.unlinkedIds).toEqual(['c'])
  })

  it('gives a TURNED copy the corners too, turned with it', () => {
    // The case a per-representation follow could not do: the copy is a rotated
    // parametric rectangle, the original becomes a plain outline with a corner recipe.
    const turn = [{ kind: 'rotate' as const, cx: 60, cy: 5, angle: 30 }]
    const before = [box('o', 0, 0, 20, 10), box('c', 50, 0, 20, 10, { ...dupOf('o'), placement: turn })]
    const r = followDuplicates(before, [treated('o', 0, 20, 3), before[1]], ['o'])
    const c = at(r.paths, 'c')
    expect(c.corners?.treatments).toEqual(treated('o', 0, 20, 3).corners!.treatments)
    expect(close(c.d, applyPlacementD(treated('x', 50, 20, 3).d, turn))).toBe(true)
    expect(linkedOriginalOf(r.paths, c)?.id).toBe('o')
  })
})

describe('what the canvas shows a selection is tied to', () => {
  // o ← c1 ← c2 (a copy of a copy), o ← c3 unlinked, o ← c4 reshaped long ago.
  const doc = [
    circle('o', 10, 10, 3),
    circle('c1', 40, 10, 3, dupOf('o')),
    circle('c2', 70, 10, 3, dupOf('c1')),
    circle('c3', 100, 10, 3, dupOf('o', { unlinked: true })),
    circle('c4', 130, 10, 7, dupOf('o')),
    circle('x', 160, 10, 3),
  ]

  it('shows an original every copy a change to it would reshape, down the whole chain', () => {
    expect(linkHighlights(doc, ['o'])).toEqual({ originals: [], copies: ['c1', 'c2'] })
  })

  it('leaves out copies that will not change: unlinked, or no longer the same shape', () => {
    expect(linkedCopiesOf(doc, 'o').map((p) => p.id)).toEqual(['c1'])
  })

  it('shows a copy the shape it follows, and the copies that follow IT', () => {
    expect(linkHighlights(doc, ['c1'])).toEqual({ originals: ['o'], copies: ['c2'] })
  })

  it('does not mark a selected copy as a follower of a selected original', () => {
    expect(linkHighlights(doc, ['o', 'c1'])).toEqual({ originals: ['o'], copies: ['c2'] })
  })

  it('shows nothing for a shape that is tied to nothing', () => {
    expect(linkHighlights(doc, ['x'])).toEqual({ originals: [], copies: [] })
    expect(linkHighlights(doc, ['c4'])).toEqual({ originals: [], copies: [] })
  })
})
