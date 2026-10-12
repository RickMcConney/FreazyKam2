// Adaptive (constant-engagement) clearing — a port of FreeCAD's Adaptive2d
// (Kresimir Tusek, LGPL-2.1-or-later; src/Mod/CAM/libarea/Adaptive.cpp, 2026-09 revision),
// re-plumbed so that nothing the engine does per step or per pass touches the whole pocket.
//
// THE ALGORITHM is upstream's, function for function: the tool is marched point by point; at
// each step a steering angle in ±45° is found (predict, bracket, interpolate) so the area the
// step cuts per unit length holds at the target set by the stepover, and conventional cutting
// is refused. Spirals and trochoidal corner loops emerge from that control. When a pass can go
// no further the engine searches the cleared area's frontier for the cheapest engage point,
// plans a lead-in back from it and a stay-down link to it, and carries on; a helix enters each
// region; a finishing profile cleans the walls.
//
// WHAT IS DIFFERENT is only where the answers come from. The previous port of this algorithm
// (removed 2026-09) took 8 s on a 100 mm square and 149 s on a 300 × 200 mm pocket, because
// upstream keeps the cleared region as one polygon and per pass unions into it, diffs it,
// offsets it (twice) to find engage points, and copies it for every lead path — all O(pocket).
//
//   cleared area      → ClearedTiles (./tiles.ts): per-tile windows, every query local
//   CalcCutArea       → analytic Green's-theorem area (./cutArea.ts), O(E) not O(E²)
//   IsClearPath       → disks along the path against the local tile, same area test
//   engage points     → per-tile contours, cached by tile version, searched nearest-first
//                       with a lower bound that stops the search once nothing nearer can win
//   lead paths        → copy-on-write fork of the tiles; "deep inside cleared" is a disk test
//   pass bookkeeping  → per-tile area accounting instead of a global boolean difference
//   boundary queries  → grid index (./boundIndex.ts)
//   entry point       → binary search on the offset depth instead of stepping it
//
// Coordinates are upstream's: integers in a scaled space (mm × scaleFactor).

import {
  Clipper64, ClipperOffset, ClipType, FillRule, PathType, JoinType, EndType, RectClip64,
  area as clipperArea, isPositive, simplifyPaths, getBoundsPaths, type Paths64,
} from 'clipper2-ts'
import { cutArea, cutAreaOut, diskUncutArea, pointInEdges } from './cutArea'
import { ClearedTiles } from './tiles'
import { BoundIndex, type ClosestHit } from './boundIndex'
import {
  type IntPoint, type Path, type Paths, type DoublePoint,
  NTOL, ip, DistanceSqrd, averageDV, rotate, PathLength, DirectionV, NormalizeV, GetPathDirectionV,
  AverageDirection, PointInPolygon, getPathNestingLevel, DistancePointToPathsSqrd, CleanPath,
  Compute2DPolygonCentroid, IntersectionPoint, SmoothPaths, PopNextFinishingPass, DeduplicatePaths,
  ConnectPaths, PathIntersectArea, Interpolation,
} from './util'

export const MotionType = { Cutting: 0, LinkClear: 1, LinkNotClear: 2, LinkClearAtPrevPass: 3 } as const

/** One emitted toolpath segment in mm. `motion` is a MotionType value. */
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

export type DPaths = Array<Array<[number, number]>>

export interface AdaptiveFCConfig {
  toolDiameter: number
  stepOverFactor: number
  /** Upstream "accuracy" (mm): sets the integer scale, so the minimum step is tolerance / ... */
  tolerance?: number
  helixRampTargetDiameter?: number
  helixRampMinDiameter?: number
  finishingProfile?: boolean
  keepToolDownDistRatio?: number
  /** 0..1 as the pocket clears. */
  onProgress?: (frac: number) => void
}

// ─── upstream constants ──────────────────────────────────────────────────────────
const MIN_STEP_CLIPPER = 16.0 * 3
const MAX_ITERATIONS = 30
const AREA_ERROR_FACTOR = 0.05
const ANGLE_HISTORY_POINTS = 3
const DIRECTION_SMOOTHING_BUFLEN = 3
const CLEAN_PATH_TOLERANCE = 1.415
const FINISHING_CLEAN_PATH_TOLERANCE = 1.415
const FINISHING_THICKNESS_SCALE = 1 / 10

// ─── port-specific constants ─────────────────────────────────────────────────────
/** Arc tolerance of every offset, in scaled units — upstream's Clipper default. Coarser arcs
 *  look like a free speed-up (fewer frontier vertices) and are not: from 0.5 unit up, with the
 *  sweep radius grown to stay conservative, the circle-and-island pocket drifts from FreeCAD's
 *  own output (366 path pieces against ~430, 2–3% less cutting left to a heavier finishing
 *  pass, upstream's failedToSetUpFinishingPass warning) for only 10–20% less time. */
const ARC_TOL_UNITS = 0.25
/** Tile core size in tool radii. Every swept shape is merged into each tile whose window it
 *  reaches, and windows overlap by about a tool radius plus the step, so small tiles merge
 *  the same shape many times over (12.8 tiles per shape at 2R). Measured on four pockets:
 *  2R 4.8 s → 4R 2.6 s → 6R 2.2 s → 8R 2.2 s on the 200 × 110 mm case, with the toolpath's
 *  piece count and cut length unchanged to within noise. */
const TILE_CORE_RADII = 6
/** Work cap for one ResolveLinkPath (disk tests), in place of upstream's wall-clock limit,
 *  which would make the output depend on machine speed. */
const RESOLVE_LINK_BUDGET = 40000

const sq = (x: number): number => x * x

function boolOp(ct: ClipType, subj: Paths, clip: Paths, fr = FillRule.EvenOdd): Paths {
  const c = new Clipper64()
  if (subj.length) c.addPaths(subj, PathType.Subject)
  if (clip.length) c.addPaths(clip, PathType.Clip)
  const out: Paths64 = []
  c.execute(ct, fr, out)
  return out
}
function offset(paths: Paths, delta: number, jt: JoinType, et: EndType, arcTol: number): Paths {
  if (!paths.length) return []
  const co = new ClipperOffset(2, arcTol)
  co.addPaths(paths, jt, et)
  const out: Paths64 = []
  co.execute(delta, out)
  return out
}
const SimplifyPolygons = (p: Paths): Paths => (p.length ? boolOp(ClipType.Union, p, []) : [])
const CleanPolygons = (p: Paths, d = 1.415): Paths => simplifyPaths(p, d, true)
const areaOfPaths = (p: Paths): number => { let a = 0; for (const q of p) a += clipperArea(q); return a }

interface IterateOut {
  iterationAngle: number | null
  tooManyIterations: boolean
  failed: boolean
  area: number
  errorFraction: number
  newToolPos: IntPoint
  newToolDir: DoublePoint
}

/** One engage contour piece inside a tile core, with its walk cache. */
interface EngagePiece {
  pts: Path
  minX: number; minY: number; maxX: number; maxY: number
  /** Sample points along the piece at MIN_STEP spacing (lazily built) and their verdicts. */
  samples: IntPoint[] | null
  sdir: DoublePoint[] | null
  status: Int8Array | null      // 0 unknown, 1 valid, 2 invalid
  result: (DoublePoint | null)[] | null
}
interface TileEngage { ver: number; pieces: EngagePiece[] }

export class AdaptiveFC {
  toolDiameter: number
  stepOverFactor: number
  tolerance: number
  helixRampTargetDiameter: number
  helixRampMinDiameter: number
  finishingProfile: boolean
  keepToolDownDistRatio: number
  private onProgress?: (frac: number) => void

  private results: AdaptiveOutput[] = []
  private scaleFactor = 100
  private stepOverScaled = 1
  private toolRadiusScaled = 10
  private finishPassOffsetScaled = 0
  private helixRampMaxRadiusScaled = 0
  private helixRampMinRadiusScaled = 0
  private referenceCutArea = 0
  private optimalCutAreaPD = 0
  private arcTol = 0.25
  private stockInputPaths: Paths = []
  private totalToClear = 1
  private clearedSoFar = 0

  // per-region state
  private bound!: BoundIndex
  private hit: ClosestHit = { distSq: 0, pathIndex: 0, segIndex: 0, x: 0, y: 0 }

  constructor(cfg: AdaptiveFCConfig) {
    this.toolDiameter = cfg.toolDiameter
    this.stepOverFactor = cfg.stepOverFactor
    this.tolerance = cfg.tolerance ?? 0.1
    this.helixRampTargetDiameter = cfg.helixRampTargetDiameter ?? 0
    this.helixRampMinDiameter = cfg.helixRampMinDiameter ?? 0
    this.finishingProfile = cfg.finishingProfile ?? true
    this.keepToolDownDistRatio = cfg.keepToolDownDistRatio ?? 3.0
    this.onProgress = cfg.onProgress
  }

  private toMM = (p: IntPoint): [number, number] => [p.x / this.scaleFactor, p.y / this.scaleFactor]
  private fromMM = (p: [number, number]): IntPoint => ip(p[0] * this.scaleFactor, p[1] * this.scaleFactor)

  // ════════════════════════════════════════════════════════════════════════════
  //  Execute
  // ════════════════════════════════════════════════════════════════════════════

  /** Clear the inside of `paths` (outer boundaries + islands, any orientation). */
  execute(stockPaths: DPaths, paths: DPaths, clearedPaths: DPaths = []): AdaptiveOutput[] {
    this.results = []
    this.tolerance = Math.min(Math.max(this.tolerance, 0.01), 1.0)
    this.scaleFactor = MIN_STEP_CLIPPER / this.tolerance / Math.min(1.0, this.stepOverFactor * this.toolDiameter)
    this.toolRadiusScaled = Math.trunc(this.toolDiameter * this.scaleFactor / 2)
    this.stepOverScaled = this.toolRadiusScaled * this.stepOverFactor
    this.arcTol = ARC_TOL_UNITS

    if (this.helixRampTargetDiameter < NTOL) this.helixRampTargetDiameter = this.toolDiameter
    this.helixRampTargetDiameter = Math.min(this.helixRampTargetDiameter, this.toolDiameter)
    this.helixRampMinDiameter = Math.max(this.helixRampMinDiameter, this.toolDiameter / 8)
    this.helixRampTargetDiameter = Math.max(this.helixRampTargetDiameter, this.helixRampMinDiameter)
    this.helixRampMaxRadiusScaled = Math.trunc(this.helixRampTargetDiameter * this.scaleFactor / 2)
    this.helixRampMinRadiusScaled = Math.trunc(this.helixRampMinDiameter * this.scaleFactor / 2)
    this.finishPassOffsetScaled = this.finishingProfile ? Math.trunc(this.stepOverScaled * FINISHING_THICKNESS_SCALE) : 0

    // Reference cut: a full disk minus the same disk shifted by R/2 (upstream measures it on
    // the polygonised tool; the analytic value matches the analytic engagement measure).
    const R = this.toolRadiusScaled
    const lens = (d: number): number => 2 * R * R * Math.acos(d / (2 * R)) - 0.5 * d * Math.sqrt(4 * R * R - d * d)
    this.referenceCutArea = Math.PI * R * R - lens(R / 2)
    this.optimalCutAreaPD = 2 * this.stepOverFactor * this.referenceCutArea / R

    // input paths
    let inputPaths: Paths = paths.map(p => CleanPath(p.map(q => this.fromMM(q)), FINISHING_CLEAN_PATH_TOLERANCE))
    inputPaths = DeduplicatePaths(inputPaths)
    inputPaths = ConnectPaths(inputPaths)
    inputPaths = SimplifyPolygons(inputPaths)
    this.stockInputPaths = SimplifyPolygons(stockPaths.map(p => p.map(q => this.fromMM(q))))
    const initialClearedPaths = SimplifyPolygons(clearedPaths.map(p => p.map(q => this.fromMM(q))))

    // 2) orientation: nesting odd ⇒ positive
    for (const p of inputPaths) {
      const nesting = getPathNestingLevel(p, inputPaths)
      if ((nesting % 2 === 1) !== isPositive(p)) p.reverse()
    }
    // 3) every input edge wants a finishing pass
    for (const p of inputPaths) for (const q of p) q.z = 1
    // (Steps 4, 5 and 5e of upstream — profiling ops, clearing outside the stock, and
    //  un-tagging walls that lie in pre-cleared ground — are not used by the pocket planner.)

    // 6) tool-centre bounds, carrying the Z=1 finishing tags through the offset
    const tagOffset = (src: Paths, delta: number): Paths => {
      const co = new ClipperOffset(2, this.arcTol, true)
      co.zCallback = (e1b, e1t, e2b, e2t, pt) => {
        const a = e1b.z === 1 && e1t.z === 1, b = e2b.z === 1 && e2t.z === 1
        pt.z = a || b ? 1 : 0
      }
      co.addPaths(src, JoinType.Round, EndType.Polygon)
      const out: Paths64 = []
      co.execute(delta, out)
      return out
    }
    const toolBounds = tagOffset(inputPaths, -(R + this.finishPassOffsetScaled))

    // total area to clear, for progress
    this.totalToClear = Math.max(1, Math.abs(areaOfPaths(offset(toolBounds, R, JoinType.Round, EndType.Polygon, this.arcTol))))
    this.clearedSoFar = 0

    // 7) one region per outer boundary, with the holes directly inside it
    for (const current of toolBounds) {
      const nesting = getPathNestingLevel(current, toolBounds)
      if (nesting % 2 === 0) continue
      const currentTBP: Paths = [current]
      for (const other of toolBounds) {
        if (other === current) continue
        if (PointInPolygon(other[0], current) !== 0 && getPathNestingLevel(other, toolBounds) === nesting + 1) currentTBP.push(other)
      }
      // 8) finishing pass = TBP offset back out by the finishing thickness
      const finishingPass = tagOffset(currentTBP, this.finishPassOffsetScaled)
      // 9) the region the interior clearing must clear (3 units shy, see upstream note)
      const boundPath = offset(currentTBP, R - 3, JoinType.Round, EndType.Polygon, this.arcTol)
      if (initialClearedPaths.length) {
        const toClear = boolOp(ClipType.Difference, boundPath, initialClearedPaths)
        if (!toClear.length) continue
      }
      this.processPolyNode(boundPath, currentTBP, finishingPass, initialClearedPaths)
    }
    this.onProgress?.(1)
    return this.results
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Local geometric queries
  // ════════════════════════════════════════════════════════════════════════════

  /** Upstream CalcCutArea: [area, conventionalArea]. */
  private calcCutArea(c1: IntPoint, c2: IntPoint, cleared: ClearedTiles): [number, number] {
    const R = this.toolRadiusScaled
    const es = cleared.edgesFor(Math.min(c1.x, c2.x) - R - 2, Math.min(c1.y, c2.y) - R - 2, Math.max(c1.x, c2.x) + R + 2, Math.max(c1.y, c2.y) + R + 2)
    cutArea(es, c1.x, c1.y, c2.x, c2.y, R)
    return [cutAreaOut.area, cutAreaOut.conv]
  }

  private diskUncut(p: IntPoint, r: number, cleared: ClearedTiles): number {
    const es = cleared.edgesFor(p.x - r - 2, p.y - r - 2, p.x + r + 2, p.y + r + 2)
    return diskUncutArea(es, p.x, p.y, r)
  }

  private pointCleared(p: IntPoint, cleared: ClearedTiles): boolean {
    const es = cleared.edgesFor(p.x - 2, p.y - 2, p.x + 2, p.y + 2)
    return pointInEdges(es, p.x, p.y)
  }

  /** Upstream IsClearPath: the tool (+ safety) swept along the path stays in cleared area.
   *  The swept shape is covered by disks along each segment, slightly enlarged so their union
   *  contains the true capsule (by ≤ 1 unit). */
  private isClearPath(tp: Path, cleared: ClearedTiles, safety = 0): boolean {
    const r = this.toolRadiusScaled + safety
    if (tp.length === 0) return true
    if (tp.length === 1) return this.diskUncut(tp[0], r, cleared) < 1.0
    const h = Math.max(4, Math.min(r, 2 * Math.sqrt(2 * r)))
    const rt = Math.sqrt(r * r + (h / 2) * (h / 2))
    let coll = 0
    for (let i = 1; i < tp.length; i++) {
      const a = tp[i - 1], b = tp[i]
      const L = Math.sqrt(DistanceSqrd(a, b))
      const n = Math.max(1, Math.ceil(L / h))
      for (let k = (i === 1 ? 0 : 1); k <= n; k++) {
        const t = k / n
        coll += this.diskUncut(ip(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), k === 0 || k === n ? r : rt, cleared)
        if (coll >= 1.0) return false
      }
    }
    return coll < 1.0
  }

  /** Squared distance from p to the nearest real cleared boundary in p's tile window. */
  private clearedBoundaryDistSq(p: IntPoint, cleared: ClearedTiles): number {
    const idx = cleared.tileIndex(p.x, p.y)
    if (idx < 0) return Infinity
    const i = idx % cleared.nx, j = (idx - i) / cleared.nx
    const w = cleared.windowRect(i, j)
    const t = cleared.get(idx)
    if (!t) return Infinity
    const e = t.es.e
    let best = Infinity
    for (let k = 0, m = t.es.n * 4; k < m; k += 4) {
      const ax = e[k], ay = e[k + 1], bx = e[k + 2], by = e[k + 3]
      // skip the window's own artificial border
      if ((ax === bx && (ax === w.left || ax === w.right)) || (ay === by && (ay === w.top || ay === w.bottom))) continue
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
      let tt = l2 > 0 ? ((p.x - ax) * dx + (p.y - ay) * dy) / l2 : 0
      if (tt < 0) tt = 0; else if (tt > 1) tt = 1
      const d2 = sq(p.x - (ax + tt * dx)) + sq(p.y - (ay + tt * dy))
      if (d2 < best) best = d2
    }
    return best
  }

  private boundClosest(p: IntPoint): ClosestHit { return this.bound.closest(p.x, p.y, this.hit) }
  private within(p: IntPoint): boolean { return this.bound.inside(p.x, p.y) }

  // ════════════════════════════════════════════════════════════════════════════
  //  Entry point (helix)
  // ════════════════════════════════════════════════════════════════════════════

  private findEntryPoint(toolBoundPaths: Paths, boundPaths: Paths, cleared: ClearedTiles):
    { entryPoint: IntPoint; toolPos: IntPoint; toolDir: DoublePoint; helixRadius: number } | null {
    const R = this.toolRadiusScaled
    let checkPaths = boolOp(ClipType.Difference, toolBoundPaths, cleared.getCleared())
    let entryPoint: IntPoint = { x: 0, y: 0 }
    let helixRadius = 0
    let found = false
    for (let iter = 0; iter < 10; iter++) {
      found = false
      // Deepest offset that is still non-empty. Upstream steps the delta by MIN_STEP until the
      // offset vanishes (hundreds of whole-region offsets on a big pocket); the offset is
      // monotone in the delta, so a binary search over the same step grid finds the same one.
      const at = (k: number): Paths => offset(checkPaths, -1 - k * MIN_STEP_CLIPPER, JoinType.Square, EndType.Polygon, this.arcTol)
      let lastValid: Paths = []
      if (at(0).length) {
        const b = getBoundsPaths(checkPaths)
        let lo = 0, hi = Math.ceil(Math.max(b.right - b.left, b.bottom - b.top) / MIN_STEP_CLIPPER) + 1
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (at(mid).length) lo = mid; else hi = mid - 1
        }
        lastValid = at(lo)
      }
      for (const p of lastValid) {
        if (p.length) { entryPoint = Compute2DPolygonCentroid(p); found = true; break }
      }
      for (let j = 0; j < checkPaths.length; j++) {
        const pip = PointInPolygon(entryPoint, checkPaths[j])
        if ((j === 0 && pip === 0) || (j > 0 && pip !== 0)) { found = false; break }
      }
      const helixDisk = (r: number): Paths => offset([[entryPoint]], r + R, JoinType.Round, EndType.Round, this.arcTol)
      const fits = (r: number): boolean => boolOp(ClipType.Difference, helixDisk(r), boundPaths).length === 0
      if (found) {
        if (!fits(this.helixRampMinRadiusScaled)) found = false
        else {
          let minSize = this.helixRampMinRadiusScaled, maxSize = this.helixRampMaxRadiusScaled
          while (minSize < maxSize) {
            const test = Math.trunc((minSize + maxSize + 1) / 2)
            if (fits(test)) minSize = test; else maxSize = test - 1
          }
          helixRadius = minSize
          cleared.addRegion(CleanPolygons(helixDisk(helixRadius)))
        }
      }
      if (!found) {
        const b = getBoundsPaths(checkPaths)
        const midX = Math.trunc((b.left + b.right) / 2), midY = Math.trunc((b.top + b.bottom) / 2)
        const rect: Path = [{ x: b.left, y: b.top }, { x: b.left, y: midY }, { x: midX, y: midY }, { x: midX, y: b.top }]
        checkPaths = boolOp(ClipType.Intersection, [rect], checkPaths)
      }
      if (found) break
    }
    if (!found) return null
    return { entryPoint, toolPos: { x: entryPoint.x, y: entryPoint.y - helixRadius }, toolDir: { x: 1, y: 0 }, helixRadius }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Cut-through test, link resolution, lead paths
  // ════════════════════════════════════════════════════════════════════════════

  private isAllowedToCutTrough(p1: IntPoint, p2: IntPoint, cleared: ClearedTiles, areaFactor = 1.5, skipBoundsCheck = false): boolean {
    if (!skipBoundsCheck && !this.within(p2)) return false
    if (!skipBoundsCheck && !this.within(p1)) return false
    const distance = Math.sqrt(DistanceSqrd(p1, p2))
    let stepSize = Math.min(0.5 * this.stepOverScaled, 8 * MIN_STEP_CLIPPER)
    if (distance < stepSize / 2) return true
    if (distance < stepSize) areaFactor *= 2
    let toolPos1 = p1
    const steps = Math.trunc(distance / stepSize) + 1
    stepSize = distance / steps
    for (let i = 1; i <= steps; i++) {
      const p = i / steps
      const toolPos2 = ip(p1.x + (p2.x - p1.x) * p, p1.y + (p2.y - p1.y) * p)
      const area = this.calcCutArea(toolPos1, toolPos2, cleared)[0]
      if (area > areaFactor * stepSize * this.optimalCutAreaPD) return false
      if (!skipBoundsCheck && !this.within(toolPos2)) return false
      toolPos1 = toolPos2
    }
    return true
  }

  private resolveLinkPath(startPoint: IntPoint, endPoint: IntPoint, cleared: ClearedTiles): Path | null {
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
    let cnt = 0
    let budget = RESOLVE_LINK_BUDGET
    const eq = (a: IntPoint, b: IntPoint): boolean => a.x === b.x && a.y === b.y

    while (queue.length) {
      if (++cnt > limit || budget <= 0) return null
      const [a, b] = queue.pop()!
      for (const lp of linkPaths) {
        if (!eq(lp[0], a) && !eq(lp[lp.length - 1], a) && !eq(lp[0], b) && !eq(lp[lp.length - 1], b)
          && IntersectionPoint(lp[0], lp[lp.length - 1], a, b)) return null
      }
      const direction = DirectionV(a, b)
      const checkPath: Path = [
        eq(a, startPoint) ? ip(a.x + offClearance * direction.x, a.y + offClearance * direction.y) : a,
        eq(b, endPoint) ? ip(b.x - offClearance * direction.x, b.y - offClearance * direction.y) : b,
      ]
      budget -= 1 + Math.sqrt(DistanceSqrd(checkPath[0], checkPath[1])) / this.toolRadiusScaled * 8
      if (this.isClearPath(checkPath, cleared, clearance)) {
        totalLength += Math.sqrt(DistanceSqrd(a, b))
        if (totalLength > this.keepToolDownDistRatio * directDistance) return null
        linkPaths.push([a, b])
      } else {
        if (Math.sqrt(DistanceSqrd(a, b)) < 4) return null
        const pDir = { x: -direction.y, y: direction.x }
        const mid = ip(0.5 * (a.x + b.x), 0.5 * (a.y + b.y))
        for (let i = 1; ; i++) {
          if (--budget <= 0) return null
          const off = i * scanStep
          let cp1 = ip(mid.x + off * pDir.x, mid.y + off * pDir.y)
          let cp2 = ip(mid.x - off * pDir.x, mid.y - off * pDir.y)
          if (this.clearedBoundaryDistSq(cp1, cleared) < this.clearedBoundaryDistSq(cp2, cleared)) { const t = cp2; cp2 = cp1; cp1 = t }
          if (this.isClearPath([cp1], cleared, clearance + 1)) { queue.push([a, cp1], [cp1, b]); break }
          if (this.isClearPath([cp2], cleared, clearance + 1)) { queue.push([a, cp2], [cp2, b]); break }
          if (off > this.keepToolDownDistRatio * directDistance) return null
        }
      }
    }
    if (!linkPaths.length) return null
    return ConnectPaths(linkPaths)[0]
  }

  /** Nearest point to p of the region "cleared, shrunk by `shrink`", searched in growing boxes. */
  private nearestShrunk(p: IntPoint, shrink: number, start: number, cleared: ClearedTiles): IntPoint | null {
    let half = Math.max(start, 2 * shrink + 8)
    const grid = Math.max(cleared.nx, cleared.ny) * cleared.spec.core
    for (;;) {
      const x0 = p.x - half, y0 = p.y - half, x1 = p.x + half, y1 = p.y + half
      const paths = cleared.pathsFor(x0, y0, x1, y1)
      const shr = paths.length ? offset(paths, -shrink, JoinType.Round, EndType.Polygon, this.arcTol) : []
      if (shr.length) {
        const c = DistancePointToPathsSqrd(shr, p)
        // A shrunk boundary near the box edge may be the box's own artefact; trust a hit only
        // when it is closer than the box can have distorted.
        if (Math.sqrt(c.distSq) <= half - 2 * shrink - 4 || half >= grid) return { x: c.x, y: c.y }
      } else if (half >= grid) return null
      half *= 2
    }
  }

  private makeLeadPath(leadIn: boolean, startPoint: IntPoint, startDir: DoublePoint, beaconPointIn: IntPoint,
    clearedOriginal: ClearedTiles, output: Path, ao: AdaptiveOutput): boolean {
    output.push(startPoint)
    const R = this.toolRadiusScaled
    const stepSize = Math.min(MIN_STEP_CLIPPER * 8, 0.2 * this.stepOverScaled + 1)
    // lead-out updates a scratch copy as it goes; lead-in reads the original
    const cleared = leadIn ? clearedOriginal : clearedOriginal.fork()
    const shrink = R + stepSize
    const inShrunk = (q: IntPoint): boolean => this.diskUncut(q, shrink, cleared) < 1.0

    let beaconPoint = beaconPointIn
    if (!inShrunk(beaconPoint)) {
      const n = this.nearestShrunk(beaconPoint, shrink, Math.sqrt(DistanceSqrd(startPoint, beaconPoint)) + shrink, cleared)
      if (!n) return false
      beaconPoint = n
    }
    let currentPoint = startPoint
    let targetDir = DirectionV(currentPoint, beaconPoint)
    const distanceToBeacon = Math.sqrt(DistanceSqrd(startPoint, beaconPoint))
    const minExitLength = Math.min(R / 5, Math.min(this.stepOverScaled, distanceToBeacon / 2))
    const maxLength = Math.max(distanceToBeacon * 2, stepSize * 10)
    let clearedStartLen: number | null = null
    let nextDir = startDir
    let nextPoint = ip(currentPoint.x + nextDir.x * stepSize, currentPoint.y + nextDir.y * stepSize)
    const adaptFactor = 0.4
    const alfa = Math.PI / 64
    let pathLen = 0
    let checkPath: Path = [currentPoint]
    for (let i = 0; i < 10000; i++) {
      if (this.isAllowedToCutTrough(currentPoint, nextPoint, cleared)) {
        if (!leadIn) {
          checkPath.push(nextPoint)
          cleared.expand(checkPath)
          checkPath = [nextPoint]
        }
        output.push(nextPoint)
        currentPoint = nextPoint
        pathLen += stepSize
        targetDir = DirectionV(currentPoint, beaconPoint)
        nextDir = NormalizeV({ x: nextDir.x + adaptFactor * targetDir.x, y: nextDir.y + adaptFactor * targetDir.y })
        if (inShrunk(currentPoint)) {
          if (clearedStartLen === null) clearedStartLen = pathLen
          if (pathLen > minExitLength && pathLen - clearedStartLen > MIN_STEP_CLIPPER) return true
        } else clearedStartLen = null
        if (pathLen > maxLength) {
          if (this.pointCleared(currentPoint, cleared)) return true
          ao.leadPathFailed = true
          return false
        }
      } else {
        nextDir = rotate(nextDir, leadIn ? -alfa : alfa)
      }
      nextPoint = ip(currentPoint.x + nextDir.x * stepSize, currentPoint.y + nextDir.y * stepSize)
    }
    return false
  }

  private findLinkPath(prevPoint: IntPoint | null, pathStart: IntPoint, pathDir: DoublePoint, cleared: ClearedTiles, ao: AdaptiveOutput): TPath[] | null {
    const result: TPath[] = []
    const endPoint = pathStart
    const linkDistance = prevPoint ? Math.sqrt(DistanceSqrd(prevPoint, endPoint)) : this.stepOverScaled
    if (linkDistance < NTOL) return result
    const beaconOffset = Math.max(Math.min(this.stepOverScaled, linkDistance / 2) * 1.5, 8 * MIN_STEP_CLIPPER)
    const hit = this.boundClosest(endPoint)
    const revEndDir = { x: -pathDir.x, y: -pathDir.y }
    let endBoundaryDir = GetPathDirectionV(this.bound.paths[hit.pathIndex], hit.segIndex)
    if (hit.distSq > beaconOffset) endBoundaryDir = pathDir
    const endBeaconDir = NormalizeV({ x: revEndDir.x - endBoundaryDir.y, y: revEndDir.y + endBoundaryDir.x })
    const endBeacon = ip(endPoint.x + beaconOffset * endBeaconDir.x, endPoint.y + beaconOffset * endBeaconDir.y)

    let leadInPath: Path = []
    if (!this.makeLeadPath(true, endPoint, revEndDir, endBeacon, cleared, leadInPath, ao)) return null
    leadInPath.reverse()

    let linkPath: Path = []
    let linkType: number = MotionType.Cutting
    if (prevPoint) {
      const resolved = this.resolveLinkPath(prevPoint, leadInPath[0], cleared)
      if (resolved) {
        linkPath = resolved
        linkType = MotionType.LinkClear
        let remaining = this.stepOverScaled / 2
        while (linkPath.length >= 2 && remaining > NTOL) {
          const p1 = linkPath[linkPath.length - 2], p2 = linkPath[linkPath.length - 1]
          const l = Math.sqrt(DistanceSqrd(p1, p2))
          if (l >= remaining) {
            const split = ip(p1.x + (p2.x - p1.x) * (l - remaining) / l, p1.y + (p2.y - p1.y) * (l - remaining) / l)
            linkPath.pop(); linkPath.push(split); leadInPath.unshift(split)
            remaining = 0
            if (!this.isClearPath([p2, split], cleared, 0)) remaining = this.stepOverScaled / 2
          } else {
            linkPath.pop(); leadInPath.unshift(p1)
            remaining -= l
            if (remaining < NTOL && !this.isClearPath([p2, p1], cleared, 0)) remaining = this.stepOverScaled / 2
          }
        }
      } else {
        linkType = MotionType.LinkNotClear
        const f = leadInPath[0]
        const dist = Math.sqrt(DistanceSqrd(prevPoint, f))
        if (dist < 2 * this.stepOverScaled && this.isAllowedToCutTrough(
          ip(prevPoint.x + (f.x - prevPoint.x) / dist, prevPoint.y + (f.y - prevPoint.y) / dist),
          ip(f.x - (f.x - prevPoint.x) / dist, f.y - (f.y - prevPoint.y) / dist), cleared)) {
          linkType = MotionType.Cutting
        }
        linkPath = [prevPoint, f]
      }
    }
    if (linkType === MotionType.LinkClear) {
      const sm = SmoothPaths([linkPath, leadInPath], 0.1 * this.stepOverScaled, 1, 4)
      linkPath = sm[0]; leadInPath = sm[1]
    }
    if (prevPoint) result.push({ motion: linkType, pts: linkPath.map(this.toMM) })
    result.push({ motion: MotionType.Cutting, pts: leadInPath.map(this.toMM) })
    return result
  }

  private appendToolPath(output: AdaptiveOutput, passToolPath: Path, linkPath: TPath[], cleared: ClearedTiles): { pos: IntPoint; dir: DoublePoint } | null {
    let result: { pos: IntPoint; dir: DoublePoint } | null = null
    for (const lp of linkPath) output.adaptivePaths.push(lp)
    if (!passToolPath.length) return null
    output.adaptivePaths.push({ motion: MotionType.Cutting, pts: passToolPath.map(this.toMM) })
    if (passToolPath.length >= 2) {
      const prevPoint = passToolPath[passToolPath.length - 1]
      const prevDir = GetPathDirectionV(passToolPath, passToolPath.length - 1)
      const hit = this.boundClosest(prevPoint)
      let boundaryDir = GetPathDirectionV(this.bound.paths[hit.pathIndex], hit.segIndex)
      const beaconOffset = Math.max(Math.min(this.stepOverScaled, PathLength(passToolPath) / 2) * 1.5, 8 * MIN_STEP_CLIPPER)
      if (hit.distSq > beaconOffset) boundaryDir = prevDir
      const beaconDir = NormalizeV({ x: prevDir.x - boundaryDir.y, y: prevDir.y + boundaryDir.x })
      const beacon = ip(prevPoint.x + beaconOffset * beaconDir.x, prevPoint.y + beaconOffset * beaconDir.y)
      let leadOut: Path = []
      const ok = this.makeLeadPath(false, prevPoint, prevDir, beacon, cleared, leadOut, output)
      if (ok && leadOut.length >= 1) {
        leadOut = SmoothPaths([leadOut], 0.1 * this.stepOverScaled, 1, 4)[0]
        output.adaptivePaths.push({ motion: MotionType.Cutting, pts: leadOut.map(this.toMM) })
        cleared.expand(leadOut)
        const p2 = leadOut[leadOut.length - 1]
        const p1 = leadOut.length >= 2 ? leadOut[leadOut.length - 2] : prevPoint
        result = { pos: p2, dir: DirectionV(p1, p2) }
      }
    }
    return result
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  ProcessPolyNode
  // ════════════════════════════════════════════════════════════════════════════

  private processPolyNode(boundPathsIn: Paths, toolBoundPathsIn: Paths, finishingPaths: Paths, initialClearedPaths: Paths): void {
    const R = this.toolRadiusScaled
    let toolBoundPaths = SimplifyPolygons(CleanPolygons(toolBoundPathsIn))
    const boundPaths = SimplifyPolygons(CleanPolygons(boundPathsIn))
    if (!toolBoundPaths.length) return
    const tbpMinus = SimplifyPolygons(CleanPolygons(offset(toolBoundPaths, -2, JoinType.Round, EndType.Polygon, this.arcTol)))
    this.bound = new BoundIndex(toolBoundPaths, R / 2)

    // cleared-area tiles
    const bb = getBoundsPaths(toolBoundPaths)
    const margin = Math.ceil(R + Math.max(8 * MIN_STEP_CLIPPER, 2 * this.stepOverScaled) + 8)
    const core = Math.ceil(Math.max(TILE_CORE_RADII * R, 8 * MIN_STEP_CLIPPER))
    const pad = 2 * R + margin
    const cleared = new ClearedTiles({
      minX: bb.left - pad, minY: bb.top - pad, maxX: bb.right + pad, maxY: bb.bottom + pad,
      core, margin,
      sweepRadius: R + 1,          // upstream ExpandCleared
      arcTolerance: this.arcTol,
      simplifyEps: 1.415,          // upstream CleanPolygons default
      // An engage contour is the cleared area eroded by R + 2 then grown by 2 + protrusion,
      // so it moves only for changes within that distance of the core (plus slack for the
      // integer offsets).
      contourReach: R + 4 + Math.ceil(this.stepOverScaled * FINISHING_THICKNESS_SCALE) + 16,
    })
    cleared.addRegion(initialClearedPaths)

    const output: AdaptiveOutput = {
      helixCenter: [0, 0], startPoint: [0, 0], adaptivePaths: [], returnMotionType: 0, clearedArea: 0,
      startPointNotFound: false, leadPathFailed: false, tooManyFailedEngagements: false,
      unclearedAreaRemains: false, failedToSetUpFinishingPass: false, finishingLeadInFailed: false,
    }

    let toolPos: IntPoint = { x: 0, y: 0 }
    let toolDir: DoublePoint = { x: 1, y: 0 }
    let entryPoint: IntPoint = { x: 0, y: 0 }
    let stepScaled = MIN_STEP_CLIPPER
    let passToolPath: Path = []
    let toClearPath: Path = []
    let gyro: DoublePoint[] = []
    let angleHistory: number[] = []
    let angle = Math.PI
    const interp = new Interpolation()
    let lastExpandToolDir = toolDir
    let badEngageCount = 0

    // ── iterateNextStep ────────────────────────────────────────────────────────
    const iterateNextStep = (toolPos: IntPoint, toolDir: DoublePoint): IterateOut => {
      const out: IterateOut = { iterationAngle: null, tooManyIterations: false, failed: false, area: 0, errorFraction: 1, newToolPos: toolPos, newToolDir: toolDir }
      const hit = this.boundClosest(toolPos)
      const distanceToBoundary = Math.sqrt(hit.distSq)
      const boundaryDir = GetPathDirectionV(this.bound.paths[hit.pathIndex], hit.segIndex)
      const distanceToEngage = Math.sqrt(DistanceSqrd(toolPos, entryPoint))
      const targetAreaPD = this.optimalCutAreaPD

      const slowDownDistance = Math.max(R / 4, MIN_STEP_CLIPPER * 8)
      if (distanceToBoundary < slowDownDistance || distanceToEngage < slowDownDistance) stepScaled = MIN_STEP_CLIPPER
      else if (Math.abs(angle) > NTOL) stepScaled = Math.trunc(MIN_STEP_CLIPPER / Math.abs(angle))
      else stepScaled = MIN_STEP_CLIPPER * 8
      const cap = Math.min(Math.trunc(R / 4), MIN_STEP_CLIPPER * 8)
      if (stepScaled > cap) stepScaled = cap
      if (stepScaled < MIN_STEP_CLIPPER) stepScaled = MIN_STEP_CLIPPER

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
      let newToolPos: IntPoint = toolPos
      let newToolDir: DoublePoint = toolDir
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        if (iteration === 0) { angle = predictedAngle; pointNotInterp = true }
        else if (iteration === 1) { angle = interp.MIN_ANGLE; pointNotInterp = true }
        else if (iteration === 2) {
          if (interp.bothSides()) { angle = interp.interpolateAngle(); pointNotInterp = false }
          else { angle = interp.MAX_ANGLE; pointNotInterp = true }
        } else if (iteration === 3 && !foundArea) {
          cleared.expand(toClearPath)
          toClearPath = []
          lastExpandToolDir = toolDir
          // nearby uncleared area in the forward direction
          const dist = (stepScaled + R) * 1.5
          const left = rotate(toolDir, -Math.PI / 4), right = rotate(toolDir, Math.PI / 4)
          const tri: Path = [toolPos, ip(toolPos.x + right.x * dist, toolPos.y + right.y * dist), ip(toolPos.x + left.x * dist, toolPos.y + left.y * dist)]
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
          for (const q of tri) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y) }
          const local = cleared.pathsFor(x0 - 2, y0 - 2, x1 + 2, y1 + 2)
          const uncut = boolOp(ClipType.Difference, [tri], local, FillRule.NonZero)
          if (uncut.length === 0) continue
          const c = DistancePointToPathsSqrd(uncut, toolPos)
          const dy = c.y - toolPos.y, dx = c.x - toolPos.x
          const len = Math.sqrt(dx * dx + dy * dy)
          angle = Math.asin(Math.max(-1, Math.min(1, (dy * toolDir.x - dx * toolDir.y) / len)))
        } else if (!foundArea) {
          angle = 0; area = 0; areaPD = 0
          break
        } else { angle = interp.interpolateAngle(); pointNotInterp = false }
        angle = interp.clampAngle(angle)

        newToolDir = rotate(toolDir, angle)
        newToolPos = ip(toolPos.x + newToolDir.x * stepScaled, toolPos.y + newToolDir.y * stepScaled)

        let intRepeat = false
        if (interp.m_min && newToolPos.x === interp.m_min.pos.x && newToolPos.y === interp.m_min.pos.y) {
          interp.m_min = { ...interp.m_min, angle }; intRepeat = true
        }
        if (interp.m_max && newToolPos.x === interp.m_max.pos.x && newToolPos.y === interp.m_max.pos.y) {
          interp.m_max = { ...interp.m_max, angle }; intRepeat = true
        }
        if (intRepeat) {
          const mn = interp.m_min, mx = interp.m_max
          if (mn && mx && Math.abs(mn.pos.x - mx.pos.x) <= 1 && Math.abs(mn.pos.y - mx.pos.y) <= 1) {
            if (pointNotInterp) continue
            let pick = mn
            if (mn.isConventional !== mx.isConventional) pick = !mn.isConventional ? mn : mx
            else if (Math.abs(mn.error) < Math.abs(mx.error)) pick = mn
            else pick = mx
            newToolDir = rotate(toolDir, pick.angle)
            newToolPos = pick.pos
            isConventional = pick.isConventional
            areaPD = pick.error + targetAreaPD
            area = areaPD * stepScaled
            out.iterationAngle = angle
            break
          }
          continue
        }

        const [a, conv] = this.calcCutArea(toolPos, newToolPos, cleared)
        area = a
        const fractionConventional = area === 0 ? 0 : conv / area
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
        const boundaryAngle = Math.atan2(boundaryDir.y, boundaryDir.x)
        const toolAngle = Math.atan2(newToolDir.y, newToolDir.x)
        let delta = boundaryAngle - toolAngle
        if (delta > Math.PI) delta -= 2 * Math.PI
        if (delta < -Math.PI) delta += 2 * Math.PI
        const rotateIncrement = (delta > 0 ? 1 : -1) * Math.PI / 90
        while (!this.within(newToolPos) && rotateStep < 180) {
          rotateStep++
          recalcArea = true
          newToolDir = rotate(newToolDir, rotateIncrement)
          newToolPos = ip(toolPos.x + newToolDir.x * stepScaled, toolPos.y + newToolDir.y * stepScaled)
        }
        if (rotateStep >= 180) out.failed = true
        if (recalcArea) {
          const [a, conv] = this.calcCutArea(toolPos, newToolPos, cleared)
          area = a
          areaPD = area / stepScaled
          errorFraction = Math.abs((areaPD - targetAreaPD) / this.optimalCutAreaPD)
          isConventional = (area === 0 ? 0 : conv / area) >= conventionalCutoff
        }
        if (area > stepScaled * this.optimalCutAreaPD && areaPD > 2 * this.optimalCutAreaPD) out.failed = true
      }
      out.area = area
      out.failed ||= isConventional
      out.failed ||= area < 1
      out.newToolPos = newToolPos
      out.newToolDir = newToolDir
      out.errorFraction = errorFraction
      return out
    }

    // ── initToolDir ────────────────────────────────────────────────────────────
    const initToolDir = (p: IntPoint, baseDir: DoublePoint): DoublePoint | null => {
      const testDirs: DoublePoint[] = [
        { x: baseDir.x, y: baseDir.y }, { x: -baseDir.y, y: baseDir.x },
        { x: -baseDir.x, y: -baseDir.y }, { x: baseDir.y, y: -baseDir.x },
      ]
      let best: { dir: DoublePoint; err: number } | null = null
      let allZero = true
      for (const td of testDirs) {
        const r = iterateNextStep(p, td)
        if (r.area !== 0) allZero = false
        if (!r.failed && (!best || r.errorFraction < best.err)) best = { dir: r.newToolDir, err: r.errorFraction }
      }
      if (best) return best.dir
      if (allZero) {
        // Head for the middle of the nearest cleared polygon (upstream: the nearest path of the
        // whole cleared area; here the nearest one in this tile's window).
        const local = cleared.pathsFor(p.x - R - 2, p.y - R - 2, p.x + R + 2, p.y + R + 2)
        if (local.length) {
          const c = DistancePointToPathsSqrd(local, p)
          if (c.distSq < R * R) return DirectionV(p, Compute2DPolygonCentroid(local[c.pathIndex]))
        }
      }
      return null
    }

    // ── engage points: per-tile contour pieces, searched nearest-first ─────────
    const tileEngage = new Map<number, TileEngage>()
    const tbpCore = new Map<number, Paths>()
    let engageProt = -1
    const piecesOf = (idx: number, protrusion: number): EngagePiece[] => {
      if (protrusion !== engageProt) { tileEngage.clear(); engageProt = protrusion }
      // Reuse the cached contours without merging the tile's queue when nothing queued lies
      // near its core — the contours cannot have moved.
      const raw = cleared.peek(idx)
      if (!raw) return []
      const cached = tileEngage.get(idx)
      if (cached && cached.ver === raw.cver && !raw.pendingNearCore) return cached.pieces
      const t = cleared.get(idx)!
      if (t.full || t.paths.length === 0) { tileEngage.set(idx, { ver: t.cver, pieces: [] }); return [] }
      if (cached && cached.ver === t.cver) return cached.pieces
      const i = idx % cleared.nx, j = (idx - i) / cleared.nx
      let core = tbpCore.get(idx)
      if (!core) {
        core = new RectClip64(cleared.coreRect(i, j)).execute(tbpMinus)
        tbpCore.set(idx, core)
      }
      const pieces: EngagePiece[] = []
      // A contour point lies about R from the real cleared boundary (eroded by R + 2, grown
      // back by 2 + protrusion), so a core with no real boundary within R + slack of it has
      // none — skip the two offsets, which is ~40% of rebuilds.
      if (core.length && cleared.boundaryNearCore(idx, R + 16)) {
        const engageBuffer = 2
        const pre = offset(t.paths, -(R + engageBuffer), JoinType.Round, EndType.Polygon, this.arcTol)
        const engagePaths = offset(pre, engageBuffer + protrusion, JoinType.Round, EndType.Polygon, this.arcTol)
        for (const ep of engagePaths) {
          for (const open of PathIntersectArea(ep, core)) {
            if (open.length < 2) continue
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
            for (const q of open) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y) }
            pieces.push({ pts: open, minX: x0, minY: y0, maxX: x1, maxY: y1, samples: null, sdir: null, status: null, result: null })
          }
        }
      }
      tileEngage.set(idx, { ver: t.cver, pieces })
      return pieces
    }

    const sampleWalk = (pc: EngagePiece): void => {
      const open = pc.pts
      const samples: IntPoint[] = [], dirs: DoublePoint[] = []
      let dToGo = 0, seg = 0, segD = 0
      while (seg < open.length - 1) {
        let p: IntPoint = open[seg]
        let segDir: DoublePoint = { x: 1, y: 0 }
        do {
          const p1 = open[seg], p2 = open[seg + 1]
          const segLen = Math.sqrt(DistanceSqrd(p1, p2))
          segDir = segLen > 0 ? { x: (p2.x - p1.x) / segLen, y: (p2.y - p1.y) / segLen } : segDir
          if (segLen - segD > dToGo) {
            segD += dToGo; dToGo = 0
            const t = segD / segLen
            p = ip(p2.x * t + p1.x * (1 - t), p2.y * t + p1.y * (1 - t))
          } else {
            dToGo -= segLen - segD; segD = 0; seg++; p = p2
          }
        } while (dToGo > 0 && seg < open.length - 1)
        samples.push(p); dirs.push(segDir)
        dToGo = MIN_STEP_CLIPPER
      }
      pc.samples = samples; pc.sdir = dirs
      pc.status = new Int8Array(samples.length)
      pc.result = new Array(samples.length).fill(null)
    }

    /** First valid engage point of a contour: from its start, or for a closed loop from the
     *  sample nearest prevPos (upstream rotates closed engage rings that way before clipping). */
    const evaluateChain = (pcs: EngagePiece[], closed: boolean, prevPos: IntPoint | null): { p: IntPoint; dir: DoublePoint } | null => {
      let total = 0
      for (const pc of pcs) { if (!pc.samples) sampleWalk(pc); total += pc.samples!.length }
      if (total === 0) return null
      let p0 = 0, s0 = 0
      if (closed && prevPos) {
        let bd = Infinity
        pcs.forEach((pc, pi) => pc.samples!.forEach((q, k) => { const d = DistanceSqrd(prevPos, q); if (d < bd) { bd = d; p0 = pi; s0 = k } }))
      }
      let pi = p0, k = s0
      for (let o = 0; o < total; o++) {
        const pc = pcs[pi]
        if (k < pc.samples!.length) {
          if (pc.status![k] === 0) {
            const dir = initToolDir(pc.samples![k], pc.sdir![k])
            pc.status![k] = dir ? 1 : 2
            pc.result![k] = dir
          }
          if (pc.status![k] === 1) return { p: pc.samples![k], dir: pc.result![k]! }
        }
        k++
        if (k >= pc.samples!.length) { k = 0; pi = (pi + 1) % pcs.length; if (!closed && pi === 0) break }
      }
      return null
    }

    const linkCost = (prevPos: IntPoint | null, link: TPath[]): number => {
      let cost = 0
      let prev: [number, number] | null = prevPos ? this.toMM(prevPos) : null
      for (const tp of link) {
        if (tp.motion === MotionType.LinkNotClear) cost += 10000
        for (const cur of tp.pts) {
          if (prev) cost += Math.hypot(cur[0] - prev[0], cur[1] - prev[1])
          prev = cur
        }
      }
      return cost
    }

    let engageCutArea = 0
    const getEngagePoint = (prevPos: IntPoint | null): { pos: IntPoint; dir: DoublePoint; link: TPath[] } | null => {
      const targetArea = this.optimalCutAreaPD * MIN_STEP_CLIPPER
      const theta = Math.pow(12 * targetArea / R / R, 1 / 3)
      const protrusion = R - Math.cos(theta / 2) * R
      const engagementProtrusion = Math.trunc(Math.min(protrusion, this.stepOverScaled * FINISHING_THICKNESS_SCALE))

      // Every tile's contour pieces (cached per tile version), stitched back into the whole
      // contours upstream gets from one global offset: a contour leaving one tile's core
      // enters the next at the same point. Upstream walks each CLIPPED contour from its true
      // start and takes the first valid point; only a contour that is a closed loop is begun
      // nearest the tool. Walking every piece from the point nearest the tool instead looks
      // equivalent and is not — at a wall it picks the contour's wall-hugging end, a valid
      // point that yields a 0.2 mm pass, and every wall is then cleared by passes creeping
      // backwards a fraction of a millimetre at a time: the rings of lead-ins.
      const pieces: EngagePiece[] = []
      for (let idx = 0; idx < cleared.nx * cleared.ny; idx++) {
        for (const pc of piecesOf(idx, engagementProtrusion)) pieces.push(pc)
      }
      if (!pieces.length) return null
      const JOIN = 6 // units: the same contour clipped from two windows can round differently
      const bucket = (x: number, y: number): string => `${Math.floor(x / 16)},${Math.floor(y / 16)}`
      const starts = new Map<string, number[]>()
      pieces.forEach((pc, i) => {
        const st = pc.pts[0], k = bucket(st.x, st.y)
        const l = starts.get(k); if (l) l.push(i); else starts.set(k, [i])
      })
      const succ = new Int32Array(pieces.length).fill(-1)
      const hasPred = new Uint8Array(pieces.length)
      pieces.forEach((pc, i) => {
        const e = pc.pts[pc.pts.length - 1]
        const bx = Math.floor(e.x / 16), by = Math.floor(e.y / 16)
        let bestJ = -1, bestD = JOIN * JOIN
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          for (const j of starts.get(`${bx + dx},${by + dy}`) ?? []) {
            if (hasPred[j] && j !== i) continue
            const d = DistanceSqrd(e, pieces[j].pts[0])
            if (d <= bestD) { bestD = d; bestJ = j }
          }
        }
        if (bestJ >= 0 && !(hasPred[bestJ])) { succ[i] = bestJ; hasPred[bestJ] = 1 }
      })
      const chains: Array<{ pcs: EngagePiece[]; closed: boolean; lb: number }> = []
      const seen = new Uint8Array(pieces.length)
      const follow = (i0: number): { pcs: EngagePiece[]; closed: boolean } => {
        const pcs: EngagePiece[] = []
        let i = i0, closed = false
        while (i >= 0 && !seen[i]) { seen[i] = 1; pcs.push(pieces[i]); i = succ[i]; if (i === i0) closed = true }
        return { pcs, closed }
      }
      for (let i = 0; i < pieces.length; i++) if (!hasPred[i] && !seen[i]) chains.push({ ...follow(i), lb: 0 })
      for (let i = 0; i < pieces.length; i++) if (!seen[i]) chains.push({ ...follow(i), lb: 0 })
      for (const ch of chains) {
        let lb = Infinity
        for (const pc of ch.pcs) {
          if (!prevPos) { lb = 0; break }
          const dx = Math.max(pc.minX - prevPos.x, 0, prevPos.x - pc.maxX)
          const dy = Math.max(pc.minY - prevPos.y, 0, prevPos.y - pc.maxY)
          lb = Math.min(lb, Math.sqrt(dx * dx + dy * dy) / this.scaleFactor)
        }
        ch.lb = lb
      }
      chains.sort((a, b) => a.lb - b.lb)

      let bestCost = Infinity
      let best: { pos: IntPoint; dir: DoublePoint; link: TPath[] } | null = null
      for (const ch of chains) {
        if (ch.lb >= bestCost) break
        const ev = evaluateChain(ch.pcs, ch.closed, prevPos)
        if (!ev) continue
        const straight = prevPos ? Math.sqrt(DistanceSqrd(prevPos, ev.p)) / this.scaleFactor : 0
        if (straight >= bestCost) continue
        const link = this.findLinkPath(prevPos, ev.p, ev.dir, cleared, output)
        if (!link) continue
        const cost = linkCost(prevPos, link)
        if (cost < bestCost) { bestCost = cost; best = { pos: ev.p, dir: ev.dir, link } }
      }
      if (best) {
        // What the lead-in cuts counts toward the coming pass (see the pass loop). Measured
        // step by step against the area as it stands, before it is merged in.
        engageCutArea = 0
        for (const lp of best.link) {
          if (lp.motion !== MotionType.Cutting) continue
          const pts = lp.pts.map(this.fromMM)
          for (let i = 1; i < pts.length; i++) engageCutArea += this.calcCutArea(pts[i - 1], pts[i], cleared)[0]
          cleared.expand(pts)
        }
      }
      return best
    }

    // ── first engagement: from pre-cleared ground, else a helix ────────────────
    let linkPath: TPath[] = []
    const first = getEngagePoint(null)
    if (first) {
      toolPos = first.pos; toolDir = first.dir; linkPath = first.link
      entryPoint = linkPath.length ? this.fromMM(linkPath[0].pts[0]) : toolPos
      output.startPoint = this.toMM(entryPoint)
    } else {
      const ep = this.findEntryPoint(toolBoundPaths, boundPaths, cleared)
      if (!ep) { output.startPointNotFound = true; this.results.push(output); return }
      entryPoint = ep.entryPoint; toolPos = ep.toolPos; toolDir = ep.toolDir
      output.startPoint = this.toMM(toolPos)
    }
    output.returnMotionType = 0
    output.helixCenter = this.toMM(entryPoint)

    // ── passes ────────────────────────────────────────────────────────────────
    // Upstream decides whether a pass cut anything by diffing the whole cleared area before
    // and after it. The answer is already known: every accepted step cuts ≥ 1 unit² of stock
    // nothing before it had cut (a step cutting less is refused), so a pass cut something iff
    // it took a step — or, with no steps, iff its lead-in did. The step areas also drive the
    // progress bar.
    for (let pass = 0; ; pass++) {
      let passCutArea = engageCutArea
      engageCutArea = 0
      passToolPath = []
      toClearPath = []
      angleHistory = [0]
      for (const lp of linkPath) {
        if (lp.motion === MotionType.Cutting || lp.motion === MotionType.LinkClear) cleared.expand(lp.pts.map(this.fromMM))
      }
      angle = Math.PI / 4
      gyro = []
      for (let i = 0; i < DIRECTION_SMOOTHING_BUFLEN; i++) gyro.push(toolDir)

      for (;;) {
        toolDir = AverageDirection(gyro)
        const r = iterateNextStep(toolPos, toolDir)
        if (r.failed) break
        if (r.iterationAngle !== null) {
          angleHistory.push(r.iterationAngle)
          if (angleHistory.length > ANGLE_HISTORY_POINTS) angleHistory.shift()
        }
        if (lastExpandToolDir.x * r.newToolDir.x + lastExpandToolDir.y * r.newToolDir.y < Math.cos(Math.PI / 4)) {
          cleared.expand(toClearPath)
          toClearPath = []
          lastExpandToolDir = toolDir
        }
        if (!toClearPath.length) toClearPath.push(toolPos)
        toClearPath.push(r.newToolPos)
        if (!passToolPath.length) passToolPath.push(toolPos)
        passToolPath.push(r.newToolPos)
        passCutArea += r.area
        toolPos = r.newToolPos
        gyro.push(r.newToolDir)
        gyro.shift()
      }
      if (toClearPath.length) { cleared.expand(toClearPath); toClearPath = [] }

      if (passCutArea >= 1) {
        this.clearedSoFar += passCutArea
        this.onProgress?.(Math.min(0.99, this.clearedSoFar / this.totalToClear))
        const cleaned = CleanPath(passToolPath, CLEAN_PATH_TOLERANCE)
        const np = this.appendToolPath(output, cleaned, linkPath, cleared)
        if (np) { toolPos = np.pos; toolDir = np.dir }
        badEngageCount = 0
      } else badEngageCount++
      if (badEngageCount > 10000) { output.tooManyFailedEngagements = true; break }

      const ep = getEngagePoint(toolPos)
      if (ep) {
        toolPos = ep.pos; toolDir = ep.dir; linkPath = ep.link
        lastExpandToolDir = toolDir
      } else {
        // anything left uncleared away from the walls?
        const all = cleared.getCleared()
        const remaining = all.filter(p => p.length && this.within(p[0]) && DistancePointToPathsSqrd(boundPaths, p[0]).distSq > 4 * R * R)
        if (remaining.length) output.unclearedAreaRemains = true
        break
      }
    }

    // sanity check: is the interior fully cleared before finishing?
    {
      const clearedLocations = offset(cleared.getCleared(), -R, JoinType.Round, EndType.Polygon, this.arcTol)
      const tbpShrink = offset(toolBoundPaths, -this.stepOverScaled * FINISHING_THICKNESS_SCALE - MIN_STEP_CLIPPER, JoinType.Round, EndType.Polygon, this.arcTol)
      if (boolOp(ClipType.Difference, tbpShrink, clearedLocations).length) output.failedToSetUpFinishingPass = true
    }

    // ── finishing pass ────────────────────────────────────────────────────────
    if (this.finishingProfile) {
      const tbpModified: Paths = []
      for (const fp of finishingPaths) {
        const off = (getPathNestingLevel(fp, finishingPaths) % 2 === 1) ? 3 : -3
        const orientation = isPositive(fp)
        for (const p of offset([fp], off, JoinType.Round, EndType.Polygon, this.arcTol)) {
          if (isPositive(p) !== orientation) p.reverse()
          tbpModified.push(p)
        }
      }
      toolBoundPaths = tbpModified
      if (toolBoundPaths.length) this.bound = new BoundIndex(toolBoundPaths, R / 2)

      const closedF: Paths = [], openF: Paths = []
      for (const p of finishingPaths) {
        let startIdx = 0
        for (let i = 0; i < p.length; i++) if ((p[i].z ?? 0) === 0) { startIdx = i; break }
        let cur: Path = []
        for (let o = 0; o < p.length; o++) {
          const pt = p[(startIdx + o) % p.length]
          if ((pt.z ?? 0) === 1) cur.push(pt)
          else if (cur.length) { openF.push(cur); cur = [] }
        }
        if (cur.length === p.length) closedF.push(p)
        else if (cur.length) openF.push(cur)
      }

      const stockExpanded = offset(this.stockInputPaths, R, JoinType.Round, EndType.Polygon, this.arcTol)
      while (closedF.length || openF.length) {
        const [isClosed, fin] = PopNextFinishingPass(closedF, openF, toolPos, this.stepOverScaled)
        if (!fin.length) continue
        if (stockExpanded.length && PathIntersectArea(fin, stockExpanded, isClosed).length === 0) continue
        let finCleaned = CleanPath(fin, FINISHING_CLEAN_PATH_TOLERANCE)
        const endPoint = isClosed ? finCleaned[0] : fin[fin.length - 1]
        const last = finCleaned[finCleaned.length - 1]
        if (last.x !== endPoint.x || last.y !== endPoint.y) {
          if (Math.sqrt(DistanceSqrd(endPoint, last)) < FINISHING_CLEAN_PATH_TOLERANCE) finCleaned.pop()
          finCleaned.push(endPoint)
        }
        finCleaned = finCleaned.map(q => ({ x: q.x, y: q.y }))
        const lp = this.findLinkPath(toolPos, finCleaned[0], GetPathDirectionV(finCleaned, 1), cleared, output)
        if (!lp) { output.finishingLeadInFailed = true; continue }
        const np = this.appendToolPath(output, finCleaned, lp, cleared)
        if (np) { toolPos = np.pos; toolDir = np.dir }
        else { toolPos = finCleaned[finCleaned.length - 1]; toolDir = GetPathDirectionV(finCleaned, finCleaned.length - 1) }
        cleared.expand(finCleaned)
        for (const l of lp) if (l.motion === MotionType.Cutting) cleared.expand(l.pts.map(this.fromMM))
      }
      output.returnMotionType = this.isClearPath([toolPos, entryPoint], cleared) ? MotionType.LinkClear : MotionType.LinkNotClear
    }

    const finalCleared = areaOfPaths(cleared.getCleared())
    output.clearedArea = (finalCleared - areaOfPaths(initialClearedPaths)) / (this.scaleFactor * this.scaleFactor)
    this.results.push(output)
  }
}
