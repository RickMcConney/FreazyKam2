import { describe, it, expect } from 'vitest'
import { penNodesToPathD, liveSegmentD } from './penCurves'
import type { PenCurveType } from './penCurves'
import type { PenNode } from '../store/uiStore'

const N = (x: number, y: number, extra: Partial<PenNode> = {}): PenNode => ({ x, y, ...extra })

const TYPES: PenCurveType[] = ['linear', 'bezier', 'catmull-rom', 'cubic-spline', 'arc-fit']

// A zigzag: no three points collinear, so every curve type has something to do.
const ZIG = [N(0, 0), N(10, 10), N(20, 0), N(30, 10)]

type Pt = { x: number; y: number }

/**
 * The ON-CURVE points of a d string, in order — the M target and the endpoint of
 * each L or C. Control points are deliberately left out: they are off the curve
 * by construction, so including them would make "does the path go through the
 * points the user clicked" untestable.
 */
function onCurvePoints(d: string): Pt[] {
  const out: Pt[] = []
  const tokens = d.trim().split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'M' || t === 'L') { out.push({ x: +tokens[i + 1], y: +tokens[i + 2] }); i += 2 }
    else if (t === 'C') { out.push({ x: +tokens[i + 5], y: +tokens[i + 6] }); i += 6 }
    else if (t === 'Z') continue
  }
  return out
}

/** Every cubic in a d string, as its four control points. */
function cubics(d: string): [Pt, Pt, Pt, Pt][] {
  const out: [Pt, Pt, Pt, Pt][] = []
  const tokens = d.trim().split(/\s+/)
  let cur: Pt = { x: 0, y: 0 }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'M' || t === 'L') { cur = { x: +tokens[i + 1], y: +tokens[i + 2] }; i += 2 }
    else if (t === 'C') {
      const p1 = { x: +tokens[i + 1], y: +tokens[i + 2] }
      const p2 = { x: +tokens[i + 3], y: +tokens[i + 4] }
      const p3 = { x: +tokens[i + 5], y: +tokens[i + 6] }
      out.push([cur, p1, p2, p3])
      cur = p3
      i += 6
    }
  }
  return out
}

const bezierAt = ([p0, p1, p2, p3]: [Pt, Pt, Pt, Pt], t: number): Pt => {
  const u = 1 - t
  const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
  }
}

/** Does `pt` appear among `pts`, at or after index `from`? Returns its index, or −1. */
const indexOfPoint = (pts: Pt[], pt: Pt, from = 0, tol = 1e-6) =>
  pts.findIndex((p, i) => i >= from && Math.abs(p.x - pt.x) < tol && Math.abs(p.y - pt.y) < tol)

describe('penNodesToPathD — the contract every curve type keeps', () => {
  it('emits nothing for no nodes, and a bare move for one', () => {
    for (const t of TYPES) {
      expect(penNodesToPathD([], false, t)).toBe('')
      expect(penNodesToPathD([N(3, 4)], false, t)).toBe('M 3 4')
      expect(penNodesToPathD([N(3, 4)], true, t)).toBe('M 3 4')
    }
  })

  it('passes through every node the user clicked, in order', () => {
    // This is the whole promise of the pen tool: a node is a point that was
    // clicked, and every scheme here interpolates rather than approximating. A
    // curve type that merely came NEAR its nodes would still look plausible.
    for (const t of TYPES) {
      for (const closed of [false, true]) {
        const pts = onCurvePoints(penNodesToPathD(ZIG, closed, t))
        let from = 0
        for (const node of ZIG) {
          const at = indexOfPoint(pts, node, from)
          expect(at, `${t} closed=${closed} missed node ${node.x},${node.y}`).toBeGreaterThanOrEqual(0)
          from = at
        }
      }
    }
  })

  it('starts at the first node', () => {
    for (const t of TYPES) expect(penNodesToPathD(ZIG, false, t).startsWith('M 0 0')).toBe(true)
  })

  it('closes with Z only when asked to', () => {
    for (const t of TYPES) {
      expect(penNodesToPathD(ZIG, false, t).endsWith('Z')).toBe(false)
      expect(penNodesToPathD(ZIG, true, t).endsWith('Z')).toBe(true)
    }
  })

  it('writes only the uppercase absolute commands the rest of the app parses', () => {
    // ImportedPath.d is absolute and uppercase throughout, and arcs are written
    // as cubics — nothing downstream has to grow a case for a pen path.
    for (const t of TYPES) {
      for (const closed of [false, true]) {
        const d = penNodesToPathD(ZIG, closed, t)
        expect(d.replace(/e-?\d+/g, '')).not.toMatch(/[a-z]/)
        expect(d).not.toMatch(/\bA\b/)
      }
    }
  })

  it('never emits NaN, whatever the nodes do', () => {
    // Coincident, collinear and doubled-back points all reach the circle solves
    // and the spline solve; one NaN makes the whole path vanish with no error.
    const nasty: PenNode[][] = [
      [N(0, 0), N(0, 0), N(0, 0)],
      [N(0, 0), N(10, 0), N(20, 0), N(30, 0)],
      [N(0, 0), N(10, 0), N(0, 0)],
      [N(0, 0), N(1e-9, 0), N(10, 10)],
      [N(-5, -5), N(0, 0), N(5, 5), N(0, 0)],
    ]
    for (const t of TYPES) {
      for (const nodes of nasty) {
        for (const closed of [false, true]) {
          expect(penNodesToPathD(nodes, closed, t)).not.toMatch(/NaN|Infinity/)
        }
      }
    }
  })
})

describe('penNodesToPathD — linear', () => {
  it('is straight lines and nothing else', () => {
    expect(penNodesToPathD(ZIG, false, 'linear')).toBe('M 0 0 L 10 10 L 20 0 L 30 10')
    expect(penNodesToPathD(ZIG, true, 'linear')).toBe('M 0 0 L 10 10 L 20 0 L 30 10 Z')
  })
})

describe('penNodesToPathD — bezier', () => {
  it('draws a line when neither end carries a handle', () => {
    // A click with no drag is a corner point; two of them are a straight run.
    expect(penNodesToPathD([N(0, 0), N(10, 0)], false, 'bezier')).toBe('M 0 0 L 10 0')
  })

  it('uses the handles the user dragged, verbatim', () => {
    expect(penNodesToPathD([N(0, 0, { outHandle: { x: 3, y: 5 } }), N(10, 0, { inHandle: { x: 7, y: 5 } })], false, 'bezier'))
      .toBe('M 0 0 C 3 5 7 5 10 0')
  })

  it('falls back to the anchor for a missing half of the pair', () => {
    // One smooth node meeting one corner node: the absent handle collapses onto
    // its own anchor, which is the degenerate cubic that looks like a line into it.
    expect(penNodesToPathD([N(0, 0, { outHandle: { x: 3, y: 5 } }), N(10, 0)], false, 'bezier'))
      .toBe('M 0 0 C 3 5 10 0 10 0')
  })

  it('runs a straight line into a corner node whatever the handles say', () => {
    expect(penNodesToPathD([N(0, 0, { outHandle: { x: 3, y: 5 } }), N(10, 0, { corner: true, inHandle: { x: 7, y: 5 } })], false, 'bezier'))
      .toBe('M 0 0 L 10 0')
  })
})

describe('penNodesToPathD — catmull-rom', () => {
  it('takes each handle a sixth of the way along the neighbours\' chord', () => {
    // cp1 = p1 + (p2 − p0)/6. On the middle segment of the zigzag the neighbours
    // are (0,0) and (30,10), so the tangent is flat-ish and the numbers are exact.
    const [, mid] = cubics(penNodesToPathD(ZIG, false, 'catmull-rom'))
    expect(mid[1]).toEqual({ x: 10 + (20 - 0) / 6, y: 10 + (0 - 0) / 6 })
    expect(mid[2]).toEqual({ x: 20 - (30 - 10) / 6, y: 0 - (10 - 10) / 6 })
  })

  it('keeps collinear points on their line instead of bulging off it', () => {
    for (const [, p1, p2] of cubics(penNodesToPathD([N(0, 0), N(10, 0), N(20, 0), N(30, 0)], false, 'catmull-rom'))) {
      expect(p1.y).toBeCloseTo(0, 12)
      expect(p2.y).toBeCloseTo(0, 12)
    }
  })

  it('arrives at a corner on a straight line and leaves it fresh', () => {
    // Only the END node being a corner forces the line. The segment leaving it
    // uses a p0 reflected through the corner, so the outgoing curve is not
    // dragged round by the direction of the straight run that arrived.
    const d = penNodesToPathD([N(0, 0), N(10, 10, { corner: true }), N(20, 0), N(30, 10)], false, 'catmull-rom')
    expect(d.startsWith('M 0 0 L 10 10 C')).toBe(true)
    const [afterCorner] = cubics(d)
    // Reflected ghost p0 = 2·(10,10) − (20,0) = (0,20) → cp1 = (10,10) + ((20,0) − (0,20))/6.
    expect(afterCorner[1]).toEqual({ x: 10 + 20 / 6, y: 10 - 20 / 6 })
  })
})

describe('penNodesToPathD — cubic-spline', () => {
  it('keeps collinear points on their line', () => {
    for (const [, p1, p2] of cubics(penNodesToPathD([N(0, 0), N(10, 0), N(20, 0), N(30, 0)], false, 'cubic-spline'))) {
      expect(p1.y).toBeCloseTo(0, 12)
      expect(p2.y).toBeCloseTo(0, 12)
    }
  })

  it('is C1 — each segment leaves a node the way the last one arrived', () => {
    // The whole point of solving the tridiagonal system rather than taking local
    // tangents: the handles either side of an interior node are collinear with
    // it, so the curve has no kink there. Catmull-Rom gets this too, but the
    // spline is the one that would silently lose it to a bad solve.
    const segs = cubics(penNodesToPathD(ZIG, false, 'cubic-spline'))
    for (let i = 1; i < segs.length; i++) {
      const inTangent = { x: segs[i - 1][3].x - segs[i - 1][2].x, y: segs[i - 1][3].y - segs[i - 1][2].y }
      const outTangent = { x: segs[i][1].x - segs[i][0].x, y: segs[i][1].y - segs[i][0].y }
      expect(inTangent.x * outTangent.y - inTangent.y * outTangent.x).toBeCloseTo(0, 9)
    }
  })

  it('solves the natural-cubic-spline system, not just some smooth curve', () => {
    // C1 continuity above is structural — cp2[i] and cp1[i+1] are both built from
    // the same derivative, so it holds whatever the solve returns. What actually
    // pins the tridiagonal system is its own interior row:
    //
    //     d[i−1] + 4·d[i] + d[i+1] = 3·(p[i+1] − p[i−1])
    //
    // and the derivatives are recoverable from the emitted handles, since
    // cp1[i] = p[i] + d[i]/3.
    const nodes = [N(0, 0), N(10, 10), N(20, 0), N(30, 10), N(40, 4)]
    const segs = cubics(penNodesToPathD(nodes, false, 'cubic-spline'))
    const d = segs.map(([p0, p1]) => ({ x: 3 * (p1.x - p0.x), y: 3 * (p1.y - p0.y) }))
    // The last node's derivative comes off the far handle of the last segment.
    const [, , cp2Last, p3Last] = segs[segs.length - 1]
    d.push({ x: 3 * (p3Last.x - cp2Last.x), y: 3 * (p3Last.y - cp2Last.y) })

    for (let i = 1; i < nodes.length - 1; i++) {
      expect(d[i - 1].x + 4 * d[i].x + d[i + 1].x).toBeCloseTo(3 * (nodes[i + 1].x - nodes[i - 1].x), 8)
      expect(d[i - 1].y + 4 * d[i].y + d[i + 1].y).toBeCloseTo(3 * (nodes[i + 1].y - nodes[i - 1].y), 8)
    }
    // And its end rows, which are what make it NATURAL: zero second derivative
    // at both ends, i.e. 2·d[0] + d[1] = 3·(p[1] − p[0]) and its mirror.
    const n = nodes.length
    expect(2 * d[0].x + d[1].x).toBeCloseTo(3 * (nodes[1].x - nodes[0].x), 8)
    expect(d[n - 2].y + 2 * d[n - 1].y).toBeCloseTo(3 * (nodes[n - 1].y - nodes[n - 2].y), 8)
  })

  it('handles a two-node path without a solve', () => {
    expect(penNodesToPathD([N(0, 0), N(6, 6)], false, 'cubic-spline')).toBe('M 0 0 C 2 2 4 4 6 6')
  })
})

describe('penNodesToPathD — arc-fit', () => {
  it('puts the curve on the circle through the points', () => {
    // Four points on a 10 mm circle. The cubics are the standard k = (4/3)tan(θ/4)
    // arc approximation, so the mid-point of each must sit on the circle too —
    // that is what a wrong k would move, while leaving every endpoint correct.
    const nodes = [0, 60, 120, 180].map((a) => N(10 * Math.cos(a * Math.PI / 180), 10 * Math.sin(a * Math.PI / 180)))
    for (const seg of cubics(penNodesToPathD(nodes, false, 'arc-fit'))) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const p = bezierAt(seg, t)
        expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 3)
      }
    }
  })

  it('draws a straight line when the points are collinear', () => {
    // Three collinear points have no circle — the determinant collapses, and
    // without the guard every coordinate downstream would be NaN.
    expect(penNodesToPathD([N(0, 0), N(10, 0), N(20, 0), N(30, 0)], false, 'arc-fit'))
      .toBe('M 0 0 L 10 0 L 20 0 L 30 0')
  })

  it('runs a straight line into a corner node', () => {
    expect(penNodesToPathD([N(0, 0), N(10, 10, { corner: true }), N(20, 0), N(30, 10)], false, 'arc-fit')
      .startsWith('M 0 0 L 10 10 C')).toBe(true)
  })

  it('draws a line for a two-node path, having no third point to fit', () => {
    expect(penNodesToPathD([N(0, 0), N(5, 5)], false, 'arc-fit')).toBe('M 0 0 L 5 5')
  })
})

describe('liveSegmentD', () => {
  it('runs from the last committed node to the cursor, for every type', () => {
    for (const t of TYPES) {
      const d = liveSegmentD(ZIG, { x: 40, y: 0 }, undefined, t)
      expect(d.startsWith('M 30 10')).toBe(true)
      const pts = onCurvePoints(d)
      expect(pts[0]).toEqual({ x: 30, y: 10 })
      expect(pts[pts.length - 1].x).toBeCloseTo(40, 6)
      expect(pts[pts.length - 1].y).toBeCloseTo(0, 6)
    }
  })

  it('has nothing to preview before the first node is placed', () => {
    for (const t of TYPES) expect(liveSegmentD([], { x: 1, y: 1 }, undefined, t)).toBe('')
  })

  it('previews a straight run from a lone node, with no history to curve against', () => {
    // The three schemes that need no neighbours say so with an L; the two
    // auto-curved ones write the same straight run as a degenerate cubic, with
    // both handles on the segment. Geometrically identical, so the test asks
    // about the geometry rather than the spelling.
    for (const t of ['linear', 'bezier', 'arc-fit'] as PenCurveType[]) {
      expect(liveSegmentD([N(0, 0)], { x: 5, y: 5 }, undefined, t)).toBe('M 0 0 L 5 5')
    }
    for (const t of ['catmull-rom', 'cubic-spline'] as PenCurveType[]) {
      const [seg] = cubics(liveSegmentD([N(0, 0)], { x: 5, y: 5 }, undefined, t))
      for (const t2 of [0.25, 0.5, 0.75]) {
        const p = bezierAt(seg, t2)
        expect(p.x).toBeCloseTo(p.y, 9) // still on the 45° line from (0,0) to (5,5)
      }
      expect(bezierAt(seg, 1)).toEqual({ x: 5, y: 5 })
    }
  })

  it('uses the dragged handles in bezier mode', () => {
    expect(liveSegmentD([N(0, 0, { outHandle: { x: 2, y: 4 } })], { x: 10, y: 0 }, { x: 8, y: 4 }, 'bezier'))
      .toBe('M 0 0 C 2 4 8 4 10 0')
  })

  it('never emits NaN from a cursor sitting on the last node', () => {
    for (const t of TYPES) {
      expect(liveSegmentD(ZIG, { x: 30, y: 10 }, undefined, t)).not.toMatch(/NaN|Infinity/)
    }
  })
})
