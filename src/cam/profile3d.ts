import type { MotionSegment } from '../store/toolpathStore'
import { pushAll, maxCutRadiusMM, toolProfileHeightMM } from './geom'
import { perfLog } from '../debug'
import type { Tool } from '../store/toolStore'
import type { StlModelBounds } from '../importers/svgImporter'
import type { BBox } from '../canvas/selectionUtils'


export interface Profile3dParams {
  stepoverPercent: number   // % of finishing tool diameter — spacing between passes
  rasterAngleDeg: number    // scan direction (raster only)
  maxDepthMM: number        // max cut depth below workpiece surface (positive value)
  roughingBallRadius?: number        // set → generate roughing pass then rest-machining finish
  roughingStepoverPercent?: number   // stepover % for roughing pass (XY spacing)
  roughingStepDownMM?: number        // axial depth per roughing pass
  roughingStockAllowanceMM?: number  // how much material to leave for finishing (default 0.3)
  roughingRasterAngleDeg?: number    // scan angle for roughing (defaults to rasterAngleDeg + 90)
  roughingToolId?: string            // toolId used in the toolChange segment marker
  finishingToolId?: string           // toolId used in the toolChange segment marker
  safeHeightMM?: number
}

// ─── Height map ───────────────────────────────────────────────────────────────
//
// The height map stores, for each grid cell (ix, iy), the maximum CNC Z value
// of any STL triangle that covers that cell.  CNC Z = 0 at the workpiece top
// surface; negative values go into the material.
//
// STL model space → CNC space:
//   cncX = (stlX - modelCX) * scaleX + cncBbox.cx
//   cncY = (stlY - modelCY) * scaleY + cncBbox.cy
//   cncZ = (stlZ - bounds.maxZ) * scaleZ   (≤ 0)

export function buildHeightMap(
  positions: Float32Array,
  indices: Uint32Array | null,
  bounds: StlModelBounds,
  bbox: BBox,
  nx: number,
  ny: number,
): Float32Array {
  const modelCX = (bounds.minX + bounds.maxX) / 2
  const modelCY = (bounds.minY + bounds.maxY) / 2
  const scaleX = bbox.width  / (bounds.maxX - bounds.minX)
  const scaleY = bbox.height / (bounds.maxY - bounds.minY)
  const scaleZ = (scaleX + scaleY) / 2

  const cellX = bbox.width  / (nx - 1)
  const cellY = bbox.height / (ny - 1)

  const grid = new Float32Array(nx * ny).fill(-Infinity)

  function vertXYZ(idx: number): [number, number, number] {
    const sx = positions[idx * 3], sy = positions[idx * 3 + 1], sz = positions[idx * 3 + 2]
    return [
      (sx - modelCX) * scaleX + bbox.cx,
      (sy - modelCY) * scaleY + bbox.cy,
      (sz - bounds.maxZ) * scaleZ,
    ]
  }

  const triCount = indices ? indices.length / 3 : positions.length / 9

  for (let t = 0; t < triCount; t++) {
    const i0 = indices ? indices[t * 3]     : t * 3
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2

    const [ax, ay, az] = vertXYZ(i0)
    const [bx, by, bz] = vertXYZ(i1)
    const [cx, cy, cz] = vertXYZ(i2)

    const tMinX = Math.min(ax, bx, cx)
    const tMaxX = Math.max(ax, bx, cx)
    const tMinY = Math.min(ay, by, cy)
    const tMaxY = Math.max(ay, by, cy)

    const ix0 = Math.max(0, Math.floor((tMinX - bbox.minX) / cellX))
    const ix1 = Math.min(nx - 1, Math.ceil((tMaxX - bbox.minX) / cellX))
    const iy0 = Math.max(0, Math.floor((tMinY - bbox.minY) / cellY))
    const iy1 = Math.min(ny - 1, Math.ceil((tMaxY - bbox.minY) / cellY))

    // Pre-compute barycentric denominator
    const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)

    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = bbox.minX + ix * cellX
        const py = bbox.minY + iy * cellY

        // Cross-product sign test (point-in-triangle)
        const d1 = (px - ax) * (by - ay) - (py - ay) * (bx - ax)
        const d2 = (px - bx) * (cy - by) - (py - by) * (cx - bx)
        const d3 = (px - cx) * (ay - cy) - (py - cy) * (ax - cx)
        if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue

        // Barycentric Z interpolation
        let z: number
        if (Math.abs(denom) < 1e-12) {
          z = (az + bz + cz) / 3
        } else {
          const w1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denom
          const w2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denom
          z = w1 * az + w2 * bz + (1 - w1 - w2) * cz
        }

        const idx = iy * nx + ix
        if (z > grid[idx]) grid[idx] = z
      }
    }
  }

  return grid
}

// Bilinear interpolation. Returns null when outside the grid or fully uncovered.
function sampleGrid(
  x: number, y: number,
  grid: Float32Array, nx: number, ny: number,
  minX: number, minY: number, cellX: number, cellY: number,
): number | null {
  const fx = (x - minX) / cellX
  const fy = (y - minY) / cellY
  if (fx < 0 || fx > nx - 1 || fy < 0 || fy > ny - 1) return null

  const ix = Math.min(Math.floor(fx), nx - 2)
  const iy = Math.min(Math.floor(fy), ny - 2)
  const tx = fx - ix, ty = fy - iy

  const h00 = grid[iy * nx + ix]
  const h10 = grid[iy * nx + (ix + 1)]
  const h01 = grid[(iy + 1) * nx + ix]
  const h11 = grid[(iy + 1) * nx + (ix + 1)]

  if (h00 === -Infinity || h10 === -Infinity || h01 === -Infinity || h11 === -Infinity) {
    const valid = [h00, h10, h01, h11].filter((h) => h !== -Infinity)
    return valid.length ? Math.max(...valid) : null
  }

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
interface ToolKernel {
  reachMM: number
  termAtDistSq: (d2: number) => number
}

function ballKernel(radius: number): ToolKernel {
  const r2 = radius * radius
  return { reachMM: radius, termAtDistSq: (d2) => Math.sqrt(r2 - d2) }
}

function toolKernel(tool: Tool): ToolKernel {
  if (tool.type === 'ballnose') return ballKernel(tool.diameterMM / 2)
  const reachMM = maxCutRadiusMM(tool)
  return { reachMM, termAtDistSq: (d2) => reachMM - toolProfileHeightMM(tool, Math.sqrt(d2)) }
}

function computeToolSurface(
  srcGrid: Float32Array, srcNX: number, srcNY: number,
  bbox: BBox, kernel: ToolKernel,
  maxCells = 750,  // cap grid resolution for speed; roughing uses 350, finishing uses 750
): { grid: Float32Array; nx: number; ny: number; cellX: number; cellY: number } {
  const radius = kernel.reachMM
  const scale = Math.max(1, Math.ceil(Math.max(srcNX, srcNY) / maxCells))
  const nx    = Math.ceil(srcNX / scale)
  const ny    = Math.ceil(srcNY / scale)
  const cellX = bbox.width  / Math.max(1, nx - 1)
  const cellY = bbox.height / Math.max(1, ny - 1)

  // Downsample using max so no surface peak is missed
  const src = new Float32Array(nx * ny).fill(-Infinity)
  for (let iy = 0; iy < srcNY; iy++) {
    for (let ix = 0; ix < srcNX; ix++) {
      const v = srcGrid[iy * srcNX + ix]
      if (v === -Infinity) continue
      const di = Math.min(Math.round(ix / scale), nx - 1)
      const dj = Math.min(Math.round(iy / scale), ny - 1)
      const idx = dj * nx + di
      if (v > src[idx]) src[idx] = v
    }
  }

  // Dilation: for each surface cell, push its minimum-required tool-Z into neighbors
  const result = new Float32Array(nx * ny).fill(-Infinity)
  const r2  = radius * radius
  const rcX = Math.ceil(radius / cellX) + 1
  const rcY = Math.ceil(radius / cellY) + 1

  // The kernel depends only on the offset, so evaluate the profile ONCE per offset
  // rather than once per (cell, offset) pair — and the inner loop loses its sqrt.
  const kw = 2 * rcX + 1
  const kern = new Float64Array(kw * (2 * rcY + 1))
  for (let dj = -rcY; dj <= rcY; dj++) {
    const dy = dj * cellY, dy2 = dy * dy
    for (let di = -rcX; di <= rcX; di++) {
      const dx = di * cellX
      const d2 = dx * dx + dy2
      kern[(dj + rcY) * kw + (di + rcX)] = d2 > r2 ? NaN : kernel.termAtDistSq(d2)
    }
  }

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const h = src[iy * nx + ix]
      if (h === -Infinity) continue
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

  return { grid: result, nx, ny, cellX, cellY }
}

// ─── Step-down roughing ───────────────────────────────────────────────────────
//
// Runs the raster algorithm at increasing depth limits (stepDownMM per pass).
// Each pass follows the 3D surface, clamped at the current maximum depth.

function generateStepDownPasses(
  grid: Float32Array, nx: number, ny: number,
  bbox: BBox, cellX: number, cellY: number,
  stepoverMM: number,
  stepDownMM: number,
  maxDepthMM: number,
  stockAllowanceMM: number,
  rasterAngleDeg: number,
  rawMaxDepthMM?: number,  // raw surface max depth — avoids inflated pass count from dilation
  safeZ = 5,
): MotionSegment[] {
  // Use raw surface depth when provided (avoids counting dilation artefacts as extra passes).
  // Fall back to scanning the effective grid only if the raw depth isn't available.
  let surfaceMaxDepth: number
  if (rawMaxDepthMM !== undefined) {
    surfaceMaxDepth = rawMaxDepthMM
  } else {
    surfaceMaxDepth = 0
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] !== -Infinity && -grid[i] > surfaceMaxDepth) surfaceMaxDepth = -grid[i]
    }
  }
  const effectiveMaxDepth = Math.min(surfaceMaxDepth, maxDepthMM)
  const numPasses = Math.ceil(effectiveMaxDepth / stepDownMM)

  perfLog(`[profile3d] roughing: ${numPasses} passes, effectiveMaxDepth=${effectiveMaxDepth.toFixed(2)}mm, stepDown=${stepDownMM}mm, stock=${stockAllowanceMM}mm`)

  const segs: MotionSegment[] = []
  for (let n = 1; n <= numPasses; n++) {
    const passDepth   = Math.min(n * stepDownMM, effectiveMaxDepth)
    const prevDepthMM = (n - 1) * stepDownMM   // skip areas already cut in previous pass
    pushAll(segs, generateRaster(grid, nx, ny, bbox, cellX, cellY,
      stepoverMM, rasterAngleDeg, passDepth, stockAllowanceMM, prevDepthMM, safeZ))
  }

  return segs
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
// When roughedInfo is provided, points where roughing already cleared to the
// finish depth are skipped (rest machining). The function handles gaps within
// scanlines by emitting proper retract/rapid moves between cut groups.

function generateRaster(
  grid: Float32Array, nx: number, ny: number,
  bbox: BBox, cellX: number, cellY: number,
  stepoverMM: number, rasterAngleDeg: number,
  maxDepthMM: number,
  stockAllowanceMM = 0,   // lift tip above surface (roughing clearance); 0 = finishing
  prevPassDepthMM  = 0,   // skip points already cut at this depth in a prior pass
  safeZ = 5,
): MotionSegment[] {
  const segs: MotionSegment[] = []
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

  const sampleStep = Math.min(cellX, cellY) * 0.5
  let lastX = 0, lastY = 0
  let inGroup = false
  let hasCut = false
  let pass = 0

  const beginGroup = (x: number, y: number, z: number) => {
    if (hasCut) segs.push({ x: lastX, y: lastY, z: safeZ, rapid: true })
    segs.push({ x, y, z: safeZ, rapid: true })
    segs.push({ x, y, z, rapid: false })
    hasCut = true; inGroup = true; lastX = x; lastY = y
  }

  const endGroup = () => {
    if (inGroup) {
      segs.push({ x: lastX, y: lastY, z: safeZ, rapid: true })
      inGroup = false
    }
  }

  for (let ry = rsMinY; ry <= rsMaxY + 1e-6; ry += stepoverMM, pass++) {
    const clampedRY = Math.min(ry, rsMaxY)
    const forward = pass % 2 === 0

    const rxRange: number[] = []
    for (let rx = rsMinX; rx <= rsMaxX + 1e-6; rx += sampleStep) rxRange.push(rx)
    if (!forward) rxRange.reverse()

    for (const rx of rxRange) {
      const cncX = rx * cosA - clampedRY * sinA
      const cncY = rx * sinA + clampedRY * cosA
      if (cncX < bbox.minX - 1e-3 || cncX > bbox.maxX + 1e-3 ||
          cncY < bbox.minY - 1e-3 || cncY > bbox.maxY + 1e-3) continue

      const h = sampleGrid(cncX, cncY, grid, nx, ny, bbox.minX, bbox.minY, cellX, cellY)
      // null = outside the STL footprint (waste material) — skip without retracting
      if (h === null) continue

      // Already cleared by a previous roughing pass — retract so the move to the next
      // deep feature doesn't gouge through the shallower surface that remains here.
      if (prevPassDepthMM > 0 && h >= -prevPassDepthMM + 1e-6) { endGroup(); continue }

      const surfZ = Math.max(h, -maxDepthMM)
      const toolZ = surfZ + stockAllowanceMM

      if (!inGroup) {
        beginGroup(cncX, cncY, toolZ)
      } else {
        segs.push({ x: cncX, y: cncY, z: toolZ, rapid: false })
        lastX = cncX; lastY = cncY
      }
    }

    endGroup()  // retract at the end of each scanline so the between-line move clears the model
  }

  return segs
}

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
  const finishKernel = toolKernel(tool)
  // Stepover is set by the geometry that finishes a near-horizontal surface, which is
  // the tool's TIP — its ball for both a ball nose and a taper. `diameterMM` is exactly
  // that for either type (a taper stores its tip), so this needs no per-type branch.
  const stepoverMM = Math.max(0.01, tool.diameterMM * params.stepoverPercent / 100)

  // Height map resolution: ≈ stepover / 3 (oversampled), capped at 1500×1500
  const cellSize = Math.max(0.05, stepoverMM / 3)
  const nx = Math.min(1500, Math.max(2, Math.ceil(bbox.width  / cellSize) + 1))
  const ny = Math.min(1500, Math.max(2, Math.ceil(bbox.height / cellSize) + 1))

  const grid = buildHeightMap(positions, indices, bounds, bbox, nx, ny)

  const hasRoughing = params.roughingBallRadius !== undefined &&
                      params.roughingBallRadius > 0 &&
                      params.roughingStepoverPercent !== undefined

  // Compute gouge-free effective surface for the finishing ball (used by both paths)
  const finishSurface = computeToolSurface(grid, nx, ny, bbox, finishKernel)

  if (!hasRoughing) {
    return generateRaster(finishSurface.grid, finishSurface.nx, finishSurface.ny,
      bbox, finishSurface.cellX, finishSurface.cellY,
      stepoverMM, params.rasterAngleDeg, params.maxDepthMM, 0, 0, safeZ)
  }

  // ── Two-pass: roughing + rest-machining finish ────────────────────────────

  const roughRadius = params.roughingBallRadius!
  const roughStepMM = Math.max(0.01, roughRadius * 2 * params.roughingStepoverPercent! / 100)
  const roughStepDownMM = params.roughingStepDownMM && params.roughingStepDownMM > 0
    ? params.roughingStepDownMM
    : roughRadius * 0.75
  const roughStockMM = params.roughingStockAllowanceMM ?? 0.3

  // Compute raw surface max depth before dilation so pass count is based on actual model depth.
  let rawMaxDepth = 0
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i]
    if (v !== -Infinity && -v > rawMaxDepth) rawMaxDepth = -v
  }

  const roughSurface = computeToolSurface(grid, nx, ny, bbox, ballKernel(roughRadius), 350)
  perfLog(`[profile3d] roughSurface ${roughSurface.nx}×${roughSurface.ny} R=${roughRadius}mm stock=${roughStockMM}mm | finishSurface ${finishSurface.nx}×${finishSurface.ny} R=${finishKernel.reachMM.toFixed(3)}mm`)

  const roughAngleDeg = params.roughingRasterAngleDeg ?? (params.rasterAngleDeg + 90)

  const roughingSegs = generateStepDownPasses(
    roughSurface.grid, roughSurface.nx, roughSurface.ny,
    bbox, roughSurface.cellX, roughSurface.cellY,
    roughStepMM, roughStepDownMM, params.maxDepthMM,
    roughStockMM, roughAngleDeg,
    rawMaxDepth, safeZ,
  )

  const finishingSegs = generateRaster(finishSurface.grid, finishSurface.nx, finishSurface.ny,
    bbox, finishSurface.cellX, finishSurface.cellY,
    stepoverMM, params.rasterAngleDeg, params.maxDepthMM, 0, 0, safeZ)

  // Stitch together: roughing → tool-change marker → finishing
  const lastRough = roughingSegs[roughingSegs.length - 1]
  const finishingToolId = params.finishingToolId ?? tool.id

  const toolChangeSeg: MotionSegment = {
    x:    lastRough?.x ?? 0,
    y:    lastRough?.y ?? 0,
    z:    safeZ,
    rapid: true,
    toolChange: finishingToolId,
  }

  return [...roughingSegs, toolChangeSeg, ...finishingSegs]
}
