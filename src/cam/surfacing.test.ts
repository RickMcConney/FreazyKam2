import { describe, it, expect } from 'vitest'
import { generateSurface } from './surfacing'
import type { SurfaceParams } from './surfacing'
import { ptSegDistSq } from './geom'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'

const EM6: Tool = {
  id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const BALL6: Tool = { ...EM6, id: 'b6', name: '6mm Ball Nose', type: 'ballnose' }
const V60: Tool = { ...EM6, id: 'v60', name: '60° V-Bit', type: 'vbit', vbitAngleDeg: 60 }
const DRILL3: Tool = { ...EM6, id: 'd3', name: '3mm Drill', type: 'drill', diameterMM: 3 }

const params = (over: Partial<SurfaceParams> = {}): SurfaceParams => ({
  widthMM: 100, heightMM: 50, depthMM: 1, stepDownMM: 1,
  stepoverPercent: 50, passAngleDeg: 0, safeHeightMM: 5, ...over,
})

const cuts = (segs: MotionSegment[]) => segs.filter((s) => !s.rapid)

/**
 * The stock a tool of `radius` actually sweeps, tested on a grid.
 *
 * Only `rapid: false` moves count. The stepover links between scanlines are
 * emitted as rapids at cut depth, so they cannot be relied on to clear anything
 * — the swath either overlaps from the scanlines either side of them or the
 * stock is left standing.
 *
 * Returns the worst uncovered sample, or null when the whole stock is swept.
 */
function uncoveredPoint(
  segs: MotionSegment[], widthMM: number, heightMM: number, radius: number, step = 1,
): [number, number] | null {
  const cutting: [number, number, number, number][] = []
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1], b = segs[i]
    if (!b.rapid && b.z < 0 && a.z === b.z) cutting.push([a.x, a.y, b.x, b.y])
  }
  const r2 = radius * radius + 1e-9
  for (let y = 0; y <= heightMM; y += step) {
    for (let x = 0; x <= widthMM; x += step) {
      if (!cutting.some(([ax, ay, bx, by]) => ptSegDistSq(x, y, ax, ay, bx, by) <= r2)) return [x, y]
    }
  }
  return null
}

describe('generateSurface — what it refuses', () => {
  it('takes an end mill or a ball nose and nothing else', () => {
    // Surfacing wants a flat or spherical bottom sweeping a plane. A V-bit's
    // width depends on its depth and a drill does not cut sideways at all.
    expect(() => generateSurface(EM6, params())).not.toThrow()
    expect(() => generateSurface(BALL6, params())).not.toThrow()
    expect(() => generateSurface(V60, params())).toThrow('Surfacing requires an end mill or ball nose tool')
    expect(() => generateSurface(DRILL3, params())).toThrow('Surfacing requires an end mill or ball nose tool')
  })

  it('refuses a stepover that would never finish', () => {
    // stepover = diameter × percent/100, so 0% is an infinite loop, not a fine pass.
    expect(() => generateSurface(EM6, params({ stepoverPercent: 0 }))).toThrow('Stepover too small')
  })
})

describe('generateSurface — the raster', () => {
  it('spaces the scanlines by the stepover, with only the last one short', () => {
    // 50 mm at 3 mm steps: 0…48 on the step, then 50 to reach the edge. Short is
    // the only direction the final gap may err — long leaves stock standing.
    const ys = [...new Set(cuts(generateSurface(EM6, params())).filter((s) => s.z < 0).map((s) => s.y))]
    expect(ys[0]).toBe(0)
    expect(ys[ys.length - 1]).toBeCloseTo(50, 9)
    for (let i = 1; i < ys.length - 1; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(3, 9)
    expect(ys[ys.length - 1] - ys[ys.length - 2]).toBeLessThanOrEqual(3 + 1e-9)
  })

  it('zigzags, so each pass starts where the last one finished', () => {
    const passes = cuts(generateSurface(EM6, params())).filter((s) => s.z < 0)
    // Ends alternate between the two edges of the stock.
    expect(passes.slice(0, 6).map((s) => s.x)).toEqual([0, 100, 0, 100, 0, 100])
  })

  it('steps over at cut depth rather than lifting between scanlines', () => {
    const segs = generateSurface(EM6, params())
    const scanlines = new Set(cuts(segs).filter((s) => s.z < 0).map((s) => s.y)).size
    const midRapids = segs.filter((s) => s.rapid && s.z < 0)
    // One link per scanline gap — the tool never climbs to safe height in the
    // middle of a level — and no link longer than a stepover.
    expect(midRapids).toHaveLength(scanlines - 1)
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i]
      if (b.rapid && b.z < 0) expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(3 + 1e-9)
    }
  })

  it('enters and leaves at safe height', () => {
    const segs = generateSurface(EM6, params({ safeHeightMM: 12 }))
    expect(segs[0]).toEqual({ x: 0, y: 0, z: 12, rapid: true })
    expect(segs[segs.length - 1]).toMatchObject({ z: 12, rapid: true })
  })

  it('re-rasters at every depth level, retracting between them', () => {
    const segs = generateSurface(EM6, params({ depthMM: 3, stepDownMM: 1 }))
    const levels = [...new Set(cuts(segs).map((s) => s.z))]
    expect(levels.sort((a, b) => b - a)).toEqual([-1, -2, -3])
    // The opening move to the stock corner, then an entry and a retract per level.
    expect(segs.filter((s) => s.rapid && s.z === 5)).toHaveLength(1 + 2 * 3)
  })
})

describe('generateSurface — pass angle', () => {
  it('keeps every move inside the stock at any angle', () => {
    // The scanlines are struck in a rotated frame and clipped back to the stock
    // rectangle; a clip that misses puts the cutter off the edge of the table.
    for (const passAngleDeg of [0, 30, 45, 90, 135, 180, -30]) {
      const segs = generateSurface(EM6, params({ passAngleDeg }))
      for (const s of segs) {
        expect(s.x).toBeGreaterThanOrEqual(-1e-6)
        expect(s.x).toBeLessThanOrEqual(100 + 1e-6)
        expect(s.y).toBeGreaterThanOrEqual(-1e-6)
        expect(s.y).toBeLessThanOrEqual(50 + 1e-6)
      }
    }
  })

  it('drops a scanline that misses the stock instead of emitting a stray move', () => {
    // A rotated raster's corner scanlines can fall outside the rectangle
    // entirely; clipScanline returns null and they must vanish, not clamp to an
    // edge and cut a line that was never asked for.
    const segs = generateSurface(EM6, params({ passAngleDeg: 45 }))
    expect(cuts(segs).length).toBeGreaterThan(0)
    expect(segs.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y))).toBe(true)
  })

  it('runs the scanlines along the angle asked for', () => {
    // At 90° the passes run up the Y axis, so it is X that steps over.
    const at90 = cuts(generateSurface(EM6, params({ passAngleDeg: 90 }))).filter((s) => s.z < 0)
    const xs = [...new Set(at90.map((s) => +s.x.toFixed(6)))]
    expect(xs.length).toBeGreaterThan(10)
    expect([...new Set(at90.map((s) => +s.y.toFixed(6)))].sort((a, b) => a - b)).toEqual([0, 50])
  })
})

describe('generateSurface — coverage', () => {
  it('sweeps the whole stock at 50% stepover, at every angle', () => {
    for (const passAngleDeg of [0, 45, 90, 30]) {
      const segs = generateSurface(EM6, params({ passAngleDeg }))
      expect(uncoveredPoint(segs, 100, 50, 3)).toBeNull()
    }
  })

  it('sweeps a stock whose height is not a whole number of stepovers', () => {
    for (const heightMM of [47, 50.5, 53, 61]) {
      const segs = generateSurface(EM6, params({ heightMM }))
      expect(uncoveredPoint(segs, 100, heightMM, 3, 0.5)).toBeNull()
    }
  })

  it('reaches the far edge at any stepover, by putting the last scanline on it', () => {
    // 100 × 52 at 80% used to leave 1 mm standing along the top: the last scanline
    // sat at the last whole stepover (48) and the cutter only reaches its own
    // radius (3) past a pass. The stepping loop now stops SHORT of the edge and the
    // final scanline is placed on it, so the short step only ever overlaps.
    for (const stepoverPercent of [40, 50, 60, 80, 100]) {
      for (const heightMM of [50, 52, 53, 61.5]) {
        const segs = generateSurface(EM6, params({ heightMM, stepoverPercent }))
        const ys = [...new Set(cuts(segs).filter((s) => s.z < 0).map((s) => s.y))]
        expect(Math.max(...ys)).toBeCloseTo(heightMM, 9)
        expect(uncoveredPoint(segs, 100, heightMM, 3, 0.5),
          `${heightMM}mm at ${stepoverPercent}%`).toBeNull()
      }
    }
  })

  it('adds no scanline when the height already divides evenly', () => {
    // 48 mm at 3 mm steps ends exactly on the edge — the extra line would be a
    // duplicate pass over ground already cut.
    const ys = [...new Set(cuts(generateSurface(EM6, params({ heightMM: 48 }))).filter((s) => s.z < 0).map((s) => s.y))]
    expect(ys).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48])
  })

  it('cuts one pass for a stock shorter than a single stepover', () => {
    const ys = [...new Set(cuts(generateSurface(EM6, params({ heightMM: 2 }))).filter((s) => s.z < 0).map((s) => s.y))]
    expect(ys).toEqual([0, 2])
  })

  it('still covers the stock at 100% stepover when the height divides evenly', () => {
    // The leftover is about the remainder, not about the percentage on its own.
    expect(uncoveredPoint(generateSurface(EM6, params({ heightMM: 48, stepoverPercent: 100 })), 100, 48, 3, 0.5))
      .toBeNull()
  })
})
