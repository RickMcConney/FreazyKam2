// Boolean ops on paths (union / intersect / subtract), judged by AREA and by which rings are
// holes — measured off the result's own rings by nesting depth (even-odd), never by their
// winding, so the check cannot share a mistake about winding with the code under test.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadFont, generateTextD } from '../shapes/textGenerator'
import { applyBooleanOp } from './booleanOps'
import { flattenPath, signedArea, type Pt2 } from '../cam/pathFlattener'
import { pointInPolygon, interiorPoint } from '../cam/geom'

const sq = (x: number, y: number, w: number, h: number, cw = false) => {
  const pts: Pt2[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
  const p = cw ? [...pts].reverse() : pts
  return 'M ' + p.map(([a, b]) => a + ' ' + b).join(' L ') + ' Z'
}
const circle = (cx: number, cy: number, r: number, cw = false, n = 256) => {
  const p = Array.from({ length: n }, (_, i) => { const a = (cw ? -1 : 1) * 2 * Math.PI * i / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] })
  return 'M ' + p.map(([a, b]) => a.toFixed(5) + ' ' + b.toFixed(5)).join(' L ') + ' Z'
}

/** Area by nesting: a ring at even depth adds, at odd depth subtracts. */
function evenOddArea(d: string): number {
  const rings = flattenPath(d, 0.01).filter(r => r.length >= 3)
  let total = 0
  for (let i = 0; i < rings.length; i++) {
    const p = interiorPoint([rings[i]])!
    const depth = rings.filter((r, j) => j !== i && Math.abs(signedArea(r)) > Math.abs(signedArea(rings[i])) && pointInPolygon(p[0], p[1], r)).length
    total += (depth % 2 === 0 ? 1 : -1) * Math.abs(signedArea(rings[i]))
  }
  return total
}
const ok = (r: ReturnType<typeof applyBooleanOp>) => {
  if ('error' in r) throw new Error(r.error)
  return r.resultD
}

describe('two overlapping squares', () => {
  const A = sq(0, 0, 10, 10), B = sq(5, 5, 10, 10)
  it('union covers both, counting the overlap once', () => expect(evenOddArea(ok(applyBooleanOp('union', [A, B])))).toBeCloseTo(175, 6))
  it('intersect is the overlap', () => expect(evenOddArea(ok(applyBooleanOp('intersect', [A, B])))).toBeCloseTo(25, 6))
  it('subtract takes the second away from the first', () => expect(evenOddArea(ok(applyBooleanOp('subtract', [A, B])))).toBeCloseTo(75, 6))
  it('subtract the other way round is the other remainder', () => expect(evenOddArea(ok(applyBooleanOp('subtract', [B, A])))).toBeCloseTo(75, 6))
})

describe('winding does not change the answer', () => {
  // Generated circles wind CW and imported art goes either way, so the same shapes drawn
  // the other way round must combine the same.
  for (const op of ['union', 'intersect', 'subtract'] as const) {
    it(op, () => {
      const ccw = evenOddArea(ok(applyBooleanOp(op, [sq(0, 0, 10, 10), circle(10, 5, 4)])))
      const cw = evenOddArea(ok(applyBooleanOp(op, [sq(0, 0, 10, 10, true), circle(10, 5, 4, true)])))
      expect(cw).toBeCloseTo(ccw, 3)
    })
  }
})

describe('holes', () => {
  it('subtracting a shape inside another leaves it a hole', () => {
    const d = ok(applyBooleanOp('subtract', [sq(0, 0, 20, 20), sq(5, 5, 4, 4)]))
    expect(flattenPath(d, 0.01).length).toBe(2)
    expect(evenOddArea(d)).toBeCloseTo(400 - 16, 6)
  })

  it('a path\'s own hole survives a union with something that misses it', () => {
    const ring = `${sq(0, 0, 20, 20)} ${sq(5, 5, 10, 10, true)}`
    expect(evenOddArea(ok(applyBooleanOp('union', [ring, sq(30, 0, 5, 5)])))).toBeCloseTo(400 - 100 + 25, 6)
  })

  // A font winds the other way: outer ring CW, counter CCW (Roboto's O reads −99 / +52).
  it('a hole wound the "wrong" way is still a hole', () => {
    const letterO = `${sq(0, 0, 20, 20, true)} ${sq(5, 5, 10, 10)}`
    expect(evenOddArea(ok(applyBooleanOp('union', [letterO, sq(30, 0, 5, 5)])))).toBeCloseTo(400 - 100 + 25, 6)
  })

  it('an island standing in a hole is kept as solid', () => {
    const target = `${sq(0, 0, 30, 30)} ${sq(5, 5, 20, 20, true)} ${sq(10, 10, 10, 10)}`
    expect(evenOddArea(ok(applyBooleanOp('union', [target, sq(40, 0, 5, 5)])))).toBeCloseTo(900 - 400 + 100 + 25, 6)
  })
})

describe('lettering from a real font', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(readFileSync(`public${decodeURIComponent(url)}`))))
    await loadFont('Roboto')
    vi.unstubAllGlobals()
  })
  it('keeps every counter through a union with a shape that misses them', () => {
    const word = generateTextD({ type: 'text', x: 0, y: 0, text: 'BOA', fontSize: 20, fontFamily: 'Roboto' })
    const result = ok(applyBooleanOp('union', [word, sq(200, 0, 10, 10)]))
    expect(evenOddArea(result)).toBeCloseTo(evenOddArea(word) + 100, 0)
    // B's two, O's and A's — the same holes, still holes.
    expect(flattenPath(result, 0.05).length).toBe(flattenPath(word, 0.05).length + 1)
  })
})

describe('more than two paths', () => {
  it('union takes all of them', () => {
    expect(evenOddArea(ok(applyBooleanOp('union', [sq(0, 0, 10, 10), sq(5, 0, 10, 10), sq(10, 0, 10, 10)])))).toBeCloseTo(200, 6)
  })
  it('subtract takes every later path away from the first', () => {
    expect(evenOddArea(ok(applyBooleanOp('subtract', [sq(0, 0, 30, 10), sq(0, 0, 10, 10), sq(20, 0, 10, 10)])))).toBeCloseTo(100, 6)
  })
})

describe('refusals', () => {
  it('needs two paths', () => expect(applyBooleanOp('union', [sq(0, 0, 1, 1)])).toEqual({ error: 'Select at least 2 paths' }))
  it('says so when a path has no area', () => expect('error' in applyBooleanOp('union', [sq(0, 0, 1, 1), 'M 0 0 L 5 5'])).toBe(true))
  it('says so when the result is empty, rather than handing back nothing', () => {
    const r = applyBooleanOp('intersect', [sq(0, 0, 1, 1), sq(5, 5, 1, 1)])
    expect('error' in r && r.error).toMatch(/empty/)
  })
})
