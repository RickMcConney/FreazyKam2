import { describe, it, expect } from 'vitest'
import {
  cellOfPoint, cellOffset, nestCell, sheetLayout, layoutExtent, opCell, opsOnCell, programSheetCount,
  opsAtSheetOrigins, sheetProgramName, STOCK_CELL, SHEET_GAP_MM, type Cell,
} from './sheets'
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'

// 2440 × 1220 mm: a 4 × 8 ft sheet lying long side along X.
const S = { widthMM: 2440, heightMM: 1220 }
// A square stock, where the nest grows across first.
const Q = { widthMM: 1000, heightMM: 1000 }
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
const cell = (col: number, row: number): Cell => ({ col, row })
/** A point `(x, y)` from a cell's corner. */
const on = (c: Cell, x: number, y: number, s = S) => {
  const o = cellOffset(c, s)
  return { x: o.x + x, y: o.y + y }
}
const mid = (c: Cell, s = S) => on(c, s.widthMM / 2, s.heightMM / 2, s)

describe('the sheet grid', () => {
  it('lays a column out to the right and a row out below, one gap apart', () => {
    expect(cellOffset(STOCK_CELL, S)).toEqual({ x: 0, y: 0 })
    expect(cellOffset(cell(1, 0), S)).toEqual({ x: px, y: 0 })
    expect(cellOffset(cell(0, 1), S)).toEqual({ x: 0, y: -py })
    expect(cellOffset(cell(2, 3), S)).toEqual({ x: 2 * px, y: -3 * py })
  })

  it('finds the cell a point lies on, for every cell of the grid', () => {
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
      const c = mid(cell(col, row))
      expect(cellOfPoint(c.x, c.y, S)).toEqual(cell(col, row))
    }
  })

  // Above and left of the stock is free workspace. The nest parks a part that fits no
  // sheet ABOVE the stock — it must not read as being on another sheet.
  it('counts what lies above the stock or left of it with the stock, however far it runs', () => {
    expect(cellOfPoint(100, S.heightMM + 500, S)).toEqual(STOCK_CELL)
    expect(cellOfPoint(-300, 100, S)).toEqual(STOCK_CELL)
    expect(cellOfPoint(-300, -5 * py, S)).toEqual(STOCK_CELL)
    expect(cellOfPoint(5 * px, S.heightMM + 500, S)).toEqual(STOCK_CELL)
  })

  // The same rule across and down: a part whose middle hangs just off an edge stays with
  // the sheet it hangs off, and only past the middle of the gap is it on the next.
  it('splits the gap between two sheets down the middle, across and down alike', () => {
    const half = SHEET_GAP_MM / 2
    expect(cellOfPoint(S.widthMM + half - 1, 100, S)).toEqual(STOCK_CELL)
    expect(cellOfPoint(S.widthMM + half + 1, 100, S)).toEqual(cell(1, 0))
    expect(cellOfPoint(100, -half + 1, S)).toEqual(STOCK_CELL)
    expect(cellOfPoint(100, -half - 1, S)).toEqual(cell(0, 1))
  })
})

// A sheet exists where something lies on it, and only there.
describe('sheetLayout', () => {
  it('is the stock alone for an ordinary drawing', () => {
    expect(sheetLayout([{ x: 100, y: 100 }], S)).toEqual([STOCK_CELL])
    expect(sheetLayout([], S)).toEqual([STOCK_CELL])
  })

  it('makes one column of two sheets for a part dragged below the stock', () => {
    expect(sheetLayout([{ x: 100, y: 100 }, mid(cell(0, 1))], S)).toEqual([STOCK_CELL, cell(0, 1)])
  })

  it('makes one row of two sheets for a part dragged right of the stock', () => {
    expect(sheetLayout([mid(cell(1, 0))], S)).toEqual([STOCK_CELL, cell(1, 0)])
  })

  it('makes no sheet for free workspace above or left of the stock', () => {
    expect(sheetLayout([{ x: -500, y: 100 }, { x: 100, y: S.heightMM + 300 }], S)).toEqual([STOCK_CELL])
  })

  // An empty cell between two occupied ones is not a sheet: nothing is drawn or numbered
  // there, and nothing is exported for it.
  it('numbers only the sheets something lies on, in reading order — across, then down', () => {
    const pts = [mid(cell(0, 1)), mid(cell(2, 0)), mid(cell(1, 1))]
    expect(sheetLayout(pts, S)).toEqual([STOCK_CELL, cell(2, 0), cell(0, 1), cell(1, 1)])
  })
})

describe('nestCell — where a nest puts its k-th sheet', () => {
  const cells = (n: number, s = Q) => Array.from({ length: n }, (_, k) => nestCell(k, s))
  const grid = (cs: Cell[]) => ({
    cols: Math.max(...cs.map((c) => c.col)) + 1,
    rows: Math.max(...cs.map((c) => c.row)) + 1,
  })

  it('makes the squarest grid for every count, with no empty row or column', () => {
    expect(grid(cells(2))).toEqual({ cols: 2, rows: 1 })
    expect(grid(cells(4))).toEqual({ cols: 2, rows: 2 })
    expect(grid(cells(6))).toEqual({ cols: 3, rows: 2 })
    expect(grid(cells(9))).toEqual({ cols: 3, rows: 3 })
    for (let n = 1; n <= 30; n++) {
      const cs = cells(n)
      const g = grid(cs)
      // Square: never more than one row or column longer than the other.
      expect(Math.abs(g.cols - g.rows)).toBeLessThanOrEqual(1)
      for (let col = 0; col < g.cols; col++) expect(cs.some((c) => c.col === col)).toBe(true)
      for (let row = 0; row < g.rows; row++) expect(cs.some((c) => c.row === row)).toBe(true)
      // Every sheet its own cell.
      expect(new Set(cs.map((c) => `${c.col},${c.row}`)).size).toBe(n)
    }
  })

  it('puts four sheets in a 2 × 2, not three in a row and one under', () => {
    expect(cells(4)).toEqual([cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)])
  })

  // A sheet wider than tall: two of them side by side are a long strip, two stacked are square.
  it('grows down first on stock wider than tall', () => {
    expect(cells(2, S)).toEqual([cell(0, 0), cell(0, 1)])
    expect(grid(cells(4, S))).toEqual({ cols: 2, rows: 2 })
  })
})

describe('opsOnCell', () => {
  it('takes only the operations on that sheet, in program order', () => {
    const b = on(cell(1, 1), 100, 100)
    const ops = [op('a', squareAt(100, 100)), op('b', squareAt(b.x, b.y)), op('c', squareAt(200, 200))]
    expect(opsOnCell(ops, STOCK_CELL, S).map((o) => o.id)).toEqual(['a', 'c'])
    expect(opsOnCell(ops, cell(1, 1), S).map((o) => o.id)).toEqual(['b'])
  })

  // The machine cuts every sheet from the same corner: a sheet's toolpath must come out
  // exactly where it would be had the part been nested on the stock itself.
  it('moves another sheet to the machine origin — points, arc centres and entry hint alike', () => {
    const c = on(cell(2, 1), 100, 300)
    const h = on(cell(2, 1), 5, 7)
    const [moved] = opsOnCell([op('b', squareAt(c.x, c.y), { entryHint: h })], cell(2, 1), S)
    expect(moved.segments).toEqual(squareAt(100, 300))
    expect(moved.entryHint).toEqual({ x: 5, y: 7 })
  })

  it("leaves the stock's operations exactly as they are", () => {
    const a = op('a', squareAt(100, 100))
    expect(opsOnCell([a], STOCK_CELL, S)[0]).toBe(a)
  })
})

describe('programSheetCount', () => {
  it('counts the sheets with something to cut — not hidden, failed or imported operations', () => {
    const c = on(cell(0, 2), 100, 100)
    const low = squareAt(c.x, c.y)
    expect(programSheetCount([op('a', squareAt(100, 100))], S)).toBe(1)
    // Two, not three: the empty row between them is not a sheet.
    expect(programSheetCount([op('a', squareAt(100, 100)), op('b', low)], S)).toBe(2)
    expect(programSheetCount([op('a', squareAt(100, 100)), op('b', low, { visible: false })], S)).toBe(1)
    expect(programSheetCount([op('a', squareAt(100, 100)), op('b', low, { status: 'error' })], S)).toBe(1)
    expect(programSheetCount([op('a', squareAt(100, 100)), op('b', low, { type: 'gcode' } as Partial<AnyOperation>)], S)).toBe(1)
  })
})

describe('opsAtSheetOrigins', () => {
  it("moves each operation to its own sheet's origin, so a check against the stock judges it there", () => {
    const c = on(cell(1, 0), 300, 400)
    const ops = [op('a', squareAt(100, 100)), op('b', squareAt(c.x, c.y))]
    const out = opsAtSheetOrigins(ops, S)
    expect(out[0]).toBe(ops[0])
    expect(opCell(out[1], S)).toEqual(STOCK_CELL)
    expect(out[1].segments).toEqual(squareAt(300, 400))
  })
})

// What the canvas fits and lets you zoom out to: sized off the stock alone, a grid of sheets
// could never be seen whole.
describe('layoutExtent', () => {
  it('is the stock alone for one sheet', () => {
    expect(layoutExtent([STOCK_CELL], S)).toEqual({ minX: 0, minY: 0, maxX: S.widthMM, maxY: S.heightMM })
  })
  it('is one column tall for a sheet below, and one row wide for a sheet beside', () => {
    expect(layoutExtent([STOCK_CELL, cell(0, 1)], S)).toEqual({ minX: 0, minY: -py, maxX: S.widthMM, maxY: S.heightMM })
    expect(layoutExtent([STOCK_CELL, cell(1, 0)], S)).toEqual({ minX: 0, minY: 0, maxX: 2 * S.widthMM + SHEET_GAP_MM, maxY: S.heightMM })
  })
  it('covers every sheet', () => {
    const cs = [STOCK_CELL, cell(2, 0), cell(1, 2)]
    const e = layoutExtent(cs, S)
    for (const c of cs) {
      const o = cellOffset(c, S)
      expect(o.x).toBeGreaterThanOrEqual(e.minX)
      expect(o.y).toBeGreaterThanOrEqual(e.minY)
      expect(o.x + S.widthMM).toBeLessThanOrEqual(e.maxX)
      expect(o.y + S.heightMM).toBeLessThanOrEqual(e.maxY)
    }
  })
})

describe('sheetProgramName', () => {
  it('names a sheet only when there is more than one', () => {
    expect(sheetProgramName('job', 0, 1)).toBe('job')
    expect(sheetProgramName('job', 2, 4)).toBe('job_sheet3')
  })
})
