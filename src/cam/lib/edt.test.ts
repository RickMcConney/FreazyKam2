import { describe, it, expect } from 'vitest'
import { edtSq, EDT_INF } from './edt'

/** Ground truth: every cell against every site, no cleverness. */
function brute(w: number, h: number, seed: Uint8Array): Float64Array {
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let best = Infinity
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!seed[j * w + i]) continue
      const d = (x - i) * (x - i) + (y - j) * (y - j)
      if (d < best) best = d
    }
    out[y * w + x] = best
  }
  return out
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('edtSq — exact squared Euclidean distance transform', () => {
  it('gives the EXACT squared distance, not an approximation, on every random grid', () => {
    const rand = mulberry32(20260919)
    let checked = 0
    for (let t = 0; t < 120; t++) {
      const w = 1 + Math.floor(rand() * 18)
      const h = 1 + Math.floor(rand() * 18)
      const density = rand() * rand()
      const seed = new Uint8Array(w * h)
      for (let k = 0; k < seed.length; k++) seed[k] = rand() < density ? 1 : 0
      if (!seed.some(v => v !== 0)) continue   // no sites: every value is a sentinel
      const got = edtSq(w, h, i => seed[i] !== 0)
      expect(Array.from(got), `grid ${w}x${h} case ${t}`).toEqual(Array.from(brute(w, h, seed)))
      checked++
    }
    expect(checked).toBeGreaterThan(80)
  })

  it('measures diagonally, so a lone corner site puts the far corner at w²+h²', () => {
    const seed = new Uint8Array(5 * 4)
    seed[0] = 1
    const d = edtSq(5, 4, i => seed[i] !== 0)
    expect(d[0]).toBe(0)
    expect(d[4]).toBe(16)                 // (4,0)
    expect(d[3 * 5]).toBe(9)              // (0,3)
    expect(d[3 * 5 + 4]).toBe(25)         // (4,3) — 4² + 3², not 4+3 and not max(4,3)
  })

  it('reads the grid row-major, so the two axes are not interchangeable', () => {
    // One site at (x=3, y=0) of a 4-wide, 2-tall grid. Transposing the axes would put it
    // at (0,3), out of range, and give a different field entirely.
    const d = edtSq(4, 2, i => i === 3)
    expect(d[0]).toBe(9)      // (0,0) → 3 across
    expect(d[4]).toBe(10)     // (0,1) → 3 across, 1 down
    expect(d[7]).toBe(1)      // (3,1) → directly below the site
  })

  it('returns the sentinel, not zero or Infinity, for a grid with no site at all', () => {
    const d = edtSq(3, 3, () => false)
    for (const v of d) {
      expect(v).toBeGreaterThanOrEqual(EDT_INF)
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('keeps the sentinel clear of any distance a capped CAM grid can hold', () => {
    // Callers compare the transform against a squared radius in cells. Grids are capped
    // in the millions of cells, so the largest real value is ~1e7 — the sentinel has to
    // beat that by a wide margin or a "no site" cell reads as a near one.
    expect(EDT_INF).toBeGreaterThan(1e9)
    // …and stay exact under the `f + q*q` the inner loop does (2^53 ≈ 9e15).
    expect(EDT_INF + 8e6).toBe(EDT_INF + 8e6)
    expect(Number.isSafeInteger(EDT_INF)).toBe(true)
  })

  it('handles a single row and a single column, which the two-pass structure could skip', () => {
    expect(Array.from(edtSq(5, 1, i => i === 2))).toEqual([4, 1, 0, 1, 4])
    expect(Array.from(edtSq(1, 5, i => i === 2))).toEqual([4, 1, 0, 1, 4])
  })
})
