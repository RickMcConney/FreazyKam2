// Adaptive (constant-engagement) clearing — a faithful TypeScript port of FreeCAD's
// Adaptive2d (Kresimir Tusek, LGPL-2.1-or-later). Original: src/Mod/CAM/libarea/Adaptive.cpp
//
// The tool is driven point-by-point ("march"). At every step a steering angle (±45°) is
// found by interpolation so the analytically-measured cut area per unit distance holds at
// a target derived from the requested stepover. Spirals and trochoids emerge from that
// control. Clearing keeps a `cleared` polygon (Clipper booleans/offsets); engage points and
// stay-down links keep the tool down between passes; a helix seeds each region.
//
// This port mirrors the C++ structure and constants. All polygon math runs in an integer
// "scaled" coordinate space (coords = mm * scaleFactor) exactly like the original, using
// clipper2-ts's integer Clipper64 / ClipperOffset in place of ClipperLib (Clipper1).
//
// Differences from the original: the FreeCAD progress-callback / visualization machinery,
// the performance counters, and the DEV_MODE diagnostics are dropped. The cut output
// (AdaptiveOutput.adaptivePaths) is identical in meaning.

import {
  Clipper64,
  ClipperOffset,
  ClipType,
  PathType,
  FillRule,
  PointInPolygonResult,
  JoinType,
  EndType,
  area as clipperArea,
  isPositive,
  pointInPolygon,
  simplifyPaths,
  getBoundsPaths,
} from 'clipper2-ts'
import type { Point64, Paths64 } from 'clipper2-ts'
import { TileRaster } from './tileRaster.js'

// ─── Types ───────────────────────────────────────────────────────────────────────
// IntPoint coords are integers in scaled space; DoublePoint is an unscaled direction/vec.
type IntPoint = Point64 // { x, y, z? }
interface DoublePoint { x: number; y: number }
type Path = IntPoint[]
type Paths = Path[]

export const MotionType = {
  Cutting: 0,
  LinkClear: 1,
  LinkNotClear: 2,
  LinkClearAtPrevPass: 3,
  // Not in the original: a mid-region helix re-entry. pts = [center, rimPoint] (rim is the
  // first cut point; |rim-center| = helix radius). The consumer lifts and helix-ramps here.
  Helix: 4,
} as const

export const OperationType = {
  ClearingInside: 0,
  ClearingOutside: 1,
  ProfilingInside: 2,
  ProfilingOutside: 3,
} as const
export type OperationTypeValue = (typeof OperationType)[keyof typeof OperationType]

/** One emitted toolpath segment in real (unscaled) mm. `motion` is a MotionType value. */
export interface TPath { motion: number; pts: Array<[number, number]> }

export interface AdaptiveOutput {
  helixCenter: [number, number]
  startPoint: [number, number]
  adaptivePaths: TPath[]
  returnMotionType: number
  clearedArea: number
  startPointNotFound: boolean
  leadPathFailed: boolean
  tooManyFailedEngagements: boolean
  unclearedAreaRemains: boolean
  failedToSetUpFinishingPass: boolean
  finishingLeadInFailed: boolean
}

/** Input geometry: array of polygons, each an array of [x,y] in real mm. */
export type DPaths = Array<Array<[number, number]>>

// ─── Constants (from Adaptive.hpp) ─────────────────────────────────────────────────
const NTOL = 1.0e-7
const SAME_POINT_TOL_SQRD_SCALED = 4.0
const LONG_MAX = 2147483647
const DBL_MAX = Number.MAX_VALUE

const MIN_STEP_CLIPPER = 16.0 * 3
const MAX_ITERATIONS = 30
// Probe baseline for raster engagement: measure cut area over ≥ this distance (≈6 cells) so the
// count is low-noise even when the actual march step is tiny (during turns). Encapsulated in
// CalcCutArea — measure ahead at the probe, scale back to the real step — so iterateNextStep is
// untouched. (= the probe-step decoupling.)
const RASTER_PROBE_MIN = 5 * MIN_STEP_CLIPPER
// …but a fixed multiple of MIN_STEP_CLIPPER doesn't scale with the tool: scaleFactor freezes once
// stepOverFactor·toolDiameter ≥ 1 (the min(1,…) clamp in Execute), so for big tools the cell/probe
// stay fixed while the radius keeps growing — fewer probe-lengths averaged per radius → a noisier
// engagement metric → ±45° steering hunts → jitter (visible scalloping on a 6 mm bit). Floor the
// probe at a fixed fraction of the tool radius so probe/toolR is constant across tool sizes. 0.20
// matched the clean 3 mm baseline but the 6 mm still hunted; 0.30 averages ~50% more frontier per
// engagement sample and quiets it (a longer probe = more low-pass on the metric).
const RASTER_PROBE_TOOL_FRAC = 0.30
// Cross-check the raster engagement against the analytic on real runs (ADV_RASTER_AUDIT=1).
const RASTER_AUDIT = !!(globalThis as { process?: { env?: Record<string, string> } }).process?.env?.ADV_RASTER_AUDIT
const gRasterAudit = { n: 0, sumAbsErr: 0, maxErr: 0 }

// ─── Profiling (wall-clock per bucket; on by default, set Adaptive2d.profiling=false to silence) ─
let gProfEnabled = true
const gProf: Record<string, { calls: number; ms: number }> = {}
const _now = (): number => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
function profReset(): void { for (const k of Object.keys(gProf)) delete gProf[k] }
function profAdd(name: string, ms: number): void { const e = gProf[name] ?? (gProf[name] = { calls: 0, ms: 0 }); e.calls++; e.ms += ms }
function prof<T>(name: string, fn: () => T): T {
  if (!gProfEnabled) return fn()
  const t0 = _now(); try { return fn() } finally { profAdd(name, _now() - t0) }
}
function profReport(label: string, totalMs: number): void {
  if (!gProfEnabled) return
  const rows = Object.entries(gProf).sort((a, b) => b[1].ms - a[1].ms)
  let out = `[adv-prof] ${label} — total ${totalMs.toFixed(1)} ms (buckets may nest)\n`
  out += '  ' + 'bucket'.padEnd(22) + 'calls'.padStart(10) + 'total ms'.padStart(12) + 'avg µs'.padStart(12) + '       %\n'
  for (const [name, e] of rows) {
    const pct = totalMs > 0 ? 100 * e.ms / totalMs : 0
    out += '  ' + name.padEnd(22) + String(e.calls).padStart(10) + e.ms.toFixed(1).padStart(12)
      + (e.calls ? 1000 * e.ms / e.calls : 0).toFixed(1).padStart(12) + (pct.toFixed(1) + '%').padStart(9) + '\n'
  }
  console.log(out)
}

const AREA_ERROR_FACTOR = 0.05
const ANGLE_HISTORY_POINTS = 3
const DIRECTION_SMOOTHING_BUFLEN = 3
const CLEAN_PATH_TOLERANCE = 1.415
const FINISHING_CLEAN_PATH_TOLERANCE = 1.415
const FINISHING_THICKNESS_SCALE = 1 / 10
const PASSES_LIMIT = LONG_MAX
const POINTS_PER_PASS_LIMIT = LONG_MAX

// ─── Clipper1-compat thin wrappers over clipper2-ts ─────────────────────────────────
// Clipper1's Clipper::Execute defaults to EvenOdd fill, so do the same here.

function trunc(v: number): number { return Math.trunc(v) }

// Perf knobs (set per-run in Execute, in scaled units). clipper2-ts is far slower than the
// native ClipperLib the algorithm was written against, so two things that were free in C++
// must be tamed here: round-join offsets explode into thousands of arc points on large
// scaled radii (capped by gArcTol), and the accumulating `cleared` polygon bloats unless
// simplified each union (gClearSimplify ≈ 0.02 mm, per the porting notes).
let gArcTol = 0
let gClearSimplify = 1.415

// Diagnostics — silent unless ADV_DEBUG env is set (so never noisy in the browser).
const ADV_DEBUG = !!(globalThis as { process?: { env?: Record<string, string> } }).process?.env?.ADV_DEBUG
const gDbg = { leadCap: 0, resolveTimeout: 0, marches: 0, zeroMarches: 0 }
function dbgLog(...a: unknown[]): void { if (ADV_DEBUG) console.error('[adv]', ...a) }

function Orientation(p: Path): boolean { return isPositive(p) }
function Area(p: Path): number { return clipperArea(p) }

// In-place reverse (matches ClipperLib::ReversePath semantics).
function ReversePath(p: Path): void { p.reverse() }
function ReversePaths(ps: Paths): void { for (const p of ps) p.reverse() }

// ClipperLib::PointInPolygon returns 0 (outside), -1 (on edge), +1 (inside).
function PointInPolygon(pt: IntPoint, poly: Path): number {
  const r = pointInPolygon({ x: pt.x, y: pt.y }, poly)
  if (r === PointInPolygonResult.IsOutside) return 0
  if (r === PointInPolygonResult.IsOn) return -1
  return 1
}

const CLIP_NAME: Record<number, string> = {
  [ClipType.Union]: 'clip.union', [ClipType.Difference]: 'clip.diff', [ClipType.Intersection]: 'clip.intersect', [ClipType.Xor]: 'clip.xor',
}
function clipBoolean(ct: ClipType, subjects: Paths, clips: Paths | null): Paths {
  return prof(CLIP_NAME[ct] ?? 'clip.other', () => {
    const c = new Clipper64()
    if (subjects.length) c.addPaths(subjects, PathType.Subject)
    if (clips && clips.length) c.addPaths(clips, PathType.Clip)
    const sol: Paths64 = []
    c.execute(ct, FillRule.EvenOdd, sol)
    return sol
  })
}

function offsetPaths(paths: Paths, delta: number, jt: JoinType, et: EndType): Paths {
  if (!paths.length) return []
  return prof('offset', () => {
    const co = new ClipperOffset(2, gArcTol)
    co.addPaths(paths, jt, et)
    const sol: Paths64 = []
    co.execute(delta, sol)
    return sol
  })
}
function offsetPath(path: Path, delta: number, jt: JoinType, et: EndType): Paths {
  return prof('offset', () => {
    const co = new ClipperOffset(2, gArcTol)
    co.addPath(path, jt, et)
    const sol: Paths64 = []
    co.execute(delta, sol)
    return sol
  })
}

// SimplifyPolygons: resolve self-intersections (Clipper1 used an EvenOdd self-union).
function SimplifyPolygons(paths: Paths): Paths {
  if (!paths.length) return []
  return clipBoolean(ClipType.Union, paths, null)
}
// CleanPolygon(s): remove near-collinear / near-coincident vertices. Clipper2 dropped
// CleanPolygon; RamerDouglasPeucker with the same distance is the faithful analog.
function CleanPolygons(paths: Paths, dist = 1.415): Paths {
  return prof('cleanPolygons', () => simplifyPaths(paths, dist, true))
}

// ─── Geometry utils ─────────────────────────────────────────────────────────────────

function DistanceSqrd(p1: IntPoint, p2: IntPoint): number {
  const dx = p1.x - p2.x, dy = p1.y - p2.y
  return dx * dx + dy * dy
}

function averageDV(vec: number[]): number {
  if (vec.length === 0) return 0
  let s = 0
  for (const v of vec) s += v
  return s / vec.length
}

function rotate(inp: DoublePoint, rad: number): DoublePoint {
  const c = Math.cos(rad), s = Math.sin(rad)
  return { x: c * inp.x - s * inp.y, y: s * inp.x + c * inp.y }
}

function PathLength(path: Path): number {
  let len = 0
  if (path.length < 2) return len
  for (let i = 1; i < path.length; i++) len += Math.sqrt(DistanceSqrd(path[i - 1], path[i]))
  return len
}

function DirectionV(p1: IntPoint, p2: IntPoint): DoublePoint {
  const dx = p2.x - p1.x, dy = p2.y - p1.y
  const l = Math.sqrt(dx * dx + dy * dy)
  if (l < NTOL) return { x: 0, y: 0 }
  return { x: dx / l, y: dy / l }
}

function NormalizeV(pt: DoublePoint): void {
  const len = Math.sqrt(pt.x * pt.x + pt.y * pt.y)
  if (len > NTOL) { pt.x /= len; pt.y /= len }
}

function GetPathDirectionV(pth: Path, pointIndex: number): DoublePoint {
  if (pth.length < 2) return { x: 0, y: 0 }
  const p1 = pth[pointIndex > 0 ? pointIndex - 1 : pth.length - 1]
  const p2 = pth[pointIndex]
  return DirectionV(p1, p2)
}

function isClose(a: IntPoint, b: IntPoint): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
}

function filterCloseValues(ppg: Paths): void {
  for (const pth of ppg) {
    for (let i = 0; i + 1 < pth.length; ) {
      if (isClose(pth[i], pth[i + 1])) pth.splice(i, 1)
      else i++
    }
    while (pth.length > 1 && isClose(pth[0], pth[pth.length - 1])) pth.pop()
  }
}

function AverageDirection(unityVectors: DoublePoint[]): DoublePoint {
  const out = { x: 0, y: 0 }
  for (const v of unityVectors) { out.x += v.x; out.y += v.y }
  const magnitude = Math.sqrt(out.x * out.x + out.y * out.y)
  if (magnitude > NTOL) { out.x /= magnitude; out.y /= magnitude }
  return out
}

interface ClosestResult { distSq: number; clp: IntPoint; pathIndex: number; segIndex: number; parameter: number }

function DistancePointToLineSegSquared(
  p1: IntPoint, p2: IntPoint, pt: IntPoint, clamp = true,
): { distSq: number; closest: IntPoint; parameter: number } {
  const D21X = p2.x - p1.x, D21Y = p2.y - p1.y
  const DP1X = pt.x - p1.x, DP1Y = pt.y - p1.y
  const lsegLenSqr = D21X * D21X + D21Y * D21Y
  if (lsegLenSqr === 0) return { distSq: DP1X * DP1X + DP1Y * DP1Y, closest: { x: p1.x, y: p1.y }, parameter: 0 }
  let parameter = DP1X * D21X + DP1Y * D21Y
  if (clamp) {
    if (parameter < 0) parameter = 0
    else if (parameter > lsegLenSqr) parameter = lsegLenSqr
  }
  const ptParameter = parameter / lsegLenSqr
  const closest: IntPoint = { x: trunc(p1.x + ptParameter * D21X), y: trunc(p1.y + ptParameter * D21Y) }
  const dx = pt.x - closest.x, dy = pt.y - closest.y
  return { distSq: dx * dx + dy * dy, closest, parameter: ptParameter }
}

function DistancePointToPathsSqrd(paths: Paths, pt: IntPoint): ClosestResult {
  let minDistSq = DBL_MAX
  const res: ClosestResult = { distSq: minDistSq, clp: { x: 0, y: 0 }, pathIndex: 0, segIndex: 0, parameter: 0 }
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]
    const size = path.length
    for (let j = 0; j < size; j++) {
      const r = DistancePointToLineSegSquared(path[j > 0 ? j - 1 : size - 1], path[j], pt)
      if (r.distSq < minDistSq) {
        minDistSq = r.distSq
        res.distSq = r.distSq; res.clp = r.closest; res.pathIndex = i; res.segIndex = j; res.parameter = r.parameter
      }
    }
  }
  return res
}

function ScaleUpPaths(paths: Paths, f: number): void { for (const p of paths) for (const pt of p) { pt.x *= f; pt.y *= f } }
function ScaleDownPaths(paths: Paths, f: number): void { for (const p of paths) for (const pt of p) { pt.x = trunc(pt.x / f); pt.y = trunc(pt.y / f) } }

function getPathNestingLevel(point: IntPoint, paths: Paths): number {
  let nesting = 0
  for (const other of paths) {
    if (other.length && PointInPolygon(point, other) !== 0) nesting++
  }
  return nesting
}
function getPathNestingLevelP(path: Path, paths: Paths): number {
  if (!path.length) return 0
  return getPathNestingLevel(path[0], paths)
}

function CleanPath(inp: Path, tolerance: number): Path {
  if (inp.length < 3) return inp.map(p => ({ x: p.x, y: p.y, z: p.z }))
  const tmp = CleanPolygons([inp], tolerance)[0] ?? []
  const size = tmp.length
  if (size <= 2) return [{ x: inp[0].x, y: inp[0].y }, { x: inp[inp.length - 1].x, y: inp[inp.length - 1].y }]

  const r = DistancePointToPathsSqrd([tmp], inp[0])
  const out: Path = []
  if (DistanceSqrd(r.clp, tmp[r.segIndex]) > 0
    && DistanceSqrd(r.clp, tmp[r.segIndex > 0 ? r.segIndex - 1 : size - 1]) > 0) {
    out.push({ x: r.clp.x, y: r.clp.y })
  }
  for (let i = 0; i < size; i++) {
    let index = r.segIndex + i
    if (index >= size) index -= size
    out.push({ x: tmp[index].x, y: tmp[index].y })
  }
  if (DistanceSqrd(out[0], inp[0]) > SAME_POINT_TOL_SQRD_SCALED) out.unshift({ x: inp[0].x, y: inp[0].y })
  if (DistanceSqrd(out[out.length - 1], inp[inp.length - 1]) > SAME_POINT_TOL_SQRD_SCALED) out.push({ x: inp[inp.length - 1].x, y: inp[inp.length - 1].y })
  return out
}

function Circle2CircleIntersect(c1: IntPoint, c2: IntPoint, radius: number): { first: DoublePoint; second: DoublePoint } | null {
  const DX = c2.x - c1.x, DY = c2.y - c1.y
  const d = Math.sqrt(DX * DX + DY * DY)
  if (d < NTOL) return null
  if (d >= radius) return null
  const a_2 = Math.sqrt(4 * radius * radius - d * d) / 2.0
  return {
    first: { x: 0.5 * (c1.x + c2.x) - DY * a_2 / d, y: 0.5 * (c1.y + c2.y) + DX * a_2 / d },
    second: { x: 0.5 * (c1.x + c2.x) + DY * a_2 / d, y: 0.5 * (c1.y + c2.y) - DX * a_2 / d },
  }
}

function Line2CircleIntersect(c: DoublePoint, radius: number, p1: DoublePoint, p2: DoublePoint, clamp = true): DoublePoint[] {
  const dx = p2.x - p1.x, dy = p2.y - p1.y
  const lcx = p1.x - c.x, lcy = p1.y - c.y
  const a = dx * dx + dy * dy
  const b = 2 * dx * lcx + 2 * dy * lcy
  const C = lcx * lcx + lcy * lcy - radius * radius
  let sq = b * b - 4 * a * C
  if (sq < 0) return []
  sq = Math.sqrt(sq)
  const t1 = (-b - sq) / (2 * a)
  const t2 = (-b + sq) / (2 * a)
  const result: DoublePoint[] = []
  if ((t1 >= 0.0 && t1 <= 1.0) || !clamp) result.push({ x: p1.x + t1 * dx, y: p1.y + t1 * dy })
  if ((t2 >= 0.0 && t2 <= 1.0) || !clamp) result.push({ x: p1.x + t2 * dx, y: p1.y + t2 * dy })
  return result
}

function Compute2DPolygonCentroid(vertices: Path): IntPoint {
  let cx = 0, cy = 0, signedArea = 0
  const size = vertices.length
  for (let i = 0; i < size; i++) {
    const x0 = vertices[i].x, y0 = vertices[i].y
    const x1 = vertices[(i + 1) % size].x, y1 = vertices[(i + 1) % size].y
    const a = x0 * y1 - x1 * y0
    signedArea += a
    cx += (x0 + x1) * a
    cy += (y0 + y1) * a
  }
  signedArea *= 0.5
  cx /= 6.0 * signedArea
  cy /= 6.0 * signedArea
  return { x: trunc(cx), y: trunc(cy) }
}

function IsPointWithinCutRegion(toolBoundPaths: Paths, point: IntPoint): boolean {
  let inside = false
  for (const p of toolBoundPaths) if (PointInPolygon(point, p) !== 0) inside = !inside
  return inside
}

// Segment/segment intersection (for self-intersection rejection in link resolving).
function IntersectionPointSeg(s1p1: IntPoint, s1p2: IntPoint, s2p1: IntPoint, s2p2: IntPoint): IntPoint | null {
  const S1DX = s1p2.x - s1p1.x, S1DY = s1p2.y - s1p1.y
  const S2DX = s2p2.x - s2p1.x, S2DY = s2p2.y - s2p1.y
  const d = S1DY * S2DX - S2DY * S1DX
  if (Math.abs(d) < NTOL) return null
  const LPDX = s1p1.x - s2p1.x, LPDY = s1p1.y - s2p1.y
  const p1d = S2DY * LPDX - S2DX * LPDY
  const p2d = S1DY * LPDX - S1DX * LPDY
  if (d < 0 && (p1d < d || p1d > 0 || p2d < d || p2d > 0)) return null
  if (d > 0 && (p1d < 0 || p1d > d || p2d < 0 || p2d > d)) return null
  const t = p1d / d
  return { x: trunc(s1p1.x + S1DX * t), y: trunc(s1p1.y + S1DY * t) }
}

function SmoothPaths(paths: Paths, stepSize: number, pointCount: number, iterations: number): void {
  // Copy every point first. ScaleUpPaths mutates point objects in place; callers share point
  // object references with these paths (e.g. an engage point also held as toolPos), so without
  // this the up-scaling would corrupt those external objects (the downscale only touches the
  // rebuilt result arrays). In the C++ original IntPoint is a value type, so this can't happen.
  for (let i = 0; i < paths.length; i++) paths[i] = paths[i].map(p => ({ x: p.x, y: p.y }))
  const output: Paths = paths.map(() => [])
  const scale = 1000
  const stepScaled = stepSize * scale
  ScaleUpPaths(paths, scale)
  const points: Array<[number, IntPoint]> = []
  for (let i = 0; i < paths.length; i++) {
    for (const pt of paths[i]) {
      if (points.length === 0) { points.push([i, { x: pt.x, y: pt.y }]); continue }
      const back = points[points.length - 1]
      const lastPt = back[1]
      const l = Math.sqrt(DistanceSqrd(lastPt, pt))
      if (l < 0.5 * stepScaled) {
        if (points.length > 1) points.pop()
        points.push([i, { x: pt.x, y: pt.y }])
        continue
      }
      const lastPathIndex = back[0]
      const steps = Math.max(trunc(l / stepScaled), 1)
      const left = pointCount * iterations * 2
      const right = steps - pointCount * iterations * 2
      for (let idx = 0; idx <= steps; idx++) {
        if (idx > left && idx < right) { idx = right; continue }
        const p = idx / steps
        const ptx: IntPoint = { x: trunc(lastPt.x + (pt.x - lastPt.x) * p), y: trunc(lastPt.y + (pt.y - lastPt.y) * p) }
        if (idx === 0 && DistanceSqrd(back[1], ptx) < scale && points.length > 1) points.pop()
        if (p < 0.5) points.push([lastPathIndex, ptx])
        else points.push([i, ptx])
      }
    }
  }
  if (points.length === 0) { ScaleDownPaths(paths, scale); return }
  const size = points.length
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 1; i < size - 1; i++) {
      const cp = points[i][1]
      let ax = cp.x, ay = cp.y, cnt = 1
      let ptsToAverage = pointCount
      if (i <= ptsToAverage) ptsToAverage = Math.max(i - 1, 0)
      else if (i + ptsToAverage >= size - 1) ptsToAverage = size - 1 - i
      for (let j = i - ptsToAverage; j <= i + ptsToAverage; j++) {
        if (j === i) continue
        let index = j
        if (index < 0) index = 0
        if (index >= size) index = size - 1
        ax += points[index][1].x; ay += points[index][1].y; cnt++
      }
      cp.x = trunc(ax / cnt); cp.y = trunc(ay / cnt)
    }
  }
  for (const pr of points) output[pr[0]].push(pr[1])
  for (let i = 0; i < paths.length; i++) {
    const cleaned = CleanPath(output[i], 1.4 * scale)
    paths[i] = cleaned
  }
  ScaleDownPaths(paths, scale)
}

function PopPathWithClosestPoint(paths: Paths, p1: IntPoint, extraDistanceAround = 0): Path | null {
  if (paths.length === 0) return null
  let minDistSqrd = DBL_MAX, closestPathIndex = 0, closestPointIndex = 0
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const path = paths[pathIndex]
    for (let i = 0; i < path.length; i++) {
      const dist = DistanceSqrd(p1, path[i])
      if (dist < minDistSqrd) { minDistSqrd = dist; closestPathIndex = pathIndex; closestPointIndex = i }
    }
  }
  const closestPath = paths[closestPathIndex]
  while (extraDistanceAround > 0) {
    const nexti = (closestPointIndex + 1) % closestPath.length
    extraDistanceAround -= Math.sqrt(DistanceSqrd(closestPath[closestPointIndex], closestPath[nexti]))
    closestPointIndex = nexti
  }
  const result: Path = []
  for (let i = 0; i < closestPath.length; i++) {
    const index = (closestPointIndex + i) % closestPath.length
    result.push({ x: closestPath[index].x, y: closestPath[index].y })
  }
  paths.splice(closestPathIndex, 1)
  return result
}

function DeduplicatePaths(inputs: Paths): Paths {
  const outputs: Paths = []
  for (const newPth of inputs) {
    let duplicate = false
    for (const oldPth of outputs) {
      let allExist = true
      for (const pt1 of newPth) {
        let exists = false
        for (const pt2 of oldPth) { if (DistanceSqrd(pt1, pt2) < SAME_POINT_TOL_SQRD_SCALED) { exists = true; break } }
        if (!exists) { allExist = false; break }
      }
      if (allExist) { duplicate = true; break }
    }
    if (!duplicate && newPth.length) outputs.push(newPth)
  }
  return outputs
}

function ConnectPaths(input: Paths): Paths {
  input = input.map(p => p.slice())
  const output: Paths = []
  let newPath = true
  let joined: Path = []
  while (input.length) {
    if (newPath) {
      if (joined.length) output.push(joined)
      joined = input[0].slice()
      input.shift()
      newPath = false
    }
    let anyMatch = false
    for (let i = 0; i < input.length; i++) {
      const n = input[i]
      const jb = joined[joined.length - 1], jf = joined[0]
      if (DistanceSqrd(n[0], jb) < SAME_POINT_TOL_SQRD_SCALED) {
        for (const pt of n) joined.push(pt)
        input.splice(i, 1); anyMatch = true; break
      } else if (DistanceSqrd(n[n.length - 1], jb) < SAME_POINT_TOL_SQRD_SCALED) {
        n.reverse(); for (const pt of n) joined.push(pt)
        input.splice(i, 1); anyMatch = true; break
      } else if (DistanceSqrd(n[0], jf) < SAME_POINT_TOL_SQRD_SCALED) {
        for (const pt of n) joined.unshift(pt)
        input.splice(i, 1); anyMatch = true; break
      } else if (DistanceSqrd(n[n.length - 1], jf) < SAME_POINT_TOL_SQRD_SCALED) {
        n.reverse(); for (const pt of n) joined.unshift(pt)
        input.splice(i, 1); anyMatch = true; break
      }
    }
    if (!anyMatch) newPath = true
  }
  if (joined.length) output.push(joined)
  return output
}

// ─── BoundBox ───────────────────────────────────────────────────────────────────────
class BoundBox {
  minX = 0; maxX = 0; minY = 0; maxY = 0
  setFirstPoint(p: IntPoint): void { this.minX = p.x; this.maxX = p.x; this.minY = p.y; this.maxY = p.y }
  addPoint(pt: IntPoint): void {
    this.minX = Math.min(pt.x, this.minX); this.maxX = Math.max(pt.x, this.maxX)
    this.minY = Math.min(pt.y, this.minY); this.maxY = Math.max(pt.y, this.maxY)
  }
  setCircle(center: IntPoint, radius: number): void {
    this.minX = center.x - radius; this.maxX = center.x + radius
    this.minY = center.y - radius; this.maxY = center.y + radius
  }
  collidesWith(bb2: BoundBox): boolean {
    return this.minX <= bb2.maxX && this.maxX >= bb2.minX && this.minY <= bb2.maxY && this.maxY >= bb2.minY
  }
  contains(bb2: BoundBox): boolean {
    return this.minX <= bb2.minX && this.maxX >= bb2.maxX && this.minY <= bb2.minY && this.maxY >= bb2.maxY
  }
}

// ─── Cleared-area model (bounded query + incremental union) ──────────────────────────
class ClearedArea {
  private clearedPaths: Paths = []
  private clearedBoundedWindow: Paths = []
  private clearedBoundedClipped: Paths = []
  private toolRadiusScaled: number
  private clearedBBWindow = new BoundBox()
  private clearedBBClippedInFocus = new BoundBox()
  private bboxClippedInvalid = false
  private clearedBoundedWindowScale = 10
  // The raster is now the source of truth for the cleared region. expandCleared/addClearedDisk just
  // mark it (O(footprint)); getCleared() materializes the polygon on demand via toContours (O(frontier),
  // cached) for the remaining polygon consumers (engage-point generation, finishing, fallbacks).
  // seedPaths holds any non-swept initial cleared region passed to setClearedPaths (empty for pockets).
  private raster: TileRaster | null
  private seedPaths: Paths = []
  private clearedDirty = true

  constructor(toolRadiusScaled: number, raster: TileRaster | null = null) {
    this.toolRadiusScaled = toolRadiusScaled
    this.raster = raster
  }

  get hasRaster(): boolean { return this.raster !== null }
  rasterArea(): number { return this.raster ? this.raster.area() : 0 }  // total cut area, scaled²
  rasterCutArea(c1: IntPoint, c2: IntPoint): [number, number] { return prof('raster.cutArea', () => this.raster!.cutArea(c1, c2)) }
  rasterIsClearPath(tp: Path, rad: number): boolean { return prof('raster.isClearPath', () => this.raster!.isClearPath(tp, rad)) }
  rasterIsCleared(p: IntPoint): boolean { return this.raster!.isCleared(p.x, p.y) }
  // Largest r ≤ maxR with disk(p,r) fully cut (how deep p sits in cleared). For routing heuristics.
  rasterClearedDepth(p: IntPoint, maxR: number): number {
    if (!this.raster) return 0
    let lo = 0, hi = Math.trunc(maxR)
    while (lo < hi) { const m = Math.trunc((lo + hi + 1) / 2); if (this.raster.isClearPath([p], m)) lo = m; else hi = m - 1 }
    return lo
  }
  rasterDeepestUncut(inside: (x: number, y: number) => boolean): { x: number; y: number; depth: number } | null {
    return this.raster ? prof('raster.deepest', () => this.raster!.deepestUncutTile(inside)) : null
  }
  rasterNearestDeepCleared(p: IntPoint): IntPoint | null {
    const r = this.raster?.nearestFullTile(p.x, p.y)
    return r ? { x: trunc(r.x), y: trunc(r.y) } : null
  }
  // p is ≥ rad deep inside cleared ⟺ the disk(p,rad) is fully cut ⟺ isClearPath([p], rad).
  rasterDeepInside(p: IntPoint, rad: number): boolean { return prof('raster.isClearPath', () => this.raster!.isClearPath([p], rad)) }
  rasterMark(path: Path): void { if (this.raster) prof('raster.mark', () => this.raster!.mark(path, this.toolRadiusScaled)) }

  // Cheap raster-only clone for the lead-path scratch (the only caller, MakeLeadPath, is raster-only
  // and never reads the polygon, so we skip copying it).
  clone(): ClearedArea {
    return new ClearedArea(this.toolRadiusScaled, this.raster ? this.raster.clone() : null)
  }

  setClearedPaths(paths: Paths): void {
    // Non-swept initial cleared region. Raster-backed: kept as a seed unioned into getCleared() and
    // (for membership/engagement to see it) marked into the raster. Empty in the common pocket case.
    this.seedPaths = paths.map(p => p.map(pt => ({ x: pt.x, y: pt.y })))
    if (!this.raster) { this.clearedPaths = this.seedPaths }
    this.clearedDirty = true
    this.bboxClippedInvalid = true
  }

  addClearedPaths(paths: Paths): void {
    this.clearedPaths = clipBoolean(ClipType.Union, this.clearedPaths, paths)
    this.clearedPaths = CleanPolygons(this.clearedPaths, gClearSimplify)
    this.bboxClippedInvalid = true
  }

  // Helix bore: a disk of `radius` at `center`. Raster-backed: just stamp it (the polygon is
  // re-derived on demand); polygon path keeps the diskPaths union as a fallback.
  addClearedDisk(diskPaths: Paths, center: IntPoint, radius: number): void {
    if (this.raster) { this.raster.markStamp(center.x, center.y, radius); this.clearedDirty = true; return }
    this.clearedPaths = clipBoolean(ClipType.Union, this.clearedPaths, diskPaths)
    this.clearedPaths = CleanPolygons(this.clearedPaths, gClearSimplify)
    this.bboxClippedInvalid = true
  }

  expandCleared(toClearToolPath: Path): void {
    if (toClearToolPath.length === 0) return
    if (this.raster) { prof('raster.mark', () => this.raster!.mark(toClearToolPath, this.toolRadiusScaled)); this.clearedDirty = true; return }
    const toolCoverPoly = offsetPath(toClearToolPath, this.toolRadiusScaled + 1, JoinType.Round, EndType.Round)
    this.clearedPaths = clipBoolean(ClipType.Union, this.clearedPaths, toolCoverPoly)
    this.clearedPaths = CleanPolygons(this.clearedPaths, gClearSimplify)
    this.bboxClippedInvalid = true
  }

  getBoundedClearedAreaClipped(toolPos: IntPoint, delta: number): Paths {
    const toolBB = new BoundBox(); toolBB.setCircle(toolPos, delta)
    if (!this.bboxClippedInvalid && this.clearedBBClippedInFocus.contains(toolBB)) return this.clearedBoundedClipped

    if (this.bboxClippedInvalid || !this.clearedBBWindow.contains(toolBB)) {
      const deltaWindow = delta * this.clearedBoundedWindowScale
      this.clearedBBWindow.setFirstPoint({ x: toolPos.x - deltaWindow, y: toolPos.y - deltaWindow })
      this.clearedBBWindow.addPoint({ x: toolPos.x + deltaWindow, y: toolPos.y + deltaWindow })
      const bbPath: Path = [
        { x: toolPos.x - deltaWindow, y: toolPos.y - deltaWindow },
        { x: toolPos.x + deltaWindow, y: toolPos.y - deltaWindow },
        { x: toolPos.x + deltaWindow, y: toolPos.y + deltaWindow },
        { x: toolPos.x - deltaWindow, y: toolPos.y + deltaWindow },
      ]
      this.clearedBoundedWindow = clipBoolean(ClipType.Intersection, [bbPath], this.clearedPaths)
    }

    this.clearedBBClippedInFocus.setFirstPoint({ x: toolPos.x - delta, y: toolPos.y - delta })
    this.clearedBBClippedInFocus.addPoint({ x: toolPos.x + delta, y: toolPos.y + delta })
    const bbPath: Path = [
      { x: toolPos.x - delta, y: toolPos.y - delta },
      { x: toolPos.x + delta, y: toolPos.y - delta },
      { x: toolPos.x + delta, y: toolPos.y + delta },
      { x: toolPos.x - delta, y: toolPos.y + delta },
    ]
    this.clearedBoundedClipped = clipBoolean(ClipType.Intersection, [bbPath], this.clearedBoundedWindow)
    this.bboxClippedInvalid = false
    return this.clearedBoundedClipped
  }

  getCleared(): Paths {
    if (this.raster) {
      if (this.clearedDirty) {
        let c = prof('contour', () => this.raster!.toContours()) as Paths
        // Collapse the cell-staircase (~cell amplitude) to the true boundary so downstream offsets
        // operate on a low-vertex polygon, not thousands of staircase corners.
        c = CleanPolygons(c, this.raster.cell * 2)
        if (this.seedPaths.length) c = clipBoolean(ClipType.Union, c, this.seedPaths)
        this.clearedPaths = c
        this.clearedDirty = false
      }
      return this.clearedPaths
    }
    return this.clearedPaths
  }
}

// ─── Linear interpolation: area-error vs steering angle ──────────────────────────────
interface InterpItem { angleFirst: number; angleSecond: IntPoint; error: number; isConventional: boolean }

class Interpolation {
  readonly MIN_ANGLE = -Math.PI / 4
  readonly MAX_ANGLE = Math.PI / 4
  m_min: InterpItem | null = null
  m_max: InterpItem | null = null

  clear(): void { this.m_min = null; this.m_max = null }

  bothSides(): boolean {
    return !!this.m_min && !!this.m_max && this.m_min.error < 0 && this.m_max.error >= 0
      && (!this.m_min.isConventional || !this.m_max.isConventional)
  }

  addPoint(error: number, angleFirst: number, angleSecond: IntPoint, allowSkip: boolean, isConventional: boolean): void {
    const newItem: InterpItem = { angleFirst, angleSecond, error, isConventional }
    if (!this.m_min) {
      this.m_min = newItem
    } else if (!this.m_max) {
      this.m_max = newItem
      if (this.m_min.error > this.m_max.error) { const t = this.m_min; this.m_min = this.m_max; this.m_max = t }
    } else if (isConventional && (this.m_min.isConventional !== this.m_max.isConventional)) {
      if (!allowSkip) {
        if (this.m_min.isConventional) this.m_min = null; else this.m_max = null
        this.addPoint(error, angleFirst, angleSecond, false, isConventional)
      }
    } else if (this.bothSides()) {
      if (error < 0) this.m_min = newItem; else this.m_max = newItem
    } else {
      if (allowSkip && Math.abs(error) > Math.abs(this.m_min.error) && Math.abs(error) > Math.abs(this.m_max.error)
        && (isConventional || !this.m_min.isConventional || !this.m_max.isConventional)) return
      if (this.m_min.isConventional !== this.m_max.isConventional) {
        if (this.m_min.isConventional) this.m_min = null; else this.m_max = null
      } else if (Math.abs(this.m_min.error) > Math.abs(this.m_max.error)) this.m_min = null
      else this.m_max = null
      this.addPoint(error, angleFirst, angleSecond, false, isConventional)
    }
  }

  interpolateAngle(): number {
    if (!this.m_min) return this.MIN_ANGLE
    if (!this.m_max) return this.MAX_ANGLE
    let p = (0 - this.m_min.error) / (this.m_max.error - this.m_min.error)
    const minInterp = 0.2
    p = Math.max(Math.min(p, 1 - minInterp), minInterp)
    return this.m_min.angleFirst * (1 - p) + this.m_max.angleFirst * p
  }

  clampAngle(angle: number): number { return Math.max(Math.min(angle, this.MAX_ANGLE), this.MIN_ANGLE) }
}

// ─── PathIntersectArea ───────────────────────────────────────────────────────────────
// Intersect the (to-be-closed) subject ring with area `obj`, preserving orientation and the
// connectivity through the closing point. Uses Clipper z-fill to track original vertex order.
function PathIntersectArea(subject: Path, obj: Paths): Paths {
  const subj = subject.map(p => ({ x: p.x, y: p.y, z: 0 }))
  subj.push({ x: subj[0].x, y: subj[0].y, z: 0 })
  for (let i = 0; i < subj.length; i++) subj[i].z = i * 2 + 1
  const clip = obj.map(path => path.map(p => ({ x: p.x, y: p.y, z: 0 })))

  const c = new Clipper64()
  c.zCallback = (e1b: Point64, e1t: Point64, e2b: Point64, e2t: Point64, p: Point64) => {
    if ((e1b.z ?? 0) !== 0 && (e1t.z ?? 0) !== 0) p.z = ((e1b.z ?? 0) + (e1t.z ?? 0)) / 2
    else if ((e2b.z ?? 0) !== 0 && (e2t.z ?? 0) !== 0) p.z = ((e2b.z ?? 0) + (e2t.z ?? 0)) / 2
  }
  c.addOpenSubject([subj])
  c.addPaths(clip, PathType.Clip)
  const closed: Paths64 = []
  const open: Paths64 = []
  c.execute(ClipType.Intersection, FillRule.NonZero, closed, open)
  const diff = open

  // restore orientation
  for (const p of diff) {
    for (let i = 0; i < p.length - 1; i++) {
      const zi = p[i].z ?? 0, zj = p[i + 1].z ?? 0
      if (zi !== 0 && zj !== 0) {
        if (zi + 1 !== zj && zi + 2 !== zj) p.reverse()
        break
      }
    }
  }

  const zstart = 1
  const zend = subj.length * 2 - 1
  let start: Path | null = null, end: Path | null = null
  const result: Paths = []
  for (const p of diff) {
    if ((p[0].z ?? 0) === zstart) start = p
    else if ((p[p.length - 1].z ?? 0) === zend) end = p
    else result.push(p)
  }
  if (start && end) {
    const joined = end.slice()
    for (let i = 1; i < start.length; i++) joined.push(start[i])
    result.push(joined)
  } else {
    if (start) result.push(start)
    if (end) result.push(end)
  }
  return result
}

// ─── The adaptive engine ─────────────────────────────────────────────────────────────
interface IterateNextStepOutput {
  iterationAngle?: number
  tooManyIterations: boolean
  failed: boolean
  area: number
  errorFraction: number
  newToolPos: IntPoint
  newToolDir: DoublePoint
}

export interface Adaptive2dConfig {
  toolDiameter?: number
  helixRampTargetDiameter?: number
  helixRampMinDiameter?: number
  stepOverFactor?: number
  tolerance?: number
  stockToLeave?: number
  forceInsideOut?: boolean
  finishingProfile?: boolean
  keepToolDownDistRatio?: number
  opType?: OperationTypeValue
  profiling?: boolean
}

export class Adaptive2d {
  toolDiameter = 5
  helixRampTargetDiameter = 0
  helixRampMinDiameter = 0
  stepOverFactor = 0.2
  tolerance = 0.1
  stockToLeave = 0
  forceInsideOut = true
  finishingProfile = true
  keepToolDownDistRatio = 3.0
  opType: OperationTypeValue = OperationType.ClearingInside
  profiling = true

  private results: AdaptiveOutput[] = []
  private inputPaths: Paths = []
  private stockInputPaths: Paths = []
  private scaleFactor = 100
  private stepOverScaled = 1
  private toolRadiusScaled = 10
  private finishPassOffsetScaled = 0
  private helixRampMaxRadiusScaled = 0
  private helixRampMinRadiusScaled = 0
  private referenceCutArea = 0
  private optimalCutAreaPD = 0
  private current_region = 0

  constructor(cfg: Adaptive2dConfig = {}) { Object.assign(this, cfg) }

  // Engagement metric. Raster path (main cleared): probe ahead ≥ RASTER_PROBE_MIN so the cell count
  // is low-noise even for tiny steps, then scale the area back to the real step → iterateNextStep is
  // unchanged. Falls back to the analytic when there's no raster (the lead-path / before-pass copies).
  private CalcCutArea(c1in: IntPoint, c2in: IntPoint, clearedArea: ClearedArea): [number, number] {
    if (clearedArea.hasRaster) {
      const dx = c2in.x - c1in.x, dy = c2in.y - c1in.y
      const stepLen = Math.sqrt(dx * dx + dy * dy)
      if (stepLen < NTOL) return [0, 0]
      const probeLen = Math.max(stepLen, RASTER_PROBE_MIN, this.toolRadiusScaled * RASTER_PROBE_TOOL_FRAC)
      const ext = probeLen / stepLen
      const probeC2: IntPoint = { x: trunc(c1in.x + dx * ext), y: trunc(c1in.y + dy * ext) }
      const [a, cv] = clearedArea.rasterCutArea(c1in, probeC2)
      const scale = stepLen / probeLen
      const res: [number, number] = [a * scale, cv * scale]
      if (RASTER_AUDIT) {
        const ana = this.calcCutAreaAnalytic(c1in, c2in, clearedArea)
        const err = Math.abs(res[0] - ana[0]) / (1 + Math.abs(ana[0]))
        gRasterAudit.n++; gRasterAudit.sumAbsErr += err; if (err > gRasterAudit.maxErr) gRasterAudit.maxErr = err
      }
      return res
    }
    return this.calcCutAreaAnalytic(c1in, c2in, clearedArea)
  }

  // ── Analytic cut-area measurement (the original engagement metric) ─────────────────
  private calcCutAreaAnalytic(c1in: IntPoint, c2in: IntPoint, clearedArea: ClearedArea): [number, number] {
    let c1: IntPoint = { x: c1in.x, y: c1in.y }
    let c2: IntPoint = { x: c2in.x, y: c2in.y }
    const dist = Math.sqrt(DistanceSqrd(c1, c2))
    if (dist < NTOL) return [0, 0]
    const R = this.toolRadiusScaled

    let polygons: DoublePoint[][] = []
    const c2BB = new BoundBox(); c2BB.setCircle(c2, R)
    const useC2 = dist > 2 * R
    const clearedBounded = clearedArea.getBoundedClearedAreaClipped(useC2 ? c2 : c1, R + (useC2 ? 0 : trunc(dist)) + 4)

    for (const path of clearedBounded) {
      if (path.length === 0) continue
      const pathBB = new BoundBox(); pathBB.setFirstPoint(path[0])
      for (const pt of path) pathBB.addPoint(pt)
      if (!pathBB.collidesWith(c2BB)) continue
      polygons.push(path.map(p => ({ x: p.x, y: p.y })))
    }

    // rotate so c1->c2 points +Y
    {
      const angle = Math.PI / 2 - Math.atan2(c2.y - c1.y, c2.x - c1.x)
      const ca = Math.cos(angle), sa = Math.sin(angle)
      c1 = { x: trunc(ca * c1.x - sa * c1.y), y: trunc(sa * c1.x + ca * c1.y) }
      c2 = { x: trunc(ca * c2.x - sa * c2.y), y: trunc(sa * c2.x + ca * c2.y) }
      polygons = polygons.map(pg => pg.map(p => ({ x: ca * p.x - sa * p.y, y: sa * p.x + ca * p.y })))
    }

    const xs: number[] = []
    for (const polygon of polygons) {
      for (const p of polygon) xs.push(p.x)
      for (let i = 0; i < polygon.length; i++) {
        const p0 = polygon[i], p1 = polygon[(i + 1) % polygon.length]
        for (const p of Line2CircleIntersect(c1, R, p0, p1)) xs.push(p.x)
        for (const p of Line2CircleIntersect(c2, R, p0, p1)) xs.push(p.x)
      }
    }
    {
      const res = Circle2CircleIntersect(c1, c2, R)
      if (res) { xs.push(res.first.x); xs.push(res.second.x) }
    }
    xs.push(c1.x - R); xs.push(c1.x + R)
    const xmin = c2.x - R, xmax = c2.x + R
    xs.push(xmin); xs.push(xmax); xs.push(c2.x)

    const xsf = xs.filter(x => xmin <= x && x <= xmax).sort((a, b) => a - b)

    const interpX = (p0: DoublePoint, p1: DoublePoint, x: number): number => {
      const interp = (x - p0.x) / (p1.x - p0.x)
      return p1.y * interp + p0.y * (1 - interp)
    }

    const circles: DoublePoint[] = [c2, c1]
    let area = 0, conventionalArea = 0
    for (let ix = 0; ix + 1 < xsf.length; ix++) {
      const x0 = xsf[ix], x1 = xsf[ix + 1]
      if (x0 === x1) continue
      const xtest = (x0 + x1) / 2

      const ys: Array<[number, number, number]> = [] // y, shapeIndex, part
      for (let ip = 0; ip < polygons.length; ip++) {
        const polygon = polygons[ip]
        for (let ie = 0; ie < polygon.length; ie++) {
          const p0 = polygon[ie], p1 = polygon[(ie + 1) % polygon.length]
          if (Math.min(p0.x, p1.x) < xtest && Math.max(p0.x, p1.x) > xtest) ys.push([interpX(p0, p1, xtest), ip, ie])
        }
      }
      for (let ic = 0; ic < circles.length; ic++) {
        const c = circles[ic]
        const dx = Math.abs(xtest - c.x)
        if (dx < R) {
          const dy = Math.sqrt(R * R - dx * dx)
          ys.push([c.y + dy, polygons.length + ic, 0])
          ys.push([c.y - dy, polygons.length + ic, 1])
        }
      }
      ys.sort((a, b) => a[0] - b[0])

      const outside: boolean[] = []
      for (let i = 0; i < polygons.length + circles.length; i++) outside.push(i === polygons.length)
      let outsideCount = 1
      for (const [, ishape, ipart] of ys) {
        const prevOutside = outside[ishape]
        const prevCount = outsideCount
        outside[ishape] = !outside[ishape]
        outsideCount += prevOutside ? -1 : 1
        const entranceExitSign = prevOutside ? -1 : 1

        if (outsideCount === 0 || prevCount === 0) {
          if (ishape < polygons.length) {
            const polygon = polygons[ishape]
            const p0 = polygon[ipart], p1 = polygon[(ipart + 1) % polygon.length]
            const y0 = interpX(p0, p1, x0), y1 = interpX(p0, p1, x1)
            const newArea = (y0 + y1) / 2 * (x1 - x0)
            area += entranceExitSign * newArea
            if (xtest < c2.x) conventionalArea += entranceExitSign * newArea
          } else {
            const c = circles[ishape - polygons.length]
            const circleSign = ipart === 0 ? 1 : -1
            const clamp = (a: number) => Math.max(-1, Math.min(1, a))
            const phi0 = Math.acos(clamp((x0 - c.x) / R)) * circleSign
            const phi1 = Math.acos(clamp((x1 - c.x) / R)) * circleSign
            const areaSector = R * R / 2 * Math.abs(phi1 - phi0)
            const y0 = c.y + circleSign * Math.sqrt(R * R - (x0 - c.x) * (x0 - c.x))
            const y1 = c.y + circleSign * Math.sqrt(R * R - (x1 - c.x) * (x1 - c.x))
            const tbase = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0))
            const tmidx = (x0 + x1) / 2, tmidy = (y0 + y1) / 2
            const th = Math.sqrt((tmidx - c.x) * (tmidx - c.x) + (tmidy - c.y) * (tmidy - c.y))
            const areaTriangle = tbase * th / 2
            const areaSegment = areaSector - areaTriangle
            const areaTrapezoid = (x1 - x0) * (y0 + y1) / 2
            const newArea = circleSign * areaSegment + areaTrapezoid
            area += entranceExitSign * newArea
            if (xtest < c2.x) conventionalArea += entranceExitSign * newArea
          }
        }
      }
    }
    return [area, conventionalArea]
  }

  private ApplyStockToLeave(inputPaths: Paths): Paths {
    if (this.stockToLeave > NTOL) {
      const outside = this.opType === OperationType.ClearingOutside || this.opType === OperationType.ProfilingOutside
      return offsetPaths(inputPaths, (outside ? 1 : -1) * this.stockToLeave * this.scaleFactor, JoinType.Round, EndType.Polygon)
    }
    // fix for clipper glitches: shrink then grow by 1
    let r = offsetPaths(inputPaths, -1, JoinType.Round, EndType.Polygon)
    filterCloseValues(r)
    r = offsetPaths(r, 1, JoinType.Round, EndType.Polygon)
    filterCloseValues(r)
    return r
  }

  Execute(stockPaths: DPaths, paths: DPaths, clearedPaths: DPaths): AdaptiveOutput[] {
    gProfEnabled = this.profiling
    profReset()
    const tExec0 = _now()
    this.results = []
    this.tolerance = Math.max(this.tolerance, 0.01)
    this.tolerance = Math.min(this.tolerance, 1.0)
    this.scaleFactor = MIN_STEP_CLIPPER / this.tolerance / Math.min(1.0, this.stepOverFactor * this.toolDiameter)
    this.current_region = 0
    gArcTol = this.scaleFactor * 0.01
    gClearSimplify = this.scaleFactor * 0.02
    gDbg.leadCap = 0; gDbg.resolveTimeout = 0; gDbg.marches = 0; gDbg.zeroMarches = 0

    this.toolRadiusScaled = trunc(this.toolDiameter * this.scaleFactor / 2)
    this.stepOverScaled = this.toolRadiusScaled * this.stepOverFactor

    if (this.helixRampTargetDiameter < NTOL) this.helixRampTargetDiameter = this.toolDiameter
    this.helixRampTargetDiameter = Math.min(this.helixRampTargetDiameter, this.toolDiameter)
    this.helixRampMinDiameter = Math.max(this.helixRampMinDiameter, this.toolDiameter / 8)
    this.helixRampTargetDiameter = Math.max(this.helixRampTargetDiameter, this.helixRampMinDiameter)
    this.helixRampMaxRadiusScaled = trunc(this.helixRampTargetDiameter * this.scaleFactor / 2)
    this.helixRampMinRadiusScaled = trunc(this.helixRampMinDiameter * this.scaleFactor / 2)
    this.finishPassOffsetScaled = this.finishingProfile ? trunc(this.stepOverScaled * FINISHING_THICKNESS_SCALE) : 0

    // tool shape + reference cut area
    const toolGeometryPaths = offsetPath([{ x: 0, y: 0 }], this.toolRadiusScaled, JoinType.Round, EndType.Round)
    const slotCut = toolGeometryPaths[0].map(p => ({ x: p.x + trunc(this.toolRadiusScaled / 2), y: p.y }))
    const crossing = clipBoolean(ClipType.Difference, [toolGeometryPaths[0]], [slotCut])
    this.referenceCutArea = Math.abs(Area(crossing[0]))
    this.optimalCutAreaPD = 2 * this.stepOverFactor * this.referenceCutArea / this.toolRadiusScaled

    // convert input paths to scaled integer clipper paths
    const converted: Paths = []
    for (const pth of paths) {
      const cpth: Path = pth.map(([x, y]) => ({ x: trunc(x * this.scaleFactor), y: trunc(y * this.scaleFactor) }))
      converted.push(CleanPath(cpth, FINISHING_CLEAN_PATH_TOLERANCE))
    }
    this.inputPaths = DeduplicatePaths(converted)
    this.inputPaths = ConnectPaths(this.inputPaths)
    this.inputPaths = SimplifyPolygons(this.inputPaths)
    this.inputPaths = this.ApplyStockToLeave(this.inputPaths)

    this.stockInputPaths = stockPaths.map(sp => sp.map(([x, y]) => ({ x: trunc(x * this.scaleFactor), y: trunc(y * this.scaleFactor) })))
    let initialClearedPaths: Paths = clearedPaths.map(cp => cp.map(([x, y]) => ({ x: trunc(x * this.scaleFactor), y: trunc(y * this.scaleFactor) })))
    initialClearedPaths = SimplifyPolygons(initialClearedPaths)
    this.stockInputPaths = SimplifyPolygons(this.stockInputPaths)

    // 1) outer clearing: add stock to inputs
    if (this.opType === OperationType.ClearingOutside) for (const p of this.stockInputPaths) this.inputPaths.push(p)

    // 2) fix input orientation by nesting parity
    for (const p of this.inputPaths) {
      const nesting = getPathNestingLevelP(p, this.inputPaths)
      if (((nesting % 2 === 1) ? 1 : 0) ^ (Orientation(p) ? 1 : 0)) ReversePath(p)
    }

    // 3) tag inputs Z=1 (need finishing)
    for (const path of this.inputPaths) for (const p of path) p.z = 1

    // 4) profiling: turn profiles into areas (Z=0 for new offset paths)
    if (this.opType === OperationType.ProfilingOutside || this.opType === OperationType.ProfilingInside) {
      let offset = 2 * (this.toolRadiusScaled + this.helixRampMaxRadiusScaled + this.finishPassOffsetScaled) + MIN_STEP_CLIPPER
      if (this.opType === OperationType.ProfilingInside) offset = -offset
      let fullPaths: Paths = []
      for (const path of this.inputPaths) {
        const offsetPathsR = offsetPath(path, offset, JoinType.Round, EndType.Polygon)
        if ((Orientation(path) ? 1 : 0) ^ (offset > 0 ? 1 : 0)) ReversePath(path)
        const clipInput: Paths = [path]
        for (const op of offsetPathsR) {
          for (const p of op) p.z = 0
          if ((Orientation(op) ? 1 : 0) ^ (offset < 0 ? 1 : 0)) ReversePath(op)
          clipInput.push(op)
        }
        fullPaths = clipBoolean(ClipType.Union, fullPaths, clipInput)
      }
      this.inputPaths = fullPaths
    }

    // 5) allow outside stock
    if (!this.forceInsideOut) {
      const stockRev = offsetPaths(this.stockInputPaths, -2, JoinType.Round, EndType.Polygon)
      ReversePaths(stockRev)
      const overshootDistance = 4 * this.toolRadiusScaled + this.stockToLeave * this.scaleFactor
      let outsideOfStock = offsetPaths(this.stockInputPaths, overshootDistance, JoinType.Square, EndType.Polygon)
      this.inputPaths = clipBoolean(ClipType.Union, this.inputPaths, [...stockRev, ...outsideOfStock])
      outsideOfStock = offsetPaths(this.stockInputPaths, 100 * this.toolRadiusScaled, JoinType.Square, EndType.Polygon)
      initialClearedPaths = clipBoolean(ClipType.Union, initialClearedPaths, [...stockRev, ...outsideOfStock])
    }

    // 6) toolBounds = offset(inputs, -(toolR+finish)) per-curve to preserve Z
    const toolBounds: Paths = []
    for (const path of this.inputPaths) {
      const orientation = Orientation(path)
      const direction = getPathNestingLevelP(path, this.inputPaths) % 2 === 1 ? 1 : -1
      const z1 = path.some(p => p.z === 1)
      const out = offsetPath(path, -(this.toolRadiusScaled + this.finishPassOffsetScaled) * direction, JoinType.Round, EndType.Polygon)
      for (const p of out) {
        if (Orientation(p) !== orientation) ReversePath(p)
        if (z1) for (const pp of p) pp.z = 1
        toolBounds.push(p)
      }
    }

    // 7) loop over connected components (exterior boundaries)
    for (const current of toolBounds) {
      const nesting = getPathNestingLevelP(current, toolBounds)
      if (nesting % 2 === 0) continue
      const currentTBP: Paths = [current]
      for (const other of toolBounds) {
        if (other === current) continue
        if (PointInPolygon(other[0], current) !== 0 && getPathNestingLevelP(other, toolBounds) === nesting + 1) currentTBP.push(other)
      }

      // 8) finishing pass
      const finishingPass: Paths = []
      for (const path of currentTBP) {
        const orientation = Orientation(path)
        const direction = getPathNestingLevelP(path, toolBounds) % 2 === 1 ? 1 : -1
        if (!path.some(p => p.z === 1)) continue
        const out = offsetPath(path, this.finishPassOffsetScaled * direction, JoinType.Round, EndType.Polygon)
        for (const p of out) { if (Orientation(p) !== orientation) ReversePath(p); finishingPass.push(p) }
      }

      // 9) bounds = offset(currentTBP, toolR-3)
      const boundPath = offsetPaths(currentTBP, this.toolRadiusScaled - 3, JoinType.Round, EndType.Polygon)

      // skip if fully cleared already
      const boundsToClear = clipBoolean(ClipType.Difference, boundPath, initialClearedPaths)
      if (!boundsToClear.length) continue

      // 10) core
      this.ProcessPolyNode(boundPath, currentTBP, finishingPass, initialClearedPaths)
    }

    if (RASTER_AUDIT && gRasterAudit.n > 0) {
      console.log(`[raster-audit] CalcCutArea raster-vs-analytic: n=${gRasterAudit.n} `
        + `meanErr=${(100 * gRasterAudit.sumAbsErr / gRasterAudit.n).toFixed(2)}% maxErr=${(100 * gRasterAudit.maxErr).toFixed(1)}%`)
    }
    profReport('Execute', _now() - tExec0)
    return this.results
  }

  // Refine a tile-quantized deepest-uncut seed to cell resolution. rasterDeepestUncut returns a
  // tile CENTRE (≈1.6 mm grid, and the grid's alignment shifts with toolR via the raster origin),
  // so a helix otherwise lands up to ±½-tile off the true pocket centre — and differently for a
  // 3 mm vs a 6 mm bit. Local hill-climb that maximises clearance from the region wall (boundPaths,
  // which already includes islands as separate loops) while staying inside the uncut cut-region.
  private refineEntryPoint(p: IntPoint, boundPaths: Paths, toolBoundPaths: Paths, cleared: ClearedArea): IntPoint {
    let best: IntPoint = { x: p.x, y: p.y }
    let bestD = DistancePointToPathsSqrd(boundPaths, best).distSq
    const accept = (c: IntPoint): boolean =>
      IsPointWithinCutRegion(toolBoundPaths, c) && (!cleared.hasRaster || !cleared.rasterIsCleared(c))
    for (let step = trunc(this.toolRadiusScaled); step >= MIN_STEP_CLIPPER; step = trunc(step / 2)) {
      let improved = true
      while (improved) {
        improved = false
        for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
          const c: IntPoint = { x: best.x + dx, y: best.y + dy }
          if (!accept(c)) continue
          const d = DistancePointToPathsSqrd(boundPaths, c).distSq
          if (d > bestD) { bestD = d; best = c; improved = true }
        }
      }
    }
    return best
  }

  private FindEntryPoint(
    toolBoundPaths: Paths, boundPaths: Paths, cleared: ClearedArea, output: AdaptiveOutput,
    minHelixRadiusScaled = this.helixRampMinRadiusScaled,
    flagNotFound = true,
  ): { entryPoint: IntPoint; toolPos: IntPoint; toolDir: DoublePoint; helixRadiusScaled: number } | null {
    let found = false
    let entryPoint: IntPoint = { x: 0, y: 0 }
    let helixRadiusScaled = minHelixRadiusScaled

    const checkHelixFit = (testR: number): { fits: boolean; clearedPaths: Paths } => {
      let clearedPaths = offsetPath(entryPoint ? [entryPoint] : [], testR + this.toolRadiusScaled, JoinType.Round, EndType.Round)
      clearedPaths = CleanPolygons(clearedPaths)
      const crossing = clipBoolean(ClipType.Difference, clearedPaths, boundPaths)
      return { fits: crossing.length === 0, clearedPaths }
    }

    const tryEntry = (): void => {
      if (!checkHelixFit(minHelixRadiusScaled).fits) { found = false; return }
      let minSize = minHelixRadiusScaled
      let maxSize = Math.max(this.helixRampMaxRadiusScaled, minHelixRadiusScaled)
      while (minSize < maxSize) {
        const testSize = Math.trunc((minSize + maxSize + 1) / 2)
        if (checkHelixFit(testSize).fits) minSize = testSize
        else maxSize = testSize - 1
      }
      helixRadiusScaled = minSize
      const fit = checkHelixFit(helixRadiusScaled)
      cleared.addClearedDisk(fit.clearedPaths, entryPoint, helixRadiusScaled + this.toolRadiusScaled)
      found = true
    }

    if (cleared.hasRaster) {
      // Deepest uncut point off the live raster (replaces the Difference + inward-offset loop);
      // wall-fit binary search (vs boundPaths input) sizes the helix.
      const deepest = cleared.rasterDeepestUncut((x, y) => IsPointWithinCutRegion(toolBoundPaths, { x: trunc(x), y: trunc(y) }))
      if (deepest) {
        entryPoint = this.refineEntryPoint({ x: trunc(deepest.x), y: trunc(deepest.y) }, boundPaths, toolBoundPaths, cleared)
        tryEntry()
      }
    } else {
      let checkPaths = clipBoolean(ClipType.Difference, toolBoundPaths, cleared.getCleared())
      for (let iter = 0; iter < 10; iter++) {
        const step = MIN_STEP_CLIPPER
        let currentDelta = -1
        let lastValidOffset: Paths = []
        let incOffset = offsetPaths(checkPaths, currentDelta, JoinType.Square, EndType.Polygon)
        while (incOffset.length) {
          incOffset = offsetPaths(checkPaths, currentDelta, JoinType.Square, EndType.Polygon)
          if (incOffset.length) lastValidOffset = incOffset
          currentDelta -= step
        }
        found = false
        for (const lv of lastValidOffset) { if (lv.length) { entryPoint = Compute2DPolygonCentroid(lv); found = true; break } }
        for (let j = 0; j < checkPaths.length; j++) {
          const pip = PointInPolygon(entryPoint, checkPaths[j])
          if ((j === 0 && pip === 0) || (j > 0 && pip !== 0)) { found = false; break }
        }
        if (found) tryEntry()
        if (!found) {
          const bounds = getBoundsPaths(checkPaths)
          const rect: Path = [
            { x: bounds.left, y: bounds.bottom },
            { x: bounds.left, y: trunc((bounds.top + bounds.bottom) / 2) },
            { x: trunc((bounds.left + bounds.right) / 2), y: trunc((bounds.top + bounds.bottom) / 2) },
            { x: trunc((bounds.left + bounds.right) / 2), y: bounds.bottom },
          ]
          checkPaths = clipBoolean(ClipType.Intersection, [rect], checkPaths)
        }
        if (found) break
      }
    }

    if (!found) { if (flagNotFound) output.startPointNotFound = true; return null }
    const toolPos: IntPoint = { x: entryPoint.x, y: entryPoint.y - helixRadiusScaled }
    const toolDir: DoublePoint = { x: 1.0, y: 0.0 }
    return { entryPoint, toolPos, toolDir, helixRadiusScaled }
  }

  // Find a helix seed in whatever stock is still uncut, working directly off the cut-tracking
  // model. Unlike FindEntryPoint (which assumes one connected boundary+holes region), this copes
  // with the disjoint leftover patches that partial clearing produces. Returns the deepest point
  // of the remaining stock with a fitting helix (radius capped at toolR → no centre plug), or null
  // if nothing with an inscribed radius ≥ minInscribedScaled remains. Commits the bore to cleared.
  private findHelixSeed(
    boundPaths: Paths, toolBoundPaths: Paths, cleared: ClearedArea, minInscribedScaled: number,
  ): { entryPoint: IntPoint; toolPos: IntPoint; toolDir: DoublePoint; helixRadiusScaled: number } | null {
    // Deepest remaining uncut point = pole of inaccessibility. From the live raster when available
    // (replaces the Difference(toolBounds, cleared) + inward-offset loop); coarse tile-level location
    // is fine since the wall-fit binary search below sizes the helix precisely against boundPaths.
    let entryPoint: IntPoint
    if (cleared.hasRaster) {
      const deepest = cleared.rasterDeepestUncut((x, y) => IsPointWithinCutRegion(toolBoundPaths, { x: trunc(x), y: trunc(y) }))
      if (!deepest || deepest.depth < minInscribedScaled) return null
      entryPoint = this.refineEntryPoint({ x: trunc(deepest.x), y: trunc(deepest.y) }, boundPaths, toolBoundPaths, cleared)
    } else {
      const uncut = clipBoolean(ClipType.Difference, toolBoundPaths, cleared.getCleared())
      if (!uncut.length) return null
      const step = Math.max(MIN_STEP_CLIPPER, this.toolRadiusScaled / 2)
      let lastValid = uncut, depth = 0
      for (let delta = -step; ; delta -= step) { const o = offsetPaths(uncut, delta, JoinType.Round, EndType.Polygon); if (!o.length) break; lastValid = o; depth = -delta }
      if (depth < minInscribedScaled) return null
      let best = lastValid[0], bestArea = -1
      for (const p of lastValid) { const a = Math.abs(Area(p)); if (a > bestArea) { bestArea = a; best = p } }
      entryPoint = Compute2DPolygonCentroid(best)
    }

    const checkFit = (r: number): Paths | null => {
      let cp = offsetPath([entryPoint], r + this.toolRadiusScaled, JoinType.Round, EndType.Round)
      cp = CleanPolygons(cp)
      return clipBoolean(ClipType.Difference, cp, boundPaths).length === 0 ? cp : null
    }
    if (!checkFit(this.helixRampMinRadiusScaled)) return null
    let lo = this.helixRampMinRadiusScaled
    let hi = Math.max(this.helixRampMaxRadiusScaled, lo)
    while (lo < hi) { const t = Math.trunc((lo + hi + 1) / 2); if (checkFit(t)) lo = t; else hi = t - 1 }
    const helixRadiusScaled = lo
    const fit = checkFit(helixRadiusScaled)
    if (fit) cleared.addClearedDisk(fit, entryPoint, helixRadiusScaled + this.toolRadiusScaled)
    return {
      entryPoint,
      toolPos: { x: entryPoint.x, y: entryPoint.y - helixRadiusScaled },
      toolDir: { x: 1.0, y: 0.0 },
      helixRadiusScaled,
    }
  }

  private IsClearPath(tp: Path, cleared: ClearedArea, safetyClearance: number): boolean {
    if (cleared.hasRaster) return cleared.rasterIsClearPath(tp, this.toolRadiusScaled + safetyClearance)
    const toolShape = offsetPath(tp, this.toolRadiusScaled + safetyClearance, JoinType.Round, EndType.Round)
    const crossing = clipBoolean(ClipType.Difference, toolShape, cleared.getCleared())
    let collisionArea = 0
    for (const p of crossing) collisionArea += Math.abs(Area(p))
    return collisionArea < 1.0
  }

  private IsAllowedToCutTrough(p1: IntPoint, p2: IntPoint, cleared: ClearedArea, toolBoundPaths: Paths, areaFactor = 1.5, skipBoundsCheck = false): boolean {
    if (!skipBoundsCheck && !IsPointWithinCutRegion(toolBoundPaths, p2)) return false
    if (!skipBoundsCheck && !IsPointWithinCutRegion(toolBoundPaths, p1)) return false
    const distance = Math.sqrt(DistanceSqrd(p1, p2))
    let stepSize = Math.min(0.5 * this.stepOverScaled, 8 * MIN_STEP_CLIPPER)
    if (distance < stepSize / 2) return true
    if (distance < stepSize) areaFactor *= 2
    let toolPos1 = p1
    const steps = trunc(distance / stepSize) + 1
    stepSize = distance / steps
    for (let i = 1; i <= steps; i++) {
      const p = i / steps
      const toolPos2: IntPoint = { x: trunc(p1.x + (p2.x - p1.x) * p), y: trunc(p1.y + (p2.y - p1.y) * p) }
      const area = this.CalcCutArea(toolPos1, toolPos2, cleared)[0]
      if (area > areaFactor * stepSize * this.optimalCutAreaPD) return false
      if (!skipBoundsCheck && !IsPointWithinCutRegion(toolBoundPaths, toolPos2)) return false
      toolPos1 = toolPos2
    }
    return true
  }

  private ResolveLinkPath(startPoint: IntPoint, endPoint: IntPoint, clearedArea: ClearedArea): Path | null {
    const queue: Array<[IntPoint, IntPoint]> = [[startPoint, endPoint]]
    let totalLength = 0
    const directDistance = Math.sqrt(DistanceSqrd(startPoint, endPoint))
    const linkPaths: Paths = []

    let scanStep = 2 * MIN_STEP_CLIPPER
    if (scanStep > this.scaleFactor * 0.1) scanStep = this.scaleFactor * 0.1
    if (scanStep < this.scaleFactor * 0.01) scanStep = this.scaleFactor * 0.01
    const limit = 10000

    let clearance = this.stepOverScaled
    let offClearance = 2 * this.stepOverScaled
    if (offClearance > directDistance / 2) { offClearance = directDistance / 2; clearance = 0 }

    // Bound the keep-tool-down search by a deterministic budget of clear-path probes (the
    // original used a wall-clock limit, but that makes the toolpath depend on machine speed —
    // a slow browser would abandon links a fast one keeps, leaving stock uncleared). When the
    // budget is spent we give up and the caller lifts instead.
    let clearBudget = 3000

    let cnt = 0
    while (queue.length) {
      if (clearBudget <= 0) { gDbg.resolveTimeout++; return null }
      cnt++
      if (cnt > limit) return null
      const pointPair = queue.pop()!
      const [pp1, pp2] = pointPair

      for (const lp of linkPaths) {
        const lf = lp[0], lb = lp[lp.length - 1]
        if (!ptEq(lf, pp1) && !ptEq(lb, pp1) && !ptEq(lf, pp2) && !ptEq(lb, pp2)
          && IntersectionPointSeg(lf, lb, pp1, pp2)) return null
      }

      const direction = DirectionV(pp1, pp2)
      const checkPath: Path = []
      if (ptEq(pp1, startPoint)) checkPath.push({ x: pp1.x + offClearance * direction.x, y: pp1.y + offClearance * direction.y })
      else checkPath.push(pp1)
      if (ptEq(pp2, endPoint)) checkPath.push({ x: pp2.x - offClearance * direction.x, y: pp2.y - offClearance * direction.y })
      else checkPath.push(pp2)

      clearBudget--
      if (this.IsClearPath(checkPath, clearedArea, clearance)) {
        totalLength += Math.sqrt(DistanceSqrd(pp1, pp2))
        if (totalLength > this.keepToolDownDistRatio * directDistance) return null
        linkPaths.push([pp1, pp2])
      } else {
        if (Math.sqrt(DistanceSqrd(pp1, pp2)) < 4) return null
        const pDir = { x: -direction.y, y: direction.x }
        const midPoint: IntPoint = { x: trunc(0.5 * (pp1.x + pp2.x)), y: trunc(0.5 * (pp1.y + pp2.y)) }
        let resolved = false
        for (let i = 1; !resolved; i++) {
          const offset = i * scanStep
          let cp1: IntPoint = { x: trunc(midPoint.x + offset * pDir.x), y: trunc(midPoint.y + offset * pDir.y) }
          let cp2: IntPoint = { x: trunc(midPoint.x - offset * pDir.x), y: trunc(midPoint.y - offset * pDir.y) }
          const closer = clearedArea.hasRaster
            ? clearedArea.rasterClearedDepth(cp1, 2 * this.stepOverScaled) < clearedArea.rasterClearedDepth(cp2, 2 * this.stepOverScaled)
            : DistancePointToPathsSqrd(clearedArea.getCleared(), cp1).distSq < DistancePointToPathsSqrd(clearedArea.getCleared(), cp2).distSq
          if (closer) { const tmp = cp2; cp2 = cp1; cp1 = tmp }
          clearBudget -= 2
          if (this.IsClearPath([cp1], clearedArea, clearance + 1)) {
            queue.push([pp1, cp1]); queue.push([cp1, pp2]); resolved = true
          } else if (this.IsClearPath([cp2], clearedArea, clearance + 1)) {
            queue.push([pp1, cp2]); queue.push([cp2, pp2]); resolved = true
          }
          if (!resolved && (offset > this.keepToolDownDistRatio * directDistance || clearBudget <= 0)) { gDbg.resolveTimeout++; return null }
        }
      }
    }
    if (!linkPaths.length) return null
    const connected = ConnectPaths(linkPaths)
    return connected[0] ?? null
  }

  private MakeLeadPath(
    leadIn: boolean, startPoint: IntPoint, startDir: DoublePoint, beaconPointIn: IntPoint,
    clearedAreaOriginal: ClearedArea, toolBoundPaths: Paths, output: AdaptiveOutput,
  ): Path | null {
    const result: Path = [startPoint]
    const stepSize = Math.min(MIN_STEP_CLIPPER * 8, 0.2 * this.stepOverScaled + 1)
    const clearedArea = clearedAreaOriginal.clone()
    const deepDelta = this.toolRadiusScaled + stepSize

    // Aim the beacon at deep cleared stock. If it isn't already deep inside, nudge it to the nearest
    // deep-cleared point (raster) — replaces the eroded-polygon relocation.
    let beaconPoint = beaconPointIn
    if (!clearedArea.rasterDeepInside(beaconPoint, deepDelta)) {
      beaconPoint = clearedArea.rasterNearestDeepCleared(beaconPoint) ?? beaconPoint
    }

    let currentPoint = startPoint
    const distanceToBeacon = Math.sqrt(DistanceSqrd(startPoint, beaconPoint))
    const minExitLength = Math.min(this.toolRadiusScaled / 5, Math.min(this.stepOverScaled, distanceToBeacon / 2))
    const maxLength = Math.max(distanceToBeacon * 2, stepSize * 10)
    let clearedStartLen: number | null = null
    let nextDir = { x: startDir.x, y: startDir.y }
    let nextPoint: IntPoint = { x: trunc(currentPoint.x + nextDir.x * stepSize), y: trunc(currentPoint.y + nextDir.y * stepSize) }
    const checkPath: Path = [currentPoint]
    const adaptFactor = 0.4
    const alfa = Math.PI / 64
    let pathLen = 0

    // The original caps at 10000 (cheap with native Clipper). When a lead is blocked it only
    // rotates (pathLen doesn't advance, so the maxLength exit never fires) — with clipper2-ts
    // that spins for seconds. A few hundred iterations is ample for a short lead; failing out
    // makes the caller fall back to a lift, which is correct.
    for (let i = 0; i < 600; i++) {
      if (this.IsAllowedToCutTrough(currentPoint, nextPoint, clearedArea, toolBoundPaths)) {
        if (!leadIn) {
          // Mark the lead's own cut on the raster so the next engagement check sees it (no offset).
          checkPath.push(nextPoint)
          clearedArea.rasterMark(checkPath)
          checkPath.length = 0; checkPath.push(nextPoint)
        }
        result.push(nextPoint)
        currentPoint = nextPoint
        pathLen += stepSize
        const targetDir = DirectionV(currentPoint, beaconPoint)
        nextDir = { x: nextDir.x + adaptFactor * targetDir.x, y: nextDir.y + adaptFactor * targetDir.y }
        NormalizeV(nextDir)

        if (clearedArea.rasterDeepInside(currentPoint, deepDelta)) {
          if (clearedStartLen === null) clearedStartLen = pathLen
          if (pathLen > minExitLength && pathLen - clearedStartLen > MIN_STEP_CLIPPER) return result
        } else clearedStartLen = null

        if (pathLen > maxLength) {
          if (clearedArea.rasterIsCleared(currentPoint)) return result
          output.leadPathFailed = true
          return null
        }
      } else {
        nextDir = rotate(nextDir, leadIn ? -alfa : alfa)
      }
      nextPoint = { x: trunc(currentPoint.x + nextDir.x * stepSize), y: trunc(currentPoint.y + nextDir.y * stepSize) }
    }
    gDbg.leadCap++
    return null
  }

  private FindLinkPath(
    prevPoint: IntPoint | null, pathStart: IntPoint, pathDir: DoublePoint,
    cleared: ClearedArea, toolBoundPaths: Paths, output: AdaptiveOutput,
  ): TPath[] | null {
    const result: TPath[] = []
    const endPoint = pathStart
    const linkDistance = prevPoint ? Math.sqrt(DistanceSqrd(prevPoint, endPoint)) : this.stepOverScaled
    if (linkDistance < NTOL) return result

    const beaconOffset = Math.max(Math.min(this.stepOverScaled, linkDistance / 2) * 1.5, 8 * MIN_STEP_CLIPPER)
    const eRes = DistancePointToPathsSqrd(toolBoundPaths, endPoint)
    const revEndDir: DoublePoint = { x: -pathDir.x, y: -pathDir.y }
    let endBoundaryDir = GetPathDirectionV(toolBoundPaths[eRes.pathIndex], eRes.segIndex)
    if (eRes.distSq > beaconOffset) endBoundaryDir = pathDir
    const endBeaconDir: DoublePoint = { x: revEndDir.x - endBoundaryDir.y, y: revEndDir.y + endBoundaryDir.x }
    NormalizeV(endBeaconDir)
    const endBeacon: IntPoint = { x: trunc(endPoint.x + beaconOffset * endBeaconDir.x), y: trunc(endPoint.y + beaconOffset * endBeaconDir.y) }

    let leadInPath = this.MakeLeadPath(true, endPoint, revEndDir, endBeacon, cleared, toolBoundPaths, output)
    if (!leadInPath) return null
    leadInPath = leadInPath.slice(); leadInPath.reverse()

    let linkPath: Path = []
    let linkType: number = MotionType.Cutting

    if (prevPoint) {
      const resolved = this.ResolveLinkPath(prevPoint, leadInPath[0], cleared)
      if (resolved) {
        linkPath = resolved
        linkType = MotionType.LinkClear
        let remainingLeadInExtension = this.stepOverScaled / 2
        while (linkPath.length >= 2 && remainingLeadInExtension > NTOL) {
          const p1 = linkPath[linkPath.length - 2]
          const p2 = linkPath[linkPath.length - 1]
          const l = Math.sqrt(DistanceSqrd(p1, p2))
          if (l >= remainingLeadInExtension) {
            const splitPoint: IntPoint = {
              x: trunc(p1.x + (p2.x - p1.x) * (l - remainingLeadInExtension) / l),
              y: trunc(p1.y + (p2.y - p1.y) * (l - remainingLeadInExtension) / l),
            }
            linkPath.pop(); linkPath.push(splitPoint)
            leadInPath.unshift(splitPoint)
            remainingLeadInExtension = 0
            if (!this.IsClearPath([p2, splitPoint], cleared, 0)) remainingLeadInExtension = this.stepOverScaled / 2
          } else {
            linkPath.pop(); leadInPath.unshift(p1)
            remainingLeadInExtension -= l
            if (remainingLeadInExtension < NTOL) {
              if (!this.IsClearPath([p2, p1], cleared, 0)) remainingLeadInExtension = this.stepOverScaled / 2
            }
          }
        }
      } else {
        linkType = MotionType.LinkNotClear
        const dist = Math.sqrt(DistanceSqrd(prevPoint, leadInPath[0]))
        if (dist < 2 * this.stepOverScaled && this.IsAllowedToCutTrough(
          { x: trunc(prevPoint.x + (leadInPath[0].x - prevPoint.x) / dist), y: trunc(prevPoint.y + (leadInPath[0].y - prevPoint.y) / dist) },
          { x: trunc(leadInPath[0].x - (leadInPath[0].x - prevPoint.x) / dist), y: trunc(leadInPath[0].y - (leadInPath[0].y - prevPoint.y) / dist) },
          cleared, toolBoundPaths,
        )) linkType = MotionType.Cutting
        linkPath = [prevPoint, leadInPath[0]]
      }
    }

    const linkPaths: Paths = [linkPath, leadInPath]
    if (linkType === MotionType.LinkClear) SmoothPaths(linkPaths, 0.1 * this.stepOverScaled, 1, 4)
    linkPath = linkPaths[0]; leadInPath = linkPaths[1]

    if (prevPoint) result.push({ motion: linkType, pts: linkPath.map(p => this.unscale(p)) })
    result.push({ motion: MotionType.Cutting, pts: leadInPath.map(p => this.unscale(p)) })
    return result
  }

  private AppendToolPath(
    output: AdaptiveOutput, passToolPath: Path, linkPath: TPath[], cleared: ClearedArea, toolBoundPaths: Paths,
  ): { pos: IntPoint; dir: DoublePoint } | null {
    for (const lp of linkPath) output.adaptivePaths.push(lp)

    const cutPath: TPath = { motion: MotionType.Cutting, pts: passToolPath.map(p => this.unscale(p)) }
    if (!cutPath.pts.length) return null
    output.adaptivePaths.push(cutPath)

    let result: { pos: IntPoint; dir: DoublePoint } | null = null
    if (passToolPath.length >= 2) {
      const prevPoint = passToolPath[passToolPath.length - 1]
      const prevDir = GetPathDirectionV(passToolPath, passToolPath.length - 1)
      const dRes = DistancePointToPathsSqrd(toolBoundPaths, prevPoint)
      let boundaryDir = GetPathDirectionV(toolBoundPaths[dRes.pathIndex], dRes.segIndex)
      const beaconOffset = Math.max(Math.min(this.stepOverScaled, PathLength(passToolPath) / 2) * 1.5, 8 * MIN_STEP_CLIPPER)
      if (dRes.distSq > beaconOffset) boundaryDir = prevDir
      const beaconDir: DoublePoint = { x: prevDir.x - boundaryDir.y, y: prevDir.y + boundaryDir.x }
      NormalizeV(beaconDir)
      const beacon: IntPoint = { x: trunc(prevPoint.x + beaconOffset * beaconDir.x), y: trunc(prevPoint.y + beaconOffset * beaconDir.y) }

      let leadOutPath = this.MakeLeadPath(false, prevPoint, prevDir, beacon, cleared, toolBoundPaths, output)
      if (leadOutPath && leadOutPath.length >= 1) {
        const linkPaths: Paths = [leadOutPath]
        SmoothPaths(linkPaths, 0.1 * this.stepOverScaled, 1, 4)
        leadOutPath = linkPaths[0]
        output.adaptivePaths.push({ motion: MotionType.Cutting, pts: leadOutPath.map(p => this.unscale(p)) })
        cleared.expandCleared(leadOutPath)
        const p2 = leadOutPath[leadOutPath.length - 1]
        const p1 = leadOutPath.length >= 2 ? leadOutPath[leadOutPath.length - 2] : prevPoint
        result = { pos: p2, dir: DirectionV(p1, p2) }
      }
    }
    return result
  }

  private unscale(p: IntPoint): [number, number] { return [p.x / this.scaleFactor, p.y / this.scaleFactor] }
  private scale(p: [number, number]): IntPoint { return { x: trunc(p[0] * this.scaleFactor), y: trunc(p[1] * this.scaleFactor) } }

  private ProcessPolyNode(boundPathsIn: Paths, toolBoundPathsIn: Paths, finishingPathsIn: Paths, initialClearedPaths: Paths): void {
    this.current_region++
    let boundPaths = boundPathsIn
    let toolBoundPaths = toolBoundPathsIn
    let finishingPaths = finishingPathsIn.map(p => p.slice())

    let entryPoint: IntPoint = { x: 0, y: 0 }

    toolBoundPaths = CleanPolygons(toolBoundPaths)
    toolBoundPaths = SimplifyPolygons(toolBoundPaths)
    boundPaths = CleanPolygons(boundPaths)
    boundPaths = SimplifyPolygons(boundPaths)

    let tbpMinus = offsetPaths(toolBoundPaths, -2, JoinType.Round, EndType.Polygon)
    tbpMinus = CleanPolygons(tbpMinus)
    tbpMinus = SimplifyPolygons(tbpMinus)

    let toolPos: IntPoint = { x: 0, y: 0 }
    let toolDir: DoublePoint = { x: 0, y: 0 }

    // Raster over the region (tool centre within boundPaths; cut extends ~toolR, helix a bit more →
    // 3·toolR margin). cell ≈ tolerance/2 in mm (≈ MIN_STEP). Only the main cleared gets one.
    const rb = getBoundsPaths(boundPaths)
    const rMargin = 3 * this.toolRadiusScaled
    const rCell = Math.max(1, trunc(this.tolerance * this.scaleFactor / 4))
    const raster = new TileRaster(
      Math.min(rb.left, rb.right) - rMargin, Math.min(rb.top, rb.bottom) - rMargin,
      Math.max(rb.left, rb.right) + rMargin, Math.max(rb.top, rb.bottom) + rMargin,
      rCell, this.toolRadiusScaled,
    )
    const cleared = new ClearedArea(this.toolRadiusScaled, raster)
    cleared.setClearedPaths(initialClearedPaths)

    let stepScaled = trunc(MIN_STEP_CLIPPER)

    const passToolPath: Path = []
    const toClearPath: Path = []
    const gyro: DoublePoint[] = []
    const angleHistory: number[] = []
    let angle = Math.PI
    const interp = new Interpolation()

    let over_cut_count = 0
    let bad_engage_count = 0

    const output: AdaptiveOutput = {
      helixCenter: [0, 0], startPoint: [0, 0], adaptivePaths: [], returnMotionType: 0, clearedArea: 0,
      startPointNotFound: false, leadPathFailed: false, tooManyFailedEngagements: false,
      unclearedAreaRemains: false, failedToSetUpFinishingPass: false, finishingLeadInFailed: false,
    }

    // Per-pass cut-area accounting via the raster's running cut total (replaces a clearedBeforePass
    // polygon snapshot + a per-pass clip.diff).
    let areaBeforePass = cleared.rasterArea()

    let lastExpandToolDir: DoublePoint = toolDir

    const iterateNextStep = (tpos: IntPoint, tdir: DoublePoint): IterateNextStepOutput => {
      const out: IterateNextStepOutput = { tooManyIterations: false, failed: false, area: 0, errorFraction: 1, newToolPos: { x: 0, y: 0 }, newToolDir: { x: 0, y: 0 } }

      const dbRes = DistancePointToPathsSqrd(toolBoundPaths, tpos)
      const distanceToBoundary = Math.sqrt(dbRes.distSq)
      const boundaryDir = GetPathDirectionV(toolBoundPaths[dbRes.pathIndex], dbRes.segIndex)
      const distanceToEngage = Math.sqrt(DistanceSqrd(tpos, entryPoint))

      const targetAreaPD = this.optimalCutAreaPD
      const slowDownDistance = Math.max(this.toolRadiusScaled / 4, MIN_STEP_CLIPPER * 8)
      if (distanceToBoundary < slowDownDistance || distanceToEngage < slowDownDistance) stepScaled = trunc(MIN_STEP_CLIPPER)
      else if (Math.abs(angle) > NTOL) stepScaled = trunc(MIN_STEP_CLIPPER / Math.abs(angle))
      else stepScaled = trunc(MIN_STEP_CLIPPER * 8)
      if (stepScaled > Math.min(trunc(this.toolRadiusScaled / 4), trunc(MIN_STEP_CLIPPER * 8))) stepScaled = Math.min(trunc(this.toolRadiusScaled / 4), trunc(MIN_STEP_CLIPPER * 8))
      if (stepScaled < MIN_STEP_CLIPPER) stepScaled = trunc(MIN_STEP_CLIPPER)

      const predictedAngle = averageDV(angleHistory)
      const maxError = AREA_ERROR_FACTOR * this.optimalCutAreaPD
      let errorFraction = 1
      let area = 0
      let isConventional = false
      const conventionalCutoff = 0.51
      let areaPD = 0
      interp.clear()
      let pointNotInterp = true
      let foundArea = false
      let newToolPos: IntPoint = { x: 0, y: 0 }
      let newToolDir: DoublePoint = { x: 0, y: 0 }

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        if (iteration === 0) { angle = predictedAngle; pointNotInterp = true }
        else if (iteration === 1) { angle = interp.MIN_ANGLE; pointNotInterp = true }
        else if (iteration === 2) {
          if (interp.bothSides()) { angle = interp.interpolateAngle(); pointNotInterp = false }
          else { angle = interp.MAX_ANGLE; pointNotInterp = true }
        } else if (iteration === 3 && !foundArea) {
          cleared.expandCleared(toClearPath); toClearPath.length = 0; lastExpandToolDir = tdir
          let clearedAreaP = cleared.getCleared()
          const dist = (stepScaled + this.toolRadiusScaled) * 1.5
          const leftAngle = rotate(tdir, -Math.PI / 4)
          const rightAngle = rotate(tdir, Math.PI / 4)
          const triangle: Path = [
            tpos,
            { x: trunc(tpos.x + rightAngle.x * dist), y: trunc(tpos.y + rightAngle.y * dist) },
            { x: trunc(tpos.x + leftAngle.x * dist), y: trunc(tpos.y + leftAngle.y * dist) },
          ]
          clearedAreaP = clipBoolean(ClipType.Difference, [triangle], clearedAreaP)
          if (clearedAreaP.length === 0) continue
          const r = DistancePointToPathsSqrd(clearedAreaP, tpos)
          const dy = r.clp.y - tpos.y, dx = r.clp.x - tpos.x
          const len = Math.sqrt(dx * dx + dy * dy)
          angle = Math.asin((dy * tdir.x - dx * tdir.y) / len)
        } else if (!foundArea) { angle = 0; area = 0; areaPD = 0; break }
        else { angle = interp.interpolateAngle(); pointNotInterp = false }
        angle = interp.clampAngle(angle)

        newToolDir = rotate(tdir, angle)
        newToolPos = { x: trunc(tpos.x + newToolDir.x * stepScaled), y: trunc(tpos.y + newToolDir.y * stepScaled) }

        let intRepeat = false
        if (interp.m_min && ptEq(newToolPos, interp.m_min.angleSecond)) {
          interp.m_min = { angleFirst: angle, angleSecond: newToolPos, error: interp.m_min.error, isConventional: interp.m_min.isConventional }
          intRepeat = true
        }
        if (interp.m_max && ptEq(newToolPos, interp.m_max.angleSecond)) {
          interp.m_max = { angleFirst: angle, angleSecond: newToolPos, error: interp.m_max.error, isConventional: interp.m_max.isConventional }
          intRepeat = true
        }
        if (intRepeat) {
          if (interp.m_min && interp.m_max
            && Math.abs(interp.m_min.angleSecond.x - interp.m_max.angleSecond.x) <= 1
            && Math.abs(interp.m_min.angleSecond.y - interp.m_max.angleSecond.y) <= 1) {
            if (pointNotInterp) continue
            let error: number
            if (interp.m_min.isConventional !== interp.m_max.isConventional) {
              if (!interp.m_min.isConventional) { newToolDir = rotate(tdir, interp.m_min.angleFirst); newToolPos = interp.m_min.angleSecond; error = interp.m_min.error; isConventional = interp.m_min.isConventional }
              else { newToolDir = rotate(tdir, interp.m_max.angleFirst); newToolPos = interp.m_max.angleSecond; error = interp.m_max.error; isConventional = interp.m_max.isConventional }
            } else if (Math.abs(interp.m_min.error) < Math.abs(interp.m_max.error)) {
              newToolDir = rotate(tdir, interp.m_min.angleFirst); newToolPos = interp.m_min.angleSecond; error = interp.m_min.error; isConventional = interp.m_min.isConventional
            } else {
              newToolDir = rotate(tdir, interp.m_max.angleFirst); newToolPos = interp.m_max.angleSecond; error = interp.m_max.error; isConventional = interp.m_max.isConventional
            }
            areaPD = error + targetAreaPD
            area = areaPD * stepScaled
            out.iterationAngle = angle
            break
          }
          continue
        }

        const caRet = this.CalcCutArea(tpos, newToolPos, cleared)
        area = caRet[0]
        const conventionalArea = caRet[1]
        const fractionConventional = area === 0 ? 0 : conventionalArea / area
        isConventional = fractionConventional >= conventionalCutoff
        if (area > 0) foundArea = true
        areaPD = area / stepScaled
        const error = areaPD - targetAreaPD
        errorFraction = Math.abs(error / this.optimalCutAreaPD)
        interp.addPoint(error, angle, newToolPos, pointNotInterp, isConventional)
        if (Math.abs(error) < maxError && !isConventional) { out.iterationAngle = angle; break }
        if (iteration === MAX_ITERATIONS - 1) out.tooManyIterations = true
      }

      let recalcArea = false
      if (area > 0) {
        let rotateStep = 0
        let rotateIncrement: number
        {
          const boundaryAngle = Math.atan2(boundaryDir.y, boundaryDir.x)
          const toolAngle = Math.atan2(newToolDir.y, newToolDir.x)
          let delta = boundaryAngle - toolAngle
          if (delta > Math.PI) delta -= 2 * Math.PI
          if (delta < -Math.PI) delta += 2 * Math.PI
          rotateIncrement = (delta > 0 ? 1 : -1) * Math.PI / 90
        }
        while (!IsPointWithinCutRegion(toolBoundPaths, newToolPos) && rotateStep < 180) {
          rotateStep++
          recalcArea = true
          newToolDir = rotate(newToolDir, rotateIncrement)
          newToolPos = { x: trunc(tpos.x + newToolDir.x * stepScaled), y: trunc(tpos.y + newToolDir.y * stepScaled) }
        }
        if (rotateStep >= 180) out.failed = true

        if (recalcArea) {
          const caRet = this.CalcCutArea(tpos, newToolPos, cleared)
          area = caRet[0]
          areaPD = area / stepScaled
          const error = areaPD - targetAreaPD
          errorFraction = Math.abs(error / this.optimalCutAreaPD)
          const conventionalArea = caRet[1]
          const fractionConventional = area === 0 ? 0 : conventionalArea / area
          isConventional = fractionConventional >= conventionalCutoff
        }

        if (area > stepScaled * this.optimalCutAreaPD && areaPD > 2 * this.optimalCutAreaPD) { over_cut_count++; out.failed = true }
      }

      out.area = area
      out.failed = out.failed || isConventional || area < 1
      out.newToolPos = newToolPos
      out.newToolDir = newToolDir
      out.errorFraction = errorFraction
      return out
    }

    const initToolDir = (tpos: IntPoint, baseDir: DoublePoint): DoublePoint | null => {
      const testDirs: DoublePoint[] = [
        { x: baseDir.x, y: baseDir.y },
        { x: -baseDir.y, y: baseDir.x },
        { x: -baseDir.x, y: -baseDir.y },
        { x: baseDir.y, y: -baseDir.x },
      ]
      let bestDir: { dir: DoublePoint; err: number } | null = null
      let allZero = true
      for (const testDir of testDirs) {
        const itResult = iterateNextStep(tpos, testDir)
        if (itResult.area !== 0) allZero = false
        if (!itResult.failed) {
          if (!bestDir || itResult.errorFraction < bestDir.err) bestDir = { dir: itResult.newToolDir, err: itResult.errorFraction }
        }
      }
      if (bestDir) return bestDir.dir
      if (allZero) {
        const clearedAreaP = cleared.getCleared()
        const r = DistancePointToPathsSqrd(clearedAreaP, tpos)
        if (r.distSq < this.toolRadiusScaled * this.toolRadiusScaled) {
          const p2 = Compute2DPolygonCentroid(clearedAreaP[r.pathIndex])
          return DirectionV(tpos, p2)
        }
        return null
      }
      return null
    }

    const _getEngagePoint = (prevPos: IntPoint | null, engagementProtrusion: number): { pos: IntPoint; dir: DoublePoint; link: TPath[] } | null => {
      // Engage candidates must lie inside the cut region (boundPaths) plus a tool margin.
      // PathIntersectArea / offset round-trips through clipper2-ts can occasionally emit a
      // stray far-away vertex; such a garbage engage point would send FindLinkPath chasing a
      // beacon thousands of mm away. Reject anything outside this box up front.
      const rb = getBoundsPaths(boundPaths)
      const margin = this.toolRadiusScaled * 2
      const rbMinX = Math.min(rb.left, rb.right) - margin, rbMaxX = Math.max(rb.left, rb.right) + margin
      const rbMinY = Math.min(rb.top, rb.bottom) - margin, rbMaxY = Math.max(rb.top, rb.bottom) + margin
      const inRegion = (p: IntPoint) =>
        Number.isFinite(p.x) && Number.isFinite(p.y)
        && p.x >= rbMinX && p.x <= rbMaxX && p.y >= rbMinY && p.y <= rbMaxY
      const engagePoints: Array<{ pos: IntPoint; dir: DoublePoint; cost: number }> = []
      const clearedAreaP = cleared.getCleared()
      const engageBuffer = 2
      const preEngage = offsetPaths(clearedAreaP, -(this.toolRadiusScaled + engageBuffer), JoinType.Round, EndType.Polygon)
      const engagePaths = offsetPaths(preEngage, engageBuffer + engagementProtrusion, JoinType.Round, EndType.Polygon)

      for (const engagePath of engagePaths) {
        let rotated: Path
        if (!prevPos) rotated = engagePath
        else {
          let iClosest = 0, dsqClosest = DBL_MAX
          for (let i = 0; i < engagePath.length; i++) {
            const dsq = DistanceSqrd(prevPos, engagePath[i])
            if (dsq < dsqClosest) { dsqClosest = dsq; iClosest = i }
          }
          rotated = []
          for (let i = 0; i < engagePath.length; i++) rotated.push(engagePath[(i + iClosest) % engagePath.length])
        }

        const openPaths = PathIntersectArea(rotated, tbpMinus)
        for (const open of openPaths) {
          let added = false
          let dToGo = 0
          let seg = 0
          let segD = 0
          while (!added && seg < open.length - 1) {
            let p: IntPoint = open[seg]
            let segDir: DoublePoint = { x: 0, y: 0 }
            do {
              const p1 = open[seg], p2 = open[seg + 1]
              const segLen = Math.sqrt(DistanceSqrd(p1, p2))
              segDir = { x: (p2.x - p1.x) / segLen, y: (p2.y - p1.y) / segLen }
              if (segLen - segD > dToGo) {
                segD += dToGo; dToGo = 0
                const interpT = segD / segLen
                p = { x: trunc(p2.x * interpT + p1.x * (1 - interpT)), y: trunc(p2.y * interpT + p1.y * (1 - interpT)) }
              } else {
                dToGo -= segLen - segD; segD = 0; seg++; p = p2
              }
            } while (dToGo > 0 && seg < open.length - 1)

            const td = inRegion(p) ? initToolDir(p, segDir) : null
            if (td) {
              const cost_mm = prevPos ? Math.sqrt(DistanceSqrd(prevPos, p)) / this.scaleFactor : 0
              engagePoints.push({ pos: p, dir: td, cost: cost_mm }); added = true
            }
            dToGo = MIN_STEP_CLIPPER
          }
        }
      }

      engagePoints.sort((a, b) => a.cost - b.cost)

      let bestCost = DBL_MAX
      let bestLink: TPath[] | null = null
      let bestPos: IntPoint = { x: 0, y: 0 }
      let bestDir: DoublePoint = { x: 0, y: 0 }
      // Perf bound (not in the original, which relies on native-fast Clipper): candidates are
      // sorted nearest-first, so cap how many we evaluate and stop at the first no-lift link —
      // it's already the cheapest reachable engage. clipper2-ts is far too slow to link-test
      // every candidate (each ResolveLinkPath can probe thousands of clear-path queries).
      const MAX_ENGAGE_ATTEMPTS = 10
      let attempts = 0
      for (const ep of engagePoints) {
        if (ep.cost >= bestCost) continue
        if (attempts++ >= MAX_ENGAGE_ATTEMPTS) break
        const link = this.FindLinkPath(prevPos, ep.pos, ep.dir, cleared, toolBoundPaths, output)
        if (!link) continue
        let cost_mm = 0
        let hasLift = false
        let prev: [number, number] | null = prevPos ? [prevPos.x / this.scaleFactor, prevPos.y / this.scaleFactor] : null
        for (const tp of link) {
          if (tp.motion === MotionType.LinkNotClear) { cost_mm += 10000; hasLift = true }
          for (const cur of tp.pts) {
            if (prev) cost_mm += Math.hypot(cur[0] - prev[0], cur[1] - prev[1])
            prev = cur
          }
        }
        if (cost_mm < bestCost) { bestCost = cost_mm; bestLink = link; bestPos = ep.pos; bestDir = ep.dir }
        if (!hasLift) break
      }
      if (bestCost < DBL_MAX && bestLink) return { pos: bestPos, dir: bestDir, link: bestLink }
      return null
    }

    const getEngagePoint = (prevPos: IntPoint | null): { pos: IntPoint; dir: DoublePoint; link: TPath[] } | null => {
      const targetArea = this.optimalCutAreaPD * MIN_STEP_CLIPPER
      const theta = Math.pow(12 * targetArea / this.toolRadiusScaled / this.toolRadiusScaled, 1 / 3)
      const protrusion = this.toolRadiusScaled - Math.cos(theta / 2) * this.toolRadiusScaled
      const engagementProtrusion = trunc(Math.min(protrusion, this.stepOverScaled * FINISHING_THICKNESS_SCALE))
      const result = _getEngagePoint(prevPos, engagementProtrusion)
      if (result) {
        for (const lp of result.link) {
          if (lp.motion === MotionType.Cutting) cleared.expandCleared(lp.pts.map(p => this.scale(p)))
        }
      }
      return result
    }

    // initial entry
    let linkPath: TPath[] = []
    let engagePoint = getEngagePoint(null)
    if (engagePoint) {
      toolPos = engagePoint.pos; toolDir = engagePoint.dir; linkPath = engagePoint.link
      entryPoint = linkPath.length > 0 ? this.scale(linkPath[0].pts[0]) : toolPos
      output.startPoint = this.unscale(entryPoint)
    } else {
      const entry = this.FindEntryPoint(toolBoundPaths, boundPaths, cleared, output)
      if (!entry) { this.results.push(output); return }
      entryPoint = entry.entryPoint; toolPos = entry.toolPos; toolDir = entry.toolDir
      output.startPoint = this.unscale(toolPos)
    }
    output.returnMotionType = 0
    output.helixCenter = this.unscale(entryPoint)

    // Re-seed control (not in the original): an outward spiral's arms eventually collide and the
    // closing zone degenerates into trochoid mush. When the contiguous spiral stalls (several
    // unproductive passes in a row) and a real blob of stock still remains (a helix ≥ toolR fits),
    // lift and helix into that blob to start a fresh clean spiral instead of mushing. A fresh
    // spiral cutting into the already-cleared region reads ~zero engagement at the seam, so the
    // re-join never spikes engagement.
    let unproductiveStreak = 0
    let reseedCount = 0
    const RESEED_STREAK = 3
    const RESEED_MAX = 40  // safety cap; the real terminator is "no helix fits the remaining stock"
    const reseedAreaThresh = 6 * Math.PI * this.toolRadiusScaled * this.toolRadiusScaled

    // passes
    for (let pass = 0; pass < PASSES_LIMIT; pass++) {
      passToolPath.length = 0
      toClearPath.length = 0
      angleHistory.length = 0
      angleHistory.push(0)

      for (const lp of linkPath) {
        if (lp.motion === MotionType.Cutting || lp.motion === MotionType.LinkClear) cleared.expandCleared(lp.pts.map(p => this.scale(p)))
      }

      angle = Math.PI / 4
      gyro.length = 0
      for (let i = 0; i < DIRECTION_SMOOTHING_BUFLEN; i++) gyro.push(toolDir)

      for (let point_index = 0; point_index < POINTS_PER_PASS_LIMIT; point_index++) {
        toolDir = AverageDirection(gyro)
        const itResult = iterateNextStep(toolPos, toolDir)

        if (!itResult.failed) {
          if (itResult.iterationAngle !== undefined) {
            angleHistory.push(itResult.iterationAngle)
            if (angleHistory.length > ANGLE_HISTORY_POINTS) angleHistory.shift()
          }
          if (lastExpandToolDir.x * itResult.newToolDir.x + lastExpandToolDir.y * itResult.newToolDir.y < Math.cos(Math.PI / 4)) {
            cleared.expandCleared(toClearPath); toClearPath.length = 0; lastExpandToolDir = toolDir
          }
          if (toClearPath.length === 0) toClearPath.push(toolPos)
          toClearPath.push(itResult.newToolPos)
          if (passToolPath.length === 0) passToolPath.push(toolPos)
          passToolPath.push(itResult.newToolPos)
          toolPos = itResult.newToolPos
          gyro.push(itResult.newToolDir); gyro.shift()
        } else break
      }
      gDbg.marches++
      if (passToolPath.length === 0) gDbg.zeroMarches++

      if (toClearPath.length) { cleared.expandCleared(toClearPath); toClearPath.length = 0 }

      const cumulativeCutArea = cleared.rasterArea() - areaBeforePass

      if (cumulativeCutArea >= 1) {
        const cleaned = CleanPath(passToolPath, CLEAN_PATH_TOLERANCE)
        const newPos = this.AppendToolPath(output, cleaned, linkPath, cleared, toolBoundPaths)
        if (newPos) { toolPos = newPos.pos; toolDir = newPos.dir }
        bad_engage_count = 0
      } else {
        bad_engage_count++
      }
      if (bad_engage_count > 10000) { output.tooManyFailedEngagements = true; break }

      if (cumulativeCutArea < reseedAreaThresh) unproductiveStreak++; else unproductiveStreak = 0

      areaBeforePass = cleared.rasterArea()

      // The spiral has stalled and we've been nibbling — if a blob big enough for a helix
      // remains, re-seed a fresh spiral there rather than continuing to mush.
      if (unproductiveStreak >= RESEED_STREAK && reseedCount < RESEED_MAX) {
        // The spiral stalled and we're nibbling. Only re-seed where a real blob remains (inscribed
        // radius ≳ 2.5·toolR — worth a fresh multi-lap spiral); a thin band has no such blob, so it
        // keeps trochoids. The helix itself stays ≤ toolR so it clears its own centre (no plug).
        const rs = this.findHelixSeed(boundPaths, toolBoundPaths, cleared, 2.5 * this.toolRadiusScaled)
        if (rs) {
          reseedCount++
          unproductiveStreak = 0
          toolPos = rs.toolPos; toolDir = rs.toolDir; entryPoint = rs.entryPoint; lastExpandToolDir = toolDir
          // Helix re-entry: center = entryPoint, rim (first cut) = toolPos.
          linkPath = [{ motion: MotionType.Helix, pts: [this.unscale(rs.entryPoint), this.unscale(rs.toolPos)] }]
          continue
        }
        unproductiveStreak = 0  // no blob fits; reset so we don't probe every pass
      }

      engagePoint = getEngagePoint(toolPos)
      if (engagePoint) {
        toolPos = engagePoint.pos; toolDir = engagePoint.dir; linkPath = engagePoint.link; lastExpandToolDir = toolDir
      } else {
        // No stay-down engage point found. Before giving up, re-seed into any remaining pocket of
        // stock that can still fit a helix — the engage search can't always reach a region the
        // spiral collision isolated, so this guarantees full coverage (any helix-able blob gets
        // its own spiral; only sub-helix slivers are left for the finishing pass). Small helix →
        // no centre plug.
        if (reseedCount < RESEED_MAX) {
          const rs = this.findHelixSeed(boundPaths, toolBoundPaths, cleared, this.toolRadiusScaled)
          if (rs) {
            reseedCount++
            unproductiveStreak = 0
            toolPos = rs.toolPos; toolDir = rs.toolDir; entryPoint = rs.entryPoint; lastExpandToolDir = toolDir
            linkPath = [{ motion: MotionType.Helix, pts: [this.unscale(rs.entryPoint), this.unscale(rs.toolPos)] }]
            continue
          }
        }
        const remaining: Paths = []
        for (const p of cleared.getCleared()) {
          if (p.length && IsPointWithinCutRegion(toolBoundPaths, p[0])
            && DistancePointToPathsSqrd(boundPaths, p[0]).distSq > 4 * this.toolRadiusScaled * this.toolRadiusScaled) remaining.push(p)
        }
        if (remaining.length) output.unclearedAreaRemains = true
        break
      }
    }

    // sanity check finishing setup
    const clearedLocations = offsetPaths(cleared.getCleared(), -this.toolRadiusScaled, JoinType.Round, EndType.Polygon)
    const tbpShrink = offsetPaths(toolBoundPaths, -this.stepOverScaled * FINISHING_THICKNESS_SCALE - MIN_STEP_CLIPPER, JoinType.Round, EndType.Polygon)
    const uncut = clipBoolean(ClipType.Difference, tbpShrink, clearedLocations)
    if (uncut.length > 0) output.failedToSetUpFinishingPass = true

    // finishing pass
    if (this.finishingProfile) {
      const tbpModified: Paths = []
      for (const fp of finishingPaths) {
        const offset = getPathNestingLevelP(fp, finishingPaths) % 2 === 1 ? 3 : -3
        const out = offsetPath(fp, offset, JoinType.Round, EndType.Polygon)
        const orientation = Orientation(fp)
        for (const p of out) { if (Orientation(p) !== orientation) ReversePath(p); tbpModified.push(p) }
      }
      toolBoundPaths = tbpModified

      let finShifted: Path | null
      while ((finShifted = PopPathWithClosestPoint(finishingPaths, toolPos, this.stepOverScaled)) !== null) {
        if (!finShifted.length) continue
        let allPointsOutside = true
        let pp1 = finShifted[0]
        for (const pt of finShifted) {
          if (IsPointWithinCutRegion(this.stockInputPaths, { x: trunc((pp1.x + pt.x) / 2), y: trunc((pp1.y + pt.y) / 2) })) { allPointsOutside = false; break }
          if (IsPointWithinCutRegion(this.stockInputPaths, pt)) { allPointsOutside = false; break }
          pp1 = pt
        }
        if (allPointsOutside) continue

        finShifted.push({ x: finShifted[0].x, y: finShifted[0].y })
        let finCleaned = CleanPath(finShifted, FINISHING_CLEAN_PATH_TOLERANCE)
        if (Math.sqrt(DistanceSqrd(finCleaned[0], finCleaned[finCleaned.length - 1])) < FINISHING_CLEAN_PATH_TOLERANCE) finCleaned.pop()
        finCleaned.push({ x: finCleaned[0].x, y: finCleaned[0].y })

        const linkP = this.FindLinkPath(toolPos, finCleaned[0], GetPathDirectionV(finCleaned, 1), cleared, toolBoundPaths, output)
        if (!linkP) { output.finishingLeadInFailed = true; continue }
        const newPos = this.AppendToolPath(output, finCleaned, linkP, cleared, toolBoundPaths)
        if (newPos) { toolPos = newPos.pos; toolDir = newPos.dir }
        else { toolPos = finCleaned[finCleaned.length - 1]; toolDir = GetPathDirectionV(finCleaned, finCleaned.length - 1) }
        cleared.expandCleared(finCleaned)
        for (const lp of linkP) {
          if (lp.motion === MotionType.Cutting) cleared.expandCleared(lp.pts.map(p => this.scale(p)))
        }
      }
      output.returnMotionType = this.IsClearPath([toolPos, entryPoint], cleared, 0) ? MotionType.LinkClear : MotionType.LinkNotClear
    }

    // newly cleared area accounting
    let initialClearedArea = 0
    for (const path of initialClearedPaths) {
      const nesting = getPathNestingLevelP(path, initialClearedPaths)
      initialClearedArea += (nesting % 2 === 1 ? 1 : -1) * Math.abs(Area(path))
    }
    const finalPaths = cleared.getCleared()
    let finalClearedArea = 0
    for (const path of finalPaths) {
      const nesting = getPathNestingLevelP(path, finalPaths)
      finalClearedArea += (nesting % 2 === 1 ? 1 : -1) * Math.abs(Area(path))
    }
    output.clearedArea = (finalClearedArea - initialClearedArea) / (this.scaleFactor * this.scaleFactor)

    void over_cut_count
    dbgLog('region', this.current_region, 'clearedArea', output.clearedArea.toFixed(1),
      'marches', gDbg.marches, 'zeroMarches', gDbg.zeroMarches, 'reseeds', reseedCount,
      'caps{lead,resolve}', gDbg.leadCap, gDbg.resolveTimeout,
      'flags', JSON.stringify({ ucl: output.unclearedAreaRemains, tmf: output.tooManyFailedEngagements, fin: output.failedToSetUpFinishingPass }))
    this.results.push(output)
  }
}

function ptEq(a: IntPoint, b: IntPoint): boolean { return a.x === b.x && a.y === b.y }
