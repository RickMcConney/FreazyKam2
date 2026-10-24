import { describe, it, expect } from 'vitest'
import { planBridges, clampToBridges, normalizeBridges, type BridgeSet, type BridgeLine, type Join } from './bridges'
import { generateProfile, polylinePassWithTabs } from './profile'
import { generateTrochoidal } from './trochoidal'
import { arcLengths, pointInPolygon } from './geom'
import { flattenPath } from './pathFlattener'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'
import type { Pt2 } from './pathFlattener'

const EM6: Tool = {
  id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const rect = (x: number, y: number, w: number, h: number) =>
  `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
const tri = (x: number, y: number, w: number, h: number) => `M ${x} ${y} L ${x + w} ${y} L ${x + w * 0.3} ${y + h} Z`
const circle = (cx: number, cy: number, r: number) =>
  `M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} Z`
const STOCK = { widthMM: 200, heightMM: 150 }
const set = (lines: BridgeLine[], widthMM = 5, heightMM = 2): BridgeSet => ({ lines, widthMM, heightMM, pathIds: [] })
const vert = (x: number, y1: number, y2: number): BridgeLine => ({ x1: x, y1, x2: x, y2 })
const horz = (y: number, x1: number, x2: number): BridgeLine => ({ x1, y1: y, x2, y2: y })
const DEPTH = 6

// THE PROPERTY: below the bridge's top, the cutter never enters a strip. Every move is walked
// in 0.05 mm steps — an arc along its circle — and wherever the tool is deeper than the
// bridge, its centre must be at least the strip's half width plus the cutter's radius from
// the line.
function intrusions(segs: MotionSegment[], b: BridgeSet, radius: number, depthMM = DEPTH): string[] {
  const top = -depthMM + b.heightMM
  const bad: string[] = []
  let prev: MotionSegment | null = null
  for (const s of segs) {
    if (prev && !s.rapid) {
      const len = Math.hypot(s.x - prev.x, s.y - prev.y)
      const n = Math.max(1, Math.ceil(len / 0.05))
      for (let k = 0; k <= n; k++) {
        const u = k / n
        let x = prev.x + u * (s.x - prev.x), y = prev.y + u * (s.y - prev.y)
        if (s.arc) {
          const a0 = Math.atan2(prev.y - s.arc.cy, prev.x - s.arc.cx), a1 = Math.atan2(s.y - s.arc.cy, s.x - s.arc.cx)
          let sweep = a1 - a0
          if (s.arc.cw && sweep > 0) sweep -= 2 * Math.PI
          if (!s.arc.cw && sweep < 0) sweep += 2 * Math.PI
          const r = Math.hypot(prev.x - s.arc.cx, prev.y - s.arc.cy)
          x = s.arc.cx + r * Math.cos(a0 + u * sweep); y = s.arc.cy + r * Math.sin(a0 + u * sweep)
        }
        const z = prev.z + u * (s.z - prev.z)
        if (z >= top - 1e-9) continue
        for (const l of b.lines) {
          const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1), ux = (l.x2 - l.x1) / len, uy = (l.y2 - l.y1) / len
          const along = (x - l.x1) * ux + (y - l.y1) * uy, across = -(x - l.x1) * uy + (y - l.y1) * ux
          // Strictly inside its length: a strip's ends are inside parts or at the sheet's edge.
          if (along <= 0 || along >= len) continue
          if (Math.abs(across) < b.widthMM / 2 + radius - 1e-6) bad.push(`(${x.toFixed(2)}, ${y.toFixed(2)}, z ${z.toFixed(2)})`)
        }
      }
    }
    prev = s
  }
  return bad
}

const profile = (d: string, b: BridgeSet | undefined, side: 'outside' | 'inside' | 'centerline' = 'outside') =>
  generateProfile(d, EM6, { side, depthMM: DEPTH, stepDownMM: 2, direction: 'climb', safeHeightMM: 5, bridges: b })

describe('a cut that crosses a bridge leaves the bridge standing', () => {
  const B = set([vert(30, 0, 150), horz(25, 0, 200)])

  for (const [name, d] of [['a rectangle', rect(10, 10, 40, 30)], ['a triangle', tri(5, 5, 50, 45)], ['a circle', circle(30, 25, 18)]] as const) {
    it(`outside profile of ${name}: never cuts into a strip below its top`, () => {
      const segs = profile(d, B)
      expect(intrusions(profile(d, undefined), B, 3).length).toBeGreaterThan(0) // without them it would
      expect(intrusions(segs, B, 3)).toEqual([])
    })
  }

  it('lifts only where it crosses — the rest of the cut goes to full depth', () => {
    const segs = profile(rect(10, 10, 40, 30), B)
    expect(Math.min(...segs.map((s) => s.z))).toBe(-DEPTH)
    const lifted = segs.filter((s) => !s.rapid && s.z === -DEPTH + 2)
    expect(lifted.length).toBeGreaterThan(0)
  })

  it('a centerline cut lifts too', () => {
    expect(intrusions(profile(rect(10, 10, 40, 30), B, 'centerline'), B, 3)).toEqual([])
  })

  it('an INSIDE cut does not lift — a hole cannot part a strip its part carries', () => {
    const hole = rect(20, 15, 20, 20)
    expect(profile(hole, B)).not.toEqual(profile(hole, undefined))
    expect(profile(hole, B, 'inside')).toEqual(profile(hole, undefined, 'inside'))
  })

  // Its loops swing a whole 2l off their guide — toward the strip, where the guide crosses it
  // at a slant — so the triangle and the circle are the cases that matter.
  for (const [name, d] of [['a rectangle', rect(10, 10, 40, 30)], ['a triangle', tri(5, 5, 50, 45)], ['a circle', circle(30, 25, 18)]] as const) {
    it(`a trochoidal outside cut of ${name} keeps its loops out of the strip as well`, () => {
      const p = { side: 'outside' as const, depthMM: DEPTH, stepDownMM: 3, direction: 'climb' as const, trochRadiusMM: 2.5, trochStepMM: 1, finishingPass: true, safeHeightMM: 5 }
      expect(intrusions(generateTrochoidal(d, EM6, p), B, 3).length).toBeGreaterThan(0)
      expect(intrusions(generateTrochoidal(d, EM6, { ...p, bridges: B }), B, 3)).toEqual([])
    })
  }
})

describe('clampToBridges — a move inside a strip\'s reach is raised to its top', () => {
  const B1 = set([vert(50, -10, 10)], 4)
  const at = (x: number, y: number, z: number, more: Partial<MotionSegment> = {}): MotionSegment => ({ x, y, z, rapid: false, ...more })
  const raised = (segs: MotionSegment[]) => segs.filter((s) => s.z === -4)

  it('raises exactly the stretch within the strip grown by the cutter, with a step up and down', () => {
    const out = clampToBridges([at(0, 0, -6), at(100, 0, -6)], B1, 3, -4)
    expect(out.map((s) => [+s.x.toFixed(6), s.z])).toEqual([[0, -6], [45, -6], [45, -4], [55, -4], [55, -6], [100, -6]])
  })

  it('raises a longer stretch where the move crosses at a slant', () => {
    const out = raised(clampToBridges([at(0, -50, -6), at(100, 50, -6)], set([vert(50, -100, 100)], 4), 3, -4))
    expect(Math.hypot(out[1].x - out[0].x, out[1].y - out[0].y)).toBeCloseTo(10 * Math.SQRT2, 6)
  })

  it('stops a plunge inside a strip at its top', () => {
    expect(clampToBridges([at(50, 0, 5, { rapid: true }), at(50, 0, -6)], B1, 3, -4).map((s) => s.z)).toEqual([5, -4])
  })

  it('keeps a ramp\'s slope above the top, and meets the top where the ramp does', () => {
    const out = clampToBridges([at(40, 0, 0), at(60, 0, -8)], B1, 3, -4)
    expect(Math.min(...out.filter((s) => s.x > 45 + 1e-9 && s.x < 55 - 1e-9).map((s) => s.z))).toBeGreaterThanOrEqual(-4)
    expect(out.some((s) => Math.abs(s.x - 50) < 1e-9 && s.z === -4)).toBe(true)
  })

  it('follows an arc that crosses a strip as straight moves, raised where they cross', () => {
    // A half circle round (50, 0) from (30, 0) to (70, 0), over the top: through the strip at x 50.
    const out = clampToBridges([at(30, 0, -6), at(70, 0, -6, { arc: { cx: 50, cy: 0, cw: true } })], set([vert(50, -100, 100)], 4), 3, -4)
    expect(out.every((s) => !s.arc)).toBe(true)
    expect(out.filter((s) => Math.abs(s.x - 50) < 5 - 1e-6).every((s) => s.z >= -4)).toBe(true)
  })

  it('leaves an arc clear of every strip as an arc, and leaves moves above the top alone', () => {
    const arc = at(10, 0, -6, { arc: { cx: 5, cy: 0, cw: true } })
    expect(clampToBridges([at(0, 0, -6), arc], B1, 3, -4)).toEqual([at(0, 0, -6), arc])
    const high = [at(0, 0, -2), at(100, 0, -2)]
    expect(clampToBridges(high, B1, 3, -4)).toEqual(high)
  })

  it('leaves the move alone past the end of a strip, beyond the cutter\'s reach', () => {
    const segs = [at(0, 0, -6), at(100, 0, -6)]
    expect(clampToBridges(segs, set([vert(50, 5, 20)]), 3, -4)).toEqual(segs)
  })

  it('holds a strip at any angle off the cut, in the strip\'s own frame', () => {
    // A diagonal strip through (50, 0): a move along y = 0 is raised over the stretch whose
    // centre is within half a width plus the cutter of the strip, measured square to it.
    const out = raised(clampToBridges([at(0, 0, -6), at(100, 0, -6)], set([{ x1: 30, y1: -20, x2: 70, y2: 20 }], 4), 3, -4))
    expect(out[1].x - out[0].x).toBeCloseTo(10 * Math.SQRT2, 6)
  })
})

describe('planBridges — a network of joins hanging every part on the sheet\'s edge', () => {
  const TOOL = { count: 2, toolRadiusMM: 3.175 / 2, widthMM: 5 }
  const rings = (d: string) => flattenPath(d, 0.25).filter((r) => r.length >= 2) as [number, number][][]
  const insideAny = (ps: { d: string }[], x: number, y: number) => ps.some((p) => rings(p.d).filter((r) => pointInPolygon(x, y, r)).length % 2 === 1)
  // Every part reaches the frame through the joins.
  const hung = (n: number, joins: Join[]) => {
    const up = Array.from({ length: n + 1 }, (_, i) => i)
    const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i])))
    for (const j of joins) up[find(j.a)] = find('part' in j.b ? j.b.part : n)
    return Array.from({ length: n }, (_, i) => find(i) === find(n))
  }
  const joinsOf = (k: number, joins: Join[]) => joins.filter((j) => j.a === k || ('part' in j.b && j.b.part === k))
  // A sheet of uneven rectangles, circles and triangles 3 mm apart, staggered row to row.
  const nest = (() => {
    const out: { id: string; d: string }[] = []
    let y = 4
    for (let r = 0; r < 4; r++) {
      let x = 4 + (r % 2) * 9
      const h = 18 + ((r * 7) % 9)
      for (let c = 0; c < 6; c++) {
        const w = 14 + ((r * 5 + c * 3) % 11)
        const k = (r + c) % 3
        out.push({ id: `p${r}${c}`, d: k === 0 ? circle(x + w / 2, y + h / 2, Math.min(w, h) / 2) : k === 1 ? tri(x, y, w, h) : rect(x, y, w, h) })
        x += w + 3
      }
      y += h + 3
    }
    return out
  })()

  it('hangs every part on the frame, through other parts where it is not beside an edge', () => {
    const joins = planBridges(nest, STOCK, TOOL)
    expect(hung(nest.length, joins).every(Boolean)).toBe(true)
    // Not every part joins the frame itself — the inner ones hang on their neighbours.
    const direct = new Set(joins.filter((j) => 'side' in j.b).map((j) => j.a))
    expect(direct.size).toBeLessThan(nest.length)
  })

  it('gives every part its count of joins — each a tab on it', () => {
    for (const count of [2, 3]) {
      const joins = planBridges(nest, STOCK, { ...TOOL, count })
      nest.forEach((_, k) => expect(joinsOf(k, joins).length).toBeGreaterThanOrEqual(count))
    }
  })

  it('lays every join across one gap: through no outline but the two it joins', () => {
    const crosses = (px: number, py: number, qx: number, qy: number, r: [number, number][]) => r.some((p, i) => {
      if (i === 0) return false
      const [ax, ay] = r[i - 1], [bx, by] = p
      const d1 = (qx - px) * (ay - py) - (qy - py) * (ax - px), d2 = (qx - px) * (by - py) - (qy - py) * (bx - px)
      const d3 = (bx - ax) * (py - ay) - (by - ay) * (px - ax), d4 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax)
      return d1 * d2 < 0 && d3 * d4 < 0
    })
    for (const j of planBridges(nest, STOCK, TOOL)) {
      const { x1, y1, x2, y2 } = j.line
      expect(insideAny(nest, (x1 + x2) / 2, (y1 + y2) / 2)).toBe(false)
      nest.forEach((p, k) => {
        if (k === j.a || ('part' in j.b && j.b.part === k)) return
        expect(rings(p.d).some((r) => crosses(x1, y1, x2, y2, r))).toBe(false)
      })
    }
  })

  // Searching every direction from an edge found the part on the far side of the edge's own
  // part — a "join" straight through it.
  it('never reaches through its own part to the one behind it', () => {
    const pair = [{ id: 'a', d: rect(80, 90, 20, 20) }, { id: 'b', d: rect(103, 90, 20, 20) }]
    const joins = planBridges(pair, { widthMM: 200, heightMM: 200 }, { ...TOOL, count: 3 })
    expect(joins.length).toBeGreaterThan(0)
    for (const j of joins) expect(insideAny(pair, (j.line.x1 + j.line.x2) / 2, (j.line.y1 + j.line.y2) / 2)).toBe(false)
    expect(hung(2, joins).every(Boolean)).toBe(true)
  })

  // Touching outlines have no gap to cross, and the join came out as a point — counted in
  // the network, dropped by the clamp, holding nothing.
  it('gives touching parts a real strip across the point where they touch', () => {
    const pair = [{ id: 'a', d: rect(80, 90, 20, 20) }, { id: 'b', d: rect(100, 90, 20, 20) }]
    const joins = planBridges(pair, { widthMM: 200, heightMM: 200 }, TOOL)
    for (const j of joins) expect(Math.hypot(j.line.x2 - j.line.x1, j.line.y2 - j.line.y1)).toBeGreaterThan(1)
    expect(joins.some((j) => j.gapMM < 1e-6)).toBe(true)
  })

  // The reported sheet: a count of 6 put every join on the side facing the neighbour — the
  // open side was more than a join's search away, and joins were spread by distance alone.
  it('holds a thin part from both sides, not only the one facing its neighbour', () => {
    const thin = [{ id: 't', d: rect(25, 70, 150, 10) }]
    const joins = planBridges(thin, { widthMM: 200, heightMM: 150 }, { ...TOOL, count: 4 })
    const ways = joins.map((j) => Math.sign(Math.round(j.line.y2 - j.line.y1)))
    expect(ways).toContain(1)
    expect(ways).toContain(-1)
  })

  it('holds the outer parts of a stack on their open side too, not only towards the stack', () => {
    const stack = [0, 1, 2].map((k) => ({ id: `s${k}`, d: rect(25, 60 + k * 14, 150, 10) }))
    const joins = planBridges(stack, { widthMM: 200, heightMM: 150 }, { ...TOOL, count: 4 })
    const ways = (k: number) => joins.filter((j) => j.a === k || ('part' in j.b && j.b.part === k))
      .map((j) => Math.sign(Math.round(j.line.y2 - j.line.y1)) * (j.a === k ? 1 : -1))
    expect(ways(0)).toContain(-1) // the bottom one, down to the sheet's edge
    expect(ways(2)).toContain(1) // the top one, up to it
  })

  // The reported sheet: a small part's join out to the frame ran alongside a long part's top
  // edge a few mm off, and lifted that cut all the way — a long tab on a part it was not joining.
  it('never runs a join alongside a part it is not joining, and stops a frame join 20 mm out', () => {
    // The small part's right side stands level with the long part's top edge, so every join
    // off that side would run alongside it; its other three sides have clean ways out.
    const parts = [{ id: 'small', d: rect(20, 102, 20, 5) }, { id: 'long', d: rect(45, 90, 140, 12) }]
    const joins = planBridges(parts, { widthMM: 200, heightMM: 150 }, { ...TOOL, count: 4 })
    const reach = TOOL.widthMM / 2 + 2 * TOOL.toolRadiusMM
    const distTo = (j: Join, d: string) => {
      let best = Infinity
      for (const r of rings(d)) for (let i = 1; i < r.length; i++) {
        for (let t = 0; t <= 20; t++) {
          const x = j.line.x1 + (j.line.x2 - j.line.x1) * t / 20, y = j.line.y1 + (j.line.y2 - j.line.y1) * t / 20
          const [ax, ay] = r[i - 1], [bx, by] = r[i], dx = bx - ax, dy = by - ay
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
          best = Math.min(best, Math.hypot(x - ax - u * dx, y - ay - u * dy))
        }
      }
      return best
    }
    for (const j of joins) {
      const joinsLong = j.a === 1 || ('part' in j.b && j.b.part === 1)
      if (!joinsLong) expect(distTo(j, parts[1].d)).toBeGreaterThanOrEqual(reach - 1e-6)
      if ('side' in j.b) expect(Math.hypot(j.line.x2 - j.line.x1, j.line.y2 - j.line.y1)).toBeLessThanOrEqual(21 + 1e-6)
    }
  })

  it('hangs a group out in open stock on the frame, however far off it is', () => {
    const lone = [{ id: 'a', d: rect(90, 90, 20, 20) }]
    const joins = planBridges(lone, { widthMM: 200, heightMM: 200 }, TOOL)
    expect(hung(1, joins)).toEqual([true])
    expect(Math.min(...joins.map((j) => j.gapMM))).toBeGreaterThan(60)
  })

  // The reported sheet: thin horizontal parts stacked with their middles in line, held at one
  // station each by one line through the middle — free to pivot about it.
  it('holds a long part at two stations along it, well apart', () => {
    const stack = [0, 1, 2].map((k) => ({ id: `s${k}`, d: rect(20 + k * 3, 10 + k * 14, 120, 10) }))
    const joins = planBridges(stack, STOCK, TOOL)
    expect(hung(3, joins).every(Boolean)).toBe(true)
    stack.forEach((_, k) => {
      const xs = joinsOf(k, joins).map((j) => (j.a === k ? j.line.x1 : j.line.x2))
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(60)
    })
  })

  it('anchors a network on more than one side of the frame when it can', () => {
    const joins = planBridges(nest, STOCK, TOOL)
    expect(new Set(joins.flatMap((j) => ('side' in j.b ? [j.b.side] : []))).size).toBeGreaterThanOrEqual(2)
  })
})

describe('the lift emitter', () => {
  it('merges overlapping lifts instead of driving the tool back along the path', () => {
    const pts: Pt2[] = [[0, 0], [100, 0]]
    const segs = polylinePassWithTabs(pts, -6, [{ start: 40, end: 60, tabZ: -4 }, { start: 50, end: 70, tabZ: -3 }], arcLengths(pts).lens)
    const xs = segs.map((s) => s.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(segs.filter((s) => s.z > -6).every((s) => s.z === -3)).toBe(true)
  })
})

describe('normalizeBridges', () => {
  it('reads a stored set back, and nothing from junk', () => {
    expect(normalizeBridges({ lines: [{ x1: 1, y1: 2, x2: 3, y2: 4 }], widthMM: 4, heightMM: 1, pathIds: ['a'] }))
      .toEqual({ lines: [{ x1: 1, y1: 2, x2: 3, y2: 4 }], widthMM: 4, heightMM: 1, pathIds: ['a'] })
    // A whole-sheet line saved before the network reads as that segment.
    expect(normalizeBridges({ lines: [{ axis: 'y', at: 5, from: 9, to: 1 }] })!.lines).toEqual([{ x1: 9, y1: 5, x2: 1, y2: 5 }])
    expect(normalizeBridges({ lines: [{ axis: 'z' }] })).toBeNull()
    expect(normalizeBridges(null)).toBeNull()
  })
})
