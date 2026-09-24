import { describe, it, expect } from 'vitest'
import {
  getBBox, getMultiBBox, translateD, scaleAroundD, rotateAroundD, mirrorD, skewAroundD,
  extractCircles, extractRectInfo, isPlacementOnly, gestureForSteps, consolidateSteps,
  foldPlacement, applyPlacementD, applyTransformSteps, transformPoint,
  dragBoxEncloses, wholeGroupsOnly, isIdentityStep, type TransformStep,
} from './selectionUtils'
import type { ImportedPath } from '../store/pathsStore'
import { flattenPath } from '../cam/pathFlattener'

const rect = 'M0,0 L10,0 L10,5 L0,5 Z' // 10×5 rect at origin, CNC mm Y-up

function bboxOf(d: string) {
  const b = getBBox(d)
  expect(b).not.toBeNull()
  return b!
}

describe('getBBox', () => {
  it('computes the bounds of a polygon path', () => {
    const b = bboxOf(rect)
    expect(b.minX).toBeCloseTo(0)
    expect(b.maxX).toBeCloseTo(10)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(5)
    expect(b.width).toBeCloseTo(10)
    expect(b.height).toBeCloseTo(5)
    expect(b.cx).toBeCloseTo(5)
    expect(b.cy).toBeCloseTo(2.5)
  })

  it('returns null for an empty d string', () => {
    expect(getBBox('')).toBeNull()
  })

  // The extreme sits at t = 1 − 1/√3, which no bisection ever samples — so a flattened box
  // falls short of it however fine the tolerance, and the old 0.5 mm one fell well short.
  it('reaches the true extreme of a cubic bulge, not the nearest flattened point', () => {
    const b = bboxOf('M0,0 C0,12 10,6 10,0')
    expect(b.maxY).toBeCloseTo(4 * Math.sqrt(3), 9)
    expect(b.minY).toBeCloseTo(0, 12)
  })

  // A 20×10 ellipse turned 30°: its half-extents are √(rx²cos²φ + ry²sin²φ) and
  // √(rx²sin²φ + ry²cos²φ), neither of which lands on an arc endpoint.
  it('measures a rotated elliptical arc at its true axis extremes', () => {
    const ex = 20 * Math.cos(Math.PI / 6), ey = 20 * Math.sin(Math.PI / 6)
    const b = bboxOf(`M${ex},${ey} A20,10,30,0,1,${-ex},${-ey} A20,10,30,0,1,${ex},${ey} Z`)
    expect(b.maxX).toBeCloseTo(Math.sqrt(325), 6)
    expect(b.minX).toBeCloseTo(-Math.sqrt(325), 6)
    expect(b.maxY).toBeCloseTo(Math.sqrt(175), 6)
    expect(b.minY).toBeCloseTo(-Math.sqrt(175), 6)
  })

  // S and T reflect the previous control point, and the box must follow the same
  // reflection flattenPath draws — so compare against a very fine flatten of the same d.
  it('contains a fine flatten of quadratic, smooth-quadratic and smooth-cubic segments and matches it to within its tolerance', () => {
    const d = 'M0,0 Q5,10 10,0 T20,0 C25,-3 28,9 30,2 S38,-11 40,0'
    const tol = 1e-4
    const b = bboxOf(d)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const sp of flattenPath(d, tol)) for (const [x, y] of sp) {
      expect(x).toBeGreaterThanOrEqual(b.minX - 1e-9)
      expect(x).toBeLessThanOrEqual(b.maxX + 1e-9)
      expect(y).toBeGreaterThanOrEqual(b.minY - 1e-9)
      expect(y).toBeLessThanOrEqual(b.maxY + 1e-9)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    expect(b.minX - minX).toBeGreaterThan(-tol)
    expect(b.maxX - maxX).toBeLessThan(tol)
    expect(b.minY - minY).toBeGreaterThan(-tol)
    expect(b.maxY - maxY).toBeLessThan(tol)
  })

  // flattenPath drops a subpath with nothing drawn from it; the box must not stretch out
  // to a stray moveto that draws nothing.
  it('ignores a lone moveto that draws nothing, as flattenPath does', () => {
    const b = bboxOf('M100,100 M0,0 L10,5')
    expect(b.minX).toBeCloseTo(0)
    expect(b.maxX).toBeCloseTo(10)
    expect(b.maxY).toBeCloseTo(5)
  })
})

describe('getMultiBBox', () => {
  it('unions the bounds of several paths', () => {
    const other = 'M20,10 L30,10 L30,20 L20,20 Z'
    const b = getMultiBBox([rect, other])!
    expect(b.minX).toBeCloseTo(0)
    expect(b.maxX).toBeCloseTo(30)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(20)
  })

  it('returns null when no path yields a bbox', () => {
    expect(getMultiBBox([''])).toBeNull()
  })
})

describe('translateD', () => {
  it('shifts the path in CNC mm', () => {
    const b = bboxOf(translateD(rect, 3, -2))
    expect(b.minX).toBeCloseTo(3)
    expect(b.maxX).toBeCloseTo(13)
    expect(b.minY).toBeCloseTo(-2)
    expect(b.maxY).toBeCloseTo(3)
  })
})

describe('scaleAroundD', () => {
  it('scales around the given anchor', () => {
    const b = bboxOf(scaleAroundD(rect, 0, 0, 2, 3))
    expect(b.maxX).toBeCloseTo(20)
    expect(b.maxY).toBeCloseTo(15)
    expect(b.minX).toBeCloseTo(0)
    expect(b.minY).toBeCloseTo(0)
  })

  it('leaves the anchor point fixed', () => {
    // anchor at the rect center: bbox center must not move
    const b = bboxOf(scaleAroundD(rect, 5, 2.5, 2, 2))
    expect(b.cx).toBeCloseTo(5)
    expect(b.cy).toBeCloseTo(2.5)
  })
})

describe('rotateAroundD', () => {
  it('rotates CCW-positive in CNC Y-up space', () => {
    // 90° CCW about origin maps (x,y) → (-y,x): x∈[0,10],y∈[0,5] → x∈[-5,0],y∈[0,10]
    const b = bboxOf(rotateAroundD(rect, 0, 0, 90))
    expect(b.minX).toBeCloseTo(-5)
    expect(b.maxX).toBeCloseTo(0)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(10)
  })

  it('is identity at 360°', () => {
    const b = bboxOf(rotateAroundD(rect, 3, 3, 360))
    expect(b.minX).toBeCloseTo(0)
    expect(b.maxX).toBeCloseTo(10)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(5)
  })
})

describe('mirrorD', () => {
  it("axis 'x' flips horizontally about cx", () => {
    const b = bboxOf(mirrorD(rect, 'x', 0, 0))
    expect(b.minX).toBeCloseTo(-10)
    expect(b.maxX).toBeCloseTo(0)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(5)
  })

  it("axis 'y' flips vertically about cy", () => {
    const b = bboxOf(mirrorD(rect, 'y', 0, 10))
    expect(b.minY).toBeCloseTo(15)
    expect(b.maxY).toBeCloseTo(20)
    expect(b.minX).toBeCloseTo(0)
    expect(b.maxX).toBeCloseTo(10)
  })
})


// ─── Reading shapes back out of a d string ────────────────────────────────────

/** A circle as the importer writes one: two semicircular arcs and a close. */
const circleD = (cx: number, cy: number, r: number) =>
  `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`

const asPath = (d: string, extra: Partial<ImportedPath> = {}): ImportedPath =>
  ({ id: 'p1', name: 'p', d, color: '#fff', visible: true, ...extra }) as ImportedPath

describe('extractCircles', () => {
  it('finds a lone circle', () => {
    expect(extractCircles(asPath(circleD(10, 10, 5))))
      .toEqual([{ cx: 10, cy: 10, radiusMM: 5 }])
  })

  it('finds EVERY hole of a pin ring, not one hole the size of the ring', () => {
    // A path is not a hole. A pinion's pin ring is six round subpaths under one id, and
    // taking the circle from the WHOLE path's bounding box is not a near miss — it is a
    // Ø40 bore at the arbor where six Ø6 holes should be, and it looks like a perfectly
    // plausible toolpath.
    const ring = [0, 60, 120, 180, 240, 300]
      .map((a) => circleD(30 + 20 * Math.cos((a * Math.PI) / 180), 30 + 20 * Math.sin((a * Math.PI) / 180), 3))
      .join(' ')
    const holes = extractCircles(asPath(ring))
    expect(holes).toHaveLength(6)
    for (const h of holes) {
      expect(h.radiusMM).toBeCloseTo(3, 6)
      expect(Math.hypot(h.cx - 30, h.cy - 30)).toBeCloseTo(20, 6)   // on the pin circle
    }
  })

  it('trusts shapeParams only when the path really is ONE subpath', () => {
    // Every part of a multi-part shape carries the SHAPE's params, so a params check
    // alone would let one set of numbers speak for a whole ring of holes. The guard is
    // the subpath count, and the geometry has to win when they disagree.
    const ring = [0, 120, 240]
      .map((a) => circleD(30 + 20 * Math.cos((a * Math.PI) / 180), 30 + 20 * Math.sin((a * Math.PI) / 180), 3))
      .join(' ')
    const circleParams = { type: 'circle', cx: 30, cy: 30, radius: 23 } as unknown as ImportedPath['shapeParams']
    const holes = extractCircles(asPath(ring, { shapeParams: circleParams }))
    expect(holes).toHaveLength(3)
    for (const h of holes) expect(h.radiusMM).toBeCloseTo(3, 6)   // the pins, not the ring

    // And a gear's own params, which name no circle at all, simply fall through.
    const gearParams = { type: 'gear', module: 4, teeth: 24 } as unknown as ImportedPath['shapeParams']
    expect(extractCircles(asPath(ring, { shapeParams: gearParams }))).toHaveLength(3)
  })

  it('takes a single-subpath circle from its params, exactly', () => {
    // Params are the canonical geometry — no bbox rounding, no arc flattening.
    const params = { type: 'circle', cx: 7, cy: 8, radius: 9 } as unknown as ImportedPath['shapeParams']
    expect(extractCircles(asPath('M 0 0 L 1 0', { shapeParams: params })))
      .toEqual([{ cx: 7, cy: 8, radiusMM: 9 }])
  })

  it('accepts a near-round ellipse and refuses an oval one', () => {
    const ell = (rx: number, ry: number) =>
      ({ type: 'ellipse', cx: 1, cy: 2, rx, ry }) as unknown as ImportedPath['shapeParams']
    expect(extractCircles(asPath('M 0 0 L 1 0', { shapeParams: ell(5, 5.1) })))
      .toEqual([{ cx: 1, cy: 2, radiusMM: 5.05 }])
    expect(extractCircles(asPath('M 0 0 L 1 0', { shapeParams: ell(5, 9) }))).toEqual([])
  })

  it('ignores subpaths that are not round, and keeps the ones that are', () => {
    const mixed = `${circleD(10, 10, 4)} M 40 0 L 80 0 L 80 6 L 40 6 Z ${circleD(100, 10, 4)}`
    const holes = extractCircles(asPath(mixed))
    expect(holes.map((h) => h.cx)).toEqual([10, 100])
  })

  it('reads any square-ish outline as a circle — a bounding-box test cannot tell', () => {
    // KNOWN LIMITATION, pinned so a change to it is deliberate. circleFromD compares the
    // bbox's two half-extents and nothing else, so a square, a diamond or a plus all pass.
    // Selecting one and drilling it bores a hole of its half-width rather than reporting
    // that it is not round.
    expect(extractCircles(asPath('M0 0 L10 0 L10 10 L0 10 Z')))
      .toEqual([{ cx: 5, cy: 5, radiusMM: 5 }])
  })
})

describe('extractRectInfo', () => {
  it('reads an axis-aligned rectangle', () => {
    expect(extractRectInfo('M 10 20 L 60 20 L 60 50 L 10 50 Z'))
      .toEqual({ p0: { x: 10, y: 20 }, widthMM: 50, heightMM: 30, rotationDeg: 0 })
  })

  it('measures a rotated rectangle along its EDGES, not its bounding box', () => {
    // This is what makes the carve agree with the canvas: DesignLayer and the photo
    // V-carve both place the picture through this one function, so a rotated photo is
    // carved where it is drawn. A bbox would report a bigger, un-rotated rectangle.
    const c = 40 * Math.SQRT1_2
    const info = extractRectInfo(`M 0 0 L ${c} ${c} L ${c - 14.142} ${c + 14.142} L -14.142 14.142 Z`)!
    expect(info.rotationDeg).toBeCloseTo(45, 6)
    expect(info.widthMM).toBeCloseTo(40, 4)
    expect(info.heightMM).toBeCloseTo(20, 3)
    expect(info.p0).toEqual({ x: 0, y: 0 })
  })

  it('returns null for anything that is not four corners', () => {
    expect(extractRectInfo('M 0 0 L 10 0 L 10 10')).toBeNull()
    expect(extractRectInfo('')).toBeNull()
  })

  it('returns null for a degenerate edge', () => {
    expect(extractRectInfo('M 0 0 L 0 0 L 10 0 L 10 10 Z')).toBeNull()
  })

  // The picture and the photo V-carve are an unskewed rectangle of the edge lengths, so
  // anything that is not a rectangle has to be refused rather than read — otherwise the
  // outline and what gets drawn and carved sit in different places.
  const PLATE = 'M 10 20 L 60 20 L 60 50 L 10 50 Z'

  it('refuses a skewed rectangle, which the picture and the carve cannot follow', () => {
    expect(extractRectInfo(skewAroundD(PLATE, 0.3, 0, 10, 20))).toBeNull()
  })

  it('refuses a rectangle with one corner dragged off square', () => {
    expect(extractRectInfo('M 0 0 L 50 0 L 50 30 L 3 30 Z')).toBeNull()
  })

  it('refuses a TURNED rectangle stretched along one world axis — that shears it too', () => {
    const turned = rotateAroundD(PLATE, 10, 20, 30)
    expect(extractRectInfo(turned)).not.toBeNull()
    expect(extractRectInfo(scaleAroundD(turned, 10, 20, 2, 1))).toBeNull()
  })

  it('still reads a turned rectangle after a uniform scale, through d-string rounding', () => {
    const turned = rotateAroundD(PLATE, 10, 20, 30)
    const info = extractRectInfo(scaleAroundD(turned, 10, 20, 1.7, 1.7))!
    expect(info).not.toBeNull()
    expect(info.widthMM).toBeCloseTo(85, 3)
    expect(info.heightMM).toBeCloseTo(51, 3)
    expect(info.rotationDeg).toBeCloseTo(30, 3)
  })
})

// ─── Placement recipes ────────────────────────────────────────────────────────

const T = (dx: number, dy: number): TransformStep => ({ kind: 'translate', dx, dy })
const R = (angle: number, cx = 5, cy = 5): TransformStep => ({ kind: 'rotate', angle, cx, cy })
const S = (s: number, ax = 5, ay = 5): TransformStep => ({ kind: 'scale', sx: s, sy: s, ax, ay })
const MIR = (axis: 'x' | 'y', cx = 5, cy = 5): TransformStep => ({ kind: 'mirror', axis, cx, cy })
const SK = (kx: number, ky: number): TransformStep => ({ kind: 'skew', kx, ky, ax: 0, ay: 0 })
const SQ = 'M0 0 L10 0 L10 10 L0 10 Z'

describe('isPlacementOnly', () => {
  it('counts the gestures that move a part without changing what it IS', () => {
    expect(isPlacementOnly([T(1, 2)])).toBe(true)
    expect(isPlacementOnly([R(30)])).toBe(true)
    expect(isPlacementOnly([MIR('x')])).toBe(true)
    expect(isPlacementOnly([SK(0.2, 0)])).toBe(true)
    expect(isPlacementOnly([T(1, 2), R(30)])).toBe(true)
  })

  it('excludes scale, which edits the DEFINITION', () => {
    // Scaling a gear scales its module, so a scale is not a placement — it goes on
    // rewriting shapeParams. One scale anywhere in the chain disqualifies the lot.
    expect(isPlacementOnly([S(2)])).toBe(false)
    expect(isPlacementOnly([T(1, 2), S(2)])).toBe(false)
  })

  it('is false for nothing at all', () => {
    expect(isPlacementOnly([])).toBe(false)
    expect(isPlacementOnly(undefined)).toBe(false)
  })
})

describe('gestureForSteps', () => {
  it('names a single gesture and calls a mixed chain a transform', () => {
    expect(gestureForSteps([T(1, 1)])).toBe('move')
    expect(gestureForSteps([R(10)])).toBe('rotate')
    expect(gestureForSteps([S(2)])).toBe('scale')
    expect(gestureForSteps([MIR('y')])).toBe('mirror')
    expect(gestureForSteps([SK(0.1, 0)])).toBe('skew')
    expect(gestureForSteps([T(1, 1), R(10)])).toBe('transform')
  })
})

describe('consolidateSteps', () => {
  const bbox = getBBox(SQ)!

  it('merges a session of dragging into one step', () => {
    expect(consolidateSteps([T(5, 0), T(3, 0)], bbox)).toEqual([{ kind: 'translate', dx: 8, dy: 0 }])
  })

  it('leaves an empty chain empty', () => {
    expect(consolidateSteps([], bbox)).toEqual([])
  })

  it('composes a mixed chain into the SAME map it started as', () => {
    // The point of consolidating: one canonical recipe, not a growing list — and the
    // geometry must be untouched by the rewrite.
    const chain = [T(10, 0), R(45), S(2)]
    const before = getBBox(applyTransformSteps({ d: SQ }, chain).d)!
    const after = getBBox(applyTransformSteps({ d: SQ }, consolidateSteps(chain, bbox)).d)!
    expect(after).toEqual(before)
  })

  it('sums rotations about a shared pivot', () => {
    const out = consolidateSteps([R(90), R(90)], bbox)
    expect(out[0]).toMatchObject({ kind: 'rotate', angle: 180, cx: 5, cy: 5 })
  })
})

describe('foldPlacement', () => {
  it('starts a placement from nothing', () => {
    expect(foldPlacement({ d: SQ }, [T(1, 1)])).toEqual([{ kind: 'translate', dx: 1, dy: 1 }])
  })

  it('adds a drag to the placement already there, still as one step', () => {
    // A part dragged twice has moved once, as far as the recipe is concerned.
    expect(foldPlacement({ d: SQ, placement: [T(1, 1)] }, [T(2, 2)]))
      .toEqual([{ kind: 'translate', dx: 3, dy: 3 }])
  })

  it('keeps a mixed placement consolidated rather than growing a list', () => {
    const out = foldPlacement({ d: SQ, placement: [T(1, 1)] }, [R(90)])
    expect(out).toHaveLength(2)
    expect(out.map((s) => s.kind)).toEqual(['rotate', 'translate'])
  })
})

describe('applyTransformSteps', () => {
  const square = { d: 'M0,0 L10,0 L10,10 L0,10 Z', shapeParams: { type: 'rectangle' as const, x: 0, y: 0, w: 10, h: 10 } }

  it('reports a rotate followed by a translate as a spill, not as params left untouched', () => {
    const r = applyTransformSteps(square, [
      { kind: 'rotate', angle: 30, cx: 5, cy: 5 },
      { kind: 'translate', dx: 3, dy: 0 },
    ])
    expect(r.shapeParams).toBeNull()
  })

  it('lets a pure translate chain move the params', () => {
    const r = applyTransformSteps(square, [{ kind: 'translate', dx: 3, dy: 4 }, { kind: 'translate', dx: 1, dy: 0 }])
    expect(r.shapeParams).toMatchObject({ x: 4, y: 4 })
  })
})

describe('applyPlacementD', () => {
  it('is the identity when a part has never been moved', () => {
    expect(applyPlacementD(SQ, undefined)).toBe(SQ)
    expect(applyPlacementD(SQ, [])).toBe(SQ)
  })

  it('bakes the recipe into the d string', () => {
    expect(getBBox(applyPlacementD(SQ, [T(5, 3)])!)).toMatchObject({ minX: 5, minY: 3, maxX: 15, maxY: 13 })
  })
})

describe('transformPoint', () => {
  it('moves a point the same way each gesture moves geometry', () => {
    expect(transformPoint(1, 1, { kind: 'translate', dx: 2, dy: 3 })).toEqual({ x: 3, y: 4 })
    const r = transformPoint(1, 0, { kind: 'rotate', angle: 90, cx: 0, cy: 0 })
    expect(r.x).toBeCloseTo(0, 9)
    expect(r.y).toBeCloseTo(1, 9)   // CCW-positive in CNC Y-up
    expect(transformPoint(2, 2, { kind: 'scale', sx: 3, sy: 3, ax: 0, ay: 0 })).toEqual({ x: 6, y: 6 })
    expect(transformPoint(2, 2, { kind: 'skew', kx: 0.5, ky: 0, ax: 0, ay: 0 })).toEqual({ x: 3, y: 2 })
  })
})

describe('skewAroundD', () => {
  it('shears about the anchor, leaving points on it fixed', () => {
    expect(skewAroundD(SQ, 0.5, 0, 0, 0)).toBe('M0,0 L10,0 L15,10 L5,10 Z')
  })
})

describe('drag-box selection mode', () => {
  it('takes only what it contains when the box is drawn right to left', () => {
    expect(dragBoxEncloses({ sx: 300, ex: 100 })).toBe(true)
    expect(dragBoxEncloses({ sx: 100, ex: 300 })).toBe(false)
  })

  it('reads x alone, so a box dragged straight down still has an answer', () => {
    // Off the diagonal there would be no answer for a drag with no x travel, and
    // the two named gestures (down-right, up-left) agree with x anyway.
    expect(dragBoxEncloses({ sx: 200, ex: 200 })).toBe(false)
  })
})

describe('wholeGroupsOnly', () => {
  // A group is ONE object, so an enclosing box may only take it when every part
  // is inside. Expansion runs first, and this takes back what it over-caught.
  const grouped = (id: string, g?: string) =>
    asPath(rect, { id, userGroups: g ? [g] : undefined })
  const paths = [grouped('a', 'G'), grouped('b', 'G'), grouped('c')]

  it('drops a group with a part left outside the box', () => {
    // 'a' was caught, so expansion pulled 'b' in with it — but 'b' is outside.
    expect(wholeGroupsOnly(['a', 'b'], [paths[0]], paths)).toEqual([])
  })

  it('keeps a group whose every part is inside', () => {
    expect(wholeGroupsOnly(['a', 'b'], [paths[0], paths[1]], paths)).toEqual(['a', 'b'])
  })

  it('never drops an ungrouped path for a neighbour it has nothing to do with', () => {
    expect(wholeGroupsOnly(['a', 'b', 'c'], [paths[2]], paths)).toEqual(['c'])
  })

  it('lets a hidden member out of the running rather than holding its group back', () => {
    // A hidden path cannot be selected either way, so requiring it to be inside
    // would make a group with one hidden part impossible to enclose at all.
    const withHidden = [paths[0], asPath(rect, { id: 'b', userGroups: ['G'], visible: false }), paths[2]]
    expect(wholeGroupsOnly(['a', 'b'], [withHidden[0]], withHidden)).toEqual(['a', 'b'])
  })
})

// A drag that snaps back to where it began must not record an edit or regenerate the
// part's operations — the canvas asks this before it bakes.
describe('isIdentityStep', () => {
  it('calls a zero move, a unit scale, a zero skew and a whole turn the identity', () => {
    expect(isIdentityStep({ kind: 'translate', dx: 0, dy: 0 })).toBe(true)
    expect(isIdentityStep({ kind: 'scale', sx: 1, sy: 1, ax: 5, ay: 5 })).toBe(true)
    expect(isIdentityStep({ kind: 'skew', kx: 0, ky: 0, ax: 5, ay: 5 })).toBe(true)
    expect(isIdentityStep({ kind: 'rotate', angle: 0, cx: 5, cy: 5 })).toBe(true)
    expect(isIdentityStep({ kind: 'rotate', angle: -360, cx: 5, cy: 5 })).toBe(true)
  })

  it('calls any real change a change — one axis is enough', () => {
    expect(isIdentityStep({ kind: 'translate', dx: 0, dy: 0.001 })).toBe(false)
    expect(isIdentityStep({ kind: 'scale', sx: 1, sy: -1, ax: 0, ay: 0 })).toBe(false)
    expect(isIdentityStep({ kind: 'skew', kx: 0.01, ky: 0, ax: 0, ay: 0 })).toBe(false)
    expect(isIdentityStep({ kind: 'rotate', angle: 5, cx: 0, cy: 0 })).toBe(false)
  })

  it('never calls a mirror the identity', () => {
    expect(isIdentityStep({ kind: 'mirror', axis: 'x', cx: 0, cy: 0 })).toBe(false)
  })
})
