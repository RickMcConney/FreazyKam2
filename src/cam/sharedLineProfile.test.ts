import { describe, it, expect, beforeEach } from 'vitest'
import {
  generateSharedLineProfile, buildNetwork, routeNetwork, walkTrails, cornerSeconds, estimateMinutes, travelBeatsLift,
  type MachineRates, type SharedLinePart,
} from './sharedLineProfile'
import { generateProfile, offsetClosedSubpaths, type ProfileParams } from './profile'
import { flattenPath, type Pt2 } from './pathFlattener'
import { takeNotes } from './notes'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { Tab } from '../store/tabStore'

// A 6 mm end mill: parts one cutter apart sit 6 mm apart, and their cut paths (offset
// 3 mm each) meet on the line halfway between them.
const tool: Tool = {
  id: 't', name: 't', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000,
  xyFeedMmMin: 2000, zFeedMmMin: 400, maxDepthMM: 30,
}
const rates: MachineRates = { rapidMmMin: 3000, accelMmS2: 200, junctionDeviationMM: 0.01 }
const params: ProfileParams = { side: 'outside', depthMM: 12, stepDownMM: 4, direction: 'climb', safeHeightMM: 5 }
const PASSES = 3
const DEPTH = -12

const sq = (x: number, y: number, w = 20, h = 20) => `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
const parts = (...ds: string[]): SharedLinePart[] => ds.map((d) => ({ d }))
const cut = (ps: SharedLinePart[], p = params) => generateSharedLineProfile(ps, tool, p, rates)

/** XY length of the cutting moves below the surface (all straight — square parts). */
function cutLength(segs: MotionSegment[]): number {
  let len = 0
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1], b = segs[i]
    if (!b.rapid && b.z < 0 && a.z < 0) len += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return len
}

/** Is `q` on a cutting move at full depth? */
function cutAtDepth(q: Pt2, segs: MotionSegment[]): boolean {
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1], b = segs[i]
    if (b.rapid || Math.abs(a.z - DEPTH) > 1e-9 || Math.abs(b.z - DEPTH) > 1e-9) continue
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a.x) * dx + (q[1] - a.y) * dy) / l2)) : 0
    if (Math.hypot(q[0] - a.x - t * dx, q[1] - a.y - t * dy) < 1e-6) return true
  }
  return false
}

/** Every point of every part's cut path, every 0.5 mm, is cut at full depth. */
function everyCutPathCut(ps: SharedLinePart[], segs: MotionSegment[]): boolean {
  for (const p of ps) for (const ring of offsetClosedSubpaths(flattenPath(p.d, 0.05), 3)) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      const n = Math.max(1, Math.ceil(2 * Math.hypot(b[0] - a[0], b[1] - a[1])))
      for (let k = 0; k < n; k++) if (!cutAtDepth([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], segs)) return false
    }
  }
  return true
}

function ptDist(q: Pt2, a: Pt2, b: Pt2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy)
}

/** Times the tool rises from the work to safe height — once per separate toolpath. */
const retracts = (segs: MotionSegment[]) => segs.filter((s, i) => s.rapid && s.z === 5 && i > 0 && segs[i - 1].z < 5).length

/** Corners the machine slows for at full depth: a turn of more than 1° between two consecutive cutting moves. */
function corners(segs: MotionSegment[]): number {
  let n = 0
  for (let i = 2; i < segs.length; i++) {
    const a = segs[i - 2], b = segs[i - 1], c = segs[i]
    if ([a, b, c].some((x) => x.rapid || x.travel || Math.abs(x.z - DEPTH) > 1e-9)) continue
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy)
    if (lu < 1e-9 || lv < 1e-9) continue
    if ((ux * vx + uy * vy) / (lu * lv) < Math.cos(Math.PI / 180)) n++
  }
  return n
}

beforeEach(() => { takeNotes() })

describe('generateSharedLineProfile — two parts one cutter apart', () => {
  // Left part 0..20, right part 26..46: their cut paths meet on x = 23, from y = −3 to 23.
  const two = parts(sq(0, 0), sq(26, 0))

  it('every point of both parts\' cut paths is cut at full depth', () => {
    expect(everyCutPathCut(two, cut(two).segments)).toBe(true)
  })

  it('the shared line is cut once per depth pass, so the job is that much shorter', () => {
    const r = cut(two)
    expect(r.sharedLengthMM).toBeCloseTo(26, 9)
    const plain = two.reduce((s, p) => s + cutLength(generateProfile(p.d, tool, params)), 0)
    expect(cutLength(r.segments)).toBeCloseTo(plain - 26 * PASSES, 6)
  })

  it('is cut as ONE toolpath: one retract for the whole sheet', () => {
    const r = cut(two)
    expect(r.toolpaths).toBe(1)
    expect(retracts(r.segments)).toBe(1)
  })

  it('the toolpath is started from whichever of its ends is nearer the tool', () => {
    // One open toolpath, from one T-junction on the shared line to the other: (23, −3) and (23, 23).
    const fromAbove = cut(two, { ...params, startNear: { x: 23, y: 100 } }).segments.find((s) => !s.rapid)!
    const fromBelow = cut(two, { ...params, startNear: { x: 23, y: -100 } }).segments.find((s) => !s.rapid)!
    expect(fromAbove.y).toBeCloseTo(23, 9)
    expect(fromBelow.y).toBeCloseTo(-3, 9)
  })

  it('a tab on the shared edge holds that edge up, whichever part the tab belongs to', () => {
    // The right part's design path runs 26,0 → 46,0 → 46,20 → 26,20 → 26,0: t = 0.875 is
    // the middle of its left edge — the shared line, at (23, 10).
    const tab: Tab = { id: 'tab', pathId: 'p', t: 0.875, lengthMM: 4, heightMM: 3 }
    const r = cut([two[0], { ...two[1], tabs: [tab] }])
    // Held up for the tab's length plus the cutter's radius either side: y 5 → 15.
    expect(cutAtDepth([23, 10], r.segments)).toBe(false)
    expect(cutAtDepth([23, 4], r.segments)).toBe(true)
    expect(r.segments.some((s) => Math.abs(s.x - 23) < 1e-9 && Math.abs(s.y - 10) <= 5 && s.z === -9)).toBe(true)
  })
})

describe('generateSharedLineProfile — routing the network', () => {
  it('a 2 × 2 grid is cut completely, as the fewest toolpaths its junctions allow', () => {
    // Four T-junctions on the outside (odd), a cross in the middle (even): two open toolpaths.
    const grid = parts(sq(0, 0), sq(26, 0), sq(0, 26), sq(26, 26))
    const r = cut(grid)
    expect(everyCutPathCut(grid, r.segments)).toBe(true)
    expect(r.toolpaths).toBe(2)
  })

  it('cuts a grid in well under the time of profiling each part on its own', () => {
    const grid = parts(...[0, 1, 2].flatMap((c) => [0, 1].map((rr) => sq(c * 26, rr * 26))))
    const r = cut(grid)
    expect(everyCutPathCut(grid, r.segments)).toBe(true)
    const from = { x: 0, y: 0, z: 5 }
    const plain = grid.flatMap((p) => generateProfile(p.d, tool, params))
    expect(estimateMinutes(r.segments, from, tool, rates.rapidMmMin)).toBeLessThan(0.8 * estimateMinutes(plain, from, tool, rates.rapidMmMin))
    // Six odd junctions (four T's along the top and bottom, one each side) — so three
    // toolpaths is the least any routing can do, against six parts' worth of loops.
    expect(r.toolpaths).toBe(3)
    expect(retracts(plain)).toBe(6)
  })

  it('a row of parts turns far fewer corners than cutting each part round, because lines run straight through junctions', () => {
    const row = parts(sq(0, 0), sq(26, 0), sq(52, 0), sq(78, 0))
    const r = cut(row)
    expect(everyCutPathCut(row, r.segments)).toBe(true)
    const plain = row.flatMap((p) => generateProfile(p.d, tool, params))
    expect(corners(r.segments)).toBeLessThan(corners(plain) / 2)
  })

  it('a part standing alone in the sheet is still cut, as its own closed loop', () => {
    const ps = parts(sq(0, 0), sq(26, 0), sq(100, 100))
    const r = cut(ps)
    expect(everyCutPathCut(ps, r.segments)).toBe(true)
    expect(r.toolpaths).toBe(2)
  })

  it('a part sitting in another part\'s hole does not stop its neighbours sharing a line', () => {
    const frame = `${sq(0, 0, 60, 60)} ${sq(15, 15, 30, 30)}`
    const r = cut(parts(frame, sq(25, 25, 10, 10), sq(66, 0, 20, 60)))
    expect(r.sharedLengthMM).toBeGreaterThan(60)
    expect(cutAtDepth([30, 22], r.segments)).toBe(true) // the inner part's own loop
  })
})

describe('generateSharedLineProfile — when nothing is shared', () => {
  it('parts further apart than the cutter share nothing, but are still routed — and nothing needs saying', () => {
    const ps = parts(sq(0, 0), sq(30, 0))
    const r = cut(ps)
    expect(r.sharedLengthMM).toBe(0)
    expect(r.toolpaths).toBe(2)
    expect(everyCutPathCut(ps, r.segments)).toBe(true)
    expect(cutLength(r.segments)).toBeCloseTo(ps.reduce((s, p) => s + cutLength(generateProfile(p.d, tool, params)), 0), 6)
    expect(takeNotes()).toEqual([])
  })

  it('parts closer than the cutter refuse sharing outright and are cut as plain profiles', () => {
    const r = cut(parts(sq(0, 0), sq(24, 0)))
    expect(r.sharedLengthMM).toBe(0)
    expect(takeNotes()[0].short).toMatch(/closer than the cutter/)
  })

  it('a stock allowance moves every cut path out with it, so parts one cutter apart now overlap and are refused', () => {
    const r = cut(parts(sq(0, 0), sq(26, 0)), { ...params, allowanceMM: 0.2 })
    expect(r.sharedLengthMM).toBe(0)
    expect(takeNotes()[0].short).toMatch(/closer than the cutter/)
  })

  it('…while parts one cutter plus twice the allowance apart share their line again', () => {
    const r = cut(parts(sq(0, 0), sq(26.4, 0)), { ...params, allowanceMM: 0.2 })
    expect(r.sharedLengthMM).toBeCloseTo(26.4, 6)
  })

  it('separate parts are cut nearest first from where the tool comes from', () => {
    const r = cut(parts(sq(0, 0), sq(100, 0)), { ...params, startNear: { x: 130, y: 10 } })
    expect(r.segments.find((s) => !s.rapid)!.x).toBeGreaterThan(90)
  })
})

describe('generateSharedLineProfile — bridges through waste', () => {
  // Two 40 × 20 rectangles end to end with a 10 mm gap: their cut paths stand 4 mm apart,
  // with the top and bottom edges on the same lines.
  const endToEnd = parts(sq(0, 0, 40, 20), sq(50, 0, 40, 20))
  const bridged = (ps = endToEnd, max = 10) => generateSharedLineProfile(ps, tool, params, rates, { bridgeMaxMM: max })

  it('with bridges off, two parts that share nothing are two toolpaths', () => {
    expect(cut(endToEnd).toolpaths).toBe(2)
  })

  it('a short bridge across the gap joins them into one toolpath, cut every pass', () => {
    const r = bridged()
    expect(r.bridges).toBe(1)
    expect(r.toolpaths).toBe(1)
    expect(retracts(r.segments)).toBe(1)
    expect(everyCutPathCut(endToEnd, r.segments)).toBe(true)
    expect(r.segments.filter((s) => s.bridge && Math.abs(s.z - DEPTH) < 1e-9).length).toBeGreaterThan(0)
  })

  it('the bridge runs straight on from the parts\' edges, so it adds no corner', () => {
    const b = bridged().segments.filter((s) => s.bridge)
    // Along the top or bottom line, from one cut path's corner to the other's.
    expect(b.every((s) => Math.abs(s.y - 23) < 1e-9 || Math.abs(s.y + 3) < 1e-9)).toBe(true)
  })

  it('a bridge is only cut when it saves time', () => {
    const r = bridged()
    const from = { x: 0, y: 0, z: 5 }
    expect(estimateMinutes(r.segments, from, tool, rates.rapidMmMin)).toBeLessThan(estimateMinutes(cut(endToEnd).segments, from, tool, rates.rapidMmMin))
  })

  it('no bridge longer than allowed — and a note says that is why there is none', () => {
    expect(bridged(endToEnd, 3).bridges).toBe(0)
    expect(takeNotes().map((n) => n.short)).toEqual(['No bridges: no clear gap between parts under 3 mm'])
  })

  /** The nearest any bridge move comes to `q`. */
  const bridgeDist = (segs: MotionSegment[], q: Pt2) => Math.min(Infinity, ...segs.flatMap((s, k) =>
    s.bridge && k > 0 ? [ptDist(q, [segs[k - 1].x, segs[k - 1].y], [s.x, s.y])] : []))

  it('a bridge that would pass through a part is never cut — it may come no nearer a part than the cut path does', () => {
    // Small parts 7 mm clear of both, sitting across both lines a bridge would take (y = −3
    // and y = 23) — so the layout itself is sound and only a bridge could mark them.
    const blocked = parts(sq(0, 0, 40, 20), sq(60, 0, 40, 20), sq(47, -4, 6, 4), sq(47, 20, 6, 4))
    const r = bridged(blocked, 20)
    expect(takeNotes()).toEqual([])
    for (const [x, y] of [[47, -4], [53, -4], [53, 0], [47, 0], [47, 20], [53, 20], [53, 24], [47, 24]]) {
      expect(bridgeDist(r.segments, [x, y])).toBeGreaterThanOrEqual(3 - 1e-6)
    }
    for (let k = 1; k < r.segments.length; k++) {
      const s = r.segments[k], p = r.segments[k - 1]
      if (s.bridge) for (const y of [-3, 23]) expect(Math.abs(s.y - y) < 1e-9 && Math.abs(p.y - y) < 1e-9).toBe(false)
    }
    expect(everyCutPathCut(blocked, r.segments)).toBe(true)
  })

  it('a bridge never starts inside a tab — the corners it would leave from are held by tabs', () => {
    // Tabs 1 mm short of the left part's right-hand corners, top and bottom: a tab is held for
    // 2 mm plus the cutter's 3 mm either side, so both corners are inside one.
    const tabs: Tab[] = [39 / 120, 61 / 120].map((t, i) => ({ id: `t${i}`, pathId: 'p', t, lengthMM: 4, heightMM: 3 }))
    const r = bridged(parts(sq(0, 0, 40, 20), sq(50, 0, 40, 20)).map((p, i) => (i === 0 ? { ...p, tabs } : p)))
    expect(r.bridges).toBe(0)
    expect(bridgeDist(r.segments, [39, 23])).toBeGreaterThan(5)
    expect(bridgeDist(r.segments, [39, -3])).toBeGreaterThan(5)
  })

  it('a long bridge that costs more to cut every pass than the toolpath it saves is not cut', () => {
    // A 60 mm gap: 54 mm of waste cut three times (~4.9 s), against one retract and set of
    // plunges plus the two corners a straight-on bridge saves each pass (~3.4 s).
    expect(bridged(parts(sq(0, 0, 40, 20), sq(100, 0, 40, 20)), 70).bridges).toBe(0)
    expect(takeNotes().map((n) => n.short)).toEqual(['No bridges: none would save time here'])
  })

  it('a bridge never joins two points of the same part', () => {
    const lone = parts(`M 0 0 L 40 0 L 40 30 L 30 30 L 30 10 L 10 10 L 10 30 L 0 30 Z`, sq(200, 0))
    expect(bridged(lone, 20).bridges).toBe(0)
  })
})

describe('generateSharedLineProfile — staying down in cut kerf', () => {
  it('between two toolpaths joined by cut kerf, the tool travels along it instead of lifting', () => {
    // A 2 × 2 grid: two open toolpaths, the second starting on a line the first cut through.
    const grid = parts(sq(0, 0), sq(26, 0), sq(0, 26), sq(26, 26))
    const r = cut(grid)
    expect(r.toolpaths).toBe(2)
    expect(r.segments.some((s) => s.travel)).toBe(true)
    expect(retracts(r.segments)).toBe(1)
    expect(everyCutPathCut(grid, r.segments)).toBe(true)
  })

  it('travel stays at the full depth of the kerf it runs in', () => {
    const r = cut(parts(sq(0, 0), sq(26, 0), sq(0, 26), sq(26, 26)))
    for (const s of r.segments.filter((x) => x.travel)) expect(s.z).toBeCloseTo(DEPTH, 9)
  })

  it('never travels over a tab, which is material still standing in the kerf', () => {
    const grid = parts(sq(0, 0), sq(26, 0), sq(0, 26), sq(26, 26))
    // Untabbed, the travel runs along the top of the top-left part (y = 49); a tab there,
    // in the middle of that edge (its design path's t = 0.625), stands in the way.
    expect(cut(grid).segments.some((s, k) => s.travel && k > 0 && s.y === 49 && cut(grid).segments[k - 1].y === 49)).toBe(true)
    const tabbed = grid.map((p, i) => (i === 2 ? { ...p, tabs: [{ id: 't', pathId: 'p', t: 0.625, lengthMM: 4, heightMM: 3 }] } : p))
    const r = cut(tabbed)
    for (let k = 1; k < r.segments.length; k++) {
      if (r.segments[k].travel) expect(ptDist([10, 49], [r.segments[k - 1].x, r.segments[k - 1].y], [r.segments[k].x, r.segments[k].y])).toBeGreaterThan(5)
    }
    expect(everyCutPathCut(grid, r.segments.filter((s) => !s.travel))).toBe(false) // the tab is left standing…
    expect(cutAtDepth([10, 46.9], r.segments) || cutAtDepth([0, 49], r.segments)).toBe(true) // …and the rest of that edge is cut
  })

  it('travels only when that beats lifting, rapiding across and plunging again', () => {
    const lift = 17, plunge = 9
    // Straight along the kerf to a start 30 mm away: travel wins.
    expect(travelBeatsLift(30, 30, lift, plunge, tool, rates)).toBe(true)
    // A 2 m detour through the kerf to a start 30 mm away by air: lift.
    expect(travelBeatsLift(2000, 30, lift, plunge, tool, rates)).toBe(false)
  })
})

describe('routeNetwork', () => {
  const corner = (c: number) => cornerSeconds(c, 2000, rates)

  it('two lines end to end become one toolpath', () => {
    const net = buildNetwork([[[0, 0], [10, 0]], [[10, 0], [20, 0]]])
    const trails = walkTrails(net, routeNetwork(net, corner, 3).partner)
    expect(trails.length).toBe(1)
    expect(trails[0].nodes.length).toBe(3)
  })

  it('at a cross, each line carries straight on rather than turning', () => {
    const net = buildNetwork([[[-10, 0], [0, 0]], [[0, 0], [10, 0]], [[0, -10], [0, 0]], [[0, 0], [0, 10]]])
    const trails = walkTrails(net, routeNetwork(net, corner, 3).partner)
    expect(trails.length).toBe(2)
    for (const t of trails) {
      const ps = t.nodes.map((n) => net.nodes[n])
      expect(ps.every((p) => p[0] === ps[0][0]) || ps.every((p) => p[1] === ps[0][1])).toBe(true)
    }
  })

  it('a loop that touches a line is joined into it when a toolpath costs more than the corners', () => {
    // A square with a line standing up from the middle of its top side: carrying the top
    // side straight on through that junction leaves the square a loop and the line a toolpath
    // of its own. Turning into the line there joins them, at the price of one corner.
    const spans: [Pt2, Pt2][] = [[[0, 0], [10, 0]], [[10, 0], [10, 10]], [[10, 10], [5, 10]], [[5, 10], [0, 10]], [[0, 10], [0, 0]], [[5, 10], [5, 20]]]
    const net = buildNetwork(spans)
    expect(walkTrails(net, routeNetwork(net, corner, 3).partner).length).toBe(1)
    // …and left as two when a toolpath costs next to nothing and corners a great deal.
    expect(walkTrails(net, routeNetwork(net, corner, 1e-6).partner).length).toBe(2)
  })
})

describe('buildNetwork', () => {
  it('span ends one Clipper rounding step apart in each axis are one junction, not a dead end', () => {
    const net = buildNetwork([[[0, 0], [10, 0]], [[10.000001, 0.000001], [20, 0]], [[10, 0], [10, 10]]])
    expect(net.nodes.length).toBe(4)
    expect(net.at.map((hs) => hs.length).sort()).toEqual([1, 1, 1, 3])
  })
})

describe('cornerSeconds', () => {
  it('costs nothing straight on, more for a sharper turn, and a full stop for a reversal', () => {
    const at = (deg: number) => cornerSeconds(Math.cos((deg * Math.PI) / 180), 2000, rates)
    expect(at(0)).toBe(0)
    expect(at(45)).toBeGreaterThan(0)
    expect(at(90)).toBeGreaterThan(at(45))
    expect(at(180)).toBeGreaterThan(at(90))
    // A reversal stops dead: brake from 2000 mm/min to nothing and accelerate back.
    expect(at(180)).toBeCloseTo((2000 / 60) / 200, 9)
  })
})
