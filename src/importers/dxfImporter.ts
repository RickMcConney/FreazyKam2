import DxfParser from 'dxf-parser'
import { perfLog } from '../debug'
import type { ImportedPath } from '../store/pathsStore'
import { PATH_COLOR } from '../colors'
import { colorByLayer } from './layers'
import { uid } from '../uid'
import { getMultiBBox, translateD } from '../canvas/selectionUtils'
import { parseD, stringifyD, applyMat, matMul as mul, IDENTITY, type Mat6 } from './svgImporter'
import { douglasPeucker } from '../cam/pathFlattener'
import { round4 } from '../util/num'

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


// A POLYLINE'S ARCS LIVE IN ITS BULGES. Each vertex may carry `bulge` = tan(θ/4), θ the
// included angle of the arc from that vertex to the next — positive CCW, negative CW, 0 or
// absent a straight line. It is how nearly every CAD package stores fillets, slot ends and
// rounded rectangles in a polyline, and reading only x/y imported each one as its chord.
// DXF is Y-up like CNC, so CCW is sweep=1 here exactly as in `arcEdge` below. A closed
// polyline's closing segment takes the LAST vertex's bulge.
function polyToD(pts: { x: number; y: number; bulge?: number }[], closed: boolean): string {
  if (pts.length < 2) return ''
  const seg = (a: { x: number; y: number; bulge?: number }, b: { x: number; y: number }): string => {
    const bulge = a.bulge ?? 0
    const chord = Math.hypot(b.x - a.x, b.y - a.y)
    if (Math.abs(bulge) < 1e-9 || chord < 1e-9) return `L${round4(b.x)},${round4(b.y)}`
    const theta = 4 * Math.atan(Math.abs(bulge))
    const r = chord / (2 * Math.sin(theta / 2))
    return `A${round4(r)},${round4(r)},0,${theta > Math.PI ? 1 : 0},${bulge > 0 ? 1 : 0},${round4(b.x)},${round4(b.y)}`
  }
  const parts = [`M${round4(pts[0].x)},${round4(pts[0].y)}`]
  for (let i = 1; i < pts.length; i++) parts.push(seg(pts[i - 1], pts[i]))
  if (closed) {
    const last = pts[pts.length - 1]
    if (Math.abs(last.bulge ?? 0) >= 1e-9) parts.push(seg(last, pts[0]))
    parts.push('Z')
  }
  return parts.join(' ')
}

// DXF arcs go CCW in Y-up space (same as CNC). sweep=1 in CNC d strings = CCW visual.
// Angles are RADIANS: the file stores degrees, but dxf-parser converts them.
// Returns null for a (near-)full circle, which the caller imports as a circle.
function arcEdge(cx: number, cy: number, r: number, s: number, e: number): Edge | null {
  let span = e - s
  if (span <= 0) span += 2 * Math.PI
  if (Math.abs(span - 2 * Math.PI) < 1e-5) return null
  return {
    kind: 'A',
    x1: cx + r * Math.cos(s), y1: cy + r * Math.sin(s),
    x2: cx + r * Math.cos(e), y2: cy + r * Math.sin(e),
    r, large: span > Math.PI ? 1 : 0,
  }
}

// Full circle: two semi-arcs. Direction doesn't matter visually; sweep=0 matches SVG importer convention.
function circleToD(cx: number, cy: number, r: number): string {
  return (
    `M${round4(cx - r)},${round4(cy)} ` +
    `A${round4(r)},${round4(r)},0,0,0,${round4(cx + r)},${round4(cy)} ` +
    `A${round4(r)},${round4(r)},0,0,0,${round4(cx - r)},${round4(cy)} Z`
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
    pts.push(`${i === 0 ? 'M' : 'L'}${round4(ex)},${round4(ey)}`)
  }
  if (isFull) pts.push('Z')
  return pts.join(' ')
}

// De Boor's algorithm for evaluating a B-spline at parameter t: find the span, then the
// blossom with every parameter t (see blossom below — one recurrence for both).
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
  return blossom(pts, degree, knots, k, Array(degree).fill(t))
}

/**
 * The B-spline's BLOSSOM (polar form) on knot span k, at the parameters `ts` (one per
 * degree): de Boor's recurrence with level r evaluated at ts[r-1] instead of one t
 * throughout. With every ts equal to t it IS the point at t; with a's and b's mixed it
 * gives the span's exact Bézier control points (below).
 */
function blossom(pts: { x: number; y: number }[], degree: number, knots: number[], k: number, ts: number[]): { x: number; y: number } {
  const d = pts.slice(k - degree, k + 1).map((p) => ({ x: p.x, y: p.y }))
  for (let r = 1; r <= degree; r++) {
    const t = ts[r - 1]
    for (let j = degree; j >= r; j--) {
      const lo = knots[k - degree + j], hi = knots[j + 1 + k - r]
      const alpha = hi === lo ? 0 : (t - lo) / (hi - lo)
      d[j].x = (1 - alpha) * d[j - 1].x + alpha * d[j].x
      d[j].y = (1 - alpha) * d[j - 1].y + alpha * d[j].y
    }
  }
  return d[degree]
}

/**
 * A spline of degree 1–3 as EXACT SVG segments — one per non-empty knot span: L for a
 * line, Q for a quadratic, C for a cubic. On span [a, b] the Bézier control points are
 * the blossoms f(a…a, b…b) with j b's for the j-th point, so the curve is not sampled at
 * all: it comes in with handles, as a pen-tool curve does, and edits as one. Null when
 * the degree has no SVG segment (above 3) or the knots do not fit, for the caller to
 * sample instead.
 */
function splineToBezierD(cps: { x: number; y: number }[], degree: number, knots: number[]): string | null {
  if (degree < 1 || degree > 3) return null
  const n = cps.length - 1
  if (knots.length < n + degree + 2) return null
  const fmt = (p: { x: number; y: number }) => `${round4(p.x)},${round4(p.y)}`
  const out: string[] = []
  for (let k = degree; k <= n; k++) {
    const a = knots[k], b = knots[k + 1]
    if (!(b > a)) continue
    const ctrl = Array.from({ length: degree + 1 }, (_, j) =>
      blossom(cps, degree, knots, k, [...Array(degree - j).fill(a), ...Array(j).fill(b)]))
    if (ctrl.some((p) => !isFinite(p.x) || !isFinite(p.y))) return null
    if (out.length === 0) out.push(`M${fmt(ctrl[0])}`)
    const cmd = degree === 1 ? 'L' : degree === 2 ? 'Q' : 'C'
    out.push(cmd + ctrl.slice(1).map(fmt).join(' '))
  }
  return out.length > 1 ? out.join(' ') : null
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
  const exact = splineToBezierD(controlPoints, degree, knots)
  if (exact) return closed ? exact + ' Z' : exact
  // Above cubic: no SVG segment can hold it, so it is sampled.
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
      pts.push(`${pts.length === 0 ? 'M' : 'L'}${round4(p.x)},${round4(p.y)}`)
    } catch { /* skip degenerate spans */ }
  }
  if (closed && pts.length > 0) pts.push('Z')
  return pts.join(' ')
}

/**
 * A SPLINE stored only as FIT points — the points the curve passes through, which is how
 * AutoCAD keeps one drawn by picking points until it is edited. dxf-parser gives no control
 * points for those, and the curve AutoCAD would solve also depends on end tangents and a
 * knot parameterisation it may not have written, so this is a centripetal Catmull–Rom
 * through the points as cubic Béziers: it passes through every one, is C1, and does not
 * loop or overshoot on uneven spacing.
 */
function fitPointsToD(pts: { x: number; y: number }[], closed: boolean): string {
  const n = pts.length
  if (n === 2) return `M${round4(pts[0].x)},${round4(pts[0].y)} L${round4(pts[1].x)},${round4(pts[1].y)}`
  // An open end has no neighbour beyond it: a phantom point mirrored through the end gives
  // the end the direction of its own chord, where a repeated point would stall it to zero.
  const at = (i: number): { x: number; y: number } => {
    if (closed) return pts[((i % n) + n) % n]
    if (i < 0) return { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y }
    if (i > n - 1) return { x: 2 * pts[n - 1].x - pts[n - 2].x, y: 2 * pts[n - 1].y - pts[n - 2].y }
    return pts[i]
  }
  const out = [`M${round4(pts[0].x)},${round4(pts[0].y)}`]
  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
    // Centripetal knot spacing (alpha = 0.5); a repeated end point gets a tiny interval.
    const d01 = Math.max(1e-9, Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y)))
    const d12 = Math.max(1e-9, Math.sqrt(Math.hypot(p2.x - p1.x, p2.y - p1.y)))
    const d23 = Math.max(1e-9, Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y)))
    // Tangents at p1 and p2 (Barry–Goldman), scaled to this segment's interval.
    const t1 = (k: 'x' | 'y') => (p1[k] - p0[k]) / d01 - (p2[k] - p0[k]) / (d01 + d12) + (p2[k] - p1[k]) / d12
    const t2 = (k: 'x' | 'y') => (p2[k] - p1[k]) / d12 - (p3[k] - p1[k]) / (d12 + d23) + (p3[k] - p2[k]) / d23
    const c1 = { x: p1.x + (t1('x') * d12) / 3, y: p1.y + (t1('y') * d12) / 3 }
    const c2 = { x: p2.x - (t2('x') * d12) / 3, y: p2.y - (t2('y') * d12) / 3 }
    out.push(`C${round4(c1.x)},${round4(c1.y)} ${round4(c2.x)},${round4(c2.y)} ${round4(p2.x)},${round4(p2.y)}`)
  }
  if (closed) out.push('Z')
  return out.join(' ')
}

// One stitchable DXF edge: a LINE, or a partial ARC (CCW from p0 to p1 in CNC
// Y-up, i.e. sweep=1). Full circles never get here — they are closed already.
type Edge =
  | { kind: 'L'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'A'; x1: number; y1: number; x2: number; y2: number; r: number; large: 0 | 1 }

// Chain LINE and ARC edges whose endpoints coincide (within tol mm) into
// continuous paths. Returns one SVG d string per connected component. Arcs must
// be stitched along with lines: an outline drawn as lines joined by fillet arcs
// (the usual CAD export) otherwise arrives as a pile of open fragments that
// can't be pocketed or profiled.
function stitchEdges(edges: Edge[], tol = 0.001): string[] {
  const n = edges.length
  if (n === 0) return []

  // Endpoint lookup on a tol grid. Lookups scan the 3×3 neighbourhood and then
  // check the real distance, so two points within tol that round into
  // adjacent cells still meet.
  const cell = (v: number) => Math.round(v / tol)
  type End = { edgeIdx: number; end: 0 | 1; x: number; y: number }
  const grid = new Map<string, End[]>()
  const add = (e: End) => {
    const k = `${cell(e.x)},${cell(e.y)}`
    let list = grid.get(k)
    if (!list) grid.set(k, (list = []))
    list.push(e)
  }
  for (let i = 0; i < n; i++) {
    const e = edges[i]
    add({ edgeIdx: i, end: 0, x: e.x1, y: e.y1 })
    add({ edgeIdx: i, end: 1, x: e.x2, y: e.y2 })
  }
  const used = new Uint8Array(n)
  // Drop duplicate edges (same kind, radius and endpoints, either direction).
  // CAD exports sometimes carry an edge drawn twice, and the walk would
  // otherwise run back along the copy.
  const seen = new Set<string>()
  for (let i = 0; i < n; i++) {
    const e = edges[i]
    const a = `${cell(e.x1)},${cell(e.y1)}`, b = `${cell(e.x2)},${cell(e.y2)}`
    // A reversed arc is a different arc, so only lines match in both directions.
    const k = e.kind === 'L' ? `L|${a < b ? a + '|' + b : b + '|' + a}` : `A|${cell(e.r)}|${e.large}|${a}|${b}`
    if (seen.has(k)) used[i] = 1
    else seen.add(k)
  }
  const findNext = (x: number, y: number): End | undefined => {
    const cx = cell(x), cy = cell(y)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const e of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (!used[e.edgeIdx] && Math.abs(e.x - x) <= tol && Math.abs(e.y - y) <= tol) return e
        }
      }
    }
    return undefined
  }

  // An edge as walked: `rev` means traversed from its p1 to its p0.
  type Step = { edgeIdx: number; rev: boolean }
  const endOf = (s: Step): [number, number] => {
    const e = edges[s.edgeIdx]
    return s.rev ? [e.x1, e.y1] : [e.x2, e.y2]
  }
  const startOf = (s: Step): [number, number] => {
    const e = edges[s.edgeIdx]
    return s.rev ? [e.x2, e.y2] : [e.x1, e.y1]
  }

  const result: string[] = []

  for (let si = 0; si < n; si++) {
    if (used[si]) continue
    used[si] = 1

    // Walk forward from p1, stopping once the chain is back at its start —
    // otherwise a third edge meeting there would be walked onto a closed loop.
    const fwd: Step[] = [{ edgeIdx: si, rev: false }]
    const [sx, sy] = startOf(fwd[0])
    let looped = false
    for (;;) {
      const [x, y] = endOf(fwd[fwd.length - 1])
      if (Math.abs(x - sx) <= tol && Math.abs(y - sy) <= tol) { looped = true; break }
      const nb = findNext(x, y)
      if (!nb) break
      used[nb.edgeIdx] = 1
      fwd.push({ edgeIdx: nb.edgeIdx, rev: nb.end === 1 })
    }
    // Walk backward from p0 (each step found is traversed toward the chain start)
    const bwd: Step[] = []
    while (!looped) {
      const [x, y] = bwd.length ? startOf(bwd[bwd.length - 1]) : startOf(fwd[0])
      const nb = findNext(x, y)
      if (!nb) break
      used[nb.edgeIdx] = 1
      bwd.push({ edgeIdx: nb.edgeIdx, rev: nb.end === 0 })
    }
    const steps = [...bwd.reverse(), ...fwd]

    const [fx, fy] = startOf(steps[0])
    const [lx, ly] = endOf(steps[steps.length - 1])
    const closed = Math.abs(fx - lx) <= tol && Math.abs(fy - ly) <= tol

    // Emit. Runs of consecutive lines are simplified — dense line-segment
    // approximations (e.g. involute gear profiles from DXF generators that emit
    // 0.02–0.05 mm segments) collapse at 0.01 mm, well within CNC accuracy and
    // preserving all real corners. Arcs are emitted exactly.
    let d = `M${round4(fx)},${round4(fy)}`
    let run: [number, number][] = [[fx, fy]]
    let pointCount = 1
    const flushRun = (isLast: boolean) => {
      if (run.length < 2) return
      let pts = run
      const allLinesClosed = closed && isLast && steps.every((s) => edges[s.edgeIdx].kind === 'L')
      if (pts.length > 4) {
        const sim = douglasPeucker(pts, 0.01) as [number, number][]
        if (sim.length >= 2) pts = sim
      }
      // A closed all-line chain ends with Z, which draws the last segment itself.
      const stop = allLinesClosed ? pts.length - 1 : pts.length
      for (let i = 1; i < stop; i++) d += ` L${round4(pts[i][0])},${round4(pts[i][1])}`
      pointCount += stop - 1
    }
    for (const s of steps) {
      const e = edges[s.edgeIdx]
      const [ex, ey] = endOf(s)
      if (e.kind === 'L') {
        run.push([ex, ey])
      } else {
        flushRun(false)
        // Reversing an arc flips its direction; the large-arc flag is unchanged.
        d += ` A${round4(e.r)},${round4(e.r)},0,${e.large},${s.rev ? 0 : 1},${round4(ex)},${round4(ey)}`
        pointCount++
        run = [[ex, ey]]
      }
    }
    flushRun(true)
    if (closed) d += ' Z'

    perfLog(`[dxfImporter] chain ${result.length + 1}: ${steps.length} edges → ${pointCount} pts (closed=${closed})`)
    result.push(d)
  }

  return result
}

// ─── Blocks and the object coordinate system ──────────────────────────────────
//
// A part drawn as a BLOCK arrives as one INSERT naming it: position, X/Y scale, rotation
// and optionally a rows × columns array. Its geometry lives in the BLOCKS section in the
// block's own coordinates, measured from the block's base point. Ignoring INSERT imported
// such a file as nothing.
//
// A 2D entity in a MIRRORED view carries extrusion (0,0,−1): its coordinates are in the
// object coordinate system, whose X axis then points the other way (the DXF arbitrary-axis
// rule gives Ax = (−1,0,0), Ay = (0,1,0) for that normal). Reading them as world X/Y put
// the part mirrored — and the ARCS the wrong way round, since "CCW" is CCW in the flipped
// plane. Only CIRCLE, ARC, LWPOLYLINE, 2D POLYLINE and INSERT are OCS entities; LINE,
// ELLIPSE and SPLINE are already world coordinates. A normal with any X or Y in it is a
// plane tilted out of the XY plane, which has no honest flat outline: it is skipped and
// reported, not flattened.

const OCS_FLIP: Mat6 = [-1, 0, 0, 1, 0, 0]
// `mul(m1, m2)` is svgImporter's matMul: m1 ∘ m2, m2 applied first.
const translate = (x: number, y: number): Mat6 => [1, 0, 0, 1, x, y]
const isIdentity = (m: Mat6) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12)
// Rotation, uniform scale and mirror keep a circular arc circular.
function isSimilarity([a, b, c, d]: Mat6): boolean {
  const n1 = a * a + b * b, n2 = c * c + d * d
  return Math.abs(a * c + b * d) < 1e-9 * Math.max(1, n1) && Math.abs(n1 - n2) < 1e-9 * Math.max(1, n1)
}
const mapD = (d: string, m: Mat6) => (isIdentity(m) ? d : stringifyD(applyMat(parseD(d), m)))

// An edge carried through `m`, still stitchable. An ARC stays an Edge only under a
// similarity (its radius just scales); under a mirror its CCW sweep would run CW, so the
// endpoints swap to keep the Edge convention (CCW from p0 to p1). Null for an arc under a
// non-uniform scale — it is an elliptical arc now, and goes out as a path of its own.
function mapEdge(e: Edge, m: Mat6): Edge | null {
  if (isIdentity(m)) return e
  const [a, b, c, d, tx, ty] = m
  const px = (x: number, y: number) => a * x + c * y + tx
  const py = (x: number, y: number) => b * x + d * y + ty
  const x1 = px(e.x1, e.y1), y1 = py(e.x1, e.y1), x2 = px(e.x2, e.y2), y2 = py(e.x2, e.y2)
  if (e.kind === 'L') return { kind: 'L', x1, y1, x2, y2 }
  if (!isSimilarity(m)) return null
  const r = e.r * Math.sqrt(a * a + b * b)
  return a * d - b * c < 0
    ? { kind: 'A', x1: x2, y1: y2, x2: x1, y2: y1, r, large: e.large }
    : { kind: 'A', x1, y1, x2, y2, r, large: e.large }
}
const edgeToD = (e: Edge) => e.kind === 'L'
  ? `M${round4(e.x1)},${round4(e.y1)} L${round4(e.x2)},${round4(e.y2)}`
  : `M${round4(e.x1)},${round4(e.y1)} A${round4(e.r)},${round4(e.r)},0,${e.large},1,${round4(e.x2)},${round4(e.y2)}`

// The extrusion normal, where dxf-parser keeps it: separate X/Y/Z fields on some
// entities, one point on others. Absent means the default (0,0,1).
function normalOf(e: Record<string, unknown>): { x: number; y: number; z: number } {
  const pt = e.extrusionDirection as { x?: number; y?: number; z?: number } | undefined
  return {
    x: (e.extrusionDirectionX as number | undefined) ?? pt?.x ?? 0,
    y: (e.extrusionDirectionY as number | undefined) ?? pt?.y ?? 0,
    z: (e.extrusionDirectionZ as number | undefined) ?? pt?.z ?? 1,
  }
}

/**
 * Handles of the CIRCLEs whose extrusion Z is negative. dxf-parser reads codes 210–230 on
 * ARC and LWPOLYLINE but not on CIRCLE, so a mirrored circle would land on the wrong side
 * of the part with nothing in the parsed entity to say so. One pass over the group codes;
 * a circle without a handle (code 5 is optional) cannot be matched and is left as parsed.
 */
function flippedCircleHandles(text: string): Set<string> {
  const out = new Set<string>()
  const lines = text.split(/\r?\n/)
  let inCircle = false, handle = '', z = 1
  const close = () => { if (inCircle && handle && z < 0) out.add(handle) }
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), val = lines[i + 1].trim()
    if (code === '0') { close(); inCircle = val === 'CIRCLE'; handle = ''; z = 1 }
    else if (inCircle && code === '5') handle = val
    else if (inCircle && code === '230') z = parseFloat(val)
  }
  close()
  return out
}

// What a skipped entity is called in the report. Text in all its forms is one thing to
// the user; what matters is that it has no outline to cut.
function skipLabel(type: string): string {
  if (type === 'TEXT' || type === 'MTEXT' || type === 'ATTDEF' || type === 'ATTRIB') return 'text'
  return type.toLowerCase()
}
// Entities that are never geometry, so leaving them out is not worth a word.
const SILENT = new Set(['VIEWPORT', 'SEQEND', 'VERTEX'])
// A block that inserts itself (directly or not) would recurse forever…
const MAX_BLOCK_DEPTH = 16
// …and one that inserts itself several times multiplies at every level inside it (three
// self-inserts is 3^16 ≈ 43 million). A cap on
// the entities expanded from blocks in all, far above any real drawing (an arrayed insert
// of a detailed part is thousands), keeps a hostile or broken file from hanging the tab.
const MAX_BLOCK_ENTITIES = 200_000

// Session-local numbering for display NAMES only ("Polyline 3") — ids come from
// uid() so they can never collide with ids loaded from a saved project.
let _pathCounter = 0

export interface DxfImportResult {
  paths: ImportedPath[]
  needsUnitsPrompt: boolean
  groupId: string
  error?: string  // set when the file failed to parse (vs. parsed but empty)
  // Entities left out, by what the user would call them ('text', 'hatch', 'dimension', …).
  // Empty when everything was imported.
  skipped: Record<string, number>
}

/** "3 text, 1 hatch" — the skipped report as a phrase for the status bar. */
export function describeSkipped(skipped: Record<string, number>): string {
  return Object.entries(skipped).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ')
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
    return { paths: [], needsUnitsPrompt: false, groupId, error: msg, skipped: {} }
  }
  if (!dxf) return { paths: [], needsUnitsPrompt: false, groupId, error: 'not a valid DXF file', skipped: {} }

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
  const blocks = (dxf as { blocks?: Record<string, { entities?: DxfAny[]; position?: { x: number; y: number } }> }).blocks ?? {}
  const flippedCircles = flippedCircleHandles(text)
  const skipped: Record<string, number> = {}
  const skip = (label: string) => { skipped[label] = (skipped[label] ?? 0) + 1 }
  const sc = (v: number) => v * toMM

  // LINE and partial ARC edges collected for stitching into connected paths — per LAYER
  // and per INSERT, so a label's stroke is never stitched onto the part outline it happens
  // to touch, and one part's edges never onto the next part's.
  const edgeSets = new Map<string, { layer?: string; groups: string[]; groupNames: string[]; edges: Edge[] }>()
  let layer: string | undefined
  // The INSERTs the current entity sits in, outermost first (ImportedPath.sourceGroups),
  // and the names of the blocks they place.
  let groups: string[] = []
  let groupNames: string[] = []
  const addEdge = (e: Edge) => {
    const key = `${layer ?? ''}\u0000${groups.join(',')}`
    const set = edgeSets.get(key)
    if (set) set.edges.push(e); else edgeSets.set(key, { layer, groups, groupNames, edges: [e] })
  }
  const pushPath = (d: string, name: string, onLayer = layer, inGroups = groups, inNames = groupNames) => {
    if (!d.trim()) return
    paths.push({
      id: uid('dxf-path'), name: `${name} ${++_pathCounter}`, d, visible: true, color: PATH_COLOR, groupId, groupName,
      ...(onLayer === undefined ? {} : { layer: onLayer }),
      ...(inGroups.length ? { sourceGroups: inGroups, sourceGroupNames: inNames } : {}),
    })
  }

  // `m` is where this list of entities lands: identity for the file's own entities, an
  // INSERT's placement (in mm) for a block's. Geometry is built in mm exactly as it always
  // was and only then carried through `m`, so a file with no blocks and no mirrored
  // entities imports byte-for-byte as before.
  let expanded = 0
  // `inherited` is the layer of the INSERT placing these entities: by the DXF convention a
  // block entity drawn on layer 0 takes on the layer it is inserted on.
  const collect = (entities: DxfAny[], m: Mat6, depth: number, inherited?: string, inGroups: string[] = [], inNames: string[] = []) => {
    for (const entity of entities) {
      groups = inGroups
      groupNames = inNames
      if (depth > 0 && ++expanded > MAX_BLOCK_ENTITIES) { skip('block expansion over the limit'); return }
      const own = (entity as { layer?: string }).layer?.trim()
      layer = own && !(own === '0' && inherited) ? own : inherited ?? (own || undefined)
      // This entity's own frame: its object coordinate system, then where the list lands.
      let ocs = m
      if (OCS_TYPES.has(entity.type)) {
        const n = normalOf(entity as unknown as Record<string, unknown>)
        if (Math.abs(n.x) > 1e-6 || Math.abs(n.y) > 1e-6) { skip(`${skipLabel(entity.type)} (tilted)`); continue }
        const flipped = n.z < 0 || (entity.type === 'CIRCLE' && !!entity.handle && flippedCircles.has(entity.handle))
        if (flipped) ocs = mul(m, OCS_FLIP)
      }
      try {
        switch (entity.type) {
          case 'LINE': {
            const e = entity as import('dxf-parser').LineEntity
            const p0 = e.vertices[0], p1 = e.vertices[1]
            if (!p0 || !p1) continue
            // Skip zero-length segments
            if (Math.abs(p0.x - p1.x) < 1e-9 && Math.abs(p0.y - p1.y) < 1e-9) continue
            addEdge(mapEdge({ kind: 'L', x1: sc(p0.x), y1: sc(p0.y), x2: sc(p1.x), y2: sc(p1.y) }, ocs)!)
            continue  // handled via stitchEdges below
          }
          case 'LWPOLYLINE': {
            const e = entity as import('dxf-parser').LwpolylineEntity
            if (e.vertices.length < 2) continue
            pushPath(mapD(polyToD(e.vertices.map((v) => ({ x: sc(v.x), y: sc(v.y), bulge: v.bulge })), e.shape), ocs),
              e.shape ? 'Closed Polyline' : 'Polyline')
            continue
          }
          case 'POLYLINE': {
            const e = entity as import('dxf-parser').PolylineEntity
            if (e.vertices.length < 2) continue
            pushPath(mapD(polyToD(e.vertices.map((v) => ({ x: sc(v.x), y: sc(v.y), bulge: v.bulge })), e.shape), ocs), 'Polyline')
            continue
          }
          case 'ARC': {
            const e = entity as import('dxf-parser').ArcEntity
            const edge = arcEdge(sc(e.center.x), sc(e.center.y), sc(e.radius), e.startAngle, e.endAngle)
            if (edge) {
              const moved = mapEdge(edge, ocs)
              if (moved) addEdge(moved)
              else pushPath(mapD(edgeToD(edge), ocs), 'Arc')  // squashed by a non-uniform scale
              continue  // handled via stitchEdges below
            }
            pushPath(mapD(circleToD(sc(e.center.x), sc(e.center.y), sc(e.radius)), ocs), 'Circle')
            continue
          }
          case 'CIRCLE': {
            const e = entity as import('dxf-parser').CircleEntity
            pushPath(mapD(circleToD(sc(e.center.x), sc(e.center.y), sc(e.radius)), ocs), 'Circle')
            continue
          }
          case 'ELLIPSE': {
            const e = entity as import('dxf-parser').EllipseEntity
            pushPath(mapD(ellipseToD(
              sc(e.center.x), sc(e.center.y),
              sc(e.majorAxisEndPoint.x), sc(e.majorAxisEndPoint.y),
              e.axisRatio,
              e.startAngle, e.endAngle,
            ), ocs), 'Ellipse')
            continue
          }
          case 'SPLINE': {
            const e = entity as import('dxf-parser').SplineEntity
            const cps = e.controlPoints ?? []
            const fits = e.fitPoints ?? []
            if (cps.length >= 2) {
              pushPath(mapD(splineToD(
                cps.map((p) => ({ x: sc(p.x), y: sc(p.y) })),
                e.degreeOfSplineCurve ?? 3,
                e.knotValues,
                e.closed,
              ), ocs), 'Spline')
            } else if (fits.length >= 2) {
              // Only the points the curve passes THROUGH: a smooth curve through them.
              pushPath(mapD(fitPointsToD(fits.map((p) => ({ x: sc(p.x), y: sc(p.y) })), e.closed ?? false), ocs), 'Spline')
            } else {
              skip('spline (no points)')
            }
            continue
          }
          case 'INSERT': {
            const e = entity as unknown as InsertEntity
            const block = blocks[e.name]
            if (!block) { skip('missing block'); continue }
            if (depth >= MAX_BLOCK_DEPTH) { skip('block nested too deep'); continue }
            // position · rotation · (array cell) · scale · −base, all translations in mm.
            const rot = ((e.rotation ?? 0) * Math.PI) / 180
            const cos = Math.cos(rot), sin = Math.sin(rot)
            const base = block.position ?? { x: 0, y: 0 }
            const sx = e.xScale ?? 1, sy = e.yScale ?? 1
            const place = mul(translate(sc(e.position.x), sc(e.position.y)), [cos, sin, -sin, cos, 0, 0])
            const fromBase = mul([sx, 0, 0, sy, 0, 0], translate(-sc(base.x), -sc(base.y)))
            const cols = Math.max(1, Math.floor(e.columnCount ?? 1)), rows = Math.max(1, Math.floor(e.rowCount ?? 1))
            // PRICE THE ARRAY BEFORE WALKING IT. The cap above is counted per entity, inside
            // collect, so it never bounded this loop: a 32767 × 32767 array — or any array of an
            // EMPTY block, which counts nothing at all — walked ~1e9 cells, allocating per cell,
            // which is the hang the cap exists to prevent. Each cell costs at least 1.
            const n = block.entities?.length ?? 0
            if (expanded + rows * cols * Math.max(1, n) > MAX_BLOCK_ENTITIES) { skip('block expansion over the limit'); continue }
            if (n === 0) { expanded += rows * cols; continue }
            // Captured: each cell's entities reset `layer` as they go.
            const insertLayer = layer
            cells: for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                // Nested inserts can still run past the cap partway through; stop there.
                if (expanded > MAX_BLOCK_ENTITIES) break cells
                const cell = translate(sc(c * (e.columnSpacing ?? 0)), sc(r * (e.rowSpacing ?? 0)))
                // Every cell is a part of its own, so every cell is a group of its own.
                collect(block.entities ?? [], mul(ocs, mul(place, mul(cell, fromBase))), depth + 1, insertLayer,
                  [...inGroups, uid('srcg')], [...inNames, e.name])
              }
            }
            continue
          }
          default:
            if (!SILENT.has(entity.type)) skip(skipLabel(entity.type))
            continue
        }
      } catch {
        // An entity the parser handed over in a shape this code cannot read. Reported like
        // any other left-out entity — a curve silently missing from a part outline is the
        // one thing an import must never do.
        skip(`${skipLabel(entity.type ?? 'entity')} (unreadable)`)
        continue
      }
    }
  }
  collect(dxf.entities ?? [], IDENTITY, 0)

  // Stitch collected LINE and ARC edges into connected paths, each layer on its own
  for (const set of edgeSets.values()) for (const d of stitchEdges(set.edges)) pushPath(d, 'Path', set.layer, set.groups, set.groupNames)
  colorByLayer(paths, layerTableColors(dxf))

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

  return { paths, needsUnitsPrompt, groupId, skipped }
}

/** Each layer's colour from the file's LAYER table, as '#rrggbb' (dxf-parser has already
 *  turned the colour index into RGB). */
function layerTableColors(dxf: unknown): Map<string, string> {
  const layers = (dxf as { tables?: { layer?: { layers?: Record<string, { color?: number }> } } })
    .tables?.layer?.layers ?? {}
  const out = new Map<string, string>()
  for (const [name, l] of Object.entries(layers)) {
    if (typeof l.color === 'number' && l.color >= 0) out.set(name, '#' + l.color.toString(16).padStart(6, '0'))
  }
  return out
}

type DxfAny = import('dxf-parser').DxfEntity & { handle?: string }
interface InsertEntity {
  type: 'INSERT'; name: string; position: { x: number; y: number }
  xScale?: number; yScale?: number; rotation?: number
  columnCount?: number; rowCount?: number; columnSpacing?: number; rowSpacing?: number
}
// The entities whose coordinates are in their object coordinate system (see above).
const OCS_TYPES = new Set(['CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'INSERT'])
