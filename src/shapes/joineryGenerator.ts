// ─── Woodworking joinery ──────────────────────────────────────────────────────
//
// Four generators, two kinds of joint.
//
// FINGER JOINTS (the box, and a single finger-joint pair) join two boards at RIGHT
// ANGLES. Each board is cut flat, so the joint is a pattern of notches along an edge,
// one notch per finger of the other board, as deep as that board is thick. The fit
// is 3D — a finger stands in a notch cut in a perpendicular board — so a router's
// round inside corners cannot be dealt with by rounding the finger to match: the
// finger's corner is the board's own face. Instead every inside corner of a notch
// gets a RELIEF (a dogbone along the corner's bisector, or a T-bone along its longer
// wall) so the square finger seats all the way down. Reliefs are found on the panel
// as built — every reflex corner of the outline — rather than per notch, so the
// corner squares a box takes out of its panels are relieved too, with nothing
// written for them.
//
// IN-PLANE JOINTS (edge dovetails and bowtie keys) join two pieces lying in the SAME
// plane, so the fit is 2D and the round corners can be designed in instead. The
// male piece is shaped first: its convex corners are rounded to (tool radius −
// clearance) and its concave ones to the tool radius. The female is the male GROWN
// by the clearance — so every concave corner the female has came from a convex
// corner of the male and has radius ≥ the tool's, which is what makes it cuttable,
// and the clearance is the same all round by construction.
//
// Everything is in CNC mm, Y-up; parts are emitted CCW (outlines) like every other
// generated shape.

import { boolRings, inflateRings, roundConcave, roundConvex, ellipseRing, ringToD, ccw, clamp, type Pt } from './polyOps'
import { signedArea } from '../cam/pathFlattener'

export type JointRelief = 'dogbone' | 'tbone' | 'none'

export const JOINT_RELIEF_LABELS: Record<JointRelief, string> = {
  dogbone: 'Dogbone', tbone: 'T-bone', none: 'None',
}

/** Room between two laid-out parts: a tool's width either side, plus a margin. */
const layoutGap = (toolDia: number) => 2 * Math.max(0, toolDia) + 6

// ─── Finger patterns ──────────────────────────────────────────────────────────

/**
 * How many fingers along an edge of length `L`: odd, so an edge's two ends match and
 * a box's corners can each belong to one panel, and as near `fingerW` wide as that
 * allows. At least 3, and never so many that a finger is narrower than the board is
 * thick plus the cutter — an end finger loses a thickness to the corner square.
 */
export function fingerCount(L: number, fingerW: number, thickness: number, toolDia: number): number {
  let n = Math.max(3, 2 * Math.round((L / Math.max(1, fingerW) - 1) / 2) + 1)
  const minW = Math.max(thickness, toolDia) + 0.5
  while (n > 3 && L / n < minW) n -= 2
  return n
}

/** What an edge of a panel does: keeps its END fingers (`tabs`), loses them to the
 *  mating board (`slots`), or is a plain edge. */
type EdgeKind = 'tabs' | 'slots' | 'plain'

interface EdgeSpec { kind: EdgeKind; n: number }

/**
 * A rectangular panel `a × b` (origin bottom-left) with finger notches along its
 * edges, then relieved. Every notch is `depth` deep (the mating board's thickness),
 * widened by half the `clearance` on each side it shares with a finger, and run 1 mm
 * past the panel at an edge's ends so the boolean leaves no sliver.
 */
function fingerPanel(
  a: number, b: number,
  edges: { bottom: EdgeSpec; right: EdgeSpec; top: EdgeSpec; left: EdgeSpec },
  depth: number, clearance: number, toolDia: number, relief: JointRelief,
): Pt[][] {
  const notches: Pt[][] = []
  // One edge's notches in edge-local coords (s along the edge, t into the panel),
  // mapped to the panel by `at`.
  const edgeNotches = (L: number, e: EdgeSpec, at: (s: number, t: number) => Pt) => {
    if (e.kind === 'plain') return
    const seg = L / e.n
    for (let i = 0; i < e.n; i++) {
      const slot = e.kind === 'tabs' ? i % 2 === 1 : i % 2 === 0
      if (!slot) continue
      // Half the clearance off each finger, on BOTH boards: a finger then comes out
      // `clearance` narrower than the notch it goes in, i.e. that much gap a side.
      const s0 = i === 0 ? -1 : i * seg - clearance / 2
      const s1 = i === e.n - 1 ? L + 1 : (i + 1) * seg + clearance / 2
      notches.push(ccw([at(s0, -1), at(s1, -1), at(s1, depth), at(s0, depth)]))
    }
  }
  edgeNotches(a, edges.bottom, (s, t) => [s, t])
  edgeNotches(a, edges.top, (s, t) => [s, b - t])
  edgeNotches(b, edges.left, (s, t) => [t, s])
  edgeNotches(b, edges.right, (s, t) => [a - t, s])
  const rect: Pt[] = [[0, 0], [a, 0], [a, b], [0, b]]
  const body = notches.length ? boolRings('difference', [rect], notches) : [rect]
  return relieveCorners(body, toolDia, relief)
}

/**
 * Cut a relief at every reflex (inside) corner of `rings`, so a square-cornered part
 * seats in a notch the router can only cut round. A DOGBONE is a tool-sized circle
 * centred on the corner's bisector a tool radius out, so it just reaches the corner
 * and bites equally into both walls. A T-BONE is centred a tool radius along the
 * LONGER wall instead, which bites only past the end of the shorter one — for a
 * finger notch, deeper into the board rather than into the face of the finger.
 */
export function relieveCorners(rings: Pt[][], toolDia: number, relief: JointRelief): Pt[][] {
  if (relief === 'none' || toolDia <= 0) return rings
  const r = toolDia / 2 + 0.05   // a touch over the tool, so it is not asked to cut its own radius exactly
  const disks: Pt[][] = []
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const p = ring[(i + n - 1) % n], v = ring[i], q = ring[(i + 1) % n]
      const ux = v[0] - p[0], uy = v[1] - p[1], wx = q[0] - v[0], wy = q[1] - v[1]
      const lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy)
      if (lu < 1e-6 || lw < 1e-6) continue
      // CCW ring: a right turn is a reflex corner.
      const cross = (ux * wy - uy * wx) / (lu * lw)
      if (cross > -0.5) continue   // only corners that are really corners (≥ 30° of turn)
      const back: Pt = [-ux / lu, -uy / lu], fwd: Pt = [wx / lw, wy / lw]
      let dir: Pt
      if (relief === 'dogbone') {
        const bx = back[0] + fwd[0], by = back[1] + fwd[1], bl = Math.hypot(bx, by)
        if (bl < 1e-9) continue
        dir = [bx / bl, by / bl]
      } else {
        dir = lu >= lw ? back : fwd
      }
      disks.push(ellipseRing(v[0] + r * dir[0], v[1] + r * dir[1], r, r))
    }
  }
  return disks.length ? boolRings('difference', rings, disks) : rings
}

/** A plain `a × b` rectangle — what a part falls back to when its joint cannot be cut,
 *  so a shape keeps the same parts while a number is typed through a bad value. */
const plainRect = (a: number, b: number): Pt[][] => [[[0, 0], [Math.max(0.1, a), 0], [Math.max(0.1, a), Math.max(0.1, b)], [0, Math.max(0.1, b)]]]

const placeRings = (rings: Pt[][], dx: number, dy: number): Pt[][] =>
  rings.map((r) => r.map(([x, y]) => [x + dx, y + dy] as Pt))

const ringsToD = (rings: Pt[][]) => rings.map((r) => ringToD(r, true)).join(' ')

function bbox(rings: Pt[][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rings) for (const [x, y] of r) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  return { x0, y0, x1, y1 }
}

/**
 * How a two-board joint is cut. `board`: each whole board, outline and joint, profiled
 * out of a sheet. `joint`: only the WASTE at the joint, as one closed region per board,
 * cut right through with an INSIDE profile — for jointing the end of a board you already
 * have, which an outside profile cannot do without cutting its other three sides too. The
 * waste of one board is every notch (reliefs and all) joined up by a strip of air past
 * the board's end, a bit's width and more, so the profile is ONE loop: round the fingers,
 * through the reliefs, and back along the strip in air. The waste inside drops out — far
 * less cutting than pocketing it. (A pocket of the same region also works.)
 */
export type JointCut = 'joint' | 'board'

export const JOINT_CUT_LABELS: Record<JointCut, string> = { joint: 'Joint only', board: 'Whole boards' }

/** The waste of `board` within `band` — what cutting the band out takes from it. */
const wasteOf = (board: Pt[][], band: Pt[]): Pt[][] => boolRings('difference', [band], board)

/** How far past the board a joint's waste reaches: room for the bit to travel in air. */
const airMargin = (toolDia: number) => 1.5 * Math.max(0, toolDia) + 1

/** A generated part — one path each, since each is profiled (or pocketed) on its own. */
export interface JointPart { key: string; d: string }

/** Lay `parts` out in rows (each row's parts side by side, rows stacked downward),
 *  `gap` apart, and centre the whole on (cx, cy). */
function layoutRows(rows: { key: string; rings: Pt[][] }[][], gap: number, cx: number, cy: number): JointPart[] {
  const placed: { key: string; rings: Pt[][] }[] = []
  let y = 0
  for (const row of rows) {
    let x = 0, rowH = 0
    for (const part of row) {
      const b = bbox(part.rings)
      placed.push({ key: part.key, rings: placeRings(part.rings, x - b.x0, y - b.y1) })
      x += b.x1 - b.x0 + gap
      rowH = Math.max(rowH, b.y1 - b.y0)
    }
    y -= rowH + gap
  }
  const all = bbox(placed.flatMap((p) => p.rings))
  const dx = cx - (all.x0 + all.x1) / 2, dy = cy - (all.y0 + all.y1) / 2
  return placed.map((p) => ({ key: p.key, d: ringsToD(placeRings(p.rings, dx, dy)) }))
}

// ─── Box ─────────────────────────────────────────────────────────────────────

export interface BoxSpec {
  cx: number; cy: number
  /** Width (X), depth (Y) and height (Z) — inside or outside, per `inside`. */
  w: number; d: number; h: number
  inside: boolean
  thickness: number
  fingerW: number
  clearance: number
  toolDia: number
  relief: JointRelief
  /** A sixth panel — a lid fingered on like the bottom. Off: an open box. */
  lid: boolean
}

export interface BoxDims {
  outer: { w: number; d: number; h: number }
  inner: { w: number; d: number; h: number }
  /** Fingers along the width, depth and height edges, and how wide each comes out. */
  nW: number; nD: number; nH: number
  fW: number; fD: number; fH: number
  /** A dimension leaves no inside — too small for two walls. */
  tooSmall: boolean
  /** The cutter is wider than a notch, so it cannot cut one. */
  toolTooBig: boolean
}

export function boxDims(s: BoxSpec): BoxDims {
  const T = Math.max(0.1, s.thickness)
  const add = s.inside ? 2 * T : 0
  const outer = { w: s.w + add, d: s.d + add, h: s.h + (s.inside ? (s.lid ? 2 : 1) * T : 0) }
  const inner = { w: outer.w - 2 * T, d: outer.d - 2 * T, h: outer.h - (s.lid ? 2 : 1) * T }
  const nW = fingerCount(outer.w, s.fingerW, T, s.toolDia)
  const nD = fingerCount(outer.d, s.fingerW, T, s.toolDia)
  const nH = fingerCount(outer.h, s.fingerW, T, s.toolDia)
  const fW = outer.w / nW, fD = outer.d / nD, fH = outer.h / nH
  return {
    outer, inner, nW, nD, nH, fW, fD, fH,
    tooSmall: inner.w <= 0 || inner.d <= 0 || inner.h <= 0,
    toolTooBig: s.toolDia > Math.min(fW, fD, fH) - 0.1,
  }
}

export const BOX_PART_LABELS: Record<string, string> = {
  bottom: 'Bottom', top: 'Lid', front: 'Front', back: 'Back', left: 'Left Side', right: 'Right Side',
}

/**
 * The panels of a finger-jointed box, laid out flat. Every panel is its OUTSIDE
 * rectangle with notches taken out of its edges; front and back keep the end fingers
 * on all four of their edges, so each of the box's eight corner cubes belongs to the
 * front or the back and to nothing else. Sides keep their end fingers against the
 * bottom and lid; the bottom and lid lose theirs all round.
 */
export function generateBoxParts(s: BoxSpec): JointPart[] {
  const m = boxDims(s)
  const { w: W, d: D, h: H } = m.outer
  const T = Math.max(0.1, s.thickness)
  const lidEdge = (n: number): EdgeSpec => ({ kind: s.lid ? 'tabs' : 'plain', n })
  // Too small for two walls: the panels are drawn plain, and the panel says why.
  const panel = (a: number, b: number, edges: Parameters<typeof fingerPanel>[2]) => m.tooSmall
    ? plainRect(a, b)
    : fingerPanel(a, b, edges, T, s.clearance, s.toolDia, s.relief)
  // Front/back: W × H, bottom edge on the bottom panel, sides on the side panels.
  const front = panel(W, H, { bottom: { kind: 'tabs', n: m.nW }, top: lidEdge(m.nW), left: { kind: 'tabs', n: m.nH }, right: { kind: 'tabs', n: m.nH } })
  // Sides: D × H, giving their ends to front and back.
  const side = panel(D, H, { bottom: { kind: 'tabs', n: m.nD }, top: lidEdge(m.nD), left: { kind: 'slots', n: m.nH }, right: { kind: 'slots', n: m.nH } })
  // Bottom (and lid): W × D, giving its ends to everything.
  const base = panel(W, D, { bottom: { kind: 'slots', n: m.nW }, top: { kind: 'slots', n: m.nW }, left: { kind: 'slots', n: m.nD }, right: { kind: 'slots', n: m.nD } })
  const rows = [
    [{ key: 'bottom', rings: base }, ...(s.lid ? [{ key: 'top', rings: base }] : [])],
    [{ key: 'front', rings: front }, { key: 'back', rings: front }],
    [{ key: 'left', rings: side }, { key: 'right', rings: side }],
  ]
  return layoutRows(rows, layoutGap(s.toolDia), s.cx, s.cy)
}

// ─── Finger joint pair ───────────────────────────────────────────────────────

export interface FingerJointSpec {
  cx: number; cy: number
  /** The joint's length — the boards' width, across the joint. */
  width: number
  /** How long each board is, from the joint end. */
  lengthA: number; lengthB: number
  thickness: number
  fingerW: number
  clearance: number
  toolDia: number
  relief: JointRelief
  /** Absent = `joint`. */
  cut?: JointCut
}

export interface FingerJointDims {
  n: number
  /** The width each finger comes out at. */
  finger: number
  toolTooBig: boolean
  tooShort: boolean
}

export function fingerJointDims(s: FingerJointSpec): FingerJointDims {
  const T = Math.max(0.1, s.thickness)
  const n = fingerCount(s.width, s.fingerW, T, s.toolDia)
  return {
    n, finger: s.width / n,
    toolTooBig: s.toolDia > s.width / n - 0.1,
    tooShort: s.lengthA <= T || s.lengthB <= T,
  }
}

export const FINGER_PART_LABELS: Record<string, string> = {
  boardA: 'Board A', boardB: 'Board B', jointA: 'Board A Joint', jointB: 'Board B Joint',
}

/**
 * Two boards meeting at a corner: A keeps the end fingers along its joint end, B the
 * fingers between them. Both lie with the joint at the top; they are the same notch
 * pattern as a box's edge, so the box and the pair cannot drift apart.
 */
export function generateFingerJointParts(s: FingerJointSpec): JointPart[] {
  const m = fingerJointDims(s)
  const T = Math.max(0.1, s.thickness)
  const plain = { kind: 'plain' as const, n: 1 }
  const board = (len: number, kind: EdgeKind) => m.tooShort || s.width <= 0
    ? plainRect(s.width, len)
    : fingerPanel(s.width, len, { bottom: plain, right: plain, left: plain, top: { kind, n: m.n } }, T, s.clearance, s.toolDia, s.relief)
  const A = board(s.lengthA, 'tabs'), B = board(s.lengthB, 'slots')
  if ((s.cut ?? 'joint') === 'board') {
    return layoutRows([[{ key: 'boardA', rings: A }, { key: 'boardB', rings: B }]], layoutGap(s.toolDia), s.cx, s.cy)
  }
  // The joint's band on each board: from below the deepest relief to past its end, and
  // past both sides — the notches at the ends open onto the board's edges.
  const mg = airMargin(s.toolDia), below = T + s.toolDia + 2
  const band = (len: number): Pt[] => [[-mg, len - below], [s.width + mg, len - below], [s.width + mg, len + mg], [-mg, len + mg]]
  return layoutRows([[{ key: 'jointA', rings: wasteOf(A, band(s.lengthA)) }, { key: 'jointB', rings: wasteOf(B, band(s.lengthB)) }]],
    layoutGap(s.toolDia), s.cx, s.cy)
}

// ─── Edge dovetails ──────────────────────────────────────────────────────────

export interface DovetailSpec {
  cx: number; cy: number
  /** The seam's length. */
  length: number
  /** How far each panel reaches back from the seam. */
  depthA: number; depthB: number
  tails: number
  /** A tail's width at its WIDE end, and how far it reaches into the other panel. */
  tailW: number; tailDepth: number
  /** The flare of each side of a tail off square, degrees. */
  angleDeg: number
  clearance: number
  toolDia: number
  /** Absent = `joint`. */
  cut?: JointCut
}

export interface DovetailDims {
  /** A tail's width where it leaves its own panel — the neck that takes the load. */
  neck: number
  /** Neighbouring tails meet or overlap at their wide ends. */
  crowded: boolean
  /** The neck is narrower than the cutter can leave between two sockets' rounded
   *  corners — or gone entirely. */
  neckTooThin: boolean
  /** The tool cannot get into the gap between two tails' wide ends. */
  toolTooBig: boolean
}

export function dovetailDims(s: DovetailSpec): DovetailDims {
  const n = Math.max(1, Math.round(s.tails))
  const flare = Math.tan(clamp(s.angleDeg, 0, 45) * Math.PI / 180)
  const neck = s.tailW - 2 * s.tailDepth * flare
  const pitch = s.length / n
  return {
    neck,
    crowded: s.tailW >= pitch,
    neckTooThin: neck < Math.max(1, s.toolDia),
    toolTooBig: pitch - s.tailW < s.toolDia + 2 * s.clearance,
  }
}

export const DOVETAIL_PART_LABELS: Record<string, string> = {
  panelA: 'Tails', panelB: 'Sockets', jointA: 'Tails Joint', jointB: 'Sockets Joint',
}

/**
 * Two panels joined along a straight seam by dovetail tails cut IN the plane of the
 * sheet — a sign or a top bigger than the machine, cut in halves that lock together.
 * A carries the tails; B is everything A leaves of B's rectangle, grown back by the
 * clearance. They are laid out apart (B above A, a tool's width clear of A's tails),
 * since cut where they assemble the cutter would go through one to reach the other.
 */
export function generateDovetailParts(s: DovetailSpec): JointPart[] {
  const { panelA, panelB } = dovetailAssembled(s)
  if ((s.cut ?? 'joint') === 'board') {
    return layoutRows([[{ key: 'panelB', rings: panelB }], [{ key: 'panelA', rings: panelA }]], layoutGap(s.toolDia), s.cx, s.cy)
  }
  const { jointA, jointB } = dovetailWaste(s, panelA, panelB)
  return layoutRows([[{ key: 'jointB', rings: jointB }], [{ key: 'jointA', rings: jointA }]], layoutGap(s.toolDia), s.cx, s.cy)
}

/**
 * The waste of each panel at the seam, where they assemble. A's board ends at the tails'
 * tips, so its waste is everything between the tails down to the seam; B's ends on the
 * seam, so its waste is the sockets. Each runs a bit's width and more past its board's
 * end and sides, which joins it into one closed loop through air for an inside profile.
 */
export function dovetailWaste(s: DovetailSpec, panelA: Pt[][], panelB: Pt[][]): { jointA: Pt[][]; jointB: Pt[][] } {
  const L = Math.max(1, s.length), mg = airMargin(s.toolDia), dip = s.toolDia + 2
  const bandA: Pt[] = [[-mg, -dip], [L + mg, -dip], [L + mg, s.tailDepth + mg], [-mg, s.tailDepth + mg]]
  const bandB: Pt[] = [[-mg, -mg], [L + mg, -mg], [L + mg, s.tailDepth + dip], [-mg, s.tailDepth + dip]]
  return { jointA: wasteOf(panelA, bandA), jointB: wasteOf(panelB, bandB) }
}

/** The two panels where they ASSEMBLE — seam on y = 0, A below it, B above — before
 *  they are laid out apart to be cut. */
export function dovetailAssembled(s: DovetailSpec): { panelA: Pt[][]; panelB: Pt[][] } {
  const m = dovetailDims(s)
  const n = Math.max(1, Math.round(s.tails))
  const L = Math.max(1, s.length), dA = Math.max(1, s.depthA), dB = Math.max(s.tailDepth + 1, s.depthB)
  const rectA: Pt[] = [[0, -dA], [L, -dA], [L, 0], [0, 0]]
  const rectB: Pt[] = [[0, 0], [L, 0], [L, dB], [0, dB]]
  // No tail to cut: the two panels plain, butted along the seam.
  if (m.neck <= 0 || s.tailDepth <= 0) return { panelA: [rectA], panelB: [rectB] }
  const r = Math.max(0, s.toolDia / 2)
  const c = Math.max(0, s.clearance)
  const pitch = L / n
  const tails: Pt[][] = []
  for (let i = 0; i < n; i++) {
    const mid = (i + 0.5) * pitch
    // From 0.5 mm inside A so the union overlaps rather than touching along a line.
    tails.push([[mid - m.neck / 2, -0.5], [mid + m.neck / 2, -0.5], [mid + s.tailW / 2, s.tailDepth], [mid - s.tailW / 2, s.tailDepth]])
  }
  // Male: rounded convex (so the female's corners come out at the tool's radius) and
  // concave (the tool's own radius at the tails' roots). The rounding is confined to
  // the joint by unioning the plain back of the panel on again, so the panel's far
  // corners stay square.
  const raw = boolRings('union', [rectA], tails)
  const male = roundConcave(roundConvex(raw, Math.max(0, r - c)), r)
  const back: Pt[] = [[0, -dA], [L, -dA], [L, -Math.min(dA, r + 1)], [0, -Math.min(dA, r + 1)]]
  // Female: B's rectangle less the male grown by the clearance.
  return { panelA: boolRings('union', male, [back]), panelB: boolRings('difference', [rectB], inflateRings(male, c)) }
}

// ─── Bowtie keys ─────────────────────────────────────────────────────────────

/** `straight`: a key and its socket, rounded so a straight bit cuts both and they fit.
 *  `vbit`: one sharp outline, for the Inlay operation to cut as plug and socket. */
export type BowtieStyle = 'straight' | 'vbit'

export interface BowtieSpec {
  cx: number; cy: number
  /** End to end, across the seam it bridges. */
  length: number
  /** Width at the ends, and at the waist over the seam. */
  width: number; waist: number
  clearance: number
  toolDia: number
  style: BowtieStyle
}

export interface BowtieDims {
  /** The waist is narrower than the cutter, which must pass round it. */
  waistTooThin: boolean
  /** The flare of each side off the centreline, degrees. */
  flareDeg: number
}

export function bowtieDims(s: BowtieSpec): BowtieDims {
  return {
    waistTooThin: s.waist < Math.max(1, s.toolDia),
    flareDeg: Math.atan2((s.width - s.waist) / 2, s.length / 2) * 180 / Math.PI,
  }
}

export const BOWTIE_PART_LABELS: Record<string, string> = { socket: 'Socket', key: 'Key', outline: 'Bowtie' }

function bowtieRing(s: BowtieSpec): Pt[] {
  const hl = Math.max(1, s.length) / 2, hw = Math.max(0.5, s.width) / 2
  const hn = clamp(s.waist / 2, 0.25, hw)
  return ccw([[-hl, -hw], [0, -hn], [hl, -hw], [hl, hw], [0, hn], [-hl, hw]])
}

/**
 * A butterfly key across a seam or a crack. With a straight bit it is two parts: the
 * SOCKET, pocketed into the work across the seam where it is placed, and the KEY, cut
 * out of a contrasting board beside it. With a V-bit it is one sharp outline that the
 * Inlay operation cuts as both plug and socket — its V-carved walls need no rounding.
 */
export function generateBowtieParts(s: BowtieSpec): JointPart[] {
  if (s.style === 'vbit') {
    return [{ key: 'outline', d: ringToD(bowtieRing(s).map(([x, y]) => [x + s.cx, y + s.cy] as Pt), true) }]
  }
  const { key, socket } = bowtieRings(s)
  const gap = layoutGap(s.toolDia)
  const kb = bbox(key), sb = bbox(socket)
  const place = (rings: Pt[][], dx: number) => ringsToD(placeRings(rings, s.cx + dx, s.cy))
  return [
    { key: 'socket', d: place(socket, 0) },
    // The key stands to the right of its socket, a tool's width and a margin clear.
    { key: 'key', d: place(key, sb.x1 - kb.x0 + gap) },
  ]
}

/** A straight-bit key and its socket, both centred on the origin. */
export function bowtieRings(s: BowtieSpec): { key: Pt[][]; socket: Pt[][] } {
  const r = Math.max(0, s.toolDia / 2), c = Math.max(0, s.clearance)
  const key = roundConcave(roundConvex([bowtieRing(s)], Math.max(0, r - c)), r)
  return { key, socket: inflateRings(key, c) }
}

/** The total area of the rings — for the tests. */
export function ringsArea(rings: Pt[][]): number {
  return rings.reduce((a, r) => a + Math.abs(signedArea(r)), 0)
}
