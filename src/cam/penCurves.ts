import type { PenNode } from '../store/uiStore'

export type PenCurveType = 'linear' | 'bezier' | 'catmull-rom' | 'cubic-spline' | 'arc-fit'

type Pt = { x: number; y: number }

function catmullRomHandles(p0: Pt, p1: Pt, p2: Pt, p3: Pt): { cp1: Pt; cp2: Pt } {
  return {
    cp1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
    cp2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
  }
}

function cubicSplineDerivatives(pts: Pt[]): Pt[] {
  const n = pts.length
  if (n < 2) return pts.map(() => ({ x: 0, y: 0 }))
  if (n === 2) {
    const d = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y }
    return [d, d]
  }

  const bx = new Array<number>(n), cx = new Array<number>(n), rhsx = new Array<number>(n)
  const by = new Array<number>(n), cy = new Array<number>(n), rhsy = new Array<number>(n)

  bx[0] = 2; cx[0] = 1; rhsx[0] = 3 * (pts[1].x - pts[0].x)
  by[0] = 2; cy[0] = 1; rhsy[0] = 3 * (pts[1].y - pts[0].y)
  for (let i = 1; i < n - 1; i++) {
    bx[i] = 4; cx[i] = 1; rhsx[i] = 3 * (pts[i + 1].x - pts[i - 1].x)
    by[i] = 4; cy[i] = 1; rhsy[i] = 3 * (pts[i + 1].y - pts[i - 1].y)
  }
  bx[n-1] = 2; cx[n-1] = 0; rhsx[n-1] = 3 * (pts[n-1].x - pts[n-2].x)
  by[n-1] = 2; cy[n-1] = 0; rhsy[n-1] = 3 * (pts[n-1].y - pts[n-2].y)

  for (let i = 1; i < n; i++) {
    const wx = 1 / bx[i-1]; bx[i] -= wx * cx[i-1]; rhsx[i] -= wx * rhsx[i-1]
    const wy = 1 / by[i-1]; by[i] -= wy * cy[i-1]; rhsy[i] -= wy * rhsy[i-1]
  }
  const dx = new Array<number>(n), dy = new Array<number>(n)
  dx[n-1] = rhsx[n-1] / bx[n-1]; dy[n-1] = rhsy[n-1] / by[n-1]
  for (let i = n-2; i >= 0; i--) {
    dx[i] = (rhsx[i] - cx[i] * dx[i+1]) / bx[i]
    dy[i] = (rhsy[i] - cy[i] * dy[i+1]) / by[i]
  }
  return dx.map((x, i) => ({ x, y: dy[i] }))
}


function autoCurveHandles(
  pts: Pt[],
  isCorner: boolean[],
  curveType: 'catmull-rom' | 'cubic-spline',
  closed?: boolean,
  lookahead?: Pt,
): { cp1s: Pt[]; cp2s: Pt[] } {
  const n = pts.length
  const cp1s: Pt[] = []
  const cp2s: Pt[] = []
  const segCount = n - 1 + (closed ? 1 : 0)

  let derivs: Pt[] | null = null
  if (curveType === 'cubic-spline') {
    const solvePts = (!closed && lookahead) ? [...pts, lookahead] : pts
    derivs = cubicSplineDerivatives(solvePts)
  }

  for (let i = 0; i < segCount; i++) {
    const i1 = (i + 1) % n

    // Only the END node being a corner forces a straight line — the segment arriving at it
    // was previewed as linear. The START being a corner means the previous segment was
    // linear; the outgoing arc starts fresh using a ghost p0 (reflected through the corner)
    // so it isn't pulled by the direction of the incoming straight line.
    if (isCorner[i1]) {
      cp1s.push(pts[i]); cp2s.push(pts[i1])
      continue
    }

    if (curveType === 'catmull-rom') {
      const ghostP0 = { x: 2 * pts[i].x - pts[i1].x, y: 2 * pts[i].y - pts[i1].y }
      const p0 = isCorner[i]
        ? ghostP0
        : closed
          ? pts[(i - 1 + n) % n]
          : i > 0 ? pts[i - 1] : { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y }
      const isLastOpenSeg = !closed && i === n - 2
      const p3 = closed
        ? pts[(i + 2) % n]
        : i < n - 2 ? pts[i + 2]
        : (isLastOpenSeg && lookahead) ? lookahead
        : { x: 2 * pts[n-1].x - pts[n-2].x, y: 2 * pts[n-1].y - pts[n-2].y }
      const { cp1, cp2 } = catmullRomHandles(p0, pts[i], pts[i1], p3)
      cp1s.push(cp1); cp2s.push(cp2)
    } else if (curveType === 'cubic-spline' && derivs) {
      // Corner-start: override cp1 with a 1/3-forward handle so the curve leaves the
      // corner cleanly without inheriting the globally-solved derivative (which still
      // factors in the pre-corner linear segment).
      const cp1 = isCorner[i]
        ? { x: pts[i].x + (pts[i1].x - pts[i].x) / 3, y: pts[i].y + (pts[i1].y - pts[i].y) / 3 }
        : { x: pts[i].x + derivs[i].x / 3, y: pts[i].y + derivs[i].y / 3 }
      cp1s.push(cp1)
      cp2s.push({ x: pts[i1].x - derivs[i1].x / 3, y: pts[i1].y - derivs[i1].y / 3 })
    }
  }

  return { cp1s, cp2s }
}

// Draws the arc from p0 to p1 on the circle through (p0, p1, p2), in the
// rotational direction established by the p0→p2 arc that contains p1.
// The lookahead p2 shapes the curvature but is not reached — only p0→p1 is drawn.
// Mirrors catmull-rom's lookahead pattern: the last committed segment live-reshapes
// as the cursor moves, and placing a point commits exactly what was previewed.
function arcSegmentForwardLookahead(p0: Pt, p1: Pt, p2: Pt): string {
  const { x: ax, y: ay } = p0
  const { x: bx, y: by } = p1
  const { x: cx, y: cy } = p2

  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(D) < 1e-8) return ` L ${bx} ${by}`

  const a2 = ax*ax+ay*ay, b2 = bx*bx+by*by, c2 = cx*cx+cy*cy
  const ox = (a2*(by-cy) + b2*(cy-ay) + c2*(ay-by)) / D
  const oy = (a2*(cx-bx) + b2*(ax-cx) + c2*(bx-ax)) / D
  const R = Math.hypot(ax - ox, ay - oy)

  const alpha = Math.atan2(ay - oy, ax - ox)  // angle of p0 (arc start)
  const beta  = Math.atan2(by - oy, bx - ox)  // angle of p1 (arc end)
  const gamma = Math.atan2(cy - oy, cx - ox)  // angle of p2 (lookahead)

  // Determine CW/CCW from the full p0→p2 arc direction (which contains p1)
  const dAngleCCWFull = (gamma - alpha + 2 * Math.PI) % (2 * Math.PI)
  const betaNorm      = (beta  - alpha + 2 * Math.PI) % (2 * Math.PI)
  const fullDAngle = betaNorm <= dAngleCCWFull ? dAngleCCWFull : dAngleCCWFull - 2 * Math.PI
  const sign = fullDAngle >= 0 ? 1 : -1

  // Sub-arc from alpha (p0) to beta (p1) in the established direction
  const dAngle = sign > 0
    ? (beta - alpha + 2 * Math.PI) % (2 * Math.PI)
    : -(((alpha - beta) + 2 * Math.PI) % (2 * Math.PI))

  if (Math.abs(dAngle) < 1e-8) return ''

  const nSegs = Math.max(1, Math.ceil(Math.abs(dAngle) / (Math.PI / 2)))
  const step = dAngle / nSegs
  const k = (4 / 3) * Math.tan(Math.abs(step) / 4)

  let d = ''
  for (let i = 0; i < nSegs; i++) {
    const a0 = alpha + i * step
    const a1 = alpha + (i + 1) * step
    const x0 = ox + R * Math.cos(a0), y0 = oy + R * Math.sin(a0)
    const x1 = ox + R * Math.cos(a1), y1 = oy + R * Math.sin(a1)
    d += ` C ${x0 + k*R*(-sign*Math.sin(a0))} ${y0 + k*R*(sign*Math.cos(a0))} ${x1 - k*R*(-sign*Math.sin(a1))} ${y1 - k*R*(sign*Math.cos(a1))} ${x1} ${y1}`
  }
  return d
}

// Draws the arc from p1 to p2 on the circle through (p0, p1, p2), continuing
// in the p0→p1→p2 direction. Used for the live preview segment: the committed
// path already drew p0→p1 live, so the dashed preview only needs p1→p2.
function arcSegmentContinuation(p0: Pt, p1: Pt, p2: Pt): string {
  const { x: ax, y: ay } = p0
  const { x: bx, y: by } = p1
  const { x: cx, y: cy } = p2

  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(D) < 1e-8) return ` L ${cx} ${cy}`

  const a2 = ax*ax+ay*ay, b2 = bx*bx+by*by, c2 = cx*cx+cy*cy
  const ox = (a2*(by-cy) + b2*(cy-ay) + c2*(ay-by)) / D
  const oy = (a2*(cx-bx) + b2*(ax-cx) + c2*(bx-ax)) / D
  const R = Math.hypot(bx - ox, by - oy)

  const alpha = Math.atan2(ay - oy, ax - ox)
  const gamma = Math.atan2(by - oy, bx - ox)
  const beta  = Math.atan2(cy - oy, cx - ox)

  const dAngleCCW = (beta - alpha + 2 * Math.PI) % (2 * Math.PI)
  const gammaNorm = (gamma - alpha + 2 * Math.PI) % (2 * Math.PI)
  const fullDAngle = gammaNorm <= dAngleCCW ? dAngleCCW : dAngleCCW - 2 * Math.PI
  const sign = fullDAngle >= 0 ? 1 : -1

  const dAngle = sign > 0
    ? (beta - gamma + 2 * Math.PI) % (2 * Math.PI)
    : -(((gamma - beta) + 2 * Math.PI) % (2 * Math.PI))

  if (Math.abs(dAngle) < 1e-8) return ''

  const nSegs = Math.max(1, Math.ceil(Math.abs(dAngle) / (Math.PI / 2)))
  const step = dAngle / nSegs
  const k = (4 / 3) * Math.tan(Math.abs(step) / 4)

  let d = ''
  for (let i = 0; i < nSegs; i++) {
    const a0 = gamma + i * step
    const a1 = gamma + (i + 1) * step
    const x0 = ox + R * Math.cos(a0), y0 = oy + R * Math.sin(a0)
    const x1 = ox + R * Math.cos(a1), y1 = oy + R * Math.sin(a1)
    d += ` C ${x0 + k*R*(-sign*Math.sin(a0))} ${y0 + k*R*(sign*Math.cos(a0))} ${x1 - k*R*(-sign*Math.sin(a1))} ${y1 - k*R*(sign*Math.cos(a1))} ${x1} ${y1}`
  }
  return d
}

// Arc-fit forward-lookahead scheme (mirrors catmull-rom):
// Segment i→i+1 is curved using nodes[i+2] (or lookahead for the last segment)
// to determine the circle. This means the last segment live-reshapes as the cursor
// moves, and clicking commits it exactly as previewed — no jump on placement.
function penNodesToPathDArcFit(nodes: PenNode[], closed?: boolean, lookahead?: Pt): string {
  const n = nodes.length
  if (n < 1) return ''
  let d = `M ${nodes[0].x} ${nodes[0].y}`
  if (n < 2) return d

  for (let i = 0; i < n - 1; i++) {
    const p0 = nodes[i]
    const p1 = nodes[i + 1]
    if (p1.corner) {
      d += ` L ${p1.x} ${p1.y}`
      continue
    }
    const pNext: Pt | undefined = i + 2 < n
      ? nodes[i + 2]
      : closed ? nodes[(i + 2) % n] : lookahead
    if (pNext) {
      d += arcSegmentForwardLookahead(p0, p1, pNext)
    } else if (i > 0) {
      d += arcSegmentContinuation(nodes[i - 1], p0, p1)
    } else {
      d += ` L ${p1.x} ${p1.y}`
    }
  }

  if (closed && n >= 3) {
    const p0 = nodes[n - 1], p1 = nodes[0]
    if (p1.corner) {
      d += ' Z'
    } else {
      d += arcSegmentForwardLookahead(p0, p1, nodes[1 % n])
      d += ' Z'
    }
  }

  return d
}

export function penNodesToPathD(nodes: PenNode[], closed?: boolean, curveType: PenCurveType = 'bezier', lookahead?: Pt): string {
  if (nodes.length < 1) return ''
  const n = nodes.length

  if (curveType === 'linear') {
    let d = `M ${nodes[0].x} ${nodes[0].y}`
    for (let i = 1; i < n; i++) d += ` L ${nodes[i].x} ${nodes[i].y}`
    if (closed && n >= 2) d += ' Z'
    return d
  }

  if (curveType === 'bezier') {
    let d = `M ${nodes[0].x} ${nodes[0].y}`
    for (let i = 1; i < n; i++) {
      const prev = nodes[i - 1], curr = nodes[i]
      if (curr.corner) { d += ` L ${curr.x} ${curr.y}`; continue }
      const cp1 = prev.outHandle, cp2 = curr.inHandle
      if (!cp1 && !cp2) d += ` L ${curr.x} ${curr.y}`
      else d += ` C ${cp1?.x ?? prev.x} ${cp1?.y ?? prev.y} ${cp2?.x ?? curr.x} ${cp2?.y ?? curr.y} ${curr.x} ${curr.y}`
    }
    if (closed && n >= 2) {
      const prev = nodes[n-1], curr = nodes[0]
      if (curr.corner) { d += ' Z' }
      else {
        const cp1 = prev.outHandle, cp2 = curr.inHandle
        if (!cp1 && !cp2) d += ' Z'
        else d += ` C ${cp1?.x ?? prev.x} ${cp1?.y ?? prev.y} ${cp2?.x ?? curr.x} ${cp2?.y ?? curr.y} ${curr.x} ${curr.y} Z`
      }
    }
    return d
  }

  if (curveType === 'arc-fit') return penNodesToPathDArcFit(nodes, closed, lookahead)

  // catmull-rom / cubic-spline
  if (n < 2) return `M ${nodes[0].x} ${nodes[0].y}`
  const pts = nodes.map(nd => ({ x: nd.x, y: nd.y }))
  const isCorner = nodes.map(nd => !!nd.corner)
  const { cp1s, cp2s } = autoCurveHandles(pts, isCorner, curveType as 'catmull-rom' | 'cubic-spline', closed, lookahead)

  let d = `M ${nodes[0].x} ${nodes[0].y}`
  const segCount = n - 1 + (closed ? 1 : 0)
  for (let i = 0; i < segCount; i++) {
    const i1 = (i + 1) % n
    const next = nodes[i1]
    const cp1 = cp1s[i], cp2 = cp2s[i]
    const isLast = closed && i === segCount - 1
    const isLine =
      Math.abs(cp1.x - nodes[i].x) < 0.001 && Math.abs(cp1.y - nodes[i].y) < 0.001 &&
      Math.abs(cp2.x - next.x) < 0.001 && Math.abs(cp2.y - next.y) < 0.001
    if (isLine) {
      d += isLast ? ' Z' : ` L ${next.x} ${next.y}`
    } else {
      d += ` C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${next.x} ${next.y}`
      if (isLast) d += ' Z'
    }
  }
  return d
}

// Preview segment from the last committed node to the cursor.
// Arc-fit uses parity to alternate between through-point (line) and arc-endpoint (arc) previews.
export function liveSegmentD(
  nodes: PenNode[],
  to: Pt,
  toInHandle: Pt | undefined,
  curveType: PenCurveType,
): string {
  if (nodes.length === 0) return ''
  const from = nodes[nodes.length - 1]

  if (curveType === 'linear') return `M ${from.x} ${from.y} L ${to.x} ${to.y}`

  if (curveType === 'bezier') {
    const cp1 = from.outHandle, cp2 = toInHandle
    if (!cp1 && !cp2) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
    return `M ${from.x} ${from.y} C ${cp1?.x ?? from.x} ${cp1?.y ?? from.y} ${cp2?.x ?? to.x} ${cp2?.y ?? to.y} ${to.x} ${to.y}`
  }

  if (curveType === 'arc-fit') {
    const n = nodes.length
    if (n >= 2) {
      // The committed path already drew nodes[n-2]→nodes[n-1] live-reshaped by the cursor.
      // Preview only needs the continuation from nodes[n-1] to cursor on the same circle.
      // After a corner, nodes[n-2] was reached by a straight line so it's a misleading
      // reference — mirror it through the corner so the arc leaves in a fresh direction.
      const ref = nodes[n - 1].corner
        ? { x: 2 * from.x - nodes[n - 2].x, y: 2 * from.y - nodes[n - 2].y }
        : nodes[n - 2]
      return `M ${from.x} ${from.y}${arcSegmentContinuation(ref, from, to)}`
    }
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
  }

  // catmull-rom / cubic-spline
  // After a corner the outgoing preview uses a ghost p0 (mirrored through the corner)
  // so the curve leaves cleanly instead of being pulled by the pre-corner direction.
  const n = nodes.length
  const p1: Pt = { x: from.x, y: from.y }
  const p2 = to
  const ghost: Pt = { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y }
  const p0 = from.corner
    ? { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y }
    : n >= 2
      ? { x: nodes[n-2].x, y: nodes[n-2].y }
      : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y }
  const { cp1, cp2 } = catmullRomHandles(p0, p1, p2, ghost)
  return `M ${from.x} ${from.y} C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${to.x} ${to.y}`
}
