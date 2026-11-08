// AN STL STANDS AS ITS OUTLINE DOES. The outline is a rectangle that turns with every
// rotate, but everything that reads the model — the Profile 3D cut, the canvas picture, the
// 3D view — fits it into a BOX (`stlToCnc`, cam/stlMapping.ts): the model's XY bounds
// stretched onto the outline's axis-aligned bounding box. Turn the outline 30° and the box
// became the one round the TURNED rectangle, so the model was drawn, shown and cut unturned
// and stretched to fill it, with nothing to say so.
//
// So the turn is put into the MODEL, once, before any of them sees it: the vertices are
// turned (and scaled to mm) to stand as the outline does, and the bounds become the box
// round the turned model box — which is the outline's own bounding box, so `stlToCnc` then
// maps at a scale of 1 and every grid, bucket and scanline that is laid out over that box
// stays correct without knowing about the turn. An outline on the axes is returned
// UNTOUCHED (same arrays, same bounds), so an unturned model is cut byte-for-byte as before.
//
// A MIRRORED outline (Send to Other Side) does not mirror the model — it never has, and that
// is a decision about double-sided work, not this fix. Its corners run the other way round,
// so the turn is read with one axis reversed, choosing the reading nearest unturned: an
// outline mirrored on the axes then stays exactly as it was.

import type { StlModelBounds } from '../importers/svgImporter'
import { parseD } from '../importers/svgImporter'
import { extractRectInfo } from '../canvas/selectionUtils'

export interface PlacedStl {
  positions: Float32Array
  bounds: StlModelBounds
  /** Turned off the axes by other than a multiple of 90°: the box then holds four corners
   *  the model does not cover. */
  turned: boolean
}

interface Axes { xx: number; xy: number; yx: number; yy: number; w: number; h: number }

/** The model's own X and Y axes as the outline `d` holds them, or null when they are the
 *  world's (or the outline is not a rectangle, which falls back to the box as before). */
export function stlAxes(d: string): Axes | null {
  if (!extractRectInfo(d)) return null
  const pts: { x: number; y: number }[] = []
  for (const c of parseD(d)) {
    if (c.t === 'M' || c.t === 'L') pts.push({ x: c.x, y: c.y })
    if (pts.length === 4) break
  }
  const ux = pts[1].x - pts[0].x, uy = pts[1].y - pts[0].y
  const vx = pts[3].x - pts[0].x, vy = pts[3].y - pts[0].y
  const w = Math.hypot(ux, uy), h = Math.hypot(vx, vy)
  let xx = ux / w, xy = uy / w, yx = vx / h, yy = vy / h
  if (xx * yy - xy * yx < 0) {
    // Mirrored: reverse one axis, whichever leaves X pointing nearest +X.
    if (xx < 0 || (xx === 0 && xy < 0)) { xx = -xx; xy = -xy } else { yx = -yx; yy = -yy }
  }
  const EPS = 1e-9
  if (Math.abs(xx - 1) < EPS && Math.abs(yy - 1) < EPS) return null
  return { xx, xy, yx, yy, w, h }
}

// One model turned for one outline, kept while that pair is asked for — the canvas, the 3D
// view and a Generate all ask about the same model, and a big STL is a million vertices.
const memo = new Map<string, { positions: Float32Array; placed: PlacedStl }>()
const MEMO_SIZE = 8

export function placeStlModel(positions: Float32Array, bounds: StlModelBounds, d: string): PlacedStl {
  const a = stlAxes(d)
  if (!a) return { positions, bounds, turned: false }
  const hit = memo.get(d)
  if (hit && hit.positions === positions) return hit.placed

  const modelW = bounds.maxX - bounds.minX, modelH = bounds.maxY - bounds.minY
  if (modelW < 1e-9 || modelH < 1e-9) return { positions, bounds, turned: false }
  const sx = a.w / modelW, sy = a.h / modelH, sz = (sx + sy) / 2
  const mcx = (bounds.minX + bounds.maxX) / 2, mcy = (bounds.minY + bounds.maxY) / 2

  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const lx = (positions[i] - mcx) * sx, ly = (positions[i + 1] - mcy) * sy
    out[i] = lx * a.xx + ly * a.yx
    out[i + 1] = lx * a.xy + ly * a.yy
    out[i + 2] = positions[i + 2] * sz
  }
  // The box round the turned MODEL BOX, not round the vertices: a model that does not fill
  // its own box (a round one in a square) would otherwise be stretched to fill the outline's.
  const ex = (Math.abs(a.xx) * a.w + Math.abs(a.yx) * a.h) / 2
  const ey = (Math.abs(a.xy) * a.w + Math.abs(a.yy) * a.h) / 2
  const placed: PlacedStl = {
    positions: out,
    bounds: { minX: -ex, maxX: ex, minY: -ey, maxY: ey, minZ: bounds.minZ * sz, maxZ: bounds.maxZ * sz },
    turned: Math.abs(a.xx * a.xy) > 1e-6,
  }
  memo.set(d, { positions, placed })
  if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value!)
  return placed
}
