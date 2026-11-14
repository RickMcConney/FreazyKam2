import { describe, it, expect } from 'vitest'
import { edgeSkew } from './edgeSkew'

const none = (d: number) => d
const grid = (step: number) => (d: number) => Math.round(d / step) * step

// A 40 × 20 selection, bottom-left at the origin. Top handle sits mid-top, its anchor mid-bottom.
const top = { anchor: { x: 20, y: 0 }, handle: { x: 20, y: 20 } }
const bottom = { anchor: { x: 20, y: 20 }, handle: { x: 20, y: 0 } }
const left = { anchor: { x: 40, y: 10 }, handle: { x: 0, y: 10 } }

describe('edge-handle skew', () => {
  it('shears by the distance dragged along the edge, over the handle-to-anchor distance', () => {
    // 5 mm sideways on a 20 mm tall box: the top edge moves 5, so kx = 5 / 20.
    const k = edgeSkew('t', top.anchor, top.handle, { x: 20, y: 20 }, { x: 25, y: 20 }, none)
    expect(k.kx).toBeCloseTo(0.25, 12)
    expect(k.ky).toBe(0)
  })

  it('moves the dragged edge by exactly the pointer movement, for either side of the box', () => {
    for (const h of [top, bottom]) {
      const { kx } = edgeSkew(h === top ? 't' : 'b', h.anchor, h.handle, h.handle, { x: h.handle.x + 7, y: h.handle.y }, none)
      // x' − x at the handle's height is kx · (handle.y − anchor.y).
      expect(kx * (h.handle.y - h.anchor.y)).toBeCloseTo(7, 12)
    }
  })

  it('shears a left or right handle along Y and leaves X alone', () => {
    const k = edgeSkew('l', left.anchor, left.handle, left.handle, { x: 0, y: 14 }, none)
    expect(k.kx).toBe(0)
    expect(k.ky * (left.handle.x - left.anchor.x)).toBeCloseTo(4, 12)
  })

  it('ignores movement across the edge — that is the scale this gesture replaces', () => {
    const k = edgeSkew('t', top.anchor, top.handle, top.handle, { x: 20, y: 90 }, none)
    expect(k.kx).toBe(0)
  })

  it('puts the pointer back at the press and gets NO shear, even on a grid it does not sit on', () => {
    // The press is off-grid (a sheared box's handle is at its bbox middle). Snapping the pointer's
    // POSITION would round it to a grid line and leave a residual; snapping the movement cannot.
    const press = { x: 23.37, y: 20 }
    const k = edgeSkew('t', top.anchor, top.handle, press, press, grid(1))
    expect(k.kx).toBe(0)
  })

  it('snaps the shear to whole grid steps, so a later drag can cancel it exactly', () => {
    const press = { x: 23.37, y: 20 }
    const out = edgeSkew('t', top.anchor, top.handle, press, { x: 23.37 + 6.4, y: 20 }, grid(1))
    expect(out.kx * 20).toBeCloseTo(6, 12)
    const back = edgeSkew('t', top.anchor, top.handle, press, { x: 23.37 - 6.4, y: 20 }, grid(1))
    expect(out.kx + back.kx).toBeCloseTo(0, 12)
  })

  it('a degenerate box (no height) shears nothing rather than dividing by zero', () => {
    const k = edgeSkew('t', { x: 0, y: 5 }, { x: 0, y: 5 }, { x: 0, y: 5 }, { x: 9, y: 5 }, none)
    expect(k.kx).toBe(0)
  })
})
