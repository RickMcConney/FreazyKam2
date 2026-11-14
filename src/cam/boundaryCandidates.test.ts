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

// A real STL: a disc 40 across, 10 tall, as a binary file in base64 (what `stlSrc` holds).
function discStl(R: number, depth: number, n = 96): string {
  const tris: number[][][] = []
  const at = (k: number, z: number) => [R * Math.cos(2 * Math.PI * k / n), R * Math.sin(2 * Math.PI * k / n), z]
  for (let k = 0; k < n; k++) {
    tris.push([[0, 0, 0], at(k, 0), at(k + 1, 0)])
    tris.push([at(k, -depth), at(k + 1, -depth), at(k + 1, 0)], [at(k, -depth), at(k + 1, 0), at(k, 0)])
  }
  const buf = Buffer.alloc(84 + 50 * tris.length)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => t.flat().forEach((v, j) => buf.writeFloatLE(v, 84 + 50 * i + 12 + 4 * j)))
  return buf.toString('base64')
}
const circle = (cx: number, cy: number, r: number) => `M${cx + r},${cy} A${r},${r} 0 1 1 ${cx - r},${cy} A${r},${r} 0 1 1 ${cx + r},${cy} Z`

describe('the boundaries offered round a round STL', () => {
  // The disc's box is 10..50 × 10..50; its corners stand 28.3 from the centre.
  const disc = p('disc', rect(10, 10, 50, 50), { stlSrc: discStl(20, 10), stlModelBounds: { minX: -20, maxX: 20, minY: -20, maxY: 20, minZ: -10, maxZ: 0 } })
  const offered = (paths: ImportedPath[]) => enclosingBoundaries([disc, ...paths], disc).map((q) => q.id)

  it('offers a circle round the disc, though the corners of the disc\'s box lie outside it', () => {
    expect(offered([p('round', circle(30, 30, 24))])).toEqual(['round'])
  })

  it('does not offer a circle that cuts into the disc', () => {
    expect(offered([p('tight', circle(30, 30, 18))])).toEqual([])
  })
})
