import {   type Pt2 } from '../pathFlattener'
import type { MotionSegment } from '../../store/toolpathStore'
import { MICRO_LIFT_MM, type PocketPlan, type PocketPlanner, compoundFinishRings, emitHelixBore, growIslands } from './shared'
import { computeAdaptive2Plan } from '../adaptive2'

// ─── Adaptive2 (fast raster-marching constant engagement) ───────────────────────
//
// Delegates to computeAdaptive2Plan (./adaptive2) — a from-scratch engine that grows the
// toolpath over an occupancy grid instead of clipping polygons, so it stays fast on large
// pockets. The 2D march is identical at every Z level, so it is computed once here and
// replayed by emitCuts at each depth pass.


export const planAdaptive2Pocket: PocketPlanner = (boundary, islands, tool, params, onProgress): PocketPlan | null => {
  const safeZ = params.safeHeightMM ?? 5
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'climb' // inside cut: climb (M3) = CCW travel

  const regions = computeAdaptive2Plan(boundary, islands, {
    toolDiameterMM: tool.diameterMM,
    stepoverMM: tool.diameterMM * (params.stepoverPercent / 100),
    wantCCW: params.direction === 'conventional',
    helixEntry: params.rampIn ?? false,
    onProgress,
  })

  const finishRings = compoundFinishRings(boundary, islands, toolRadius, wantCCW)
  const islandFinish = growIslands(islands, toolRadius)
  const travelObstacles = {
    edgeObstacles: [...finishRings, ...growIslands(islands, tool.diameterMM)],
    solidObstacles: islandFinish,
    containment: finishRings,
  }

  return {
    finishRings,
    travelObstacles,
    emitCuts: (zDepth: number, prevZ: number, incomingPos: Pt2 | null, segs: MotionSegment[]) => {
      let lastPos: Pt2 | null = incomingPos
      for (const reg of regions) {
        const first = reg.moves[0]?.pts[0]
        if (!first) continue
        if (lastPos) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
        if (reg.helixRadiusMM > 0) {
          // The plan starts the march on the bore rim; end the bore exactly there so the
          // helix flows into the spiral with no connector.
          const endAngle = Math.atan2(first[1] - reg.helixCenter[1], first[0] - reg.helixCenter[0])
          emitHelixBore(reg.helixCenter, reg.helixRadiusMM, endAngle, prevZ, zDepth, wantCCW, segs, safeZ)
        } else {
          segs.push({ x: first[0], y: first[1], z: safeZ, rapid: true })
          segs.push({ x: first[0], y: first[1], z: prevZ, rapid: true })
          segs.push({ x: first[0], y: first[1], z: zDepth, rapid: false })
        }
        lastPos = first
        for (const mv of reg.moves) {
          if (mv.kind === 'link') {
            // Stay-down air move: micro-lift, traverse as travel (dashed in the UI, and
            // emitted at travel feed), drop back to depth.
            const liftZ = Math.min(safeZ, zDepth + MICRO_LIFT_MM)
            segs.push({ x: lastPos[0], y: lastPos[1], z: liftZ, rapid: false, travel: true })
            for (const [x, y] of mv.pts) {
              segs.push({ x, y, z: liftZ, rapid: false, travel: true })
              lastPos = [x, y]
            }
            segs.push({ x: lastPos[0], y: lastPos[1], z: zDepth, rapid: false })
          } else {
            for (const [x, y] of mv.pts) {
              if (x === lastPos[0] && y === lastPos[1]) continue
              segs.push({ x, y, z: zDepth, rapid: false, feedScale: mv.feedScale })
              lastPos = [x, y]
            }
          }
        }
      }
      return lastPos
    },
  }
}

