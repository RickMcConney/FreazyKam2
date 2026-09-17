import { flattenPath, ensureWinding, signedArea, rotatePolylineNear, arcFitPolyline, ARC_FIT_MAX_SPAN, splitSelfIntersecting, isOpenSubpath, type Pt2 } from './pathFlattener'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { zPasses, arcLengths, interpPt, stripClosingDuplicate, toolRadiusAtHeight, pushAll } from './geom'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool, CuttingDirection } from '../store/toolStore'
import type { CutSide } from '../store/toolpathStore'
import type { Tab } from '../store/tabStore'

export interface ProfileParams {
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  startNear?: { x: number; y: number }
  rampIn?: boolean
  safeHeightMM?: number
  /** Stock left on the wall, in mm. Shifts the offset away from the design line by
   *  this much on whichever side the cut is on, so the finished wall lands exactly
   *  `allowanceMM` proud of the line — inside cuts leave a smaller opening, outside
   *  cuts a bigger part. Negative cuts past the line. Meaningless for a centerline
   *  cut, which has no side, and ignored there. */
  allowanceMM?: number
  // Surface the cut starts from (0 = stock top, negative = the floor an earlier op left).
  // depthMM and tab heights are both measured from here.
  startZMM?: number
}

function fitCircle(pts: Pt2[]): { cx: number; cy: number; r: number } | null {
  if (pts.length < 8) return null
  let sx = 0, sy = 0
  for (const [x, y] of pts) { sx += x; sy += y }
  const cx = sx / pts.length, cy = sy / pts.length
  const radii = pts.map(([x, y]) => Math.hypot(x - cx, y - cy))
  const r = radii.reduce((a, b) => a + b, 0) / radii.length
  if (r < 0.1) return null
  const variance = radii.reduce((acc, ri) => acc + (ri - r) ** 2, 0) / radii.length
  return Math.sqrt(variance) / r <= 0.01 ? { cx, cy, r } : null
}

// Evaluate XY at arc-length fraction t across all subpaths (matches TabLayer's evalPathAtT convention).
export function designPathAtT(subpaths: Pt2[][], t: number): [number, number] | null {
  let totalLen = 0
  const segs: { pts: Pt2[]; startLen: number; segLen: number }[] = []
  for (const sp of subpaths) {
    let len = 0
    for (let i = 1; i < sp.length; i++) len += Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1])
    segs.push({ pts: sp, startLen: totalLen, segLen: len })
    totalLen += len
  }
  if (totalLen < 1e-6) return null
  const target = t * totalLen
  for (const seg of segs) {
    if (target > seg.startLen + seg.segLen && seg !== segs[segs.length - 1]) continue
    let cum = seg.startLen
    for (let i = 1; i < seg.pts.length; i++) {
      const dx = seg.pts[i][0] - seg.pts[i - 1][0], dy = seg.pts[i][1] - seg.pts[i - 1][1]
      const el = Math.hypot(dx, dy)
      if (cum + el >= target || i === seg.pts.length - 1) {
        const u = el > 1e-10 ? Math.min(1, (target - cum) / el) : 0
        return [seg.pts[i - 1][0] + u * dx, seg.pts[i - 1][1] + u * dy]
      }
      cum += el
    }
  }
  return null
}

// Project (tx, ty) onto a polyline and return the arc-length of the nearest point.
export function nearestArcLen(pts: Pt2[], arcLens: number[], tx: number, ty: number): number {
  let bestDist = Infinity, bestLen = 0
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1]
    const bx = pts[i][0], by = pts[i][1]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const u = len2 > 1e-10 ? Math.max(0, Math.min(1, ((tx - ax) * dx + (ty - ay) * dy) / len2)) : 0
    const dist = Math.hypot(tx - (ax + u * dx), ty - (ay + u * dy))
    if (dist < bestDist) {
      bestDist = dist
      bestLen = arcLens[i - 1] + u * (arcLens[i] - arcLens[i - 1])
    }
  }
  return bestLen
}

// Generate segments for one polyline pass with tab support.
export function polylinePassWithTabs(
  pts: Pt2[],
  zDepth: number,
  tabRanges: { start: number; end: number; tabZ: number }[],
  arcLens: number[],
): MotionSegment[] {
  if (tabRanges.length === 0) {
    return pts.slice(1).map(([x, y]) => ({ x, y, z: zDepth, rapid: false }))
  }

  const total = arcLens[arcLens.length - 1]

  function interpXY(s: number): [number, number] {
    s = Math.max(0, Math.min(total, s))
    for (let i = 1; i < pts.length; i++) {
      if (arcLens[i] >= s - 1e-10) {
        const segLen = arcLens[i] - arcLens[i - 1]
        const t = segLen > 1e-10 ? (s - arcLens[i - 1]) / segLen : 0
        return [
          pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]),
          pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]),
        ]
      }
    }
    return [pts[pts.length - 1][0], pts[pts.length - 1][1]]
  }

  const sorted = [...tabRanges].sort((a, b) => a.start - b.start)

  const segs: MotionSegment[] = []
  let curZ = zDepth
  let ptIdx = 1

  for (const tr of sorted) {
    const tabStart = Math.max(0, tr.start)
    const tabEnd = Math.min(total, tr.end)
    if (tabEnd <= tabStart) continue

    while (ptIdx < pts.length && arcLens[ptIdx] <= tabStart + 1e-6) {
      segs.push({ x: pts[ptIdx][0], y: pts[ptIdx][1], z: curZ, rapid: false })
      ptIdx++
    }

    const [ex, ey] = interpXY(tabStart)
    segs.push({ x: ex, y: ey, z: curZ, rapid: false })
    curZ = tr.tabZ
    segs.push({ x: ex, y: ey, z: curZ, rapid: false })

    while (ptIdx < pts.length && arcLens[ptIdx] < tabEnd - 1e-6) {
      segs.push({ x: pts[ptIdx][0], y: pts[ptIdx][1], z: curZ, rapid: false })
      ptIdx++
    }

    const [fx, fy] = interpXY(tabEnd)
    segs.push({ x: fx, y: fy, z: curZ, rapid: false })
    curZ = zDepth
    segs.push({ x: fx, y: fy, z: curZ, rapid: false })
  }

  while (ptIdx < pts.length) {
    segs.push({ x: pts[ptIdx][0], y: pts[ptIdx][1], z: curZ, rapid: false })
    ptIdx++
  }

  return segs
}

export function generateProfile(
  d: string,
  tool: Tool,
  params: ProfileParams,
  tabs?: Tab[]
): MotionSegment[] {
  // Separate closed loops from open strokes (e.g. single-stroke / Hershey text):
  //  • closed loops feed splitSelfIntersecting — it needs ≥3 points and assumes a
  //    closed polygon — and the offset/winding logic below.
  //  • open strokes, including 2-point straight segments like an 'I' stem, are
  //    followed as-is for centerline cuts. They must NOT go through
  //    splitSelfIntersecting: it drops sub-3-point strokes (so they vanish, hence
  //    "No geometry found") and wraps a self-touching open stroke into a closed
  //    loop, adding a spurious end→start closing line.
  const flat = flattenPath(d, 0.05)
  const closedSubs = splitSelfIntersecting(flat.filter((sp) => !isOpenSubpath(sp)))
  const openSubs = flat.filter(isOpenSubpath)
  if (closedSubs.length === 0 && openSubs.length === 0) throw new Error('No geometry found in path')
  // Combined design geometry, used for tab arc-length placement.
  const designSubs = [...closedSubs, ...openSubs]

  const safeZ = params.safeHeightMM ?? 5

  const startZ = Math.min(0, params.startZMM ?? 0)

  // Offset by the tool's radius AT THE CUT SURFACE, not its nominal radius. With the
  // tip at full depth the wall a V-bit or ball nose leaves is a cone/ball surface, and
  // the widest point of that cut sits at startZ — so offsetting by the radius at height
  // `depthMM` above the tip is what makes the finished cut just touch the design line at
  // the surface. An end mill is unaffected (radius is constant with height), and a V-bit
  // or ball nose cutting past its full-diameter height falls back to the same value, so
  // ordinary through-profiles emit exactly the G-code they always did.
  //
  // Every pass shares this one offset: the cone/ball surface is fixed in XY, so shallower
  // passes simply leave a step outside it and the final pass sweeps the finished wall. The
  // radial bite the last pass takes is ~stepDown·tanθ, not the whole taper.
  //
  // A stock allowance rides on top of that offset, on the same side: the finished wall
  // is the offset plus the tool's radius back the other way, so moving the toolpath a
  // further `allowance` off the line moves the wall exactly `allowance` proud of it. A
  // centerline cut has no side for stock to be left on, so it ignores the allowance
  // rather than guessing a direction.
  const cutRadius = toolRadiusAtHeight(tool, params.depthMM)
  const allowance = params.allowanceMM ?? 0
  const rawDelta =
    params.side === 'outside' ? cutRadius + allowance :
    params.side === 'inside' ? -(cutRadius + allowance) : 0
  // A near-zero offset (a V-bit barely scratching the surface) is a centerline cut —
  // Clipper would otherwise be handed a degenerate inflate.
  const delta = Math.abs(rawDelta) < 1e-6 ? 0 : rawDelta


  const passes = zPasses(params.depthMM, params.stepDownMM, startZ)
  const segs: MotionSegment[] = []

  // Compute offset paths using Clipper2.
  // Normalize inputs to CCW so positive delta = expand, negative = shrink.
  // Clipper2 handles self-intersections automatically, eliminating the need for
  // the manual resolveOffsetLoops pass.
  interface OffsetPath { pts: Pt2[]; isOpen: boolean }
  let offsetPaths: OffsetPath[]
  if (delta !== 0) {
    // Inside/outside offset only applies to closed loops; open strokes have no
    // interior, so they're left to centerline cuts.
    const inputPaths = closedSubs
      .map(sp => stripClosingDuplicate(sp))
      .filter(sp => sp.length >= 3)
      .map(sp => {
        const ccw = signedArea(sp) >= 0 ? sp : [...sp].reverse()
        return ccw.map(([x, y]) => ({ x, y }))
      })
    const result = inflatePathsD(inputPaths, delta, JoinType.Miter, EndType.Polygon, 4, 6)
    offsetPaths = result
      .map(p => stripClosingDuplicate(p.map(({ x, y }) => [x, y] as Pt2)))
      .filter(p => p.length >= 3)
      .map(pts => ({ pts, isOpen: false }))
    // An inside offset that eats the whole shape returns nothing, and an op that emits no
    // segments looks identical to one that was never generated. Say which knob did it —
    // with an allowance in the mix "the tool is too big" is no longer the only answer.
    if (offsetPaths.length === 0 && openSubs.length === 0) {
      throw new Error(allowance !== 0
        ? 'Tool plus allowance is larger than the shape'
        : 'Tool is larger than the shape')
    }
    // An open stroke has no interior, so there is no inside or outside of it to offset
    // to, and it is left out of the inflate above. Left at that it is simply DROPPED —
    // the op generates, reports nothing, and the stroke is never cut, which is only
    // discovered in the material. Name it instead, and name the cut that does work on
    // an open stroke.
    if (openSubs.length > 0) {
      const side = params.side === 'inside' ? 'inside' : 'outside'
      throw new Error(closedSubs.length === 0
        ? `Path is open — an ${side} profile needs a closed shape. Use a centerline profile to cut along it.`
        : `${openSubs.length} of ${designSubs.length} subpaths are open and cannot be offset — an ${side} profile needs closed shapes. `
          + 'Use a centerline profile, or split the path and profile the closed parts.')
    }
  } else {
    // Centerline: follow every subpath exactly. Closed loops trace once (drop the
    // duplicate closing point); open strokes cut start → end with no closing line.
    offsetPaths = [
      ...closedSubs.map(sp => ({ pts: stripClosingDuplicate(sp), isOpen: false })),
      ...openSubs.map(sp => ({ pts: sp, isOpen: true })),
    ].filter(({ pts }) => pts.length >= 2)
  }

  // Climb with an M3 (CW) spindle puts the material on the RIGHT of travel:
  // inside profile → CCW, outside profile → CW. Conventional is the reverse.
  const wantCCW = (params.direction === 'climb') === (params.side === 'inside')

  for (const { pts: rawPts, isOpen } of offsetPaths) {
    if (isOpen) {
      // Open path (centerline only): cut start → end, no winding or closing needed.
      const [sx, sy] = rawPts[0]
      const [ex, ey] = rawPts[rawPts.length - 1]
      const { lens: pathLens, total: pathTotal } = arcLengths(rawPts)

      const tabRanges: { start: number; end: number; tabZ: number }[] = []
      if (tabs && tabs.length > 0) {
        for (const tab of tabs) {
          const pos = designPathAtT(designSubs, tab.t)
          if (!pos) continue
          const center = nearestArcLen(rawPts, pathLens, pos[0], pos[1])
          const half = tab.lengthMM / 2 + tool.diameterMM / 2
          tabRanges.push({ start: center - half, end: center + half, tabZ: Math.min(startZ, startZ - params.depthMM + tab.heightMM) })
        }
      }

      if (params.rampIn) {
        // Ramp forward from the pass start on every pass (no backtrack to ramp entry).
        // Intermediate passes: ramp then cut rampEnd → far end; the next opposite-direction
        // pass returns to the start and naturally clears the ramp zone.
        // Last pass only: ramp, cleanup (rampEnd → start), then full cut start → far end.
        const rampDist = Math.min(2 * tool.diameterMM, pathTotal * 0.45)
        const RAMP_STEPS = 12
        const reversedPts = [...rawPts].reverse()
        const { lens: reversedLens } = arcLengths(reversedPts)
        const rampEndFwd = interpPt(rawPts, pathLens, rampDist)
        const rampEndBwd = interpPt(reversedPts, reversedLens, rampDist)
        const mainTotal = pathTotal - rampDist

        // Intermediate main sub-polylines: rampEnd → far end (arc-lengths offset by rampDist)
        const mainFwdPts: Pt2[] = [rampEndFwd]
        const mainFwdLens: number[] = [0]
        for (let i = 1; i < rawPts.length; i++) {
          if (pathLens[i] > rampDist + 1e-6) { mainFwdPts.push(rawPts[i]); mainFwdLens.push(pathLens[i] - rampDist) }
        }
        const mainBwdPts: Pt2[] = [rampEndBwd]
        const mainBwdLens: number[] = [0]
        for (let i = 1; i < reversedPts.length; i++) {
          if (reversedLens[i] > rampDist + 1e-6) { mainBwdPts.push(reversedPts[i]); mainBwdLens.push(reversedLens[i] - rampDist) }
        }

        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
        segs.push({ x: sx, y: sy, z: startZ, rapid: true })

        for (let pi = 0; pi < passes.length; pi++) {
          const zDepth = passes[pi]
          const rampStartZ = pi === 0 ? startZ : passes[pi - 1]
          const forward = pi % 2 === 0
          const pts = forward ? rawPts : reversedPts
          const lens = forward ? pathLens : reversedLens
          const rampEnd = forward ? rampEndFwd : rampEndBwd
          const isLast = pi === passes.length - 1
          const activeRanges = tabRanges.filter(tr => zDepth < tr.tabZ)

          // Ramp forward from pts[0] to rampEnd, descending from rampStartZ to zDepth
          for (let i = 1; i <= RAMP_STEPS; i++) {
            const t = i / RAMP_STEPS
            const [rx, ry] = interpPt(pts, lens, t * rampDist)
            segs.push({ x: rx, y: ry, z: rampStartZ + (zDepth - rampStartZ) * t, rapid: false, feedScale: 0.5 })
          }
          // Now at rampEnd at zDepth

          if (isLast) {
            // Cleanup: rampEnd → pts[0] at full depth to clear the ramp zone
            const cleanPts: Pt2[] = [rampEnd]
            const cleanLens: number[] = [0]
            for (let ci = pts.length - 1; ci >= 0; ci--) {
              if (lens[ci] < rampDist - 1e-6) {
                const prev = cleanPts[cleanPts.length - 1]
                cleanLens.push(cleanLens[cleanLens.length - 1] + Math.hypot(pts[ci][0] - prev[0], pts[ci][1] - prev[1]))
                cleanPts.push(pts[ci])
              }
            }
            const lastClean = cleanPts[cleanPts.length - 1]
            if (Math.hypot(lastClean[0] - pts[0][0], lastClean[1] - pts[0][1]) > 1e-6) {
              cleanLens.push(cleanLens[cleanLens.length - 1] + Math.hypot(lastClean[0] - pts[0][0], lastClean[1] - pts[0][1]))
              cleanPts.push(pts[0])
            }
            segs.push(...polylinePassWithTabs(cleanPts, zDepth, [], cleanLens))
            // Full cut from pts[0] to far end
            if (activeRanges.length === 0) {
              const arcSegs = arcFitPolyline(pts, 0.1, ARC_FIT_MAX_SPAN)
              for (const s of arcSegs) {
                segs.push({ x: s.x, y: s.y, z: zDepth, rapid: false, ...(s.arc ? { arc: s.arc } : {}) })
              }
            } else {
              const effectiveRanges = forward
                ? activeRanges
                : activeRanges.map(tr => ({ start: pathTotal - tr.end, end: pathTotal - tr.start, tabZ: tr.tabZ }))
              segs.push(...polylinePassWithTabs(pts, zDepth, effectiveRanges, lens))
            }
          } else {
            // Intermediate: cut rampEnd → far end; ramp zone cleared by next opposite pass
            const mainPts = forward ? mainFwdPts : mainBwdPts
            const mainLens = forward ? mainFwdLens : mainBwdLens
            if (activeRanges.length === 0) {
              const arcSegs = arcFitPolyline(mainPts, 0.1, ARC_FIT_MAX_SPAN)
              for (const s of arcSegs) {
                segs.push({ x: s.x, y: s.y, z: zDepth, rapid: false, ...(s.arc ? { arc: s.arc } : {}) })
              }
            } else {
              const mainTabRanges = forward
                ? activeRanges.map(tr => ({ start: tr.start - rampDist, end: tr.end - rampDist, tabZ: tr.tabZ })).filter(tr => tr.end > 0 && tr.start < mainTotal)
                : activeRanges.map(tr => ({ start: pathTotal - tr.end - rampDist, end: pathTotal - tr.start - rampDist, tabZ: tr.tabZ })).filter(tr => tr.end > 0 && tr.start < mainTotal)
              segs.push(...polylinePassWithTabs(mainPts, zDepth, mainTabRanges, mainLens))
            }
          }
        }

        const [retractX, retractY] = passes.length % 2 === 1 ? [ex, ey] : [sx, sy]
        segs.push({ x: retractX, y: retractY, z: safeZ, rapid: true })
      } else {
        // Bidirectional passes: alternate direction each depth level so the tool
        // feed-plunges in place at each pass end instead of retracting to safe height.
        const reversedPts = [...rawPts].reverse()
        const { lens: reversedLens } = arcLengths(reversedPts)
        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
        for (let pi = 0; pi < passes.length; pi++) {
          const zDepth = passes[pi]
          const forward = pi % 2 === 0
          const pts = forward ? rawPts : reversedPts
          const lens = forward ? pathLens : reversedLens
          // Feed-plunge at current position (already here from end of previous pass; first pass descends from safeZ)
          segs.push({ x: pts[0][0], y: pts[0][1], z: zDepth, rapid: false })
          const activeRanges = tabRanges.filter(tr => zDepth < tr.tabZ)
          if (activeRanges.length === 0) {
            const arcSegs = arcFitPolyline(pts, 0.1, ARC_FIT_MAX_SPAN)
            for (const s of arcSegs) {
              segs.push({ x: s.x, y: s.y, z: zDepth, rapid: false, ...(s.arc ? { arc: s.arc } : {}) })
            }
          } else {
            // For backward passes, mirror tab arc-length positions relative to path total
            const effectiveRanges = forward
              ? activeRanges
              : activeRanges.map(tr => ({ start: pathTotal - tr.end, end: pathTotal - tr.start, tabZ: tr.tabZ }))
            segs.push(...polylinePassWithTabs(pts, zDepth, effectiveRanges, lens))
          }
        }
        // Retract from wherever the final pass ended
        const [retractX, retractY] = passes.length % 2 === 1 ? [ex, ey] : [sx, sy]
        segs.push({ x: retractX, y: retractY, z: safeZ, rapid: true })
      }
      continue
    }

    const oriented = ensureWinding(rawPts, wantCCW)
    // Only take the true-arc circle fast-path when there are no tabs. The fast-path
    // emits the loop as one or two uninterrupted arcs, which can't carry the per-tab
    // Z-lifts. With tabs present we fall through to the generic closed-polygon path
    // (polylinePassWithTabs), which raises the tool over each tab; gcode.ts then
    // re-fits the tab-free spans back into G2/G3 arcs, so a tabbed circle still
    // exports as arcs between the tabs.
    const circle = (tabs && tabs.length > 0) ? null : fitCircle(oriented)

    if (circle) {
      // Circle pass — emitted as true arcs (only when no tabs apply).
      const { cx, cy, r } = circle
      let sx: number, sy: number
      if (params.startNear) {
        const dx = params.startNear.x - cx, dy = params.startNear.y - cy
        const d = Math.hypot(dx, dy)
        sx = d < 1e-10 ? cx + r : cx + r * dx / d
        sy = d < 1e-10 ? cy     : cy + r * dy / d
      } else {
        sx = cx + r; sy = cy
      }
      const cw = !wantCCW

      if (params.rampIn) {
        // Helical entry: descend along the arc over a ramp wedge, complete the rest
        // of the circle at depth, then (final pass only) clear the wedge with a flat
        // finishing arc. Mirrors the closed-polygon ramp structure below.
        const circ = 2 * Math.PI * r
        const rampDist = Math.min(2 * tool.diameterMM, circ * 0.45)
        const rampAngle = rampDist / r          // radians swept by the ramp
        const dir = cw ? -1 : 1
        const startAngle = Math.atan2(sy - cy, sx - cx)
        const rampEndAngle = startAngle + dir * rampAngle
        const rex = cx + r * Math.cos(rampEndAngle)
        const rey = cy + r * Math.sin(rampEndAngle)

        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
        for (let pi = 0; pi < passes.length; pi++) {
          const zDepth = passes[pi]
          const rampStartZ = pi === 0 ? startZ : passes[pi - 1]
          // pi 0: rapid down to the surface; pi>0: already at depth (no lift), the
          // previous pass's circle ended back at sx at this depth.
          segs.push({ x: sx, y: sy, z: rampStartZ, rapid: true })
          // Helical ramp arc sx → rampEnd, descending rampStartZ → zDepth.
          segs.push({ x: rex, y: rey, z: zDepth, rapid: false, arc: { cx, cy, cw } })
          // Remainder of the circle at depth: rampEnd → sx the long way round.
          segs.push({ x: sx, y: sy, z: zDepth, rapid: false, arc: { cx, cy, cw } })
          // Final pass: clear the ramp wedge with a flat arc sx → rampEnd.
          if (pi === passes.length - 1) {
            segs.push({ x: rex, y: rey, z: zDepth, rapid: false, arc: { cx, cy, cw } })
          }
        }
        segs.push({ x: rex, y: rey, z: safeZ, rapid: true })
      } else {
        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
        for (const zDepth of passes) {
          segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
          segs.push({ x: sx, y: sy, z: zDepth, rapid: false, arc: { cx, cy, cw } })
        }
        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
      }
    } else {
      const rotated = params.startNear
        ? rotatePolylineNear(oriented, params.startNear.x, params.startNear.y)
        : oriented
      const [sx, sy] = rotated[0]

      // Append start point so the closing edge is a real segment (needed for tab arc-length math).
      const closed: Pt2[] = [...rotated, rotated[0]]

      const { lens } = arcLengths(closed)

      // Compute tab ranges over the full closed path (used by both ramp and non-ramp branches)
      const tabRanges: { start: number; end: number; tabZ: number }[] = []
      if (tabs && tabs.length > 0) {
        for (const tab of tabs) {
          const pos = designPathAtT(designSubs, tab.t)
          if (!pos) continue
          const center = nearestArcLen(closed, lens, pos[0], pos[1])
          const half = tab.lengthMM / 2 + tool.diameterMM / 2
          tabRanges.push({
            start: center - half,
            end: center + half,
            tabZ: Math.min(startZ, startZ - params.depthMM + tab.heightMM),
          })
        }
      }

      if (params.rampIn) {
        const rampLen = 2 * tool.diameterMM
        const { lens: rampLens, total } = arcLengths(closed)
        const rampDist = Math.min(rampLen, total * 0.45)
        const [rampEndX, rampEndY] = interpPt(closed, rampLens, rampDist)

        // Main cut sub-polyline: rampEnd → sx,sy (arc lengths offset by rampDist)
        const mainPts: Pt2[] = [[rampEndX, rampEndY]]
        const mainLens: number[] = [0]
        for (let i = 1; i < closed.length; i++) {
          if (rampLens[i] > rampDist + 1e-6) {
            mainPts.push(closed[i])
            mainLens.push(rampLens[i] - rampDist)
          }
        }
        const mainTotal = total - rampDist

        // Cleanup sub-polyline: sx,sy → rampEnd (covers the ramp entry zone)
        const cleanPts: Pt2[] = [[sx, sy]]
        const cleanLens: number[] = [0]
        for (let i = 1; i < closed.length; i++) {
          if (rampLens[i] <= rampDist - 1e-6) {
            cleanPts.push(closed[i])
            cleanLens.push(rampLens[i])
          } else {
            break
          }
        }
        cleanPts.push([rampEndX, rampEndY])
        cleanLens.push(rampDist)

        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
        for (let pi = 0; pi < passes.length; pi++) {
          const zDepth = passes[pi]
          const rampStartZ = pi === 0 ? startZ : passes[pi - 1]

          // pi === 0: lower from safe height to surface; pi > 0: rapid at current depth to ramp start (no lift)
          segs.push({ x: sx, y: sy, z: rampStartZ, rapid: true })

          // Ramp in: descend from rampStartZ to zDepth while moving along path
          const RAMP_STEPS = 12
          for (let i = 1; i <= RAMP_STEPS; i++) {
            const t = i / RAMP_STEPS
            const [rx, ry] = interpPt(closed, rampLens, t * rampDist)
            segs.push({ x: rx, y: ry, z: rampStartZ + (zDepth - rampStartZ) * t, rapid: false, feedScale: 0.5 })
          }

          const activeRanges = tabRanges.filter(tr => zDepth < tr.tabZ)

          // Main cut with tab avoidance (tab arc-lengths are offset by rampDist)
          const mainTabRanges = activeRanges
            .map(tr => ({ start: tr.start - rampDist, end: tr.end - rampDist, tabZ: tr.tabZ }))
            .filter(tr => tr.end > 0 && tr.start < mainTotal)
          segs.push(...polylinePassWithTabs(mainPts, zDepth, mainTabRanges, mainLens))

          // Cleanup pass: only on the final depth pass to clear the ramp entry zone.
          // Intermediate passes skip it — the next ramp descends through the same groove anyway.
          if (pi === passes.length - 1) {
            const cleanTabRanges = activeRanges.filter(tr => tr.end > 0 && tr.start < rampDist)
            segs.push(...polylinePassWithTabs(cleanPts, zDepth, cleanTabRanges, cleanLens))
          }
        }
        segs.push({ x: rampEndX, y: rampEndY, z: safeZ, rapid: true })
      } else {
        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
        for (const zDepth of passes) {
          segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
          const activeRanges = tabRanges.filter((tr) => zDepth < tr.tabZ)
          if (activeRanges.length === 0) {
            const arcSegs = arcFitPolyline(closed, 0.1, ARC_FIT_MAX_SPAN)
            for (const s of arcSegs) {
              segs.push({ x: s.x, y: s.y, z: zDepth, rapid: false, ...(s.arc ? { arc: s.arc } : {}) })
            }
          } else {
            const passSegs = polylinePassWithTabs(closed, zDepth, activeRanges, lens)
            pushAll(segs, passSegs)
          }
          segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
        }
        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
      }
    }
  }

  return segs
}
