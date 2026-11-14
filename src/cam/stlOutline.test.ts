// The outline a model's tabs sit on (cam/stlOutline): the mesh's footprint seen from above,
// not its box — so a round model is tabbed round its side, where a tab can reach it.
import { describe, it, expect } from 'vitest'
import { meshSilhouette } from './stlOutline'
import { tabPointAt } from './tabPlacement'
import { pointInPolygon, toolProfileHeightMM } from './geom'
import { generateProfile3d } from './profile3d'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'
import type { BBox } from '../canvas/selectionUtils'

const box = (minX: number, minY: number, w: number, h: number): BBox =>
  ({ minX, minY, maxX: minX + w, maxY: minY + h, width: w, height: h, cx: minX + w / 2, cy: minY + h / 2 })

/** A disc (or ring, with `hole`) `R` across its outside, `depth` tall, faceted `n` ways, centred on (cx, cy). */
function puck(R: number, depth: number, cx = 0, cy = 0, hole = 0, n = 96): number[] {
  const pos: number[] = [], tri = (...p: number[][]) => pos.push(...p.flat())
  const at = (r: number, k: number, z: number) => [cx + r * Math.cos(2 * Math.PI * k / n), cy + r * Math.sin(2 * Math.PI * k / n), z]
  for (let k = 0; k < n; k++) {
    if (hole > 0) {
      tri(at(hole, k, 0), at(R, k, 0), at(R, k + 1, 0)); tri(at(hole, k, 0), at(R, k + 1, 0), at(hole, k + 1, 0))
      tri(at(hole, k, -depth), at(hole, k + 1, -depth), at(hole, k + 1, 0)); tri(at(hole, k, -depth), at(hole, k + 1, 0), at(hole, k, 0))
    } else {
      tri([cx, cy, 0], at(R, k, 0), at(R, k + 1, 0))
    }
    // The vertical side projects to a line: it covers nothing on its own.
    tri(at(R, k, -depth), at(R, k + 1, -depth), at(R, k + 1, 0)); tri(at(R, k, -depth), at(R, k + 1, 0), at(R, k, 0))
  }
  return pos
}
const boundsOf = (pos: number[]) => {
  const xs = pos.filter((_, i) => i % 3 === 0), ys = pos.filter((_, i) => i % 3 === 1), zs = pos.filter((_, i) => i % 3 === 2)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
}
const area = (r: [number, number][]) => { let a = 0; for (let i = 1; i < r.length; i++) a += r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1]; return a / 2 }

describe('a model\'s silhouette', () => {
  // 40 mm across, its box placed at (10, 10) on the stock; a cell is 40/600 mm.
  const pos = puck(20, 10)
  const rings = meshSilhouette(new Float32Array(pos), null, boundsOf(pos), box(10, 10, 40, 40))

  it('is the round outline of a round model, not its square box', () => {
    expect(rings).toHaveLength(1)
    for (const [x, y] of rings[0]) expect(Math.abs(Math.hypot(x - 30, y - 30) - 20)).toBeLessThan(0.4)
  })

  // A tool run its radius past the outline must clear the model's side: a ring a tenth
  // inside it put the tool's edge on the wall, and the tool rode on top of it.
  it('never comes inside the model anywhere along it, not even between its points', () => {
    // The disc is a 96-gon: its side is nowhere nearer the centre than this.
    const inner = 20 * Math.cos(Math.PI / 96)
    const r = rings[0]
    for (let i = 1; i < r.length; i++) for (let k = 0; k <= 10; k++) {
      const x = r[i - 1][0] + (r[i][0] - r[i - 1][0]) * k / 10, y = r[i - 1][1] + (r[i][1] - r[i - 1][1]) * k / 10
      expect(Math.hypot(x - 30, y - 30)).toBeGreaterThan(inner)
    }
  })

  it('never comes inside a square model\'s sharp corners', () => {
    const sq: number[] = []
    const tri = (...p: number[][]) => sq.push(...p.flat())
    tri([0, 0, 0], [30, 0, 0], [30, 30, 0]); tri([0, 0, 0], [30, 30, 0], [0, 30, 0])
    const r = meshSilhouette(new Float32Array(sq), null, { minX: 0, maxX: 30, minY: 0, maxY: 30, minZ: -1, maxZ: 0 }, box(0, 0, 30, 30))
    expect(r).toHaveLength(1)
    // Every corner of the square lies inside the ring.
    for (const [x, y] of [[0, 0], [30, 0], [30, 30], [0, 30]]) expect(pointInPolygon(x, y, r[0])).toBe(true)
  })

  it('runs anticlockwise and closes on its first point', () => {
    expect(area(rings[0])).toBeGreaterThan(0)
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1])
  })

  it('takes no ring round a hole through the model: a tab holds a part from outside', () => {
    const p = puck(20, 10, 0, 0, 8)
    const r = meshSilhouette(new Float32Array(p), null, boundsOf(p), box(0, 0, 40, 40))
    expect(r).toHaveLength(1)
    for (const [x, y] of r[0]) expect(Math.hypot(x - 20, y - 20)).toBeGreaterThan(19.8)
  })

  it('gives each separate piece of a model its own ring', () => {
    const p = [...puck(10, 5, 0, 0), ...puck(10, 5, 40, 0)]
    const r = meshSilhouette(new Float32Array(p), null, boundsOf(p), box(0, 0, 60, 20))
    expect(r).toHaveLength(2)
  })
})

describe('a tab on a round model\'s silhouette holds it where a tab on its box would miss', () => {
  const END: Tool = { id: 'end', name: 'End 6', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20 }
  const pos = puck(20, 10)
  const bounds = boundsOf(pos)
  const B = box(0, 0, 40, 40)
  const rings = meshSilhouette(new Float32Array(pos), null, bounds, B)
  // An eighth of the way round from wherever the ring starts — off the axes, which is where
  // a tab on the square box would sit at the box's corner, 8 mm off the disc.
  const at = tabPointAt(rings, 0.125)!
  const left = rings.some((r) => pointInPolygon(at.x - at.ty * 0.01, at.y + at.tx * 0.01, r))
  const [nx, ny] = left ? [-at.ty, at.tx] : [at.ty, -at.tx]
  const TOP = -7

  it('sits on the disc\'s side and points in at its centre', () => {
    expect(Math.abs(Math.hypot(at.x - 20, at.y - 20) - 20)).toBeLessThan(0.4)
    const ix = (20 - at.x) / 20, iy = (20 - at.y) / 20
    expect(nx * ix + ny * iy).toBeGreaterThan(0.995)
  })

  it('is left standing to its top, right beside the disc', { timeout: 60000 }, () => {
    const segs: MotionSegment[] = generateProfile3d(new Float32Array(pos), null, bounds, B, END, {
      stepoverPercent: 30, rasterAngleDeg: 0, maxDepthMM: 12,
      tabs: [{ x: at.x, y: at.y, nx, ny, lengthMM: 6, topZ: TOP }],
    })
    let low = Infinity
    // Just outside the disc, on the tab's centre line.
    const px = at.x - nx * 1.5, py = at.y - ny * 1.5
    for (let k = 1; k < segs.length; k++) {
      const a = segs[k - 1], b = segs[k]
      if (b.rapid || b.travel) continue
      const m = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05))
      for (let i = 1; i <= m; i++) {
        const x = a.x + (b.x - a.x) * i / m, y = a.y + (b.y - a.y) * i / m, z = a.z + (b.z - a.z) * i / m
        const r = Math.hypot(x - px, y - py)
        if (r <= 3) low = Math.min(low, z + toolProfileHeightMM(END, r))
      }
    }
    expect(low).toBeGreaterThanOrEqual(TOP - 0.02)
  })
})

describe('boundary "outline": a round model is cut round, not square', () => {
  const END: Tool = { id: 'end', name: 'End 6', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20 }
  const pos = puck(20, 10)
  const bounds = boundsOf(pos)
  const B = box(0, 0, 40, 40)
  const rings = meshSilhouette(new Float32Array(pos), null, bounds, B)
  // As opJob passes it: the outline as the boundary, and it is the model's own.
  const segs = generateProfile3d(new Float32Array(pos), null, bounds, B, END,
    { stepoverPercent: 30, rasterAngleDeg: 0, maxDepthMM: 12, boundaryRings: rings, boundaryIsModel: true })
  const cuts = segs.filter((s, k) => k > 0 && !s.rapid && !s.travel && s.z < -0.01)
  const fromCentre = (s: MotionSegment) => Math.hypot(s.x - 20, s.y - 20)

  it('runs the tool\'s centre no more than its radius and a lead past the outline, which stands at most 0.4 out', () => {
    for (const s of cuts) expect(fromCentre(s)).toBeLessThan(20 + 0.4 + 3 + 0.3)
  })

  const corners = [[0, 0], [40, 0], [40, 40], [0, 40]]
  const nearestCorner = (c: MotionSegment[]) => Math.min(...c.map((s) => Math.min(...corners.map(([x, y]) => Math.hypot(s.x - x, s.y - y)))))

  it('leaves the corners of the model\'s box uncut, where the box boundary cuts them', () => {
    // The tool's edge never reaches a corner of the box…
    expect(nearestCorner(cuts)).toBeGreaterThan(3)
    // …which the box boundary, run its radius past the box, cuts right through.
    const boxCuts = generateProfile3d(new Float32Array(pos), null, bounds, B, END, { stepoverPercent: 30, rasterAngleDeg: 0, maxDepthMM: 12 })
      .filter((s, k) => k > 0 && !s.rapid && !s.travel && s.z < -0.01)
    expect(nearestCorner(boxCuts)).toBeLessThan(1)
  })

  it('still cuts down to the model\'s base right beside it', () => {
    expect(cuts.some((s) => fromCentre(s) > 22.5 && s.z < -9.9)).toBe(true)
  })
})
