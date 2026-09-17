// Exporting paths as SVG.
//
// The counterpart of the SVG importer, and it is written to round-trip THROUGH
// it: the importer maps `x_mm = (x − vbX)·(widthMM/vbW)` and
// `y_mm = heightMM − (y − vbY)·(heightMM/vbH)`, so a file written with
// `width="{W}mm" height="{H}mm" viewBox="0 0 W H"` has one user unit to the
// millimetre and needs nothing but the Y-flip. Other tools read it the same way
// — Inkscape and Illustrator both honour a mm width with a matching viewBox —
// which is the whole reason to state the size in real units rather than pixels.
//
// THE PAGE IS THE STOCK. Not the drawing's bounding box: a box origin would put
// the content's corner at 0,0 and the round trip would silently move everything
// that was not already there. With the stock as the page, a path exported at
// (120, 40) comes back at (120, 40) in any project with the same stock — and
// anything lying off the stock still exports, just off the page, because the
// mapping is affine and clamps nothing.
//
// The Y-flip goes through `applyMat`, the importer's own transform, rather than
// through a `<g transform="scale(1,-1)">` or hand-written arithmetic. A mirror
// has to flip every arc's SWEEP flag and re-solve its axes, and that code exists
// once, in the file this has to agree with.

import { parseD, stringifyD, applyMat, type ImportedPath } from '../importers/svgImporter'
import { usePathsStore } from '../store/pathsStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { sanitizeFileName } from './filename'

const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape'

/** Stroke width of the exported outlines, mm. A hairline: these are cut lines,
 *  and a fat stroke reads as material in a viewer that fills nothing. */
const STROKE_MM = 0.2

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/** Trim a millimetre figure the way the page attributes want it. */
const mm = (n: number) => +n.toFixed(4)

/**
 * The paths as an SVG document, in millimetres, with the stock as the page.
 *
 * A path's NAME rides on `inkscape:label` and NOT on `id`: the importer prefers
 * `id` when both are there, and an id has to be an XML name — no spaces — so
 * "Great Wheel teeth" would come back mangled. Inkscape shows the label as the
 * object's name, which is what a name is for.
 */
export function pathsToSvg(
  paths: ImportedPath[],
  stock: { widthMM: number; heightMM: number },
): string {
  const w = Math.max(1, stock.widthMM)
  const h = Math.max(1, stock.heightMM)
  // CNC mm (Y-up) → SVG user units (Y-down), one unit to the millimetre.
  const flip = (d: string) => stringifyD(applyMat(parseD(d), [1, 0, 0, -1, 0, h]))

  const body = paths.map((p) => {
    const label = p.name ? ` inkscape:label="${esc(p.name)}"` : ''
    return `  <path${label} fill="none" stroke="${esc(p.color)}" stroke-width="${STROKE_MM}" d="${flip(p.d)}"/>`
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="${INKSCAPE_NS}"`,
    `     width="${mm(w)}mm" height="${mm(h)}mm" viewBox="0 0 ${mm(w)} ${mm(h)}">`,
    `  <!-- FreazyKam: one user unit = 1 mm, page = the stock, origin bottom-left -->`,
    ...body,
    '</svg>',
    '',
  ].join('\n')
}

/** What an export would take: the selection if there is one, else everything on
 *  the canvas. Split out so the caller can say which, and how much is going. */
export function pathsForSvgExport(): { paths: ImportedPath[]; fromSelection: boolean; skipped: number } {
  const { paths, selectedIds } = usePathsStore.getState()
  const fromSelection = selectedIds.length > 0
  const pool = fromSelection ? paths.filter((p) => selectedIds.includes(p.id)) : paths
  const drawn = pool.filter((p) => p.visible && !p.hidden)
  // An SVG holds outlines. A picture and an STL are carried by paths whose `d`
  // is only their bounding box, so exporting them would put a plain rectangle in
  // the file where the user is expecting their photo — better to leave them out
  // and say how many.
  const out = drawn.filter((p) => !p.imageSrc && !p.stlSrc)
  return { paths: out, fromSelection, skipped: drawn.length - out.length }
}

function download(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.svg') ? filename : `${filename}.svg`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Toolbar entry point: write the selection (or the whole drawing) to a file. */
export function exportSvg() {
  const { paths, fromSelection, skipped } = pathsForSvgExport()
  const ui = useUIStore.getState()
  if (paths.length === 0) {
    ui.showStatus('Nothing to export — no visible paths.', 'warn')
    return
  }
  const { widthMM, heightMM } = useWorkpieceStore.getState()
  download(pathsToSvg(paths, { widthMM, heightMM }), sanitizeFileName(useProjectStore.getState().name || 'drawing'))
  ui.showStatus(
    `Exported ${paths.length} path${paths.length > 1 ? 's' : ''}`
    + `${fromSelection ? ' (selection)' : ''} as SVG, in mm on a ${mm(widthMM)} × ${mm(heightMM)} page.`
    + (skipped > 0 ? ` ${skipped} image/STL path${skipped > 1 ? 's' : ''} left out — an SVG holds outlines only.` : ''),
    skipped > 0 ? 'warn' : 'info',
  )
}
