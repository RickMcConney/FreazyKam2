// Toolpath audit — test support, not shipped UI code.
//
// Answers "did this operation actually cut what it was supposed to?" by running the WHOLE
// pipeline the machine sees — strategy → generateGcode (arc fitting, simplification, post
// templates) → parseGcode → the sim's own Heightfield carve — and then comparing the
// resulting height map against the region the tool should have cleared.
//
// Going through gcode + the parser matters: bugs have hidden in the emitter (a dropped
// plunge turning a ring into a helix, an arc fit swallowing a loop) that are invisible to
// any check that stops at the strategy's MotionSegment[].
//
// Ground truth is the morphological OPENING of the cut region by the tool radius — erode by
// r, dilate by r — which is exactly the set a round tool of that radius can reach. Corner
// stock a tool physically cannot enter is therefore never counted as a miss.
//
// Two entry points:
//   auditPocket(...)       — synthetic geometry, for unit tests
//   auditProjectFile(...)  — a saved .fkam project, regenerated with the current code
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { generatePocket, type PocketParams } from '../cam/pocket'
import { generateGcode } from '../cam/gcode'
import { flattenPath, type Pt2 } from '../cam/pathFlattener'
import { parseGcode, type SimSegment, type ToolState } from './gcodeParser'
import { Heightfield, computeCutBounds, type HeightfieldGrid } from './heightfield'
import { useWorkpieceStore, zDatumOffsetMM } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import type { AnyOperation } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

// Arcs ON deliberately: arc fitting is part of what we are auditing.
export const AUDIT_POST: PostProcessorProfile = {
  id: 'audit', name: 'Audit', unitMode: 'mm', commentStyle: 'semicolon',
  startGcode: 'G21\nG90', endGcode: 'M5\nM30', toolChangeGcode: 'M5\nM0',
  spindleOnTemplate: 'M3 S{s}', spindleOffGcode: 'M5',
  rapidTemplate: 'G0 X{x} Y{y} Z{z}', cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
  arcCWTemplate: 'G2 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  arcCCWTemplate: 'G3 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  outputArcs: true,
}

const DEFAULT_CELL_MM = 0.25
const TOUCH_MM = 0.05        // height change that counts as "the tool was here"

export interface AuditOffender { x: number; y: number; heightMM: number }

/** A connected patch of offending cells — one physical sliver/ridge/scar. */
export interface AuditCluster {
  cells: number
  areaMM2: number
  x0: number; y0: number; x1: number; y1: number
  /** Narrow dimension of the patch — a leftover spine reads as a fraction of a mm. */
  widthMM: number
}

// Flood-fill offending cells into connected patches so a report names physical features
// ("a 0.4 mm spine 60 mm long") instead of listing hundreds of loose sample points.
function clusterMask(mask: Uint8Array, g: HeightfieldGrid, limit = 12): AuditCluster[] {
  const seen = new Uint8Array(mask.length)
  const out: AuditCluster[] = []
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    let cells = 0
    let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const k = stack.pop()!
      const i = k % g.NX, j = (k - i) / g.NX
      cells++
      if (i < i0) i0 = i
      if (j < j0) j0 = j
      if (i > i1) i1 = i
      if (j > j1) j1 = j
      if (i > 0 && mask[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack.push(k - 1) }
      if (i < g.NX - 1 && mask[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack.push(k + 1) }
      if (j > 0 && mask[k - g.NX] && !seen[k - g.NX]) { seen[k - g.NX] = 1; stack.push(k - g.NX) }
      if (j < g.NY - 1 && mask[k + g.NX] && !seen[k + g.NX]) { seen[k + g.NX] = 1; stack.push(k + g.NX) }
    }
    const x0 = g.gx0 + i0 * g.sx, x1 = g.gx0 + i1 * g.sx
    const y0 = g.gy0 + j0 * g.sy, y1 = g.gy0 + j1 * g.sy
    const spanX = x1 - x0 + g.sx, spanY = y1 - y0 + g.sy
    out.push({
      cells, areaMM2: cells * g.sx * g.sy, x0, y0, x1, y1,
      // Area / long side approximates the narrow dimension of a curved sliver better than
      // the bbox short side does.
      widthMM: cells * g.sx * g.sy / Math.max(spanX, spanY),
    })
  }
  return out.sort((a, b) => b.cells - a.cells).slice(0, limit)
}

/** What one operation was supposed to remove: `region` cleared flat to `depthMM`. */
export interface OpIntent {
  id: string
  name: string
  type: string
  /** Cut region as a clipper compound (CCW outers, CW holes), or null = intent not modeled. */
  region: Pt2[][] | null
  depthMM: number
  toolRadiusMM: number
}

export interface OpAudit {
  id: string
  name: string
  type: string
  modeled: boolean
  cellsToClear: number
  uncut: number
  shallow: number
  worstShallowMM: number
  uncutSamples: AuditOffender[]
  shallowSamples: AuditOffender[]
}

export interface AuditResult {
  cellMM: number
  gcode: string
  segmentCount: number
  simSegmentCount: number
  warnings: string[]
  cellsToClear: number
  uncut: number
  shallow: number
  /** Material removed where every modeled op says it must stay. -1 when not checked. */
  gouged: number
  worstShallowMM: number
  uncutSamples: AuditOffender[]
  shallowSamples: AuditOffender[]
  gougeSamples: AuditOffender[]
  uncutClusters: AuditCluster[]
  shallowClusters: AuditCluster[]
  gougeClusters: AuditCluster[]
  ops: OpAudit[]
}

// ─── region helpers ────────────────────────────────────────────────────────────

const toCP = (pts: Pt2[]) => pts.map(([x, y]) => ({ x, y }))
const fromCP = (r: { x: number; y: number }[]) => r.map(({ x, y }) => [x, y] as Pt2)

function signedArea(pts: Pt2[]): number {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
  }
  return a / 2
}

const orient = (pts: Pt2[], ccw: boolean) => (signedArea(pts) >= 0) === ccw ? pts : [...pts].reverse()

/** Offset a compound region (CCW outers + CW holes) by `delta`; negative shrinks. */
export function offsetRegion(rings: Pt2[][], delta: number): Pt2[][] {
  if (rings.length === 0) return rings
  if (delta === 0) return rings
  const res = inflatePathsD(rings.map(toCP), delta, JoinType.Round, EndType.Polygon, 4, 6)
  return res.map(fromCP).filter(r => r.length >= 3)
}

/** Boundary path minus island paths, as a clipper compound. */
export function regionFromPaths(boundaryD: string, islandDs: string[]): Pt2[][] {
  return [
    ...flattenPath(boundaryD, 0.05).filter(r => r.length >= 3).map(r => orient(r, true)),
    ...islandDs.flatMap(d => flattenPath(d, 0.05).filter(r => r.length >= 3).map(r => orient(r, false))),
  ]
}

// Even-odd scanline fill of a compound region into a cell mask. Scanline rather than
// per-cell point-in-polygon: the audit grid runs to hundreds of thousands of cells.
function rasterizeRegion(rings: Pt2[][], g: HeightfieldGrid): Uint8Array {
  const mask = new Uint8Array(g.NX * g.NY)
  const xs: number[] = []
  for (let j = 0; j < g.NY; j++) {
    const py = g.gy0 + j * g.sy
    xs.length = 0
    for (const ring of rings) {
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [x0, y0] = ring[k], [x1, y1] = ring[i]
        if ((y0 > py) === (y1 > py)) continue
        xs.push(x0 + ((py - y0) / (y1 - y0)) * (x1 - x0))
      }
    }
    if (xs.length < 2) continue
    xs.sort((a, b) => a - b)
    const rowBase = j * g.NX
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - g.gx0) / g.sx))
      const i1 = Math.min(g.NX - 1, Math.floor((xs[s + 1] - g.gx0) / g.sx))
      for (let i = i0; i <= i1; i++) mask[rowBase + i] = 1
    }
  }
  return mask
}

function ringsBBox(rings: Pt2[][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rings) for (const [x, y] of r) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1, empty: !isFinite(x0) }
}

// Grid covering both the cuts AND every op's intended region — a region that got no motion
// at all must still land on the grid, or a completely skipped op would score as a pass.
function auditGrid(
  W: number, H: number, T: number,
  segments: SimSegment[], toolStates: ToolState[],
  intents: OpIntent[], cellMM: number, orgX: number, orgY: number,
): HeightfieldGrid {
  const b = computeCutBounds(segments, toolStates, orgX, orgY, W, H)
  let x0 = b.empty ? Infinity : b.x0, y0 = b.empty ? Infinity : b.y0
  let x1 = b.empty ? -Infinity : b.x1, y1 = b.empty ? -Infinity : b.y1
  for (const it of intents) {
    if (!it.region) continue
    const rb = ringsBBox(it.region)
    if (rb.empty) continue
    x0 = Math.min(x0, rb.x0 - 1); y0 = Math.min(y0, rb.y0 - 1)
    x1 = Math.max(x1, rb.x1 + 1); y1 = Math.max(y1, rb.y1 + 1)
  }
  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = W; y1 = H }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0)
  x1 = Math.min(W, x1); y1 = Math.min(H, y1)
  const regionW = Math.max(x1 - x0, 1e-3), regionH = Math.max(y1 - y0, 1e-3)
  const NX = Math.max(2, Math.round(regionW / cellMM) + 1)
  const NY = Math.max(2, Math.round(regionH / cellMM) + 1)
  return {
    NX, NY,
    sx: regionW / (NX - 1), sy: regionH / (NY - 1),
    gx0: x0, gy0: y0, T, orgX, orgY,
  }
}

// ─── core ──────────────────────────────────────────────────────────────────────

/**
 * Carve `gcode` into a heightfield and score it against what `intents` say should have been
 * removed. Shared by both entry points.
 */
export function auditGcode(
  gcode: string,
  intents: OpIntent[],
  W: number, H: number, T: number,
  segmentCount: number,
  cellMM = DEFAULT_CELL_MM,
): AuditResult {
  // Frame handling must match ThreeView/simStore exactly: emitted G-code is in MACHINE
  // coordinates, so shift Z back to top-referenced (simStore.genZOff) and hand the heightfield
  // the origin offset it adds to every XY (ThreeView passes originWorldXY the same way).
  // Getting this wrong scores the whole job as uncut, which is a harness bug, not a CAM one.
  const { origin, zOrigin } = useWorkpieceStore.getState()
  const org = originWorldXY(origin, W, H)
  const zOff = zDatumOffsetMM(zOrigin, T)
  const parsed = parseGcode(gcode)
  const segments = zOff
    ? parsed.segments.map(s => ({ ...s, z: s.z - zOff, prevZ: s.prevZ - zOff }))
    : parsed.segments
  const grid = auditGrid(W, H, T, segments, parsed.toolStates, intents, cellMM, org.x, org.y)
  const hf = new Heightfield(grid)
  hf.carveAll(segments, parsed.toolStates)

  // Pull the "must clear" region in / push the "may cut" region out by a couple of cells so
  // the ragged cell boundary at a wall is not scored either way. The audit asserts about the
  // interior, not the edge quantization.
  const margin = 2 * cellMM + 0.05
  const expected = new Float32Array(grid.NX * grid.NY).fill(T)
  const mayCut = new Uint8Array(grid.NX * grid.NY)
  const opMasks: (Uint8Array | null)[] = []
  let allModeled = true

  for (const it of intents) {
    if (!it.region || it.region.length === 0) { allModeled = false; opMasks.push(null); continue }
    // Opening = what a round tool of this radius can physically clear.
    const reachable = offsetRegion(offsetRegion(it.region, -it.toolRadiusMM), it.toolRadiusMM)
    const mask = rasterizeRegion(offsetRegion(reachable, -margin), grid)
    // Material the op is allowed to remove is its region and nothing more — the tool CENTRE
    // stays a radius inside the wall, so the swept material never crosses it. (Dilating by the
    // radius here, as this once did, licensed the tool to eat a full radius into the wall and
    // made the audit blind to real gouges.)
    const allowed = rasterizeRegion(offsetRegion(it.region, margin), grid)
    const floor = T - it.depthMM
    for (let k = 0; k < mask.length; k++) {
      if (mask[k] && floor < expected[k]) expected[k] = floor
      if (allowed[k]) mayCut[k] = 1
    }
    opMasks.push(mask)
  }

  const classify = (mask: Uint8Array | null) => {
    const out = {
      cellsToClear: 0, uncut: 0, shallow: 0, worstShallowMM: 0,
      uncutSamples: [] as AuditOffender[], shallowSamples: [] as AuditOffender[],
      uncutMask: new Uint8Array(grid.NX * grid.NY),
      shallowMask: new Uint8Array(grid.NX * grid.NY),
    }
    if (!mask) return out
    for (let j = 0; j < grid.NY; j++) {
      for (let i = 0; i < grid.NX; i++) {
        const k = j * grid.NX + i
        if (!mask[k] || expected[k] >= T) continue
        out.cellsToClear++
        const h = hf.topZ[k]
        const x = grid.gx0 + i * grid.sx, y = grid.gy0 + j * grid.sy
        if (h > T - TOUCH_MM) {
          out.uncut++
          out.uncutMask[k] = 1
          if (out.uncutSamples.length < 20) out.uncutSamples.push({ x, y, heightMM: h })
        } else if (h > expected[k] + TOUCH_MM) {
          out.shallow++
          out.shallowMask[k] = 1
          out.worstShallowMM = Math.max(out.worstShallowMM, h - expected[k])
          if (out.shallowSamples.length < 20) out.shallowSamples.push({ x, y, heightMM: h })
        }
      }
    }
    return out
  }

  const ops: OpAudit[] = intents.map((it, n) => {
    const { uncutMask: _u, shallowMask: _s, ...stats } = classify(opMasks[n])
    return { id: it.id, name: it.name, type: it.type, modeled: opMasks[n] !== null, ...stats }
  })

  // Union coverage — a cell cleared by any op counts, so overlapping ops don't false-flag.
  const union = new Uint8Array(grid.NX * grid.NY)
  for (const m of opMasks) if (m) for (let k = 0; k < union.length; k++) if (m[k]) union[k] = 1
  const total = classify(union)

  let gouged = -1
  const gougeSamples: AuditOffender[] = []
  const gougeMask = new Uint8Array(grid.NX * grid.NY)
  if (allModeled && intents.length > 0) {
    gouged = 0
    for (let j = 0; j < grid.NY; j++) {
      for (let i = 0; i < grid.NX; i++) {
        const k = j * grid.NX + i
        if (mayCut[k]) continue
        const h = hf.topZ[k]
        if (h < T - TOUCH_MM) {
          gouged++
          gougeMask[k] = 1
          if (gougeSamples.length < 20) {
            gougeSamples.push({ x: grid.gx0 + i * grid.sx, y: grid.gy0 + j * grid.sy, heightMM: h })
          }
        }
      }
    }
  }

  return {
    cellMM: hf.cellMM,
    gcode,
    segmentCount,
    simSegmentCount: segments.length,
    warnings: parsed.warnings,
    cellsToClear: total.cellsToClear,
    uncut: total.uncut,
    shallow: total.shallow,
    gouged,
    worstShallowMM: total.worstShallowMM,
    uncutSamples: total.uncutSamples,
    shallowSamples: total.shallowSamples,
    gougeSamples,
    uncutClusters: clusterMask(total.uncutMask, grid),
    shallowClusters: clusterMask(total.shallowMask, grid),
    gougeClusters: clusterMask(gougeMask, grid),
    ops,
  }
}

// ─── entry point: synthetic pocket ─────────────────────────────────────────────

export interface AuditOptions {
  boundaryD: string
  islandDs?: string[]
  tool: Tool
  params: PocketParams
  /** Grid spacing for the audit height map (mm). Finer = slower, more sensitive. */
  cellMM?: number
}

/**
 * Generate one pocket, emit it as G-code, run the sim's carve, and compare the height map
 * with the region the tool should have cleared. Reads the workpiece store for stock
 * size/thickness/origin (set it in the test's `beforeEach`, as `gcode.test.ts` does).
 */
export function auditPocket(opts: AuditOptions): AuditResult {
  const { boundaryD, islandDs = [], tool, params } = opts
  const { widthMM: W, heightMM: H, thicknessMM: T } = useWorkpieceStore.getState()

  const segments = generatePocket(boundaryD, tool, { ...params, islandDs })
  const op = {
    id: 'audit-op', name: 'Audit', type: 'pocket', toolId: tool.id, pathId: 'p1',
    depthMM: params.depthMM, stepDownMM: params.stepDownMM, direction: params.direction,
    rampIn: params.rampIn, status: 'done', segments, color: '#fff', visible: true,
  } as unknown as AnyOperation
  const gcode = generateGcode([op], { [tool.id]: tool }, 'audit', AUDIT_POST)

  const allowance = params.finishAllowanceMM ?? 0
  const raw = regionFromPaths(boundaryD, islandDs)
  const intent: OpIntent = {
    id: 'audit-op', name: 'Audit', type: 'pocket',
    region: allowance !== 0 ? offsetRegion(raw, -allowance) : raw,
    depthMM: params.depthMM,
    toolRadiusMM: tool.diameterMM / 2,
  }
  return auditGcode(gcode, [intent], W, H, T, segments.length, opts.cellMM)
}

// ─── reporting ─────────────────────────────────────────────────────────────────

/** One-line summary for test failure messages. */
export function auditSummary(a: AuditResult): string {
  const s = (list: AuditOffender[]) =>
    list.slice(0, 4).map(o => `(${o.x.toFixed(1)},${o.y.toFixed(1)} h=${o.heightMM.toFixed(2)})`).join(' ')
  return [
    `cells=${a.cellsToClear} uncut=${a.uncut} shallow=${a.shallow} gouged=${a.gouged}`,
    `worstShallow=${a.worstShallowMM.toFixed(2)}mm cell=${a.cellMM.toFixed(3)}mm`,
    a.uncut ? `\n  uncut: ${s(a.uncutSamples)}` : '',
    a.shallow ? `\n  shallow: ${s(a.shallowSamples)}` : '',
    a.gouged > 0 ? `\n  gouged: ${s(a.gougeSamples)}` : '',
    a.warnings.length ? `\n  warnings: ${a.warnings.join(' | ')}` : '',
  ].join(' ')
}

/** Multi-line per-operation report — what to print when auditing a project file. */
export function auditReport(a: AuditResult): string {
  const lines = [
    `grid ${a.cellMM.toFixed(3)}mm · ${a.segmentCount} segments → ${a.simSegmentCount} sim moves`,
    `TOTAL  cells=${a.cellsToClear} uncut=${a.uncut} shallow=${a.shallow} ` +
    `gouged=${a.gouged < 0 ? 'n/a' : a.gouged} worstShallow=${a.worstShallowMM.toFixed(2)}mm`,
  ]
  for (const o of a.ops) {
    lines.push(o.modeled
      ? `  ${o.type} "${o.name}": cells=${o.cellsToClear} uncut=${o.uncut} shallow=${o.shallow} worst=${o.worstShallowMM.toFixed(2)}mm`
      : `  ${o.type} "${o.name}": intent not modeled — carved, but not scored`)
    const s = (list: AuditOffender[]) =>
      list.slice(0, 6).map(p => `(${p.x.toFixed(1)},${p.y.toFixed(1)} h=${p.heightMM.toFixed(2)})`).join(' ')
    if (o.uncut) lines.push(`      uncut at ${s(o.uncutSamples)}`)
    if (o.shallow) lines.push(`      shallow at ${s(o.shallowSamples)}`)
  }
  const clusterLines = (label: string, cs: AuditCluster[]) => {
    if (cs.length === 0) return
    lines.push(`  ${label}: ${cs.length} patch(es)`)
    for (const c of cs.slice(0, 8)) {
      lines.push(`      ${c.areaMM2.toFixed(1)}mm² ~${c.widthMM.toFixed(2)}mm wide, ` +
        `x ${c.x0.toFixed(1)}→${c.x1.toFixed(1)}  y ${c.y0.toFixed(1)}→${c.y1.toFixed(1)}`)
    }
  }
  clusterLines('UNCUT', a.uncutClusters)
  clusterLines('SHALLOW', a.shallowClusters)
  clusterLines('GOUGED', a.gougeClusters)
  if (a.warnings.length) lines.push(`  parser warnings: ${a.warnings.join(' | ')}`)
  return lines.join('\n')
}
