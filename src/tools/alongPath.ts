// ─── Text along a path ────────────────────────────────────────────────────────
//
// Lays a text object's letters along a guide path — a name round a plaque, the words of a
// seal above and below a circle. Each letter is placed WHOLE (never bent): its centre on the
// baseline goes to the point of the guide its own pen position reaches, turned to the
// guide's direction there. The pen positions are the font's own, kerning included
// (shapes/textGenerator textGlyphRuns), so the letters keep the spacing the Text tool gave
// them, measured along the guide instead of along a straight line.
//
// Two settings decide where the text lands:
//   - SIDE, which side of the line the letters stand: `out` (baseline on the line), `on`
//     (the line through the middle of the capitals) or `in` (cap tops on the line). On a
//     closed guide `out` is outside the shape; on an open one it is above the line.
//   - AT, where along the guide the text sits, 0 to 1. An open guide: 0 starts the text at
//     its left-hand end, 1 finishes it at the right-hand end. A closed guide: the text's
//     middle goes to that fraction of the way round, clockwise from the BOTTOM — so 0.25 is
//     the left, 0.5 the top, 0.75 the right.
// The text is always laid to read left to right, upright: an open guide drawn right to left
// is travelled backwards, and on a closed guide text whose middle falls on the underside
// runs anticlockwise — the bottom half of a seal reads the same way as the top.
//
// Pure: no stores, no fonts. All coordinates CNC mm, Y-up.

import { flattenPath, signedArea, type Pt2 } from '../cam/pathFlattener'
import { parseD, stringifyD, applyMat } from '../importers/svgImporter'

export type AlongSide = 'out' | 'on' | 'in'

export interface AlongPathOptions {
  side: AlongSide
  /** Where along the guide, 0–1 (see the header). */
  at: number
  /** Extra space between letters, mm (negative tightens). */
  spacingMM: number
  /** Clear space between the line and the letters, mm — on whichever side they stand. */
  gapMM: number
  /** Turn each letter to the guide; off, they stay upright and only follow its course. */
  rotate: boolean
}

/** One letter to place: its pen position and advance (mm) and its outline, pen at the origin
 *  and baseline on y = 0 — what textGlyphRuns returns. */
export interface AlongGlyph { x: number; advance: number; d: string }

export interface Guide {
  pts: Pt2[]
  /** Arc length at each point. */
  lens: number[]
  total: number
  closed: boolean
}

/**
 * The guide as a polyline, as `at` measures it. Its first subpath only: a guide is one line.
 * Closed: wound clockwise and started at its bottommost point. Open: first point to last.
 */
export function guideOf(d: string): Guide | null {
  const sub = flattenPath(d, 0.02).find((s) => s.length >= 2)
  if (!sub) return null
  let pts = sub.slice()
  const first = pts[0], last = pts[pts.length - 1]
  const closed = pts.length >= 3 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6
  if (closed) {
    pts.pop()
    // Clockwise is negative area in Y-up.
    if (signedArea(pts) > 0) pts.reverse()
    // Start exactly at the bottom, not at the nearest vertex: a flattened circle has no
    // vertex at its very bottom, and measuring from the nearest one sets the whole word half
    // a millimetre aside.
    const start = extremePoint(pts, [0, -1])
    pts = [...pts.slice(start.after), ...pts.slice(0, start.after)]
    if (Math.hypot(start.p[0] - pts[0][0], start.p[1] - pts[0][1]) > 1e-9) pts.unshift(start.p)
    pts.push(pts[0])
  }
  const lens = [0]
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const total = lens[lens.length - 1]
  if (total < 1e-6) return null
  return { pts, lens, total, closed }
}

/**
 * The furthest point of a closed ring in direction `dir` (the highest for [0, 1]) and the
 * index of the vertex it comes just before. A flat stretch at the extreme gives its middle; a curve gives the peak
 * of the parabola through the extreme vertex and its two neighbours, which on a flattened
 * arc is within a hair of the arc's own top.
 */
function extremePoint(pts: Pt2[], dir: Pt2): { p: Pt2; after: number } {
  const n = pts.length
  const dl = Math.hypot(dir[0], dir[1]) || 1
  const ux = dir[0] / dl, uy = dir[1] / dl
  const along = (p: Pt2) => ux * p[0] + uy * p[1]
  const y = (i: number) => along(pts[((i % n) + n) % n])
  let k = 0
  for (let i = 1; i < n; i++) if (y(i) > y(k)) k = i
  const at = (i: number) => pts[((i % n) + n) % n]
  // A flat top: the run of vertices level with the extreme, and its middle.
  let a = k, b = k
  while (b - a < n - 1 && Math.abs(y(b + 1) - y(k)) < 1e-6) b++
  while (b - a < n - 1 && Math.abs(y(a - 1) - y(k)) < 1e-6) a--
  if (b > a) {
    const pa = at(a), pb = at(b)
    // Middle of the run by length along it (it is straight, at one height).
    const total = Math.hypot(pb[0] - pa[0], pb[1] - pa[1])
    let acc = 0
    for (let i = a; i < b; i++) {
      const p = at(i), q = at(i + 1), l = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (acc + l >= total / 2) {
        const t = (total / 2 - acc) / Math.max(1e-12, l)
        return { p: [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])], after: (((i + 1) % n) + n) % n }
      }
      acc += l
    }
  }
  // A curve: the parabola through the extreme vertex and its neighbours, by arc length.
  const p0 = at(k - 1), p1 = at(k), p2 = at(k + 1)
  const l0 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), l1 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
  // A sharp corner (a rectangle's, picked diagonally) IS the point: the parabola is for the
  // gentle turns of a flattened curve, and across a corner it slides off along an edge.
  const turn = Math.abs(Math.atan2(
    (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]),
    (p1[0] - p0[0]) * (p2[0] - p1[0]) + (p1[1] - p0[1]) * (p2[1] - p1[1])))
  if (turn > Math.PI / 12) return { p: p1, after: (k + 1) % n }
  const y0 = along(p0), y1 = along(p1), y2 = along(p2)
  // Peak of y(s) through (−l0, y0), (0, y1), (l1, y2).
  const denom = l0 * l1 * (l0 + l1)
  const A = denom > 1e-12 ? (l0 * (y2 - y1) + l1 * (y0 - y1)) / denom : 0
  const B = denom > 1e-12 ? (l0 * l0 * (y2 - y1) - l1 * l1 * (y0 - y1)) / denom : 0
  const sPeak = A < -1e-12 ? Math.max(-l0, Math.min(l1, -B / (2 * A))) : 0
  if (sPeak < 0) {
    const t = 1 + sPeak / Math.max(1e-12, l0)
    return { p: [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])], after: k }
  }
  const t = sPeak / Math.max(1e-12, l1)
  return { p: [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])], after: (k + 1) % n }
}

/** The point at arc length `s` — wrapped round a closed guide, and run straight on along the
 *  end segments past the ends of an open one, so text longer than the line still lays out. */
export function pointAt(g: Guide, s: number): Pt2 {
  if (g.closed) s = ((s % g.total) + g.total) % g.total
  const { pts, lens } = g
  if (s <= 0) return extend(pts[0], pts[1], s)
  if (s >= g.total) return extend(pts[pts.length - 1], pts[pts.length - 2], g.total - s)
  let lo = 0, hi = lens.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lens[m] <= s) lo = m; else hi = m }
  const t = (s - lens[lo]) / Math.max(1e-12, lens[hi] - lens[lo])
  return [pts[lo][0] + t * (pts[hi][0] - pts[lo][0]), pts[lo][1] + t * (pts[hi][1] - pts[lo][1])]
}

// Past the end point `a` of a line whose next point in is `b`: `a` moved −by along the
// direction from `b` to `a` (callers pass the overshoot as a negative `by`).
function extend(a: Pt2, b: Pt2, by: number): Pt2 {
  const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy) || 1
  return [a[0] - (dx / l) * by, a[1] - (dy / l) * by]
}

/** Direction of travel at `s`, radians — taken across a short span rather than from the one
 *  segment under `s`, so a flattened curve's facets do not jitter the letters' angles. */
export function angleAt(g: Guide, s: number): number {
  const h = Math.min(1, g.total / 50)
  const a = pointAt(g, s - h), b = pointAt(g, s + h)
  return Math.atan2(b[1] - a[1], b[0] - a[0])
}

/**
 * The letters laid along the guide, as one compound d string. `capMM` is the text's cap
 * height (its font size, which the Text tool states as the cap height) — what `on` and `in`
 * measure the letters by. Null when the guide is no line.
 */
export function layoutAlongPath(glyphs: AlongGlyph[], capMM: number, guideD: string, o: AlongPathOptions): string | null {
  const g = guideOf(guideD)
  if (!g || glyphs.length === 0) return null
  const n = glyphs.length
  const at = Math.max(0, Math.min(1, o.at))
  // Each letter's centre along the text, with the extra spacing after every letter but the last.
  const centres = glyphs.map((gl, i) => gl.x + gl.advance / 2 + i * o.spacingMM)
  const length = glyphs[n - 1].x + glyphs[n - 1].advance + (n - 1) * o.spacingMM
  // Travel backwards to keep the text upright: an open guide drawn right to left; a closed
  // one (wound clockwise) where its middle sits on the underside, heading left.
  let back: boolean
  let sOf: (u: number) => number // distance u along the text → arc length on the guide
  if (g.closed) {
    const sc = at * g.total
    back = Math.cos(angleAt(g, sc)) < -1e-9
    sOf = (u) => sc + (back ? -1 : 1) * (u - length / 2)
  } else {
    back = g.pts[g.pts.length - 1][0] < g.pts[0][0]
    const u0 = at * (g.total - length)
    sOf = (u) => (back ? g.total - (u0 + u) : u0 + u)
  }
  // How far the baseline sits off the line, along the letters' own "up" — left of the way
  // they read. That is above an open line, and outside a closed one travelled clockwise;
  // on a closed one's underside, read left to right, "up" points INTO the shape, so outside
  // there means hanging below the line.
  const up = g.closed && back ? (o.side === 'out' ? 'in' : o.side === 'in' ? 'out' : 'on') : o.side
  const lift = up === 'out' ? o.gapMM : up === 'on' ? -capMM / 2 : -capMM - o.gapMM
  const out: string[] = []
  glyphs.forEach((gl, i) => {
    if (!gl.d.trim()) return
    const s = sOf(centres[i])
    const [px, py] = pointAt(g, s)
    const th = o.rotate ? angleAt(g, s) + (back ? Math.PI : 0) : 0
    const c = Math.cos(th), sn = Math.sin(th)
    // Letter-local (x, y), pen at the origin → (x − advance/2, y + lift) turned by θ, onto P.
    const hx = gl.advance / 2
    const ex = px - c * hx - sn * lift
    const ey = py - sn * hx + c * lift
    out.push(stringifyD(applyMat(parseD(gl.d), [c, sn, -sn, c, ex, ey])))
  })
  return out.join(' ')
}
