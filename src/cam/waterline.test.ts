// The waterline finish, end to end through generateProfile3d, on heightfield meshes whose
// exact surface is known. Every claim is measured on the emitted motion — nothing the
// generator computes along the way is trusted.
import { describe, it, expect } from 'vitest'
import { generateProfile3d, type Profile3dParams } from './profile3d'
import { maxCutRadiusMM, toolProfileHeightMM } from './geom'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'
import type { BBox } from '../canvas/selectionUtils'

const BALL: Tool = { id: 'ball', name: 'Ball 6', type: 'ballnose', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20 }
const TAPER: Tool = { id: 'taper', name: 'Taper', type: 'taper', diameterMM: 1, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25, vbitAngleDeg: 5 }
const W = 40
const STEPOVER_PCT = 20
const STEP = BALL.diameterMM * STEPOVER_PCT / 100   // 1.2 mm

type Height = (x: number, y: number) => number

const box = (w: number, h: number): BBox => ({ minX: 0, minY: 0, maxX: w, maxY: h, width: w, height: h, cx: w / 2, cy: h / 2 })

/** A heightfield mesh over [0,W]², n×n cells, and its exact height anywhere. */
function mesh(S: Height, n: number) {
  const pos: number[] = []
  const c = W / n
  const v = (i: number, j: number) => [i * c, j * c, S(i * c, j * c)]
  const at = (x: number, y: number) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(x / c))), j = Math.min(n - 1, Math.max(0, Math.floor(y / c)))
    const fx = x / c - i, fy = y / c - j
    const za = v(i, j)[2], zb = v(i + 1, j)[2], zc = v(i + 1, j + 1)[2], zd = v(i, j + 1)[2]
    return fx >= fy ? za + (zb - za) * fx + (zc - zb) * fy : za + (zc - zd) * fx + (zd - za) * fy
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = v(i, j), b = v(i + 1, j), cc = v(i + 1, j + 1), d = v(i, j + 1)
      pos.push(...a, ...b, ...cc, ...a, ...cc, ...d)
    }
  }
  const positions = new Float32Array(pos)
  let minZ = Infinity, maxZ = -Infinity
  for (let k = 2; k < positions.length; k += 3) { minZ = Math.min(minZ, positions[k]); maxZ = Math.max(maxZ, positions[k]) }
  return { positions, at, bounds: { minX: 0, maxX: W, minY: 0, maxY: W, minZ, maxZ } }
}

function waterline(S: Height, n: number, tool = BALL, over: Partial<Profile3dParams> = {}) {
  const m = mesh(S, n)
  const segs = generateProfile3d(m.positions, null, m.bounds, box(W, W), tool, {
    stepoverPercent: STEPOVER_PCT, rasterAngleDeg: 0, maxDepthMM: 30, finishStrategy: 'waterline', ...over,
  })
  return { m, segs, cuts: segs.filter((s) => !s.rapid) }
}

/** The constant-Z runs of the motion — a waterline's rings — in the order they are cut. */
function rings(segs: MotionSegment[], minPts = 12) {
  const out: { z: number; pts: [number, number][]; first: number }[] = []
  let cur: { z: number; pts: [number, number][]; first: number } | null = null
  segs.forEach((s, i) => {
    if (s.rapid) { cur = null; return }
    if (!cur || Math.abs(s.z - cur.z) > 1e-9) { cur = { z: s.z, pts: [], first: i }; out.push(cur) }
    cur.pts.push([s.x, s.y])
  })
  return out.filter((r) => r.pts.length >= minPts)
}
const centroid = (p: [number, number][]) => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length]
const meanRadius = (p: [number, number][], cx: number, cy: number) => p.reduce((s, q) => s + Math.hypot(q[0] - cx, q[1] - cy), 0) / p.length
const signedArea = (p: [number, number][]) => {
  let a = 0
  for (let k = 0; k < p.length; k++) { const [x1, y1] = p[k], [x2, y2] = p[(k + 1) % p.length]; a += x1 * y2 - x2 * y1 }
  return a / 2
}

// A hemisphere of radius 15 on a floor 15 down: a crown, every slope up to vertical, a floor.
const DOME: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 15 ? Math.sqrt(225 - r * r) - 15 : -15 }
const PIT: Height = (x, y) => -Math.max(0, 10 - Math.max(Math.abs(x - 20), Math.abs(y - 20)))
const RIDGE: Height = (x) => -Math.min(8, Math.abs(x - 20))
// Two domes that meet only at the floor.
const TWO: Height = (x, y) => {
  const r1 = Math.hypot(x - 11, y - 20), r2 = Math.hypot(x - 29, y - 20)
  return Math.max(r1 < 8 ? Math.sqrt(64 - r1 * r1) - 8 : -8, r2 < 8 ? Math.sqrt(64 - r2 * r2) - 8 : -8)
}
// A boss: flat top AT the stock top, 70° sides, a floor 10 down — the steep-walls test's.
const BOSS: Height = (x, y) => { const r = Math.hypot(x - 20, y - 20); return r < 8 ? 0 : -Math.min(10, (r - 8) * 2.75) }
const BALL_EIGHTH: Tool = { ...BALL, id: 'b8', name: '1/8" ball', diameterMM: 3.175 }

const dome = waterline(DOME, 80)

describe('the waterline never cuts into the model', () => {
  // The tool's whole profile under every emitted point, against the mesh's exact surface,
  // sampled every 0.1 mm — the same measure, and the same tolerance, as the raster finish.
  const GOUGE_TOL = 0.02
  function worstGouge(S: Height, n: number, tool: Tool, every: number) {
    const { m, cuts } = waterline(S, n, tool)
    const R = maxCutRadiusMM(tool)
    let worst = 0
    for (let k = 0; k < cuts.length; k += every) {
      const s = cuts[k]
      for (let u = Math.max(0, s.x - R); u <= Math.min(W, s.x + R); u += 0.1) {
        for (let v = Math.max(0, s.y - R); v <= Math.min(W, s.y + R); v += 0.1) {
          const d = Math.hypot(u - s.x, v - s.y)
          if (d <= R) worst = Math.min(worst, s.z + toolProfileHeightMM(tool, d) - m.at(u, v))
        }
      }
    }
    return -worst
  }
  const cases: [string, Height, number][] = [
    ['a dome, crown to vertical foot', DOME, 80],
    ['a 45° pyramid pit', PIT, 40],
    ['a 45° ridge', RIDGE, 40],
  ]
  // A 1/8" ball at 10%, as the steep-walls test is cut. Two things only show at this scale:
  // the ball rolling over a facet's corner stands higher than either ring point beside it,
  // and the surface turns so sharply at a wall's foot that a crossing refined against it
  // may not converge. Unhandled, they cut 0.05 mm into a dome and 0.01 mm into a boss.
  const FINE_TOL = 0.005
  function worstFineGouge(S: Height, n: number) {
    const { m, segs } = waterline(S, n, BALL_EIGHTH, { stepoverPercent: 10 })
    const R = BALL_EIGHTH.diameterMM / 2
    // Every third cut point and every third MIDPOINT — a straight move can cut in between
    // two points that are both clear. Moves as the machine makes them: a "move" from the
    // end of one cut to the start of the next across a lift is no move at all.
    const pts: { x: number; y: number; z: number }[] = []
    for (let k = 1; k < segs.length; k++) {
      const a = segs[k - 1], b = segs[k]
      if (b.rapid) continue
      pts.push(b)
      if (!a.rapid) pts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
    }
    let worst = 0
    for (let k = 0; k < pts.length; k += 3) {
      const s = pts[k]
      for (let u = Math.max(0, s.x - R); u <= Math.min(W, s.x + R); u += 0.05) {
        for (let v = Math.max(0, s.y - R); v <= Math.min(W, s.y + R); v += 0.05) {
          const d = Math.hypot(u - s.x, v - s.y)
          if (d <= R) worst = Math.min(worst, s.z + toolProfileHeightMM(BALL_EIGHTH, d) - m.at(u, v))
        }
      }
    }
    return -worst
  }
  it('1/8" ball at 10%: a faceted dome — no move cuts across a facet corner between two ring points', { timeout: 60000 }, () => {
    expect(worstFineGouge(DOME, 80)).toBeLessThan(FINE_TOL)
  })
  it('1/8" ball at 10%: a 70° boss — no ring point is left where the surface turns at the foot', { timeout: 60000 }, () => {
    expect(worstFineGouge(BOSS, 40)).toBeLessThan(FINE_TOL)
  })

  for (const [name, S, n] of cases) {
    it(`ball nose: ${name}`, { timeout: 30000 }, () => {
      expect(worstGouge(S, n, BALL, 5)).toBeLessThan(GOUGE_TOL)
    })
    it(`taper: ${name}`, { timeout: 30000 }, () => {
      expect(worstGouge(S, n, TAPER, 25)).toBeLessThan(GOUGE_TOL)
    })
  }
})

describe('where the waterline puts its rings', () => {
  it('cuts the crown of a dome, not just the ring a level below it', () => {
    // Levels used to start a whole Z step below the top, leaving the crown standing. (Sunk
    // a millimetre: a crown AT the stock top is the stock's own surface, with nothing on it
    // to cut.)
    const sunk = waterline(DOME, 80, BALL, { modelTopMM: 1 }).cuts
    const top = sunk.filter((s) => Math.hypot(s.x - 20, s.y - 20) < STEP / 2)
    expect(top.length).toBeGreaterThan(0)
    expect(Math.max(...top.map((s) => s.z))).toBeGreaterThan(-1.05)
  })

  it('spaces neighbouring rings by the stepover measured ON THE PART, all the way up to the crown', () => {
    // Spacing the levels a stepover apart in Z left rings far apart across a gentle slope:
    // near the crown one Z step is several millimetres of surface. Measured here as the 3D
    // distance between one ring and the next, from the dome's foot to its top.
    const domeRings = rings(dome.cuts)
      .filter((r) => r.z > -14.99 && Math.hypot(centroid(r.pts)[0] - 20, centroid(r.pts)[1] - 20) < 0.5)
      .map((r) => ({ z: r.z, r: meanRadius(r.pts, 20, 20) }))
      .sort((a, b) => b.z - a.z)
    expect(domeRings.length).toBeGreaterThan(10)
    let worst = Math.hypot(domeRings[0].r, 0)   // from the crown to the first ring
    for (let k = 1; k < domeRings.length; k++) {
      worst = Math.max(worst, Math.hypot(domeRings[k].r - domeRings[k - 1].r, domeRings[k].z - domeRings[k - 1].z))
    }
    expect(worst).toBeLessThan(STEP * 1.05)
  })

  it('keeps the tool centre inside the model box, as the raster does', () => {
    for (const s of dome.cuts) {
      expect(s.x).toBeGreaterThanOrEqual(-1e-6); expect(s.x).toBeLessThanOrEqual(W + 1e-6)
      expect(s.y).toBeGreaterThanOrEqual(-1e-6); expect(s.y).toBeLessThanOrEqual(W + 1e-6)
    }
  })

  it('cuts climb: round a peak clockwise, round the inside of a pit anticlockwise', () => {
    // The material on the tool's right, for a clockwise spindle.
    const closed = (r: { pts: [number, number][] }) => {
      const p = r.pts, a = p[0], b = p[p.length - 1]
      return Math.hypot(a[0] - b[0], a[1] - b[1]) < STEP
    }
    const domeRings = rings(dome.cuts).filter((r) => r.z > -14.99 && closed(r))
    expect(domeRings.length).toBeGreaterThan(5)
    for (const r of domeRings) expect(signedArea(r.pts)).toBeLessThan(0)
    // (Wall rings only: the pit's bottom is a small flat, whose rings run the other way —
    // a floor ring cut outside-in has the uncut middle on its right.)
    const pitRings = rings(waterline(PIT, 40).cuts).filter((r) => r.z < -0.01 && r.z > -9.9 && closed(r))
    expect(pitRings.length).toBeGreaterThan(5)
    for (const r of pitRings) expect(signedArea(r.pts)).toBeGreaterThan(0)
  })
})

describe('the order the waterline cuts in', () => {
  it('cuts each peak from its tip down, one peak at a time, and the rings round both after both', () => {
    // The domes stand 2 mm apart, too close for a 6 mm ball between them: from a few mm
    // down the tool's rings join into one round both (centred between them).
    const { cuts } = waterline(TWO, 80)
    const peakRings = rings(cuts).filter((r) => r.z > -7.99)
    const side = peakRings.map((r) => {
      const x = centroid(r.pts)[0]
      return Math.abs(x - 20) < 2 ? 'both' : x < 20 ? 'A' : 'B'
    })
    // Runs of the same label, in cutting order: one peak, the other, then the shared rings.
    const order = side.filter((s, k) => k === 0 || s !== side[k - 1])
    expect(order.length).toBe(3)
    expect(order[2]).toBe('both')
    for (const label of ['A', 'B', 'both']) {
      const zs = peakRings.filter((_, k) => side[k] === label).map((r) => r.z)
      expect(zs.length).toBeGreaterThan(3)
      for (let k = 1; k < zs.length; k++) expect(zs[k]).toBeLessThan(zs[k - 1])
    }
  })

  it('goes down from one ring to the next on a ramp along it, never straight down', () => {
    // A straight step down between rings at the point nearest the last one's end lined up,
    // ring after ring, into a groove down the side of the part. Only an entry — the feed
    // after coming down from safe height — may go straight down.
    // (Above the floor: a floor ring follows the surface where it passes the foot of a wall,
    // and those dips are the surface's, not a step from one ring to the next.)
    const segs = dome.segs
    for (let k = 1; k < segs.length; k++) {
      const a = segs[k - 1], b = segs[k]
      if (b.rapid || a.rapid || b.z >= a.z - 1e-9 || b.z < -14.5) continue
      const run = Math.hypot(b.x - a.x, b.y - a.y), drop = a.z - b.z
      expect(drop / run, `move ${k}`).toBeLessThan(Math.tan(12 * Math.PI / 180))
    }
  })

  it('starts each ring somewhere new, so the step-downs do not line up into a seam', () => {
    // Where each ramp starts, as an angle round the dome. Lined up, they would all sit in
    // one narrow sector; carried round by each ring's overlap, they spread right round.
    const segs = dome.segs
    const angles: number[] = []
    for (let k = 1; k < segs.length - 1; k++) {
      const a = segs[k - 1], b = segs[k], c = segs[k + 1]
      if (a.rapid || b.rapid || c.rapid) continue
      if (Math.abs(b.z - a.z) < 1e-9 && c.z < b.z - 1e-9 && b.z > -14.99) angles.push(Math.atan2(b.y - 20, b.x - 20))
    }
    expect(angles.length).toBeGreaterThan(10)
    angles.sort((p, q) => p - q)
    let widestGap = angles[0] + 2 * Math.PI - angles[angles.length - 1]
    for (let k = 1; k < angles.length; k++) widestGap = Math.max(widestGap, angles[k] - angles[k - 1])
    expect(widestGap).toBeLessThan(Math.PI / 2)
  })
})

describe('the flats a waterline cannot cross', () => {
  /** The furthest any point of the floor beyond `rMin` is from a cut at floor height. */
  function floorGap(cuts: MotionSegment[], floorZ: number, rMin: number) {
    // (Within 0.03: the lowest wall ring stands 0.02 above the floor, where the ball is
    // still rolling off the wall onto it.)
    const onFloor = cuts.filter((s) => Math.abs(s.z - floorZ) < 0.03)
    let worst = 0
    for (let x = 0.5; x < W; x += 1) {
      for (let y = 0.5; y < W; y += 1) {
        if (Math.hypot(x - 20, y - 20) < rMin) continue
        let best = Infinity
        for (const s of onFloor) best = Math.min(best, Math.hypot(s.x - x, s.y - y))
        worst = Math.max(worst, best)
      }
    }
    return worst
  }

  it('finishes the floor round a dome — rings stepped in from its edge by the stepover', () => {
    // No ring at constant Z crosses a flat, so the floor used to be left as the roughing
    // left it.
    expect(floorGap(dome.cuts, -15, 15 + BALL.diameterMM / 2 + 0.5)).toBeLessThan(STEP)
  })

  it('cuts the floor after the walls standing on it', () => {
    const floorAt = dome.cuts.findIndex((s) => Math.abs(s.z + 15) < 0.01 && Math.hypot(s.x - 20, s.y - 20) > 20)
    let lastWall = -1
    dome.cuts.forEach((s, i) => { if (s.z > -14.9 && s.z < -1) lastWall = i })
    expect(floorAt).toBeGreaterThan(lastWall)
  })

  it('finishes the plane the maximum depth cuts the model off at, and goes no deeper', () => {
    const { cuts } = waterline(DOME, 80, BALL, { maxDepthMM: 10 })
    expect(Math.min(...cuts.map((s) => s.z))).toBeGreaterThanOrEqual(-10 - 1e-9)
    // The dome meets Z = −10 at r = √(225 − 25).
    expect(floorGap(cuts, -10, Math.sqrt(200) + BALL.diameterMM / 2 + 0.5)).toBeLessThan(STEP)
  })

  it('leaves a flat AT the stock top alone — there is nothing on it to cut', { timeout: 30000 }, () => {
    // The level search stops just under a steep boss's rim, which reads as a flat there.
    const { cuts } = waterline(BOSS, 40, BALL_EIGHTH, { stepoverPercent: 10 })
    const onTop = cuts.filter((s) => Math.hypot(s.x - 20, s.y - 20) < 8 - BALL_EIGHTH.diameterMM / 2 - 0.5)
    expect(onTop).toEqual([])
  })
})
