// THE OUTLINE A MODEL'S TABS GO ON. An STL path's `d` is its BOX — the rectangle the model
// is stretched into — and a tab placed on the box is a long way from a round model's side
// everywhere but the middle of each edge, and nowhere near it round a corner. A 3D Profile's
// tabs (cam/profile3dTabs) run square in from wherever they sit until they meet the model,
// so what they want to sit on is the model's own SILHOUETTE: the XY footprint of the mesh,
// seen from above.
//
// Read off a raster, not a polygon union: every triangle (as placed — `placeStlModel`, then
// `stlToCnc`, the mapping every reader of the model shares) is filled into a mask of cells,
// everything the outside cannot reach is called inside (so through-holes and the cracks a
// mesh leaves between facets close up — a tab never holds a part from a hole), and the
// boundary of each piece is traced and simplified.
//
// IT ERRS OUTWARD, NEVER IN. Boundary "outline" runs each tool's centre its radius and a
// lead (0.05 mm) past this ring, so a ring even a tenth inside the model's true side puts
// the tool's edge over the wall — where a drop cutter rides ON it. A faceted base (vertical
// from −28 to −8) left 12 mm bridges in the band at the polygon's corners, where cell
// rounding and the smoothing below had both pulled the ring in. So every cell a facet
// TOUCHES is marked (its edges are walked as well as its interior sampled), the mask is
// grown by `GROW_CELLS`, which more than covers what the smoothing takes off a corner, and
// the cells are fine — 0.1 to 0.25 mm. The ring then stands ~0.05 to ~3.4 cells outside.
import type { Pt2 } from './pathFlattener'
import { flattenPath } from './pathFlattener'
import { stlToCnc } from './stlMapping'
import { placeStlModel } from './stlPlacement'
import { decodeStlMesh } from '../importers/stlImporter'
import { getBBox } from '../canvas/selectionUtils'
import type { StlModelBounds } from '../importers/svgImporter'

const CELLS_ACROSS = 1000
const MIN_CELL_MM = 0.1, MAX_CELL_MM = 0.25
/** How far the marked cells are grown before tracing: covers the smoothing's pull-in. */
const GROW_CELLS = 2
/** A piece smaller than this many cells is a stray facet, not a part of the model. */
const MIN_PIECE_CELLS = 16

/**
 * The model's silhouette as closed rings (first point repeated), in CNC mm, outer
 * boundaries only. Empty for a mesh with nothing in it.
 */
export function meshSilhouette(
  positions: Float32Array, indices: Uint32Array | null, bounds: StlModelBounds,
  bbox: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; cx: number; cy: number },
): Pt2[][] {
  const map = stlToCnc(bounds, bbox)
  const side = Math.max(bbox.width, bbox.height)
  if (!(side > 0)) return []
  const cell = Math.min(MAX_CELL_MM, Math.max(MIN_CELL_MM, side / CELLS_ACROSS))
  // Room for the growth plus two empty cells round the box, so the outside is one region.
  const pad = GROW_CELLS + 2
  const x0 = bbox.minX - pad * cell, y0 = bbox.minY - pad * cell
  const W = Math.ceil(bbox.width / cell) + 2 * pad, H = Math.ceil(bbox.height / cell) + 2 * pad
  const touched = new Uint8Array(W * H)
  const mark = (fx: number, fy: number) => {
    const i = Math.floor(fx), j = Math.floor(fy)
    if (i >= 0 && j >= 0 && i < W && j < H) touched[j * W + i] = 1
  }

  const triCount = indices ? indices.length / 3 : positions.length / 9
  const vx = (v: number) => (map.x(positions[v * 3]) - x0) / cell
  const vy = (v: number) => (map.y(positions[v * 3 + 1]) - y0) / cell
  for (let t = 0; t < triCount; t++) {
    const a = indices ? indices[t * 3] : t * 3
    const b = indices ? indices[t * 3 + 1] : t * 3 + 1
    const c = indices ? indices[t * 3 + 2] : t * 3 + 2
    const ax = vx(a), ay = vy(a), bx = vx(b), by = vy(b), cx = vx(c), cy = vy(c)
    // Every cell an edge passes through (a quarter-cell walk: what it misses at a cell's
    // corner is far less than the growth below) — so a facet narrower than a cell, or a
    // vertical one, still marks its cells.
    for (const [px, py, qx, qy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) {
      const m = Math.max(1, Math.ceil(Math.hypot(qx - px, qy - py) * 4))
      for (let k = 0; k <= m; k++) mark(px + (qx - px) * k / m, py + (qy - py) * k / m)
    }
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(area) < 1e-12) continue
    const s = area > 0 ? 1 : -1
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)))
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)))
    const eps = -1e-9
    for (let j = j0; j <= j1; j++) {
      const py = j + 0.5
      for (let i = i0; i <= i1; i++) {
        const px = i + 0.5
        const e0 = s * ((bx - ax) * (py - ay) - (by - ay) * (px - ax))
        const e1 = s * ((cx - bx) * (py - by) - (cy - by) * (px - bx))
        const e2 = s * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx))
        if (e0 >= eps && e1 >= eps && e2 >= eps) touched[j * W + i] = 1
      }
    }
  }

  // Grown by GROW_CELLS (a disc), which also closes the hairline cracks between facets.
  const mask = new Uint8Array(W * H)
  const disc: number[] = []
  for (let dj = -GROW_CELLS; dj <= GROW_CELLS; dj++) for (let di = -GROW_CELLS; di <= GROW_CELLS; di++) {
    if (di * di + dj * dj <= GROW_CELLS * GROW_CELLS + 1) disc.push(dj * W + di)
  }
  for (let j = GROW_CELLS; j < H - GROW_CELLS; j++) for (let i = GROW_CELLS; i < W - GROW_CELLS; i++) {
    const k = j * W + i
    if (touched[k]) for (const o of disc) mask[k + o] = 1
  }

  // Inside = whatever the outside cannot reach (flood from the border cell).
  const outside = new Uint8Array(W * H)
  const stack = [0]
  outside[0] = 1
  while (stack.length) {
    const k = stack.pop()!
    const i = k % W, j = (k - i) / W
    const nb = [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, j > 0 ? k - W : -1, j < H - 1 ? k + W : -1]
    for (const n of nb) if (n >= 0 && !outside[n] && !mask[n]) { outside[n] = 1; stack.push(n) }
  }
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && !outside[j * W + i]

  // Drop pieces too small to be part of the model.
  const seen = new Uint8Array(W * H)
  for (let k = 0; k < W * H; k++) {
    if (outside[k] || seen[k]) continue
    const piece = [k]
    seen[k] = 1
    for (let p = 0; p < piece.length; p++) {
      const q = piece[p], i = q % W, j = (q - i) / W
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj
        if (!inside(ni, nj)) continue
        const n = nj * W + ni
        if (!seen[n]) { seen[n] = 1; piece.push(n) }
      }
    }
    if (piece.length < MIN_PIECE_CELLS) for (const q of piece) outside[q] = 1
  }

  // Boundary edges between inside and outside cells, directed with the inside on the LEFT
  // (so outer rings run CCW). Vertices are cell corners, (W+1) × (H+1).
  const V = W + 1
  const next = new Map<number, number[]>()
  const addEdge = (from: number, to: number) => {
    const l = next.get(from)
    if (l) l.push(to)
    else next.set(from, [to])
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!inside(i, j)) continue
    if (!inside(i, j - 1)) addEdge(j * V + i, j * V + i + 1)             // bottom, +X
    if (!inside(i + 1, j)) addEdge(j * V + i + 1, (j + 1) * V + i + 1)   // right, +Y
    if (!inside(i, j + 1)) addEdge((j + 1) * V + i + 1, (j + 1) * V + i) // top, −X
    if (!inside(i - 1, j)) addEdge((j + 1) * V + i, j * V + i)           // left, −Y
  }

  const rings: Pt2[][] = []
  const dirOf = (a: number, b: number) => [b % V - a % V, Math.floor(b / V) - Math.floor(a / V)]
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop: number[] = [start]
      let prev = start, cur = next.get(start)!.pop()!
      while (cur !== start) {
        loop.push(cur)
        const outs = next.get(cur)
        if (!outs || outs.length === 0) break
        let pick = 0
        if (outs.length > 1) {
          // A saddle (two pieces meeting at a corner): turn LEFT, round the same cell, so
          // pieces touching only at a corner stay separate rings.
          const [dx, dy] = dirOf(prev, cur)
          const left = outs.findIndex((o) => { const [ox, oy] = dirOf(cur, o); return ox === -dy && oy === dx })
          pick = left >= 0 ? left : 0
        }
        const nxt = outs.splice(pick, 1)[0]
        prev = cur
        cur = nxt
      }
      if (cur !== start || loop.length < 4) continue
      const pts: Pt2[] = loop.map((v) => [x0 + (v % V) * cell, y0 + Math.floor(v / V) * cell])
      // Outer boundaries only: everything inside was filled, so any CW loop is degenerate.
      let a2 = 0
      for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a2 += p[0] * q[1] - q[0] * p[1] }
      if (a2 <= 0) continue
      const ring = simplifyClosed(smoothClosed(pts), cell * 0.25)
      if (ring.length >= 3) rings.push([...ring, ring[0]])
    }
  }
  return rings
}

// The traced loop is a staircase, and a tab is drawn and cut square to the outline where it
// sits — read off a staircase, that direction is 0° or 90° wherever it happens to land.
// Each point becomes the mean of the edge midpoints round it, which takes the steps out
// (and moves a straight edge not at all), before the ring is simplified.
const SMOOTH_HALF = 4
function smoothClosed(pts: Pt2[]): Pt2[] {
  const n = pts.length
  if (n < 2 * SMOOTH_HALF + 2) return pts
  const mids: Pt2[] = pts.map((p, i) => { const q = pts[(i + 1) % n]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] })
  const out: Pt2[] = []
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0
    for (let k = -SMOOTH_HALF; k <= SMOOTH_HALF; k++) { const m = mids[(i + k + n) % n]; x += m[0]; y += m[1] }
    out.push([x / (2 * SMOOTH_HALF + 1), y / (2 * SMOOTH_HALF + 1)])
  }
  return out
}

// Douglas–Peucker on a closed ring, split at the point farthest from the first.
function simplifyClosed(pts: Pt2[], tol: number): Pt2[] {
  if (pts.length < 4) return pts
  let far = 0, best = -1
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1])
    if (d > best) { best = d; far = i }
  }
  const a = dp(pts.slice(0, far + 1), tol)
  const b = dp([...pts.slice(far), pts[0]], tol)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

function dp(pts: Pt2[], tol: number): Pt2[] {
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    const [ax, ay] = pts[s], [bx, by] = pts[e]
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy)
    let worst = -1, wi = -1
    for (let i = s + 1; i < e; i++) {
      const d = L < 1e-12 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L
      if (d > worst) { worst = d; wi = i }
    }
    if (worst > tol) { keep[wi] = 1; stack.push([s, wi], [wi, e]) }
  }
  return pts.filter((_, i) => keep[i])
}

// ─── The outline tabs go on, for any path ─────────────────────────────────────

interface TabPathLike { d: string; stlSrc?: string; stlModelBounds?: StlModelBounds }

// One silhouette per (model, outline): the canvas asks on every render, and a big STL is a
// million triangles.
const memo = new Map<string, { src: string; rings: Pt2[][] }>()
const MEMO_SIZE = 8
const flatMemo = new Map<string, Pt2[][]>()
const FLAT_MEMO_SIZE = 4096

/**
 * The outline a path's tabs lie on, as closed polylines — what a tab's `t` is measured
 * along. An STL model's silhouette (above); every other path's own `d`, flattened at 0.05.
 */
export function tabOutline(p: TabPathLike): Pt2[][] {
  if (p.stlSrc && p.stlModelBounds) {
    const key = p.d + '\u0000' + JSON.stringify(p.stlModelBounds)
    const hit = memo.get(key)
    if (hit && hit.src === p.stlSrc) return hit.rings
    let rings: Pt2[][] = []
    const bbox = getBBox(p.d)
    // Asked during a render (the form's boundary list, the tab layer): a model that will not
    // decode keeps its box rather than taking the panel down.
    if (bbox) {
      try {
        const mesh = decodeStlMesh(p.stlSrc)
        const placed = placeStlModel(mesh.positions, p.stlModelBounds, p.d)
        rings = meshSilhouette(placed.positions, mesh.indices, placed.bounds, bbox)
      } catch { rings = [] }
    }
    // A model with nothing to trace keeps its box.
    if (rings.length === 0) rings = flattenPath(p.d, 0.05)
    memo.set(key, { src: p.stlSrc, rings })
    if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value!)
    return rings
  }
  let polys = flatMemo.get(p.d)
  if (!polys) {
    polys = flattenPath(p.d, 0.05)
    if (flatMemo.size >= FLAT_MEMO_SIZE) flatMemo.clear()
    flatMemo.set(p.d, polys)
  }
  return polys
}
