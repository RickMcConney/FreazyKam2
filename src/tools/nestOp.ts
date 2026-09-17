// ─── Nesting ──────────────────────────────────────────────────────────────────
//
// Arrange parts on the stock so as little material as possible is wasted.
//
// WHY A RASTER AND NOT A NO-FIT POLYGON. The textbook answer to irregular nesting
// is the NFP: for each ordered pair of parts, the locus of positions where they
// touch without overlapping, computed by Minkowski sum. It is exact and it is
// what SVGnest/deepnest use — and it is also where those implementations spend
// all of their bug budget, because the sum of two non-convex polygons with holes
// is a genuinely hard piece of computational geometry, and every degeneracy
// (collinear edges, coincident vertices, a part that fits a hole exactly) is a
// separate special case. Worse, an NFP says nothing about a part sitting INSIDE
// another part's hole without a second, differently-shaped inner-fit polygon.
//
// A raster gives all of that for free. "Does this part fit here" becomes a
// bitwise AND, "may a part sit in a ring's hole" becomes "did we fill the hole
// when we stamped the ring", and there are no degeneracies at all — the worst a
// pathological outline can do is cost a cell of packing tightness. The price is
// resolution-limited placement, which for a CNC job with a millimetre of spacing
// around every part is not a price.
//
// CONSERVATIVENESS IS THE ONE INVARIANT THAT MATTERS. Every mask is a SUPERSET of
// the polygon it stands for: a cell is set if the part touches it ANYWHERE, not if
// its centre happens to be inside. Two supersets that share no cell therefore
// stand for two polygons that do not overlap, so a fit reported here is a fit in
// millimetres — never the other way round. The cost is that a nest can be a cell
// looser than the theoretical optimum, which is the right side to err on when the
// result is going into wood.
//
// It takes TWO passes to earn that, and the second is the one that is easy to
// leave out. Scanline filling alone describes a part by where its INTERIOR is, so
// any feature thinner than a cell — a spoke, a tab, the waist of a bone — falls
// between the scanlines and simply is not in the mask, and another part nests
// straight through it. Sampling the row two or three times only moves the
// threshold; it does not remove it. So the outline is walked cell by cell as well
// (`markSegment`, an exact grid traversal), which covers every cell the boundary
// passes through whatever its width. A cell wholly inside the part is caught by
// the fill; a cell the part only clips necessarily holds a piece of the boundary
// and is caught by the walk. Between them there is nothing left to miss.
//
// Coordinates are CNC mm, Y-up, and the stock occupies [0,W]×[0,H] whatever the
// XY origin says (originWorldXY is a display/G-code offset applied on the way out
// — see WorkpieceLayer). Nothing here knows about paths, the stores or the UI:
// it takes rings and gives back transforms.

import { flattenPath, type Pt2 } from '../cam/pathFlattener'
import { interiorPoint } from '../cam/geom'

// ─── Public types ─────────────────────────────────────────────────────────────

/** One thing that moves as a unit. `rings` are closed polylines, filled even-odd. */
export interface NestItem {
  id: string
  rings: Pt2[][]
  /**
   * How far this part ALREADY stands turned from the orientation it was drawn in.
   *
   * Without it the rotation grid is relative to wherever the part happens to be
   * lying, so nesting at 90° a part a previous nest had turned 15° offers it
   * 105°, 195°, 285° — never square to the stock — and every re-nest turns
   * everything again. With it the grid is ABSOLUTE: "90°" always means one of the
   * four square orientations, and re-nesting the same parts with the same
   * settings reproduces the same nest instead of drifting.
   */
  currentAngleDeg?: number
}

export interface NestParams {
  sheetWidthMM: number
  sheetHeightMM: number
  /** Minimum gap between two parts. */
  spacingMM: number
  /** Minimum gap between a part and the edge of the stock. */
  marginMM: number
  /** 0 = parts keep their orientation; otherwise the angles tried are multiples of this. */
  rotationStepDeg: number
  /**
   * Which edge the nest grows from, and therefore where the offcut ends up.
   *
   * 'left' (the default) packs in columns from the left-hand edge, so what is
   * left over is a full-height strip off the END of the board — which is the
   * piece a woodworker can actually use, because length is the dimension you
   * trim and width is whatever the board already is. 'bottom' packs in rows from
   * the bottom edge instead, for stock whose long axis runs the other way.
   */
  packFrom?: 'left' | 'bottom'
  /** Whether a part may be nested inside another part's hole. */
  useHoles: boolean
  /** Ring sets that are already occupied — paths that were not selected for nesting. */
  obstacles?: Pt2[][][]
  /**
   * FILL THE STOCK. The ONE item given is repeated as many times as will fit,
   * and the placements come back with `#0`, `#1`, … appended to its id: `#0` is
   * the part the caller already has, the rest are copies for it to make.
   *
   * Ignored unless exactly one item is given, since "as many as will fit" has no
   * meaning for a mixed set — which of them would it make more of?
   */
  fill?: boolean
  /** Cell size. Defaults to a size that keeps the grid near a million cells. */
  resolutionMM?: number
}

/**
 * Where one item ended up, as the transform to apply to it: rotate about
 * (pivotX, pivotY) by `angleDeg`, THEN translate by (dx, dy). Stated as a
 * transform rather than as new geometry so the caller can hand it straight to
 * `applyTransformStep`, which is what keeps shape parameters and placement
 * recipes alive through the move.
 */
export interface NestPlacement {
  id: string
  angleDeg: number
  pivotX: number
  pivotY: number
  dx: number
  dy: number
  /**
   * False for a part that would not fit and has been PARKED clear of the stock
   * instead (see the parking pass in `nest`). Leaving such a part where it lay
   * was the first behaviour and it is the wrong one: the nest has just cleared
   * and repacked the stock underneath it, so "where it lay" is on top of
   * everything else, and a nest of nineteen tracks came out with seven pairs of
   * parts sitting through each other. A part that cannot be cut from this stock
   * has to be somewhere the user can see it is not on the stock.
   */
  onStock: boolean
}

export interface NestResult {
  /** Every item that moved — on the stock and parked beside it, `onStock` says which. */
  placements: NestPlacement[]
  /** Items that would not fit on the stock. They are parked clear of it. */
  unplacedIds: string[]
  resolutionMM: number
  /** Nested part area as a fraction of the whole stock. */
  utilization: number
  /** Bounding box of the nested result — what lies beyond it is usable offcut. */
  usedWidthMM: number
  usedHeightMM: number
  /**
   * A FILL THAT STOPPED SHORT: it hit the work ceiling (see FILL_LIMIT) rather
   * than running out of stock, so the sheet would take more copies than came
   * back. The caller has to say so — "fill the stock" that quietly did not is
   * the one outcome the user cannot tell from a full sheet by looking.
   */
  fillLimited?: boolean
}

// ─── Bit grid ─────────────────────────────────────────────────────────────────

// Occupancy for the whole sheet, one bit per cell, packed 32 to a word so a
// collision test is a handful of word reads rather than a loop over cells.
class BitGrid {
  readonly cols: number
  readonly rows: number
  private readonly wpr: number
  private readonly bits: Uint32Array

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.wpr = (cols + 31) >> 5
    this.bits = new Uint32Array(this.wpr * rows)
  }

  /** Set columns [a,b] (inclusive) of row r. Out-of-range parts are clipped away. */
  setRange(r: number, a: number, b: number): void {
    if (r < 0 || r >= this.rows) return
    const c0 = a < 0 ? 0 : a
    const c1 = b > this.cols - 1 ? this.cols - 1 : b
    if (c1 < c0) return
    const base = r * this.wpr
    const w0 = c0 >>> 5, w1 = c1 >>> 5
    const m0 = 0xffffffff << (c0 & 31)
    const m1 = 0xffffffff >>> (31 - (c1 & 31))
    if (w0 === w1) { this.bits[base + w0] |= m0 & m1; return }
    this.bits[base + w0] |= m0
    for (let w = w0 + 1; w < w1; w++) this.bits[base + w] = 0xffffffff
    this.bits[base + w1] |= m1
  }

  /** Lowest set column within [a,b] of row r, or -1 when the span is clear. */
  firstSetInRange(r: number, a: number, b: number): number {
    if (r < 0 || r >= this.rows) return -1
    const c0 = a < 0 ? 0 : a
    const c1 = b > this.cols - 1 ? this.cols - 1 : b
    if (c1 < c0) return -1
    const base = r * this.wpr
    const w0 = c0 >>> 5, w1 = c1 >>> 5
    const m0 = 0xffffffff << (c0 & 31)
    const m1 = 0xffffffff >>> (31 - (c1 & 31))
    for (let w = w0; w <= w1; w++) {
      let v = this.bits[base + w] | 0
      if (w === w0) v &= m0
      if (w === w1) v &= m1
      if (v !== 0) return (w << 5) + (31 - Math.clz32(v & -v))
    }
    return -1
  }
}

// ─── Rasterising ──────────────────────────────────────────────────────────────

/**
 * A part as cell spans, with its bbox min at local (0,0). Rows are indexed from
 * the BOTTOM (CNC Y-up), and `runs[r]` is a flat list of inclusive [start, end]
 * column pairs — one entry for a convex row, more for a row crossing a fork.
 */
interface Mask {
  cols: number
  rows: number
  runs: number[][]
  /** Set cells, i.e. the part's area in cells. */
  cells: number
}

/** Where a horizontal line at `y` crosses a closed ring. */
function ringCrossings(ring: Pt2[], y: number, out: number[]): void {
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const ya = ring[a][1], yb = ring[b][1]
    // Same half-open rule as pointInPolygon, so a vertex on the line counts once.
    if ((ya > y) !== (yb > y)) {
      out.push(ring[a][0] + ((y - ya) / (yb - ya)) * (ring[b][0] - ring[a][0]))
    }
  }
}

/**
 * Subpaths that carry geometry, with non-finite points dropped.
 *
 * Two points is enough: an open cut occupies material along its line. Dropping
 * them is what made a track's grooves invisible to the nest. Non-finite points go
 * because a NaN reaches the grid traversal as a NaN cell index, which indexes
 * nothing and used to throw — one bad coordinate in an import is not a reason to
 * fail a nest.
 */
function usableRings(rings: Pt2[][]): Pt2[][] {
  return rings
    .map((r) => r.filter(([x, y]) => isFinite(x) && isFinite(y)))
    .filter((r) => r.length >= 2)
}

function bboxOf(rings: Pt2[][]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

function translateRings(rings: Pt2[][], dx: number, dy: number): Pt2[][] {
  return rings.map((r) => r.map(([x, y]) => [x + dx, y + dy] as Pt2))
}

function rotateRings(rings: Pt2[][], cx: number, cy: number, deg: number): Pt2[][] {
  if (deg === 0) return rings
  const t = (deg * Math.PI) / 180
  const cos = Math.cos(t), sin = Math.sin(t)
  return rings.map((r) => r.map(([x, y]) => {
    const px = x - cx, py = y - cy
    return [cx + cos * px - sin * py, cy + sin * px + cos * py] as Pt2
  }))
}

/**
 * Rings (already sitting with their bbox min at the origin) as a cell mask.
 *
 * `mode` is the fill rule, and it is the whole of the "may a part sit in a hole"
 * question: 'evenodd' leaves a hole unset, so later parts can be placed in it;
 * 'union' — inside ANY ring — fills holes in, so they cannot.
 *
 * Interior fill plus an outline walk; see the header for why both are needed.
 */
function rasterizeMask(rings: Pt2[][], res: number, mode: 'evenodd' | 'union'): Mask {
  // TWO POPULATIONS, and conflating them cost the track its grooves. `all` is
  // every subpath with a length — including the two-point straight lines an open
  // cut is made of, which have no interior to fill but still occupy material and
  // still have to be in the mask. `solid` is the subset that encloses something,
  // and only those can be filled. Filtering everything to `>= 3` up front left a
  // groove with no geometry at all: no cells, no bounding box, and a part the
  // nest was free to drop straight on top of.
  const all = usableRings(rings)
  const solid = all.filter((r) => r.length >= 3)
  const bb = bboxOf(all)
  if (!bb) return { cols: 0, rows: 0, runs: [], cells: 0 }
  const cols = Math.max(1, Math.ceil(bb.maxX / res - 1e-9))
  const rows = Math.max(1, Math.ceil(bb.maxY / res - 1e-9))
  const spans: number[][] = Array.from({ length: rows }, () => [])
  const xs: number[] = []

  // Pass 1 — the interior, one scanline down the middle of each cell row. A cell
  // the part covers completely has its centre inside, so the fill catches it;
  // anything the fill misses is a cell the boundary crosses, which is pass 2.
  for (let r = 0; r < rows; r++) {
    const y = (r + 0.5) * res
    if (mode === 'evenodd') {
      xs.length = 0
      for (const ring of solid) ringCrossings(ring, y, xs)
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2) addSpan(spans[r], xs[k], xs[k + 1], res, cols)
    } else {
      for (const ring of solid) {
        xs.length = 0
        ringCrossings(ring, y, xs)
        xs.sort((p, q) => p - q)
        for (let k = 0; k + 1 < xs.length; k += 2) addSpan(spans[r], xs[k], xs[k + 1], res, cols)
      }
    }
  }

  // Pass 2 — the outline itself, cell by cell. Runs for BOTH fill rules: a hole's
  // wall is material either way, and leaving it out would let a part nested in a
  // hole touch the wall. Over `all`, so an open cut is exactly its own line.
  for (const ring of all) {
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      markSegment(spans, ring[b][0], ring[b][1], ring[a][0], ring[a][1], res, cols, rows)
    }
  }

  const runs: number[][] = []
  let cells = 0
  for (let r = 0; r < rows; r++) {
    const row = mergeSpans(spans[r])
    runs.push(row)
    for (let i = 0; i < row.length; i += 2) cells += row[i + 1] - row[i] + 1
  }
  return { cols, rows, runs, cells }
}

/** Every cell the interval [x0,x1] touches — rounded OUTWARD, never inward. */
function addSpan(out: number[], x0: number, x1: number, res: number, cols: number): void {
  let a = Math.floor(x0 / res)
  let b = Math.ceil(x1 / res) - 1
  if (b < a) b = a
  if (a < 0) a = 0
  if (b > cols - 1) b = cols - 1
  if (b < a) return
  out.push(a, b)
}

/**
 * Mark every cell the segment passes through (Amanatides & Woo grid traversal:
 * step whichever axis reaches its next cell boundary first, so the cells marked
 * form an unbroken chain along the line rather than a dotted one).
 */
function markSegment(
  spans: number[][], x0: number, y0: number, x1: number, y1: number,
  res: number, cols: number, rows: number,
): void {
  const clampC = (c: number) => (c < 0 ? 0 : c > cols - 1 ? cols - 1 : c)
  const clampR = (r: number) => (r < 0 ? 0 : r > rows - 1 ? rows - 1 : r)
  const u0 = x0 / res, v0 = y0 / res, u1 = x1 / res, v1 = y1 / res
  let cx = clampC(Math.floor(u0)), cy = clampR(Math.floor(v0))
  const cxEnd = clampC(Math.floor(u1)), cyEnd = clampR(Math.floor(v1))
  spans[cy].push(cx, cx)
  const du = u1 - u0, dv = v1 - v0
  const stepX = du > 0 ? 1 : du < 0 ? -1 : 0
  const stepY = dv > 0 ? 1 : dv < 0 ? -1 : 0
  const tDeltaX = du === 0 ? Infinity : 1 / Math.abs(du)
  const tDeltaY = dv === 0 ? Infinity : 1 / Math.abs(dv)
  let tMaxX = du === 0 ? Infinity : (stepX > 0 ? Math.floor(u0) + 1 - u0 : u0 - Math.floor(u0)) / Math.abs(du)
  let tMaxY = dv === 0 ? Infinity : (stepY > 0 ? Math.floor(v0) + 1 - v0 : v0 - Math.floor(v0)) / Math.abs(dv)
  // The traversal is bounded by the cells the segment spans; the guard is only
  // there so a NaN coordinate cannot spin forever.
  let guard = Math.abs(cxEnd - cx) + Math.abs(cyEnd - cy) + 4
  while ((cx !== cxEnd || cy !== cyEnd) && guard-- > 0) {
    if (tMaxX < tMaxY) { cx = clampC(cx + stepX); tMaxX += tDeltaX } else { cy = clampR(cy + stepY); tMaxY += tDeltaY }
    spans[cy].push(cx, cx)
  }
}

/** Sort and coalesce a row's [a,b] pairs, joining touching runs. */
function mergeSpans(flat: number[]): number[] {
  const n = flat.length / 2
  if (n === 0) return []
  const idx = Array.from({ length: n }, (_, i) => i).sort((p, q) => flat[p * 2] - flat[q * 2])
  const out: number[] = []
  let a = flat[idx[0] * 2], b = flat[idx[0] * 2 + 1]
  for (let i = 1; i < n; i++) {
    const na = flat[idx[i] * 2], nb = flat[idx[i] * 2 + 1]
    if (na <= b + 1) { if (nb > b) b = nb } else { out.push(a, b); a = na; b = nb }
  }
  out.push(a, b)
  return out
}

// ─── Placement ────────────────────────────────────────────────────────────────

/**
 * Stamp a mask into the grid, grown by a disk of `rad` cells.
 *
 * The clearance between parts is created ONCE, here, on the part being put down
 * — rather than on every candidate position of the part being placed, which is
 * the inner loop. Growing by a disk (a per-row half-width of √(rad²−dy²)) rather
 * than by a square is what makes the gap a true distance and not a Chebyshev one,
 * so two parts meeting corner-to-corner are not pushed 1.4× further apart than
 * two meeting edge-to-edge.
 */
function stampDilated(grid: BitGrid, mask: Mask, ox: number, oy: number, rad: number): void {
  for (let r = 0; r < mask.rows; r++) {
    const row = mask.runs[r]
    if (row.length === 0) continue
    for (let dy = -rad; dy <= rad; dy++) {
      const dx = Math.floor(Math.sqrt(Math.max(0, rad * rad - dy * dy)))
      const gr = oy + r + dy
      for (let i = 0; i < row.length; i += 2) grid.setRange(gr, ox + row[i] - dx, ox + row[i + 1] + dx)
    }
  }
}

/**
 * Whether `mask` fits with its corner at (ox, oy); -1 when it does, otherwise the
 * lowest ox worth trying next.
 *
 * That second return is what makes the scan affordable. A run blocked at absolute
 * column c cannot come clear until the run's own start has passed it, so every x
 * up to c − runStart is known to fail without being tested — one word read
 * skips a whole placed part rather than a cell.
 */
function fitOrSkip(grid: BitGrid, mask: Mask, ox: number, oy: number): number {
  for (let r = 0; r < mask.rows; r++) {
    const row = mask.runs[r]
    const gr = oy + r
    for (let i = 0; i < row.length; i += 2) {
      const a = row[i], b = row[i + 1]
      const hit = grid.firstSetInRange(gr, ox + a, ox + b)
      if (hit >= 0) return hit - a + 1
    }
  }
  return -1
}

/** One orientation a part may be offered: where it would END UP, and the turn to get there. */
interface Turn {
  /** The absolute orientation, in [0,360) — a multiple of the grid step. */
  absolute: number
  /** The turn from where the part is lying now, in (−180,180]. */
  delta: number
}

/**
 * The turns to try, as deltas from where the part is lying NOW.
 *
 * The grid itself is absolute — multiples of `stepDeg` from the orientation the
 * part was drawn in — so `currentDeg` is subtracted out to state each one as the
 * turn that would get there. Least movement first, so a part that is already
 * square to the stock is offered "stay put" ahead of "turn 180°", and a tie
 * between two orientations goes to the one that disturbs the drawing least.
 */
function anglesFor(stepDeg: number, currentDeg = 0): Turn[] {
  const norm = (a: number) => { const m = ((a % 360) + 360) % 360; return m > 180 ? m - 360 : m }
  // NO ROTATION IS THE GRID {0}, NOT "LEAVE IT ALONE". Both readings sound the
  // same until a part has already been turned by an earlier nest: "leave it
  // alone" strands it at 90° with no way back short of undo, while the grid
  // reading turns it home. The grid reading is also the only one consistent with
  // the rest of the ladder — every other step offers 0 among its orientations,
  // so the coarsest possible step has to offer 0 and nothing else.
  if (!(stepDeg > 0) || stepDeg >= 360) return [{ absolute: 0, delta: norm(-currentDeg) }]
  const out: Turn[] = []
  for (let k = 0; k * stepDeg < 360 - 1e-9; k++) {
    const absolute = k * stepDeg
    const delta = norm(absolute - currentDeg)
    out.push({ absolute, delta: Math.abs(delta) < 1e-9 ? 0 : delta })
  }
  return out.sort((p, q) => Math.abs(p.delta) - Math.abs(q.delta))
}

/**
 * The rotation grids to pack against, coarsest first, for a chosen step.
 *
 * A FINER SETTING MUST NEVER PLACE FEWER PARTS THAN A COARSER ONE. Every layout
 * reachable at 90° is reachable at 15° — the 90° grid is a subset of the 15° one
 * — so a user who reads the setting as "how freely may parts turn" is right, and
 * a result that gets worse as the freedom grows is a bug however it is explained.
 *
 * It happened anyway, and the reason is worth stating because it is a property of
 * greedy packing and not of this code: bottom-left fill takes the lowest position
 * it can find and never reconsiders, so given a finer grid a part will take a
 * slightly lower spot at some odd angle, the tidy rows never form, and the sheet
 * of 19 tracks that fitted at 90° dropped to 17 at 15° — worse than not turning
 * anything at all. MORE CHOICE MAKES A GREEDY ALGORITHM WORSE, reliably.
 *
 * So the finer settings pack against the coarser grids too and keep the best
 * result, which makes the ladder monotone by construction rather than by luck.
 *
 * THE CHOSEN GRID COMES FIRST AND THE REST ARE INSURANCE. Where everything fits
 * at the setting the user picked — which is the ordinary case — the caller stops
 * there and pays nothing for the rest, and the answer is the finely-packed one
 * they asked for. The coarser grids are only worth their time when parts are
 * actually being left over, and that is exactly when they are run. Turning 60
 * parts at 15° went from 14.6 s to under 3 s on that rule alone; the finer grids
 * were buying about 2.5% of tightness for five times the wait.
 */
function angleGrids(stepDeg: number): number[] {
  if (!(stepDeg > 0) || stepDeg >= 360) return [stepDeg]
  return [stepDeg, ...ROTATION_LADDER.filter((t) => t > stepDeg && t % stepDeg === 0)]
}

/** The steps the UI offers, coarsest first — the ladder `angleGrids` walks down. */
const ROTATION_LADDER = [180, 90, 45]

/** Most copies one fill will make, whatever the arithmetic says — see `fillCap`. */
const FILL_LIMIT = 400

interface Candidate { mask: Mask; angle: number; absAngle: number; minX: number; minY: number }

/**
 * Which way up a part is offered to the sweep first.
 *
 * THE ONE THING GREEDY PACKING CANNOT FIND ON ITS OWN IS A CHANGE OF GRAIN. Take
 * nineteen identical 162×40 tracks on a 600×280 sheet: laid end to end they go
 * three to a row and six rows, which is eighteen and no more. The nineteenth only
 * fits in a MIXED layout — one upright band of thirteen with two lying-down rows
 * of three above it — and a sweep that always offers a part the way it was drawn
 * will never start that upright band, so it stops at eighteen every time and the
 * user finds the missing part by hand in about a minute.
 *
 * Preferring the narrow orientation makes the sweep commit to the upright band;
 * preferring the wide one makes it commit to rows. Neither is right in general,
 * which is why all three are tried and the best kept.
 */
type Orient = 'as-drawn' | 'narrow-first' | 'wide-first'

/** A part worked out ready to pack: its orientations, rasterised, and its pivot. */
interface PreparedItem {
  item: NestItem
  pivotX: number
  pivotY: number
  /** The orientation to fall back on — no turn, where that is on the grid. */
  base: Candidate
  candidates: Candidate[]
}

/**
 * What one packing pass achieved, in packing-grid coordinates.
 *
 * Written out rather than inferred: with `ReturnType<typeof packPass>` the
 * checker resolved the whole thing to `never` and then typed everything after
 * the pass loop as unreachable, which is a confusing way to be told that a pass
 * is just a record of five things.
 */
interface PackOutcome {
  placements: NestPlacement[]
  unplaced: PreparedItem[]
  placedCells: number
  usedCols: number
  usedRows: number
  /** Fill mode only: the pass ran out of its copy budget, not out of stock. */
  fillLimited?: boolean
}

/**
 * The orientations this pass may use, in the order it should try them.
 *
 * `grid` narrows the set to one rotation step — see `angleGrids` for why a 15°
 * nest also packs against the 90° and 45° grids. Ties always fall back to least
 * rotation, so a part that need not turn does not.
 */
function orderCandidates(cands: Candidate[], orient: Orient, grid: number): Candidate[] {
  const inGrid = grid > 0 && grid < 360
    ? cands.filter((c) => Math.abs(c.absAngle % grid) < 1e-9 || Math.abs((c.absAngle % grid) - grid) < 1e-9)
    : cands
  const usable = inGrid.length > 0 ? inGrid : cands
  if (orient === 'as-drawn' || usable.length < 2) return usable
  const dir = orient === 'narrow-first' ? 1 : -1
  return [...usable].sort((a, b) => dir * (a.mask.cols - b.mask.cols) || Math.abs(a.angle) - Math.abs(b.angle))
}

/**
 * Nest `items` onto the stock, bottom-left first.
 *
 * Order is by descending area, which is the standard and the right one: a large
 * part placed late has only the gaps small parts left behind to choose from,
 * while a small part placed late fits in one. Each part then takes the LOWEST,
 * then leftmost, position any of its allowed angles can reach — so the nest grows
 * as a solid front from the origin corner and whatever is left over is one
 * contiguous piece of stock rather than a scatter of unusable gaps.
 */
export function nest(items: NestItem[], params: NestParams): NestResult {
  // PACKING FROM THE LEFT IS PACKING FROM THE BOTTOM OF A TRANSPOSED SHEET, and
  // that is the whole implementation. A column sweep written directly is 10-20x
  // slower than the row sweep, because the skip hint in `fitOrSkip` is an x hint
  // and a sweep moving in y cannot use it (measured, and the reason an earlier
  // column-major twin of `findSpot` was deleted). Swapping x for y on the way in
  // costs one pass over the rings and lets the fast machinery do the work
  // unchanged; the placements are swapped back on the way out.
  //
  // Reflection about y=x is its own inverse and reverses handedness, so the
  // transform coming back is: rotate by MINUS the angle, about the swapped pivot,
  // then translate by the swapped offset. Written out, with S the swap:
  //   S ∘ (rotate θ about c, then translate d) ∘ S
  //     = rotate −θ about Sc, then translate Sd
  const flip = (params.packFrom ?? 'left') === 'left'
  const swapRings = (rs: Pt2[][]): Pt2[][] =>
    flip ? rs.map((r) => r.map(([x, y]) => [y, x] as Pt2)) : rs
  const work: NestItem[] = flip
    ? items.map((i) => ({ id: i.id, rings: swapRings(i.rings), currentAngleDeg: -(i.currentAngleDeg ?? 0) }))
    : items
  const obstacles = flip ? params.obstacles?.map(swapRings) : params.obstacles
  /** The parts as the caller gave them, for parking, which happens in real space. */
  const realRings = new Map(items.map((i) => [i.id, i.rings]))
  const W = flip ? params.sheetHeightMM : params.sheetWidthMM
  const H = flip ? params.sheetWidthMM : params.sheetHeightMM
  const res = params.resolutionMM ?? Math.max(0.2, Math.sqrt((W * H) / 1_000_000))
  const mode: 'evenodd' | 'union' = params.useHoles ? 'evenodd' : 'union'
  // Nothing to nest onto: every item stays exactly where it is, since there is no
  // stock to be in the way of.
  const empty: NestResult = {
    placements: [], unplacedIds: items.map((i) => i.id), resolutionMM: res,
    utilization: 0, usedWidthMM: 0, usedHeightMM: 0,
  }
  if (!(W > 0) || !(H > 0) || items.length === 0) return empty

  const cols = Math.max(1, Math.ceil(W / res))
  const rows = Math.max(1, Math.ceil(H / res))

  // A cell counts as usable only if the WHOLE cell clears the margin — the masks
  // are supersets, so requiring every one of a part's cells to be usable puts the
  // part itself inside the margin.
  const cMin = Math.ceil(params.marginMM / res)
  const cMax = Math.floor((W - params.marginMM) / res) - 1
  const rMin = Math.ceil(params.marginMM / res)
  const rMax = Math.floor((H - params.marginMM) / res) - 1
  if (cMax < cMin || rMax < rMin) return empty

  // A CELL AND A HALF ON TOP OF THE REQUESTED SPACING, and the half is the part
  // that is easy to get wrong. A mask is a superset, so the polygon inside it can
  // sit up to a cell in from the mask's edge — in EACH axis. Two parts meeting
  // face to face therefore lose one cell of the gap, but two meeting corner to
  // corner lose √2 of one, and a single spare cell left a 2 mm spacing coming out
  // at 1.97 mm between diagonal neighbours. Formally: with cells no closer than
  // `rad`, the gap is at least res·√((i−1)²+(j−1)²) over all i²+j² > rad², whose
  // minimum sits on the diagonal at √2·⌊rad/√2⌋ ≈ rad − √2 cells.
  const rad = Math.max(1, Math.ceil(params.spacingMM / res + 1.5))

  // A fresh sheet with everything already spoken for stamped into it. One per
  // pack pass, since a pass fills its own grid up.
  const freshGrid = (): BitGrid => {
    const g = new BitGrid(cols, rows)
    for (const obstacle of obstacles ?? []) {
      const bb = bboxOf(usableRings(obstacle))
      if (!bb) continue
      const col0 = Math.floor(bb.minX / res)
      const row0 = Math.floor(bb.minY / res)
      const local = translateRings(obstacle, -col0 * res, -row0 * res)
      stampDilated(g, rasterizeMask(local, res, mode), col0, row0, rad)
    }
    return g
  }

  // Sorted by area, biggest first — measured on the mask, so it is the area that
  // will actually be packed (holes included or not, per `mode`) rather than the
  // outline's.
  const prepared: PreparedItem[] = work
    .map((item): PreparedItem | null => {
      const bb = bboxOf(usableRings(item.rings))
      if (!bb) return null
      const pivotX = (bb.minX + bb.maxX) / 2
      const pivotY = (bb.minY + bb.maxY) / 2
      // Every orientation this part may be offered, rasterised ONCE. The passes
      // below differ only in which of them they try and in what order, and
      // rasterising is the expensive half of a pass — nine sweeps of a bitmap are
      // nearly free, nine sets of masks are not.
      const turns = anglesFor(params.rotationStepDeg, item.currentAngleDeg ?? 0)
      const candidates = turns.map((t) => maskAtAngle(item.rings, pivotX, pivotY, t, res, mode))
      const base = candidates.find((c) => c.angle === 0) ?? candidates[0]
      return { item, pivotX, pivotY, base, candidates }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => b.base.mask.cells - a.base.mask.cells)

  // ── Filling the stock ──────────────────────────────────────────────────────
  // The one part, over and over, until the sheet refuses one. A REFUSAL IS FINAL
  // here, which is what lets a pass stop at the first one rather than grinding
  // through a cap's worth of hopeless placements: the copies are identical and
  // the grid only ever gains cells, so a copy that will not go on now will not go
  // on after another has been stamped.
  //
  // Two caps, and the first is the real one: every stamp covers at least the
  // part's own cells and no two overlap, so the sheet cannot hold more than its
  // cells divided by the part's. The second is a ceiling on the WORK. A fill runs
  // the whole multi-start — up to four rotation grids × three orientations × two
  // pass types, each of which fills the sheet from scratch — so a 4 mm part on a
  // full sheet is thousands of placements a dozen times over, and a job with four
  // hundred parts on one sheet is not one a router is about to cut anyway.
  const fill = params.fill === true && prepared.length === 1
  const fillCap = fill
    ? Math.min(FILL_LIMIT, Math.max(1, Math.floor((cols * rows) / Math.max(1, prepared[0].base.mask.cells))))
    : 0
  function* toPack(): Generator<PreparedItem> {
    if (!fill) { yield* prepared; return }
    const e = prepared[0]
    for (let n = 0; n < fillCap; n++) yield { ...e, item: { ...e.item, id: `${e.item.id}#${n}` } }
  }

  // ONE PASS PER ORIENTATION PREFERENCE, AND KEEP THE BEST. Bottom-left fill is
  // greedy and never reconsiders, so the whole shape of the result is decided by
  // what it commits to first — see `Orient` for the sheet of tracks that made the
  // point. The masks are already rasterised, so a pass is one sweep of a bitmap.
  /**
   * SHELF PACKING, the other half of the multi-start.
   *
   * Free bottom-left fill will take any gain going, however small, and on parts
   * with an interlocking profile that is its undoing: a model-railway track
   * whose peg fits its neighbour's socket can slide 14 mm back into the column
   * beside it, which the greedy rule duly takes — and the clean column structure
   * that would have held 20 tracks collapses into a jumble that holds 18. The
   * gain is real and local; the cost is global and larger, and greedy packing
   * cannot see it.
   *
   * A shelf pass refuses those. Parts go into LEVELS: every part in a level has
   * its bottom on the same line, a new level opens above the tallest part in the
   * one below, and nothing ever reaches back into a level already closed. For
   * identical parts that is the layout a person draws by hand, and it is what
   * fits the twentieth track.
   *
   * Neither strategy dominates — shelves waste whatever a level's tallest part
   * leaves under the shorter ones, which on mixed parts is a great deal — so
   * this is a pass alongside the others and wins only when it actually places
   * more. Levels here are levels of the PACKING grid, so with `packFrom: 'left'`
   * they are columns up the board.
   */
  const shelfPass = (orient: Orient, gridStep: number): PackOutcome => {
    const grid = freshGrid()
    const placements: NestPlacement[] = []
    const unplaced: PreparedItem[] = []
    let placedCells = 0
    let usedCols = 0
    let usedRows = 0
    // A fill ends one of two ways: the sheet refuses a copy, or the budget runs
    // out. Only the first means the stock is full.
    let refused = false
    let levelY = rMin
    let levelH = 0
    let cursorX = cMin

    for (const entry of toPack()) {
      const { item, pivotX, pivotY } = entry
      const candidates = orderCandidates(entry.candidates, orient, gridStep)
      let best: { cand: Candidate; ox: number; oy: number } | null = null

      // At most one fresh level per part: if it will not go on the level it is
      // offered and will not go on a brand new one either, no later level can
      // help, because a new level is the emptiest the sheet ever gets.
      // Not `attempt < 2 && !best`: naming `best` in a loop condition makes the
      // checker narrow it to null for the whole body, and everything after the
      // loop then types as unreachable.
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const cand of candidates) {
          if (levelY + cand.mask.rows - 1 > rMax) continue
          const oxMax = cMax - cand.mask.cols + 1
          let ox = cursorX
          while (ox <= oxMax) {
            const skip = fitOrSkip(grid, cand.mask, ox, levelY)
            if (skip < 0) break
            ox = Math.max(ox + 1, skip)
          }
          if (ox <= oxMax && (!best || ox < best.ox)) best = { cand, ox, oy: levelY }
        }
        if (best) break
        if (attempt === 0) {
          // A new level clears the tallest part of the one below plus the gap
          // the stamps already carry, so the line is known to be free.
          levelY = levelY + levelH + rad
          levelH = 0
          cursorX = cMin
          if (levelY > rMax) break
        }
      }

      if (!best) { if (fill) { refused = true; break } unplaced.push(entry); continue }
      stampDilated(grid, best.cand.mask, best.ox, best.oy, rad)
      placements.push({
        id: item.id, angleDeg: best.cand.angle, pivotX, pivotY,
        dx: best.ox * res - best.cand.minX,
        dy: best.oy * res - best.cand.minY,
        onStock: true,
      })
      placedCells += best.cand.mask.cells
      usedCols = Math.max(usedCols, best.ox + best.cand.mask.cols)
      usedRows = Math.max(usedRows, best.oy + best.cand.mask.rows)
      cursorX = best.ox + 1
      levelH = Math.max(levelH, best.cand.mask.rows)
    }
    return { placements, unplaced, placedCells, usedCols, usedRows, fillLimited: fill && !refused }
  }

  const packPass = (orient: Orient, gridStep: number): PackOutcome => {
    const grid = freshGrid()
    const placements: NestPlacement[] = []
    const unplaced: PreparedItem[] = []
    let placedCells = 0
    let usedCols = 0
    let usedRows = 0
    // A fill ends one of two ways: the sheet refuses a copy, or the budget runs
    // out. Only the first means the stock is full.
    let refused = false
    for (const entry of toPack()) {
      const { item, pivotX, pivotY } = entry
      const candidates = orderCandidates(entry.candidates, orient, gridStep)

      let best: { cand: Candidate; ox: number; oy: number } | null = null
      for (const cand of candidates) {
        const spot = findSpot(grid, cand.mask, cMin, cMax, rMin, rMax, best)
        if (spot) best = { cand, ox: spot.ox, oy: spot.oy }
      }

      if (!best) { if (fill) { refused = true; break } unplaced.push(entry); continue }
      stampDilated(grid, best.cand.mask, best.ox, best.oy, rad)
      placements.push({
        id: item.id,
        angleDeg: best.cand.angle,
        pivotX,
        pivotY,
        dx: best.ox * res - best.cand.minX,
        dy: best.oy * res - best.cand.minY,
        onStock: true,
      })
      placedCells += best.cand.mask.cells
      usedCols = Math.max(usedCols, best.ox + best.cand.mask.cols)
      usedRows = Math.max(usedRows, best.oy + best.cand.mask.rows)
    }
    return { placements, unplaced, placedCells, usedCols, usedRows, fillLimited: fill && !refused }
  }

  // More parts on the stock wins outright — a part that has to be cut from a
  // second sheet costs more than any amount of tidiness. After that, the pass
  // that reaches LEAST FAR ALONG THE GROWTH DIRECTION wins, which is `usedRows`
  // in packing coordinates whichever edge the caller asked to grow from. That is
  // the offcut: pack from the left and it is the length of board still unused,
  // pack from the bottom and it is the band still free along the top. Ranking by
  // the AREA of the used box instead — which is what this did first — quietly
  // trades that strip away for tidiness in the other axis, where there is nothing
  // to be gained, because the other axis is the width of the board and no part of
  // it is recoverable.
  const orients: Orient[] = prepared.some((e) => e.candidates.length > 1)
    ? ['as-drawn', 'narrow-first', 'wide-first']
    : ['as-drawn']
  const beats = (pass: PackOutcome, champ: PackOutcome | null): boolean =>
    !champ
    || pass.placements.length > champ.placements.length
    || (pass.placements.length === champ.placements.length
        && (pass.usedRows < champ.usedRows
            || (pass.usedRows === champ.usedRows && pass.usedCols < champ.usedCols)))

  let better: PackOutcome | null = null
  for (const gridStep of angleGrids(params.rotationStepDeg)) {
    for (const orient of orients) {
      for (const pass of [packPass(orient, gridStep), shelfPass(orient, gridStep)]) {
        if (beats(pass, better)) better = pass
      }
    }
    // Everything is on the stock, so no coarser grid can place more and the
    // insurance is not worth its time — see `angleGrids`.
    // Never in fill mode: nothing is ever unplaced there (the pass stops instead
    // of parking), so this would break out after the first grid and throw the
    // coarser ones away — and those are the grids that pack MORE copies, for the
    // reason `angleGrids` gives.
    //
    // Copied to a const first: the checker holds `better` at its declared `null`
    // through a test written directly against it here, and then types everything
    // after the loop as unreachable. Reading it into a fresh binding is enough.
    const champ: PackOutcome | null = better
    if (!fill && champ && champ.unplaced.length === 0) break
  }
  const { placements, unplaced, placedCells, usedCols, usedRows, fillLimited } = better!

  // Back into real coordinates — see `flip` at the top for the derivation.
  // `|| 0` is not decoration: negating an angle of zero gives -0, which is a
  // DIFFERENT value to Object.is and so to every strict comparison a caller might
  // make against "no rotation at all".
  const out = placements.map((p): NestPlacement => flip
    ? { ...p, angleDeg: -p.angleDeg || 0, pivotX: p.pivotY, pivotY: p.pivotX, dx: p.dy, dy: p.dx }
    : p)

  // ── Parking ────────────────────────────────────────────────────────────────
  // Whatever would not fit goes in rows off the right-hand END of the stock, in
  // the order it was tried. Off the stock rather than tucked into a corner of it,
  // because the one thing the user has to be able to see is that these parts are
  // not in the job; laid out rather than piled up, so they can be dealt with one
  // at a time; and in REAL coordinates rather than packed ones, so they land in
  // the same place whichever edge the nest grew from.
  const realW = params.sheetWidthMM
  const gutter = Math.max(params.marginMM, 10)
  const gap = Math.max(params.spacingMM, 2)
  let px = realW + gutter
  let py = 0
  let shelf = 0
  for (const entry of unplaced) {
    const rings = realRings.get(entry.item.id)
    if (!rings) continue
    // TURNED THE WAY THE NEST WOULD HAVE PREFERRED, not left as it lies. With
    // rotation set to None that preference IS "back to as drawn", and a parked
    // part still standing at some old nest's 90° while every other part went home
    // would be the odd one out for no reason the user could see. It also fixes
    // the offsets: parking used to state no turn while measuring from a turned
    // part's bounding box, which put it in the wrong place whenever the two
    // disagreed.
    const angleDeg = flip ? -entry.base.angle || 0 : entry.base.angle
    const pivotX = flip ? entry.pivotY : entry.pivotX
    const pivotY = flip ? entry.pivotX : entry.pivotY
    const bb = bboxOf(usableRings(rotateRings(rings, pivotX, pivotY, angleDeg)))
    if (!bb) continue
    const w = bb.maxX - bb.minX
    const h = bb.maxY - bb.minY
    if (px > realW + gutter && px + w > realW + gutter + realW) { px = realW + gutter; py += shelf + gap; shelf = 0 }
    out.push({ id: entry.item.id, angleDeg, pivotX, pivotY, dx: px - bb.minX, dy: py - bb.minY, onStock: false })
    px += w + gap
    shelf = Math.max(shelf, h)
  }

  return {
    placements: out,
    unplacedIds: unplaced.map((u) => u.item.id),
    resolutionMM: res,
    utilization: (placedCells * res * res) / (W * H),  // on-stock parts only
    usedWidthMM: flip ? usedRows * res : usedCols * res,
    usedHeightMM: flip ? usedCols * res : usedRows * res,
    ...(fillLimited ? { fillLimited: true } : {}),
  }
}

function maskAtAngle(
  rings: Pt2[][], pivotX: number, pivotY: number, turn: Turn, res: number, mode: 'evenodd' | 'union',
): Candidate {
  const rot = rotateRings(rings, pivotX, pivotY, turn.delta)
  const bb = bboxOf(usableRings(rot))!
  const local = translateRings(rot, -bb.minX, -bb.minY)
  return { mask: rasterizeMask(local, res, mode), angle: turn.delta, absAngle: turn.absolute, minX: bb.minX, minY: bb.minY }
}

/**
 * The lowest-then-leftmost position this mask fits, or null.
 *
 * `beat` is the best position found so far for a DIFFERENT orientation of the
 * same part: rows above it cannot improve on it, so the sweep stops there.
 * Trying four orientations therefore costs barely more than trying one, once the
 * first has landed low.
 *
 * A COLUMN-MAJOR TWIN OF THIS WAS TRIED AND REMOVED. The idea was that sweeping
 * left-to-right leaves its slack down the side rather than along the top, and
 * that one of the two orders would be a part better on any given sheet. It never
 * was: over identical tracks, irregular blobs, mixed oblongs and long bars it
 * never once placed more parts than the row sweep, and it cost about half the
 * total runtime — because the skip hint below is an x hint, which a sweep moving
 * in y cannot use, so it tested every cell one at a time. What actually finds the
 * layouts a row sweep misses is offering the part the other way UP (see `Orient`),
 * which is cheap and does win.
 */
function findSpot(
  grid: BitGrid, mask: Mask,
  cMin: number, cMax: number, rMin: number, rMax: number,
  beat: { ox: number; oy: number } | null,
): { ox: number; oy: number } | null {
  const oxMax = cMax - mask.cols + 1
  const oyMax = rMax - mask.rows + 1
  if (oxMax < cMin || oyMax < rMin) return null
  const oyLimit = beat ? Math.min(oyMax, beat.oy) : oyMax
  for (let oy = rMin; oy <= oyLimit; oy++) {
    const oxLimit = beat && oy === beat.oy ? Math.min(oxMax, beat.ox - 1) : oxMax
    let ox = cMin
    while (ox <= oxLimit) {
      const skip = fitOrSkip(grid, mask, ox, oy)
      if (skip < 0) return { ox, oy }
      ox = Math.max(ox + 1, skip)
    }
  }
  return null
}

// ─── Grouping paths into nestable items ───────────────────────────────────────

/** The fields of ImportedPath that decide what moves with what. */
export interface NestablePath {
  id: string
  d: string
  groupId?: string
  userGroups?: string[]
  shapePart?: string
}

export interface NestGroup {
  /** Every path that moves as this one item. */
  ids: string[]
  rings: Pt2[][]
}

type Box = NonNullable<ReturnType<typeof bboxOf>>
interface Member { id: string; rings: Pt2[][]; box: Box | null }

const toGroup = (ms: Member[]): NestGroup => ({
  ids: ms.map((m) => m.id),
  rings: ms.flatMap((m) => m.rings),
})

/**
 * Split one shape's parts into the separate PIECES OF WOOD they are cut from.
 *
 * A shape's parts are not all one blank. A gear draws its lantern pinion's cheek
 * clear of the wheel along +X, and an escapement draws its pallets above the
 * escape wheel: those are two pieces in each case, and nesting them as one wastes
 * the whole rectangle between them. The gear's own teeth, spokes, bore and
 * marking, by contrast, are one disc and must not be prised apart.
 *
 * A `groupId` IS NOT ONE SHAPE. `duplicateSelected` remaps `userGroups` but
 * carries `groupId` straight through, so nineteen tracks copied from four
 * originals arrive here as four groups of up to eighteen paths — nineteen
 * independent pieces wearing four labels. Nothing in the data says which body
 * belongs with which grooves, so the geometry has to.
 *
 * WHICH IS WHY THIS IS A RASTER AND NOT A BOUNDING-BOX TEST. Boxes were the first
 * attempt and they are far too eager: a track is a long curve whose box is mostly
 * empty, so two tracks lying beside each other on the drawing cross boxes without
 * coming near each other, and clustering welded them — transitively, until four
 * tracks were one rigid blob too big to place at all. Cells are the real
 * footprint. Two parts join when they actually share one, which for a track's
 * body, grooves and treads they do (the cuts are IN the body) and for two
 * separate tracks they do not. Open cut lines have no interior for a containment
 * test to find, but they rasterize exactly like anything else, which is what made
 * boxes look necessary in the first place.
 */
function splitIntoPieces(ms: Member[]): Member[][] {
  const parent = ms.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const boxed = ms.filter((m) => m.box)
  if (ms.length > 1 && boxed.length > 0) {
    const minX = Math.min(...boxed.map((m) => m.box!.minX))
    const minY = Math.min(...boxed.map((m) => m.box!.minY))
    const w = Math.max(Math.max(...boxed.map((m) => m.box!.maxX)) - minX, 1e-6)
    const h = Math.max(Math.max(...boxed.map((m) => m.box!.maxY)) - minY, 1e-6)
    const res = Math.max(0.2, Math.sqrt((w * h) / 1_000_000))
    const cols = Math.max(1, Math.ceil(w / res) + 1)
    const rows = Math.max(1, Math.ceil(h / res) + 1)
    // First part to claim a cell owns it; every later claimant joins its piece.
    const owner = new Int32Array(cols * rows).fill(-1)
    ms.forEach((m, i) => {
      if (!m.box) return
      const col0 = Math.floor((m.box.minX - minX) / res)
      const row0 = Math.floor((m.box.minY - minY) / res)
      const mask = rasterizeMask(
        translateRings(m.rings, -(minX + col0 * res), -(minY + row0 * res)), res, 'union',
      )
      for (let r = 0; r < mask.rows; r++) {
        const gr = row0 + r
        if (gr < 0 || gr >= rows) continue
        const row = mask.runs[r]
        for (let k = 0; k < row.length; k += 2) {
          const c1 = Math.min(cols - 1, col0 + row[k + 1])
          for (let c = Math.max(0, col0 + row[k]); c <= c1; c++) {
            const idx = gr * cols + c
            const o = owner[idx]
            if (o < 0) owner[idx] = i
            else if (find(o) !== find(i)) parent[find(o)] = find(i)
          }
        }
      }
    })
  }
  const byRoot = new Map<number, Member[]>()
  ms.forEach((m, i) => {
    const r = find(i)
    const list = byRoot.get(r)
    if (list) list.push(m); else byRoot.set(r, [m])
  })
  return [...byRoot.values()]
}

/**
 * Work out which selected paths have to travel together.
 *
 * Three separate reasons, and all three have bitten:
 *
 *  - A USER GROUP is one object to the user, so it is one part here, and it is
 *    never split: the user has said in as many words that these things go
 *    together.
 *  - A MULTI-PART SHAPE (`shapePart`) is one shape but not necessarily one PIECE
 *    OF WOOD, and that distinction is the whole of the second pass below. Its
 *    parts share a `groupId` — which on its own is no guide at all, since an SVG
 *    import shares one too and a sheet of imported parts is exactly what wants
 *    nesting apart.
 *  - CONTAINMENT. A plate and its bolt holes are separate paths with nothing
 *    tying them together but geometry, and nesting the holes as parts in their own
 *    right would scatter them across the stock. So a path lying inside another's
 *    material rides with it — tested from `interiorPoint`, never a centroid, which
 *    on any concave outline lands outside the shape (see /CLAUDE.md).
 *
 * A path inside another's HOLE is deliberately not caught: even-odd puts it
 * outside the material, and a part someone dropped into a ring's middle is a part,
 * not a feature of the ring.
 */
export function groupPathsForNesting(paths: NestablePath[], tolerance = 0.1): NestGroup[] {
  const members: Member[] = paths.map((p) => {
    const rings = usableRings(flattenPath(p.d, tolerance))
    return { id: p.id, rings, box: bboxOf(rings) }
  })

  const keyed = new Map<string, { members: Member[]; splittable: boolean }>()
  members.forEach((m, i) => {
    const p = paths[i]
    const shapeKey = p.shapePart !== undefined ? p.groupId : undefined
    // A user group wins over the shape's own key, and is never split — the user
    // has said in as many words that these things go together.
    const key = p.userGroups?.[0] ?? shapeKey ?? p.id
    let entry = keyed.get(key)
    if (!entry) {
      entry = { members: [], splittable: !p.userGroups?.length && shapeKey !== undefined }
      keyed.set(key, entry)
    }
    entry.members.push(m)
  })

  const groups: NestGroup[] = [...keyed.values()].flatMap((e) =>
    (e.splittable ? splitIntoPieces(e.members) : [e.members]).map(toGroup))
  const probes = groups.map((g) => interiorPoint(g.rings))
  const areas = groups.map((g) => {
    const bb = bboxOf(g.rings)
    return bb ? (bb.maxX - bb.minX) * (bb.maxY - bb.minY) : 0
  })

  // Each group joins the SMALLEST group that contains it. For plain nesting the
  // choice does not show — a chain collapses to its root below either way — but
  // it decides the one case that is genuinely ambiguous: a path lying inside two
  // containers that do not contain EACH OTHER goes with the tighter fit, which is
  // the one it was almost certainly drawn as a feature of.
  const parent = groups.map((_, i) => i)
  for (let i = 0; i < groups.length; i++) {
    const probe = probes[i]
    if (!probe) continue
    let bestJ = -1
    for (let j = 0; j < groups.length; j++) {
      if (j === i || areas[j] <= areas[i]) continue
      if (!insideEvenOdd(probe[0], probe[1], groups[j].rings)) continue
      if (bestJ < 0 || areas[j] < areas[bestJ]) bestJ = j
    }
    if (bestJ >= 0) parent[i] = bestJ
  }
  const rootOf = (i: number): number => {
    let r = i
    const seen = new Set<number>()
    while (parent[r] !== r && !seen.has(r)) { seen.add(r); r = parent[r] }
    return r
  }

  const merged = new Map<number, NestGroup>()
  for (let i = 0; i < groups.length; i++) {
    const root = rootOf(i)
    let out = merged.get(root)
    if (!out) { out = { ids: [], rings: [] }; merged.set(root, out) }
    out.ids.push(...groups[i].ids)
    out.rings.push(...groups[i].rings)
  }
  return [...merged.values()]
}

/** Inside the material of a ring set, by the even-odd rule SVG and CAM both fill with. */
function insideEvenOdd(x: number, y: number, rings: Pt2[][]): boolean {
  let crossings = 0
  const xs: number[] = []
  for (const ring of rings) {
    if (ring.length < 3) continue
    xs.length = 0
    ringCrossings(ring, y, xs)
    for (const cx of xs) if (cx > x) crossings++
  }
  return crossings % 2 === 1
}
