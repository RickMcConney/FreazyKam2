import { describe, it, expect } from 'vitest'
import { generateTrochoidal } from './trochoidal'
import type { TrochoidalParams } from './trochoidal'
import type { Tool } from '../store/toolStore'

const EM6: Tool = {
  id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}

// Centerline by default — the sided cases all name their side explicitly.
const params = (over: Partial<TrochoidalParams> = {}): TrochoidalParams => ({
  side: 'centerline', depthMM: 2, stepDownMM: 2, direction: 'climb',
  trochRadiusMM: 3, trochStepMM: 1, finishingPass: false, safeHeightMM: 5, ...over,
})

const cuts = (segs: ReturnType<typeof generateTrochoidal>) => segs.filter((s) => !s.rapid)

describe('generateTrochoidal — a centerline cut follows an open stroke', () => {
  // Trochoidal SLOTTING along a line is one of the things the strategy is for: full-width
  // engagement, taken as loops so the tool is never buried. So an open path is followed,
  // not closed off — only the sided cuts refuse it, since a stroke has no interior to be
  // inside or outside of.
  const LINE = 'M 10 20 L 110 20'
  const p = params({ trochRadiusMM: 3 })

  it('cuts a slot CENTRED on the line, not off to one side', () => {
    // Against a wall the guide path IS the wall, so the swing runs 0 → 2l into the
    // material. A slot has no wall: the line is its centre, so the swing runs −l → +l.
    // One amplitude of error here is a slot cut entirely off the line that was drawn.
    const ys = cuts(generateTrochoidal(LINE, EM6, p)).map((s) => s.y)
    expect(Math.min(...ys)).toBeCloseTo(20 - 3, 6)
    expect(Math.max(...ys)).toBeCloseTo(20 + 3, 6)
  })

  it('runs the whole length of the stroke, end to end', () => {
    const xs = cuts(generateTrochoidal(LINE, EM6, p)).map((s) => s.x)
    expect(Math.min(...xs)).toBeCloseTo(10, 2)
    expect(Math.max(...xs)).toBeCloseTo(110, 2)
  })

  it('starts at whichever end is nearer the entry hint', () => {
    expect(generateTrochoidal(LINE, EM6, params({ startNear: { x: 10, y: 20 } }))[0].x).toBeCloseTo(10, 6)
    expect(generateTrochoidal(LINE, EM6, params({ startNear: { x: 110, y: 20 } }))[0].x).toBeCloseTo(110, 6)
  })

  it('keeps the ends of the stroke sharp and reaches the far corner', () => {
    // The two ends are where the line was drawn to, not corners to turn through —
    // rounding them would cut short of the part being edged.
    const segs = generateTrochoidal('M 0 0 L 40 0 L 40 40', EM6, p)
    expect(cuts(segs).some((s) => Math.hypot(s.x - 40, s.y - 40) < 3.1)).toBe(true)
    expect(Math.hypot(segs[0].x, segs[0].y)).toBeLessThan(3.1)
  })

  it('lifts over the slot between depth passes instead of cutting back down it', () => {
    // A closed loop ends where it began; a stroke ends at the far end, so the return
    // would otherwise be a full-length cutting move back through its own kerf.
    const segs = generateTrochoidal(LINE, EM6, params({ depthMM: 4, stepDownMM: 2 }))
    expect(segs.some((s) => s.rapid && s.z < 0)).toBe(false)
    expect(segs.filter((s) => s.rapid && s.z === 5)).toHaveLength(4) // entry, lift, return, final
  })

  it('cuts every depth pass', () => {
    const z = [...new Set(cuts(generateTrochoidal(LINE, EM6, params({ depthMM: 4, stepDownMM: 2 }))).map((s) => s.z))]
    expect(z.sort((a, b) => b - a)).toEqual([-2, -4])
  })
})

describe('generateTrochoidal — the finishing pass on an open slot', () => {
  const L = 'M 0 0 L 40 0 L 40 40'
  const p = params({ finishingPass: true, trochRadiusMM: 3 })

  /** Distance from a point to the L-shaped design line. */
  const distToLine = (x: number, y: number) => {
    let best = Infinity
    for (const [ax, ay, bx, by] of [[0, 0, 40, 0], [40, 0, 40, 40]]) {
      const dx = bx - ax, dy = by - ay
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
      best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
    }
    return best
  }

  /** The segments the finishing pass added, i.e. everything past the roughing. */
  const finishOf = (over = {}) => {
    const rough = generateTrochoidal(L, EM6, params({ ...over, finishingPass: false, trochRadiusMM: 3 }))
    return generateTrochoidal(L, EM6, params({ ...over, finishingPass: true, trochRadiusMM: 3 })).slice(rough.length - 1)
  }

  it('rides the two WALLS of the slot, not its centreline', () => {
    // Against a wall the roughing loops swing outward from the exact path, so sweeping
    // that path cuts something. In a CENTRED slot they clear right across the line, so
    // the same sweep would be a pure air pass — the wall at ±l is what is left scalloped.
    for (const s of finishOf().filter((g) => !g.rapid && g.z < 0)) {
      expect(distToLine(s.x, s.y)).toBeCloseTo(3, 6)
    }
  })

  it('rides BOTH sides of the line, not just one', () => {
    // Sampled along each emitted move, so a wall that is one long straight run still
    // counts — testing the endpoints alone misses it.
    const fin = finishOf().filter((g) => !g.rapid && g.z < 0)
    let above = 0, below = 0
    for (let i = 1; i < fin.length; i++) {
      for (let t = 0; t <= 1; t += 0.1) {
        const x = fin[i - 1].x + t * (fin[i].x - fin[i - 1].x)
        const y = fin[i - 1].y + t * (fin[i].y - fin[i - 1].y)
        if (x > 5 && x < 35) { if (y > 1) above++; else if (y < -1) below++ }
      }
    }
    expect(above).toBeGreaterThan(0)
    expect(below).toBeGreaterThan(0)
  })

  it('finishes every leg of the path, not just the first', () => {
    // The vertical leg of the L must get both its walls too.
    const fin = finishOf().filter((g) => !g.rapid && g.z < 0)
    expect(fin.some((s) => Math.abs(s.x - 37) < 1e-6 && s.y > 20)).toBe(true)  // inner wall
    expect(fin.some((s) => Math.abs(s.x - 43) < 1e-6 && s.y > 20)).toBe(true)  // outer wall
  })

  it('never cuts across the work to reach the finishing pass', () => {
    // The roughing loops end at the FAR end of a stroke, not back at their own start the
    // way a closed pass does. arcFitPolyline skips its first point assuming the tool is
    // already standing on it, so the finish used to open with a straight cut from the far
    // end right across the part — 40 mm of it on this path.
    const segs = generateTrochoidal(L, EM6, p)
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i]
      if (b.rapid || a.z !== b.z || b.z > 0) continue
      // Every cutting move either runs along a wall (both ends at l from the line) or is
      // a short link inside the cleared slot.
      const onWall = Math.abs(distToLine(a.x, a.y) - 3) < 1e-6 && Math.abs(distToLine(b.x, b.y) - 3) < 1e-6
      if (!onWall) expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(6)
    }
  })

  it('leaves the closed-path finishing pass alone', () => {
    const CL = 'M 0 0 L 0 40 L 40 40 L 40 0 Z'
    expect(generateTrochoidal(CL, EM6, params({ side: 'inside', finishingPass: true })).length)
      .toBeGreaterThan(generateTrochoidal(CL, EM6, params({ side: 'inside', finishingPass: false })).length)
  })
})

describe('generateTrochoidal — a SIDED cut still needs a closed shape', () => {
  const OPEN_U = 'M 0 0 L 0 40 L 40 40 L 40 0'
  const CLOSED = 'M 0 0 L 0 40 L 40 40 L 40 0 Z'

  it('refuses an open path inside or outside, and says to use centerline', () => {
    for (const side of ['inside', 'outside'] as const) {
      expect(() => generateTrochoidal(OPEN_U, EM6, params({ side })))
        .toThrow(`Path is open — an ${side} trochoidal cut needs a closed shape. Close the path, or set the cut to centerline — a trochoidal slot follows an open line.`)
    }
  })

  it('refuses a compound path with one open subpath among closed ones', () => {
    expect(() => generateTrochoidal(`${CLOSED} M 60 0 L 100 0 L 100 40`, EM6, params({ side: 'inside' })))
      .toThrow(/Path has 1 of 2 subpaths open/)
  })

  it('cuts the closed subpaths and the open one together on centerline', () => {
    // A mixed path is not an error here — the loops go round the square and along the
    // stroke, which is exactly what was selected.
    const xs = cuts(generateTrochoidal(`${CLOSED} M 60 20 L 100 20`, EM6, params())).map((s) => s.x)
    expect(Math.min(...xs)).toBeLessThan(1)
    expect(Math.max(...xs)).toBeGreaterThan(99)
  })

  it('still cuts a closed path on every side', () => {
    for (const side of ['inside', 'outside', 'centerline'] as const) {
      expect(generateTrochoidal(CLOSED, EM6, params({ side })).length).toBeGreaterThan(0)
    }
  })

  it('rejects a path with nothing drawn at all', () => {
    expect(() => generateTrochoidal('', EM6, params())).toThrow('No geometry found in path')
  })
})
