import { zPasses } from './geom'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

export interface DrillPoint {
  x: number
  y: number
}

export interface DrillParams {
  depthMM: number
  stepDownMM: number
  startNear?: { x: number; y: number }
  safeHeightMM?: number
  /** Surface the hole starts from (0 = stock top, negative = the floor an earlier op
   *  left). `depthMM` is measured from here, exactly as it is for a profile — without
   *  it a hole drilled in a pocket came out that pocket's depth too shallow. */
  startZMM?: number
}

/** A hole to bore: where it is and how big it is. */
export interface HoleSpec {
  cx: number
  cy: number
  radiusMM: number
}

function nearestNeighbourOrder<T extends DrillPoint>(pts: T[], startX: number, startY: number): T[] {
  const remaining = [...pts]
  const ordered: T[] = []
  let cx = startX, cy = startY
  while (remaining.length > 0) {
    let bestIdx = 0, bestDist = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = (remaining[i].x - cx) ** 2 + (remaining[i].y - cy) ** 2
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    ordered.push(remaining[bestIdx])
    cx = remaining[bestIdx].x; cy = remaining[bestIdx].y
    remaining.splice(bestIdx, 1)
  }
  return ordered
}

export function generatePeckDrill(
  points: DrillPoint[],
  _tool: Tool,
  params: DrillParams
): MotionSegment[] {
  if (points.length === 0) throw new Error('No drill points specified')
  const safeZ = params.safeHeightMM ?? 5
  const startZ = Math.min(0, params.startZMM ?? 0)
  const zLevels = zPasses(params.depthMM, params.stepDownMM, startZ)
  const segs: MotionSegment[] = []

  const ordered = params.startNear
    ? nearestNeighbourOrder(points, params.startNear.x, params.startNear.y)
    : points

  for (const pt of ordered) {
    segs.push({ x: pt.x, y: pt.y, z: safeZ, rapid: true })
    for (let i = 0; i < zLevels.length; i++) {
      segs.push({ x: pt.x, y: pt.y, z: zLevels[i], rapid: false })
      // Between pecks, back out to the surface being drilled FROM — the chip break,
      // which is about clearing the flutes, not about reaching stock top.
      const retractZ = i < zLevels.length - 1 ? startZ : safeZ
      segs.push({ x: pt.x, y: pt.y, z: retractZ, rapid: true })
    }
  }

  return segs
}

// Helical drilling: spiral down at the innermost radius (G3/CCW arc), then a
// flat Archimedean spiral outward (chained semicircular G3 arcs) ending with
// one full circle at the wall, so the finished wall only sees a light cut and
// the cutter never plunges radially into fresh stock.
// helicalRadius = holeRadius - tool.diameterMM / 2 (must be > 0)
export function generateHelicalDrill(
  centerX: number,
  centerY: number,
  helicalRadius: number,
  tool: Tool,
  params: DrillParams
): MotionSegment[] {
  if (helicalRadius <= 0) {
    // Tool is larger than the hole — fall back to peck drilling at center
    return generatePeckDrill([{ x: centerX, y: centerY }], tool, params)
  }

  const safeZ = params.safeHeightMM ?? 5
  const startZ = Math.min(0, params.startZMM ?? 0)
  const zLevels = zPasses(params.depthMM, params.stepDownMM, startZ)
  const stepoverMM = tool.diameterMM * 0.4

  // Helix radius: just under the tool radius so the helical bore clears its
  // own core (no center plunge needed). Holes up to ~2× tool diameter helix
  // directly at the wall radius.
  const r0 = Math.min(helicalRadius, tool.diameterMM * 0.475)

  // Spiral pitch: radius growth per revolution, ≤ stepover, sized so a whole
  // number of revolutions lands exactly on the wall radius.
  const span = helicalRadius - r0
  const nRevs = span > 1e-9 ? Math.ceil(span / stepoverMM) : 0
  const pitch = nRevs > 0 ? span / nRevs : 0

  // Start point: rightmost point of helix circle (I = -r, J = 0 → clean G-code)
  const sx = centerX + r0

  const segs: MotionSegment[] = []
  segs.push({ x: sx, y: centerY, z: safeZ, rapid: true })

  // The first helix starts at the surface the hole is drilled from, not at safe
  // height: everything above that surface is air (or a floor an earlier op cut), so
  // ramping through it on the arc is a wasted revolution.
  segs.push({ x: sx, y: centerY, z: startZ, rapid: true })
  let prevZ = startZ
  let firstPass = true

  for (const zDepth of zLevels) {
    // Between passes the machine is at the wall. Feed back to the helix start
    // at the same Z (through already-cleared stock) before descending.
    if (!firstPass) {
      segs.push({ x: sx, y: centerY, z: prevZ, rapid: false })
    }
    firstPass = false

    // Helical descent: one full CCW revolution from prevZ down to zDepth (G3).
    segs.push({ x: sx, y: centerY, z: zDepth, rapid: false, arc: { cx: centerX, cy: centerY, cw: false } })
    prevZ = zDepth

    // Flat circle at r0 to flatten the ramp floor left by the helical descent.
    segs.push({ x: sx, y: centerY, z: zDepth, rapid: false, arc: { cx: centerX, cy: centerY, cw: false } })

    // Spiral outward to the wall as chained 180° G3 arcs: each semicircle grows
    // the radius by pitch/2, with centers alternating ±pitch/4 along the X axis
    // through the hole center. Junction points and both arc centers are
    // collinear, so tangents match — a smooth Archimedean spiral with no radial
    // plunge moves, two arcs of G-code per revolution.
    let r = r0
    let side = 1 // +1 = at right crossing (x = cx + r), −1 = at left crossing
    for (let k = 0; k < nRevs * 2; k++) {
      const rNext = r + pitch / 2
      segs.push({
        x: centerX - side * rNext, y: centerY, z: zDepth, rapid: false,
        arc: { cx: centerX - side * (pitch / 4), cy: centerY, cw: false },
      })
      r = rNext
      side = -side
    }

    // The spiral ends at the right crossing exactly on the wall radius; finish
    // with one full flat circle taking the light cut at the finished wall.
    segs.push({ x: centerX + helicalRadius, y: centerY, z: zDepth, rapid: false, arc: { cx: centerX, cy: centerY, cw: false } })
  }

  // Retract from the wall
  segs.push({ x: centerX + helicalRadius, y: centerY, z: safeZ, rapid: true })

  return segs
}

/**
 * Bore SEVERAL holes in one operation.
 *
 * One path is not one hole — a pinion's pin holes, a bolt circle, an SVG's circles
 * that came in as a single compound path are all N round subpaths under one id. So
 * the op holds a list, exactly as peck drilling holds a list of points, and each
 * hole gets its own complete helical bore.
 *
 * Ordered nearest-neighbour from `startNear`, the same as peck: the rapids between
 * holes are the only free choice here, and walking a bolt circle in emission order
 * is a needless trip across the part.
 *
 * A hole smaller than the tool falls back to a peck at its centre (see
 * `generateHelicalDrill`), so a mixed set still comes out drilled.
 */
export function generateHelicalDrills(
  holes: HoleSpec[],
  tool: Tool,
  params: DrillParams
): MotionSegment[] {
  if (holes.length === 0) throw new Error('No holes specified')
  const ordered = params.startNear
    ? nearestNeighbourOrder(holes.map((h) => ({ ...h, x: h.cx, y: h.cy })), params.startNear.x, params.startNear.y)
    : holes.map((h) => ({ ...h, x: h.cx, y: h.cy }))

  const segs: MotionSegment[] = []
  for (const h of ordered) {
    segs.push(...generateHelicalDrill(h.cx, h.cy, h.radiusMM - tool.diameterMM / 2, tool, params))
  }
  return segs
}
