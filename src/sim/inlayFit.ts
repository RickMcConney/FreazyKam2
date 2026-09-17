// Inlay fit audit — does the male plug actually drop into the female socket?
//
// Test support, not shipped UI code. Sibling of toolpathAudit.ts and built on the same
// machinery: strategy → generateGcode → parseGcode → the sim's Heightfield carve. Both
// halves of the inlay are carved into height maps on ONE shared grid and then checked
// against each other.
//
// ─── The assembly maths ───────────────────────────────────────────────────────────────
//
// Both boards are machined face-up. Write each machined surface top-referenced, so 0 is
// the untouched board face and negative is into the material:
//
//   female:  material where  z ≤ F(x,y)          (F ≤ 0; the socket is where F < 0)
//   male:    material where  z ≤ M(x,y)          (M ≤ 0; the plug is where M = 0)
//
// The male board is turned over and pressed in. Turning it about a vertical axis through
// x = cx maps (x, y, z) → (2cx − x, y, −z); the plug then hangs below the male's cleared
// background plane, which is `plugDepthMM` (D) below its own face, so the assembled male
// occupies
//
//   z ≥ −M(2cx − x, y) − D
//
// The two solids may not overlap, so the whole fit reduces to one inequality:
//
//   FIT:   F(x,y) + M(2cx − x, y) + D  ≤  0        everywhere inside the socket footprint
//
// and the quantity on the left, negated, is the physical air gap between the two surfaces:
//
//   gap(x,y) = −(F + M' + D)     ≥ 0 fits, < 0 is interference (mm of wood in the way)
//
// A correct V-inlay has gap ≈ 0 along the tapered walls (that is the wedge that makes the
// joint tight), gap ≈ glueLineMM across the socket floor, and gap ≈ 0 on the land outside
// the socket where the male's background plane rests on the female's face.
//
// Two failure modes are scored:
//
//   INTERFERENCE — gap < 0. Wood where wood already is; the plug will not seat. This is
//                  the one that makes an inlay unusable.
//
//   SURFACE GAP  — the joint closes, but the finished face has a hole in it. Once the
//                  assembly is planed back to the female's face, the material visible at
//                  z = 0⁻ is female wood where F = 0, and male wood wherever the plug
//                  reaches above the face — which is M > −D. So a hole is exactly
//
//                      F < 0   and   M ≤ −D
//
//                  i.e. the female cut a cavity and the male never grew a plug to fill
//                  it. Deliberate slack does NOT trip this: the glue line, the clearance
//                  band around the plug, and the V-carve's own over-cut ring in the
//                  socket floor all sit below the face with plug material above them.
//
// ─── Mirroring ────────────────────────────────────────────────────────────────────────
//
// By default the male is generated with mirrorX = false and compared in the DESIGN frame
// (no 2cx − x). That answers "is the male geometry the correct complement of the female",
// which is the question about the CAM, and it presumes the mirror is applied correctly
// somewhere. Pass `checkMirror` to instead generate with mirrorX = true and sample at
// 2cx − x — the physical assembly, which additionally tests the form's own mirroring.
import { generateInlayFemale, generateInlayMale, type InlayParams } from '../cam/inlay'
import { generateGcode } from '../cam/gcode'
import { flattenPath, type Pt2 } from '../cam/pathFlattener'
import { parseGcode } from './gcodeParser'
import { Heightfield, type HeightfieldGrid } from './heightfield'
import { AUDIT_POST, regionFromPaths, offsetRegion, type AuditCluster } from './toolpathAudit'
import { useWorkpieceStore, zDatumOffsetMM } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

const DEFAULT_CELL_MM = 0.1

/** One boundary + its direct island children — exactly what groupPathsByContainment yields. */
export interface InlayFitGroup {
  boundaryD: string
  islandDs?: string[]
  /** Parallel to islandDs: paths nested directly inside each island (the next level's plugs). */
  islandPlugDs?: string[][]
  name?: string
}

export interface InlayFitOptions {
  groups: InlayFitGroup[]
  /** Roughing / profile end mill. */
  roughTool: Tool
  /** Wall tool: a V-bit, an end mill, or null for "None — roughing only". */
  wallTool: Tool | null
  params: Omit<InlayParams, 'islandDs' | 'mirrorX'>
  cellMM?: number
  /**
   * Lateral slop allowed before a cell counts, in cells. One cell absorbs the ±half-cell
   * rasterization error of each of the two surfaces at a vertical wall, which would
   * otherwise read as a one-cell ring of interference along every wall.
   */
  slopCells?: number
  /**
   * Generate the male with `mirrorX: true` and compare it flipped about the design's
   * vertical centre line — the physical assembly. Default (false) compares in the design
   * frame, isolating the male GEOMETRY from the mirror convention.
   */
  checkMirror?: boolean
}

export interface InlayFitStats {
  cells: number
  areaMM2: number
  worstMM: number
  clusters: AuditCluster[]
  samples: { x: number; y: number; mm: number }[]
}

export interface InlayFitResult {
  cellMM: number
  femaleGcode: string
  maleGcode: string
  warnings: string[]
  /** Cells inside the audited footprint (the denominator for the two scores). */
  footprintCells: number
  /** Cells the female actually cut — the socket proper. */
  socketCells: number
  interference: InlayFitStats
  /** Socket cells with no plug material at the finished face — a hole in the inlay. */
  surfaceGaps: InlayFitStats
  /** Air gap across the socket floor and walls, for sanity: min / median / max in mm. */
  gapMinMM: number
  gapMedianMM: number
  gapMaxMM: number
}

// ─── helpers ──────────────────────────────────────────────────────────────────────────

function opsFor(
  segsByTool: { toolId: string; name: string; segs: MotionSegment[] }[],
  angleDeg: number,
): AnyOperation[] {
  return segsByTool
    .filter(s => s.segs.length > 0)
    .map((s, i) => ({
      id: `fit-${i}`, name: s.name, type: 'inlay', role: 'female', phase: 'endmill',
      toolId: s.toolId, pathId: 'p1', angleDeg,
      depthMM: 0, stepDownMM: 1, direction: 'climb',
      status: 'done', segments: s.segs, color: '#fff', visible: true,
    } as unknown as AnyOperation))
}

// Even-odd scanline fill of a compound region into a cell mask (same method as
// toolpathAudit's rasterizeRegion, kept local so the grid type stays private there).
function rasterize(rings: Pt2[][], g: HeightfieldGrid): Uint8Array {
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
      widthMM: cells * g.sx * g.sy / Math.max(spanX, spanY),
    })
  }
  return out.sort((a, b) => b.cells - a.cells).slice(0, limit)
}

function statsFrom(
  mask: Uint8Array, depth: Float32Array, g: HeightfieldGrid,
): InlayFitStats {
  let cells = 0, worst = 0
  const samples: { x: number; y: number; mm: number }[] = []
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue
    cells++
    const v = depth[k]
    if (v > worst) worst = v
    if (samples.length < 20) {
      const i = k % g.NX, j = (k - i) / g.NX
      samples.push({ x: g.gx0 + i * g.sx, y: g.gy0 + j * g.sy, mm: v })
    }
  }
  return { cells, areaMM2: cells * g.sx * g.sy, worstMM: worst, clusters: clusterMask(mask, g), samples }
}

// ─── entry point ──────────────────────────────────────────────────────────────────────

/**
 * Generate both halves of an inlay, carve them, and score the fit.
 *
 * Reads the workpiece store for stock size / thickness / origin, exactly as auditPocket
 * does — set it in the test's beforeEach.
 */
export async function auditInlayFit(opts: InlayFitOptions): Promise<InlayFitResult> {
  const { groups, roughTool, wallTool, params } = opts
  const cellMM = opts.cellMM ?? DEFAULT_CELL_MM
  const slopCells = opts.slopCells ?? 1
  const D = params.pocketDepthMM
  const { widthMM: W, heightMM: H, thicknessMM: T } = useWorkpieceStore.getState()

  const toolsById: Record<string, Tool> = { [roughTool.id]: roughTool }
  if (wallTool) toolsById[wallTool.id] = wallTool
  const wallToolId = wallTool ? wallTool.id : roughTool.id

  // ── generate both halves ────────────────────────────────────────────────────────────
  const femaleParts: { toolId: string; name: string; segs: MotionSegment[] }[] = []
  const malePartsList: { toolId: string; name: string; segs: MotionSegment[] }[] = []
  // Male generation is deferred until the design bbox (and so the flip axis) is known.
  const maleGen: { boundaryD: string; p: InlayParams; label: string }[] = []
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const p: InlayParams = {
      ...params, islandDs: g.islandDs ?? [], islandPlugDs: g.islandPlugDs ?? [], mirrorX: false,
    }
    const label = g.name ?? `g${gi}`
    const f = await generateInlayFemale(g.boundaryD, roughTool, wallTool, p)
    femaleParts.push({ toolId: roughTool.id, name: `F rough ${label}`, segs: f.endmillSegs })
    femaleParts.push({ toolId: wallToolId, name: `F wall ${label}`, segs: f.vbitSegs })
    maleGen.push({ boundaryD: g.boundaryD, p, label })
  }

  // ── one shared grid for both carves ─────────────────────────────────────────────────
  // Spanning the design footprint plus a margin: the male's release cut and the socket's
  // outward clearance both run a little outside the drawn boundary.
  const boundaryRings = groups.flatMap(g => flattenPath(g.boundaryD, 0.05).filter(r => r.length >= 3))
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
  for (const r of boundaryRings) for (const [x, y] of r) {
    if (x < bx0) bx0 = x
    if (y < by0) by0 = y
    if (x > bx1) bx1 = x
    if (y > by1) by1 = y
  }
  if (!isFinite(bx0)) throw new Error('inlay fit: no boundary geometry')
  const pad = Math.max(2, roughTool.diameterMM)
  const gx0 = Math.max(0, bx0 - pad), gy0 = Math.max(0, by0 - pad)
  const gx1 = Math.min(W, bx1 + pad), gy1 = Math.min(H, by1 + pad)
  const regionW = Math.max(gx1 - gx0, 1e-3), regionH = Math.max(gy1 - gy0, 1e-3)
  const NX = Math.max(2, Math.round(regionW / cellMM) + 1)
  const NY = Math.max(2, Math.round(regionH / cellMM) + 1)
  const { origin, zOrigin } = useWorkpieceStore.getState()
  const org = originWorldXY(origin, W, H)
  const grid: HeightfieldGrid = {
    NX, NY, sx: regionW / (NX - 1), sy: regionH / (NY - 1),
    gx0, gy0, T, orgX: org.x, orgY: org.y,
  }

  // ── male, now that the flip axis is known ───────────────────────────────────────────
  // Mirror axis: the male board is turned over about the vertical centre line of the
  // design — ONE line for every group, which is what the form stores on each op.
  const cx = (bx0 + bx1) / 2
  for (const { boundaryD, p, label } of maleGen) {
    const m = await generateInlayMale(boundaryD, roughTool, wallTool,
      { ...p, mirrorX: opts.checkMirror ?? false, mirrorAxisX: cx })
    malePartsList.push({ toolId: wallToolId, name: `M wall ${label}`, segs: m.vbitSegs })
    malePartsList.push({ toolId: roughTool.id, name: `M rough ${label}`, segs: m.endmillSegs })
  }

  const angleDeg = params.angleDeg
  const femaleGcode = generateGcode(opsFor(femaleParts, angleDeg), toolsById, 'fit-female', AUDIT_POST)
  const maleGcode = generateGcode(opsFor(malePartsList, angleDeg), toolsById, 'fit-male', AUDIT_POST)

  const zOff = zDatumOffsetMM(zOrigin, T)
  const carve = (gcode: string) => {
    const parsed = parseGcode(gcode)
    const segments = zOff
      ? parsed.segments.map(s => ({ ...s, z: s.z - zOff, prevZ: s.prevZ - zOff }))
      : parsed.segments
    const hf = new Heightfield(grid)
    hf.carveAll(segments, parsed.toolStates)
    return { hf, warnings: parsed.warnings }
  }
  const female = carve(femaleGcode)
  const male = carve(maleGcode)

  // ── compare ─────────────────────────────────────────────────────────────────────────

  // Footprint = everything inside the outermost boundaries, grown by the clearance the
  // socket adds. Outside it the male is waste to be cut away, so it is not compared.
  const footprintRings = groups.flatMap(g => regionFromPaths(g.boundaryD, []))
  const footprint = rasterize(offsetRegion(footprintRings, Math.max(0, params.clearanceMM)), grid)

  const interfereMask = new Uint8Array(NX * NY)
  const interfereDepth = new Float32Array(NX * NY)
  const gapMask = new Uint8Array(NX * NY)
  const gapDepth = new Float32Array(NX * NY)
  const socketMask = new Uint8Array(NX * NY)

  // Interference has to survive `slopCells` of lateral slack before it counts: at a
  // vertical wall the two surfaces are quantized independently, and a plug that is one
  // cell proud reads as a full-depth ring of interference that a hundredth of a mm of
  // real-world slop would absorb. Taking the deepest male sample in the neighbourhood is
  // the same as eroding the plug laterally by that much.
  const TOL_MM = 1e-3
  // How far the plug must clear the face before it counts as present. One cell of
  // quantization plus a hair; a genuine missing plug misses by the full depth.
  const FACE_TOL_MM = Math.max(0.05, 1.5 * cellMM)
  // The male is dilated by the clearance as well as the slop when asking "is there plug
  // material here" — the clearance is a deliberate lateral gap all the way round the plug,
  // so without this every plug reports a hole the width of its own fit gap.
  const gapSlop = slopCells + Math.ceil(Math.max(0, params.clearanceMM) / cellMM)

  let footprintCells = 0, socketCells = 0
  const gapValues: number[] = []
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i
      if (!footprint[k]) continue
      footprintCells++
      const F = female.hf.topZ[k] - T
      // Mirrored male sample. Both extremes over the slop window are taken so each check
      // gets the benefit of the doubt: the lowest surface (plug eroded laterally) for
      // interference, the highest (plug dilated) for voids.
      const mi = opts.checkMirror
        ? Math.round((2 * cx - (gx0 + i * grid.sx) - gx0) / grid.sx)
        : i
      let mHigh = -Infinity, mLow = Infinity
      for (let dj = -gapSlop; dj <= gapSlop; dj++) {
        const jj = j + dj
        if (jj < 0 || jj >= NY) continue
        for (let di = -gapSlop; di <= gapSlop; di++) {
          const ii = mi + di
          if (ii < 0 || ii >= NX) continue
          const v = male.hf.topZ[jj * NX + ii] - T
          if (v > mHigh) mHigh = v
          if (Math.abs(dj) <= slopCells && Math.abs(di) <= slopCells && v < mLow) mLow = v
        }
      }
      if (!isFinite(mHigh) || !isFinite(mLow)) continue

      const gapEroded = -(F + mLow + D)
      gapValues.push(gapEroded)

      if (F < -TOL_MM) {
        socketCells++
        socketMask[k] = 1
        // No plug material above the finished face → a hole in the inlay.
        if (mHigh <= -D + FACE_TOL_MM) { gapMask[k] = 1; gapDepth[k] = -F }
      }
      if (gapEroded < -TOL_MM) { interfereMask[k] = 1; interfereDepth[k] = -gapEroded }
    }
  }

  gapValues.sort((a, b) => a - b)
  const median = gapValues.length ? gapValues[gapValues.length >> 1] : 0

  return {
    cellMM: (grid.sx + grid.sy) / 2,
    femaleGcode, maleGcode,
    warnings: [...female.warnings, ...male.warnings],
    footprintCells,
    socketCells,
    interference: statsFrom(interfereMask, interfereDepth, grid),
    surfaceGaps: statsFrom(gapMask, gapDepth, grid),
    gapMinMM: gapValues.length ? gapValues[0] : 0,
    gapMedianMM: median,
    gapMaxMM: gapValues.length ? gapValues[gapValues.length - 1] : 0,
  }
}

/** One-line summary for test failure messages. */
export function inlayFitSummary(r: InlayFitResult): string {
  const pct = (n: number) => r.footprintCells ? `${(100 * n / r.footprintCells).toFixed(1)}%` : '—'
  return [
    `cell=${r.cellMM.toFixed(3)}mm footprint=${r.footprintCells} socket=${r.socketCells}`,
    `interference=${r.interference.cells} (${pct(r.interference.cells)}, ${r.interference.areaMM2.toFixed(1)}mm²,`,
    `worst ${r.interference.worstMM.toFixed(2)}mm)`,
    `surfaceGaps=${r.surfaceGaps.cells} (${r.surfaceGaps.areaMM2.toFixed(1)}mm²,` +
    ` deepest ${r.surfaceGaps.worstMM.toFixed(2)}mm)`,
    `gap min/med/max = ${r.gapMinMM.toFixed(2)}/${r.gapMedianMM.toFixed(2)}/${r.gapMaxMM.toFixed(2)}mm`,
    r.warnings.length ? `\n  warnings: ${r.warnings.join(' | ')}` : '',
  ].join(' ')
}

/** Multi-line report — what to print from a harness script. */
export function inlayFitReport(r: InlayFitResult): string {
  const lines = [inlayFitSummary(r)]
  const cl = (label: string, s: InlayFitStats) => {
    if (s.clusters.length === 0) return
    lines.push(`  ${label}: ${s.clusters.length} patch(es)`)
    for (const c of s.clusters.slice(0, 8)) {
      lines.push(`      ${c.areaMM2.toFixed(1)}mm² ~${c.widthMM.toFixed(2)}mm wide, ` +
        `x ${c.x0.toFixed(1)}→${c.x1.toFixed(1)}  y ${c.y0.toFixed(1)}→${c.y1.toFixed(1)}`)
    }
  }
  cl('INTERFERENCE', r.interference)
  cl('SURFACE GAP', r.surfaceGaps)
  return lines.join('\n')
}
