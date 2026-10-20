// TILING: a board longer than the machine, cut in tiles, slid along between them.
//
// The user enters the board's REAL size and designs and generates as if the machine were
// that big; nothing about drawing, generating or start heights knows about tiles. A tile
// is only a WINDOW of the finished program: tile k is every move inside [b_k, b_{k+1})
// along the slide axis, moved by −b_k so the window's start lands on the same machine spot
// every time (`tileOps`). Toolpaths are clipped, not geometry: clipping a part's outline
// would break every profile and pocket at the seam, while clipping the moves keeps each
// one exactly where the full-size program had it (`clipToWindow`). Each move belongs to
// exactly one tile, so nothing is cut twice.
//
// Where a cut leaves the window and comes back into it, the tile lifts to safe height,
// rapids over and plunges back in. That plunge is one step-down at most: the passes above
// it were clipped to the same window and cut first.
//
// THE PINS. Two pins sit in the spoilboard at a fixed machine spot, `pinFromStartMM` from
// the window's start, across the board. Each tile drills the board's NEXT pair of holes,
// one tile length further on, before the board slides: slide it until those holes drop onto
// the pins and the next tile is registered to the last. The first tile also drills the
// first pair, through into the spoilboard — those are where the pins go. Every later pair
// goes only through the board (`stationDepthMM`): a hole in the spoilboard holds nothing,
// and each one is a hole in the spoilboard for good. Like a flip, a
// pair of equal pins only fixes the spacing; the two are DIFFERENT SIZES so the board cannot
// go back on turned round.

import type { AnyOperation, MotionSegment } from '../store/toolpathStore'
import type { Stock } from './sheets'

/** The axis the board slides along between tiles. */
export type TileAxis = 'x' | 'y'

export interface Tiling {
  axis: TileAxis
  /** The machine's usable travel along the slide axis. Typed in — never read off a controller. */
  maxTravelMM: number
  /** The seams between tiles, along the axis from the board's start, ascending. */
  seamsMM: number[]
  /** The small pin's diameter. */
  pin1DiaMM: number
  /** The big pin's diameter — the difference is what stops the board going back on turned round. */
  pin2DiaMM: number
  /** How far the pins are from each tile's start, along the axis. */
  pinFromStartMM: number
  /** The small pin's distance from the board's low edge across the axis (bottom for a Y slide, left for X). */
  pin1MM: number
  /** The big pin's distance from the board's high edge across the axis. */
  pin2MM: number
  /** How deep the first pair of holes goes into the spoilboard, for the pins. */
  spoilDepthMM: number
  /** One "Tile Pins" path per station, in station order, once the form has made them. */
  pinPathIds?: string[]
  /** The end mill that bores the pin holes; absent = the largest that fits (tools/registrationOps). */
  toolId?: string
}

// 8 and 10 mm pins, as for a double-sided job: both bigger than a 1/4" end mill.
export const TILING_DEFAULTS: Omit<Tiling, 'axis' | 'maxTravelMM' | 'seamsMM'> = {
  pin1DiaMM: 8, pin2DiaMM: 10, pinFromStartMM: 20, pin1MM: 20, pin2MM: 20, spoilDepthMM: 8,
}

/** A stored setting as this build reads it: anything missing or not a number takes its default. */
export function normalizeTiling(raw: unknown): Tiling | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const D = TILING_DEFAULTS
  return {
    axis: r.axis === 'x' ? 'x' : 'y',
    maxTravelMM: num(r.maxTravelMM, 600),
    seamsMM: Array.isArray(r.seamsMM) ? r.seamsMM.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b) : [],
    pin1DiaMM: num(r.pin1DiaMM, D.pin1DiaMM),
    pin2DiaMM: num(r.pin2DiaMM, D.pin2DiaMM),
    pinFromStartMM: num(r.pinFromStartMM, D.pinFromStartMM),
    pin1MM: num(r.pin1MM, D.pin1MM),
    pin2MM: num(r.pin2MM, D.pin2MM),
    spoilDepthMM: num(r.spoilDepthMM, D.spoilDepthMM),
    ...(Array.isArray(r.pinPathIds) ? { pinPathIds: r.pinPathIds.filter((v): v is string => typeof v === 'string') } : {}),
    ...(typeof r.toolId === 'string' ? { toolId: r.toolId } : {}),
  }
}

/** The least size difference that keeps the big pin out of the small hole. */
export const MIN_TILE_PIN_SIZE_DIFF_MM = 1

export const axisLengthMM = (t: Pick<Tiling, 'axis'>, s: Stock) => (t.axis === 'y' ? s.heightMM : s.widthMM)
const acrossLengthMM = (t: Pick<Tiling, 'axis'>, s: Stock) => (t.axis === 'y' ? s.widthMM : s.heightMM)

/** Every tile's start and end along the axis: b₀ = 0, the seams, the board's length. */
export function tileBounds(t: Pick<Tiling, 'axis' | 'seamsMM'>, s: Stock): number[] {
  return [0, ...t.seamsMM, axisLengthMM(t, s)]
}

export const tileCount = (t: Pick<Tiling, 'seamsMM'>) => t.seamsMM.length + 1

/** Where tile k's window starts, as a CNC offset — what its program is moved back by. */
export function tileOffset(t: Pick<Tiling, 'axis' | 'seamsMM'>, s: Stock, k: number): { x: number; y: number } {
  const b = tileBounds(t, s)[k] ?? 0
  return t.axis === 'y' ? { x: 0, y: b } : { x: b, y: 0 }
}

/**
 * The longest tile k may be. Every tile but the last has to reach one tile further on to
 * drill the next pair of holes, so it gives up the pins' distance and the big hole's radius.
 */
export function maxTileLengthMM(t: Tiling, k: number, n: number): number {
  return k < n - 1 ? t.maxTravelMM - t.pinFromStartMM - t.pin2DiaMM / 2 : t.maxTravelMM
}

/** The shortest a tile may be: room for its pins and a millimetre over. */
export const minTileLengthMM = (t: Tiling) => t.pinFromStartMM + t.pin2DiaMM / 2 + 1

/** The fewest equal tiles that fit — where a new tiling starts, and what a tile count gives. */
export function evenSeams(t: Tiling, s: Stock, n?: number): number[] {
  const len = axisLengthMM(t, s)
  const each = maxTileLengthMM(t, 0, 2)
  const count = Math.max(1, n ?? (each > 0 ? Math.ceil(len / each) : 1))
  return Array.from({ length: count - 1 }, (_, i) => Math.round((len * (i + 1)) / count))
}

/**
 * Where seam i may go: past the tile before it by at least the minimum and at most what
 * that tile may span, and leaving the tile after it room for its pins. The tile AFTER is
 * deliberately not held to the machine's reach: a seam can be put at a gap in the parts
 * however short that makes this tile, and a tile left too long beyond it takes another
 * seam — `tilingProblem` says so.
 */
export function seamLimits(t: Tiling, s: Stock, i: number): { min: number; max: number } {
  const b = tileBounds(t, s)
  const n = b.length - 1
  const lo = b[i], hi = b[i + 2]
  const minLen = minTileLengthMM(t)
  const min = lo + minLen
  return { min, max: Math.max(min, Math.min(lo + maxTileLengthMM(t, i, n), hi - minLen)) }
}

/** Is any tile longer than the machine can cut it (with its next pins)? */
export function anyTileTooLong(t: Tiling, s: Stock): boolean {
  const b = tileBounds(t, s)
  const n = b.length - 1
  return b.some((v, k) => k < n && b[k + 1] - v > maxTileLengthMM(t, k, n) + 1e-6)
}

/** What is wrong with this tiling, or null. */
export function tilingProblem(t: Tiling, s: Stock): string | null {
  if (!(t.maxTravelMM > 0)) return 'Enter the machine’s travel along the slide axis.'
  if (!(t.pin1DiaMM > 0) || !(t.pin2DiaMM > 0)) return 'Each pin needs a diameter.'
  if (t.pin2DiaMM - t.pin1DiaMM < MIN_TILE_PIN_SIZE_DIFF_MM) {
    return `The big pin must be at least ${MIN_TILE_PIN_SIZE_DIFF_MM} mm bigger than the small one — with pins the same size the board could go back on turned round.`
  }
  const across = acrossLengthMM(t, s)
  if (t.pin1MM < t.pin1DiaMM / 2 || t.pin2MM < t.pin2DiaMM / 2) return 'A pin hole runs off the edge of the board.'
  if (across - t.pin1MM - t.pin2MM < (t.pin1DiaMM + t.pin2DiaMM) / 2 + 1) return 'The pin holes overlap — move the pins further apart.'
  if (t.pinFromStartMM < t.pin2DiaMM / 2) return 'The pins are too close to the start of the tile.'
  const b = tileBounds(t, s)
  const n = b.length - 1
  for (let k = 0; k < n; k++) {
    const len = b[k + 1] - b[k]
    if (len > maxTileLengthMM(t, k, n) + 1e-6) {
      return k < n - 1
        ? `Tile ${k + 1} is ${len.toFixed(1)} mm — with the next pair of pin holes to drill it can be at most ${maxTileLengthMM(t, k, n).toFixed(1)} mm on this machine.`
        : `Tile ${k + 1} is ${len.toFixed(1)} mm, longer than the machine's ${t.maxTravelMM.toFixed(1)} mm of travel.`
    }
    if (len < minTileLengthMM(t) - 1e-6) return `Tile ${k + 1} is too short for its pins.`
  }
  return null
}

export interface TilePin { x: number; y: number; diaMM: number }

/**
 * The pin holes of station k, on the full-size board: the pair the board sits on for
 * tile k. The small pin, then the big one.
 */
export function stationPins(t: Tiling, s: Stock, k: number): [TilePin, TilePin] {
  const along = tileBounds(t, s)[k] + t.pinFromStartMM
  const across = acrossLengthMM(t, s)
  const at = (a: number, diaMM: number): TilePin => (t.axis === 'y' ? { x: a, y: along, diaMM } : { x: along, y: a, diaMM })
  return [at(t.pin1MM, t.pin1DiaMM), at(across - t.pin2MM, t.pin2DiaMM)]
}

/** The tile that drills station k: tile 0 drills the first two, every later station its predecessor. */
export const stationTile = (k: number) => Math.max(0, k - 1)

/** How far a through hole goes past the board, so it is through and no more. */
export const PIN_BREAKTHROUGH_MM = 0.5

/**
 * How deep station k is drilled. Station 0 goes through the board and into the spoilboard
 * — those holes are where the pins go. Every other station goes only through the board:
 * its holes drop onto the pins, and a deeper one would leave a hole in the spoilboard that
 * holds nothing, there for good.
 */
export function stationDepthMM(t: Tiling, k: number, thicknessMM: number): number {
  return thicknessMM + (k === 0 ? t.spoilDepthMM : PIN_BREAKTHROUGH_MM)
}

// ─── Clipping ──────────────────────────────────────────────────────────────────

type P3 = { x: number; y: number; z: number }
const lerp3 = (a: P3, b: P3, t: number): P3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
const ARC_CHORD_TOL_MM = 0.01

interface ArcSweep { cx: number; cy: number; a0: number; d: number; r0: number; r1: number; z0: number; z1: number }

function arcSweep(p: P3, s: MotionSegment): ArcSweep {
  const { cx, cy, cw } = s.arc!
  const a0 = Math.atan2(p.y - cy, p.x - cx)
  const a1 = Math.atan2(s.y - cy, s.x - cx)
  const full = Math.abs(p.x - s.x) < 1e-9 && Math.abs(p.y - s.y) < 1e-9
  let d: number
  if (cw) { d = a0 - a1; while (d <= 1e-12) d += 2 * Math.PI; if (full) d = 2 * Math.PI; d = -d }
  else { d = a1 - a0; while (d <= 1e-12) d += 2 * Math.PI; if (full) d = 2 * Math.PI }
  return { cx, cy, a0, d, r0: Math.hypot(p.x - cx, p.y - cy), r1: Math.hypot(s.x - cx, s.y - cy), z0: p.z, z1: s.z }
}

const arcPoint = (a: ArcSweep, t: number): P3 => {
  const ang = a.a0 + a.d * t, r = a.r0 + (a.r1 - a.r0) * t
  return { x: a.cx + r * Math.cos(ang), y: a.cy + r * Math.sin(ang), z: a.z0 + (a.z1 - a.z0) * t }
}

/** The arc's extent along the axis: its two ends, and any extreme of the circle its sweep passes. */
function arcRange(a: ArcSweep, axis: TileAxis): [number, number] {
  const u = (q: P3) => (axis === 'y' ? q.y : q.x)
  let lo = Math.min(u(arcPoint(a, 0)), u(arcPoint(a, 1))), hi = Math.max(u(arcPoint(a, 0)), u(arcPoint(a, 1)))
  const extremes = axis === 'y' ? [Math.PI / 2, -Math.PI / 2] : [0, Math.PI]
  for (const e of extremes) {
    for (let k = -2; k <= 2; k++) {
      const t = (e + 2 * Math.PI * k - a.a0) / a.d
      if (t > 0 && t < 1) { const v = u(arcPoint(a, t)); lo = Math.min(lo, v); hi = Math.max(hi, v) }
    }
  }
  return [lo, hi]
}

/** An arc as straight chords within ARC_CHORD_TOL_MM, for an arc a seam cuts. */
function arcChords(a: ArcSweep): P3[] {
  const r = Math.max(a.r0, a.r1, 1e-6)
  const step = r > ARC_CHORD_TOL_MM ? 2 * Math.acos(1 - ARC_CHORD_TOL_MM / r) : Math.PI / 8
  const n = Math.max(1, Math.ceil(Math.abs(a.d) / step))
  return Array.from({ length: n }, (_, i) => arcPoint(a, (i + 1) / n))
}

/**
 * One operation's moves inside [lo, hi] along the axis, in their original coordinates.
 * Whatever lies outside is dropped; a move the window cuts keeps its inside part; and
 * wherever the tool has to come back in, it lifts to `safeZ`, rapids over and plunges at
 * the plunge feed (from 1 mm over the stock, so the descent through air is quick).
 */
export function clipToWindow(segs: MotionSegment[], lo: number, hi: number, axis: TileAxis, safeZ: number): MotionSegment[] {
  const u = (q: P3) => (axis === 'y' ? q.y : q.x)
  const inside = (q: P3) => u(q) >= lo - 1e-9 && u(q) <= hi + 1e-9
  const out: MotionSegment[] = []
  let here: P3 | null = null
  let prev: P3 | null = null

  // Get to `a` from wherever the tile's tool is, if it is not already there.
  const arrive = (a: P3, rapidMove: boolean) => {
    if (here && Math.hypot(here.x - a.x, here.y - a.y, here.z - a.z) < 1e-6) return
    if (here && here.z < safeZ - 1e-9) out.push({ x: here.x, y: here.y, z: safeZ, rapid: true })
    out.push({ x: a.x, y: a.y, z: Math.max(safeZ, a.z), rapid: true })
    if (a.z < safeZ - 1e-9) {
      if (rapidMove || a.z >= 0) out.push({ x: a.x, y: a.y, z: a.z, rapid: true })
      else {
        if (safeZ > 1) out.push({ x: a.x, y: a.y, z: 1, rapid: true })
        out.push({ x: a.x, y: a.y, z: a.z, rapid: false })
      }
    }
    here = a
  }

  // A straight move a → b with `s`'s flags (and no arc).
  const line = (a: P3, b: P3, s: MotionSegment) => {
    const ua = u(a), ub = u(b)
    let t0 = 0, t1 = 1
    if (Math.abs(ub - ua) < 1e-12) {
      if (!inside(a)) return
    } else {
      const tl = (lo - ua) / (ub - ua), th = (hi - ua) / (ub - ua)
      t0 = Math.max(0, Math.min(tl, th)); t1 = Math.min(1, Math.max(tl, th))
      if (t1 - t0 <= 1e-12) return
    }
    const A = t0 > 0 ? lerp3(a, b, t0) : a
    const B = t1 < 1 ? lerp3(a, b, t1) : b
    arrive(A, s.rapid)
    const { arc: _arc, ...rest } = s
    out.push({ ...rest, x: B.x, y: B.y, z: B.z })
    here = B
  }

  for (const s of segs) {
    const p: P3 = { x: s.x, y: s.y, z: s.z }
    if (s.toolChange) {
      // A tool change is a lift as well: made where the tool is (or the window's edge),
      // never out past it.
      const at: P3 = inside(p) ? p
        : here ? { x: here.x, y: here.y, z: Math.max(here.z, s.z) }
        : axis === 'y' ? { x: p.x, y: Math.min(hi, Math.max(lo, p.y)), z: s.z } : { x: Math.min(hi, Math.max(lo, p.x)), y: p.y, z: s.z }
      out.push({ ...s, x: at.x, y: at.y, z: at.z })
      here = at
      prev = p
      continue
    }
    if (!prev) {
      // The operation's first point: the program gets there as it always did.
      if (inside(p)) { out.push(s); here = p }
      prev = p
      continue
    }
    if (s.arc) {
      const a = arcSweep(prev, s)
      const [alo, ahi] = arcRange(a, axis)
      if (alo >= lo - 1e-9 && ahi <= hi + 1e-9) {
        // Wholly in the window: kept as the arc it is.
        arrive(prev, s.rapid)
        out.push(s)
        here = p
      } else if (!(ahi < lo || alo > hi)) {
        const { arc: _arc, ...flat } = s
        let q = prev
        for (const c of arcChords(a)) { line(q, c, flat as MotionSegment); q = c }
      }
    } else {
      line(prev, p, s)
    }
    prev = p
  }
  if (here && (here as P3).z < safeZ - 1e-9) out.push({ x: (here as P3).x, y: (here as P3).y, z: safeZ, rapid: true })
  return out
}

function shift(segs: MotionSegment[], dx: number, dy: number): MotionSegment[] {
  return segs.map((g) => ({
    ...g, x: g.x + dx, y: g.y + dy,
    ...(g.arc ? { arc: { ...g.arc, cx: g.arc.cx + dx, cy: g.arc.cy + dy } } : {}),
  }))
}

/**
 * Tile k's operations: everything else clipped to its window, the pin holes that tile
 * drills whole, all moved so the window's start is the machine's. Program order is kept,
 * and an operation with nothing in the window is left out.
 */
export function tileOps(ops: AnyOperation[], t: Tiling, s: Stock, k: number, safeZ: (op: AnyOperation) => number): AnyOperation[] {
  const b = tileBounds(t, s)
  const off = tileOffset(t, s, k)
  const lo = b[k], hi = b[k + 1]
  const pinIds = t.pinPathIds ?? []
  const result: AnyOperation[] = []
  for (const op of ops) {
    const pathId = (op as { pathId?: string }).pathId
    const station = pathId ? pinIds.indexOf(pathId) : -1
    let segs: MotionSegment[]
    if (station >= 0) {
      if (stationTile(station) !== k) continue
      segs = op.segments
    } else {
      segs = clipToWindow(op.segments, lo, hi, t.axis, safeZ(op))
      if (!segs.some((g) => !g.rapid && !g.toolChange)) continue
    }
    const hint = op.entryHint
    result.push({
      ...op,
      segments: shift(segs, -off.x, -off.y),
      ...(hint ? { entryHint: { x: hint.x - off.x, y: hint.y - off.y } } : {}),
    } as AnyOperation)
  }
  return result
}

/**
 * Where along the axis the program cuts: the merged spans the cutting moves sweep, each
 * widened by its tool's radius. A seam outside every span crosses no cut — what dragging
 * a seam snaps to.
 */
export function cutSpans(ops: AnyOperation[], axis: TileAxis, radiusOf: (op: AnyOperation) => number): [number, number][] {
  const spans: [number, number][] = []
  for (const op of ops) {
    const r = radiusOf(op)
    let prev: P3 | null = null
    for (const g of op.segments) {
      if (g.toolChange) continue
      const p: P3 = { x: g.x, y: g.y, z: g.z }
      if (prev && !g.rapid && (g.z < 0 || prev.z < 0)) {
        const [a, b] = g.arc ? arcRange(arcSweep(prev, g), axis) : [Math.min(axis === 'y' ? prev.y : prev.x, axis === 'y' ? p.y : p.x), Math.max(axis === 'y' ? prev.y : prev.x, axis === 'y' ? p.y : p.x)]
        spans.push([a - r, b + r])
      }
      prev = p
    }
  }
  spans.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const sp of spans) {
    const last = merged[merged.length - 1]
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1])
    else merged.push([sp[0], sp[1]])
  }
  return merged
}

/** How many of `spans` the seam at `u` falls inside — 0 is a clean break. */
export const spanAt = (spans: [number, number][], u: number) => spans.findIndex((sp) => u > sp[0] && u < sp[1])
