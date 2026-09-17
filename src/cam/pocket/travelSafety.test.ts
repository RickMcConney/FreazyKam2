// What isTravelSafe does with a move that runs ALONG the region it is checked against.
//
// The raster builds its scanlines by intersecting the tool-centre limit ring, then hands
// that same ring to isTravelSafe as the containment region — so a stepover at a wall is
// collinear with the ring and every sample of it lands exactly on it. pointInPolygon
// answers such a point by the half-open crossing rule, i.e. by WHICH WALL it is, and a
// plain rectangular pocket therefore lifted to safe Z, rapided one stepover and plunged
// at the end of every second row while stepping over at depth at the other end. The cut
// geometry was right and the machine spent half the job in the air.
import { describe, it, expect } from 'vitest'
import { isTravelSafe, insetRing, type TravelSafetyObstacles } from './shared'
import { buildPocketClearance } from './clearance'
import { generatePocket, type PocketParams } from '../pocket'
import { planRasterPocket } from './raster'
import type { Pt2 } from '../pathFlattener'
import type { Tool } from '../../store/toolStore'

const TOOL: Tool = {
  id: 't1', name: 'em6', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const SAFE_Z = 5

const params = (over: Partial<PocketParams> = {}): PocketParams => ({
  strategy: 'raster', depthMM: 4, stepDownMM: 2, stepoverPercent: 45,
  direction: 'climb', islandDs: [], angle: 0, rampIn: false, safeHeightMM: SAFE_Z,
  ...over,
} as PocketParams)

describe('a travel that runs along the boundary of its own containment region', () => {
  // The ring a raster of this rectangle actually gets: the outline inset by the tool
  // radius, which is where the scanline ends sit.
  const ring = insetRing([[10, 10], [70, 10], [70, 50], [10, 50]] as Pt2[], TOOL.diameterMM / 2)
  const obstacles: TravelSafetyObstacles = {
    edgeObstacles: [ring], solidObstacles: [], containment: [ring],
  }
  const xs = ring.map(p => p[0])
  const left = Math.min(...xs), right = Math.max(...xs)

  it('is safe at the right wall exactly as it is at the left', () => {
    const atLeft = isTravelSafe([left, 20], [left, 22.7], obstacles)
    const atRight = isTravelSafe([right, 20], [right, 22.7], obstacles)
    expect(atLeft).toBe(true)
    expect(atRight).toBe(atLeft)
  })

  it('is safe when the move lands a few ulps outside the ring, as a rotated raster does', () => {
    const eps = 2e-15
    expect(isTravelSafe([left - eps, 20], [left - eps, 22.7], obstacles)).toBe(true)
    expect(isTravelSafe([right + eps, 20], [right + eps, 22.7], obstacles)).toBe(true)
  })

  it('still refuses a move that leaves the region', () => {
    expect(isTravelSafe([right, 20], [right + 8, 22.7], obstacles)).toBe(false)
    expect(isTravelSafe([left, 20], [left - 8, 22.7], obstacles)).toBe(false)
  })
})

describe('a raster pocket of a plain rectangle', () => {
  const rect = 'M 10 10 L 70 10 L 70 50 L 10 50 Z'

  const atSafeHeight = (segs: { z: number }[]) => segs.filter(s => s.z >= SAFE_Z).length

  it('never returns to safe height between two rows', () => {
    const segs = generatePocket(rect, TOOL, params())
    expect(segs.filter(s => !s.rapid).length).toBeGreaterThan(40) // it did cut the pocket
    // depth 4 at 2 mm/pass is two levels, and each spends exactly two segments up high:
    // the approach over its first row, and the retract at the end. Every row-to-row link
    // in between is a cut. This was 28 before — one lift per row at the right-hand wall.
    expect(atSafeHeight(segs)).toBe(4)
  })

  it('holds at every angle and stepover, not just the one that was reported', () => {
    // The bug was found at angle 0, "fixed", and was still there at 45; fixed again, and
    // was still there beside an island. So the claim is swept, not sampled.
    for (const angle of [0, 15, 30, 45, 60, 75, 90, 120, 135]) {
      for (const stepoverPercent of [30, 45, 60]) {
        const segs = generatePocket(rect, TOOL, params({ angle, stepoverPercent }))
        expect(`${angle}deg ${stepoverPercent}%: ${atSafeHeight(segs)}`).toBe(`${angle}deg ${stepoverPercent}%: 4`)
      }
    }
  })

  it('does the same with the passes run at an angle', () => {
    // The angled case needed a second fix and is the sharper test of it. Its rows end on
    // the walls too, but the ends are computed by rotating into the scanline-aligned frame
    // and back, so they land a few ulps OUTSIDE the ring (x = 12.999999999999998 on a wall
    // at 13). A stepover along that wall then has a degenerate bounding box a hair outside
    // the ring's own, the box pre-filter dropped the only containment ring as unreachable,
    // and the scan reported the move unsafe with no live ring left to test. 60 segments up
    // high before the fix.
    expect(atSafeHeight(generatePocket(rect, TOOL, params({ angle: 45 })))).toBe(4)
  })
})

describe('a raster pocket around an island', () => {
  const rect = 'M 20 20 L 140 20 L 140 100 L 20 100 Z'
  const island = 'M 60 45 L 100 45 L 100 75 L 60 75 Z'
  const islandParams = (over: Partial<PocketParams> = {}) =>
    params({ islandDs: [island], ...over })

  // The tool centre runs down the island's flanks at x = 60 - r and x = 100 + r.
  const LEFT_FLANK = 60 - TOOL.diameterMM / 2
  const RIGHT_FLANK = 100 + TOOL.diameterMM / 2

  // Row-to-row stepovers down a flank: a lift with BOTH ends on the same flank. The two
  // per depth level that are NOT that (the raster handing over to the island's finishing
  // contour, and that contour handing back) are a different decision, made against a
  // different obstacle set — islands grown by a full tool DIAMETER, since the finishing
  // pass approaches across stock the raster has not cleared.
  const flankLifts = (segs: { x: number; y: number; z: number }[], x: number) => {
    let n = 0
    for (let i = 1; i < segs.length; i++) {
      if (!(segs[i].z >= SAFE_Z && segs[i - 1].z < SAFE_Z)) continue
      let j = i
      while (j < segs.length && segs[j].z >= SAFE_Z) j++
      if (j < segs.length && Math.abs(segs[i - 1].x - x) < 1e-6 && Math.abs(segs[j].x - x) < 1e-6) n++
    }
    return n
  }

  // The third site of the same bug, and the one the earlier two fixes did not reach:
  // transitionEntersSolidPolygon read a midpoint lying ON the island as solid material,
  // and the half-open rule makes that true down the LEFT flank and false down the right.
  // Every stepover on the left lifted; the identical move on the right did not.
  it('costs the same down the left flank as down the right', () => {
    for (const angle of [0, 30, 60, 90]) {
      const segs = generatePocket(rect, TOOL, islandParams({ angle }))
      const l = flankLifts(segs, LEFT_FLANK), r = flankLifts(segs, RIGHT_FLANK)
      expect(`${angle}deg L${l} R${r}`).toBe(`${angle}deg L${r} R${r}`)
    }
  })

  it('steps from row to row at depth down both flanks', () => {
    for (const angle of [0, 30, 60, 90]) {
      const segs = generatePocket(rect, TOOL, islandParams({ angle }))
      expect(`${angle}deg L${flankLifts(segs, LEFT_FLANK)}`).toBe(`${angle}deg L0`)
      expect(`${angle}deg R${flankLifts(segs, RIGHT_FLANK)}`).toBe(`${angle}deg R0`)
    }
  })

  it('retracts only to hand over to the finishing contours', () => {
    // Two depth levels, two hand-overs each. Before the fix this was 32.
    const segs = generatePocket(rect, TOOL, islandParams({ angle: 0 }))
    expect(segs.filter(s => s.z >= SAFE_Z).length).toBe(8)
  })
})

describe('a row-to-row link across a CURVED wall', () => {
  // The fourth case, and not a boundary-convention bug like the three above. The row ends
  // sit on the limit RING, which is a polygon flattened from the drawn curve to
  // POCKET_FLATTEN_TOL_MM — so a straight link between two of them cuts across the vertices
  // in between by up to that tolerance, and isTravelSafe (1 um) rightly refuses it. On
  // scratch/ovals.fkam that was 40 retracts for a pocket needing a handful. The fix is
  // LINK_MARGIN_MM: stop the FILL short so the link cannot reach the limit, and leave the
  // sliver to the finishing contour. See raster.ts.
  const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 128) =>
    'M ' + Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n
      return `${cx + rx * Math.cos(a)} ${cy + ry * Math.sin(a)}`
    }).join(' L ') + ' Z'

  const atSafeHeight = (segs: { z: number }[]) => segs.filter(s => s.z >= SAFE_Z).length

  // NB this one does NOT pin the margin, and is here to record why: a pocket wall is
  // CONVEX, so the chord between two points on it lies inside the pocket and violates
  // nothing. It is the islands below that generate the excursions. Kept as the standing
  // fact that a plain elliptical pocket wants no row-to-row retract at all.
  it('needs no retract at all around a plain ellipse', () => {
    const segs = generatePocket(ellipse(200, 130, 92.5, 57.5), TOOL, params({
      angle: 140, stepoverPercent: 25, depthMM: 3, stepDownMM: 3,
    }))
    expect(atSafeHeight(segs)).toBe(2)
  })

  it('does not retract once per row around elliptical ISLANDS', () => {
    const segs = generatePocket(ellipse(200, 130, 92.5, 57.5), TOOL, params({
      angle: 140, stepoverPercent: 25, depthMM: 3, stepDownMM: 3,
      islandDs: [ellipse(160, 137, 17.5, 12.5), ellipse(235, 120, 20, 15)],
    }))
    // Islands genuinely need retracts to get past them; the claim is the order of
    // magnitude. Without the margin this is 108, and 41 on the real project file.
    expect(atSafeHeight(segs)).toBeLessThan(14)
  })
})

describe('the raster asks the clearance field, not the offset rings', () => {
  // The predicate is unit-tested in clearance.test.ts; this pins that the raster actually
  // USES it, which is the part a refactor can quietly undo. isTravelSafe short-circuits to
  // the field when the plan supplies one, so the check is that the plan supplies one and
  // that its answer is the exact-distance answer.
  const rect = 'M 20 20 L 140 20 L 140 100 L 20 100 Z'
  const island = 'M 60 45 L 100 45 L 100 75 L 60 75 Z'

  it('hands isTravelSafe a field built from the drawn geometry', () => {
    const plan = planRasterPocket(
      [[20, 20], [140, 20], [140, 100], [20, 100]],
      [[[60, 45], [100, 45], [100, 75], [60, 75]]],
      TOOL,
      params({ islandDs: [island] }),
    )
    expect(plan).not.toBeNull()
    const f = plan!.travelObstacles.field
    expect(f).toBeDefined()
    expect(f!.clearanceMM).toBe(TOOL.diameterMM / 2)
    // Measured off the ISLAND ITSELF, not an offset of it: a move down the left flank at
    // exactly the tool radius is allowed, and a hair closer is not.
    expect(f!.field.isClear([57, 50], [57, 70], f!.clearanceMM)).toBe(true)
    expect(f!.field.isClear([57.5, 50], [57.5, 70], f!.clearanceMM)).toBe(false)
  })

  it('overrides the ring sets when both are present', () => {
    // The seam itself. Ring sets that say NO and a field that says YES: the field wins, and
    // vice versa. Without this the wiring is unpinned — on the shapes above the two agree,
    // so removing the short-circuit changes nothing and every other test still passes.
    const wall: Pt2[] = [[20, 20], [140, 20], [140, 100], [20, 100]]
    const field = buildPocketClearance(wall, [])
    const blocking: Pt2[][] = [[[60, 10], [62, 10], [62, 110], [60, 110]]] // straddles the move

    const ringsSayNo: TravelSafetyObstacles = {
      edgeObstacles: blocking, solidObstacles: blocking, containment: [wall],
    }
    expect(isTravelSafe([40, 60], [90, 60], ringsSayNo)).toBe(false)
    expect(isTravelSafe([40, 60], [90, 60], { ...ringsSayNo, field: { field, clearanceMM: 3 } })).toBe(true)

    const ringsSayYes: TravelSafetyObstacles = { edgeObstacles: [], containment: [wall] }
    expect(isTravelSafe([22, 60], [22, 80], ringsSayYes)).toBe(true)
    // 2 mm from the wall, and the field is asked for 3.
    expect(isTravelSafe([22, 60], [22, 80], { ...ringsSayYes, field: { field, clearanceMM: 3 } })).toBe(false)
  })

  it('and the answer reaches the emitted toolpath', () => {
    // Both flanks free of row-to-row retracts is the field's answer showing through.
    const segs = generatePocket(rect, TOOL, params({ islandDs: [island], angle: 0 }))
    const flank = (x: number) => {
      let n = 0
      for (let i = 1; i < segs.length; i++) {
        if (!(segs[i].z >= SAFE_Z && segs[i - 1].z < SAFE_Z)) continue
        let j = i
        while (j < segs.length && segs[j].z >= SAFE_Z) j++
        if (j < segs.length && Math.abs(segs[i - 1].x - x) < 1e-6 && Math.abs(segs[j].x - x) < 1e-6) n++
      }
      return n
    }
    expect(`L${flank(57)} R${flank(103)}`).toBe('L0 R0')
  })
})

describe('the seam between hybrid\'s contour families and its raster areas', () => {
  // From scratch/ovalsauto.fkam — an ellipse pocket with two elliptical islands, hybrid,
  // 1 mm allowance. A raster does not reach its own boundary: the fill stops LINK_MARGIN_MM
  // short, and the first scanline then lands anywhere in [0, stepover] of THAT, because
  // generateScanlines phases its grid off a bbox edge rather than the outline. Against a
  // wall both are free — the finishing contour cuts at the tool-centre limit and sweeps a
  // full width, taking the whole band. Hybrid's boundary is a SEAM with no finishing pass,
  // so the band survived as a hairline annulus round each island, and rest cleanup traced
  // its outer AND inner edge: 322 mm of wavy ring to remove ~50 mm2 of stock.
  const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 128) =>
    'M ' + Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n
      return `${cx + rx * Math.cos(a)} ${cy + ry * Math.sin(a)}`
    }).join(' L ') + ' Z'

  const hybrid = (stepoverPercent: number) => generatePocket(
    ellipse(377.5, 132.5, 92.5, 57.5), TOOL, params({
      strategy: 'hybrid', stepoverPercent, angle: 140, depthMM: 3, stepDownMM: 3,
      finishAllowanceMM: 1,
      islandDs: [ellipse(337.5, 137.5, 17.5, 12.5), ellipse(415, 120, 20, 15)],
    }))

  it('leaves no hairline annulus for rest cleanup to trace', () => {
    // The annulus showed up as several hundred extra cut moves round the islands, which is
    // the symptom visible on the canvas. 1554 with the seam flush, 1356 overlapping only by
    // LINK_MARGIN_MM, ~1050 overlapping by the stepover too. The project file itself goes
    // 1108 -> 939 -> 708. Bounded rather than pinned exactly, since the count moves with any
    // change to the split.
    expect(hybrid(25).length).toBeLessThan(1200)
  })

  it('holds across stepovers, where the band the raster misses scales with it', () => {
    // The miss is LINK_MARGIN_MM + up to one stepover, so a flush seam gets steadily worse
    // as the stepover grows. Each of these is comfortably under what a flush seam produced.
    for (const so of [15, 25, 45, 70]) {
      expect(`${so}%: ${hybrid(so).length < 1400}`).toBe(`${so}%: true`)
    }
  })
})

// WHERE THIS ENDED UP
//
// The travel question is now asked of the DRAWN geometry — see ./clearance.ts — instead of
// of offset polygons. That is what closes the bug class rather than patching its instances:
// six bugs in a row (a point ON a ring answered by the half-open crossing rule, three times
// over; a bounding box a few ulps off a ring; a chord across a flattened curve; a mitered
// corner claiming ground the tool can cross; an exclusion sized for stock the fill had
// already taken) all lived in the gap between an offset ring and the region it stood for,
// and the exact predicate has no such gap.
//
// Measured over scripts/raster-travel-oracle.mts, 240 cases, ~30k at-depth moves:
//
//   retracts                        7710  ->  370
//   needless (legal AND short)         ?  ->   13
//   gouging at-depth moves             0  ->    0
//   generation time                        unchanged (within noise)
//
// The field did NOT reduce the retract count on its own — by then the patched ring version
// was already at 368. What it changes is that the answer can no longer be wrong: it is one
// inequality over an exactly-computed distance, and its tolerance is argued from Clipper's
// coordinate precision rather than picked. The 13 that remain are not travel-safety at all;
// they come from where the fill happens to END versus where the finishing contour starts,
// which is a sequencing question (see planRingLink's deliberate length cap, which prefers a
// rapid over a long traverse at cutting feed).
//
// The other five strategies still go the old way. TravelSafetyObstacles.field is the seam:
// give a strategy's plan a field and isTravelSafe uses it, with no other change.
