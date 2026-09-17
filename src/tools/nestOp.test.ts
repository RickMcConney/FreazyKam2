import { describe, it, expect } from 'vitest'
import { nest, groupPathsForNesting, type NestItem, type NestParams, type NestPlacement } from './nestOp'
import type { Pt2 } from '../cam/pathFlattener'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const rect = (x: number, y: number, w: number, h: number): Pt2[] =>
  [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]

const rectD = (x: number, y: number, w: number, h: number): string =>
  `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`

/** Where a placement actually puts a ring: rotate about the pivot, then translate. */
function place(ring: Pt2[], p: NestPlacement): Pt2[] {
  const t = (p.angleDeg * Math.PI) / 180
  const cos = Math.cos(t), sin = Math.sin(t)
  return ring.map(([x, y]) => {
    const dx = x - p.pivotX, dy = y - p.pivotY
    return [p.pivotX + cos * dx - sin * dy + p.dx, p.pivotY + sin * dx + cos * dy + p.dy] as Pt2
  })
}

function bbox(ring: Pt2[]) {
  const xs = ring.map((q) => q[0]), ys = ring.map((q) => q[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

/** Clear distance between two axis-aligned boxes; negative when they overlap. */
function boxGap(a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX)
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY)
  return dx >= 0 && dy >= 0 ? Math.hypot(dx, dy) : Math.max(dx, dy)
}

/**
 * A bar with a tab on one end and a matching notch on the other, so two of them
 * can INTERLOCK end to end — the shape of a model-railway track, and the shape
 * that tempts free bottom-left fill into wrecking its own layout.
 */
const stepBar = (x: number, y: number, L: number, T: number, tab: number, depth: number): Pt2[] => [
  [x, y], [x + L, y], [x + L, y + T - depth], [x + L + tab, y + T - depth],
  [x + L + tab, y + T], [x + tab, y + T], [x + tab, y + T - depth], [x, y + T - depth],
]

/** Squares scattered well clear of the stock, so nothing starts where it belongs. */
const squares = (n: number, size: number): NestItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, rings: [rect(500 + i * 200, 500, size, size)] }))

/** Every part's outline where the nest put it. */
function placedBoxes(items: NestItem[], placements: NestPlacement[]) {
  return placements.map((p) => bbox(place(items.find((i) => i.id === p.id)!.rings[0], p)))
}

const PARAMS: NestParams = {
  sheetWidthMM: 100, sheetHeightMM: 100, spacingMM: 1, marginMM: 1,
  rotationStepDeg: 0, useHoles: false,
}

// ─── Placement ────────────────────────────────────────────────────────────────

describe('nest', () => {
  it('places every part that fits and leaves no two of them overlapping', () => {
    const items = squares(9, 30)
    const r = nest(items, PARAMS)
    expect(r.unplacedIds).toEqual([])
    expect(r.placements).toHaveLength(9)
    const boxes = placedBoxes(items, r.placements)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(boxGap(boxes[i], boxes[j])).toBeGreaterThan(0)
      }
    }
  })

  it('keeps at least the requested gap between parts, diagonal neighbours included', () => {
    const items = squares(4, 30)
    const r = nest(items, { ...PARAMS, spacingMM: 2, marginMM: 3 })
    expect(r.placements).toHaveLength(4)
    const boxes = placedBoxes(items, r.placements)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(boxGap(boxes[i], boxes[j])).toBeGreaterThanOrEqual(2 - 1e-6)
      }
    }
  })

  it('keeps every part the requested margin clear of the edge of the stock', () => {
    const items = squares(4, 30)
    const r = nest(items, { ...PARAMS, spacingMM: 2, marginMM: 3 })
    for (const b of placedBoxes(items, r.placements)) {
      expect(b.minX).toBeGreaterThanOrEqual(3 - 1e-6)
      expect(b.minY).toBeGreaterThanOrEqual(3 - 1e-6)
      expect(b.maxX).toBeLessThanOrEqual(97 + 1e-6)
      expect(b.maxY).toBeLessThanOrEqual(97 + 1e-6)
    }
  })

  it('fills up the left edge first, so the offcut is a strip off the END of the board', () => {
    // Four 20 mm squares with 1 mm between them go in ONE column, not a 2x2
    // block. Length is the dimension a woodworker can trim; width is whatever
    // the board already is — so the leftover has to be a full-height strip at
    // the right-hand end, not a shallow band along the top.
    const items = squares(4, 20)
    const r = nest(items, { ...PARAMS, sheetWidthMM: 200, sheetHeightMM: 200, marginMM: 0 })
    expect(r.placements).toHaveLength(4)
    expect(r.usedWidthMM).toBeLessThan(22)
    expect(r.usedHeightMM).toBeGreaterThan(80)
    for (const b of placedBoxes(items, r.placements)) expect(b.minX).toBeLessThan(1)
  })

  it('keeps the longest strip of board, not the smallest bounding box', () => {
    // Two passes can place the same parts and differ in shape: one reaching
    // further along the board but sitting in a neater box, the other leaving more
    // board. Only the second is worth anything — the width of the board is not
    // recoverable whatever the nest does with it, so a tidier box across the
    // grain buys nothing, while every millimetre NOT reached along the length is
    // a piece that can be cut off and used. Ranking passes by the area of the
    // used box (which is what this did first) trades the strip away for that
    // worthless tidiness: here it gives back 107 mm of board instead of 122.
    const items: NestItem[] = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`, rings: [rect(1000 + i * 200, 0, 60, 55)],
    }))
    const r = nest(items, {
      sheetWidthMM: 300, sheetHeightMM: 200, spacingMM: 3, marginMM: 3,
      rotationStepDeg: 90, useHoles: false, resolutionMM: 1,
    })
    expect(r.placements.filter((p) => p.onStock)).toHaveLength(7)
    expect(300 - r.usedWidthMM).toBeGreaterThanOrEqual(122)
  })

  it('fills along the bottom edge instead when asked to pack that way', () => {
    const items = squares(4, 20)
    const r = nest(items, {
      ...PARAMS, sheetWidthMM: 200, sheetHeightMM: 200, marginMM: 0, packFrom: 'bottom',
    })
    expect(r.placements).toHaveLength(4)
    expect(r.usedHeightMM).toBeLessThan(22)
    expect(r.usedWidthMM).toBeGreaterThan(80)
    for (const b of placedBoxes(items, r.placements)) expect(b.minY).toBeLessThan(1)
  })

  it('parks a part that will not fit CLEAR of the stock, never on top of the nest', () => {
    // Leaving it where it lay was the first behaviour, and it is the wrong one:
    // the nest has just repacked the stock underneath it, so where it lay is on
    // top of everything else. A sheet of 19 tracks came out with seven pairs of
    // parts sitting through each other, every one of them an unplaced part.
    // The oversized part starts lying OVER the origin corner — exactly where the
    // nest is about to pack the part that does fit. Start it off the stock and
    // the test proves nothing: leaving it alone would pass too.
    const items: NestItem[] = [
      { id: 'huge', rings: [rect(0, 0, 300, 20)] },
      { id: 'fits', rings: [rect(300, 0, 40, 40)] },
    ]
    const r = nest(items, { ...PARAMS, marginMM: 0 })
    expect(r.unplacedIds).toEqual(['huge'])

    const huge = r.placements.find((p) => p.id === 'huge')!
    const fits = r.placements.find((p) => p.id === 'fits')!
    expect(huge.onStock).toBe(false)
    expect(fits.onStock).toBe(true)
    // Wholly off the 100 mm stock, so it is visibly not in the job.
    expect(bbox(place(items[0].rings[0], huge)).minX).toBeGreaterThanOrEqual(100)
    expect(boxGap(
      bbox(place(items[0].rings[0], huge)),
      bbox(place(items[1].rings[0], fits)),
    )).toBeGreaterThan(0)
  })

  it('lays parked parts out side by side rather than piling them on one spot', () => {
    // Two parts that will not fit have to be separable by hand afterwards, which
    // a pile of coincident outlines is not.
    const items: NestItem[] = [
      { id: 'a', rings: [rect(0, 0, 300, 20)] },
      { id: 'b', rings: [rect(0, 40, 280, 20)] },
    ]
    const r = nest(items, { ...PARAMS, marginMM: 0 })
    expect(r.unplacedIds.sort()).toEqual(['a', 'b'])
    const boxes = r.placements.map((pl) => bbox(place(items.find((i) => i.id === pl.id)!.rings[0], pl)))
    expect(boxGap(boxes[0], boxes[1])).toBeGreaterThan(0)
    for (const b of boxes) expect(b.minX).toBeGreaterThanOrEqual(100)
  })

  it('turns a part to make it fit when rotation is allowed, and cannot when it is not', () => {
    // 90 mm tall and 10 mm wide, onto stock only 40 mm tall.
    const tall: NestItem[] = [{ id: 'tall', rings: [rect(0, 0, 10, 90)] }]
    const p = { ...PARAMS, sheetHeightMM: 40, spacingMM: 0, marginMM: 0 }
    expect(nest(tall, p).unplacedIds).toEqual(['tall'])
    const turned = nest(tall, { ...p, rotationStepDeg: 90 })
    expect(turned.unplacedIds).toEqual([])
    // A quarter turn, either way round — packing from the left mirrors the sense.
    expect(((turned.placements[0].angleDeg % 180) + 180) % 180).toBe(90)
    const b = bbox(place(tall[0].rings[0], turned.placements[0]))
    expect(b.maxY - b.minY).toBeCloseTo(10, 6)
    expect(b.maxX - b.minX).toBeCloseTo(90, 6)
  })

  it('leaves a part unrotated when it already fits, whatever rotations are allowed', () => {
    const r = nest(squares(1, 30), { ...PARAMS, rotationStepDeg: 15 })
    expect(r.placements[0].angleDeg).toBe(0)
  })

  it("nests a part inside another part's hole only when holes are allowed", () => {
    // A 90 mm ring with a 60 mm hole, and a 30 mm square. The stock has room for
    // the ring and for nothing else beside it.
    const items: NestItem[] = [
      { id: 'ring', rings: [rect(0, 0, 90, 90), rect(15, 15, 60, 60)] },
      { id: 'plug', rings: [rect(200, 0, 30, 30)] },
    ]
    expect(nest(items, PARAMS).unplacedIds).toEqual(['plug'])

    const withHoles = nest(items, { ...PARAMS, useHoles: true })
    expect(withHoles.unplacedIds).toEqual([])
    const ringBox = bbox(place(items[0].rings[0], withHoles.placements.find((p) => p.id === 'ring')!))
    const plugBox = bbox(place(items[1].rings[0], withHoles.placements.find((p) => p.id === 'plug')!))
    expect(plugBox.minX).toBeGreaterThan(ringBox.minX)
    expect(plugBox.maxX).toBeLessThan(ringBox.maxX)
    expect(plugBox.minY).toBeGreaterThan(ringBox.minY)
    expect(plugBox.maxY).toBeLessThan(ringBox.maxY)
  })

  it('treats an unselected path as occupied stock', () => {
    // The whole bottom half of the stock is taken by something not being nested.
    const items = squares(1, 40)
    const r = nest(items, { ...PARAMS, marginMM: 0, obstacles: [[rect(0, 0, 100, 50)]] })
    expect(r.placements).toHaveLength(1)
    expect(placedBoxes(items, r.placements)[0].minY).toBeGreaterThanOrEqual(51 - 1e-6)
  })

  it("uses the hole of an unselected part, given its rings as one obstacle", () => {
    // A part left out of the selection is an obstacle, and a hole in it is as
    // usable as a hole in a part being nested — provided the caller hands its
    // rings over as ONE obstacle. Handed the outer and inner outlines as two,
    // each fills solid and the hole is not there to find. NestForm runs the
    // unselected paths through groupPathsForNesting for exactly this reason.
    const outer = rect(0, 0, 90, 90)
    const inner = rect(20, 20, 50, 50)
    const plug = squares(1, 30)
    const asOneItem = nest(plug, { ...PARAMS, useHoles: true, obstacles: [[outer, inner]] })
    expect(asOneItem.unplacedIds).toEqual([])
    expect(placedBoxes(plug, asOneItem.placements)[0].minX).toBeGreaterThan(20)

    const asTwo = nest(plug, { ...PARAMS, useHoles: true, obstacles: [[outer], [inner]] })
    expect(asTwo.unplacedIds).toEqual(['s0'])
  })

  it('reports utilization as the nested part area over the whole stock', () => {
    const r = nest(squares(2, 40), { ...PARAMS, spacingMM: 0, marginMM: 0 })
    expect(r.placements).toHaveLength(2)
    // 2 × 40² of part on 100² of stock, to within the cell size.
    expect(r.utilization).toBeGreaterThan(0.31)
    expect(r.utilization).toBeLessThan(0.33)
  })

  it('treats an open cut line as material, not as nothing', () => {
    // A groove is a two-point straight line: no interior, no area, and until it
    // was let into the raster it had no cells either — so a part could be nested
    // straight across it.
    const line: NestItem = { id: 'line', rings: [[[0, 0], [90, 0]]] }
    const block: NestItem = { id: 'block', rings: [rect(300, 0, 40, 40)] }
    const r = nest([line, block], {
      sheetWidthMM: 100, sheetHeightMM: 100, spacingMM: 2, marginMM: 0,
      rotationStepDeg: 0, useHoles: false,
    })
    expect(r.unplacedIds).toEqual([])
    const a = bbox(place(line.rings[0], r.placements.find((p) => p.id === 'line')!))
    const b = bbox(place(block.rings[0], r.placements.find((p) => p.id === 'block')!))
    expect(boxGap(a, b)).toBeGreaterThanOrEqual(2 - 1e-6)
  })

  it('will not nest through a feature thinner than a cell', () => {
    // A 0.5 mm bar on a 2 mm grid: no scanline down the middle of a cell row
    // touches it, so an interior-only raster describes this part as EMPTY and
    // happily drops the square on top of it. The outline walk is what stops that.
    const bar: NestItem = { id: 'bar', rings: [rect(0, 0, 60, 0.5)] }
    const block: NestItem = { id: 'block', rings: [rect(300, 0, 20, 20)] }
    const r = nest([bar, block], {
      sheetWidthMM: 60, sheetHeightMM: 60, spacingMM: 0, marginMM: 0,
      rotationStepDeg: 0, useHoles: false, resolutionMM: 2,
    })
    expect(r.unplacedIds).toEqual([])
    const [a, b] = [
      bbox(place(bar.rings[0], r.placements.find((p) => p.id === 'bar')!)),
      bbox(place(block.rings[0], r.placements.find((p) => p.id === 'block')!)),
    ]
    expect(boxGap(a, b)).toBeGreaterThan(0)
  })

  it('reproduces the same nest when it is run again, and says so by moving nothing', () => {
    // The nest is decided by the parts' SHAPES, not by where they are lying, so a
    // second run must land them exactly where the first did. Anything else means
    // pressing the button twice walks the drawing somewhere new each time.
    const items = squares(6, 25)
    const first = nest(items, { ...PARAMS, rotationStepDeg: 90 })
    expect(first.placements).toHaveLength(6)
    const moved: NestItem[] = first.placements.map((pl) => ({
      id: pl.id,
      rings: [place(items.find((i) => i.id === pl.id)!.rings[0], pl)],
      currentAngleDeg: pl.angleDeg,
    }))
    const second = nest(moved, { ...PARAMS, rotationStepDeg: 90 })
    for (const pl of second.placements) {
      expect(pl.angleDeg).toBe(0)
      expect(pl.dx).toBeCloseTo(0, 6)
      expect(pl.dy).toBeCloseTo(0, 6)
    }
  })

  it('turns a part back to the way it was drawn when no rotation is allowed', () => {
    // "No rotation" is the grid {0}, not "leave it alone". The two sound the same
    // until an earlier nest has already turned a part: read as "leave it alone"
    // it is stranded at 90° with no way home short of undo, which is what the
    // user hit. Read as a grid it goes back, and it agrees with every other
    // setting on the ladder — all of which offer 0 among their orientations.
    const item: NestItem = { id: 'p', rings: [rect(0, 0, 40, 90)], currentAngleDeg: 90 }
    const r = nest([item], { ...PARAMS, rotationStepDeg: 0 })
    expect(r.placements[0].angleDeg).toBe(-90)
  })

  it('leaves an as-drawn part alone when no rotation is allowed', () => {
    // The other half of the same rule: turning home must be a no-op for a part
    // that is already home, or nesting twice would walk the drawing.
    const r = nest(squares(1, 30), { ...PARAMS, rotationStepDeg: 0 })
    expect(r.placements[0].angleDeg).toBe(0)
  })

  it('offers turns onto an ABSOLUTE grid, so a part already at an angle is squared up', () => {
    // A part standing at 15° asked for 90° rotation must be offered −15° (square
    // to the stock), not 90° on top of the 15° it already has. Without that, every
    // re-nest turns everything again and nothing is ever square.
    const item: NestItem = { id: 'p', rings: [rect(0, 0, 90, 10)], currentAngleDeg: 15 }
    const r = nest([item], { ...PARAMS, sheetHeightMM: 40, spacingMM: 0, marginMM: 0, rotationStepDeg: 90 })
    expect(r.unplacedIds).toEqual([])
    // Whatever it picked, the part ends up square: 15 + chosen is a multiple of 90.
    const absolute = ((15 + r.placements[0].angleDeg) % 90 + 90) % 90
    expect(Math.min(absolute, 90 - absolute)).toBeCloseTo(0, 6)
  })

  it('fits more by committing to the orientation the parts were NOT drawn in', () => {
    // Twelve identical 110 x 40 oblongs on 330 x 210. Bottom-left fill is greedy
    // and never reconsiders, so everything turns on what it commits to first:
    // offering each part as drawn gets ten on, offering it upright gets eleven.
    // Neither preference wins in general, which is why all of them are tried.
    //
    // This is a sheet of 19 model-railway tracks reduced to its bones — there,
    // as-drawn and wide-first both stopped at 18 of 19 and only upright-first
    // found the nineteenth, which is exactly the track the user had to place by
    // hand.
    const items: NestItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`, rings: [rect(1000 + i * 200, 0, 110, 40)],
    }))
    const r = nest(items, {
      sheetWidthMM: 330, sheetHeightMM: 210, spacingMM: 3, marginMM: 3,
      rotationStepDeg: 90, useHoles: false,
    })
    expect(r.placements.filter((p) => p.onStock)).toHaveLength(11)

    const boxes = placedBoxes(items, r.placements.filter((p) => p.onStock))
    for (const b of boxes) {
      expect(b.minX).toBeGreaterThanOrEqual(3 - 1e-6)
      expect(b.minY).toBeGreaterThanOrEqual(3 - 1e-6)
      expect(b.maxX).toBeLessThanOrEqual(327 + 1e-6)
      expect(b.maxY).toBeLessThanOrEqual(207 + 1e-6)
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(boxGap(boxes[i], boxes[j])).toBeGreaterThanOrEqual(3 - 1e-6)
      }
    }
  })

  it('never fits FEWER parts as the rotation grid gets finer', () => {
    // The 90° grid is a subset of the 45° one, which is a subset of the 15° one,
    // so every layout a coarse setting can reach a fine one can reach too and the
    // ladder has to be monotone. Greedily it is not: bottom-left fill takes the
    // lowest spot it can find, so a finer grid tempts each part into a slightly
    // lower odd angle, the tidy rows never form, and this fixture dropped from 11
    // parts at 90° to 9 at 15° — worse than not turning anything at all. The fix
    // is to pack against the coarser grids as well and keep the best, which is
    // why the property holds by construction rather than by luck.
    const items: NestItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`, rings: [rect(1000 + i * 200, 0, 110, 40)],
    }))
    // The cell size is pinned only to keep the test quick — the claim is about
    // the angle ladder, and it holds identically on the default grid (which is
    // 20x finer here, and 20x slower to sweep 24 orientations over).
    const p = {
      sheetWidthMM: 330, sheetHeightMM: 210, spacingMM: 3, marginMM: 3,
      useHoles: false, resolutionMM: 1,
    }
    const fitted = (step: number) =>
      nest(items, { ...p, rotationStepDeg: step }).placements.filter((q) => q.onStock).length

    const coarse = fitted(90)
    expect(coarse).toBe(11)
    expect(fitted(45)).toBeGreaterThanOrEqual(coarse)
    expect(fitted(15)).toBeGreaterThanOrEqual(coarse)
  })

  it('packs interlocking parts in clean shelves rather than letting them creep', () => {
    // Free bottom-left fill takes any gain going, and on parts that interlock
    // that is its undoing: a bar slides its tab back into the column beside it,
    // which is a real local gain, and the clean column structure that would have
    // held every part collapses into a jumble that holds three fewer. Shelf
    // packing refuses those — every part in a level sits on the same line and
    // nothing reaches back into a level already closed.
    //
    // Neither strategy dominates (shelves waste what a level's tallest part
    // leaves under the shorter ones), so both are run and the better kept. This
    // is a fixture where shelves win by three; `nest` must find that.
    const items: NestItem[] = Array.from({ length: 22 }, (_, i) => ({
      id: `b${i}`, rings: [stepBar(2000 + i * 300, 0, 130, 40, 12, 12)],
    }))
    const r = nest(items, {
      sheetWidthMM: 500, sheetHeightMM: 300, spacingMM: 3, marginMM: 3,
      rotationStepDeg: 90, useHoles: false, resolutionMM: 1,
    })
    expect(r.placements.filter((p) => p.onStock)).toHaveLength(22)

    const boxes = placedBoxes(items, r.placements.filter((p) => p.onStock))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(boxGap(boxes[i], boxes[j])).toBeGreaterThan(0)
      }
    }
  })

  it('places the largest part first, so a big one is never crowded out by small ones', () => {
    // The big square only fits at all if it goes down before the small ones,
    // which would otherwise be strung along the bottom edge in its way.
    const items: NestItem[] = [
      ...squares(6, 10),
      { id: 'big', rings: [rect(0, 400, 60, 60)] },
    ]
    const r = nest(items, { ...PARAMS, sheetWidthMM: 70, sheetHeightMM: 90, marginMM: 0 })
    expect(r.unplacedIds).toEqual([])
    expect(placedBoxes(items, r.placements).find((_, i) => r.placements[i].id === 'big')!.minY)
      .toBeLessThan(1)
  })
})

// ─── Grouping ─────────────────────────────────────────────────────────────────

describe('groupPathsForNesting', () => {
  it('splits a multi-part shape into pieces where its parts stand apart', () => {
    // An escapement: the wheel and its bore are one blank, the pallets and their
    // arbor hole are another, and nesting the two as one wastes everything in
    // between.
    const groups = groupPathsForNesting([
      { id: 'wheel', d: rectD(0, 0, 100, 100), groupId: 'esc', shapePart: 'wheel' },
      { id: 'bore', d: rectD(47, 47, 6, 6), groupId: 'esc', shapePart: 'bore' },
      { id: 'anchor', d: rectD(5, 112, 88, 46), groupId: 'esc', shapePart: 'anchor' },
      { id: 'anchorbore', d: rectD(47, 147, 6, 6), groupId: 'esc', shapePart: 'anchorbore' },
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.ids.sort()).sort()).toEqual([['anchor', 'anchorbore'], ['bore', 'wheel']])
  })

  it('splits a shape by its parts\' actual FOOTPRINT, not by their bounding boxes', () => {
    // An L and a square sitting in the L's concave notch. Their boxes overlap
    // almost entirely; the parts never touch. Boxes were the first test here and
    // this is what they got wrong — on a sheet of long curved tracks they welded
    // four separate tracks into one rigid blob too big to place at all.
    const L = 'M 0 0 L 100 0 L 100 10 L 10 10 L 10 100 L 0 100 Z'
    const groups = groupPathsForNesting([
      { id: 'l', d: L, groupId: 'g', shapePart: 'l' },
      { id: 'sq', d: rectD(40, 40, 50, 50), groupId: 'g', shapePart: 'sq' },
    ])
    expect(groups).toHaveLength(2)
  })

  it('keeps parts that share a groupId only because one was DUPLICATED apart', () => {
    // duplicateSelected remaps userGroups but carries groupId straight through,
    // so a copied shape's parts arrive wearing the original's group. Only the
    // geometry can say they are two pieces.
    const groups = groupPathsForNesting([
      { id: 'body', d: rectD(0, 0, 60, 20), groupId: 'g', shapePart: 'body' },
      { id: 'groove', d: 'M 5 10 L 55 10', groupId: 'g', shapePart: 'groove' },
      { id: 'body-copy', d: rectD(0, 40, 60, 20), groupId: 'g', shapePart: 'body' },
      { id: 'groove-copy', d: 'M 5 50 L 55 50', groupId: 'g', shapePart: 'groove' },
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.ids.sort()).sort()).toEqual([
      ['body', 'groove'], ['body-copy', 'groove-copy'],
    ])
  })

  it('keeps a multi-part shape whose parts overlap as one piece', () => {
    // A track: the grooves and treads are cut INTO the body, and they are open
    // cut lines with no interior for a containment test to find — so the test has
    // to be that their boxes overlap, or the grooves nest somewhere the body isn't.
    const groups = groupPathsForNesting([
      { id: 'body', d: rectD(0, 0, 160, 40), groupId: 'trk', shapePart: 'body' },
      { id: 'groove', d: 'M 5 20 L 155 20', groupId: 'trk', shapePart: 'groove' },
      { id: 'tread', d: 'M 20 0 L 20 40', groupId: 'trk', shapePart: 'tread' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].ids.sort()).toEqual(['body', 'groove', 'tread'])
  })

  it('never splits a user group, even where its members stand apart', () => {
    const groups = groupPathsForNesting([
      { id: 'a', d: rectD(0, 0, 20, 20), groupId: 'g', shapePart: 'a', userGroups: ['u1'] },
      { id: 'b', d: rectD(500, 0, 20, 20), groupId: 'g', shapePart: 'b', userGroups: ['u1'] },
    ])
    expect(groups).toHaveLength(1)
  })

  it('keeps a path lying inside another path with it', () => {
    const groups = groupPathsForNesting([
      { id: 'plate', d: rectD(0, 0, 50, 50) },
      { id: 'hole', d: rectD(10, 10, 5, 5) },
      { id: 'other', d: rectD(100, 0, 20, 20) },
    ])
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.ids.includes('plate'))!.ids.sort()).toEqual(['hole', 'plate'])
  })

  it('collapses a chain of nested paths into one part, not into pairs', () => {
    const groups = groupPathsForNesting([
      { id: 'outer', d: rectD(0, 0, 90, 90) },
      { id: 'mid', d: rectD(20, 20, 50, 50) },
      { id: 'inner', d: rectD(30, 30, 10, 10) },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].ids.sort()).toEqual(['inner', 'mid', 'outer'])
  })

  it('reads a shared groupId as a shape only when shapePart says so, never as an import', () => {
    // Two overlapping bars, neither inside the other. As one SHAPE's parts they
    // are one blank. Carrying the same groupId as an SVG IMPORT they are two
    // drawings that happen to have arrived in the same file, and a sheet of
    // imported parts is exactly what wants nesting apart — which is why groupId
    // on its own is never enough to tie anything together.
    const bars = [rectD(0, 0, 60, 10), rectD(50, 5, 10, 60)]
    expect(groupPathsForNesting([
      { id: 'a', d: bars[0], groupId: 'g1', shapePart: 'a' },
      { id: 'b', d: bars[1], groupId: 'g1', shapePart: 'b' },
    ])).toHaveLength(1)
    expect(groupPathsForNesting([
      { id: 'a', d: bars[0], groupId: 'svg1' },
      { id: 'b', d: bars[1], groupId: 'svg1' },
    ])).toHaveLength(2)
  })

  it('keeps a user group together wherever its members sit', () => {
    const groups = groupPathsForNesting([
      { id: 'a', d: rectD(0, 0, 20, 20), userGroups: ['u1'] },
      { id: 'b', d: rectD(100, 0, 20, 20), userGroups: ['u1'] },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].ids.sort()).toEqual(['a', 'b'])
  })

  it("nests a part standing in a ring's hole as a part, not as part of the ring", () => {
    const groups = groupPathsForNesting([
      { id: 'ring-outer', d: rectD(0, 0, 50, 50), userGroups: ['ring'] },
      { id: 'ring-inner', d: rectD(10, 10, 30, 30), userGroups: ['ring'] },
      { id: 'loose', d: rectD(20, 20, 5, 5) },
    ])
    expect(groups).toHaveLength(2)
  })
})
