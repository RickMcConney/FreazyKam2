import { describe, it, expect } from 'vitest'
import { Clipper64, ClipperOffset, ClipType, FillRule, PathType, JoinType, EndType, area, type Paths64 } from 'clipper2-ts'
import { cutArea, cutAreaOut, diskUncutArea, type EdgeSet } from './cutArea'
import { AdaptiveFC, MotionType, type AdaptiveOutput } from './engine'

type P = [number, number]

// ─── helpers ─────────────────────────────────────────────────────────────────────

function bool(ct: ClipType, a: Paths64, b: Paths64): Paths64 {
  const c = new Clipper64()
  c.addPaths(a, PathType.Subject)
  if (b.length) c.addPaths(b, PathType.Clip)
  const s: Paths64 = []
  c.execute(ct, FillRule.NonZero, s)
  return s
}
const areaOf = (ps: Paths64): number => ps.reduce((s, p) => s + area(p), 0)
const disk = (cx: number, cy: number, r: number, n = 2000): Paths64 =>
  [Array.from({ length: n }, (_, i) => ({ x: Math.round(cx + r * Math.cos(2 * Math.PI * i / n)), y: Math.round(cy + r * Math.sin(2 * Math.PI * i / n)) }))]
function edgesOf(ps: Paths64): EdgeSet {
  const a: number[] = []
  for (const p of ps) for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a.push(p[i].x, p[i].y, q.x, q.y) }
  return { e: Float64Array.from(a), n: a.length / 4 }
}

const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const circle = (cx: number, cy: number, r: number, n = 128): P[] =>
  Array.from({ length: n }, (_, i) => { const a = 2 * Math.PI * i / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P })

function run(paths: P[][], dia = 6, stepover = 0.2): AdaptiveOutput[] {
  return new AdaptiveFC({ toolDiameter: dia, stepOverFactor: stepover, tolerance: 0.1, helixRampTargetDiameter: dia })
    .execute([paths[0]], paths)
}

/** Replay every cut and stay-down link as a swept disk on a grid; report stock left inside the
 *  pocket further than 0.1 mm from a wall, and cuts outside it further than 0.02 mm (gouge). */
function audit(paths: P[][], outs: AdaptiveOutput[], R: number, cell = 0.1): { uncut: number; gouge: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of paths[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  x0 -= 1; y0 -= 1; x1 += 1; y1 += 1
  const W = Math.ceil((x1 - x0) / cell) + 1, H = Math.ceil((y1 - y0) / cell) + 1
  const cut = new Uint8Array(W * H)
  const stamp = (cx: number, cy: number): void => {
    const i0 = Math.max(0, Math.floor((cx - R - x0) / cell)), i1 = Math.min(W - 1, Math.ceil((cx + R - x0) / cell))
    const j0 = Math.max(0, Math.floor((cy - R - y0) / cell)), j1 = Math.min(H - 1, Math.ceil((cy + R - y0) / cell))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = x0 + i * cell - cx, dy = y0 + j * cell - cy
      if (dx * dx + dy * dy <= R * R) cut[j * W + i] = 1
    }
  }
  for (const o of outs) {
    const h = o.helixCenter, s0 = o.adaptivePaths[0]?.pts[0]
    if (s0) {
      const hr = Math.hypot(s0[0] - h[0], s0[1] - h[1])
      for (let a = 0; a < 64; a++) stamp(h[0] + hr * Math.cos(a / 64 * 2 * Math.PI), h[1] + hr * Math.sin(a / 64 * 2 * Math.PI))
    }
    for (const tp of o.adaptivePaths) {
      if (tp.motion !== MotionType.Cutting && tp.motion !== MotionType.LinkClear) continue
      for (let i = 1; i < tp.pts.length; i++) {
        const [ax, ay] = tp.pts[i - 1], [bx, by] = tp.pts[i]
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / cell))
        for (let k = 0; k <= n; k++) stamp(ax + (bx - ax) * k / n, ay + (by - ay) * k / n)
      }
    }
  }
  const wallDist = (x: number, y: number): number => {
    let m = Infinity
    for (const poly of paths) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j], [bx, by] = poly[i]
      const dx = bx - ax, dy = by - ay
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
      m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy))
    }
    return m
  }
  let uncut = 0, gouge = 0
  const xs: number[] = []
  for (let j = 0; j < H; j++) {
    // even-odd spans of the pocket (outer + islands) along this row
    const y = y0 + j * cell
    xs.length = 0
    for (const poly of paths) for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
      const [xi, yi] = poly[i], [xk, yk] = poly[k]
      if ((yi > y) !== (yk > y)) xs.push((xk - xi) * (y - yi) / (yk - yi) + xi)
    }
    xs.sort((a, b) => a - b)
    let q = 0
    for (let i = 0; i < W; i++) {
      const x = x0 + i * cell
      while (q < xs.length && xs[q] <= x) q++
      const inside = (q & 1) === 1
      const c = cut[j * W + i]
      if (inside && !c && wallDist(x, y) > 0.1) uncut++
      else if (!inside && c && wallDist(x, y) > 0.02) gouge++
    }
  }
  return { uncut: uncut * cell * cell, gouge: gouge * cell * cell }
}

// ─── the engagement measure ──────────────────────────────────────────────────────

describe('analytic cut area (Green’s theorem) matches an exact polygon boolean', () => {
  const R = 1440
  let seed = 7
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

  it('area and conventional share both agree with Clipper to within its polygonisation, over random cleared regions', () => {
    for (let trial = 0; trial < 40; trial++) {
      const co = new ClipperOffset(2, 1)
      for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) {
        const pts = []
        let x = (rnd() - 0.5) * 6000, y = (rnd() - 0.5) * 6000
        for (let j = 0; j < 6; j++) { pts.push({ x: Math.round(x), y: Math.round(y) }); x += (rnd() - 0.5) * 3000; y += (rnd() - 0.5) * 3000 }
        co.addPath(pts, JoinType.Round, EndType.Round)
      }
      const C: Paths64 = []
      co.execute(R + 1, C)
      const c1 = { x: Math.round((rnd() - 0.5) * 3000), y: Math.round((rnd() - 0.5) * 3000) }
      const ang = rnd() * 2 * Math.PI, st = 48 + rnd() * 700
      const c2 = { x: Math.round(c1.x + st * Math.cos(ang)), y: Math.round(c1.y + st * Math.sin(ang)) }
      cutArea(edgesOf(C), c1.x, c1.y, c2.x, c2.y, R)
      const ref = bool(ClipType.Difference, bool(ClipType.Difference, disk(c2.x, c2.y, R), disk(c1.x, c1.y, R)), C)
      // the half-plane LEFT of the motion c1 → c2
      const L = Math.hypot(c2.x - c1.x, c2.y - c1.y)
      const tx = (c2.x - c1.x) / L * 1e5, ty = (c2.y - c1.y) / L * 1e5, nx = -ty, ny = tx
      const left = [[
        { x: Math.round(c2.x - tx), y: Math.round(c2.y - ty) }, { x: Math.round(c2.x + tx), y: Math.round(c2.y + ty) },
        { x: Math.round(c2.x + tx + nx), y: Math.round(c2.y + ty + ny) }, { x: Math.round(c2.x - tx + nx), y: Math.round(c2.y - ty + ny) },
      ]]
      const scale = Math.PI * R * R
      expect(Math.abs(cutAreaOut.area - areaOf(ref)) / scale).toBeLessThan(1e-3)
      expect(Math.abs(cutAreaOut.conv - areaOf(bool(ClipType.Intersection, ref, left))) / scale).toBeLessThan(1e-3)
    }
  })

  it('a disk outside the cleared region agrees with Clipper too', () => {
    const co = new ClipperOffset(2, 1)
    co.addPath([{ x: -3000, y: 0 }, { x: 0, y: 500 }, { x: 2500, y: -800 }], JoinType.Round, EndType.Round)
    const C: Paths64 = []
    co.execute(R + 1, C)
    for (const [x, y] of [[0, 900], [2000, 1500], [-2500, -1200]]) {
      const ref = areaOf(bool(ClipType.Difference, disk(x, y, R + 300), C))
      expect(Math.abs(diskUncutArea(edgesOf(C), x, y, R + 300) - ref) / (Math.PI * R * R)).toBeLessThan(1e-3)
    }
  })

  it('stock on the LEFT of travel is the conventional side for an M3 spindle; on the right it is climb', () => {
    // Cleared: everything below y = 0; the tool centre runs half a radius below that line, so
    // the stock it bites is above it. Travelling +x that stock is on the LEFT, travelling −x
    // it is on the RIGHT. The engine refuses steps that are mostly conventional.
    const R2 = 1440
    const below: Paths64 = [[{ x: -1e5, y: -1e5 }, { x: 1e5, y: -1e5 }, { x: 1e5, y: 0 }, { x: -1e5, y: 0 }]]
    cutArea(edgesOf(below), 0, -R2 / 2, 48, -R2 / 2, R2)       // travel +x, uncut stock above = left
    expect(cutAreaOut.area).toBeGreaterThan(0)
    expect(cutAreaOut.conv / cutAreaOut.area).toBeGreaterThan(0.99)
    cutArea(edgesOf(below), 48, -R2 / 2, 0, -R2 / 2, R2)       // travel −x, stock above = right
    expect(cutAreaOut.conv / cutAreaOut.area).toBeLessThan(0.01)
  })
})

// ─── the engine ──────────────────────────────────────────────────────────────────

describe('FreeCAD-derived adaptive engine', () => {
  it('clears a square pocket completely, leaving only the corners a round cutter cannot reach, without gouging', () => {
    const paths = [rect(0, 0, 60, 60)]
    const { uncut, gouge } = audit(paths, run(paths), 3)
    // four corners of R²(1 − π/4) ≈ 1.93 mm² each, less the 0.1 mm wall allowance of the audit
    expect(uncut).toBeLessThan(6.5)
    expect(gouge).toBe(0)
  })

  it('clears round an island completely without cutting into it', () => {
    const paths = [circle(0, 0, 30), circle(5, -2, 9)]
    const { uncut, gouge } = audit(paths, run(paths), 3)
    expect(uncut).toBe(0)
    expect(gouge).toBe(0)
  })

  it('clears along a wall in one pass per side, not by tiny passes creeping backwards (the wall rings)', () => {
    // FreeCAD's own engine emits 204 path pieces here; ours once emitted 2052. Upstream walks
    // each engage contour from its START; walking it from the point nearest the tool instead
    // picks the contour's wall-hugging end — valid, cheap, and good for a 0.2 mm pass — so every
    // wall was cleared by passes creeping backwards, each with its own lead-in and lead-out.
    const out = run([rect(0, 0, 60, 60)])
    const pieces = out.reduce((s, o) => s + o.adaptivePaths.length, 0)
    expect(pieces).toBeLessThan(300)
  })

  it('never lifts the tool in an open pocket — every relink stays down over cleared floor', () => {
    const out = run([circle(0, 0, 30), circle(5, -2, 9)])
    const lifts = out.flatMap(o => o.adaptivePaths).filter(tp => tp.motion === MotionType.LinkNotClear)
    expect(lifts.length).toBe(0)
  })

  it('every cutting move stays inside the pocket wall offset by the tool radius', () => {
    const paths = [rect(0, 0, 40, 30)]
    for (const o of run(paths)) for (const tp of o.adaptivePaths) {
      if (tp.motion !== MotionType.Cutting) continue
      for (const [x, y] of tp.pts) {
        expect(x).toBeGreaterThanOrEqual(3 - 1e-3); expect(x).toBeLessThanOrEqual(37 + 1e-3)
        expect(y).toBeGreaterThanOrEqual(3 - 1e-3); expect(y).toBeLessThanOrEqual(27 + 1e-3)
      }
    }
  })
})
