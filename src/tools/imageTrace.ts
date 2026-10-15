// Bitmap tracing: turn a picture's dark (or light) regions into closed vector outlines.
//
// The outline is a level set of the picture's BRIGHTNESS, not of a thresholded black and
// white copy of it. Marching squares over the 0/1 bitmap can only put a vertex at a pixel
// edge's midpoint, so every curve comes out as a 45° staircase; over the greyscale it
// interpolates between neighbours, and the anti-aliased edge every logo and scan already
// has places the line to a fraction of a pixel. The staircase is then not there to smooth
// away, which is what lets a light simplification keep the shape.
//
// Pipeline: level-set loops (cam/marchingSquares) → drop specks below an area → closed
// Douglas–Peucker → smooth vertices get Catmull-Rom-style handles, sharp ones stay
// corners → mapped through the image rectangle onto the stock. The mapping is the one
// photo V-carve samples with (`sampleLum` in cam/photoVcarve.ts), so a trace lies exactly
// on the picture it came from, rotated along with it.
//
// Pure, no DOM: the caller decodes the picture (io/imageLuminance.ts) on the main thread.

import type { Pt2 } from '../cam/pathFlattener'
import type { PhotoImage } from '../cam/photoVcarve'
import type { RectInfo } from '../canvas/selectionUtils'
import { traceIsolines } from '../cam/marchingSquares'
import { round4 } from '../util/num'
import { inflatePathsD, unionD, differenceD, intersectD, areaD, FillRule, JoinType, EndType, ClipperD, PolyTreeD, PolyPathD, ClipType } from 'clipper2-ts'
import { interiorPoint, pointInPolygon } from '../cam/geom'

export interface TraceParams {
  /** Brightness cut, 0 (black) … 255 (white). Ignored when `autoThreshold` is on. */
  threshold: number
  /** Pick the threshold from the picture's histogram (Otsu). */
  autoThreshold: boolean
  /** Which side is the shape: 'dark' traces ink on a light ground, 'light' the reverse. */
  trace: 'dark' | 'light'
  /** Regions (and holes) smaller than a square of this side are dropped, in mm. */
  minSpeckMM: number
  /** 0 = straight segments that follow every pixel step … 100 = smoothest curves. */
  smoothing: number
  /**
   * How many tones the picture is split into (absent = 2). Above 2 each cut comes out as
   * its own LEVEL — see traceImage.
   */
  tones?: number
  /** The cuts of a multi-tone trace when `autoThreshold` is off: tones − 1 brightnesses,
   *  ASCENDING (darkest break first) whichever way `trace` points. Ignored — the automatic
   *  cuts are used — when absent or not tones − 1 long. */
  cuts?: number[]
  /** Grow every traced region by this much in total (half each side of a line), in mm —
   *  so linework too thin for any tool becomes a band one can pocket. Absent = 0. */
  thickenMM?: number
  /** 'outline' (absent): closed outlines round every region. 'centerline': one open path
   *  down the middle of each stroke, for line art cut with a V-bit on a centerline
   *  profile. Two tones only; Thicken does not apply. */
  mode?: 'outline' | 'centerline'
}

export const DEFAULT_TRACE: TraceParams = {
  threshold: 128,
  autoThreshold: true,
  trace: 'dark',
  minSpeckMM: 0.5,
  smoothing: 50,
  tones: 2,
  mode: 'outline',
  thickenMM: 0,
}

/** More loops than this is a photograph traced at the wrong threshold, not a drawing. */
export const MAX_TRACE_LOOPS = 3000

export interface TraceResult {
  /** One closed outline per entry — an outer boundary or a hole — as an absolute d string. */
  ds: string[]
  /** Which level each entry of `ds` belongs to: 1 is the innermost (the darkest region for
   *  a dark trace), counting outward. All 1 for a two-tone trace. */
  levels: number[]
  /** The cut each level was traced at, level 1 first. */
  thresholds: number[]
  /** Loops dropped for being smaller than `minSpeckMM`. */
  specks: number
}

/**
 * Otsu's threshold: the brightness that best splits the histogram into two classes, by
 * maximising the between-class variance — then moved to HALFWAY BETWEEN THE TWO CLASS
 * MEANS. Returns the cut `t` with dark = lum < t.
 *
 * Otsu alone is the right split but the wrong place to cut. A crisp drawing is almost all
 * pure black and pure white, so the variance hardly changes across the whole gap between
 * them and the first cut to reach the maximum — just above black — wins; on a 1 mm black
 * line that traced 0.8 mm wide, the anti-aliased edge cut at a fifth of the way up rather
 * than at its middle. Midway between the means is where that edge's middle is.
 */
export function otsuThreshold(lum: Uint8Array): number {
  const hist = new Float64Array(256)
  for (let i = 0; i < lum.length; i++) hist[lum[i]]++
  const total = lum.length
  if (total === 0) return 128
  let sumAll = 0
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]
  let wB = 0, sumB = 0, best = -1, bestT = 128
  for (let t = 0; t < 255; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; bestT = t + 1 }
  }
  let wD = 0, sD = 0
  for (let i = 0; i < bestT; i++) { wD += hist[i]; sD += i * hist[i] }
  const wL = total - wD
  if (wD === 0 || wL === 0) return bestT
  return Math.round((sD / wD + (sumAll - sD) / wL) / 2)
}

/**
 * Otsu's method for `k` classes: the k − 1 ascending cuts (class i is cuts[i−1] ≤ lum <
 * cuts[i]) that maximise the between-class variance. Dynamic programming over the 256-bin
 * histogram, O(k·256²), so instant for any k worth asking for.
 */
export function multiOtsu(lum: Uint8Array, k: number): number[] {
  const n = lum.length
  if (k < 2) return []
  if (n === 0) return Array.from({ length: k - 1 }, (_, i) => Math.round(256 * (i + 1) / k))
  const w = new Float64Array(257), m = new Float64Array(257)
  const hist = new Float64Array(256)
  for (let i = 0; i < n; i++) hist[lum[i]]++
  for (let i = 0; i < 256; i++) { w[i + 1] = w[i] + hist[i] / n; m[i + 1] = m[i] + i * hist[i] / n }
  const mu = m[256]
  const term = (a: number, b: number) => {
    const W = w[b] - w[a]
    if (W <= 0) return 0
    const d = (m[b] - m[a]) / W - mu
    return W * d * d
  }
  // best[j][t]: the best j classes over bins [0, t); from[j][t] where the last one starts.
  const best = Array.from({ length: k + 1 }, () => new Float64Array(257).fill(-Infinity))
  const from = Array.from({ length: k + 1 }, () => new Int16Array(257))
  for (let t = 1; t <= 256; t++) best[1][t] = term(0, t)
  for (let j = 2; j <= k; j++) {
    for (let t = j; t <= 256; t++) {
      for (let s = j - 1; s < t; s++) {
        const v = best[j - 1][s] + term(s, t)
        if (v > best[j][t]) { best[j][t] = v; from[j][t] = s }
      }
    }
  }
  const cuts: number[] = []
  for (let j = k, t = 256; j > 1; j--) { t = from[j][t]; cuts.unshift(t) }
  return cuts
}

/** A middle tone holding less than this share of the pixels is anti-aliasing, not a tone. */
const MIDDLE_TONE_SHARE = 0.1

/**
 * The automatic threshold for tracing `trace` areas. A plain two-tone picture (a logo, a
 * stencil) splits at Otsu's cut. A picture with a real THIRD tone — a cartoon's black
 * outlines around grey fill on white — is what the two-class cut gets wrong: it splits
 * white from everything else, so the fill traces as one blob with the outlines lost inside
 * it. There the cut is taken below the middle tone for dark (the linework) and above it
 * for light (everything that is not background).
 */
export function autoThreshold(lum: Uint8Array, trace: 'dark' | 'light'): number {
  const [t1, t2] = multiOtsu(lum, 3)
  let mid = 0
  for (let i = 0; i < lum.length; i++) if (lum[i] >= t1 && lum[i] < t2) mid++
  if (lum.length === 0 || mid / lum.length < MIDDLE_TONE_SHARE) return otsuThreshold(lum)
  return trace === 'dark' ? t1 : t2
}

function ringArea(r: Pt2[]): number {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return a / 2
}

function distToSeg(p: Pt2, a: Pt2, b: Pt2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

// Open Douglas–Peucker over pts[i0..i1], marking the kept indices.
function dp(pts: Pt2[], i0: number, i1: number, tol: number, keep: Uint8Array): void {
  const stack: [number, number][] = [[i0, i1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let worst = -1, wd = tol
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(pts[i], pts[a], pts[b])
      if (d > wd) { wd = d; worst = i }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]) }
  }
}

/**
 * Douglas–Peucker for a CLOSED ring (no repeated end point). Anchored at the first point
 * and the point farthest from it, which are both certainly on the hull of the shape, so
 * the result does not depend on where the tracer happened to start the loop.
 */
export function simplifyRing(ring: Pt2[], tol: number): Pt2[] {
  const n = ring.length
  if (n <= 3) return ring.slice()
  let far = 0, fd = -1
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1])
    if (d > fd) { fd = d; far = i }
  }
  const pts = [...ring, ring[0]]
  const keep = new Uint8Array(n + 1)
  keep[0] = 1; keep[far] = 1; keep[n] = 1
  dp(pts, 0, far, tol, keep)
  dp(pts, far, n, tol, keep)
  const out: Pt2[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i])
  return out
}

/** Exact identity of a vertex that has been through Clipper at precision 4. */
const vkey = (p: Pt2) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`

/**
 * Douglas–Peucker that leaves the vertices in `lock` where they are. Runs of free
 * vertices between two locked ones are simplified with those two as fixed anchors. An
 * outer tone's ring runs along the inner tone's outline for much of its length; simplified
 * on its own it would pick different vertices there and the two outlines would cross.
 * Locked, the shared run is the inner tone's outline exactly.
 */
export function simplifyRingLocked(ring: Pt2[], tol: number, lock: Set<string>, near?: (p: Pt2) => boolean): Pt2[] {
  const n = ring.length
  // `near`: free vertices that pass within `tol` of the inner outline are kept as well. A
  // chord between two that were dropped there could dip across it.
  const locked = ring.map((p) => lock.has(vkey(p)) || !!near?.(p))
  // A free vertex next to a locked one is where the ring leaves the shared outline — a
  // point ON the inner tone's edge. Dropping it would cut the corner across that edge.
  const pinned = locked.map((l, i) => l || locked[(i + 1) % n] || locked[(i - 1 + n) % n])
  const first = pinned.indexOf(true)
  if (first < 0) return simplifyRing(ring, tol)
  const out: Pt2[] = []
  let a = first
  for (let step = 0; step < n; ) {
    // The next pinned vertex after a (wrapping), and the free run between them.
    let b = (a + 1) % n, k = 1
    while (!pinned[b]) { b = (b + 1) % n; k++ }
    out.push(ring[a])
    if (k > 1) {
      const run: Pt2[] = []
      for (let j = 0; j <= k; j++) run.push(ring[(a + j) % n])
      const keep = new Uint8Array(run.length)
      dp(run, 0, run.length - 1, tol, keep)
      for (let j = 1; j < run.length - 1; j++) if (keep[j]) out.push(run[j])
    }
    step += k
    a = b
  }
  return out
}

type Mapper = (p: Pt2) => Pt2

/**
 * A closed ring as a d string. With `cornerDeg` null every edge is a straight line;
 * otherwise a vertex turning by less than `cornerDeg` is SMOOTH — its handles lie along
 * the chord from its previous to its next neighbour, a third of each adjacent edge long
 * (clamped like that, Catmull-Rom cannot overshoot on uneven spacing) — and a sharper
 * one is a corner whose handles point straight at its neighbours. An edge between two
 * corners is written as a line.
 */
/** One edge of a written outline: a cubic Bézier, or a straight line when `c` is null. */
export interface Seg { p0: Pt2; c: [Pt2, Pt2] | null; p1: Pt2 }

const lerp = (a: Pt2, b: Pt2, t: number): Pt2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

export function segPoint(g: Seg, t: number): Pt2 {
  if (!g.c) return lerp(g.p0, g.p1, t)
  const a = lerp(g.p0, g.c[0], t), b = lerp(g.c[0], g.c[1], t), c = lerp(g.c[1], g.p1, t)
  const d = lerp(a, b, t), e = lerp(b, c, t)
  return lerp(d, e, t)
}

/** The piece of `g` from t0 to t1 (t1 < t0 gives it reversed), exactly — de Casteljau. */
export function segPiece(g: Seg, t0: number, t1: number, p0: Pt2, p1: Pt2): Seg {
  if (!g.c) return { p0, c: null, p1 }
  if (t1 < t0) { const r = segPiece(g, t1, t0, p1, p0); return { p0, c: r.c && [r.c[1], r.c[0]], p1 } }
  // Left part [0, t1], then the right part of that from t0 / t1.
  const split = (q0: Pt2, q1: Pt2, q2: Pt2, q3: Pt2, t: number) => {
    const a = lerp(q0, q1, t), b = lerp(q1, q2, t), c = lerp(q2, q3, t)
    const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t)
    return { left: [q0, a, d, f] as Pt2[], right: [f, e, c, q3] as Pt2[] }
  }
  const L = split(g.p0, g.c[0], g.c[1], g.p1, t1).left
  const u = t1 > 1e-12 ? t0 / t1 : 0
  const R = split(L[0], L[1], L[2], L[3], u).right
  return { p0, c: [R[1], R[2]], p1 }
}

export function segsToD(segs: Seg[], map: Mapper, closed = true): string {
  const fmt = (p: Pt2) => { const q = map(p); return `${round4(q[0])},${round4(q[1])}` }
  if (segs.length === 0) return ''
  const parts = [`M${fmt(segs[0].p0)}`]
  if (!closed) {
    for (const g of segs) parts.push(g.c ? `C${fmt(g.c[0])},${fmt(g.c[1])},${fmt(g.p1)}` : `L${fmt(g.p1)}`)
    return parts.join(' ')
  }
  // A closing straight edge is the Z itself; writing it as well leaves a zero-length edge.
  const last = segs[segs.length - 1]
  const body = !last.c && segs.length > 1 ? segs.slice(0, -1) : segs
  for (const g of body) parts.push(g.c ? `C${fmt(g.c[0])},${fmt(g.c[1])},${fmt(g.p1)}` : `L${fmt(g.p1)}`)
  return parts.join(' ') + ' Z'
}

/**
 * The handles a closed ring is drawn with. A vertex turning by less than `cornerDeg` is
 * SMOOTH — its handles lie along the chord from its previous to its next neighbour, a
 * third of each adjacent edge long (clamped like that, Catmull-Rom cannot overshoot on
 * uneven spacing) — and a sharper one, or one listed in `forceCorner`, is a corner whose
 * handles point straight at its neighbours. An edge between two corners is a line, and
 * with `cornerDeg` null every edge is.
 */
export function ringSegments(ring: Pt2[], cornerDeg: number | null, forceCorner?: (i: number) => boolean): Seg[] {
  const n = ring.length
  if (cornerDeg === null || n < 3) return ring.map((p, i) => ({ p0: p, c: null, p1: ring[(i + 1) % n] }))
  const cosLim = Math.cos(cornerDeg * Math.PI / 180)
  const hIn: Pt2[] = new Array(n), hOut: Pt2[] = new Array(n)
  const corner = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const p = ring[i], a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n]
    const inX = p[0] - a[0], inY = p[1] - a[1], outX = b[0] - p[0], outY = b[1] - p[1]
    const lIn = Math.hypot(inX, inY), lOut = Math.hypot(outX, outY)
    const cos = lIn > 1e-12 && lOut > 1e-12 ? (inX * outX + inY * outY) / (lIn * lOut) : -1
    if (cos < cosLim || forceCorner?.(i)) {
      corner[i] = 1
      hIn[i] = [p[0] - inX / 3, p[1] - inY / 3]
      hOut[i] = [p[0] + outX / 3, p[1] + outY / 3]
    } else {
      const tx = b[0] - a[0], ty = b[1] - a[1], lt = Math.hypot(tx, ty) || 1
      hIn[i] = [p[0] - (tx / lt) * lIn / 3, p[1] - (ty / lt) * lIn / 3]
      hOut[i] = [p[0] + (tx / lt) * lOut / 3, p[1] + (ty / lt) * lOut / 3]
    }
  }
  return ring.map((p, i) => {
    const j = (i + 1) % n
    return { p0: p, c: corner[i] && corner[j] ? null : [hOut[i], hIn[j]], p1: ring[j] }
  })
}

/** As ringSegments, for an OPEN polyline: its two ends are corners and there is no closing edge. */
export function polylineSegments(pts: Pt2[], cornerDeg: number | null): Seg[] {
  const n = pts.length
  if (n < 2) return []
  if (n === 2) return [{ p0: pts[0], c: null, p1: pts[1] }]
  return ringSegments(pts, cornerDeg, (i) => i === 0 || i === n - 1).slice(0, n - 1)
}

export function ringToD(ring: Pt2[], map: Mapper, cornerDeg: number | null): string {
  return segsToD(ringSegments(ring, cornerDeg), map)
}

/**
 * Gaussian blur, in place, of the w×h picture inside the padded field `T` (row stride
 * `gw`, one cell of border all round). The border is left alone — it has to stay below
 * every level for the loops to close — and the picture's own edge is clamped, not mixed
 * with the border, so a shape touching the edge of the image does not fade at it.
 */
function blurInterior(T: Float32Array, w: number, h: number, gw: number, sigma: number): void {
  if (sigma < 0.2) return
  const rad = Math.ceil(3 * sigma)
  const k = new Float32Array(2 * rad + 1)
  let sum = 0
  for (let i = -rad; i <= rad; i++) { k[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + rad] }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(w * h)
  const at = (c: number, r: number) => T[(r + 1) * gw + c + 1]
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let v = 0
    for (let i = -rad; i <= rad; i++) v += k[i + rad] * at(Math.min(w - 1, Math.max(0, c + i)), r)
    tmp[r * w + c] = v
  }
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let v = 0
    for (let i = -rad; i <= rad; i++) v += k[i + rad] * tmp[Math.min(h - 1, Math.max(0, r + i)) * w + c]
    T[(r + 1) * gw + c + 1] = v
  }
}

/** Squared Euclidean distance from every pixel to the nearest pixel with `set[i]`
 *  (Felzenszwalb & Huttenlocher), Infinity when there is none. */
function edt2(set: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20
  const d = new Float32Array(w * h)
  for (let i = 0; i < d.length; i++) d[i] = set[i] ? 0 : INF
  const m = Math.max(w, h)
  const f = new Float64Array(m), z = new Float64Array(m + 1), out = new Float64Array(m)
  const v = new Int32Array(m)
  const pass = (n: number, get: (i: number) => number, put: (i: number, x: number) => void) => {
    for (let i = 0; i < n; i++) f[i] = get(i)
    let k = 0
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity
    for (let q = 1; q < n; q++) {
      let sx = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (sx <= z[k]) { k--; sx = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]) }
      k++; v[k] = q; z[k] = sx; z[k + 1] = Infinity
    }
    k = 0
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + f[v[k]] }
    for (let i = 0; i < n; i++) put(i, out[i])
  }
  for (let c = 0; c < w; c++) pass(h, (r) => d[r * w + c], (r, x) => { d[r * w + c] = x })
  for (let r = 0; r < h; r++) pass(w, (c) => d[r * w + c], (c, x) => { d[r * w + c] = x })
  for (let i = 0; i < d.length; i++) if (d[i] >= INF / 2) d[i] = Infinity
  return d
}

/**
 * Fills every gap narrower than `gapPx` between areas of a darker tone with that tone —
 * the tip of a lighter area squeezed into the V where two lines meet joins the lines, as
 * does a thin sliver of it run between them. A morphological closing of each tone that
 * has a lighter tone beyond it, darkest first, done on the grid before anything is traced
 * by moving each filled pixel's value just into the tone's range (`levels` ascending), so
 * everything downstream sees an ordinary picture with the gap painted over. The outermost tone is not closed against the
 * background: that would bridge the white flecks along a line's halo (see dropHalos).
 * Returns how many pixels changed tone.
 */
export function closeTones(T: Float32Array, w: number, h: number, gw: number, levels: number[], gapPx: number): number {
  const r2 = (gapPx / 2) * (gapPx / 2)
  if (gapPx < 1 || levels.length < 2) return 0
  const n = w * h
  const at = (i: number) => (Math.floor(i / w) + 1) * gw + (i % w) + 1
  const mask = new Uint8Array(n), notGrown = new Uint8Array(n)
  let changed = 0
  for (let c = levels.length; c >= 2; c--) {
    const lo = levels[c - 1]
    for (let i = 0; i < n; i++) mask[i] = T[at(i)] > lo ? 1 : 0
    const dIn = edt2(mask, w, h)
    for (let i = 0; i < n; i++) notGrown[i] = dIn[i] > r2 ? 1 : 0
    const dOut = edt2(notGrown, w, h)
    for (let i = 0; i < n; i++) {
      if (mask[i] || dOut[i] <= r2) continue
      T[at(i)] = lo + 0.5
      changed++
    }
  }
  return changed
}

// ── Centerlines ──────────────────────────────────────────────────────────────

const N8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const

/**
 * Flips every connected region of `mask` smaller than `minArea` pixels to the colour
 * around it: an ink fleck (8-connected) goes, a hole (4-connected background not reaching
 * the edge) fills — the same rule the outline trace applies by dropping small loops. A
 * hole that stays open is what makes a centerline close into a loop, so a fleck of white
 * inside a stroke would otherwise come out as a tiny ring. Returns how many flipped.
 */
export function despeckleMask(mask: Uint8Array, w: number, h: number, minArea: number): number {
  const label = new Int32Array(w * h).fill(-1)
  let flipped = 0
  const stack: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1) continue
    const v = mask[start]
    const comp: number[] = []
    let touchesEdge = false
    label[start] = start
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const x = i % w, y = (i - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesEdge = true
      for (let k = 0; k < 8; k++) {
        if (!v && (k & 1)) continue   // background is 4-connected, ink 8-connected
        const nx = x + N8[k][0], ny = y + N8[k][1]
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (label[j] === -1 && mask[j] === v) { label[j] = start; stack.push(j) }
      }
    }
    if (comp.length < minArea && (v || !touchesEdge)) {
      for (const i of comp) mask[i] = v ? 0 : 1
      flipped++
    }
  }
  return flipped
}

/**
 * Zhang–Suen thinning, in place: every stroke of `mask` down to a one-pixel skeleton.
 *
 * Only a pixel with a background neighbour can ever be removed (the test needs at most six
 * set neighbours), so each pass looks at the FRONTIER — pixels on the current edge —
 * rather than at every ink pixel. Re-testing the whole area each pass made a mostly-ink
 * picture (a dark photograph traced dark) take seconds: the passes number half the
 * thickest region and each one cost the whole area. Pixels uncovered by a deletion join
 * the frontier for the next pass, so the total work follows the area once.
 */
export function thinMask(mask: Uint8Array, w: number, h: number): void {
  const inFront = new Uint8Array(w * h)
  let front: number[] = []
  const nb = new Int32Array(8)
  // P2 … P9, clockwise from north, as 0/1 — reads outside the picture are background.
  const load = (i: number) => {
    const x = i % w, y = (i - x) / w
    const up = y > 0, dn = y < h - 1, lf = x > 0, rt = x < w - 1
    nb[0] = up ? mask[i - w] : 0
    nb[1] = up && rt ? mask[i - w + 1] : 0
    nb[2] = rt ? mask[i + 1] : 0
    nb[3] = dn && rt ? mask[i + w + 1] : 0
    nb[4] = dn ? mask[i + w] : 0
    nb[5] = dn && lf ? mask[i + w - 1] : 0
    nb[6] = lf ? mask[i - 1] : 0
    nb[7] = up && lf ? mask[i - w - 1] : 0
  }
  const push = (i: number) => { if (mask[i] && !inFront[i]) { inFront[i] = 1; front.push(i) } }
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue
    load(i)
    if (nb[0] + nb[1] + nb[2] + nb[3] + nb[4] + nb[5] + nb[6] + nb[7] < 8) push(i)
  }
  const del: number[] = []
  for (let changed = true; changed; ) {
    changed = false
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0
      for (const i of front) {
        if (!mask[i]) continue
        load(i)
        const b = nb[0] + nb[1] + nb[2] + nb[3] + nb[4] + nb[5] + nb[6] + nb[7]
        if (b < 2 || b > 6) continue
        let a = 0
        for (let k = 0; k < 8; k++) if (!nb[k] && nb[(k + 1) & 7]) a++
        if (a !== 1) continue
        if (pass === 0 ? (nb[0] && nb[2] && nb[4]) || (nb[2] && nb[4] && nb[6])
          : (nb[0] && nb[2] && nb[6]) || (nb[0] && nb[4] && nb[6])) continue
        del.push(i)
      }
      if (del.length === 0) continue
      changed = true
      for (const i of del) mask[i] = 0
      // Survivors stay on the frontier; the deleted pixels' neighbours join it.
      const next: number[] = []
      for (const i of front) { inFront[i] = 0; if (mask[i]) { inFront[i] = 1; next.push(i) } }
      front = next
      for (const i of del) {
        const x = i % w, y = (i - x) / w
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) push(ny * w + nx)
        }
      }
    }
  }
}

/**
 * A skeleton's pixels as polylines, in pixel coordinates. A diagonal step counts only
 * where neither pixel beside it is set, so the corner of an L is one path, not a
 * three-pixel triangle. Paths run between ENDS and JUNCTIONS (any pixel not linking
 * exactly two others); what is left over is closed loops, returned with `closed`.
 */
export function traceSkeleton(mask: Uint8Array, w: number, h: number): { pts: Pt2[]; closed: boolean }[] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1
  const nbrs = (i: number): number[] => {
    const x = i % w, y = (i - x) / w
    const out: number[] = []
    for (let k = 0; k < 8; k++) {
      const [dx, dy] = N8[k]
      if (!on(x + dx, y + dy)) continue
      if (k & 1 && (on(x + dx, y) || on(x, y + dy))) continue
      out.push((y + dy) * w + x + dx)
    }
    return out
  }
  const pt = (i: number): Pt2 => [i % w, Math.floor(i / w)]
  const paths: { pts: Pt2[]; closed: boolean }[] = []
  const usedEdge = new Set<string>()
  const ek = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)
  const isNode = (i: number) => nbrs(i).length !== 2
  const seen = new Uint8Array(w * h)
  const walk = (from: number, next: number): number[] => {
    const chain = [from]
    let prev = from, cur = next
    usedEdge.add(ek(prev, cur))
    while (true) {
      chain.push(cur); seen[cur] = 1
      if (isNode(cur)) break
      const nx = nbrs(cur).find((j) => j !== prev && !usedEdge.has(ek(cur, j)))
      if (nx === undefined) break
      usedEdge.add(ek(cur, nx))
      prev = cur; cur = nx
    }
    return chain
  }
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || !isNode(i)) continue
    seen[i] = 1
    for (const j of nbrs(i)) if (!usedEdge.has(ek(i, j))) paths.push({ pts: walk(i, j).map(pt), closed: false })
  }
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue
    const n = nbrs(i)
    if (n.length !== 2) continue
    const chain = walk(i, n[0])
    if (chain[chain.length - 1] === i) chain.pop()
    paths.push({ pts: chain.map(pt), closed: true })
  }
  return paths
}

/** The cuts a trace uses, level 1 (innermost) first. */
export function traceThresholds(lum: Uint8Array, params: TraceParams): number[] {
  const tones = Math.max(2, Math.round(params.tones ?? 2))
  const clamp = (t: number) => Math.max(1, Math.min(254, Math.round(t)))
  if (tones === 2) return [clamp(params.autoThreshold ? autoThreshold(lum, params.trace) : params.threshold)]
  // Ascending cuts nest the dark way round: lum < c1 lies inside lum < c2. A light trace
  // nests the other way, lum ≥ c_last innermost.
  const manual = !params.autoThreshold && params.cuts?.length === tones - 1
  const cuts = (manual ? [...params.cuts!].sort((a, b) => a - b) : multiOtsu(lum, tones)).map(clamp)
  return params.trace === 'dark' ? cuts : cuts.reverse()
}

/**
 * Trace `img` (laid on the stock as `rect`) into closed outlines.
 *
 * A two-tone trace is one set of outlines. With more tones each cut is traced as its own
 * LEVEL — the region darker than that cut (lighter, for a light trace) — so the levels
 * NEST: the black linework lies inside the grey-or-darker silhouette. That is the shape a
 * stepped carve wants (each level pocketed a step deeper than the one around it), and a
 * single tone is still there for the asking: select a level together with the level
 * inside it, and pocket or inlay sees the inner one as islands.
 *
 * Throws when the settings produce more than MAX_TRACE_LOOPS outlines.
 */
export function traceImage(img: PhotoImage, rect: RectInfo, params: TraceParams): TraceResult {
  const { w, h, lum } = img
  // A centerline is a two-tone question — is this pixel part of a stroke — whatever Tones says.
  const thresholds = traceThresholds(lum, params.mode === 'centerline' ? { ...params, tones: 2 } : params)

  // Grid one pixel larger all round, the border never part of the shape, so every level
  // set closes inside it. Cell (ix, iy) is pixel (ix − 1, iy − 1): with x0 = y0 = −1 and
  // cell = 1 the loops come out in pixel-centre coordinates, y running DOWN the image.
  const gw = w + 2, gh = h + 2
  const T = new Float32Array(gw * gh)
  const dark = params.trace === 'dark'
  for (let r = 0; r < h; r++) {
    const row = (r + 1) * gw + 1
    for (let c = 0; c < w; c++) {
      const v = lum[r * w + c]
      T[row + c] = dark ? 255 - v : v
    }
  }
  const grid = { T, inside: new Uint8Array(0), gw, gh, x0: -1, y0: -1, cell: 1, tMax: 255 }

  const sx = rect.widthMM / w, sy = rect.heightMM / h
  const minAreaPx = (params.minSpeckMM * params.minSpeckMM) / (sx * sy)
  const s = Math.max(0, Math.min(100, params.smoothing)) / 100
  // Simplification tolerance in pixels, and the turn that counts as a corner. Both grow
  // with smoothing: a coarser polygon turns further at each vertex of the same curve.
  const tolPx = 0.25 + 1.25 * s
  const cornerDeg = s === 0 ? null : 35 + 40 * s
  const thicken = Math.max(0, params.thickenMM ?? 0)
  // Smoothing also BLURS the picture a little (σ up to 1 px) before it is traced. A tone
  // edge that runs through soft shading rather than along a drawn line follows the JPEG
  // noise in it, pixel by pixel, and no simplification of the outline removes that. The
  // cost is that a crisp edge shifts when the threshold is not mid-grey — half a pixel at
  // Smoothing 100 on the test square (0.12 mm at 0.25 mm/px) — and sharp corners round
  // a little more.
  blurInterior(T, w, h, gw, 1.0 * s)
  // Multi-tone, the speck size is also the narrowest GAP a darker tone keeps: anything
  // lighter squeezed between two of its areas, or into a V where its lines meet, narrower
  // than that, fills with it. Small areas of a tone of their own were tried as well (each
  // taking the tone it bordered most) and dropped: the dark flecks in a JPEG's ringing
  // joined the halo beside every line into one strip, which dropHalos then kept.
  if (params.mode !== 'centerline' && thresholds.length > 1) {
    closeTones(T, w, h, gw, thresholds.map((t) => dark ? 255.5 - t : t - 0.5).sort((a, b) => a - b), params.minSpeckMM / Math.sqrt(sx * sy))
  }
  if (params.mode === 'centerline') {
    return traceCenterlines(T, w, h, gw, dark ? 255.5 - thresholds[0] : thresholds[0] - 0.5,
      minAreaPx, tolPx, cornerDeg, ([x, y]) => {
        const u = (x + 0.5) * sx, v = rect.heightMM - (y + 0.5) * sy
        const c = Math.cos(rect.rotationDeg * Math.PI / 180), si = Math.sin(rect.rotationDeg * Math.PI / 180)
        return [rect.p0.x + u * c - v * si, rect.p0.y + u * si + v * c]
      }, thresholds, s)
  }
  // …and, on a multi-tone trace, OPENS each tone's own BAND (the tone minus the tones
  // inside it): any part narrower than twice this is shaved off. A drawn line's
  // anti-aliased edge is a pixel of in-between brightness all along it, so the middle tone
  // grows a hair-thin rim round every line, and a wedge wherever two lines nearly meet —
  // neither caught by the speck filter, since their area is not small. Thickening would
  // keep the rim exactly as thin (both tones grow alike) and leave a pair of outlines no
  // bit fits between, so with Thicken on the band must also be as wide as the Thicken
  // amount, which is the bit the user is sizing the lines for. Opening the band rather
  // than the whole tone is what reaches the rim: attached to a thick line, it is part of
  // a region far wider than any sliver.
  const thickenPx = thicken / Math.sqrt(sx * sy)
  const openPx = thresholds.length > 1 ? Math.max(2 * s, thickenPx / 2) : 0
  const cos = Math.cos(rect.rotationDeg * Math.PI / 180), sin = Math.sin(rect.rotationDeg * Math.PI / 180)
  const map: Mapper = ([x, y]) => {
    const u = (x + 0.5) * sx
    const v = rect.heightMM - (y + 0.5) * sy
    return [rect.p0.x + u * cos - v * sin, rect.p0.y + u * sin + v * cos]
  }
  const identity: Mapper = (p) => p

  type CP = { x: number; y: number }[]
  const toCP = (r: Pt2[]): CP => r.map(([x, y]) => ({ x, y }))
  const fromCP = (r: CP): Pt2[] => r.map((p) => [p.x, p.y] as Pt2)
  // Precision 4 throughout (Clipper's own default is 2), so a vertex that comes through
  // two different booleans comes out the same number both times and `vkey` can match it.
  const U = (paths: CP[], rule: FillRule) => unionD(paths, [], rule, 4)
  const grow = (paths: CP[], by: number, arcTol: number) => inflatePathsD(paths, by, JoinType.Round, EndType.Polygon, 2, 4, arcTol)
  const q4 = (v: number) => Math.round(v * 1e4) / 1e4
  const multi = thresholds.length > 1
  // One pixel, in mm — the unit every tolerance below is stated in.
  const pxMM = Math.sqrt(sx * sy)
  const tolMM = tolPx * pxMM
  // The narrowest gap a darker tone keeps (closeTones), multi-tone only.
  const gapMM = multi ? params.minSpeckMM : 0
  const thickenRings = (rings: CP[]): CP[] => grow(U(rings, FillRule.EvenOdd), thicken / 2, 0.01)

  // The inner tone as WRITTEN — its curves, and those curves sampled densely enough that a
  // chord between two samples never strays measurably from the curve. `at` says where on
  // which curve each sample sits, so a later tone running along it can write that curve.
  let innerSegs: Seg[] = []
  let innerAt = new Map<string, { g: number; t: number }[]>()
  let innerDrawn: CP[] = []
  // …and as traced, before any thickening, which is what the next band is measured from.
  let innerRaw: CP[] = []
  const sampleStep = 0.25 * pxMM
  const sample = (ringsSegs: Seg[][]) => {
    innerSegs = ringsSegs.flat()
    innerAt = new Map()
    innerDrawn = []
    let g = 0
    for (const segs of ringsSegs) {
      const ring: Pt2[] = []
      for (const seg of segs) {
        const len = Math.hypot(seg.p1[0] - seg.p0[0], seg.p1[1] - seg.p0[1])
          + (seg.c ? Math.hypot(seg.c[0][0] - seg.p0[0], seg.c[0][1] - seg.p0[1]) + Math.hypot(seg.c[1][0] - seg.p1[0], seg.c[1][1] - seg.p1[1]) : 0)
        // Straight edges too: the 'near' test below finds the inner outline through these
        // samples, and a long straight edge sampled only at its ends looked far away
        // along its whole middle — so the edge beside it was smoothed across it.
        const n = Math.max(seg.c ? 2 : 1, Math.ceil(len / sampleStep))
        for (let i = 0; i <= n; i++) {
          const t = i / n
          const p = segPoint(seg, t)
          const pq: Pt2 = [q4(p[0]), q4(p[1])]
          const k = vkey(pq)
          const list = innerAt.get(k)
          if (list) list.push({ g, t }); else innerAt.set(k, [{ g, t }])
          if (i < n) ring.push(pq)
        }
        g++
      }
      innerDrawn.push(toCP(ring))
    }
  }

  const ds: string[] = []
  const levels: number[] = []
  let specks = 0
  thresholds.forEach((threshold, li) => {
    // dark: shape where lum < threshold, i.e. 255 − lum > 255 − threshold. light: lum ≥ threshold.
    const level = dark ? 255.5 - threshold : threshold - 0.5
    const kept: Pt2[][] = []
    for (const loop of traceIsolines(grid, level)) {
      // traceIsolines closes each loop by repeating its first point.
      const ring = loop.length > 1 && loop[0][0] === loop[loop.length - 1][0] && loop[0][1] === loop[loop.length - 1][1]
        ? loop.slice(0, -1) : loop
      if (Math.abs(ringArea(ring)) < minAreaPx || ring.length < 3) { specks++; continue }
      kept.push(ring)
    }
    if (ds.length + kept.length > MAX_TRACE_LOOPS) {
      throw new Error(`The trace makes over ${MAX_TRACE_LOOPS} outlines — raise Ignore Specks or move the threshold`)
    }

    let ringsSegs: Seg[][]
    if (!multi) {
      let rings = kept.map((ring) => simplifyRing(ring, tolPx)).filter((r) => r.length >= 3).map((r) => r.map(map))
      if (thicken > 0 && rings.length > 0) {
        // Grown in mm, after the speck pass, so a speck is judged at the size it was drawn.
        // Clipper's round joins are dense; thin them to the same tolerance as the trace.
        rings = thickenRings(rings.map(toCP)).map((r) => simplifyRing(fromCP(r), tolMM)).filter((r) => r.length >= 3)
      }
      ringsSegs = rings.map((r) => ringSegments(r, cornerDeg))
    } else {
      const poly = U(kept.map((r) => toCP(r.map(map))), FillRule.EvenOdd)
      if (li === 0) {
        innerRaw = U(poly.map((r) => toCP(simplifyRing(fromCP(r), tolMM))).filter((r) => r.length >= 3), FillRule.EvenOdd)
        let rings = innerRaw.map(fromCP)
        if (thicken > 0 && rings.length > 0) {
          rings = thickenRings(innerRaw).map((r) => simplifyRing(fromCP(r), tolMM)).filter((r) => r.length >= 3)
        }
        ringsSegs = rings.map((r) => ringSegments(r, cornerDeg))
      } else {
        // An outer tone is built FROM the inner one as written, never traced beside it:
        // its own band (tone minus inner, opened so no part is narrower than the bit),
        // united with the inner tone's drawn curves. Every vertex it shares with them is
        // one of their samples, and a run of those is written as the exact piece of the
        // inner curve it follows — so two outlines that coincide are the same curve and
        // cannot cross. Measured from the drawn inner tone, or, when thickening, from the
        // traced one: the band then grows into the thickened inner tone and is lost in it.
        const band = poly.length ? differenceD(poly, thicken > 0 ? innerRaw : innerDrawn, FillRule.NonZero, 4) : []
        const openMM = openPx * pxMM
        // The opening only says WHICH parts of the band survive. Its regrown edge never
        // lands exactly back on the inner tone, so used as it is it leaves a hairline gap
        // all along the shared edge — thousands of slivers in the union. Clipping the
        // band itself to the (slightly enlarged) opening keeps the band's own edge there.
        const opened = openMM > 0
          ? intersectD(band, grow(grow(grow(band, -openMM, 0.01), openMM, 0.01), 0.1 * pxMM, 0.01), FillRule.NonZero, 4)
          : band
        // Measured from the TRACED inner tone: to within a pixel is plenty here, and the
        // drawn one is sampled every quarter pixel, which made this the slowest step.
        const solid = dropHalos(opened, innerRaw, haloPx(s) * pxMM, pxMM)
        innerRaw = U([...poly, ...innerRaw], FillRule.NonZero)
        const grownBand = thicken > 0 && solid.length ? grow(solid, thicken / 2, 0.01) : solid
        let tone = U([...grownBand, ...innerDrawn], FillRule.NonZero)
        // The band's opening shaves the narrow tip off whatever closeTones filled into a V
        // against the inner tone, and the tip came back as a small triangle of the next
        // tone out — at any Smoothing above 0, where the opening is on. So the tone is
        // closed again here, adding only what the closing adds: its edges along the inner
        // tone stay the inner tone's own curves. Not the outermost tone, as in closeTones.
        if (gapMM > 0 && li < thresholds.length - 1 && tone.length) {
          // Closed on a copy simplified to a third of a pixel — the tone as written is
          // sampled every quarter pixel along the inner tone, and closing that took seconds —
          // then measured against the tone itself, so a filled gap's edge along it is exactly
          // its edge. The copy never lies exactly on the tone, so the difference is also a
          // hairline along every edge — round a hole, a whole thin ring — long enough that its
          // area can pass for a gap's. It is told apart by mean width (twice the area over the
          // perimeter, holes and all): the copy strays a third of a pixel at most.
          const rough = tone.map((r) => toCP(simplifyRing(fromCP(r), pxMM / 3))).filter((r) => r.length >= 3)
          const diff = differenceD(grow(grow(rough, gapMM / 2, 0.05 * pxMM), -gapMM / 2, 0.05 * pxMM), tone, FillRule.NonZero, 4)
          const perim = (r: CP) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + Math.hypot(q.x - p.x, q.y - p.y) }, 0)
          const added = toPieces(diff).filter((rings) => {
            const area = rings.reduce((a, r) => a + areaD(r), 0)
            return area > 0 && 2 * area / rings.reduce((a, r) => a + perim(r), 0) > 0.3 * pxMM
          }).flat()
          if (added.length) tone = U([...tone, ...added], FillRule.NonZero)
        }
        // A hole the tone came out with, smaller than a speck, fills — the speck rule, which
        // the loop filter applies only to what is traced: the opening and the boolean steps
        // above leave small gaps of their own where two tones' edges meet a line. Filling
        // only grows this tone, so the tones still nest.
        const minHoleMM2 = params.minSpeckMM * params.minSpeckMM
        tone = tone.filter((r) => { const a = areaD(r); return a > 0 || -a >= minHoleMM2 })
        const lock = new Set(innerAt.keys())
        const cellMM = Math.max(tolMM, 1e-6), hash = new Map<string, Pt2[]>()
        for (const r of innerDrawn) for (const pt of r) {
          const k = `${Math.floor(pt.x / cellMM)},${Math.floor(pt.y / cellMM)}`
          const list = hash.get(k); if (list) list.push([pt.x, pt.y]); else hash.set(k, [[pt.x, pt.y]])
        }
        const near = (p: Pt2) => {
          const cx = Math.floor(p[0] / cellMM), cy = Math.floor(p[1] / cellMM)
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const o of hash.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(o[0] - p[0], o[1] - p[1]) < tolMM) return true
          }
          return false
        }
        const segs = innerSegs, at = innerAt
        ringsSegs = tone.map((r) => simplifyRingLocked(fromCP(r), tolMM, lock, near)).filter((r) => r.length >= 3).map((ring) => {
          const n = ring.length
          const info = ring.map((p) => at.get(vkey(p)))
          // Free edges close to the inner outline keep all their vertices (`near`, in the
          // simplify), so they follow the band's own edge however they are smoothed; shared
          // runs are replaced below by the inner tone's own curve.
          const own = ringSegments(ring, cornerDeg)
          // Consecutive samples of one inner curve make one piece of it, not one piece per
          // sample pair — the shared run is written as the curve it follows.
          const out: Seg[] = []
          let run: { g: number; t0: number; t1: number; p0: Pt2; p1: Pt2 } | null = null
          const flush = () => { if (run) { out.push(segPiece(segs[run.g], run.t0, run.t1, run.p0, run.p1)); run = null } }
          own.forEach((seg, i) => {
            const ia = info[i], ib = info[(i + 1) % n]
            let hit: { g: number; ta: number; tb: number } | null = null
            if (ia && ib) {
              for (const ea of ia) { for (const eb of ib) if (ea.g === eb.g) { hit = { g: ea.g, ta: ea.t, tb: eb.t }; break } if (hit) break }
            }
            if (hit && run && run.g === hit.g && run.t1 === hit.ta && Math.sign(hit.tb - hit.ta) === Math.sign(run.t1 - run.t0)) {
              run.t1 = hit.tb; run.p1 = seg.p1
              return
            }
            flush()
            if (hit) run = { g: hit.g, t0: hit.ta, t1: hit.tb, p0: seg.p0, p1: seg.p1 }
            else out.push(seg)
          })
          flush()
          return out
        })
      }
      sample(ringsSegs)
    }
    // Largest first, so an outline comes before the holes and details inside it.
    const area = (segs: Seg[]) => Math.abs(ringArea(segs.map((g) => g.p0)))
    const order = [...ringsSegs].sort((a, b) => area(b) - area(a))
    for (const segs of order) { ds.push(segsToD(segs, identity)); levels.push(li + 1) }
  })
  return { ds, levels, thresholds, specks }
}

// How far out from the inner tone a piece of a band must reach to be a tone of its own,
// in pixels. Round a dark line on a light ground the picture is never clean: the line's
// anti-aliased edge, and on a JPEG the ringing beside it, are a few pixels of in-between
// brightness hugging the line. Where they cross an outer tone's cut they come out as
// lumps on the line — too wide for the band's opening to shave off, too big for the speck
// filter, and nothing the picture actually shows. They are told apart by WHERE they lie,
// not by their size: a halo sits wholly within a few pixels of the line it hangs off,
// while a real area of that tone (a body's fill, a shadow) reaches out beyond it. Smoothing
// blurs the picture before it is traced, which spreads the halo, so the reach grows with
// it: 4 px at Smoothing 0, 8 px at 100 — on the hippo cartoon the lumps stood 5–6 px off
// the line at 100. The cost is a real area that thin hugging a line, which goes too.
let HALO_BASE_PX = 4
const haloPx = (s: number) => HALO_BASE_PX * (1 + s)

/** For the harnesses only: the reach at Smoothing 0 (it doubles by Smoothing 100). */
export function _setHaloPx(px: number) { HALO_BASE_PX = px }

/** Polygons as PIECES — each outline with its own holes, from Clipper's tree. */
function toPieces(paths: { x: number; y: number }[][]): { x: number; y: number }[][][] {
  const tree = new PolyTreeD()
  const c = new ClipperD(4)
  c.addSubjectPaths(paths)
  c.execute(ClipType.Union, FillRule.NonZero, tree)
  const pieces: { x: number; y: number }[][][] = []
  const walk = (node: PolyPathD) => {
    for (let i = 0; i < node.count; i++) {
      const outer = node.child(i)
      const rings = [outer.poly!]
      for (let j = 0; j < outer.count; j++) { const hole = outer.child(j); rings.push(hole.poly!); walk(hole) }
      pieces.push(rings)
    }
  }
  walk(tree)
  return pieces
}

/**
 * The band's pieces that reach farther than `reachMM` from `inner`, holes and all —
 * every piece lying wholly within that distance of the inner tone is a halo and goes.
 */
function dropHalos(band: { x: number; y: number }[][], inner: { x: number; y: number }[][], reachMM: number, pxMM: number): { x: number; y: number }[][] {
  if (band.length === 0 || reachMM <= 0 || inner.length === 0) return band
  const far = differenceD(band, inflatePathsD(inner, reachMM, JoinType.Round, EndType.Polygon, 2, 4, 0.25 * pxMM), FillRule.NonZero, 4)
  if (far.length === 0) return []
  const pts = (r: { x: number; y: number }[]): Pt2[] => r.map((p) => [p.x, p.y] as Pt2)
  // The band as pieces, so a hole can never be credited to the wrong outline.
  const pieces = toPieces(band)
  // A piece stays if some part of the band beyond the reach lies in it (outline, not holes).
  const marks = far.filter((r) => areaD(r) > 0).map((r) => interiorPoint([pts(r)])).filter((p): p is Pt2 => !!p)
  const inPiece = (rings: { x: number; y: number }[][], p: Pt2) =>
    rings.reduce((ins, r) => ins !== pointInPolygon(p[0], p[1], pts(r)), false)
  return pieces.filter((rings) => marks.some((p) => inPiece(rings, p))).flat()
}

/**
 * The centerline trace: the traced pixels, despeckled, thinned to a skeleton and walked
 * into open paths. Thinning leaves a stub wherever a stroke ends or turns sharply, a few
 * pixels long and roughly half a stroke wide; any branch from an end to a junction
 * shorter than 1.5 × the AVERAGE STROKE WIDTH (ink area over skeleton length) is taken
 * for one and trimmed, and the skeleton walked again so the paths either side of it join
 * up. The skeleton's pixel stair-steps are then averaged out (more passes the higher the
 * smoothing) before the usual simplify — ends held still, so paths still meet at junctions.
 */
function traceCenterlines(T: Float32Array, w: number, h: number, gw: number, level: number,
  minAreaPx: number, tolPx: number, cornerDeg: number | null, map: Mapper, thresholds: number[], smooth: number): TraceResult {
  const relax = (pts: Pt2[], closed: boolean): Pt2[] => {
    let cur = pts
    for (let pass = 0; pass < Math.round(1 + 3 * smooth); pass++) {
      const n = cur.length
      cur = cur.map((p, i) => {
        if (!closed && (i === 0 || i === n - 1)) return p
        const a = cur[(i - 1 + n) % n], b = cur[(i + 1) % n]
        return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4] as Pt2
      })
    }
    return cur
  }
  const mask = new Uint8Array(w * h)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) mask[r * w + c] = T[(r + 1) * gw + c + 1] >= level ? 1 : 0
  const specks = despeckleMask(mask, w, h, minAreaPx)
  let ink = 0
  for (let i = 0; i < mask.length; i++) ink += mask[i]
  thinMask(mask, w, h)
  let skel = 0
  for (let i = 0; i < mask.length; i++) skel += mask[i]
  const strokePx = skel > 0 ? ink / skel : 0

  // Trim stubs: an end-to-junction branch shorter than a stroke width, junction kept.
  const deg = (i: number) => {
    const x = i % w, y = (i - x) / w
    let n = 0
    for (let k = 0; k < 8; k++) {
      const [dx, dy] = N8[k], nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) continue
      if (k & 1) {
        const a = x + dx >= 0 && x + dx < w && mask[y * w + x + dx], b = y + dy >= 0 && y + dy < h && mask[(y + dy) * w + x]
        if (a || b) continue
      }
      n++
    }
    return n
  }
  for (const path of traceSkeleton(mask, w, h)) {
    if (path.closed || path.pts.length >= Math.max(3, 1.5 * strokePx)) continue
    const a = path.pts[0], b = path.pts[path.pts.length - 1]
    const da = deg(a[1] * w + a[0]), db = deg(b[1] * w + b[0])
    if ((da === 1 && db >= 3) || (db === 1 && da >= 3)) {
      const pts = da === 1 ? path.pts.slice(0, -1) : path.pts.slice(1)
      for (const [x, y] of pts) mask[y * w + x] = 0
    }
  }

  const paths = traceSkeleton(mask, w, h)
    // What is left of a speck: a path no longer than the speck size it came from.
    .filter((p) => p.pts.length >= 2 && p.pts.length * p.pts.length >= minAreaPx)
  if (paths.length > MAX_TRACE_LOOPS) {
    throw new Error(`The trace makes over ${MAX_TRACE_LOOPS} lines — raise Ignore Specks or move the threshold`)
  }
  const ds: string[] = []
  for (const p of paths) {
    if (p.closed) {
      const ring = simplifyRing(relax(p.pts, true), tolPx)
      if (ring.length >= 3) ds.push(segsToD(ringSegments(ring.map(map), cornerDeg), (q) => q))
    } else {
      const pts = relax(p.pts, false)
      const keep = new Uint8Array(pts.length)
      keep[0] = 1; keep[pts.length - 1] = 1
      if (pts.length > 2) dp(pts, 0, pts.length - 1, tolPx, keep)
      const line = pts.filter((_, i) => keep[i]).map(map)
      ds.push(segsToD(polylineSegments(line, cornerDeg), (q) => q, false))
    }
  }
  return { ds, levels: ds.map(() => 1), thresholds: thresholds.slice(0, 1), specks }
}
