// The 3D sim's tool indicator is turned from the tool's OWN profile — `toolProfileHeightMM`,
// the function the carve and the CAM read — so the tool on screen is the shape that cut the
// stock. `cutterOutline` is that profile resampled; `flutePhase` is which way the flutes twist.
import { describe, it, expect } from 'vitest'
import { cutterOutline, flutePhase } from './toolMesh'
import { toolProfileHeightMM } from '../cam/geom'
import type { Tool } from '../store/toolStore'

const base = { id: '', name: '', fluteCount: 2, rpm: 0, xyFeedMmMin: 0, zFeedMmMin: 0, maxDepthMM: 20 }
const ball: Tool = { ...base, type: 'ballnose', diameterMM: 6 }
const vbit: Tool = { ...base, type: 'vbit', diameterMM: 12, vbitAngleDeg: 60 }
const bull: Tool = { ...base, type: 'bullnose', diameterMM: 8, cornerRadiusMM: 1.5 }
const endmill: Tool = { ...base, type: 'endmill', diameterMM: 6 }
/** How far a (radius, height) point lies from each tool's true profile CURVE. Measured as a
 *  distance, not as a height error, since at a ball's rim the curve is near vertical and
 *  a point a micron off it can be a long way off in height. */
const offCurve: Record<string, (d: number, h: number) => number> = {
  ball: (d, h) => Math.abs(Math.hypot(d, h - 3) - 3),                           // sphere R 3, centre (0, 3)
  vbit: (d, h) => Math.abs(h - d / Math.tan(Math.PI / 6)) * Math.sin(Math.PI / 6), // 30° per side
  bull: (d, h) => d <= 2.5 ? Math.abs(h) : Math.abs(Math.hypot(d - 2.5, h - 1.5) - 1.5), // flat 2.5, corner 1.5
}
const segLens = (pts: [number, number][]) => pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]))

describe('cutterOutline — the tip is the tool\'s own profile', () => {
  for (const [name, key, tool, r] of [['ball nose', 'ball', ball, 3], ['V-bit', 'vbit', vbit, 6], ['bull nose', 'bull', bull, 4]] as const) {
    it(`every point of a ${name}'s tip lies on its profile curve, from the axis out to the cutting radius`, () => {
      const { tip } = cutterOutline(tool, r, 30)
      expect(tip[0][0]).toBeCloseTo(0, 9)
      expect(tip[0][1]).toBeCloseTo(toolProfileHeightMM(tool, 0), 9)
      expect(tip[tip.length - 1][0]).toBeCloseTo(r, 6)
      // 5 µm: the dense samples are even in RADIUS, so the last one climbs ~0.25 mm of a
      // ball's near-vertical rim and its chord sags L²/8R ≈ 2.5 µm. Fine for a picture.
      for (const [d, h] of tip) expect(offCurve[key](d, h)).toBeLessThan(5e-3)
    })
  }

  it('a curved tip is turned from enough rows that no facet sags visibly off the curve (10 µm at its middle)', () => {
    for (const [key, tool, r] of [['ball', ball, 3], ['bull', bull, 4]] as const) {
      const { tip } = cutterOutline(tool, r, 30)
      for (let i = 1; i < tip.length; i++) {
        const [d, h] = [(tip[i - 1][0] + tip[i][0]) / 2, (tip[i - 1][1] + tip[i][1]) / 2]
        expect(offCurve[key](d, h)).toBeLessThan(0.01)
      }
    }
  })

  it('a ball\'s rim is sampled evenly by ARC LENGTH, not by radius, so the near-vertical edge is not faceted', () => {
    const lens = segLens(cutterOutline(ball, 3, 30).tip)
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length
    for (const l of lens) expect(Math.abs(l - mean) / mean).toBeLessThan(0.02)
  })

  it('a flat end mill\'s tip is a flat disc at the tip height', () => {
    const { tip } = cutterOutline(endmill, 3, 20)
    for (const [, h] of tip) expect(h).toBe(0)
  })

  it('the wall is a separate straight run at the full radius, from where the profile reaches it up to the flute top', () => {
    const { tip, wall } = cutterOutline(ball, 3, 15)
    const edgeTop = tip[tip.length - 1][1]
    expect(wall[0]).toEqual([3, edgeTop])
    expect(wall[wall.length - 1][1]).toBeCloseTo(15, 9)
    for (const [d] of wall) expect(d).toBe(3)
  })

  it('there is no wall when the flutes end at or below where the profile reaches full width', () => {
    expect(cutterOutline(vbit, 6, 1).wall).toEqual([])
  })
})

describe('flutePhase — which way the flutes twist', () => {
  const twist = 0.1
  it('an upcut turns positive (CCW from above) as it climbs, and a downcut is its mirror image', () => {
    const up = flutePhase('up', twist, 0), down = flutePhase('down', twist, 0)
    expect(up(10)).toBeCloseTo(1, 12)
    expect(down(10)).toBeCloseTo(-1, 12)
  })
  it('straight flutes (a V-bit) do not turn', () => {
    expect(flutePhase('straight', twist, 0)(10)).toBe(0)
  })
  it('a compression bit is upcut to its join, then turns back the other way without a break', () => {
    const c = flutePhase('compression', twist, 4), up = flutePhase('up', twist, 0)
    expect(c(3)).toBeCloseTo(up(3), 12)
    expect(c(4 - 1e-9)).toBeCloseTo(c(4 + 1e-9), 6)
    expect(c(6)).toBeCloseTo(up(2), 12)
  })
})
