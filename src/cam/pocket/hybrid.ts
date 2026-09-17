import { signedArea, ensureWinding, type Pt2 } from '../pathFlattener'
import { pointInPolygon, stripClosingDuplicate } from '../geom'
import { differenceD, inflatePathsD, intersectD, unionD, EndType, JoinType, FillRule } from 'clipper2-ts'
import type { MotionSegment } from '../../store/toolpathStore'
import { type PocketPlan, type PocketPlanner, _timed, emitLinkedContourRings, growIslands, offsetRing } from './shared'
import { LINK_MARGIN_MM, planRasterPocket } from './raster'
import { planContourOutermost } from './contour'

// ─── Hybrid: raster the open areas, contour the rest ─────────────────────────────
//
// Pure orchestration. It carves the pocket into sub-areas and runs the EXISTING strategies
// on them — raster over the large contiguous island-free areas, contour over what is left
// (the surroundings of every island, and anything too small or awkward to raster). It is
// the automation of something a user can already do by hand: draw the sub-areas, pocket
// the open ones with raster, pocket the rest with contour.
//
// Doing it this way rather than inside one engine means both halves keep every behaviour
// they already have and were measured on — raster's scanline ordering and lift penalties,
// contour's nesting-driven ring order and linking.
//
// The rest used to go to the adaptive march, for its engagement control at the medial-axis
// junctions where island offset families merge. It was removed: unreliable, and its cost
// was pathological rather than merely high — see openForRest below for the mechanism, and
// note it could take 152 s over a region contour clears in seconds. `planContourOutermost`
// is the right shape for these regions anyway: their OUTSIDE is already cleared by the
// raster, so opening at the outermost ring and working inward gives every pass — including
// the first — cleared material on one side and exactly one stepover of engagement. The
// adaptive strategies remain available as strategies in their own right.
//
// The sub-areas only ROUGH. The finishing pass is the one for the whole pocket, following
// the ORIGINAL boundary and islands — letting each sub-area finish its own outline instead
// walks the tool around the segmentation rather than around the real shape, and leaves
// stock along the true wall wherever a sub-area's outline had been pulled in from it.

// How many contour rings each island gets. Just enough to do the two jobs the contour is
// actually for: the innermost ring IS the island's finishing pass, and the ring or two
// outside it clears the immediate surround, where a raster would clip its scanlines against
// the island and wrap the tool round the end at uncontrolled engagement.
//
// Deliberately small. Beyond that the contour is only competing with the raster over open
// ground, and losing: measured across three island fixtures, going from 3 rings to 8 left
// the cut length up to 16% LONGER and the segment count up to 70% higher, for no gain. The
// worry that too few rings would leave a complex island fragmenting the raster's scanlines
// did not materialise — a couple of round-join offsets already smooth an island's notches
// enough for the raster to clip it cleanly.
const ISLAND_CONTOUR_RINGS = 3
// Minimum rings for a contour family to be worth it; below this the march takes the area.
const MIN_CONTOUR_RINGS = 2
// Below this an area is not worth rastering — too few passes to be better than marching it.
const MIN_RASTER_AREA = (so: number, r: number) => 6 * so * 8 * r

const toCP = (pts: Pt2[]) => pts.map(([x, y]) => ({ x, y }))
const fromCP = (r: { x: number; y: number }[]) => stripClosingDuplicate(r.map(({ x, y }) => [x, y] as Pt2))

/** Split a Clipper result into outer rings each with the holes that fall inside it. */
function groupOutersAndHoles(paths: Pt2[][]): { outer: Pt2[]; holes: Pt2[][] }[] {
  const outers: { outer: Pt2[]; holes: Pt2[][] }[] = []
  const holes: Pt2[][] = []
  for (const p of paths) {
    if (p.length < 3) continue
    if (signedArea(p) >= 0) outers.push({ outer: p, holes: [] })
    else holes.push(p)
  }
  for (const h of holes) {
    // Smallest containing outer owns the hole (nested areas).
    let best = -1
    let bestArea = Infinity
    for (let i = 0; i < outers.length; i++) {
      const a = Math.abs(signedArea(outers[i].outer))
      if (a < bestArea && pointInPolygon(h[0][0], h[0][1], outers[i].outer)) { best = i; bestArea = a }
    }
    if (best >= 0) outers[best].holes.push(h)
  }
  return outers
}

/**
 * Pass angle that makes the raster's passes as long as possible over `ring`.
 *
 * generateScanlines lays passes PARALLEL to the angle and steps across them, so the number
 * of passes — and with it the number of direction reversals, the slowest and most heavily
 * loaded part of a raster — is set by the extent PERPENDICULAR to that angle. Minimising
 * that extent therefore maximises mean pass length.
 *
 * Swept over candidate angles rather than taken from the bounding box or a principal-axis
 * fit: a bounding box misses the long axis of anything diagonal, and a vertex-based fit is
 * pulled around by sampling density, which varies a lot across Clipper offset output.
 */
function bestRasterAngle(ring: Pt2[]): number {
  let best = 0
  let bestExtent = Infinity
  for (let deg = 0; deg < 180; deg += 5) {
    const a = (-deg * Math.PI) / 180
    const cos = Math.cos(a), sin = Math.sin(a)
    let lo = Infinity, hi = -Infinity
    for (const [x, y] of ring) {
      const yr = x * sin + y * cos
      if (yr < lo) lo = yr
      if (yr > hi) hi = yr
    }
    const extent = hi - lo
    if (extent < bestExtent) { bestExtent = extent; best = deg }
  }
  return best
}

export const planHybridPocket: PocketPlanner = (boundary, islands, tool, params, onProgress): PocketPlan | null => {
  const toolRadius = tool.diameterMM / 2
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const wantCCW = params.direction === 'climb'

  // No islands: there is nothing to carve around, so this IS a raster pocket. Returning the
  // raster plan unchanged keeps a rectangle or a circle exactly as fast and exactly as
  // simple as choosing raster directly.
  // Auto unless explicitly pinned.
  const angleFor = (ring: Pt2[]) => (params.autoAngle === false ? (params.angle ?? 0) : bestRasterAngle(ring))

  if (islands.length === 0) {
    return planRasterPocket(boundary, islands, tool, { ...params, angle: angleFor(boundary) }, onProgress)
  }

  const plan = _timed('hybrid-split', () => {
    // How far each island's offset family can grow before it MERGES — with another
    // island's family, or with the wall. That distance, not a fixed margin, is what sets
    // the keep-out: an island with room around it gets a big contour family and hands the
    // raster a correspondingly smaller area, while crowded islands stop early and leave
    // the merge zone to the march, which is the one thing that handles a medial-axis
    // junction properly.
    const toolZone = offsetRing(boundary, -toolRadius)
    const toolZoneCP = [toCP(toolZone)]
    const insideZone = (ring: Pt2[]) =>
      toolZone.length >= 3 && differenceD([toCP(ring)], toolZoneCP, FillRule.NonZero, 3).length === 0
    // Each island grown by a radius, memoised. It is a function of the island alone, but the
    // test below asks it for every ring of every OTHER island's family — 3·N·(N−1) Clipper
    // offsets for N distinct answers, which is the whole cost of the split on an
    // island-heavy pocket. Computed on demand, so an early overlap still costs nothing for
    // the islands never reached.
    const grownCache: (Pt2[][] | undefined)[] = new Array(islands.length)
    const grownIsland = (j: number) =>
      (grownCache[j] ??= growIslands([islands[j]], toolRadius, JoinType.Round))
    const overlapsOther = (ring: Pt2[], self: number) => {
      const ringCP = [toCP(ring)]
      return islands.some((_other, j) =>
        j !== self && grownIsland(j).some(g => intersectD(ringCP, [toCP(g)], FillRule.NonZero, 3).length > 0))
    }

    // Contour families, outermost ring first — the order they must be cut in, since only
    // their outer side is cleared (see ContourOrder).
    const contourFamilies: Pt2[][][] = []
    const grownIslands: Pt2[][] = []
    // What each contour family actually SWEEPS: its outermost ring plus a tool radius
    // beyond it, down to the island wall. Subtracted from the march's share below, or the
    // march is handed the very annulus the contour just cleared and cuts it all again.
    const contourCovered: Pt2[][] = []
    // Islands whose wall the contour family already finishes — its innermost ring is at
    // island + R, which IS the island's finishing contour.
    const contoured: boolean[] = islands.map(() => false)
    for (let i = 0; i < islands.length; i++) {
      const rings: Pt2[][] = []
      for (let k = 0; k < ISLAND_CONTOUR_RINGS; k++) {
        const r = offsetRing(islands[i], toolRadius + k * stepoverMM)
        if (r.length < 3 || !insideZone(r) || overlapsOther(r, i)) break
        rings.push(ensureWinding(r, !wantCCW))   // island wall: opposite winding keeps climb
      }
      if (rings.length >= MIN_CONTOUR_RINGS) {
        contourFamilies.push([...rings].reverse())   // outermost first
        grownIslands.push(rings[rings.length - 1])
        const swept = offsetRing(islands[i], 2 * toolRadius + (rings.length - 1) * stepoverMM)
        if (swept.length >= 3) contourCovered.push(swept)
        contoured[i] = true
      } else {
        // No room to contour — fall back to the fixed keep-out so the march gets the area.
        const g = offsetRing(islands[i], toolRadius + stepoverMM)
        grownIslands.push(g.length >= 3 ? g : islands[i])
      }
    }

    // The raster stops where the contour families' SWATH ends — one tool radius beyond
    // their outermost ring, not one stepover. Above 50% the stepover exceeds the radius, and
    // the difference was left as a hairline annulus for the march to walk: a long thin ring
    // is the most expensive thing it can be handed, and it was what still cost 11k segments
    // at 55-60% after the split itself was fixed.
    //
    // OVERLAPPED, because a raster does not reach its own boundary and this boundary is a
    // SEAM with no finishing pass to cover what it misses. Two terms, and the second is the
    // bigger one:
    //
    //   LINK_MARGIN_MM   the fill deliberately stops that far short (see raster.ts)
    //   stepoverMM       the first scanline lands somewhere in [0, stepover] of the fill
    //                    boundary — generateScanlines phases the grid from a bbox edge, not
    //                    from the outline — so the tool's swath stops that much short too
    //
    // Against a real wall both are free: the finishing contour cuts at the tool-centre limit
    // and sweeps a full width, so it takes the whole band. Here nothing does, and what
    // survives is a hairline annulus round the island — which rest cleanup then traces both
    // edges of, hundreds of mm of wavy path for tens of mm2 of stock. That is the failure
    // the comment above already records, and it is why the topology argument ("adding
    // contours round an island cannot leave stock a plain raster would have cleared") only
    // holds if the seam is overlapped by everything the raster fails to reach.
    //
    // Overlapping costs air: the raster passes over ground the contour family already cut.
    // Going NEGATIVE is fine and happens above ~45% stepover — it just means the raster
    // area reaches inside the outermost contour ring. It cannot reach the island itself: a
    // family has at least MIN_CONTOUR_RINGS rings, so its outermost is at least
    // toolRadius + stepover out, and this pulls back by at most stepover + LINK_MARGIN_MM.
    const keepout = growIslands(grownIslands, toolRadius - LINK_MARGIN_MM - stepoverMM, JoinType.Round)
    if (keepout.length === 0) return null

    // The open areas: the pocket with those keep-outs removed.
    const pocketCP = [toCP(ensureWinding(boundary, true)), ...islands.map(i => toCP(ensureWinding(i, false)))]
    const rawOpen = differenceD(pocketCP, keepout.map(toCP), FillRule.NonZero, 3)
    // Morphological open: erode then dilate by a tool diameter, which deletes anything
    // narrower than two diameters. Those slivers — typically where an island keep-out comes
    // close to a wall — are too thin for a raster sub-area to fill (its own fill insets by a
    // diameter and its wall pass by a radius), so they would be left uncut. Dropping them
    // here hands them to the adaptive remainder, which can work in a narrow space.
    const eroded = inflatePathsD(rawOpen, -tool.diameterMM, JoinType.Round, EndType.Polygon, 4, 6)
    const openPaths = (eroded.length === 0 ? [] : inflatePathsD(eroded, tool.diameterMM, JoinType.Round, EndType.Polygon, 4, 6))
      .map(fromCP)
    const open = groupOutersAndHoles(openPaths)

    const minArea = MIN_RASTER_AREA(stepoverMM, toolRadius)
    // Areas too small to raster are simply left to the march. Finding none is NOT a reason
    // to abandon the split: the contour families are still good, and throwing them away to
    // march the whole pocket is the worst of every option — it was 30 s on a star-in-star
    // at 60% against 0.7 s for the split.
    const rasterAreas = open.filter(a => Math.abs(signedArea(a.outer)) >= minArea)

    // What the raster does not take goes to the march: the island surroundings, plus any
    // open area too small to be worth rastering.
    const keptCP = rasterAreas.flatMap(a => [toCP(ensureWinding(a.outer, true)), ...a.holes.map(h => toCP(ensureWinding(h, false)))])
    // Everything already accounted for: the raster areas AND the swaths of the contour
    // families. Only what neither reached is left for the march.
    const coveredUnion = unionD([...keptCP, ...contourCovered.map(c => toCP(ensureWinding(c, true)))],
      [], FillRule.NonZero, 3)
    const restPaths = differenceD(pocketCP, coveredUnion, FillRule.NonZero, 3).map(fromCP)
    const rest = groupOutersAndHoles(restPaths).filter(r => Math.abs(signedArea(r.outer)) > toolRadius * toolRadius)

    // Grow every sub-area OUTWARD by a tool diameter and clip it back to the real pocket.
    //
    // Two things fall out of this. Between sub-areas their fills now overlap instead of
    // meeting exactly, so a seam cannot leave a strip of stock that neither side reached —
    // a strategy always stops short of the outline it was given (raster by a diameter, the
    // march by a radius), which is fine against a real wall the finishing pass will take,
    // but leaves a gap against an ARTIFICIAL edge that nothing else owns.
    //
    // And along the real wall the clip caps the growth at the true boundary, so each
    // sub-area stops exactly where an ordinary pocket of the whole shape would, leaving the
    // wall to the one finishing pass that follows the ORIGINAL outline (below). Holes are
    // carried through unchanged so island clearance is not eaten into.
    const grow = (area: { outer: Pt2[]; holes: Pt2[][] }) => {
      const grown = inflatePathsD([toCP(ensureWinding(area.outer, true))], tool.diameterMM,
        JoinType.Round, EndType.Polygon, 4, 6)
      if (grown.length === 0) return [area]
      const holesCP = area.holes.map(h => toCP(ensureWinding(h, true)))
      const withHoles = holesCP.length > 0
        ? differenceD(grown, holesCP, FillRule.NonZero, 3)
        : grown
      return groupOutersAndHoles(intersectD(withHoles, pocketCP, FillRule.NonZero, 3).map(fromCP))
    }

    // Drop what the tool cannot physically enter, before handing a region on.
    //
    // A passage narrower than the tool DIAMETER has no legal tool-centre position anywhere
    // along it, so no strategy can remove that material — it is uncuttable, not merely
    // awkward. Feeding one to a strategy is at best wasted work and at worst pathological:
    // the adaptive march that used to take these regions would work a frontier it could
    // never advance, showing up as MORE time for FEWER segments (on the dog's 22-island
    // pocket a 1 mm finish allowance grew every island, pinched the gaps between them, took
    // the unreachable share of the region from 0.9% to 5.5% and the march from 6.9 s to
    // 152 s). Contour is far better behaved — an offset that collapses simply yields no
    // ring — but the open still keeps it off geometry it cannot use.
    //
    // Erode by the radius and dilate back: a morphological open, which deletes features
    // thinner than 2R — exactly the uncuttable ones — and leaves everything else in place,
    // including the tool-diameter overlap `grow` just added between neighbouring sub-areas.
    // The same reasoning already governs the raster areas above, at the diameter (a raster
    // needs room to fill; this only needs room to fit).
    //
    // Erring the wrong way is cheap here: a round join can clip a corner that a real cutter
    // would just reach, and restCleanupRings — which measures what was actually machined,
    // not what a strategy meant to machine — picks up anything genuinely left behind.
    // µm precision and a 0.05 mm arc tolerance, as restCleanupRings uses and for the same
    // reason: the region runs to thousands of vertices and offsetting it twice at full arc
    // refinement costs more than the open saves. The error is on the safe side — a coarser
    // round join removes slightly LESS, so the worst case is the un-opened region.
    const openForRest = (area: { outer: Pt2[]; holes: Pt2[][] }) => {
      const cp = [toCP(ensureWinding(area.outer, true)), ...area.holes.map(h => toCP(ensureWinding(h, false)))]
      const eroded = inflatePathsD(cp, -toolRadius, JoinType.Round, EndType.Polygon, 2, 3, 0.05)
      if (eroded.length === 0) return []
      return groupOutersAndHoles(
        inflatePathsD(eroded, toolRadius, JoinType.Round, EndType.Polygon, 2, 3, 0.05).map(fromCP))
    }

    // Each sub-area is roughed by the strategy that suits it. None of them emits a wall
    // pass — see the note at the top of this file.
    const subPlans: PocketPlan[] = []
    for (const a of rasterAreas) {
      for (const g of grow(a)) {
        // Each area gets its own angle — a pocket can easily have open areas whose long
        // axes point in quite different directions.
        const p = planRasterPocket(ensureWinding(g.outer, true), g.holes.map(h => ensureWinding(h, true)),
          tool, { ...params, angle: angleFor(g.outer) })
        if (p) subPlans.push(p)
      }
    }
    // Contour each island's family, outermost ring inward, against the cleared raster.
    for (const rings of contourFamilies) {
      subPlans.push({
        finishRings: [],
        travelObstacles: { edgeObstacles: [] },
        emitCuts: (z, prevZ, pos, segs) =>
          emitLinkedContourRings(rings, z, { edgeObstacles: [] }, segs, params.startNear,
            params.rampIn ? 2 * tool.diameterMM : undefined, prevZ, params.safeHeightMM ?? 5,
            tool.diameterMM, pos, true),
      })
    }
    for (const r of rest) {
      for (const g of grow(r)) {
        for (const m of openForRest(g)) {
          const p = planContourOutermost(ensureWinding(m.outer, true), m.holes.map(h => ensureWinding(h, true)), tool, params)
          if (p) subPlans.push(p)
        }
      }
    }
    return subPlans.length > 0 ? { subPlans, contoured } : null
  })

  if (!plan) {
    // Nothing worth splitting — contour the whole pocket.
    return planContourOutermost(boundary, islands, tool, params, onProgress)
  }

  const islandObstacles = growIslands(islands, toolRadius)

  // The pocket's finishing contours, MINUS the island walls a contour family already
  // finished. Those families end on a full lap at island + R taking one stepover — that is
  // the finish pass, so running the shared one over them again is a wasted lap per island
  // per depth. Built here rather than via compoundFinishRings so the outer-wall loops and
  // the island loops can be told apart before their winding is normalised.
  const realFinish = ((): Pt2[][] => {
    const res = inflatePathsD(
      [toCP(ensureWinding(boundary, true)), ...islands.map(i => toCP(ensureWinding(i, false)))],
      -toolRadius, JoinType.Miter, EndType.Polygon, 4, 6,
    )
    const keep: Pt2[][] = []
    for (const r of res) {
      const pts = fromCP(r)
      if (pts.length < 3) continue
      if (signedArea(pts) >= 0) { keep.push(ensureWinding(pts, wantCCW)); continue }
      // An island loop: skip it when that island's own contour family ends on it. A loop
      // that pinched together with a neighbour is not dropped — it is no longer a single
      // island's wall.
      const owner = islands.findIndex((isl, i) => plan.contoured[i] && pointInPolygon(isl[0][0], isl[0][1], pts))
      const shared = islands.filter(isl => pointInPolygon(isl[0][0], isl[0][1], pts)).length
      if (owner >= 0 && shared === 1) continue
      keep.push(ensureWinding(pts, !wantCCW))
    }
    return keep
  })()
  const travelObstacles = {
    edgeObstacles: [...realFinish, ...islandObstacles],
    solidObstacles: islandObstacles,
    containment: realFinish,
  }

  return {
    // The real pocket's wall pass, around the original shape — not the sub-areas'.
    finishRings: realFinish,
    travelObstacles,
    emitCuts: (z: number, prevZ: number, incomingPos: Pt2 | null, segs: MotionSegment[]) => {
      let pos = incomingPos
      for (const sub of plan.subPlans) pos = sub.emitCuts(z, prevZ, pos, segs) ?? pos
      return pos
    },
  }
}
