import { useMemo, useRef } from 'react'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { getBBox } from './selectionUtils'
import { cellOfPoint, cellOffset, programPoints, sameCell, sheetLayout, STOCK_CELL, type Cell, type Stock } from '../cam/sheets'
import { backCell, type DoubleSided } from '../cam/doubleSided'
import { useUIStore } from '../store/uiStore'
import { useSimStore } from '../store/simStore'

// The middle of each path's box, kept per path OBJECT: a path is replaced, never mutated,
// when it changes, so only edited paths are measured again — a sheet of 890 paths is not
// re-flattened on every edit to one of them.
const centres = new WeakMap<ImportedPath, { x: number; y: number } | null>()
export function centreOf(p: ImportedPath): { x: number; y: number } | null {
  if (centres.has(p)) return centres.get(p)!
  const b = getBBox(p.d)
  const c = b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null
  centres.set(p, c)
  return c
}

// THE SHEETS ARE WHERE THE PATHS AND THE TOOLPATHS ARE — both, so the picker, the canvas
// and the program agree on one list: a toolpath whose path was deleted still has a sheet
// to be cut on, and a part with no toolpath yet still shows its sheet.
//
// A DOUBLE-SIDED job's side B is the one sheet that exists with nothing on it: it is the
// back of the stock, and it has to be there to draw on before anything is (cam/doubleSided).
function layoutOf(paths: ImportedPath[], ops: AnyOperation[], stock: Stock, ds: DoubleSided | null = null): Cell[] {
  const pts: { x: number; y: number }[] = programPoints(ops)
  if (ds) {
    const o = cellOffset(backCell(ds.flip), stock)
    pts.push({ x: o.x + stock.widthMM / 2, y: o.y + stock.heightMM / 2 })
  }
  for (const p of paths) {
    if (!p.visible || p.hidden) continue
    const c = centreOf(p)
    if (c) pts.push(c)
  }
  return sheetLayout(pts, stock)
}

/**
 * What a sheet is called on the canvas and in the picker. On a double-sided job the stock
 * and its back are the two SIDES of one board, so they say so.
 */
export function sheetName(cell: Cell, k: number, ds: DoubleSided | null): string {
  if (ds) {
    if (sameCell(cell, STOCK_CELL)) return `Sheet ${k + 1} · Side A`
    if (sameCell(cell, backCell(ds.flip))) return `Sheet ${k + 1} · Side B`
  }
  return `Sheet ${k + 1}`
}

/** Where `active` is in `cells` — the stock when that sheet is gone. */
export function sheetIndex(cells: Cell[], active: Cell): number {
  const i = cells.findIndex((c) => sameCell(c, active))
  return i < 0 ? 0 : i
}

/** The sheets of stock the drawing occupies (cam/sheets) — just the stock for an ordinary one. */
export function useSheetLayout(): Cell[] {
  const paths = usePathsStore((s) => s.paths)
  const ops = useToolpathStore((s) => s.operations)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const doubleSided = useWorkpieceStore((s) => s.doubleSided)
  // The same array until the sheets themselves change, so the layers drawing them are not
  // re-rendered by every toolpath that lands during a Generate.
  const last = useRef<Cell[]>([STOCK_CELL])
  return useMemo(() => {
    const next = layoutOf(paths, ops, { widthMM, heightMM }, doubleSided)
    const prev = last.current
    if (next.length === prev.length && next.every((c, i) => sameCell(c, prev[i]))) return prev
    last.current = next
    return next
  }, [paths, ops, widthMM, heightMM, doubleSided])
}

/** The sheets, and the one Simulate plays and the machine panel runs. */
export function useActiveSheet(): { cells: Cell[]; index: number; cell: Cell } {
  const cells = useSheetLayout()
  const index = sheetIndex(cells, useUIStore((s) => s.activeSheet))
  return { cells, index, cell: cells[index] }
}

/** The sheets right now, read from the stores — for code outside React. */
export function sheetLayoutNow(): Cell[] {
  const wp = useWorkpieceStore.getState()
  return layoutOf(usePathsStore.getState().paths, useToolpathStore.getState().operations, wp, wp.doubleSided)
}

/** The active sheet right now, read from the stores — for code outside React (the 3D view, the export). */
export function currentSheet(): { cells: Cell[]; index: number; cell: Cell } {
  const cells = sheetLayoutNow()
  const index = sheetIndex(cells, useUIStore.getState().activeSheet)
  return { cells, index, cell: cells[index] }
}

/** The sheet a path lies on, by the middle of its box. */
export function pathCell(p: ImportedPath, stock: Stock): Cell {
  const c = centreOf(p)
  return c ? cellOfPoint(c.x, c.y, stock) : STOCK_CELL
}

/**
 * The loaded program was generated for ANOTHER sheet than the one on show. A sheet change
 * reaches the program only once simAutoReload has rebuilt it (a settle delay plus the
 * build), and in that window the views must show no carve at all rather than the previous
 * sheet's — drawn on the new sheet's parts, it flashed up as the wrong cut. An imported
 * G-code file is in its own coordinates and belongs to no sheet, so it is never stale.
 */
export function simProgramIsStale(programSheet: Cell, autoReload: boolean, active: Cell, programTile: number | null = null, activeTile: number | null = null): boolean {
  // A tiled job's programs are its tiles, so another tile picked is another program too.
  return autoReload && (!sameCell(programSheet, active) || programTile !== activeTile)
}

/** The tile the picker is on, on a tiled job; null otherwise. */
export function activeTileNow(): number | null {
  const t = useWorkpieceStore.getState().tiling
  if (!t) return null
  return Math.max(0, Math.min(t.seamsMM.length, useUIStore.getState().activeTile))
}

/** `simProgramIsStale` read from the stores — for code outside React (the 3D view). */
export function simProgramIsStaleNow(): boolean {
  const sim = useSimStore.getState()
  return simProgramIsStale(sim.sheet, sim.autoReload, currentSheet().cell, sim.tile, activeTileNow())
}
