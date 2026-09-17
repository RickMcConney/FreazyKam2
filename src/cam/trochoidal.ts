import { flattenPath, ensureWinding, signedArea, rotatePolylineNear, arcFitPolyline, splitSelfIntersecting, requireClosedSubpaths, isOpenSubpath, type Pt2 } from './pathFlattener'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { zPasses, arcLengths, interpPt, stripClosingDuplicate, pushAll } from './geom'
import { designPathAtT, nearestArcLen, polylinePassWithTabs } from './profile'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { CutSide } from '../store/toolpathStore'
import type { CuttingDirection } from '../store/toolStore'
import type { Tab } from '../store/tabStore'

export interface TrochoidalParams {
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  // loopRadius (l): amplitude of each loop — tool swings 0..2l outward from profile wall.
  // Use toolRadius for a 1-diameter-wide clearing pass; larger = wider cut.
  trochRadiusMM: number
  // stepoverMM (w): forward advance along path per complete loop.
  // r = w/(2π) is the rolling-circle radius. Small values (10–20% of toolDia) give
  // the tight Spirograph-like pattern that keeps engagement constant.
  trochStepMM: number
  finishingPass: boolean
  rampIn?: boolean
  startNear?: { x: number; y: number }
  safeHeightMM?: number
}

// Build a smooth (G1-continuous) unit-tangent sampler for a closed polyline.
// A per-segment tangent steps discontinuously at every vertex; over a rounded corner's
// many short facets those steps rotate the trochoidal perpendicular and staircase the
// loop stems. Instead we compute a tangent at each vertex (blend of its two edges) and
// angle-interpolate along each segment, so direction rotates continuously through corners.
// A CLOSED `closed` has a duplicate closing vertex (closed[last] === closed[0]) and every
// vertex bisects two edges. An OPEN one has none: its two ends have a single edge each and
// take that edge's own direction, or the bisector would wrap the first edge against the
// last and point the tangent somewhere across the middle of the part.
function makeTangentSampler(closed: Pt2[], lens: number[], open = false): (s: number) => [number, number] {
  const m = closed.length - 1                 // unique vertices / edges
  const edgeAng: number[] = []
  for (let j = 0; j < m; j++) {
    edgeAng.push(Math.atan2(closed[j + 1][1] - closed[j][1], closed[j + 1][0] - closed[j][0]))
  }
  // Angle bisector at each vertex from its incoming and outgoing edge directions.
  const vertAng: number[] = []
  for (let j = 0; j < m; j++) {
    if (open && j === 0) { vertAng.push(edgeAng[0]); continue }
    const aPrev = edgeAng[open ? j - 1 : (j - 1 + m) % m]
    const aCur = edgeAng[j]
    let d = aCur - aPrev
    while (d <= -Math.PI) d += 2 * Math.PI
    while (d > Math.PI) d -= 2 * Math.PI
    vertAng.push(aPrev + d / 2)
  }
  vertAng.push(open ? edgeAng[m - 1] : vertAng[0])   // far end / the duplicate closing vertex

  const total = lens[lens.length - 1]
  return (s: number): [number, number] => {
    s = Math.max(0, Math.min(total, s))
    for (let i = 1; i < closed.length; i++) {
      if (lens[i] >= s - 1e-10) {
        const segLen = lens[i] - lens[i - 1]
        const t = segLen > 1e-10 ? (s - lens[i - 1]) / segLen : 0
        const a0 = vertAng[i - 1]
        let d = vertAng[i] - a0
        while (d <= -Math.PI) d += 2 * Math.PI
        while (d > Math.PI) d -= 2 * Math.PI
        const a = a0 + d * t
        return [Math.cos(a), Math.sin(a)]
      }
    }
    return [Math.cos(vertAng[m]), Math.sin(vertAng[m])]
  }
}

// Replace each sharp corner of a closed polygon with a tangent fillet arc.
// Trochoidal loops are placed by arc-length along this center path; a zero-length
// mitered vertex makes the tangent (and thus loop direction) snap discontinuously,
// producing sharp kinks/straight chords across corners. Spreading the turn over a
// short arc lets the tangent rotate gradually so loops stay round and evenly spaced.
// Roughing-only smoothing: the wall corner is recovered exactly by the finishing pass.
// `open`: the first and last vertices are the ENDS of a stroke, not corners — there is
// nothing on the far side of them to turn through, and rounding them would pull the cut
// short of where the line was drawn.
function roundPolygonCorners(poly: Pt2[], radius: number, open = false): Pt2[] {
  const n = poly.length
  if (n < 3 || radius <= 1e-6) return poly
  const out: Pt2[] = []
  for (let i = 0; i < n; i++) {
    if (open && (i === 0 || i === n - 1)) { out.push(poly[i]); continue }
    const prev = poly[(i - 1 + n) % n]
    const cur = poly[i]
    const next = poly[(i + 1) % n]
    let ix = cur[0] - prev[0], iy = cur[1] - prev[1]
    let ox = next[0] - cur[0], oy = next[1] - cur[1]
    const inLen = Math.hypot(ix, iy), outLen = Math.hypot(ox, oy)
    if (inLen < 1e-9 || outLen < 1e-9) { out.push(cur); continue }
    ix /= inLen; iy /= inLen; ox /= outLen; oy /= outLen
    const cross = ix * oy - iy * ox
    const dot = Math.max(-1, Math.min(1, ix * ox + iy * oy))
    const turn = Math.atan2(cross, dot)         // signed exterior turn angle
    if (Math.abs(turn) < 0.05) { out.push(cur); continue }   // ~3°, effectively straight
    const t = Math.min(radius, 0.5 * inLen, 0.5 * outLen)    // trim distance along each edge
    if (t < 1e-6) { out.push(cur); continue }
    const ax = cur[0] - ix * t, ay = cur[1] - iy * t         // tangent point on incoming edge
    const bx = cur[0] + ox * t, by = cur[1] + oy * t         // tangent point on outgoing edge
    const R = t * Math.tan((Math.PI - Math.abs(turn)) / 2)   // fillet radius for this trim
    const sign = cross >= 0 ? 1 : -1                         // inward normal direction
    const cxr = ax + (-iy * sign) * R, cyr = ay + (ix * sign) * R   // arc center
    const a0 = Math.atan2(ay - cyr, ax - cxr)
    const a1 = Math.atan2(by - cyr, bx - cxr)
    let dA = a1 - a0
    while (dA <= -Math.PI) dA += 2 * Math.PI
    while (dA > Math.PI) dA -= 2 * Math.PI
    const arcSteps = Math.max(2, Math.ceil(Math.abs(dA) / (Math.PI / 18)))  // ~10° per step
    for (let k = 0; k <= arcSteps; k++) {
      const ang = a0 + dA * (k / arcSteps)
      out.push([cxr + R * Math.cos(ang), cyr + R * Math.sin(ang)])
    }
  }
  return out
}

export function generateTrochoidal(
  d: string,
  tool: Tool,
  params: TrochoidalParams,
  tabs?: Tab[],
): MotionSegment[] {
  // A CENTERLINE trochoidal follows a stroke — that is trochoidal slotting, and cutting a
  // slot along an open line is one of the things the strategy is for. So open subpaths are
  // kept, exactly as profile.ts keeps them, and only the SIDED cuts refuse them: an inside
  // or an outside needs an interior to be on a side of, and a stroke has none.
  const designSubs = flattenPath(d, 0.05)
  const openSubs = designSubs.filter((sp) => sp.length >= 2 && isOpenSubpath(sp))
  const subpaths = splitSelfIntersecting(designSubs.filter((sp) => !isOpenSubpath(sp)))
  if (subpaths.length === 0 && openSubs.length === 0) throw new Error('No geometry found in path')

  const safeZ = params.safeHeightMM ?? 5
  const l = Math.max(0.01, params.trochRadiusMM)  // loop amplitude
  const w = Math.max(0.1, params.trochStepMM)      // stepover per loop
  const r = w / (2 * Math.PI)                      // rolling-circle radius

  const delta =
    params.side === 'outside' ? tool.diameterMM / 2 :
    params.side === 'inside' ? -tool.diameterMM / 2 : 0

  if (delta !== 0 && openSubs.length > 0) {
    requireClosedSubpaths(designSubs, {
      cut: `an ${params.side} trochoidal cut`,
      remedy: 'Close the path, or set the cut to centerline — a trochoidal slot follows an open line.',
    })
  }

  const passes = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  // Climb with an M3 (CW) spindle puts the material on the RIGHT of travel:
  // inside → CCW, outside → CW. Conventional is the reverse.
  const wantCCW = (params.direction === 'climb') === (params.side === 'inside')

  // perpSign controls which side of the offset path the loops swing into (into material,
  // away from the boundary wall). This is NOT the same as pocket.ts's generateTrochoidalRow
  // perpSign — that function operates on straight raster rows where wantCCW means loop
  // direction, not polygon winding. For a polygon boundary the correct sign depends only
  // on direction: climb always needs +1 and conventional always needs -1, regardless of
  // whether the cut is inside or outside.
  //
  // Proof by case:
  //   outside+climb:        CW polygon,  LEFT of travel  = outward → (-ty,tx) → perpSign=+1
  //   outside+conventional: CCW polygon, RIGHT of travel = outward → (ty,-tx) → perpSign=-1
  //   inside+climb:         CCW polygon, LEFT of travel  = inward  → (-ty,tx) → perpSign=+1
  //   inside+conventional:  CW polygon,  RIGHT of travel = inward  → (ty,-tx) → perpSign=-1
  const perpSign = params.direction === 'climb' ? 1 : -1

  // Compute offset paths via Clipper2 (same as profile.ts).
  interface OffsetPath { pts: Pt2[]; isOpen?: boolean }
  let offsetPaths: OffsetPath[]
  if (delta !== 0) {
    const inputPaths = subpaths
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
      .map(pts => ({ pts }))
  } else {
    offsetPaths = [
      ...subpaths
        .map(sp => stripClosingDuplicate(sp))
        .filter(sp => sp.length >= 3)
        .map(pts => ({ pts })),
      ...openSubs.map(pts => ({ pts, isOpen: true })),
    ]
  }

  const STEPS = 32  // segments per trochoidal loop (matches pocket.ts)

  for (const { pts: rawPts, isOpen } of offsetPaths) {
    // Round sharp corners so trochoidal loops sweep smoothly around them instead of
    // snapping. Radius is scaled to the loop geometry: large enough to fit a couple of
    // loops in the corner arc, capped so it never consumes a whole short edge (the
    // function itself clamps the trim to half each adjacent edge).
    const cornerR = Math.max(l, 2 * w)

    let closed: Pt2[]        // loop guide, corners rounded
    let closedExact: Pt2[]   // the true path, for the finishing pass

    if (isOpen) {
      // A stroke has no winding to fix and no vertex to rotate the start onto — the only
      // choice is which END to start from, so start at whichever is nearer the entry hint
      // and run to the other. Its two ends stay sharp: they are where the line was drawn
      // to, not corners to turn through.
      const near = params.startNear
      const a = rawPts[0], b = rawPts[rawPts.length - 1]
      const src = near && Math.hypot(b[0] - near.x, b[1] - near.y) < Math.hypot(a[0] - near.x, a[1] - near.y)
        ? [...rawPts].reverse()
        : rawPts
      closedExact = src
      closed = roundPolygonCorners(src, cornerR, true)
    } else {
      const oriented = ensureWinding(rawPts, wantCCW)
      const rotated = params.startNear
        ? rotatePolylineNear(oriented, params.startNear.x, params.startNear.y)
        : oriented

      // Place the start at the midpoint of the first edge rather than on a corner.
      // rotatePolylineNear starts the path at a vertex; corner-rounding then displaces that
      // point onto the fillet, so the loops (which start/end at the rounded p0) no longer
      // meet the finishing pass (which follows the exact wall). A mid-edge point is collinear
      // — roundPolygonCorners preserves it verbatim — so both paths share an identical start
      // point and connect cleanly, and the original start corner now gets rounded like the rest.
      const startList: Pt2[] = [
        [(rotated[0][0] + rotated[1][0]) / 2, (rotated[0][1] + rotated[1][1]) / 2],
        ...rotated.slice(1),
        rotated[0],
      ]
      const smoothed = roundPolygonCorners(startList, cornerR)

      // Close polyline for full loop traversal. `closed` (rounded corners) drives the
      // trochoidal loops; `closedExact` (true offset) is reserved for the finishing pass
      // so the finished wall holds its real, un-rounded corners. Both start at the same point.
      closed = [...smoothed, smoothed[0]]
      closedExact = [...startList, startList[0]]
    }

    const { lens, total } = arcLengths(closed)
    if (total < 1e-6) continue
    const tangentAt = makeTangentSampler(closed, lens, isOpen)

    // WHERE THE LOOPS SWING. Against a wall the guide path IS the wall and the swing runs
    // 0 → 2l into the material, so the finished wall is cut on every loop. A slot has no
    // wall: the line is its CENTRE, so the swing runs −l → +l about it and the slot comes
    // out 2l + tool wide, centred on the line that was drawn. Getting this wrong does not
    // fail, it just cuts the slot a full amplitude off to one side.
    const offsetOf = isOpen
      ? (theta: number) => -l * Math.cos(theta)
      : (theta: number) => l * (1 - Math.cos(theta))
    const entryOffset = offsetOf(0)

    // Tab ranges (same design-path t → offset-path arc-length mapping as
    // profile.ts). Two range sets: the loop guide path (`closed`, corners
    // rounded) widened by the loop amplitude — during a loop the tool wanders
    // up to ~l along-path from its guide position — and the exact wall path
    // for the finishing pass.
    const tabRanges: { start: number; end: number; tabZ: number }[] = []
    const exactLens = arcLengths(closedExact)
    const tabRangesExact: { start: number; end: number; tabZ: number }[] = []
    if (tabs && tabs.length > 0) {
      for (const tab of tabs) {
        const pos = designPathAtT(designSubs, tab.t)
        if (!pos) continue
        const tabZ = Math.min(0, -params.depthMM + tab.heightMM)
        const half = tab.lengthMM / 2 + tool.diameterMM / 2
        const center = nearestArcLen(closed, lens, pos[0], pos[1])
        tabRanges.push({ start: center - half - l, end: center + half + l, tabZ })
        const centerExact = nearestArcLen(closedExact, exactLens.lens, pos[0], pos[1])
        tabRangesExact.push({ start: centerExact - half, end: centerExact + half, tabZ })
      }
    }

    const nLoops = Math.floor(total / w)
    if (nLoops === 0) continue

    // Start: where θ = 0 actually puts the tool. On a wall that is the guide path itself
    // (offset 0); in a centred slot it is one amplitude to the side, so the entry plunge
    // has to be there and not on the line.
    const [g0x, g0y] = closed[0]
    const [t0x, t0y] = tangentAt(0)
    const p0x = g0x + entryOffset * perpSign * (-t0y)
    const p0y = g0y + entryOffset * perpSign * t0x

    // Ramp spans 2× tool diameter of arc-length advance, split into rampLoops full loops.
    // Matches profile.ts ramp distance convention.
    const rampLoops = params.rampIn
      ? Math.max(1, Math.ceil((2 * tool.diameterMM) / w))
      : 0
    const rampSteps = rampLoops * STEPS

    segs.push({ x: p0x, y: p0y, z: safeZ, rapid: true })

    for (let pi = 0; pi < passes.length; pi++) {
      const zDepth = passes[pi]
      const rampStartZ = pi === 0 ? 0 : passes[pi - 1]
      // Tabs only constrain passes that cut below the tab top
      const activeRanges = tabRanges.filter((tr) => zDepth < tr.tabZ)
      const inTabRange = (s: number) => activeRanges.some((tr) => s >= tr.start && s <= tr.end)

      if (params.rampIn) {
        // Rapid to ramp start Z (surface on first pass, previous depth thereafter).
        // This mirrors profile.ts's ramp entry: position without a full retract on pi > 0.
        segs.push({ x: p0x, y: p0y, z: rampStartZ, rapid: true })
      } else {
        // Straight plunge to depth.
        segs.push({ x: p0x, y: p0y, z: zDepth, rapid: false })
      }

      // Prolate cycloid along the curved offset path.
      // advance(θ) = r*θ - l*sin(θ)   — forward arc-length along the offset path
      // offset(θ)  = l*(1-cos(θ))     — lateral swing: 0 at wall, 2l at peak, 0 at wall
      // The outward perpendicular at each arc-length s is derived from the path tangent.
      for (let i = 1; i <= nLoops * STEPS; i++) {
        const theta = i * (2 * Math.PI / STEPS)
        const advance = r * theta - l * Math.sin(theta)
        const s = Math.min(advance, total)
        const offsetVal = offsetOf(theta)

        const [cx, cy] = interpPt(closed, lens, s)
        const [tx, ty] = tangentAt(s)
        // Outward perpendicular — same sign convention as generateTrochoidalRow in pocket.ts.
        const px = perpSign * (-ty)
        const py = perpSign * tx

        // During ramp: Z descends linearly over the first rampSteps; feedScale 0.5 matches profile.ts.
        let z = zDepth
        let feedScale: number | undefined
        if (params.rampIn && i <= rampSteps) {
          z = rampStartZ + (zDepth - rampStartZ) * (i / rampSteps)
          feedScale = 0.5
        }
        // Lift the whole loop over tab zones — the tab bridges the kerf, so
        // any cutting there below tab height would sever it.
        if (activeRanges.length > 0 && inTabRange(s)) {
          const tabZ = activeRanges.find((tr) => s >= tr.start && s <= tr.end)!.tabZ
          if (z < tabZ) z = tabZ
        }

        const seg: MotionSegment = { x: cx + offsetVal * px, y: cy + offsetVal * py, z, rapid: false }
        if (feedScale !== undefined) seg.feedScale = feedScale
        segs.push(seg)
      }

      if (!isOpen) {
        // Return to start to close the loop at full depth (lifted if a tab
        // covers the start of the guide path).
        const startTab = activeRanges.find((tr) => 0 >= tr.start && 0 <= tr.end)
        segs.push({ x: p0x, y: p0y, z: startTab ? Math.max(zDepth, startTab.tabZ) : zDepth, rapid: false })
      }

      // Optional finishing pass: one clean sweep along the offset path.
      // With active tabs, use the generic tab-lifting polyline pass instead of
      // arc fitting (same trade-off as profile.ts — arcs can't carry Z-lifts;
      // gcode.ts re-fits arcs between the tabs).
      if (params.finishingPass) {
        const activeExact = tabRangesExact.filter((tr) => zDepth < tr.tabZ)
        if (isOpen) {
          // A SLOT'S FINISH IS ITS TWO WALLS, not its centreline. Against a wall the
          // roughing loops swing outward from the exact path, so a sweep along that path
          // is a real cut; in a centred slot they swing to BOTH sides of the line and
          // clear right across it, so the same sweep cuts nothing but air. The walls are
          // the two things left scalloped, at ±l — and one Clipper ring round the stroke
          // is both of them plus the ends, in a single pass.
          for (const loop of inflatePathsD(
            [closedExact.map(([x, y]) => ({ x, y }))], l, JoinType.Round, EndType.Butt, 4, 6)) {
            const raw = stripClosingDuplicate(loop.map(({ x, y }) => [x, y] as Pt2))
            if (raw.length < 3) continue
            // Start the ring at whatever point is nearest the tool. The loops end at the
            // far END of the stroke, not back at their own start the way a closed pass
            // does, so without this the link into the finish is a cut straight across the
            // work — which is the diagonal that showed up on a 3-point path.
            const here = segs[segs.length - 1]
            const rot = rotatePolylineNear(raw, here.x, here.y)
            const ring: Pt2[] = [...rot, rot[0]]
            // arcFitPolyline and polylinePassWithTabs both SKIP their first point, on the
            // assumption the tool is already standing on it. Here it is not, so the move
            // onto the ring has to be made explicitly.
            segs.push({ x: ring[0][0], y: ring[0][1], z: zDepth, rapid: false })
            if (activeExact.length > 0) {
              // The ring passes every tab TWICE, once up each wall, so a lift decided by
              // arc length ALONG THE RING would protect one side and cut the other. Each
              // point is projected back onto the design line instead.
              for (let i = 1; i < ring.length; i++) {
                const [rx, ry] = ring[i]
                const at = nearestArcLen(closedExact, exactLens.lens, rx, ry)
                const tab = activeExact.find((tr) => at >= tr.start && at <= tr.end)
                segs.push({ x: rx, y: ry, z: tab ? Math.max(zDepth, tab.tabZ) : zDepth, rapid: false })
              }
            } else {
              for (const seg of arcFitPolyline(ring, 0.1)) {
                segs.push({ x: seg.x, y: seg.y, z: zDepth, rapid: false, ...(seg.arc ? { arc: seg.arc } : {}) })
              }
            }
          }
        } else if (activeExact.length > 0) {
          pushAll(segs, polylinePassWithTabs(closedExact, zDepth, activeExact, exactLens.lens))
        } else {
          const arcSegs = arcFitPolyline(closedExact, 0.1)
          for (const s of arcSegs) {
            segs.push({ x: s.x, y: s.y, z: zDepth, rapid: false, ...(s.arc ? { arc: s.arc } : {}) })
          }
        }
      }

      // A closed loop finishes where it started, so the next pass just plunges again. A
      // stroke finishes at the far end: lift, and return over the slot rather than back
      // through it, so the next pass starts from the same end as this one did.
      if (isOpen && pi < passes.length - 1) {
        segs.push({ x: segs[segs.length - 1].x, y: segs[segs.length - 1].y, z: safeZ, rapid: true })
        segs.push({ x: p0x, y: p0y, z: safeZ, rapid: true })
      }
    }

    const [lastX, lastY] = isOpen ? [segs[segs.length - 1].x, segs[segs.length - 1].y] : [p0x, p0y]
    segs.push({ x: lastX, y: lastY, z: safeZ, rapid: true })
  }

  return segs
}
