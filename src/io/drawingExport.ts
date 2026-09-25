// Writing the drawing out for another tool, as SVG or DXF. The format and the filename
// are chosen in `SaveDialog` (kind 'drawing'); both formats take the same paths
// (`pathsForExport`: the selection, else everything visible) and write millimetres.

import { pathsToSvg, pathsForExport } from './svgExport'
import { pathsToDxf } from './dxfExport'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useUIStore } from '../store/uiStore'
import { downloadText } from './download'
import { round4 as mm } from '../util/num'

export type DrawingFormat = 'svg' | 'dxf'

export const DRAWING_FORMATS: Record<DrawingFormat, { label: string; ext: string; mime: string; hint: string }> = {
  svg: { label: 'SVG', ext: '.svg', mime: 'image/svg+xml', hint: 'Inkscape, Illustrator, browsers — the stock is the page' },
  dxf: { label: 'DXF', ext: '.dxf', mime: 'application/dxf', hint: 'CAD, CAM and laser software — arcs kept exact' },
}

/** Write the selection (or the whole drawing) as `name` + the format's extension. */
export function exportDrawing(name: string, format: DrawingFormat) {
  const { paths, fromSelection, skipped } = pathsForExport()
  const ui = useUIStore.getState()
  if (paths.length === 0) {
    ui.showStatus('Nothing to export — no visible paths.', 'warn')
    return
  }
  const meta = DRAWING_FORMATS[format]
  const { widthMM, heightMM } = useWorkpieceStore.getState()
  const content = format === 'svg' ? pathsToSvg(paths, { widthMM, heightMM }) : pathsToDxf(paths)
  const filename = name.toLowerCase().endsWith(meta.ext) ? name : `${name}${meta.ext}`
  downloadText(content, filename, meta.mime)
  ui.showStatus(
    `Exported ${paths.length} path${paths.length > 1 ? 's' : ''}`
    + `${fromSelection ? ' (selection)' : ''} as ${meta.label}, in mm`
    + (format === 'svg' ? ` on a ${mm(widthMM)} × ${mm(heightMM)} page.` : '.')
    + (skipped > 0 ? ` ${skipped} image/STL path${skipped > 1 ? 's' : ''} left out — the file holds outlines only.` : ''),
    skipped > 0 ? 'warn' : 'info',
  )
}
