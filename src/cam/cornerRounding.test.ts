import { describe, it, expect, beforeEach } from 'vitest'
import { roundInsideCorners, withinTolerance, dropSpikes } from './cornerRounding'
import { generateProfile, type ProfileParams } from './profile'
import { generateGcode } from './gcode'
import { pointInPolygon } from './geom'
import { parseGcode } from '../sim/gcodeParser'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { Pt2 } from './pathFlattener'
import type { Tool } from '../store/toolStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import type { AnyOperation } from '../store/toolpathStore'

// Tool-centre rings, CCW, as profile.ts hands them over.
const SQUARE: Pt2[] = [[0, 0], [20, 0], [20, 20], [0, 20]]
// An L: five convex corners and ONE reflex (inside) corner, at (10,10).
const ELL: Pt2[] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]]
// A 60° V notch cut into the top edge: its bottom (10,11.34) is a sharp reflex corner.
const VEE: Pt2[] = [[0, 0], [20, 0], [20, 20], [12, 20], [10, 16.536], [8, 20], [0, 20]]

const minDistTo = (p: Pt2, ring: Pt2[]) => {
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy))
  }
  return best
}

describe('roundInsideCorners — which corners, and which way', () => {
  it('outside profile: rounds the dent at the part\'s inside corner, moving the path AWAY from the part', () => {
    const { rings, rhoMM } = roundInsideCorners([ELL], 'outside', 0.2)
    expect(rhoMM).toBeGreaterThan(0)
    // The path only moves outward: nothing of it lies inside the original region by more
    // than the 2 µm the rounding circles are drawn to.
    for (const p of rings[0]) expect(pointInPolygon(p[0], p[1], ELL) && minDistTo(p, ELL) > 0.0025).toBe(false)
    // The reflex corner itself is no longer on the path…
    expect(minDistTo([10, 10], rings[0])).toBeGreaterThan(0.01)
    // …and every convex corner still is, to within a few microns: the grow step draws each
    // corner's circle as chords, and shrinking them back bevels the point by ~4 µm.
    for (const c of [[0, 0], [20, 0], [20, 10], [10, 20], [0, 20]] as Pt2[]) expect(minDistTo(c, rings[0])).toBeLessThan(0.005)
  })

  it('inside profile: trims the corners reaching into the hole, moving the path AWAY from the walls', () => {
    const { rings, rhoMM } = roundInsideCorners([SQUARE], 'inside', 0.2)
    expect(rhoMM).toBeGreaterThan(0)
    // The path only moves inward: all of it lies inside the original ring.
    for (const p of rings[0]) expect(pointInPolygon(p[0], p[1], SQUARE) || minDistTo(p, SQUARE) < 0.0025).toBe(true)
    for (const c of SQUARE) expect(minDistTo(c, rings[0])).toBeGreaterThan(0.01)
  })

  it('moves no point of the path further than the tolerance — and uses as much of it as it may', () => {
    for (const [ring, side] of [[ELL, 'outside'], [SQUARE, 'inside'], [VEE, 'outside']] as const) {
      const { rings } = roundInsideCorners([ring], side, 0.2)
      expect(withinTolerance([ring], rings, 0.2 + 1e-6)).toBe(true)
      expect(withinTolerance([ring], rings, 0.15)).toBe(false)
    }
  })

  it('rounds a right angle by ρ = tol / (√2 − 1), the most a 90° corner allows', () => {
    const { rhoMM } = roundInsideCorners([SQUARE], 'inside', 0.2)
    expect(rhoMM).toBeCloseTo(0.2 / (Math.SQRT2 - 1), 1)
  })

  it('rounds a sharper corner by less, for the same tolerance', () => {
    const right = roundInsideCorners([ELL], 'outside', 0.2).rhoMM
    const vee = roundInsideCorners([VEE], 'outside', 0.2).rhoMM
    expect(vee).toBeLessThan(right)
    // A 60° V: the apex moves ρ(1/sin 30° − 1) = ρ, so ρ is the tolerance itself.
    expect(vee).toBeCloseTo(0.2, 1)
  })

  it('does not fill a channel narrower than the rounding — the tolerance still binds', () => {
    // A 0.3 mm slot 5 mm deep: closing by even 0.2 would bridge it. The deviation check
    // holds ρ down to what keeps the slot's floor within tolerance.
    const slot: Pt2[] = [[0, 0], [20, 0], [20, 20], [10.15, 20], [10.15, 15], [9.85, 15], [9.85, 20], [0, 20]]
    const { rings } = roundInsideCorners([slot], 'outside', 0.2)
    expect(withinTolerance([slot], rings, 0.2 + 1e-6)).toBe(true)
    expect(minDistTo([10, 15], rings[0])).toBeLessThanOrEqual(0.2 + 1e-6)
  })

  it('leaves a smooth outward curve as it was — an escape wheel\'s tooth tip', () => {
    // A tip rounded at r = 2 in 3–7° steps, between two straight flanks that meet the rest
    // of the wheel in sharp inside corners (which DO get rounded). Growing it with a mitred
    // join and shrinking it back replaced part of such a tip with a straight chord and an
    // 88° corner.
    const tip: Pt2[] = [[0, 0], [30, 0], [30, 10]]
    for (let k = 0; k <= 36; k++) {
      const a = -Math.PI / 2 + (k / 36) * Math.PI
      tip.push([32 + 2 * Math.cos(a) * (1 + 0.01 * (k % 3)), 12 + 2 * Math.sin(a)])
    }
    tip.push([30, 14], [30, 30], [0, 30])
    const { rings, rhoMM } = roundInsideCorners([tip], 'outside', 0.2)
    expect(rhoMM).toBeGreaterThan(0)
    const curve = tip.slice(3, 40)
    for (const p of curve) expect(minDistTo(p, rings[0])).toBeLessThan(0.005)
    // …and nothing on it turns sharply: a machine takes it without stopping.
    const r = rings[0]
    for (let i = 0; i < r.length; i++) {
      const a = r[(i - 1 + r.length) % r.length], b = r[i], c = r[(i + 1) % r.length]
      if (Math.hypot(b[0] - 32, b[1] - 12) > 2.5) continue
      const t = (Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])) * 180 / Math.PI
      expect(Math.abs(((t + 540) % 360) - 180)).toBeLessThan(30)
    }
  })

  it('leaves the rings alone with no tolerance', () => {
    expect(roundInsideCorners([ELL], 'outside', 0)).toEqual({ rings: [ELL], rhoMM: 0 })
  })
})

describe('dropSpikes — the hooks offsetting leaves behind', () => {
  it('removes a vertex that doubles back across a tiny edge, moving the path no further than that edge', () => {
    // The shape of the one an escape wheel's rounding left: 0.013 mm, turning back 100°.
    const hooked: Pt2[] = [[0, 0], [10, 0], [10.0022, 0.0128], [10.5, 3], [0, 3]]
    const clean = dropSpikes(hooked)
    expect(clean.length).toBe(4)
    for (const p of hooked) expect(minDistTo(p, clean)).toBeLessThanOrEqual(0.013)
    // No sharp turn across a short edge is left.
    expect(dropSpikes(clean)).toEqual(clean)
  })

  it('leaves a real rounding arc alone, however short its chords', () => {
    const arc: Pt2[] = [[0, 0], [5, 0]]
    for (let k = 1; k < 12; k++) {
      const a = -Math.PI / 2 + (k / 12) * (Math.PI / 2)
      arc.push([5 + 0.3 * Math.cos(a), 0.3 + 0.3 * Math.sin(a)])
    }
    arc.push([5.3, 0.3], [5.3, 5], [0, 5])
    expect(dropSpikes(arc)).toEqual(arc)
  })

  it('drops points that repeat the one before', () => {
    expect(dropSpikes([[0, 0], [10, 0], [10, 0], [10, 5], [0, 5]])).toEqual([[0, 0], [10, 0], [10, 5], [0, 5]])
  })
})

// ─── End to end: the corner the machine no longer has to stop for ─────────────

describe('a profile with rounded inside corners', () => {
  const EM3: Tool = {
    id: 'em3', name: '3mm End Mill', type: 'endmill', diameterMM: 3, fluteCount: 1,
    rpm: 18000, xyFeedMmMin: 1200, zFeedMmMin: 300, maxDepthMM: 12,
  }
  const POST: PostProcessorProfile = {
    id: 'p', name: 'P', unitMode: 'mm', commentStyle: 'semicolon',
    startGcode: 'G21\nG90', endGcode: 'M5\nG0 Z10\nM30', toolChangeGcode: 'M5\nM0',
    spindleOnTemplate: 'M3 S{s}', spindleOffGcode: 'M5',
    rapidTemplate: 'G0 X{x} Y{y} Z{z}', cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
    arcCWTemplate: 'G2 X{x} Y{y} Z{z} I{i} J{j} F{f}', arcCCWTemplate: 'G3 X{x} Y{y} Z{z} I{i} J{j} F{f}',
    outputArcs: true,
  }
  const LIM = { accelXYMmS2: 200, accelZMmS2: 50, maxRateXYMmMin: 4000, maxRateZMmMin: 400, junctionDeviationMM: 0.04 }
  // A 40 mm square hole: four inside corners for an inside profile.
  const HOLE = 'M 10 10 L 50 10 L 50 50 L 10 50 Z'
  const params = (over: Partial<ProfileParams> = {}): ProfileParams => ({
    side: 'inside', depthMM: 1, stepDownMM: 1, direction: 'climb', safeHeightMM: 5, ...over,
  })

  beforeEach(() => {
    useWorkpieceStore.setState({ origin: 'bottom-left', zOrigin: 'top', widthMM: 100, heightMM: 100, thicknessMM: 5, autoFeedEnabled: false, maxFeedMmMin: 0 })
  })

  function slowestCornerMmMin(cornerToleranceMM: number): { speed: number; gcode: string } {
    const segments = generateProfile(HOLE, EM3, params({ cornerToleranceMM }))
    const op = { id: 'o', name: 'P', type: 'profile', toolId: 'em3', pathId: 'p', side: 'inside', depthMM: 1, stepDownMM: 1,
      direction: 'climb', rampIn: false, status: 'done', segments, color: '#fff', visible: true } as AnyOperation
    const gcode = generateGcode([op], { em3: EM3 }, 'x', POST)
    const p = parseGcode(gcode, 5, LIM)
    // Slowest junction on the cut at depth, from the end of the first full side on — before
    // that the tool is still getting up to speed from the plunge, and the last move stops
    // for the retract. Every corner after the first side is a corner run at speed.
    const cut = p.segments.filter((s) => !s.rapid && s.z < -0.5 && s.prevZ < -0.5)
    const firstSide = cut.findIndex((s) => Math.hypot(s.x - s.prevX, s.y - s.prevY) > 10)
    return { speed: Math.min(...cut.slice(firstSide + 1, -1).map((s) => s.v0! * 60)), gcode }
  }

  it('writes each inside corner as a G2/G3 arc the machine carries its feed through', () => {
    const sharp = slowestCornerMmMin(0)
    const round = slowestCornerMmMin(0.2)
    expect(sharp.speed).toBeLessThan(400)          // a square corner: nearly a stop
    expect(round.speed).toBeGreaterThan(1000)      // rounded: most of the feed kept
    expect((round.gcode.match(/^G[23] /gm) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it('never cuts into the part — the rounded path keeps at least the tool radius from every wall', () => {
    const segments = generateProfile(HOLE, EM3, params({ cornerToleranceMM: 0.2 }))
    const wall: Pt2[] = [[10, 10], [50, 10], [50, 50], [10, 50]]
    let prev = segments[0], closest = Infinity, furthest = 0
    for (const q of segments) {
      if (!q.rapid && q.z < -0.5 && prev.z < -0.5) {
        const pts: Pt2[] = []
        if (q.arc) {
          const { cx, cy, cw } = q.arc
          const R = Math.hypot(prev.x - cx, prev.y - cy)
          let a0 = Math.atan2(prev.y - cy, prev.x - cx), a1 = Math.atan2(q.y - cy, q.x - cx)
          if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI } else if (a1 <= a0) a1 += 2 * Math.PI
          for (let k = 1; k <= 16; k++) pts.push([cx + R * Math.cos(a0 + ((a1 - a0) * k) / 16), cy + R * Math.sin(a0 + ((a1 - a0) * k) / 16)])
        } else pts.push([q.x, q.y])
        for (const p of pts) {
          const d = minDistTo(p, wall)
          closest = Math.min(closest, d)
          // Only the corners move; along a wall the path sits at exactly the radius.
          furthest = Math.max(furthest, d)
        }
      }
      prev = q
    }
    // Within the 10 µm the rounded passes are fitted to (profile.ts FINE_FIT_TOL_MM).
    expect(closest).toBeGreaterThanOrEqual(1.5 - 0.0105)
    // A corner point's distance to the NEAREST wall stays under the radius + tolerance too.
    expect(furthest).toBeLessThanOrEqual(1.5 + 0.2 + 0.002)
  })

  it('hands the G-code writer its corners as exact moves, which it passes through unrefitted', () => {
    const segments = generateProfile(HOLE, EM3, params({ cornerToleranceMM: 0.2 }))
    const cut = segments.filter((s) => !s.rapid && s.z < -0.5)
    expect(cut.filter((s) => s.arc).every((s) => s.exact)).toBe(true)
    const { gcode } = slowestCornerMmMin(0.2)
    // Each generated corner arc reaches the file as an arc of the same radius.
    const radii = [...gcode.matchAll(/^G[23] .*I(-?[\d.]+) J(-?[\d.]+)/gm)].map((m) => Math.hypot(+m[1], +m[2]))
    const corner = radii.filter((r) => r < 5)
    expect(corner.length).toBeGreaterThanOrEqual(4)
    for (const r of corner) expect(r).toBeCloseTo(0.2 / (Math.SQRT2 - 1), 1)
  })

  it('stays off for a profile saved before the option — no tolerance, no change', () => {
    expect(generateProfile(HOLE, EM3, params())).toEqual(generateProfile(HOLE, EM3, params({ cornerToleranceMM: 0 })))
  })

  it('ignores the tolerance on a centerline cut, which has no part side to back away from', () => {
    expect(generateProfile(HOLE, EM3, params({ side: 'centerline', cornerToleranceMM: 0.2 })))
      .toEqual(generateProfile(HOLE, EM3, params({ side: 'centerline' })))
  })
})
