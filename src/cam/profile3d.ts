import type { MotionSegment } from '../store/toolpathStore'
import { pushAll, maxCutRadiusMM, toolProfileHeightMM, ringsBBox } from './geom'
import type { Pt2 } from './pathFlattener'
import { inflatePathsD, unionD, FillRule, JoinType, EndType } from 'clipper2-ts'
import { perfLog } from '../debug'
import { ballDropCutter } from './dropCutter'
import { generateWaterline } from './waterline'
import { stlToCnc } from './stlMapping'
import type { Tool } from '../store/toolStore'
import type { StlModelBounds } from '../importers/svgImporter'
import type { BBox } from '../canvas/selectionUtils'


/**
 * What a 3D Profile leaves of the stock under its deepest cut. A model deeper than the
 * stock (or a max depth set past it) used to be cut to that depth anyway — through the
 * stock and into the table, over the whole floor once waterline started finishing flats.
 * The cut now stops this far above the stock's bottom, so the part stays in one piece and
 * nothing touches the table; the model's lowest part comes out as this skin.
 */
export const STOCK_SKIN_MM = 0.5

/** The depth a 3D Profile actually cuts to: its max depth, kept above the stock's bottom. */
export function profile3dDepthMM(maxDepthMM: number, stockThicknessMM: number): number {
  return stockThicknessMM > STOCK_SKIN_MM ? Math.min(maxDepthMM, stockThicknessMM - STOCK_SKIN_MM) : maxDepthMM
}

/**
 * Whether a model sunk `modelTopMM` below the stock top lies wholly below a cut `depthMM`
 * deep. Then nothing of it is reached: the raster cuts one flat at the depth and the
 * waterline cuts nothing, so the job is refused rather than run.
 */
export function modelBelowCut(modelTopMM: number | undefined, depthMM: number): boolean {
  return (modelTopMM ?? 0) >= depthMM
}

export const MODEL_BELOW_CUT_MSG = 'Model Top Below Stock is at or below the depth cut — nothing of the model would be cut'

export interface Profile3dParams {
  stepoverPercent: number   // % of finishing tool diameter — spacing between passes
  /** How the finish is cut: scanlines, or constant-Z rings round the model. Unset: raster. */
  finishStrategy?: 'raster' | 'waterline'
  rasterAngleDeg: number    // scan direction (raster only)
  maxDepthMM: number        // max cut depth below workpiece surface (positive value)
  roughingRadiusMM?: number        // set → generate roughing pass then rest-machining finish (the rougher's radius, ball or flat)
  roughingFlat?: boolean             // the rougher is a flat end mill, not a ball nose
  roughingStepoverPercent?: number   // stepover % for roughing pass (XY spacing)
  roughingStepDownMM?: number        // axial depth per roughing pass
  roughingStockAllowanceMM?: number  // how much material to leave for finishing (default 0.3)
  roughingRasterAngleDeg?: number    // scan angle for roughing (defaults to rasterAngleDeg + 90)
  roughingToolId?: string            // toolId used in the toolChange segment marker
  finishingToolId?: string           // toolId used in the toolChange segment marker
  safeHeightMM?: number
  /** Machine rapid rate and the roughing tool's feeds — they price riding the surface from
   *  one run to the next against lifting over. Unset: 5000 mm/min, the finishing tool's. */
  rapidMmMin?: number
  roughingXyFeedMmMin?: number
  roughingZFeedMmMin?: number
  /** How far below the stock top the model's highest point sits. Unset: at the top. */
  modelTopMM?: number
  /** Where the cut may go: closed rings in CNC mm, holes as further rings (even–odd). The
   *  tool's edge stays inside, and inside it the ground the model does not cover is a floor
   *  at the model's lowest point. Unset: the model's own box, and only the model. */
  boundaryRings?: Pt2[][]
  /** The boundary is the stock's own edge: nothing stands beyond it, so the tool may run
   *  past it by its radius and clear right to it, leaving no wall. */
  boundaryOpen?: boolean
}

// ─── Height map ───────────────────────────────────────────────────────────────
//
// The height map stores, for each grid cell (ix, iy), the maximum CNC Z of the STL
// surface ANYWHERE WITHIN THE CELL — the square of one cell's size centred on the node —
// not the height at the node itself. CNC Z = 0 at the workpiece top surface; negative
// values go into the material.
//
// The maximum over the cell, rather than a point sample, is what makes the finish
// gouge-free. A point sample under-reads any surface that rises between two nodes: at the
// foot of a steep wall the node sees the floor while the wall stands half a cell away, and
// the tool, told the wall is not there, cut 0.7 mm into it (6 mm ball, 30% stepover), and
// 0.1 mm into a 45° wall. Reading high instead can only lift the tool — it leaves at most
// about slope × half a cell of stock on a slope, and none on a flat.
//
// STL model space → CNC space: `stlToCnc` (stlMapping.ts), shared with the drop-cutter.

type P3 = [number, number, number]

// Clip a polygon to the half-space `sign·(p[axis] − bound) ≤ 0`, interpolating Z (and the
// other coordinate) along each cut edge — Sutherland–Hodgman, one plane.
function clipPlane(poly: P3[], axis: 0 | 1, bound: number, sign: 1 | -1): P3[] {
  const out: P3[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    const da = sign * (a[axis] - bound), db = sign * (b[axis] - bound)
    if (da <= 0) out.push(a)
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db)
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
    }
  }
  return out
}

export function buildHeightMap(
  positions: Float32Array,
  indices: Uint32Array | null,
  bounds: StlModelBounds,
  bbox: BBox,
  nx: number,
  ny: number,
  /** The grid's own extent when it is not the model's box, the depth of the model's top
   *  below the stock top, and what a cell no triangle covers reads as. */
  opts: { gridBox?: BBox; zOffsetMM?: number; fill?: number } = {},
): Float32Array {
  const G = opts.gridBox ?? bbox
  const map = stlToCnc(bounds, bbox, opts.zOffsetMM ?? 0)

  const cellX = G.width  / (nx - 1)
  const cellY = G.height / (ny - 1)
  const hx = cellX / 2, hy = cellY / 2

  const grid = new Float32Array(nx * ny).fill(-Infinity)

  function vertXYZ(idx: number): P3 {
    return [map.x(positions[idx * 3]), map.y(positions[idx * 3 + 1]), map.z(positions[idx * 3 + 2])]
  }

  const triCount = indices ? indices.length / 3 : positions.length / 9

  for (let t = 0; t < triCount; t++) {
    const i0 = indices ? indices[t * 3]     : t * 3
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2
    const tri: P3[] = [vertXYZ(i0), vertXYZ(i1), vertXYZ(i2)]

    const tMinX = Math.min(tri[0][0], tri[1][0], tri[2][0])
    const tMaxX = Math.max(tri[0][0], tri[1][0], tri[2][0])
    const tMinY = Math.min(tri[0][1], tri[1][1], tri[2][1])
    const tMaxY = Math.max(tri[0][1], tri[1][1], tri[2][1])
    const tMaxZ = Math.max(tri[0][2], tri[1][2], tri[2][2])

    // Every node whose cell the triangle's footprint can touch.
    const ix0 = Math.max(0, Math.ceil((tMinX - hx - G.minX) / cellX))
    const ix1 = Math.min(nx - 1, Math.floor((tMaxX + hx - G.minX) / cellX))
    const iy0 = Math.max(0, Math.ceil((tMinY - hy - G.minY) / cellY))
    const iy1 = Math.min(ny - 1, Math.floor((tMaxY + hy - G.minY) / cellY))

    for (let iy = iy0; iy <= iy1; iy++) {
      const py = G.minY + iy * cellY
      // Clip to the cell's row once; each cell in the row then only clips in X.
      let row = clipPlane(tri, 1, py - hy, -1)
      if (row.length) row = clipPlane(row, 1, py + hy, 1)
      if (!row.length) continue
      for (let ix = ix0; ix <= ix1; ix++) {
        const idx = iy * nx + ix
        if (grid[idx] >= tMaxZ) continue   // nothing in this triangle can raise the cell
        const px = G.minX + ix * cellX
        let cellPoly = clipPlane(row, 0, px - hx, -1)
        if (cellPoly.length) cellPoly = clipPlane(cellPoly, 0, px + hx, 1)
        let z = -Infinity
        for (const p of cellPoly) if (p[2] > z) z = p[2]
        if (z > grid[idx]) grid[idx] = z
      }
    }
  }

  if (opts.fill !== undefined) for (let k = 0; k < grid.length; k++) if (grid[k] === -Infinity) grid[k] = opts.fill
  return grid
}

function clampNear(f: number, max: number): number {
  return f < 0 && f > -1e-9 ? 0 : f > max && f < max + 1e-9 ? max : f
}

// Bilinear interpolation. Returns null when outside the grid. The grids it reads are built
// with a `fill` (see generateProfile3d), so every node holds a height.
function sampleGrid(
  x: number, y: number,
  grid: Float32Array, nx: number, ny: number,
  minX: number, minY: number, cellX: number, cellY: number,
): number | null {
  // A point ON the box edge can come back a few ulps outside it from the raster's
  // rotation (a 90° raster's edge line is at x = −2e-15); that is the edge, not outside.
  const fx = clampNear((x - minX) / cellX, nx - 1)
  const fy = clampNear((y - minY) / cellY, ny - 1)
  if (fx < 0 || fx > nx - 1 || fy < 0 || fy > ny - 1) return null

  const ix = Math.min(Math.floor(fx), nx - 2)
  const iy = Math.min(Math.floor(fy), ny - 2)
  const tx = fx - ix, ty = fy - iy

  const h00 = grid[iy * nx + ix]
  const h10 = grid[iy * nx + (ix + 1)]
  const h01 = grid[(iy + 1) * nx + ix]
  const h11 = grid[(iy + 1) * nx + (ix + 1)]

  return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) +
         h01 * (1 - tx) * ty       + h11 * tx * ty
}

// ─── Gouge-free tool surface (morphological dilation) ────────────────────────
//
// For each grid cell (jx, jy) the raw height h gives the surface Z directly below
// the tool, but the tool can also collide with NEIGHBORING surface points if they
// are within its cutting radius.  The tool-TIP Z at (jx, jy) must therefore satisfy
//     tipZ >= h_neighbor − f(dist)     for every neighbor within reach,
// where f is the tool's own profile — how far above its tip the tool's surface sits
// at radial distance d (see the tool-profile note in geom.ts). For a ball nose that
// is R − √(R²−d²); a taper is its tip ball blended into its cone, which is why the
// same dilation carves either one.
//
// This is the 2D morphological dilation of the height map by the tool profile. The
// result is the "effective surface" — the gouge-free tool-TIP height. The pipeline
// is tip-referenced, so the emitted Z is just this effective surface (+ stock allowance);
// there is no extra ball-radius term (adding one would float the tool R above the stock).
//
// Computed on a downsampled grid (≤DILATE_MAX cells) for speed.

// The dilation kernel. `termAtDistSq` is added to a neighbour's height and the reach
// then subtracted — `eff = h + term − reach` — which is the shape `reach − f(d)`, i.e.
// the tool's tip when its flank rests on that neighbour. It is split that way rather
// than folded into one `−f(d)` term so the ball-nose case stays the exact expression
// (`h + √(R²−d²) − R`) this function computed before it took a profile at all; a
// re-association would be a sub-ULP change, but not a provably empty one.
export interface ToolKernel {
  reachMM: number
  termAtDistSq: (d2: number) => number
  /** A flat end mill: level across its whole radius, and a vertical wall at its rim. */
  flat?: boolean
}

export function ballKernel(radius: number): ToolKernel {
  const r2 = radius * radius
  return { reachMM: radius, termAtDistSq: (d2) => Math.sqrt(r2 - d2) }
}

/** A flat end mill of radius `radius`: its tip is its whole bottom, out to its rim. */
export function flatKernel(radius: number): ToolKernel {
  return { reachMM: radius, termAtDistSq: () => radius, flat: true }
}

function toolKernel(tool: Tool): ToolKernel {
  if (tool.type === 'ballnose') return ballKernel(tool.diameterMM / 2)
  const reachMM = maxCutRadiusMM(tool)
  return { reachMM, termAtDistSq: (d2) => reachMM - toolProfileHeightMM(tool, Math.sqrt(d2)) }
}

/**
 * The kernel, read as if every node's surface could be up to `lean` mm NEARER the tool
 * than the node — where that matters.
 *
 * A node holds the highest point in its cell (`buildHeightMap`), and that point can sit
 * anywhere in the cell: up to half a cell diagonal from the node. Where the tool's profile
 * is gentle that hardly moves the answer, and leaning on it everywhere DOUBLED the stock
 * left on every slope, so it was not done. But beside a near-vertical wall the tool
 * touches with the side of its ball (or the flank of a taper's cone), where its profile
 * is nearly vertical: half a cell sideways is most of a millimetre of height. A real
 * relief with a stepped ledge was cut 0.21 mm into the ledge's edge. So the lean is
 * applied by how steep the tool is at that distance — none up to 45°, all of it from
 * 63° (slope 2) on, in proportion between — which leaves the slopes the old trade-off
 * was about alone and keeps the surface continuous.
 */
function leanKernel(kernel: ToolKernel, lean: number): ToolKernel {
  if (!(lean > 0)) return kernel
  const reach = kernel.reachMM
  const f = (d: number) => reach - kernel.termAtDistSq(d * d)
  const step = Math.min(1e-3, reach / 1000)
  return {
    reachMM: reach,
    termAtDistSq: (d2) => {
      const d = Math.sqrt(d2)
      if (d < step) return kernel.termAtDistSq(d2)
      const slope = (f(d) - f(d - step)) / step
      if (!(slope > 1)) return kernel.termAtDistSq(d2)
      const dd = Math.max(0, d - lean * Math.min(1, slope - 1))
      return kernel.termAtDistSq(dd * dd)
    },
  }
}

/** `srcGrid` must hold a height at every node — a `buildHeightMap` built with `fill`. */
function computeToolSurface(
  srcGrid: Float32Array, srcNX: number, srcNY: number,
  bbox: BBox, kernel: ToolKernel,
  maxCells = 750,  // cap grid resolution for speed; roughing uses 350, finishing uses 750
): ToolSurface {
  const scale = Math.max(1, Math.ceil(Math.max(srcNX, srcNY) / maxCells))
  const nx    = Math.ceil(srcNX / scale)
  const ny    = Math.ceil(srcNY / scale)
  const cellX = bbox.width  / Math.max(1, nx - 1)
  const cellY = bbox.height / Math.max(1, ny - 1)
  const srcCellX = bbox.width  / Math.max(1, srcNX - 1)
  const srcCellY = bbox.height / Math.max(1, srcNY - 1)
  const src = downsampleMax(srcGrid, srcNX, srcNY, srcCellX, srcCellY, nx, ny, cellX, cellY)

  // How far a coarse node's highest point can be from it: half its own cell, plus half a
  // source cell for the source node it came from.
  const lean = Math.hypot((cellX + (scale > 1 ? srcCellX : 0)) / 2, (cellY + (scale > 1 ? srcCellY : 0)) / 2)
  const table = kernelTable(kernel, lean, cellX, cellY)
  const grid = dilate(src, nx, ny, table, kernel.reachMM)
  if (!kernel.flat) return { grid, nx, ny, cellX, cellY }
  return { grid, nx, ny, cellX, cellY, low: lowUnderTool(src, nx, ny, table) }
}

/**
 * The source grid downsampled to nx × ny, keeping each coarse node's MAX so no surface
 * peak is missed. Each source node goes to the coarse node nearest its POSITION: the two
 * grids both span the box edge to edge, so their spacings differ unless (srcN − 1) happens
 * to divide by the scale, and `round(ix / scale)` then drifts — up to half a source cell by
 * the far edge, which moved a steep wall under the tool and gouged a dome's foot 0.1 mm.
 */
function downsampleMax(
  srcGrid: Float32Array, srcNX: number, srcNY: number, srcCellX: number, srcCellY: number,
  nx: number, ny: number, cellX: number, cellY: number,
): Float32Array {
  const src = new Float32Array(nx * ny).fill(-Infinity)
  for (let iy = 0; iy < srcNY; iy++) {
    for (let ix = 0; ix < srcNX; ix++) {
      const v = srcGrid[iy * srcNX + ix]
      const di = Math.min(Math.round((ix * srcCellX) / cellX), nx - 1)
      const dj = Math.min(Math.round((iy * srcCellY) / cellY), ny - 1)
      const idx = dj * nx + di
      if (v > src[idx]) src[idx] = v
    }
  }
  return src
}

/** The tool's profile at every grid offset within its reach (NaN beyond), `kw` wide and
 *  centred on (rcX, rcY). */
interface KernelTable { kern: Float64Array; kw: number; rcX: number; rcY: number }

/**
 * The kernel depends only on the offset, so evaluate the profile ONCE per offset rather
 * than once per (cell, offset) pair — and the dilation's inner loop loses its sqrt. A flat
 * end mill's rim is a vertical wall: a high point just outside the rim's reach of its node,
 * but inside the rim of the cutter, would hit its side. So it reaches `lean` further — the
 * flat-tool form of `leanKernel`, which tilts nothing on a level profile.
 */
function kernelTable(kernel: ToolKernel, lean: number, cellX: number, cellY: number): KernelTable {
  const reachCut = kernel.flat ? kernel.reachMM + lean : kernel.reachMM
  const r2  = reachCut * reachCut
  const rcX = Math.ceil(reachCut / cellX) + 1
  const rcY = Math.ceil(reachCut / cellY) + 1
  const leaned = leanKernel(kernel, lean)
  const kw = 2 * rcX + 1
  const kern = new Float64Array(kw * (2 * rcY + 1))
  for (let dj = -rcY; dj <= rcY; dj++) {
    const dy = dj * cellY, dy2 = dy * dy
    for (let di = -rcX; di <= rcX; di++) {
      const dx = di * cellX
      const d2 = dx * dx + dy2
      kern[(dj + rcY) * kw + (di + rcX)] = d2 > r2 ? NaN : leaned.termAtDistSq(d2)
    }
  }
  return { kern, kw, rcX, rcY }
}

/** The dilation: for each surface node, push its minimum-required tip Z into the nodes
 *  within the tool's reach. */
function dilate(src: Float32Array, nx: number, ny: number, { kern, kw, rcX, rcY }: KernelTable, radius: number): Float32Array {
  const result = new Float32Array(nx * ny).fill(-Infinity)
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const h = src[iy * nx + ix]
      const jxMin = Math.max(0, ix - rcX), jxMax = Math.min(nx - 1, ix + rcX)
      const jyMin = Math.max(0, iy - rcY), jyMax = Math.min(ny - 1, iy + rcY)
      for (let jy = jyMin; jy <= jyMax; jy++) {
        const kRow = (jy - iy + rcY) * kw + rcX - ix
        for (let jx = jxMin; jx <= jxMax; jx++) {
          // effective surface = the tool's tip when its flank rests on this neighbour
          const k = kern[kRow + jx]
          if (Number.isNaN(k)) continue   // outside the tool's reach
          const eff = h + k - radius
          const idx = jy * nx + jx
          if (eff > result[idx]) result[idx] = eff
        }
      }
    }
  }
  return result
}

/** The LOWEST surface under a flat end mill's bottom at each node: where that is level with
 *  the highest, the tool stands on a flat and its bottom finishes it. */
function lowUnderTool(src: Float32Array, nx: number, ny: number, { kern, kw, rcX, rcY }: KernelTable): Float32Array {
  const low = new Float32Array(nx * ny)
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      let m = Infinity
      const jxMin = Math.max(0, ix - rcX), jxMax = Math.min(nx - 1, ix + rcX)
      const jyMin = Math.max(0, iy - rcY), jyMax = Math.min(ny - 1, iy + rcY)
      for (let jy = jyMin; jy <= jyMax; jy++) {
        const kRow = (jy - iy + rcY) * kw + rcX - ix
        for (let jx = jxMin; jx <= jxMax; jx++) {
          if (Number.isNaN(kern[kRow + jx])) continue
          const h = src[jy * nx + jx]
          if (h < m) m = h
        }
      }
      low[iy * nx + ix] = m
    }
  }
  return low
}

// ─── The stock that is left ───────────────────────────────────────────────────
//
// An entry has to come down from safe height somewhere, and the only question is how far
// it may RAPID before it has to feed. Feeding all the way from safe height is always safe
// and was most of the run time — on a 15 mm relief, about 20 mm of every entry went down
// through air at plunge feed. So the passes that have already run are carved into a
// height map of the stock, and an entry rapids to just above what they left.
//
// The carve has to be an UPPER bound on the material everywhere, not just at its nodes,
// since a rapid into stock is a crash. Two things make it one. Every emitted cutting point
// q bounds the material by `tip(q) + f(|x − q|)`, because the tool stood there — so the
// minimum over the points it cut is a bound, and the straight moves between those points
// only remove more. And a node stands for every point within `e` (half a cell diagonal)
// of it, so each node takes the bound at the FARTHEST of those points: the tool is
// carved as if it were `e` narrower than it is. An entry then asks the same question in
// reverse with the entering tool, again leaning `e` the safe way.

/** How far above the stock the carve says is left an entry stops rapiding. */
const ENTRY_CLEARANCE_MM = 1

export class StockModel {
  readonly z: Float32Array
  readonly nx: number
  readonly ny: number
  readonly minX: number
  readonly minY: number
  readonly cell: number
  private readonly e: number

  constructor(bbox: BBox, marginMM: number) {
    // Matches the roughing surface's resolution — the bound is no finer than that anyway.
    this.cell = Math.max(0.2, Math.max(bbox.width, bbox.height) / 350)
    this.minX = bbox.minX - marginMM
    this.minY = bbox.minY - marginMM
    this.nx = Math.ceil((bbox.width + 2 * marginMM) / this.cell) + 1
    this.ny = Math.ceil((bbox.height + 2 * marginMM) / this.cell) + 1
    this.z = new Float32Array(this.nx * this.ny)   // Z = 0: the top of the stock
    this.e = this.cell * Math.SQRT1_2
  }

  /**
   * Lower the stock by every cutting point of `segs`, cut with `tool`: at each node the
   * tool's surface over it, `tip + reach − term(d²)` — narrowed by `e`, so the carve stays
   * an upper bound between the nodes. A flat end mill takes everything under its bottom
   * down to its tip exactly (its term is its reach, and `z + R − R` need not be `z`).
   */
  carve(segs: MotionSegment[], tool: ToolKernel): void {
    const { z, nx, ny, minX, minY, cell, e } = this
    const R = tool.reachMM
    const reach = R - e
    if (reach <= 0) return
    const rc = Math.ceil(reach / cell)
    for (const s of segs) {
      if (s.rapid) continue
      const cx = (s.x - minX) / cell, cy = (s.y - minY) / cell
      const i0 = Math.max(0, Math.ceil(cx - rc)), i1 = Math.min(nx - 1, Math.floor(cx + rc))
      const j0 = Math.max(0, Math.ceil(cy - rc)), j1 = Math.min(ny - 1, Math.floor(cy + rc))
      for (let j = j0; j <= j1; j++) {
        const dy = (j - cy) * cell
        for (let i = i0; i <= i1; i++) {
          const dx = (i - cx) * cell
          const d = Math.sqrt(dx * dx + dy * dy) + e
          if (d >= R) continue
          const top = tool.flat ? s.z : s.z + R - tool.termAtDistSq(d * d)
          const k = j * nx + i
          if (top < z[k]) z[k] = top
        }
      }
    }
  }

  /** Whether `tool` at (x, y) with its tip at `level` would touch stock left — that is,
   *  `clearTipZ(x, y, tool) > level` — answered at the first node that says so. */
  stockAbove(x: number, y: number, tool: ToolKernel, level: number): boolean {
    return this.highestNeed(x, y, tool, level) > level
  }

  /** The lowest tip height at (x, y) that `tool` is clear of every bit of stock left. */
  clearTipZ(x: number, y: number, tool: ToolKernel): number {
    return this.highestNeed(x, y, tool, Infinity)
  }

  /** The highest tip height any stock node under `tool` at (x, y) asks for — or the first
   *  one found above `stopAbove`, which settles a yes/no question as soon as it can. */
  private highestNeed(x: number, y: number, tool: ToolKernel, stopAbove: number): number {
    const { z, nx, ny, minX, minY, cell, e } = this
    const reach = tool.reachMM
    const rc = Math.ceil((reach + e) / cell)
    const cx = (x - minX) / cell, cy = (y - minY) / cell
    const i0 = Math.max(0, Math.ceil(cx - rc)), i1 = Math.min(nx - 1, Math.floor(cx + rc))
    const j0 = Math.max(0, Math.ceil(cy - rc)), j1 = Math.min(ny - 1, Math.floor(cy + rc))
    let need = -Infinity
    for (let j = j0; j <= j1; j++) {
      const dy = (j - cy) * cell
      for (let i = i0; i <= i1; i++) {
        const dx = (i - cx) * cell
        const d = Math.max(0, Math.sqrt(dx * dx + dy * dy) - e)
        if (d > reach) continue
        // The tool's surface sits `reach − term` above its tip at distance d.
        const v = z[j * nx + i] - (reach - tool.termAtDistSq(d * d))
        if (v > need) { need = v; if (need > stopAbove) return need }
      }
    }
    return need
  }
}

// ─── Step-down roughing ───────────────────────────────────────────────────────
//
// Runs the raster algorithm at increasing depth limits (stepDownMM per pass).
// Each pass follows the 3D surface, clamped at the current maximum depth.

function generateStepDownPasses(
  surf: ToolSurface,
  bbox: BBox,
  stepoverMM: number,
  stepDownMM: number,
  maxDepthMM: number,
  stockAllowanceMM: number,
  rasterAngleDeg: number,
  /** The model's depth read off the raw height map, not the dilated surface — dilation
   *  artefacts would count as extra passes. */
  rawMaxDepthMM: number,
  roughKernel: ToolKernel,
  stock: StockModel,
  motion: Omit<RasterMotion, 'stock' | 'enter'>,
  area: CutArea | undefined,
  wall: Pt2[][],
): MotionSegment[] {
  const effectiveMaxDepth = Math.min(rawMaxDepthMM, maxDepthMM)
  // Floored like `zPasses`: a step of 0 made this Infinity and the loop below unbounded.
  if (!(stepDownMM >= 0.01)) stepDownMM = 0.01
  const numPasses = Math.ceil(effectiveMaxDepth / stepDownMM)

  perfLog(`[profile3d] roughing: ${numPasses} passes, effectiveMaxDepth=${effectiveMaxDepth.toFixed(2)}mm, stepDown=${stepDownMM}mm, stock=${stockAllowanceMM}mm`)

  const enter = roughKernel
  const segs: MotionSegment[] = []
  for (let n = 1; n <= numPasses; n++) {
    const passDepth   = Math.min(n * stepDownMM, effectiveMaxDepth)
    const prevDepthMM = (n - 1) * stepDownMM   // skip areas already cut in previous pass
    const em = new PassEmitter(surf, bbox, passDepth, stockAllowanceMM, { ...motion, enter, stock }, undefined, area)
    if (roughKernel.flat) em.flatFloorDepthMM = maxDepthMM
    rasterInto(em, stepoverMM, rasterAngleDeg, prevDepthMM)
    wallInto(em, wall, prevDepthMM)
    const level = em.done()
    // Carved after the level, never during it: an entry is judged against the stock
    // before its own level started, which can only read high.
    stock.carve(level, roughKernel)
    pushAll(segs, level)
  }

  return segs
}

// ─── Moving between cuts ──────────────────────────────────────────────────────
//
// A raster is a set of runs laid onto the gouge-free grid; this is how it gets from one
// run to the next.
//
// LINKING. The gouge-free grid holds the lowest safe tip height at EVERY point, not just
// on the runs — so a move between two runs that follows that grid is gouge-free by the
// same construction as the cut itself. Each run is therefore joined to the next by
// riding the surface whenever that is quicker than lifting to safe height, crossing, and
// coming back down; the comparison is in seconds, like `travelBeatsLift` in the 2D
// router. A ride over ground an earlier roughing level cleared is marked `travel` — the
// tool runs in the groove that level cut. It never rides out of the boundary: that is
// lifted over. (Ground the model does not cover, holes through it included, is a floor at
// its lowest point, ridden like any other surface.)
//
// ENTRIES rapid down to just above the stock earlier passes left (`StockModel`) and feed
// only the rest of the way.

interface ToolSurface {
  grid: Float32Array; nx: number; ny: number; cellX: number; cellY: number
  /** A flat end mill's: the lowest surface under its bottom at each node. */
  low?: Float32Array
}

/** Where the tool centre may go, when that is not simply the surface's own box. */
interface CutArea {
  box: BBox
  inside: (x: number, y: number) => boolean
  /** The limit itself, where it stands against a wall of stock — outers anticlockwise. */
  wall?: Pt2[][]
  /** The limit, always — where the tool centre may go. */
  limit: Pt2[][]
}

interface RasterMotion {
  safeZ: number
  /** Feeds that price a link against a lift. */
  xyFeedMmMin: number
  zFeedMmMin: number
  rapidMmMin: number
  /** The tool coming down at an entry, and what earlier passes left for it to come down
   *  onto — null when nothing has cut yet (the stock top, Z = 0). */
  enter: ToolKernel
  stock: StockModel | null
}

const TRAVEL_FEED_FACTOR = 2.5   // as gcode.ts writes a `travel` move
/** How far apart the highest and lowest surface under a flat end mill may be for it to be
 *  standing on a flat. */
const FLAT_FLOOR_TOL_MM = 0.01
/** A finishing cut that would take less than this off the stock the roughing left is
 *  not made. */
const REST_TOL_MM = 0.01
const MAX_LINK_GAP_CELLS = 2

/** One pass's motion: its cuts, the links between them, and the entries where a link
 *  does not pay. */
class PassEmitter {
  readonly segs: MotionSegment[] = []
  /** The tool's position while it is down; null = up at safe height. */
  at: { x: number; y: number; z: number } | null = null
  /** Spacing of the samples a cut or a link takes of the grid. */
  readonly sampleStep: number
  readonly surf: ToolSurface
  readonly bbox: BBox
  /** The box the raster scans, and whether the tool centre may stand at a point. */
  readonly scanBox: BBox
  readonly inside: (x: number, y: number) => boolean

  constructor(
    surf: ToolSurface, bbox: BBox,
    private readonly maxDepthMM: number,
    private readonly stockAllowanceMM: number,
    private readonly motion: RasterMotion,
    /** Where set, cuts and links read the surface exactly (`ballDropCutter`). */
    private readonly exact?: (x: number, y: number) => number | null,
    area?: CutArea,
  ) {
    this.surf = surf
    this.bbox = bbox
    this.scanBox = area?.box ?? bbox
    this.inside = area?.inside ?? (() => true)
    this.sampleStep = Math.min(surf.cellX, surf.cellY) * 0.5
  }

  // How the surface is read. Two sources — the gouge-free grid, and the exact surface where
  // the pass has one — each either inside the boundary only or anywhere, all turned into a
  // tip height by the one rule in `tip`.

  /** The grid's surface height at (x, y), boundary or not; null off the grid. */
  private gridZ(x: number, y: number): number | null {
    const { grid, nx, ny, cellX, cellY } = this.surf
    return sampleGrid(x, y, grid, nx, ny, this.bbox.minX, this.bbox.minY, cellX, cellY)
  }

  /** The best surface height the pass has at (x, y): exact where given, else the grid. */
  private bestZ(x: number, y: number): number | null {
    return this.exact ? this.exact(x, y) : this.gridZ(x, y)
  }

  /** The tip height over surface `h`: no deeper than the max depth, plus the allowance. */
  private tip(x: number, y: number, h: number | null): number | null {
    return h === null ? null : Math.max(h, -this.maxDepthMM) + this.allowanceAt(x, y, h)
  }

  /** The grid's surface height under (x, y) — null outside the boundary. */
  surfaceZ(x: number, y: number): number | null {
    return this.inside(x, y) ? this.gridZ(x, y) : null
  }

  /** The tip height a cut at (x, y) follows, read off the grid; null outside the boundary. */
  tipZ(x: number, y: number): number | null {
    return this.tip(x, y, this.surfaceZ(x, y))
  }

  /** The model's final depth — set for a flat end mill's roughing, which then leaves no
   *  allowance on a flat: its bottom is the best finish a level surface can have. */
  flatFloorDepthMM: number | null = null

  /** The stock allowance at (x, y), where the surface under the tool is `h`. (A pass with
   *  an exact surface is a finish, which has no `low`: its allowance is the plain one.) */
  private allowanceAt(x: number, y: number, h: number): number {
    const low = this.surf.low
    if (!low || this.flatFloorDepthMM === null) return this.stockAllowanceMM
    const { nx, ny, cellX, cellY } = this.surf
    const l = sampleGrid(x, y, low, nx, ny, this.bbox.minX, this.bbox.minY, cellX, cellY)
    if (l === null) return this.stockAllowanceMM
    const D = -this.flatFloorDepthMM
    return Math.max(h, D) - Math.max(l, D) <= FLAT_FLOOR_TOL_MM ? 0 : this.stockAllowanceMM
  }

  /** Set for a finish after roughing: the stock the roughing left, and the finishing tool. */
  rest: { stock: StockModel; tool: ToolKernel } | null = null

  /** Whether a cut at (x, y, z) takes anything — false where the roughing already left the
   *  stock there within REST_TOL_MM of it (a flat an end mill finished). */
  needsCut(x: number, y: number, z: number): boolean {
    return !this.rest || this.rest.stock.stockAbove(x, y, this.rest.tool, z + REST_TOL_MM)
  }

  /** `tipZ`, read exactly where the pass was given an exact surface. */
  exactTipZ(x: number, y: number): number | null {
    return this.inside(x, y) ? this.tip(x, y, this.bestZ(x, y)) : null
  }

  get allowanceMM(): number { return this.stockAllowanceMM }

  /** `exactTipZ` on the limit itself, which a containment test may read either way. */
  edgeTipZ(x: number, y: number): number | null {
    return this.tip(x, y, this.bestZ(x, y))
  }

  // How low an entry at (x, y, z) may rapid before it feeds.
  private entryZ(x: number, y: number, z: number): number {
    const { safeZ, stock, enter } = this.motion
    const clear = stock ? stock.clearTipZ(x, y, enter) : 0
    return Math.min(safeZ, Math.max(z, clear + ENTRY_CLEARANCE_MM))
  }

  private enter(x: number, y: number, z: number): void {
    const { safeZ } = this.motion
    if (this.at) this.segs.push({ x: this.at.x, y: this.at.y, z: safeZ, rapid: true })
    this.segs.push({ x, y, z: safeZ, rapid: true })
    const e = this.entryZ(x, y, z)
    if (e < safeZ) this.segs.push({ x, y, z: e, rapid: true })
    if (z < e) this.segs.push({ x, y, z, rapid: false })
    this.at = { x, y, z }
  }

  // Ride the surface from where the tool is to (x, y, z), if that beats lifting.
  private link(x: number, y: number, z: number, overCleared: boolean, maxClimbMM = Infinity): boolean {
    const at = this.at
    if (!at) return false
    const ride = this.ridePath(at, x, y, z, maxClimbMM)
    if (!ride) return false
    // A ride over ground the roughing already finished takes nothing either: travel. (Its
    // last point is where the next cut starts, which of course has stock to take.)
    if (!overCleared && this.rest && ride.pts.slice(0, -1).every(([qx, qy, qz]) => !this.needsCut(qx, qy, qz))) overCleared = true
    const { motion } = this
    const rideS = ride.len / (motion.xyFeedMmMin * (overCleared ? TRAVEL_FEED_FACTOR : 1))
    if (!(rideS < this.liftSeconds(at, x, y, z))) return false
    for (const [qx, qy, qz] of ride.pts) {
      this.segs.push(overCleared ? { x: qx, y: qy, z: qz, rapid: false, travel: true } : { x: qx, y: qy, z: qz, rapid: false })
    }
    this.at = { x, y, z }
    return true
  }

  /**
   * The points of a ride along the surface from `at` to (x, y, z), sampled every
   * `sampleStep`, and its 3D length — or null where there is no such ride: it leaves the
   * boundary, crosses a gap too wide to bridge, or climbs more than `maxClimbMM` above
   * both ends.
   */
  private ridePath(
    at: { x: number; y: number; z: number }, x: number, y: number, z: number, maxClimbMM: number,
  ): { pts: [number, number, number][]; len: number } | null {
    const dx = x - at.x, dy = y - at.y
    const hop = Math.hypot(dx, dy)
    const n = Math.max(1, Math.ceil(hop / this.sampleStep))
    // Outside the boundary is not a gap to bridge: the tool's edge would leave it. Checked
    // before the surface is read (`exactTipZ` is a drop-cutter query per point).
    for (let i = 1; i < n; i++) if (!this.inside(at.x + dx * i / n, at.y + dy * i / n)) return null
    const zs: (number | null)[] = []
    for (let i = 1; i <= n; i++) {
      const t = i / n
      zs.push(i === n ? z : this.exactTipZ(at.x + dx * t, at.y + dy * t))
    }
    // A stretch with no surface under it. Every surface is filled to a floor wherever the
    // model does not reach, so this is only the grid's edge read a hair outside — bridged
    // at the higher of the heights either side when no longer than MAX_LINK_GAP_CELLS,
    // lifted over otherwise.
    const step = hop / n
    const maxGap = MAX_LINK_GAP_CELLS * Math.max(this.surf.cellX, this.surf.cellY)
    for (let i = 0; i < n; i++) {
      if (zs[i] !== null) continue
      let j = i
      while (zs[j] === null) j++   // zs[n − 1] is the endpoint, never null
      if ((j - i) * step > maxGap) return null
      const fill = Math.max(i > 0 ? zs[i - 1]! : at.z, zs[j]!)
      for (let k = i; k < j; k++) zs[k] = fill
      i = j
    }
    // A link that would ride up and over something between its ends — a waterline moving
    // from one floor ring to the next across the foot of a wall — lifts instead: it is a
    // jerk up and down the machine has no reason to make.
    if (maxClimbMM < Infinity) {
      const top = Math.max(at.z, z) + maxClimbMM
      for (const q of zs) if (q! > top) return null
    }
    const pts: [number, number, number][] = []
    let len = 0, px = at.x, py = at.y, pz = at.z
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const qx = at.x + dx * t, qy = at.y + dy * t, qz = zs[i - 1]!
      len += Math.hypot(qx - px, qy - py, qz - pz)
      pts.push([qx, qy, qz]); px = qx; py = qy; pz = qz
    }
    return { pts, len }
  }

  /** Seconds to lift from `at` to safe height, rapid across, rapid down to the entry
   *  height above (x, y) and feed the rest of the way to z. */
  private liftSeconds(at: { x: number; y: number; z: number }, x: number, y: number, z: number): number {
    const { motion } = this
    const hop = Math.hypot(x - at.x, y - at.y)
    const e = this.entryZ(x, y, z)
    return (2 * motion.safeZ - at.z - e + hop) / motion.rapidMmMin + (e - z) / motion.zFeedMmMin
  }

  /** Get to (x, y, z) to start a run: along the surface if that pays, else over the top. */
  arrive(x: number, y: number, z: number, overCleared = false, maxClimbMM = Infinity): void {
    if (!this.link(x, y, z, overCleared, maxClimbMM)) this.enter(x, y, z)
  }

  cut(x: number, y: number, z: number): void {
    this.segs.push({ x, y, z, rapid: false })
    this.at = { x, y, z }
  }

  /** Lift off at the end of the pass and hand back its motion. */
  done(): MotionSegment[] {
    if (this.at) this.segs.push({ x: this.at.x, y: this.at.y, z: this.motion.safeZ, rapid: true })
    this.at = null
    return this.segs
  }
}

// ─── Raster strategy ──────────────────────────────────────────────────────────
//
// Scanlines parallel to rasterAngleDeg, stepped by stepoverMM.
// The tool follows the 3D surface: the emitted Z is the tool-TIP position
// (gcode and the simulator are both tip-referenced — see gcode.ts / SimulationLayer).
// `grid` already holds the gouge-free tip height (computeToolSurface solves the ball
// collision and returns tip = surface raised by the ball geometry), so the tip Z is
// simply surfaceZ + stockAllowance — no ball-radius term.
//
// When prevPassDepthMM is set, points the previous roughing level already cut to their
// final height are skipped, and so are points outside the model (no surface under them).
// Either one splits a scanline into RUNS, which the emitter links.

/** Scanline offsets: stepped by the stepover, with the last one ON the far edge (see
 *  `scanlineRYs` in surfacing.ts — stopping a step short of it left a strip uncut). */
function scanlineOffsets(min: number, max: number, step: number): number[] {
  const out: number[] = []
  for (let r = min; r < max - 1e-9; r += step) out.push(r)
  out.push(max)
  return out
}

function rasterInto(
  em: PassEmitter,
  stepoverMM: number, rasterAngleDeg: number,
  prevPassDepthMM: number,   // skip points already cut at this depth in a prior pass
): void {
  const { scanBox: bbox, sampleStep } = em
  const θ  = (rasterAngleDeg * Math.PI) / 180
  const cosA = Math.cos(θ),  sinA = Math.sin(θ)
  const cosB = Math.cos(-θ), sinB = Math.sin(-θ)

  const corners = [
    [bbox.minX, bbox.minY], [bbox.maxX, bbox.minY],
    [bbox.maxX, bbox.maxY], [bbox.minX, bbox.maxY],
  ]
  const raster = corners.map(([x, y]) => [x * cosB - y * sinB, x * sinB + y * cosB])
  const rsMinX = Math.min(...raster.map((c) => c[0]))
  const rsMaxX = Math.max(...raster.map((c) => c[0]))
  const rsMinY = Math.min(...raster.map((c) => c[1]))
  const rsMaxY = Math.max(...raster.map((c) => c[1]))

  let forward = true
  for (const ry of scanlineOffsets(rsMinY, rsMaxY, stepoverMM)) {
    const rxRange: number[] = []
    for (let rx = rsMinX; rx <= rsMaxX + 1e-6; rx += sampleStep) rxRange.push(rx)
    if (!forward) rxRange.reverse()

    let inRun = false        // the last sample on this line was cut
    let lineCut = false      // anything on this line was cut
    let gapCleared = true    // every point skipped since the last run was cleared ground
    for (const rx of rxRange) {
      const cncX = rx * cosA - ry * sinA
      const cncY = rx * sinA + ry * cosA
      if (cncX < bbox.minX - 1e-3 || cncX > bbox.maxX + 1e-3 ||
          cncY < bbox.minY - 1e-3 || cncY > bbox.maxY + 1e-3) continue

      const h = em.surfaceZ(cncX, cncY)
      // Outside the boundary the tool may not go: a gap in the run, lifted over. (Ground the
      // model does not cover — round it, or a hole through it — is a floor, not a gap.)
      if (h === null) { gapCleared = false; inRun = false; continue }
      // Already cleared by a previous roughing level: a gap the link may ride along.
      if (prevPassDepthMM > 0 && h >= -prevPassDepthMM + 1e-6) { inRun = false; continue }

      const toolZ = em.exactTipZ(cncX, cncY) ?? em.tipZ(cncX, cncY)!
      // Already finished by the roughing: cleared ground, ridden over like a cleared level.
      if (!em.needsCut(cncX, cncY, toolZ)) { inRun = false; continue }
      if (inRun) { em.cut(cncX, cncY, toolZ); continue }
      // A gap within this line is cleared ground only if the boundary did not interrupt it.
      em.arrive(cncX, cncY, toolZ, lineCut && gapCleared)
      inRun = true; lineCut = true; gapCleared = true
    }
    // Alternate with the lines that cut, so the next one starts at the end this one left.
    if (lineCut) forward = !forward
  }
}

// ─── The machining boundary ───────────────────────────────────────────────────
//
// By default a 3D Profile cuts the model's own box and nothing else. A boundary widens or
// narrows that to a drawn region: the tool's EDGE stays inside it — its centre is kept in
// by the larger of the two tools' radii, so neither the rougher nor the finisher reaches
// past the line — and inside it, wherever the model does not reach, the ground is a floor
// at the model's lowest point. A relief placed in a bigger board is then cleared down to
// its base all round, instead of standing in a box of uncut stock.

/** Even–odd containment over a set of rings, by crossings of a ray to +x — the edges kept
 *  in horizontal bands so each test looks at the few that cross its row. */
function ringContainment(rings: Pt2[][], band: number): (x: number, y: number) => boolean {
  let minY = Infinity
  for (const r of rings) for (const p of r) if (p[1] < minY) minY = p[1]
  const bands = new Map<number, number[]>()
  for (const r of rings) {
    for (let k = 0; k < r.length; k++) {
      const a = r[k], b = r[(k + 1) % r.length]
      if (a[1] === b[1]) continue
      const j0 = Math.floor((Math.min(a[1], b[1]) - minY) / band), j1 = Math.floor((Math.max(a[1], b[1]) - minY) / band)
      for (let j = j0; j <= j1; j++) {
        let list = bands.get(j)
        if (!list) bands.set(j, list = [])
        list.push(a[0], a[1], b[0], b[1])
      }
    }
  }
  return (x, y) => {
    const list = bands.get(Math.floor((y - minY) / band))
    if (!list) return false
    let inside = false
    for (let q = 0; q < list.length; q += 4) {
      const ax = list[q], ay = list[q + 1], bx = list[q + 2], by = list[q + 3]
      if ((ay > y) === (by > y)) continue
      if (ax + (y - ay) * (bx - ax) / (by - ay) > x) inside = !inside
    }
    return inside
  }
}

/** Where the tool centre may go: the boundary pulled in by `insetMM`. */
function cutArea(rings: Pt2[][], insetMM: number, open = false): CutArea {
  const region = unionD(rings.filter((r) => r.length >= 3).map((r) => r.map(([x, y]) => ({ x, y }))), FillRule.EvenOdd)
  // Round joins are chords inside their arcs by up to the arc tolerance; pulled in by that
  // much more, the chords stay a full radius clear (they cut 0.01 mm into a hole's margin).
  const ARC_TOL = 0.01
  const limit = inflatePathsD(region, open ? insetMM : -(insetMM + ARC_TOL), JoinType.Round, EndType.Polygon, 2, 4, ARC_TOL)
    .map((r) => r.map((p) => [p.x, p.y] as Pt2))
  if (!limit.length) throw new Error('The boundary is too small for the tool — no room for its edge to stay inside')
  const { minX, minY, maxX, maxY } = ringsBBox(limit)!
  const box: BBox = { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
  return { box, inside: ringContainment(limit, 0.5), wall: open ? undefined : limit, limit }
}

/** The model's box as a wall ring, anticlockwise. */
const boxRing = (b: BBox): Pt2[] => [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]]

// ─── The wall at the edge of the cut ──────────────────────────────────────────
//
// Every raster line, and every waterline ring that runs into the boundary, ends there,
// and each end leaves a ball-shaped dent in the stock standing beyond it: a wall of
// vertical cusps all along the edge. One pass round the limit, on the surface, cuts them
// into a single clean profile — after each roughing level, and after the finish.
function wallInto(em: PassEmitter, rings: Pt2[][], prevPassDepthMM = 0): void {
  for (const ring of rings) {
    // Dense along the ring, starting at the point nearest the tool.
    const pts: Pt2[] = []
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length]
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / em.sampleStep))
      for (let i = 0; i < n; i++) pts.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n])
    }
    if (pts.length < 2) continue
    let start = 0
    if (em.at) {
      let best = Infinity
      pts.forEach(([x, y], k) => { const d = Math.hypot(x - em.at!.x, y - em.at!.y); if (d < best) { best = d; start = k } })
    }
    let down = false
    let cleared = false   // the stretch since the tool was last down was all cleared ground
    for (let i = 0; i <= pts.length; i++) {
      const [x, y] = pts[(start + i) % pts.length]
      const z = em.edgeTipZ(x, y)
      if (z === null) { down = false; cleared = false; continue }   // no surface here: lift over it
      // An earlier roughing level already took this stretch, as the raster skips it — and,
      // as the raster does, the tool rides over it as travel when that beats lifting.
      if ((prevPassDepthMM > 0 && z - em.allowanceMM >= -prevPassDepthMM + 1e-6) || !em.needsCut(x, y, z)) {
        if (down) cleared = true
        down = false
        continue
      }
      if (down) em.cut(x, y, z)
      else { em.arrive(x, y, z, cleared); down = true; cleared = false }
    }
  }
}

const grow = (b: BBox, d: number): BBox => ({
  minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d,
  width: b.width + 2 * d, height: b.height + 2 * d, cx: b.cx, cy: b.cy,
})

// ─── Public entry point ───────────────────────────────────────────────────────

export function generateProfile3d(
  positions: Float32Array,
  indices: Uint32Array | null,
  bounds: StlModelBounds,
  bbox: BBox,
  tool: Tool,
  params: Profile3dParams,
): MotionSegment[] {
  if (tool.type !== 'ballnose' && tool.type !== 'taper') {
    throw new Error('3D Profile requires a ball nose or taper tool')
  }
  if (bbox.width < 0.001 || bbox.height < 0.001) {
    throw new Error('STL path has zero dimensions')
  }

  const safeZ = params.safeHeightMM ?? 5
  const rapidMmMin = params.rapidMmMin && params.rapidMmMin > 0 ? params.rapidMmMin : 5000
  const finishKernel = toolKernel(tool)
  // Stepover is set by the geometry that finishes a near-horizontal surface, which is
  // the tool's TIP — its ball for both a ball nose and a taper. `diameterMM` is exactly
  // that for either type (a taper stores its tip), so this needs no per-type branch.
  const stepoverMM = Math.max(0.01, tool.diameterMM * params.stepoverPercent / 100)

  const rough = roughPlan(params, tool)

  // The model sits `zOff` below the stock top. With a boundary, the surfaces span the
  // boundary's area plus the reach of the larger tool, and the floor fills what the model
  // does not cover; without one, they are the model's box and nothing else, as always.
  const zOff = params.modelTopMM && params.modelTopMM > 0 ? params.modelTopMM : 0
  // Each tool's centre is kept in by its OWN radius, so both reach the boundary line: kept
  // in by the larger one, the finishing ball stopped short of the roughing and left its
  // scallops standing in a band all along the boundary.
  const reachMM = Math.max(rough ? rough.radius : 0, finishKernel.reachMM)
  const open = !!params.boundaryOpen
  const area = params.boundaryRings?.length ? cutArea(params.boundaryRings, finishKernel.reachMM, open) : undefined
  const roughArea = params.boundaryRings?.length && rough ? cutArea(params.boundaryRings, rough.radius, open) : undefined
  // The walls each pass finishes on: the limit, or the model's own box without a boundary.
  const finishWall = area ? area.wall ?? [] : [boxRing(bbox)]
  const roughWall = roughArea ? roughArea.wall ?? [] : [boxRing(bbox)]
  const G = area ? grow(area.box, reachMM + 1) : bbox
  const floorZ = stlToCnc(bounds, bbox, zOff).z(bounds.minZ)

  // Height map resolution: ≈ stepover / 3 (oversampled), capped at 1500×1500
  const cellSize = Math.max(0.05, stepoverMM / 3)
  const nx = Math.min(1500, Math.max(2, Math.ceil(G.width  / cellSize) + 1))
  const ny = Math.min(1500, Math.max(2, Math.ceil(G.height / cellSize) + 1))

  const grid = buildHeightMap(positions, indices, bounds, bbox, nx, ny,
    // Inside the box (or the boundary), ground the model does not cover is a floor at its
    // lowest point — a round relief in its square box has nothing in the corners, and was
    // left standing there, lifted over as if it were a hole. A hole THROUGH the model is
    // floor too, and is cut down to it.
    area ? { gridBox: G, zOffsetMM: zOff, fill: floorZ } : { zOffsetMM: zOff, fill: floorZ })

  // Compute gouge-free effective surface for the finishing ball (used by both paths)
  const finishSurface = computeToolSurface(grid, nx, ny, G, finishKernel)

  // A ball nose is finished against the model's own triangles (`ballDropCutter`): exact,
  // where the grid reads high on steep walls by design. A taper still reads the grid.
  const drop = tool.type === 'ballnose'
    ? ballDropCutter(positions, indices, bounds, bbox, tool.diameterMM / 2, zOff)
    : undefined
  // Inside a boundary the floor is a plane under everything: the ball can rest on it.
  const exactFinish = drop
    ? (x: number, y: number) => Math.max(drop(x, y) ?? -Infinity, floorZ)
    : undefined
  const finish = (stock: StockModel | null): MotionSegment[] => {
    const em = new PassEmitter(finishSurface, G, params.maxDepthMM, 0, {
      safeZ, rapidMmMin, xyFeedMmMin: tool.xyFeedMmMin, zFeedMmMin: tool.zFeedMmMin,
      enter: finishKernel, stock,
    }, exactFinish, area)
    if (stock) em.rest = { stock, tool: finishKernel }
    if (params.finishStrategy === 'waterline') {
      generateWaterline(em, em.scanBox, {
        stepoverMM, maxDepthMM: params.maxDepthMM, toolDiameterMM: tool.diameterMM,
        cl: (x, y) => em.edgeTipZ(x, y),
        inside: area ? em.inside : undefined,
        limit: area?.limit,
        needsCut: stock ? (x, y, z) => em.needsCut(x, y, z) : undefined,
      })
    } else {
      rasterInto(em, stepoverMM, params.rasterAngleDeg, 0)
    }
    wallInto(em, finishWall)
    return em.done()
  }

  if (!rough) return finish(null)

  // ── Two-pass: roughing + rest-machining finish ────────────────────────────
  // The stock the roughing leaves, for the entries of its later levels and of the finish.
  // Its margin takes in the stock just outside the model that either tool can touch.
  const stock = new StockModel(G, Math.max(rough.radius, finishKernel.reachMM) + 1)
  const roughingSegs = roughPasses(rough, grid, nx, ny, G, params.maxDepthMM, stock, { safeZ, rapidMmMin }, roughArea, roughWall,
    `finishSurface ${finishSurface.nx}×${finishSurface.ny} R=${finishKernel.reachMM.toFixed(3)}mm`)
  return withToolChange(roughingSegs, finish(stock), safeZ, params.finishingToolId ?? tool.id)
}

/** A roughing pass's settings, resolved once from the params: its tool's radius and shape
 *  (a ball, or a flat end mill), its stepover, step down, allowance, angle and feeds. */
interface RoughPlan {
  radius: number
  kernel: ToolKernel
  stepMM: number
  stepDownMM: number
  stockMM: number
  angleDeg: number
  xyFeedMmMin: number
  zFeedMmMin: number
}

/** The roughing pass the params ask for — null when they ask for none. */
function roughPlan(params: Profile3dParams, tool: Tool): RoughPlan | null {
  const radius = params.roughingRadiusMM
  if (radius === undefined || !(radius > 0) || params.roughingStepoverPercent === undefined) return null
  return {
    radius,
    kernel: params.roughingFlat ? flatKernel(radius) : ballKernel(radius),
    stepMM: Math.max(0.01, radius * 2 * params.roughingStepoverPercent / 100),
    stepDownMM: params.roughingStepDownMM && params.roughingStepDownMM > 0 ? params.roughingStepDownMM : radius * 0.75,
    stockMM: params.roughingStockAllowanceMM ?? 0.3,
    angleDeg: params.roughingRasterAngleDeg ?? (params.rasterAngleDeg + 90),
    xyFeedMmMin: params.roughingXyFeedMmMin ?? tool.xyFeedMmMin,
    zFeedMmMin: params.roughingZFeedMmMin ?? tool.zFeedMmMin,
  }
}

/** Every roughing level, carving `stock` as it goes. `grid` is the raw height map over `G`. */
function roughPasses(
  rough: RoughPlan, grid: Float32Array, nx: number, ny: number, G: BBox, maxDepthMM: number,
  stock: StockModel, motion: { safeZ: number; rapidMmMin: number }, area: CutArea | undefined, wall: Pt2[][],
  finishLog: string,
): MotionSegment[] {
  // The model's depth off the raw height map, so the pass count is the model's, not the
  // dilated surface's.
  let rawMaxDepth = 0
  for (let i = 0; i < grid.length; i++) if (-grid[i] > rawMaxDepth) rawMaxDepth = -grid[i]
  // The surface the rougher's tip may follow.
  const surface = computeToolSurface(grid, nx, ny, G, rough.kernel, 350)
  perfLog(`[profile3d] roughSurface ${surface.nx}×${surface.ny} R=${rough.radius}mm stock=${rough.stockMM}mm | ${finishLog}`)
  return generateStepDownPasses(
    surface, G, rough.stepMM, rough.stepDownMM, maxDepthMM, rough.stockMM, rough.angleDeg,
    rawMaxDepth, rough.kernel, stock,
    { ...motion, xyFeedMmMin: rough.xyFeedMmMin, zFeedMmMin: rough.zFeedMmMin }, area, wall,
  )
}

/** Roughing, then a tool-change marker where it ended, then the finish. */
function withToolChange(rough: MotionSegment[], finish: MotionSegment[], safeZ: number, finishingToolId: string): MotionSegment[] {
  const last = rough[rough.length - 1]
  const change: MotionSegment = { x: last?.x ?? 0, y: last?.y ?? 0, z: safeZ, rapid: true, toolChange: finishingToolId }
  return [...rough, change, ...finish]
}
