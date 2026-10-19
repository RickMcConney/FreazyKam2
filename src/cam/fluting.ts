// ─── Fluting ──────────────────────────────────────────────────────────────────
//
// A centerline carve along a stroke whose DEPTH follows a height profile drawn by the
// user: the classic fluted column or table leg, a groove that swells from nothing at its
// ends to full depth in the middle. The tool rides the path itself (no offset — a V-bit or
// ball nose cutting on its centreline), and only Z changes along it.
//
// The profile is a list of breakpoints over the path's own length:
//
//   t      0 … 1   how far along the path, as a fraction of its length
//   depth  0 … 1   how deep, as a fraction of the operation's depth
//
// so one profile fits every selected path whatever its length, and changing the depth
// scales the whole flute rather than flattening its shape. Between breakpoints the depth is
// either a straight line or a monotone cubic (Fritsch–Carlson), which passes through every
// breakpoint WITHOUT overshooting them — an ordinary cubic spline would carve deeper than
// the deepest point the user set and lift above the surface between two zero points.
//
// Each subpath of a compound path takes the whole profile over its own length. Step-down
// clips the profile at each pass level (the profile below the level, the level where the
// profile is deeper), so no pass removes more than one step anywhere. An open stroke is cut
// there and back, so the tool is already standing where the next pass starts; a closed one
// goes round the same way every time and also ends where it began.

import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import { flattenPath, isOpenSubpath, type Pt2 } from './pathFlattener'
import { zPasses } from './geom'

export interface FluteBreakpoint {
  /** Position along the path, 0 = its start, 1 = its end. */
  t: number
  /** Depth there, as a fraction of the operation's depth: 0 = the surface, 1 = full depth. */
  depth: number
}

export interface FlutingParams {
  depthMM: number
  stepDownMM: number
  profile: FluteBreakpoint[]
  /** Monotone cubic between breakpoints rather than straight lines. */
  smooth: boolean
  /** Run the profile from the path's END: t = 0 sits on its last point. */
  reverse?: boolean
  safeHeightMM?: number
  /** The surface the depths are measured from (0 = stock top). */
  startZMM?: number
}

// Flattening tolerance for the path. The XY of a centreline cut IS the drawn line, so it is
// flattened finer than an offset cut needs; the G-code writer re-fits arcs to constant-Z runs.
const FLATTEN_TOL_MM = 0.02
// Spacing of the extra samples a smooth profile is evaluated at between breakpoints.
const SMOOTH_STEP_MM = 0.5
// 3D thinning tolerance: drops only points a straight move would pass through anyway.
const THIN_TOL_MM = 0.002

/** The breakpoints sorted by t, clamped into the unit square, with ends at t = 0 and t = 1. */
export function normalizeProfile(profile: FluteBreakpoint[]): FluteBreakpoint[] {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
  const pts = profile.map((p) => ({ t: clamp(p.t), depth: clamp(p.depth) })).sort((a, b) => a.t - b.t)
  if (pts.length === 0) return [{ t: 0, depth: 1 }, { t: 1, depth: 1 }]
  if (pts[0].t > 0) pts.unshift({ t: 0, depth: pts[0].depth })
  if (pts[pts.length - 1].t < 1) pts.push({ t: 1, depth: pts[pts.length - 1].depth })
  return pts
}

/**
 * Fritsch–Carlson tangents: the cubic Hermite through these points is monotone on every
 * interval the data is monotone on, so it never leaves the range of its two end values.
 */
function monotoneTangents(pts: FluteBreakpoint[]): number[] {
  const n = pts.length
  const h: number[] = [], delta: number[] = []
  for (let i = 0; i < n - 1; i++) {
    h.push(pts[i + 1].t - pts[i].t)
    delta.push(h[i] > 1e-12 ? (pts[i + 1].depth - pts[i].depth) / h[i] : 0)
  }
  const m = new Array<number>(n).fill(0)
  if (n < 2) return m
  m[0] = delta[0]
  m[n - 1] = delta[n - 2]
  for (let i = 1; i < n - 1; i++) {
    // A peak, a trough or a flat: zero slope, or the curve would bulge past the breakpoint.
    m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2
  }
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / delta[i], b = m[i + 1] / delta[i]
    const s = a * a + b * b
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      m[i] = tau * a * delta[i]
      m[i + 1] = tau * b * delta[i]
    }
  }
  return m
}

/**
 * The depth fraction at `t` (0 … 1) along a profile. `profile` must already be normalized;
 * pass `tangents` from `monotoneTangents` for the smooth curve.
 */
function evalProfile(pts: FluteBreakpoint[], t: number, tangents: number[] | null): number {
  if (t <= pts[0].t) return pts[0].depth
  const n = pts.length
  if (t >= pts[n - 1].t) return pts[n - 1].depth
  let i = 0
  while (i < n - 2 && t > pts[i + 1].t) i++
  const a = pts[i], b = pts[i + 1]
  const h = b.t - a.t
  if (h <= 1e-12) return b.depth
  const u = (t - a.t) / h
  if (!tangents) return a.depth + (b.depth - a.depth) * u
  const u2 = u * u, u3 = u2 * u
  const v = (2 * u3 - 3 * u2 + 1) * a.depth + (u3 - 2 * u2 + u) * h * tangents[i] +
    (-2 * u3 + 3 * u2) * b.depth + (u3 - u2) * h * tangents[i + 1]
  return Math.min(1, Math.max(0, v))
}

/** The depth fraction at `t` along `profile` — what the form's graph draws. */
export function fluteDepthAt(profile: FluteBreakpoint[], t: number, smooth: boolean): number {
  const pts = normalizeProfile(profile)
  return evalProfile(pts, t, smooth ? monotoneTangents(pts) : null)
}

/**
 * `count` breakpoints evenly spaced along the path, each taking the depth the current
 * profile has there — how the form changes the number of breakpoints without throwing away
 * the shape already drawn.
 */
export function resampleProfile(profile: FluteBreakpoint[], count: number, smooth: boolean): FluteBreakpoint[] {
  const n = Math.max(2, Math.round(count))
  const pts = normalizeProfile(profile)
  const tangents = smooth ? monotoneTangents(pts) : null
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    return { t, depth: Math.round(evalProfile(pts, t, tangents) * 1e4) / 1e4 }
  })
}

type Pt3 = [number, number, number]

/** Douglas–Peucker in 3D: keeps every point a straight move between its neighbours would miss. */
function thin3d(pts: Pt3[], tol: number): Pt3[] {
  const n = pts.length
  if (n <= 2) return pts
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  const tol2 = tol * tol
  while (stack.length) {
    const [i0, i1] = stack.pop()!
    const [ax, ay, az] = pts[i0], [bx, by, bz] = pts[i1]
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const len2 = dx * dx + dy * dy + dz * dz
    let worst = -1, worstD = tol2
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py, pz] = pts[i]
      let u = len2 > 1e-20 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2 : 0
      u = Math.max(0, Math.min(1, u))
      const ex = ax + u * dx - px, ey = ay + u * dy - py, ez = az + u * dz - pz
      const d2 = ex * ex + ey * ey + ez * ez
      if (d2 > worstD) { worstD = d2; worst = i }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([i0, worst], [worst, i1]) }
  }
  return pts.filter((_, i) => keep[i])
}

/**
 * The points of one subpath with the full depth (mm, positive down) under each — every
 * drawn vertex, every breakpoint, and for a smooth profile a sample every SMOOTH_STEP_MM.
 */
function sampleSubpath(sub: Pt2[], pts: FluteBreakpoint[], tangents: number[] | null, depthMM: number): { x: number; y: number; d: number }[] {
  const cum = [0]
  for (let i = 1; i < sub.length; i++) cum.push(cum[i - 1] + Math.hypot(sub[i][0] - sub[i - 1][0], sub[i][1] - sub[i - 1][1]))
  const L = cum[cum.length - 1]
  if (L < 1e-6) return []
  const at = new Set<number>(cum)
  for (const p of pts) at.add(p.t * L)
  if (tangents) for (let s = SMOOTH_STEP_MM; s < L; s += SMOOTH_STEP_MM) at.add(s)
  const ss = [...at].sort((a, b) => a - b)
  const out: { x: number; y: number; d: number }[] = []
  let seg = 0
  for (const s of ss) {
    while (seg < sub.length - 2 && s > cum[seg + 1]) seg++
    const len = cum[seg + 1] - cum[seg]
    const u = len > 1e-12 ? Math.min(1, Math.max(0, (s - cum[seg]) / len)) : 0
    const x = sub[seg][0] + (sub[seg + 1][0] - sub[seg][0]) * u
    const y = sub[seg][1] + (sub[seg + 1][1] - sub[seg][1]) * u
    const prev = out[out.length - 1]
    if (prev && Math.hypot(prev.x - x, prev.y - y) < 1e-6) continue
    out.push({ x, y, d: evalProfile(pts, s / L, tangents) * depthMM })
  }
  return out
}

export function generateFluting(d: string, tool: Tool, params: FlutingParams): MotionSegment[] {
  if (tool.type !== 'vbit' && tool.type !== 'taper' && tool.type !== 'ballnose') {
    throw new Error('Fluting needs a V-bit, taper or ball nose — it cuts on the centreline of the path')
  }
  if (!(params.depthMM > 0)) throw new Error('Depth must be greater than zero')
  const safeZ = params.safeHeightMM ?? 5
  const startZ = params.startZMM ?? 0
  const pts = normalizeProfile(params.profile)
  const tangents = params.smooth ? monotoneTangents(pts) : null

  const segs: MotionSegment[] = []
  let at: { x: number; y: number } | null = null
  for (const raw of flattenPath(d, FLATTEN_TOL_MM)) {
    const sub = params.reverse ? [...raw].reverse() : raw
    const open = isOpenSubpath(sub)
    const samples = sampleSubpath(sub, pts, tangents, params.depthMM)
    if (samples.length < 2) continue
    const deepest = Math.max(...samples.map((p) => p.d))
    if (deepest < 1e-4) continue

    // Each pass cuts the profile clipped at its level, so it takes at most one step anywhere.
    const levels = zPasses(deepest, params.stepDownMM).map((z) => -z)
    const passes = levels.map((level, k) => {
      const pass = thin3d(samples.map((p): Pt3 => [p.x, p.y, startZ - Math.min(p.d, level)]), THIN_TOL_MM)
      // There and back on a stroke, so the next pass starts where this one ends.
      return open && k % 2 === 1 ? pass.reverse() : pass
    })

    const [fx, fy, fz] = passes[0][0]
    if (at) segs.push({ x: at.x, y: at.y, z: safeZ, rapid: true })
    segs.push({ x: fx, y: fy, z: safeZ, rapid: true })
    segs.push({ x: fx, y: fy, z: fz, rapid: false })
    let [px, py, pz] = passes[0][0]
    for (const pass of passes) {
      for (const [x, y, z] of pass) {
        const run = Math.hypot(x - px, y - py)
        if (run < 1e-9 && Math.abs(z - pz) < 1e-9) continue
        // Steeper than 45° going down: across level, then straight down, so the writer feeds
        // the descent at the plunge rate. Level at the higher Z can only leave stock.
        if (pz - z > run && run > 1e-9) segs.push({ x, y, z: pz, rapid: false })
        segs.push({ x, y, z, rapid: false })
        px = x; py = y; pz = z
      }
    }
    at = { x: px, y: py }
  }
  if (!at) throw new Error('Nothing to cut — the height profile is at the surface along the whole path')
  segs.push({ x: at.x, y: at.y, z: safeZ, rapid: true })
  return segs
}
