import { describe, it, expect } from 'vitest'
import { generateShapeD, translateShapeParams, scaleShapeParams, shapeParamsFromDrag, DEFAULT_SHAPE_CONFIG, SCALE_LOCKED_SHAPES, SQUARE_DRAG_SHAPES, fixedDragAspect, type ShapeParams, type ShapeType } from './shapeGenerators'
import { getBBox } from '../canvas/selectionUtils'
import { flattenPath, signedArea } from '../cam/pathFlattener'
import { stripClosingDuplicate } from '../cam/geom'

// Winding of the generated outline in CNC Y-up space (positive area = CCW)
function outlineArea(d: string): number {
  const polys = flattenPath(d, 0.05)
  expect(polys.length).toBeGreaterThan(0)
  return signedArea(stripClosingDuplicate(polys[0]))
}

describe('generateShapeD', () => {
  it('rectangle emits the exact CCW polygon', () => {
    const d = generateShapeD({ type: 'rectangle', x: 0, y: 0, w: 50, h: 30 })
    expect(d).toBe('M0,0 L50,0 L50,30 L0,30 Z')
  })

  it('polygon-based shapes trace CCW in CNC Y-up', () => {
    const shapes: ShapeParams[] = [
      { type: 'rectangle', x: 0, y: 0, w: 50, h: 30 },
      { type: 'roundrect', x: 0, y: 0, w: 50, h: 30, r: 5 },
      { type: 'polygon', cx: 0, cy: 0, radius: 20, sides: 6 },
      { type: 'star', cx: 0, cy: 0, outerRadius: 20, innerRadius: 8, points: 5 },
    ]
    for (const p of shapes) {
      expect(outlineArea(generateShapeD(p)), `${p.type} should be CCW`).toBeGreaterThan(0)
    }
  })

  it('circle and ellipse (sweep=0 arcs) trace CW in CNC Y-up', () => {
    // Direction is irrelevant for these downstream (CLAUDE.md), but the
    // winding the generator emits is CW — pin it so a change is deliberate.
    expect(outlineArea(generateShapeD({ type: 'circle', cx: 0, cy: 0, radius: 20 }))).toBeLessThan(0)
    expect(outlineArea(generateShapeD({ type: 'ellipse', cx: 0, cy: 0, rx: 25, ry: 15 }))).toBeLessThan(0)
  })

  it('circle bbox spans cx±r / cy±r', () => {
    const b = getBBox(generateShapeD({ type: 'circle', cx: 10, cy: 20, radius: 5 }))!
    expect(b.minX).toBeCloseTo(5, 1)
    expect(b.maxX).toBeCloseTo(15, 1)
    expect(b.minY).toBeCloseTo(15, 1)
    expect(b.maxY).toBeCloseTo(25, 1)
  })

  it('circle area matches πr² after flattening', () => {
    // flattened polygon is inscribed, so slightly under the true area
    const area = Math.abs(outlineArea(generateShapeD({ type: 'circle', cx: 0, cy: 0, radius: 10 })))
    expect(area).toBeGreaterThan(Math.PI * 100 * 0.99)
    expect(area).toBeLessThanOrEqual(Math.PI * 100)
  })

  it('polygon places the first vertex at the bottom (angle −90°)', () => {
    const d = generateShapeD({ type: 'polygon', cx: 0, cy: 0, radius: 10, sides: 6 })
    expect(d.startsWith('M0,-10')).toBe(true)
  })

  it('roundrect corner radius is clamped to half the smaller side', () => {
    // r=100 on a 50×30 rect must clamp to 15 — bbox still exactly w×h
    const b = getBBox(generateShapeD({ type: 'roundrect', x: 0, y: 0, w: 50, h: 30, r: 100 }))!
    expect(b.minX).toBeCloseTo(0, 1)
    expect(b.maxX).toBeCloseTo(50, 1)
    expect(b.minY).toBeCloseTo(0, 1)
    expect(b.maxY).toBeCloseTo(30, 1)
  })

  it('roundrect corners bulge outward (area between sharp rect and inscribed)', () => {
    const area = outlineArea(generateShapeD({ type: 'roundrect', x: 0, y: 0, w: 50, h: 30, r: 5 }))
    const sharp = 50 * 30
    const cornerLoss = (4 - Math.PI) * 5 * 5 // exact loss for 4 convex r=5 corners
    // flattening chords shave a little more off the rounded corners
    expect(area).toBeGreaterThan(sharp - cornerLoss - 2)
    expect(area).toBeLessThan(sharp - cornerLoss + 0.5)
  })
})

describe('translateShapeParams', () => {
  it('moves xy-anchored and center-anchored shapes alike', () => {
    expect(translateShapeParams({ type: 'rectangle', x: 1, y: 2, w: 5, h: 5 }, 10, -3))
      .toEqual({ type: 'rectangle', x: 11, y: -1, w: 5, h: 5 })
    expect(translateShapeParams({ type: 'circle', cx: 0, cy: 0, radius: 4 }, 2, 3))
      .toEqual({ type: 'circle', cx: 2, cy: 3, radius: 4 })
  })
})

describe('scaleShapeParams', () => {
  it('uniformly scales a circle around the anchor', () => {
    const p = scaleShapeParams({ type: 'circle', cx: 10, cy: 0, radius: 5 }, 0, 0, 2, 2)
    expect(p).toEqual({ type: 'circle', cx: 20, cy: 0, radius: 10 })
  })

  it('converts a circle to an ellipse under non-uniform scale', () => {
    const p = scaleShapeParams({ type: 'circle', cx: 0, cy: 0, radius: 5 }, 0, 0, 2, 1)
    expect(p).toEqual({ type: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5 })
  })

  it('returns null where the shape cannot represent a non-uniform scale', () => {
    expect(scaleShapeParams({ type: 'polygon', cx: 0, cy: 0, radius: 5, sides: 6 }, 0, 0, 2, 1)).toBeNull()
    expect(scaleShapeParams({ type: 'star', cx: 0, cy: 0, outerRadius: 5, innerRadius: 2, points: 5 }, 0, 0, 1, 3)).toBeNull()
  })

  it('normalizes a mirror scale so w/h stay positive and x/y stay the min corner', () => {
    const p = scaleShapeParams({ type: 'rectangle', x: 0, y: 0, w: 10, h: 5 }, 0, 0, -1, 1)
    expect(p).toEqual({ type: 'rectangle', x: -10, y: 0, w: 10, h: 5 })
  })

  it('re-clamps the roundrect radius after scaling', () => {
    const p = scaleShapeParams({ type: 'roundrect', x: 0, y: 0, w: 50, h: 30, r: 15 }, 0, 0, 1, 0.5)
    expect(p).toMatchObject({ w: 50, h: 15, r: 7.5 })
  })

  it('params scale in sync with the geometry (bbox agreement)', () => {
    const before: ShapeParams = { type: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 3 }
    const after = scaleShapeParams(before, 0, 0, 2, 2)!
    // getBBox flattens at 0.5 mm tolerance, so bounds may fall short by up to ~0.6
    const b = getBBox(generateShapeD(after))!
    expect(b.cx).toBeCloseTo(20, 0)
    expect(b.cy).toBeCloseTo(20, 0)
    expect(b.width).toBeGreaterThan(19)
    expect(b.width).toBeLessThanOrEqual(20.01)
    expect(b.height).toBeGreaterThan(11)
    expect(b.height).toBeLessThanOrEqual(12.01)
  })
})


// ── Dragging out from the centre ────────────────────────────────────────────
//
// The mode reflects the drag ORIGIN through the cursor rather than casing every
// shape, so what has to hold is that EVERY shape ends up centred on the origin
// and twice the size — including any added later, which is the whole reason for
// doing it that way.
describe('shapeParamsFromDrag from the centre', () => {
  const ORIGIN = { x: 100, y: 80 }
  const END = { x: 130, y: 100 }

  const types = (Object.keys(DEFAULT_SHAPE_CONFIG) as ShapeType[])
    .filter((t) => !SCALE_LOCKED_SHAPES.has(t) && t !== 'text')

  it('covers every draggable shape', () => {
    expect(types.length).toBeGreaterThan(8)
  })

  // Where a shape says its own centre is. Not the bounding box: a board's handle
  // reaches out past its body and a cam has a lever unioned onto it, so their
  // drawn extent is deliberately not symmetric about the point they are built
  // around. Centring on the BOX would move those two under the cursor as their
  // handle grew, which is not what "from the centre" should mean.
  const centreOf = (p: ShapeParams): { x: number; y: number } =>
    'cx' in p ? { x: p.cx, y: p.cy }
      : 'w' in p ? { x: p.x + p.w / 2, y: p.y + p.h / 2 }
      : { x: p.x, y: p.y }

  // A shape of fixed proportions grows its drag to them FIRST, so it is dragged
  // here along its own aspect — the box it is centred in is then the one END
  // spans, and the equality below says the same thing for it as for the rest.
  // (Off-aspect drags are covered by the tests after this loop.)
  const endFor = (type: ShapeType) => {
    const aspect = fixedDragAspect(type, DEFAULT_SHAPE_CONFIG)
    return aspect === null ? END : { x: END.x, y: ORIGIN.y + (END.x - ORIGIN.x) / aspect }
  }

  for (const type of types) {
    it(`centres a ${type} on the drag origin`, () => {
      const end = endFor(type)
      // The corner-to-corner drag that should produce the SAME shape: the box
      // centred on the origin with the cursor at its corner.
      const mirrored = { x: 2 * ORIGIN.x - end.x, y: 2 * ORIGIN.y - end.y }
      const centred = shapeParamsFromDrag(type, ORIGIN, end, DEFAULT_SHAPE_CONFIG, true)
      const corner = shapeParamsFromDrag(type, mirrored, end, DEFAULT_SHAPE_CONFIG, false)
      // Identical params, so identical geometry — the mode is exactly "drag the
      // box that is centred here", not an approximation of it. This is the
      // assertion that covers shapes added later for free. (The preference
      // itself is recorded on the PATH, not here — see ImportedPath.fromCenter.)
      expect(centred).toEqual(corner)

      // A cutting board's params describe its BODY, and shapeParamsFromDrag
      // takes the handle out of the drag width — so its body sits deliberately
      // offset inside the box it was dragged in, and only the box is centred.
      // The equality above is what states that for it.
      if (type === 'board') return
      const c = centreOf(centred)
      expect(c.x).toBeCloseTo(ORIGIN.x, 6)
      expect(c.y).toBeCloseTo(ORIGIN.y, 6)
    })
  }

  it('leaves corner-to-corner dragging exactly as it was', () => {
    for (const type of types) {
      expect(shapeParamsFromDrag(type, ORIGIN, END, DEFAULT_SHAPE_CONFIG, false))
        .toEqual(shapeParamsFromDrag(type, ORIGIN, END, DEFAULT_SHAPE_CONFIG))
    }
  })

  // A round shape dragged anything but a true diagonal used to shrink to the SHORT
  // side about the box's middle, and so trailed the pointer: 100 right and 20 up
  // gave a 20 mm circle whose edge sat 40 mm short of the cursor.
  it('grows a circle to the cursor along the longer side of the drag', () => {
    for (const end of [
      { x: ORIGIN.x + 100, y: ORIGIN.y + 20 },     // mostly right
      { x: ORIGIN.x - 15, y: ORIGIN.y - 60 },      // mostly down, and leftward
    ]) {
      const b = getBBox(generateShapeD(shapeParamsFromDrag('circle', ORIGIN, end, DEFAULT_SHAPE_CONFIG)))!
      const side = Math.max(Math.abs(end.x - ORIGIN.x), Math.abs(end.y - ORIGIN.y))
      expect(b.width).toBeCloseTo(side, 3)
      expect(b.height).toBeCloseTo(side, 3)
      // The corner stays where the drag began, and the far side is under the
      // cursor on the axis it moved further along.
      const sx = Math.sign(end.x - ORIGIN.x), sy = Math.sign(end.y - ORIGIN.y)
      expect(b.cx).toBeCloseTo(ORIGIN.x + sx * side / 2, 3)
      expect(b.cy).toBeCloseTo(ORIGIN.y + sy * side / 2, 3)
    }
  })

  it('grows a centred circle to the cursor along the longer side of the drag', () => {
    const b = getBBox(generateShapeD(
      shapeParamsFromDrag('circle', ORIGIN, { x: ORIGIN.x + 50, y: ORIGIN.y + 10 }, DEFAULT_SHAPE_CONFIG, true)))!
    expect(b.cx).toBeCloseTo(ORIGIN.x, 6)
    expect(b.cy).toBeCloseTo(ORIGIN.y, 6)
    expect(b.width).toBeCloseTo(100, 3)
  })

  it('grows a heart to the cursor along whichever axis reaches past its proportions', () => {
    const aspect = fixedDragAspect('heart', DEFAULT_SHAPE_CONFIG)!
    for (const end of [
      { x: ORIGIN.x + 100, y: ORIGIN.y + 20 },     // wider than a heart: width reaches the cursor
      { x: ORIGIN.x - 15, y: ORIGIN.y - 80 },      // taller than a heart: height does
    ]) {
      const dx = Math.abs(end.x - ORIGIN.x), dy = Math.abs(end.y - ORIGIN.y)
      const b = getBBox(generateShapeD(shapeParamsFromDrag('heart', ORIGIN, end, DEFAULT_SHAPE_CONFIG)))!
      const w = Math.max(dx, dy * aspect)
      expect(b.width).toBeCloseTo(w, 2)
      expect(b.height).toBeCloseTo(w / aspect, 2)
      // Neither side falls short of the cursor, and one of them is exactly on it.
      expect(b.width).toBeGreaterThanOrEqual(dx - 1e-6)
      expect(b.height).toBeGreaterThanOrEqual(dy - 1e-6)
      expect(Math.min(Math.abs(b.width - dx), Math.abs(b.height - dy))).toBeLessThan(0.01)
      // Its corner stays where the drag began.
      const sx = Math.sign(end.x - ORIGIN.x), sy = Math.sign(end.y - ORIGIN.y)
      expect(b.cx).toBeCloseTo(ORIGIN.x + sx * b.width / 2, 2)
      expect(b.cy).toBeCloseTo(ORIGIN.y + sy * b.height / 2, 2)
    }
  })

  it('keeps a centred heart on the drag origin whatever the drag\'s proportions', () => {
    const b = getBBox(generateShapeD(
      shapeParamsFromDrag('heart', ORIGIN, { x: ORIGIN.x + 50, y: ORIGIN.y + 5 }, DEFAULT_SHAPE_CONFIG, true)))!
    expect(b.cx).toBeCloseTo(ORIGIN.x, 2)
    expect(b.cy).toBeCloseTo(ORIGIN.y, 2)
    expect(b.width).toBeCloseTo(100, 2)
  })

  it('sizes every round shape by the longer side of the drag, not the shorter', () => {
    for (const type of SQUARE_DRAG_SHAPES) {
      if (!types.includes(type)) continue
      const wide = shapeParamsFromDrag(type, ORIGIN, { x: ORIGIN.x + 60, y: ORIGIN.y + 10 }, DEFAULT_SHAPE_CONFIG)
      const square = shapeParamsFromDrag(type, ORIGIN, { x: ORIGIN.x + 60, y: ORIGIN.y + 60 }, DEFAULT_SHAPE_CONFIG)
      expect(wide).toEqual(square)
    }
  })

  // The reason Rick asked for it: drag from one point repeatedly and the shapes
  // nest, which corner-to-corner cannot do without working out each corner.
  it('makes repeated drags from one point concentric', () => {
    const boxes = [10, 20, 30].map((r) => {
      const p = shapeParamsFromDrag('circle', ORIGIN, { x: ORIGIN.x + r, y: ORIGIN.y + r }, DEFAULT_SHAPE_CONFIG, true)
      return getBBox(generateShapeD(p))!
    })
    for (const b of boxes) {
      expect(b.cx).toBeCloseTo(ORIGIN.x, 6)
      expect(b.cy).toBeCloseTo(ORIGIN.y, 6)
    }
    // Nested, not merely co-centred.
    expect(boxes[0].width).toBeLessThan(boxes[1].width)
    expect(boxes[1].width).toBeLessThan(boxes[2].width)
  })
})

