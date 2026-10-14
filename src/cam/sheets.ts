// MORE THAN ONE SHEET OF STOCK. A nest that will not fit on the stock carries on onto more
// sheets, each the stock's size, laid out in a GRID of SHEET_COLUMNS columns with
// SHEET_GAP_MM between them — across from the stock, then down a row:
//
//     sheet k:  column c = k mod COLUMNS, row r = ⌊k / COLUMNS⌋
//               x ∈ [c·(W + gap), c·(W + gap) + W]
//               y ∈ [−r·(H + gap), −r·(H + gap) + H]      (sheet 0 is the stock itself)
//
// A grid rather than one column, because a column of 4 × 8 ft sheets is a long thin strip
// the canvas spends most of its width not showing.
//
// A part's sheet is WHERE IT LIES, not a number stamped on it: drag a part from sheet 2
// onto sheet 3 and it is cut with sheet 3, with nothing hidden to go stale. And since
// parts on different sheets never overlap in space, start heights and floors need no
// special case — nothing on sheet 2 can stand on a pocket cut in sheet 1.
//
// The machine only ever sees ONE sheet: everything that turns the program into G-code
// (`buildGcodeInputs`) takes the operations on one sheet and moves them by minus that
// sheet's offset, so its corner is the machine origin — load a fresh board, run the next
// file.

import type { AnyOperation, MotionSegment } from '../store/toolpathStore'

/** The space between two sheets on the canvas. Drawing only — it never reaches a machine. */
export const SHEET_GAP_MM = 50
/** Sheets across before the next row starts. */
export const SHEET_COLUMNS = 3

export interface Stock { widthMM: number; heightMM: number }

/** Where sheet `k`'s corner lies, relative to the stock's. */
export function sheetOffset(k: number, s: Stock): { x: number; y: number } {
  const col = k % SHEET_COLUMNS
  const row = Math.floor(k / SHEET_COLUMNS)
  return { x: col * (s.widthMM + SHEET_GAP_MM), y: row === 0 ? 0 : -row * (s.heightMM + SHEET_GAP_MM) }
}

/**
 * The sheet a point is on: the grid cell — a sheet and the gap after it — that holds it.
 * Anything left of the stock or above the first row counts with the first row's nearest
 * sheet, and anything right of the last column with that column: the nest parks a part
 * that fits no sheet ABOVE the stock, where it counts as the stock's (and the export
 * check says it is off it).
 */
export function sheetOfPoint(x: number, y: number, s: Stock): number {
  if (!(s.widthMM > 0) || !(s.heightMM > 0)) return 0
  // Above the grid altogether: the parking area, however wide a parked part runs.
  if (y > s.heightMM) return 0
  const col = x < 0 ? 0 : Math.min(SHEET_COLUMNS - 1, Math.floor(x / (s.widthMM + SHEET_GAP_MM)))
  const row = y >= 0 ? 0 : Math.ceil(-y / (s.heightMM + SHEET_GAP_MM) - 1e-9)
  return row * SHEET_COLUMNS + col
}

/** The sheet an operation cuts on — where the middle of its toolpath is. */
export function opSheet(op: AnyOperation, s: Stock): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const g of op.segments) {
    if (g.toolChange) continue
    if (g.x < minX) minX = g.x
    if (g.x > maxX) maxX = g.x
    if (g.y < minY) minY = g.y
    if (g.y > maxY) maxY = g.y
  }
  return minY === Infinity ? 0 : sheetOfPoint((minX + maxX) / 2, (minY + maxY) / 2, s)
}

/** How many sheets the drawing occupies: one more than the highest a path sits on. */
export function sheetCount(centres: { x: number; y: number }[], s: Stock): number {
  let k = 0
  for (const c of centres) k = Math.max(k, sheetOfPoint(c.x, c.y, s))
  return k + 1
}

function shiftSegments(segs: MotionSegment[], dx: number, dy: number): MotionSegment[] {
  return segs.map((g) => ({
    ...g, x: g.x + dx, y: g.y + dy,
    ...(g.arc ? { arc: { ...g.arc, cx: g.arc.cx + dx, cy: g.arc.cy + dy } } : {}),
  }))
}

/**
 * The operations on sheet `k`, each with its toolpath moved so the sheet's corner is the
 * machine origin. Entry hints move with them; nothing else is in sheet coordinates.
 * Program order is kept.
 */
export function opsOnSheet(ops: AnyOperation[], k: number, s: Stock): AnyOperation[] {
  const off = sheetOffset(k, s)
  return ops.flatMap((op) => {
    if (opSheet(op, s) !== k) return []
    if (off.x === 0 && off.y === 0) return [op]
    const hint = op.entryHint
    return [{
      ...op,
      segments: shiftSegments(op.segments, -off.x, -off.y),
      ...(hint ? { entryHint: { x: hint.x - off.x, y: hint.y - off.y } } : {}),
    } as AnyOperation]
  })
}

/** What reaches a G-code file: done, visible, generated (not imported) operations. */
const cuts = (op: AnyOperation) => op.visible && op.status === 'done' && op.type !== 'gcode' && op.segments.length > 0

/** How many sheets the PROGRAM spans — one more than the highest sheet anything cuts on. */
export function programSheetCount(ops: AnyOperation[], s: Stock): number {
  let k = 0
  for (const op of ops) if (cuts(op)) k = Math.max(k, opSheet(op, s))
  return k + 1
}

/**
 * Every operation moved to ITS OWN sheet's origin — the frame each one is cut in. For
 * checks that judge a toolpath against the stock (is it on it, how deep, how far): judged
 * where it lies on the canvas, everything off the first sheet would read as off the stock.
 */
export function opsAtSheetOrigins(ops: AnyOperation[], s: Stock): AnyOperation[] {
  return ops.map((op) => {
    const k = opSheet(op, s)
    return k === 0 ? op : opsOnSheet([op], k, s)[0]
  })
}

/**
 * The box the sheets cover, in CNC mm — the stock alone for one sheet. What the canvas fits
 * and how far it lets you zoom out, so every sheet can be seen at once.
 */
export function sheetGridExtent(count: number, s: Stock): { minX: number; minY: number; maxX: number; maxY: number } {
  const n = Math.max(1, Math.floor(count))
  const cols = Math.min(n, SHEET_COLUMNS)
  const rows = Math.ceil(n / SHEET_COLUMNS)
  return {
    minX: 0,
    minY: rows === 1 ? 0 : -(rows - 1) * (s.heightMM + SHEET_GAP_MM),
    maxX: cols * s.widthMM + (cols - 1) * SHEET_GAP_MM,
    maxY: s.heightMM,
  }
}
