import { describe, it, expect } from 'vitest'
import { base64ToArrayBuffer, decodeStlMesh, parseStlGeometry } from './stlImporter'

/**
 * A binary STL of `tris` triangles, as the base64 an imported path carries. Each record
 * is a normal and three vertices (12 float32) plus a 2-byte attribute; the vertex values
 * vary with `seed` so two models are different files.
 */
function binaryStl(tris: number, seed = 0): string {
  const buf = new ArrayBuffer(84 + 50 * tris)
  const dv = new DataView(buf)
  dv.setUint32(80, tris, true)
  for (let t = 0; t < tris; t++) {
    const o = 84 + 50 * t
    for (let k = 0; k < 12; k++) dv.setFloat32(o + 4 * k, ((t * 7 + k * 3 + seed) % 17) - 8, true)
  }
  return Buffer.from(buf).toString('base64')
}

describe('decodeStlMesh — one decode per model, shared by every consumer', () => {
  it('yields exactly the vertices a direct parse of the file gives', () => {
    const src = binaryStl(40)
    const mesh = decodeStlMesh(src)
    const geo = parseStlGeometry(base64ToArrayBuffer(src))
    expect(Array.from(mesh.positions)).toEqual(Array.from(geo.attributes.position.array))
    expect(mesh.indices === null).toBe(geo.index === null)
    geo.dispose()
  })

  it('hands every consumer the same decoded model rather than decoding it again', () => {
    const src = binaryStl(10, 1)
    expect(decodeStlMesh(src)).toBe(decodeStlMesh(src))
  })

  it('keeps only the two most recent models, so a deleted one is not held for the session', () => {
    const a = binaryStl(5, 2), b = binaryStl(5, 3), c = binaryStl(5, 4)
    const first = decodeStlMesh(a)
    decodeStlMesh(b)
    expect(decodeStlMesh(a)).toBe(first)   // a refreshed to most recent
    decodeStlMesh(c)                        // evicts b, not a
    expect(decodeStlMesh(a)).toBe(first)
    decodeStlMesh(b)                        // b decoded again — evicts c
    decodeStlMesh(c)                        // evicts a
    expect(decodeStlMesh(a)).not.toBe(first)
  })
})
