import { memo, useMemo } from 'react'
import { Shape } from 'react-konva'
import type { Viewport } from '../viewport'
import { useUIStore } from '../../store/uiStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useToolpathStore, pathIdsOf, type MotionSegment } from '../../store/toolpathStore'
import { useToolStore } from '../../store/toolStore'
import { maxCutRadiusMM, toolRadiusAtHeight } from '../../cam/geom'
import { toolpathRuns, swathRuns, type RunCmd } from '../toolpathRuns'
import type { Tool } from '../../store/toolStore'

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

// The swath, per segments array and per (tool, surface) it was measured for: a V-carve's
// depth-dependent widths are worked out once per hover target, not on every redraw.
interface SwathGroup { toolId: string | null; widths: { width: number; path: Path2D; discs: [number, number][] }[] }
const swaths = new WeakMap<MotionSegment[], { key: string; tools: readonly Tool[]; groups: SwathGroup[] }>()
function swathOf(segs: MotionSegment[], tools: readonly Tool[], toolFor: (id: string | null) => Tool | undefined, surfaceZ: number, key: string): SwathGroup[] {
  const hit = swaths.get(segs)
  if (hit && hit.key === key && hit.tools === tools) return hit.groups
  // How wide the tool cuts at z: its radius that far above its tip, the surface being the
  // op's own start (a carve into a pocket floor is measured from the floor). Above the
  // surface it cuts nothing, so the glow is its centreline alone there.
  const widthAt = (id: string | null, z: number) => {
    const tool = toolFor(id)
    if (!tool) return 0
    return Math.min(2 * maxCutRadiusMM(tool), 2 * toolRadiusAtHeight(tool, Math.max(0, surfaceZ - z)))
  }
  const toPath = (cmds: RunCmd[]) => {
    const path = new Path2D()
    const discs: [number, number][] = []
    for (const c of cmds) {
      if (c.k === 'M') path.moveTo(c.x, c.y)
      else if (c.k === 'L') path.lineTo(c.x, c.y)
      else if (c.k === 'D') discs.push([c.x, c.y])
      else path.arc(c.cx, c.cy, c.r, c.a0, c.a1, c.anticlockwise)
    }
    return { path, discs }
  }
  const groups = swathRuns(segs, widthAt).map((r) => ({
    toolId: r.toolId,
    widths: [...r.byWidth].map(([width, cmds]) => ({ width, ...toPath(cmds) })),
  }))
  swaths.set(segs, { key, tools, groups })
  return groups
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
 * An operation with no toolpath yet (not generated, or failed), or a hidden one, lights its
 * source paths instead, so every row lights SOMETHING up.
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
    const segRuns: { segs: MotionSegment[]; toolId: string; surfaceZ: number }[] = []
    if (hoverOpIds.length === 0 && hoverPathIds.length === 0) return { hitPaths, ownPaths, segRuns }
    const byId = new Map(paths.map((p) => [p.id, p]))
    const want = new Set(hoverOpIds)
    const seen = new Set<string>()
    for (const id of new Set(hoverPathIds)) { const p = byId.get(id); if (p) ownPaths.push(p) }
    for (const op of operations) {
      if (!want.has(op.id)) continue
      // A HIDDEN op's toolpath is not drawn, so hovering it must not draw it either — the
      // pointer is still on the row when its eye is clicked, and the glow read as the hide
      // not working. It lights its source paths, like an op with no toolpath.
      if (op.visible && op.segments.length > 0) { segRuns.push({ segs: op.segments, toolId: op.toolId, surfaceZ: op.generatedWith?.startZMM ?? 0 }); continue }
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
        // A toolpath's glow is THE SWATH ITS BIT CUTS: at each move, the width the tool cuts
        // at that depth (`swathRuns`) — a straight-walled bit's own width, a V-bit's only as
        // wide as the carve, never wider than the bit (`maxCutRadiusMM`: a taper's widest
        // cut, not its tip). Never thinner than the plain glow's centreline, or a fine
        // engraving vanishes at low zoom. The centreline is drawn over it, crisp.
        const toolById = new Map(tools.map((t) => [t.id, t]))
        for (const { segs, toolId, surfaceZ } of segRuns) {
          const toolFor = (id: string | null) => toolById.get(id ?? toolId)
          // Rebuilt when the toolpath, its tool, its surface or the tool library changes.
          for (const group of swathOf(segs, tools, toolFor, surfaceZ, `${surfaceZ}|${toolId}`)) {
            for (const { width, path, discs } of group.widths) {
              const w = Math.max(width, 3 * px)
              c.strokeStyle = GLOW
              c.globalAlpha = 0.35
              c.lineWidth = w
              c.stroke(path)
              // A plunge — a drilled hole, a straight-down entry — is the bit's disc at the
              // depth it reaches, the same swath glow as a cut, ringed at its edge.
              if (discs.length) {
                const r = w / 2
                const d2 = new Path2D()
                for (const [x, y] of discs) { d2.moveTo(x + r, y); d2.arc(x, y, r, 0, 2 * Math.PI) }
                c.fillStyle = GLOW
                c.fill(d2)
                c.globalAlpha = 1
                c.lineWidth = 2 * px
                c.stroke(d2)
              }
            }
          }
          c.globalAlpha = 1
          c.lineWidth = 2 * px
          for (const run of movesOf(segs)) c.stroke(run.path)
        }
        c.restore()
      }} />
  )
})
