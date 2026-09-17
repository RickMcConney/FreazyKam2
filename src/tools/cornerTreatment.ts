import type { PathNode } from '../canvas/nodeUtils'
import { parseDToNodes, nodesToD } from '../canvas/nodeUtils'

export type CornerTreatmentType = 'outerRound' | 'innerRound' | 'chamfer' | 'dogbone'

export interface CornerTreatmentParams {
  type: CornerTreatmentType
  radiusMM: number
}

export interface TreatableCorner {
  idx: number
  x: number
  y: number
}

function norm(x: number, y: number) {
  const len = Math.hypot(x, y)
  return len < 1e-10 ? { x: 0, y: 0 } : { x: x / len, y: y / len }
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

// Bezier handle length approximating a circular arc of given angle and radius
function arcHandle(angleDeg: number, r: number) {
  return (4 / 3) * Math.tan((angleDeg * Math.PI) / 720) * r
}

interface CornerGeom {
  tin: { x: number; y: number }
  tout: { x: number; y: number }
  theta: number
  cross: number
  dPrev: number
  dNext: number
}

// Geometry at node i if it is a treatable sharp corner, else null
function cornerGeom(nodes: PathNode[], closed: boolean, i: number): CornerGeom | null {
  const n = nodes.length
  const node = nodes[i]

  // Skip endpoints of open paths
  if (!closed && (i === 0 || i === n - 1)) return null

  // Only treat sharp (corner) nodes — no bezier handles
  if (node.handleIn || node.handleOut) return null

  const prev = nodes[(i - 1 + n) % n]
  const next = nodes[(i + 1) % n]

  // Tangent directions, accounting for adjacent bezier handles
  const tin = prev.handleOut
    ? norm(node.x - prev.handleOut.x, node.y - prev.handleOut.y)
    : norm(node.x - prev.x, node.y - prev.y)
  const tout = next.handleIn
    ? norm(next.handleIn.x - node.x, next.handleIn.y - node.y)
    : norm(next.x - node.x, next.y - node.y)

  if ((tin.x === 0 && tin.y === 0) || (tout.x === 0 && tout.y === 0)) return null

  // theta = angle between the two tangent vectors (0 = same dir, π = reversal)
  const dot = Math.max(-1, Math.min(1, tin.x * tout.x + tin.y * tout.y))
  const cross = tin.x * tout.y - tin.y * tout.x
  const theta = Math.acos(dot)

  if (theta < 0.05 || Math.PI - theta < 0.05) return null

  return { tin, tout, theta, cross, dPrev: dist2(prev, node), dNext: dist2(node, next) }
}

// Similarity transform (rotation + uniform scale + mirror + translation).
// mat is in Mat6 layout: x' = a·x + c·y + e, y' = b·x + d·y + f.
// All corner-treatment constructions are similarity-covariant, so a session
// snapshot transformed by mat (with radii × scale) reproduces the transformed
// treated shape exactly.
export interface SimilarityTransform {
  mat: [number, number, number, number, number, number]
  scale: number
}

// Similarity transform taking path a onto path b, or null when b is not a
// similarity image of a (non-uniform scale, skew, node edits, …).
// Tolerance covers the 1e-4 coordinate rounding of the d stringifiers.
export function pathSimilarityTransform(dA: string, dB: string): SimilarityTransform | null {
  const A = parseDToNodes(dA)
  const B = parseDToNodes(dB)
  if (A.closed !== B.closed || A.nodes.length !== B.nodes.length || A.nodes.length === 0) return null

  // Corresponding point pairs: anchors + handles (presence must match)
  const pa: { x: number; y: number }[] = []
  const pb: { x: number; y: number }[] = []
  for (let i = 0; i < A.nodes.length; i++) {
    const na = A.nodes[i], nb = B.nodes[i]
    if (!!na.handleIn !== !!nb.handleIn || !!na.handleOut !== !!nb.handleOut) return null
    pa.push(na); pb.push(nb)
    if (na.handleIn) { pa.push(na.handleIn); pb.push(nb.handleIn!) }
    if (na.handleOut) { pa.push(na.handleOut); pb.push(nb.handleOut!) }
  }

  const EPS = 1e-3
  const p0 = pa[0], q0 = pb[0]

  const verify = (a: number, b: number, c: number, d: number): SimilarityTransform | null => {
    const e = q0.x - (a * p0.x + c * p0.y)
    const f = q0.y - (b * p0.x + d * p0.y)
    for (let i = 0; i < pa.length; i++) {
      const px = a * pa[i].x + c * pa[i].y + e
      const py = b * pa[i].x + d * pa[i].y + f
      if (Math.abs(px - pb[i].x) > EPS || Math.abs(py - pb[i].y) > EPS) return null
    }
    const scale = Math.hypot(a, b)
    return scale > 1e-6 ? { mat: [a, b, c, d, e, f], scale } : null
  }

  // Reference vector: the pair farthest from p0, for best conditioning
  let k = -1, best = 0
  for (let i = 1; i < pa.length; i++) {
    const d2 = (pa[i].x - p0.x) ** 2 + (pa[i].y - p0.y) ** 2
    if (d2 > best) { best = d2; k = i }
  }
  if (k < 0 || best < 1e-12) return verify(1, 0, 0, 1) // degenerate: pure translation at most

  const vx = pa[k].x - p0.x, vy = pa[k].y - p0.y
  const wx = pb[k].x - q0.x, wy = pb[k].y - q0.y
  const L2 = vx * vx + vy * vy

  // Direct (rotation + scale): x' = a·x − b·y, y' = b·x + a·y
  let a = (vx * wx + vy * wy) / L2
  let b = (vx * wy - vy * wx) / L2
  const direct = verify(a, b, -b, a)
  if (direct) return direct

  // Reflected (mirror + rotation + scale): x' = a·x + b·y, y' = b·x − a·y
  a = (vx * wx - vy * wy) / L2
  b = (vx * wy + vy * wx) / L2
  return verify(a, b, b, -a)
}

// Apply a similarity transform to every anchor and handle of a path
export function transformPathBySimilarity(d: string, t: SimilarityTransform): string {
  const { nodes, closed } = parseDToNodes(d)
  const [a, b, c, dd, e, f] = t.mat
  const tp = (p: { x: number; y: number }) => ({ x: a * p.x + c * p.y + e, y: b * p.x + dd * p.y + f })
  const out: PathNode[] = nodes.map((n) => ({
    ...tp(n),
    ...(n.handleIn ? { handleIn: tp(n.handleIn) } : {}),
    ...(n.handleOut ? { handleOut: tp(n.handleOut) } : {}),
  }))
  return nodesToD(out, closed)
}

// Sharp corners of the path that a treatment can be applied to, for on-canvas picking
export function getTreatableCorners(d: string): TreatableCorner[] {
  const { nodes, closed } = parseDToNodes(d)
  if (nodes.length < 2) return []
  const corners: TreatableCorner[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (cornerGeom(nodes, closed, i)) corners.push({ idx: i, x: nodes[i].x, y: nodes[i].y })
  }
  return corners
}

// cornerIdxs: node indices (as reported by getTreatableCorners) to treat.
// Omitted or empty → treat every treatable corner.
export function applyCornerTreatment(d: string, params: CornerTreatmentParams, cornerIdxs?: readonly number[]): string {
  const idxs = cornerIdxs && cornerIdxs.length > 0 ? cornerIdxs : getTreatableCorners(d).map((c) => c.idx)
  return applyCornerTreatments(d, new Map(idxs.map((i) => [i, params])))
}

// Per-corner treatments applied in one pass; indices refer to nodes of `d`
export function applyCornerTreatments(d: string, treatmentByIdx: ReadonlyMap<number, CornerTreatmentParams>): string {
  const { nodes, closed } = parseDToNodes(d)
  if (nodes.length < 2) return d

  const n = nodes.length
  const newNodes: PathNode[] = []

  for (let i = 0; i < n; i++) {
    const node = nodes[i]

    const params = treatmentByIdx.get(i)
    const geom = params ? cornerGeom(nodes, closed, i) : null
    if (!params || !geom) {
      newNodes.push(node)
      continue
    }
    const { tin, tout, theta, cross, dPrev, dNext } = geom
    const r = Math.max(0.001, params.radiusMM)

    // ── Chamfer / Outer Round / Inner Round ───────────────────────────────────
    // Setback = r along each edge from the corner
    if (params.type !== 'dogbone') {
      const rc = Math.min(r, Math.min(dPrev, dNext) * 0.45)
      if (rc < 0.001) { newNodes.push(node); continue }

      const p1 = { x: node.x - tin.x * rc, y: node.y - tin.y * rc }
      const p2 = { x: node.x + tout.x * rc, y: node.y + tout.y * rc }

      // Exterior turn angle in degrees (how much direction changes at corner)
      const turnDeg = (Math.PI - theta) * (180 / Math.PI)
      const h = arcHandle(turnDeg, rc)

      switch (params.type) {
        case 'chamfer':
          newNodes.push({ x: p1.x, y: p1.y })
          newNodes.push({ x: p2.x, y: p2.y })
          break

        case 'outerRound':
          // Arc bulges away from the interior of the corner
          newNodes.push({ x: p1.x, y: p1.y, handleOut: { x: p1.x + tin.x * h, y: p1.y + tin.y * h } })
          newNodes.push({ x: p2.x, y: p2.y, handleIn: { x: p2.x - tout.x * h, y: p2.y - tout.y * h } })
          break

        case 'innerRound':
          // Arc bulges toward the interior of the corner (fillet / concave)
          newNodes.push({ x: p1.x, y: p1.y, handleOut: { x: p1.x + tout.x * h, y: p1.y + tout.y * h } })
          newNodes.push({ x: p2.x, y: p2.y, handleIn: { x: p2.x - tin.x * h, y: p2.y - tin.y * h } })
          break
      }
      continue
    }

    // ── Dogbone ───────────────────────────────────────────────────────────────
    // The dogbone circle is centered at C = N + bisector*r, where bisector points
    // into the "mouth" of the corner.  The circle has radius r and passes through N.
    // The circle also intersects the two edges at P_in and P_out, which are
    // diametrically opposite each other (setback = 2r·sin(θ/2) along each edge).
    // The path replaces the corner with: P_in → semicircle through N → P_out.
    {
      // Bisector = normalize(-t_in + t_out) points into the corner mouth
      const bx = -tin.x + tout.x, by = -tin.y + tout.y
      const bLen = Math.hypot(bx, by)
      if (bLen < 0.01) { newNodes.push(node); continue }
      const bisector = { x: bx / bLen, y: by / bLen }

      // Circle center
      const cx = node.x + bisector.x * r
      const cy = node.y + bisector.y * r

      // Distance along each edge from N to the circle intersection
      // Proof: since N is on the circle, |N - C| = r.  Edge direction tin.
      // Point on edge: N - tin*t.  Solve |(N - tin*t) - C|² = r².
      // → t² - 2(D·tin)t = 0 where D = N-C = -bisector*r
      // → t = 2·(D·tin) = 2·(-bisector·tin)·r = 2·r·sin(θ/2)
      const setback = 2 * r * Math.sin(theta / 2)

      // Skip if the setback would overrun the adjacent segments
      if (setback > dPrev * 0.9 || setback > dNext * 0.9) {
        newNodes.push(node)
        continue
      }

      const P_in  = { x: node.x - tin.x  * setback, y: node.y - tin.y  * setback }
      const P_out = { x: node.x + tout.x * setback, y: node.y + tout.y * setback }

      // The arc is a semicircle split into two 90° bezier arcs: P_in → N → P_out
      // Arc direction matches the corner turn direction (CCW turn → CCW arc)
      const dir = cross >= 0 ? 1 : -1   // +1 = CCW, -1 = CW

      const k = arcHandle(90, r)   // handle length for 90° arc

      // Tangent function on the circle at angle a, in the arc direction
      const arcTan = (a: number) => ({
        x: dir * -Math.sin(a),
        y: dir *  Math.cos(a),
      })

      const a_in  = Math.atan2(P_in.y  - cy, P_in.x  - cx)
      const a_N   = Math.atan2(node.y  - cy, node.x  - cx)
      const a_out = Math.atan2(P_out.y - cy, P_out.x - cx)

      const tIn  = arcTan(a_in)
      const tN   = arcTan(a_N)
      const tOut = arcTan(a_out)

      newNodes.push(
        // P_in: sharp entry from the incoming edge, departs along arc tangent
        {
          x: P_in.x, y: P_in.y,
          handleOut: { x: P_in.x + tIn.x * k, y: P_in.y + tIn.y * k },
        },
        // N: smooth midpoint of the semicircle
        {
          x: node.x, y: node.y,
          handleIn:  { x: node.x - tN.x * k, y: node.y - tN.y * k },
          handleOut: { x: node.x + tN.x * k, y: node.y + tN.y * k },
        },
        // P_out: arc arrives, sharp exit along the outgoing edge
        {
          x: P_out.x, y: P_out.y,
          handleIn: { x: P_out.x - tOut.x * k, y: P_out.y - tOut.y * k },
        },
      )
    }
  }

  return nodesToD(newNodes, closed)
}
