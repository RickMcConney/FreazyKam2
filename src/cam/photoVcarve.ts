// ─── Photo V-Carve ────────────────────────────────────────────────────────────
//
// Carves a greyscale photograph as a field of parallel V-grooves. One raster line =
// one continuous groove; the V-bit rides at a depth set by the image brightness under
// it — dark pixels deep, light pixels shallow. Because a V-bit cuts WIDER the deeper
// it goes, varying the depth varies the groove width, and the picture appears as the
// pattern of light and dark the ridges between the grooves cast.
//
//   grooveWidth(d) = 2·d·tan(θ/2)      θ = the bit's included angle
//
// That is the one piece of machining behind the whole operation, and it also fixes the
// line spacing, which is why the operation has no stepover setting. Space the lines
// wider than the deepest groove and bare stock is left between them; space them
// tighter and the deep grooves cut away the ridges either side of them, which are the
// very thing carrying the image. So the lines sit exactly one full-depth groove apart:
//
//   lineSpacing = grooveWidth(maxDepth) = 2·maxDepth·tan(θ/2)   ← lineSpacingMM()
//
// The darkest areas then just touch their neighbours, and everything lighter leaves
// progressively more uncut land between grooves — which is what reads as a lighter
// tone. Depth is therefore the only control over resolution: a shallower carve is a
// finer one, and a deeper carve trades detail for contrast.
//
// The grooves are continuous — a white run is cut at `minDepthMM` rather than lifted
// out. At the usual minDepth of 0 that means the tip skims the surface across the
// background, which is what a photo carve wants: a lift-and-plunge per white run
// would fragment every line into hundreds of retracts on a noisy photograph, and the
// re-entry marks would show.
//
// The same argument links the lines to each other. Cut serpentine, a line ends one
// stepover from where the next one starts, so the tool is already there: it stays down
// and cuts across, and the whole carve is one plunge and one retract instead of two
// rapids and a plunge per line. The link runs along the edge of the picture, between
// two grooves that a full-depth pixel would have joined anyway.
//
// Depths here are measured DOWN from `zStartMM` — the surface the picture is carved
// into, which is stock top (0) on bare material and a pocket floor when the photo sits
// in one (cam/startHeight.ts resolves it). Emitted Z is the tool tip, like every other
// generator.

import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import { douglasPeucker, type Pt2 } from './pathFlattener'
import { reportProgress } from './progress'
import { perfLog } from '../debug'

/** A decoded image: row-major luminance, 0 = black … 255 = white, row 0 is the TOP. */
export interface PhotoImage {
  lum: Uint8Array
  w: number
  h: number
}

/**
 * Where an image-backed path puts its picture, in CNC mm. Same parametrisation the
 * canvas draws with (see extractRectInfo): the image's bottom-left corner sits on
 * `p0`, its bottom edge runs along `rotationDeg`, and its top edge is `heightMM` away
 * on the CCW side of that edge. Toolpath and canvas therefore agree by construction,
 * including for a rotated image.
 */
export interface PhotoRect {
  p0: { x: number; y: number }
  widthMM: number
  heightMM: number
  rotationDeg: number
}

export interface PhotoVCarveParams {
  angleDeg: number       // V-bit included angle
  passAngleDeg: number   // raster direction, CCW from the image's own bottom edge
  minDepthMM: number     // depth where the image is white
  maxDepthMM: number     // depth where the image is black
  zStartMM?: number      // surface the depths are measured from (0 = stock top)
  safeHeightMM?: number
}

/** Width of the cut a V-bit of included angle `angleDeg` leaves at depth `depthMM`. */
export function grooveWidthMM(depthMM: number, angleDeg: number): number {
  return 2 * depthMM * Math.tan((angleDeg / 2) * Math.PI / 180)
}

// Below this the derived spacing stops describing a carve and starts describing a
// hang: a 0.01 mm depth on a 90° bit asks for 0.02 mm lines, which is 5000 passes
// across a 100 mm photo for a cut no eye or cutter resolves.
const MIN_LINE_SPACING_MM = 0.05

/**
 * The line spacing for a carve `maxDepthMM` deep with a `angleDeg` bit — the width of
 * the deepest groove, so the darkest lines just meet. The generator uses this; the form
 * shows it. Never a stored operation setting: it is a consequence of the depth.
 */
export function lineSpacingMM(maxDepthMM: number, angleDeg: number): number {
  return Math.max(MIN_LINE_SPACING_MM, grooveWidthMM(maxDepthMM, angleDeg))
}

// Emitted points, before simplification. A 200×150 mm photo at 0.3 mm stepover is
// already 500 lines; without a ceiling a high-resolution source would hand the
// emitter tens of millions of points and hang the app. Hitting it coarsens the
// spacing ALONG the lines only — the line count (and so the visible resolution of
// the carve) is the user's stepover and is never touched.
const MAX_SAMPLES = 400_000

// Deviation allowed when thinning the depth profile of a groove. Well under what a
// V-bit resolves, so this only drops points a straight run would have repeated.
const DP_TOL_MM = 0.005

/** Bilinear luminance at image-local (u, v) mm, returned 0 (black) … 1 (white). */
function sampleLum(img: PhotoImage, u: number, v: number, widthMM: number, heightMM: number): number {
  // Pixel centres sit at +0.5, and v runs UP the image while rows run down it.
  const fx = (u / widthMM) * img.w - 0.5
  const fy = (1 - v / heightMM) * img.h - 0.5
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const tx = fx - x0, ty = fy - y0
  const cx0 = x0 < 0 ? 0 : x0 > img.w - 1 ? img.w - 1 : x0
  const cy0 = y0 < 0 ? 0 : y0 > img.h - 1 ? img.h - 1 : y0
  const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 > img.w - 1 ? img.w - 1 : x0 + 1
  const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 > img.h - 1 ? img.h - 1 : y0 + 1
  const l00 = img.lum[cy0 * img.w + cx0], l10 = img.lum[cy0 * img.w + cx1]
  const l01 = img.lum[cy1 * img.w + cx0], l11 = img.lum[cy1 * img.w + cx1]
  const top = l00 + (l10 - l00) * tx
  const bot = l01 + (l11 - l01) * tx
  return (top + (bot - top) * ty) / 255
}

/**
 * Clip the line `P(t) = b·n̂ + t·d̂` to the rectangle [0,W]×[0,H] (Liang–Barsky).
 * Returns null when the line misses the rectangle.
 */
function clipToRect(
  bx: number, by: number, dx: number, dy: number, W: number, H: number,
): { t0: number; t1: number } | null {
  let t0 = -Infinity, t1 = Infinity
  const ps = [-dx, dx, -dy, dy]
  const qs = [bx - 0, W - bx, by - 0, H - by]
  for (let i = 0; i < 4; i++) {
    const p = ps[i], q = qs[i]
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null          // parallel to this edge and outside it
      continue
    }
    const r = q / p
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r }
    else       { if (r < t0) return null; if (r < t1) t1 = r }
  }
  return t1 - t0 > 1e-9 ? { t0, t1 } : null
}

export function generatePhotoVCarve(
  img: PhotoImage,
  rect: PhotoRect,
  tool: Tool,
  params: PhotoVCarveParams,
): MotionSegment[] {
  if (tool.type !== 'vbit') throw new Error('Photo V-Carve requires a V-bit tool')
  if (img.w < 1 || img.h < 1 || img.lum.length < img.w * img.h) throw new Error('Image has no pixel data')
  const W = rect.widthMM, H = rect.heightMM
  if (!(W > 0.001) || !(H > 0.001)) throw new Error('Image has zero size on the workpiece')
  if (!(params.maxDepthMM > 0)) throw new Error('Depth at black must be greater than zero')
  // Not a setting — the deepest groove's own width (see the header).
  const stepover = lineSpacingMM(params.maxDepthMM, params.angleDeg)

  const safeZ = params.safeHeightMM ?? 5
  const zStart = params.zStartMM ?? 0
  const minD = params.minDepthMM
  const spanD = params.maxDepthMM - params.minDepthMM
  const _t0 = performance.now()

  // Raster frame, in the image's own coordinates: d̂ along the lines, n̂ across them.
  const th = params.passAngleDeg * Math.PI / 180
  const dx = Math.cos(th), dy = Math.sin(th)
  const nx = -dy, ny = dx

  // The band of line offsets the image spans, from its four corners.
  const corners: [number, number][] = [[0, 0], [W, 0], [W, H], [0, H]]
  let bMin = Infinity, bMax = -Infinity
  for (const [cu, cv] of corners) {
    const b = cu * nx + cv * ny
    if (b < bMin) bMin = b
    if (b > bMax) bMax = b
  }

  // Exactly `stepover` apart, centred in the band, so the leftover margin is split
  // between the two edges instead of piling up on one of them.
  const span = bMax - bMin
  const lineCount = Math.max(1, Math.floor(span / stepover) + 1)
  const pad = (span - (lineCount - 1) * stepover) / 2

  // Clip every line first: the total cut length is what sets the sample spacing.
  const lines: { b: number; t0: number; t1: number }[] = []
  let totalLen = 0
  for (let i = 0; i < lineCount; i++) {
    const b = bMin + pad + i * stepover
    const clip = clipToRect(b * nx, b * ny, dx, dy, W, H)
    if (!clip) continue
    lines.push({ b, t0: clip.t0, t1: clip.t1 })
    totalLen += clip.t1 - clip.t0
  }
  if (lines.length === 0) return []

  // Along-line spacing: fine enough to resolve a pixel, never finer than half a
  // stepover (detail the neighbouring grooves would erase anyway), and stretched if
  // the whole carve would otherwise blow the sample budget.
  const pxMM = Math.min(W / img.w, H / img.h)
  let ds = Math.max(0.05, Math.min(pxMM, stepover / 2))
  if (totalLen / ds > MAX_SAMPLES) ds = totalLen / MAX_SAMPLES

  const cosR = Math.cos(rect.rotationDeg * Math.PI / 180)
  const sinR = Math.sin(rect.rotationDeg * Math.PI / 180)
  const worldX = (u: number, v: number) => rect.p0.x + u * cosR - v * sinR
  const worldY = (u: number, v: number) => rect.p0.y + u * sinR + v * cosR

  // How far apart two lines' facing ends may be before the tool lifts between them
  // instead of cutting across. Serpentine ends sit one stepover apart when the raster
  // runs square to the edge it exits through, and stepover/sin(angle) when it doesn't —
  // so the allowance is in stepovers, not mm. What it catches is the corner of the
  // rectangle, where a line exiting the top edge follows one that exited the side and
  // the two ends can be most of an edge apart; dragging the bit along that would carve
  // a border into the picture.
  const maxLink = 3 * stepover

  const segs: MotionSegment[] = []
  // Where the previous line left the tool, at cutting depth. Null before the first.
  let prevEnd: { x: number; y: number } | null = null
  for (let li = 0; li < lines.length; li++) {
    const { b, t0, t1 } = lines[li]
    const bu = b * nx, bv = b * ny

    // (t, z) profile of this groove. XY is linear in t, so thinning here is exactly
    // thinning the 3D path — no XY error is introduced.
    const prof: Pt2[] = []
    // Stops short of t1 so the exact end point below isn't duplicated by a step that
    // floating-point rounding put a hair inside it.
    for (let t = t0; t < t1 - 1e-9; t += ds) {
      const u = bu + t * dx, v = bv + t * dy
      const depth = minD + (1 - sampleLum(img, u, v, W, H)) * spanD
      prof.push([t, zStart - Math.max(0, depth)])
    }
    {
      const u = bu + t1 * dx, v = bv + t1 * dy
      const depth = minD + (1 - sampleLum(img, u, v, W, H)) * spanD
      prof.push([t1, zStart - Math.max(0, depth)])
    }

    const thinned = douglasPeucker(prof, DP_TOL_MM)
    // Serpentine: cut back the way we came, so the move between lines is one
    // stepover instead of the length of the image.
    if (li % 2 === 1) thinned.reverse()

    const [ft, fz] = thinned[0]
    const fx = worldX(bu + ft * dx, bv + ft * dy), fy = worldY(bu + ft * dx, bv + ft * dy)
    if (prevEnd && Math.hypot(fx - prevEnd.x, fy - prevEnd.y) <= maxLink) {
      // Already there — cut across to the next groove rather than lift and re-plunge.
      segs.push({ x: fx, y: fy, z: fz, rapid: false })
    } else {
      if (prevEnd) segs.push({ x: prevEnd.x, y: prevEnd.y, z: safeZ, rapid: true })
      segs.push({ x: fx, y: fy, z: safeZ, rapid: true })
      segs.push({ x: fx, y: fy, z: fz, rapid: false })
    }
    for (let i = 1; i < thinned.length; i++) {
      const [t, z] = thinned[i]
      const u = bu + t * dx, v = bv + t * dy
      segs.push({ x: worldX(u, v), y: worldY(u, v), z, rapid: false })
    }
    const [lt] = thinned[thinned.length - 1]
    prevEnd = { x: worldX(bu + lt * dx, bv + lt * dy), y: worldY(bu + lt * dx, bv + lt * dy) }

    reportProgress((li + 1) / lines.length, 'carving')
  }
  if (prevEnd) segs.push({ x: prevEnd.x, y: prevEnd.y, z: safeZ, rapid: true })

  perfLog(`[photovcarve] ${lines.length} lines, ds=${ds.toFixed(3)}mm → ${segs.length} segs in ${(performance.now() - _t0).toFixed(0)}ms`)
  return segs
}
