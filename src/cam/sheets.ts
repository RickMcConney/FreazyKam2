// MORE THAN ONE SHEET OF STOCK. Sheets are CELLS of a grid laid out from the stock — one
// stock-sized cell per column across and per row down, SHEET_GAP_MM apart:
//
//     cell (col, row):  x ∈ [col·(W + gap), col·(W + gap) + W]
//                       y ∈ [−row·(H + gap), −row·(H + gap) + H]   ((0, 0) is the stock)
//
// A SHEET EXISTS WHERE SOMETHING LIES ON IT. Drag a part off the stock to the right or
// below and a sheet appears under it; empty it and the sheet goes. So the grid is only as
// big as what is on it: a part dragged below the stock makes one column of two sheets, not
// a fixed-width grid with empty cells beside them. Above and left of the stock is free
// workspace and never makes a sheet — what lies there counts with the stock, where the
// export check reports it as off it, exactly as it did before there were sheets.
//
// The sheets are NUMBERED in reading order (across, then down), whatever order they were
// made in. A NEST that needs more sheets fills cells in square order (`nestCell`) — 1, then
// 2 side by side, then 2 × 2, 3 × 2, 3 × 3 … — so n sheets make the squarest grid there is,
// with no empty row or column; on stock wider than tall the grid grows downward first.
//
// A part's sheet is WHERE IT LIES, not a number stamped on it: drag a part from one sheet
// onto another and it is cut with that one, with nothing hidden to go stale. And since
// parts on different sheets never overlap in space, start heights and floors need no
// special case — nothing on one sheet can stand on a pocket cut in another.
//
// The machine only ever sees ONE sheet: everything that turns the program into G-code
// (`buildGcodeInputs`) takes the operations on one sheet and moves them by minus that
// sheet's offset, so its corner is the machine origin — load a fresh board, run the next
// file.

import type { AnyOperation, MotionSegment } from '../store/toolpathStore'
import { reachesProgram } from './programOps'

/** The space between two sheets on the canvas. Drawing only — it never reaches a machine. */
export const SHEET_GAP_MM = 50

export interface Stock { widthMM: number; heightMM: number }
/** One sheet: a cell of the grid. (0, 0) is the stock itself. */
export interface Cell { col: number; row: number }
type XY = { x: number; y: number }

export const STOCK_CELL: Cell = { col: 0, row: 0 }
export const sameCell = (a: Cell, b: Cell) => a.col === b.col && a.row === b.row
export const cellKey = (c: Cell) => `${c.col},${c.row}`

/** Where a cell's corner lies, relative to the stock's. */
export function cellOffset(c: Cell, s: Stock): XY {
  return { x: c.col * (s.widthMM + SHEET_GAP_MM), y: c.row === 0 ? 0 : -c.row * (s.heightMM + SHEET_GAP_MM) }
}

/**
 * The cell a point is on. The gap between two sheets is split down the middle, the same
 * way across and down. Left of the stock or above it is free workspace, and counts with
 * the stock (see the header).
 */
export function cellOfPoint(x: number, y: number, s: Stock): Cell {
  if (!(s.widthMM > 0) || !(s.heightMM > 0)) return STOCK_CELL
  if (x < 0 || y > s.heightMM) return STOCK_CELL
  const down = s.heightMM - y   // how far below the stock's top edge
  return {
    col: Math.max(0, Math.floor((x + SHEET_GAP_MM / 2) / (s.widthMM + SHEET_GAP_MM))),
    row: Math.max(0, Math.floor((down + SHEET_GAP_MM / 2) / (s.heightMM + SHEET_GAP_MM))),
  }
}

/**
 * The cell a nest's `k`-th sheet goes on: square order, so the first n cells are always
 * the squarest grid with no empty row or column. Shell `m` (the cells with
 * max(col, row) = m) adds a column of m cells and then a row of m + 1. On stock wider than
 * tall the two are swapped, so the grid grows DOWN first and stays near square on screen.
 */
export function nestCell(k: number, s: Stock): Cell {
  const m = Math.floor(Math.sqrt(k))
  const i = k - m * m
  const c = i < m ? { col: m, row: i } : { col: i - m, row: m }
  return s.widthMM > s.heightMM ? { col: c.row, row: c.col } : c
}

// The middle of each toolpath's box, kept per segments ARRAY: segments are replaced, never
// mutated, so an op is measured again only when it is regenerated — the views and the
// export ask for every op's sheet over and over.
const centres = new WeakMap<MotionSegment[], XY | null>()
export function opCentre(op: AnyOperation): XY | null {
  const segs = op.segments
  if (centres.has(segs)) return centres.get(segs)!
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const g of segs) {
    if (g.toolChange) continue
    if (g.x < minX) minX = g.x
    if (g.x > maxX) maxX = g.x
    if (g.y < minY) minY = g.y
    if (g.y > maxY) maxY = g.y
  }
  const c = minY === Infinity ? null : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  centres.set(segs, c)
  return c
}

/** The cell an operation cuts on — where the middle of its toolpath is. */
export function opCell(op: AnyOperation, s: Stock): Cell {
  const c = opCentre(op)
  return c ? cellOfPoint(c.x, c.y, s) : STOCK_CELL
}

/** The middles of the operations that reach the program — where they say sheets are. */
export function programPoints(ops: AnyOperation[]): XY[] {
  return ops.flatMap((op) => { if (!reachesProgram(op)) return []; const c = opCentre(op); return c ? [c] : [] })
}

/**
 * The sheets: every cell something lies on, and always the stock, in reading order —
 * across, then down. Index k in this list is "Sheet k + 1" everywhere.
 */
export function sheetLayout(points: XY[], s: Stock): Cell[] {
  const byKey = new Map<string, Cell>([[cellKey(STOCK_CELL), STOCK_CELL]])
  for (const p of points) {
    const c = cellOfPoint(p.x, p.y, s)
    byKey.set(cellKey(c), c)
  }
  return [...byKey.values()].sort((a, b) => a.row - b.row || a.col - b.col)
}

function shiftSegments(segs: MotionSegment[], dx: number, dy: number): MotionSegment[] {
  return segs.map((g) => ({
    ...g, x: g.x + dx, y: g.y + dy,
    ...(g.arc ? { arc: { ...g.arc, cx: g.arc.cx + dx, cy: g.arc.cy + dy } } : {}),
  }))
}

/**
 * The operations on `cell`, each with its toolpath moved so the sheet's corner is the
 * machine origin. Entry hints move with them; nothing else is in sheet coordinates.
 * Program order is kept.
 */
export function opsOnCell(ops: AnyOperation[], cell: Cell, s: Stock): AnyOperation[] {
  const off = cellOffset(cell, s)
  return ops.flatMap((op) => {
    if (!sameCell(opCell(op, s), cell)) return []
    if (off.x === 0 && off.y === 0) return [op]
    const hint = op.entryHint
    return [{
      ...op,
      segments: shiftSegments(op.segments, -off.x, -off.y),
      ...(hint ? { entryHint: { x: hint.x - off.x, y: hint.y - off.y } } : {}),
    } as AnyOperation]
  })
}

/** How many sheets have something to CUT — the files a multi-sheet export writes. */
export function programSheetCount(ops: AnyOperation[], s: Stock): number {
  return new Set(ops.filter(reachesProgram).map((op) => cellKey(opCell(op, s)))).size || 1
}

/**
 * Every operation moved to ITS OWN sheet's origin — the frame each one is cut in. For
 * checks that judge a toolpath against the stock (is it on it, how deep, how far): judged
 * where it lies on the canvas, everything off the first sheet would read as off the stock.
 */
export function opsAtSheetOrigins(ops: AnyOperation[], s: Stock): AnyOperation[] {
  return ops.map((op) => {
    const c = opCell(op, s)
    return sameCell(c, STOCK_CELL) ? op : opsOnCell([op], c, s)[0]
  })
}

/**
 * The box the sheets cover, in CNC mm — the stock alone for one sheet. What the canvas fits
 * and how far it lets you zoom out, so every sheet can be seen at once.
 */
export function layoutExtent(cells: Cell[], s: Stock): { minX: number; minY: number; maxX: number; maxY: number } {
  let cols = 1, rows = 1
  for (const c of cells) { cols = Math.max(cols, c.col + 1); rows = Math.max(rows, c.row + 1) }
  return {
    minX: 0,
    minY: rows === 1 ? 0 : -(rows - 1) * (s.heightMM + SHEET_GAP_MM),
    maxX: cols * s.widthMM + (cols - 1) * SHEET_GAP_MM,
    maxY: s.heightMM,
  }
}

/** A sheet's program/file name: the base alone for a one-sheet job. */
export function sheetProgramName(base: string, k: number, sheets: number): string {
  return sheets > 1 ? `${base}_sheet${k + 1}` : base
}
