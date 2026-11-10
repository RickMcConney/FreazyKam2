// Waterline rings for a flat end mill sliced off the mesh (`flatWaterlineSlicer`), and what
// the 3D Profile does with them: an end mill's moves bent over every cliff (`chordGuard`)
// and its lowest level cut right down at the floor.
//
// The models here are closed PRISMS — a regular polygon swept straight down, or tapered —
// because the behaviour being pinned is at a vertical wall, which a heightfield mesh cannot
// make. The polygon is the exact outline at every height, so a ring can be measured against
// it directly.
import { describe, it, expect } from 'vitest'
import { flatWaterlineSlicer } from './waterlineSlice'
import { flatDropCutter } from './dropCutter'
import { generateProfile3d, type Profile3dParams } from './profile3d'
import { ptSegDistSq } from './geom'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'
import type { BBox } from '../canvas/selectionUtils'

const END: Tool = { id: 'end', name: 'End 3', type: 'endmill', diameterMM: 3, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20 }
const R = END.diameterMM / 2

const box = (minX: number, minY: number, maxX: number, maxY: number): BBox =>
  ({ minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 })

/** A regular n-gon of radius r about (cx, cy), anticlockwise. */
const ngon = (cx: number, cy: number, r: number, n: number): [number, number][] =>
  Array.from({ length: n }, (_, k) => [cx + r * Math.cos(2 * Math.PI * k / n), cy + r * Math.sin(2 * Math.PI * k / n)])

/**
 * A closed solid: the n-gon of radius `rBot` at z = −depth narrowing (or not) to `rTop` at
 * z = 0 — a prism when the two are equal, a frustum otherwise — with its top and bottom
 * capped. The mesh's box is the bottom polygon's, which is also its CNC box (1:1, top at 0).
 */
function solid(cx: number, cy: number, rBot: number, rTop: number, depth: number, n = 64) {
  const bot = ngon(cx, cy, rBot, n), top = ngon(cx, cy, rTop, n)
  const pos: number[] = []
  const tri = (a: number[], b: number[], c: number[]) => pos.push(...a, ...b, ...c)
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n
    const t0 = [...top[k], 0], t1 = [...top[k1], 0], b0 = [...bot[k], -depth], b1 = [...bot[k1], -depth]
    tri([cx, cy, 0], t0, t1)            // top cap
    tri([cx, cy, -depth], b1, b0)       // bottom cap
    tri(b0, b1, t1); tri(b0, t1, t0)    // side
  }
  const xs = bot.map((p) => p[0]), ys = bot.map((p) => p[1])
  const bbox = box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))
  return {
    positions: new Float32Array(pos),
    bounds: { minX: bbox.minX, maxX: bbox.maxX, minY: bbox.minY, maxY: bbox.maxY, minZ: -depth, maxZ: 0 },
    bbox, bot, top,
  }
}

/** The distance from (x, y) to the polygon's outline. */
const distToPoly = (poly: [number, number][], x: number, y: number) => {
  let best = Infinity
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length]
    best = Math.min(best, ptSegDistSq(x, y, a[0], a[1], b[0], b[1]))
  }
  return Math.sqrt(best)
}

/** Twice the signed area of an x/y ring: negative is clockwise. */
const area2 = (r: number[]) => {
  let a = 0
  for (let k = 0; k < r.length; k += 2) { const j = (k + 2) % r.length; a += r[k] * r[j + 1] - r[j] * r[k + 1] }
  return a
}

describe('a flat end mill\'s waterline sliced off the mesh', () => {
  const prism = solid(20, 20, 8, 8, 6)
  const slice = flatWaterlineSlicer(prism.positions, null, prism.bounds, prism.bbox, R)

  it('stands exactly a tool radius off the model\'s outline — never nearer, and no further than the grow allowance', () => {
    const { rings } = slice(-3)
    expect(rings).toHaveLength(1)
    for (let k = 0; k < rings[0].length; k += 2) {
      const d = distToPoly(prism.bot, rings[0][k], rings[0][k + 1])
      expect(d).toBeGreaterThanOrEqual(R)
      expect(d).toBeLessThan(R + 0.01)
    }
  })

  it('runs with the material on its right: an outer ring is clockwise', () => {
    expect(area2(slice(-3).rings[0])).toBeLessThan(0)
  })

  it('has nothing to cut above the model\'s top', () => {
    const fresh = flatWaterlineSlicer(prism.positions, null, prism.bounds, prism.bbox, R)
    expect(fresh(0.5).rings).toEqual([])
  })

  it('part-way up a sloping side, follows only the model at or above the level', () => {
    // 10 mm across at the foot, 5 at the top, 10 deep: 7.5 at z = −5. Everything below the
    // level is under the tool and does not count.
    const frustum = solid(20, 20, 10, 5, 10)
    const at = flatWaterlineSlicer(frustum.positions, null, frustum.bounds, frustum.bbox, R)
    const { rings } = at(-5)
    expect(rings).toHaveLength(1)
    const outline = ngon(20, 20, 7.5, 64)
    for (let k = 0; k < rings[0].length; k += 2) {
      const d = distToPoly(outline, rings[0][k], rings[0][k + 1])
      expect(d).toBeGreaterThanOrEqual(R - 1e-3)
      expect(d).toBeLessThan(R + 0.01)
    }
  })

  it('reads a higher level again from the top, not from the wider outline of the one below it', () => {
    // On a frustum each level's outline is smaller than the one below, so a shadow kept
    // from the lower level would give the higher one a ring that is too big.
    const frustum = solid(20, 20, 10, 5, 10)
    const again = flatWaterlineSlicer(frustum.positions, null, frustum.bounds, frustum.bbox, R)
    const first = again(-3).rings
    again(-8)
    expect(again(-3).rings).toEqual(first)
  })
})

describe('an end mill\'s 3D Profile against a vertical wall', () => {
  // A boss on nothing: the ground round it is a floor at its foot, 6 down.
  const boss = solid(20, 20, 8, 8, 6)
  const params = (over: Partial<Profile3dParams> = {}): Profile3dParams =>
    ({ stepoverPercent: 30, rasterAngleDeg: 30, maxDepthMM: 20, safeHeightMM: 3, ...over })
  const gen = (over: Partial<Profile3dParams> = {}) =>
    generateProfile3d(boss.positions, null, boss.bounds, boss.bbox, END, params(over))
  // A tool 5 µm narrower than the one cutting: where it stands clear, the cut is at most
  // that far into the side of anything — the measure that means something at a cliff, where
  // a sideways nick of microns reads as the whole wall's height in Z.
  const floorZ = -6
  const slim = flatDropCutter(boss.positions, null, boss.bounds, boss.bbox, R - 0.005)
  const intrusions = (segs: MotionSegment[]) => {
    let n = 0
    for (let k = 1; k < segs.length; k++) {
      const a = segs[k - 1], b = segs[k]
      if (b.rapid || b.toolChange) continue
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.02))
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t
        if (Math.max(slim(x, y) ?? -Infinity, floorZ) > z + 1e-3) n++
      }
    }
    return n
  }

  for (const finishStrategy of ['raster', 'waterline'] as const) {
    it(`${finishStrategy}: never cuts the corner off the wall between two points of a move`, () => {
      expect(intrusions(gen({ finishStrategy }))).toBe(0)
    })
  }

  it('waterline: leaves no skin on the floor beside the wall — its lowest ring is cut at the floor', () => {
    // Beside the wall a cut there is the lowest ring's or nothing's: the floor's own rings
    // start a stepover out. Every point the tool stands on within a few microns of a radius
    // off the wall, at the foot, must be at the floor.
    const segs = gen({ finishStrategy: 'waterline' })
    const beside = segs.filter((s) => !s.rapid && s.z < floorZ + 0.5 && Math.abs(distToPoly(boss.bot, s.x, s.y) - R) < 0.01)
    expect(beside.length).toBeGreaterThan(0)
    expect(Math.min(...beside.map((s) => s.z))).toBeLessThanOrEqual(floorZ + 0.002)
  })
})
