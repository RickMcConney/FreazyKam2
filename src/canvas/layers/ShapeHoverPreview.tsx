import { memo, useMemo } from 'react'
import { Path } from 'react-konva'
import { generateShapeD, shapeParamsFromConfig, type ShapeToolConfig, type ShapeType } from '../../shapes/shapeGenerators'
import { getBBox, type BBox } from '../selectionUtils'
import { pathVertices } from '../objectSnap'
import { useCanvasStore } from '../../store/canvasStore'
import { useUIStore } from '../../store/uiStore'
import { canvasTheme } from '../../theme'
import type { Viewport } from '../viewport'

/** The tools that are not a shape (or text). */
export const NON_SHAPE_TOOLS: ReadonlySet<string> = new Set(['select', 'drill', 'pen', 'constrain', 'region', 'measure', 'stamp'])

/** What a click of `tool` would place, generated at the ORIGIN, and its box — shared
 *  by the preview (which moves it by x/y) and the placement snap (which aligns its
 *  box), so the shape is generated once per tool/config, not once per mouse move.
 *  A single-entry cache: the config object is replaced on every change. */
let originCache: { tool: string; config: ShapeToolConfig; value: { d: string; bbox: BBox; vertices: { x: number; y: number }[] } | null } | null = null
export function originShape(tool: string, config: ShapeToolConfig): { d: string; bbox: BBox; vertices: { x: number; y: number }[] } | null {
  if (NON_SHAPE_TOOLS.has(tool)) return null
  if (originCache && originCache.tool === tool && originCache.config === config) return originCache.value
  let value: { d: string; bbox: BBox; vertices: { x: number; y: number }[] } | null = null
  try {
    const d = generateShapeD(shapeParamsFromConfig(tool as ShapeType, 0, 0, config))
    const bbox = d ? getBBox(d) : null
    value = d && bbox ? { d, bbox, vertices: pathVertices(d) } : null
  } catch { value = null }
  originCache = { tool, config, value }
  return value
}

// WHAT A CLICK WOULD PLACE, following the cursor while a shape tool is on and no
// press is in progress — so a shape can be put where it belongs before clicking,
// rather than placed and then dragged there. It is exactly the click's shape: the
// defaults (which follow the selected shape), centred on the SNAPPED cursor, as
// shapeParamsFromConfig centres a click — and object-snapped like a drag of a placed
// shape, guides and all (useShapeDraw's placeAt), so it lines up before it lands.
//
// Generated ONCE per tool/config at the origin and moved with the node's x/y, so a
// mouse move costs a translate, not a regeneration (a gear or a maze is not cheap).
// Drawn in the simulation's layer, which exists for things that change as fast as
// the pointer: on the drawing's layer every move would repaint every path.
export const ShapeHoverPreview = memo(function ShapeHoverPreview({ viewport }: { viewport: Viewport }) {
  const at = useCanvasStore((s) => s.shapeHoverAt)
  const activeTool = useUIStore((s) => s.activeTool)
  const config = useUIStore((s) => s.shapeToolConfig)
  const colors = canvasTheme(useUIStore((s) => s.darkMode)).shapePreview
  const d = useMemo(() => originShape(activeTool, config)?.d ?? null, [activeTool, config])
  if (!at || !d) return null
  return (
    <Path
      x={at.x} y={at.y} data={d}
      stroke={colors.stroke} strokeWidth={1.5 / viewport.scale} fill={colors.fill}
      dash={[6 / viewport.scale, 4 / viewport.scale]}
      listening={false} perfectDrawEnabled={false} shadowForStrokeEnabled={false}
    />
  )
})
