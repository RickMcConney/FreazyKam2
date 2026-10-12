import type { Pt2 } from '../pathFlattener'
import type { MotionSegment } from '../../store/toolpathStore'
import { MICRO_LIFT_MM, type PocketPlan, type PocketPlanner, _timed, emitHelixBore } from './shared'
import { AdaptiveFC, MotionType, type AdaptiveOutput } from '../adaptiveFC/engine'

// ─── Adaptive FC (FreeCAD's Adaptive2d, re-plumbed for speed) ──────────────────
//
// Delegates to ../adaptiveFC/engine — FreeCAD's constant-engagement algorithm with its cleared
// area held in local tiles and its engagement measured analytically. The engine plans the
// whole region including its own finishing profile, so the plan is selfFinishing and
// generatePocket skips the shared rest/finish tail. The 2D plan is the same at every depth,
// so it is computed once and replayed per level.
//
// The engine's steering refuses conventional cutting, so its natural hand is CLIMB for an M3
// spindle (stock on the right of travel; CCW round the inside of a pocket — the same rule as
// every other inside cut here). For conventional the geometry is mirrored in X, cleared in the
// natural hand and mirrored back: reflection reverses the winding and swaps climb for
// conventional, so the flipped path is exactly as clean as the natural one.
//
// Every entry into material is a helix (see helixRampTargetDiameter below). The other way the
// tool comes down is after a relink the engine could not keep at depth (LinkNotClear): that
// lands on the start of a lead-in, which the engine only places where a full tool disk of
// floor is already cut at THIS depth, so the descent there is through air, not stock.

export const planAdaptiveFCPocket: PocketPlanner = (boundary, islands, tool, params, onProgress): PocketPlan | null => {
  const safeZ = params.safeHeightMM ?? 5
  const dia = tool.diameterMM
  const wantCCW = params.direction === 'climb'
  const mx = wantCCW ? 1 : -1

  const toDP = (pts: Pt2[]): Array<[number, number]> => pts.map(([x, y]) => [mx * x, y] as [number, number])
  const geom = [toDP(boundary), ...islands.map(toDP)]

  const engine = new AdaptiveFC({
    toolDiameter: dia,
    stepOverFactor: params.stepoverPercent / 100,
    tolerance: 0.1,
    finishingProfile: true,
    keepToolDownDistRatio: 3.0,
    // ALWAYS a helix, as big as the tool where it fits (the engine shrinks it to dia/8 in a
    // tight spot). An adaptive pocket steps down far deeper than a slotting one — up toward
    // the flute length — and a straight plunge that deep is the hardest load an end mill can
    // take, so the Ramp In checkbox does not apply here.
    helixRampTargetDiameter: dia,
    helixRampMinDiameter: dia / 8,
    onProgress: f => onProgress?.(f),
  })

  // No catch: a failing engine must surface as its own error, not as a plan-less region
  // that generatePocket reports as "too small for the tool".
  const outputs: AdaptiveOutput[] = _timed('adaptiveFC.execute', () => engine.execute([toDP(boundary)], geom))
  if (mx < 0) for (const out of outputs) {
    out.helixCenter = [-out.helixCenter[0], out.helixCenter[1]]
    out.startPoint = [-out.startPoint[0], out.startPoint[1]]
    for (const tp of out.adaptivePaths) for (const p of tp.pts) p[0] = -p[0]
  }

  return {
    finishRings: [],
    travelObstacles: { edgeObstacles: [] },
    selfFinishing: true,
    emitCuts: (z, prevZ, incomingPos, segs) => emitAdaptiveFC(outputs, z, prevZ, incomingPos, segs, safeZ, wantCCW),
  }
}

function emitAdaptiveFC(
  outputs: AdaptiveOutput[], z: number, prevZ: number, incomingPos: Pt2 | null,
  segs: MotionSegment[], safeZ: number, wantCCW: boolean,
): Pt2 | null {
  let lastPos: Pt2 | null = incomingPos
  for (const out of outputs) {
    const firstCut = out.adaptivePaths[0]?.pts[0]
    if (!firstCut) continue
    if (lastPos) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
    // The engine assumes the helix cleared a disk of (helix radius + tool radius) round its
    // centre and starts the march on the helix circle, so the bore ends exactly there.
    const c: Pt2 = [out.helixCenter[0], out.helixCenter[1]]
    const hr = Math.hypot(firstCut[0] - c[0], firstCut[1] - c[1])
    if (hr >= 0.01) {
      emitHelixBore(c, hr, Math.atan2(firstCut[1] - c[1], firstCut[0] - c[0]), prevZ, z, wantCCW, segs, safeZ)
    } else {
      segs.push({ x: firstCut[0], y: firstCut[1], z: safeZ, rapid: true })
      segs.push({ x: firstCut[0], y: firstCut[1], z: prevZ, rapid: true })
      segs.push({ x: firstCut[0], y: firstCut[1], z, rapid: false })
    }
    let cur: Pt2 = [firstCut[0], firstCut[1]]
    for (const tp of out.adaptivePaths) {
      if (tp.pts.length === 0) continue
      if (tp.motion === MotionType.LinkNotClear) {
        // A relink across uncut stock: lift, rapid over, and feed back down into the cleared
        // ground the lead-in starts from (cleared on the level above as well).
        const dest = tp.pts[tp.pts.length - 1]
        segs.push({ x: cur[0], y: cur[1], z: safeZ, rapid: true })
        segs.push({ x: dest[0], y: dest[1], z: safeZ, rapid: true })
        segs.push({ x: dest[0], y: dest[1], z: prevZ, rapid: true })
        segs.push({ x: dest[0], y: dest[1], z, rapid: false })
        cur = [dest[0], dest[1]]
      } else if (tp.motion === MotionType.LinkClear) {
        // Stay-down link over floor the engine verified is cleared: micro-lift and traverse.
        const liftZ = Math.min(safeZ, z + MICRO_LIFT_MM)
        segs.push({ x: cur[0], y: cur[1], z: liftZ, rapid: false, travel: true })
        for (const [x, y] of tp.pts) { segs.push({ x, y, z: liftZ, rapid: false, travel: true }); cur = [x, y] }
        segs.push({ x: cur[0], y: cur[1], z, rapid: false })
      } else {
        for (const [x, y] of tp.pts) {
          if (x === cur[0] && y === cur[1]) continue
          segs.push({ x, y, z, rapid: false })
          cur = [x, y]
        }
      }
    }
    lastPos = cur
  }
  return lastPos
}
