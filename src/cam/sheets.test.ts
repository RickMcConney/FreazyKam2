import { describe, it, expect } from 'vitest'
import { sheetOfPoint, sheetOffset, sheetGridExtent, opSheet, opsOnSheet, programSheetCount, opsAtSheetOrigins, SHEET_GAP_MM, SHEET_COLUMNS } from './sheets'
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'

// 2440 × 1220 mm: a 4 × 8 ft sheet lying long side along X.
const S = { widthMM: 2440, heightMM: 1220 }
const px = S.widthMM + SHEET_GAP_MM
const py = S.heightMM + SHEET_GAP_MM

const op = (id: string, segments: MotionSegment[], over: Partial<AnyOperation> = {}): AnyOperation => ({
  id, name: id, type: 'profile', toolId: 't', status: 'done', visible: true, color: '#fff', segments,
  pathId: 'p', side: 'outside', depthMM: 3, stepDownMM: 3, direction: 'climb', ...over,
} as AnyOperation)
/** A square toolpath with one arc, centred on (x, y). */
const squareAt = (x: number, y: number): MotionSegment[] => [
  { x: x - 10, y: y - 10, z: 5, rapid: true },
  { x: x + 10, y: y - 10, z: -3, rapid: false },
  { x: x + 10, y: y + 10, z: -3, rapid: false, arc: { cx: x, cy: y, cw: false } },
  { x: x - 10, y: y + 10, z: -3, rapid: false },
]
/** A point `(x, y)` from sheet `k`'s corner. */
const on = (k: number, x: number, y: number) => {
  const o = sheetOffset(k, S)
  return { x: o.x + x, y: o.y + y }
}

describe('the sheet grid', () => {
  it(`lays the sheets out ${SHEET_COLUMNS} across, then down a row, one gap apart`, () => {
    expect(sheetOffset(0, S)).toEqual({ x: 0, y: 0 })
    expect(sheetOffset(1, S)).toEqual({ x: px, y: 0 })
    expect(sheetOffset(2, S)).toEqual({ x: 2 * px, y: 0 })
    expect(sheetOffset(3, S)).toEqual({ x: 0, y: -py })
    expect(sheetOffset(7, S)).toEqual({ x: px, y: -2 * py })
  })

  it('finds the sheet a point lies on, for every sheet of the grid', () => {
    for (let k = 0; k < 9; k++) {
      const c = on(k, S.widthMM / 2, S.heightMM / 2)
      expect(sheetOfPoint(c.x, c.y, S)).toBe(k)
    }
  })

  // The nest parks a part that fits no sheet ABOVE the stock — it must not read as being
  // on another sheet, or a one-sheet nest with a parked part would draw a second sheet.
  it('counts what lies above the stock or left of it with the stock', () => {
    expect(sheetOfPoint(100, S.heightMM + 500, S)).toBe(0)
    expect(sheetOfPoint(-300, 100, S)).toBe(0)
    // However far across a parked part runs — one wider than the stock reaches past it.
    expect(sheetOfPoint(2 * px + 100, S.heightMM + 500, S)).toBe(0)
  })
})

describe('opsOnSheet', () => {
  it('takes only the operations on that sheet, in program order', () => {
    const b = on(4, 100, 100)
    const ops = [op('a', squareAt(100, 100)), op('b', squareAt(b.x, b.y)), op('c', squareAt(200, 200))]
    expect(opsOnSheet(ops, 0, S).map((o) => o.id)).toEqual(['a', 'c'])
    expect(opsOnSheet(ops, 4, S).map((o) => o.id)).toEqual(['b'])
  })

  // The machine cuts every sheet from the same corner: sheet k's toolpath must come out
  // exactly where it would be had the part been nested on the stock itself.
  it('moves another sheet to the machine origin — points, arc centres and entry hint alike', () => {
    const c = on(5, 100, 300)
    const h = on(5, 5, 7)
    const [moved] = opsOnSheet([op('b', squareAt(c.x, c.y), { entryHint: h })], 5, S)
    expect(moved.segments).toEqual(squareAt(100, 300))
    expect(moved.entryHint).toEqual({ x: 5, y: 7 })
  })

  it('leaves the first sheet\'s operations exactly as they are', () => {
    const a = op('a', squareAt(100, 100))
    expect(opsOnSheet([a], 0, S)[0]).toBe(a)
  })
})

describe('programSheetCount', () => {
  it('counts the sheets the program cuts on — not hidden, failed or imported operations', () => {
    const c = on(4, 100, 100)
    const low = squareAt(c.x, c.y)
    expect(programSheetCount([op('a', squareAt(100, 100))], S)).toBe(1)
    expect(programSheetCount([op('a', squareAt(100, 100)), op('b', low)], S)).toBe(5)
    expect(programSheetCount([op('a', squareAt(100, 100)), op('b', low, { visible: false })], S)).toBe(1)
    expect(programSheetCount([op('a', squareAt(100, 100)), op('b', low, { status: 'error' })], S)).toBe(1)
  })
})

describe('opsAtSheetOrigins', () => {
  it('moves each operation to its own sheet\'s origin, so a check against the stock judges it there', () => {
    const c = on(2, 300, 400)
    const ops = [op('a', squareAt(100, 100)), op('b', squareAt(c.x, c.y))]
    const out = opsAtSheetOrigins(ops, S)
    expect(out[0]).toBe(ops[0])
    expect(opSheet(out[1], S)).toBe(0)
    expect(out[1].segments).toEqual(squareAt(300, 400))
  })
})

// What the canvas fits and lets you zoom out to: sized off the stock alone, a grid of sheets
// could never be seen whole.
describe('sheetGridExtent', () => {
  it('is the stock alone for one sheet', () => {
    expect(sheetGridExtent(1, S)).toEqual({ minX: 0, minY: 0, maxX: S.widthMM, maxY: S.heightMM })
  })
  it('covers every sheet — a part row as well as the full rows above it', () => {
    // Seven sheets: two full rows of three and one on a third row.
    const e = sheetGridExtent(7, S)
    for (let k = 0; k < 7; k++) {
      const o = sheetOffset(k, S)
      expect(o.x).toBeGreaterThanOrEqual(e.minX)
      expect(o.y).toBeGreaterThanOrEqual(e.minY)
      expect(o.x + S.widthMM).toBeLessThanOrEqual(e.maxX)
      expect(o.y + S.heightMM).toBeLessThanOrEqual(e.maxY)
    }
    expect(e).toEqual({ minX: 0, minY: -2 * py, maxX: 3 * S.widthMM + 2 * SHEET_GAP_MM, maxY: S.heightMM })
  })
  it('is only as wide as the sheets in it while there are fewer than a row', () => {
    expect(sheetGridExtent(2, S).maxX).toBe(2 * S.widthMM + SHEET_GAP_MM)
  })
})
