import DxfParser from 'dxf-parser'
import { perfLog } from '../debug'
import type { ImportedPath } from '../store/pathsStore'
import { PATH_COLOR } from '../colors'
import { uid } from '../uid'
import { getMultiBBox, translateD } from '../canvas/selectionUtils'
import { parseD, stringifyD, applyMat, type Mat6 } from './svgImporter'
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
      pts.push(`${pts.length === 0 ? 'M' : 'L'}${round4(p.x)},${round4(p.y)}`)
    } catch { /* skip degenerate spans */ }
  }
  if (closed && pts.length > 0) pts.push('Z')
  return pts.join(' ')
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

const IDENTITY: Mat6 = [1, 0, 0, 1, 0, 0]
const OCS_FLIP: Mat6 = [-1, 0, 0, 1, 0, 0]
// m1 ∘ m2 — m2 applied first.
function mul(m1: Mat6, m2: Mat6): Mat6 {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1]
}
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

  // LINE and partial ARC edges collected for stitching into connected paths
  const edges: Edge[] = []
  const pushPath = (d: string, name: string) => {
    if (!d.trim()) return
    paths.push({ id: uid('dxf-path'), name: `${name} ${++_pathCounter}`, d, visible: true, color: PATH_COLOR, groupId, groupName })
  }

  // `m` is where this list of entities lands: identity for the file's own entities, an
  // INSERT's placement (in mm) for a block's. Geometry is built in mm exactly as it always
  // was and only then carried through `m`, so a file with no blocks and no mirrored
  // entities imports byte-for-byte as before.
  let expanded = 0
  const collect = (entities: DxfAny[], m: Mat6, depth: number) => {
    for (const entity of entities) {
      if (depth > 0 && ++expanded > MAX_BLOCK_ENTITIES) { skip('block expansion over the limit'); return }
      // This entity's own frame: its object coordinate system, then where the list lands.
      let own = m
      if (OCS_TYPES.has(entity.type)) {
        const n = normalOf(entity as unknown as Record<string, unknown>)
        if (Math.abs(n.x) > 1e-6 || Math.abs(n.y) > 1e-6) { skip(`${skipLabel(entity.type)} (tilted)`); continue }
        const flipped = n.z < 0 || (entity.type === 'CIRCLE' && !!entity.handle && flippedCircles.has(entity.handle))
        if (flipped) own = mul(m, OCS_FLIP)
      }
      try {
        switch (entity.type) {
          case 'LINE': {
            const e = entity as import('dxf-parser').LineEntity
            const p0 = e.vertices[0], p1 = e.vertices[1]
            if (!p0 || !p1) continue
            // Skip zero-length segments
            if (Math.abs(p0.x - p1.x) < 1e-9 && Math.abs(p0.y - p1.y) < 1e-9) continue
            edges.push(mapEdge({ kind: 'L', x1: sc(p0.x), y1: sc(p0.y), x2: sc(p1.x), y2: sc(p1.y) }, own)!)
            continue  // handled via stitchEdges below
          }
          case 'LWPOLYLINE': {
            const e = entity as import('dxf-parser').LwpolylineEntity
            if (e.vertices.length < 2) continue
            pushPath(mapD(polyToD(e.vertices.map((v) => ({ x: sc(v.x), y: sc(v.y), bulge: v.bulge })), e.shape), own),
              e.shape ? 'Closed Polyline' : 'Polyline')
            continue
          }
          case 'POLYLINE': {
            const e = entity as import('dxf-parser').PolylineEntity
            if (e.vertices.length < 2) continue
            pushPath(mapD(polyToD(e.vertices.map((v) => ({ x: sc(v.x), y: sc(v.y), bulge: v.bulge })), e.shape), own), 'Polyline')
            continue
          }
          case 'ARC': {
            const e = entity as import('dxf-parser').ArcEntity
            const edge = arcEdge(sc(e.center.x), sc(e.center.y), sc(e.radius), e.startAngle, e.endAngle)
            if (edge) {
              const moved = mapEdge(edge, own)
              if (moved) edges.push(moved)
              else pushPath(mapD(edgeToD(edge), own), 'Arc')  // squashed by a non-uniform scale
              continue  // handled via stitchEdges below
            }
            pushPath(mapD(circleToD(sc(e.center.x), sc(e.center.y), sc(e.radius)), own), 'Circle')
            continue
          }
          case 'CIRCLE': {
            const e = entity as import('dxf-parser').CircleEntity
            pushPath(mapD(circleToD(sc(e.center.x), sc(e.center.y), sc(e.radius)), own), 'Circle')
            continue
          }
          case 'ELLIPSE': {
            const e = entity as import('dxf-parser').EllipseEntity
            pushPath(mapD(ellipseToD(
              sc(e.center.x), sc(e.center.y),
              sc(e.majorAxisEndPoint.x), sc(e.majorAxisEndPoint.y),
              e.axisRatio,
              e.startAngle, e.endAngle,
            ), own), 'Ellipse')
            continue
          }
          case 'SPLINE': {
            const e = entity as import('dxf-parser').SplineEntity
            pushPath(mapD(splineToD(
              e.controlPoints.map((p) => ({ x: sc(p.x), y: sc(p.y) })),
              e.degree,
              e.knots,
              e.closed,
            ), own), 'Spline')
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
            const cols = Math.max(1, e.columnCount ?? 1), rows = Math.max(1, e.rowCount ?? 1)
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const cell = translate(sc(c * (e.columnSpacing ?? 0)), sc(r * (e.rowSpacing ?? 0)))
                collect(block.entities ?? [], mul(own, mul(place, mul(cell, fromBase))), depth + 1)
              }
            }
            continue
          }
          default:
            if (!SILENT.has(entity.type)) skip(skipLabel(entity.type))
            continue
        }
      } catch { continue }
    }
  }
  collect(dxf.entities ?? [], IDENTITY, 0)

  // Stitch collected LINE and ARC edges into connected paths
  for (const d of stitchEdges(edges)) pushPath(d, 'Path')

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

type DxfAny = import('dxf-parser').DxfEntity & { handle?: string }
interface InsertEntity {
  type: 'INSERT'; name: string; position: { x: number; y: number }
  xScale?: number; yScale?: number; rotation?: number
  columnCount?: number; rowCount?: number; columnSpacing?: number; rowSpacing?: number
}
// The entities whose coordinates are in their object coordinate system (see above).
const OCS_TYPES = new Set(['CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'INSERT'])
