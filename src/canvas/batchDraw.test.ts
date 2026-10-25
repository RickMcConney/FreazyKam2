import { describe, it, expect, beforeAll } from 'vitest'
import { Transform } from 'konva/lib/Util'
import type Konva from 'konva'
import { makeBatch, visiblePath, drawFrame, strokeBatches, runBox, overlaps, type BatchItem, type Box } from './batchDraw'

// Node has no Path2D. This one records what is drawn into it, which is the thing the culling
// decides: `parts` names every member a path was built from, so a test can say exactly which
// outlines a frame would stroke.
class FakePath2D {
  parts: string[] = []
  constructor(public label = '') { if (label) this.parts.push(label) }
  addPath(p: FakePath2D) { this.parts.push(...p.parts) }
  moveTo() {}
  lineTo() {}
  arc() {}
  closePath() {}
}
beforeAll(() => { (globalThis as { Path2D?: unknown }).Path2D = FakePath2D })

function item(label: string, minX: number, minY: number, maxX: number, maxY: number): BatchItem {
  return { path: new FakePath2D(label) as unknown as Path2D, minX, minY, maxX, maxY }
}
const parts = (p: Path2D | null) => (p as unknown as FakePath2D | null)?.parts ?? null

// Three parts in a row along X, 10 mm square, 40 mm apart.
const row = () => makeBatch([item('a', 0, 0, 10, 10), item('b', 40, 0, 50, 10), item('c', 80, 0, 90, 10)])

describe('a batch', () => {
  it('spans the union of its members\' boxes', () => {
    const b = row()
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([0, 0, 90, 10])
  })

  it('holds every member in its combined path, in order', () => {
    expect(parts(row().all)).toEqual(['a', 'b', 'c'])
  })
})

describe('what a frame strokes (visiblePath)', () => {
  it('is the cached combined path itself when the whole batch is in view', () => {
    const b = row()
    expect(visiblePath(b, { minX: -5, minY: -5, maxX: 95, maxY: 15 })).toBe(b.all)
  })

  it('is only the members the view overlaps when zoomed in on part of the batch', () => {
    const b = row()
    const p = visiblePath(b, { minX: 30, minY: -5, maxX: 60, maxY: 15 })
    expect(p).not.toBe(b.all)
    expect(parts(p)).toEqual(['b'])
  })

  it('keeps a member that only pokes into the view', () => {
    // The view's left edge is inside part b, and its right edge stops short of part c.
    expect(parts(visiblePath(row(), { minX: 45, minY: -5, maxX: 79, maxY: 15 }))).toEqual(['b'])
  })

  it('keeps a member whose box only touches the view\'s edge', () => {
    expect(parts(visiblePath(row(), { minX: 50, minY: -5, maxX: 70, maxY: 15 }))).toEqual(['b'])
  })

  it('drops a member that is out of view on Y alone', () => {
    const b = makeBatch([item('low', 0, 0, 10, 10), item('high', 0, 100, 10, 110)])
    expect(parts(visiblePath(b, { minX: -5, minY: 95, maxX: 15, maxY: 120 }))).toEqual(['high'])
  })

  it('is nothing when the view lies between the members', () => {
    expect(visiblePath(row(), { minX: 15, minY: -5, maxX: 35, maxY: 15 })).toBeNull()
  })

  it('is nothing when the view is off the batch entirely', () => {
    expect(visiblePath(row(), { minX: 200, minY: 200, maxX: 300, maxY: 300 })).toBeNull()
  })

  it('is nothing for an empty batch, whatever the view', () => {
    expect(visiblePath(makeBatch([]), { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 })).toBeNull()
  })
})

describe('overlaps', () => {
  const a: Box = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
  it('is true for boxes that share only an edge', () => {
    expect(overlaps(a, { minX: 10, minY: 0, maxX: 20, maxY: 10 })).toBe(true)
  })
  it('is false for boxes apart on X or on Y', () => {
    expect(overlaps(a, { minX: 11, minY: 0, maxX: 20, maxY: 10 })).toBe(false)
    expect(overlaps(a, { minX: 0, minY: 11, maxX: 10, maxY: 20 })).toBe(false)
  })
})

describe('runBox', () => {
  it('bounds a flat [x, y, …] run', () => {
    expect(runBox([3, -1, -2, 4, 5, 0])).toEqual({ minX: -2, minY: -1, maxX: 5, maxY: 4 })
  })
})

// A shape inside the CNC layer: the layer is Y-flipped (scaleY = -scale) with CNC (0, 0) at
// screen (vp.x, vp.y), so its absolute transform is [s, 0, 0, -s, vp.x, vp.y].
function fakeShape(m: number[], width = 800, height = 600): Konva.Shape {
  return {
    getAbsoluteTransform: () => new Transform(m),
    getStage: () => ({ width: () => width, height: () => height }),
  } as unknown as Konva.Shape
}

describe('the frame a batch is drawn in (drawFrame)', () => {
  it('maps the stage onto CNC mm through the Y-flip', () => {
    // 2 px/mm, origin at screen (100, 500): screen → CNC is x = (sx − 100) / 2, y = (500 − sy) / 2.
    const { ppu, view } = drawFrame(fakeShape([2, 0, 0, -2, 100, 500]), 0)
    expect(ppu).toBe(2)
    expect(view).toEqual({ minX: -50, minY: -50, maxX: 350, maxY: 250 })
  })

  it('widens the view by the pad, in screen pixels', () => {
    const { view } = drawFrame(fakeShape([2, 0, 0, -2, 100, 500]), 4)
    expect(view).toEqual({ minX: -52, minY: -52, maxX: 352, maxY: 252 })
  })

  it('reads pixels per mm under a non-uniform live scale as the geometric mean of the axes', () => {
    // A drag preview scaling the selection 4× in X and 1× in Y on a 2 px/mm view.
    expect(drawFrame(fakeShape([8, 0, 0, -2, 0, 0]), 0).ppu).toBeCloseTo(4)
  })

  it('reads pixels per mm unchanged under a rotation', () => {
    const c = Math.cos(0.7) * 3, s = Math.sin(0.7) * 3
    expect(drawFrame(fakeShape([c, s, s, -c, 0, 0]), 0).ppu).toBeCloseTo(3)
  })
})

// The context strokeBatches draws on, recording each stroke as it lands.
function fakeCtx() {
  const strokes: { parts: string[]; lineWidth: number; dash: number[]; color: string; alpha: number }[] = []
  const c = {
    lineWidth: 1, strokeStyle: '', globalAlpha: 1, lineJoin: 'miter', lineCap: 'butt',
    dash: [] as number[],
    save() {}, restore() { c.dash = [] },
    setLineDash(d: number[]) { c.dash = d },
    stroke(p: FakePath2D) {
      strokes.push({ parts: p.parts, lineWidth: c.lineWidth, dash: c.dash, color: c.strokeStyle, alpha: c.globalAlpha })
    },
  }
  return { ctx: { _context: c } as unknown as Konva.Context, strokes }
}

describe('stroking batches', () => {
  // 2 px/mm with CNC (0, 0) at the stage's bottom-left: the 800 × 600 stage shows 400 × 300 mm.
  const shape = fakeShape([2, 0, 0, -2, 0, 600])

  it('converts screen-pixel widths and dashes to mm at the current zoom', () => {
    const { ctx, strokes } = fakeCtx()
    strokeBatches(ctx, shape, [{ color: '#f00', widthPx: 1.5, dashPx: [5, 4], opacity: 0.75, batch: row() }])
    expect(strokes).toEqual([{ parts: ['a', 'b', 'c'], lineWidth: 0.75, dash: [2.5, 2], color: '#f00', alpha: 0.75 }])
  })

  it('skips a batch with nothing in view and strokes only what is in view of the others', () => {
    const { ctx, strokes } = fakeCtx()
    const offStage = makeBatch([item('far', 1000, 1000, 1010, 1010)])
    const straddling = makeBatch([item('in', 10, 10, 20, 20), item('out', 900, 10, 910, 20)])
    strokeBatches(ctx, shape, [
      { color: '#111', widthPx: 1, batch: offStage },
      { color: '#222', widthPx: 1, batch: straddling },
    ])
    expect(strokes.map((s) => [s.color, s.parts])).toEqual([['#222', ['in']]])
  })
})
