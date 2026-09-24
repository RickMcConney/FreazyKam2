// Adaptive2 — the constant-engagement marcher (./adaptive2) and its pocket planner
// (./pocket/adaptive2).
//
// Most of these replay the toolpath over a fine stock grid with the REAL tool radius and
// read off what each move actually removed. That is the only way to test the engine's
// claims — the bite held near the stepover, links over cleared floor, the side the stock
// is on — without trusting the engine's own occupancy grid, which is the thing under test.
import { describe, it, expect, beforeEach } from 'vitest'
import { computeAdaptive2Plan, type Adaptive2Params, type Adaptive2Region } from './adaptive2'
import { generatePocket, type PocketParams } from './pocket'
import { MICRO_LIFT_MM } from './pocket/shared'
import { ptSegDistSq, pointInPolygon } from './geom'
import { auditPocket, auditSummary } from '../sim/toolpathAudit'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { Pt2 } from './pathFlattener'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'

const TOOL: Tool = {
  id: 't1', name: 'em6', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const D = TOOL.diameterMM
const R = D / 2

const circle = (cx: number, cy: number, r: number, n = 120): Pt2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt2
  })
const rect = (x0: number, y0: number, x1: number, y1: number): Pt2[] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const toD = (pts: Pt2[]) => `M ${pts.map(p => `${p[0]} ${p[1]}`).join(' L ')} Z`

interface Shape { name: string; boundary: Pt2[]; islands: Pt2[][] }
const CIRCLE: Shape = { name: 'circle', boundary: circle(60, 60, 30), islands: [] }
const SQUARE: Shape = { name: 'square', boundary: rect(0, 0, 50, 50), islands: [] }
const ISLAND: Shape = { name: 'rectangle with a round island', boundary: rect(20, 20, 120, 80), islands: [circle(70, 50, 10)] }
// An arm 8 mm wide for a 6 mm tool: too narrow to hold a spiral, so it is all
// trochoids and slots — the geometry that forces feed reductions.
const NARROW_L: Shape = {
  name: 'L with 8 mm arms',
  boundary: [[10, 10], [54, 10], [54, 18], [18, 18], [18, 54], [10, 54]],
  islands: [],
}
// Two lobes joined by a 4 mm neck the 6 mm tool cannot pass.
const DUMBBELL: Shape = {
  name: 'dumbbell with a neck narrower than the tool',
  boundary: [[10, 10], [50, 10], [50, 28], [70, 28], [70, 10], [110, 10], [110, 50],
    [70, 50], [70, 32], [50, 32], [50, 50], [10, 50]],
  islands: [],
}
const OPEN_SHAPES = [CIRCLE, SQUARE, ISLAND]

const plan = (s: Shape, over: Partial<Adaptive2Params> = {}) =>
  computeAdaptive2Plan(s.boundary, s.islands, {
    toolDiameterMM: D, stepoverMM: 0.4 * D, wantCCW: true, helixEntry: true, ...over,
  })

const pocketParams = (over: Partial<PocketParams> = {}): PocketParams => ({
  strategy: 'adaptive2', stepoverPercent: 40, direction: 'climb', rampIn: true,
  safeHeightMM: 5, depthMM: 3, stepDownMM: 3, islandDs: [],
  ...over,
} as PocketParams)

beforeEach(() => {
  useWorkpieceStore.setState({
    widthMM: 260, heightMM: 200, thicknessMM: 12,
    origin: 'bottom-left', zOrigin: 'top', spindleType: 'vfd',
    autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

// ─── Stock replay ────────────────────────────────────────────────────────────────

type Step =
  | { mode: 'jump'; x: number; y: number }                       // reposition, cuts nothing
  | { mode: 'plunge'; x: number; y: number }                     // tool footprint at a point
  | { mode: 'disc'; x: number; y: number; r: number }            // a helix bore
  | { mode: 'cut' | 'link'; x: number; y: number; feedScale?: number }

interface Replay {
  /** New material per mm of travel (the radial bite, mm) for each cut move at full feed. */
  fullFeedBites: number[]
  /** Same, for moves the engine slowed down, with their feed scale. */
  slowBites: { bite: number; feedScale: number }[]
  linkArea: number
  linkLength: number
  /** Newly cut area lying to the right / left of the direction of travel. */
  rightArea: number
  leftArea: number
}

const CELL = 0.1
const SUBSTEP = 0.25

function replay(shape: Shape, steps: Step[]): Replay {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of shape.boundary) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  x0 -= 1; y0 -= 1
  const w = Math.ceil((x1 - x0 + 1) / CELL), h = Math.ceil((y1 - y0 + 1) / CELL)
  const stock = new Uint8Array(w * h)
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const px = x0 + (ix + 0.5) * CELL, py = y0 + (iy + 0.5) * CELL
      if (pointInPolygon(px, py, shape.boundary) && !shape.islands.some(i => pointInPolygon(px, py, i))) stock[iy * w + ix] = 1
    }
  }
  // Remove stock within r of (px,py); split what went by the side of the heading (dx,dy).
  const stamp = (px: number, py: number, r: number, dx = 0, dy = 0) => {
    let n = 0, right = 0, left = 0
    const r2 = r * r
    const iy0 = Math.max(0, Math.floor((py - r - y0) / CELL)), iy1 = Math.min(h - 1, Math.floor((py + r - y0) / CELL))
    const ix0 = Math.max(0, Math.floor((px - r - x0) / CELL)), ix1 = Math.min(w - 1, Math.floor((px + r - x0) / CELL))
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const k = iy * w + ix
        if (!stock[k]) continue
        const ox = x0 + (ix + 0.5) * CELL - px, oy = y0 + (iy + 0.5) * CELL - py
        if (ox * ox + oy * oy > r2) continue
        stock[k] = 0
        n++
        const cross = dx * oy - dy * ox
        if (cross < 0) right++
        else if (cross > 0) left++
      }
    }
    const a = CELL * CELL
    return { area: n * a, right: right * a, left: left * a }
  }

  const out: Replay = { fullFeedBites: [], slowBites: [], linkArea: 0, linkLength: 0, rightArea: 0, leftArea: 0 }
  let at: Pt2 | null = null
  for (const s of steps) {
    if (s.mode === 'jump') { at = [s.x, s.y]; continue }
    if (s.mode === 'plunge') { stamp(s.x, s.y, R); at = [s.x, s.y]; continue }
    if (s.mode === 'disc') { stamp(s.x, s.y, s.r); continue }
    if (!at) { at = [s.x, s.y]; continue }
    const len = Math.hypot(s.x - at[0], s.y - at[1])
    if (len < 1e-9) continue
    const dx = (s.x - at[0]) / len, dy = (s.y - at[1]) / len
    const n = Math.max(1, Math.ceil(len / SUBSTEP))
    let area = 0
    for (let k = 1; k <= n; k++) {
      const r = stamp(at[0] + (s.x - at[0]) * k / n, at[1] + (s.y - at[1]) * k / n, R, dx, dy)
      area += r.area
      out.rightArea += r.right
      out.leftArea += r.left
    }
    if (s.mode === 'link') {
      out.linkArea += area
      out.linkLength += len
    } else if (len > 0.2) {
      if (s.feedScale === undefined) out.fullFeedBites.push(area / len)
      else out.slowBites.push({ bite: area / len, feedScale: s.feedScale })
    }
    at = [s.x, s.y]
  }
  return out
}

/** The engine's plan as the planner will cut it: bore (or plunge) at each seed, then the moves. */
function planSteps(regions: Adaptive2Region[]): Step[] {
  const steps: Step[] = []
  for (const reg of regions) {
    const first = reg.moves[0].pts[0]
    if (reg.helixRadiusMM > 0) steps.push({ mode: 'disc', x: reg.helixCenter[0], y: reg.helixCenter[1], r: reg.helixRadiusMM + R })
    steps.push({ mode: 'plunge', x: first[0], y: first[1] })
    for (const mv of reg.moves) {
      for (const [x, y] of mv.pts) steps.push({ mode: mv.kind, x, y, feedScale: mv.feedScale })
    }
  }
  return steps
}

/** Emitted motion as the machine runs it, flattened to the XY plane (single depth pass). */
function segmentSteps(segs: MotionSegment[]): Step[] {
  return segs.map((s): Step => (s.rapid ? { mode: 'jump', x: s.x, y: s.y }
    : s.travel ? { mode: 'link', x: s.x, y: s.y }
      : { mode: 'cut', x: s.x, y: s.y, feedScale: s.feedScale }))
}

const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

// ─── Tests ───────────────────────────────────────────────────────────────────────

/** Fraction of the material the pocket removes that lies to the right of the cutter's travel. */
function rightShare(shape: Shape, params: PocketParams): number {
  const r = replay(shape, segmentSteps(generatePocket(toD(shape.boundary), TOOL, params)))
  return r.rightArea / (r.rightArea + r.leftArea)
}

describe('adaptive clearing mills the side the user asked for', () => {
  // With an M3 (clockwise) spindle, climb milling keeps the stock on the cutter's RIGHT,
  // conventional on its left. The march grows outward with the stock outside the path, so
  // climb is a CCW spiral — the same hand as the contour strategy and the finishing ring.
  //
  // Both entries once got this wrong in opposite directions: the planner passed the
  // winding inverted, so every helix-entered pocket milled conventional when climb was
  // asked for; and a plunge entry ignored the winding altogether (its start is symmetric,
  // so grid noise picked the hand), which happened to cancel the inversion. Flipping the
  // Ramp In checkbox therefore flipped climb and conventional. Measured here as the side
  // of the travel the removed material actually lay on, so it cannot pass by construction:
  // before the fix a climb circle put 12% of its material on the right, now 98%.
  for (const shape of [CIRCLE, SQUARE]) {
    for (const rampIn of [true, false]) {
      for (const direction of ['climb', 'conventional'] as const) {
        it(`${direction} on the ${shape.name} (rampIn=${rampIn})`, () => {
          const r = rightShare(shape, pocketParams({ direction, rampIn }))
          if (direction === 'climb') expect(r).toBeGreaterThan(0.85)
          else expect(r).toBeLessThan(0.15)
        })
      }
    }
  }

  // Weaker around an island, and honestly so: once the cleared area wraps round the island
  // and closes, the stock between the two fronts is ENCLOSED, and a single global winding
  // then has it on the wrong side (CCW round a hole keeps the hole on the left). Measured
  // at 0.61–0.69 either way; the broken planner put climb at 0.31 here.
  for (const rampIn of [true, false]) {
    it(`climb and conventional still take mostly their own side round an island (rampIn=${rampIn})`, () => {
      const p = { rampIn, islandDs: ISLAND.islands.map(toD) }
      expect(rightShare(ISLAND, pocketParams({ ...p, direction: 'climb' }))).toBeGreaterThan(0.55)
      expect(rightShare(ISLAND, pocketParams({ ...p, direction: 'conventional' }))).toBeLessThan(0.45)
    })
  }
})

describe('computeAdaptive2Plan returns nothing it cannot cut', () => {
  it('returns no regions for a tool of zero diameter', () => {
    expect(plan(SQUARE, { toolDiameterMM: 0 })).toEqual([])
  })

  it('returns no regions for a boundary of fewer than three points', () => {
    expect(computeAdaptive2Plan([[0, 0], [50, 0]], [], {
      toolDiameterMM: D, stepoverMM: 2, wantCCW: true, helixEntry: true,
    })).toEqual([])
  })

  it('returns no regions for a pocket narrower than the tool', () => {
    expect(plan({ name: 'slot', boundary: rect(0, 0, 50, 5), islands: [] })).toEqual([])
  })
})

describe('the tool centre stays a full radius clear of the walls and islands', () => {
  // Measured against the DRAWN geometry, not the engine's inset ring, so a wrong offset
  // or a smoothing pass that drifts off the mask both show up as a gouge.
  const distToRing = (p: Pt2, ring: Pt2[]) => {
    let best = Infinity
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      best = Math.min(best, ptSegDistSq(p[0], p[1], a[0], a[1], b[0], b[1]))
    }
    return Math.sqrt(best)
  }
  for (const shape of [CIRCLE, ISLAND, NARROW_L, DUMBBELL]) {
    for (const pct of [20, 60]) {
      it(`${shape.name} at ${pct}% engagement`, () => {
        const regions = plan(shape, { stepoverMM: D * pct / 100 })
        expect(regions.length).toBeGreaterThan(0)
        for (const p of regions.flatMap(r => r.moves.flatMap(m => m.pts))) {
          expect(pointInPolygon(p[0], p[1], shape.boundary)).toBe(true)
          expect(distToRing(p, shape.boundary)).toBeGreaterThanOrEqual(R - 1e-6)
          for (const isl of shape.islands) {
            expect(pointInPolygon(p[0], p[1], isl)).toBe(false)
            expect(distToRing(p, isl)).toBeGreaterThanOrEqual(R - 1e-6)
          }
        }
      })
    }
  }
})

describe('the radial bite stays near the requested engagement', () => {
  // The engine's whole claim. Stepping on circumference occupancy alone once ran the
  // median bite ~20% over the stepover; the swept-area check that picks the winner keeps
  // it within a few percent (the grid's bookkeeping radius sits a hair under the tool's).
  for (const shape of OPEN_SHAPES) {
    for (const pct of [20, 40, 60]) {
      it(`${shape.name} at ${pct}%: median within 20% of target, 95th percentile within 35%`, () => {
        const s = D * pct / 100
        const r = replay(shape, planSteps(plan(shape, { stepoverMM: s })))
        expect(r.fullFeedBites.length).toBeGreaterThan(50)
        expect(quantile(r.fullFeedBites, 0.5) / s).toBeGreaterThan(0.95)
        expect(quantile(r.fullFeedBites, 0.5) / s).toBeLessThan(1.2)
        expect(quantile(r.fullFeedBites, 0.95) / s).toBeLessThan(1.35)
      })
    }
  }

  // A slot is sometimes unavoidable — the plunge, a channel too narrow to trochoid in —
  // and the engine then cuts the feed so the chip load (bite × feed) stays near an
  // on-target pass. The feed never drops below 30%, so a full slot at a low engagement
  // is the one place that floor, not the target, is the bound.
  for (const shape of [...OPEN_SHAPES, NARROW_L]) {
    for (const pct of [20, 40, 60]) {
      it(`${shape.name} at ${pct}%: no full-width bite at full feed, and slowed bites keep the chip load`, () => {
        const s = D * pct / 100
        const r = replay(shape, planSteps(plan(shape, { stepoverMM: s, helixEntry: false })))
        expect(Math.max(...r.fullFeedBites)).toBeLessThan(0.95 * D)
        for (const { bite, feedScale } of r.slowBites) {
          expect(bite * feedScale).toBeLessThanOrEqual(Math.max(1.4 * s, 0.3 * 1.05 * D))
        }
      })
    }
  }
})

describe('a stay-down link crosses floor that is already cut', () => {
  // A link is emitted as travel (micro-lift, travel feed) — if it ran through stock the
  // machine would plough it at rapid-ish feed. The residue allowed here is the sliver
  // between the engine's bookkeeping radius and the real tool: a few hundredths of a mm
  // of width on average, against a stepover of millimetres.
  for (const shape of [SQUARE, ISLAND, NARROW_L]) {
    it(`${shape.name}: under 0.1 mm of material per mm of link`, () => {
      const r = replay(shape, planSteps(plan(shape, { stepoverMM: 0.2 * D })))
      expect(r.linkLength).toBeGreaterThan(20)
      expect(r.linkArea / r.linkLength).toBeLessThan(0.1)
    })
  }
})

describe('entries', () => {
  it('starts the march on the rim of its helix bore, so the bore flows into the spiral', () => {
    const regions = plan(CIRCLE, { helixEntry: true })
    expect(regions[0].helixRadiusMM).toBeGreaterThan(0)
    for (const reg of regions.filter(r => r.helixRadiusMM > 0)) {
      expect(reg.helixRadiusMM).toBeLessThanOrEqual(0.9 * R)
      const [x, y] = reg.moves[0].pts[0]
      expect(Math.hypot(x - reg.helixCenter[0], y - reg.helixCenter[1])).toBeCloseTo(reg.helixRadiusMM, 6)
    }
  })

  it('plunges instead of boring when helix entry is off', () => {
    expect(plan(ISLAND, { helixEntry: false }).every(r => r.helixRadiusMM === 0)).toBe(true)
  })

  it('re-seeds in each lobe the tool cannot travel between', () => {
    const regions = plan(DUMBBELL)
    const lobes = new Set(regions.map(r => (r.helixCenter[0] < 60 ? 'left' : 'right')))
    expect([...lobes].sort()).toEqual(['left', 'right'])
  })
})

it('reports progress that only ever rises and reaches the end', () => {
  const seen: number[] = []
  plan(ISLAND, { onProgress: f => seen.push(f) })
  expect(seen.length).toBeGreaterThan(10)
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  expect(seen[seen.length - 1]).toBeGreaterThan(0.95)
})

describe('the adaptive pocket clears the whole reachable region', () => {
  // End to end: strategy → G-code → the simulator's heightfield, including the finishing
  // pass that takes the wall band the march deliberately leaves.
  for (const shape of [CIRCLE, ISLAND, NARROW_L, DUMBBELL]) {
    for (const stepoverPercent of [20, 60]) {
      for (const rampIn of [true, false]) {
        it(`${shape.name} at ${stepoverPercent}% (rampIn=${rampIn})`, () => {
          const a = auditPocket({
            boundaryD: toD(shape.boundary),
            islandDs: shape.islands.map(toD),
            tool: TOOL,
            params: pocketParams({ stepoverPercent, rampIn }),
          })
          expect(a.cellsToClear).toBeGreaterThan(1000)
          expect(a.warnings, auditSummary(a)).toEqual([])
          expect(a.uncut, auditSummary(a)).toBeLessThanOrEqual(20)
          expect(a.shallow, auditSummary(a)).toBeLessThanOrEqual(20)
          expect(a.gouged, auditSummary(a)).toBeLessThanOrEqual(20)
        })
      }
    }
  }
})

describe('the planner emits the plan faithfully', () => {
  it('lifts a link by the micro-lift, runs it as travel, and drops back to depth', () => {
    const depth = -3
    const segs = generatePocket(toD(ISLAND.boundary), TOOL, pocketParams({ islandDs: ISLAND.islands.map(toD) }))
    const travel = segs.filter(s => s.travel)
    expect(travel.length).toBeGreaterThan(0)
    for (const s of travel) expect(s.z).toBeCloseTo(depth + MICRO_LIFT_MM, 9)
    for (let i = 1; i < segs.length; i++) {
      if (segs[i - 1].travel && !segs[i].travel && !segs[i].rapid) expect(segs[i].z).toBeCloseTo(depth, 9)
    }
  })

  it('replays the same XY path at every depth pass', () => {
    const segs = generatePocket(toD(CIRCLE.boundary), TOOL, pocketParams({ depthMM: 6, stepDownMM: 3, rampIn: false }))
    const at = (z: number) => segs.filter(s => !s.rapid && !s.travel && Math.abs(s.z - z) < 1e-9).map(s => `${s.x},${s.y}`)
    const first = at(-3), second = at(-6)
    expect(first.length).toBeGreaterThan(100)
    // The deeper pass carries the finishing contour as well, so it is the first pass plus more.
    expect(second.slice(0, first.length - 50)).toEqual(first.slice(0, first.length - 50))
  })

  it("regenerates a project's old 'adaptive' operation with the adaptive2 engine", () => {
    const p = { islandDs: ISLAND.islands.map(toD) }
    const legacy = generatePocket(toD(ISLAND.boundary), TOOL, pocketParams({ ...p, strategy: 'adaptive' as PocketParams['strategy'] }))
    expect(legacy).toEqual(generatePocket(toD(ISLAND.boundary), TOOL, pocketParams(p)))
  })
})
