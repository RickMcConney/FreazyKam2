import {   type Pt2 } from '../pathFlattener'
import type { MotionSegment } from '../../store/toolpathStore'
import { type PocketPlan, type PocketPlanner, _timed, emitHelicalRamp } from './shared'
import { Adaptive2d, OperationType, MotionType, type AdaptiveOutput } from '../adaptiveClearing'

// ─── Adaptive (constant-engagement) clearing ─────────────────────────────────────
//
// Delegates to the Adaptive2d engine (a faithful port of FreeCAD's libarea Adaptive.cpp)
// in ./adaptiveClearing. That engine measures cutter engagement analytically and steers the
// tool to hold it constant, so spirals and trochoids emerge automatically. Here we just feed
// it the pocket geometry (boundary + islands) for this depth level and translate its
// motion-type-tagged output paths into MotionSegments — emitting a helix/plunge entry per
// region and lifting only on the engine's "link not clear" relinks.

// This engine emits its own finishing profile and handles its own leftovers, so the plan
// is marked selfFinishing and generatePocket skips the shared rest/finish tail for it.
export const planAdaptivePocket: PocketPlanner = (boundary, islands, tool, params): PocketPlan | null => {
  const safeZ = params.safeHeightMM ?? 5
  const dia = tool.diameterMM
  const wantCCW = params.direction === 'climb' // inside cut: climb (M3) = CCW travel
  const rampIn = params.rampIn ?? false

  // Winding control via geometric reflection. The engine's engagement steering always winds CCW
  // (its tuned, clean path = climb for an inside pocket with an M3 spindle). To get the
  // CW/conventional path we mirror the geometry across X, clear in the engine's natural mode, then
  // mirror the toolpath back: reflection reverses orientation (CCW→CW) and swaps
  // climb↔conventional, so the flipped result is exactly as clean as the natural one. (Inverting
  // the engine's conventional test instead left the flipped spiral hunting — the
  // angle/interpolation conventions don't invert with it.) wantCCW is true for climb on an inside
  // pocket, so reflect exactly when we want CW (conventional).
  const reflect = !wantCCW
  const mx = reflect ? -1 : 1

  // Geometry for the engine, in CNC mm. The engine offsets the boundary inward and islands
  // outward by the tool radius itself, so feed the raw walls (already allowance-adjusted by
  // generatePocket). paths = boundary + island holes; stock = boundary; cleared = none.
  const toDP = (pts: Pt2[]): Array<[number, number]> => pts.map(([x, y]) => [mx * x, y] as [number, number])
  const geomPaths: Array<Array<[number, number]>> = [toDP(boundary), ...islands.map(toDP)]
  const stock: Array<Array<[number, number]>> = [toDP(boundary)]

  const engine = new Adaptive2d({
    toolDiameter: dia,
    stepOverFactor: params.stepoverPercent / 100,
    tolerance: 0.1,
    stockToLeave: 0,             // allowance already applied upstream in generatePocket
    forceInsideOut: true,        // stay inside the pocket boundary
    finishingProfile: true,      // clean the walls with a finishing contour
    keepToolDownDistRatio: 3.0,
    helixRampMinDiameter: rampIn ? 0 : dia / 8,      // 0 → engine defaults to dia/8
    helixRampTargetDiameter: rampIn ? dia : dia / 8, // small target when not ramping
    opType: OperationType.ClearingInside,
  })

  let outputs: AdaptiveOutput[]
  try {
    outputs = _timed('engine.Execute', () => engine.Execute(stock, geomPaths, []))
  } catch (err) {
    console.error('[adaptive] engine failed', err)
    return null
  }

  // Mirror the toolpath back into real coordinates (no-op when not reflecting).
  if (reflect) for (const out of outputs) {
    out.helixCenter = [mx * out.helixCenter[0], out.helixCenter[1]]
    out.startPoint = [mx * out.startPoint[0], out.startPoint[1]]
    for (const tp of out.adaptivePaths) for (const p of tp.pts) p[0] = mx * p[0]
  }

  return {
    finishRings: [],
    travelObstacles: { edgeObstacles: [] },
    selfFinishing: true,
    emitCuts: (zDepth: number, prevZ: number, incomingPos: Pt2 | null, segs: MotionSegment[]) =>
      emitAdaptive(outputs, zDepth, prevZ, incomingPos, segs, safeZ, rampIn, wantCCW),
  }
}

function emitAdaptive(
  outputs: AdaptiveOutput[],
  zDepth: number,
  prevZ: number,
  incomingPos: Pt2 | null,
  segs: MotionSegment[],
  safeZ: number,
  rampIn: boolean,
  wantCCW: boolean,
): Pt2 | null {
  let lastPos: Pt2 | null = incomingPos

  for (const out of outputs) {
    if (out.adaptivePaths.length === 0) continue
    const firstCut = out.adaptivePaths[0].pts[0]
    if (!firstCut) continue
    const helixCenter: Pt2 = [out.helixCenter[0], out.helixCenter[1]]
    const helixR = Math.hypot(firstCut[0] - helixCenter[0], firstCut[1] - helixCenter[1])

    // Entry: ramp or plunge from prevZ down to zDepth, then settle on the first cut point.
    if (lastPos !== null) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
    if (rampIn && helixR >= 0.1) {
      emitHelicalRamp(helixCenter, helixR, prevZ, zDepth, wantCCW, segs, safeZ)
      segs.push({ x: firstCut[0], y: firstCut[1], z: zDepth, rapid: false })
    } else {
      segs.push({ x: firstCut[0], y: firstCut[1], z: safeZ, rapid: true })
      segs.push({ x: firstCut[0], y: firstCut[1], z: prevZ, rapid: true })
      segs.push({ x: firstCut[0], y: firstCut[1], z: zDepth, rapid: false })
    }
    let cur: Pt2 = [firstCut[0], firstCut[1]]

    for (const tp of out.adaptivePaths) {
      if (tp.pts.length === 0) continue
      if (tp.motion === MotionType.Helix) {
        // Mid-region helix re-entry into a fresh blob: lift, then ramp down at the blob centre.
        // pts = [center, rim]; the rim is the first cut point (helix radius = |rim-center|).
        const center = tp.pts[0]
        const rim = tp.pts[tp.pts.length - 1]
        const hr = Math.hypot(rim[0] - center[0], rim[1] - center[1])
        segs.push({ x: cur[0], y: cur[1], z: safeZ, rapid: true })
        if (hr >= 0.1) {
          emitHelicalRamp([center[0], center[1]], hr, prevZ, zDepth, wantCCW, segs, safeZ)
          segs.push({ x: rim[0], y: rim[1], z: zDepth, rapid: false })
        } else {
          segs.push({ x: center[0], y: center[1], z: safeZ, rapid: true })
          segs.push({ x: center[0], y: center[1], z: zDepth, rapid: false })
        }
        cur = [rim[0], rim[1]]
      } else if (tp.motion === MotionType.LinkNotClear) {
        // Relink that crosses uncleared stock — lift, rapid across, plunge back down.
        const dest = tp.pts[tp.pts.length - 1]
        segs.push({ x: cur[0], y: cur[1], z: safeZ, rapid: true })
        segs.push({ x: dest[0], y: dest[1], z: safeZ, rapid: true })
        segs.push({ x: dest[0], y: dest[1], z: zDepth, rapid: false })
        cur = [dest[0], dest[1]]
      } else if (tp.motion === MotionType.LinkClear) {
        // Stay-down reposition over already-cleared stock — the engine verified it's clear, so
        // traverse it at depth (travel, not a cut). Marked `travel` so it's shown/treated as a
        // rapid-at-depth, not a cutting feed move (that re-machined air and cluttered the view).
        for (const [x, y] of tp.pts) {
          segs.push({ x, y, z: zDepth, rapid: false, travel: true })
          cur = [x, y]
        }
      } else {
        // Cutting move — actual material removal at controlled engagement.
        for (const [x, y] of tp.pts) {
          segs.push({ x, y, z: zDepth, rapid: false })
          cur = [x, y]
        }
      }
    }
    lastPos = cur
  }

  return lastPos
}


