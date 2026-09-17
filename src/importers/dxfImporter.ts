import DxfParser from 'dxf-parser'
import { perfLog } from '../debug'
import type { ImportedPath } from '../store/pathsStore'
import { PATH_COLOR } from '../colors'
import { uid } from '../uid'
import { getMultiBBox, translateD } from '../canvas/selectionUtils'
import { douglasPeucker } from '../cam/pathFlattener'

export type DxfUnitsChoice = 'mm' | 'cm' | 'in' | 'ft' | 'm'

// DXF $INSUNITS → mm conversion factor
const INSUNITS_TO_MM: Record<number, number> = {
  1: 25.4,    // inches
  2: 304.8,   // feet
  3: 1609344, // miles
  4: 1,       // mm
  5: 10,      // cm
  6: 1000,    // m
  7: 1e6,     // km
}

const USER_UNITS_TO_MM: Record<DxfUnitsChoice, number> = {
  mm: 1, cm: 10, in: 25.4, ft: 304.8, m: 1000,
}

const fmt = (n: number) => +n.toFixed(4)

function polyToD(pts: { x: number; y: number }[], closed: boolean): string {
  if (pts.length < 2) return ''
  const parts = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)},${fmt(p.y)}`)
  if (closed) parts.push('Z')
  return parts.join(' ')
}

// DXF arcs go CCW in Y-up space (same as CNC). sweep=1 in CNC d strings = CCW visual.
function arcToD(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const s = (startDeg * Math.PI) / 180
  const e = (endDeg * Math.PI) / 180
  const x1 = cx + r * Math.cos(s)
  const y1 = cy + r * Math.sin(s)
  const x2 = cx + r * Math.cos(e)
  const y2 = cy + r * Math.sin(e)
  let span = endDeg - startDeg
  if (span <= 0) span += 360
  const lg = span > 180 ? 1 : 0
  // If nearly 360°, close the path instead of a degenerate arc
  if (Math.abs(span - 360) < 0.001) return circleToD(cx, cy, r)
  return `M${fmt(x1)},${fmt(y1)} A${fmt(r)},${fmt(r)},0,${lg},1,${fmt(x2)},${fmt(y2)}`
}

// Full circle: two semi-arcs. Direction doesn't matter visually; sweep=0 matches SVG importer convention.
function circleToD(cx: number, cy: number, r: number): string {
  return (
    `M${fmt(cx - r)},${fmt(cy)} ` +
    `A${fmt(r)},${fmt(r)},0,0,0,${fmt(cx + r)},${fmt(cy)} ` +
    `A${fmt(r)},${fmt(r)},0,0,0,${fmt(cx - r)},${fmt(cy)} Z`
  )
}

// Sample a DXF ELLIPSE as a polyline (handles rotation and partial arcs)
function ellipseToD(
  cx: number, cy: number,
  majX: number, majY: number,
  axisRatio: number,
  startAngle: number, endAngle: number,
): string {
  const rx = Math.sqrt(majX * majX + majY * majY)
  const ry = rx * axisRatio
  const rotRad = Math.atan2(majY, majX)
  let span = endAngle - startAngle
  if (span <= 0) span += 2 * Math.PI
  const isFull = Math.abs(span - 2 * Math.PI) < 0.001
  const steps = Math.max(32, Math.ceil(64 * span / (2 * Math.PI)))
  const pts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const t = startAngle + (span * i) / steps
    const ex = cx + rx * Math.cos(t) * Math.cos(rotRad) - ry * Math.sin(t) * Math.sin(rotRad)
    const ey = cy + rx * Math.cos(t) * Math.sin(rotRad) + ry * Math.sin(t) * Math.cos(rotRad)
    pts.push(`${i === 0 ? 'M' : 'L'}${fmt(ex)},${fmt(ey)}`)
  }
  if (isFull) pts.push('Z')
  return pts.join(' ')
}

// De Boor's algorithm for evaluating a B-spline at parameter t
function deBoor(
  pts: { x: number; y: number }[],
  degree: number,
  knots: number[],
  t: number,
): { x: number; y: number } {
  const n = pts.length - 1
  // Find knot span index k such that knots[k] <= t < knots[k+1]
  let k = degree
  for (let i = degree; i <= n; i++) {
    if (t >= knots[i] && (t < knots[i + 1] || i === n)) { k = i; break }
  }
  const d = pts.slice(k - degree, k + 1).map((p) => ({ x: p.x, y: p.y }))
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const denom = knots[k - degree + j + r] - knots[k - degree + j]
      const alpha = denom === 0 ? 0 : (t - knots[k - degree + j]) / denom
      d[j].x = (1 - alpha) * d[j - 1].x + alpha * d[j].x
      d[j].y = (1 - alpha) * d[j - 1].y + alpha * d[j].y
    }
  }
  return d[degree]
}

function splineToD(
  controlPoints: { x: number; y: number }[],
  degree: number,
  knots?: number[],
  closed?: boolean,
): string {
  if (controlPoints.length < 2) return ''
  if (!knots || knots.length < controlPoints.length + degree + 1) {
    return polyToD(controlPoints, closed ?? false)
  }
  const tMin = knots[degree]
  const tMax = knots[controlPoints.length]
  const steps = Math.max(32, controlPoints.length * 8)
  const pts: string[] = []
  for (let i = 0; i <= steps; i++) {
    // Clamp t slightly below tMax to stay within valid knot span
    const t = tMin + ((tMax - tMin) * i) / steps - (i === steps ? 1e-9 : 0)
    try {
      const p = deBoor(controlPoints, degree, knots, t)
      if (!isFinite(p.x) || !isFinite(p.y)) continue
      pts.push(`${pts.length === 0 ? 'M' : 'L'}${fmt(p.x)},${fmt(p.y)}`)
    } catch { /* skip degenerate spans */ }
  }
  if (closed && pts.length > 0) pts.push('Z')
  return pts.join(' ')
}

// Chain line segments whose endpoints coincide (within tol mm) into continuous
// polyline paths. Returns one SVG d string per connected component.
function stitchLines(
  segs: { x1: number; y1: number; x2: number; y2: number }[],
  tol = 0.001,
): string[] {
  const n = segs.length
  if (n === 0) return []

  // Quantised key for endpoint lookup
  const key = (x: number, y: number) =>
    `${Math.round(x / tol)},${Math.round(y / tol)}`

  type Adj = { segIdx: number; end: 0 | 1 }
  const adj = new Map<string, Adj[]>()

  for (let i = 0; i < n; i++) {
    const s = segs[i]
    const k0 = key(s.x1, s.y1)
    const k1 = key(s.x2, s.y2)
    if (!adj.has(k0)) adj.set(k0, [])
    if (!adj.has(k1)) adj.set(k1, [])
    adj.get(k0)!.push({ segIdx: i, end: 0 })
    adj.get(k1)!.push({ segIdx: i, end: 1 })
  }

  const used = new Uint8Array(n)
  const result: string[] = []

  for (let si = 0; si < n; si++) {
    if (used[si]) continue
    used[si] = 1
    const seg = segs[si]

    // Walk forward from p1
    const fwd: [number, number][] = [[seg.x2, seg.y2]]
    let cx = seg.x2, cy = seg.y2
    for (;;) {
      const nb = (adj.get(key(cx, cy)) ?? []).find(nb => !used[nb.segIdx])
      if (!nb) break
      used[nb.segIdx] = 1
      const s = segs[nb.segIdx]
      if (nb.end === 0) { cx = s.x2; cy = s.y2 }
      else              { cx = s.x1; cy = s.y1 }
      fwd.push([cx, cy])
    }

    // Walk backward from p0
    const bwd: [number, number][] = [[seg.x1, seg.y1]]
    cx = seg.x1; cy = seg.y1
    for (;;) {
      const nb = (adj.get(key(cx, cy)) ?? []).find(nb => !used[nb.segIdx])
      if (!nb) break
      used[nb.segIdx] = 1
      const s = segs[nb.segIdx]
      if (nb.end === 0) { cx = s.x2; cy = s.y2 }
      else              { cx = s.x1; cy = s.y1 }
      bwd.push([cx, cy])
    }

    // Full chain: reverse(bwd) + fwd
    let pts: [number, number][] = [...bwd.reverse(), ...fwd]
    if (pts.length < 2) continue

    const [fx, fy] = pts[0]
    const [lx, ly] = pts[pts.length - 1]
    const closed = Math.abs(fx - lx) < tol && Math.abs(fy - ly) < tol

    const beforeCount = pts.length

    // Simplify dense line-segment approximations (e.g. involute gear profiles
    // from DXF generators that emit 0.02–0.05 mm segments). Tolerance 0.01 mm
    // is well within CNC accuracy and preserves all real corners.
    if (pts.length > 4) {
      if (closed) {
        // Open the polygon, simplify, restore the closure
        const open = [...pts, pts[0]]
        const sim = douglasPeucker(open, 0.01) as [number, number][]
        sim.pop()
        if (sim.length >= 2) pts = sim
      } else {
        const sim = douglasPeucker(pts, 0.01) as [number, number][]
        if (sim.length >= 2) pts = sim
      }
    }

    perfLog(`[dxfImporter] chain ${result.length + 1}: ${beforeCount} pts → ${pts.length} pts (closed=${closed})`)

    let d = `M${fmt(pts[0][0])},${fmt(pts[0][1])}`
    const end = closed ? pts.length - 1 : pts.length
    for (let i = 1; i < end; i++) d += ` L${fmt(pts[i][0])},${fmt(pts[i][1])}`
    if (closed) d += ' Z'

    result.push(d)
  }

  return result
}

// Session-local numbering for display NAMES only ("Polyline 3") — ids come from
// uid() so they can never collide with ids loaded from a saved project.
let _pathCounter = 0

export interface DxfImportResult {
  paths: ImportedPath[]
  needsUnitsPrompt: boolean
  groupId: string
  error?: string  // set when the file failed to parse (vs. parsed but empty)
}

export function importDxf(
  text: string,
  groupName: string,
  unitsOverride?: DxfUnitsChoice,
  centerMM?: { x: number; y: number },
): DxfImportResult {
  const groupId = uid('dxf-group')

  let dxf: ReturnType<InstanceType<typeof DxfParser>['parseSync']>
  try {
    const parser = new DxfParser()
    dxf = parser.parseSync(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'not a valid DXF file'
    return { paths: [], needsUnitsPrompt: false, groupId, error: msg }
  }
  if (!dxf) return { paths: [], needsUnitsPrompt: false, groupId, error: 'not a valid DXF file' }

  const insunits: number = (dxf.header as { $INSUNITS?: number })?.$INSUNITS ?? 0
  let toMM: number
  let needsUnitsPrompt = false

  if (unitsOverride) {
    toMM = USER_UNITS_TO_MM[unitsOverride]
  } else if (INSUNITS_TO_MM[insunits]) {
    toMM = INSUNITS_TO_MM[insunits]
  } else {
    needsUnitsPrompt = true
    toMM = 1
  }

  const paths: ImportedPath[] = []
  const entities = dxf.entities ?? []

  // LINE segments collected for stitching into connected polylines
  const lineSegs: { x1: number; y1: number; x2: number; y2: number }[] = []

  for (const entity of entities) {
    let d = ''
    let name = ''

    try {
      const sc = (v: number) => v * toMM

      switch (entity.type) {
        case 'LINE': {
          const e = entity as import('dxf-parser').LineEntity
          const p0 = e.vertices[0], p1 = e.vertices[1]
          if (!p0 || !p1) continue
          // Skip zero-length segments
          if (Math.abs(p0.x - p1.x) < 1e-9 && Math.abs(p0.y - p1.y) < 1e-9) continue
          lineSegs.push({ x1: sc(p0.x), y1: sc(p0.y), x2: sc(p1.x), y2: sc(p1.y) })
          continue  // handled via stitchLines below
        }
        case 'LWPOLYLINE': {
          const e = entity as import('dxf-parser').LwpolylineEntity
          if (e.vertices.length < 2) continue
          d = polyToD(e.vertices.map((v) => ({ x: sc(v.x), y: sc(v.y) })), e.shape)
          name = e.shape ? 'Closed Polyline' : 'Polyline'
          break
        }
        case 'POLYLINE': {
          const e = entity as import('dxf-parser').PolylineEntity
          if (e.vertices.length < 2) continue
          d = polyToD(e.vertices.map((v) => ({ x: sc(v.x), y: sc(v.y) })), e.shape)
          name = 'Polyline'
          break
        }
        case 'ARC': {
          const e = entity as import('dxf-parser').ArcEntity
          d = arcToD(sc(e.center.x), sc(e.center.y), sc(e.radius), e.startAngle, e.endAngle)
          name = 'Arc'
          break
        }
        case 'CIRCLE': {
          const e = entity as import('dxf-parser').CircleEntity
          d = circleToD(sc(e.center.x), sc(e.center.y), sc(e.radius))
          name = 'Circle'
          break
        }
        case 'ELLIPSE': {
          const e = entity as import('dxf-parser').EllipseEntity
          d = ellipseToD(
            sc(e.center.x), sc(e.center.y),
            sc(e.majorAxisEndPoint.x), sc(e.majorAxisEndPoint.y),
            e.axisRatio,
            e.startAngle, e.endAngle,
          )
          name = 'Ellipse'
          break
        }
        case 'SPLINE': {
          const e = entity as import('dxf-parser').SplineEntity
          d = splineToD(
            e.controlPoints.map((p) => ({ x: sc(p.x), y: sc(p.y) })),
            e.degree,
            e.knots,
            e.closed,
          )
          name = 'Spline'
          break
        }
        default:
          continue
      }
    } catch { continue }

    if (!d.trim()) continue

    paths.push({
      id: uid('dxf-path'),
      name: `${name} ${++_pathCounter}`,
      d,
      visible: true,
      color: PATH_COLOR,
      groupId,
      groupName,
    })
  }

  // Stitch collected LINE segments into connected polylines
  for (const d of stitchLines(lineSegs)) {
    paths.push({
      id: uid('dxf-path'),
      name: `Path ${++_pathCounter}`,
      d,
      visible: true,
      color: PATH_COLOR,
      groupId,
      groupName,
    })
  }

  // Translate all paths so the group bbox center lands on centerMM (workpiece center)
  if (centerMM && paths.length > 0) {
    const bbox = getMultiBBox(paths.map((p) => p.d))
    if (bbox) {
      const dx = centerMM.x - (bbox.minX + bbox.maxX) / 2
      const dy = centerMM.y - (bbox.minY + bbox.maxY) / 2
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
        for (const path of paths) {
          path.d = translateD(path.d, dx, dy)
        }
      }
    }
  }

  return { paths, needsUnitsPrompt, groupId }
}
