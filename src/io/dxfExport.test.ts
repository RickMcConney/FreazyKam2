import { describe, it, expect } from 'vitest'
import { pathsToDxf, dToPolylines, CURVE_TOL_MM } from './dxfExport'
import { importDxf } from '../importers/dxfImporter'
import type { ImportedPath } from '../importers/svgImporter'
import { flattenPath } from '../cam/pathFlattener'

const path = (d: string): ImportedPath => ({ id: 'p', name: 'p', visible: true, color: '#3b82f6', d })

const pts = (d: string) => flattenPath(d, 0.001).flat()

/** Distance from (x, y) to the segment a–b. */
function segDist(x: number, y: number, [ax, ay]: number[], [bx, by]: number[]): number {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(ax + t * dx - x, ay + t * dy - y)
}

/** Every point of `a` lies within `tol` of the polyline `b` — shape equality that does
 *  not care how finely either side was flattened. */
function near(a: [number, number][], b: [number, number][], tol: number) {
  for (const [x, y] of a) {
    let best = Infinity
    for (let i = 1; i < b.length; i++) best = Math.min(best, segDist(x, y, b[i - 1], b[i]))
    expect(best).toBeLessThan(tol)
  }
}

/** Export, then read back through the app's own DXF importer. */
function roundTrip(...ds: string[]) {
  const res = importDxf(pathsToDxf(ds.map(path)), 'g')
  expect(res.error).toBeUndefined()
  return res
}

describe('DXF export', () => {
  it('declares millimetres, so the importer does not ask for units', () => {
    const dxf = pathsToDxf([path('M0,0 L10,0 L10,10 Z')])
    expect(dxf).toMatch(/\$INSUNITS\n70\n4\n/)
    expect(roundTrip('M0,0 L10,0 L10,10 Z').needsUnitsPrompt).toBe(false)
  })

  it('writes CNC coordinates as they are — DXF is Y-up, so nothing is flipped or moved', () => {
    const d = 'M120,40 L180,40 L180,90 L120,90 Z'
    const { paths } = roundTrip(d)
    expect(paths).toHaveLength(1)
    const back = pts(paths[0].d)
    near(back, pts(d), 1e-6)
    near(pts(d), back, 1e-6)
  })

  it('writes a closed subpath as a closed polyline with no duplicate end vertex', () => {
    const [poly] = dToPolylines('M0,0 L10,0 L10,10 L0,0 Z')
    expect(poly.closed).toBe(true)
    expect(poly.verts).toHaveLength(3)
  })

  it('keeps an open path open', () => {
    const [poly] = dToPolylines('M0,0 L10,0 L10,10')
    expect(poly.closed).toBe(false)
    expect(roundTrip('M0,0 L10,0 L10,10').paths[0].d).not.toMatch(/Z/)
  })

  it('writes each subpath as its own polyline', () => {
    expect(dToPolylines('M0,0 L10,0 L10,10 Z M2,2 L4,2 L4,4 Z')).toHaveLength(2)
  })

  // The arc is carried EXACTLY — as a bulge, not as a run of chords.
  it('writes a circular arc as one bulged segment, CCW positive', () => {
    const [ccw] = dToPolylines('M10,0 A10,10,0,0,1,0,10')
    expect(ccw.verts).toHaveLength(2)
    expect(ccw.verts[0].bulge).toBeCloseTo(Math.tan(Math.PI / 8), 12)   // quarter turn CCW
    const [cw] = dToPolylines('M10,0 A10,10,0,0,0,0,10')
    expect(cw.verts[0].bulge).toBeCloseTo(-Math.tan(Math.PI / 8), 12)
    const [big] = dToPolylines('M10,0 A10,10,0,1,1,0,10')                // the other three quarters
    expect(big.verts[0].bulge).toBeCloseTo(Math.tan((3 * Math.PI / 2) / 4), 12)
  })

  it('round-trips arcs, both directions and both large-arc flags, onto the same circle', () => {
    for (const d of [
      'M10,0 A10,10,0,0,1,0,10',
      'M10,0 A10,10,0,0,0,0,10',
      'M10,0 A10,10,0,1,1,0,10',
      'M10,0 A10,10,0,1,0,0,10',
    ]) {
      const back = pts(roundTrip(d).paths[0].d)
      near(back, pts(d), 1e-4)
      near(pts(d), back, 1e-4)
    }
  })

  it('round-trips a full circle drawn as two half arcs', () => {
    const d = 'M30,20 A10,10,0,0,1,10,20 A10,10,0,0,1,30,20 Z'
    const [poly] = dToPolylines(d)
    expect(poly.closed).toBe(true)
    expect(poly.verts).toHaveLength(2)
    const back = pts(roundTrip(d).paths[0].d)
    near(back, pts(d), 1e-4)
    near(pts(d), back, 1e-4)
  })

  it('keeps a closing arc — the bulge on the last vertex is the closing segment', () => {
    // A D shape: straight up the left, arc back down to the start.
    const d = 'M0,0 L0,20 A10,10,0,0,1,0,0 Z'
    const back = pts(roundTrip(d).paths[0].d)
    near(back, pts(d), 1e-4)
    near(pts(d), back, 1e-4)
  })

  it('flattens a bézier to within the curve tolerance', () => {
    const d = 'M10,10 C20,40 60,40 70,10'
    const [poly] = dToPolylines(d)
    expect(poly.verts.length).toBeGreaterThan(4)
    expect(poly.verts.every((v) => v.bulge === 0)).toBe(true)
    const back = pts(roundTrip(d).paths[0].d)
    near(pts(d), back, CURVE_TOL_MM * 1.5)
  })

  it('flattens an elliptical arc rather than writing it as a circle', () => {
    const d = 'M20,0 A20,10,0,0,1,0,10'
    const [poly] = dToPolylines(d)
    expect(poly.verts.length).toBeGreaterThan(2)
    near(pts(d), pts(roundTrip(d).paths[0].d), CURVE_TOL_MM * 1.5)
  })

  it('writes nothing for a lone moveto', () => {
    expect(dToPolylines('M5,5')).toHaveLength(0)
  })
})
