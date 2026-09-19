import { describe, it, expect } from 'vitest'
import { flattenPath, pathExtents } from './pathFlattener'

const allFinite = (rings: [number, number][][]) => rings.every((r) => r.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)))

describe('flattenPath — an arc with a zero radius is a straight line (SVG F.6.2)', () => {
  it('flattens a zero-radius arc to its endpoint, with no NaN', () => {
    expect(flattenPath('M0 0 A0 0 0 0 1 10 0')).toEqual([[[0, 0], [10, 0]]])
  })

  it('treats ONE zero radius the same as both', () => {
    expect(flattenPath('M0 0 A0 5 0 0 1 10 0')).toEqual([[[0, 0], [10, 0]]])
    expect(flattenPath('M0 0 A5 0 30 1 0 10 0')).toEqual([[[0, 0], [10, 0]]])
  })

  it('keeps a closed shape with a zero-radius corner intact and finite', () => {
    // A rounded-rectangle generator with its corner radius dialled to 0 emits exactly this.
    const rings = flattenPath('M0 0 L10 0 A0 0 0 0 1 10 10 L0 10 Z')
    expect(allFinite(rings)).toBe(true)
    expect(rings[0]).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]])
  })

  it('agrees with pathExtents on the box', () => {
    const d = 'M2 3 A0 0 0 0 1 12 7 L2 7 Z'
    const xs = flattenPath(d).flat()
    const box = [Math.min(...xs.map((p) => p[0])), Math.min(...xs.map((p) => p[1])),
      Math.max(...xs.map((p) => p[0])), Math.max(...xs.map((p) => p[1]))]
    expect(pathExtents(d)).toEqual(box)
  })

  it('leaves a real arc curved', () => {
    const [ring] = flattenPath('M0 0 A5 5 0 0 1 10 0', 0.01)
    expect(ring.length).toBeGreaterThan(4)
    expect(allFinite([ring])).toBe(true)
    // A semicircle of radius 5 bulges a full radius off its chord. Vertices sit ON the
    // circle, spaced for a chord error within the 0.01 tolerance, so the highest one is
    // within that of the apex — and never past it.
    const bulge = Math.max(...ring.map(([, y]) => Math.abs(y)))
    expect(bulge).toBeGreaterThanOrEqual(5 - 0.01)
    expect(bulge).toBeLessThanOrEqual(5 + 1e-9)
  })
})

// ─── One parser ──────────────────────────────────────────────────────────────────
//
// `flattenPath` and `pathExtents` used to carry a tokeniser each, and both were wrong in
// the same two ways. The bugs were invisible because `ImportedPath.d` only ever holds
// absolute uppercase commands, so no stored path reached them — but a pasted SVG or a
// hand-edited project does, and what came out was not an error, it was geometry.
//
// The unit square below is the whole test: every spelling of it must flatten to the same
// four corners. Before, `H`/`V` were not in the tokeniser's character class at all, so the
// letter did not terminate the previous command and its numbers were swallowed by it —
// `M 0 0 H 10 V 10 H 0 Z` came out as `[[0,0],[10,10],[0,undefined],[0,0]]`, an undefined
// COORDINATE on its way into the toolpath. Lowercase was matched and then fell through a
// switch with no lowercase case, so a relative square flattened to nothing at all.
const SQUARE: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]

describe('flattenPath — every spelling of a square is the same square', () => {
  const spellings: Record<string, string> = {
    'explicit line-tos': 'M 0 0 L 10 0 L 10 10 L 0 10 Z',
    'horizontal and vertical commands': 'M 0 0 H 10 V 10 H 0 Z',
    'H/V mixed with L': 'M 0 0 L 10 0 V 10 L 0 10 Z',
    'relative (lowercase) commands': 'M 0 0 l 10 0 l 0 10 l -10 0 z',
    'relative H/V': 'M 0 0 h 10 v 10 h -10 z',
    'one moveto carrying every point': 'M 0 0 10 0 10 10 0 10 Z',
  }
  for (const [name, d] of Object.entries(spellings)) {
    it(`flattens ${name} to the same four corners`, () => {
      expect(flattenPath(d)).toEqual([SQUARE])
    })
    it(`measures ${name} as 0,0 → 10,10`, () => {
      expect(pathExtents(d)).toEqual([0, 0, 10, 10])
    })
  }

  it('never emits a coordinate that is not a number', () => {
    // The old H/V failure did not throw and did not come out empty — it came out as a
    // polyline with an undefined in it, which reads as a plausible shape until something
    // divides by it. Guard the property itself, for every spelling.
    for (const d of Object.values(spellings)) {
      for (const poly of flattenPath(d)) {
        for (const [x, y] of poly) {
          expect(Number.isFinite(x), `x in ${d}`).toBe(true)
          expect(Number.isFinite(y), `y in ${d}`).toBe(true)
        }
      }
    }
  })
})

describe('flattenPath and pathExtents read one parser, so they cannot drift apart', () => {
  // pathExtents' docblock claims it mirrors flattenPath. It used to say so about a second
  // hand-written copy of the switch; now they walk the same command stream, and the only
  // difference left is the flattening tolerance. A bbox from the flattened points can only
  // sit INSIDE the true extents (subdivision stops within tolerance of the chord), so the
  // two agree to within that — and on a polygon, exactly.
  const cases = [
    'M 0 0 L 10 0 L 10 10 L 0 10 Z',
    'M 0 0 H 10 V 10 H 0 Z',
    'M 0 0 l 10 0 l 0 10 l -10 0 z',
    'M 0 0 C 10 20 30 20 40 0 S 60 -20 80 0',
    'M 0 0 Q 20 30 40 0 T 80 0',
    'M 0 0 A 20 20 0 0 1 40 0 Z',
  ]
  for (const d of cases) {
    it(`agrees with the flattened points for ${d.slice(0, 28)}…`, () => {
      const pts = flattenPath(d, 0.001).flat()
      expect(pts.length).toBeGreaterThan(1)
      const ext = pathExtents(d)!
      const fx0 = Math.min(...pts.map((p) => p[0])), fx1 = Math.max(...pts.map((p) => p[0]))
      const fy0 = Math.min(...pts.map((p) => p[1])), fy1 = Math.max(...pts.map((p) => p[1]))
      // The flattened box is contained in the true one, to within the tolerance.
      expect(ext[0]).toBeLessThanOrEqual(fx0 + 1e-9)
      expect(ext[1]).toBeLessThanOrEqual(fy0 + 1e-9)
      expect(ext[2]).toBeGreaterThanOrEqual(fx1 - 1e-9)
      expect(ext[3]).toBeGreaterThanOrEqual(fy1 - 1e-9)
      expect(ext[0]).toBeGreaterThan(fx0 - 0.01)
      expect(ext[3]).toBeLessThan(fy1 + 0.01)
    })
  }
})

describe('the shared walker resolves S and T to the curve they stand for', () => {
  // The reflection rule now lives in exactly one place, so nothing else would catch it
  // being wrong — and "wrong" here is a curve of a plausible but different shape, which is
  // the failure mode this codebase keeps warning about. Each case states the explicit
  // curve the smooth one is defined to equal, so the assertion is the SVG rule itself.
  const equivalents: [string, string, string][] = [
    ['S reflects the previous C control through the current point',
      'M 0 0 C 10 20 30 20 40 0 S 60 -20 80 0',
      'M 0 0 C 10 20 30 20 40 0 C 50 -20 60 -20 80 0'],   // reflect (30,20) about (40,0)
    ['a chain of S keeps reflecting, each off the one before',
      'M 0 0 C 5 10 15 10 20 0 S 35 -10 40 0 S 55 10 60 0',
      'M 0 0 C 5 10 15 10 20 0 C 25 -10 35 -10 40 0 C 45 10 55 10 60 0'],
    ['S with no preceding curve puts its first control ON the current point',
      'M 0 0 S 20 20 40 0',
      'M 0 0 C 0 0 20 20 40 0'],
    ['S after a line-to also collapses onto the current point',
      'M 0 0 L 10 0 S 20 20 40 0',
      'M 0 0 L 10 0 C 10 0 20 20 40 0'],
    ['T reflects the previous Q control through the current point',
      'M 0 0 Q 20 30 40 0 T 80 0',
      'M 0 0 Q 20 30 40 0 Q 60 -30 80 0'],                // reflect (20,30) about (40,0)
    ['a chain of T keeps reflecting',
      'M 0 0 Q 10 20 20 0 T 40 0 T 60 0',
      'M 0 0 Q 10 20 20 0 Q 30 -20 40 0 Q 50 20 60 0'],
    ['T with no preceding quadratic collapses onto the current point',
      'M 0 0 T 40 0',
      'M 0 0 Q 0 0 40 0'],
  ]
  for (const [name, smooth, explicit] of equivalents) {
    it(name, () => {
      expect(flattenPath(smooth, 0.001)).toEqual(flattenPath(explicit, 0.001))
    })
  }

  it('and the explicit forms are genuinely different curves, so the test is not vacuous', () => {
    // Guard against the equivalences all passing because every curve flattened the same.
    const shapes = equivalents.map(([, smooth]) => JSON.stringify(flattenPath(smooth, 0.001)))
    expect(new Set(shapes).size).toBe(shapes.length)
  })
})
