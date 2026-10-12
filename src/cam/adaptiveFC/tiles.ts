// Tiled cleared region for the FreeCAD-derived adaptive engine (./engine.ts).
//
// Upstream keeps the cleared area as ONE Clipper polygon and unions every new pass into it,
// offsets all of it to find engage points, copies all of it for each lead path and diffs all
// of it to measure what a pass removed. Each of those costs O(everything cleared so far), and
// they run once or more per pass, so a large pocket goes quadratic — the old port of this
// algorithm took 149 s on a 300 × 200 mm pocket, two thirds of it rebuilding that polygon.
//
// Here the plane is cut into square tiles of side `core`, and each tile stores the cleared
// region clipped to its WINDOW: the core grown by `margin` on every side. The margin is at
// least the largest disk any query asks about (tool radius + step, or + link clearance), so
// every engagement query is answered by ONE tile with no seams anywhere near the tool — the
// window's artificial edges lie outside the disks being measured. Windows overlap, so an
// expansion updates every tile whose window it reaches (a handful), with bounded work each.
//
// A fork (`fork()`) is a copy-on-write overlay used by the lead-out planner, which expands a
// scratch copy of the cleared area step by step and then throws it away.

import {
  Clipper64, ClipperOffset, ClipType, FillRule, PathType, JoinType, EndType, RectClip64,
  area as clipperArea, simplifyPaths, type Paths64, type Path64, type Rect64,
} from 'clipper2-ts'
import type { EdgeSet } from './cutArea'

export interface Tile {
  paths: Paths64
  es: EdgeSet
  /** Bumped on every change. */
  ver: number
  /** Bumped only by changes within `contourReach` of the core — the only ones that can move
   *  this tile's engage contours, which are expensive to rebuild. */
  cver: number
  /** True when the window is entirely cleared (one path equal to the window rect). */
  full: boolean
  /** Clipped swept shapes not yet merged into `paths` (see flush). */
  pending: Paths64 | null
  pendingNearCore: boolean
}

export interface TileGridSpec {
  minX: number; minY: number; maxX: number; maxY: number
  core: number
  margin: number
  /** Radius the cleared region grows by around a swept path (tool radius + safety). */
  sweepRadius: number
  arcTolerance: number
  /** Vertex simplification after each union (≤ the sweep's extra radius). */
  simplifyEps: number
  /** How far outside a tile's core a change can still move its engage contours. */
  contourReach: number
}

let globalVer = 1

/** Shortest distance from a polyline to an axis-aligned rectangle (0 if they touch). */
function polylineRectDist(pl: Path64, r: Rect64): number {
  let best = Infinity
  const ptRect = (x: number, y: number): number => {
    const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom)
    return Math.sqrt(dx * dx + dy * dy)
  }
  for (let i = 0; i < pl.length; i++) {
    best = Math.min(best, ptRect(pl[i].x, pl[i].y))
    if (best === 0) return 0
    if (i === 0) continue
    // segment vs rect: sample-free — the distance is attained at a segment endpoint or where
    // the segment crosses a slab; check the segment against the rect's four edges.
    const a = pl[i - 1], b = pl[i]
    const corners: Array<[number, number]> = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]]
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
    for (const [cx, cy] of corners) {
      if (l2 === 0) break
      let t = ((cx - a.x) * dx + (cy - a.y) * dy) / l2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      best = Math.min(best, ptRect(a.x + t * dx, a.y + t * dy))
    }
    // a segment that crosses the rect without an endpoint inside it
    if (segHitsRect(a.x, a.y, b.x, b.y, r)) return 0
  }
  return best
}

function segHitsRect(ax: number, ay: number, bx: number, by: number, r: Rect64): boolean {
  let t0 = 0, t1 = 1
  const dx = bx - ax, dy = by - ay
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
    return true
  }
  return clip(-dx, ax - r.left) && clip(dx, r.right - ax) && clip(-dy, ay - r.top) && clip(dy, r.bottom - ay)
}
const EMPTY_ES: EdgeSet = { e: new Float64Array(0), n: 0 }

function boolOp(ct: ClipType, subj: Paths64, clip: Paths64, fr = FillRule.NonZero): Paths64 {
  const c = new Clipper64()
  if (subj.length) c.addPaths(subj, PathType.Subject)
  if (clip.length) c.addPaths(clip, PathType.Clip)
  const out: Paths64 = []
  c.execute(ct, fr, out)
  return out
}

function edgesOf(paths: Paths64): EdgeSet {
  let n = 0
  for (const p of paths) n += p.length
  const e = new Float64Array(n * 4)
  let k = 0
  for (const p of paths) {
    const m = p.length
    for (let i = 0; i < m; i++) {
      const a = p[i], b = p[i + 1 === m ? 0 : i + 1]
      e[k++] = a.x; e[k++] = a.y; e[k++] = b.x; e[k++] = b.y
    }
  }
  return { e, n }
}

export class ClearedTiles {
  readonly spec: TileGridSpec
  readonly ox: number
  readonly oy: number
  readonly nx: number
  readonly ny: number
  private readonly base: (Tile | undefined)[]
  private readonly overlay: Map<number, Tile> | null
  private readonly parent: ClearedTiles | null
  /** Tiles changed since the last `takeDirty()` (index set). */
  private dirty = new Set<number>()

  constructor(spec: TileGridSpec, parent: ClearedTiles | null = null) {
    this.spec = spec
    this.parent = parent
    if (parent) {
      this.ox = parent.ox; this.oy = parent.oy; this.nx = parent.nx; this.ny = parent.ny
      this.base = parent.base
      this.overlay = new Map()
    } else {
      // Offset the grid by an odd amount so axis-aligned geometry rarely lands on a seam.
      this.ox = Math.floor(spec.minX) - 7
      this.oy = Math.floor(spec.minY) - 7
      this.nx = Math.max(1, Math.ceil((spec.maxX - this.ox) / spec.core) + 1)
      this.ny = Math.max(1, Math.ceil((spec.maxY - this.oy) / spec.core) + 1)
      this.base = new Array(this.nx * this.ny)
      this.overlay = null
    }
  }

  fork(): ClearedTiles { return new ClearedTiles(this.spec, this) }

  // ─── tile access ──────────────────────────────────────────────────────────────

  /** The tile with every queued change merged in. */
  get(idx: number): Tile | undefined {
    const t = this.raw(idx)
    if (t?.pending) this.flush(idx, t)
    return t
  }

  /** The tile as stored, queue unmerged — for callers that only need to know whether
   *  anything near the core is waiting (`pendingNearCore`, `cver`). */
  peek(idx: number): Tile | undefined { return this.raw(idx) }

  /** The tile as stored, queue unmerged. */
  private raw(idx: number): Tile | undefined {
    if (this.overlay) return this.overlay.get(idx) ?? this.parent!.get(idx)
    return this.base[idx]
  }

  /** A tile this instance may mutate (copy-on-write for a fork). */
  private own(idx: number): Tile {
    if (this.overlay) {
      let t = this.overlay.get(idx)
      if (!t) {
        const p = this.parent!.get(idx)
        t = p ? { ...p, pending: null, pendingNearCore: false } : this.blank()
        this.overlay.set(idx, t)
      }
      return t
    }
    let t = this.base[idx]
    if (!t) { t = this.blank(); this.base[idx] = t }
    return t
  }

  private blank(): Tile {
    return { paths: [], es: EMPTY_ES, ver: ++globalVer, cver: globalVer, full: false, pending: null, pendingNearCore: false }
  }

  /** Expansions only QUEUE their clipped shapes on each tile they reach; the union runs when
   *  the tile is next read. A tile behind the tool collects several shapes and merges them in
   *  one Clipper call instead of one per expansion — the per-call overhead, not polygon size,
   *  is what dominated (100k unions of ~33 vertices on a 200 mm pocket). */
  private flush(idx: number, t: Tile): void {
    const pend = t.pending!
    t.pending = null
    let merged = boolOp(ClipType.Union, t.paths, pend)
    if (this.spec.simplifyEps > 0) merged = simplifyPaths(merged, this.spec.simplifyEps, true)
    const i = idx % this.nx, j = (idx - i) / this.nx
    const w = this.windowRect(i, j)
    let full = false
    if (merged.length === 1 && merged[0].length === 4) {
      const a = Math.abs(clipperArea(merged[0]))
      full = a >= (w.right - w.left) * (w.bottom - w.top) - 1
    }
    t.paths = merged
    t.es = edgesOf(merged)
    t.full = full
    t.ver = ++globalVer
    if (t.pendingNearCore) t.cver = t.ver
    t.pendingNearCore = false
    this.dirty.add(idx)
  }

  tileIndex(x: number, y: number): number {
    const i = Math.floor((x - this.ox) / this.spec.core)
    const j = Math.floor((y - this.oy) / this.spec.core)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1
    return j * this.nx + i
  }

  coreRect(i: number, j: number): Rect64 {
    const s = this.spec.core
    return { left: this.ox + i * s, top: this.oy + j * s, right: this.ox + (i + 1) * s, bottom: this.oy + (j + 1) * s }
  }

  windowRect(i: number, j: number): Rect64 {
    const s = this.spec.core, m = this.spec.margin
    return { left: this.ox + i * s - m, top: this.oy + j * s - m, right: this.ox + (i + 1) * s + m, bottom: this.oy + (j + 1) * s + m }
  }

  /** Visit every tile index whose WINDOW intersects the box. */
  private forWindows(x0: number, y0: number, x1: number, y1: number, fn: (idx: number, i: number, j: number) => void): void {
    const s = this.spec.core, m = this.spec.margin
    const i0 = Math.max(0, Math.floor((x0 - m - this.ox) / s)), i1 = Math.min(this.nx - 1, Math.floor((x1 + m - this.ox) / s))
    const j0 = Math.max(0, Math.floor((y0 - m - this.oy) / s)), j1 = Math.min(this.ny - 1, Math.floor((y1 + m - this.oy) / s))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * this.nx + i, i, j)
  }

  takeDirty(): Set<number> { const d = this.dirty; this.dirty = new Set(); return d }

  // ─── area accounting (replaces upstream's per-pass diff of the whole cleared area) ──
  private acct: Map<number, number> | null = null
  /** Start measuring newly cleared area: every tile records its core area before its first change. */
  beginAccounting(): void { this.acct = new Map() }
  /** Area cleared since beginAccounting(). */
  accountedArea(): number {
    if (!this.acct) return 0
    let a = 0
    for (const [idx, before] of this.acct) a += this.coreArea(idx) - before
    return a
  }

  // ─── updates ──────────────────────────────────────────────────────────────────

  /** Union a region (closed paths, any orientation, NonZero) into the cleared area.
   *  `spine`/`spineR`: the region is the polyline `spine` grown by `spineR` — lets a tile tell
   *  exactly whether the change comes within contourReach of its core, rather than from the
   *  region's bounding box, which flags neighbours a long chunk never goes near. */
  addRegion(paths: Paths64, spine?: Path64, spineR = 0): void {
    if (paths.length === 0) return
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of paths) for (const q of p) {
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x
      if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y
    }
    if (!(x0 <= x1)) return
    this.forWindows(x0, y0, x1, y1, (idx, i, j) => {
      const w = this.windowRect(i, j)
      if (x1 < w.left || x0 > w.right || y1 < w.top || y0 > w.bottom) return
      const clipped = new RectClip64(w).execute(paths)
      if (clipped.length === 0) return
      if (this.raw(idx)?.full) return
      if (this.acct && !this.acct.has(idx)) this.acct.set(idx, this.coreArea(idx))
      const t = this.own(idx)
      if (t.pending) for (const p of clipped) t.pending.push(p)
      else t.pending = clipped
      const c = this.coreRect(i, j), r = this.spec.contourReach
      if (!(x1 < c.left - r || x0 > c.right + r || y1 < c.top - r || y0 > c.bottom + r)
        && (!spine || polylineRectDist(spine, c) <= spineR + r)) t.pendingNearCore = true
    })
  }

  /** Grow the cleared area by the tool swept along `path` (upstream ExpandCleared). */
  expand(path: Path64): void {
    if (path.length === 0) return
    const lim = this.spec.core
    // Chunk long paths so each swept polygon stays local (a few tiles).
    let start = 0
    while (start < path.length) {
      let end = start
      let x0 = path[start].x, x1 = x0, y0 = path[start].y, y1 = y0
      while (end + 1 < path.length) {
        const q = path[end + 1]
        const nx0 = Math.min(x0, q.x), nx1 = Math.max(x1, q.x), ny0 = Math.min(y0, q.y), ny1 = Math.max(y1, q.y)
        if (end > start && (nx1 - nx0 > lim || ny1 - ny0 > lim)) break
        x0 = nx0; x1 = nx1; y0 = ny0; y1 = ny1
        end++
      }
      const chunk = path.slice(start, end + 1)
      const co = new ClipperOffset(2, this.spec.arcTolerance)
      co.addPath(chunk, JoinType.Round, EndType.Round)
      const swept: Paths64 = []
      co.execute(this.spec.sweepRadius, swept)
      this.addRegion(swept, chunk, this.spec.sweepRadius + this.spec.arcTolerance)
      if (end === path.length - 1) break
      start = end
    }
  }

  // ─── queries ──────────────────────────────────────────────────────────────────

  private compKey = ''
  private compES: EdgeSet = EMPTY_ES
  private compPaths: Paths64 = []

  /** Cleared polygons valid inside the box (see edgesFor). Shared — do not mutate. */
  pathsFor(x0: number, y0: number, x1: number, y1: number): Paths64 {
    const idx = this.fitTile(x0, y0, x1, y1)
    if (idx !== -2) return idx >= 0 ? (this.get(idx)?.paths ?? []) : []
    this.composite(x0, y0, x1, y1)
    return this.compPaths
  }

  /** Tile whose window holds the box: its index, −1 for "outside the grid, nothing cleared",
   *  −2 when no single window holds it. */
  private fitTile(x0: number, y0: number, x1: number, y1: number): number {
    const idx = this.tileIndex((x0 + x1) / 2, (y0 + y1) / 2)
    if (idx < 0) return -2
    const i = idx % this.nx, j = (idx - i) / this.nx
    const w = this.windowRect(i, j)
    return (x0 > w.left && x1 < w.right && y0 > w.top && y1 < w.bottom) ? idx : -2
  }

  /** Edges of the cleared area valid for any query inside the box. One tile's window when it
   *  fits (the common case); otherwise a merged region built for this box. */
  edgesFor(x0: number, y0: number, x1: number, y1: number): EdgeSet {
    const idx = this.fitTile(x0, y0, x1, y1)
    if (idx >= 0) return this.get(idx)?.es ?? EMPTY_ES
    return this.composite(x0, y0, x1, y1)
  }

  private composite(x0: number, y0: number, x1: number, y1: number): EdgeSet {
    const pad = 4
    const rect: Rect64 = { left: Math.floor(x0) - pad, top: Math.floor(y0) - pad, right: Math.ceil(x1) + pad, bottom: Math.ceil(y1) + pad }
    let vers = ''
    const parts: Paths64 = []
    const s = this.spec.core
    const i0 = Math.max(0, Math.floor((rect.left - this.ox) / s)), i1 = Math.min(this.nx - 1, Math.floor((rect.right - this.ox) / s))
    const j0 = Math.max(0, Math.floor((rect.top - this.oy) / s)), j1 = Math.min(this.ny - 1, Math.floor((rect.bottom - this.oy) / s))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const t = this.get(j * this.nx + i)
      vers += (t ? t.ver : 0) + ','
    }
    const key = `${rect.left},${rect.top},${rect.right},${rect.bottom}|${vers}`
    if (key === this.compKey) return this.compES
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const t = this.get(j * this.nx + i)
      if (!t || t.paths.length === 0) continue
      for (const p of new RectClip64(this.coreRect(i, j)).execute(t.paths)) parts.push(p)
    }
    const merged = parts.length ? new RectClip64(rect).execute(boolOp(ClipType.Union, parts, [])) : []
    this.compKey = key
    this.compPaths = merged
    this.compES = edgesOf(merged)
    return this.compES
  }

  /** The whole cleared region as one polygon set (expensive — for one-off global steps). */
  getCleared(): Paths64 {
    const parts: Paths64 = []
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
      const t = this.get(j * this.nx + i)
      if (!t || t.paths.length === 0) continue
      for (const p of new RectClip64(this.coreRect(i, j)).execute(t.paths)) parts.push(p)
    }
    return parts.length ? boolOp(ClipType.Union, parts, []) : []
  }

  /** Cleared area inside one tile's core. */
  coreArea(idx: number): number {
    const t = this.get(idx)
    if (!t || t.paths.length === 0) return 0
    const i = idx % this.nx, j = (idx - i) / this.nx
    let a = 0
    for (const p of new RectClip64(this.coreRect(i, j)).execute(t.paths)) a += clipperArea(p)
    return a
  }

  /** Does any REAL cleared-area boundary (not the window's own border) come within `d` of
   *  this tile's core? */
  boundaryNearCore(idx: number, d: number): boolean {
    const t = this.get(idx)
    if (!t) return false
    const i = idx % this.nx, j = (idx - i) / this.nx
    const w = this.windowRect(i, j), c = this.coreRect(i, j)
    const r: Rect64 = { left: c.left - d, top: c.top - d, right: c.right + d, bottom: c.bottom + d }
    const e = t.es.e
    for (let k = 0, m = t.es.n * 4; k < m; k += 4) {
      const ax = e[k], ay = e[k + 1], bx = e[k + 2], by = e[k + 3]
      if ((ax === bx && (ax === w.left || ax === w.right)) || (ay === by && (ay === w.top || ay === w.bottom))) continue
      if (Math.max(ax, bx) < r.left || Math.min(ax, bx) > r.right || Math.max(ay, by) < r.top || Math.min(ay, by) > r.bottom) continue
      if (segHitsRect(ax, ay, bx, by, r)) return true
    }
    return false
  }

  /** Cleared polygons in the window of tile idx (shared — do not mutate). */
  windowPaths(idx: number): Paths64 { return this.get(idx)?.paths ?? [] }
}
