// HOLDING TABS ON A 3D PROFILE. A 3D Profile that cuts round a model down through the stock
// frees it, exactly as a 2D profile frees a part — but it has no cut path to lift along. Its
// passes all follow the MODEL (the height map, the exact drop cutters, the waterline slicer),
// so a tab is made the one way every pass will agree on: it is added to the model. A flat
// strip of surface at the tab's top, from where the model stands taller than it out past
// the cut. Roughing leaves its allowance on it, the finish rides over it, the waterline rings
// go round it, and none of them can gouge it or forget it — there is no second code path.
//
// A tab is placed on the model's OUTLINE (the path the op is built on — its box, or the
// turned rectangle), like any other tab: `t` of the way round it, `lengthMM` wide. From that
// point it runs INWARD, square off the outline, as far as the model — each sliver of its
// width to where the model first stands above the tab's top, so its inner end follows the
// model's shape — and OUTWARD past everything the tools can reach, into the stock beyond
// the cut. Where the cut is not through the stock the top is below the floor and there is
// no tab, which is right: the part is still held by what is under it.
import type { BBox } from '../canvas/selectionUtils'
import type { StlModelBounds } from '../importers/svgImporter'
import { stlToCnc } from './stlMapping'

/** One tab: where it sits on the model's outline, the unit normal pointing IN to the model,
 *  how wide it is along the outline and the Z of its top (`holdTopZ`). */
export interface Profile3dTab { x: number; y: number; nx: number; ny: number; lengthMM: number; topZ: number }

/** A strip of tab: a rectangle from `out` mm outward of (x, y) to `inn` mm inward, `w` wide. */
export interface TabStrip { x: number; y: number; nx: number; ny: number; w: number; inn: number; out: number; topZ: number }

/** How far past the model's first contact a strip runs into it, so no hairline is left. */
const OVERLAP_MM = 0.5

/**
 * The strips each tab is made of, read off the model's height map (`grid`, nx × ny nodes over
 * `G`, not yet raised). A sliver that never meets the model above the tab's top holds nothing
 * and is left out — a tab placed beside a corner the model does not fill is narrower there —
 * and so is a whole tab whose top is at or below the floor.
 */
export function tabStrips(tabs: Profile3dTab[], grid: Float32Array, nx: number, ny: number, G: BBox, floorZ: number): TabStrip[] {
  const cellX = G.width / (nx - 1), cellY = G.height / (ny - 1)
  const cell = Math.min(cellX, cellY)
  const far = Math.hypot(G.width, G.height)
  const at = (x: number, y: number): number | null => {
    const ix = Math.round((x - G.minX) / cellX), iy = Math.round((y - G.minY) / cellY)
    return ix < 0 || iy < 0 || ix >= nx || iy >= ny ? null : grid[iy * nx + ix]
  }
  const out: TabStrip[] = []
  for (const t of tabs) {
    if (!(t.topZ > floorZ + 0.01) || !(t.lengthMM > 0)) continue
    const tx = -t.ny, ty = t.nx
    const n = Math.max(1, Math.ceil(t.lengthMM / cell))
    const w = t.lengthMM / n
    for (let k = 0; k < n; k++) {
      const u = -t.lengthMM / 2 + (k + 0.5) * w
      const sx = t.x + tx * u, sy = t.y + ty * u
      for (let s = 0; s <= far; s += cell) {
        const z = at(sx + t.nx * s, sy + t.ny * s)
        if (z === null) break
        if (z >= t.topZ) { out.push({ x: sx, y: sy, nx: t.nx, ny: t.ny, w, inn: s + OVERLAP_MM, out: far, topZ: t.topZ }); break }
      }
    }
  }
  return out
}

/** Raise the height map to each strip's top wherever a node's cell can touch the strip. */
export function raiseGridForTabs(grid: Float32Array, nx: number, ny: number, G: BBox, strips: TabStrip[]): void {
  const cellX = G.width / (nx - 1), cellY = G.height / (ny - 1)
  // A node stands for its whole cell: one whose cell only clips the strip still reads it.
  const slack = Math.hypot(cellX, cellY) / 2
  for (const s of strips) {
    const tx = -s.ny, ty = s.nx
    const corners = [[-s.out, -s.w / 2], [-s.out, s.w / 2], [s.inn, s.w / 2], [s.inn, -s.w / 2]]
      .map(([a, b]) => [s.x + s.nx * a + tx * b, s.y + s.ny * a + ty * b])
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1])
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - slack - G.minX) / cellX)), i1 = Math.min(nx - 1, Math.ceil((Math.max(...xs) + slack - G.minX) / cellX))
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - slack - G.minY) / cellY)), j1 = Math.min(ny - 1, Math.ceil((Math.max(...ys) + slack - G.minY) / cellY))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = G.minX + i * cellX - s.x, dy = G.minY + j * cellY - s.y
      const a = dx * s.nx + dy * s.ny, b = dx * tx + dy * ty
      if (a < -s.out - slack || a > s.inn + slack || Math.abs(b) > s.w / 2 + slack) continue
      const k = j * nx + i
      if (grid[k] < s.topZ) grid[k] = s.topZ
    }
  }
}

/**
 * The mesh with each strip's TOP FACE added — two triangles, in the model's own coordinates
 * (the inverse of `stlToCnc`), so everything that reads the triangles reads the tabs: the
 * drop cutters rest on the face and its edges, the slicer's shadow takes its outline in.
 * Only the top: a tool can only ever touch a flat strip there or on its edges.
 */
export function meshWithTabs(
  positions: Float32Array, indices: Uint32Array | null, bounds: StlModelBounds, bbox: BBox, zOffsetMM: number, strips: TabStrip[],
): { positions: Float32Array; indices: Uint32Array | null } {
  if (strips.length === 0) return { positions, indices }
  const map = stlToCnc(bounds, bbox, zOffsetMM)
  // The map is affine per axis: two samples give its inverse.
  const inv = (f: (v: number) => number) => { const c = f(0), m = f(1) - c; return (v: number) => (v - c) / m }
  const ix = inv(map.x), iy = inv(map.y), iz = inv(map.z)
  const verts: number[] = []
  for (const s of strips) {
    const tx = -s.ny, ty = s.nx
    const c = [[-s.out, -s.w / 2], [-s.out, s.w / 2], [s.inn, s.w / 2], [s.inn, -s.w / 2]]
      .map(([a, b]) => [ix(s.x + s.nx * a + tx * b), iy(s.y + s.ny * a + ty * b), iz(s.topZ)])
    for (const q of [c[0], c[1], c[2], c[0], c[2], c[3]]) verts.push(q[0], q[1], q[2])
  }
  const base = positions.length / 3
  const outP = new Float32Array(positions.length + verts.length)
  outP.set(positions)
  outP.set(verts, positions.length)
  if (!indices) return { positions: outP, indices: null }
  const outI = new Uint32Array(indices.length + verts.length / 3)
  outI.set(indices)
  for (let k = 0; k < verts.length / 3; k++) outI[indices.length + k] = base + k
  return { positions: outP, indices: outI }
}
