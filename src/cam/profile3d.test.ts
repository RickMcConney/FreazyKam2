// 3D profile — a ball nose or taper following an STL surface, tip-referenced (Z = 0 at the
// top of the model, negative into the stock).
//
// The surfaces here are built as meshes from height functions whose true height is known
// at every point, so a test can ask where the tool is against the SURFACE rather than
// against the code's own height map.
import { describe, it, expect } from 'vitest'
import { findRapidGouges } from '../sim/rapidGouge'
import type { SimSegment, ToolState } from '../sim/gcodeParser'
import { buildHeightMap, generateProfile3d, StockModel, ballKernel, flatKernel, profile3dDepthMM, modelBelowCut, modelPreviewTrim, type Profile3dParams } from './profile3d'
import { maxCutRadiusMM, toolProfileHeightMM } from './geom'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'
import type { BBox } from '../canvas/selectionUtils'

const BALL: Tool = { id: 'ball', name: 'Ball 6', type: 'ballnose', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20 }
const TAPER: Tool = { id: 'taper', name: 'Taper', type: 'taper', diameterMM: 1, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25, vbitAngleDeg: 5 }
// A bowl bit in miniature: Ø6 with a 1.5 mm corner, so a 3 mm flat across its middle.
const BULL: Tool = { id: 'bull', name: 'Bull 6', type: 'bullnose', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20, cornerRadiusMM: 1.5 }
// A small corner is the hard case: the tighter the corner, the more a coarse grid misses.
const BULL_SMALL: Tool = { ...BULL, id: 'bull-s', cornerRadiusMM: 0.5 }
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
/** The groove sunk 1 mm, so its flats have stock above them. The flats of `groove` itself are
 *  AT the stock top, where a finish has nothing to take and cuts nothing — a test of how the
 *  raster cuts a flat needs one with something on it. */
const SUNK = { modelTopMM: 1 }
/** Over the model's own box. Boundary "model" lets each tool's centre run its radius past
 *  the box, where the ground is a floor at the model's lowest point; a test about how the
 *  MODEL is cut reads the moves over it. */
const inBox = (s: MotionSegment, size = W) => s.x >= 0 && s.x <= size && s.y >= 0 && s.y <= size
/** Every point the tool passes through on the cutting moves, every 0.05 mm — the machine
 *  cuts all along a move, not only at its ends, and where a tool's profile is near vertical
 *  the ends alone read high. Rapids and travel (a G0 with links as rapids) are left out. */
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

/** The stock `pts` leave on an n × n grid of `c` mm from the origin, from Z0 down: at each
 *  node the lowest the tool's own surface came. Carving several passes into one grid is
 *  cutting them in turn. */
function carveGrid(z: Float32Array, n: number, c: number, pts: { x: number; y: number; z: number }[], tool: Tool): Float32Array {
  const r = maxCutRadiusMM(tool)
  for (const p of pts) {
    for (let j = Math.max(0, Math.ceil((p.y - r) / c)); j <= Math.min(n - 1, Math.floor((p.y + r) / c)); j++) {
      for (let i = Math.max(0, Math.ceil((p.x - r) / c)); i <= Math.min(n - 1, Math.floor((p.x + r) / c)); i++) {
        const d = Math.hypot(i * c - p.x, j * c - p.y)
        if (d > r) continue
        const top = p.z + toolProfileHeightMM(tool, d)
        if (top < z[j * n + i]) z[j * n + i] = top
      }
    }
  }
  return z
}

/** The fed moves that run wholly at or above the stock top — through air. A climb from a cut
 *  below it onto it is not one: it sweeps through the stock beside the cut, so it is fed. */
const fedThroughAir = (segs: MotionSegment[]) =>
  segs.filter((b, k) => k > 0 && !b.rapid && !b.travel && b.z >= 0 && segs[k - 1].z >= 0 && !segs[k - 1].rapid)

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
  it('refuses a V-bit and a drill — but not an end mill, which finishes flats and walls', () => {
    for (const type of ['vbit', 'drill'] as const) {
      expect(() => run({ ...BALL, type })).toThrow('3D Profile requires a ball nose, bull nose, taper or end mill tool')
    }
    expect(() => run({ ...BALL, type: 'endmill' })).not.toThrow()
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
      const flat = cuts(run(tool, SUNK)).filter((s) => inBox(s) && (s.x < 20 - 8 - 4 || s.x > 20 + 8 + 4))
      expect(flat.length, tool.type).toBeGreaterThan(100)
      // To half a micron: a taper reads the grid, and right at the box's edge the line from
      // the last node on the top to the first one past it sags a fraction of a micron.
      for (const s of flat) expect(s.z, tool.type).toBeCloseTo(-1, 3)
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
    const bottom = Math.min(...cuts(run()).filter((s) => inBox(s)).map((s) => s.z))
    expect(bottom).toBeGreaterThanOrEqual(fits - 1e-3)
    expect(bottom).toBeLessThan(fits + cell)
  })

  it('stays down from one scanline to the next: one entry, one lift for the whole finish', () => {
    // Lifting to safe height at the end of every line, rapiding one stepover across and
    // feeding back down was half the run time of a relief. The groove is one surface edge
    // to edge, so nothing on it needs a lift.
    const segs = run(BALL, SUNK)
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
    // feeds the rest of the way onto the surface — here the box's corner, from a radius past it.
    const segs = run(BALL, SUNK)
    const k = segs.findIndex((s) => !s.rapid)
    expect(segs.slice(k - 2, k)).toMatchObject([{ z: SAFE_Z, rapid: true }, { z: 1, rapid: true }])
    expect(segs[k].z).toBeLessThan(-1)
  })

  it('puts its last scanline ON the far edge, not up to a stepover short of it', () => {
    // 46 mm is not a whole number of 1.8 mm stepovers: stepping and stopping left the last
    // line short; at a roughing stepover it was up to 3 mm, a strip of stock the finish then
    // had to take in one go. The edge is where the centre may go: the box, and the 3 mm
    // radius and 0.05 mm lead past it, less the limit's 0.01 mm arc tolerance.
    const edge = 3 + 0.04
    for (const [angle, key] of [[0, 'y'], [90, 'x']] as const) {
      const c = cuts(run(BALL, { ...SUNK, rasterAngleDeg: angle }))
      expect(Math.max(...c.map((s) => s[key])), `${angle}°`).toBeCloseTo(W + edge, 6)
      expect(Math.min(...c.map((s) => s[key])), `${angle}°`).toBeCloseTo(-edge, 6)
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
    const ys = lines(run(BALL, { ...SUNK, rasterAngleDeg: 0 }), 'y')
    for (let i = 1; i < ys.length - 1; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(stepover, 6)
    // At 90° the scanlines run along Y, so it is X that steps.
    const xs = lines(run(BALL, { ...SUNK, rasterAngleDeg: 90 }), 'x')
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
    // The flat across a bull nose's middle is where a ball-nose stand-in would gouge;
    // measured under the bull nose's own profile, it must not.
    it(`bull nose: ${name}`, { timeout: 30000 }, () => {
      expect(worstGouge(S, n, BULL, 30, W, 4)).toBeLessThan(GOUGE_TOL)
      expect(worstGouge(S, n, BULL_SMALL, 30, W, 4)).toBeLessThan(GOUGE_TOL)
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
    // Its rows are the same rows; along them the samples need not be the same points (the
    // grid spans the rougher's reach too, which moves them), so a cut counts as kept if the
    // run after roughing cuts within a sample of it on its row.
    const alone = run(BALL).filter((s) => !s.rapid && !s.travel)
    const rows = new Map<number, number[]>()
    for (const s of finishing) if (!s.rapid && !s.travel) {
      const k = Math.round(s.y * 1e6); (rows.get(k) ?? rows.set(k, []).get(k)!).push(s.x)
    }
    const kept = (s: MotionSegment) => (rows.get(Math.round(s.y * 1e6)) ?? []).some((x) => Math.abs(x - s.x) < 0.25)
    // (Points on the limit itself — the radius and 0.05 mm lead past the box, less the arc
    // tolerance — are left out: the lap round it runs there in both, and where a row's last
    // sample falls against it is a matter of sampling.)
    const onLimit = (s: MotionSegment) => Math.hypot(Math.max(0, -s.x, s.x - W), Math.max(0, -s.y, s.y - W)) > 3 + 0.04 - 0.02
    const dropped = alone.filter((s) => !kept(s) && !onLimit(s))
    expect(dropped.length).toBeGreaterThan(0)
    for (const s of dropped) expect(s.z).toBeGreaterThan(-0.01)
  })

  it('leaves the stock allowance for the finish — and does not cut the air over a top at the stock top', () => {
    // The block's flat top IS the stock top, so the allowance over it (Z+0.3) is above the
    // stock: the roughing takes nothing there and does not feed across it. Nowhere does it
    // come closer to the surface than the finish will.
    const { roughing, finishing } = split(rough())
    const top = cuts(roughing).filter((s) => !s.travel && inBox(s) && (s.x < 8 || s.x > 32))
    expect(top).toHaveLength(0)
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
    // so it is fed along as often in a three-pass rough as in a one-pass one. (Moves along
    // it, not points at its height: a climb out of a cut onto ground skipped as air is fed
    // too, and ends there — and three levels make three times as many of those.)
    const onTop = (segs: MotionSegment[]) => {
      const r = split(segs).roughing
      return r.filter((b, k) => k > 0 && !b.rapid && !b.travel && !r[k - 1].rapid
        && Math.abs(b.z - 0.3) < 1e-6 && Math.abs(r[k - 1].z - 0.3) < 1e-6).length
    }
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
    for (const s of travel.filter((s) => inBox(s) && s.x > 19 && s.x < 21)) expect(s.z).toBeCloseTo(0.3, 6)
    // Three 2 mm levels in 6 mm grooves, one entry each for the raster — plus, on the two
    // later levels, the pass round the limit a radius outside the box: it cuts the floor
    // past the box's two ends and runs in the air beside the top along its sides, so it is
    // two stretches, and starting at the point nearest the tool can split one: at most
    // three more per level.
    const entries = roughing.filter((s, i) => i > 0 && !s.rapid && roughing[i - 1].rapid)
    expect(entries.length).toBeLessThanOrEqual(3 + 2 * 3)
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
      // The grid spans the box and the 6 mm either tool's edge can reach past it.
      const R = 3, c = 0.1, o = -8, n = Math.round((W + 16) / c) + 1
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
  it('stops a cut deeper than the stock at its bottom', () => {
    expect(profile3dDepthMM(15, 12)).toBe(12)
  })
  it('cuts a model exactly as deep as its stock right to the bottom — no skin unless asked for', () => {
    // A 20 mm shaft in 20 mm stock was left on a 0.5 mm skin, with a warning that called it
    // deeper than the stock.
    expect(profile3dDepthMM(20, 20)).toBe(20)
  })
  it('leaves a cut within the stock as deep as it was asked to be — a skin, when that is what is set', () => {
    expect(profile3dDepthMM(8, 12)).toBe(8)
    expect(profile3dDepthMM(19.5, 20)).toBe(19.5)
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

describe('boundary "model" cuts the stock down to the model, right up to its vertical sides', () => {
  // A guitar neck fills its stock: 0.3 mm of wood beyond its outline, and its headstock runs
  // out to its box in three places. With the tool centre kept INSIDE the box, beside each of
  // them the tool could only stand on the model's top, and a full-height sliver was left.
  // Here a solid block 40 × 60, 10 tall, whose four vertical sides ARE its box, in stock
  // 0.3 mm bigger: every point of that 0.3 mm strip must be cut to the floor — for a ball, to
  // the fillet a round tip leaves where a wall meets a floor, and no higher.
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
  const END: Tool = { ...BALL, id: 'end', name: 'End 6', type: 'endmill' }
  /** The highest the finish leaves any point of the strip, above the floor and the fillet. */
  const leftBeside = (tool: Tool, over: Partial<Profile3dParams>) => {
    const segs = swept(generateProfile3d(block.positions, null, block.bounds, box(0, 0, BW, BH), tool, params({ maxDepthMM: 12, ...over })))
    const R = tool.diameterMM / 2
    // A ball runs past a side a radius and the limit's 0.04 mm off it (the 0.05 mm lead, less
    // the arc tolerance): its fillet is measured from there. Near the wall it is all but
    // vertical, and from a radius off it reads ~0.2 mm short.
    const off = R + 0.04
    const fillet = (d: number) => tool.type === 'ballnose' && off - d < R ? R - Math.sqrt(R * R - (off - d) ** 2) : 0
    let worst = 0
    const at = (x: number, y: number, d: number) => {
      let low = Infinity
      for (const s of segs) {
        const r = Math.hypot(s.x - x, s.y - y)
        if (r <= R) low = Math.min(low, s.z + toolProfileHeightMM(tool, r))
      }
      worst = Math.max(worst, low - B - fillet(d))
    }
    for (const d of [0.05, 0.15, 0.3]) {
      for (let t = 0; t <= BW; t += 1) { at(t, -d, d); at(t, BH + d, d) }
      for (let t = 0; t <= BH; t += 1) { at(-d, t, d); at(BW + d, t, d) }
    }
    return worst
  }
  // …and the roughing before it leaves its allowance on those sides, not just on top: added
  // in Z alone it left none beside a vertical wall, so a rougher read exactly against the
  // triangles cut the sides to their final size and the finish had nothing to clean up.
  for (const roughingFlat of [true, false]) {
    it(`${roughingFlat ? 'an end mill' : 'a ball nose'} roughing keeps its cutter the allowance off the sides`, { timeout: 30000 }, () => {
      const ALLOW = 0.3, Rr = 3
      const segs = generateProfile3d(block.positions, null, block.bounds, box(0, 0, BW, BH), BALL, params({
        maxDepthMM: 12, roughingRadiusMM: Rr, roughingFlat, roughingStepoverPercent: 50, roughingStepDownMM: 3, roughingStockAllowanceMM: ALLOW,
      }))
      const roughing = segs.slice(0, segs.findIndex((s) => s.toolChange)).filter((s) => !s.rapid && s.z < -0.5)
      expect(roughing.length).toBeGreaterThan(100)
      // How far the cutter's own surface stands off the block (top 0, sides its box, 10 deep).
      const out = (s: MotionSegment) => Math.hypot(Math.max(0, -s.x, s.x - BW), Math.max(0, -s.y, s.y - BH))
      const clearance = (s: MotionSegment) => roughingFlat
        ? (s.z >= 0 ? s.z : out(s) - Rr)                                   // a cylinder: its rim, below the top
        : Math.hypot(out(s), Math.max(0, s.z + Rr)) - Rr                   // a ball: centre to the block
      let least = Infinity, besideAtDepth = Infinity
      for (const s of roughing) {
        least = Math.min(least, clearance(s))
        if (s.z < -5) besideAtDepth = Math.min(besideAtDepth, out(s))
      }
      expect(least).toBeGreaterThanOrEqual(ALLOW - 1e-3)
      // …and at depth it comes down beside the side no further off than the lead past that.
      expect(besideAtDepth).toBeLessThan(Rr + ALLOW + 0.06)
    })
  }

  for (const tool of [END, BALL]) {
    for (const finishStrategy of ['raster', 'waterline'] as const) {
      it(`${tool.type === 'endmill' ? 'an end mill' : 'a ball nose'}, ${finishStrategy}: nothing stands beside the sides`, { timeout: 30000 }, () => {
        expect(leftBeside(tool, { finishStrategy })).toBeLessThan(0.02)
      })
    }
  }
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
      // (To 0.1 µm: the roughing reads its grid leaned a cell diagonal beside steep ground,
      // which moves which finishing points have anything left to take by that much.)
      expect(low, `edge at y=${y}`).toBeLessThan(-15 + scallop + 1e-4)
    }
  })

  it('finishes with one pass round its limit, so line ends leave no cusps on the wall beyond', () => {
    // Without a boundary the limit is a radius and 0.05 mm outside the model's box (less the
    // 0.01 mm arc tolerance), its corners rounded about the box's, so its left edge is straight from
    // y = 0 to y = 40. A raster along X touches it only where its lines end, a stepover
    // apart; the pass round the limit runs the whole edge.
    const e = 3 + 0.04
    const segs = run(BALL, { ...SUNK, stepoverPercent: 30 })
    const onLeft = cuts(segs).filter((s) => Math.abs(s.x + e) < 1e-6).map((s) => s.y).sort((a, b) => a - b)
    let gap = onLeft[0]
    for (let k = 1; k < onLeft.length; k++) gap = Math.max(gap, onLeft[k] - onLeft[k - 1])
    gap = Math.max(gap, W - onLeft[onLeft.length - 1])
    expect(gap).toBeLessThan(0.5)
  })
})

describe('a model sunk below the stock top', () => {
  it('drops every height of the finish by the depth it is sunk', () => {
    // Sunk 1 mm and 3 mm: at 0 the flats are at the stock top and are not cut at all.
    const at0 = cuts(run(BALL, { modelTopMM: 1 })), at2 = cuts(run(BALL, { modelTopMM: 3 }))
    expect(at2.length).toBe(at0.length)
    for (let k = 0; k < at0.length; k++) {
      expect(at2[k].x).toBe(at0[k].x)
      expect(at2[k].y).toBe(at0[k].y)
      expect(at2[k].z).toBeCloseTo(at0[k].z - 2, 9)
    }
  })

  it('drops a taper\'s finish the same way — it reads the height map, not the triangles', { timeout: 30000 }, () => {
    const at0 = cuts(run(TAPER, { modelTopMM: 1 })), at2 = cuts(run(TAPER, { modelTopMM: 3 }))
    expect(at2.length).toBe(at0.length)
    // To float32 rounding: the height map is a Float32Array, and both models are offset.
    for (let k = 0; k < at0.length; k += 7) expect(at2[k].z).toBeCloseTo(at0[k].z - 2, 5)
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
    // (Clear of the dome by the rim's reach and the grid cell diagonal it is widened by — half
    // for where a node's high point is, half for where the tool is between nodes — so a
    // steep wall between nodes cannot meet it.)
    const onFloor = raster.roughing.filter((s) => Math.hypot(s.x - 20, s.y - 20) > 8 + R + 2.5 && s.z < -7)
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

    it('skips nothing that still has stock on it — it leaves the part no higher than a finish alone would', { timeout: 60000 }, () => {
      // Measured on what is LEFT, not by matching points: the run after roughing need not
      // sample its rows at the same points as a finish on its own (the grid spans the
      // rougher's reach too). Both are carved here, the roughing with the end mill and each
      // finish with the ball; nowhere may roughing + its finish stand higher than the
      // finish on its own leaves the stock.
      const aloneSegs = generateProfile3d(dome.positions, null, dome.bounds, box(0, 0, W, W), BALL, params())
      const alone = cuts(aloneSegs)
      const c = 0.2, n = Math.round(W / c) + 1
      const END: Tool = { ...BALL, id: 'end', type: 'endmill', diameterMM: 2 * R }
      const solo = carveGrid(new Float32Array(n * n), n, c, swept(aloneSegs), BALL)
      // The program itself, rapids and all: swept from the cuts alone, the end of one cut
      // would run on to the start of the next as if it were fed there.
      const prog = gen(), k = prog.findIndex((s) => s.toolChange)
      const both = carveGrid(carveGrid(new Float32Array(n * n), n, c, swept(prog.slice(0, k)), END), n, c, swept(prog.slice(k + 1)), BALL)
      let worst = 0
      for (let k = 0; k < solo.length; k++) worst = Math.max(worst, both[k] - solo[k])
      // …and it does skip: ground the end mill already finished.
      expect(cuts(raster.finishing).length).toBeLessThan(alone.length - 100)
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

describe('a 3D Profile never moves into stock at rapid speed', () => {
  // A `travel` move goes out as G0 (`linksAsRapids`), so it is judged as one: the program is
  // carved in order with the simulator's rapid check (sim/rapidGouge.ts) and every travel
  // move that removes stock is counted. Two faults lived here: a cleared ride's LAST step,
  // the drop onto the next cut — 3 mm into a roughing level, or the finish's allowance — and
  // a cleared ride dipping below the level above on a slope, where the tip height it follows
  // runs under the surface at the tool's centre.
  const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 8 ? Math.sqrt(64 - r * r) - 8 : -8 }
  const dome = mesh(DOME, W, W, 80)
  const rapidsIntoStock = (segs: MotionSegment[], roughFlat: boolean) => {
    const tools: ToolState[] = [
      { toolDiameterMM: 6, spindleRpm: 1, fluteCount: 2, ...(roughFlat ? {} : { toolBallNose: true }) },
      { toolDiameterMM: 6, spindleRpm: 1, fluteCount: 2, toolBallNose: true },
    ]
    let p = { x: 0, y: 0, z: SAFE_Z }, tool = 0
    const prog: SimSegment[] = []
    for (const s of segs) {
      if (s.toolChange) tool = 1
      prog.push({ x: s.x, y: s.y, z: s.z, prevX: p.x, prevY: p.y, prevZ: p.z, rapid: !!(s.rapid || s.travel),
        feedRateMmMin: 1, lineIdx: prog.length, durationS: 0, startTimeS: 0, toolStateIdx: tool })
      p = s
    }
    return findRapidGouges(prog, tools, { widthMM: W, heightMM: W, thicknessMM: 20, orgX: 0, orgY: 0 }, 0.1).length
  }
  for (const [name, m] of [['groove', groove], ['dome', dome]] as const) {
    for (const roughFlat of [false, true]) {
      for (const finishStrategy of ['raster', 'waterline'] as const) {
        it(`${name}, ${roughFlat ? 'end mill' : 'ball'} roughing, ${finishStrategy} finish`, () => {
          const segs = generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), BALL, params({
            finishStrategy, roughingRadiusMM: 3, roughingFlat: roughFlat, roughingStepoverPercent: 50,
            roughingStepDownMM: 3, roughingStockAllowanceMM: 0.3, rasterAngleDeg: 30,
          }))
          expect(rapidsIntoStock(segs, roughFlat)).toBe(0)
        })
      }
    }
  }
})

describe('a flat already at the stock top is not cut', () => {
  // A guitar neck's fretboard is the stock's own top face: a pass over it takes nothing, yet
  // every row of the finish fed its whole length at Z0. And a mesh is rarely flat to the
  // micron — a vertex 0.014 mm proud of the face puts the rest of it 0.014 mm under Z0, so
  // the whole face read as work. Here: a 40 mm flat with one such vertex, and a 3 mm step
  // down past x = 28 standing for the sculpted part.
  const NECK: Height = (x, y) => (x > 28 ? -3 : x === 10 && y === 10 ? 0.014 : 0)
  const neck = mesh(NECK, W, W, 40)
  const runNeck = (over: Partial<Profile3dParams> = {}) =>
    generateProfile3d(neck.positions, null, neck.bounds, box(0, 0, W, W), BALL, params(over))
  /** The cutting moves over the flat — beyond the ball's reach of the step, and over the
   *  model's box: past its edge the tools clear the stock beside the flat, as they should. */
  const onFlat = (segs: MotionSegment[]) => segs.filter((s) => !s.rapid && !s.travel && inBox(s) && s.x < 28 - 3 - 1)
  const ROUGH = { roughingRadiusMM: 3, roughingStepoverPercent: 50, roughingStepDownMM: 3, roughingStockAllowanceMM: 0.3 }
  const roughOf = (segs: MotionSegment[]) => segs.slice(0, segs.findIndex((s) => s.toolChange))
  const finishOf = (segs: MotionSegment[]) => segs.slice(segs.findIndex((s) => s.toolChange) + 1)

  it('a finish cuts nothing where its tip would be at or above the stock top', () => {
    // The groove's flats sit exactly at Z0, the stock top: no move is fed across them.
    const segs = run()
    const c = cuts(segs).filter((s) => !s.travel)
    expect(c.length).toBeGreaterThan(100)
    expect(fedThroughAir(segs)).toHaveLength(0)
    expect(c.filter((s) => inBox(s) && s.z < 0 && (s.x < 20 - 8 - 3 - 1 || s.x > 20 + 8 + 3 + 1))).toHaveLength(0)
  })

  it('without a tolerance, a flat a mesh vertex leaves 0.014 mm under the top is still cut', () => {
    // The rule it pins is the default: only a tip AT the top is skipped, so nothing is left
    // standing unless the user says how much may be.
    const flat = onFlat(runNeck())
    expect(flat.length).toBeGreaterThan(100)
    for (const s of flat.filter((s) => Math.hypot(s.x - 10, s.y - 10) > 4)) expect(s.z).toBeCloseTo(-0.014, 3)
  })

  for (const finishStrategy of ['raster', 'waterline'] as const) {
    it(`with skipFlatTolMM, a ${finishStrategy} finish leaves that flat alone and still cuts the step`, () => {
      const segs = runNeck({ skipFlatTolMM: 0.05, finishStrategy })
      expect(onFlat(segs)).toHaveLength(0)
      // The step's floor, 3 mm down (and 0.014 more: the proud vertex is the model's top).
      expect(cuts(segs).filter((s) => s.x > 28 && Math.abs(s.z + 3.014) < 1e-3).length).toBeGreaterThan(50)
    })
  }

  for (const roughingFlat of [false, true]) {
    it(`with skipFlatTolMM, ${roughingFlat ? 'an end mill' : 'a ball'} roughing and the finish after it leave the flat alone`, () => {
      // A ball's tip on the flat is at +0.3, the allowance, and was already in the air; an end
      // mill leaves no allowance on a flat, so its tip is the face itself, 0.014 mm under.
      const without = runNeck({ ...ROUGH, roughingFlat })
      if (roughingFlat) expect(onFlat(roughOf(without)).length).toBeGreaterThan(50)
      const segs = runNeck({ ...ROUGH, roughingFlat, skipFlatTolMM: 0.05 })
      expect(onFlat(roughOf(segs))).toHaveLength(0)
      expect(onFlat(finishOf(segs))).toHaveLength(0)
      expect(cuts(roughOf(segs)).filter((s) => s.x > 28).length).toBeGreaterThan(20)
    })
  }

  it('a ride over the flat it skipped never runs under the stock top', () => {
    // With no roughing there is no stock model: the stock is its top, and a travel ride over
    // ground skipped as finished follows a tip up to the tolerance UNDER it — at G0. A ridge
    // 4 mm wide between two 3 mm steps is narrow enough that riding across it beats lifting.
    const RIDGE: Height = (x, y) => (x < 18 || x > 22 ? -3 : x === 20 && y === 10 ? 0.014 : 0)
    const ridge = mesh(RIDGE, W, W, 40)
    const segs = generateProfile3d(ridge.positions, null, ridge.bounds, box(0, 0, W, W), BALL, params({ skipFlatTolMM: 0.05 }))
    const over = segs.filter((s) => s.travel && Math.abs(s.x - 20) < 2)
    expect(over.length).toBeGreaterThan(20)
    for (const s of over) expect(s.z).toBeGreaterThanOrEqual(0)
  })
})

describe("the 3D view's model preview", () => {
  const op = (over: Record<string, unknown> = {}) => ({ type: 'profile3d', visible: true, pathId: 'stl', maxDepthMM: 15, modelTopMM: 0.2, ...over })

  it('is sunk and trimmed as its 3D Profile cuts it', () => {
    expect(modelPreviewTrim([op()], 'stl', 31)).toEqual({ topMM: 0.2, depthMM: 15 })
  })

  it('stops where the cut stops, which is never through the stock', () => {
    expect(modelPreviewTrim([op({ maxDepthMM: 40 })], 'stl', 31)!.depthMM).toBe(profile3dDepthMM(40, 31))
    expect(profile3dDepthMM(40, 31)).toBe(31)
  })

  it('is shown whole when nothing cuts the model — no 3D Profile, a hidden one, or one on another model', () => {
    expect(modelPreviewTrim([], 'stl', 31)).toBeNull()
    expect(modelPreviewTrim([op({ visible: false })], 'stl', 31)).toBeNull()
    expect(modelPreviewTrim([op({ pathId: 'other' }), { type: 'pocket', pathId: 'stl' }], 'stl', 31)).toBeNull()
  })
})

describe('finishing with a flat end mill', () => {
  const END: Tool = { id: 'end', name: 'End 6', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20 }
  const R = 3
  // A terraced part — what an end mill finish is for: a top, a step, a floor, each a flat,
  // with walls that drop within one fine mesh cell, at radii no grid node lines up with.
  const TERRACE: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 5.3 ? 0 : r < 14.7 ? -3 : -7 }
  const m = mesh(TERRACE, W, W, 200)
  const worstGouge = (segs: MotionSegment[]) => {
    let worst = 0
    for (const s of cuts(segs)) {
      for (let u = s.x - R; u <= s.x + R; u += 0.05) {
        for (let v = s.y - R; v <= s.y + R; v += 0.05) {
          if (u < 0 || v < 0 || u > W || v > W || Math.hypot(u - s.x, v - s.y) > R) continue
          worst = Math.max(worst, m.at(u, v) - s.z)
        }
      }
    }
    return worst
  }

  for (const finishStrategy of ['raster', 'waterline'] as const) {
    it(`never cuts into a wall with the rim of its flat bottom (${finishStrategy})`, { timeout: 30000 }, () => {
      const segs = generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), END, params({ finishStrategy }))
      expect(cuts(segs).length).toBeGreaterThan(50)
      expect(worstGouge(segs)).toBeLessThan(0.02)
    })
  }

  it('never cuts into a wall after roughing either — the rest finish reads the triangles too', { timeout: 30000 }, () => {
    const segs = generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), END, params({
      roughingRadiusMM: 4, roughingFlat: true, roughingStepoverPercent: 50, roughingStepDownMM: 3, roughingStockAllowanceMM: 0.3,
    }))
    const k = segs.findIndex((s) => s.toolChange)
    expect(k).toBeGreaterThan(0)
    expect(worstGouge(segs.slice(k + 1))).toBeLessThan(0.02)
  })

  it('never cuts into a curved surface with the rim of its flat bottom', { timeout: 30000 }, () => {
    // Every contact a slope makes is the uphill point of the rim, on a face or along an edge.
    const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 12 ? Math.sqrt(144 - r * r) - 12 : -12 }
    const d = mesh(DOME, W, W, 80)
    const segs = generateProfile3d(d.positions, null, d.bounds, box(0, 0, W, W), END, params())
    let worst = 0
    for (const s of cuts(segs)) {
      for (let u = s.x - R; u <= s.x + R; u += 0.1) {
        for (let v = s.y - R; v <= s.y + R; v += 0.1) {
          if (u < 0 || v < 0 || u > W || v > W || Math.hypot(u - s.x, v - s.y) > R) continue
          worst = Math.max(worst, d.at(u, v) - s.z)
        }
      }
    }
    expect(worst).toBeLessThan(0.02)
  })

  // Clear of the walls by 0.5 mm: on the grid the rim stood off every wall by over a
  // millimetre, riding up onto the terrace above and leaving a ledge round its foot.
  it('finishes every flat to its own depth — the bottom of the tool IS the finish there', { timeout: 30000 }, () => {
    const segs = generateProfile3d(m.positions, null, m.bounds, box(0, 0, W, W), END, params())
    // Points whose whole flat bottom lies on one terrace, clear of the walls by a grid cell.
    const on = (lo: number, hi: number) => cuts(segs).filter((s) => {
      const r = Math.hypot(s.x - 20, s.y - 20)
      return r - R > lo + 0.5 && r + R < hi - 0.5
    })
    const step = on(5.3, 14.7), floor = on(14.7, 99).filter((s) => s.x > 1 && s.y > 1 && s.x < W - 1 && s.y < W - 1)
    expect(step.length).toBeGreaterThan(10)
    expect(floor.length).toBeGreaterThan(50)
    for (const s of step) expect(s.z).toBeCloseTo(-3, 2)
    for (const s of floor) expect(s.z).toBeCloseTo(-7, 2)
  })
})

describe('roughing over ground already at the stock top', () => {
  // A neck: a long flat top AT the stock top (Z0), with a 5 mm pocket only at one end —
  // roughed with a 1/4" end mill, rows running the long way. On every row the tool finishes
  // the pocket, and the rest of the row is the flat top, where the tip would sit at
  // 0 + 0.3 allowance: above the stock, taking nothing.
  const NL = 120, NW = 20
  const NECK: Height = (_x, y) => (y < 25 ? -5 : 0)
  const neck = mesh(NECK, NW, NL, 120)   // as long and as wide as its box, so 5 mm stays 5 mm
  const END4: Tool = { id: 'e4', name: 'End 1/4', type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20 }
  const segs = generateProfile3d(neck.positions, null, neck.bounds, box(0, 0, NW, NL), BALL, params({
    rasterAngleDeg: 90, roughingRadiusMM: END4.diameterMM / 2, roughingFlat: true, roughingStepoverPercent: 40,
    roughingStepDownMM: 3.8, roughingStockAllowanceMM: 0.3, roughingXyFeedMmMin: 1000,
  }))
  const roughing = segs.slice(0, segs.findIndex((s) => s.toolChange))

  it('never feeds through air above the stock — no fed move runs wholly at or above Z0', () => {
    expect(fedThroughAir(roughing)).toHaveLength(0)
  })

  it('lifts and rapids over the long flat instead of feeding or riding along it', () => {
    // Every row crosses ~95 mm of flat. A short hop between nearby cuts may still ride the
    // surface as travel when that is quicker than lifting — the longest is straight across
    // the 20 mm width, between the cuts beside it, a radius past each side — but a run along
    // the flat never does.
    let run = 0, longest = 0
    for (let i = 1; i < roughing.length; i++) {
      const a = roughing[i - 1], b = roughing[i]
      if (!b.rapid && a.z >= -1e-6 && b.z >= -1e-6) longest = Math.max(longest, run += Math.hypot(b.x - a.x, b.y - a.y))
      else run = 0
    }
    expect(longest).toBeLessThan(NW + END4.diameterMM + 1)
  })

  it('still clears the pocket', () => {
    const inPocket = roughing.filter((s) => !s.rapid && s.y < 25 - 3.2 - 0.5 && s.z < -4)
    expect(inPocket.length).toBeGreaterThan(20)
  })
})

describe('cut direction: mixed, climb or conventional', () => {
  // A row runs along d = (cos θ, sin θ) and the rows step toward n = (−sin θ, cos θ), so the
  // stock not yet cut is on the +n side: the LEFT of a move along +d. With an M3 spindle,
  // climb keeps the stock on the RIGHT of the feed (as the 2D profile does: CW round an
  // outside, CCW round a pocket), so every climb row runs along −d.
  const along = (deg: number) => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)]
  /** Each cutting move's travel along the row direction (vertical and zero moves left out).
   *  Moves along the limit — both tools' radius, 3 mm, and a 0.05 mm lead outside the box,
   *  less the 0.01 mm arc tolerance, its corners rounded about the box's — are the lap round
   *  it (`wallInto`), a ring with a hand of its own, and are left out, with the first and
   *  last rows, which lie on that edge too. */
  // (Round its corners the limit is chords, up to the 0.01 mm tolerance inside the arc.)
  const EDGE = 3 + 0.04
  const onEdge = (p: MotionSegment) =>
    Math.hypot(Math.max(0, -p.x, p.x - W), Math.max(0, -p.y, p.y - W)) > EDGE - 0.02
  // Only moves ALONG a row: a link from a row's end onto the lap (or to the next run) crosses
  // rows, and goes whichever way the two ends lie.
  const rowSteps = (segs: MotionSegment[], deg: number) => {
    const [dx, dy] = along(deg), out: number[] = []
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i]
      if (b.rapid || (onEdge(a) && onEdge(b))) continue
      if (Math.abs((b.y - a.y) * dx - (b.x - a.x) * dy) > 1e-6) continue
      const s = (b.x - a.x) * dx + (b.y - a.y) * dy
      if (Math.abs(s) > 1e-6) out.push(s)
    }
    return out
  }
  const finishOf = (segs: MotionSegment[]) => { const k = segs.findIndex((s) => s.toolChange); return k < 0 ? segs : segs.slice(k + 1) }
  const roughOf = (segs: MotionSegment[]) => segs.slice(0, segs.findIndex((s) => s.toolChange))
  const ROUGH = { roughingRadiusMM: 3, roughingFlat: true, roughingStepoverPercent: 50, roughingStepDownMM: 3, roughingStockAllowanceMM: 0.3 }

  it('mixed is the zigzag: rows both ways, and no lift between them', () => {
    const segs = run(BALL)
    const steps = rowSteps(segs, 0)
    expect(steps.some((s) => s > 0)).toBe(true)
    expect(steps.some((s) => s < 0)).toBe(true)
    expect(run(BALL, { finishDirection: 'mixed' })).toEqual(segs)
  })

  for (const deg of [0, 90, 180, 270, 30]) {
    it(`climb cuts every row with the stock on its right — never a move the other way (raster ${deg}°)`, () => {
      const steps = rowSteps(run(BALL, { rasterAngleDeg: deg, finishDirection: 'climb' }), deg)
      expect(steps.length).toBeGreaterThan(50)
      for (const s of steps) expect(s).toBeLessThan(0)
    })
    it(`conventional is the mirror of climb (raster ${deg}°)`, () => {
      const steps = rowSteps(run(BALL, { rasterAngleDeg: deg, finishDirection: 'conventional' }), deg)
      expect(steps.length).toBeGreaterThan(50)
      for (const s of steps) expect(s).toBeGreaterThan(0)
    })
  }

  it('goes back over the top between rows: a lift to safe height before every row, and no feed on the way back', () => {
    const segs = run(BALL, { finishDirection: 'climb' })
    // Every row starts with the tool coming down from safe height at the row's climb end.
    let rows = 0, lifted = 0
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i]
      if (!b.rapid && a.rapid && b.x === a.x && b.y === a.y) {
        rows++
        // walk back to the last move that was not a rapid: it must have gone up to safe height
        let j = i - 1
        while (j > 0 && segs[j].rapid && segs[j].z !== SAFE_Z) j--
        if (segs[j].rapid && segs[j].z === SAFE_Z) lifted++
      }
    }
    expect(rows).toBeGreaterThan(5)
    expect(lifted).toBe(rows)
  })

  it('a spindle running M4 swaps climb and conventional', () => {
    const climbM4 = run(BALL, { finishDirection: 'climb', spindleReverse: true })
    expect(climbM4).toEqual(run(BALL, { finishDirection: 'conventional' }))
  })

  it('sets the roughing and the finish independently', () => {
    const segs = run(BALL, { ...ROUGH, roughingRasterAngleDeg: 0, roughingDirection: 'climb', finishDirection: 'conventional' })
    const r = rowSteps(roughOf(segs), 0), f = rowSteps(finishOf(segs), 0)
    expect(r.length).toBeGreaterThan(20)
    expect(f.length).toBeGreaterThan(20)
    for (const s of r) expect(s).toBeLessThan(0)
    for (const s of f) expect(s).toBeGreaterThan(0)
    // …and leaving one unset leaves it the zigzag.
    const mixedRough = rowSteps(roughOf(run(BALL, { ...ROUGH, roughingRasterAngleDeg: 0, finishDirection: 'climb' })), 0)
    expect(mixedRough.some((s) => s > 0) && mixedRough.some((s) => s < 0)).toBe(true)
  })

  describe('waterline', () => {
    // A dome: every ring above the floor goes round it with the dome — the material — inside.
    // Climb on M3 keeps it on the right, which round a boss is clockwise.
    const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 12 ? Math.sqrt(144 - r * r) - 12 : -12 }
    const dome = mesh(DOME, W, W, 80)
    const turns = (segs: MotionSegment[]) => {
      const out: number[] = []
      for (let i = 1; i < segs.length; i++) {
        const a = segs[i - 1], b = segs[i]
        if (b.rapid || b.travel || a.z < -11 || Math.abs(b.z - a.z) > 1e-9) continue   // on a ring round the dome
        // …going ROUND it: the step from one ring down to the next runs outward, and has no hand.
        const dr = Math.hypot(b.x - 20, b.y - 20) - Math.hypot(a.x - 20, a.y - 20)
        if (Math.abs(dr) > 0.3 * Math.hypot(b.x - a.x, b.y - a.y)) continue
        const c = (a.x - 20) * (b.y - a.y) - (a.y - 20) * (b.x - a.x)
        if (Math.abs(c) > 1e-3) out.push(c)
      }
      return out
    }
    const wl = (over: Partial<Profile3dParams>) =>
      generateProfile3d(dome.positions, null, dome.bounds, box(0, 0, W, W), BALL, params({ finishStrategy: 'waterline', ...over }))

    it('climb runs every ring round a boss clockwise, conventional anticlockwise', { timeout: 60000 }, () => {
      const climb = turns(wl({ finishDirection: 'climb' })), conv = turns(wl({ finishDirection: 'conventional' }))
      expect(climb.length).toBeGreaterThan(50)
      for (const c of climb) expect(c).toBeLessThan(0)
      for (const c of conv) expect(c).toBeGreaterThan(0)
    })

    it('the lap round the box takes the hand too: along its bottom edge climb runs +x, conventional −x', { timeout: 60000 }, () => {
      // The lap runs with the stock beyond the limit on its right (anticlockwise round the
      // box) — climb. With a waterline finish nothing else runs along the limit's edge, a
      // radius and 0.05 mm lead below the box, less the 0.01 mm arc tolerance.
      const y0 = -(3 + 0.04)
      const bottom = (segs: MotionSegment[]) => {
        const out: number[] = []
        for (let i = 1; i < segs.length; i++) {
          const a = segs[i - 1], b = segs[i]
          if (!b.rapid && !b.travel && Math.abs(a.y - y0) < 1e-6 && Math.abs(b.y - y0) < 1e-6 && Math.abs(b.x - a.x) > 1e-6) out.push(b.x - a.x)
        }
        return out
      }
      const climb = bottom(wl({ finishDirection: 'climb' })), conv = bottom(wl({ finishDirection: 'conventional' }))
      expect(climb.length).toBeGreaterThan(20)
      for (const d of climb) expect(d).toBeGreaterThan(0)
      for (const d of conv) expect(d).toBeLessThan(0)
    })

    it('runs an open chain from its climb end too, not from whichever end is nearer', { timeout: 60000 }, () => {
      // The groove's contours run edge to edge: open chains, one up each wall. The stock is
      // beyond each wall, so with it on the right the −x wall runs −y and the +x wall +y.
      const segs = run(BALL, { finishStrategy: 'waterline', finishDirection: 'climb' })
      let n = 0
      for (let i = 1; i < segs.length; i++) {
        const a = segs[i - 1], b = segs[i]
        const dy = b.y - a.y
        if (b.rapid || b.travel || Math.abs(b.z - a.z) > 1e-9 || Math.abs(dy) < 1e-6 || Math.abs(b.x - a.x) > 0.1 * Math.abs(dy)) continue
        if (a.x < 1e-6 || a.x > W - 1e-6 || Math.abs(a.x - 20) < 0.5) continue   // the box's lap; the groove's bottom
        n++
        expect(Math.sign(dy)).toBe(a.x < 20 ? -1 : 1)
      }
      expect(n).toBeGreaterThan(50)
    })

    it('mixed leaves the rings as traced', { timeout: 60000 }, () => {
      expect(wl({ finishDirection: 'mixed' })).toEqual(wl({}))
    })
  })
})
