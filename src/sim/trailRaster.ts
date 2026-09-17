// ─── Cut trail raster (2D simulation) ─────────────────────────────────────────
//
// The trail is PAINTED ONCE and then blitted, rather than re-stroked from vector
// geometry on every draw. Same idea as the 3D sim's heightfield texture, and for the
// same reason: a photo v-carve trail is ~8,400 separate polylines, and asking the
// canvas rasterizer to lay all of them down again — with round caps and joins at
// every end — costs tens of milliseconds. Konva redraws its whole layer on any
// change, so that bill came due on every playback frame AND on every pan and zoom
// once the program had finished. Drawing an image costs the same whether the trail
// holds ten segments or a million.
//
// Two things make appending safe:
//   - The strokes are laid down OPAQUE and the whole image is drawn at the trail's
//     opacity by the layer. Overlapping passes therefore can't compound, so redrawing
//     over ground already covered — which every extended polyline does at its joint —
//     changes nothing.
//   - Round caps mean a segment drawn on its own joins its neighbours exactly as it
//     would inside one polyline, so a frame can paint just the segments cut during it.
//
// Resolution follows the viewport: the image is re-painted from scratch when the user
// zooms in past what it holds (a full repaint, once per zoom — not per frame). Beyond
// MAX_SIDE_PX it stops growing and the trail softens, which is a translucent overlay
// going slightly fuzzy at extreme zoom, not a loss of information: the toolpath layer
// draws the same geometry as crisp vectors.

import type { FrustumSeg } from './cutTrail'

// Pixels per mm. The floor keeps a whole-board view from going blocky; the ceiling
// stops a zoomed-in view from allocating a canvas nobody needs.
const RES_MIN = 6
const RES_MAX = 24
// Hard caps on the backing canvas — a large board carved edge to edge would otherwise
// ask for hundreds of MB.
const MAX_SIDE_PX = 4096
const MAX_TOTAL_PX = 12e6
// Re-paint at a higher resolution once the viewport is this much sharper than the
// image. Slack, so a scroll-wheel nudge doesn't trigger a repaint.
const RES_SLACK = 1.4

export interface TrailBBox { x0: number; y0: number; x1: number; y1: number }

export class TrailRaster {
  private _canvas: HTMLCanvasElement | null = null
  private _ctx: CanvasRenderingContext2D | null = null
  private _bbox: TrailBBox = { x0: 0, y0: 0, x1: 0, y1: 0 }
  private _res = 0

  /** The painted image, to be drawn over `bbox` in CNC mm. Null until sized. */
  get canvas(): HTMLCanvasElement | null { return this._canvas }
  get bbox(): TrailBBox { return this._bbox }
  get widthMM(): number { return this._bbox.x1 - this._bbox.x0 }
  get heightMM(): number { return this._bbox.y1 - this._bbox.y0 }

  /**
   * Point the raster at `bbox` (CNC mm) sharp enough for a viewport of `scalePxPerMM`.
   * Returns true when the backing image was (re)allocated — it is blank, and the
   * caller has to repaint the whole trail into it.
   */
  ensure(bbox: TrailBBox, scalePxPerMM: number): boolean {
    const wMM = Math.max(0.001, bbox.x1 - bbox.x0)
    const hMM = Math.max(0.001, bbox.y1 - bbox.y0)

    let res = Math.min(RES_MAX, Math.max(RES_MIN, scalePxPerMM))
    // Fit the caps: the long side first, then total pixels.
    res = Math.min(res, MAX_SIDE_PX / Math.max(wMM, hMM))
    res = Math.min(res, Math.sqrt(MAX_TOTAL_PX / (wMM * hMM)))
    res = Math.max(res, 0.1)

    const sameBox = this._canvas !== null &&
      this._bbox.x0 === bbox.x0 && this._bbox.y0 === bbox.y0 &&
      this._bbox.x1 === bbox.x1 && this._bbox.y1 === bbox.y1
    // Only ever grow the resolution: zooming back out doesn't need a repaint, and
    // repainting on the way out would fire on every wheel step of a zoom gesture.
    if (sameBox && res <= this._res * RES_SLACK) return false

    this._bbox = { ...bbox }
    this._res = Math.max(res, sameBox ? this._res : 0)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(wMM * this._res))
    canvas.height = Math.max(1, Math.round(hMM * this._res))
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    // CNC mm → image px, with Y flipped (image rows run down, CNC Y runs up).
    ctx.setTransform(this._res, 0, 0, -this._res, -bbox.x0 * this._res, bbox.y1 * this._res)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    this._canvas = canvas
    this._ctx = ctx
    return true
  }

  clear(): void {
    if (!this._ctx || !this._canvas) return
    this._ctx.save()
    this._ctx.setTransform(1, 0, 0, 1, 0, 0)
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height)
    this._ctx.restore()
  }

  /** Stroke polylines grouped by cut width (mm) — one path per width. */
  strokePolys(byWidth: Iterable<[number, number[][]]>, color: string): void {
    const ctx = this._ctx
    if (!ctx) return
    ctx.strokeStyle = color
    for (const [width, polys] of byWidth) {
      // A V-bit riding at the surface rounds to zero width: nothing was removed.
      if (width <= 0 || polys.length === 0) continue
      ctx.beginPath()
      for (const pts of polys) {
        ctx.moveTo(pts[0], pts[1])
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1])
      }
      // Never thinner than one pixel, or a shallow cut vanishes from the image
      // entirely instead of reading as a faint line.
      ctx.lineWidth = Math.max(width, 1 / this._res)
      ctx.stroke()
    }
  }

  /** Fill tapered segments (a cut that changes width along its length) as quads. */
  fillFrustums(segs: FrustumSeg[], color: string): void {
    const ctx = this._ctx
    if (!ctx || segs.length === 0) return
    ctx.fillStyle = color
    ctx.beginPath()
    for (const { x0, y0, w0, x1, y1, w1 } of segs) {
      const dx = x1 - x0, dy = y1 - y0
      const len = Math.hypot(dx, dy)
      if (len < 0.0001) continue
      const nx = -dy / len, ny = dx / len
      const r0 = w0 / 2, r1 = w1 / 2
      ctx.moveTo(x0 + nx * r0, y0 + ny * r0)
      ctx.lineTo(x1 + nx * r1, y1 + ny * r1)
      ctx.lineTo(x1 - nx * r1, y1 - ny * r1)
      ctx.lineTo(x0 - nx * r0, y0 - ny * r0)
      ctx.closePath()
    }
    ctx.fill()
  }
}

/**
 * The area the cut trail can occupy: the extent of every cutting move, grown by the
 * widest cut so a stroke's edge isn't clipped. Rapids are excluded — a retract to the
 * far corner would otherwise stretch the image over the whole table and spend the
 * resolution on empty air.
 */
export function cutBBox(
  segments: { x: number; y: number; z: number; prevX: number; prevY: number; prevZ: number; rapid: boolean }[],
  ox: number,
  oy: number,
  marginMM: number,
): TrailBBox | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of segments) {
    if (s.rapid || (s.prevZ >= -0.001 && s.z >= -0.001)) continue
    if (s.prevX < x0) x0 = s.prevX; if (s.prevX > x1) x1 = s.prevX
    if (s.x < x0) x0 = s.x;         if (s.x > x1) x1 = s.x
    if (s.prevY < y0) y0 = s.prevY; if (s.prevY > y1) y1 = s.prevY
    if (s.y < y0) y0 = s.y;         if (s.y > y1) y1 = s.y
  }
  if (!isFinite(x0)) return null
  const m = marginMM
  return { x0: x0 + ox - m, y0: y0 + oy - m, x1: x1 + ox + m, y1: y1 + oy + m }
}
