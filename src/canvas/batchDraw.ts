// Drawing thousands of outlines as a handful of strokes, skipping what is off screen.
//
// WHY: a Konva node per path costs a transform, a save/restore and an attribute pass per
// node per frame, and Konva redraws every node of a layer on every pan and zoom frame
// whether it is on screen or not. On a nest (2,677 paths, 2,675 toolpaths, five nodes per
// toolpath) that was the whole cost of a pan. Here each outline is a cached `Path2D` with
// its box; a `Batch` is the outlines that share one stroke style, kept also as ONE combined
// `Path2D`. A frame strokes the combined path when everything is in view, or a path made
// of just the members that are, so a zoomed-in pan strokes only what you can see.
//
// The batches hold still while the user pans — nothing here depends on the viewport. The
// line width and dashes are given in SCREEN pixels and converted inside the draw from the
// shape's own absolute transform, so a zoom repaints without React re-rendering anything,
// and a batch drawn under a live scale (the drag preview) keeps a constant screen width.
import type Konva from 'konva'

export interface Box { minX: number; minY: number; maxX: number; maxY: number }

export interface BatchItem extends Box { path: Path2D }

export interface Batch extends Box {
  items: BatchItem[]
  /** Every member in one path — what a frame strokes when all of them are in view. */
  all: Path2D
}

export interface StrokeStyle {
  color: string
  /** Screen pixels. */
  widthPx: number
  opacity?: number
  /** Screen pixels. */
  dashPx?: number[]
  round?: boolean
}

export interface StrokeBatch extends StrokeStyle { batch: Batch }

export function makeBatch(items: BatchItem[]): Batch {
  const all = new Path2D()
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const it of items) {
    all.addPath(it.path)
    if (it.minX < minX) minX = it.minX
    if (it.minY < minY) minY = it.minY
    if (it.maxX > maxX) maxX = it.maxX
    if (it.maxY > maxY) maxY = it.maxY
  }
  return { items, all, minX, minY, maxX, maxY }
}

/** Batches keyed by a style key, in first-seen order. */
export function groupInto<K>(
  entries: Iterable<{ key: K; item: BatchItem }>,
): Map<K, BatchItem[]> {
  const m = new Map<K, BatchItem[]>()
  for (const { key, item } of entries) {
    const list = m.get(key)
    if (list) list.push(item)
    else m.set(key, [item])
  }
  return m
}

/** Box of a flat [x, y, x, y, …] run. */
export function runBox(pts: number[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * What the shape draws at: screen pixels per local unit (the geometric mean of the axes,
 * so a non-uniform live scale gets the width the old per-node compensation gave it), and
 * the stage rectangle in the shape's local units, widened by `padPx` pixels.
 */
export function drawFrame(shape: Konva.Shape, padPx = 4): { ppu: number; view: Box } {
  const tr = shape.getAbsoluteTransform()
  const [a, b, c, d] = tr.getMatrix()
  const ppu = Math.sqrt(Math.abs(a * d - b * c)) || 1
  const stage = shape.getStage()
  const inv = tr.copy().invert()
  const w = stage?.width() ?? 0, h = stage?.height() ?? 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [sx, sy] of [[-padPx, -padPx], [w + padPx, -padPx], [-padPx, h + padPx], [w + padPx, h + padPx]]) {
    const p = inv.point({ x: sx, y: sy })
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { ppu, view: { minX, minY, maxX, maxY } }
}

export function overlaps(a: Box, b: Box): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY
}

function contains(outer: Box, inner: Box): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY
}

/** The members of `batch` in view, as one path — or null when none is. */
export function visiblePath(batch: Batch, view: Box): Path2D | null {
  if (batch.items.length === 0 || !overlaps(batch, view)) return null
  if (contains(view, batch)) return batch.all
  let p: Path2D | null = null
  for (const it of batch.items) {
    if (!overlaps(it, view)) continue
    if (!p) p = new Path2D()
    p.addPath(it.path)
  }
  return p
}

/** The native context behind Konva's wrapper — `Path2D` strokes go straight to it. */
export function nativeCtx(ctx: Konva.Context): CanvasRenderingContext2D {
  return (ctx as unknown as { _context: CanvasRenderingContext2D })._context
}

export function strokeBatches(ctx: Konva.Context, shape: Konva.Shape, batches: StrokeBatch[]): void {
  const { ppu, view } = drawFrame(shape)
  const c = nativeCtx(ctx)
  for (const s of batches) {
    const p = visiblePath(s.batch, view)
    if (!p) continue
    c.save()
    c.globalAlpha = s.opacity ?? 1
    c.strokeStyle = s.color
    c.lineWidth = s.widthPx / ppu
    if (s.round) { c.lineJoin = 'round'; c.lineCap = 'round' }
    if (s.dashPx) c.setLineDash(s.dashPx.map((v) => v / ppu))
    c.stroke(p)
    c.restore()
  }
}
