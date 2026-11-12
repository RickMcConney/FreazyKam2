import { memo, useMemo } from 'react'
import { Shape } from 'react-konva'
import type { Viewport } from '../viewport'
import { useUIStore } from '../../store/uiStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useToolpathStore, pathIdsOf, type MotionSegment } from '../../store/toolpathStore'

// Amber for a TOOLPATH's source paths: it reads against both the blue selection and the
// toolpath colours, in either theme. A hovered PATH glows the selection's own blue — it is
// the path itself being pointed at, and hovering it shows what a click would select.
const GLOW = '#f59e0b'
const PATH_GLOW = '#60a5fa'

// A Path2D per path OBJECT: paths are replaced, never mutated, so an edit re-parses only
// the path edited. Canvas Path2D takes the SVG d syntax as it stands (arcs included).
const path2ds = new WeakMap<ImportedPath, Path2D>()
function path2dOf(p: ImportedPath): Path2D {
  let p2 = path2ds.get(p)
  if (!p2) { p2 = new Path2D(p.d); path2ds.set(p, p2) }
  return p2
}

/**
 * The paths behind whatever the pointer is over in the Toolpaths list (`uiStore.hoverOpIds`)
 * — a row, a tool run or a whole sheet folder — so a toolpath can be found on a crowded
 * drawing before it is clicked to edit. And the paths themselves, for a row or folder of
 * the Paths list or a path chip of the strip (`uiStore.hoverPathIds`).
 *
 * In the simulation's layer (CNC space, its own canvas, listening off), not the drawing's:
 * running the pointer down the list changes this many times a second, and on layer 1 each
 * change would repaint the whole drawing. ONE Shape whatever the count (see the canvas
 * CLAUDE.md on N shapes) — a sheet folder can light up hundreds of parts.
 *
 * An operation with no live source path — surfacing, imported G-code, a part since deleted
 * — has its own cutting moves traced instead, so every row lights SOMETHING up.
 */
export const HoverHighlightLayer = memo(function HoverHighlightLayer({ viewport }: { viewport: Viewport }) {
  const hoverOpIds = useUIStore((s) => s.hoverOpIds)
  const hoverPathIds = useUIStore((s) => s.hoverPathIds)
  const operations = useToolpathStore((s) => s.operations)
  const paths = usePathsStore((s) => s.paths)

  const { hitPaths, ownPaths, segRuns } = useMemo(() => {
    const hitPaths: ImportedPath[] = []
    const ownPaths: ImportedPath[] = []
    const segRuns: MotionSegment[][] = []
    if (hoverOpIds.length === 0 && hoverPathIds.length === 0) return { hitPaths, ownPaths, segRuns }
    const byId = new Map(paths.map((p) => [p.id, p]))
    const want = new Set(hoverOpIds)
    const seen = new Set<string>()
    for (const id of new Set(hoverPathIds)) { const p = byId.get(id); if (p) ownPaths.push(p) }
    for (const op of operations) {
      if (!want.has(op.id)) continue
      const live = pathIdsOf(op).map((id) => byId.get(id)).filter((p): p is ImportedPath => !!p)
      if (live.length === 0) { if (op.segments.length > 0) segRuns.push(op.segments); continue }
      for (const p of live) if (!seen.has(p.id)) { seen.add(p.id); hitPaths.push(p) }
    }
    return { hitPaths, ownPaths, segRuns }
  }, [hoverOpIds, hoverPathIds, operations, paths])

  if (hitPaths.length === 0 && ownPaths.length === 0 && segRuns.length === 0) return null
  const px = 1 / viewport.scale   // one screen pixel in mm, so the glow keeps its weight at any zoom
  return (
    <Shape listening={false} perfectDrawEnabled={false}
      sceneFunc={(kctx) => {
        const c = kctx._context as CanvasRenderingContext2D
        const ps = hitPaths.map(path2dOf)
        let moves: Path2D | null = null
        if (segRuns.length > 0) {
          // Cutting moves only, straight between endpoints — a pointer to WHERE the
          // toolpath is, not a preview of the cut.
          moves = new Path2D()
          for (const segs of segRuns) {
            let down = false
            for (const g of segs) {
              if (g.toolChange) { down = false; continue }
              if (g.rapid || !down) { moves.moveTo(g.x, g.y); down = !g.rapid; continue }
              moves.lineTo(g.x, g.y)
            }
          }
        }
        c.save()
        c.lineCap = 'round'
        c.lineJoin = 'round'
        // A soft wide stroke under a crisp one, per colour.
        const glow = (list: Path2D[], colour: string) => {
          if (list.length === 0) return
          c.strokeStyle = colour
          c.globalAlpha = 0.35
          c.lineWidth = 9 * px
          for (const p of list) c.stroke(p)
          c.globalAlpha = 1
          c.lineWidth = 2 * px
          for (const p of list) c.stroke(p)
        }
        glow(ownPaths.map(path2dOf), PATH_GLOW)
        glow(ps, GLOW)
        if (moves) { c.strokeStyle = GLOW; c.lineWidth = 2 * px; c.globalAlpha = 0.85; c.stroke(moves) }
        c.restore()
      }} />
  )
})
