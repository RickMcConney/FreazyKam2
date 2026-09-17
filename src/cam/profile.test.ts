import { describe, it, expect } from 'vitest'
import { generateProfile, polylinePassWithTabs, designPathAtT, nearestArcLen } from './profile'
import { arcLengths } from './geom'
import { signedArea } from './pathFlattener'
import type { Pt2 } from './pathFlattener'
import type { Tool } from '../store/toolStore'
import type { Tab } from '../store/tabStore'
import type { MotionSegment } from '../store/toolpathStore'
import type { ProfileParams } from './profile'

const EM6: Tool = {
  id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const V60: Tool = {
  id: 'v60', name: '60° V-Bit', type: 'vbit', diameterMM: 6.35, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 10, vbitAngleDeg: 60,
}
const BALL6: Tool = {
  id: 'b6', name: '6mm Ball Nose', type: 'ballnose', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20,
}

// A 40 mm square from (10,10) to (50,50). Deliberately a square and not a circle:
// fitCircle needs ≥ 8 points, so a 4-sided loop always takes the generic polygon
// branch. The circle fast path gets its own block below.
const SQ = 'M 10 10 L 50 10 L 50 50 L 10 50 Z'

const params = (over: Partial<ProfileParams> = {}): ProfileParams => ({
  side: 'outside', depthMM: 3, stepDownMM: 3, direction: 'climb', safeHeightMM: 5, ...over,
})

const cuts = (segs: MotionSegment[]) => segs.filter((s) => !s.rapid)

/** XY extent of the cutting moves — i.e. where the tool centre actually travels. */
function cutBox(segs: MotionSegment[]) {
  const c = cuts(segs)
  return {
    x0: Math.min(...c.map((s) => s.x)), x1: Math.max(...c.map((s) => s.x)),
    y0: Math.min(...c.map((s) => s.y)), y1: Math.max(...c.map((s) => s.y)),
  }
}

/** How far the toolpath stands outside the 40 mm design square, in mm. */
const standoff = (segs: MotionSegment[]) => cutBox(segs).x1 - 50

/** Signed area of the cut loop: > 0 is CCW, < 0 is CW (CNC Y-up). */
const loopArea = (segs: MotionSegment[]) =>
  signedArea(cuts(segs).map((s) => [s.x, s.y] as Pt2))

const tab = (over: Partial<Tab> = {}): Tab =>
  ({ id: 'tab1', pathId: 'p1', t: 0.5, lengthMM: 10, heightMM: 2, ...over }) as Tab

describe('designPathAtT', () => {
  // An L: 10 mm along X then 10 mm up Y, so t is half-way at the corner.
  const L: Pt2[][] = [[[0, 0], [10, 0], [10, 10]]]

  it('walks arc length, not point index', () => {
    expect(designPathAtT(L, 0)).toEqual([0, 0])
    expect(designPathAtT(L, 0.25)).toEqual([5, 0])
    expect(designPathAtT(L, 0.5)).toEqual([10, 0])
    expect(designPathAtT(L, 0.75)).toEqual([10, 5])
    expect(designPathAtT(L, 1)).toEqual([10, 10])
  })

  it('spans several subpaths as one continuous length', () => {
    const two: Pt2[][] = [[[0, 0], [10, 0]], [[100, 0], [110, 0]]]
    // Total 20 mm: t=0.25 is mid-way along the first, t=0.75 mid-way along the second.
    expect(designPathAtT(two, 0.25)).toEqual([5, 0])
    expect(designPathAtT(two, 0.75)).toEqual([105, 0])
  })

  it('returns null for a path with no length', () => {
    expect(designPathAtT([[[5, 5]]], 0.5)).toBeNull()
  })
})

describe('nearestArcLen', () => {
  const pts: Pt2[] = [[0, 0], [10, 0], [20, 0]]
  const { lens } = arcLengths(pts)

  it('projects a point off the line onto its arc length', () => {
    expect(nearestArcLen(pts, lens, 12, 4)).toBeCloseTo(12, 9)
  })

  it('clamps to the ends rather than extrapolating', () => {
    expect(nearestArcLen(pts, lens, -3, 0)).toBeCloseTo(0, 9)
    expect(nearestArcLen(pts, lens, 99, 0)).toBeCloseTo(20, 9)
  })
})

describe('polylinePassWithTabs', () => {
  const pts: Pt2[] = [[0, 0], [10, 0], [20, 0]]
  const { lens } = arcLengths(pts)

  it('emits one segment per point after the first when there are no tabs', () => {
    expect(polylinePassWithTabs(pts, -5, [], lens)).toEqual([
      { x: 10, y: 0, z: -5, rapid: false },
      { x: 20, y: 0, z: -5, rapid: false },
    ])
  })

  it('lifts to the tab height and comes back down, both as vertical moves', () => {
    const out = polylinePassWithTabs(pts, -5, [{ start: 8, end: 12, tabZ: -1 }], lens)
    // The doubled points at 8 and 12 are the Z moves: the tool climbs in place at
    // the start of the tab and plunges in place at the end, so the tab keeps its
    // square ends instead of being ramped through.
    expect(out).toEqual([
      { x: 8, y: 0, z: -5, rapid: false },
      { x: 8, y: 0, z: -1, rapid: false },
      { x: 10, y: 0, z: -1, rapid: false },
      { x: 12, y: 0, z: -1, rapid: false },
      { x: 12, y: 0, z: -5, rapid: false },
      { x: 20, y: 0, z: -5, rapid: false },
    ])
  })

  it('carries an interior vertex over the tab at tab height', () => {
    // The vertex at 10 falls inside 8…12 and must be emitted at tabZ, not at depth.
    const out = polylinePassWithTabs(pts, -5, [{ start: 8, end: 12, tabZ: -1 }], lens)
    expect(out.find((s) => s.x === 10)?.z).toBe(-1)
  })

  it('never cuts below full depth, whatever order the tabs arrive in', () => {
    const out = polylinePassWithTabs(
      pts, -5,
      [{ start: 14, end: 16, tabZ: -1 }, { start: 2, end: 4, tabZ: -1 }],
      lens,
    )
    expect(Math.min(...out.map((s) => s.z))).toBe(-5)
    // Sorted internally, so the path still runs monotonically along the line.
    expect(out.map((s) => s.x)).toEqual([...out.map((s) => s.x)].sort((a, b) => a - b))
  })

  it('ignores a zero-length or inverted range', () => {
    const out = polylinePassWithTabs(pts, -5, [{ start: 12, end: 8, tabZ: -1 }], lens)
    expect(out.every((s) => s.z === -5)).toBe(true)
  })
})

describe('generateProfile — which side of the line the tool runs', () => {
  it('puts an outside cut a tool radius clear of the design line', () => {
    expect(cutBox(generateProfile(SQ, EM6, params({ side: 'outside' }))))
      .toEqual({ x0: 7, x1: 53, y0: 7, y1: 53 })
  })

  it('puts an inside cut a tool radius within it', () => {
    expect(cutBox(generateProfile(SQ, EM6, params({ side: 'inside' }))))
      .toEqual({ x0: 13, x1: 47, y0: 13, y1: 47 })
  })

  it('runs a centerline cut straight down the line', () => {
    expect(cutBox(generateProfile(SQ, EM6, params({ side: 'centerline' }))))
      .toEqual({ x0: 10, x1: 50, y0: 10, y1: 50 })
  })
})

describe('generateProfile — the offset is the tool radius AT THE CUT SURFACE', () => {
  // The wall a tapered tool leaves is a cone or a ball, widest at the surface. So
  // the offset is the radius `depthMM` above the tip, which is what makes the
  // finished wall touch the design line at startZ. Offsetting by diameterMM/2
  // instead would cut a shallow V-groove a full 3.175 mm off the line.

  it('sizes a V-bit from its depth, not its nominal diameter', () => {
    // 60° included → 30° half angle → radius = depth·tan30.
    expect(standoff(generateProfile(SQ, V60, params({ depthMM: 1, stepDownMM: 1 }))))
      .toBeCloseTo(Math.tan(Math.PI / 6), 3)
    expect(standoff(generateProfile(SQ, V60, params({ depthMM: 2, stepDownMM: 2 }))))
      .toBeCloseTo(2 * Math.tan(Math.PI / 6), 3)
  })

  it('clamps a V-bit cutting past its full-diameter depth to the real radius', () => {
    expect(standoff(generateProfile(SQ, V60, params({ depthMM: 99, stepDownMM: 99 }))))
      .toBeCloseTo(6.35 / 2, 3)
  })

  it('sizes a ball nose off its sphere, and clamps past the equator', () => {
    // √(h(2R−h)) at h = 1 on a 3 mm radius ball.
    expect(standoff(generateProfile(SQ, BALL6, params({ depthMM: 1, stepDownMM: 1 }))))
      .toBeCloseTo(Math.sqrt(1 * (2 * 3 - 1)), 3)
    expect(standoff(generateProfile(SQ, BALL6, params({ depthMM: 9, stepDownMM: 9 }))))
      .toBeCloseTo(3, 3)
  })

  it('leaves an end mill unaffected by depth — a straight wall is a straight wall', () => {
    for (const depthMM of [0.5, 3, 20]) {
      expect(standoff(generateProfile(SQ, EM6, params({ depthMM, stepDownMM: depthMM }))))
        .toBeCloseTo(3, 9)
    }
  })
})

describe('generateProfile — stock allowance', () => {
  it('moves an outside cut further out, so the part comes out proud', () => {
    expect(standoff(generateProfile(SQ, EM6, params({ side: 'outside', allowanceMM: 1 }))))
      .toBeCloseTo(4, 9)
  })

  it('moves an inside cut further in, so the opening comes out small', () => {
    expect(cutBox(generateProfile(SQ, EM6, params({ side: 'inside', allowanceMM: 1 }))).x1)
      .toBeCloseTo(46, 9)
  })

  it('cuts past the line for a negative allowance', () => {
    expect(standoff(generateProfile(SQ, EM6, params({ side: 'outside', allowanceMM: -1 }))))
      .toBeCloseTo(2, 9)
  })

  it('ignores the allowance on a centerline cut, which has no side to leave it on', () => {
    expect(cutBox(generateProfile(SQ, EM6, params({ side: 'centerline', allowanceMM: 1 }))))
      .toEqual({ x0: 10, x1: 50, y0: 10, y1: 50 })
  })
})

describe('generateProfile — climb vs conventional', () => {
  // With an M3 (CW) spindle, climb milling puts the material on the RIGHT of
  // travel. That makes an inside profile run CCW and an outside profile CW;
  // conventional is the reverse of each. This truth table is the whole rule, and
  // it has shipped inverted before — nothing else in the emitted path says which
  // way round the tool went.
  const area = (side: ProfileParams['side'], direction: ProfileParams['direction']) =>
    loopArea(generateProfile(SQ, EM6, params({ side, direction })))

  it('cuts an inside profile CCW on climb, CW on conventional', () => {
    expect(area('inside', 'climb')).toBeGreaterThan(0)
    expect(area('inside', 'conventional')).toBeLessThan(0)
  })

  it('cuts an outside profile CW on climb, CCW on conventional', () => {
    expect(area('outside', 'climb')).toBeLessThan(0)
    expect(area('outside', 'conventional')).toBeGreaterThan(0)
  })

  it('treats a centerline cut as the not-inside case, so climb runs it CW', () => {
    expect(area('centerline', 'climb')).toBeLessThan(0)
    expect(area('centerline', 'conventional')).toBeGreaterThan(0)
  })

  it('reverses direction without changing the geometry cut', () => {
    // Same loop, opposite winding — the offset must not move with the direction.
    expect(Math.abs(area('outside', 'climb'))).toBeCloseTo(Math.abs(area('outside', 'conventional')), 6)
  })
})

describe('generateProfile — depth passes', () => {
  it('steps down and lands exactly on the requested depth', () => {
    const z = [...new Set(cuts(generateProfile(SQ, EM6, params({ depthMM: 6, stepDownMM: 2 }))).map((s) => s.z))]
    expect(z.sort((a, b) => b - a)).toEqual([-2, -4, -6])
  })

  it('measures depth from the surface the cut starts on, not from stock top', () => {
    // Profiling in a 3 mm-deep pocket: 3 mm of cut ends at −6, not at −3.
    const z = cuts(generateProfile(SQ, EM6, params({ depthMM: 3, stepDownMM: 3, startZMM: -3 }))).map((s) => s.z)
    expect(Math.min(...z)).toBeCloseTo(-6, 9)
  })

  it('rapids at the safe height and nowhere else', () => {
    const segs = generateProfile(SQ, EM6, params({ safeHeightMM: 12 }))
    expect(segs[0]).toMatchObject({ z: 12, rapid: true })
    expect(segs[segs.length - 1]).toMatchObject({ z: 12, rapid: true })
    expect(segs.filter((s) => s.rapid).every((s) => s.z === 12)).toBe(true)
  })

  it('never emits a cutting move above the surface it starts from', () => {
    expect(cuts(generateProfile(SQ, EM6, params())).every((s) => s.z <= 0)).toBe(true)
  })
})

describe('generateProfile — holding tabs', () => {
  it('raises the tool to leave stock of the tab height under it', () => {
    const segs = generateProfile(SQ, EM6, params({ depthMM: 5, stepDownMM: 5 }), [tab({ heightMM: 2 })])
    // 5 mm deep with 2 mm of tab left standing → the tool rides at −3.
    expect(cuts(segs).some((s) => s.z === -3)).toBe(true)
    expect(cuts(segs).some((s) => s.z === -5)).toBe(true)
  })

  it('widens the tab by the tool diameter so the CUT tab is the length asked for', () => {
    // A straight 100 mm line, tab at the middle. The tool centre must lift half a
    // diameter early and drop half a diameter late, or the tool's own width eats
    // the ends of the tab it just left.
    const span = (lengthMM: number) => {
      const segs = generateProfile('M 0 0 L 100 0', EM6,
        params({ side: 'centerline', depthMM: 5, stepDownMM: 5 }), [tab({ lengthMM, heightMM: 2 })])
      const up = cuts(segs).filter((s) => s.z === -3).map((s) => s.x)
      return Math.max(...up) - Math.min(...up)
    }
    expect(span(10)).toBeCloseTo(10 + 6, 6)
    expect(span(20)).toBeCloseTo(20 + 6, 6)
  })

  it('stops lifting once the passes are shallower than the tab', () => {
    // A 2 mm tab in a 6 mm cut: the −2 pass is above the tab top, so it cuts
    // straight through; only the passes below it lift.
    const segs = generateProfile(SQ, EM6, params({ depthMM: 6, stepDownMM: 2 }), [tab({ heightMM: 2 })])
    const tabZ = -4
    expect(cuts(segs).filter((s) => s.z === tabZ).length).toBeGreaterThan(0)
    // Nothing rides at tab height during the first pass, which is already above it.
    expect(cuts(segs).some((s) => s.z === -2)).toBe(true)
  })
})

describe('generateProfile — the circle fast path', () => {
  const CIRCLE = 'M 50 20 A 30 30 0 1 0 50 80 A 30 30 0 1 0 50 20 Z'

  it('emits a true arc rather than a polygon', () => {
    const segs = generateProfile(CIRCLE, EM6, params({ side: 'outside' }))
    expect(segs.filter((s) => s.arc).length).toBe(1)
    expect(segs.length).toBeLessThan(10)
  })

  it('sets the arc direction from the same climb rule as a polygon', () => {
    const arcOf = (side: ProfileParams['side'], direction: ProfileParams['direction']) =>
      generateProfile(CIRCLE, EM6, params({ side, direction })).find((s) => s.arc)!.arc!
    expect(arcOf('outside', 'climb').cw).toBe(true)
    expect(arcOf('outside', 'conventional').cw).toBe(false)
    expect(arcOf('inside', 'climb').cw).toBe(false)
    expect(arcOf('inside', 'conventional').cw).toBe(true)
  })

  it('offsets the arc by the tool radius', () => {
    const out = generateProfile(CIRCLE, EM6, params({ side: 'outside' }))
    const arc = out.find((s) => s.arc)!
    expect(Math.hypot(arc.x - arc.arc!.cx, arc.y - arc.arc!.cy)).toBeCloseTo(33, 1)
    const ins = generateProfile(CIRCLE, EM6, params({ side: 'inside' }))
    const iarc = ins.find((s) => s.arc)!
    expect(Math.hypot(iarc.x - iarc.arc!.cx, iarc.y - iarc.arc!.cy)).toBeCloseTo(27, 1)
  })

  it('falls back to a polygon when tabs apply — an arc cannot carry a Z lift', () => {
    const segs = generateProfile(CIRCLE, EM6, params({ side: 'outside' }), [tab({ heightMM: 1 })])
    expect(segs.filter((s) => s.arc).length).toBe(0)
    expect(cuts(segs).some((s) => s.z === -2)).toBe(true)
  })
})

describe('generateProfile — open strokes', () => {
  const STROKE = 'M 0 0 L 10 0 L 10 10'

  it('cuts an open stroke start to end with no closing move', () => {
    const segs = generateProfile(STROKE, EM6, params({ side: 'centerline', depthMM: 2, stepDownMM: 2 }))
    expect(cuts(segs).map((s) => [s.x, s.y])).toEqual([[0, 0], [10, 0], [10, 10]])
  })

  it('keeps a two-point stroke, which is a letter stem', () => {
    const segs = generateProfile('M 0 0 L 0 10', EM6, params({ side: 'centerline', depthMM: 2, stepDownMM: 2 }))
    expect(cuts(segs).length).toBeGreaterThan(0)
  })

  it('refuses a sided cut on an open stroke, and names the cut that works', () => {
    // A stroke has no interior to be inside or outside of, so it is left out of
    // the offset. It used to be left out of everything else too: the op generated
    // cleanly, reported nothing, and simply never cut the stroke.
    for (const side of ['outside', 'inside'] as const) {
      expect(() => generateProfile(STROKE, EM6, params({ side })))
        .toThrow(`Path is open — an ${side} profile needs a closed shape. Use a centerline profile to cut along it.`)
    }
  })

  it('refuses a mixed path too, saying how much of it could not be offset', () => {
    // Silently cutting the closed half is the worse answer: what comes off the
    // machine is missing the strokes, and nothing said so.
    const mixed = 'M 0 0 L 10 0 L 10 10 Z M 20 0 L 30 0 L 30 10'
    expect(() => generateProfile(mixed, EM6, params({ side: 'outside' })))
      .toThrow(/1 of 2 subpaths are open and cannot be offset/)
  })

  it('still cuts a mixed path on the centerline, which needs no interior', () => {
    const mixed = 'M 0 0 L 10 0 L 10 10 Z M 20 0 L 30 0 L 30 10'
    const segs = generateProfile(mixed, EM6, params({ side: 'centerline' }))
    expect(cuts(segs).some((s) => s.x === 30)).toBe(true) // the open stroke
    expect(cuts(segs).some((s) => s.x === 10)).toBe(true) // the closed loop
  })
})

describe('generateProfile — start point and ramping', () => {
  it('starts the cut at the corner nearest startNear', () => {
    const startAt = (startNear: { x: number; y: number }) => {
      const c = cuts(generateProfile(SQ, EM6, params({ side: 'centerline', startNear })))
      return [c[0].x, c[0].y]
    }
    expect(startAt({ x: 10, y: 10 })).toEqual([10, 10])
    expect(startAt({ x: 50, y: 50 })).toEqual([50, 50])
  })

  it('ramps in at half feed and reaches full depth on every pass', () => {
    const segs = generateProfile(SQ, EM6, params({ depthMM: 6, stepDownMM: 3, rampIn: true }))
    // 12 ramp steps per pass, two passes.
    expect(segs.filter((s) => s.feedScale === 0.5).length).toBe(24)
    expect(Math.min(...segs.map((s) => s.z))).toBeCloseTo(-6, 9)
  })

  it('clears the ramp entry zone on the last pass', () => {
    // Without the cleanup pass the ramp leaves a wedge of stock at the entry.
    const flat = cuts(generateProfile(SQ, EM6, params({ depthMM: 3, stepDownMM: 3, rampIn: true })))
      .filter((s) => Math.abs(s.z - -3) < 1e-9)
    expect(flat.length).toBeGreaterThan(4)
  })
})

describe('generateProfile — failure modes', () => {
  it('names the tool when an inside offset eats the whole shape', () => {
    expect(() => generateProfile('M 0 0 L 4 0 L 4 4 L 0 4 Z', EM6, params({ side: 'inside', depthMM: 1, stepDownMM: 1 })))
      .toThrow('Tool is larger than the shape')
  })

  it('names the allowance too when one is in play', () => {
    // "The tool is too big" is no longer the whole answer once stock is being left.
    expect(() => generateProfile('M 0 0 L 4 0 L 4 4 L 0 4 Z', EM6, params({ side: 'inside', depthMM: 1, stepDownMM: 1, allowanceMM: 1 })))
      .toThrow('Tool plus allowance is larger than the shape')
  })

  it('rejects a path with no geometry', () => {
    expect(() => generateProfile('', EM6, params())).toThrow('No geometry found in path')
  })
})
