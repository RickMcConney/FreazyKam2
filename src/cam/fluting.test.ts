import { describe, it, expect } from 'vitest'
import { generateFluting, fluteDepthAt, resampleProfile, type FluteBreakpoint, type FlutingParams } from './fluting'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'

const vbit: Tool = {
  id: 'v', name: '60° V', type: 'vbit', diameterMM: 12, vbitAngleDeg: 60, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 10,
}
const endmill: Tool = { ...vbit, id: 'e', name: '6 mm', type: 'endmill', diameterMM: 6, vbitAngleDeg: undefined }

// A 100 mm stroke along X, so x IS the distance along the path.
const LINE = 'M 0 0 L 100 0'
const PEAK: FluteBreakpoint[] = [{ t: 0, depth: 0 }, { t: 0.5, depth: 1 }, { t: 1, depth: 0 }]
const params = (over: Partial<FlutingParams> = {}): FlutingParams =>
  ({ depthMM: 4, stepDownMM: 1.5, profile: PEAK, smooth: false, safeHeightMM: 5, ...over })
const cuts = (segs: MotionSegment[]) => segs.filter((s) => !s.rapid)

/** The profile's depth (mm) under x on LINE, linear PEAK at 4 mm. */
const peakDepth = (x: number) => 4 * (1 - Math.abs(x - 50) / 50)

describe('the flute height profile', () => {
  it('passes through every breakpoint, straight or smooth', () => {
    const profile: FluteBreakpoint[] = [{ t: 0, depth: 0.1 }, { t: 0.3, depth: 0.9 }, { t: 0.6, depth: 0.4 }, { t: 1, depth: 0.7 }]
    for (const smooth of [false, true]) {
      for (const p of profile) expect(fluteDepthAt(profile, p.t, smooth)).toBeCloseTo(p.depth, 9)
    }
  })

  it('smooth never carves past the deeper of two breakpoints, nor rises above the shallower', () => {
    // A sharp rise into a level run is where an ordinary cubic overshoots.
    const profile: FluteBreakpoint[] = [{ t: 0, depth: 0 }, { t: 0.05, depth: 1 }, { t: 0.5, depth: 1 }, { t: 0.55, depth: 0.2 }, { t: 1, depth: 0.3 }]
    for (let i = 0; i < profile.length - 1; i++) {
      const a = profile[i], b = profile[i + 1]
      const lo = Math.min(a.depth, b.depth), hi = Math.max(a.depth, b.depth)
      for (let k = 0; k <= 50; k++) {
        const v = fluteDepthAt(profile, a.t + (b.t - a.t) * (k / 50), true)
        expect(v).toBeGreaterThanOrEqual(lo - 1e-9)
        expect(v).toBeLessThanOrEqual(hi + 1e-9)
      }
    }
  })

  it('changing the number of breakpoints keeps the shape already drawn', () => {
    expect(resampleProfile(PEAK, 5, false)).toEqual([
      { t: 0, depth: 0 }, { t: 0.25, depth: 0.5 }, { t: 0.5, depth: 1 }, { t: 0.75, depth: 0.5 }, { t: 1, depth: 0 },
    ])
  })
})

describe('a fluting toolpath', () => {
  it('reaches the profile\'s depth at every breakpoint and never cuts below it', () => {
    const segs = cuts(generateFluting(LINE, vbit, params()))
    for (const s of segs) expect(s.z).toBeGreaterThanOrEqual(-peakDepth(s.x) - 1e-9)
    const deepestAt = (x: number) => Math.min(...segs.filter((s) => Math.abs(s.x - x) < 1e-6).map((s) => s.z))
    expect(deepestAt(50)).toBeCloseTo(-4, 9)
    expect(deepestAt(0)).toBeCloseTo(0, 9)
    expect(deepestAt(100)).toBeCloseTo(0, 9)
  })

  it('takes the depth a step at a time, so no pass cuts more than one step-down deeper than the last', () => {
    const segs = cuts(generateFluting(LINE, vbit, params()))
    const levelsAtPeak = [...new Set(segs.filter((s) => Math.abs(s.x - 50) < 1e-6).map((s) => +s.z.toFixed(6)))].sort((a, b) => b - a)
    expect(levelsAtPeak).toEqual([-1.5, -3, -4])
  })

  it('cuts an open stroke there and back, staying down between passes', () => {
    const segs = generateFluting(LINE, vbit, params())
    expect(segs.filter((s) => s.rapid)).toHaveLength(2) // to above the start, and the final lift
    // Three passes — out, back, out — so it goes in at the start and lifts out at the end.
    expect(segs[1]).toMatchObject({ x: 0, rapid: false })
    expect(segs[segs.length - 1]).toMatchObject({ x: 100, rapid: true })
  })

  it('runs the profile from the path\'s end when reversed', () => {
    const ramp: FluteBreakpoint[] = [{ t: 0, depth: 1 }, { t: 1, depth: 0 }]
    const deepX = (reverse: boolean) => {
      const segs = cuts(generateFluting(LINE, vbit, params({ profile: ramp, reverse })))
      return segs.reduce((a, b) => (b.z < a.z ? b : a)).x
    }
    expect(deepX(false)).toBeCloseTo(0, 6)
    expect(deepX(true)).toBeCloseTo(100, 6)
  })

  it('descends steeper than 45° straight down, so the writer feeds it as a plunge', () => {
    // From the surface to 4 mm within 1 mm of path: a cliff.
    const cliff: FluteBreakpoint[] = [{ t: 0, depth: 0 }, { t: 0.4, depth: 0 }, { t: 0.41, depth: 1 }, { t: 1, depth: 1 }]
    const segs = cuts(generateFluting(LINE, vbit, params({ profile: cliff, stepDownMM: 10 })))
    for (let i = 1; i < segs.length; i++) {
      const run = Math.hypot(segs[i].x - segs[i - 1].x, segs[i].y - segs[i - 1].y)
      const drop = segs[i - 1].z - segs[i].z
      if (run > 1e-9) expect(drop).toBeLessThanOrEqual(run + 1e-9)
    }
  })

  it('refuses a flat end mill, which would leave a step wherever the depth changes', () => {
    expect(() => generateFluting(LINE, endmill, params())).toThrow(/V-bit, taper or ball nose/)
  })

  it('refuses a profile that stays at the surface the whole way', () => {
    const flat: FluteBreakpoint[] = [{ t: 0, depth: 0 }, { t: 1, depth: 0 }]
    expect(() => generateFluting(LINE, vbit, params({ profile: flat }))).toThrow(/Nothing to cut/)
  })
})
