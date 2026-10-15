import { describe, it, expect } from 'vitest'
import { nest, nestSheets, __nestInternals, groupPathsForNesting, nestIsStale, type NestItem, type NestParams, type NestPlacement } from './nestOp'
import type { Pt2 } from '../cam/pathFlattener'
import { cellOfPoint, cellOffset, nestCell, STOCK_CELL } from '../cam/sheets'

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
    // Wholly off the 100 mm stock, so it is visibly not in the job — ABOVE it, since to
    // the right is where more sheets go (cam/sheets), and there it would read as on one.
    const hb = bbox(place(items[0].rings[0], huge))
    expect(hb.minY).toBeGreaterThanOrEqual(100)
    expect(cellOfPoint((hb.minX + hb.maxX) / 2, (hb.minY + hb.maxY) / 2, { widthMM: 100, heightMM: 100 })).toEqual(STOCK_CELL)
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
    for (const b of boxes) expect(b.minY).toBeGreaterThanOrEqual(100)
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
  // THE DRAWING'S OWN GROUPING (sourceGroups / sourceElement), as the importers keep it.
  // A file can group "all the holes" across a sheet; trusting that would weld every part.
  it('splits a source group whose pieces do not touch, so each hole still goes with its own part', () => {
    const groups = groupPathsForNesting([
      { id: 'a', d: rectD(0, 0, 40, 40) },
      { id: 'b', d: rectD(60, 0, 40, 40) },
      { id: 'ha', d: rectD(10, 10, 5, 5), sourceGroups: ['holes'] },
      { id: 'hb', d: rectD(70, 10, 5, 5), sourceGroups: ['holes'] },
    ])
    expect(groups.map((g) => g.ids.sort()).sort()).toEqual([['a', 'ha'], ['b', 'hb']])
  })

  // A label beside its part, not inside it, with letters that do not touch each other.
  it("never splits one drawn element: a label's strokes travel together", () => {
    const groups = groupPathsForNesting([
      // In a part group too, which on its own is split wherever its pieces do not touch.
      { id: 'one', d: 'M 0 0 L 0 6', sourceGroups: ['part'], sourceElement: 'lbl' },
      { id: 'zero', d: 'M 10 0 L 14 0 L 14 6 L 10 6 Z', sourceGroups: ['part'], sourceElement: 'lbl' },
    ])
    expect(groups).toHaveLength(1)
  })

  // scratch/Charizard_50MB_sheet01.svg: the importer splits each single-stroke label into
  // one path per stroke, and the slash through every 0 is a straight two-point line. It has
  // no interior to probe, so it joined nothing and was nested off on its own into some
  // small gap, while the rest of the label rode with the part.
  it('keeps a straight two-point stroke inside a part with that part', () => {
    const groups = groupPathsForNesting([
      { id: 'part', d: rectD(0, 0, 60, 40) },
      { id: 'zero', d: 'M 20 10 L 24 10 L 24 18 L 20 18 Z' },
      { id: 'slash', d: 'M 20.5 10.5 L 23.5 17.5' },
      { id: 'dash', d: 'M 30 14 L 34 14' },
    ])
    expect(groups.map((g) => g.ids.sort())).toEqual([['dash', 'part', 'slash', 'zero']])
  })

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

// The nest's result is applied to the snapshot it was solved from, so an edit made to a
// part while the worker ran would be written over. NestForm refuses the result instead.
describe('nestIsStale', () => {
  const a = { id: 'a', d: 'M0,0' }, b = { id: 'b', d: 'M1,1' }, c = { id: 'c', d: 'M2,2' }
  const before = [a, b, c]

  it('accepts a result when nothing it nested was touched', () => {
    expect(nestIsStale(before, before, ['a', 'b'], false)).toBe(false)
    // An unrelated path edited: irrelevant without obstacles.
    expect(nestIsStale(before, [a, b, { ...c, d: 'M9,9' }], ['a', 'b'], false)).toBe(false)
  })

  it('refuses it when a nested part was edited while the nest ran', () => {
    expect(nestIsStale(before, [a, { ...b, d: 'M5,5' }, c], ['a', 'b'], false)).toBe(true)
  })

  it('does not refuse over a nested part that was deleted — it just drops out', () => {
    expect(nestIsStale(before, [a, c], ['a', 'b'], false)).toBe(false)
  })

  it('refuses any change at all when other paths were obstacles', () => {
    expect(nestIsStale(before, [a, b, { ...c, d: 'M9,9' }], ['a', 'b'], true)).toBe(true)
    expect(nestIsStale(before, before, ['a', 'b'], true)).toBe(false)
  })
})

describe('nest — filling the stock to a count', () => {
  // 100 x 100 stock, 20 mm squares, 1 mm gap and no margin: sixteen fit.
  const one: NestItem[] = [{ id: 'g0', rings: [rect(0, 0, 20, 20)] }]
  const fill = { ...PARAMS, marginMM: 0, spacingMM: 1, fill: true }

  it('fills the whole stock when no count is given', () => {
    const r = nest(one, fill)
    expect(r.placements.filter((p) => p.onStock)).toHaveLength(16)
  })

  it('stops at the count asked for, the original included, and does not call that limited', () => {
    const r = nest(one, { ...fill, fillCount: 5 })
    expect(r.placements.filter((p) => p.onStock).map((p) => p.id))
      .toEqual(['g0#0', 'g0#1', 'g0#2', 'g0#3', 'g0#4'])
    expect(r.fillLimited).toBeUndefined()
  })

  it('places only what fits when the count asks for more than the stock holds', () => {
    const r = nest(one, { ...fill, fillCount: 40 })
    expect(r.placements.filter((p) => p.onStock)).toHaveLength(16)
    expect(r.fillLimited).toBeUndefined()
  })
})

// ─── More than one sheet ──────────────────────────────────────────────────────

describe('nestSheets', () => {
  // 100×100 stock with a 1 mm margin takes nine 30 mm squares (3 × 3), no more.
  const STOCK = { widthMM: 100, heightMM: 100 }
  const cellOf = (items: NestItem[], p: NestPlacement) => {
    const b = bbox(place(items.find((i) => i.id === p.id)!.rings[0], p))
    return cellOfPoint((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, STOCK)
  }

  it('carries what will not fit onto more sheets, each part inside its own sheet', () => {
    const items = squares(20, 30)
    const r = nestSheets(items, PARAMS)
    expect(r.unplacedIds).toEqual([])
    expect(r.sheets).toBe(3)
    for (const p of r.placements) {
      const b = bbox(place(items.find((i) => i.id === p.id)!.rings[0], p))
      const o = cellOffset(nestCell(p.sheet!, STOCK), STOCK)
      expect(b.minY).toBeGreaterThanOrEqual(o.y)
      expect(b.maxY).toBeLessThanOrEqual(o.y + 100)
      expect(b.minX).toBeGreaterThanOrEqual(o.x)
      expect(b.maxX).toBeLessThanOrEqual(o.x + 100)
      expect(cellOf(items, p)).toEqual(nestCell(p.sheet!, STOCK))
    }
  })

  it('fills the sheets in order: the first full, the last with the remainder', () => {
    const r = nestSheets(squares(20, 30), PARAMS)
    const count = (k: number) => r.placements.filter((p) => p.sheet === k).length
    expect([count(0), count(1), count(2)]).toEqual([9, 9, 2])
  })

  it('stays on one sheet when everything fits, exactly as a plain nest does', () => {
    const items = squares(5, 30)
    expect(nestSheets(items, PARAMS).placements).toEqual(nest(items, PARAMS).placements)
  })

  // Without the stop, a part no sheet can hold would ask for sheet after sheet.
  it('parks a part too big for any sheet beside the stock, and stops', () => {
    const items = [...squares(10, 30), { id: 'big', rings: [rect(900, 900, 150, 150)] }]
    const r = nestSheets(items, PARAMS)
    expect(r.unplacedIds).toEqual(['big'])
    expect(r.sheets).toBe(2)
    expect(r.placements.find((p) => p.id === 'big')?.onStock).toBe(false)
  })

  it('packs round what already stands on a lower sheet', () => {
    // A 98 mm block filling the second sheet leaves room there for nothing.
    const o = cellOffset(nestCell(1, STOCK), STOCK)
    const block = [[rect(o.x + 1, o.y + 1, 98, 98)]]
    const r = nestSheets(squares(12, 30), { ...PARAMS, obstacles: block })
    expect(r.placements.filter((p) => p.sheet === 1)).toHaveLength(0)
    expect(r.placements.filter((p) => p.sheet === 2)).toHaveLength(3)
  })
})

// ─── The row check that rules out heights (rowsCanHold) ───────────────────────
// A pruning step is invisible when it is right — the nest comes out identical, only
// faster — so it is pinned here directly: one cell too strict and nests quietly get worse
// with every other test still green.

describe('ruling out a height before the sweep', () => {
  const { BitGrid, rowNeedOf, rowsCanHold } = __nestInternals
  const mask = (rows: number[][]) => ({ cols: 40, rows: rows.length, runs: rows, cells: 0 })

  it("measures a row's longest clear run, across word boundaries and to the last column", () => {
    const g = new BitGrid(70, 3)
    expect(g.longestFreeRun(0)).toBe(70)
    g.setRange(0, 10, 12)          // clear 0–9 (10) and 13–69 (57)
    expect(g.longestFreeRun(0)).toBe(57)
    g.setRange(0, 40, 40)          // 13–39 (27) and 41–69 (29), the last across two words
    expect(g.longestFreeRun(0)).toBe(29)
    g.setRange(1, 0, 69)
    expect(g.longestFreeRun(1)).toBe(0)
  })

  it('lets a span through a run of EXACTLY its length, and not one a cell shorter', () => {
    const g = new BitGrid(100, 4)
    for (let r = 0; r < 4; r++) { g.setRange(r, 0, 59); g.setRange(r, 98, 99) }   // clear 60–97: 38
    expect(rowsCanHold(g, rowNeedOf(mask([[0, 37], [0, 37]])), 0)).toBe(true)
    expect(rowsCanHold(g, rowNeedOf(mask([[0, 37], [0, 38]])), 0)).toBe(false)
  })

  it('judges a row by its widest span, not by its cells all told', () => {
    // Two spans of 20 with a gap fit a sheet row whose clear runs are 25 and 25.
    const g = new BitGrid(60, 1)
    g.setRange(0, 25, 34)
    expect(rowsCanHold(g, rowNeedOf(mask([[0, 19, 30, 49]])), 0)).toBe(true)
  })

  it('sees a write: a row ruled in is ruled out once a part lands across its gap', () => {
    const g = new BitGrid(50, 1)
    const need = rowNeedOf(mask([[0, 29]]))
    expect(rowsCanHold(g, need, 0)).toBe(true)
    g.setRange(0, 20, 20)
    expect(rowsCanHold(g, need, 0)).toBe(false)
  })
})

// ─── Progress ─────────────────────────────────────────────────────────────────

describe('nest progress', () => {
  // The reporter the worker installs (cam/progress); throttling would drop most of a fast
  // test's reports, so the reports are read off a reporter installed here instead.
  const record = async (run: () => void) => {
    const { setProgressReporter } = await import('../cam/progress')
    const seen: { frac: number; label?: string }[] = []
    setProgressReporter((frac, label) => seen.push({ frac, label }))
    try { run() } finally { setProgressReporter(null) }
    return seen
  }

  it('only ever rises, says which sheet it is on, and ends at 100%', async () => {
    const seen = await record(() => nestSheets(squares(20, 30), PARAMS))
    expect(seen.length).toBeGreaterThan(2)
    for (let i = 1; i < seen.length; i++) expect(seen[i].frac).toBeGreaterThanOrEqual(seen[i - 1].frac)
    expect(seen[seen.length - 1].frac).toBe(1)
    expect(seen.some((s) => s.label?.startsWith('Sheet 3'))).toBe(true)
  })

  it('reports a plain one-sheet nest too', async () => {
    const seen = await record(() => nest(squares(5, 30), PARAMS))
    expect(seen[seen.length - 1].frac).toBe(1)
  })
})
