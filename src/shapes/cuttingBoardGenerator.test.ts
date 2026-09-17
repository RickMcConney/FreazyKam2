import { describe, it, expect } from 'vitest'
import {
  generateCuttingBoardD, type CuttingBoardSpec, type BoardShape, type BoardHandle,
} from './cuttingBoardGenerator'
import { generateShapeD } from './shapeGenerators'
import { flattenPath, signedArea } from '../cam/pathFlattener'
import { pointInPolygon, ptSegDistSq } from '../cam/geom'

const base: CuttingBoardSpec = {
  x: 0, y: 0, w: 350, h: 250, shape: 'rect', corner: 25,
  handle: 'paddle', handleW: 60, handleL: 110, handleInset: 22,
  hole: true, holeDia: 22, groove: true, grooveInset: 20,
}

const SHAPES: BoardShape[] = ['rect', 'oval', 'barrel']
const HANDLES: BoardHandle[] = ['none', 'paddle', 'grips', 'slot']

function subpaths(p: CuttingBoardSpec) {
  return flattenPath(generateCuttingBoardD(p), 0.1)
}

function clampTo(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)) }

function minDistToRing(px: number, py: number, ring: number[][]): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    best = Math.min(best, ptSegDistSq(px, py, ring[j][0], ring[j][1], ring[i][0], ring[i][1]))
  return Math.sqrt(best)
}

describe('generateCuttingBoardD', () => {
  it('leaves real material around every inner feature, on every body', () => {
    // The groove, the slot and the hanging hole all have to sit inside the
    // outline with wood left round them. A feature that breaches the outline or
    // the groove is invisible on screen and only shows up in the workpiece.
    for (const shape of SHAPES) {
      for (const handle of HANDLES) {
        const polys = subpaths({ ...base, shape, handle })
        const outer = polys[0]
        expect(polys.length, `${shape}/${handle}`).toBeGreaterThan(1)
        for (let i = 1; i < polys.length; i++) {
          for (const [px, py] of polys[i]) {
            expect(pointInPolygon(px, py, outer), `${shape}/${handle} subpath ${i} escapes`).toBe(true)
            // 2.9 rather than the generator's 3 mm clearance: the paths are
            // compared after flattening, which moves a point by up to the
            // 0.1 mm tolerance at each end.
            expect(minDistToRing(px, py, outer), `${shape}/${handle} subpath ${i} too close`).toBeGreaterThan(2.9)
          }
        }
      }
    }
  })

  it('holds the groove a constant inset from the edge it follows', () => {
    // The point of a true offset over a scaled copy: the router runs at one
    // depth from the edge the whole way round, including on a curve.
    for (const shape of SHAPES) {
      const polys = subpaths({ ...base, shape, handle: 'none', hole: false })
      expect(polys.length).toBe(2)
      const [outer, groove] = polys
      for (const [px, py] of groove) {
        expect(minDistToRing(px, py, outer), shape).toBeGreaterThan(base.grooveInset - 1)
        expect(minDistToRing(px, py, outer), shape).toBeLessThan(base.grooveInset + 1)
      }
    }
  })

  it('hand slots stand off the board edge, and keep the groove off themselves', () => {
    // The rail outboard of a slot is what you grip, so the gap is a real
    // dimension; and the groove has to stay out of the end strip the slot sits
    // in, or it drains straight through the board.
    for (const handle of ['grips', 'slot'] as BoardHandle[]) {
      const p = { ...base, handle, handleW: 110, handleL: 26, handleInset: 22 }
      const polys = subpaths(p)
      const [outer, groove, ...slots] = polys
      expect(slots.length, handle).toBe(handle === 'grips' ? 2 : 1)
      for (const slot of slots) {
        // The gap is what the user asked for (the slot may be slid further in
        // to fit, never further out).
        expect(Math.min(...slot.map((q) => minDistToRing(q[0], q[1], outer))), handle)
          .toBeGreaterThan(p.handleInset - 1)
        for (const [px, py] of slot) {
          expect(pointInPolygon(px, py, outer), handle).toBe(true)
          expect(minDistToRing(px, py, groove), handle).toBeGreaterThan(2.9)
        }
      }
    }
  })

  it('never hands the groove a corner the bit cannot turn', () => {
    // Cutting the slot end strips out of the field squares off the groove's
    // corners; a core box bit cannot produce a sharp inside corner, so they are
    // opened out first. Measured as the sharpest turn along the flattened path.
    const sharpestTurn = (ring: number[][]) => {
      let worst = 0
      for (let i = 0; i < ring.length; i++) {
        const a = ring[(i - 1 + ring.length) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length]
        const u = Math.hypot(b[0] - a[0], b[1] - a[1]), v = Math.hypot(c[0] - b[0], c[1] - b[1])
        if (u < 1e-9 || v < 1e-9) continue
        const dot = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (u * v)
        worst = Math.max(worst, Math.acos(clampTo(dot, -1, 1)))
      }
      return worst
    }
    for (const handle of ['grips', 'slot'] as BoardHandle[]) {
      const groove = subpaths({ ...base, handle, handleW: 110, handleL: 26 })[1]
      // 45° — a flattened 10 mm arc turns a few degrees per segment; a squared
      // corner turns 90° in one step.
      expect((sharpestTurn(groove) * 180) / Math.PI, handle).toBeLessThan(45)
    }
  })

  it('a wider edge gap pushes the slots further in', () => {
    const near = subpaths({ ...base, handle: 'grips', handleW: 110, handleL: 26, handleInset: 15 })[2]
    const far = subpaths({ ...base, handle: 'grips', handleW: 110, handleL: 26, handleInset: 40 })[2]
    expect(Math.min(...far.map((q) => q[0]))).toBeGreaterThan(Math.min(...near.map((q) => q[0])) + 20)
  })

  it('a paddle does NOT pull the groove out along the neck', () => {
    // The groove rings the cutting field; the handle is not part of it.
    const withHandle = subpaths({ ...base, handle: 'paddle', hole: false })[1]
    const without = subpaths({ ...base, handle: 'none', hole: false })[1]
    const topOf = (r: number[][]) => Math.max(...r.map((q) => q[1]))
    expect(topOf(withHandle)).toBeCloseTo(topOf(without), 1)
  })

  it('winds the outline CCW and everything inside it CW', () => {
    for (const shape of SHAPES) {
      for (const handle of HANDLES) {
        const areas = subpaths({ ...base, shape, handle }).map(signedArea)
        expect(areas[0], `${shape}/${handle} outline`).toBeGreaterThan(0)
        for (let i = 1; i < areas.length; i++)
          expect(areas[i], `${shape}/${handle} subpath ${i}`).toBeLessThan(0)
      }
    }
  })

  it('the body spans w × h and only the paddle reaches past it', () => {
    // Everything stays inside the box the user dragged, and the paddle is the
    // one feature allowed to grow out of it — `shapeParamsFromDrag` subtracts
    // its length from the drag height on that basis.
    for (const shape of SHAPES) {
      for (const handle of HANDLES) {
        const tag = `${shape}/${handle}`
        const outer = subpaths({ ...base, shape, handle })[0]
        const xs = outer.map((q) => q[0]), ys = outer.map((q) => q[1])
        // The board runs along X, so the paddle comes off the RIGHT end.
        const rightX = base.x + base.w + (handle === 'paddle' ? base.handleL : 0)
        expect(Math.min(...xs), tag).toBeCloseTo(base.x, 1)
        expect(Math.max(...xs), tag).toBeCloseTo(rightX, 1)
        expect(Math.min(...ys), tag).toBeCloseTo(base.y, 1)
        expect(Math.max(...ys), tag).toBeCloseTo(base.y + base.h, 1)
      }
    }
  })

  it('a hand slot suppresses the hanging hole', () => {
    // The panel hides the checkbox there; the generator has to agree, or the
    // board gets a hole the user cannot switch off.
    for (const handle of ['slot', 'grips'] as BoardHandle[])
      expect(subpaths({ ...base, handle, hole: true }).length, handle)
        .toBe(subpaths({ ...base, handle, hole: false }).length)
  })

  it('drops a feature that cannot fit rather than emitting a broken one', () => {
    // A 100 mm slot has nowhere to go on a 60 mm board once the groove has its
    // share; omitted is visible on the canvas, breached is not.
    const tiny = subpaths({ ...base, w: 60, h: 60, corner: 5, handle: 'slot', handleW: 100, handleL: 40 })
    const outer = tiny[0]
    for (let i = 1; i < tiny.length; i++)
      for (const [px, py] of tiny[i]) expect(pointInPolygon(px, py, outer)).toBe(true)
  })

  it('survives degenerate input', () => {
    const cases: CuttingBoardSpec[] = [
      { ...base, w: 1, h: 1 },
      { ...base, corner: 1e6 },
      { ...base, grooveInset: 1e6 },
      { ...base, handleW: 1e6, handleL: 1e6 },
      { ...base, handle: 'grips', handleInset: 1e6 },
      { ...base, handle: 'grips', w: 40, h: 40 },
      { ...base, holeDia: 1e6 },
      { ...base, w: 0, h: 0, corner: 0, handleW: 0, handleL: 0, handleInset: 0, holeDia: 0, grooveInset: 0 },
    ]
    for (const p of cases) {
      const d = generateCuttingBoardD(p)
      expect(d.length, JSON.stringify(p)).toBeGreaterThan(0)
      expect(d).not.toMatch(/NaN|Infinity/)
    }
  })

  it('is reachable through generateShapeD', () => {
    expect(generateShapeD({ type: 'board', ...base })).toBe(generateCuttingBoardD(base))
  })
})
