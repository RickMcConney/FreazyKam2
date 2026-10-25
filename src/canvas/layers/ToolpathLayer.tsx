import { memo, useMemo } from 'react'
import { Group, Shape } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import { useToolpathStore, type MotionSegment, type AnyOperation } from '../../store/toolpathStore'
import { usePostProcessorStore, linksAsRapids } from '../../store/postProcessorStore'
import { useToolStore, type Tool } from '../../store/toolStore'
import { maxCutRadiusMM } from '../../cam/geom'
import { makeBatch, groupInto, runBox, strokeBatches, drawFrame, nativeCtx, type Box, type BatchItem, type StrokeBatch } from '../batchDraw'

interface Props {
  viewport: Viewport
}

interface SegmentGroups {
  cutting: number[][]
  rapid: number[][]
  travel: number[][]
  /** Cuts through waste an optimized profile added to join toolpaths (cam/sharedLineProfile). */
  bridge: number[][]
  firstCut: [number, number] | null
}

type SegType = 'cutting' | 'rapid' | 'travel' | 'bridge'

function segType(seg: MotionSegment): SegType {
  if (seg.rapid) return 'rapid'
  if (seg.travel) return 'travel'
  if (seg.bridge) return 'bridge'
  return 'cutting'
}

// Expands an arc MotionSegment to flat [x,y,...] polyline points starting after the given prev position.
function arcToPolyPts(px: number, py: number, seg: MotionSegment): number[] {
  const { cx, cy, cw } = seg.arc!
  const r = Math.hypot(px - cx, py - cy)
  if (r < 0.001) return [seg.x, seg.y]
  let a0 = Math.atan2(py - cy, px - cx)
  let a1 = Math.atan2(seg.y - cy, seg.x - cx)
  const isFullCircle = Math.abs(px - seg.x) < 0.001 && Math.abs(py - seg.y) < 0.001
  if (isFullCircle) a1 = a0 + (cw ? -2 * Math.PI : 2 * Math.PI)
  else if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
  else { if (a1 <= a0) a1 += 2 * Math.PI }
  const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (5 * Math.PI / 180)))
  const pts: number[] = []
  for (let k = 1; k <= steps; k++) {
    const a = a0 + (a1 - a0) * (k / steps)
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  return pts
}

function groupSegments(segments: MotionSegment[]): SegmentGroups {
  const cutting: number[][] = []
  const rapid: number[][] = []
  const travel: number[][] = []
  const bridge: number[][] = []
  let cur: number[] = []
  let curType: SegType = segType(segments[0] ?? { rapid: true, x: 0, y: 0, z: 0 })
  let firstCut: [number, number] | null = null
  let prevX = segments[0]?.x ?? 0
  let prevY = segments[0]?.y ?? 0

  const pushCur = (t: SegType) => {
    if (cur.length >= 4) {
      if (t === 'rapid') rapid.push(cur)
      else if (t === 'travel') travel.push(cur)
      else if (t === 'bridge') bridge.push(cur)
      else cutting.push(cur)
    }
  }

  for (const seg of segments) {
    const pts = seg.arc ? arcToPolyPts(prevX, prevY, seg) : [seg.x, seg.y]
    const st = segType(seg)

    if (st !== curType) {
      pushCur(curType)
      cur = cur.length >= 2 ? [cur[cur.length - 2], cur[cur.length - 1], ...pts] : [...pts]
      curType = st
    } else {
      cur.push(...pts)
    }
    if ((st === 'cutting' || st === 'bridge') && firstCut === null) firstCut = [pts[0], pts[1]]
    prevX = seg.x; prevY = seg.y
  }
  pushCur(curType)

  return { cutting, rapid, travel, bridge, firstCut }
}

// GROUPED ONCE PER TOOLPATH, NOT ONCE PER RENDER. The layer re-renders on every pan and
// zoom frame (its viewport prop), and grouping walked every segment of every visible op,
// expanded every arc and allocated fresh point arrays each time. Segments arrays are
// replaced, never mutated, so an unchanged array has an unchanged grouping; the WeakMap lets
// a toolpath's grouping go when its segments do.
const groupCache = new WeakMap<MotionSegment[], SegmentGroups>()
function groupsFor(segments: MotionSegment[]): SegmentGroups {
  let g = groupCache.get(segments)
  if (!g) {
    g = groupSegments(segments)
    groupCache.set(segments, g)
  }
  return g
}

// ── Batched drawing ───────────────────────────────────────────────────────────
// ALL toolpaths of a style are ONE stroke (canvas/batchDraw), not four Konva nodes and a
// start circle per toolpath: a nest of 2,675 toolpaths was ~13,000 nodes repainted on
// every pan frame. Each toolpath's runs of a style are one `Path2D` with its box, cached on
// the segments array like the grouping above, so a zoomed-in frame strokes only toolpaths
// in view and a regenerate rebuilds only the combined paths, not every op's.

type Style = 'cutting' | 'rapid' | 'travel' | 'bridge'
const runItems = new WeakMap<number[][], BatchItem | null>()
function itemOfRuns(runs: number[][]): BatchItem | null {
  if (runItems.has(runs)) return runItems.get(runs)!
  let item: BatchItem | null = null
  if (runs.length > 0) {
    const path = new Path2D()
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const pts of runs) {
      if (pts.length < 4) continue
      path.moveTo(pts[0], pts[1])
      for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1])
      const b = runBox(pts)
      if (b.minX < minX) minX = b.minX
      if (b.minY < minY) minY = b.minY
      if (b.maxX > maxX) maxX = b.maxX
      if (b.maxY > maxY) maxY = b.maxY
    }
    if (isFinite(minX)) item = { path, minX, minY, maxX, maxY }
  }
  runItems.set(runs, item)
  return item
}

/** A marker drawn at a constant screen size: the cut's start, or a drill hole without a tool. */
interface Dot { x: number; y: number }

interface Drawn {
  strokes: StrokeBatch[]
  /** Drill holes at the tool's radius, in mm — a batch per colour. */
  holes: StrokeBatch[]
  /** Start markers by colour: filled, white-rimmed, 3.5 px. */
  starts: Map<string, Dot[]>
  /** Drill holes whose tool is gone, by colour: a 3.5 px ring. */
  looseHoles: Map<string, Dot[]>
}

function build(operations: AnyOperation[], tools: Tool[], rapidLinks: boolean): Drawn {
  const visible = operations.filter((o) => o.visible && o.status === 'done' && o.segments.length > 0)
  const entries: { key: string; item: BatchItem }[] = []
  const holeEntries: { key: string; item: BatchItem }[] = []
  const starts = new Map<string, Dot[]>()
  const looseHoles = new Map<string, Dot[]>()
  const push = (m: Map<string, Dot[]>, k: string, d: Dot) => {
    const l = m.get(k)
    if (l) l.push(d)
    else m.set(k, [d])
  }
  for (const op of visible) {
    const g = groupsFor(op.segments)
    const add = (style: Style, color: string) => {
      const item = itemOfRuns(g[style])
      if (item) entries.push({ key: `${style}|${color}`, item })
    }
    add('cutting', op.color)
    add('rapid', '#e53e3e')
    add('bridge', '#f97316')
    add('travel', rapidLinks ? '#e53e3e' : '#38a169')
    if (op.type === 'drill') {
      const tool = tools.find((t) => t.id === op.toolId)
      const r = tool ? maxCutRadiusMM(tool) : 0
      for (const pt of op.points) {
        if (r > 0) {
          const path = new Path2D()
          path.arc(pt.x, pt.y, r, 0, 2 * Math.PI)
          holeEntries.push({ key: op.color, item: { path, minX: pt.x - r, minY: pt.y - r, maxX: pt.x + r, maxY: pt.y + r } })
        } else push(looseHoles, op.color, pt)
      }
    } else if (g.firstCut) {
      push(starts, op.color, { x: g.firstCut[0], y: g.firstCut[1] })
    }
  }
  const STYLE: Record<Style, Omit<StrokeBatch, 'color' | 'batch'>> = {
    cutting: { widthPx: 1.5, opacity: 0.9, round: true },
    rapid: { widthPx: 1.2, opacity: 0.75, round: true, dashPx: [5, 4] },
    bridge: { widthPx: 2.2, opacity: 0.95, round: true },
    travel: { widthPx: 1.2, opacity: 0.75, round: true, dashPx: rapidLinks ? [5, 4] : [4, 3] },
  }
  // Drawn in the order the per-op nodes stacked: cuts, rapids, bridges, links.
  const order: Style[] = ['cutting', 'rapid', 'bridge', 'travel']
  const grouped = [...groupInto(entries)]
  const strokes: StrokeBatch[] = []
  for (const style of order) {
    for (const [key, items] of grouped) {
      const i = key.indexOf('|')
      if (key.slice(0, i) !== style) continue
      strokes.push({ ...STYLE[style], color: key.slice(i + 1), batch: makeBatch(items) })
    }
  }
  const holes = [...groupInto(holeEntries)].map(([color, items]) => (
    { color, widthPx: 1.5, opacity: 0.9, batch: makeBatch(items) }
  ))
  return { strokes, holes, starts, looseHoles }
}

const MARKER_PX = 3.5
// A start marker is 3.5 px up close but never more than this across the stock, so zoomed
// out it shrinks with the parts: a fixed screen size on a nest of thousands of toolpaths
// was a carpet of dots over the drawing.
const START_MAX_MM = 1

function drawDots(c: CanvasRenderingContext2D, dots: Map<string, Dot[]>, ppu: number, view: Box, filled: boolean) {
  const r = filled ? Math.min(MARKER_PX / ppu, START_MAX_MM) : MARKER_PX / ppu
  for (const [color, list] of dots) {
    const p = new Path2D()
    let any = false
    for (const d of list) {
      if (d.x + r < view.minX || d.x - r > view.maxX || d.y + r < view.minY || d.y - r > view.maxY) continue
      p.moveTo(d.x + r, d.y)
      p.arc(d.x, d.y, r, 0, 2 * Math.PI)
      any = true
    }
    if (!any) continue
    c.save()
    if (filled) {
      c.globalAlpha = 0.95
      c.fillStyle = color
      c.fill(p)
      c.strokeStyle = '#ffffff'
      // The rim shrinks with the dot, or a tiny dot is all rim.
      c.lineWidth = Math.min(1 / ppu, r * 0.3)
    } else {
      c.globalAlpha = 0.9
      c.strokeStyle = color
      c.lineWidth = 1.5 / ppu
    }
    c.stroke(p)
    c.restore()
  }
}

export const ToolpathLayer = memo(function ToolpathLayer(_props: Props) {
  // Selectors, not whole-store destructuring: the tool store has nothing to say about a
  // toolpath but its drill radius, and the toolpath store's other fields change on writes
  // this layer does not draw.
  const operations = useToolpathStore((s) => s.operations)
  const tools = useToolStore((s) => s.tools)
  // Stay-down links are drawn as what the machine will be sent: rapids when the active
  // post-processor emits them as G0 (linksAsRapids), the green link style when they go out
  // as G1 at a travel feed. The segments carry `travel` either way; only the G-code differs.
  const rapidLinks = usePostProcessorStore((s) => linksAsRapids(s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0]))

  // Nothing here depends on the viewport: widths, dashes and markers are in screen pixels,
  // converted inside the draw, so a pan or zoom only repaints.
  // The scene function is the same object until the toolpaths change — a new one would
  // make Konva redraw the layer on every stage re-render (the cursor readout is enough).
  const sceneFunc = useMemo(() => {
    const drawn = build(operations, tools, rapidLinks)
    return (ctx: Konva.Context, shape: Konva.Shape) => {
      strokeBatches(ctx, shape, drawn.strokes)
      strokeBatches(ctx, shape, drawn.holes)
      const { ppu, view } = drawFrame(shape)
      const c = nativeCtx(ctx)
      drawDots(c, drawn.looseHoles, ppu, view, false)
      drawDots(c, drawn.starts, ppu, view, true)
    }
  }, [operations, tools, rapidLinks])

  return (
    <Group name="toolpaths" listening={false}>
      <Shape
        sceneFunc={sceneFunc}
        listening={false}
        perfectDrawEnabled={false}
      />
    </Group>
  )
})
