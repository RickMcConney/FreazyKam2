import { describe, it, expect } from 'vitest'
import { buildVertexIndex, collectSnapTargets, pathVertices, snapVertexDelta } from './objectSnap'
import { resolveMoveSnap } from './gestureMath'
import { generateShapeD } from '../shapes/shapeGenerators'
import { getBBox } from './selectionUtils'

const hex = (cx: number, cy: number) => generateShapeD({ type: 'polygon', cx, cy, radius: 10, sides: 6 })
const noGrid = (p: { x: number; y: number }) => p

describe('pathVertices — a path\'s corners are its segment end points', () => {
  it('a hexagon has six corners, the closing point not counted twice', () => {
    expect(pathVertices(hex(0, 0))).toHaveLength(6)
  })
  it('a square drawn back to its start has four', () => {
    expect(pathVertices('M0 0 L10 0 L10 10 L0 10 L0 0 Z')).toHaveLength(4)
  })
})

describe('snapVertexDelta — a moving corner within tolerance lands exactly on a target corner', () => {
  const index = buildVertexIndex([{ x: 10, y: 10 }, { x: 50, y: 50 }], 5)
  it('the nearest corner pair wins and lands exactly', () => {
    const r = snapVertexDelta([{ x: 0, y: 0 }], 9.6, 10.3, index, 1)
    expect(r).toEqual({ dx: 10, dy: 10, point: { x: 10, y: 10 } })
  })
  it('nothing within tolerance is no snap', () => {
    expect(snapVertexDelta([{ x: 0, y: 0 }], 8, 8, index, 1)).toBeNull()
  })
  it('a tolerance wider than a cell still finds a corner several cells away', () => {
    expect(snapVertexDelta([{ x: 0, y: 0 }], 2, 10, index, 9)?.point).toEqual({ x: 10, y: 10 })
  })
})

describe('resolveMoveSnap — two hexagons go edge to edge, as a honeycomb needs', () => {
  // Hexagon A stands at the origin; B is dragged from the origin to near where it
  // shares A's edge between corners 0 and 1 — the reflection of A's centre in that
  // edge, which is twice the edge's midpoint. No bounding-box line passes there.
  const a = hex(0, 0)
  const [c0, c1] = pathVertices(a)
  const want = { x: c0.x + c1.x, y: c0.y + c1.y }
  const targets = { ...collectSnapTargets([{ d: a }], { widthMM: 1000, heightMM: 1000 }), moving: pathVertices(hex(0, 0)) }
  const ib = getBBox(hex(0, 0))!

  it('dragged close to the edge-sharing spot, B lands on it exactly', () => {
    const r = resolveMoveSnap(ib, want.x + 0.4, want.y - 0.3, targets, 1, true, noGrid)
    expect(r.dx).toBeCloseTo(want.x, 9)
    expect(r.dy).toBeCloseTo(want.y, 9)
    expect(r.guides?.point).toBeDefined()
  })
  it('with snap off it stays where it was dragged', () => {
    const r = resolveMoveSnap(ib, want.x + 0.4, want.y - 0.3, targets, 1, false, noGrid)
    expect(r.dx).toBeCloseTo(want.x + 0.4, 9)
  })
  it('without its own corners it falls back to box alignment, which cannot reach the spot', () => {
    const { moving: _m, ...boxOnly } = targets
    const r = resolveMoveSnap(ib, want.x + 0.4, want.y - 0.3, boxOnly, 1, true, noGrid)
    expect(Math.hypot(r.dx - want.x, r.dy - want.y)).toBeGreaterThan(0.1)
  })
})
