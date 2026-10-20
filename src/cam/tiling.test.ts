// Tiling (cam/tiling): a board longer than the machine, cut in windows and slid along on
// two pins between them. The clip is what the machine runs, so it is judged the way the
// machine would see it: where every tile's moves go, whether each cut is made exactly once,
// and how the tool comes back into a window. The seams, limits and pin stations are what
// keep each tile inside the machine's reach and the board registered from one to the next.
import { describe, it, expect } from 'vitest'
import {
  clipToWindow, tileOps, tileBounds, evenSeams, seamLimits, tilingProblem, maxTileLengthMM, minTileLengthMM,
  stationPins, stationTile, stationDepthMM, PIN_BREAKTHROUGH_MM, cutSpans, spanAt, normalizeTiling, TILING_DEFAULTS, type Tiling,
} from './tiling'
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'

const stock = { widthMM: 600, heightMM: 300 }
const tiling = (over: Partial<Tiling> = {}): Tiling => ({ axis: 'x', maxTravelMM: 200, seamsMM: [150, 300, 450], ...TILING_DEFAULTS, ...over })
const SAFE = 5

// A two-pass rectangle profile from x 10 to 590, and a full circle straddling x = 150.
function program(): MotionSegment[] {
  const s: MotionSegment[] = [{ x: 10, y: 10, z: SAFE, rapid: true }]
  for (const z of [-3, -6]) {
    s.push({ x: 10, y: 10, z, rapid: false })
    s.push({ x: 590, y: 10, z, rapid: false }, { x: 590, y: 290, z, rapid: false }, { x: 10, y: 290, z, rapid: false }, { x: 10, y: 10, z, rapid: false })
  }
  s.push({ x: 10, y: 10, z: SAFE, rapid: true })
  s.push({ x: 150, y: 130, z: SAFE, rapid: true }, { x: 150, y: 130, z: -2, rapid: false })
  s.push({ x: 150, y: 130, z: -2, rapid: false, arc: { cx: 150, cy: 150, cw: false } })
  s.push({ x: 150, y: 130, z: SAFE, rapid: true })
  return s
}

// Cutting length in XY, as the machine would run it: arcs at their radius, plunges not
// counted (a re-entry adds plunges, never cut length).
function cutLength(segs: MotionSegment[]): number {
  let L = 0
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1], b = segs[i]
    if (b.rapid || b.toolChange || (a.z >= 0 && b.z >= 0)) continue
    if (b.arc) {
      const r = Math.hypot(a.x - b.arc.cx, a.y - b.arc.cy)
      const full = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 1e-9
      L += full ? 2 * Math.PI * r : r * Math.abs(Math.atan2(b.y - b.arc.cy, b.x - b.arc.cx) - Math.atan2(a.y - b.arc.cy, a.x - b.arc.cx))
      continue
    }
    L += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return L
}

describe('clipping a program to a tile', () => {
  const b = tileBounds(tiling(), stock)
  const tiles = b.slice(0, -1).map((lo, k) => clipToWindow(program(), lo, b[k + 1], 'x', SAFE))

  it("keeps every one of a tile's moves inside its window", () => {
    tiles.forEach((segs, k) => {
      for (const g of segs) {
        expect(g.x).toBeGreaterThanOrEqual(b[k] - 1e-9)
        expect(g.x).toBeLessThanOrEqual(b[k + 1] + 1e-9)
      }
    })
  })

  it('cuts every part of the program exactly once over all the tiles', () => {
    const whole = cutLength(program())
    const sum = tiles.reduce((n, segs) => n + cutLength(segs), 0)
    // The circle the seam crosses is cut in chords (≤ 0.01 mm off the arc), so a hair short.
    expect(sum).toBeLessThanOrEqual(whole + 1e-6)
    expect(whole - sum).toBeLessThan(0.05)
  })

  it('keeps an arc that lies wholly inside the window as an arc', () => {
    const circleOnly = program().slice(-4)
    const kept = clipToWindow(circleOnly, 100, 200, 'x', SAFE)
    expect(kept.filter((g) => g.arc)).toHaveLength(1)
    const split = clipToWindow(circleOnly, 150, 300, 'x', SAFE)
    expect(split.some((g) => g.arc)).toBe(false)
  })

  it('comes back into the window by lifting to safe height, rapiding over, and plunging at the plunge feed', () => {
    const t1 = tiles[1]   // [150, 300]: the profile leaves and re-enters on every pass
    for (let i = 1; i < t1.length; i++) {
      const a = t1[i - 1], g = t1[i]
      const sideways = Math.hypot(g.x - a.x, g.y - a.y) > 1e-9
      // Nothing crosses sideways below safe height except a cut along the toolpath, and a
      // cut never starts from above the stock: a sideways move at depth follows one at depth.
      if (sideways && !g.rapid && g.z < 0) expect(a.z).toBeLessThan(0)
      if (sideways && g.rapid) expect(Math.min(a.z, g.z)).toBeGreaterThanOrEqual(SAFE - 1e-9)
    }
    // Each re-entry ends in a feed plunge straight down onto the cut.
    const plunges = t1.filter((g, i) => i > 0 && !g.rapid && g.z < 0 && g.x === t1[i - 1].x && g.y === t1[i - 1].y && g.z < t1[i - 1].z)
    expect(plunges.length).toBeGreaterThanOrEqual(2)
  })

  it('ends a tile operation at safe height, whatever depth the window left it at', () => {
    for (const segs of tiles) expect(segs[segs.length - 1].z).toBeGreaterThanOrEqual(SAFE)
  })
})

describe('the seams', () => {
  it('start as the fewest equal tiles the machine can reach', () => {
    const t = tiling({ seamsMM: [] })
    const seams = evenSeams(t, stock)
    expect(seams).toEqual([150, 300, 450])
    expect(tilingProblem({ ...t, seamsMM: seams }, stock)).toBeNull()
  })

  it('leave every tile but the last room to reach the next pair of pin holes', () => {
    const t = tiling()
    expect(maxTileLengthMM(t, 0, 4)).toBeCloseTo(t.maxTravelMM - t.pinFromStartMM - t.pin2DiaMM / 2, 9)
    expect(maxTileLengthMM(t, 3, 4)).toBe(t.maxTravelMM)
    expect(tilingProblem(tiling({ seamsMM: [190, 300, 450] }), stock)).toMatch(/next pair of pin holes/)
  })

  it('can go into a gap however short that makes the tile before it', () => {
    const lim = seamLimits(tiling(), stock, 0)
    expect(lim.min).toBeCloseTo(minTileLengthMM(tiling()), 9)
    expect(lim.max).toBeCloseTo(maxTileLengthMM(tiling(), 0, 4), 9)
  })

  it('are not held back by the tile after them — a tile left too long is reported, not prevented', () => {
    // One seam on a 600 mm board: the tile after it can never fit, and the seam still moves.
    const one = tiling({ seamsMM: [100] })
    const lim = seamLimits(one, stock, 0)
    expect(lim.max).toBeGreaterThan(lim.min)
    expect(tilingProblem(one, stock)).toMatch(/Tile 2/)
  })

  it('read the board a dragged seam crosses: inside a cut span, or a clean break', () => {
    const op = { id: 'p', type: 'profile', toolId: 't', segments: program() } as unknown as AnyOperation
    const spans = cutSpans([op], 'x', () => 3)
    expect(spanAt(spans, 300)).toBeGreaterThanOrEqual(0)   // the profile's long sides cross every seam
    const shortOp = { ...op, segments: program().slice(-4) } as unknown as AnyOperation
    const s2 = cutSpans([shortOp], 'x', () => 3)
    expect(spanAt(s2, 150)).toBeGreaterThanOrEqual(0)
    expect(spanAt(s2, 172)).toBeGreaterThanOrEqual(0)      // past the toolpath (x 170) but inside the tool
    expect(spanAt(s2, 175)).toBe(-1)                        // past the circle and its tool radius
  })
})

describe('the pin stations', () => {
  it('put each pair the same distance into its tile, one bigger than the other', () => {
    const t = tiling()
    const b = tileBounds(t, stock)
    for (let k = 0; k < 4; k++) {
      const [small, big] = stationPins(t, stock, k)
      expect(small.x).toBeCloseTo(b[k] + t.pinFromStartMM, 9)
      expect(big.x).toBeCloseTo(b[k] + t.pinFromStartMM, 9)
      expect(big.diaMM - small.diaMM).toBeGreaterThanOrEqual(1)
    }
  })

  it('are drilled one tile ahead: tile 1 drills the first two, every later station its predecessor', () => {
    expect([0, 1, 2, 3].map(stationTile)).toEqual([0, 0, 1, 2])
  })

  it('go into the spoilboard only at the first station — where the pins go — and only through the board after it', () => {
    expect(stationDepthMM(tiling(), 0, 12)).toBe(12 + TILING_DEFAULTS.spoilDepthMM)
    for (const k of [1, 2, 3]) expect(stationDepthMM(tiling(), k, 12)).toBe(12 + PIN_BREAKTHROUGH_MM)
  })

  it('refuse two pins the same size, since then the board goes back on turned round', () => {
    expect(tilingProblem(tiling({ pin2DiaMM: 8 }), stock)).toMatch(/bigger than the small one/)
  })
})

describe("a tile's program", () => {
  const t = tiling({ pinPathIds: ['s0', 's1', 's2', 's3'] })
  const pinOp = (station: number): AnyOperation => {
    const [p] = stationPins(t, stock, station)
    return { id: `pin${station}`, type: 'drill', pathId: `s${station}`, segments: [{ x: p.x, y: p.y, z: SAFE, rapid: true }, { x: p.x, y: p.y, z: -20, rapid: false }] } as unknown as AnyOperation
  }
  const part = { id: 'part', type: 'profile', segments: program() } as unknown as AnyOperation

  it('is moved so its window starts at the same machine spot every time', () => {
    const b = tileBounds(t, stock)
    for (let k = 0; k < 4; k++) {
      const [op] = tileOps([part], t, stock, k, () => SAFE)
      const xs = op.segments.map((g) => g.x)
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1e-9)
      expect(Math.max(...xs)).toBeLessThanOrEqual(b[k + 1] - b[k] + 1e-9)
    }
  })

  it('drills the pin holes for the NEXT tile whole, outside its own window, and no other tile drills them', () => {
    const ops = [0, 1, 2, 3].map(pinOp)
    for (let k = 0; k < 4; k++) {
      const got = tileOps(ops, t, stock, k, () => SAFE).map((o) => o.id)
      expect(got).toEqual(ops.filter((_, s) => stationTile(s) === k).map((o) => o.id))
    }
    // Tile 1 drills station 2 at its full tile length plus the pins' distance.
    const [st1] = tileOps([pinOp(1)], t, stock, 0, () => SAFE)
    expect(st1.segments[0].x).toBeCloseTo(150 + t.pinFromStartMM, 9)
  })

  it('reads a setting from an older build, and leaves out what is not a number', () => {
    const n = normalizeTiling({ axis: 'y', maxTravelMM: 400, seamsMM: [300, 'x', 100], pin1DiaMM: 6 })!
    expect(n.axis).toBe('y')
    expect(n.seamsMM).toEqual([100, 300])
    expect(n.pin2DiaMM).toBe(TILING_DEFAULTS.pin2DiaMM)
  })
})
