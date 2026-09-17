import {   type Pt2 } from '../pathFlattener'
import { type PocketPlan, type PocketPlanner, buildOffsetLevels, compoundFinishRings, emitLinkedContourRings, growRing } from './shared'

// Which end of the offset family the cut opens at.
//
// 'innermost' is the ordinary pocket: the region is solid, so the cut has to open where the
// offsets converge — the medial axis — and work outward, each pass then having cleared
// material on one side.
//
// 'outermost' is for a region whose OUTSIDE is already cleared: the surroundings of an
// island once the open area around it has been rastered. There the cut opens against that
// cleared edge and works inward toward the island, so every pass — including the first —
// has cleared material on its outer side and takes exactly one stepover. Opening at the
// medial axis instead would slot full width into the middle of the annulus.
export type ContourOrder = 'innermost' | 'outermost'

export const makeContourPlanner = (order: ContourOrder): PocketPlanner =>
  (boundary, islands, tool, params): PocketPlan | null => {
  const safeZ = params.safeHeightMM ?? 5
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'climb' // inside cut: climb (M3) = CCW travel
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  const levels = buildOffsetLevels(boundary, islands, toolRadius, stepoverMM, wantCCW)
  if (levels.length === 0) return null

  // levels[0] is the same geometry as the shared finishing ring, but buildOffsetLevels
  // winds every loop the same way; compoundFinishRings winds island (hole) loops opposite
  // so climb stays climb on an island wall. Take the finish ring from there.
  const finishRings = compoundFinishRings(boundary, islands, toolRadius, wantCCW)

  // Cut innermost rings first, finishing ring last for a clean wall finish — or, for an
  // already-cleared surround, straight down the family from the outside in.
  const innerRings = order === 'innermost'
    ? levels.slice(1).reverse().flat()
    : levels.slice(1).flat()

  // Obstacles for travel-safety checks: the finishing rings bound the tool zone.
  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const travelObstacles = {
    edgeObstacles: [...finishRings, ...islandObstacles],
    solidObstacles: islandObstacles,
    containment: finishRings,
  }

  return {
    finishRings,
    travelObstacles,
    // startInnermost: innerRings is ordered innermost-level-first, and ring order follows the
    // nesting, not proximity. The cut opens at the innermost ring and walks outward; an outer
    // ring is skipped while it still contains an uncut ring, so when a region runs out at a
    // medial-axis merge the cut drops back to the innermost ring still pending (the next
    // medial-axis junction) and works outward from there. Left to proximity, a startNear hint or
    // the carried-over position from the previous depth level opens an outer contour of a region
    // whose middle is still solid — a full-width slot.
    emitCuts: (z: number, prevZ: number, incomingPos: Pt2 | null, segs) =>
      emitLinkedContourRings(innerRings, z, travelObstacles, segs, params.startNear, rampDist,
        prevZ, safeZ, tool.diameterMM, incomingPos,
        order === 'outermost',            // strict order: the family IS the cutting sequence
        order === 'innermost'),           // nesting-driven order for a solid region
  }
}

export const planContourPocket = makeContourPlanner('innermost')
export const planContourOutermost = makeContourPlanner('outermost')
