// Where a dragged or resized selection LANDS. The canvas harness (scripts/canvas-gestures.mts)
// drives these through the real mouse but never puts a part where two snaps compete or where
// the grid differs from the cursor, so the precedence rules live here.
import { describe, it, expect } from 'vitest'
import { isSlippedClick, resolveMoveSnap, resolveResizePoint, resizeScale, scaledBox, SLIP_MAX_MS, SLIP_MAX_PX } from './gestureMath'
import type { SnapTargets } from './objectSnap'

/** A 1 mm grid. */
const grid = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) })
const noGrid = (p: { x: number; y: number }) => p
const targets = (over: Partial<SnapTargets> = {}): SnapTargets => ({ xs: [], ys: [], boxes: [], ...over })
/** The dragged selection's box where the drag started: 10 × 10 at the origin. */
const ib = { minX: 0, minY: 0, maxX: 10, maxY: 10, cx: 5, cy: 5 }
const box = (x: number, w = 10) => ({ minX: x, maxX: x + w, minY: 0, maxY: 10 })

describe('resolveMoveSnap — where a dragged selection lands', () => {
  it('with snap off, nothing aligns, even an edge lying right beside a target', () => {
    const r = resolveMoveSnap(ib, 10.7, 3.4, targets({ xs: [20.5] }), 2, false, noGrid)
    expect(r).toEqual({ dx: 10.7, dy: 3.4, guides: null })
  })

  it('an edge within the tolerance of another shape\'s edge aligns to it and draws the guide there', () => {
    const r = resolveMoveSnap(ib, 10.7, 0, targets({ xs: [20.5] }), 2, true, noGrid)
    expect(r.dx).toBeCloseTo(10.5, 12)               // maxX 20.7 → 20.5
    expect(r.guides).toEqual({ x: 20.5, y: undefined })
  })

  it('the box\'s CENTRE aligns as well as its edges, and the nearest of the three wins', () => {
    const r = resolveMoveSnap(ib, 10.7, 0, targets({ xs: [15.6] }), 2, true, noGrid)
    expect(r.dx).toBeCloseTo(10.6, 12)               // centre 15.7 → 15.6
  })

  it('the grid takes only the axis that did not align, and lands the box\'s CORNER on it, not the cursor', () => {
    const off = { minX: 0.3, minY: 0.3, maxX: 10.3, maxY: 10.3, cx: 5.3, cy: 5.3 }
    const r = resolveMoveSnap(off, 10.7, 3.4, targets({ xs: [21] }), 2, true, grid)
    expect(r.dx).toBeCloseTo(10.7, 12)               // maxX 11 + … aligned to 21, grid left alone
    expect(off.minY + r.dy).toBe(4)                  // y: corner 3.7 → 4 on the grid
    expect(r.guides).toEqual({ x: 21, y: undefined })
  })

  it('an axis that aligned is not then put on the grid — on y as on x', () => {
    const r = resolveMoveSnap(ib, 0, 3.4, targets({ ys: [3.5] }), 2, true, grid)   // minY 3.4 → 3.5, not 3
    expect(r.dy).toBeCloseTo(3.5, 12)
    expect(r.guides).toEqual({ x: undefined, y: 3.5 })
  })

  it('a move only the grid touched draws no guide', () => {
    const r = resolveMoveSnap(ib, 3.4, 3.6, targets(), 2, true, grid)
    expect(r).toEqual({ dx: 3, dy: 4, guides: null })
  })

  // Two boxes 20 apart (0–10, 30–40): a third dragged after them is offered the same 20 at 60.
  const spaced = targets({ boxes: [box(0), box(30)] })
  it('equal spacing beats alignment when it is the NEARER of the two, and draws the gaps instead of the line', () => {
    const r = resolveMoveSnap(ib, 59, 0, { ...spaced, xs: [70.5] }, 2, true, noGrid)  // spacing 1 off, alignment 1.5
    expect(r.dx).toBeCloseTo(60, 12)
    expect(r.guides?.x).toBeUndefined()
    expect(r.guides?.gaps?.map((g) => g.to - g.from)).toEqual([20, 20])
  })

  it('alignment beats equal spacing when it is the nearer', () => {
    const r = resolveMoveSnap(ib, 59, 0, { ...spaced, xs: [69.5] }, 2, true, noGrid)  // alignment 0.5 off, spacing 1
    expect(r.dx).toBeCloseTo(59.5, 12)
    expect(r.guides).toEqual({ x: 69.5, y: undefined })
  })

  it('an axis that took equal spacing is not then put on the grid', () => {
    const r = resolveMoveSnap(ib, 59.4, 0, spaced, 2, true, (p) => ({ x: Math.round(p.x / 7) * 7, y: p.y }))
    expect(r.dx).toBeCloseTo(60, 12)
  })
})

describe('resolveResizePoint — where a dragged handle lands', () => {
  const t = targets({ xs: [5.5], ys: [9.8] })
  it('a top or bottom handle aligns its y only: its x is the box\'s middle and must not snap', () => {
    const r = resolveResizePoint('t', { x: 5.4, y: 10.1 }, t, 2, true, grid)
    expect(r.point).toEqual({ x: 5, y: 9.8 })
    expect(r.guides).toEqual({ x: undefined, y: 9.8 })
  })
  it('a left or right handle aligns its x only', () => {
    const r = resolveResizePoint('r', { x: 5.4, y: 10.1 }, t, 2, true, grid)
    expect(r.point).toEqual({ x: 5.5, y: 10 })
    expect(r.guides).toEqual({ x: 5.5, y: undefined })
  })
  it('a corner handle aligns both axes', () => {
    expect(resolveResizePoint('br', { x: 5.4, y: 10.1 }, t, 2, true, grid).point).toEqual({ x: 5.5, y: 9.8 })
  })
  it('with object snap off (a Shift corner drag) both axes go to the grid and nothing is drawn', () => {
    expect(resolveResizePoint('br', { x: 5.4, y: 10.1 }, t, 2, false, grid)).toEqual({ point: { x: 5, y: 10 }, guides: null })
  })
})

describe('resizeScale — the scale a handle drag asks for', () => {
  // A 10 × 10 box at the origin dragged by its bottom-right corner; the anchor is top-left.
  const anchor = { x: 0, y: 10 }, br = { x: 10, y: 0 }
  it('a corner scales each axis by the handle\'s new offset from the anchor over its old one', () => {
    expect(resizeScale('br', anchor, br, { x: 20, y: -5 }, false)).toEqual({ sx: 2, sy: 1.5 })
  })
  it('an edge handle leaves the other axis alone, Shift or not', () => {
    expect(resizeScale('r', { x: 0, y: 5 }, { x: 10, y: 5 }, { x: 20, y: 50 }, true)).toEqual({ sx: 2, sy: 1 })
    expect(resizeScale('t', { x: 5, y: 0 }, { x: 5, y: 10 }, { x: 50, y: 30 }, false)).toEqual({ sx: 1, sy: 3 })
  })
  it('Shift on a corner takes one factor from the diagonal for both axes', () => {
    const { sx, sy } = resizeScale('br', anchor, br, { x: 20, y: -5 }, true)
    expect(sx).toBeCloseTo(25 / Math.hypot(10, 10), 12)
    expect(sy).toBeCloseTo(sx, 12)
  })
  it('Shift on a corner dragged back through the anchor still mirrors that axis, and only that one', () => {
    const { sx, sy } = resizeScale('br', anchor, br, { x: -20, y: -5 }, true)
    expect(sx).toBeCloseTo(-25 / Math.hypot(10, 10), 12)
    expect(sy).toBeCloseTo(-sx, 12)
  })
  it('a handle dragged almost onto its anchor keeps a sliver of size, with its sign', () => {
    expect(resizeScale('r', { x: 0, y: 5 }, { x: 10, y: 5 }, { x: -0.0001, y: 5 }, false).sx).toBe(-0.001)
  })
  it('a handle dragged EXACTLY onto its anchor — which the grid makes easy — does not collapse the shape to nothing', () => {
    const { sx } = resizeScale('r', { x: 0, y: 5 }, { x: 10, y: 5 }, { x: 0, y: 5 }, false)
    expect(Math.abs(sx)).toBe(0.001)
  })
})

describe('scaledBox — the preview box of a scaled selection', () => {
  it('scales about the anchor, and a mirrored box is still reported min-corner first with a positive size', () => {
    expect(scaledBox({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { x: 0, y: 0 }, -1, 2))
      .toEqual({ minX: -10, minY: 0, width: 10, height: 20 })
  })
})

describe('isSlippedClick — a shape-tool click that slipped places a default shape, not a sliver', () => {
  it('a quick release a few px from the press is a click', () => {
    expect(isSlippedClick(120, 6)).toBe(true)
  })
  it('a quick flick that travels far is a drag', () => {
    expect(isSlippedClick(120, SLIP_MAX_PX + 1)).toBe(false)
  })
  it('a slow small drag is a drag', () => {
    expect(isSlippedClick(SLIP_MAX_MS + 50, 6)).toBe(false)
  })
  it('the limits themselves are a drag', () => {
    expect(isSlippedClick(SLIP_MAX_MS, 6)).toBe(false)
    expect(isSlippedClick(120, SLIP_MAX_PX)).toBe(false)
  })
})
