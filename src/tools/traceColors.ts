import { nextPathColor, type ImportedPath } from '../importers/svgImporter'
import { colorByLayer } from '../importers/layers'

// The colours the traced paths get — one per tone LAYER when there are several (as
// colorByLayer gives an import's layers), the ordinary path colour otherwise. Shared by
// the canvas preview and Trace itself, so locking a preview in changes nothing on screen.
export function traceColors(levels: number[], tones: number): string[] {
  if (tones <= 1) return levels.map(() => nextPathColor())
  const tmp = levels.map((l) => ({ id: '', name: '', d: '', visible: true, color: '', layer: `Tone ${l}` }) as ImportedPath)
  colorByLayer(tmp)
  return tmp.map((p) => p.color)
}
