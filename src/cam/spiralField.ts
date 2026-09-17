// Poisson "temperature" field for the curvilinear-spiral pocket strategy.
//
// Solves −∆T = 1 with T = 0 on every wall (the eroded pocket boundary and every
// grown island) on a regular grid, by SOR. The solution is a smooth scalar field
// that is 0 at the walls and rises to local maxima along the pocket's medial
// ridge. Its level sets (isotherms, traced in marchingSquares.ts) are the
// structure curves of Bieterman's curvilinear spiral, and its maxima are the
// spiral seed points (where we helix in).
//
// All geometry is CNC mm, Y-up. The caller passes the tool-centre domain already
// offset: outer rings = boundary eroded by the tool radius, holes = islands grown
// by the tool radius.

import type { Pt2 } from './pathFlattener'

export interface FieldGrid {
  T: Float32Array        // temperature, 0 outside the domain
  inside: Uint8Array     // 1 where a cell centre is in the tool-centre domain
  gw: number
  gh: number
  x0: number             // CNC x of grid column 0
  y0: number             // CNC y of grid row 0
  cell: number           // cell size (mm)
  tMax: number
}

// Even-odd scanline rasterization of a polygon set onto the grid NODES (points at
// x0 + ix*cell, y0 + iy*cell). Row-at-a-time: O(rows·vertices + cells), where the
// obvious point-in-polygon-per-cell version is O(cells·vertices) — on an imported
// boundary of a few thousand vertices that difference alone was seconds.
function fillNodes(polys: Pt2[][], gw: number, gh: number, x0: number, y0: number, cell: number): Uint8Array {
  const out = new Uint8Array(gw * gh)
  const xs: number[] = []
  for (let iy = 0; iy < gh; iy++) {
    const py = y0 + iy * cell
    xs.length = 0
    for (const poly of polys) {
      const n = poly.length
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = poly[i][1], yj = poly[j][1]
        // Same half-open crossing rule as the point-in-polygon test this replaces,
        // so a node exactly on a horizontal grid line classifies identically.
        if ((yi > py) !== (yj > py)) {
          xs.push(poly[j][0] + ((py - yj) * (poly[i][0] - poly[j][0])) / (yi - yj))
        }
      }
    }
    if (xs.length < 2) continue
    xs.sort((a, b) => a - b)
    const row = iy * gw
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // pointInPolys used a strict `px < crossing` test, so a node exactly on the
      // left crossing is outside and one on the right crossing is inside.
      let i0 = Math.floor((xs[k] - x0) / cell) + 1
      let i1 = Math.floor((xs[k + 1] - x0) / cell)
      if (i0 < 0) i0 = 0
      if (i1 > gw - 1) i1 = gw - 1
      for (let ix = i0; ix <= i1; ix++) out[row + ix] = 1
    }
  }
  return out
}

function insideMask(outers: Pt2[][], holes: Pt2[][], gw: number, gh: number, x0: number, y0: number, cell: number): Uint8Array {
  const inside = fillNodes(outers, gw, gh, x0, y0, cell)
  if (holes.length > 0) {
    const hole = fillNodes(holes, gw, gh, x0, y0, cell)
    for (let i = 0; i < inside.length; i++) if (hole[i]) inside[i] = 0
  }
  return inside
}

// SOR sweeps for −∆T = 1 ⇒ T_P = (T_E + T_W + T_N + T_S + h²) / 4. Cells outside the
// domain hold T = 0 (Dirichlet), so they contribute 0 to interior neighbours.
function relax(T: Float32Array, inside: Uint8Array, gw: number, gh: number, cell: number, maxIter: number): void {
  const h2 = cell * cell
  const omega = 1.85
  const tol = 1e-4 * h2
  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0
    for (let iy = 1; iy < gh - 1; iy++) {
      for (let ix = 1; ix < gw - 1; ix++) {
        const idx = iy * gw + ix
        if (!inside[idx]) continue
        const sum = T[idx - 1] + T[idx + 1] + T[idx - gw] + T[idx + gw]
        const next = T[idx] + omega * ((sum + h2) / 4 - T[idx])
        const d = Math.abs(next - T[idx])
        T[idx] = next
        if (d > maxDelta) maxDelta = d
      }
    }
    if (maxDelta < tol) break
  }
}

// Most cells the FINEST field grid may have — the same budget adaptive2 uses for its own.
//
// THE FINE GRID USED TO HAVE NO BUDGET AT ALL. The coarse-to-fine levels below coarsen only
// to build the levels UNDER the requested cell; the finest is always the caller's, and the
// caller's is `max(0.25, toolRadius / 4)`. A full 2440 × 1220 mm sheet with a 2 mm tool is
// 47.6 million cells at 0.25 — the field, the inside mask, the hole mask and three smoothing
// copies come to several hundred MB, and the worker is killed with nothing but "Worker
// error" to say why. Every other grid in the CAM code already had a cap. The field is a
// steering function, not cut geometry, so a coarser one only makes the isotherms a little
// less fine; the tool-centre limits the spiral is clamped to are the real rings either way.
export const MAX_FIELD_CELLS = 6e6

/**
 * The cell the field is actually solved at: `cell` itself whenever that grid fits
 * MAX_FIELD_CELLS — so every ordinary pocket is solved exactly as it always was — else
 * grown by 1.4× steps until it does. Sized with the same formula as `gridAt` below.
 */
export function fieldCellFor(spanX: number, spanY: number, cell: number): number {
  if (!(cell > 0)) return cell
  let c = cell
  while ((Math.ceil(spanX / c) + 3) * (Math.ceil(spanY / c) + 3) > MAX_FIELD_CELLS) c *= 1.4
  return c
}

// Rasterize the domain and solve the Poisson field.
//  outers — tool-centre boundary rings (boundary eroded by tool radius)
//  holes  — island rings grown by tool radius
// The returned grid's `cell` is the one it was SOLVED at (see fieldCellFor), which is coarser
// than the one asked for when the domain is huge — read it from the grid, never assume.
export function solveField(
  outers: Pt2[][], holes: Pt2[][], cell: number,
  onProgress?: (frac: number) => void,
): FieldGrid {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const poly of outers) for (const [x, y] of poly) {
    if (x < minx) minx = x; if (x > maxx) maxx = x
    if (y < miny) miny = y; if (y > maxy) maxy = y
  }
  if (!Number.isFinite(minx)) {
    return { T: new Float32Array(0), inside: new Uint8Array(0), gw: 0, gh: 0, x0: 0, y0: 0, cell, tMax: 0 }
  }
  cell = fieldCellFor(maxx - minx, maxy - miny, cell)

  // Grid geometry for a given cell size. One-cell margin so the domain border has an
  // outside (T=0) ring of nodes.
  const gridAt = (c: number) => ({
    cell: c,
    x0: minx - c,
    y0: miny - c,
    gw: Math.ceil((maxx - minx) / c) + 3,
    gh: Math.ceil((maxy - miny) / c) + 3,
  })

  // Coarse-to-fine (nested iteration). Point SOR needs O(N) sweeps to converge on an
  // N×N grid and each sweep is O(N²), so solving the fine grid from a cold start is
  // O(N³) — that was ~19 s on a 300 mm pocket, and worse on small tools, which drive
  // the cell size down. Solving a 2× coarser grid instead is 8× cheaper; doing that
  // recursively down to a grid small enough to solve outright, then interpolating each
  // solution up as the next level's initial guess, leaves only smooth, short-range error
  // for the fine sweeps to clean up. Same field, ~two orders of magnitude less work.
  const COARSEST_DIM = 48
  const scales: number[] = [1]
  {
    let c = cell
    let g = gridAt(c)
    while (Math.max(g.gw, g.gh) > COARSEST_DIM && scales.length < 8) {
      c *= 2
      scales.push(scales[scales.length - 1] * 2)
      g = gridAt(c)
    }
  }

  let coarse: { T: Float32Array; gw: number; gh: number; x0: number; y0: number; cell: number } | null = null
  let result!: FieldGrid

  for (let li = scales.length - 1; li >= 0; li--) {
    // Coarse levels are cheap and fine ones dominate, so weight by cell count rather than
    // by level index — otherwise the bar races to 80% and then sits there.
    onProgress?.(1 - 4 ** -(scales.length - 1 - li))
    const g = gridAt(cell * scales[li])
    const inside = insideMask(outers, holes, g.gw, g.gh, g.x0, g.y0, g.cell)
    const T = new Float32Array(g.gw * g.gh)

    if (coarse) {
      // Bilinear prolongation. The levels are not index-nested (each has its own
      // one-cell margin), so sample the coarse solution at each fine node's CNC
      // position rather than by index arithmetic.
      const { T: cT, gw: cgw, gh: cgh, x0: cx0, y0: cy0, cell: ccell } = coarse
      for (let iy = 0; iy < g.gh; iy++) {
        const py = g.y0 + iy * g.cell
        const fy = (py - cy0) / ccell
        const j0 = Math.max(0, Math.min(cgh - 1, Math.floor(fy)))
        const j1 = Math.min(cgh - 1, j0 + 1)
        const ty = fy - j0
        for (let ix = 0; ix < g.gw; ix++) {
          const idx = iy * g.gw + ix
          if (!inside[idx]) continue
          const px = g.x0 + ix * g.cell
          const fx = (px - cx0) / ccell
          const i0 = Math.max(0, Math.min(cgw - 1, Math.floor(fx)))
          const i1 = Math.min(cgw - 1, i0 + 1)
          const tx = fx - i0
          const v00 = cT[j0 * cgw + i0], v10 = cT[j0 * cgw + i1]
          const v01 = cT[j1 * cgw + i0], v11 = cT[j1 * cgw + i1]
          T[idx] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty
        }
      }
    }

    // Coarsest level starts cold and must converge on its own; every finer level
    // inherits a good guess and only has to smooth the interpolation error.
    const maxIter = coarse ? Math.max(30, Math.min(400, Math.max(g.gw, g.gh))) : Math.min(20000, 60 * Math.max(g.gw, g.gh))
    relax(T, inside, g.gw, g.gh, g.cell, maxIter)

    if (li === 0) {
      // Smooth out grid-scale variation along ridges. The Poisson solution has small
      // cell-to-cell wobble along a flat medial ridge (especially diagonal ones, which
      // the axis-aligned grid staircases); each bump would otherwise read as a separate
      // local maximum and spawn a redundant spiral. A few neighbour-averaging passes
      // (over interior cells only, so walls stay at 0) merge a ridge into one crest.
      for (let pass = 0; pass < 3; pass++) {
        const src = T.slice()
        for (let iy = 1; iy < g.gh - 1; iy++) {
          for (let ix = 1; ix < g.gw - 1; ix++) {
            const idx = iy * g.gw + ix
            if (!inside[idx]) continue
            let sum = src[idx], cnt = 1
            if (inside[idx - 1]) { sum += src[idx - 1]; cnt++ }
            if (inside[idx + 1]) { sum += src[idx + 1]; cnt++ }
            if (inside[idx - g.gw]) { sum += src[idx - g.gw]; cnt++ }
            if (inside[idx + g.gw]) { sum += src[idx + g.gw]; cnt++ }
            T[idx] = sum / cnt
          }
        }
      }
      let tMax = 0
      for (let i = 0; i < T.length; i++) if (T[i] > tMax) tMax = T[i]
      result = { T, inside, gw: g.gw, gh: g.gh, x0: g.x0, y0: g.y0, cell: g.cell, tMax }
    } else {
      coarse = { T, gw: g.gw, gh: g.gh, x0: g.x0, y0: g.y0, cell: g.cell }
    }
  }

  return result
}
