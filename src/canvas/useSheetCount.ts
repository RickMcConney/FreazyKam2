import { useMemo } from 'react'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { getBBox } from './selectionUtils'
import { sheetCount, sheetOfPoint, type Stock } from '../cam/sheets'
import { useUIStore } from '../store/uiStore'

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

function countSheets(paths: ImportedPath[], stock: Stock): number {
  const cs: { x: number; y: number }[] = []
  for (const p of paths) {
    if (!p.visible || p.hidden) continue
    const c = centreOf(p)
    if (c) cs.push(c)
  }
  return sheetCount(cs, stock)
}

/** How many sheets of stock the drawing occupies (cam/sheets) — 1 for an ordinary one. */
export function useSheetCount(): number {
  const paths = usePathsStore((s) => s.paths)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  return useMemo(() => countSheets(paths, { widthMM, heightMM }), [paths, widthMM, heightMM])
}

/**
 * The sheet on show right now, read from the stores — for code outside React (the 3D
 * view). The active sheet, held within the sheets there are; 0 for a one-sheet drawing.
 */
export function currentSheet(): number {
  const count = countSheets(usePathsStore.getState().paths, useWorkpieceStore.getState())
  return Math.min(useUIStore.getState().activeSheet, count - 1)
}

/** The sheet a path lies on, by the middle of its box. */
export function pathSheet(p: ImportedPath, stock: Stock): number {
  const c = centreOf(p)
  return c ? sheetOfPoint(c.x, c.y, stock) : 0
}
