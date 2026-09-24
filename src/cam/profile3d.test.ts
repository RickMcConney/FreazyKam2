// 3D profile — a ball nose or taper following an STL surface, tip-referenced (Z = 0 at the
// top of the model, negative into the stock).
//
// The surfaces here are built as meshes from height functions whose true height is known
// at every point, so a test can ask where the tool is against the SURFACE rather than
// against the code's own height map.
import { describe, it, expect } from 'vitest'
import { buildHeightMap, generateProfile3d, type Profile3dParams } from './profile3d'
import { maxCutRadiusMM, toolProfileHeightMM } from './geom'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'
import type { BBox } from '../canvas/selectionUtils'

const BALL: Tool = { id: 'ball', name: 'Ball 6', type: 'ballnose', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20 }
const TAPER: Tool = { id: 'taper', name: 'Taper', type: 'taper', diameterMM: 1, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25, vbitAngleDeg: 5 }
const SAFE_Z = 5

const box = (minX: number, minY: number, w: number, h: number): BBox =>
  ({ minX, minY, maxX: minX + w, maxY: minY + h, width: w, height: h, cx: minX + w / 2, cy: minY + h / 2 })

type Height = (x: number, y: number) => number

/** A heightfield mesh over [0,W]×[0,H], n×n cells, two triangles each, and `at` — the
 *  exact height of that mesh anywhere, triangle by triangle. */
function mesh(S: Height, W: number, H: number, n: number) {
  const pos: number[] = []
  const cw = W / n, ch = H / n
  const v = (i: number, j: number) => [i * cw, j * ch, S(i * cw, j * ch)]
  const at = (x: number, y: number) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(x / cw))), j = Math.min(n - 1, Math.max(0, Math.floor(y / ch)))
    const fx = x / cw - i, fy = y / ch - j
    const za = v(i, j)[2], zb = v(i + 1, j)[2], zc = v(i + 1, j + 1)[2], zd = v(i, j + 1)[2]
    // Triangles (a,b,c) below the diagonal and (a,c,d) above it, as pushed below.
    return fx >= fy ? za + (zb - za) * fx + (zc - zb) * fy : za + (zc - zd) * fx + (zd - za) * fy
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1)
      pos.push(...a, ...b, ...c, ...a, ...c, ...d)
    }
  }
  const positions = new Float32Array(pos)
  let minZ = Infinity, maxZ = -Infinity
  for (let k = 2; k < positions.length; k += 3) { minZ = Math.min(minZ, positions[k]); maxZ = Math.max(maxZ, positions[k]) }
  return { positions, at, bounds: { minX: 0, maxX: W, minY: 0, maxY: H, minZ, maxZ } }
}

// A 40 × 40 block with a V-groove down the middle: flat top at 0, walls at 45°, 8 deep.
// Every kink lands on a mesh vertex, so the mesh IS the surface.
const W = 40
const GROOVE: Height = (x) => -Math.max(0, 8 - Math.abs(x - 20))
const groove = mesh(GROOVE, W, W, 40)
const params = (over: Partial<Profile3dParams> = {}): Profile3dParams =>
  ({ stepoverPercent: 30, rasterAngleDeg: 0, maxDepthMM: 30, ...over })
const run = (tool = BALL, over: Partial<Profile3dParams> = {}) =>
  generateProfile3d(groove.positions, null, groove.bounds, box(0, 0, W, W), tool, params(over))

const cuts = (segs: MotionSegment[]) => segs.filter((s) => !s.rapid)

describe('buildHeightMap', () => {
  it('puts the top of the model at Z = 0 and the rest below it', () => {
    const { positions, bounds } = mesh((x) => (x < 20 ? 10 : 4), 40, 40, 40)
    const g = buildHeightMap(positions, null, bounds, box(0, 0, 40, 40), 41, 41)
    expect(g[10 * 41 + 5]).toBe(0)      // (5, 10) on the high side
    expect(g[10 * 41 + 30]).toBe(-6)    // (30, 10) on the low side
  })

  it('fits the model onto the path box, centred, and scales depth with it', () => {
    // A 10 mm model with a 2 mm deep, 4 mm wide slot at x ∈ [3,7], placed in a 20 mm box
    // at (100, 50): everything doubles and moves with the box.
    const { positions, bounds } = mesh((x) => (x > 3 && x < 7 ? -2 : 0), 10, 10, 10)
    const g = buildHeightMap(positions, null, bounds, box(100, 50, 20, 20), 21, 21)
    const at = (x: number, y: number) => g[(y - 50) * 21 + (x - 100)]
    expect(at(110, 60)).toBe(-4)   // slot centre: model (5,5) → (110,60), 2 mm deep → 4
    expect(at(102, 60)).toBe(0)    // model x = 1, outside the slot
    expect(at(118, 60)).toBe(0)
  })

  it('reads the HIGHEST point of the surface within each cell, not the point at its node', () => {
    // A plane rising in X and falling in Y peaks at a cell's +X, −Y corner, half a cell
    // from the node each way — clipped where the cell runs off the model.
    const { positions, bounds } = mesh((x, y) => 0.1 * x - 0.05 * y, 20, 20, 4)
    const g = buildHeightMap(positions, null, bounds, box(0, 0, 20, 20), 21, 21)
    const peak = (x: number, y: number) => 0.1 * Math.min(x + 0.5, 20) - 0.05 * Math.max(y - 0.5, 0) - bounds.maxZ
    for (const [x, y] of [[0, 0], [3, 7], [11, 2], [20, 20], [17, 13]]) {
      expect(g[y * 21 + x], `(${x}, ${y})`).toBeCloseTo(peak(x, y), 5)
    }
  })

  it('sees a wall that rises between two nodes', () => {
    // A 5 mm step at x = 10.3: the node at x = 10 stands on the low side, but its cell
    // reaches to 10.5, so it reads the top of the wall. A point sample reads the floor,
    // and the tool is then told there is no wall 0.3 mm from where it stands.
    const pos = new Float32Array([
      0, 0, 0, 10.3, 0, 0, 10.3, 10, 0, 0, 0, 0, 10.3, 10, 0, 0, 10, 0,        // floor
      10.3, 0, 0, 10.3, 10, 5, 10.3, 10, 0, 10.3, 0, 0, 10.3, 0, 5, 10.3, 10, 5, // wall face
      10.3, 0, 5, 20, 0, 5, 20, 10, 5, 10.3, 0, 5, 20, 10, 5, 10.3, 10, 5,     // top
    ])
    const bounds = { minX: 0, maxX: 20, minY: 0, maxY: 10, minZ: 0, maxZ: 5 }
    const g = buildHeightMap(pos, null, bounds, box(0, 0, 20, 10), 21, 11)
    expect(g[5 * 21 + 9]).toBe(-5)    // x = 9: its cell ends at 9.5, all floor
    expect(g[5 * 21 + 10]).toBe(0)    // x = 10: its cell holds the wall
  })

  it('reads an indexed mesh exactly as the same triangles unindexed', () => {
    const { positions, bounds } = mesh((x, y) => -Math.hypot(x - 5, y - 5) * 0.3, 10, 10, 6)
    const indices = new Uint32Array(positions.length / 3).map((_, i) => i)
    const b = box(0, 0, 10, 10)
    expect(buildHeightMap(positions, indices, bounds, b, 23, 23)).toEqual(buildHeightMap(positions, null, bounds, b, 23, 23))
  })

  it('leaves cells no triangle covers as -Infinity — waste material, not a surface at 0', () => {
    // One triangle over the lower-left half of the box.
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0])
    const bounds = { minX: 0, maxX: 10, minY: 0, maxY: 10, minZ: 0, maxZ: 0 }
    const g = buildHeightMap(positions, null, bounds, box(0, 0, 10, 10), 11, 11)
    expect(g[2 * 11 + 2]).toBe(0)
    expect(g[9 * 11 + 9]).toBe(-Infinity)
  })
})

describe('generateProfile3d refuses what it cannot cut', () => {
  it('refuses a tool with no rounded tip', () => {
    for (const type of ['endmill', 'vbit', 'drill'] as const) {
      expect(() => run({ ...BALL, type })).toThrow('3D Profile requires a ball nose or taper tool')
    }
  })

  it('refuses a path box of zero size', () => {
    expect(() => generateProfile3d(groove.positions, null, groove.bounds, box(0, 0, 0, 40), BALL, params()))
      .toThrow('STL path has zero dimensions')
  })
})

describe('the finishing raster', () => {
  it('puts the TIP on a flat surface — it does not float the tool by its radius', { timeout: 30000 }, () => {
    // The pipeline is tip-referenced; adding the ball radius here would cut R above the
    // stock and leave the whole top uncut.
    for (const tool of [BALL, TAPER]) {
      const flat = cuts(run(tool)).filter((s) => s.x < 20 - 8 - 4 || s.x > 20 + 8 + 4)
      expect(flat.length, tool.type).toBeGreaterThan(100)
      for (const s of flat) expect(s.z, tool.type).toBeCloseTo(0, 6)
    }
  })

  it('never goes deeper than the maximum depth', () => {
    const segs = cuts(run(BALL, { maxDepthMM: 3 }))
    expect(Math.min(...segs.map((s) => s.z))).toBeCloseTo(-3, 6)
    // …and it is clamped, not just shallow: the groove bottom is cut AT the limit.
    expect(segs.filter((s) => Math.abs(s.x - 20) < 1).every((s) => Math.abs(s.z + 3) < 1e-6)).toBe(true)
  })

  it('reaches into the groove as far as the ball fits, to within a grid cell', () => {
    // A 45° V takes a 3 mm ball to within R(√2 − 1) ≈ 1.24 mm of its point. The raster
    // reads the gouge-free surface between grid nodes by linear interpolation, and at the
    // bottom of a V that surface is itself a V — so a scanline between two nodes rides up
    // to one cell high. It must never read LOWER, which would put the ball into both walls.
    const cell = W / Math.ceil(W / (BALL.diameterMM * 0.3 / 3))   // height-map cell: stepover / 3
    const fits = -8 + 3 * (Math.SQRT2 - 1)
    const bottom = Math.min(...cuts(run()).map((s) => s.z))
    expect(bottom).toBeGreaterThanOrEqual(fits - 1e-3)
    expect(bottom).toBeLessThan(fits + cell)
  })

  it('moves only at safe height between groups, and never cuts across between them', () => {
    // Every rapid is at safe height, every group is entered by a vertical plunge from it,
    // and every other cutting move is one short sample along its scanline — so no move
    // at depth can cross the model from one scanline to the next.
    const segs = run()
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], s = segs[i]
      if (s.rapid) { expect(s.z).toBe(SAFE_Z); continue }
      const len = Math.hypot(s.x - a.x, s.y - a.y)
      if (a.rapid) expect(len).toBe(0)
      else expect(len).toBeLessThan(0.5)
    }
  })

  it('spaces its scanlines by the stepover, in the direction of the raster angle', () => {
    const stepover = BALL.diameterMM * 0.3
    const lines = (segs: MotionSegment[], key: 'x' | 'y') =>
      [...new Set(cuts(segs).map((s) => Math.round(s[key] * 1e6) / 1e6))].sort((a, b) => a - b)
    const ys = lines(run(BALL, { rasterAngleDeg: 0 }), 'y')
    for (let i = 1; i < ys.length - 1; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(stepover, 6)
    // At 90° the scanlines run along Y, so it is X that steps.
    const xs = lines(run(BALL, { rasterAngleDeg: 90 }), 'x')
    expect(xs.length).toBe(ys.length)
  })

  it('uses its own safe height', () => {
    expect(run(BALL, { safeHeightMM: 12 }).filter((s) => s.rapid).every((s) => s.z === 12)).toBe(true)
  })
})

describe('the finish never cuts into the model', () => {
  // The claim that matters most: with the tool's tip at each emitted point, no part of the
  // tool is below the surface. Measured against the mesh's own exact surface, sampled
  // every 0.1 mm under the whole tool, so nothing the code computes is trusted.
  //
  // The height map used to sample the surface at its grid nodes only. A wall rising
  // between two nodes was invisible to it, and a 6 mm ball at 30% stepover cut 0.70 mm
  // into the foot of a dome, 0.12 mm into a 45° pit and 0.07 mm into a 45° groove. It now
  // takes the HIGHEST point in each cell. What is left is distance rounding in the
  // dilation — a surface point can sit up to half a cell nearer the tool than its node —
  // measured at 0.016 mm at most. Closing that too would double the stock left on every
  // slope, so it is the tolerance here: under the resolution of the machine.
  const GOUGE_TOL = 0.02
  const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 15 ? Math.sqrt(225 - r * r) - 15 : -15 }
  const PIT: Height = (x, y) => -Math.max(0, 10 - Math.max(Math.abs(x - 20), Math.abs(y - 20)))
  const RIDGE: Height = (x) => -Math.min(8, Math.abs(x - 20))

  function worstGouge(S: Height, n: number, tool: Tool, pct: number, size = W, every = 1) {
    const m = mesh(S, size, size, n)
    const segs = cuts(generateProfile3d(m.positions, null, m.bounds, box(0, 0, size, size), tool, params({ stepoverPercent: pct })))
    const R = maxCutRadiusMM(tool)
    let worst = 0
    for (let k = 0; k < segs.length; k += every) {
      const s = segs[k]
      for (let u = Math.max(0, s.x - R); u <= Math.min(size, s.x + R); u += 0.1) {
        for (let v = Math.max(0, s.y - R); v <= Math.min(size, s.y + R); v += 0.1) {
          const d = Math.hypot(u - s.x, v - s.y)
          if (d <= R) worst = Math.min(worst, s.z + toolProfileHeightMM(tool, d) - m.at(u, v))
        }
      }
    }
    return -worst
  }

  const cases: [string, Height, number][] = [
    ['the near-vertical foot of a dome', DOME, 80],
    ['a 45° groove', GROOVE, 40],
    ['a 45° pyramid pit', PIT, 40],
    ['a 45° ridge', RIDGE, 40],
  ]
  for (const [name, S, n] of cases) {
    for (const pct of [10, 30]) {
      it(`ball nose at ${pct}% stepover: ${name}`, { timeout: 30000 }, () => {
        expect(worstGouge(S, n, BALL, pct, W, pct < 20 ? 8 : 1)).toBeLessThan(GOUGE_TOL)
      })
    }
    it(`taper: ${name}`, { timeout: 30000 }, () => {
      expect(worstGouge(S, n, TAPER, 30, W, 40)).toBeLessThan(GOUGE_TOL)
    })
  }

  it('stays clear when a large grid is downsampled for the dilation', { timeout: 30000 }, () => {
    // 39.95 mm at a 0.05 mm cell is 800 nodes, over the 750 cap — halved to 400, which
    // does not divide 799 evenly. Mapping the nodes by index rather than by position
    // drifted half a cell by the far edge and cut 0.10 mm into this dome.
    const dome: Height = (x, y) => DOME(x * 40 / 39.95, y * 40 / 39.95)
    expect(worstGouge(dome, 80, TAPER, 15, 39.95, 40)).toBeLessThan(GOUGE_TOL)
  })

  it('leaves no more than slope × half a cell on a 45° wall for reading high', () => {
    // The price of never gouging: a cell's highest point is up to half a cell above its
    // node on a slope, and the tool rides that. Clearance between tool and surface on the
    // groove's walls, clear of its top edge and its bottom.
    const m = mesh(GROOVE, W, W, 40)
    const cell = W / Math.ceil(W / (BALL.diameterMM * 0.3 / 3))
    const segs = cuts(generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), BALL, params()))
      .filter((s) => Math.abs(s.x - 20) > 4 && Math.abs(s.x - 20) < 6)
    expect(segs.length).toBeGreaterThan(50)
    for (const s of segs) {
      let gap = Infinity
      for (let u = s.x - 3; u <= s.x + 3; u += 0.02) gap = Math.min(gap, s.z + toolProfileHeightMM(BALL, Math.abs(u - s.x)) - m.at(u, s.y))
      expect(gap).toBeLessThanOrEqual(cell / 2 + 1e-3)
    }
  })
})

describe('roughing then rest-machining', () => {
  const rough = (over: Partial<Profile3dParams> = {}) => run(BALL, {
    roughingBallRadius: 3, roughingStepoverPercent: 40, roughingStepDownMM: 3,
    roughingStockAllowanceMM: 0.3, finishingToolId: 'fin', ...over,
  })
  const split = (segs: MotionSegment[]) => {
    const k = segs.findIndex((s) => s.toolChange)
    return { roughing: segs.slice(0, k), change: segs[k], finishing: segs.slice(k + 1) }
  }

  it('changes to the finishing tool exactly once, at safe height, between the two', () => {
    const segs = rough()
    expect(segs.filter((s) => s.toolChange)).toHaveLength(1)
    const { roughing, change, finishing } = split(segs)
    expect(change).toMatchObject({ toolChange: 'fin', rapid: true, z: SAFE_Z })
    expect(roughing.length).toBeGreaterThan(0)
    // The finish is the same raster a finishing-only run produces.
    expect(finishing).toEqual(run(BALL))
  })

  it('leaves the stock allowance for the finish', () => {
    // On the flat top the roughing tip rides the allowance above the surface; nowhere does
    // it come closer to the surface than the finish will.
    const { roughing, finishing } = split(rough())
    const top = cuts(roughing).filter((s) => s.x < 8 || s.x > 32)
    expect(top.length).toBeGreaterThan(0)
    for (const s of top) expect(s.z).toBeCloseTo(0.3, 6)
    const finishFloor = Math.min(...cuts(finishing).map((s) => s.z))
    expect(Math.min(...cuts(roughing).map((s) => s.z))).toBeGreaterThanOrEqual(finishFloor + 0.3 - 1e-6)
  })

  it('steps down a level at a time instead of roughing to full depth at once', () => {
    // At 3 mm a step, the first pass stops at 3 mm (+ the allowance) wherever the groove is
    // deeper — a floor that a single full-depth pass never has.
    const firstFloor = (segs: MotionSegment[]) =>
      cuts(split(segs).roughing).filter((s) => Math.abs(s.z - (-3 + 0.3)) < 1e-6).length
    expect(firstFloor(rough({ roughingStepDownMM: 3 }))).toBeGreaterThan(100)
    expect(firstFloor(rough({ roughingStepDownMM: 20 }))).toBe(0)
  })

  it('does not re-cut ground an earlier pass already took', () => {
    // The flat top is finished to its allowance by the first pass; later passes skip it,
    // so it is visited as often in a three-pass rough as in a one-pass one.
    const onTop = (segs: MotionSegment[]) => cuts(split(segs).roughing).filter((s) => Math.abs(s.z - 0.3) < 1e-6).length
    expect(onTop(rough({ roughingStepDownMM: 3 }))).toBe(onTop(rough({ roughingStepDownMM: 20 })))
  })

  it('roughs across the finishing direction by default', () => {
    // Finish at 0° steps in Y; the rough defaults to 90° and so steps in X.
    const { roughing } = split(rough())
    const plunges = roughing.filter((s, i) => i > 0 && !s.rapid && roughing[i - 1].rapid)
    const xs = new Set(plunges.map((s) => Math.round(s.x * 1e6)))
    const ys = new Set(plunges.map((s) => Math.round(s.y * 1e6)))
    expect(xs.size).toBeGreaterThan(ys.size)
  })
})
