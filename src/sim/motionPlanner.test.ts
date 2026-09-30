import { describe, it, expect } from 'vitest'
import {
  planMotion, trapezoid, trapezoidAt, lengthBelowSpeed, ARC_TOLERANCE_MM, PLANNER_BLOCKS,
  type MotionLimits, type PlanBlock,
} from './motionPlanner'
import { parseGcode, segFeedAt, segFraction } from './gcodeParser'

// A hobby machine: 100 mm/s² in XY, 25 in Z, Z capped at 200 mm/min, Grbl's default 0.01.
const LIM: MotionLimits = {
  accelXYMmS2: 100, accelZMmS2: 25, maxRateXYMmMin: 4000, maxRateZMmMin: 200, junctionDeviationMM: 0.01,
}
const line = (dx: number, dy: number, dz: number, feed: number, over: Partial<PlanBlock> = {}): PlanBlock =>
  ({ dx, dy, dz, feedMmMin: feed, rapid: false, arcRadiusMM: 0, arcId: -1, stopBefore: false, ...over })

// Grbl's junction speed for a corner of `turnDeg` between two XY moves.
function grblCornerSpeed(turnDeg: number, a: number, jd: number): number {
  const phi = (turnDeg * Math.PI) / 180
  const cosT = -Math.cos(phi)
  const s = Math.sqrt(0.5 * (1 - cosT))
  // The junction vector bisects the turn; a 90° turn in X then Y points it diagonally, so
  // the per-axis limit allows a/cos45° along it.
  const jAngle = Math.PI / 2 + phi / 2
  const aj = Math.min(a / Math.abs(Math.cos(jAngle)), a / Math.abs(Math.sin(jAngle)))
  return Math.sqrt((aj * jd * s) / (1 - s))
}

describe('planMotion — a single move', () => {
  it('reaches the feed on a long move, ramping up and down at the acceleration limit', () => {
    // From rest to rest: time = L/v + v/a.
    const [tr] = planMotion([line(100, 0, 0, 1200)], LIM)
    const v = 20
    expect(tr.vc).toBeCloseTo(v, 9)
    expect(tr.durationS).toBeCloseTo(100 / v + v / 100, 9)
  })

  it('never reaches the feed on a move shorter than it takes to get there and back', () => {
    // 2 mm to reach 20 mm/s at 100 mm/s², 2 more to stop: a 2 mm move peaks at √(a·L).
    const [tr] = planMotion([line(2, 0, 0, 1200)], LIM)
    expect(tr.vc).toBeCloseTo(Math.sqrt(100 * 2), 9)
    expect(tr.vc).toBeLessThan(20)
    expect(tr.durationS).toBeCloseTo(2 * Math.sqrt(2 / 100), 9)
  })

  it('caps a move\'s feed by every axis it uses — a ramp is held to Z\'s max rate', () => {
    // 10 mm in X while dropping 1 mm: Z at 200 mm/min limits the whole move to ~33 mm/s × 10…
    // i.e. the XY speed is dragged down to 200 × L / |dz|.
    const [tr] = planMotion([line(10, 0, -1, 1200)], { ...LIM, accelXYMmS2: 1e9, accelZMmS2: 1e9 })
    const L = Math.hypot(10, 1)
    expect(tr.vc * 60).toBeCloseTo(Math.min(1200, (200 * L) / 1), 6)
    const [steep] = planMotion([line(1, 0, -1, 1200)], { ...LIM, accelXYMmS2: 1e9, accelZMmS2: 1e9 })
    expect(steep.vc * 60).toBeCloseTo(200 * Math.SQRT2, 6)
  })

  it('runs a rapid at the machine\'s max rate, not a fixed figure', () => {
    const [tr] = planMotion([line(1000, 0, 0, 0, { rapid: true })], { ...LIM, accelXYMmS2: 1e9 })
    expect(tr.vc * 60).toBeCloseTo(4000, 6)
  })

  it('with acceleration off, runs every move at its feed — the old constant-speed timing', () => {
    const plan = planMotion([line(10, 0, 0, 600), line(0, 10, 0, 600)], { ...LIM, accelXYMmS2: 0 })
    for (const tr of plan) { expect(tr.vc).toBe(10); expect(tr.durationS).toBeCloseTo(1, 9) }
  })
})

describe('planMotion — junctions', () => {
  it('takes a square corner at exactly the junction-deviation speed', () => {
    const plan = planMotion([line(100, 0, 0, 1200), line(0, 100, 0, 1200)], LIM)
    expect(plan[0].v1).toBeCloseTo(grblCornerSpeed(90, 100, 0.01), 9)
    expect(plan[1].v0).toBe(plan[0].v1)
    expect(plan[0].v1 * 60).toBeLessThan(150)   // ~107 mm/min: nearly a stop
  })

  it('takes a corner faster as the junction deviation grows, by its square root', () => {
    const at = (jd: number) => planMotion([line(100, 0, 0, 1200), line(0, 100, 0, 1200)], { ...LIM, junctionDeviationMM: jd })[0].v1
    expect(at(0.04) / at(0.01)).toBeCloseTo(2, 9)
  })

  it('carries full speed straight on, and stops dead for a reversal', () => {
    const straight = planMotion([line(50, 0, 0, 1200), line(50, 0, 0, 1200)], LIM)
    expect(straight[0].v1).toBeCloseTo(20, 9)
    const back = planMotion([line(50, 0, 0, 1200), line(-50, 0, 0, 1200)], LIM)
    expect(back[0].v1).toBe(0)
  })

  it('brakes in time: a move never arrives faster than it can stop for the next junction', () => {
    const plan = planMotion([line(100, 0, 0, 1200), line(1, 0, 0, 1200), line(0, 100, 0, 1200)], LIM)
    // The 1 mm move must shed speed to the corner within its own length.
    expect(plan[1].v0 ** 2).toBeLessThanOrEqual(plan[1].v1 ** 2 + 2 * 100 * 1 + 1e-9)
  })

  it('speeds up no faster than it can: a short first move leaves below full speed', () => {
    // From rest, 1 mm at 100 mm/s² reaches √(2·a·L) — nothing lets the next move start
    // any faster, however straight the junction.
    const plan = planMotion([line(1, 0, 0, 1200), line(100, 0, 0, 1200)], LIM)
    expect(plan[0].v1).toBeCloseTo(Math.sqrt(2 * 100 * 1), 9)
    expect(plan[1].v0).toBe(plan[0].v1)
  })

  it('starts from rest after anything that makes the controller drain its buffer', () => {
    const plan = planMotion([line(100, 0, 0, 1200), line(100, 0, 0, 1200, { stopBefore: true })], LIM)
    expect(plan[0].v1).toBe(0)
    expect(plan[1].v0).toBe(0)
  })

  it('prices an arc by the CONTROLLER\'s chords, however finely the simulator drew it', () => {
    // A quarter circle of r = 5 at F1200, drawn with 10 chords and with 100.
    const arc = (n: number) => Array.from({ length: n }, (_, k) => {
      const a0 = (k / n) * Math.PI / 2, a1 = ((k + 1) / n) * Math.PI / 2
      return line(5 * (Math.cos(a1) - Math.cos(a0)), 5 * (Math.sin(a1) - Math.sin(a0)), 0, 1200, { arcRadiusMM: 5, arcId: 0 })
    })
    const coarse = planMotion([line(50, 0, 0, 1200, { dx: 0, dy: -50 }), ...arc(10)], LIM)
    const fine = planMotion([line(50, 0, 0, 1200, { dx: 0, dy: -50 }), ...arc(100)], LIM)
    // The junction inside the arc is the same speed at either resolution.
    expect(coarse[5].v0).toBeCloseTo(fine[50].v0, 9)
    // And it is the junction rule at the controller's chord angle.
    const seg = 2 * Math.asin(Math.sqrt(ARC_TOLERANCE_MM * (2 * 5 - ARC_TOLERANCE_MM)) / 5)
    const c = Math.cos(seg / 2)
    expect(coarse[5].v0).toBeCloseTo(Math.min(20, Math.sqrt((100 * 0.01 * c) / (1 - c))), 9)
  })

  it('cannot plan further ahead than the controller\'s buffer: a run of tiny moves is held down', () => {
    // 2000 collinear 0.01 mm moves — no junction limits at all — but the controller only
    // sees PLANNER_BLOCKS of them, and must be able to stop within those — so every move
    // is ENTERED no faster than that. (Within a 0.01 mm move it may gain a hair on top.)
    const plan = planMotion(Array.from({ length: 2000 }, () => line(0.01, 0, 0, 1200)), LIM)
    const cap = Math.sqrt(2 * 100 * PLANNER_BLOCKS * 0.01)
    expect(Math.max(...plan.map((t) => t.v0))).toBeLessThanOrEqual(cap + 1e-9)
    expect(Math.max(...plan.map((t) => t.v0))).toBeCloseTo(cap, 6)
    expect(cap).toBeLessThan(20)
  })
})

describe('the trapezoid inside a move', () => {
  const L = 10
  const tr = trapezoid(L, 2, 4, 20, 100)

  it('covers the whole move in its own duration, and never runs backwards', () => {
    expect(trapezoidAt(tr, L, tr.durationS).dist).toBeCloseTo(L, 9)
    let last = -1
    for (let k = 0; k <= 50; k++) {
      const d = trapezoidAt(tr, L, (k / 50) * tr.durationS).dist
      expect(d).toBeGreaterThanOrEqual(last - 1e-12)
      last = d
    }
  })

  it('enters and leaves at the speeds it was planned for', () => {
    expect(trapezoidAt(tr, L, 0).speed).toBeCloseTo(2, 9)
    expect(trapezoidAt(tr, L, tr.durationS).speed).toBeCloseTo(4, 9)
  })

  it('measures the length run below a speed from the ramps alone', () => {
    // Below 10 mm/s: from 2 up to 10, and from 10 down to 4.
    expect(lengthBelowSpeed(tr, L, 10)).toBeCloseTo((100 - 4) / 200 + (100 - 16) / 200, 9)
    expect(lengthBelowSpeed(tr, L, 1)).toBe(0)
    expect(lengthBelowSpeed(tr, L, 1000)).toBe(L)
  })
})

describe('parseGcode with motion limits', () => {
  it('times a program by the planner, and the tool follows the ramp, not a constant speed', () => {
    const { segments, totalTimeS } = parseGcode('G21 G90\nG1 X100 Y0 Z5 F1200', 5, LIM)
    expect(totalTimeS).toBeCloseTo(100 / 20 + 20 / 100, 9)
    // A quarter of the way through the TIME, the tool has covered less than a quarter of
    // the distance — it spent the start of it accelerating.
    const seg = segments[0]
    expect(segFraction(seg, totalTimeS / 4)).toBeLessThan(0.25)
    expect(segFeedAt(seg, 0)).toBe(0)
    expect(segFeedAt(seg, totalTimeS / 2)).toBeCloseTo(1200, 6)
  })

  it('starts from rest again after a spindle change', () => {
    const { segments } = parseGcode('G21 G90\nG1 X50 F1200\nM5\nG1 X100 F1200', 5, LIM)
    expect(segments[0].v1).toBe(0)
    expect(segments[1].v0).toBe(0)
    const joined = parseGcode('G21 G90\nG1 X50 F1200\nG1 X100 F1200', 5, LIM).segments
    expect(joined[0].v1).toBeCloseTo(20, 9)
  })

  it('without limits, keeps the programmed-feed timing it always had', () => {
    const { totalTimeS, segments } = parseGcode('G21 G90\nG1 X100 F1200')
    expect(totalTimeS).toBeCloseTo(5, 9)
    expect(segments[0].acc).toBeUndefined()
  })
})
