// TileRaster — bit-packed, tiled 2D occupancy model of the cleared region for adaptive clearing.
//
// The cleared region is the tool swept along the cut paths. We rasterize it on a FINE-ish cell, but
// store it as tiles in three states so memory stays O(frontier) not O(area):
//   EMPTY   — all uncut (default, no storage)
//   FULL    — all cut (flag, no storage); a tile collapses to FULL the moment its last cell is set
//   PARTIAL — straddles the boundary; a bit-packed Uint32Array of T×T bits
//
// Queries count with popcount (32 cells per op), so they're fast and flat with total cleared size:
//   uncutInDisk(cx,cy,r)  → engagement: uncut area under the tool disk (popcount the cut bits,
//                           subtract from the disk's cell count). Measured at a PROBE point ahead
//                           of the tool so the area is large enough to be low-noise at a coarse cell.
//   isCleared / area      → membership / total cut.
// (conventional/climb split and isClearPath collision are added on top of this core.)
//
// Coordinates are the engine's scaled integers; cell is the scaled cell size. T must be a multiple
// of 32 (so tile rows are word-aligned). Validated against Clipper + a naive reference by
// scripts/tile-raster2-check.mjs.

const EMPTY = 0, PARTIAL = 1, FULL = 2

function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}
// set bits in inclusive bit-index range [start,end] of a Uint32Array
function popcountRange(arr: Uint32Array, start: number, end: number): number {
  if (end < start) return 0
  const w0 = start >>> 5, w1 = end >>> 5
  if (w0 === w1) {
    const len = end - start + 1
    const mask = ((len === 32 ? 0xffffffff : ((1 << len) - 1)) << (start & 31)) >>> 0
    return popcount32((arr[w0] & mask) >>> 0)
  }
  let c = popcount32((arr[w0] & (0xffffffff << (start & 31))) >>> 0)
  for (let w = w0 + 1; w < w1; w++) c += popcount32(arr[w] >>> 0)
  const lastBits = (end & 31) + 1
  const lastMask = (lastBits === 32 ? 0xffffffff : ((1 << lastBits) - 1)) >>> 0
  c += popcount32((arr[w1] & lastMask) >>> 0)
  return c
}

export class TileRaster {
  readonly cell: number
  private readonly x0: number
  private readonly y0: number
  private readonly gw: number   // global cells
  private readonly gh: number
  private readonly T: number
  private readonly tShift: number
  private readonly tMask: number
  private readonly wpt: number   // words per tile (T*T/32)
  private readonly tw: number
  private readonly th: number
  private readonly state: Uint8Array
  private readonly bits: Array<Uint32Array | null>
  private readonly cut: Int32Array  // cut-cell count per tile (for FULL collapse)
  private readonly toolR: number
  private totalCutCells = 0
  partialTiles = 0
  peakPartialTiles = 0

  constructor(x0: number, y0: number, x1: number, y1: number, cell: number, toolR: number, T = 64) {
    if ((T & 31) !== 0) throw new Error('T must be a multiple of 32')
    this.toolR = toolR
    this.cell = cell > 0 ? cell : 1
    this.x0 = x0; this.y0 = y0
    this.gw = Math.ceil((x1 - x0) / this.cell)
    this.gh = Math.ceil((y1 - y0) / this.cell)
    this.T = T; this.tShift = Math.log2(T); this.tMask = T - 1
    this.wpt = (T * T) >> 5
    this.tw = Math.ceil(this.gw / T); this.th = Math.ceil(this.gh / T)
    this.state = new Uint8Array(this.tw * this.th)
    this.bits = new Array(this.tw * this.th).fill(null)
    this.cut = new Int32Array(this.tw * this.th)
  }

  area(): number { return this.totalCutCells * this.cell * this.cell }  // cut area in scaled units²
  partialBytes(): number { return this.partialTiles * this.wpt * 4 }

  // Cheap copy (tile map → only the frontier bitmaps are duplicated): for the lead-path scratch.
  clone(): TileRaster {
    const c = new TileRaster(this.x0, this.y0, this.x0 + this.gw * this.cell, this.y0 + this.gh * this.cell, this.cell, this.toolR, this.T)
    c.state.set(this.state)
    c.cut.set(this.cut)
    for (let i = 0; i < this.bits.length; i++) { const b = this.bits[i]; c.bits[i] = b ? b.slice() : null }
    c.totalCutCells = this.totalCutCells
    c.partialTiles = this.partialTiles
    return c
  }

  private gx(x: number): number { return Math.floor((x - this.x0) / this.cell) }
  private gy(y: number): number { return Math.floor((y - this.y0) / this.cell) }
  private cxw(gx: number): number { return this.x0 + (gx + 0.5) * this.cell }
  private cyw(gy: number): number { return this.y0 + (gy + 0.5) * this.cell }

  // Extract the cut-region boundary as Clipper-ready loops (outer CCW, holes CW), in scaled coords.
  // Boundary-edge tracing of the cut/uncut frontier: for each frontier cut cell emit the sides whose
  // neighbour is uncut (CCW round the cell ⇒ cut-on-left), then chain edges into loops keeping only
  // corners. Interior FULL tiles are skipped, so it's O(frontier). On-demand source for getCleared().
  toContours(): Array<Array<{ x: number; y: number }>> {
    const W1 = this.gw + 1
    // Multi-successor edge map: at pinch points (frontier touching itself) a vertex has two out-edges;
    // a single-successor map would silently drop one and corrupt the contour.
    const outEdges = new Map<number, number[]>()
    const addEdge = (a: number, b: number): void => { const l = outEdges.get(a); if (l) l.push(b); else outEdges.set(a, [b]) }
    const cut = (gx: number, gy: number): boolean => {
      if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return false
      const ti = (gy >> this.tShift) * this.tw + (gx >> this.tShift)
      const st = this.state[ti]
      if (st === FULL) return true
      if (st === EMPTY) return false
      const b = this.bits[ti]!, bi = (gy & this.tMask) * this.T + (gx & this.tMask)
      return (b[bi >>> 5] & (1 << (bi & 31))) !== 0
    }
    const emit = (gx: number, gy: number): void => {
      const bl = gy * W1 + gx, br = bl + 1, tl = bl + W1, tr = tl + 1
      if (!cut(gx, gy - 1)) addEdge(bl, br)       // bottom →
      if (!cut(gx + 1, gy)) addEdge(br, tr)       // right ↑
      if (!cut(gx, gy + 1)) addEdge(tr, tl)       // top ←
      if (!cut(gx - 1, gy)) addEdge(tl, bl)       // left ↓
    }
    for (let ty = 0; ty < this.th; ty++) {
      for (let tx = 0; tx < this.tw; tx++) {
        const ti = ty * this.tw + tx, st = this.state[ti]
        if (st === EMPTY) continue
        if (st === FULL
          && ty + 1 < this.th && this.state[ti + this.tw] === FULL
          && ty > 0 && this.state[ti - this.tw] === FULL
          && tx + 1 < this.tw && this.state[ti + 1] === FULL
          && tx > 0 && this.state[ti - 1] === FULL) continue // interior FULL tile
        const gx0 = tx * this.T, gy0 = ty * this.T
        const gx1 = Math.min((tx + 1) * this.T - 1, this.gw - 1), gy1 = Math.min((ty + 1) * this.T - 1, this.gh - 1)
        if (st === FULL) {
          // Interior FULL cells have all-cut neighbours → no boundary; only the border ring can.
          for (let gx = gx0; gx <= gx1; gx++) { emit(gx, gy0); if (gy1 !== gy0) emit(gx, gy1) }
          for (let gy = gy0 + 1; gy < gy1; gy++) { emit(gx0, gy); if (gx1 !== gx0) emit(gx1, gy) }
        } else {
          for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) if (cut(gx, gy)) emit(gx, gy)
        }
      }
    }
    const vx = (k: number): number => this.x0 + (k % W1) * this.cell
    const vy = (k: number): number => this.y0 + ((k / W1) | 0) * this.cell
    const contours: Array<Array<{ x: number; y: number }>> = []
    for (const start of outEdges.keys()) {
      let outs = outEdges.get(start)
      while (outs && outs.length) {
        const raw: number[] = [start]
        let cur = outs.pop()!
        let guard = 0
        while (cur !== start && guard++ < 1e7) {
          raw.push(cur)
          const o = outEdges.get(cur)
          if (!o || !o.length) break
          cur = o.pop()!
        }
        // keep corners only (drop collinear)
        const n = raw.length
        const loop: Array<{ x: number; y: number }> = []
        for (let i = 0; i < n; i++) {
          const a = raw[(i - 1 + n) % n], b = raw[i], c = raw[(i + 1) % n]
          const ax = vx(a), ay = vy(a), bx = vx(b), by = vy(b), cx = vx(c), cy = vy(c)
          if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) !== 0) loop.push({ x: bx, y: by })
        }
        if (loop.length >= 3) contours.push(loop)
        outs = outEdges.get(start)
      }
    }
    return contours
  }

  // Centre of the nearest fully-cut (FULL) tile to (x,y) — a cheap "nearest deep-cleared point",
  // used to aim a lead's beacon into cleared stock. null if nothing is fully cut yet.
  nearestFullTile(x: number, y: number): { x: number; y: number } | null {
    const ts = this.T * this.cell
    const ctx = Math.max(0, Math.min(this.tw - 1, Math.floor((x - this.x0) / ts)))
    const cty = Math.max(0, Math.min(this.th - 1, Math.floor((y - this.y0) / ts)))
    for (let ring = 0; ring < this.tw + this.th; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const ny = cty + dy; if (ny < 0 || ny >= this.th) continue
        const edge = Math.abs(dy) === ring
        for (let dx = -ring; dx <= ring; dx += (edge ? 1 : 2 * ring || 1)) {
          const nx = ctx + dx; if (nx < 0 || nx >= this.tw) continue
          if (this.state[ny * this.tw + nx] === FULL) return { x: this.x0 + (nx + 0.5) * ts, y: this.y0 + (ny + 0.5) * ts }
        }
      }
    }
    return null
  }

  // Deepest uncut point inside the region: a coarse tile-level distance transform (Chebyshev BFS
  // from blocked tiles = cut OR outside the region) over EMPTY-and-inside tiles; the farthest one is
  // the pole of inaccessibility. Returns its centre + approx depth (scaled), or null if none.
  // `inside(x,y)` tests region membership (centre of each tile). Used to seed/reseed helices.
  deepestUncutTile(inside: (x: number, y: number) => boolean): { x: number; y: number; depth: number } | null {
    const tw = this.tw, th = this.th, ts = this.T * this.cell
    const dist = new Int32Array(tw * th).fill(-1)
    const q: number[] = []
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        const ti = ty * tw + tx
        const blocked = this.state[ti] !== EMPTY || !inside(this.x0 + (tx + 0.5) * ts, this.y0 + (ty + 0.5) * ts)
        if (blocked) { dist[ti] = 0; q.push(ti) }
      }
    }
    for (let head = 0; head < q.length; head++) {
      const ti = q[head], tx = ti % tw, ty = (ti / tw) | 0, d = dist[ti]
      for (let dy = -1; dy <= 1; dy++) {
        const ny = ty + dy; if (ny < 0 || ny >= th) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = tx + dx; if (nx < 0 || nx >= tw) continue
          const nti = ny * tw + nx
          if (dist[nti] < 0) { dist[nti] = d + 1; q.push(nti) }
        }
      }
    }
    let best = 0, bestTi = -1
    for (let ti = 0; ti < dist.length; ti++) if (dist[ti] > best) { best = dist[ti]; bestTi = ti }
    if (bestTi < 0) return null
    const tx = bestTi % tw, ty = (bestTi / tw) | 0
    return { x: this.x0 + (tx + 0.5) * ts, y: this.y0 + (ty + 0.5) * ts, depth: best * ts }
  }

  isCleared(x: number, y: number): boolean {
    const gx = this.gx(x), gy = this.gy(y)
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return false
    const ti = (gy >> this.tShift) * this.tw + (gx >> this.tShift)
    const st = this.state[ti]
    if (st === FULL) return true
    if (st === EMPTY) return false
    const lx = gx & this.tMask, ly = gy & this.tMask
    const b = this.bits[ti]!
    const bi = ly * this.T + lx
    return (b[bi >>> 5] & (1 << (bi & 31))) !== 0
  }

  mark(path: ReadonlyArray<{ x: number; y: number }>, r: number): void {
    if (path.length === 0) return
    if (path.length === 1) { this.stamp(path[0].x, path[0].y, path[0].x, path[0].y, r); return }
    for (let i = 1; i < path.length; i++) this.stamp(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y, r)
  }
  markStamp(cx: number, cy: number, r: number): void { this.stamp(cx, cy, cx, cy, r) }

  // mark the radius-r tube around segment [a,b] as cut (tile iteration; FULL fast-path; collapse)
  private stamp(ax: number, ay: number, bx: number, by: number, r: number): void {
    const r2 = r * r
    const ts = this.T * this.cell
    const minX = Math.min(ax, bx) - r, maxX = Math.max(ax, bx) + r
    const minY = Math.min(ay, by) - r, maxY = Math.max(ay, by) + r
    const tx0 = Math.max(0, Math.floor((minX - this.x0) / ts)), tx1 = Math.min(this.tw - 1, Math.floor((maxX - this.x0) / ts))
    const ty0 = Math.max(0, Math.floor((minY - this.y0) / ts)), ty1 = Math.min(this.th - 1, Math.floor((maxY - this.y0) / ts))
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const ti = ty * this.tw + tx
        if (this.state[ti] === FULL) continue
        // tile fully inside the tube? → FULL without allocating a bitmap
        const wx0 = this.x0 + tx * ts, wy0 = this.y0 + ty * ts, wx1 = wx0 + ts, wy1 = wy0 + ts
        if (this.state[ti] === EMPTY
          && distSqPtSeg(wx0, wy0, ax, ay, bx, by) <= r2 && distSqPtSeg(wx1, wy0, ax, ay, bx, by) <= r2
          && distSqPtSeg(wx0, wy1, ax, ay, bx, by) <= r2 && distSqPtSeg(wx1, wy1, ax, ay, bx, by) <= r2) {
          this.state[ti] = FULL; this.totalCutCells += this.T * this.T; this.cut[ti] = this.T * this.T; continue
        }
        if (this.state[ti] === EMPTY) { this.bits[ti] = new Uint32Array(this.wpt); this.state[ti] = PARTIAL; this.partialTiles++ }
        const b = this.bits[ti]!
        // cell range in this tile intersected with the tube bbox
        const gx0 = Math.max(tx * this.T, this.gx(minX)), gx1 = Math.min((tx + 1) * this.T - 1, this.gw - 1, this.gx(maxX))
        const gy0 = Math.max(ty * this.T, this.gy(minY)), gy1 = Math.min((ty + 1) * this.T - 1, this.gh - 1, this.gy(maxY))
        for (let gy = gy0; gy <= gy1; gy++) {
          const py = this.cyw(gy), ly = gy & this.tMask
          for (let gx = gx0; gx <= gx1; gx++) {
            if (distSqPtSeg(this.cxw(gx), py, ax, ay, bx, by) > r2) continue
            const bi = ly * this.T + (gx & this.tMask)
            const w = bi >>> 5, m = 1 << (bi & 31)
            if ((b[w] & m) === 0) { b[w] |= m; this.cut[ti]++; this.totalCutCells++ }
          }
        }
        if (this.cut[ti] === this.T * this.T) { this.state[ti] = FULL; this.bits[ti] = null; this.partialTiles-- }
      }
    }
    if (this.partialTiles > this.peakPartialTiles) this.peakPartialTiles = this.partialTiles
  }

  // cut cells in row gy, global x range [gxL,gxR] — walk tiles, popcount PARTIAL spans.
  private cutInRow(gy: number, gxL: number, gxR: number): number {
    if (gxR < gxL) return 0
    const ty = gy >> this.tShift, ly = gy & this.tMask, base = ly * this.T
    let cut = 0, gx = gxL
    while (gx <= gxR) {
      const tx = gx >> this.tShift, ti = ty * this.tw + tx
      const sxR = Math.min(gxR, (tx + 1) * this.T - 1)
      const st = this.state[ti]
      if (st === FULL) cut += sxR - gx + 1
      else if (st === PARTIAL) cut += popcountRange(this.bits[ti]!, base + (gx & this.tMask), base + (sxR & this.tMask))
      gx = sxR + 1
    }
    return cut
  }

  // disk row x-range [gxL,gxR] (cells whose center is within r of (cx,cy)); null if empty
  private diskRow(gy: number, cx: number, cy: number, r: number): [number, number] | null {
    const dy = this.cyw(gy) - cy
    if (Math.abs(dy) > r) return null
    const dx = Math.sqrt(r * r - dy * dy)
    const gxL = Math.max(0, Math.ceil((cx - dx - this.x0) / this.cell - 0.5))
    const gxR = Math.min(this.gw - 1, Math.floor((cx + dx - this.x0) / this.cell - 0.5))
    return gxR < gxL ? null : [gxL, gxR]
  }

  // uncut area under disk(cx,cy,r).
  uncutInDisk(cx: number, cy: number, r: number): number {
    const cellA = this.cell * this.cell
    let uncut = 0
    for (let gy = Math.max(0, this.gy(cy - r)); gy <= Math.min(this.gh - 1, this.gy(cy + r)); gy++) {
      const row = this.diskRow(gy, cx, cy, r)
      if (!row) continue
      uncut += (row[1] - row[0] + 1) - this.cutInRow(gy, row[0], row[1])
    }
    return uncut * cellA
  }

  // Engagement of the move c1→c2 (read-only), measured at c2's tool disk: [total, conventional].
  // conventional = uncut on the left of the travel line through c1 (cross(c2−c1, p−c1) > 0),
  // matching the analytic CalcCutArea's rotated-frame xtest<c2.x convention.
  cutArea(c1: { x: number; y: number }, c2: { x: number; y: number }): [number, number] {
    const cx = c2.x, cy = c2.y, r = this.toolR, cellA = this.cell * this.cell
    const dx = c2.x - c1.x, dy = c2.y - c1.y
    let total = 0, conv = 0
    for (let gy = Math.max(0, this.gy(cy - r)); gy <= Math.min(this.gh - 1, this.gy(cy + r)); gy++) {
      const row = this.diskRow(gy, cx, cy, r)
      if (!row) continue
      const [gxL, gxR] = row
      total += (gxR - gxL + 1) - this.cutInRow(gy, gxL, gxR)
      // conventional sub-range of [gxL,gxR]
      const pyc = this.cyw(gy)
      let cL = gxL, cR = gxR
      if (dy === 0) {
        if (dx * (pyc - c1.y) <= 0) continue // whole row non-conventional
      } else {
        const xcross = c1.x + dx * (pyc - c1.y) / dy
        const t = (xcross - this.x0) / this.cell - 0.5
        if (dy > 0) cR = Math.min(gxR, Math.ceil(t) - 1)   // cells left of the line
        else cL = Math.max(gxL, Math.floor(t) + 1)         // cells right of the line
      }
      if (cR >= cL) conv += (cR - cL + 1) - this.cutInRow(gy, cL, cR)
    }
    return [total * cellA, conv * cellA]
  }

  // Collision/clearance: is every point within `rad` of the path already cut? Any uncut cell in the
  // tube (including off-grid) ⇒ uncut stock in the way ⇒ not clear. FULL tiles short-circuit.
  isClearPath(path: ReadonlyArray<{ x: number; y: number }>, rad: number): boolean {
    const segs: Array<[{ x: number; y: number }, { x: number; y: number }]> = []
    if (path.length === 1) segs.push([path[0], path[0]])
    else for (let i = 1; i < path.length; i++) segs.push([path[i - 1], path[i]])
    const r2 = rad * rad
    for (const [a, b] of segs) {
      const minX = Math.min(a.x, b.x) - rad, maxX = Math.max(a.x, b.x) + rad
      const minY = Math.min(a.y, b.y) - rad, maxY = Math.max(a.y, b.y) + rad
      // tube leaving the grid → uncut stock outside the region
      if (minX < this.x0 || minY < this.y0 || maxX > this.x0 + this.gw * this.cell || maxY > this.y0 + this.gh * this.cell) return false
      const gy0 = this.gy(minY), gy1 = this.gy(maxY)
      for (let gy = Math.max(0, gy0); gy <= Math.min(this.gh - 1, gy1); gy++) {
        const py = this.cyw(gy)
        const gxL = Math.max(0, this.gx(minX)), gxR = Math.min(this.gw - 1, this.gx(maxX))
        const ty = gy >> this.tShift, ly = gy & this.tMask, base = ly * this.T
        let gx = gxL
        while (gx <= gxR) {
          const tx = gx >> this.tShift, ti = ty * this.tw + tx
          const sxR = Math.min(gxR, (tx + 1) * this.T - 1)
          const st = this.state[ti]
          if (st !== FULL) {
            const bb = st === PARTIAL ? this.bits[ti]! : null
            for (let cgx = gx; cgx <= sxR; cgx++) {
              if (distSqPtSeg(this.cxw(cgx), py, a.x, a.y, b.x, b.y) > r2) continue
              if (bb === null) return false // EMPTY tile, cell in tube → uncut
              const bi = base + (cgx & this.tMask)
              if ((bb[bi >>> 5] & (1 << (bi & 31))) === 0) return false // uncut cell in tube
            }
          }
          gx = sxR + 1
        }
      }
    }
    return true
  }
}

function distSqPtSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = px - (x1 + t * dx), ey = py - (y1 + t * dy)
  return ex * ex + ey * ey
}
