// Holding tabs on a 3D Profile (cam/profile3dTabs): judged by what the TOOL leaves, swept
// along every cutting move, never by the height map — the tab is added to the model, and the
// model is the thing each pass reads.
import { describe, it, expect } from 'vitest'
import { generateProfile3d, type Profile3dParams } from './profile3d'
import { toolProfileHeightMM } from './geom'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'
import type { BBox } from '../canvas/selectionUtils'

const BALL: Tool = { id: 'ball', name: 'Ball 6', type: 'ballnose', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20 }
const END: Tool = { ...BALL, id: 'end', name: 'End 6', type: 'endmill' }
const box = (minX: number, minY: number, w: number, h: number): BBox =>
  ({ minX, minY, maxX: minX + w, maxY: minY + h, width: w, height: h, cx: minX + w / 2, cy: minY + h / 2 })

// A solid block 40 × 60, 10 tall, its four vertical sides its box — a part cut out of 10 mm
// stock: the band round it goes down to the stock's bottom and the block comes free.
const BW = 40, BH = 60, B = -10, n = 40
const block = (() => {
  const pos: number[] = [], tri = (...p: number[][]) => pos.push(...p.flat())
  const cx = BW / n, cy = BH / n
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    tri([i * cx, j * cy, 0], [(i + 1) * cx, j * cy, 0], [(i + 1) * cx, (j + 1) * cy, 0])
    tri([i * cx, j * cy, 0], [(i + 1) * cx, (j + 1) * cy, 0], [i * cx, (j + 1) * cy, 0])
  }
  const side = (x0: number, y0: number, x1: number, y1: number) => { tri([x0, y0, B], [x1, y1, B], [x1, y1, 0]); tri([x0, y0, B], [x1, y1, 0], [x0, y0, 0]) }
  side(0, 0, BW, 0); side(BW, 0, BW, BH); side(BW, BH, 0, BH); side(0, BH, 0, 0)
  tri([0, 0, B], [BW, BH, B], [BW, 0, B]); tri([0, 0, B], [0, BH, B], [BW, BH, B])
  return { positions: new Float32Array(pos), bounds: { minX: 0, maxX: BW, minY: 0, maxY: BH, minZ: B, maxZ: 0 } }
})()

// One tab in the middle of the bottom side, 6 mm wide, 3 mm tall off the stock's bottom.
const TOP = -7
const TAB = { x: 20, y: 0, nx: 0, ny: 1, lengthMM: 6, topZ: TOP }

/** Every point the tool passes through on its cutting moves, every 0.05 mm. */
function swept(segs: MotionSegment[]): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = []
  for (let k = 1; k < segs.length; k++) {
    const a = segs[k - 1], b = segs[k]
    if (b.rapid || b.travel) continue
    const m = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05))
    for (let i = 1; i <= m; i++) out.push({ x: a.x + (b.x - a.x) * i / m, y: a.y + (b.y - a.y) * i / m, z: a.z + (b.z - a.z) * i / m })
  }
  return out
}
/** The lowest the tool's own surface comes at (x, y): what is left standing there. */
function leftAt(pts: { x: number; y: number; z: number }[], tool: Tool, x: number, y: number): number {
  const R = tool.diameterMM / 2
  let low = Infinity
  for (const s of pts) {
    const r = Math.hypot(s.x - x, s.y - y)
    if (r <= R) low = Math.min(low, s.z + toolProfileHeightMM(tool, r))
  }
  return low
}
const cut = (tool: Tool, over: Partial<Profile3dParams>) =>
  swept(generateProfile3d(block.positions, null, block.bounds, box(0, 0, BW, BH), tool,
    { stepoverPercent: 30, rasterAngleDeg: 0, maxDepthMM: 12, ...over }))

// Across the band the tools clear beside the block (their centres run a radius past it):
// hard against the block, in the middle of the band, and at its outer edge.
const ACROSS = [-0.3, -2, -4, -5.5]
// Inside the tab's width, clear of its two edges by the fillet a ball leaves beside a step.
const ALONG = [18, 20, 22]

describe('a 3D Profile leaves its holding tabs standing', () => {
  for (const tool of [END, BALL]) {
    for (const finishStrategy of ['raster', 'waterline'] as const) {
      const name = `${tool.type === 'endmill' ? 'an end mill' : 'a ball nose'}, ${finishStrategy}`

      it(`${name}: no cut goes below the tab's top anywhere across it`, { timeout: 60000 }, () => {
        const pts = cut(tool, { finishStrategy, tabs: [TAB] })
        for (const x of ALONG) for (const y of ACROSS) expect(leftAt(pts, tool, x, y)).toBeGreaterThanOrEqual(TOP - 0.02)
      })

      it(`${name}: the tab is cut down to its top, not left as a wall`, { timeout: 60000 }, () => {
        const pts = cut(tool, { finishStrategy, tabs: [TAB] })
        // A ball leaves scallops between its passes; an end mill a flat.
        expect(leftAt(pts, tool, 20, -3)).toBeLessThan(TOP + (tool.type === 'ballnose' ? 0.4 : 0.05))
      })

      it(`${name}: beside the tab the band still goes to the bottom`, { timeout: 60000 }, () => {
        const pts = cut(tool, { finishStrategy, tabs: [TAB] })
        for (const x of [5, 35]) expect(leftAt(pts, tool, x, -3)).toBeLessThan(B + 0.05)
        // …and with no tab, so does the ground where the tab would have been.
        expect(leftAt(cut(tool, { finishStrategy }), tool, 20, -3)).toBeLessThan(B + 0.05)
      })
    }
  }

  // A bull nose and a taper have no exact drop cutter: they read the HEIGHT MAP, so the tab
  // has to be in the map as well as in the mesh.
  const BULL: Tool = { ...BALL, id: 'bull', name: 'Bull 6', type: 'bullnose', cornerRadiusMM: 1.5 }
  const TAPER: Tool = { ...BALL, id: 'taper', name: 'Taper', type: 'taper', diameterMM: 1, maxDepthMM: 25, vbitAngleDeg: 5 }
  for (const tool of [BULL, TAPER]) {
    it(`${tool.type === 'bullnose' ? 'a bull nose' : 'a taper'}, read off the height map: no cut goes below the tab's top`, { timeout: 120000 }, () => {
      const pts = cut(tool, { tabs: [TAB] })
      // Across the band THIS tool clears: its centre runs its own radius past the block. A
      // taper is a narrow cone, so beside a 10 mm wall it only gets down a couple of mm out.
      const ys = tool.type === 'taper' ? [-2, -2.4] : [-0.3, -1]
      for (const x of ALONG) for (const y of ys) expect(leftAt(pts, tool, x, y)).toBeGreaterThanOrEqual(TOP - 0.02)
      // …and the tab is not everything: beside it the same band is cut well below its top.
      expect(leftAt(pts, tool, 5, ys[1])).toBeLessThan(TOP - 1)
    })
  }

  it('the roughing leaves the tab too, with its allowance on top', { timeout: 60000 }, () => {
    const segs = generateProfile3d(block.positions, null, block.bounds, box(0, 0, BW, BH), BALL, {
      stepoverPercent: 30, rasterAngleDeg: 0, maxDepthMM: 12, tabs: [TAB],
      roughingRadiusMM: 3, roughingFlat: true, roughingStepoverPercent: 50, roughingStepDownMM: 3, roughingStockAllowanceMM: 0.3,
    })
    const rough = swept(segs.slice(0, segs.findIndex((s) => s.toolChange)))
    for (const x of ALONG) for (const y of ACROSS) expect(leftAt(rough, END, x, y)).toBeGreaterThanOrEqual(TOP + 0.3 - 0.02)
  })

  it('a tab whose top is at or below the floor is no tab: the cut is not through the stock', { timeout: 60000 }, () => {
    const withTab = generateProfile3d(block.positions, null, block.bounds, box(0, 0, BW, BH), END,
      { stepoverPercent: 30, rasterAngleDeg: 0, maxDepthMM: 12, tabs: [{ ...TAB, topZ: B }] })
    const without = generateProfile3d(block.positions, null, block.bounds, box(0, 0, BW, BH), END,
      { stepoverPercent: 30, rasterAngleDeg: 0, maxDepthMM: 12 })
    expect(withTab).toEqual(without)
  })
})
