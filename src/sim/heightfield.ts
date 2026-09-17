// Heightfield material-removal model — the carve math, with no rendering attached.
//
// The stock is a regular grid of height samples (`topZ`, one per vertex, mm above the
// stock bottom). `carve()` lowers the samples a swept tool passes over. `HeightfieldMaterial`
// wraps one of these and hands `topZ` to a GPU texture; tests drive the same instance
// directly to assert what a toolpath actually removed. Nothing here touches three.js.
//
// Coordinate convention: segment XY is workpiece-local mm shifted by (orgX, orgY); segment Z
// is top-referenced (0 = stock top, negative = into the material), while `topZ` holds height
// above the stock bottom (0 … T).
import { vRadiusAtHeightMM, vConeOffsetMM } from '../cam/geom'
import type { SimSegment, ToolState } from './gcodeParser'
import { segTool } from './gcodeParser'

export const TARGET_CELL_MM = 0.05     // desired sample spacing where cuts happen
export const MAX_SAMPLES = 4_000_000   // cap total grid samples (texture + vertices)
export const MAX_AXIS = 4096           // hard cap on samples per axis

export interface CutBounds { x0: number; y0: number; x1: number; y1: number; empty: boolean }

export interface HeightfieldGrid {
  NX: number
  NY: number
  sx: number      // sample spacing X (mm)
  sy: number      // sample spacing Y (mm)
  gx0: number     // grid origin X in workpiece-local mm
  gy0: number     // grid origin Y in workpiece-local mm
  T: number       // stock thickness
  orgX: number
  orgY: number
}

function segMaxRadius(seg: SimSegment, toolStates: ToolState[]): number {
  const ts = segTool(seg, toolStates)
  if (ts.toolVbitHalfAngleTan) {
    const h = Math.max(Math.abs(seg.prevZ), Math.abs(seg.z))
    return vRadiusAtHeightMM(h, ts.toolVbitHalfAngleTan, ts.toolTipRadiusMM ?? 0)
  }
  return ts.toolDiameterMM / 2
}

// Bounding box (workpiece-local mm) of every cutting move's footprint, padded and
// clamped to the stock. The heightfield only grids this region so resolution can
// concentrate where material is actually removed instead of being spread evenly
// over the whole stock. `empty` = no cuts inside the stock (grid the whole block
// coarsely — it stays flat anyway).
export function computeCutBounds(
  segments: SimSegment[], toolStates: ToolState[],
  orgX: number, orgY: number, W: number, H: number,
): CutBounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const seg of segments) {
    if (seg.rapid || (seg.prevZ >= 0 && seg.z >= 0)) continue
    const ax = seg.prevX + orgX, ay = seg.prevY + orgY
    const bx = seg.x + orgX, by = seg.y + orgY
    const r = segMaxRadius(seg, toolStates)
    const sx0 = Math.min(ax, bx) - r, sx1 = Math.max(ax, bx) + r
    const sy0 = Math.min(ay, by) - r, sy1 = Math.max(ay, by) + r
    if (sx1 <= 0 || sx0 >= W || sy1 <= 0 || sy0 >= H) continue  // wholly off the stock
    x0 = Math.min(x0, sx0); y0 = Math.min(y0, sy0)
    x1 = Math.max(x1, sx1); y1 = Math.max(y1, sy1)
  }
  if (!isFinite(x0)) return { x0: 0, y0: 0, x1: W, y1: H, empty: true }
  const pad = 1.0  // keep a flat-stock margin around the cuts so edges meet the apron cleanly
  return {
    x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad),
    x1: Math.min(W, x1 + pad), y1: Math.min(H, y1 + pad),
    empty: false,
  }
}

// Grid the cut region at TARGET_CELL_MM, coarsened if that would blow the sample budget.
// `cellMM` overrides the target (tests use a fixed spacing so tolerances are predictable).
export function gridForSegments(
  W: number, H: number, T: number,
  segments: SimSegment[], toolStates: ToolState[],
  orgX: number, orgY: number,
  cellMM?: number,
): HeightfieldGrid & { bounds: CutBounds } {
  const bounds = computeCutBounds(segments, toolStates, orgX, orgY, W, H)
  const regionW = Math.max(bounds.x1 - bounds.x0, 1e-3)
  const regionH = Math.max(bounds.y1 - bounds.y0, 1e-3)
  const targetCell = cellMM ?? (bounds.empty ? Math.max(W, H) / 4 : TARGET_CELL_MM)
  const byBudget = Math.sqrt((regionW * regionH) / MAX_SAMPLES)
  const cell = Math.max(targetCell, byBudget, 0.01)
  const NX = Math.max(2, Math.min(MAX_AXIS, Math.round(regionW / cell) + 1))
  const NY = Math.max(2, Math.min(MAX_AXIS, Math.round(regionH / cell) + 1))
  return {
    NX, NY,
    sx: regionW / (NX - 1),
    sy: regionH / (NY - 1),
    gx0: bounds.x0, gy0: bounds.y0,
    T, orgX, orgY,
    bounds,
  }
}

/**
 * The height a V-bit or taper pass leaves at one cell, at pass parameter `tRaw`:
 * z(t) plus the tool's own profile at the cell's distance from the tool axis — a tip
 * ball out to `dT`, then the cone. The `f` that `carve` minimises.
 *
 * A plain function rather than a closure made per grid cell: this is the inner loop of
 * the 3D sim's carve and of the toolpath and inlay-fit audits.
 */
function vbitSurface(
  tRaw: number, tcRaw: number, lenSq: number, perpSq: number,
  prevZ: number, dz: number,
  dT: number, tipR: number, vbitTan: number, off: number,
): number {
  const tt = Math.max(0, Math.min(1, tRaw))
  const dt = tt - tcRaw
  const d = Math.sqrt(dt * dt * lenSq + perpSq)
  const prof = d <= dT
    ? tipR - Math.sqrt(Math.max(0, tipR * tipR - d * d))
    : d / vbitTan - off
  return (prevZ + tt * dz) + prof
}

export class Heightfield {
  readonly topZ: Float32Array
  readonly NX: number
  readonly NY: number
  readonly sx: number
  readonly sy: number
  readonly gx0: number
  readonly gy0: number
  readonly T: number
  readonly orgX: number
  readonly orgY: number
  readonly cellMM: number

  anyCarved = false
  dirty = false

  constructor(grid: HeightfieldGrid) {
    this.NX = grid.NX
    this.NY = grid.NY
    this.sx = grid.sx
    this.sy = grid.sy
    this.gx0 = grid.gx0
    this.gy0 = grid.gy0
    this.T = grid.T
    this.orgX = grid.orgX
    this.orgY = grid.orgY
    this.cellMM = (grid.sx + grid.sy) / 2
    this.topZ = new Float32Array(grid.NX * grid.NY).fill(grid.T)
  }

  reset() {
    this.topZ.fill(this.T)
    this.anyCarved = false
    this.dirty = true
  }

  /** Material height (mm above stock bottom) at a workpiece-local mm point, or null off-grid. */
  heightAt(x: number, y: number): number | null {
    const i = Math.round((x - this.gx0) / this.sx)
    const j = Math.round((y - this.gy0) / this.sy)
    if (i < 0 || j < 0 || i >= this.NX || j >= this.NY) return null
    return this.topZ[j * this.NX + i]
  }

  /** Carve every cutting move of a parsed program. */
  carveAll(segments: SimSegment[], toolStates: ToolState[]) {
    for (const s of segments) {
      if (s.rapid || (s.prevZ >= 0 && s.z >= 0)) continue
      const ts = segTool(s, toolStates)
      this.carve(s.prevX, s.prevY, s.x, s.y, s.prevZ, s.z, ts.toolVbitHalfAngleTan, ts.toolBallNose, ts.toolDiameterMM, ts.toolTipRadiusMM)
    }
  }

  // The per-cell carve math (flat / ball / V-bit) — a closest-point model evaluated over
  // the uniform grid.
  carve(
    ax: number, ay: number, bx: number, by: number,
    prevZ: number, endZ: number,
    vbitTan?: number,
    ballNose?: boolean,
    toolDiameterMM = 0,
    tipRadiusMM = 0,
  ) {
    const dz = endZ - prevZ
    // Deliberately NOT capped at the tool's own diameter: this model has always let the
    // cone run on past full engagement, the inlay pipeline v-carves to 2.5× the socket
    // depth on that basis, and capping it here moved every V-bit socket in the fit audit.
    const r = vbitTan
      ? vRadiusAtHeightMM(Math.max(Math.abs(prevZ), Math.abs(endZ)), vbitTan, tipRadiusMM)
      : toolDiameterMM / 2
    if (r <= 0) return

    // Deepest achievable height (tip, deepest Z) — cells already at/below skip.
    const flatH = Math.max(0, this.T + Math.min(prevZ, endZ))

    ax += this.orgX; ay += this.orgY
    bx += this.orgX; by += this.orgY
    const dx = bx - ax, dy = by - ay
    const lenSq = dx * dx + dy * dy

    // Samples are points on an (sx, sy) grid: a sample within half a cell
    // diagonal of the swept edge represents material the cut at least partly
    // removed. Without this coverage margin, two passes whose footprints
    // exactly touch (inside + outside profile on the same path) leave a chain
    // of full-height single-cell spikes wherever a sample center lands
    // epsilon outside both footprints — a ~µm-wide real sliver rendered as a
    // cell-wide wall. Leftovers wider than a cell still show.
    const covEps = 0.5 * Math.hypot(this.sx, this.sy)
    const rPad = r + covEps

    const { NX, NY, sx, sy, gx0, gy0, topZ } = this
    const iMin = Math.max(0, Math.floor((Math.min(ax, bx) - rPad - gx0) / sx))
    const iMax = Math.min(NX - 1, Math.ceil((Math.max(ax, bx) + rPad - gx0) / sx))
    const jMin = Math.max(0, Math.floor((Math.min(ay, by) - rPad - gy0) / sy))
    const jMax = Math.min(NY - 1, Math.ceil((Math.max(ay, by) + rPad - gy0) / sy))

    // The V-bit/taper profile's constants depend on the TOOL alone, so they are worked out
    // once per segment here rather than once per grid cell inside the loop below.
    const dT = vbitTan && tipRadiusMM > 0 ? tipRadiusMM / Math.sqrt(1 + vbitTan * vbitTan) : 0   // r·cosθ
    const off = vbitTan ? vConeOffsetMM(vbitTan, tipRadiusMM) : 0
    const r0sq = tipRadiusMM * tipRadiusMM
    const dTsq = dT * dT

    for (let j = jMin; j <= jMax; j++) {
      const py = gy0 + j * sy
      const rowBase = j * NX
      for (let i = iMin; i <= iMax; i++) {
        const idx = rowBase + i
        const cur = topZ[idx]
        if (cur <= flatH) continue
        const px = gx0 + i * sx

        const ex = px - ax, ey = py - ay
        const proj = ex * dx + ey * dy
        // Vertical segment (peck-drill plunge): no XY travel to parameterize,
        // so evaluate at the deepest end — the tip reaches min(prevZ, endZ)
        // over the whole footprint. Falling back to t=0 (start Z) left the
        // final peck depth uncarved, so drills never punched through.
        const tc_raw = lenSq < 1e-8 ? (dz < 0 ? 1 : 0) : proj / lenSq
        const dist0sq = ex * ex + ey * ey
        const perp_sq = Math.max(0, dist0sq - tc_raw * proj)

        let newH: number
        if (vbitTan) {
          // Surface the swept cutter leaves at this cell: min over the pass of
          // z(t) + f(dist(t)), where f is the tool's own profile — a cone for a
          // V-bit, a tip ball blended into that cone for a taper.
          //
          // f is convex and C1, so the minimum of z + f(dist) over [0,1] sits at one of:
          // an interval end, the closest-approach point, either piece's own optimum, or
          // the ball/cone boundary. Evaluating all of them is exact, not a search.
          let fMin = Math.min(
            vbitSurface(0, tc_raw, lenSq, perp_sq, prevZ, dz, dT, tipRadiusMM, vbitTan, off),
            vbitSurface(1, tc_raw, lenSq, perp_sq, prevZ, dz, dT, tipRadiusMM, vbitTan, off),
            vbitSurface(Math.max(0, Math.min(1, tc_raw)), tc_raw, lenSq, perp_sq, prevZ, dz, dT, tipRadiusMM, vbitTan, off),
          )
          const discrim = lenSq * (lenSq - dz * dz * vbitTan * vbitTan)
          if (discrim > 1e-12 && perp_sq > 1e-12) {
            const t_opt = tc_raw - dz * vbitTan * Math.sqrt(perp_sq) / Math.sqrt(discrim)
            fMin = Math.min(fMin, vbitSurface(t_opt, tc_raw, lenSq, perp_sq, prevZ, dz, dT, tipRadiusMM, vbitTan, off))
          }
          if (dT > 0) {
            if (r0sq > perp_sq && lenSq > 1e-12) {
              // Ball-piece optimum: uL = −dz·√(r0²−d²) solved for u = t − tc_raw.
              const u = -Math.sign(dz) * Math.abs(dz) *
                Math.sqrt((r0sq - perp_sq) / (lenSq * (lenSq + dz * dz)))
              fMin = Math.min(fMin, vbitSurface(tc_raw + u, tc_raw, lenSq, perp_sq, prevZ, dz, dT, tipRadiusMM, vbitTan, off))
            }
            if (dTsq > perp_sq && lenSq > 1e-12) {
              const u = Math.sqrt((dTsq - perp_sq) / lenSq)
              fMin = Math.min(fMin,
                vbitSurface(tc_raw - u, tc_raw, lenSq, perp_sq, prevZ, dz, dT, tipRadiusMM, vbitTan, off),
                vbitSurface(tc_raw + u, tc_raw, lenSq, perp_sq, prevZ, dz, dT, tipRadiusMM, vbitTan, off))
            }
          }
          newH = Math.max(0, this.T + fMin)
        } else if (ballNose) {
          const tc = Math.max(0, Math.min(1, tc_raw))
          const z_tc = prevZ + tc * dz
          if (z_tc >= 0) continue
          const br = toolDiameterMM / 2
          const dt = tc - tc_raw
          const dist = Math.sqrt(dt * dt * lenSq + perp_sq)
          // Rim cells inside the coverage margin carve to the sphere equator
          // (the max(0, …) clamp degrades to exactly that past dist = br).
          if (dist > br + covEps) continue
          newH = Math.max(0, this.T + z_tc + br - Math.sqrt(Math.max(0, br * br - dist * dist)))
        } else {
          const tc = Math.max(0, Math.min(1, tc_raw))
          const z_tc = prevZ + tc * dz
          if (z_tc >= 0) continue
          const dt = tc - tc_raw
          const dist = Math.sqrt(dt * dt * lenSq + perp_sq)
          if (dist > rPad) continue
          newH = Math.max(0, this.T + z_tc)
        }

        if (cur > newH) {
          topZ[idx] = newH
          this.dirty = true
          this.anyCarved = true
        }
      }
    }
  }
}
