// The adaptive pocket strategy end to end: generatePocket → motion (and, for coverage, →
// G-code → the simulator's heightfield). The engine itself is pinned in
// ../adaptiveFC/adaptiveFC.test.ts; this is what the PLANNER does with it.
//
// Most of these replay the emitted motion over a fine stock grid with the REAL tool radius
// and read off what each move actually removed — the only way to test the claims (the side
// the stock is on, links over cut floor, nothing plunged into stock) without trusting the
// engine's own idea of what is cleared, which is the thing under test.
import { describe, it, expect, beforeEach } from 'vitest'
import { generatePocket, type PocketParams } from '../pocket'
import { HELIX_MAX_RAMP_DEG, MICRO_LIFT_MM } from './shared'
import { pointInPolygon } from '../geom'
import { auditPocket, auditSummary } from '../../sim/toolpathAudit'
import { useWorkpieceStore } from '../../store/workpieceStore'
import type { Pt2 } from '../pathFlattener'
import type { Tool } from '../../store/toolStore'
import type { MotionSegment } from '../../store/toolpathStore'

const TOOL: Tool = {
  id: 't1', name: 'em6', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const R = TOOL.diameterMM / 2

const circle = (cx: number, cy: number, r: number, n = 120): Pt2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt2
  })
const rect = (x0: number, y0: number, x1: number, y1: number): Pt2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const toD = (pts: Pt2[]): string => `M ${pts.map(p => `${p[0].toFixed(4)} ${p[1].toFixed(4)}`).join(' L ')} Z`

interface Shape { name: string; boundary: Pt2[]; islands: Pt2[][] }
const CIRCLE: Shape = { name: 'circle', boundary: circle(60, 60, 30), islands: [] }
const SQUARE: Shape = { name: 'square', boundary: rect(0, 0, 50, 50), islands: [] }
const ISLAND: Shape = { name: 'rectangle with a round island', boundary: rect(20, 20, 120, 80), islands: [circle(70, 50, 10)] }
// An arm 8 mm wide for a 6 mm tool: too narrow to hold a spiral.
const NARROW_L: Shape = { name: 'L with 8 mm arms', boundary: [[10, 10], [54, 10], [54, 18], [18, 18], [18, 54], [10, 54]], islands: [] }
// Two lobes joined by a 4 mm neck the 6 mm tool cannot pass: a helix in each.
const DUMBBELL: Shape = {
  name: 'dumbbell with a neck narrower than the tool',
  boundary: [[10, 10], [50, 10], [50, 28], [70, 28], [70, 10], [110, 10], [110, 50], [70, 50], [70, 32], [50, 32], [50, 50], [10, 50]],
  islands: [],
}

const params = (shape: Shape, over: Partial<PocketParams> = {}): PocketParams => ({
  strategy: 'adaptive', stepoverPercent: 20, direction: 'climb', rampIn: false,
  safeHeightMM: 5, depthMM: 3, stepDownMM: 3, islandDs: shape.islands.map(toD),
  ...over,
} as PocketParams)
const pocket = (shape: Shape, over: Partial<PocketParams> = {}): MotionSegment[] =>
  generatePocket(toD(shape.boundary), TOOL, params(shape, over))

beforeEach(() => {
  useWorkpieceStore.setState({
    widthMM: 260, heightMM: 200, thicknessMM: 20,
    origin: 'bottom-left', zOrigin: 'top', spindleType: 'vfd',
    autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

// ─── Stock replay (one depth level) ─────────────────────────────────────────────

interface Replay {
  /** Newly cut area lying to the right / left of the direction of travel. */
  rightArea: number
  leftArea: number
  linkArea: number
  linkLength: number
  /** Stock removed by descents that do not move in XY (a plunge), and how many there were. */
  plungeArea: number
  plunges: number
}

const CELL = 0.1
const SUBSTEP = 0.25

/** Replays the moves AT `z` (and the descents onto it) over the shape's stock. */
function replay(shape: Shape, segs: MotionSegment[], z: number): Replay {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of shape.boundary) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  x0 -= 1; y0 -= 1
  const w = Math.ceil((x1 - x0 + 1) / CELL), h = Math.ceil((y1 - y0 + 1) / CELL)
  const stock = new Uint8Array(w * h)
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    const px = x0 + (ix + 0.5) * CELL, py = y0 + (iy + 0.5) * CELL
    if (pointInPolygon(px, py, shape.boundary) && !shape.islands.some(i => pointInPolygon(px, py, i))) stock[iy * w + ix] = 1
  }
  const stamp = (px: number, py: number, dx = 0, dy = 0): { area: number; right: number; left: number } => {
    let n = 0, right = 0, left = 0
    const iy0 = Math.max(0, Math.floor((py - R - y0) / CELL)), iy1 = Math.min(h - 1, Math.floor((py + R - y0) / CELL))
    const ix0 = Math.max(0, Math.floor((px - R - x0) / CELL)), ix1 = Math.min(w - 1, Math.floor((px + R - x0) / CELL))
    for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
      const k = iy * w + ix
      if (!stock[k]) continue
      const ox = x0 + (ix + 0.5) * CELL - px, oy = y0 + (iy + 0.5) * CELL - py
      if (ox * ox + oy * oy > R * R) continue
      stock[k] = 0
      n++
      const cross = dx * oy - dy * ox
      if (cross < 0) right++
      else if (cross > 0) left++
    }
    const a = CELL * CELL
    return { area: n * a, right: right * a, left: left * a }
  }
  const out: Replay = { rightArea: 0, leftArea: 0, linkArea: 0, linkLength: 0, plungeArea: 0, plunges: 0 }
  let prev: MotionSegment | null = null
  for (const s of segs) {
    const p = prev
    prev = s
    if (!p || s.rapid) continue
    const onLevel = Math.abs(s.z - z) < 1e-6
    const descending = s.z < p.z - 1e-6
    const len = Math.hypot(s.x - p.x, s.y - p.y)
    if (descending && Math.abs(s.z - z) < 1e-6 && len < 1e-6) {
      // a straight descent ONTO this level: whatever it removes, it removed by plunging
      out.plunges++
      out.plungeArea += stamp(s.x, s.y).area
      continue
    }
    // A link runs micro-lifted (MICRO_LIFT_MM) but through the same stock a full depth deep,
    // so it ploughs whatever it crosses — it counts.
    if (!onLevel && !s.travel && !(descending && s.z >= z - 1e-6)) continue
    if (len < 1e-9) continue
    const dx = (s.x - p.x) / len, dy = (s.y - p.y) / len
    const n = Math.max(1, Math.ceil(len / SUBSTEP))
    let area = 0
    for (let k = 1; k <= n; k++) {
      const r = stamp(p.x + (s.x - p.x) * k / n, p.y + (s.y - p.y) * k / n, dx, dy)
      area += r.area
      if (onLevel) { out.rightArea += r.right; out.leftArea += r.left }
    }
    if (s.travel) { out.linkArea += area; out.linkLength += len }
  }
  return out
}

const rightShare = (shape: Shape, over: Partial<PocketParams>): number => {
  const r = replay(shape, pocket(shape, over), -3)
  return r.rightArea / (r.rightArea + r.leftArea)
}

// ─── Tests ───────────────────────────────────────────────────────────────────────

describe('adaptive pocket mills the side the user asked for', () => {
  // With an M3 (clockwise) spindle, climb keeps the stock on the cutter's RIGHT. The engine's
  // natural hand is climb; conventional is cut by mirroring the geometry and back. Measured
  // as the side the removed material actually lay on, so it cannot pass by construction.
  // The Ramp In checkbox must not flip it (it once did, on the old engine).
  for (const shape of [CIRCLE, SQUARE]) {
    for (const rampIn of [true, false]) {
      for (const direction of ['climb', 'conventional'] as const) {
        it(`${direction} on the ${shape.name} (Ramp In ${rampIn ? 'on' : 'off'})`, () => {
          const r = rightShare(shape, { direction, rampIn })
          if (direction === 'climb') expect(r).toBeGreaterThan(0.9)
          else expect(r).toBeLessThan(0.1)
        })
      }
    }
  }

  it('climb and conventional take their own side round an island too', () => {
    expect(rightShare(ISLAND, { direction: 'climb' })).toBeGreaterThan(0.85)
    expect(rightShare(ISLAND, { direction: 'conventional' })).toBeLessThan(0.15)
  })
})

describe('the adaptive pocket only ever enters stock on a helix', () => {
  // It steps down far deeper than a slotting pocket (toward the flute length), so a straight
  // plunge into stock is the worst load it could put on the cutter. Every straight descent
  // it does make — after a relink that had to lift — must land on floor already cut.
  for (const shape of [ISLAND, DUMBBELL, NARROW_L]) {
    it(`${shape.name}: no straight descent removes stock`, () => {
      const segs = pocket(shape, { rampIn: false, depthMM: 9, stepDownMM: 9 })
      const r = replay(shape, segs, -9)
      expect(r.plungeArea).toBeLessThan(0.05)
    })
  }

  it('bores a helix at the start of every region, even with Ramp In off', () => {
    // The dumbbell's neck is narrower than the tool, so it is two regions — two helices.
    const segs = pocket(DUMBBELL, { rampIn: false })
    let helices = 0
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i]
      if (!b.rapid && b.z < a.z - 1e-6 && Math.hypot(b.x - a.x, b.y - a.y) > 1e-6 && (a.rapid || segs[i - 2]?.rapid)) helices++
    }
    expect(helices).toBeGreaterThanOrEqual(2)
  })

  it(`never descends steeper than ${HELIX_MAX_RAMP_DEG}° on its helix`, () => {
    const segs = pocket(NARROW_L, { depthMM: 9, stepDownMM: 9 })
    const tan = Math.tan(HELIX_MAX_RAMP_DEG * Math.PI / 180)
    let ramps = 0
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i]
      const dz = a.z - b.z, dxy = Math.hypot(b.x - a.x, b.y - a.y)
      if (b.rapid || dz <= 1e-9 || dxy < 1e-9) continue
      ramps++
      expect(dz / dxy).toBeLessThanOrEqual(tan * 1.02)   // chords of the helix circle run a hair short
    }
    expect(ramps).toBeGreaterThan(10)
  })
})

describe('a stay-down link crosses floor that is already cut', () => {
  // A link is a micro-lifted travel move; through stock the machine would plough it at
  // travel feed. The residue allowed is the sliver between the engine's bookkeeping and
  // the real tool.
  for (const shape of [SQUARE, ISLAND]) {
    it(`${shape.name}: under 0.1 mm of material per mm of link`, () => {
      const r = replay(shape, pocket(shape), -3)
      expect(r.linkLength).toBeGreaterThan(20)
      expect(r.linkArea / r.linkLength).toBeLessThan(0.1)
    })
  }

  it('lifts a link by the micro-lift, runs it as travel, and drops back to depth', () => {
    const segs = pocket(ISLAND)
    const travel = segs.filter(s => s.travel)
    expect(travel.length).toBeGreaterThan(0)
    for (const s of travel) expect(s.z).toBeCloseTo(-3 + MICRO_LIFT_MM, 9)
  })
})

describe('the adaptive pocket clears the whole reachable region', () => {
  // End to end through the G-code and the simulator's heightfield, including the engine's
  // own finishing profile.
  const cases: Array<[Shape, number]> = [[CIRCLE, 20], [ISLAND, 20], [ISLAND, 50], [NARROW_L, 20], [DUMBBELL, 20]]
  for (const [shape, stepoverPercent] of cases) {
    it(`${shape.name} at ${stepoverPercent}%`, () => {
      const a = auditPocket({ boundaryD: toD(shape.boundary), islandDs: shape.islands.map(toD), tool: TOOL, params: params(shape, { stepoverPercent }) })
      expect(a.cellsToClear).toBeGreaterThan(1000)
      expect(a.warnings, auditSummary(a)).toEqual([])
      expect(a.uncut, auditSummary(a)).toBeLessThanOrEqual(20)
      expect(a.shallow, auditSummary(a)).toBeLessThanOrEqual(20)
      expect(a.gouged, auditSummary(a)).toBeLessThanOrEqual(20)
    })
  }
})

describe('the planner replays one plan at every depth', () => {
  it('cuts the same XY path at every depth pass', () => {
    const segs = pocket(CIRCLE, { depthMM: 6, stepDownMM: 3 })
    const at = (z: number): string[] => segs.filter(s => !s.rapid && !s.travel && Math.abs(s.z - z) < 1e-9).map(s => `${s.x},${s.y}`)
    expect(at(-3).length).toBeGreaterThan(100)
    expect(at(-6)).toEqual(at(-3))
  })

  it('regenerates an operation still holding a retired adaptive id with the current engine', () => {
    const now = pocket(ISLAND)
    for (const old of ['adaptive2', 'adaptiveFC']) {
      expect(pocket(ISLAND, { strategy: old as PocketParams['strategy'] })).toEqual(now)
    }
  })
})
