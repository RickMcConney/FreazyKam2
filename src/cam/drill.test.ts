import { describe, it, expect } from 'vitest'
import { generatePeckDrill, generateHelicalDrill, generateHelicalDrills } from './drill'
import type { HoleSpec, DrillParams } from './drill'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'

const EM6: Tool = {
  id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}

const params = (over: Partial<DrillParams> = {}): DrillParams =>
  ({ depthMM: 6, stepDownMM: 2, safeHeightMM: 5, ...over })

/**
 * How far from the hole centre the tool ever gets — the number that decides
 * whether a bore comes out the size it was asked for.
 *
 * An arc segment holds only its endpoint and its centre, so the whole arc has to
 * be accounted for and not just where it lands: a semicircle struck about an
 * offset centre bulges out to |centre − hole| + its own radius, which is where an
 * oversize bore would show up. Sampling the arc would be the same answer with
 * more arithmetic and a tolerance to argue about.
 */
function boreReach(segs: MotionSegment[], cx: number, cy: number): number {
  let max = 0
  for (const s of segs) {
    if (s.arc) {
      const arcR = Math.hypot(s.x - s.arc.cx, s.y - s.arc.cy)
      max = Math.max(max, Math.hypot(s.arc.cx - cx, s.arc.cy - cy) + arcR)
    } else {
      max = Math.max(max, Math.hypot(s.x - cx, s.y - cy))
    }
  }
  return max
}

/**
 * Where each hole was ENTERED, in the order they were drilled — a rapid at safe
 * height that is followed by a move to a DIFFERENT height, i.e. one going down.
 * Matching every rapid at safe height instead would also catch each retract,
 * which sits at the same XY and would double every hole.
 */
const entries = (segs: MotionSegment[], safeZ = 5) =>
  segs.filter((s, i) => s.rapid && s.z === safeZ && segs[i + 1] && segs[i + 1].z !== safeZ)
      .map((s) => [s.x, s.y])

describe('generatePeckDrill', () => {
  it('pecks: plunge, retract to the surface, plunge deeper, and only then to safe height', () => {
    // Retracting to Z0 between pecks is the chip break — it clears the flutes
    // without paying for the full climb to safe height on every peck.
    expect(generatePeckDrill([{ x: 10, y: 20 }], EM6, params())).toEqual([
      { x: 10, y: 20, z: 5, rapid: true },
      { x: 10, y: 20, z: -2, rapid: false },
      { x: 10, y: 20, z: 0, rapid: true },
      { x: 10, y: 20, z: -4, rapid: false },
      { x: 10, y: 20, z: 0, rapid: true },
      { x: 10, y: 20, z: -6, rapid: false },
      { x: 10, y: 20, z: 5, rapid: true },
    ])
  })

  it('lands exactly on the requested depth even when it is not a multiple of the step', () => {
    const z = generatePeckDrill([{ x: 0, y: 0 }], EM6, params({ depthMM: 5, stepDownMM: 2 }))
      .filter((s) => !s.rapid).map((s) => s.z)
    expect(z).toEqual([-2, -4, -5])
  })

  it('never moves in XY with the tool in the hole', () => {
    const segs = generatePeckDrill([{ x: 7, y: -3 }], EM6, params())
    expect(segs.every((s) => s.x === 7 && s.y === -3)).toBe(true)
  })

  it('drills in the given order when there is no entry hint', () => {
    const segs = generatePeckDrill([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 0 }], EM6, params({ depthMM: 2, stepDownMM: 2 }))
    expect(entries(segs).map(([x]) => x)).toEqual([0, 100, 10])
  })

  it('walks nearest-neighbour from the entry hint, which is the only free choice here', () => {
    // Emission order would cross the part twice; the holes are all the same and
    // the rapids between them are the whole cost.
    const segs = generatePeckDrill([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 0 }], EM6,
      params({ depthMM: 2, stepDownMM: 2, startNear: { x: 100, y: 0 } }))
    expect(entries(segs).map(([x]) => x)).toEqual([100, 10, 0])
  })

  it('refuses an empty point list rather than emitting nothing', () => {
    expect(() => generatePeckDrill([], EM6, params())).toThrow('No drill points specified')
  })
})

describe('generateHelicalDrill', () => {
  // helicalRadius is the wall the tool CENTRE runs at: hole radius − tool radius.
  const bore = (helicalRadius: number, over: Partial<DrillParams> = {}) =>
    generateHelicalDrill(0, 0, helicalRadius, EM6, params({ depthMM: 2, stepDownMM: 2, ...over }))

  it('enters at the rightmost point of the helix, so the G-code arc has J = 0', () => {
    // r0 = min(wall, 0.475·diameter) — just under the tool radius, so the helix
    // clears its own core and nothing has to plunge at the centre.
    const first = bore(7)[0]
    expect(first).toMatchObject({ y: 0, z: 5, rapid: true })
    expect(first.x).toBeCloseTo(2.85, 9)
  })

  it('starts at the wall itself when the hole is too small to spiral', () => {
    expect(bore(1)[0]).toMatchObject({ x: 1, y: 0 })
  })

  it('cuts every arc CCW', () => {
    // G3 throughout: an inside bore climb-cuts counter-clockwise.
    expect(bore(7).filter((s) => s.arc).every((s) => s.arc!.cw === false)).toBe(true)
  })

  it('reaches the wall exactly and never goes past it', () => {
    // Short is stock left in a hole that will not fit its dowel; long is an
    // oversize hole. Neither is visible in the segment list without accounting
    // for the bulge of each arc.
    for (const wall of [1, 3, 7, 20, 50]) {
      expect(boreReach(bore(wall), 0, 0)).toBeCloseTo(wall, 9)
    }
  })

  it('grows the radius monotonically, never more than the stepover per revolution', () => {
    // The spiral arcs are the ones struck about an offset centre.
    const crossings = bore(20).filter((s) => s.arc && s.arc.cx !== 0).map((s) => Math.abs(s.x))
    for (let i = 1; i < crossings.length; i++) {
      expect(crossings[i]).toBeGreaterThan(crossings[i - 1])
    }
    // Two semicircles per revolution, so a full turn grows by 2 × the half-step,
    // and that must stay inside 40% of the tool diameter.
    const perRev = crossings[2] - crossings[0]
    expect(perRev).toBeLessThanOrEqual(EM6.diameterMM * 0.4 + 1e-9)
  })

  it('finishes with a full flat circle at the wall, then retracts from it', () => {
    const segs = bore(7)
    const last = segs[segs.length - 1]
    const finish = segs[segs.length - 2]
    // The wall only ever sees this one light circular cut — the spiral never
    // plunges radially into fresh stock at full width.
    expect(finish).toMatchObject({ x: 7, y: 0, z: -2, rapid: false })
    expect(finish.arc).toEqual({ cx: 0, cy: 0, cw: false })
    expect(last).toEqual({ x: 7, y: 0, z: 5, rapid: true })
  })

  it('returns to the helix start at depth between passes instead of lifting', () => {
    const segs = bore(7, { depthMM: 4, stepDownMM: 2 })
    // The one non-arc cutting move: back across already-cleared stock at −2,
    // ready to descend again. A rapid there would be a rapid through material.
    const links = segs.filter((s) => !s.rapid && !s.arc)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ y: 0, z: -2, rapid: false })
    expect(links[0].x).toBeCloseTo(2.85, 9)
    // Three rapids in the whole bore and no more: down to safe height, down to the
    // surface, and out at the end. Nothing lifts between passes.
    expect(segs.filter((s) => s.rapid)).toHaveLength(3)
  })

  it('bores each depth pass down to the requested depth', () => {
    const z = [...new Set(bore(7, { depthMM: 6, stepDownMM: 2 }).filter((s) => !s.rapid).map((s) => s.z))]
    expect(z.sort((a, b) => b - a)).toEqual([-2, -4, -6])
  })

  it('falls back to a peck at the centre when the tool is wider than the hole', () => {
    // No arcs at all — there is no room to spiral, and a hole the size of the
    // tool is exactly what a plunge makes.
    const segs = generateHelicalDrill(5, 5, -1, EM6, params({ depthMM: 2, stepDownMM: 2 }))
    expect(segs.some((s) => s.arc)).toBe(false)
    expect(segs.every((s) => s.x === 5 && s.y === 5)).toBe(true)
  })
})

describe('generateHelicalDrills', () => {
  const holes = (...specs: [number, number, number][]): HoleSpec[] =>
    specs.map(([cx, cy, radiusMM]) => ({ cx, cy, radiusMM }))

  it('bores every hole in the list — one path is not one hole', () => {
    // A pinion's pin ring is eight round subpaths under one id. Deriving one
    // circle from the whole path's bbox bored a single hole the size of the ring.
    const segs = generateHelicalDrills(holes([0, 0, 10], [50, 0, 10], [0, 50, 10]), EM6, params({ depthMM: 2, stepDownMM: 2 }))
    expect(entries(segs)).toHaveLength(3)
    expect(segs.filter((s) => s.rapid)).toHaveLength(9) // safe + surface + retract per hole
    for (const [cx, cy] of [[0, 0], [50, 0], [0, 50]]) {
      const own = segs.filter((s) => Math.hypot(s.x - cx, s.y - cy) <= 7.001)
      expect(boreReach(own, cx, cy)).toBeCloseTo(7, 6)
    }
  })

  it('converts hole radius to a tool-centre radius', () => {
    // A Ø20 hole with a Ø6 cutter runs the centre round a 7 mm circle.
    expect(boreReach(generateHelicalDrills(holes([0, 0, 10]), EM6, params({ depthMM: 2, stepDownMM: 2 })), 0, 0))
      .toBeCloseTo(7, 9)
  })

  it('orders the holes nearest-neighbour from the entry hint', () => {
    const segs = generateHelicalDrills(holes([0, 0, 10], [50, 0, 10], [5, 0, 10]), EM6,
      params({ depthMM: 2, stepDownMM: 2, startNear: { x: 50, y: 0 } }))
    // Each bore enters at its own centre + r0 (2.85 mm for this tool).
    expect(entries(segs).map(([x]) => Math.round(x))).toEqual([53, 8, 3])
  })

  it('keeps the given order when there is no hint', () => {
    const segs = generateHelicalDrills(holes([0, 0, 10], [50, 0, 10], [5, 0, 10]), EM6, params({ depthMM: 2, stepDownMM: 2 }))
    expect(entries(segs).map(([x]) => Math.round(x))).toEqual([3, 53, 8])
  })

  it('drills the undersized holes of a mixed set instead of dropping them', () => {
    // Ø4 with a Ø6 cutter cannot be bored; it still has to come out drilled.
    const segs = generateHelicalDrills(holes([0, 0, 10], [50, 0, 2]), EM6, params({ depthMM: 2, stepDownMM: 2 }))
    const small = segs.filter((s) => s.x > 40)
    expect(small.length).toBeGreaterThan(0)
    expect(small.some((s) => s.arc)).toBe(false)
    expect(small.every((s) => s.x === 50 && s.y === 0)).toBe(true)
  })

  it('refuses an empty hole list', () => {
    expect(() => generateHelicalDrills([], EM6, params())).toThrow('No holes specified')
  })
})

describe('drilling and the start surface', () => {
  it('measures peck depth from the surface the hole starts on', () => {
    // 5 mm of hole from the floor of a 3 mm pocket bottoms out at −8. Measuring
    // from stock top instead gave a hole 3 mm shallower than the one asked for —
    // safe, because the plunge only ever descends through cleared air, and
    // therefore silent.
    const z = generatePeckDrill([{ x: 0, y: 0 }], EM6, params({ depthMM: 5, stepDownMM: 5, startZMM: -3 }))
      .filter((s) => !s.rapid).map((s) => s.z)
    expect(z).toEqual([-8])
  })

  it('pecks back out to that surface, not to stock top', () => {
    // The chip break is about clearing the flutes, so it retracts to the ground
    // the hole is being drilled from.
    const segs = generatePeckDrill([{ x: 0, y: 0 }], EM6, params({ depthMM: 4, stepDownMM: 2, startZMM: -3 }))
    expect(segs.map((s) => s.z)).toEqual([5, -5, -3, -7, 5])
  })

  it('measures helical depth from it too', () => {
    const z = generateHelicalDrill(0, 0, 7, EM6, params({ depthMM: 5, stepDownMM: 5, startZMM: -3 }))
      .filter((s) => !s.rapid).map((s) => s.z)
    expect(Math.min(...z)).toBeCloseTo(-8, 9)
  })

  it('rapids down to the start surface before the helix, rather than ramping through air', () => {
    // The helical descent spends exactly one revolution however far it has to
    // drop, so starting it at safe height above a deep floor would ramp into the
    // material several times steeper than the pass that follows it.
    const segs = generateHelicalDrill(0, 0, 7, EM6, params({ depthMM: 2, stepDownMM: 2, startZMM: -6 }))
    expect(segs[0]).toMatchObject({ z: 5, rapid: true })
    expect(segs[1]).toMatchObject({ z: -6, rapid: true })
    expect(segs[2]).toMatchObject({ z: -8, rapid: false })
    expect(segs[2].arc).toBeTruthy()
  })

  it('ignores a positive start height — nothing starts above the stock', () => {
    const z = generatePeckDrill([{ x: 0, y: 0 }], EM6, params({ depthMM: 5, stepDownMM: 5, startZMM: 3 }))
      .filter((s) => !s.rapid).map((s) => s.z)
    expect(z).toEqual([-5])
  })

  it('drills from stock top when no start height is given', () => {
    // Every project saved before this parameter existed must emit what it did.
    const z = generatePeckDrill([{ x: 0, y: 0 }], EM6, params({ depthMM: 5, stepDownMM: 5 }))
      .filter((s) => !s.rapid).map((s) => s.z)
    expect(z).toEqual([-5])
  })
})
