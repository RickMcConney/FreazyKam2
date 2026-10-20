// A double-sided job (cam/doubleSided): the pins that register the flip, the mirror that
// carries a shape from one face to the other, and side B's program. Every rule here was
// one a board flipped the wrong way, or a part cut a mirror image off, would break.
import { describe, it, expect } from 'vitest'
import {
  backCell, pinCentres, pinProblem, otherSideSteps, otherSideBox, guideTransform, normalizeDoubleSided,
  DOUBLE_SIDED_DEFAULTS, type DoubleSided, type FlipDirection,
} from './doubleSided'
import { cellOffset, opsOnCell, STOCK_CELL } from './sheets'
import { applyTransformSteps } from '../canvas/selectionUtils'
import type { AnyOperation } from '../store/toolpathStore'

const stock = { widthMM: 300, heightMM: 200 }
const job = (flip: FlipDirection, over: Partial<DoubleSided> = {}): DoubleSided => ({ flip, ...DOUBLE_SIDED_DEFAULTS, ...over })

// Where a point of the board ends up, on the machine, after the board is turned over about
// the stock's vertical centre line (left-right), its horizontal one (top-bottom), or turned
// half round face up. Each maps the stock rectangle onto itself.
const turn = {
  'left-right': (p: { x: number; y: number }) => ({ x: stock.widthMM - p.x, y: p.y }),
  'top-bottom': (p: { x: number; y: number }) => ({ x: p.x, y: stock.heightMM - p.y }),
  'half-turn': (p: { x: number; y: number }) => ({ x: stock.widthMM - p.x, y: stock.heightMM - p.y }),
}
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9

describe('the dowel pins', () => {
  for (const flip of ['left-right', 'top-bottom'] as const) {
    it(`turned over ${flip}, each hole comes back over the pin of its own size`, () => {
      const pins = pinCentres(job(flip), stock)
      for (const p of pins) expect(near(turn[flip](p), p)).toBe(true)
    })

    it(`turned over the wrong way or half round, the big pin meets the small hole (${flip} job)`, () => {
      const [small, big] = pinCentres(job(flip), stock)
      const wrong = flip === 'left-right' ? ['top-bottom', 'half-turn'] as const : ['left-right', 'half-turn'] as const
      for (const w of wrong) {
        // Every wrong way keeps the distance between the holes, so the board drops onto the
        // pins slid along the axis — with the holes swapped end for end.
        const a = turn[w](small), b = turn[w](big)
        const along = (q: { x: number; y: number }) => (flip === 'left-right' ? q.y : q.x)
        expect(Math.sign(along(b) - along(a))).toBe(-Math.sign(along(big) - along(small)))
      }
      // …and that is only a refusal because the two are different sizes.
      expect(big.diaMM - small.diaMM).toBeGreaterThanOrEqual(1)
    })
  }

  it('refuses pins the same size, since then a wrong flip fits too', () => {
    expect(pinProblem(job('left-right', { pin2DiaMM: 8 }), stock)).toMatch(/bigger than pin 1/)
    expect(pinProblem(job('left-right'), stock)).toBeNull()
  })

  it('refuses a pin hole off the edge, and two holes that overlap', () => {
    expect(pinProblem(job('left-right', { pin1MM: 2 }), stock)).toMatch(/off the edge/)
    expect(pinProblem(job('left-right', { pin1MM: 100, pin2MM: 95 }), stock)).toMatch(/overlap/)
  })

  it('reads a setting from an older build: one pin size, or a third pin, becomes the two-size pair', () => {
    const old = normalizeDoubleSided({ flip: 'top-bottom', pinDiaMM: 6, pin1MM: 12, pin3MM: 30, spoilDepthMM: 4 })!
    expect(old).toMatchObject({ flip: 'top-bottom', pin1DiaMM: 6, pin2DiaMM: DOUBLE_SIDED_DEFAULTS.pin2DiaMM, pin1MM: 12, pin2MM: 30, spoilDepthMM: 4 })
    expect(normalizeDoubleSided(null)).toBeNull()
  })
})

describe('the other side of the board', () => {
  it('is the sheet to the right for a left-right flip and below for top-bottom', () => {
    expect(backCell('left-right')).toEqual({ col: 1, row: 0 })
    expect(backCell('top-bottom')).toEqual({ col: 0, row: 1 })
  })

  for (const flip of ['left-right', 'top-bottom'] as const) {
    it(`a side-A point lands on side B where the board puts it after the flip (${flip})`, () => {
      // The guide draws side A on side B through this; side B's own coordinates are the
      // machine's after the flip, so it must be the flip, moved onto the back sheet.
      const g = guideTransform(flip, stock)
      const back = cellOffset(backCell(flip), stock)
      const p = { x: 40, y: 30 }
      const onB = { x: g.x + g.scaleX * p.x - back.x, y: g.y + g.scaleY * p.y - back.y }
      expect(near(onB, turn[flip](p))).toBe(true)
    })

    it(`a path sent to the other side and back is exactly where it was (${flip})`, () => {
      const d = 'M 20 30 L 60 30 L 60 50 L 20 50 Z'
      const there = applyTransformSteps({ d, shapeParams: undefined }, otherSideSteps(flip, STOCK_CELL, stock))
      const back = applyTransformSteps({ d: there.d, shapeParams: undefined }, otherSideSteps(flip, backCell(flip), stock))
      expect(back.d).toBe('M20,30 L60,30 L60,50 L20,50 Z')
      expect(there.d).not.toBe(back.d)
    })

    it(`a path sent to side B lands where the guide draws it — mirrored, not just moved (${flip})`, () => {
      const there = applyTransformSteps({ d: 'M 20 30 L 60 30 L 60 50 L 20 50 Z', shapeParams: undefined }, otherSideSteps(flip, STOCK_CELL, stock))
      const xs = there.d.match(/-?[\d.]+(?=,)/g)!.map(Number), ys = there.d.match(/(?<=,)-?[\d.]+/g)!.map(Number)
      expect({ minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) })
        .toEqual(otherSideBox(flip, stock, { minX: 20, maxX: 60, minY: 30, maxY: 50 }))
      // The first corner is the one nearest the flip axis afterwards: the shape turned over.
      const first = there.d.match(/^M(-?[\d.]+),(-?[\d.]+)/)!.map(Number)
      if (flip === 'left-right') expect(first[1]).toBe(Math.max(...xs)); else expect(first[2]).toBe(Math.max(...ys))
    })

    it(`a box's image on the other side agrees with the guide, and goes back the same way (${flip})`, () => {
      const a = { minX: 20, maxX: 60, minY: 30, maxY: 50 }
      const b = otherSideBox(flip, stock, a)!
      const g = guideTransform(flip, stock)
      const xs = [g.x + g.scaleX * a.minX, g.x + g.scaleX * a.maxX], ys = [g.y + g.scaleY * a.minY, g.y + g.scaleY * a.maxY]
      expect(b).toEqual({ minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) })
      expect(otherSideBox(flip, stock, b)).toEqual(a)
    })
  }

  it('gives no image for a shape on neither side', () => {
    expect(otherSideBox('left-right', stock, { minX: 20, maxX: 60, minY: -300, maxY: -280 })).toBeNull()
  })
})

describe("side B's program", () => {
  it('is side B’s own toolpath moved to the machine origin — never mirrored, so a climb cut stays climb', () => {
    const back = cellOffset(backCell('left-right'), stock)
    const segs = [
      { x: back.x + 10, y: 10, z: 5, rapid: true },
      { x: back.x + 10, y: 10, z: -3, rapid: false },
      { x: back.x + 50, y: 10, z: -3, rapid: false },
      { x: back.x + 50, y: 50, z: -3, rapid: false, arc: { cx: back.x + 50, cy: 30, cw: false } },
    ]
    const op = { id: 'o', type: 'profile', segments: segs, visible: true, status: 'done' } as unknown as AnyOperation
    const [moved] = opsOnCell([op], backCell('left-right'), stock)
    moved.segments.forEach((g, i) => {
      expect(g.x).toBeCloseTo(segs[i].x - back.x, 9)
      expect(g.y).toBeCloseTo(segs[i].y, 9)
    })
    // The direction of travel, and the arc's hand, are the toolpath's own.
    expect(moved.segments[3].arc?.cw).toBe(false)
    expect(moved.segments[2].x).toBeGreaterThan(moved.segments[1].x)
  })
})
