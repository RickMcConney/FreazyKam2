// Helpers for the FreeCAD-derived adaptive engine — straight ports of the utility functions in
// FreeCAD's src/Mod/CAM/libarea/Adaptive.cpp (Kresimir Tusek, LGPL-2.1-or-later), on
// clipper2-ts integer paths. Names follow upstream so the engine reads against the original.

import {
  Clipper64, ClipType, FillRule, PathType, PointInPolygonResult,
  pointInPolygon, simplifyPath, type Path64, type Paths64, type Point64,
} from 'clipper2-ts'

export type IntPoint = Point64
export type Path = Path64
export type Paths = Paths64
export interface DoublePoint { x: number; y: number }

export const NTOL = 1.0e-7
export const SAME_POINT_TOL_SQRD_SCALED = 4.0

export const ip = (x: number, y: number): IntPoint => ({ x: Math.trunc(x), y: Math.trunc(y) })

export function DistanceSqrd(a: IntPoint, b: IntPoint): number {
  const dx = a.x - b.x, dy = a.y - b.y
  return dx * dx + dy * dy
}

export function averageDV(v: number[]): number {
  if (v.length === 0) return 0
  let s = 0
  for (const x of v) s += x
  return s / v.length
}

export function rotate(v: DoublePoint, rad: number): DoublePoint {
  const c = Math.cos(rad), s = Math.sin(rad)
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y }
}

export function PathLength(p: Path): number {
  let len = 0
  for (let i = 1; i < p.length; i++) len += Math.sqrt(DistanceSqrd(p[i - 1], p[i]))
  return len
}

export function DirectionV(a: IntPoint, b: IntPoint): DoublePoint {
  const dx = b.x - a.x, dy = b.y - a.y
  const l = Math.sqrt(dx * dx + dy * dy)
  if (l < NTOL) return { x: 0, y: 0 }
  return { x: dx / l, y: dy / l }
}

export function NormalizeV(v: DoublePoint): DoublePoint {
  const l = Math.sqrt(v.x * v.x + v.y * v.y)
  return l > NTOL ? { x: v.x / l, y: v.y / l } : v
}

export function GetPathDirectionV(p: Path, i: number): DoublePoint {
  if (p.length < 2) return { x: 0, y: 0 }
  const a = p[i > 0 ? i - 1 : p.length - 1]
  const b = p[i]
  return DirectionV(a, b)
}

export function AverageDirection(vs: DoublePoint[]): DoublePoint {
  let x = 0, y = 0
  for (const v of vs) { x += v.x; y += v.y }
  const m = Math.sqrt(x * x + y * y)
  return { x: x / m, y: y / m }
}

/** ClipperLib::PointInPolygon: 0 outside, −1 on edge, +1 inside. */
export function PointInPolygon(pt: IntPoint, poly: Path): number {
  const r = pointInPolygon(pt, poly)
  if (r === PointInPolygonResult.IsOutside) return 0
  if (r === PointInPolygonResult.IsOn) return -1
  return 1
}

export function getPathNestingLevel(path: Path, paths: Paths): number {
  let n = 0
  if (path.length === 0) return 0
  for (const other of paths) if (PointInPolygon(path[0], other) !== 0) n++
  return n
}

export interface Clp { distSq: number; pathIndex: number; segIndex: number; par: number; x: number; y: number }

export function DistancePointToPathsSqrd(paths: Paths, pt: IntPoint): Clp {
  const r: Clp = { distSq: Infinity, pathIndex: 0, segIndex: 0, par: 0, x: 0, y: 0 }
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i], m = p.length
    for (let j = 0; j < m; j++) {
      const a = p[j > 0 ? j - 1 : m - 1], b = p[j]
      const dx = b.x - a.x, dy = b.y - a.y
      const l2 = dx * dx + dy * dy
      let par = 0, qx = a.x, qy = a.y
      if (l2 > 0) {
        let t = (pt.x - a.x) * dx + (pt.y - a.y) * dy
        if (t < 0) t = 0; else if (t > l2) t = l2
        par = t / l2
        qx = Math.trunc(a.x + par * dx); qy = Math.trunc(a.y + par * dy)
      }
      const ex = pt.x - qx, ey = pt.y - qy
      const d2 = ex * ex + ey * ey
      if (d2 < r.distSq) { r.distSq = d2; r.pathIndex = i; r.segIndex = j; r.par = par; r.x = qx; r.y = qy }
    }
  }
  return r
}

/** Upstream CleanPath: join near-collinear points of an OPEN path, keeping its endpoints. */
export function CleanPath(inp: Path, tolerance: number): Path {
  if (inp.length < 3) return inp.slice()
  const tmp = simplifyPath(inp, tolerance, true)
  const size = tmp.length
  if (size <= 2) return [inp[0], inp[inp.length - 1]]
  // restore the starting point: rotate the cleaned ring to start nearest the original start
  const clp = DistancePointToPathsSqrd([tmp], inp[0])
  const out: Path = []
  const prevIdx = clp.segIndex > 0 ? clp.segIndex - 1 : size - 1
  const c = { x: clp.x, y: clp.y }
  if (DistanceSqrd(c, tmp[clp.segIndex]) > 0 && DistanceSqrd(c, tmp[prevIdx]) > 0) out.push(c)
  for (let i = 0; i < size; i++) out.push(tmp[(clp.segIndex + i) % size])
  if (DistanceSqrd(out[0], inp[0]) > SAME_POINT_TOL_SQRD_SCALED) out.unshift(inp[0])
  if (DistanceSqrd(out[out.length - 1], inp[inp.length - 1]) > SAME_POINT_TOL_SQRD_SCALED) out.push(inp[inp.length - 1])
  return out
}

export function Compute2DPolygonCentroid(v: Path): IntPoint {
  let cx = 0, cy = 0, a2 = 0
  const n = v.length
  for (let i = 0; i < n; i++) {
    const x0 = v[i].x, y0 = v[i].y, x1 = v[(i + 1) % n].x, y1 = v[(i + 1) % n].y
    const a = x0 * y1 - x1 * y0
    a2 += a; cx += (x0 + x1) * a; cy += (y0 + y1) * a
  }
  const sa = a2 * 0.5
  return ip(cx / (6 * sa), cy / (6 * sa))
}

/** Segment–segment intersection (upstream IntersectionPoint). */
export function IntersectionPoint(s1p1: IntPoint, s1p2: IntPoint, s2p1: IntPoint, s2p2: IntPoint): boolean {
  const S1DX = s1p2.x - s1p1.x, S1DY = s1p2.y - s1p1.y
  const S2DX = s2p2.x - s2p1.x, S2DY = s2p2.y - s2p1.y
  const d = S1DY * S2DX - S2DY * S1DX
  if (Math.abs(d) < NTOL) return false
  const LPDX = s1p1.x - s2p1.x, LPDY = s1p1.y - s2p1.y
  const p1d = S2DY * LPDX - S2DX * LPDY
  const p2d = S1DY * LPDX - S1DX * LPDY
  if (d < 0 && (p1d < d || p1d > 0 || p2d < d || p2d > 0)) return false
  if (d > 0 && (p1d < 0 || p1d > d || p2d < 0 || p2d > d)) return false
  return true
}

export function SmoothPaths(paths: Paths, stepSize: number, pointCount: number, iterations: number): Paths {
  const scale = 1000
  const stepScaled = stepSize * scale
  const up = paths.map(p => p.map(q => ({ x: q.x * scale, y: q.y * scale })))
  const points: Array<{ i: number; p: IntPoint }> = []
  for (let i = 0; i < up.length; i++) {
    for (const pt of up[i]) {
      if (points.length === 0) { points.push({ i, p: pt }); continue }
      const back = points[points.length - 1]
      const lastPt = back.p
      const l = Math.sqrt(DistanceSqrd(lastPt, pt))
      if (l < 0.5 * stepScaled) {
        if (points.length > 1) points.pop()
        points.push({ i, p: pt })
        continue
      }
      const lastPathIndex = back.i
      const steps = Math.max(Math.trunc(l / stepScaled), 1)
      const left = pointCount * iterations * 2
      const right = steps - pointCount * iterations * 2
      for (let idx = 0; idx <= steps; idx++) {
        if (idx > left && idx < right) { idx = right; continue }
        const p = idx / steps
        const ptx = ip(lastPt.x + (pt.x - lastPt.x) * p, lastPt.y + (pt.y - lastPt.y) * p)
        if (idx === 0 && DistanceSqrd(back.p, ptx) < scale && points.length > 1) points.pop()
        points.push({ i: p < 0.5 ? lastPathIndex : i, p: ptx })
      }
    }
  }
  if (points.length === 0) return paths
  const size = points.length
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 1; i < size - 1; i++) {
      const cp = points[i].p
      let ax = cp.x, ay = cp.y, cnt = 1
      let pts = pointCount
      if (i <= pts) pts = Math.max(i - 1, 0)
      else if (i + pts >= size - 1) pts = size - 1 - i
      for (let j = i - pts; j <= i + pts; j++) {
        if (j === i) continue
        const q = points[Math.min(Math.max(j, 0), size - 1)].p
        ax += q.x; ay += q.y; cnt++
      }
      points[i].p = ip(ax / cnt, ay / cnt)
    }
  }
  const output: Paths = paths.map(() => [])
  for (const pr of points) output[pr.i].push(pr.p)
  return output.map(o => CleanPath(o, 1.4 * scale).map(q => ip(q.x / scale, q.y / scale)))
}

/** Pick and remove the finishing pass nearest p1 (upstream PopNextFinishingPass). Returns
 *  [isClosed, path]. */
export function PopNextFinishingPass(closed: Paths, open: Paths, p1: IntPoint, extraDistanceAround: number): [boolean, Path] {
  if (closed.length === 0 && open.length === 0) return [false, []]
  let minD = Infinity, cpi = 0, cpt = 0, isClosed = closed.length > 0
  for (let pi = 0; pi < closed.length; pi++) {
    const p = closed[pi]
    for (let i = 0; i < p.length; i++) {
      const d = DistanceSqrd(p1, p[i])
      if (d < minD) { minD = d; cpi = pi; cpt = i; isClosed = true }
    }
  }
  for (let pi = 0; pi < open.length; pi++) {
    const p = open[pi]
    if (p.length) {
      const d = DistanceSqrd(p1, p[0])
      if (d < minD) { minD = d; cpi = pi; cpt = 0; isClosed = false }
    }
  }
  if (!isClosed) { const r = open[cpi]; open.splice(cpi, 1); return [false, r] }
  const path = closed[cpi]
  closed.splice(cpi, 1)
  const result: Path = []
  let extra = extraDistanceAround
  while (extra > 0) {
    const nexti = (cpt + 1) % path.length
    const a = path[cpt], b = path[nexti]
    const dn = Math.sqrt(DistanceSqrd(a, b))
    cpt = nexti
    if (dn <= extra) extra -= dn
    else {
      const t = extra / dn
      result.push({ x: Math.trunc(a.x * (1 - t) + b.x * t), y: Math.trunc(a.y * (1 - t) + b.y * t), z: a.z })
      extra = 0
    }
  }
  for (let o = 0; o < path.length; o++) result.push(path[(cpt + o) % path.length])
  return [true, result]
}

export function DeduplicatePaths(inputs: Paths): Paths {
  const out: Paths = []
  for (const np of inputs) {
    let dup = false
    for (const op of out) {
      let all = true
      for (const p1 of np) {
        let exists = false
        for (const p2 of op) if (DistanceSqrd(p1, p2) < SAME_POINT_TOL_SQRD_SCALED) { exists = true; break }
        if (!exists) { all = false; break }
      }
      if (all) { dup = true; break }
    }
    if (!dup && np.length) out.push(np)
  }
  return out
}

export function ConnectPaths(input: Paths): Paths {
  const inp = input.map(p => p.slice())
  const output: Paths = []
  let newPath = true
  let joined: Path = []
  while (inp.length) {
    if (newPath) {
      if (joined.length) output.push(joined)
      joined = inp[0].slice()
      inp.shift()
      newPath = false
    }
    let any = false
    for (let i = 0; i < inp.length; i++) {
      const n = inp[i]
      if (DistanceSqrd(n[0], joined[joined.length - 1]) < SAME_POINT_TOL_SQRD_SCALED) {
        joined.push(...n); inp.splice(i, 1); any = true; break
      } else if (DistanceSqrd(n[n.length - 1], joined[joined.length - 1]) < SAME_POINT_TOL_SQRD_SCALED) {
        n.reverse(); joined.push(...n); inp.splice(i, 1); any = true; break
      } else if (DistanceSqrd(n[0], joined[0]) < SAME_POINT_TOL_SQRD_SCALED) {
        for (const pt of n) joined.unshift(pt)
        inp.splice(i, 1); any = true; break
      } else if (DistanceSqrd(n[n.length - 1], joined[0]) < SAME_POINT_TOL_SQRD_SCALED) {
        n.reverse(); for (const pt of n) joined.unshift(pt)
        inp.splice(i, 1); any = true; break
      }
    }
    if (!any) newPath = true
  }
  if (joined.length) output.push(joined)
  return output
}

/** Intersect a path (closed unless told otherwise) with an area, keeping its direction and
 *  joining the piece that runs through the closing point (upstream PathIntersectArea). */
export function PathIntersectArea(subjectIn: Path, obj: Paths, isClosed = true): Paths {
  const subj: Path = subjectIn.map((p, i) => ({ x: p.x, y: p.y, z: i * 2 + 1 }))
  if (isClosed && subj.length) subj.push({ x: subj[0].x, y: subj[0].y, z: subj.length * 2 + 1 })
  const clip = obj.map(path => path.map(p => ({ x: p.x, y: p.y, z: 0 })))
  const c = new Clipper64()
  c.zCallback = (e1b, e1t, e2b, e2t, p) => {
    if ((e1b.z ?? 0) !== 0 && (e1t.z ?? 0) !== 0) p.z = Math.trunc(((e1b.z ?? 0) + (e1t.z ?? 0)) / 2)
    else if ((e2b.z ?? 0) !== 0 && (e2t.z ?? 0) !== 0) p.z = Math.trunc(((e2b.z ?? 0) + (e2t.z ?? 0)) / 2)
  }
  c.addOpenSubject([subj])
  c.addPaths(clip, PathType.Clip)
  const closed: Paths = [], diff: Paths = []
  c.execute(ClipType.Intersection, FillRule.NonZero, closed, diff)
  for (const p of diff) {
    for (let i = 0; i < p.length - 1; i++) {
      const zi = p[i].z ?? 0, zj = p[i + 1].z ?? 0
      // z grows along the subject, so the first pair that differs gives the direction.
      // (Upstream tests zi+1 / zi+2 exactly, which misreads two new points on one edge.)
      if (zi !== 0 && zj !== 0 && zi !== zj) {
        if (zj < zi) p.reverse()
        break
      }
    }
  }
  const zstart = 1, zend = subj.length * 2 - 1
  let start: Path | null = null, end: Path | null = null
  const result: Paths = []
  for (const p of diff) {
    if ((p[0].z ?? 0) === zstart) start = p
    else if ((p[p.length - 1].z ?? 0) === zend) end = p
    else result.push(p)
  }
  if (start && end && isClosed) {
    const j = end.slice()
    for (let i = 1; i < start.length; i++) j.push(start[i])
    result.push(j)
  } else {
    if (start) result.push(start)
    if (end) result.push(end)
  }
  return result
}

// ─── Linear interpolation: area error vs steering angle (upstream Interpolation) ─────

interface InterpItem { angle: number; pos: IntPoint; error: number; isConventional: boolean }

export class Interpolation {
  readonly MIN_ANGLE = -Math.PI / 4
  readonly MAX_ANGLE = Math.PI / 4
  m_min: InterpItem | null = null
  m_max: InterpItem | null = null

  clear(): void { this.m_min = null; this.m_max = null }

  bothSides(): boolean {
    return !!this.m_min && !!this.m_max && this.m_min.error < 0 && this.m_max.error >= 0
      && (!this.m_min.isConventional || !this.m_max.isConventional)
  }

  addPoint(error: number, angle: number, pos: IntPoint, allowSkip: boolean, isConventional: boolean): void {
    const it: InterpItem = { angle, pos, error, isConventional }
    if (!this.m_min) this.m_min = it
    else if (!this.m_max) {
      this.m_max = it
      if (this.m_min.error > this.m_max.error) { const t = this.m_min; this.m_min = this.m_max; this.m_max = t }
    } else if (isConventional && (this.m_min.isConventional !== this.m_max.isConventional)) {
      if (!allowSkip) {
        if (this.m_min.isConventional) this.m_min = null; else this.m_max = null
        this.addPoint(error, angle, pos, false, isConventional)
      }
    } else if (this.bothSides()) {
      if (error < 0) this.m_min = it; else this.m_max = it
    } else {
      if (allowSkip && Math.abs(error) > Math.abs(this.m_min.error) && Math.abs(error) > Math.abs(this.m_max.error)
        && (isConventional || !this.m_min.isConventional || !this.m_max.isConventional)) return
      if (this.m_min.isConventional !== this.m_max.isConventional) {
        if (this.m_min.isConventional) this.m_min = null; else this.m_max = null
      } else if (Math.abs(this.m_min.error) > Math.abs(this.m_max.error)) this.m_min = null
      else this.m_max = null
      this.addPoint(error, angle, pos, false, isConventional)
    }
  }

  interpolateAngle(): number {
    if (!this.m_min) return this.MIN_ANGLE
    if (!this.m_max) return this.MAX_ANGLE
    let p = (0 - this.m_min.error) / (this.m_max.error - this.m_min.error)
    const minInterp = 0.2
    p = Math.max(Math.min(p, 1 - minInterp), minInterp)
    return this.m_min.angle * (1 - p) + this.m_max.angle * p
  }

  clampAngle(a: number): number { return Math.max(Math.min(a, this.MAX_ANGLE), this.MIN_ANGLE) }
}
