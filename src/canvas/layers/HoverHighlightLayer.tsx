import { memo, useMemo } from 'react'
import { Shape } from 'react-konva'
import type { Viewport } from '../viewport'
import { useUIStore } from '../../store/uiStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useToolpathStore, pathIdsOf, type MotionSegment } from '../../store/toolpathStore'
import { useToolStore } from '../../store/toolStore'
import { maxCutRadiusMM } from '../../cam/geom'
import { toolpathRuns } from '../toolpathRuns'

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

// The same per OBJECT for a toolpath's moves: segments arrays are replaced on every
// regenerate, never mutated, so a hover over a big pocket builds its Path2D once. Split
// into one run per TOOL, at each tool change, so each run can be drawn at its bit's width;
// `toolId: null` is the op's own tool, until the first change.
interface MoveRun { toolId: string | null; path: Path2D; plunges: [number, number][] }
const moveRuns = new WeakMap<MotionSegment[], MoveRun[]>()
function movesOf(segs: MotionSegment[]): MoveRun[] {
  let runs = moveRuns.get(segs)
  if (runs) return runs
  // Cutting moves only, with arcs drawn as arcs, so what lights up is the path the tool's
  // centre actually takes (toolpathRuns, which says why a rapid does not lose the pen).
  runs = toolpathRuns(segs).map(({ toolId, cmds }) => {
    const path = new Path2D()
    const plunges: [number, number][] = []
    for (const c of cmds) {
      if (c.k === 'M') path.moveTo(c.x, c.y)
      else if (c.k === 'L') path.lineTo(c.x, c.y)
      else if (c.k === 'D') plunges.push([c.x, c.y])
      else path.arc(c.cx, c.cy, c.r, c.a0, c.a1, c.anticlockwise)
    }
    return { toolId, path, plunges }
  })
  moveRuns.set(segs, runs)
  return runs
}

/**
 * The TOOLPATH of whatever the pointer is over in the Toolpaths list (`uiStore.hoverOpIds`)
 * — a row, a tool run or a whole sheet folder — so a toolpath can be found on a crowded
 * drawing before it is clicked to edit. Its own cutting moves, not its source paths: the
 * shape is already on screen, and what the row is asking about is where THIS op cuts —
 * an outside profile and an inside one of the same path lit up identically. And the paths themselves, for a row or folder of
 * the Paths list or a path chip of the strip (`uiStore.hoverPathIds`).
 *
 * In the simulation's layer (CNC space, its own canvas, listening off), not the drawing's:
 * running the pointer down the list changes this many times a second, and on layer 1 each
 * change would repaint the whole drawing. ONE Shape whatever the count (see the canvas
 * CLAUDE.md on N shapes) — a sheet folder can light up hundreds of parts.
 *
 * An operation with no toolpath yet (not generated, or failed) lights its source paths
 * instead, so every row lights SOMETHING up.
 */
export const HoverHighlightLayer = memo(function HoverHighlightLayer({ viewport }: { viewport: Viewport }) {
  const hoverOpIds = useUIStore((s) => s.hoverOpIds)
  const hoverPathIds = useUIStore((s) => s.hoverPathIds)
  const operations = useToolpathStore((s) => s.operations)
  const paths = usePathsStore((s) => s.paths)
  const tools = useToolStore((s) => s.tools)

  const { hitPaths, ownPaths, segRuns } = useMemo(() => {
    const hitPaths: ImportedPath[] = []
    const ownPaths: ImportedPath[] = []
    const segRuns: { segs: MotionSegment[]; toolId: string }[] = []
    if (hoverOpIds.length === 0 && hoverPathIds.length === 0) return { hitPaths, ownPaths, segRuns }
    const byId = new Map(paths.map((p) => [p.id, p]))
    const want = new Set(hoverOpIds)
    const seen = new Set<string>()
    for (const id of new Set(hoverPathIds)) { const p = byId.get(id); if (p) ownPaths.push(p) }
    for (const op of operations) {
      if (!want.has(op.id)) continue
      if (op.segments.length > 0) { segRuns.push({ segs: op.segments, toolId: op.toolId }); continue }
      for (const id of pathIdsOf(op)) {
        const p = byId.get(id)
        if (p && !seen.has(p.id)) { seen.add(p.id); hitPaths.push(p) }
      }
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
        c.save()
        c.lineCap = 'round'
        c.lineJoin = 'round'
        // A soft wide stroke under a crisp one, per colour.
        const glow = (list: Path2D[], colour: string) => {
          if (list.length === 0) return
          c.strokeStyle = colour
          c.globalAlpha = 0.35
          c.lineWidth = 11 * px   // one pixel more each side than it was
          for (const p of list) c.stroke(p)
          c.globalAlpha = 1
          c.lineWidth = 2 * px
          for (const p of list) c.stroke(p)
        }
        glow(ownPaths.map(path2dOf), PATH_GLOW)
        glow(ps, GLOW)
        // A toolpath's glow is THE WIDTH OF ITS BIT (`maxCutRadiusMM`: a taper's widest cut,
        // not its tip), so what lights up is the swath the tool sweeps. Never thinner than
        // the plain glow's centreline, or a fine engraving bit vanishes at low zoom.
        const toolById = new Map(tools.map((t) => [t.id, t]))
        for (const { segs, toolId } of segRuns) {
          for (const run of movesOf(segs)) {
            const tool = toolById.get(run.toolId ?? toolId)
            const width = tool ? 2 * maxCutRadiusMM(tool) : 9 * px
            c.strokeStyle = GLOW
            c.globalAlpha = 0.35
            c.lineWidth = Math.max(width, 3 * px)
            c.stroke(run.path)
            c.globalAlpha = 1
            c.lineWidth = 2 * px
            c.stroke(run.path)
            // A plunge — a drilled hole, a straight-down entry — is the bit's disc, the
            // same swath glow as a cut, ringed at its edge as a cut has its centreline.
            if (run.plunges.length) {
              const r = Math.max(width, 3 * px) / 2
              const discs = new Path2D()
              for (const [x, y] of run.plunges) { discs.moveTo(x + r, y); discs.arc(x, y, r, 0, 2 * Math.PI) }
              c.fillStyle = GLOW
              c.globalAlpha = 0.35
              c.fill(discs)
              c.globalAlpha = 1
              c.stroke(discs)
            }
          }
        }
        c.restore()
      }} />
  )
})
