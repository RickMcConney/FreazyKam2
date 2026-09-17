// Does the male plug drop into the female socket?
//
// Both halves go strategy → G-code → sim parser → heightfield carve, and the two height
// maps are checked against each other. See src/sim/inlayFit.ts for the assembly maths;
// the short version is that the fit reduces to F + M + plugDepth ≤ 0 everywhere, and the
// two scores are INTERFERENCE (wood in the way, the plug will not seat) and SURFACE GAP
// (it seats, but the finished face has a hole in it).
//
// These are the tests that catch "the inlay only works for simple shapes": the failures
// below all lived in geometry that reads fine on the canvas and cuts fine on its own — an
// island in a socket, one design nested inside another — and only showed up as a plug that
// would not go in.
import { describe, it, expect, beforeEach } from 'vitest'
import { auditInlayFit, inlayFitSummary, type InlayFitGroup } from '../sim/inlayFit'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { Tool } from '../store/toolStore'

const ENDMILL: Tool = {
  id: 'em', name: '1/8 EM', type: 'endmill', diameterMM: 3.175, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const VBIT: Tool = {
  id: 'vb', name: '60 V-bit', type: 'vbit', diameterMM: 6.35, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20, vbitAngleDeg: 60,
}

const PARAMS = {
  angleDeg: 60, pocketDepthMM: 5, stepDownMM: 3, stepoverPercent: 40,
  glueLineMM: 0.2, clearanceMM: 0.1, rampIn: false, safeHeightMM: 3,
}

const rect = (x: number, y: number, w: number, h: number) =>
  `M${x},${y} L${x + w},${y} L${x + w},${y + h} L${x},${y + h} Z`
const circle = (cx: number, cy: number, r: number, n = 96) =>
  'M' + Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return `${(cx + r * Math.cos(a)).toFixed(3)},${(cy + r * Math.sin(a)).toFixed(3)}`
  }).join(' L') + ' Z'

beforeEach(() => {
  useWorkpieceStore.setState({
    widthMM: 260, heightMM: 200, thicknessMM: 12,
    origin: 'bottom-left', zOrigin: 'top', spindleType: 'vfd',
    autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

// Sharp corners quantize onto the audit grid a cell either way, and a Miter offset on the
// socket side meets a Round one on the plug side at every corner point, so a fraction of a
// mm² survives at each. The failures these tests exist to catch run to hundreds of mm² —
// a whole island's worth of stock, or a whole nested plug that was never cut.
const SLACK_MM2 = 4

async function fit(groups: InlayFitGroup[], wallTool: Tool | null = VBIT) {
  return auditInlayFit({
    groups, roughTool: ENDMILL, wallTool, params: PARAMS, cellMM: 0.15,
  })
}

function expectFits(r: Awaited<ReturnType<typeof fit>>) {
  expect(r.socketCells, inlayFitSummary(r)).toBeGreaterThan(1000)
  expect(r.warnings, inlayFitSummary(r)).toEqual([])
  expect(r.interference.areaMM2, inlayFitSummary(r)).toBeLessThanOrEqual(SLACK_MM2)
  expect(r.surfaceGaps.areaMM2, inlayFitSummary(r)).toBeLessThanOrEqual(SLACK_MM2)
  // The floor sits a glue line off the plug; nothing anywhere may be jammed.
  expect(r.gapMinMM, inlayFitSummary(r)).toBeGreaterThan(-0.75)
}

describe('inlay male plug fits the female socket', () => {
  it('plain square', async () => {
    expectFits(await fit([{ boundaryD: rect(40, 40, 50, 50) }]))
  })

  it('plain circle', async () => {
    expectFits(await fit([{ boundaryD: circle(65, 65, 25) }]))
  })

  it('flat walls (no finish tool)', async () => {
    expectFits(await fit([{ boundaryD: rect(40, 40, 50, 50) }], null))
  })

  // Regression: the male's holes were V-carved from the male board's FACE, but the plug
  // mates along a plane one plug-depth below it. Every hole came out halfWidth too small
  // at every depth, so the plug jammed on the socket's protrusion — 417 mm² of
  // interference, 4.65 mm deep, on nothing more exotic than a square with a hole in it.
  it('square with a round island', async () => {
    expectFits(await fit([{ boundaryD: rect(40, 40, 60, 60), islandDs: [circle(70, 70, 12)] }]))
  })

  // Regression: nesting. Three levels alternate solid/void by the even-odd rule, so the
  // male's hole for the middle ring has the innermost square standing in it as the next
  // plug. Clearing that hole flat machined the inner plug away, leaving the finished inlay
  // with a hole where its centre should be (3413 mm² of surface gap on inlaytest.fkam).
  it('three nested squares', async () => {
    const outer = rect(30, 30, 90, 90)
    const middle = rect(45, 45, 60, 60)
    const inner = rect(60, 60, 30, 30)
    expectFits(await fit([
      { boundaryD: outer, islandDs: [middle], islandPlugDs: [[inner]] },
      { boundaryD: inner },
    ]))
  })

  // Regression: the socket pocket ran the 'hybrid' ("auto") strategy, whose sub-area seams
  // left full-height wedges of stock a few tool-widths out from each island. Nothing about
  // them looks wrong and the pocket audit scores the region as fully covered — but they sit
  // exactly where the plug's underside lands, so the joint stood 2 mm open. A plain ROUND
  // island, with no awkward geometry at all, was the worst case of the lot at 8.6 mm²;
  // raster has no seams and takes it to zero. See the strategy note in insideClear.
  it('leaves no stock under the plug around a plain round island', async () => {
    const r = await fit([{ boundaryD: rect(40, 40, 70, 70), islandDs: [circle(75, 75, 15)] }])
    expect(r.interference.areaMM2, inlayFitSummary(r)).toBeLessThanOrEqual(0.5)
  })

  // Regression: the wall passes were unclipped. The socket's wall band is 3 × halfWidth
  // (8.7 mm here) and a protrusion's is 2 × halfWidth, so on any design whose features sit
  // closer together than that they carved through each other and out past the socket edge.
  it('island close enough to the wall for the wall bands to collide', async () => {
    expectFits(await fit([
      { boundaryD: rect(40, 40, 60, 60), islandDs: [rect(45, 45, 20, 20)] },
    ]))
  })
})

// An SVG import arrives as ONE compound path — outline first, holes after — which is what
// generatePocket has always classified into outer + islands. The inlay read "more than one
// subpath" as TEXT instead and sent it down the V-carve-only route, so the female's roughing
// operation came out completely empty (bat_wings_outline_HQG8L.svg: 2610 V-bit segments and
// zero pocket). Both spellings of the same design must now machine the same way.
describe('a compound path is classified, not mistaken for text', () => {
  const outerRing = 'M40,40 L100,40 L100,100 L40,100 Z'
  const holeRing = 'M55,55 L85,55 L85,85 L55,85 Z'
  const compound = `${outerRing} ${holeRing}`

  it('the female roughs a compound boundary instead of emitting nothing', async () => {
    const { generateInlayFemale } = await import('./inlay')
    const p = { ...PARAMS, islandDs: [] }
    const asCompound = await generateInlayFemale(compound, ENDMILL, VBIT, p)
    expect(asCompound.endmillSegs.length).toBeGreaterThan(0)

    // …and matches the same design given as a boundary path plus an island path.
    const asPaths = await generateInlayFemale(outerRing, ENDMILL, VBIT,
      { ...PARAMS, islandDs: [holeRing] })
    expect(asCompound.endmillSegs.length).toBe(asPaths.endmillSegs.length)
    expect(asCompound.vbitSegs.length).toBe(asPaths.vbitSegs.length)
  })

  it('and the plug still fits', async () => {
    expectFits(await fit([{ boundaryD: compound }]))
  })

  // The text route is still reachable — it is a real, separately-tuned workflow (V-carve
  // socket + raised-prism plug), just not for every path that happens to have a hole in it.
  it('leaves genuinely multi-shape paths on the text route', async () => {
    const { splitRegions } = await import('./inlay')
    expect(splitRegions(compound).length).toBe(1)
    expect(splitRegions(`${outerRing} M120,40 L180,40 L180,100 L120,100 Z`).length).toBe(2)
  })
})

// Regression: `segs.push(...generatePocket(...))` passes every segment as a separate
// function argument, and engines cap that (~65–125k in V8). A big socket at a fine stepover
// blows straight past it and throws "Maximum call stack size exceeded" — which the form
// turns into setError, and setError CLEARS the segments. The operation ended up with no
// toolpath at all, the canvas drew nothing and the sim found nothing to run, all with
// perfectly good geometry. It scaled with how much work was asked for (depth, stepover,
// ramp-in, island count), so it looked like "the inlay only works on simple shapes".
describe('a socket bigger than the engine argument limit still generates', () => {
  it('survives a segment count past the spread-argument cap', async () => {
    const { generateInlayFemale } = await import('./inlay')
    // A 230 × 170 socket with twenty islands, 2 mm bit, 0.3 mm steps, 10% stepover: about
    // 176k segments, comfortably past V8's ~125k argument ceiling. Area, depth and stepover
    // are what drive the count, which is why this bit the big detailed jobs and left a
    // plain shallow square alone.
    //
    // The step was 0.4 mm and the assertion 150k until the isTravelSafe boundary fixes (see
    // pocket/travelSafety.test.ts) stopped the raster lifting at the end of every second
    // row: the same socket came out at 132k, still past the cap but with the margin gone,
    // and a test that only just exercises the thing it names stops exercising it on the
    // next change. The step was cut instead of the assertion.
    const tool: Tool = { ...ENDMILL, id: 'em2', diameterMM: 2 }
    const islands: string[] = []
    for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) islands.push(circle(35 + i * 45, 35 + j * 45, 9, 48))
    const r = await generateInlayFemale('M15,15 L245,15 L245,185 L15,185 Z', tool, VBIT, {
      ...PARAMS, angleDeg: 30, pocketDepthMM: 6, stepDownMM: 0.3,
      stepoverPercent: 10, islandDs: islands,
    })
    expect(r.endmillSegs.length).toBeGreaterThan(150_000)
    expect(r.vbitSegs.length).toBeGreaterThan(0)
  })
})

describe('the audit catches a plug that does not fit', () => {
  // A negative control for the audit itself: force the plug oversize by making the
  // clearance strongly negative and the interference must show up. Without this the "0
  // interference" assertions above could equally mean the audit is measuring nothing.
  it('reports interference when the clearance is inverted', async () => {
    const r = await auditInlayFit({
      groups: [{ boundaryD: rect(40, 40, 50, 50) }],
      roughTool: ENDMILL, wallTool: VBIT,
      params: { ...PARAMS, clearanceMM: -1.0, glueLineMM: 0 },
      cellMM: 0.15,
    })
    expect(r.interference.areaMM2, inlayFitSummary(r)).toBeGreaterThan(20)
  })
})
