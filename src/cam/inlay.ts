import { pointInPolygon, interiorPoint, pushAll, isVCutter, tipBallRadiusMM, vProfileHeightMM, vRadiusAtHeightMM } from './geom'
import { flattenPath, signedArea, splitSelfIntersecting, requireClosedSubpaths, sharesVertex, type Pt2 } from './pathFlattener'
import { generatePocket } from './pocket'
import { generateVCarve } from './vcarve'
import { inflatePathsD, differenceD, intersectD, FillRule, JoinType, EndType } from 'clipper2-ts'
import { applyCornerTreatment } from '../tools/cornerTreatment'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

export interface InlayParams {
  angleDeg: number           // V-bit full included angle
  pocketDepthMM: number      // depth of the flat-bottom pocket / inlay
  stepDownMM: number         // step-down for end mill roughing
  stepoverPercent: number    // stepover % for end mill roughing
  glueLineMM: number         // extra depth added to female pocket for glue space
  clearanceMM: number        // reduction of male bevel offsets for fit clearance
  islandDs: string[]         // hole paths inside the shape
  // Male only, one entry per islandDs entry: the paths nested DIRECTLY inside that island.
  // Those are the next nesting level's plugs — the male must leave them standing in the
  // hole it cuts, exactly as the Pocket form's "invert" grouping leaves its own islands
  // standing. Omitted/short = no nested plugs. The female ignores it: a nested group cuts
  // its own socket into the island it stands on, so nothing is needed there.
  islandPlugDs?: string[][]
  // Male only: the selected path this plug stands INSIDE — the outline of the background
  // the male board has to clear. An inverted grouping machines the levels the default
  // reading treats as holes, so the plug is a shape nested inside another selected path
  // and the wood between the two is background: leave it at full height and the male board
  // lands on the female's uncut face with the plug still a plug-depth clear of its socket.
  // Absent → the plug's surroundings are scrap the release profile alone frees (the
  // default, un-nested reading, where the boundary IS the outline of the male piece).
  fieldD?: string
  // Male only, with fieldD: the OTHER plugs standing in that same field. One operation
  // clears the field for all of them, so every one of them has to be kept out of it.
  fieldPlugDs?: string[]
  rampIn?: boolean           // ramp/helical entry on roughing pockets instead of plunging
  mirrorX?: boolean          // male only: mirror shape around vertical axis
  // Male only: the X of that axis. Turning the board over is one rigid motion for the
  // WHOLE part, so every operation cut from the same board must flip about the same line.
  // Omitted → this boundary's own centre, which is only right when it is the only group.
  mirrorAxisX?: number
  safeHeightMM?: number
}

// Offset a path by deltaMM. Self-intersecting input is split into simple loops
// first so Clipper2 receives well-formed polygons.
//
// `precision` is DECIMAL PLACES, not a distance — inflatePathsD's signature is
// (paths, delta, joinType, endType, miterLimit, precision, arcTolerance) and this argument
// lands in the precision slot. It was named `arcTolerance` here, which reads as millimetres
// and is off by orders of magnitude in both directions: 6 looks like a huge chord error and
// is actually µm precision, while a plausible-looking 0.01 quantizes to whole millimetres.
// `arcToleranceMM` is the real chord-error control for Round joins (0 = Clipper's default,
// delta/500); it is ignored for Miter.
function offsetPath(
  d: string, deltaMM: number, joinType: JoinType, precision: number, arcToleranceMM = 0,
): string | null {
  const subpaths = splitSelfIntersecting(flattenPath(d, 0.05))
  if (!subpaths.length) return null
  const inputPaths = subpaths.map(sp => {
    let pts = [...sp]
    if (pts.length > 1 && Math.hypot(pts[pts.length-1][0]-pts[0][0], pts[pts.length-1][1]-pts[0][1]) < 1e-6)
      pts = pts.slice(0, -1)
    if (signedArea(pts) < 0) pts = [...pts].reverse()
    return pts.map(([x, y]) => ({ x, y }))
  })
  const result = inflatePathsD(inputPaths, deltaMM, joinType, EndType.Polygon, 4, precision, arcToleranceMM)
  if (!result.length) return null
  const cmds: string[] = []
  for (const loop of result) {
    if (loop.length < 3) continue
    cmds.push(`M${loop[0].x.toFixed(4)} ${loop[0].y.toFixed(4)}`)
    for (let i = 1; i < loop.length; i++) cmds.push(`L${loop[i].x.toFixed(4)} ${loop[i].y.toFixed(4)}`)
    cmds.push('Z')
  }
  return cmds.length ? cmds.join(' ') : null
}

function offsetPathD(d: string, deltaMM: number): string | null {
  return offsetPath(d, deltaMM, JoinType.Miter, 6)
}

// CCW-oriented clipper rings for a d-string.
function toClipRings(s: string) {
  return splitSelfIntersecting(flattenPath(s, 0.05))
    .map(sp => {
      let pts = [...sp]
      if (pts.length > 1 && Math.hypot(pts[pts.length-1][0]-pts[0][0], pts[pts.length-1][1]-pts[0][1]) < 1e-6)
        pts = pts.slice(0, -1)
      return pts
    })
    .filter(pts => pts.length >= 3)
    .map(pts => (signedArea(pts) < 0 ? [...pts].reverse() : pts).map(([x, y]) => ({ x, y })))
}

function ringsToD(result: { x: number; y: number }[][]): string | null {
  const cmds: string[] = []
  for (const loop of result) {
    if (loop.length < 3) continue
    cmds.push(`M${loop[0].x.toFixed(4)} ${loop[0].y.toFixed(4)}`)
    for (let i = 1; i < loop.length; i++) cmds.push(`L${loop[i].x.toFixed(4)} ${loop[i].y.toFixed(4)}`)
    cmds.push('Z')
  }
  return cmds.length ? cmds.join(' ') : null
}

// `d` minus every path in `clipDs`, as a compound d-string (CCW outers, CW holes — what
// classifySubpaths, and so generateVCarve, expects). null when nothing is left.
//
// Both of these return null rather than throwing when Clipper cannot do the job. They only
// ever REFINE a wall region that has a working un-refined form, so the caller's fallback
// costs a slightly wrong wall — whereas a throw here escapes insideClear and discards a
// socket whose pocket has already been computed, leaving the operation with no toolpath at
// all. Nothing about a boolean on decorative artwork is worth that.
function subtractD(d: string, clipDs: (string | null | undefined)[]): string | null {
  try {
    const subject = toClipRings(d)
    if (!subject.length) return null
    const clips = clipDs.flatMap(c => (c ? toClipRings(c) : []))
    if (!clips.length) return d
    return ringsToD(differenceD(subject, clips, FillRule.NonZero, 6))
  } catch { return null }
}

/** `a` ∩ `b`, same compound-d convention as subtractD. */
function intersectPathD(a: string, b: string): string | null {
  try {
    const sa = toClipRings(a), sb = toClipRings(b)
    if (!sa.length || !sb.length) return null
    return ringsToD(intersectD(sa, sb, FillRule.NonZero, 6))
  } catch { return null }
}

function offsetPathRound(d: string, deltaMM: number): string | null {
  return offsetPath(d, deltaMM, JoinType.Round, 2)
}

// Offset a path by deltaMM, treating each sub-ring as an independent solid (each ring
// offset in its own Clipper call, so results are never unioned across rings). A
// self-intersecting boundary therefore keeps all its lobes on a positive/outward
// offset, which offsetPath would merge into one. Used for inlay socket offsets, where
// each lobe must stay a separate region (the same way generatePocket treats them).
function offsetEachRing(d: string, deltaMM: number): string | null {
  const cmds: string[] = []
  for (const ring of splitSelfIntersecting(flattenPath(d, 0.05))) {
    let pts = [...ring]
    if (pts.length > 1 && Math.hypot(pts[pts.length-1][0]-pts[0][0], pts[pts.length-1][1]-pts[0][1]) < 1e-6)
      pts = pts.slice(0, -1)
    if (pts.length < 3) continue
    if (signedArea(pts) < 0) pts = [...pts].reverse()
    const result = inflatePathsD([pts.map(([x, y]) => ({ x, y }))], deltaMM, JoinType.Miter, EndType.Polygon, 4, 6)
    for (const loop of result) {
      if (loop.length < 3) continue
      cmds.push(`M${loop[0].x.toFixed(4)} ${loop[0].y.toFixed(4)}`)
      for (let i = 1; i < loop.length; i++) cmds.push(`L${loop[i].x.toFixed(4)} ${loop[i].y.toFixed(4)}`)
      cmds.push('Z')
    }
  }
  return cmds.length ? cmds.join(' ') : null
}

// Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in cells.
// One 1-D pass per row then per column; `seed[k] !== 0` marks the sites distance is measured
// FROM. Cells with no site anywhere come back at INF.
const EDT_INF = 1e12
function edtSq(seed: Uint8Array, nx: number, ny: number): Float64Array {
  const f = new Float64Array(nx * ny)
  for (let k = 0; k < f.length; k++) f[k] = seed[k] ? 0 : EDT_INF
  const pass = (n: number, stride: number, base: number) => {
    const v = new Int32Array(n), z = new Float64Array(n + 1), out = new Float64Array(n)
    let k = 0
    v[0] = 0; z[0] = -EDT_INF; z[1] = EDT_INF
    for (let q = 1; q < n; q++) {
      let s = 0
      for (;;) {
        s = ((f[base + q * stride] + q * q) - (f[base + v[k] * stride] + v[k] * v[k])) / (2 * q - 2 * v[k])
        if (s <= z[k]) k--
        else break
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = EDT_INF
    }
    k = 0
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++
      out[q] = (q - v[k]) * (q - v[k]) + f[base + v[k] * stride]
    }
    for (let q = 0; q < n; q++) f[base + q * stride] = out[q]
  }
  for (let j = 0; j < ny; j++) pass(nx, 1, j * nx)
  for (let i = 0; i < nx; i++) pass(ny, nx, i)
  return f
}

// Even-odd scanline fill of a set of rings into a cell mask. Counters nest once inside their
// letter, so even-odd gives letter-minus-counter with no containment test.
function fillRings(
  rings: Pt2[][], nx: number, ny: number, gx0: number, gy0: number, cell: number,
): Uint8Array {
  const mask = new Uint8Array(nx * ny)
  const xs: number[] = []
  for (let j = 0; j < ny; j++) {
    const py = gy0 + j * cell
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
    const row = j * nx
    for (let t = 0; t + 1 < xs.length; t += 2) {
      const i0 = Math.max(0, Math.ceil((xs[t] - gx0) / cell))
      const i1 = Math.min(nx - 1, Math.floor((xs[t + 1] - gx0) / cell))
      for (let i = i0; i <= i1; i++) mask[row + i] = 1
    }
  }
  return mask
}

/**
 * V-bit plunges that clear the stock inside a letter's COUNTERS that the roughing cutter
 * cannot reach.
 *
 * The wall trace leaves the plug's cone standing beside every letter edge — stock at
 * −D + u/tan(θ/2), u being the distance out from the outline. Everywhere the end mill can
 * get to, its pocket takes that away flat at −D and nothing is left. Where it cannot — a
 * counter too narrow to enter, or a corner tighter than its radius — the stock stays, the
 * female has untouched face against it, and every bit of it is interference.
 *
 * ── Only within a letter's bounding box ──────────────────────────────────────────────────
 * Every patch worth a plunge belongs to a letterform: the counters (A's triangle here is
 * narrower than a 1/8" cutter and never gets pocketed at all — enclosed by the letter, so
 * there is no second chance), and the tight outside corners where a stroke meets a bowl —
 * B's and G's junctions, E's and F's notches. All of them sit inside the letter's own
 * bounding box, so that is the test.
 *
 * The open background beyond those boxes is deliberately left alone. The V-bit runs BEFORE
 * the end mill (one tool change), so out there it would be plunging into full-depth solid
 * stock the pocket is about to remove anyway. Unrestricted, the patch test also flagged the
 * blank's own edge band and its four corners, which are far from any letter — and since the
 * allowed depth grows with distance from the letters, that came out as 146 plunges in open
 * stock, some at the bit's 5.5 mm limit in a 6 mm board. Inside a bounding box the same
 * bound is self-limiting: a patch the cutter cannot reach is by definition within a radius
 * of a letter, so nothing there can ask for more than D + R/tan(θ/2).
 *
 * ── The depth law ────────────────────────────────────────────────────────────────────────
 * A tip at q, depth z, cuts the point p down to −z + |p−q|/tan(θ/2). Two consequences:
 *
 *   SAFE:   the plug's wall must survive, and its nearest point is the outline itself, so
 *           z ≤ D + dist(q, outline)/tan(θ/2). At equality the cone lands exactly on the
 *           wall the trace already cut — it can touch it but never eat into it.
 *   USEFUL: at that same z, every p within dist(q, outline) of q is taken to −D or below.
 *
 * The bound and the reach are the same number, so one plunge at the deepest point of a
 * patch is the most any single plunge can do, and the depth is read straight off the
 * distance to the LETTER OUTLINE — never off the patch geometry. That is what makes this
 * gouge-proof: get the patch detection wrong and the worst case is a wasted plunge in
 * already-cut air. Deriving depth from a region boolean instead put 1038 mm² of B and D
 * through the letters when the boolean returned the wrong side.
 *
 * Cutting deeper than D inside a counter costs nothing — the assembly is planed back to
 * the female's face, so everything below the mating plane comes off anyway.
 *
 * Patches are found on a grid: a cell is reachable if some disc of the cutter's radius
 * covers it without touching a letter, i.e. the reachable set is the cutter-centre set
 * dilated by its own radius. Distances lose up to a cell to rasterization, so a cell's
 * diagonal is subtracted from every radius before it is used — the error can then only
 * make a plunge shallower and narrower, never deeper.
 */
function letterReliefPlunges(
  letterOuterDs: string[], letterCounterDs: string[],
  roughRadiusMM: number, plugDepthMM: number, wg: WallGeom, maxDepthMM: number,
): { x: number; y: number; z: number }[] {
  const tanHalf = wg.tanHalf
  const CELL = 0.1
  const outerRings = letterOuterDs.flatMap(s => flattenPath(s, 0.05)).filter(r => r.length >= 3)
  const counterRings = letterCounterDs.flatMap(s => flattenPath(s, 0.05)).filter(r => r.length >= 3)
  if (!outerRings.length) return []
  // One box per letter — the union of the boxes, NOT the box of the union, so the open
  // ground between letters is not swept in with them.
  const boxes = outerRings.map(r => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity
    for (const [x, y] of r) {
      if (x < a) a = x
      if (y < b) b = y
      if (x > c) c = x
      if (y > d) d = y
    }
    return { x0: a, y0: b, x1: c, y1: d }
  })

  // Grid spans the letters themselves, not the blank — nothing outside them is considered.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of outerRings) for (const [x, y] of r) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  const pad = roughRadiusMM + 1
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
  const nx = Math.ceil((x1 - x0) / CELL) + 1
  const ny = Math.ceil((y1 - y0) / CELL) + 1
  if (nx < 3 || ny < 3 || nx * ny > 8e6) return []

  const bbox = { x0, y0 }
  // Letter SOLID (outers minus counters) — what the plug is made of, and what every depth
  // is measured against. Even-odd handles the single level of nesting.
  const letters = fillRings([...outerRings, ...counterRings], nx, ny, bbox.x0, bbox.y0, CELL)
  // Candidate zone: inside some letter's bounding box. Counters are inside their letter's
  // box by construction, so this covers them as well as the tight outside corners.
  const inBox = new Uint8Array(nx * ny)
  for (const b of boxes) {
    const i0 = Math.max(0, Math.floor((b.x0 - bbox.x0) / CELL))
    const i1 = Math.min(nx - 1, Math.ceil((b.x1 - bbox.x0) / CELL))
    const j0 = Math.max(0, Math.floor((b.y0 - bbox.y0) / CELL))
    const j1 = Math.min(ny - 1, Math.ceil((b.y1 - bbox.y0) / CELL))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) inBox[j * nx + i] = 1
  }
  // Distance from every cell to the nearest letter cell. Inside a letter it is 0, which is
  // what keeps a plunge that lands on one at plug depth exactly.
  const distToLetter = edtSq(letters, nx, ny)
  const rCells = roughRadiusMM / CELL

  // Where the cutter's CENTRE may sit: a radius clear of every letter. Not restricted to
  // the boxes — a cutter parked outside a box still sweeps into it, and missing that would
  // invent patches along every box edge.
  const centres = new Uint8Array(nx * ny)
  for (let k = 0; k < centres.length; k++) {
    if (!letters[k] && distToLetter[k] >= rCells * rCells) centres[k] = 1
  }
  const distToCentre = edtSq(centres, nx, ny)

  // Leftover: background the cutter never swept, and proud enough to be worth a plunge.
  const SAFETY_MM = CELL * Math.SQRT2
  const MIN_RELIEF_MM = 0.05
  // The reach a MIN_RELIEF_MM-deep plunge actually clears — the tool's width at that
  // depth, which for a taper is its tip ball rather than a cone's depth × tanHalf.
  const minDistCells = (wg.halfWidthAt(MIN_RELIEF_MM) + SAFETY_MM) / CELL
  const open: number[] = []
  for (let k = 0; k < letters.length; k++) {
    if (letters[k] || !inBox[k]) continue
    if (distToCentre[k] <= rCells * rCells) continue
    if (distToLetter[k] <= minDistCells * minDistCells) continue
    open.push(k)
  }
  if (!open.length) return []
  // Deepest patch point first: it both reaches furthest and is the one standing proudest.
  open.sort((a, b) => distToLetter[b] - distToLetter[a])

  const done = new Uint8Array(nx * ny)
  const out: { x: number; y: number; z: number }[] = []
  for (const k of open) {
    if (done[k]) continue
    const i = k % nx, j = (k - i) / nx
    const reachMM = Math.max(0, Math.sqrt(distToLetter[k]) * CELL - SAFETY_MM)
    if (reachMM <= 0) continue
    // How far BELOW the mating plane the tip must go for the tool to be `reachMM` wide
    // there — f(reach), the inverse of halfWidthAt. A taper's tip ball makes this less
    // than the cone's reach/tan, so the plunge stops short of the plug wall rather than
    // shaving it.
    const z = -Math.min(plugDepthMM + vProfileHeightMM(reachMM, tanHalf, wg.tipR), maxDepthMM)
    out.push({ x: bbox.x0 + i * CELL, y: bbox.y0 + j * CELL, z })
    // This plunge takes everything within reachMM down to the mating plane or below.
    const rc = Math.ceil(reachMM / CELL), rc2 = (reachMM / CELL) * (reachMM / CELL)
    for (let dj = -rc; dj <= rc; dj++) {
      const jj = j + dj
      if (jj < 0 || jj >= ny) continue
      for (let di = -rc; di <= rc; di++) {
        const ii = i + di
        if (ii < 0 || ii >= nx) continue
        if (di * di + dj * dj <= rc2) done[jj * nx + ii] = 1
      }
    }
    if (out.length >= 2000) break
  }
  return out
}

// Returns true for geometry-constraint errors that are expected and safe to skip.
// Unknown errors (regressions, bad config) are re-thrown so they surface immediately.
function isExpectedGeometryError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return /too small|no geometry|medial axis|boundary vcarve/i.test(e.message)
}

// Round all convex (outer) corners of path d to radius r using the corner tool.
function roundCornersForEndmill(d: string, r: number): string {
  if (r <= 0.001) return d
  return applyCornerTreatment(d, { type: 'outerRound', radiusMM: r })
}

// Extra radius added when rounding corners for the end-mill wall method, so the finish
// bit can reach fully into convex corners (it leaves a small flat at a perfect point
// otherwise). Arbitrary — just enough to cover typical end-mill imperfection without
// visibly rounding the final cut.
const CORNER_ROUND_EXTRA_MM = 1

// ─── Helpers ─────────────────────────────────────────────────────────────────


function ptsToD(pts: Pt2[]): string {
  if (pts.length < 2) return ''
  const p = [`M${pts[0][0].toFixed(4)} ${pts[0][1].toFixed(4)}`]
  for (let i = 1; i < pts.length; i++) p.push(`L${pts[i][0].toFixed(4)} ${pts[i][1].toFixed(4)}`)
  p.push('Z')
  return p.join(' ')
}

// Split a multi-subpath d string into per-letter regions.
// Each outer subpath is returned as { outerD, islandDs[] } where islandDs are subpaths
// lying inside that outer ring (intrinsic holes like the counter of 'o' or 'a').
// Single-subpath paths return [].
// Exported for tests: a non-empty result switches generateInlayMale onto the raised-prism
// text algorithm entirely, so getting the grouping wrong changes far more than one counter.
export function splitRegions(d: string): { outerD: string; islandDs: string[] }[] {
  // A self-intersecting single path has exactly one M command. splitSelfIntersecting
  // will split it into multiple loops, but those are sub-rings of one shape — not
  // separate letters. Only treat as multi-region when the path has multiple explicit
  // subpaths (multiple M commands), i.e. text or intentionally compound shapes.
  if ((d.match(/M/g) ?? []).length <= 1) return []
  const subs = splitSelfIntersecting(flattenPath(d, 0.05))
  if (subs.length <= 1) return []

  const sorted = [...subs].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
  // One stand-in point per ring, computed once. NOT the centroid — a vertex mean only
  // lands inside a convex ring, and letterforms are the opposite of convex: a 'V', 'W',
  // 'Y' or 'X' has its mean out in the open air between the arms, so the ring read as
  // outside everything and a counter could be missed or a letter claimed by a neighbour.
  // See interiorPoint in cam/geom.ts. Vertex mean only for degenerate rings with no
  // interior for a scan line to find.
  const reps: Pt2[] = sorted.map(sp => interiorPoint([sp]) ??
    [sp.reduce((s, p) => s + p[0], 0) / sp.length, sp.reduce((s, p) => s + p[1], 0) / sp.length])
  const usedAsHole = new Set<number>()
  const regions: { outerD: string; outerPts: Pt2[]; islandDs: string[] }[] = []

  for (let i = 0; i < sorted.length; i++) {
    if (usedAsHole.has(i)) continue
    const outer = sorted[i]
    if (regions.some(r => pointInPolygon(reps[i][0], reps[i][1], r.outerPts))) {
      usedAsHole.add(i); continue
    }

    const holes: string[] = []
    for (let j = i + 1; j < sorted.length; j++) {
      if (usedAsHole.has(j)) continue
      const cand = sorted[j]
      // Touching loops (shared vertex) are siblings, not holes.
      if (!sharesVertex(cand, outer) && pointInPolygon(reps[j][0], reps[j][1], outer)) {
        holes.push(ptsToD(cand))
        usedAsHole.add(j)
      }
    }
    regions.push({ outerD: ptsToD(outer), outerPts: outer, islandDs: holes })
  }
  return regions.map(({ outerD, islandDs }) => ({ outerD, islandDs }))
}

// Grow a text socket outward by clearanceMM — the female's share of the fit gap.
//
// Clearance lives on the socket and only on the socket, exactly as it does for the
// ordinary (non-text) inlay in computeInlayFemaleOffsets: the plug stays nominal, holes
// grow, and the gap is never doubled across the joint. glueLineMM deliberately does NOT
// appear here — a V-carved socket already runs deeper than the plug can reach, because
// its depth is set by the stroke width it has to open out to, so there is nowhere for a
// glue allowance to be added that the plug would ever touch.
//
// This is a REGION dilation, not a per-ring offset. A counter is a hole in the letter,
// so growing the socket means the outer ring moves out by c while the counter moves IN
// by c. Offsetting every ring outward (offsetEachRing, which forces each ring CCW) would
// grow the counters too and eat away the very protrusion the male's counter has to land
// on. Returns null for c <= 0 — the caller then machines the nominal letters.
function growTextSocket(
  regions: { outerD: string; islandDs: string[] }[], clearanceMM: number,
): string | null {
  if (!(clearanceMM > 0)) return null
  const parts: string[] = []
  for (const r of regions) {
    parts.push(offsetPathD(r.outerD, clearanceMM) ?? r.outerD)
    // A counter narrower than 2c has nothing left after shrinking and the offset comes
    // back empty. Machining it nominal leaves the protrusion a touch tight rather than
    // dropping the counter altogether, which would carve straight through it.
    for (const iD of r.islandDs) parts.push(offsetPathD(iD, -clearanceMM) ?? iD)
  }
  return parts.length ? parts.join(' ') : null
}

// Centre X of a path's bounding box — the axis the male board is turned over about.
function centerX(d: string): number | null {
  const subs = flattenPath(d, 0.05).filter(s => s.length >= 3)
  if (!subs.length) return null
  let minX = Infinity, maxX = -Infinity
  for (const sub of subs) for (const [x] of sub) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
  }
  return (minX + maxX) / 2
}

// How many regions a path must split into before the V-bit inlay treats it as TEXT (a plain
// V-carve socket + raised-prism plug) rather than as ordinary boundaries with holes.
//
// It used to be "more than none", i.e. any path with two subpaths. But an SVG import is
// normally exactly that: one compound path whose first ring is the outline and whose others
// are its holes — a bat outline with four wing cut-outs is ONE region, not five letters.
// Those went down the text route, whose female is a V-carve with no pocket at all, so the
// roughing operation came out completely empty (bat_wings_outline: vbit 2610 segs, endmill
// 0). generatePocket has always classified compound input into outer + holes; the inlay
// now does the same, and only a path that really does split into several separate shapes
// still reads as text.
const MULTI_REGION_IS_TEXT = 1

// The boundary/island pairs an inlay operation should machine, one per region, with each
// region's own holes folded into its island list. `extraIslandDs` (the paths the user
// selected as islands) go to every region — they were chosen against the whole selection,
// and a region that doesn't contain one is unaffected by it.
function boundariesOf(
  d: string,
  regions: { outerD: string; islandDs: string[] }[],
  extraIslandDs: string[],
): { boundaryD: string; islandDs: string[]; extraFrom: number }[] {
  if (regions.length === 0) return [{ boundaryD: d, islandDs: extraIslandDs, extraFrom: 0 }]
  return regions.map(r => ({
    boundaryD: r.outerD,
    islandDs: [...r.islandDs, ...extraIslandDs],
    // Index in islandDs where extraIslandDs starts — the male needs it to keep
    // islandPlugDs aligned, since a region's own holes have no nested plugs.
    extraFrom: r.islandDs.length,
  }))
}

// The outer rings of a path, as separate d strings — one per region for a compound path
// (text, an SVG import), the path itself otherwise. Used where another operation's plug
// has to be kept out of this one's pocket: its holes are that operation's business, so
// only what it leaves standing matters here.
function outerRingDs(d: string): string[] {
  const regions = splitRegions(d)
  return regions.length ? regions.map(r => r.outerD) : [d]
}

// Mirror a path string around the vertical axis x = cx.
// Flattens to polylines so curves become linear approximations — fine for CAM.
//
// The axis is a parameter, never each path's own centre: turning the board over is ONE
// rigid motion for the whole part. Mirroring an island about its own centre leaves it
// where it was while the boundary around it moves, so every island landed in the wrong
// place on any design that isn't symmetric about each island.
function mirrorPathDAbout(d: string, cx: number): string {
  const subs = flattenPath(d, 0.05).filter(s => s.length >= 3)
  if (!subs.length) return d
  // Mirror X around cx; reverse each subpath to restore CCW winding (mirror flips chirality)
  return subs.map(sub =>
    ptsToD([...sub].reverse().map(([x, y]) => [2 * cx - x, y] as Pt2))
  ).join(' ')
}

function mirrorPathD(d: string): string {
  const cx = centerX(d)
  return cx === null ? d : mirrorPathDAbout(d, cx)
}


// Trace a closed contour at successive Z depths without retracting between passes.
// The tool rapids to the start once, feed-plunges straight down to each depth in
// place (it always ends a pass back at the start point of a closed loop), and only
// lifts to safe Z after the final pass. This roughly halves rapid/air time versus a
// per-pass retract, and leaves a single plunge column on the visible seam instead of
// re-marking the same spot once per depth. Direction is kept constant across passes
// so the finish wall is cut consistently (climb/conventional) rather than alternating.
// Step-down Z levels from the surface to -depth, ending on the full-depth pass.
function zStepsTo(depthMM: number, stepDownMM: number): number[] {
  const depth = Math.abs(depthMM), step = Math.abs(stepDownMM)
  const out: number[] = []
  let z = -step
  while (z > -depth) { out.push(z); z -= step }
  out.push(-depth)
  return out
}

// When `rampLenMM` is given, each pass enters by ramping down along the contour over
// ~rampLenMM of travel (feed-reduced) instead of plunging straight in, then cuts the
// full perimeter at depth and re-cuts the ramped zone to clean the floor. This mirrors
// the ramp-in entry that generateProfile/generatePocket use. `undefined` → plunge in place.
function addContourStack(pts: Pt2[], zPasses: number[], segs: MotionSegment[], safeZ = 5, rampLenMM?: number) {
  if (pts.length < 2 || zPasses.length === 0) return
  // Normalize: drop a duplicate closing vertex so the loop is a clean vertex ring.
  let loop = pts
  if (loop.length > 2 && Math.hypot(loop[loop.length-1][0]-loop[0][0], loop[loop.length-1][1]-loop[0][1]) < 1e-6)
    loop = loop.slice(0, -1)
  const [sx, sy] = loop[0]
  const n = loop.length

  if (rampLenMM === undefined || rampLenMM <= 0 || n < 3) {
    segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
    for (const z of zPasses) {
      segs.push({ x: sx, y: sy, z, rapid: false })   // feed-plunge in place
      for (let i = 1; i < loop.length; i++) segs.push({ x: loop[i][0], y: loop[i][1], z, rapid: false })
      segs.push({ x: sx, y: sy, z, rapid: false })   // close loop back to start
    }
    segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
    return
  }

  // Cumulative arc length at each vertex (cum[0] = 0); total perimeter includes the
  // closing segment back to loop[0].
  const cum = [0]
  let total = 0
  for (let i = 1; i < n; i++) { total += Math.hypot(loop[i][0]-loop[i-1][0], loop[i][1]-loop[i-1][1]); cum.push(total) }
  total += Math.hypot(loop[0][0]-loop[n-1][0], loop[0][1]-loop[n-1][1])
  if (total < 1e-6) { segs.push({ x: sx, y: sy, z: safeZ, rapid: true }); return }
  const rampLen = Math.min(rampLenMM, total * 0.45)

  // Vertices spanned by the ramp: 1..rampLast (rampLast = first vertex at/after rampLen).
  let rampLast = 1
  for (let i = 1; i < n; i++) { rampLast = i; if (cum[i] >= rampLen) break }

  segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
  segs.push({ x: sx, y: sy, z: 0, rapid: true })   // rapid to surface at the start point
  let prevZ = 0
  for (const z of zPasses) {
    // Ramp: loop[0] (already here at prevZ) → loop[rampLast], descending prevZ → z.
    for (let i = 1; i <= rampLast; i++) {
      const f = Math.min(cum[i] / rampLen, 1)
      segs.push({ x: loop[i][0], y: loop[i][1], z: prevZ + (z - prevZ) * f, rapid: false, feedScale: 0.5 })
    }
    // Cut the rest of the perimeter at depth: loop[rampLast] → … → loop[0].
    for (let i = rampLast + 1; i < n; i++) segs.push({ x: loop[i][0], y: loop[i][1], z, rapid: false })
    segs.push({ x: sx, y: sy, z, rapid: false })
    // Re-cut the ramped zone at full depth, ending back at loop[0] for the next pass.
    for (let i = 1; i <= rampLast; i++) segs.push({ x: loop[i][0], y: loop[i][1], z, rapid: false })
    for (let i = rampLast - 1; i >= 1; i--) segs.push({ x: loop[i][0], y: loop[i][1], z, rapid: false })
    segs.push({ x: sx, y: sy, z, rapid: false })
    prevZ = z
  }
  segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
}

function getOuters(d: string): Pt2[][] {
  const subs = flattenPath(d, 0.05).filter(s => s.length >= 3)
  const outers = subs.filter(s => signedArea(s) >= 0)
  return outers.length > 0 ? outers : subs
}

// ─── Female socket ────────────────────────────────────────────────────────────

// The wall tool's geometry in the ONE form this file needs it. Everything here used to
// be written out as `depth × tanHalf`, which is the half-width of a CONE at that depth —
// true for a V-bit and wrong for a taper, whose tip is a ball. `halfWidthAt` is the
// tool's actual cutting radius at a depth, and reduces to `depth × tanHalf` exactly when
// the tip radius is zero.
//
// The ANGLE comes from the operation (`params.angleDeg`) because the male and female
// halves of an inlay must agree on one; the TIP is a property of the grind and so always
// comes from the tool.
interface WallGeom {
  tanHalf: number
  tipR: number
  halfWidthAt: (depthMM: number) => number
  /** Depth at which the tool is buried to its widest cutting diameter — below it the
   *  wall would be cut by the shank, not the flute. */
  maxDepthMM: number
}

function wallGeom(tool: Tool, angleDeg: number): WallGeom {
  const tanHalf = Math.tan((angleDeg / 2) * (Math.PI / 180))
  if (tanHalf < 1e-6) throw new Error('Invalid V-bit angle')
  const tipR = tipBallRadiusMM(tool)
  return {
    tanHalf, tipR,
    halfWidthAt: (depthMM) => vRadiusAtHeightMM(depthMM, tanHalf, tipR),
    // A taper's usable length is stated outright (its Max Z); a V-bit's follows from
    // where its cone reaches full diameter.
    maxDepthMM: tool.type === 'taper'
      ? (tool.maxDepthMM > 0 ? tool.maxDepthMM : vProfileHeightMM(tipR, tanHalf, tipR))
      : (tool.diameterMM / 2) / tanHalf,
  }
}

// Compute the socket boundary + two inward offset paths for the female operation.
// Exported so the UI can add them to the canvas as debug paths.
//
// Clearance is applied here and only here: the socket is offset OUTWARD by clearanceMM
// (offset-then-inset), so the fit gap lives entirely on the socket side — holes grow,
// plugs stay nominal, and the gap is never doubled across a joint.
function computeInlayFemaleOffsets(
  d: string,
  params: Pick<InlayParams, 'angleDeg' | 'pocketDepthMM' | 'glueLineMM' | 'clearanceMM'>,
  tipR = 0,
): { socketD: string | null; pocketBoundaryD: string | null; vcarveIslandD: string | null } {
  const halfAngle = (params.angleDeg / 2) * (Math.PI / 180)
  const tanHalf = Math.tan(halfAngle)
  if (tanHalf < 1e-6) return { socketD: null, pocketBoundaryD: null, vcarveIslandD: null }
  // Offsets use the total socket depth so the V-carved walls reach the pocket floor
  // (glue gap included). fullWidth = 2 × halfWidth.
  const halfWidthMM = vRadiusAtHeightMM(params.pocketDepthMM + params.glueLineMM, tanHalf, tipR)
  const c = params.clearanceMM
  // Per-ring offsets (offsetEachRing) so a self-intersecting boundary keeps each lobe
  // separate on the outward socket offset — offsetPath would merge them and carve only
  // one side. The pocket-floor / V-carve-island insets are net-inward for normal
  // clearances and behave the same either way, but stay per-ring for consistency.
  const socketD = c !== 0 ? offsetEachRing(d, c) : d
  if (!socketD) return { socketD: null, pocketBoundaryD: null, vcarveIslandD: null }
  return {
    socketD,
    pocketBoundaryD: offsetEachRing(d, c - halfWidthMM),
    vcarveIslandD:   offsetEachRing(d, c - halfWidthMM * 3),  // inset by fullWidth × 1.5
  }
}

// ── Inlay primitives ──────────────────────────────────────────────────────────
//
// Every V-bit inlay reduces to two dual operations:
//
//   insideClear(boundary, protrusions) — a SOCKET. Pockets the interior (auto strategy) and
//     V-carves the walls sloping inward, leaving any protrusions standing proud.
//     Clearance lives here (see computeInlayFemaleOffsets): the socket grows outward
//     by clearanceMM so the mating plug fits.
//
//   outerCut(boundary) — a PLUG. V-carves the outline (tip on path) at each stepdown
//     and frees it from stock with an outward end-mill release profile. No clearance.
//
//   female(shape) = insideClear(outer, islands)
//   male(shape)   = outerCut(outer) + insideClear(eachIsland, [])
//
// i.e. the male part is the female part with the solid side flipped on every boundary.

// SOCKET. `roughTool` clears the flat bottom; `wallTool` forms the walls — a V-bit
// (medial-axis V-carve) or an end mill (corner-round + step-down finish contours).
// Result slots: vbitSegs = wall/finish-tool passes, endmillSegs = roughing passes.
//
// `plugDs` are regions left standing whose walls this call must NOT form: in the male
// part, a hole cut into the plug can have further plugs standing inside it (one nesting
// level further in), and each of those gets its own outerCut. They are kept out of the
// roughing pocket exactly like protrusions, but get no wall pass — a protrusion's wall
// slopes the opposite way to a plug's, so forming one here would cut the other away.
async function insideClear(
  boundaryD: string, boundaryProtrusionDs: string[],
  roughTool: Tool, wallTool: Tool | null, params: InlayParams,
  plugDs: string[] = [],
): Promise<InlaySplitResult> {
  const totalDepthMM = params.pocketDepthMM + params.glueLineMM

  // ── Clearance comes off the SOCKET, at its islands as much as at its outer wall ──
  //
  // computeInlayFemaleOffsets grows the outer boundary by clearanceMM. A protrusion is the
  // same joint seen from the other side — female material standing where the male has a
  // hole — so it shrinks by the same amount, and the socket gets bigger in both directions.
  //
  // The alternative, and what this used to do, was to leave protrusions nominal and grow
  // the MALE's hole instead (generateInlayMale passed clearance down to its island
  // inside-clears). Both give a gap of c, but that one takes it out of the plug: an 'O',
  // any closed letter, any ring is thinnest exactly at the counter, and the hole eats into
  // it from the inside. Plugs are the thin, fragile, VISIBLE half of an inlay and they stay
  // nominal — which also means the male part no longer depends on clearanceMM at all, so
  // one plug fits whatever fit-gap the socket was cut with, and the design line is rendered
  // at nominal size everywhere instead of nominal outside and oversize in the counters.
  //
  // Shrinking here covers every branch below, including the two that hand the pocket a
  // finishAllowanceMM of −c and pre-grow their islands by c to cancel it: pre-growing an
  // already-shrunk protrusion returns it to nominal, and the allowance then takes it to
  // −c, which is the size wanted. `plugDs` are NOT touched — those are the next nesting
  // level's plugs standing inside a male hole, and they are plug material too.
  const clearanceMM = params.clearanceMM
  const protrusionDs = clearanceMM > 0
    ? boundaryProtrusionDs.map((iD) => offsetPathD(iD, -clearanceMM) ?? iD)
    : boundaryProtrusionDs

  // Every socket pocket below runs plain 'raster', NOT the 'hybrid' strategy the Pocket
  // form calls "auto".
  //
  // An inlay is the one pocket where coverage beats cycle time by a wide margin: leftover
  // stock in the socket floor is not a cosmetic ridge, it is material the plug lands on,
  // and the joint then will not close at all. Hybrid splits the region into sub-areas,
  // rasters each at its own best angle and contours rings around the protrusions; measured
  // against the mating plug (sim/inlayFit.ts), the seams between those sub-areas kept
  // full-height wedges of stock a few tool-widths out from each island — invisible on the
  // canvas, and enough to hold the plug 2 mm proud:
  //
  //     circle island   8.58 mm² → 0.00      5-point star  2.04 → 0.02
  //     bat artwork    21.38 mm² → 0.36      (interference, hybrid → raster)
  //
  // Raster's scanlines run the whole region at one angle with no seams to leave. `angle: 0`
  // is a real pinned angle here, not a fallback. (Rest cleanup and the wall/island
  // finishing contours are the shared tail in pocket.ts and apply either way.)
  const strategy = 'raster' as const

  // ── No finish tool: pocket only (roughing socket, no wall-finish pass). ──
  // The pocket already emits a finishing contour ring at each Z (see pocket.ts),
  // so for a plain flat-walled socket the rough bit alone produces the final socket.
  // Corners are rounded to the ROUGHING tool (there's no finish tool to do it), matching
  // outerCut's no-finish male plug so the socket corners and plug corners agree.
  // Clearance still lives on the socket: finishAllowanceMM = −c grows the pocket outward
  // by c, and protrusions are pre-grown by c so the −c allowance nets them to nominal.
  if (wallTool === null) {
    const c = params.clearanceMM
    const roundedD = roundCornersForEndmill(boundaryD, roughTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    // Plugs need the same treatment as protrusions here: walls are vertical either way,
    // and both must be pre-grown by c to cancel the pocket's finishAllowanceMM = −c.
    const pocketIslandDs = [...protrusionDs, ...plugDs].map(iD => {
      const roundedIsland = roundCornersForEndmill(iD, roughTool.diameterMM + CORNER_ROUND_EXTRA_MM)
      return c !== 0 ? (offsetPathRound(roundedIsland, c) ?? roundedIsland) : roundedIsland
    })
    const endmillSegs: MotionSegment[] = []
    try {
      pushAll(endmillSegs, generatePocket(roundedD, roughTool, {
        strategy, depthMM: totalDepthMM, stepDownMM: params.stepDownMM,
        stepoverPercent: params.stepoverPercent, direction: 'climb',
        islandDs: pocketIslandDs, angle: 0, safeHeightMM: params.safeHeightMM,
        finishAllowanceMM: -c, rampIn: params.rampIn,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }
    if (endmillSegs.length === 0)
      throw new Error('Inlay socket is too small for the selected tool')
    return { endmillSegs, vbitSegs: [] }
  }

  // ── V-cutter walls: raster pocket to the bevel-foot boundary + medial-axis V-carve. ──
  if (isVCutter(wallTool)) {
    const wg = wallGeom(wallTool, params.angleDeg)
    const halfWidthMM = wg.halfWidthAt(totalDepthMM)
    const fullWidthMM = halfWidthMM * 2

    const { socketD, pocketBoundaryD, vcarveIslandD } = computeInlayFemaleOffsets(boundaryD, params, wg.tipR)

    // Socket too small/thin for the tool geometry → plain medial-axis VCarve, no pocket.
    if (!socketD || !pocketBoundaryD || !vcarveIslandD) {
      const vbitSegs = await generateVCarve(socketD ?? boundaryD, wallTool, {
        angleDeg: params.angleDeg,
        maxDepthMM: wg.maxDepthMM,
        islandDs: protrusionDs,
        safeHeightMM: params.safeHeightMM,
      })
      if (!vbitSegs.length) throw new Error('Inlay socket is too small for the selected tools')
      return { vbitSegs, endmillSegs: [] }
    }

    const pocketSegs: MotionSegment[] = []
    const vcarveSegs: MotionSegment[] = []

    // A protrusion widens downward (its wall is V-carved from the top), so the pocket has
    // to stop halfWidth outside it. A plug is the other way round — it is widest at the
    // floor, exactly on its own path — so it is kept out at nominal size.
    const islandPocketDs = [
      ...protrusionDs.map(iD => offsetPathD(iD, halfWidthMM)),
      ...plugDs,
    ].filter((s): s is string => s !== null)
    try {
      pushAll(pocketSegs, generatePocket(pocketBoundaryD, roughTool, {
        strategy, depthMM: totalDepthMM, stepDownMM: params.stepDownMM,
        stepoverPercent: params.stepoverPercent, direction: 'climb',
        islandDs: islandPocketDs, angle: 0, safeHeightMM: params.safeHeightMM,
        rampIn: params.rampIn,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }

    // V-carve the outer wall: socketD down to the flat-bottom boundary (vcarveIslandD),
    // MINUS anything standing in that band. The band is 3 × halfWidth wide (8.7 mm for a
    // 60° bit at 5 mm), so a protrusion that comes closer to the socket wall than that
    // lies inside it — and a plain difference is the only way the medial axis learns it is
    // there. Without the subtraction the wall pass carved straight across the protrusion,
    // to 1.5 × the socket depth, wherever two features sat closer together than the band
    // (scratch/inlaytest.fkam: 175 mm² of protrusion tops shaved off).
    // Falls back to the unsubtracted band (socket edge → flat floor, protrusions ignored)
    // if the difference comes back empty — a wall that overruns a protrusion is wrong, but
    // no wall at all is worse, and this way the refinement can never cost segments.
    const wallRegionD = subtractD(socketD, [vcarveIslandD, ...protrusionDs, ...plugDs])
    try {
      pushAll(vcarveSegs, await generateVCarve(wallRegionD ?? socketD, wallTool, {
        angleDeg: params.angleDeg, maxDepthMM: 2.5 * totalDepthMM,
        islandDs: wallRegionD ? [] : [vcarveIslandD], safeHeightMM: params.safeHeightMM,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }

    // V-carve each protrusion's annular wall (nominal — clearance is on the socket only).
    // The annulus is fullWidth (2 × halfWidth) proud of the protrusion, which is easily
    // wider than the gap to whatever is next to it, so it is clipped to the socket and
    // differenced against everything else standing in it. Unclipped it carved a groove
    // outside the socket wall entirely, and shaved the tops off neighbouring protrusions.
    for (const iD of protrusionDs) {
      const islandVCarveOuterD = offsetPathD(iD, fullWidthMM)
      if (!islandVCarveOuterD) continue
      const clipped = intersectPathD(islandVCarveOuterD, socketD) ?? islandVCarveOuterD
      const bandD = subtractD(clipped, [iD, ...protrusionDs.filter(o => o !== iD), ...plugDs])
      try {
        // Same fallback as the socket wall: unclipped annulus rather than no wall.
        //
        // The cap is 2.5 × the socket depth, matching the socket wall above, NOT the socket
        // depth itself. A medial-axis V-carve reproduces the exact wall only if the tool
        // reaches every skeleton point at its own radius/tan(θ/2); cap it short and the cone
        // from a clipped point rises away at 1/tan and leaves a wedge of stock against the
        // wall. Along a straight run the annulus's inradius is halfWidth, so socket depth is
        // exactly enough — but at a protrusion CORNER of half-angle α the skeleton runs out
        // along the bisector to fullWidth/(1 + sin α), which tends to fullWidth as the corner
        // sharpens, i.e. up to TWICE the depth a straight wall needs. starinstar.fkam wanted
        // 4.58 mm against a 3 mm cap and left 1.4 mm of stock standing at all five points of
        // the inner star, one patch per point. Cutting deeper here cannot reach the
        // protrusion: a V-carve's cut rises to zero at its own region boundary.
        pushAll(vcarveSegs, await generateVCarve(bandD ?? islandVCarveOuterD, wallTool, {
          angleDeg: params.angleDeg, maxDepthMM: 2.5 * totalDepthMM,
          islandDs: bandD ? [] : [iD], safeHeightMM: params.safeHeightMM,
        }))
      } catch (e) { if (!isExpectedGeometryError(e)) throw e }
    }

    if (pocketSegs.length === 0 && vcarveSegs.length === 0)
      throw new Error('Inlay socket is too small for the selected tools')
    return { endmillSegs: pocketSegs, vbitSegs: vcarveSegs }
  }

  // ── End-mill walls: round corners, raster pocket, step-down finish contours. ──
  const safeZ = params.safeHeightMM ?? 5
  const finishR = wallTool.diameterMM / 2
  const c = params.clearanceMM
  const zPasses = zStepsTo(totalDepthMM, params.stepDownMM)

  // Round corners so the finish bit reaches convex corners.
  const roundedD = roundCornersForEndmill(boundaryD, wallTool.diameterMM + CORNER_ROUND_EXTRA_MM)
  // Socket wall = rounded outline grown outward by clearance (clearance lives on the
  // socket only). The pocket grows itself by clearance via finishAllowanceMM = −c (done
  // per-ring inside generatePocket, so self-intersecting boundaries stay intact rather
  // than merging). The finish contour is the wall offset inward by the tool radius:
  // offset(roundedD, c − finishR) — a net inward offset for normal clearances, so it
  // doesn't merge self-intersecting loops either.
  const finishContourD = offsetPathRound(roundedD, c - finishR)
  if (!finishContourD) throw new Error('Inlay socket is too small for the selected tools')

  // Protrusions: rounded; pre-grown by clearance so the pocket's −c allowance nets back
  // to nominal (clearance stays on the socket, not the protrusion). Finish-contoured
  // with the tool running finishR outside the nominal protrusion.
  const pocketIslandDs: string[] = []
  const protrusionFinishDs: string[] = []
  for (const iD of protrusionDs) {
    const roundedIsland = roundCornersForEndmill(iD, wallTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    pocketIslandDs.push(c !== 0 ? (offsetPathRound(roundedIsland, c) ?? roundedIsland) : roundedIsland)
    const contour = offsetPathRound(roundedIsland, finishR)
    if (contour) protrusionFinishDs.push(contour)
  }
  // Plugs: kept out of the pocket, no finish contour — their wall is their own op's.
  for (const pD of plugDs) {
    const roundedPlug = roundCornersForEndmill(pD, wallTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    pocketIslandDs.push(c !== 0 ? (offsetPathRound(roundedPlug, c) ?? roundedPlug) : roundedPlug)
  }

  const endmillSegs: MotionSegment[] = []
  try {
    pushAll(endmillSegs, generatePocket(roundedD, roughTool, {
      strategy, depthMM: totalDepthMM, stepDownMM: params.stepDownMM,
      stepoverPercent: params.stepoverPercent, direction: 'climb',
      islandDs: pocketIslandDs, angle: 0, safeHeightMM: params.safeHeightMM,
      finishAllowanceMM: -c, rampIn: params.rampIn,
    }))
  } catch (e) { if (!isExpectedGeometryError(e)) throw e }

  const wallRampLen = params.rampIn ? 2 * wallTool.diameterMM : undefined
  const vbitSegs: MotionSegment[] = []
  for (const pts of getOuters(finishContourD)) addContourStack(pts, zPasses, vbitSegs, safeZ, wallRampLen)
  for (const cD of protrusionFinishDs)
    for (const pts of getOuters(cD)) addContourStack(pts, zPasses, vbitSegs, safeZ, wallRampLen)

  if (endmillSegs.length === 0 && vbitSegs.length === 0)
    throw new Error('Inlay socket is too small for the selected tools')
  return { endmillSegs, vbitSegs }
}

// PLUG. Frees a raised feature, with no clearance (the plug stays nominal). For a V-bit
// the outline is traced (tip on path) and the surrounding stock freed by a roughing
// release profile; for an end mill a single outside finish profile forms the wall and
// frees the plug at once. vbitSegs = wall/finish-tool passes, endmillSegs = roughing.
function outerCut(boundaryD: string, roughTool: Tool, wallTool: Tool | null, params: InlayParams): InlaySplitResult {
  const safeZ = params.safeHeightMM ?? 5
  const zPasses = zStepsTo(params.pocketDepthMM, params.stepDownMM)

  // No finish tool: free the plug with a single flat-walled outside profile cut by the
  // roughing end mill itself (corners rounded to its radius). Segments go in endmillSegs.
  if (wallTool === null) {
    const r = roughTool.diameterMM / 2
    const roundedD = roundCornersForEndmill(boundaryD, roughTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    const outsideProfileD = offsetPathRound(roundedD, r)
    const endmillSegs: MotionSegment[] = []
    const rampLen = params.rampIn ? 2 * roughTool.diameterMM : undefined
    if (outsideProfileD)
      for (const outer of getOuters(outsideProfileD)) addContourStack(outer, zPasses, endmillSegs, safeZ, rampLen)
    return { vbitSegs: [], endmillSegs }
  }

  if (!isVCutter(wallTool)) {
    // End mill: round corners, then one outside profile (finishR outside the wall).
    const finishR = wallTool.diameterMM / 2
    const roundedD = roundCornersForEndmill(boundaryD, wallTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    const outsideProfileD = offsetPathRound(roundedD, finishR)
    const vbitSegs: MotionSegment[] = []
    const rampLen = params.rampIn ? 2 * wallTool.diameterMM : undefined
    if (outsideProfileD)
      for (const outer of getOuters(outsideProfileD)) addContourStack(outer, zPasses, vbitSegs, safeZ, rampLen)
    return { vbitSegs, endmillSegs: [] }
  }

  // V-cutter: trace the outline (tip on path) + roughing release profile to free the plug.
  // The tip is what rides the line — a V-bit's apex or a taper's ball touches it at a
  // point either way, so the plug is nominal at the mating plane for both.
  const vbitSegs: MotionSegment[] = []
  for (const pts of getOuters(boundaryD)) addContourStack(pts, zPasses, vbitSegs, safeZ)
  const endmillSegs: MotionSegment[] = []
  const releaseD = offsetPathD(boundaryD, roughTool.diameterMM / 2)
  const rampLen = params.rampIn ? 2 * roughTool.diameterMM : undefined
  if (releaseD) for (const outer of getOuters(releaseD)) addContourStack(outer, zPasses, endmillSegs, safeZ, rampLen)
  return { vbitSegs, endmillSegs }
}

/**
 * Female socket = insideClear(outline, islands): pocket the interior and form the walls
 * (V-bit V-carve or end-mill finish contour), leaving any islands standing as protrusions.
 * `endmill` is the roughing tool, `vbit` the wall tool (its .type selects the wall method).
 * `vbit === null` skips the wall pass entirely → a plain flat-walled roughing-only socket.
 */
/**
 * Both halves of an inlay bound a REGION — the socket is a pocket, the plug is the
 * solid that fills it — so an open path is meaningless to either. Checked once at each
 * entry point, before `splitRegions` closes everything implicitly, and covering the
 * islands too: an open island is a hole of the wrong shape in one half and a
 * protrusion of the wrong shape in the other, and the pair then cannot seat.
 */
function requireClosedInlay(d: string, params: InlayParams, half: 'socket' | 'plug'): void {
  const cut = `an inlay ${half}`
  const remedy = 'Close the path — an inlay needs a shape with an inside and an outside.'
  requireClosedSubpaths(flattenPath(d, 0.05), { cut, remedy })
  for (const iD of params.islandDs) {
    requireClosedSubpaths(flattenPath(iD, 0.05), { cut, noun: 'Island path', remedy })
  }
}

export async function generateInlayFemale(
  d: string,
  endmill: Tool,
  vbit: Tool | null,
  params: InlayParams
): Promise<InlaySplitResult> {
  requireClosedInlay(d, params, 'socket')
  const regions = splitRegions(d)

  // Text with a V-bit: plain VCarve over the whole path (the VCarve alone forms the
  // socket; no flat pocket). Depth at full engagement = r / tan(half). Paired with the
  // raised-prism male, so both halves must agree on when this fires — see the note on
  // MULTI_REGION_IS_TEXT.
  if (vbit && isVCutter(vbit) && regions.length > MULTI_REGION_IS_TEXT) {
    const wg = wallGeom(vbit, params.angleDeg)
    const vbitSegs = await generateVCarve(growTextSocket(regions, params.clearanceMM) ?? d, vbit, {
      angleDeg: params.angleDeg,
      maxDepthMM: wg.maxDepthMM,
      islandDs: params.islandDs,
      safeHeightMM: params.safeHeightMM,
    })
    if (!vbitSegs.length) throw new Error('Inlay socket is too small for the selected tools')
    return { vbitSegs, endmillSegs: [] }
  }

  // One socket per region: the outline, with its own holes plus any selected islands
  // standing as protrusions. A region too small for the tools is skipped rather than
  // failing the operation — the same treatment the male gives its islands — but if that
  // leaves nothing at all the caller still hears about it.
  const out: InlaySplitResult = { vbitSegs: [], endmillSegs: [] }
  const boundaries = boundariesOf(d, regions, params.islandDs)
  let lastErr: unknown = null
  for (const { boundaryD, islandDs } of boundaries) {
    try {
      const r = await insideClear(boundaryD, islandDs, endmill, vbit, params)
      pushAll(out.vbitSegs, r.vbitSegs)
      pushAll(out.endmillSegs, r.endmillSegs)
    } catch (e) {
      if (boundaries.length === 1 || !isExpectedGeometryError(e)) throw e
      lastErr = e
    }
  }
  if (out.vbitSegs.length === 0 && out.endmillSegs.length === 0)
    throw (lastErr ?? new Error('Inlay socket is too small for the selected tools'))
  return out
}

// ─── Male plug ────────────────────────────────────────────────────────────────

export interface InlaySplitResult {
  vbitSegs: MotionSegment[]
  endmillSegs: MotionSegment[]
}

/**
 * Male text-plug algorithm — Virtual Z-Plane Shift.
 *
 * Called for multi-subpath paths (text, multi-letter shapes) where each letter
 * subpath acts as a raised prism on the plug face.
 *
 * Core principle:
 *   The V-carve runs directly on each letter boundary (not inverted), with the bit
 *   apex on the MATING plane — plugDepth below the male board's face — so the wall it
 *   leaves is the exact cone complement of the female's V-carved wall.
 *
 *   Z = plugDepthMM   (constant, every letter, every point on its boundary)
 *
 * The end mill clears the recessed background (bbox minus letter outers) to
 * pocketDepthMM, pockets any letter counters (e.g. inside of 'O') to the same
 * depth, and profiles the bounding-box perimeter to free the plug from stock.
 * glueLineMM is not applied to the male plug — it only affects the female socket,
 * and neither is clearanceMM (the socket carries the whole fit gap).
 *
 * ── Why the depth is constant ────────────────────────────────────────────────────
 * Write both boards top-referenced, with s = distance INSIDE the letter and D = the
 * plug depth. The female is a V-carve, F = −min(s/tan(θ/2), Dmax). Tracing the male's
 * outline with the tip at −Z leaves M = min(0, −Z + s/tan(θ/2)) inside the letter and
 * −D outside it, once the background pocket has run. Turning the board over, the two
 * solids may not overlap: F + M + D ≤ 0. At Z = D that is an identity — 0 on every
 * wall and on the land outside the letters, negative (a harmless void) only where the
 * socket is deeper than the plug can reach. So the plug does fit a V-carve, exactly.
 *
 * Any other Z is a straight loss:
 *   Z > D  undercuts the plug by (Z−D)·tan(θ/2) per side and sinks a moat around each
 *          letter deeper than the background, so the boards cannot even meet at the
 *          face. A stroke narrower than 2(Z−D)·tan(θ/2) is cut away completely.
 *   Z < D  leaves the plug (D−Z) proud — it wedges, and you plane it flush. Recoverable,
 *          which is why the V-bit's reach clamp below errs in that direction.
 *
 * This used to run Z = modalMATradius/tan(θ/2), i.e. the female's own depth rule. On
 * scratch/abcdefg.fkam that put Z at 3.5–4.0 mm against a D of 2 mm: 38% of the
 * footprint cut up to 1.85 mm too deep, every 3.2 mm stroke reduced to 1.5 mm, and a
 * 1 mm-deep moat round every letter. It read as "no interference" in the fit audit
 * because an undersized plug never interferes — it just rattles.
 */
async function generateInlayMaleText(
  d: string,
  profileTool: Tool,
  vbitTool: Tool,
  params: InlayParams,
): Promise<InlaySplitResult> {
  const safeZ = params.safeHeightMM ?? 5
  const workingD = params.mirrorX ? mirrorPathD(d) : d

  const wg = wallGeom(vbitTool, params.angleDeg)

  // Z_max: depth when the bit is fully engaged at its widest cutting radius. Below it
  // the wall would be cut by the shank, not the flute, so the plug depth is clamped to
  // it — leaving the plug proud rather than undersized (see the note above).
  const vbitMaxDepthMM = wg.maxDepthMM
  const wallDepthMM = Math.min(params.pocketDepthMM, vbitMaxDepthMM)

  // Split into per-letter regions (outer ring + intrinsic counter-holes like 'O', 'A').
  const regions = splitRegions(workingD)
  if (regions.length === 0) throw new Error('Text path produced no letter regions')

  const letterOuterDs  = regions.map(r => r.outerD)
  const letterCounterDs = regions.flatMap(r => r.islandDs)

  // Compute bounding box of all letter outer rings.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const od of letterOuterDs) {
    for (const sub of flattenPath(od, 0.05)) {
      for (const [x, y] of sub) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (!isFinite(minX)) throw new Error('Cannot compute bounding box for text path')

  // Margin: wide enough for the bit at max engagement + end mill diameter clearance.
  const margin = Math.max(wg.halfWidthAt(vbitMaxDepthMM) * 2, profileTool.diameterMM, 2.0)
  minX -= margin; minY -= margin; maxX += margin; maxY += margin

  // Bounding box polygon (CCW in CNC Y-up).
  const bboxPts: Pt2[] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
  const bboxD = ptsToD(bboxPts)

  const vbitSegs: MotionSegment[] = []
  const endmillSegs: MotionSegment[] = []

  // ── V-bit pass ─────────────────────────────────────────────────────────────
  // Trace every letter boundary — the outer ring and each counter — with the tip on the
  // mating plane, forming the raised prism's bevelled wall. Counters get the same trace:
  // a counter is a hole in the plug that receives the female's standing protrusion, and
  // its wall slopes the same way for the same reason. Stepped down like every other
  // contour stack, since a 60° bit at full plug depth is 2.3 mm of engagement in one bite.
  const wallPasses = zStepsTo(wallDepthMM, params.stepDownMM)
  for (const r of regions) {
    for (const pts of getOuters(r.outerD)) addContourStack(pts, wallPasses, vbitSegs, safeZ)
    for (const iD of r.islandDs)
      for (const pts of getOuters(iD)) addContourStack(pts, wallPasses, vbitSegs, safeZ)
  }

  // ── V-bit letter relief ────────────────────────────────────────────────────
  // One plunge per patch inside a letter's bounding box the roughing cutter cannot reach — see
  // letterReliefPlunges for the depth law that keeps these off the plug wall, and for why
  // the search is confined to the letters' own bounding boxes.
  for (const p of letterReliefPlunges(
    letterOuterDs, letterCounterDs,
    profileTool.diameterMM / 2, wallDepthMM, wg, vbitMaxDepthMM,
  )) {
    vbitSegs.push({ x: p.x, y: p.y, z: safeZ, rapid: true })
    vbitSegs.push({ x: p.x, y: p.y, z: p.z, rapid: false })
    vbitSegs.push({ x: p.x, y: p.y, z: safeZ, rapid: true })
  }

  // ── End mill background pocket ──────────────────────────────────────────────
  // Clear the background (inside bboxD, outside letter outer rings) to inlay depth.
  // generatePocket automatically respects the tool radius when approaching islands.
  // 'raster' for the same reason as the socket in insideClear: this background is the
  // mating face of the plug, and a wedge of stock left at a strategy seam holds the whole
  // letter block off the female. One angle, no seams.
  try {
    pushAll(endmillSegs, generatePocket(bboxD, profileTool, {
      strategy:       'raster',
      depthMM:        params.pocketDepthMM,
      stepDownMM:     params.stepDownMM,
      stepoverPercent: params.stepoverPercent,
      direction:      'climb',
      islandDs:       letterOuterDs,
      angle:          0,
      safeHeightMM:   params.safeHeightMM,
      rampIn:         params.rampIn,
    }))
  } catch (e) { if (!isExpectedGeometryError(e)) throw e }

  // ── End mill counter pockets ────────────────────────────────────────────────
  // Letter counters (e.g. the void inside 'O') must be recessed to inlay depth
  // so they match the female socket's protruding counter islands. Island-free and small,
  // so a raster over the whole counter is both the simplest and the most complete answer.
  for (const counterD of letterCounterDs) {
    try {
      pushAll(endmillSegs, generatePocket(counterD, profileTool, {
        strategy:       'raster',
        depthMM:        params.pocketDepthMM,
        stepDownMM:     params.stepDownMM,
        stepoverPercent: params.stepoverPercent,
        direction:      'climb',
        islandDs:       [],
        angle:          0,
        safeHeightMM:   params.safeHeightMM,
        rampIn:         params.rampIn,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }
  }

  // ── Release profile ─────────────────────────────────────────────────────────
  // Profile the bounding box perimeter to inlay depth to free the plug from stock.
  //
  // Offset by HALF a radius, not a full one. At a full radius the cutter's edge only just
  // touches the bbox line, so it never reaches the four fillets the background pocket has
  // to leave standing in the blank's own corners — a round tool cannot get into a square
  // corner, and those lumps sit at full height on the mating face and hold the whole plug
  // off the female. Coming in half a radius sweeps everything within R/2 of each wall, and
  // a 90° corner fillet only reaches R(1−1/√2) ≈ 0.29 R from either wall, so it goes
  // completely. The blank simply ends up R/2 smaller all round, which costs nothing: this
  // rectangle is one this function invented to carry the letters, not part of the design.
  const releaseOffset = profileTool.diameterMM / 4
  const releaseD = offsetPathD(bboxD, releaseOffset)
  if (releaseD) {
    const depth = params.pocketDepthMM
    const step  = Math.abs(params.stepDownMM)
    const zPasses: number[] = []
    let zr = -step
    while (zr > -depth) { zPasses.push(zr); zr -= step }
    zPasses.push(-depth)
    const rampLen = params.rampIn ? 2 * profileTool.diameterMM : undefined
    for (const pts of getOuters(releaseD)) {
      addContourStack(pts, zPasses, endmillSegs, safeZ, rampLen)
    }
  }

  if (vbitSegs.length === 0 && endmillSegs.length === 0)
    throw new Error('Inlay text plug is too small for the selected tools')
  return { vbitSegs, endmillSegs }
}

/**
 * Male plug = outerCut(outer boundary) + insideClear(each island).
 *   - The border is a plug: V-carve the outline + end-mill release profile (outerCut).
 *   - Each island is a hole = a socket that receives the mating female protrusion, so
 *     it's an inside-clear (the same primitive the female socket uses).
 * This is the female operation with the solid side flipped on every boundary.
 *
 * Multi-subpath paths (text) use the Virtual Z-Plane Shift algorithm (generateInlayMaleText),
 * which treats letters as raised prisms cut from a bounding box.
 *
 * Returns segments split by tool so callers can create one operation per tool, enabling
 * all V-bit passes to run before any end mill passes (one tool change total).
 */
export async function generateInlayMale(
  d: string,
  profileTool: Tool,
  vbitTool: Tool | null,
  params: InlayParams
): Promise<InlaySplitResult> {
  requireClosedInlay(d, params, 'plug')
  // Text with a V-bit: Virtual Z-Plane Shift (raised-letter prisms). Gated the same way
  // as the female's V-carve socket — see MULTI_REGION_IS_TEXT.
  const regions = splitRegions(d)
  if (vbitTool && isVCutter(vbitTool) && regions.length > MULTI_REGION_IS_TEXT) {
    return generateInlayMaleText(d, profileTool, vbitTool, params)
  }

  // Turning the male board over is ONE rigid motion, so every path mirrors about the same
  // axis — the boundary's centre — not about its own.
  const mirrorAxis = params.mirrorX ? (params.mirrorAxisX ?? centerX(d)) : null
  const mirror = (s: string) => mirrorAxis === null ? s : mirrorPathDAbout(s, mirrorAxis)
  const vbitSegs: MotionSegment[] = []
  const endmillSegs: MotionSegment[] = []

  const halfWidthMM = vbitTool && isVCutter(vbitTool)
    ? wallGeom(vbitTool, params.angleDeg).halfWidthAt(params.pocketDepthMM)
    : 0

  // Each island is a hole in the plug that receives the mating female protrusion, so it's
  // an inside-clear. clearanceMM enlarges it so the protrusion fits (and its medial-axis
  // V-carve clears the tips a round end mill can't reach). glueLine belongs only to the
  // real female socket, not the male.
  //
  // The hole's boundary is the island grown by halfWidth, because the male's V-carve
  // reference plane is the MATING plane — halfWidth/tan = plugDepth below the male board's
  // face — not the face itself. insideClear puts its socket's top opening on the boundary
  // it is given and narrows it by halfWidth over the depth; pre-growing by halfWidth lands
  // the narrow end, at full depth, exactly on the island. That is the surface the female
  // protrusion's own wall mates with: the protrusion widens downward from the island line
  // at exactly the same rate the hole widens upward from it.
  //
  // Without the shift the hole was cut as if the island line lay on the male's FACE, so it
  // came out halfWidth too small at every depth and the plug jammed on the protrusion —
  // 4.65 mm of interference on a plain square-with-a-round-island at 5 mm deep.
  const islandPlugDs = params.islandPlugDs ?? []
  // Every ring this operation leaves standing as plug material, in the mirrored frame —
  // what the field clearance below has to machine around.
  const standingDs: string[] = []
  for (const { boundaryD, islandDs, extraFrom } of boundariesOf(d, regions, params.islandDs)) {
    standingDs.push(mirror(boundaryD))
    // Plug border: outer-cut (no clearance — the plug stays nominal).
    const border = outerCut(mirror(boundaryD), profileTool, vbitTool, params)
    pushAll(vbitSegs, border.vbitSegs)
    pushAll(endmillSegs, border.endmillSegs)

    for (let i = 0; i < islandDs.length; i++) {
      const islandD = mirror(islandDs[i])
      const holeD = halfWidthMM > 0 ? (offsetPathD(islandD, halfWidthMM) ?? islandD) : islandD
      // Paths nested inside this island are the next level's plugs; they stand in the hole
      // and their own male operation forms their walls. islandPlugDs is indexed against
      // params.islandDs, which starts at extraFrom here — a region's own holes are geometry,
      // not selected paths, so they never carry nested plugs.
      const plugDs = (i >= extraFrom ? islandPlugDs[i - extraFrom] ?? [] : []).map(mirror)
      try {
        // clearanceMM: 0 — the socket side carries the whole fit gap, and for this joint
        // that is the female's protrusion (shrunk in insideClear), not this hole. Growing
        // both would double the gap; growing this one alone would thin the plug that
        // surrounds it. glueLineMM: 0 for the same reason it always was — glue depth
        // belongs to the real socket floor, not to the male.
        const socket = await insideClear(holeD, [], profileTool, vbitTool,
          { ...params, glueLineMM: 0, clearanceMM: 0 }, plugDs)
        pushAll(vbitSegs, socket.vbitSegs)
        pushAll(endmillSegs, socket.endmillSegs)
      } catch (e) { if (!isExpectedGeometryError(e)) throw e }
    }
  }

  // ── Field clearance ─────────────────────────────────────────────────────────
  //
  // The plug stands inside another selected path (an inverted grouping — see fieldD).
  // Everything between the two is background and has to come down to the mating plane:
  // the female board is untouched face out there, so any stock left standing holds the
  // whole male board off it and the plug never reaches its socket. This is the same
  // construction the raised-prism text plug uses, with the user's own outline in place of
  // the bounding box it has to invent.
  //
  // Islands are the plugs at NOMINAL size. The V-carve traces each plug outline with the
  // tip on the mating plane, so plug material only ever lies inside that line (it narrows
  // going up, which is what makes it the socket's complement once the board is turned
  // over) — a vertical pocket that stops on the line cannot touch it, and the bevel above
  // the line is the V-bit's own work.
  if (params.fieldD) {
    const safeZ = params.safeHeightMM ?? 5
    const fieldD = mirror(params.fieldD)
    const plugDs = [
      ...standingDs,
      ...(params.fieldPlugDs ?? []).flatMap(outerRingDs).map(mirror),
    ]
    try {
      pushAll(endmillSegs, generatePocket(fieldD, profileTool, {
        // 'raster' for the reason insideClear rasters its socket: this background is the
        // male's mating land, and a wedge of stock left at a strategy seam holds the
        // whole plug off the female. One angle, no seams.
        strategy:        'raster',
        depthMM:         params.pocketDepthMM,
        stepDownMM:      params.stepDownMM,
        stepoverPercent: params.stepoverPercent,
        direction:       'climb',
        islandDs:        plugDs,
        angle:           0,
        safeHeightMM:    params.safeHeightMM,
        rampIn:          params.rampIn,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }

    // Release profile — frees the male piece the way outerCut's does for an un-nested
    // plug, since the field outline is this piece's own perimeter. Offset by HALF a
    // radius so it also sweeps the fillets the pocket has to leave in the field's own
    // corners: a round tool cannot get into a square corner, and those lumps sit at full
    // height on the mating land. A 90° fillet only reaches R(1−1/√2) ≈ 0.29 R from either
    // wall, so R/2 takes it completely; the piece simply ends up R/2 smaller all round,
    // which costs nothing out here — the land is background, not design.
    const releaseD = offsetPathD(fieldD, profileTool.diameterMM / 4)
    if (releaseD) {
      const rampLen = params.rampIn ? 2 * profileTool.diameterMM : undefined
      const zPasses = zStepsTo(params.pocketDepthMM, params.stepDownMM)
      for (const pts of getOuters(releaseD)) addContourStack(pts, zPasses, endmillSegs, safeZ, rampLen)
    }
  }

  if (vbitSegs.length === 0 && endmillSegs.length === 0)
    throw new Error('Inlay plug is too small for the selected tools')
  return { vbitSegs, endmillSegs }
}
