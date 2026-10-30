// A picture of the finished part for the head of a G-code file — the PNG thumbnail block
// Klipper's Moonraker reads (and Mainsail/Fluidd show in the file list), in the form
// PrusaSlicer/OrcaSlicer write it:
//
//   ;
//   ; thumbnail begin 300x300 23952        ← W x H, then the base64 length
//   ; iVBORw0KGgo…                          ← 78 base64 characters a line
//   ; thumbnail end
//
// Always `;` comments whatever the profile's comment style: Moonraker looks for exactly
// that prefix, and every controller we ship a preset for takes `;` as a comment.
//
// The picture is the program's own toolpaths carved into a height map on the image grid —
// each cutting move swept with its tool's real profile (toolProfileHeightMM, so a V-carve
// comes out as a V and a ball raster as a relief) — then shaded by depth with a light from
// the top left. Stock is laid out as the drawing is seen (Y up), fitted and centred in a
// square image; everything off the stock is transparent.
//
// An ICON (under ICON_MAX_PX — Mainsail's file-list picture) is drawn differently, because
// the preview's way leaves nothing to tell one file from the next at 32 px: a design on a
// third of the board got ten pixels, and averaging ten source pixels into one washed every
// V-carve and engraving line out to the colour of the stock. So an icon is framed on the CUT
// AREA, not the stock, each of its pixels leans to the DEEPEST cut inside it (a 0.5 mm line is
// still a dark pixel), and depth is read against the job's deepest cut, not the stock's
// thickness, so a shallow engraving reads as dark as a cut-out.
import { zlibSync } from 'fflate'
import type { AnyOperation } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import { maxCutRadiusMM, toolProfileHeightMM } from './geom'

/** Mainsail's recommended pair: a list icon and a file-browser preview. */
export const THUMBNAIL_SIZES = [32, 300] as const

const SUPERSAMPLE_PX = 600   // the height map is carved once at this size and averaged down
const ICON_MAX_PX = 100      // below this a thumbnail is an icon (see the header)
const ICON_OVERSAMPLE = 8    // icon source pixels per icon pixel, each way
const BASE64_LINE = 78

export interface ThumbnailStock { widthMM: number; heightMM: number; thicknessMM: number }

/** The `;` comment lines of every thumbnail block, smallest first. */
export function thumbnailLines(
  operations: AnyOperation[], toolsById: Record<string, Tool>, stock: ThumbnailStock,
  startToolId: (op: AnyOperation) => string, sizes: readonly number[] = THUMBNAIL_SIZES,
): string[] {
  if (!(stock.widthMM > 0 && stock.heightMM > 0)) return []
  const { widthMM: W, heightMM: H } = stock
  const side = Math.max(W, H)
  const whole: View = { x0: (W - side) / 2, y0: (H - side) / 2, size: side }
  const previews = sizes.filter((n) => n >= ICON_MAX_PX)
  let preview: { rgba: Uint8ClampedArray; M: number } | undefined
  if (previews.length) {
    const big = Math.max(...previews)
    // Whole multiples of each size where it matters most: the large one.
    const M = Math.max(big, Math.round(SUPERSAMPLE_PX / big) * big)
    preview = { rgba: shade(carve(operations, toolsById, stock, whole, startToolId, M), M, stock.thicknessMM), M }
  }
  const cutView = iconView(operations, toolsById, stock, startToolId) ?? whole
  const out: string[] = []
  for (const n of [...sizes].sort((a, b) => a - b)) {
    const rgba = n < ICON_MAX_PX || !preview
      ? icon(carve(operations, toolsById, stock, cutView, startToolId, n * ICON_OVERSAMPLE), n)
      : downsample(preview.rgba, preview.M, n)
    const b64 = base64(encodePng(rgba, n, n))
    out.push(';', `; thumbnail begin ${n}x${n} ${b64.length}`)
    for (let i = 0; i < b64.length; i += BASE64_LINE) out.push(`; ${b64.slice(i, i + BASE64_LINE)}`)
    out.push('; thumbnail end')
  }
  out.push(';')
  return out
}

/** The square of the drawing an image shows: lower-left corner and side, in mm. */
interface View { x0: number; y0: number; size: number }

interface HeightMap {
  /** Surface height per pixel, top-referenced (0 = stock top); NaN = off the stock. */
  z: Float32Array
  pxPerMM: number
}

function carve(
  operations: AnyOperation[], toolsById: Record<string, Tool>, stock: ThumbnailStock, view: View,
  startToolId: (op: AnyOperation) => string, M: number,
): HeightMap {
  const { widthMM: W, heightMM: H } = stock
  const s = M / view.size
  // Pixel column i, row j (row 0 at the TOP of the image = the view's Y max) has its centre
  // at x = x0 + (i + .5)/s, y = y0 + (M − j − .5)/s.
  const px = (x: number) => (x - view.x0) * s - 0.5
  const py = (y: number) => M - (y - view.y0) * s - 0.5
  const z = new Float32Array(M * M).fill(NaN)
  const i0 = Math.max(0, Math.ceil(px(0))), i1 = Math.min(M - 1, Math.floor(px(W)))
  const j0 = Math.max(0, Math.ceil(py(H))), j1 = Math.min(M - 1, Math.floor(py(0)))
  for (let j = j0; j <= j1; j++) if (i1 >= i0) z.fill(0, j * M + i0, j * M + i1 + 1)

  // The tool profile tabulated by pixel distance — sampled at an eighth of a pixel.
  const LUT_STEP = 1 / 8
  const luts = new Map<string, { h: Float32Array; rPx: number }>()
  const lutFor = (tool: Tool) => {
    let l = luts.get(tool.id)
    if (!l) {
      const rPx = maxCutRadiusMM(tool) * s
      const n = Math.ceil(rPx / LUT_STEP) + 2
      const h = new Float32Array(n)
      for (let k = 0; k < n; k++) h[k] = toolProfileHeightMM(tool, (k * LUT_STEP) / s)
      l = { h, rPx }
      luts.set(tool.id, l)
    }
    return l
  }

  // One straight move of the tool tip from (ax, ay, az) to (bx, by, bz), pixel units in XY.
  const sweep = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, lut: { h: Float32Array; rPx: number }) => {
    // A tool narrower than a pixel still leaves a visible line a pixel wide.
    const r = Math.max(lut.rPx, 0.75)
    const deepest = Math.min(az, bz)
    const reach = Math.min(r, radiusAtDepthPx(lut, -deepest))
    const xa = Math.max(0, Math.floor(Math.min(ax, bx) - reach)), xb = Math.min(M - 1, Math.ceil(Math.max(ax, bx) + reach))
    const ya = Math.max(0, Math.floor(Math.min(ay, by) - reach)), yb = Math.min(M - 1, Math.ceil(Math.max(ay, by) + reach))
    if (xa > xb || ya > yb) return
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const h = lut.h, last = h.length - 1
    for (let j = ya; j <= yb; j++) {
      for (let i = xa; i <= xb; i++) {
        const k = j * M + i
        const cur = z[k]
        if (!(cur > deepest)) continue   // off the stock (NaN) or already as deep as this move goes
        // A plunge has no length: its tip reaches the deeper end, which is the one to carve.
        let t = len2 > 0 ? ((i - ax) * dx + (j - ay) * dy) / len2 : bz < az ? 1 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = i - (ax + t * dx), ey = j - (ay + t * dy)
        const d = Math.sqrt(ex * ex + ey * ey)
        if (d > r) continue
        const idx = Math.min(last, Math.round(d / LUT_STEP))
        const surf = az + t * (bz - az) + (lut.rPx >= 0.75 ? h[idx] : 0)
        if (surf < cur) z[k] = surf
      }
    }
  }

  // Chords no longer than a pixel.
  forEachCut(operations, toolsById, startToolId, 1 / s, (tool, ax, ay, az, bx, by, bz) =>
    sweep(px(ax), py(ay), az, px(bx), py(by), bz, lutFor(tool)))
  return { z, pxPerMM: s }
}

/** Every move that cuts: its tool and the tip's path from the point before it, an arc as
 *  chords no longer than `chordMM`. */
function forEachCut(
  operations: AnyOperation[], toolsById: Record<string, Tool>,
  startToolId: (op: AnyOperation) => string, chordMM: number,
  visit: (tool: Tool, ax: number, ay: number, az: number, bx: number, by: number, bz: number) => void,
) {
  let x = 0, y = 0, zz = Infinity
  for (const op of operations) {
    let tool = toolsById[startToolId(op)] ?? toolsById[op.toolId]
    for (const seg of op.segments) {
      if (seg.toolChange) { tool = toolsById[seg.toolChange] ?? tool; continue }
      if (!seg.rapid && tool && (seg.z < 0 || zz < 0)) {
        if (seg.arc) {
          const { cx, cy, cw } = seg.arc
          const a0 = Math.atan2(y - cy, x - cx), rad = Math.hypot(x - cx, y - cy)
          let sw = Math.atan2(seg.y - cy, seg.x - cx) - a0
          if (cw && sw >= 0) sw -= 2 * Math.PI
          if (!cw && sw <= 0) sw += 2 * Math.PI
          const n = Math.max(1, Math.ceil((Math.abs(sw) * rad) / chordMM))
          let qx = x, qy = y, qz = zz
          for (let k = 1; k <= n; k++) {
            const a = a0 + (sw * k) / n
            const nx = k === n ? seg.x : cx + rad * Math.cos(a), ny = k === n ? seg.y : cy + rad * Math.sin(a)
            const nz = zz + ((seg.z - zz) * k) / n
            visit(tool, qx, qy, qz, nx, ny, nz)
            qx = nx; qy = ny; qz = nz
          }
        } else visit(tool, x, y, zz, seg.x, seg.y, seg.z)
      }
      x = seg.x; y = seg.y; zz = seg.z
    }
  }
}

/** The square an icon shows: what the program cuts (as far as each tool reaches), clipped to
 *  the stock, with a small margin. Undefined when nothing cuts the stock. */
function iconView(
  operations: AnyOperation[], toolsById: Record<string, Tool>, stock: ThumbnailStock,
  startToolId: (op: AnyOperation) => string,
): View | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  forEachCut(operations, toolsById, startToolId, Math.max(stock.widthMM, stock.heightMM) / 200, (tool, ax, ay, _az, bx, by) => {
    const r = maxCutRadiusMM(tool)
    x0 = Math.min(x0, ax - r, bx - r); x1 = Math.max(x1, ax + r, bx + r)
    y0 = Math.min(y0, ay - r, by - r); y1 = Math.max(y1, ay + r, by + r)
  })
  x0 = Math.max(x0, 0); y0 = Math.max(y0, 0)
  x1 = Math.min(x1, stock.widthMM); y1 = Math.min(y1, stock.heightMM)
  if (!(x1 > x0 && y1 > y0)) return undefined
  const size = Math.max(x1 - x0, y1 - y0) * 1.08
  return { x0: (x0 + x1 - size) / 2, y0: (y0 + y1 - size) / 2, size }
}

/** An n×n icon from an (n·k)² height map: each pixel leaning to the deepest cut in its block, coloured
 *  by depth against the job's deepest, flat (a light direction at 32 px is noise). Blocks
 *  with no stock in them are transparent. */
function icon({ z }: HeightMap, n: number): Uint8Array {
  const k = ICON_OVERSAMPLE, M = n * k
  const out = new Uint8Array(n * n * 4)
  let deepest = 0
  for (let i = 0; i < z.length; i++) if (z[i] < deepest) deepest = z[i]
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let low = Infinity, sum = 0, stockPx = 0
      for (let y = j * k; y < (j + 1) * k; y++) {
        for (let x = i * k; x < (i + 1) * k; x++) {
          const v = z[y * M + x]
          if (Number.isNaN(v)) continue
          stockPx++
          sum += v
          if (v < low) low = v
        }
      }
      if (!stockPx) continue
      // Half the deepest cut in the block, so a line much thinner than the pixel still
      // darkens it; half the mean, so a relief keeps its shape instead of reading as one
      // tone. Any cut at all starts well clear of the stock colour.
      const t = deepest < 0 ? Math.min(1, (low + sum / stockPx) / 2 / deepest) : 0
      const cut = low < -0.01 && t > 0 ? Math.max(0.4, t) : 0
      const o = (j * n + i) * 4
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(WOOD[c] + (DEEP_ICON[c] - WOOD[c]) * cut)
      out[o + 3] = cut > 0 ? 255 : Math.round((255 * stockPx) / (k * k))
    }
  }
  return out
}

/** How far out (pixels) a tool's surface sits below the stock top when its tip is `depth` down. */
function radiusAtDepthPx(lut: { h: Float32Array; rPx: number }, depthMM: number): number {
  const h = lut.h
  for (let k = 0; k < h.length; k++) if (h[k] >= depthMM) return k / 8 + 1
  return lut.rPx + 1
}

// Uncut stock, and the colour at full stock depth.
const WOOD: [number, number, number] = [222, 190, 140]
const DEEP: [number, number, number] = [96, 62, 32]
const DEEP_ICON: [number, number, number] = [60, 34, 14]

function shade({ z, pxPerMM }: HeightMap, M: number, thicknessMM: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(M * M * 4)
  const T = thicknessMM > 0 ? thicknessMM : 1
  // Light from the top left: a slope facing it is lit, one facing away shadowed. The slope
  // is in mm per mm, so a 45° V wall reads the same at any image size.
  const at = (i: number, j: number, fb: number) => {
    const v = i >= 0 && j >= 0 && i < M && j < M ? z[j * M + i] : NaN
    return Number.isNaN(v) ? fb : v
  }
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const v = z[j * M + i]
      if (Number.isNaN(v)) continue
      const depth = Math.min(1, Math.max(0, -v / T))
      const gx = (at(i + 1, j, v) - at(i - 1, j, v)) * pxPerMM / 2   // +x, mm/mm
      const gy = (at(i, j - 1, v) - at(i, j + 1, v)) * pxPerMM / 2   // +y (up the image)
      const lit = Math.max(0.45, Math.min(1.3, 1 + 0.35 * (-gx + gy)))
      const k = (j * M + i) * 4
      for (let c = 0; c < 3; c++) out[k + c] = (WOOD[c] + (DEEP[c] - WOOD[c]) * depth) * lit
      out[k + 3] = depth >= 0.999 ? 110 : 255   // cut through: let the background show
    }
  }
  return out
}

/** Area-average an M×M RGBA image down to n×n (alpha-weighted, so edges do not darken). */
function downsample(src: Uint8ClampedArray, M: number, n: number): Uint8Array {
  const out = new Uint8Array(n * n * 4)
  const f = M / n
  for (let j = 0; j < n; j++) {
    const ya = Math.floor(j * f), yb = Math.max(ya + 1, Math.floor((j + 1) * f))
    for (let i = 0; i < n; i++) {
      const xa = Math.floor(i * f), xb = Math.max(xa + 1, Math.floor((i + 1) * f))
      let r = 0, g = 0, b = 0, a = 0, cnt = 0
      for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) {
          const k = (y * M + x) * 4, w = src[k + 3]
          r += src[k] * w; g += src[k + 1] * w; b += src[k + 2] * w; a += w; cnt++
        }
      }
      const k = (j * n + i) * 4
      if (a > 0) { out[k] = r / a; out[k + 1] = g / a; out[k + 2] = b / a }
      out[k + 3] = a / cnt
    }
  }
  return out
}

// ─── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** An 8-bit RGBA PNG, every row filtered "Up" (a shaded height map compresses well that way). */
export function encodePng(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const stride = w * 4
  const raw = new Uint8Array((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1)
    raw[o] = y === 0 ? 0 : 2
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x]
      raw[o + 1 + x] = y === 0 ? v : (v - rgba[(y - 1) * stride + x]) & 0xff
    }
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w); dv.setUint32(4, h)
  ihdr.set([8, 6, 0, 0, 0], 8)   // 8-bit, RGBA, deflate, standard filters, no interlace
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  const out = new Uint8Array(sig.length + chunks.reduce((n, c) => n + c.length, 0))
  out.set(sig)
  let p = sig.length
  for (const c of chunks) { out.set(c, p); p += c.length }
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
