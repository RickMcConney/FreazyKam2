import { describe, it, expect } from 'vitest'
import { buildHoldIndex, stripAt, stripEnds, refitStrip } from './bridgePick'
import { planBridges, ringCorners, cornerClearMM, targetSpots, OVERLAP_MM, FRAME_STUB_MM, type Join } from './bridges'
import { tabTAt } from './tabPlacement'
import { flattenPath } from './pathFlattener'
import { translateD } from '../canvas/selectionUtils'

const rect = (x: number, y: number, w: number, h: number) =>
  `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
const circle = (cx: number, cy: number, r: number) =>
  `M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} Z`
const STOCK = { widthMM: 300, heightMM: 200 }
const W = 5, R = 3.175 / 2
const CLEAR = cornerClearMM(W, R)
const OPTS = { widthMM: W, toolRadiusMM: R, reachMM: 30, searchMM: 2 * CLEAR + 2, pickMM: 30 }

// Two 60 × 40 parts side by side, 6 mm apart: a gap from x = 70 to x = 76, y 50…90.
const A = { id: 'a', d: rect(10, 50, 60, 40) }
const B = { id: 'b', d: rect(76, 50, 60, 40) }
// A third part above A, 6 mm off its top edge.
const C = { id: 'c', d: rect(10, 96, 60, 30) }

const cornersOf = (d: string) => flattenPath(d, 0.25).flatMap((r) => ringCorners(r as [number, number][]))
const distToCorners = (d: string, x: number, y: number) => Math.min(...cornersOf(d).map(([cx, cy]) => Math.hypot(cx - x, cy - y)))

describe('ringCorners — where an outline turns, not where it was faceted', () => {
  it('finds the four corners of a rectangle', () => {
    expect(cornersOf(rect(0, 0, 50, 30))).toHaveLength(4)
  })
  it('finds none round a circle, however finely it was flattened', () => {
    expect(cornersOf(circle(0, 0, 10))).toHaveLength(0)
  })
})

describe('stripAt — one strip placed by hand', () => {
  const ix = buildHoldIndex([A, B, C], STOCK)

  it('a click in the gap between two parts joins them, square across the gap', () => {
    const p = stripAt(ix, 73, 70, OPTS)!
    expect(p).not.toBeNull()
    expect(new Set([p.a, p.b])).toEqual(new Set(['a', 'b']))
    // Horizontal (square to the vertical edges), at the click's height, reaching OVERLAP_MM into each.
    expect(p.line.y1).toBeCloseTo(70, 6)
    expect(p.line.y2).toBeCloseTo(70, 6)
    expect(Math.min(p.line.x1, p.line.x2)).toBeCloseTo(70 - OVERLAP_MM, 6)
    expect(Math.max(p.line.x1, p.line.x2)).toBeCloseTo(76 + OVERLAP_MM, 6)
  })

  it('finds no strip to a part where an outline faces open stock', () => {
    // A's bottom edge faces open stock.
    expect(stripAt(ix, 40, 50, OPTS)).toBeNull()
  })

  it('asked for the frame, puts a stub into open stock where no part is in reach in front', () => {
    const p = stripAt(ix, 40, 50, { ...OPTS, toPart: 'frame' })!
    expect(p.b).toBe('frame')
    // Straight down off the bottom edge, FRAME_STUB_MM long past the outline.
    expect(p.line.x1).toBeCloseTo(40, 6)
    expect(p.line.x2).toBeCloseTo(40, 6)
    expect(p.line.y1).toBeCloseTo(50 + OVERLAP_MM, 6)
    expect(p.line.y2).toBeCloseTo(50 - FRAME_STUB_MM, 6)
  })

  it('asked for the frame, refuses where a part stands within reach in front', () => {
    // A's right edge faces B 6 mm away: that is a join to B, never a stub through it.
    expect(stripAt(ix, 70, 70, { ...OPTS, toPart: 'frame' })).toBeNull()
  })

  it('a click by a corner slides the strip along until both ends clear the corners', () => {
    const p = stripAt(ix, 73, 51, OPTS)!
    expect(p).not.toBeNull()
    for (const [x, y] of [[p.line.x1, p.line.y1], [p.line.x2, p.line.y2]]) {
      // Each end, stepped back onto its outline, stands at least the clearance off any corner.
      const ox = x < 73 ? x + OVERLAP_MM : x - OVERLAP_MM
      const d = ox < 73 ? A.d : B.d
      expect(distToCorners(d, ox, y)).toBeGreaterThanOrEqual(CLEAR - 1e-6)
    }
  })

  it('slides off a corner of the part it LEAVES, even where the far part has none', () => {
    // B2 runs well past A's top corner, so only A's corner (70, 90) is near the click.
    const ix2 = buildHoldIndex([A, { id: 'b2', d: rect(76, 30, 60, 80) }], STOCK)
    const p = stripAt(ix2, 72, 89, OPTS)!
    expect(p.a).toBe('a')
    expect(distToCorners(A.d, Math.min(p.line.x1, p.line.x2) + OVERLAP_MM, p.line.y1)).toBeGreaterThanOrEqual(CLEAR - 1e-6)
  })

  it('a drag keeps the strip between the same two parts, wherever the pointer goes', () => {
    // The pointer is in the gap between A and C, nearest A's top edge — which faces C. Held to
    // A→B, the drag finds nothing there rather than jumping across to C.
    expect(stripAt(ix, 40, 93, { ...OPTS, fromPart: 'a', toPart: 'b' })).toBeNull()
    const q = stripAt(ix, 72, 80, { ...OPTS, fromPart: 'a', toPart: 'b' })!
    expect([q.a, q.b]).toEqual(['a', 'b'])
    expect(q.line.y1).toBeCloseTo(80, 6)
  })

  it('reads back which two parts an existing strip joins', () => {
    const p = stripAt(ix, 73, 70, OPTS)!
    expect(stripEnds(ix, p.line)).toEqual({ a: p.a, b: p.b })
  })
})

describe('planBridges keeps its joins off the corners', () => {
  it('no join of two big parts lands within the clearance of a corner of either', () => {
    const parts = [A, B, C]
    const joins = planBridges(parts, STOCK, { count: 3, toolRadiusMM: R, widthMM: W })
    expect(joins.length).toBeGreaterThan(0)
    for (const j of joins) {
      const ux = j.line.x2 - j.line.x1, uy = j.line.y2 - j.line.y1, l = Math.hypot(ux, uy)
      // The start end, stepped back onto part a's outline.
      const sx = j.line.x1 + ux / l * OVERLAP_MM, sy = j.line.y1 + uy / l * OVERLAP_MM
      expect(distToCorners(parts[j.a].d, sx, sy)).toBeGreaterThanOrEqual(CLEAR - 1e-6)
      if ('part' in j.b) {
        const ex = j.line.x2 - ux / l * OVERLAP_MM, ey = j.line.y2 - uy / l * OVERLAP_MM
        expect(distToCorners(parts[j.b.part].d, ex, ey)).toBeGreaterThanOrEqual(CLEAR - 1e-6)
      }
    }
  })

  it('still holds a part too small to have an edge clear of its corners', () => {
    // 8 mm square: every point of its edge is within CLEAR (≈ 6.1 mm) of a corner.
    const tiny = { id: 't', d: rect(73 - 4, 20, 8, 8) }
    const joins = planBridges([A, tiny], STOCK, { count: 2, toolRadiusMM: R, widthMM: W })
    expect(joins.some((j) => j.a === 1 || ('part' in j.b && j.b.part === 1))).toBe(true)
  })
})

describe('tabTAt — a tab where the user clicked', () => {
  it('lands at the nearest point of the outline', () => {
    const polys = flattenPath(rect(0, 0, 100, 50), 0.05)
    // (50, -3) is nearest (50, 0), 50 mm along a 300 mm outline from (0, 0).
    expect(tabTAt(polys, 50, -3, 5)).toBeCloseTo(50 / 300, 6)
  })
  it('moves off a corner by half its length and a millimetre', () => {
    const polys = flattenPath(rect(0, 0, 100, 50), 0.05)
    const t = tabTAt(polys, 99, -1, 6)!
    // Within 3 + 1 mm of the corner at (100, 0) it slides back to 96 mm along.
    expect(t * 300).toBeCloseTo(96, 6)
  })
})

// Strips per side of an axis-aligned rectangle part, by where each join meets it.
function perSide(parts: { d: string }[], joins: Join[]): Record<string, number>[] {
  const box = (d: string) => { const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number); const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } }
  const out = parts.map(() => ({ L: 0, R: 0, B: 0, T: 0 } as Record<string, number>))
  const count = (k: number, x: number, y: number) => {
    const b = box(parts[k].d), e = 0.6
    const s = Math.abs(x - b.x0) < e ? 'L' : Math.abs(x - b.x1) < e ? 'R' : Math.abs(y - b.y0) < e ? 'B' : 'T'
    out[k][s]++
  }
  for (const j of joins) {
    const { x1, y1, x2, y2 } = j.line, l = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / l, uy = (y2 - y1) / l
    count(j.a, x1 + ux * OVERLAP_MM, y1 + uy * OVERLAP_MM)
    if ('part' in j.b) count(j.b.part, x2 - ux * OVERLAP_MM, y2 - uy * OVERLAP_MM)
  }
  return out
}

describe('planBridges spreads a part\'s joins evenly, side by side', () => {
  // The user's sheet: two pairs of rectangles, 110 × 60 / 90 × 70 side by side 20 mm apart.
  const STOCK2 = { widthMM: 584.2, heightMM: 279.4 }
  const pair = [{ id: 'p', d: rect(140, 130, 110, 60) }, { id: 'q', d: rect(270, 125, 90, 70) }]

  it('eight joins on a rectangle are two on every side — not three on one and one on another', () => {
    for (const side of perSide(pair, planBridges(pair, STOCK2, { count: 8, toolRadiusMM: R, widthMM: W }))) {
      expect(side).toEqual({ L: 2, R: 2, B: 2, T: 2 })
    }
  })

  it('stays even when the parts are dragged far apart — a side facing distant parts is held into open stock', () => {
    // 155 mm apart: beyond any join's reach, and each one's frame join runs through the other.
    const apart = [{ id: 'p', d: rect(77, -140, 110, 70) }, { id: 'q', d: rect(342, -160, 110, 70) }]
    for (const side of perSide(apart, planBridges(apart, STOCK2, { count: 8, toolRadiusMM: R, widthMM: W }))) {
      expect(side).toEqual({ L: 2, R: 2, B: 2, T: 2 })
    }
  })
})

describe('targetSpots — where a part\'s joins should go', () => {
  const ring = flattenPath(rect(0, 0, 110, 60), 0.25) as [number, number][][]
  const sideOf = ({ x, y }: { x: number; y: number }) =>
    Math.abs(x) < 1e-6 ? 'L' : Math.abs(x - 110) < 1e-6 ? 'R' : Math.abs(y) < 1e-6 ? 'B' : 'T'
  const tally = (n: number) => targetSpots(ring, n, CLEAR).map(sideOf).sort().join('')

  it('shares the count among the sides, a long side taking at most one more than a short one', () => {
    expect(tally(8)).toBe('BBLLRRTT')
    expect(tally(6)).toBe('BBLRTT')
    expect(tally(4)).toBe('BLRT')
  })

  it('spaces a side\'s spots evenly between its corner clearances', () => {
    const bottom = targetSpots(ring, 8, CLEAR).filter((p) => sideOf(p) === 'B').map((p) => p.x).sort((a, b) => a - b)
    const use = 110 - 2 * CLEAR
    expect(bottom[0]).toBeCloseTo(CLEAR + use / 4, 6)
    expect(bottom[1]).toBeCloseTo(CLEAR + 3 * use / 4, 6)
  })

  it('gives the short ends of a long thin part none, and spreads two far apart along it', () => {
    const thin = flattenPath(rect(0, 0, 120, 10), 0.25) as [number, number][][]
    const two = targetSpots(thin, 2, CLEAR)
    expect(two.map((p) => (Math.abs(p.y) < 1e-6 ? 'B' : 'T')).sort()).toEqual(['B', 'T'])
    // At the two ends of a diagonal, not one station twice in the middle.
    expect(Math.abs(two[0].x - two[1].x)).toBeGreaterThan(100)
  })
})

describe('refitStrip — a strip follows the parts it holds', () => {
  const before = buildHoldIndex([A, B, C], STOCK)
  const strip = stripAt(before, 73, 70, OPTS)!.line
  const o = { widthMM: W, toolRadiusMM: R }

  it('leaves a strip alone when neither of its parts changed', () => {
    const after = buildHoldIndex([A, B, { ...C, d: translateD(C.d, 0, 20) }], STOCK)
    expect(refitStrip(before, after, strip, new Set(['c']), o)).toBe('keep')
  })

  it('moves with its parts, from the same place on the part it leaves', () => {
    const after = buildHoldIndex([{ ...A, d: translateD(A.d, 0, 10) }, { ...B, d: translateD(B.d, 0, 10) }, C], STOCK)
    const r = refitStrip(before, after, strip, new Set(['a', 'b']), o)
    if (r === 'keep' || !r.line) throw new Error('expected a re-fitted strip')
    expect(r.line.y1).toBeCloseTo(strip.y1 + 10, 6)
    expect(r.line.y2).toBeCloseTo(strip.y2 + 10, 6)
    expect(r.line.x1).toBeCloseTo(strip.x1, 6)
  })

  it('stays joined to the same neighbour when that one moves but is still in reach', () => {
    const after = buildHoldIndex([A, { ...B, d: translateD(B.d, 10, 0) }, C], STOCK)
    const r = refitStrip(before, after, strip, new Set(['b']), o)
    if (r === 'keep' || !r.line) throw new Error('expected a re-fitted strip')
    expect(Math.max(r.line.x1, r.line.x2)).toBeCloseTo(86 + OVERLAP_MM, 6)
    expect(r.ends.sort()).toEqual(['a', 'b'])
  })

  it('becomes a stub into open stock when its neighbour is dragged out of reach', () => {
    const after = buildHoldIndex([A, { ...B, d: translateD(B.d, 150, 0) }, C], STOCK)
    const r = refitStrip(before, after, strip, new Set(['b']), o)
    if (r === 'keep' || !r.line) throw new Error('expected a re-fitted strip')
    expect(Math.max(r.line.x1, r.line.x2)).toBeCloseTo(70 + FRAME_STUB_MM, 6)
  })

  it('goes with the part it leaves when that part is deleted', () => {
    const after = buildHoldIndex([B, C], STOCK)
    const r = refitStrip(before, after, strip, new Set(['a']), o)
    expect(r !== 'keep' && r.line === null).toBe(true)
  })
})
