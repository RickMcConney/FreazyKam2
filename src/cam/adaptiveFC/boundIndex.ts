// Uniform-grid index over a fixed polygon set (the tool-centre boundary), for the two queries
// the adaptive engine makes on every tool step: distance to the nearest edge (upstream
// DistancePointToPathsSqrd over toolBoundPaths) and even-odd containment (upstream
// IsPointWithinCutRegion). Upstream walks every boundary vertex for both; on a detailed
// outline — text, a gear — that is thousands of edges per step, several steps per mm.

import type { Paths64 } from 'clipper2-ts'

export interface ClosestHit {
  distSq: number
  pathIndex: number
  /** Upstream convention: the segment is (j−1 → j), so the direction is GetPathDirectionV(path, j). */
  segIndex: number
  x: number
  y: number
}

export class BoundIndex {
  readonly paths: Paths64
  private readonly x0: number
  private readonly y0: number
  private readonly cell: number
  private readonly gw: number
  private readonly gh: number
  /** Per cell: edge ids (start, count into `ids`). Edge id = (path << 20) | seg … stored as two arrays. */
  private readonly cellStart: Int32Array
  private readonly cellCount: Int32Array
  private readonly edgePath: Int32Array
  private readonly edgeSeg: Int32Array
  private readonly ids: Int32Array
  /** Even-odd containment of each cell's centre. */
  private readonly centreIn: Uint8Array
  private readonly ex: Float64Array // edge coords a.x a.y b.x b.y

  constructor(paths: Paths64, cellHint: number) {
    this.paths = paths
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ne = 0
    for (const p of paths) {
      ne += p.length
      for (const q of p) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y }
    }
    if (!(x0 <= x1)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1 }
    // Keep the grid bounded: ~ne cells, never finer than the hint.
    const span = Math.max(x1 - x0, y1 - y0, 1)
    let cell = Math.max(cellHint, span / 512)
    const target = Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / Math.max(ne, 16))
    cell = Math.max(cell, target)
    this.cell = cell
    this.x0 = x0 - cell
    this.y0 = y0 - cell
    this.gw = Math.ceil((x1 - this.x0) / cell) + 2
    this.gh = Math.ceil((y1 - this.y0) / cell) + 2

    this.edgePath = new Int32Array(ne)
    this.edgeSeg = new Int32Array(ne)
    this.ex = new Float64Array(ne * 4)
    let k = 0
    for (let pi = 0; pi < paths.length; pi++) {
      const p = paths[pi], m = p.length
      for (let j = 0; j < m; j++) {
        const a = p[j > 0 ? j - 1 : m - 1], b = p[j]
        this.edgePath[k] = pi; this.edgeSeg[k] = j
        this.ex[4 * k] = a.x; this.ex[4 * k + 1] = a.y; this.ex[4 * k + 2] = b.x; this.ex[4 * k + 3] = b.y
        k++
      }
    }
    // Bucket edges by the cells their bbox covers (conservative).
    const ncell = this.gw * this.gh
    const counts = new Int32Array(ncell)
    const visit = (e: number, fn: (c: number) => void): void => {
      const ax = this.ex[4 * e], ay = this.ex[4 * e + 1], bx = this.ex[4 * e + 2], by = this.ex[4 * e + 3]
      const i0 = Math.floor((Math.min(ax, bx) - this.x0) / cell), i1 = Math.floor((Math.max(ax, bx) - this.x0) / cell)
      const j0 = Math.floor((Math.min(ay, by) - this.y0) / cell), j1 = Math.floor((Math.max(ay, by) - this.y0) / cell)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * this.gw + i)
    }
    for (let e = 0; e < ne; e++) visit(e, c => { counts[c]++ })
    this.cellStart = new Int32Array(ncell)
    this.cellCount = new Int32Array(ncell)
    let tot = 0
    for (let c = 0; c < ncell; c++) { this.cellStart[c] = tot; tot += counts[c] }
    this.ids = new Int32Array(tot)
    for (let e = 0; e < ne; e++) visit(e, c => { this.ids[this.cellStart[c] + this.cellCount[c]++] = e })

    // Cell-centre containment: scanline parity across each row.
    this.centreIn = new Uint8Array(ncell)
    const xs: number[] = []
    for (let j = 0; j < this.gh; j++) {
      const yc = this.y0 + (j + 0.5) * cell
      xs.length = 0
      for (let e = 0; e < ne; e++) {
        const ay = this.ex[4 * e + 1], by = this.ex[4 * e + 3]
        if ((ay <= yc) !== (by <= yc)) {
          const ax = this.ex[4 * e], bx = this.ex[4 * e + 2]
          xs.push(ax + (yc - ay) * (bx - ax) / (by - ay))
        }
      }
      xs.sort((a, b) => a - b)
      let q = 0
      for (let i = 0; i < this.gw; i++) {
        const xc = this.x0 + (i + 0.5) * cell
        while (q < xs.length && xs[q] < xc) q++
        this.centreIn[j * this.gw + i] = q & 1
      }
    }
  }

  /** Even-odd containment (upstream IsPointWithinCutRegion). */
  inside(px: number, py: number): boolean {
    const i = Math.floor((px - this.x0) / this.cell), j = Math.floor((py - this.y0) / this.cell)
    if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return false
    const c = j * this.gw + i
    const cx = this.x0 + (i + 0.5) * this.cell, cy = this.y0 + (j + 0.5) * this.cell
    let inside = this.centreIn[c] === 1
    // Flip for every edge the segment centre → p crosses (all such edges touch this cell).
    const s = this.cellStart[c], n = this.cellCount[c]
    const dx = px - cx, dy = py - cy
    for (let k = 0; k < n; k++) {
      const e = this.ids[s + k]
      const ax = this.ex[4 * e], ay = this.ex[4 * e + 1], bx = this.ex[4 * e + 2], by = this.ex[4 * e + 3]
      const ex = bx - ax, ey = by - ay
      const den = dx * ey - dy * ex
      if (den === 0) continue
      const t = ((ax - cx) * ey - (ay - cy) * ex) / den   // along centre→p
      const u = ((ax - cx) * dy - (ay - cy) * dx) / den   // along the edge
      if (t >= 0 && t < 1 && u >= 0 && u < 1) inside = !inside
    }
    return inside
  }

  /** Nearest edge (upstream DistancePointToPathsSqrd). */
  closest(px: number, py: number, out: ClosestHit): ClosestHit {
    out.distSq = Infinity
    const cell = this.cell
    const ci = Math.floor((px - this.x0) / cell), cj = Math.floor((py - this.y0) / cell)
    const maxRing = Math.max(this.gw, this.gh)
    for (let r = 0; r <= maxRing; r++) {
      // Distance from p to the nearest point of ring r's cells is ≥ (r − 1)·cell.
      if (r > 0) {
        const lb = (r - 1) * cell
        if (lb * lb > out.distSq) break
      }
      for (let j = cj - r; j <= cj + r; j++) {
        if (j < 0 || j >= this.gh) continue
        const step = (j === cj - r || j === cj + r) ? 1 : 2 * r
        for (let i = ci - r; i <= ci + r; i += step || 1) {
          if (i < 0 || i >= this.gw) continue
          const c = j * this.gw + i
          const s = this.cellStart[c], n = this.cellCount[c]
          for (let k = 0; k < n; k++) this.testEdge(this.ids[s + k], px, py, out)
        }
      }
    }
    return out
  }

  private testEdge(e: number, px: number, py: number, out: ClosestHit): void {
    const ax = this.ex[4 * e], ay = this.ex[4 * e + 1], bx = this.ex[4 * e + 2], by = this.ex[4 * e + 3]
    const dx = bx - ax, dy = by - ay
    const l2 = dx * dx + dy * dy
    let qx = ax, qy = ay
    if (l2 > 0) {
      let t = ((px - ax) * dx + (py - ay) * dy) / l2
      if (t < 0) t = 0; else if (t > 1) t = 1
      // Upstream truncates the closest point to an integer.
      qx = Math.trunc(ax + t * dx); qy = Math.trunc(ay + t * dy)
    }
    const ddx = px - qx, ddy = py - qy
    const d2 = ddx * ddx + ddy * ddy
    // Ties go to the lower (path, seg) like upstream's linear scan.
    if (d2 < out.distSq || (d2 === out.distSq && (this.edgePath[e] < out.pathIndex || (this.edgePath[e] === out.pathIndex && this.edgeSeg[e] < out.segIndex)))) {
      out.distSq = d2; out.pathIndex = this.edgePath[e]; out.segIndex = this.edgeSeg[e]; out.x = qx; out.y = qy
    }
  }
}
