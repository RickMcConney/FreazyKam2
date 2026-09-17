// Adaptive2 — fast constant-engagement (adaptive) pocket clearing.
//
// A from-scratch replacement for the Adaptive2d port in ./adaptiveClearing.ts. The old engine
// maintains the cleared region as a Clipper polygon, so every engagement probe, lead path and
// link check is a boolean/offset op against geometry whose vertex count grows with everything
// cut so far — that is the measured superlinear blowup on large pockets.
//
// This engine keeps the cleared region as a fixed-resolution occupancy grid instead, so every
// query is O(local) and the total cost is linear in removed area:
//
//   engagement(p)   → sample the tool circumference against the grid (count uncut samples)
//   commit a step   → stamp the swept tool disk into the grid
//   link / re-seed  → exact distance transforms over the grid (O(cells), run rarely)
//
// The toolpath is GROWN, not offset: from a helix bore at the deepest point of the pocket the
// tool advances in small steps, and each step picks the turn angle whose circumferential
// engagement is closest to the target. Holding that equality makes the path follow the stock
// frontier outward as a spiral with constant radial engagement; when a corner pinches the
// engagement upward the best candidate turns away through cleared stock and re-approaches —
// the classic adaptive trochoidal corner loops emerge from the steering rule by themselves.
// When no stock is in sampling reach the engine floods a BFS "guide field" (distance to the
// nearest remaining stock, routed through the machinable region so it bends around islands)
// and descends it across the cleared floor — a stay-down link. It lifts and re-seeds with a
// fresh bore only when remaining stock is genuinely unreachable from the current position.
//
// All geometry in CNC mm. The only polygon op is one compound Clipper offset at setup (the
// tool-centre allowed region); islands are handled there and need no special cases afterward.

import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { signedArea, douglasPeucker, type Pt2 } from './pathFlattener'
import { ptSegDistSq } from './geom'

interface Adaptive2Move {
  // 'cut' = engagement-controlled material removal; 'link' = stay-down traverse over
  // already-cleared floor (verified ~zero engagement while walking it).
  kind: 'cut' | 'link'
  pts: Pt2[]
  // Feed multiplier for a 'cut' move. 1 for ordinary engagement-controlled cutting;
  // below 1 where the geometry forced a bite wider than the target (a channel narrower
  // than the tool can trochoid in), scaled so the chip load is the same as an on-target
  // pass. Undefined ⇒ full feed.
  feedScale?: number
}

export interface Adaptive2Region {
  helixCenter: Pt2
  /** Tool-centre radius of the entry bore; 0 ⇒ plunge entry at the first cut point. */
  helixRadiusMM: number
  moves: Adaptive2Move[]
}

export type Adaptive2Progress = (frac: number, label?: string) => void

export interface Adaptive2Params {
  toolDiameterMM: number
  /** Target radial engagement (the UI engagement % × tool diameter). */
  stepoverMM: number
  /** Spiral winding: CCW = conventional for an inside pocket (codebase convention). */
  wantCCW: boolean
  /** Helix-bore entries (the rampIn checkbox); false = straight plunge at each seed. */
  helixEntry: boolean
  /** Optional 0->1 progress; driven by how much of the owed stock is gone. */
  onProgress?: Adaptive2Progress
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// ─── Rasterization ───────────────────────────────────────────────────────────────

// Even-odd scanline fill of a polygon set (outer boundaries + holes in one list).
function fillEvenOdd(polys: Pt2[][], w: number, h: number, x0: number, y0: number, cell: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const xs: number[] = []
  for (let iy = 0; iy < h; iy++) {
    const yc = y0 + (iy + 0.5) * cell
    xs.length = 0
    for (const poly of polys) {
      const n = poly.length
      for (let i = 0; i < n; i++) {
        const ax = poly[i][0], ay = poly[i][1]
        const bx = poly[(i + 1) % n][0], by = poly[(i + 1) % n][1]
        if ((ay <= yc) !== (by <= yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay))
      }
    }
    if (xs.length < 2) continue
    xs.sort((a, b) => a - b)
    const row = iy * w
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i0 = Math.ceil((xs[k] - x0) / cell - 0.5)
      let i1 = Math.floor((xs[k + 1] - x0) / cell - 0.5)
      if (i0 < 0) i0 = 0
      if (i1 > w - 1) i1 = w - 1
      for (let ix = i0; ix <= i1; ix++) out[row + ix] = 1
    }
  }
  return out
}

// ─── Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) ────────────

const EDT_INF = 1e10

function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -EDT_INF
  z[1] = EDT_INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = EDT_INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/** Squared distance (in cells) from every cell to the nearest cell where isFeature(i) is true. */
function edtSq(w: number, h: number, isFeature: (i: number) => boolean): Float64Array {
  const m = Math.max(w, h)
  const f = new Float64Array(m)
  const d = new Float64Array(m)
  const v = new Int32Array(m)
  const z = new Float64Array(m + 1)
  const out = new Float64Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = isFeature(y * w + x) ? 0 : EDT_INF
    dt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) f[x] = out[row + x]
    dt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) out[row + x] = d[x]
  }
  return out
}

// ─── Path fairing helpers ────────────────────────────────────────────────────────

/** Resample a polyline at a uniform arc-length interval, endpoints preserved. Fairing
 *  filters assume even spacing — the umbrella operator on unevenly spaced samples is
 *  biased toward the longer side, which is exactly the noise it is meant to remove. */
function resampleUniform(pts: Pt2[], step: number): Pt2[] {
  if (pts.length < 2 || step <= 0) return pts
  const out: Pt2[] = [pts[0]]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1]
    const dx = pts[i][0] - ax, dy = pts[i][1] - ay
    const d = Math.hypot(dx, dy)
    if (d < 1e-12) continue
    let t = (step - carry) / d
    while (t <= 1) {
      out.push([ax + dx * t, ay + dy * t])
      t += step / d
    }
    carry = (carry + d) % step
  }
  const last = pts[pts.length - 1]
  const tail = out[out.length - 1]
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.25) out.push(last)
  else out[out.length - 1] = last
  return out
}

/** Thin a faired polyline, bounding BOTH the chord deviation and the DIRECTION CHANGE at
 *  each kept vertex. Douglas-Peucker bounds deviation only; on a gently curving path that
 *  lets it emit very long chords, and the whole accumulated turn of the arc then lands on
 *  one vertex — the tool decelerates into every one of those. */
function thinByChordAndTurn(pts: Pt2[], tolMM: number, maxTurnRad: number): Pt2[] {
  const n = pts.length
  if (n <= 2) return pts
  const out: Pt2[] = [pts[0]]
  let anchor = 0
  while (anchor < n - 1) {
    let best = anchor + 1
    for (let j = anchor + 2; j < n; j++) {
      const ax = pts[anchor][0], ay = pts[anchor][1]
      const bx = pts[j][0], by = pts[j][1]
      let dev = 0
      for (let k = anchor + 1; k < j; k++) {
        dev = Math.max(dev, Math.sqrt(ptSegDistSq(pts[k][0], pts[k][1], ax, ay, bx, by)))
        if (dev > tolMM) break
      }
      if (dev > tolMM) break
      if (out.length >= 2) {
        const px = out[out.length - 1][0] - out[out.length - 2][0]
        const py = out[out.length - 1][1] - out[out.length - 2][1]
        const l1 = Math.hypot(px, py), l2 = Math.hypot(bx - ax, by - ay)
        if (l1 > 1e-9 && l2 > 1e-9) {
          const c = clamp((px * (bx - ax) + py * (by - ay)) / (l1 * l2), -1, 1)
          if (Math.acos(c) > maxTurnRad) break
        }
      }
      best = j
    }
    out.push(pts[best])
    anchor = best
  }
  return out
}

// ─── The engine ──────────────────────────────────────────────────────────────────

export function computeAdaptive2Plan(boundary: Pt2[], islands: Pt2[][], prm: Adaptive2Params): Adaptive2Region[] {
  const R = prm.toolDiameterMM / 2
  if (R <= 0 || boundary.length < 3) return []

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of boundary) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  // Grid resolution: fine enough to steer by (R/10), coarsened if a huge pocket would
  // otherwise blow past the cell budget.
  let cell = clamp(R / 10, 0.08, 0.35)
  let w = 0, h = 0, x0 = 0, y0 = 0
  for (;;) {
    x0 = minX - 2 * cell
    y0 = minY - 2 * cell
    w = Math.ceil((maxX - minX + 4 * cell) / cell)
    h = Math.ceil((maxY - minY + 4 * cell) / cell)
    if (w * h <= 6e6) break
    cell *= 1.4
  }
  const nCells = w * h

  // Bookkeeping radius: a hair under the true tool radius so circumference samples always
  // land inside cells the stamp marked. Stamping, sampling and the bore all use rb, so the
  // model is self-consistent; the real tool over-covers the grid by ~0.75 cell, which is the
  // safe direction (never reports cut stock that the tool didn't actually reach).
  const rb = R - 0.75 * cell
  if (rb <= cell) return []   // tool of the order of grid resolution — nothing sensible to do

  // Tool-centre allowed region: boundary ⊖ R, islands ⊕ R — the single polygon op. The
  // extra half cell covers raster quantization (a cell centre can sit up to ~0.7 cell
  // inside the polygon while its true position is outside), so no committed step can
  // stray past the real inset wall; the finishing pass owns that margin anyway.
  const toCP = (pts: Pt2[], ccw: boolean) => {
    const wound = (signedArea(pts) >= 0) === ccw ? pts : [...pts].reverse()
    return wound.map(([x, y]) => ({ x, y }))
  }
  const machPolys = inflatePathsD(
    [toCP(boundary, true), ...islands.map(i => toCP(i, false))],
    -(R + 0.5 * cell), JoinType.Round, EndType.Polygon, 4, 6,
  ).map(r => r.map(({ x, y }) => [x, y] as Pt2)).filter(r => r.length >= 3)
  if (machPolys.length === 0) return []

  const mach = fillEvenOdd(machPolys, w, h, x0, y0, cell)
  const region = fillEvenOdd([boundary, ...islands], w, h, x0, y0, cell)

  // cleared[i] = 1 ⇒ no stock at cell i (outside the pocket, island, or already cut).
  // Pre-clearing everything outside the region makes walls invisible to the engagement
  // probe — the tool-centre mask (mach) is what actually keeps the tool off them.
  const cleared = new Uint8Array(nCells)
  for (let i = 0; i < nCells; i++) if (!region[i]) cleared[i] = 1

  // Drop stock no tool position can ever touch (sharp concave corner fillets) so it
  // neither registers as engagement nor keeps the march hunting for it.
  const dMach = edtSq(w, h, i => mach[i] !== 0)
  const reachSq = (rb / cell) * (rb / cell)
  for (let i = 0; i < nCells; i++) {
    if (!cleared[i] && dMach[i] > reachSq) cleared[i] = 1
  }

  // Distance from every cell to the nearest non-machinable cell — helix headroom at seeds.
  const dWall = edtSq(w, h, i => mach[i] === 0)

  const s = clamp(prm.stepoverMM, cell, 1.9 * rb)
  // Target fraction of the tool circumference in stock. For a straight pass at radial
  // stepover s the engaged ARC is 2·acos(1 − s/rb) — engagement is symmetric about the cut
  // direction, so it spans acos(1 − s/rb) either side. `engagement()` below measures the
  // full circumference, so the target is that arc over 2π, i.e. acos(1 − s/rb)/π.
  // (Dividing by 2π halves the arc, which made the marcher aim at half the requested
  // engagement — at 40% stepover it steered to ~0.7 mm of cut on a 6 mm tool.)
  const ft = Math.acos(clamp(1 - s / rb, -1, 1)) / Math.PI

  // band[i] = 1 ⇒ wall sliver the finishing pass takes: stock at most ONE STEPOVER deep
  // along the walls/islands, so the finishing bite never exceeds the target engagement.
  // Band stock stays fully visible to the engagement probe — the tool really cuts it in
  // passing and the steering must respect it (blinding the probe to it kills the
  // trochoids and overloads the cutter) — but it is never a GOAL: seeds, guide-field
  // targets and the completion count all ignore it, so the march never travels back
  // across the pocket just to shave a wall crumb the finishing pass erases anyway.
  const band = new Uint8Array(nCells)
  const dEdge = edtSq(w, h, i => region[i] === 0)
  const bandCells = Math.min(s, rb) / cell
  const bandSq = bandCells * bandCells
  for (let i = 0; i < nCells; i++) {
    if (region[i] && dEdge[i] <= bandSq) band[i] = 1
  }

  // uncut counts OWED stock only (real and not band) — the marcher's goal metric.
  let uncut = 0
  for (let i = 0; i < nCells; i++) if (!cleared[i] && !band[i]) uncut++
  if (uncut === 0) return []
  // Owed stock remaining is the honest progress signal for a march: it falls
  // monotonically and reaches zero exactly when the work is done.
  const uncut0 = uncut
  const tellProgress = () => prm.onProgress?.(1 - uncut / uncut0, 'Clearing')

  // Cutting steps prefer to keep the tool edge OUT of the finishing band: without this
  // the final wall lap pins against the machinable limit and swallows leftover strip +
  // band in one bite (~2 stepovers ≈ 80–95% width — the frontier-collision spikes). The
  // penalty is soft: in corridors narrower than the threshold every candidate carries it
  // equally, so geometric slots are still cut.
  const bandKeep = (R + Math.min(s, rb)) / cell
  const bandKeepSq = bandKeep * bandKeep
  const inBandZone = (x: number, y: number): boolean => {
    const ix = Math.floor((x - x0) / cell)
    const iy = Math.floor((y - y0) / cell)
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return true
    return dEdge[iy * w + ix] < bandKeepSq
  }

  const K = 96
  const cosT = new Float64Array(K)
  const sinT = new Float64Array(K)
  for (let k = 0; k < K; k++) {
    cosT[k] = Math.cos((2 * Math.PI * k) / K) * rb
    sinT[k] = Math.sin((2 * Math.PI * k) / K) * rb
  }

  const clearedAt = (x: number, y: number): boolean => {
    const ix = Math.floor((x - x0) / cell)
    const iy = Math.floor((y - y0) / cell)
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return true
    return cleared[iy * w + ix] !== 0
  }
  const machAt = (x: number, y: number): boolean => {
    const ix = Math.floor((x - x0) / cell)
    const iy = Math.floor((y - y0) / cell)
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return false
    return mach[iy * w + ix] !== 0
  }
  const engagement = (x: number, y: number): number => {
    let c = 0
    for (let k = 0; k < K; k++) if (!clearedAt(x + cosT[k], y + sinT[k])) c++
    return c / K
  }

  // Returns how many cells this sweep cleared — `n` = any material (0 ⇒ pure air, the
  // path-straightener may reroute it), `owed` = non-band material (goal progress).
  const stampSeg = (ax: number, ay: number, bx: number, by: number, r: number): { n: number; owed: number } => {
    const r2 = r * r
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / cell))
    const ix1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + r - x0) / cell))
    const iy0 = Math.max(0, Math.floor((Math.min(ay, by) - r - y0) / cell))
    const iy1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + r - y0) / cell))
    let n = 0
    let owed = 0
    for (let iy = iy0; iy <= iy1; iy++) {
      const py = y0 + (iy + 0.5) * cell
      const row = iy * w
      for (let ix = ix0; ix <= ix1; ix++) {
        if (cleared[row + ix]) continue
        const px = x0 + (ix + 0.5) * cell
        if (ptSegDistSq(px, py, ax, ay, bx, by) <= r2) {
          cleared[row + ix] = 1
          if (!band[row + ix]) { uncut--; owed++ }
          n++
        }
      }
    }
    return { n, owed }
  }
  const stampDisk = (cx: number, cy: number, r: number): void => { stampSeg(cx, cy, cx, cy, r) }

  // Guide field: BFS distance (in cells, over machinable cells only) to the nearest
  // machinable cell that still touches stock. Descending it walks the tool across the
  // cleared floor to the next work, bending around islands automatically — the stay-down
  // alternative to lifting. Rebuilt on demand; allocated lazily.
  let guide: Int32Array | null = null
  let guideQueue: Uint32Array | null = null
  const buildGuide = (): boolean => {
    if (!guide) { guide = new Int32Array(nCells); guideQueue = new Uint32Array(nCells) }
    guide.fill(-1)
    const q = guideQueue!
    let qt = 0
    // Sources: machinable cells holding OWED stock (band crumbs are not goals). The
    // flood then expands ONLY across the cleared floor — cells the tool can actually
    // slide over — so descending the field never demands plowing through solid stock.
    for (let i = 0; i < nCells; i++) {
      if (mach[i] && cleared[i] === 0 && band[i] === 0) { guide[i] = 0; q[qt++] = i }
    }
    if (qt === 0) return false
    let qh = 0
    while (qh < qt) {
      const c = q[qh++]
      const d = guide[c] + 1
      const x = c % w
      if (x > 0 && mach[c - 1] && cleared[c - 1] && guide[c - 1] < 0) { guide[c - 1] = d; q[qt++] = c - 1 }
      if (x < w - 1 && mach[c + 1] && cleared[c + 1] && guide[c + 1] < 0) { guide[c + 1] = d; q[qt++] = c + 1 }
      if (c >= w && mach[c - w] && cleared[c - w] && guide[c - w] < 0) { guide[c - w] = d; q[qt++] = c - w }
      if (c + w < nCells && mach[c + w] && cleared[c + w] && guide[c + w] < 0) { guide[c + w] = d; q[qt++] = c + w }
    }
    return true
  }
  const guideAt = (x: number, y: number): number => {
    const ix = Math.floor((x - x0) / cell)
    const iy = Math.floor((y - y0) / cell)
    if (!guide || ix < 0 || iy < 0 || ix >= w || iy >= h) return Infinity
    const g = guide[iy * w + ix]
    return g < 0 ? Infinity : g
  }

  // ── Marching ──────────────────────────────────────────────────────────────────

  // Step length, and the max turn per step that goes with it.
  //
  // The step is CONSTANT. It used to grow with distance to the nearest wall, on the theory
  // that open field is cheap to cross in bigger strides — but that idea failed twice and
  // the measurement says it never paid. Holding the turn limit fixed while the step grew
  // tripled the minimum turn radius, so the tool could no longer retreat through cleared
  // stock when engagement rose and just plowed on (162 mm at 92% of the tool diameter).
  // Deriving the turn limit from the step instead fixed that but let a long step carry a
  // 107 deg turn allowance, and the march wandered — the "meandering" on a 660x940 pocket.
  // And it was not even faster: the wandering path was twice as long, so the big pocket
  // took 70 s instead of 22 s. A constant-engagement march is always at the stock frontier
  // while cutting, so it always needs the fine step; the way to save work in open field is
  // not to steer there at all (see the hybrid note in scratch/pocket.md).
  const dsBase = Math.max(2 * cell, R / 5)
  // Turn per step is bounded BOTH ways. Below, by the minimum loop radius the trochoidal
  // retreat needs (0.45 R). Above, by an absolute angle, so that on a large pocket — where
  // the cell budget coarsens the grid and with it the step — a single step can still only
  // change heading by a modest amount. Without the ceiling the candidate turns spread wide
  // enough that consecutive steps swing about and the path stops reading as a spiral.
  const MAX_TURN_PER_STEP = 0.45
  const A = Math.min(dsBase / (0.45 * R), MAX_TURN_PER_STEP)
  // Target new stock per step: a pass at the requested radial stepover sweeps s·ds.
  // Hard chip-load governor: no single step may sweep more than 1.3× that.
  const areaTargetPerLen = s
  const OVERLOAD = 1.3
  const dirSign = prm.wantCCW ? 1 : -1
  // Candidate turns, as fractions of A. The score prefers engagement closest to target,
  // mildly prefers going straight (smoothness), and nudges toward the requested winding
  // direction so re-engagements settle on the climb/conventional side consistently.
  const CAND = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]
  const idleLimit = Math.ceil((2 * Math.PI * 0.45 * R) / dsBase) + 4

  let px = 0, py = 0, theta = 0               // march state

  // Read-only preview of a step's newly-swept stock area (mm²): uncut cells inside the
  // leading crescent (within rb of the step end, beyond rb of the start).
  const previewStepArea = (ax: number, ay: number, bx: number, by: number): number => {
    const r2 = rb * rb
    const ix0 = Math.max(0, Math.floor((bx - rb - x0) / cell))
    const ix1 = Math.min(w - 1, Math.floor((bx + rb - x0) / cell))
    const iy0 = Math.max(0, Math.floor((by - rb - y0) / cell))
    const iy1 = Math.min(h - 1, Math.floor((by + rb - y0) / cell))
    let n = 0
    for (let iy = iy0; iy <= iy1; iy++) {
      const pyc = y0 + (iy + 0.5) * cell
      const row = iy * w
      for (let ix = ix0; ix <= ix1; ix++) {
        if (cleared[row + ix]) continue
        const pxc = x0 + (ix + 0.5) * cell
        const dbx = pxc - bx, dby = pyc - by
        if (dbx * dbx + dby * dby > r2) continue
        const dax = pxc - ax, day = pyc - ay
        if (dax * dax + day * day <= r2) continue
        n++
      }
    }
    return n * cell * cell
  }

  // How many occupancy-ranked candidates get the (more expensive, exact) area check.
  const AREA_SHORTLIST = 3

  const steerStep = (): { cut: number; owed: number; feedScale: number } | null => {
    const ds = dsBase
    const areaTarget = areaTargetPerLen * ds
    const maxStepArea = OVERLOAD * areaTarget

    // Two-stage ranking. Circumference occupancy is cheap (96 samples) but it is only a
    // proxy: it is measured on the bookkeeping circle rb, which is a hair under the real
    // tool, and it misreads pivots around convex corners, where the outer flank sweeps a
    // wide fan at on-target occupancy. Steering on it alone ran the MEDIAN radial bite
    // ~20% over the requested stepover. So occupancy only shortlists; the winner is
    // picked by the ACTUAL swept area, which is exactly the quantity the stepover asks
    // for and is curvature-correct by construction.
    const scored: { c: number; score: number }[] = []
    for (let i = 0; i < CAND.length; i++) {
      const c = CAND[i]
      const th = theta + c * A
      const nx = px + Math.cos(th) * ds
      const ny = py + Math.sin(th) * ds
      if (!machAt(nx, ny)) continue
      const e = engagement(nx, ny)
      const score = Math.abs(e - ft) + 0.02 * Math.abs(c) - 0.012 * c * dirSign
        + (inBandZone(nx, ny) ? 0.6 : 0)
      scored.push({ c, score })
    }
    if (scored.length === 0) return null
    scored.sort((a, b) => a.score - b.score)

    let bestDelta = NaN
    let bestArea = 0
    let bestScore = Infinity
    const consider = (c: number) => {
      const th = theta + c * A
      const nx = px + Math.cos(th) * ds
      const ny = py + Math.sin(th) * ds
      const a = previewStepArea(px, py, nx, ny)
      // Under the cap: closest to target wins, with the same mild straightness bias.
      // Over it: strictly worse than any legal candidate, ranked by how far over.
      const sc = a > maxStepArea ? 1000 + a : Math.abs(a - areaTarget) / areaTarget + 0.05 * Math.abs(c)
      if (sc < bestScore) { bestScore = sc; bestDelta = c * A; bestArea = a }
    }
    for (let i = 0; i < Math.min(AREA_SHORTLIST, scored.length); i++) consider(scored[i].c)
    // Every shortlisted candidate overloads: widen the search to all of them before
    // accepting an over-target bite — that is the trochoidal retreat through cleared
    // stock, and it is only unavailable in a true geometric slot.
    if (bestScore >= 1000) {
      for (let i = AREA_SHORTLIST; i < scored.length; i++) consider(scored[i].c)
    }
    if (Number.isNaN(bestDelta)) return null

    theta += bestDelta
    const nx = px + Math.cos(theta) * ds
    const ny = py + Math.sin(theta) * ds
    const st = stampSeg(px, py, nx, ny, rb)
    px = nx
    py = ny
    // A bite the geometry forced over the cap gets a proportional feed cut, so the chip
    // load matches an on-target pass instead of silently spiking. Quantized so a channel
    // doesn't fragment into dozens of feed changes.
    const over = bestArea > maxStepArea ? bestArea / areaTarget : 1
    const feedScale = over > 1 ? Math.max(0.3, Math.round((1 / over) * 4) / 4) : 1
    return { cut: st.n, owed: st.owed, feedScale }
  }

  // The turn-per-step limit keeps the path smooth, but it can nose the march into a
  // dead-end (every candidate off the machinable mask). A round tool can re-aim in place
  // for free — pick the best heading over the full circle and carry on.
  const reAim = (): boolean => {
    const ds = dsBase
    let bestT = NaN
    let bestSc = Infinity
    for (let k = 0; k < 24; k++) {
      const th = (k / 24) * 2 * Math.PI
      const nx = px + Math.cos(th) * ds
      const ny = py + Math.sin(th) * ds
      if (!machAt(nx, ny)) continue
      const e = engagement(nx, ny)
      const sc = (e > ft * 1.2 ? 2 + e : Math.abs(e - ft)) + (inBandZone(nx, ny) ? 0.6 : 0)
      if (sc < bestSc) { bestSc = sc; bestT = th }
    }
    if (Number.isNaN(bestT)) return false
    theta = bestT
    return true
  }

  // True when the straight tool move a→b runs entirely over already-cut floor: the
  // centre line stays machinable (same wall guarantee as a marched step) and every cell
  // the tool sweeps is cut AND inside the pocket (outside-region cells read "cleared"
  // for the engagement probe, but they are wall — a chord may never cross them).
  const chordClear = (ax: number, ay: number, bx: number, by: number): boolean => {
    const len = Math.hypot(bx - ax, by - ay)
    const lineSteps = Math.max(1, Math.ceil(len / cell))
    for (let k = 0; k <= lineSteps; k++) {
      if (!machAt(ax + ((bx - ax) * k) / lineSteps, ay + ((by - ay) * k) / lineSteps)) return false
    }
    const r2 = rb * rb
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - rb - x0) / cell))
    const ix1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + rb - x0) / cell))
    const iy0 = Math.max(0, Math.floor((Math.min(ay, by) - rb - y0) / cell))
    const iy1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + rb - y0) / cell))
    for (let iy = iy0; iy <= iy1; iy++) {
      const pyc = y0 + (iy + 0.5) * cell
      const row = iy * w
      for (let ix = ix0; ix <= ix1; ix++) {
        const pxc = x0 + (ix + 0.5) * cell
        if (ptSegDistSq(pxc, pyc, ax, ay, bx, by) > r2) continue
        if (!cleared[row + ix] || !region[row + ix]) return false
      }
    }
    return true
  }

  // Replace a steered air run (steps that removed no material) with the fewest straight
  // chords over cut floor — the straight back-stroke of the trochoidal "D". Greedy
  // line-of-sight: from each anchor jump to the farthest run point reachable by a clear
  // chord (adjacent points were physically traversed, so the fallback is always valid).
  // Endpoints are preserved, so the rejoin into the next cut is unchanged.
  const straighten = (from: Pt2, pts: Pt2[]): Pt2[] => {
    if (pts.length <= 1) return pts
    const out: Pt2[] = []
    let ax = from[0], ay = from[1]
    let i = 0
    while (i < pts.length) {
      let j = pts.length - 1
      while (j > i && !chordClear(ax, ay, pts[j][0], pts[j][1])) {
        j = i + Math.floor((j - i) / 2)
      }
      out.push(pts[j])
      ax = pts[j][0]
      ay = pts[j][1]
      i = j + 1
    }
    return out
  }

  // ── Region loop ───────────────────────────────────────────────────────────────

  const regions: Adaptive2Region[] = []
  const simplifyTol = cell * 0.4

  // Post-smoothing: the march advances in fixed steps with quantized headings, so raw cut
  // polylines carry heading noise — the mean curvature is right but it JITTERS step to
  // step, which is what reads as wobble and what excites chatter. So the filter targets
  // curvature continuity, not position error.
  //
  // Taubin λ/μ rather than repeated averaging. Plain [1,2,1] smoothing is a low-pass that
  // also SHRINKS the curve toward its centroid, so every extra pass pulls the path off the
  // frontier; that is what capped the old filter at 4 passes and left the jitter in. Taubin
  // alternates a positive (λ) smoothing step with a slightly larger negative (μ) one, whose
  // net transfer function passes low frequencies at unity gain and kills high ones — so
  // passes can be stacked until the jitter is gone without the curve creeping inward.
  //
  // Two constraints keep it honest. The per-point displacement clamp is CURVATURE-AWARE:
  // on near-straight runs (where the jitter lives) a point may move a few tenths, but where
  // the path genuinely turns — wall corners, trochoid apexes — the clamp tightens sharply,
  // so smoothing cannot shortcut a corner and leave a stock lens for the next lap to
  // swallow (that showed up as 88% corner bites with a uniform clamp). And points that
  // leave the machinable mask revert, so walls and islands stay untouchable.
  //
  // The budget is set by the lap overlap: consecutive passes overlap by (2R − stepover),
  // so a lateral shift of a few tenths cannot open a ridge — the binding constraint is
  // engagement, which is why it is a fraction of the stepover rather than of the overlap.
  const SMOOTH_PASSES = 24
  const TAUBIN_LAMBDA = 0.55
  const TAUBIN_MU = -0.58
  const smoothTol = Math.min(0.12 * s, 1.5 * cell)
  // Fair on evenly spaced samples: the march's own step now varies with wall clearance,
  // and unevenly spaced samples bias the filter.
  const fairStep = Math.max(cell, dsBase)
  // Max direction change at an emitted vertex. ~3.5 deg is below what a controller has to
  // decelerate for at roughing feeds, and it is the cap that keeps the path reading as a
  // curve rather than a chain of facets.
  const MAX_VERTEX_TURN = 0.06
  // Output thinning: below the residual ripple, so collapsing straight runs cannot
  // reintroduce a kink by cutting across a wave.
  const thinTol = simplifyTol * 0.15
  const smoothCut = (raw: Pt2[]): Pt2[] => {
    if (raw.length < 3) return raw
    const pts = resampleUniform(raw, fairStep)
    const n = pts.length
    if (n < 5) return douglasPeucker(pts, simplifyTol)
    // Per-point clamp from the ORIGINAL local turn angle (over ±2 neighbours): full
    // tolerance when straight, down to 15% at ≥ ~45° of turn.
    const tol = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const im = Math.max(0, i - 2)
      const ip = Math.min(n - 1, i + 2)
      const v1x = pts[i][0] - pts[im][0]
      const v1y = pts[i][1] - pts[im][1]
      const v2x = pts[ip][0] - pts[i][0]
      const v2y = pts[ip][1] - pts[i][1]
      const l1 = Math.hypot(v1x, v1y)
      const l2 = Math.hypot(v2x, v2y)
      let turn = 0
      if (l1 > 1e-9 && l2 > 1e-9) {
        const c = clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)
        turn = Math.acos(c)
      }
      tol[i] = smoothTol * Math.max(0.15, 1 - turn / 0.8)
      // Wall-adjacent laps feed the finishing contour: rounding them grows the corner
      // lens the (ungoverned) finishing pass swallows in one pivot. Keep them faithful;
      // they ride walls and are nearly straight anyway.
      if (inBandZone(pts[i][0], pts[i][1])) tol[i] *= 0.25
    }
    // One Laplacian sweep with weight `w`, endpoints pinned, each point clamped to its
    // budget around its ORIGINAL position and reverted if it would leave the mask.
    const sweep = (src: Pt2[], w: number): Pt2[] => {
      const out: Pt2[] = new Array(n)
      out[0] = src[0]
      out[n - 1] = src[n - 1]
      for (let i = 1; i < n - 1; i++) {
        const a = src[i - 1], p = src[i], b = src[i + 1]
        let sx = p[0] + w * ((a[0] + b[0]) / 2 - p[0])
        let sy = p[1] + w * ((a[1] + b[1]) / 2 - p[1])
        const o = pts[i]
        const dx = sx - o[0]
        const dy = sy - o[1]
        const d2 = dx * dx + dy * dy
        const ti = tol[i]
        if (d2 > ti * ti) {
          const k = ti / Math.sqrt(d2)
          sx = o[0] + dx * k
          sy = o[1] + dy * k
        }
        out[i] = machAt(sx, sy) ? [sx, sy] : o
      }
      return out
    }
    let cur2 = pts
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      cur2 = sweep(cur2, TAUBIN_LAMBDA)
      cur2 = sweep(cur2, TAUBIN_MU)
    }
    // Thin on BOTH deviation and turn, so long chords cannot swallow the whole turn of an
    // arc and dump it on one vertex.
    return thinByChordAndTurn(cur2, thinTol, MAX_VERTEX_TURN)
  }
  // Owed leftovers under ~1 mm² aren't worth another entry move.
  const stopUncut = Math.max(4, Math.round(1 / (cell * cell)))
  let budget = Math.ceil((uncut * cell * cell) / (dsBase * s)) * 8 + 20000

  while (uncut > stopUncut && regions.length < 200 && budget > 0) {
    // Seed at the deepest remaining OWED stock the tool centre can sit on (depth measured
    // to anything cut, void, or mere band — keeps seeds off the walls). Owed stock always
    // sits on machinable cells (everything else is band), so no seed means done.
    const dClear = edtSq(w, h, i => cleared[i] !== 0 || band[i] !== 0)
    let seedIdx = -1
    let seedScore = 0
    for (let i = 0; i < nCells; i++) {
      if (mach[i] && !cleared[i] && !band[i] && dClear[i] > seedScore) { seedScore = dClear[i]; seedIdx = i }
    }
    if (seedIdx < 0) break

    const sx = x0 + ((seedIdx % w) + 0.5) * cell
    const sy = y0 + (Math.floor(seedIdx / w) + 0.5) * cell
    let hr = 0
    if (prm.helixEntry) {
      const head = Math.min(Math.sqrt(dWall[seedIdx]), Math.sqrt(dClear[seedIdx])) * cell - cell
      hr = Math.min(0.9 * R, head)
      if (hr < Math.max(0.3, 0.15 * R)) hr = 0
    }

    const before = uncut

    // Entry: bore (helix) or plunge, then march. A plunge's first lateral moves are
    // area-governed like any other step, so even a plunge into a leftover sliver cuts
    // its way out at capped width rather than slotting.
    let moves: Adaptive2Move[] = []
    let cur: Pt2[] = []
    if (hr > 0) {
      stampDisk(sx, sy, hr + rb)
      px = sx + hr                      // bore rim at angle 0 — the emitter ends the helix here
      py = sy
      theta = dirSign * (Math.PI / 2)   // tangent to the rim in the winding direction
    } else {
      stampDisk(sx, sy, rb)
      px = sx
      py = sy
      // Pick the start heading whose first step lands closest to target engagement.
      let bestT = 0
      let bestSc = Infinity
      const ds0 = dsBase
      for (let k = 0; k < 16; k++) {
        const th = (k / 16) * 2 * Math.PI
        const nx = px + Math.cos(th) * ds0
        const ny = py + Math.sin(th) * ds0
        if (!machAt(nx, ny)) continue
        const sc = Math.abs(engagement(nx, ny) - ft)
        if (sc < bestSc) { bestSc = sc; bestT = th }
      }
      theta = bestT
    }
    cur.push([px, py])

    let idle = 0
    let navMode = false               // descending the guide field to new stock
    let navSteps = 0
    let navLimit = 0

    // Steps that removed nothing accumulate here instead of going straight into the
    // path; when cutting resumes the run is replaced by straight chords over cut floor
    // (straighten) and emitted as a stay-down 'link' move — rendered as dashed travel in
    // the UI, so cutting and air-moves are visually distinct. Hops shorter than a couple
    // of steps stay inline in the cut move. Only zero-cut steps may be rerouted — their
    // stamps changed nothing, so the swap is exactly behavior-preserving on the grid.
    const air: Pt2[] = []
    // Feed multiplier the current cut run is accumulating under. A step the geometry
    // forced over the chip-load cap returns a reduced scale; the run is flushed and a new
    // one started whenever it changes, so a slot's slow section is exactly the slot.
    let curFeed = 1
    const flushCut = () => {
      // feedScale is left undefined at full feed: it means "this move needs a protective
      // feed override", and downstream (motion simplification, arc fitting, the gcode
      // emitter) treats any tagged segment as ineligible for merging.
      if (cur.length >= 2) moves.push(curFeed < 1 ? { kind: 'cut', pts: cur, feedScale: curFeed } : { kind: 'cut', pts: cur })
    }
    const setFeed = (fs: number) => {
      if (fs === curFeed) return
      flushCut()
      cur = cur.length > 0 ? [cur[cur.length - 1]] : []
      curFeed = fs
    }
    const emitAir = () => {
      if (air.length === 0) return
      const from = cur[cur.length - 1]
      const pts = straighten(from, air)
      air.length = 0
      let len = 0
      let prev = from
      for (const p of pts) { len += Math.hypot(p[0] - prev[0], p[1] - prev[1]); prev = p }
      if (len <= dsBase * 2) {
        for (const p of pts) cur.push(p)
        return
      }
      flushCut()
      moves.push({ kind: 'link', pts })
      cur = [pts[pts.length - 1]]
    }

    while (uncut > stopUncut && budget-- > 0) {
      tellProgress()
      if (!navMode) {
        // ── cutting mode: hold engagement at target ──
        let r = steerStep()
        if (r === null) {
          if (!reAim()) break
          r = steerStep()
          if (r === null) break
        }
        if (r.cut === 0) air.push([px, py])
        else { emitAir(); setFeed(r.feedScale); cur.push([px, py]) }
        // Idle = no GOAL progress: steps that cut nothing, or only shave band stock the
        // finishing pass owns, both count — otherwise the march nibbles the band edge
        // forever at low engagement without ever moving on.
        if (r.owed === 0) idle++
        else idle = 0
        if (idle > idleLimit) {
          // A full loop without touching stock: nothing left here. Flood the guide field
          // and slide to the nearest remaining stock without lifting; end the region only
          // if no stock is reachable from where we stand.
          if (!buildGuide()) break
          const g0 = guideAt(px, py)
          if (!Number.isFinite(g0)) break
          navMode = true
          navSteps = 0
          navLimit = g0 * 3 + 100
          idle = 0
        }
      } else {
        // ── navigation mode: descend the guide field, engagement still capped ──
        const ds = dsBase
        const maxStepArea = OVERLOAD * areaTargetPerLen * ds
        let bestDelta = NaN
        let bestSc = Infinity
        let bestE = 0
        for (let i = 0; i < CAND.length; i++) {
          const th = theta + CAND[i] * A
          const nx = px + Math.cos(th) * ds
          const ny = py + Math.sin(th) * ds
          if (!machAt(nx, ny)) continue
          const g = guideAt(nx, ny)
          if (!Number.isFinite(g)) continue
          // Same chip-load governor as cutting mode: occupancy alone misses pivot
          // inflation (e.g. rounding an island while walking to new stock).
          if (previewStepArea(px, py, nx, ny) > maxStepArea) continue
          const e = engagement(nx, ny)
          const sc = g + (e > ft * 1.15 ? 1e6 : 0) + 0.3 * Math.abs(CAND[i])
          if (sc < bestSc) { bestSc = sc; bestDelta = CAND[i] * A; bestE = e }
        }
        if (Number.isNaN(bestDelta) || bestSc >= 1e6) {
          if (!reAim() || ++navSteps > navLimit) break
          continue
        }
        theta += bestDelta
        const nx = px + Math.cos(theta) * ds
        const ny = py + Math.sin(theta) * ds
        const st = stampSeg(px, py, nx, ny, rb)
        px = nx
        py = ny
        if (st.n === 0) air.push([px, py])
        else { emitAir(); setFeed(1); cur.push([px, py]) }
        if (bestE >= ft * 0.5 || guideAt(px, py) === 0) {
          navMode = false
          idle = 0
        } else if (++navSteps > navLimit) {
          break
        }
      }
    }
    emitAir()
    flushCut()

    moves = moves
      .map(m => (m.kind === 'cut' ? { ...m, pts: smoothCut(m.pts) } : m))
      .filter(m => m.pts.length >= (m.kind === 'cut' ? 2 : 1))

    if (moves.some(m => m.kind === 'cut')) {
      regions.push({ helixCenter: [sx, sy], helixRadiusMM: hr, moves })
    }
    if (uncut >= before) break   // no progress — bail rather than spin
  }

  return regions
}
