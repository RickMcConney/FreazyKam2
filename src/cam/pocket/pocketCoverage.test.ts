// End-to-end pocket coverage: strategy → G-code → sim parser → the sim's own heightfield
// carve, checked against the region a tool of that radius can reach.
//
// These are the tests that catch "the app shows uncut material" — including bugs that live
// in the emitter (dropped plunges, arc fits that swallow a loop), which segment-level checks
// cannot see. See sim/toolpathAudit.ts for the method.
import { describe, it, expect, beforeEach } from 'vitest'
import { auditPocket, auditSummary } from '../../sim/toolpathAudit'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { generatePocket, type PocketParams } from '../pocket'
import type { Tool } from '../../store/toolStore'
import { flattenPath, type Pt2 } from '../pathFlattener'
import { buildOffsetLevels, closedPath, restCleanupRings } from './shared'

const TOOL: Tool = {
  id: 't1', name: 'em6', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}

const toD = (pts: Pt2[]) => `M ${pts.map(p => `${p[0]} ${p[1]}`).join(' L ')} Z`
const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 160): Pt2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt2
  })
const circle = (cx: number, cy: number, r: number, n = 120) => ellipse(cx, cy, r, r, n)
const rect = (x0: number, y0: number, x1: number, y1: number): Pt2[] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

// 50% stepover is the largest that guarantees full coverage for an offset strategy: each
// ring's swath reaches `r` past its path, so a step of `s` leaves `s - r` unreached wherever
// the offset family terminates (a lobe's medial axis). At s = r that gap is exactly zero.
// See the >50% test at the bottom, which pins the leftover instead of denying it.
const params = (over: Partial<PocketParams> = {}): PocketParams => ({
  strategy: 'contour', stepoverPercent: 50, direction: 'climb', rampIn: true,
  safeHeightMM: 5, depthMM: 6, stepDownMM: 3, islandDs: [],
  ...over,
} as PocketParams)

beforeEach(() => {
  useWorkpieceStore.setState({
    widthMM: 260, heightMM: 200, thicknessMM: 12,
    origin: 'bottom-left', zOrigin: 'top', spindleType: 'vfd',
    autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

// The audit grid quantizes walls, so a handful of edge cells can read either way; the
// failures these tests exist to catch (a skipped ring, a helical descent, a 0.5 mm scar)
// run to hundreds or thousands of cells.
const SLACK = 20

function expectClean(a: ReturnType<typeof auditPocket>) {
  expect(a.warnings, auditSummary(a)).toEqual([])
  expect(a.uncut, auditSummary(a)).toBeLessThanOrEqual(SLACK)
  expect(a.shallow, auditSummary(a)).toBeLessThanOrEqual(SLACK)
  expect(a.gouged, auditSummary(a)).toBeLessThanOrEqual(SLACK)
}

describe('contour pocket clears the whole reachable region', () => {
  const cases: [string, Pt2[], Pt2[][]][] = [
    ['plain rectangle', rect(30, 30, 150, 110), []],
    ['ellipse with two round islands',
      ellipse(120, 100, 100, 60),
      [circle(80, 100, 25), circle(160, 108, 22)]],
    ['circle with two close islands',
      circle(120, 100, 70),
      [circle(104, 100, 18), circle(140, 100, 18)]],
    ['rectangle with a square island',
      rect(30, 30, 190, 150), [rect(90, 70, 130, 110)]],
    // Two lobes joined by a neck: the offset levels split, so the cut has to finish one
    // region, lift, and re-enter the next at ITS innermost ring.
    ['dumbbell', [
      [20, 40], [90, 40], [90, 85], [150, 85], [150, 40], [220, 40],
      [220, 150], [150, 150], [150, 105], [90, 105], [90, 150], [20, 150],
    ] as Pt2[], []],
  ]

  for (const [name, boundary, islands] of cases) {
    for (const rampIn of [true, false]) {
      it(`${name} (rampIn=${rampIn})`, () => {
        const a = auditPocket({
          boundaryD: toD(boundary),
          islandDs: islands.map(toD),
          tool: TOOL,
          params: params({ rampIn }),
        })
        expect(a.cellsToClear).toBeGreaterThan(1000)
        expectClean(a)
      })
    }
  }

  it('leaves nothing behind at a 30% stepover and a single depth pass', () => {
    const a = auditPocket({
      boundaryD: toD(ellipse(120, 100, 90, 55)),
      islandDs: [toD(circle(120, 100, 30))],
      tool: TOOL,
      params: params({ stepoverPercent: 30, depthMM: 3, stepDownMM: 3 }),
    })
    expectClean(a)
  })

  it('cuts nothing into the islands or outside the boundary', () => {
    const a = auditPocket({
      boundaryD: toD(circle(120, 100, 70)),
      islandDs: [circle(95, 100, 20), circle(150, 105, 25)].map(toD),
      tool: TOOL,
      params: params(),
    })
    expect(a.gouged, auditSummary(a)).toBeLessThanOrEqual(SLACK)
  })
})

describe('stepover above 50% is cleaned up, not left as slivers', () => {
  // Above 50% a plain offset family cannot reach the last (stepover - radius) of stock where
  // the level sets stop running parallel — a lobe's medial axis, a junction cusp. The
  // clean-up rings in buildOffsetLevels close that; these cases are the ones that were
  // measurably ridged before it (twoislands70.fkam: 278 audit cells in 12 patches).
  for (const stepoverPercent of [60, 70, 90]) {
    it(`${stepoverPercent}% stepover clears the pocket`, () => {
      const a = auditPocket({
        boundaryD: toD(ellipse(120, 100, 100, 60)),
        islandDs: [circle(80, 100, 25), circle(160, 108, 22)].map(toD),
        tool: TOOL,
        params: params({ stepoverPercent }),
      })
      expectClean(a)
    })
  }

  it('the dumbbell medial axis is cleared at 70%', () => {
    const a = auditPocket({
      boundaryD: toD([
        [20, 40], [90, 40], [90, 85], [150, 85], [150, 40], [220, 40],
        [220, 150], [150, 150], [150, 105], [90, 105], [90, 150], [20, 150],
      ] as Pt2[]),
      tool: TOOL,
      params: params({ stepoverPercent: 70 }),
    })
    expectClean(a)
  })

  it('finds nothing to clean up on offset rings at or below 50%', () => {
    // Contour's rings have provable coverage there — the clean-up runs but comes back empty,
    // so those pockets emit exactly the rings they always did.
    const boundary = flattenPath(toD(ellipse(120, 100, 100, 60)), 0.05)[0]
    const islands = [flattenPath(toD(circle(80, 100, 25)), 0.05)[0]]
    const r = TOOL.diameterMM / 2
    for (const pct of [30, 50]) {
      const step = TOOL.diameterMM * (pct / 100)
      const levels = buildOffsetLevels(boundary, islands, r, step, true)
      const paths = levels.flat().map(closedPath)
      expect(restCleanupRings(boundary, islands, r, paths, true), `stepover ${pct}%`).toEqual([])
    }
    // …and above 50% it genuinely finds stock to clear.
    const step70 = TOOL.diameterMM * 0.7
    const levels70 = buildOffsetLevels(boundary, islands, r, step70, true)
    const paths70 = levels70.flat().map(closedPath)
    expect(restCleanupRings(boundary, islands, r, paths70, true).length).toBeGreaterThan(0)
  })
})

// The rest clean-up is shared by every offset/raster/spiral strategy, so every one of them is
// held to the same standard at a stepover where it used to leave stock.
describe('every strategy clears the whole reachable region', () => {
  // 'hybrid' is the UI's Auto, and its stepover slider reaches 90% like raster's and
  // contour's do — so it is held to the same standard at the same setting.
  for (const strategy of ['raster', 'contour', 'morph', 'hybrid'] as const) {
    for (const stepoverPercent of [50, 90]) {
      it(`${strategy} at ${stepoverPercent}% stepover`, () => {
        const a = auditPocket({
          boundaryD: toD(ellipse(120, 100, 90, 55)),
          islandDs: [circle(85, 100, 20), circle(155, 105, 18)].map(toD),
          tool: TOOL,
          params: params({ strategy, stepoverPercent, depthMM: 3, stepDownMM: 3 }),
        })
        expect(a.cellsToClear).toBeGreaterThan(1000)
        expectClean(a)
      })
    }
  }
})

describe('an open boundary is refused, not filled in', () => {
  // `splitSelfIntersecting` treats every subpath as implicitly closed, so a U-shaped
  // path used to come back as a ring joined mouth-to-mouth: the pocket cleared the
  // whole square the U outlines, with no error and a toolpath that looks entirely
  // reasonable on the canvas. Machining a shape the user did not draw is the worst
  // failure in this file, so it is refused at the door.
  const OPEN_U = 'M 0 0 L 0 40 L 40 40 L 40 0'
  const CLOSED = 'M 0 0 L 0 40 L 40 40 L 40 0 Z'

  it('refuses an open boundary and names the cut that does work on one', () => {
    expect(() => generatePocket(OPEN_U, TOOL, params()))
      .toThrow('Path is open — a pocket needs a closed shape. Close the path, or use a centerline profile to cut a groove along it.')
  })

  it('refuses a two-point line with the same message, not "no geometry"', () => {
    expect(() => generatePocket('M 0 0 L 40 0', TOOL, params())).toThrow(/Path is open/)
  })

  it('refuses a compound path with one open subpath among closed ones', () => {
    expect(() => generatePocket(`${CLOSED} M 60 0 L 100 0 L 100 40`, TOOL, params()))
      .toThrow(/Path has 1 of 2 subpaths open/)
  })

  it('refuses an open ISLAND — it would leave stock in a shape nobody asked for', () => {
    expect(() => generatePocket(CLOSED, TOOL, params({ islandDs: ['M 10 10 L 30 10 L 30 30'] })))
      .toThrow(/^Island path is open/)
  })

  it('still accepts a path closed by returning to its start without a Z', () => {
    expect(() => generatePocket('M 0 0 L 0 40 L 40 40 L 40 0 L 0 0', TOOL, params())).not.toThrow()
  })

  it('ignores a stray moveto that draws nothing', () => {
    // A single point is noise in an imported file, not a stroke to fail a job over.
    expect(() => generatePocket(`${CLOSED} M 90 90`, TOOL, params())).not.toThrow()
  })
})

describe('a pocket with a waist the tool cannot cross is cut on both sides of it', () => {
  // Two square lobes joined by a neck. Where the neck is too narrow for the tool — or for
  // the tool plus the finish allowance on both walls — the tool-centre region is two pieces,
  // and every offset that fed a planner kept ONE of them. The other lobe got no fill: with
  // an allowance no strategy cut it at all, and on big lobes raster and auto left ~40% of it
  // standing (rest cleanup's few rings mopped up a small lobe, which hid it there).
  const dumbbell = (S: number, neck: number) => {
    const a = S / 2 - neck / 2, b = S / 2 + neck / 2
    return toD([[0, 0], [S, 0], [S, a], [S + 20, a], [S + 20, 0], [2 * S + 20, 0], [2 * S + 20, S],
      [S + 20, S], [S + 20, b], [S, b], [S, S], [0, S]])
  }
  /** Percent of a lobe's middle (sampled on a grid) that no full-depth move came within the radius of. */
  function uncutPercent(segs: ReturnType<typeof generatePocket>, x0: number, S: number, margin: number): number {
    const cuts: number[][] = []
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i]
      if (!b.rapid && a.z <= -3 + 1e-6 && b.z <= -3 + 1e-6) cuts.push([a.x, a.y, b.x, b.y])
    }
    const R = TOOL.diameterMM / 2
    const step = Math.max(1, S / 30)
    let total = 0, uncut = 0
    for (let x = x0 + margin; x <= x0 + S - margin; x += step) {
      for (let y = margin; y <= S - margin; y += step) {
        total++
        const hit = cuts.some(([ax, ay, bx, by]) => {
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
          return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= R + 0.05
        })
        if (!hit) uncut++
      }
    }
    return Math.round((100 * uncut) / total)
  }
  const run = (S: number, neck: number, strategy: string, allowance = 0) => {
    const segs = generatePocket(dumbbell(S, neck), TOOL, params({
      strategy: strategy as PocketParams['strategy'], forceStrategy: true, depthMM: 3, stepDownMM: 3,
      stepoverPercent: 40, finishAllowanceMM: allowance,
    }))
    const m = TOOL.diameterMM / 2 + allowance + 1
    return `left ${uncutPercent(segs, 0, S, m)}% right ${uncutPercent(segs, S + 20, S, m)}%`
  }

  it('with a finish allowance wider than the neck leaves, every strategy cuts both lobes', () => {
    for (const strategy of ['raster', 'contour', 'hybrid', 'morph', 'adaptive']) {
      expect(`${strategy}: ${run(40, 4, strategy, 2.5)}`).toBe(`${strategy}: left 0% right 0%`)
    }
  })

  it('raster and auto fill both 150 mm lobes through a neck narrower than the tool', () => {
    for (const strategy of ['raster', 'hybrid']) {
      expect(`${strategy}: ${run(150, 4, strategy)}`).toBe(`${strategy}: left 0% right 0%`)
    }
  })

  it('raster fills both lobes through a neck only just wider than the tool', () => {
    // 6.2 mm: one region at the tool radius, two at radius + the 0.2 mm link margin.
    expect(run(150, 6.2, 'raster')).toBe('left 0% right 0%')
  })
})
