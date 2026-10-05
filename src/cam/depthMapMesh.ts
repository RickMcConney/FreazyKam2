// A depth-map image as a triangle mesh, so a 3D Profile carves it exactly as it carves an STL.
//
// The 3D Profile's whole machinery — the cell-max height map, the dilation, the ball
// drop-cutter, the waterline, the roughing levels and the stock model — reads triangles
// through `stlToCnc`. Rather than teach each of them a second kind of surface, the picture
// is turned into the surface it describes: one vertex per sample node, Z from brightness,
// two triangles per grid square. Everything downstream is then shared, gouge checks and all.
//
// The mesh is built directly in CNC mm, rotation included, and its bounds are the vertices'
// own XY extent — so `stlToCnc` maps it with scale 1 and nothing is stretched. Z runs 0 …
// `reliefMM`: white (black when inverted) is the model top, the picture's BACKGROUND is the
// floor `reliefMM` below it (`depthMapFloorLevel`), and the levels between are stretched
// to fit. Anything at or darker than the background is cut flat on that floor. A rotated
// picture's box holds ground the picture does not cover; it is read as that floor too.

import type { PhotoImage, PhotoRect } from './photoVcarve'
import type { StlModelBounds } from '../importers/svgImporter'
import type { BBox } from '../canvas/selectionUtils'

/** Sample nodes along the picture's longer side, at most. A finish resolves nothing much
 *  finer than its stepover, and the triangle count goes with the square of this. */
export const DEPTH_MAP_MAX_NODES = 700

/** The relief of a depth map whose op predates the setting. */
export const DEFAULT_RELIEF_MM = 6

export interface DepthMapMesh {
  positions: Float32Array
  indices: Uint32Array
  bounds: StlModelBounds
  /** The mesh's XY extent as the path box `stlToCnc` maps onto — the bounds' own, so the
   *  mapping is the identity. */
  bbox: BBox
}

export interface DepthMapOpts {
  /** Dark is high instead of white. */
  invert?: boolean
  /** Spacing between sample nodes in mm; never finer than a pixel. Unset: as fine as the
   *  picture allows, up to `DEPTH_MAP_MAX_NODES` along the longer side. */
  sampleMM?: number
}

/**
 * The grey level of a depth map's BACKGROUND — the level at and below which the picture is
 * floor — on the "height" scale: plain luminance, or 255 − luminance when dark is high.
 *
 * Not black, and not the darkest pixel. A background that is a dark grey rather than 0 left
 * itself standing proud of the floor the 3D Profile clears round the model, and the cut
 * stepped down at the picture's edge. And the darkest PIXEL is whatever speck of noise
 * happens to be darkest: a JPEG's black background is not black but a spike at 0–1 with a
 * tail of compression specks running out to grey 20 or more (`scratch/3ddog.fkam`), each of
 * which, with 0 as the floor, carved as a bump — half a millimetre proud at grey 12 on a
 * 12 mm relief.
 *
 * So the background is found as what it looks like in the histogram: a SPIKE at the dark
 * end. The tallest (lightly smoothed) bin with no more than 2 % of the picture darker
 * still is its peak; the floor is where its decay stops falling, which takes in the whole noise tail and
 * stops where the picture's own content begins (grey 28 on the dog, whose plaque starts
 * near 55; grey 5 on `scratch/elk.jpg`, whose dark mountains begin almost at once). A
 * picture with no such spike — no flat background, only content — floors at its darkest
 * 0.1 %, so a few specks still cannot set it.
 */
export function depthMapFloorLevel(img: PhotoImage, invert = false): number {
  const hist = new Float64Array(256)
  for (let k = 0; k < img.lum.length; k++) hist[invert ? 255 - img.lum[k] : img.lum[k]]++
  const n = img.lum.length
  const below = new Float64Array(257)   // below[b]: pixels darker than level b
  for (let b = 0; b < 256; b++) below[b + 1] = below[b] + hist[b]
  let p001 = 0, p50 = 0
  while (p001 < 255 && below[p001 + 1] <= n * 0.001) p001++
  while (p50 < 255 && below[p50 + 1] < n * 0.5) p50++
  const s = new Float64Array(256)
  for (let b = 0; b < 256; b++) {
    let sum = 0, cnt = 0
    for (let q = Math.max(0, b - 2); q <= Math.min(255, b + 2); q++) { sum += hist[q]; cnt++ }
    s[b] = sum / cnt
  }
  // The spike is looked for only at the floor END — where at most 2 % of the picture is
  // darker still (room for specks below a grey background, no more). A background is the
  // floor by definition. Searched up to the median as before, the dog's plaque face (a
  // mid-grey, its largest flat region) was taken for the background with Dark is high on:
  // the floor landed at grey 77 and the whole dog, lighter than that, was cut flat.
  let peak = p001
  for (let b = p001; b <= p50 && below[Math.max(0, b - 3)] <= 0.02 * n; b++) if (s[b] > s[peak]) peak = b
  let end = peak
  while (end < 252 && Math.min(s[end + 1], s[end + 2], s[end + 3]) < s[end]) end++
  // A spike stands well above where it ends, and holds a real share of the picture; a
  // smooth histogram's tallest dark bin is neither.
  let mass = 0
  for (let q = Math.max(0, peak - 3); q <= Math.min(255, peak + 3); q++) mass += hist[q]
  const spiky = s[peak] >= 3 * s[end] && mass >= 0.02 * n
  return spiky ? end : p001
}

/**
 * The surface the picture describes, over the rectangle `rect` it sits on (see
 * `extractRectInfo`): its bottom-left corner on `p0`, its bottom edge along `rotationDeg`.
 */
export function depthMapMesh(img: PhotoImage, rect: PhotoRect, reliefMM: number, opts: DepthMapOpts = {}): DepthMapMesh {
  if (!(reliefMM > 0)) throw new Error('The relief depth must be more than zero')
  const W = rect.widthMM, H = rect.heightMM
  const pixelMM = Math.max(W / img.w, H / img.h)
  const spacing = Math.max(pixelMM, opts.sampleMM ?? 0, Math.max(W, H) / (DEPTH_MAP_MAX_NODES - 1))
  const nu = Math.max(2, Math.round(W / spacing) + 1)
  const nv = Math.max(2, Math.round(H / spacing) + 1)

  // Each node is the MEAN of the pixels in its own footprint, not a point sample: a node
  // stands for a whole cell, and a point sample of a noisy or high-resolution picture would
  // carve its noise.
  const levels = sampleBoxMeans(img, nu, nv)
  // The floor end of the range is the picture's background (`depthMapFloorLevel`); the top
  // end stays white (black), so a picture with no white in it still stands below the model
  // top by as much as it is darker. At or below the background is floor.
  const floor = depthMapFloorLevel(img, opts.invert)
  const span = 255 - floor
  const height = (l: number) => {
    if (!(span > 0)) return 1
    const t = ((opts.invert ? 255 - l : l) - floor) / span
    return t < 0 ? 0 : t > 1 ? 1 : t
  }

  const cosR = Math.cos(rect.rotationDeg * Math.PI / 180)
  const sinR = Math.sin(rect.rotationDeg * Math.PI / 180)
  const positions = new Float32Array(nu * nv * 3)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let j = 0; j < nv; j++) {
    const v = (j / (nv - 1)) * H
    for (let i = 0; i < nu; i++) {
      const u = (i / (nu - 1)) * W
      const k = j * nu + i
      const x = rect.p0.x + u * cosR - v * sinR
      const y = rect.p0.y + u * sinR + v * cosR
      positions[k * 3] = x
      positions[k * 3 + 1] = y
      positions[k * 3 + 2] = height(levels[k]) * reliefMM
      // The extent of what the arrays HOLD — float32 — so the mapping is exactly 1.
      const fx = positions[k * 3], fy = positions[k * 3 + 1]
      if (fx < minX) minX = fx
      if (fx > maxX) maxX = fx
      if (fy < minY) minY = fy
      if (fy > maxY) maxY = fy
    }
  }

  const indices = new Uint32Array((nu - 1) * (nv - 1) * 6)
  let t = 0
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i, b = a + 1, c = a + nu, d = c + 1
      indices[t++] = a; indices[t++] = b; indices[t++] = d
      indices[t++] = a; indices[t++] = d; indices[t++] = c
    }
  }

  const bounds: StlModelBounds = { minX, maxX, minY, maxY, minZ: 0, maxZ: reliefMM }
  const bbox: BBox = {
    minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY,
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
  }
  return { positions, indices, bounds, bbox }
}

/**
 * The picture's mean level over each node's footprint, row 0 at the BOTTOM (v runs up the
 * picture while its rows run down). Node (i, j) sits at pixel-space x = i/(nu−1)·w, and its
 * footprint is the pixels within half a node spacing of it — at least the one under it.
 */
function sampleBoxMeans(img: PhotoImage, nu: number, nv: number): Float32Array {
  const out = new Float32Array(nu * nv)
  const sx = img.w / (nu - 1), sy = img.h / (nv - 1)
  // Pixel ranges per column and per row, computed once.
  const span = (n: number, step: number, size: number) => {
    const lo = new Int32Array(n), hi = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const c = i * step
      let a = Math.floor(c - step / 2), b = Math.ceil(c + step / 2) - 1
      a = Math.max(0, Math.min(size - 1, a))
      b = Math.max(a, Math.min(size - 1, b))
      lo[i] = a; hi[i] = b
    }
    return { lo, hi }
  }
  const cols = span(nu, sx, img.w)
  const rows = span(nv, sy, img.h)
  for (let j = 0; j < nv; j++) {
    // Node row j is j/(nv−1) of the way UP the picture: image rows from the bottom.
    const r = nv - 1 - j
    const y0 = rows.lo[r], y1 = rows.hi[r]
    for (let i = 0; i < nu; i++) {
      const x0 = cols.lo[i], x1 = cols.hi[i]
      let sum = 0
      for (let y = y0; y <= y1; y++) {
        const row = y * img.w
        for (let x = x0; x <= x1; x++) sum += img.lum[row + x]
      }
      out[j * nu + i] = sum / ((y1 - y0 + 1) * (x1 - x0 + 1))
    }
  }
  return out
}
