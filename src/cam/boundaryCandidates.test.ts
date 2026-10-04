import { describe, it, expect } from 'vitest'
import { enclosingBoundaries } from './boundaryCandidates'
import type { ImportedPath } from '../store/pathsStore'

const p = (id: string, d: string, extra: Partial<ImportedPath> = {}): ImportedPath => ({ id, name: id, d, visible: true, color: '#fff', ...extra })
const rect = (x0: number, y0: number, x1: number, y1: number) => `M${x0},${y0} L${x1},${y0} L${x1},${y1} L${x0},${y1} Z`
// The model's box: 20..40 × 20..40.
const stl = p('stl', rect(20, 20, 40, 40), { stlSrc: 'x' })
const ids = (paths: ImportedPath[]) => enclosingBoundaries([stl, ...paths], stl).map((q) => q.id)

describe('the boundaries offered for a 3D Profile', () => {
  it('offers a closed shape that completely encloses the model', () => {
    expect(ids([p('around', rect(10, 10, 50, 50))])).toEqual(['around'])
  })

  it('does not offer one that only overlaps the model, or sits beside it', () => {
    expect(ids([p('overlap', rect(30, 10, 60, 50)), p('beside', rect(50, 0, 70, 20))])).toEqual([])
  })

  it('does not offer a concave shape whose notch bites into the model, though it surrounds the box\'s corners', () => {
    // A C round the box: all four corners inside, the middle of the right side not.
    const C = 'M10,10 L50,10 L50,28 L30,28 L30,32 L50,32 L50,50 L10,50 Z'
    expect(ids([p('C', C)])).toEqual([])
  })

  it('does not offer a ring whose hole is over the model', () => {
    const ring = rect(0, 0, 60, 60) + ' ' + rect(25, 25, 35, 35)
    expect(ids([p('ring', ring)])).toEqual([])
  })

  it('does not offer a shape with a straight slot right across the model, though no point of it is inside', () => {
    // The slot enters on the left and its end is past the right side: every corner of the
    // box is inside the shape, and every vertex of the shape is outside the box.
    const slot = 'M10,10 L50,10 L50,50 L10,50 L10,31 L45,31 L45,29 L10,29 Z'
    expect(ids([p('slot', slot)])).toEqual([])
  })

  it('does not offer an open path, however it is placed', () => {
    expect(ids([p('U', 'M10,50 L10,10 L50,10 L50,50')])).toEqual([])
  })

  it('offers the three that fit most closely, tightest first, when there are more', () => {
    const shapes = [
      p('wide', rect(0, 0, 80, 80)), p('tight', rect(18, 18, 42, 42)),
      p('mid', rect(10, 10, 50, 50)), p('loose', rect(5, 5, 55, 55)),
    ]
    expect(ids(shapes)).toEqual(['tight', 'mid', 'loose'])
  })

  it('never offers the model itself, another STL or an image', () => {
    expect(ids([p('stl2', rect(0, 0, 60, 60), { stlSrc: 'y' }), p('img', rect(0, 0, 60, 60), { imageSrc: 'z' })])).toEqual([])
  })
})
