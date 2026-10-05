// 3D profile — a ball nose or taper following an STL surface, tip-referenced (Z = 0 at the
// top of the model, negative into the stock).
//
// The surfaces here are built as meshes from height functions whose true height is known
// at every point, so a test can ask where the tool is against the SURFACE rather than
// against the code's own height map.
import { describe, it, expect } from 'vitest'
import { buildHeightMap, generateProfile3d, StockModel, ballKernel, flatKernel, profile3dDepthMM, STOCK_SKIN_MM, modelBelowCut, type Profile3dParams } from './profile3d'
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

describe('the stock model that entries rapid down onto', () => {
  // Two ball passes 5.4 mm apart (90% of a 6 mm ball) at Z = −5.7 leave a scallop between
  // them whose crest stands R − √(R² − 2.7²) = 1.69 mm above their floor. An entry midway
  // must be told the crest is there; a carve that read only the floor would rapid the tip
  // 1.69 mm into it. End to end this rarely decides anything — an entry is usually held
  // up by uncut stock nearby — so the bound is pinned here, on its own.
  const R = 3
  const crest = -5.7 + R - Math.sqrt(R * R - 2.7 * 2.7)
  const passes = () => {
    const segs: MotionSegment[] = []
    for (const y of [-5.4, 0, 5.4]) for (let x = 0; x <= 20 + 1e-9; x += 0.1) segs.push({ x, y, z: -5.7, rapid: false })
    return segs
  }

  it('never reads the stock between two passes lower than the scallop they leave', () => {
    const stock = new StockModel(box(0, -10, 20, 20), 4)
    stock.carve(passes(), ballKernel(R))
    for (const x of [5, 10, 15]) {
      const tip = stock.clearTipZ(x, 2.7, ballKernel(R))
      expect(tip).toBeGreaterThanOrEqual(crest)
      // …and is not so cautious it stops the entry far above it: within a cell's slope.
      expect(tip).toBeLessThan(crest + 0.6)
    }
  })

  it('lets the same ball come back down on a pass it cut to below the scallops beside it', () => {
    // On the middle pass the tool stood at −5.7; the bound may lean high by a cell's
    // slope, but it must not stop the entry up at the crests either side.
    const stock = new StockModel(box(0, -10, 20, 20), 4)
    stock.carve(passes(), ballKernel(R))
    expect(stock.clearTipZ(10, 0, ballKernel(R))).toBeGreaterThanOrEqual(-5.7)
    expect(stock.clearTipZ(10, 0, ballKernel(R))).toBeLessThan(crest)
  })

  it('keeps an entry beside the wall of a slot clear of the stock standing at its edge', () => {
    // One pass at Y = 0 leaves a slot with uncut stock at Z = 0 past |y| = 3. An entry
    // across it has to keep the ball's flank above that wall, and the wall is where the
    // ball is steepest — so a node only a fraction of a cell nearer than the stock it
    // stands for is a real gouge. Checked against the slot's exact section.
    const stock = new StockModel(box(0, -10, 20, 20), 4)
    const segs: MotionSegment[] = []
    for (let x = 0; x <= 20 + 1e-9; x += 0.1) segs.push({ x, y: 0, z: -5.7, rapid: false })
    stock.carve(segs, ballKernel(R))
    const M = (y: number) => (Math.abs(y) < R ? -5.7 + R - Math.sqrt(R * R - y * y) : 0)
    for (let py = 0; py <= 2.5 + 1e-9; py += 0.05) {
      let need = -Infinity
      for (let y = py - R; y <= py + R; y += 0.002) need = Math.max(need, M(y) - (R - Math.sqrt(Math.max(0, R * R - (y - py) ** 2))))
      expect(stock.clearTipZ(10, py, ballKernel(R)), `y = ${py.toFixed(2)}`).toBeGreaterThanOrEqual(need)
    }
  })

  it('reads untouched stock as the stock top', () => {
    const stock = new StockModel(box(0, 0, 20, 20), 4)
    expect(stock.clearTipZ(10, 10, ballKernel(R))).toBe(0)
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

  it('stays down from one scanline to the next: one entry, one lift for the whole finish', () => {
    // Lifting to safe height at the end of every line, rapiding one stepover across and
    // feeding back down was half the run time of a relief. The groove is one surface edge
    // to edge, so nothing on it needs a lift.
    const segs = run()
    const lifts = segs.filter((s, i) => i > 0 && s.rapid && s.z === SAFE_Z && !segs[i - 1].rapid)
    const entries = segs.filter((s, i) => i > 0 && !s.rapid && segs[i - 1].rapid)
    expect(lifts).toHaveLength(1)
    expect(entries).toHaveLength(1)
  })

  it('never cuts across the model in one straight move — a link follows the surface too', () => {
    // Every cutting move, the links between scanlines included, is one short sample of the
    // gouge-free surface; the gouge tests below measure all of them against the mesh.
    const segs = run()
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], s = segs[i]
      if (s.rapid || a.rapid) continue
      expect(Math.hypot(s.x - a.x, s.y - a.y)).toBeLessThan(0.5)
    }
  })

  it('clears a hole in the model to its lowest point, as the floor of its box', () => {
    // Two 12 mm strips 16 mm apart, 2 mm down. Between them the model has no surface; it
    // used to be lifted over as uncut stock, which left the corners of a round relief's
    // square box standing. Inside the model's box, ground the model does not cover is now a
    // floor at its lowest point — here the strips' own height — and is cut like them.
    const strip = (x0: number) => mesh(() => -2, 12, 40, 12).positions.map((v, i) => (i % 3 === 0 ? v + x0 : v))
    const positions = new Float32Array([...strip(0), ...strip(28)])
    const bounds = { minX: 0, maxX: 40, minY: 0, maxY: 40, minZ: -2, maxZ: 0 }
    const segs = generateProfile3d(positions, null, bounds, box(0, 0, 40, 40), BALL, params({ stepoverPercent: 50 }))
    const inGap = cuts(segs).filter((s) => s.x > 17 && s.x < 23)
    expect(inGap.length).toBeGreaterThan(50)
    for (const s of inGap) expect(s.z).toBeCloseTo(-2, 6)
    // And the scanlines run straight across it: one entry for the whole finish.
    const entries = segs.filter((s, i) => i > 0 && !s.rapid && segs[i - 1].rapid)
    expect(entries.length).toBe(1)
    // The roughing reads the height map, not the triangles: it clears the gap too.
    const rough = generateProfile3d(positions, null, bounds, box(0, 0, 40, 40), BALL, params({
      stepoverPercent: 50, roughingRadiusMM: 3, roughingStepoverPercent: 50, roughingStepDownMM: 3, roughingStockAllowanceMM: 0.3,
    }))
    const roughGap = cuts(rough.slice(0, rough.findIndex((s) => s.toolChange))).filter((s) => s.x > 17 && s.x < 23)
    expect(roughGap.length).toBeGreaterThan(20)
    for (const s of roughGap) expect(s.z).toBeCloseTo(-2 + 0.3, 6)
  })

  it('rapids down to just above the stock instead of feeding from safe height', () => {
    // With nothing cut yet the stock top is Z = 0: the entry rapids to 1 mm above it, then
    // feeds the last millimetre onto the surface.
    const segs = run()
    const k = segs.findIndex((s) => !s.rapid)
    expect(segs.slice(k - 2, k + 1)).toMatchObject([
      { z: SAFE_Z, rapid: true }, { z: 1, rapid: true }, { z: 0, rapid: false },
    ])
  })

  it('puts its last scanline ON the far edge, not up to a stepover short of it', () => {
    // 40 mm is not a whole number of 1.8 mm stepovers: stepping and stopping left the last
    // line 0.4 mm short; at a roughing stepover it was up to 3 mm, a strip of stock the
    // finish then had to take in one go.
    for (const [angle, key] of [[0, 'y'], [90, 'x']] as const) {
      const c = cuts(run(BALL, { rasterAngleDeg: angle }))
      expect(Math.max(...c.map((s) => s[key])), `${angle}°`).toBeCloseTo(W, 6)
      expect(Math.min(...c.map((s) => s[key])), `${angle}°`).toBeCloseTo(0, 6)
    }
  })

  it('spaces its scanlines by the stepover, in the direction of the raster angle', () => {
    const stepover = BALL.diameterMM * 0.3
    // A scanline is a value many cuts share; the links between lines pass through others.
    const lines = (segs: MotionSegment[], key: 'x' | 'y') => {
      const n = new Map<number, number>()
      for (const s of cuts(segs)) { const v = Math.round(s[key] * 1e6) / 1e6; n.set(v, (n.get(v) ?? 0) + 1) }
      return [...n].filter(([, c]) => c > 20).map(([v]) => v).sort((a, b) => a - b)
    }
    const ys = lines(run(BALL, { rasterAngleDeg: 0 }), 'y')
    for (let i = 1; i < ys.length - 1; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(stepover, 6)
    // At 90° the scanlines run along Y, so it is X that steps.
    const xs = lines(run(BALL, { rasterAngleDeg: 90 }), 'x')
    expect(xs.length).toBe(ys.length)
  })

  it('uses its own safe height', () => {
    // It starts and finishes there, and no rapid goes above it.
    const segs = run(BALL, { safeHeightMM: 12 })
    expect(segs[0]).toMatchObject({ z: 12, rapid: true })
    expect(segs[segs.length - 1]).toMatchObject({ z: 12, rapid: true })
    for (const s of segs.filter((s) => s.rapid)) expect(s.z).toBeLessThanOrEqual(12)
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
    roughingRadiusMM: 3, roughingStepoverPercent: 40, roughingStepDownMM: 3,
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
    // The finish is the raster a finishing-only run produces, less the cuts that would take
    // nothing off the stock the roughing left — here the block's top, which IS the stock top.
    // Wherever both cut the same point they cut it at the same height (the links across the
    // skipped ground are new points, so they are not compared).
    const xy = (s: MotionSegment) => `${s.x},${s.y}`
    const alone = run(BALL).filter((s) => !s.rapid && !s.travel)
    const zAlone = new Map(alone.map((s) => [xy(s), s.z]))
    for (const s of finishing) {
      if (s.rapid || s.travel || !zAlone.has(xy(s))) continue
      expect(s.z).toBe(zAlone.get(xy(s)))
    }
    const after = new Set(finishing.filter((s) => !s.rapid && !s.travel).map(xy))
    const dropped = alone.filter((s) => !after.has(xy(s)))
    expect(dropped.length).toBeGreaterThan(0)
    for (const s of dropped) expect(s.z).toBeGreaterThan(-0.01)
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

  it('rides the cleared top between two grooves as travel, instead of lifting over it', () => {
    // Scanlines across two grooves: from level 2 on, the top between them is already at
    // its allowance, so each line is two runs with cleared ground between. The tool runs
    // along the groove level 1 cut there, as a travel move, and each level enters once.
    const TWO: Height = (x) => -Math.max(0, 6 - Math.abs(x - 10), 6 - Math.abs(x - 30))
    const m = mesh(TWO, W, W, 40)
    const segs = generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), BALL, params({
      roughingRadiusMM: 3, roughingStepoverPercent: 40, roughingStepDownMM: 2,
      roughingStockAllowanceMM: 0.3, roughingRasterAngleDeg: 0,
    }))
    const { roughing } = split(segs)
    const travel = roughing.filter((s) => s.travel)
    expect(travel.length).toBeGreaterThan(100)
    // Over the flat top between the grooves, it rides exactly at the allowance.
    for (const s of travel.filter((s) => s.x > 19 && s.x < 21)) expect(s.z).toBeCloseTo(0.3, 6)
    // Three 2 mm levels in 6 mm grooves, one entry each for the raster — plus, on the two
    // later levels, the pass round the model's box wall: it cuts the four groove ends on the
    // box edge, and the 40 mm of cleared edge between two of them is quicker to lift over
    // than to ride, so at most two more per level.
    const entries = roughing.filter((s, i) => i > 0 && !s.rapid && roughing[i - 1].rapid)
    expect(entries.length).toBeLessThanOrEqual(3 + 2 * 2)
  })

  it('never rapids into the stock any earlier move left', { timeout: 30000 }, () => {
    // The claim that makes the shallow entries safe, checked against stock carved here by
    // the emitted moves themselves — not by the code under test. Every cutting point lowers
    // a 0.1 mm stock grid under the ball; each rapid must then leave the whole tool clear
    // of it. Carving at the points alone leaves the stock HIGHER than the machine would
    // (the moves between them cut more), so this can only be stricter than the truth.
    //
    // An entry on a line the roughing itself cut is safe almost whatever the carve says —
    // the tool stood there. The carve earns its keep where the finish re-enters BETWEEN
    // rough lines, which is what the strips do: the finish lifts over the hole between
    // them on every line, and comes back down beside it, mid-way between two rough passes
    // 90% of a diameter apart — whose scallops stand 1.7 mm, above the 1 mm clearance.
    const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 15 ? Math.sqrt(225 - r * r) - 15 : -15 }
    const strip = (x0: number) => mesh(() => -6, 12, 40, 12).positions.map((v, i) => (i % 3 === 0 ? v + x0 : v))
    const strips = {
      positions: new Float32Array([...strip(0), ...strip(28)]),
      bounds: { minX: 0, maxX: 40, minY: 0, maxY: 40, minZ: -6, maxZ: 0 },
    }
    const roughAt = { roughingRadiusMM: 3, roughingStepoverPercent: 50, roughingStepDownMM: 3, roughingStockAllowanceMM: 0.3 }
    for (const [name, m, over] of [
      ['dome', mesh(DOME, W, W, 40), roughAt],
      ['groove', mesh(GROOVE, W, W, 40), roughAt],
      ['strips', strips, { ...roughAt, roughingStepoverPercent: 90, roughingRasterAngleDeg: 0 }],
    ] as const) {
      const segs = generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), BALL, params(over))
      const R = 3, c = 0.1, o = -4, n = Math.round((W + 8) / c) + 1
      const stock = new Float32Array(n * n)
      const f = (d: number) => R - Math.sqrt(R * R - d * d)
      const nodes = (x: number, y: number, fn: (k: number, d: number) => void) => {
        for (let j = Math.ceil((y - R - o) / c); j <= Math.floor((y + R - o) / c); j++) {
          for (let i = Math.ceil((x - R - o) / c); i <= Math.floor((x + R - o) / c); i++) {
            const d = Math.hypot(o + i * c - x, o + j * c - y)
            if (d < R) fn(j * n + i, d)
          }
        }
      }
      let entries = 0, worst = Infinity
      for (const s of segs) {
        if (s.rapid) {
          if (s.z < SAFE_Z) entries++
          nodes(s.x, s.y, (k, d) => { worst = Math.min(worst, s.z + f(d) - stock[k]) })
        } else {
          nodes(s.x, s.y, (k, d) => { const top = s.z + f(d); if (top < stock[k]) stock[k] = top })
        }
      }
      expect(entries, name).toBeGreaterThan(2)
      expect(worst, name).toBeGreaterThanOrEqual(0)
    }
  })

  it('rapids a later level down into the ground the earlier ones cleared', () => {
    // Level 1 took the groove to 2.7 mm, so level 2 does not feed down from the stock top
    // to reach it. It stops short of that floor by more than the 1 mm clearance: the ball
    // coming down there must also clear the groove's walls within its radius.
    const { roughing } = split(rough())
    const descents = roughing.filter((s, i) => i > 0 && s.rapid && s.z < SAFE_Z && roughing[i - 1].rapid)
    expect(descents.length).toBeGreaterThan(1)
    expect(Math.min(...descents.map((s) => s.z))).toBeLessThan(-0.5)
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

describe('a 3D Profile never cuts through the stock', () => {
  // A model deeper than the stock, or a max depth set past it, was cut to that depth —
  // through the stock and into the table, over the whole floor once waterline finished
  // flats.
  it('stops a cut deeper than the stock half a millimetre above its bottom', () => {
    expect(profile3dDepthMM(15, 12)).toBe(12 - STOCK_SKIN_MM)
    expect(STOCK_SKIN_MM).toBe(0.5)
  })
  it('leaves a cut within the stock as deep as it was asked to be', () => {
    expect(profile3dDepthMM(8, 12)).toBe(8)
  })
})

describe('a model sunk below the cut is refused', () => {
  // Then nothing of the model is reached: the raster cut one flat at the depth and the
  // waterline cut nothing, and neither said why.
  it('refuses a model whose top is at or below the depth cut', () => {
    expect(modelBelowCut(10, 10)).toBe(true)
    expect(modelBelowCut(12, 10)).toBe(true)
  })
  it('accepts a model whose top is above the depth cut, or not sunk at all', () => {
    expect(modelBelowCut(9.5, 10)).toBe(false)
    expect(modelBelowCut(undefined, 10)).toBe(false)
  })
})

describe('a machining boundary', () => {
  // A dome on a floor filling the 40 mm model box, inside a boundary 8 mm out from it all
  // round. Inside the boundary and outside the model is ground the model does not cover:
  // it is cleared to the model's base. A 6 mm roughing ball and the 6 mm finishing ball.
  const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 15 ? Math.sqrt(225 - r * r) - 15 : -15 }
  const dome = mesh(DOME, W, W, 40)
  const OUT: [number, number][] = [[-8, -8], [48, -8], [48, 48], [-8, 48]]
  const ROUGH_R = 4
  const gen = (over: Partial<Profile3dParams> = {}) =>
    generateProfile3d(dome.positions, null, dome.bounds, box(0, 0, W, W), BALL, params({
      roughingRadiusMM: ROUGH_R, roughingStepoverPercent: 40, roughingStepDownMM: 6, roughingStockAllowanceMM: 0.3,
      boundaryRings: [OUT], ...over,
    }))
  const withBoundary = gen()
  const parts = (segs: MotionSegment[]) => {
    const k = segs.findIndex((s) => s.toolChange)
    return { roughing: cuts(segs.slice(0, k)), finishing: cuts(segs.slice(k + 1)) }
  }
  /** How far inside the rectangle [x0,x1]×[y0,y1] the point is (negative outside). */
  const depthIn = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
    Math.min(x - x0, x1 - x, y - y0, y1 - y)

  it('keeps each tool\'s EDGE inside the boundary — each by its own radius', () => {
    const { roughing, finishing } = parts(withBoundary)
    for (const s of roughing) expect(depthIn(s.x, s.y, -8, -8, 48, 48)).toBeGreaterThanOrEqual(ROUGH_R - 0.01)
    for (const s of finishing) expect(depthIn(s.x, s.y, -8, -8, 48, 48)).toBeGreaterThanOrEqual(3 - 0.01)
    // ... and both reach the line, or the finish leaves the rougher's scallops standing.
    expect(Math.min(...finishing.map((s) => depthIn(s.x, s.y, -8, -8, 48, 48)))).toBeLessThan(3 + 0.05)
    expect(Math.min(...roughing.map((s) => depthIn(s.x, s.y, -8, -8, 48, 48)))).toBeLessThan(ROUGH_R + 0.05)
  })

  it('clears the ground the model does not cover down to the model\'s base, and no deeper', () => {
    const { finishing } = parts(withBoundary)
    expect(Math.min(...finishing.map((s) => s.z))).toBeGreaterThanOrEqual(-15 - 1e-9)
    const floor = finishing.filter((s) => Math.abs(s.z + 15) < 1e-6)
    // Every point of the margin between the model's box and the boundary has a finishing
    // pass at the base within a stepover of it.
    const step = BALL.diameterMM * 0.3
    for (let x = -4.5; x <= 44.5; x += 1.5) {
      for (const y of [-4.5, -3, 43, 44.5]) {
        const near = Math.min(...floor.map((s) => Math.hypot(s.x - x, s.y - y)))
        expect(near, `${x},${y}`).toBeLessThan(step)
      }
    }
  })

  it('keeps out of a hole in the boundary — each tool\'s edge stays outside it too', () => {
    const HOLE: [number, number][] = [[44, 10], [44, 30], [38, 30], [38, 10]]
    const { roughing, finishing } = parts(gen({ boundaryRings: [OUT, HOLE] }))
    const fromHole = (s: MotionSegment) => Math.hypot(Math.max(38 - s.x, 0, s.x - 44), Math.max(10 - s.y, 0, s.y - 30))
    for (const s of roughing) expect(fromHole(s)).toBeGreaterThanOrEqual(ROUGH_R - 0.01)
    for (const s of finishing) expect(fromHole(s)).toBeGreaterThanOrEqual(3 - 0.01)
  })

  it('never short-cuts across a corner of the boundary between two lines', () => {
    // An L: the raster's lines end on its inner corner's two edges, and a straight link
    // from one line's end to the next cuts across the corner — outside the boundary by
    // less than the two grid cells a link may otherwise bridge.
    const L: [number, number][] = [[-8, -8], [48, -8], [48, 48], [20, 48], [20, 20.4], [-8, 20.4]]
    const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 15 ? Math.sqrt(225 - r * r) - 15 : -15 }
    const m = mesh(DOME, W, W, 40)
    const segs = generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), BALL, params({ boundaryRings: [L], rasterAngleDeg: 30 }))
    // The notch the L leaves out is x < 20, y > 20.4: every move keeps the tool centre a
    // full radius from it, all along the move.
    let nearest = Infinity
    for (let k = 1; k < segs.length; k++) {
      const a = segs[k - 1], b = segs[k]
      if (b.rapid || a.rapid || b.z > 0) continue
      for (let t = 0; t <= 1; t += 0.05) {
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
        nearest = Math.min(nearest, Math.hypot(Math.max(x - 20, 0), Math.max(20.4 - y, 0)))
      }
    }
    expect(nearest).toBeGreaterThanOrEqual(3 - 0.02)
  })

  it('refuses a boundary with no room for the tool inside it', () => {
    expect(() => gen({ boundaryRings: [[[10, 10], [14, 10], [14, 14], [10, 14]]] })).toThrow(/too small/)
  })

  it('finishes right to an OPEN boundary — the stock\'s own edge — leaving no wall, and runs no more than its radius past it', () => {
    // Measured as what the ball leaves AT the edge, not by how far its centre goes: it once
    // ran a full radius past on every row, because the stock model held stock outside the
    // stock that no carve ever reached, and that is no part of leaving no wall.
    const { finishing } = parts(gen({ boundaryOpen: true }))
    const outMost = Math.min(...finishing.map((s) => depthIn(s.x, s.y, -8, -8, 48, 48)))
    expect(outMost).toBeGreaterThanOrEqual(-3 - 0.01)
    const R = BALL.diameterMM / 2
    // No higher than a scallop between two rows a stepover apart: that much stands between
    // any two passes, at the edge or anywhere else.
    const half = BALL.diameterMM * 0.3 / 2
    const scallop = R - Math.sqrt(R * R - half * half)
    // Along the left edge, beside the model's box: the lowest the ball's surface came.
    for (let y = -6; y <= 46; y += 0.5) {
      let low = Infinity
      for (const s of finishing) {
        const d2 = (s.x + 8) ** 2 + (s.y - y) ** 2
        if (d2 < R * R) low = Math.min(low, s.z + R - Math.sqrt(R * R - d2))
      }
      expect(low, `edge at y=${y}`).toBeLessThan(-15 + scallop + 1e-6)
    }
  })

  it('finishes with one pass round the model\'s box, so line ends leave no cusps on its wall', () => {
    // Without a boundary, a raster along X touches the box's left edge only where its lines
    // end, a stepover apart; the pass round the box runs the whole edge.
    const segs = run(BALL, { stepoverPercent: 30 })
    const onLeft = cuts(segs).filter((s) => Math.abs(s.x) < 1e-6).map((s) => s.y).sort((a, b) => a - b)
    let gap = onLeft[0]
    for (let k = 1; k < onLeft.length; k++) gap = Math.max(gap, onLeft[k] - onLeft[k - 1])
    gap = Math.max(gap, W - onLeft[onLeft.length - 1])
    expect(gap).toBeLessThan(0.5)
  })
})

describe('a model sunk below the stock top', () => {
  it('drops every height of the finish by the depth it is sunk', () => {
    const at0 = cuts(run(BALL)), at2 = cuts(run(BALL, { modelTopMM: 2 }))
    expect(at2.length).toBe(at0.length)
    for (let k = 0; k < at0.length; k++) {
      expect(at2[k].x).toBe(at0[k].x)
      expect(at2[k].y).toBe(at0[k].y)
      expect(at2[k].z).toBeCloseTo(at0[k].z - 2, 9)
    }
  })

  it('drops a taper\'s finish the same way — it reads the height map, not the triangles', { timeout: 30000 }, () => {
    const at0 = cuts(run(TAPER)), at2 = cuts(run(TAPER, { modelTopMM: 2 }))
    expect(at2.length).toBe(at0.length)
    for (let k = 0; k < at0.length; k += 7) expect(at2[k].z).toBeCloseTo(at0[k].z - 2, 6)
  })

  it('finishes its flat top, which is no longer the stock top', { timeout: 30000 }, () => {
    // A waterline stops just under the highest point; at the stock top that is the top
    // itself and is left alone, but sunk it has to be cut like any other flat.
    const MESA: Height = (x, y) => -Math.min(8, Math.max(0, Math.hypot(x - 20, y - 20) - 8))
    const m = mesh(MESA, W, W, 40)
    const onTop = (modelTopMM: number) => cuts(generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), BALL,
      params({ finishStrategy: 'waterline', modelTopMM }))).filter((s) => Math.hypot(s.x - 20, s.y - 20) < 4)
    expect(onTop(0)).toEqual([])
    const sunk = onTop(2)
    expect(sunk.length).toBeGreaterThan(0)
    for (const s of sunk) expect(s.z).toBeCloseTo(-2, 6)
  })
})

describe('roughing with a flat end mill', () => {
  // A dome of radius 8 on a floor 8 down, in the 40 mm box — plenty of open floor round
  // it — roughed with a 6 mm end mill at 3 mm levels and a 0.3 mm allowance.
  const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 8 ? Math.sqrt(64 - r * r) - 8 : -8 }
  const dome = mesh(DOME, W, W, 80)
  const R = 3, ALLOW = 0.3
  const gen = (over: Partial<Profile3dParams> = {}) =>
    generateProfile3d(dome.positions, null, dome.bounds, box(0, 0, W, W), BALL, params({
      roughingRadiusMM: R, roughingFlat: true, roughingStepoverPercent: 50, roughingStepDownMM: 3,
      roughingStockAllowanceMM: ALLOW, ...over,
    }))
  const parts = (segs: MotionSegment[]) => {
    const k = segs.findIndex((s) => s.toolChange)
    return { roughing: cuts(segs.slice(0, k)), finishing: cuts(segs.slice(k + 1)) }
  }
  const raster = parts(gen())

  it('never cuts into the model anywhere under its flat bottom — beside a near-vertical wall too', () => {
    // The bottom is level out to the rim: every surface point under it must be at or below
    // the tip. The grid holds each cell's highest point at its node, so a wall half a cell
    // past a node's reach could still meet the rim; the rim reaches that much further.
    let worst = 0
    for (const s of raster.roughing) {
      for (let u = Math.max(0, s.x - R); u <= Math.min(W, s.x + R); u += 0.1) {
        for (let v = Math.max(0, s.y - R); v <= Math.min(W, s.y + R); v += 0.1) {
          if (Math.hypot(u - s.x, v - s.y) <= R) worst = Math.max(worst, dome.at(u, v) - s.z)
        }
      }
    }
    expect(worst).toBeLessThan(0.02)
  })

  it('never clips a near-vertical wall with its rim, whichever side of a grid node the wall falls', () => {
    // A boss whose side drops 6 mm within one 0.2 mm mesh cell. The grid keeps each cell's
    // highest point at its node, up to half a cell diagonal from where that point really is,
    // so a rim reaching exactly its radius missed a wall standing just inside it: 0.6–0.9 mm
    // into the wall, at four different wall radii and mesh spacings.
    const BOSS: Height = (x, y) => (Math.hypot(x - 20, y - 20) < 8.3 ? 0 : -6)
    const m = mesh(BOSS, W, W, 200)
    const segs = generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), BALL, params({
      roughingRadiusMM: R, roughingFlat: true, roughingStepoverPercent: 50, roughingStepDownMM: 3, roughingStockAllowanceMM: 0,
    }))
    let worst = 0
    for (const s of parts(segs).roughing) {
      if (Math.abs(Math.hypot(s.x - 20, s.y - 20) - 8.3) > R + 0.5) continue   // only near the wall
      for (let u = s.x - R; u <= s.x + R; u += 0.05) {
        for (let v = s.y - R; v <= s.y + R; v += 0.05) {
          if (u < 0 || v < 0 || u > W || v > W || Math.hypot(u - s.x, v - s.y) > R) continue
          worst = Math.max(worst, m.at(u, v) - s.z)
        }
      }
    }
    expect(worst).toBeLessThan(0.02)
  })

  it('cuts a flat to its final depth — its bottom IS the finish there, so no allowance', () => {
    // The last level over the floor (the earlier ones cross it at −3, −6, …).
    // (Clear of the dome by the rim's reach and the half grid cell it is widened by, so a
    // steep wall between nodes cannot meet it.)
    const onFloor = raster.roughing.filter((s) => Math.hypot(s.x - 20, s.y - 20) > 8 + R + 2 && s.z < -7)
    expect(onFloor.length).toBeGreaterThan(50)
    // Within the 0.01 mm a surface may vary under the bottom and still count as level —
    // not the 0.3 mm allowance.
    for (const s of onFloor) expect(s.z).toBeLessThanOrEqual(-8 + 0.01)
  })

  it('leaves the allowance everywhere the surface under it is not level', () => {
    const onDome = raster.roughing.filter((s) => Math.hypot(s.x - 20, s.y - 20) < 6 && s.z > -7)
    expect(onDome.length).toBeGreaterThan(20)
    for (const s of onDome) expect(s.z - dome.at(s.x, s.y)).toBeGreaterThanOrEqual(ALLOW - 1e-6)
  })

  it('records the stock it leaves as a flat bottom, never lower than it really cut', () => {
    const stock = new StockModel(box(0, 0, 20, 20), 4)
    stock.carve([{ x: 10, y: 10, z: -2, rapid: false }], flatKernel(R))
    for (let j = 0; j < stock.ny; j++) {
      for (let i = 0; i < stock.nx; i++) {
        const x = stock.minX + i * stock.cell, y = stock.minY + j * stock.cell
        const z = stock.z[j * stock.nx + i]
        const d = Math.hypot(x - 10, y - 10)
        expect(z).toBeGreaterThanOrEqual(-2)                  // an upper bound: never below the cut
        if (d < R - stock.cell) expect(z).toBe(-2)            // well under the bottom: the cut itself
        if (d > R) expect(z).toBe(0)                          // past the rim: untouched
      }
    }
  })

  describe('and the finish that follows it', () => {
    /** The stock the roughing moves leave, carved here independently on a 0.2 mm grid. */
    function roughStock(roughing: MotionSegment[]) {
      const c = 0.2, n = Math.round(W / c) + 1
      const z = new Float32Array(n * n).fill(0)
      for (let k = 1; k < roughing.length; k++) {
        const a = roughing[k - 1], b = roughing[k]
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05))
        for (let t = 0; t <= steps; t++) {
          const x = a.x + (b.x - a.x) * t / steps, y = a.y + (b.y - a.y) * t / steps, zz = a.z + (b.z - a.z) * t / steps
          for (let j = Math.max(0, Math.ceil((y - R) / c)); j <= Math.min(n - 1, Math.floor((y + R) / c)); j++) {
            for (let i = Math.max(0, Math.ceil((x - R) / c)); i <= Math.min(n - 1, Math.floor((x + R) / c)); i++) {
              if (Math.hypot(i * c - x, j * c - y) <= R && zz < z[j * n + i]) z[j * n + i] = zz
            }
          }
        }
      }
      return (x: number, y: number) => z[Math.round(y / c) * n + Math.round(x / c)]
    }

    /** The floor clear of the dome — and of the box's edge, where the stock model is
     *  deliberately cautious (it reads every cut a little narrower than it was, and the
     *  finishing ball a little wider, so beside the uncut stock outside the box it keeps
     *  the finish: cutting a little more is the safe side to err on). */
    // Within the end mill's radius of the dome the roughing left its allowance, and the
    // finishing ball reaches its own radius further: the open floor starts beyond both.
    // A ride across finished ground is `travel`, not a cut.
    // (A stretch that does need cutting ends a point past where it stops needing it, and a
    // floor ring crosses these margins at a slant: 2 mm of room either side.)
    const openFloor = (s: MotionSegment) => !s.travel && Math.hypot(s.x - 20, s.y - 20) > 8 + R + BALL.diameterMM / 2 + 2 &&
      Math.min(s.x, s.y, W - s.x, W - s.y) > 3 + 2

    it('skips the floor the end mill finished', () => {
      expect(raster.finishing.filter(openFloor)).toEqual([])
      // ... which a finish with no roughing before it cuts all over.
      expect(cuts(generateProfile3d(dome.positions, null, dome.bounds, box(0, 0, W, W), BALL, params())).filter(openFloor).length).toBeGreaterThan(200)
    })

    it('skips nothing that still has stock on it — every cut it leaves out would take nothing', { timeout: 60000 }, () => {
      const alone = cuts(generateProfile3d(dome.positions, null, dome.bounds, box(0, 0, W, W), BALL, params()))
      const made = new Set(raster.finishing.map((s) => `${s.x},${s.y}`))
      const left = roughStock(raster.roughing)
      const Rb = BALL.diameterMM / 2
      let worst = 0, skipped = 0
      for (const s of alone) {
        if (made.has(`${s.x},${s.y}`)) continue
        skipped++
        // What the ball at this point would take off the stock the roughing left.
        for (let u = Math.max(0, s.x - Rb); u <= Math.min(W, s.x + Rb); u += 0.2) {
          for (let v = Math.max(0, s.y - Rb); v <= Math.min(W, s.y + Rb); v += 0.2) {
            const d = Math.hypot(u - s.x, v - s.y)
            if (d <= Rb) worst = Math.max(worst, left(u, v) - (s.z + toolProfileHeightMM(BALL, d)))
          }
        }
      }
      expect(skipped).toBeGreaterThan(100)
      expect(worst).toBeLessThan(0.02)
    })

    it('skips a waterline\'s floor rings the same way', { timeout: 30000 }, () => {
      const { finishing } = parts(gen({ finishStrategy: 'waterline' }))
      expect(finishing.filter(openFloor)).toEqual([])
      expect(cuts(generateProfile3d(dome.positions, null, dome.bounds, box(0, 0, W, W), BALL, params({ finishStrategy: 'waterline' }))).filter(openFloor).length).toBeGreaterThan(200)
      // ... while the dome itself is still finished.
      expect(finishing.filter((s) => Math.hypot(s.x - 20, s.y - 20) < 6).length).toBeGreaterThan(50)
    })
  })
})
