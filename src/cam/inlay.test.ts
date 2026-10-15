import { describe, it, expect } from 'vitest'
import { splitRegions, generateInlayFemale, generateInlayMale, plugCutoutD, cutoutIsOwnOutline } from './inlay'
import { flattenPath, signedArea } from './pathFlattener'
import { pointInPolygon } from './geom'
import type { Tool } from '../store/toolStore'

// Two subpaths (two M commands) — the multi-region gate splitRegions applies before
// grouping. A single self-intersecting path is one shape and is deliberately skipped.
const W_OUTER = 'M 110 220 L 135 150 L 165 150 L 175 210 L 200 210 L 210 150 L 240 150 L 250 235 Z'
const W_INNER = 'M 162.4586 153 L 172.4586 213 L 202.5414 213 L 212.5414 153 L 237.3323 153 ' +
                'L 246.5813 231.6165 L 114.1060 217.4228 L 137.1142 153 Z'
const BOX = 'M 0 0 L 60 0 L 60 60 L 0 60 Z'
const BOX_HOLE = 'M 15 15 L 45 15 L 45 45 L 15 45 Z'

describe('splitRegions', () => {
  it('returns nothing for a single-subpath path', () => {
    expect(splitRegions(W_OUTER)).toEqual([])
  })

  it('groups a counter into its letter', () => {
    const regions = splitRegions(`${BOX} ${BOX_HOLE}`)
    expect(regions.length).toBe(1)
    expect(regions[0].islandDs.length).toBe(1)
  })

  // Regression: grouping used each ring's vertex mean, which only lands inside a convex
  // ring. The W's mean is at (185.6, 185.9) — in the notch under the middle peak, outside
  // the shape — so a counter shaped like its own letter was never claimed, and the inner
  // ring became a SECOND region: a second raised prism, carved as if it were another
  // letter. Letterforms are the opposite of convex, so this is the ordinary case for
  // V/W/X/Y, not an edge case.
  it('groups a concave counter into its equally concave letter', () => {
    const regions = splitRegions(`${W_OUTER} ${W_INNER}`)
    expect(regions.length).toBe(1)
    expect(regions[0].islandDs.length).toBe(1)
  })

  it('keeps disjoint letters as separate regions', () => {
    const regions = splitRegions(`${BOX} M 100 0 L 160 0 L 160 60 L 100 60 Z`)
    expect(regions.length).toBe(2)
    expect(regions.every((r) => r.islandDs.length === 0)).toBe(true)
  })
})

describe('an open path is refused by both halves', () => {
  // The socket is a pocket and the plug is the solid that fills it, so both bound a
  // REGION. An open path was closed off implicitly by splitRegions and machined as a
  // shape nobody drew — and since the two halves have to seat together, a wrong shape
  // in either is a pair that cannot be assembled.
  const OPEN_U = 'M 0 0 L 0 40 L 40 40 L 40 0'
  const CLOSED = 'M 0 0 L 0 40 L 40 40 L 40 0 Z'
  const EM: Tool = {
    id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
    rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
  }
  const P = {
    angleDeg: 60, pocketDepthMM: 2, stepDownMM: 2, stepoverPercent: 50,
    glueLineMM: 0, clearanceMM: 0, islandDs: [] as string[], safeHeightMM: 5,
  }

  it('names the half that was asked for', async () => {
    await expect(generateInlayFemale(OPEN_U, EM, null, P)).rejects
      .toThrow('Path is open — an inlay socket needs a closed shape. Close the path — an inlay needs a shape with an inside and an outside.')
    await expect(generateInlayMale(OPEN_U, EM, null, P)).rejects
      .toThrow('Path is open — an inlay plug needs a closed shape. Close the path — an inlay needs a shape with an inside and an outside.')
  })

  it('refuses an open island in either half', async () => {
    const withIsland = { ...P, islandDs: ['M 10 10 L 30 10 L 30 30'] }
    await expect(generateInlayFemale(CLOSED, EM, null, withIsland)).rejects.toThrow(/^Island path is open/)
    await expect(generateInlayMale(CLOSED, EM, null, withIsland)).rejects.toThrow(/^Island path is open/)
  })

  it('still cuts a closed path', async () => {
    const f = await generateInlayFemale(CLOSED, EM, null, P)
    expect(f.endmillSegs.length + f.vbitSegs.length).toBeGreaterThan(0)
  })

  // Inlay stepped its own depth passes, without the floor `zPasses` has: `while (z >
  // -depth) z -= 0` never ends, and the worker grew an array of -0 passes until it died.
  // A synchronous loop cannot be timed out, so a regression here crashes the run rather
  // than hanging politely — which is still a failure, and a loud one.
  it('finishes both halves on a step-down of 0 instead of looping forever', async () => {
    const zero = { ...P, stepDownMM: 0 }
    const f = await generateInlayFemale(CLOSED, EM, null, zero)
    const m = await generateInlayMale(CLOSED, EM, null, zero)
    expect(f.endmillSegs.length).toBeGreaterThan(0)
    expect(m.endmillSegs.length).toBeGreaterThan(0)
    // Every depth reached is a real one: nothing below the requested floor.
    for (const s of [...f.endmillSegs, ...m.endmillSegs]) expect(s.z).toBeGreaterThanOrEqual(-P.pocketDepthMM - 1e-9)
  })
})

describe('the female socket never cuts below its floor', () => {
  // A socket is the half of an inlay still there when the job is done, and a socket cut on
  // its own is a pocket with sharp V-bit walls — a groove under its floor shows. The wall
  // V-carve used to run its tip down to 1.5× the socket depth along every wall and deeper at
  // corners. Whether the plug still SEATS is inlayFit.test.ts's question; this one is only
  // about the floor.
  const EM: Tool = {
    id: 'em', name: '1/8 EM', type: 'endmill', diameterMM: 3.175, fluteCount: 2,
    rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
  }
  const VB: Tool = {
    id: 'vb', name: '60 V-bit', type: 'vbit', diameterMM: 6.35, fluteCount: 2,
    rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20, vbitAngleDeg: 60,
  }
  const P = {
    angleDeg: 60, pocketDepthMM: 5, stepDownMM: 3, stepoverPercent: 40,
    glueLineMM: 0.2, clearanceMM: 0.1, islandDs: [] as string[], safeHeightMM: 3,
  }
  const star = (cx: number, cy: number, R: number, r: number, n: number) => 'M' + Array.from({ length: 2 * n }, (_, i) => {
    const a = Math.PI / 2 + (i * Math.PI) / n, rad = i % 2 ? r : R
    return `${(cx + rad * Math.cos(a)).toFixed(4)},${(cy + rad * Math.sin(a)).toFixed(4)}`
  }).join(' L') + ' Z'
  const cases: [string, string, string[]][] = [
    ['a square', 'M 40 40 L 90 40 L 90 90 L 40 90 Z', []],
    ['a star', star(75, 75, 40, 16, 5), []],
    ['a square with a star standing in it', 'M 30 30 L 120 30 L 120 120 L 30 120 Z', [star(75, 75, 30, 12, 5)]],
  ]
  for (const [name, d, islandDs] of cases) {
    it(`cuts ${name} no deeper than the floor with either tool`, async () => {
      const f = await generateInlayFemale(d, EM, VB, { ...P, islandDs })
      const floor = -(P.pocketDepthMM + P.glueLineMM)
      expect(f.vbitSegs.length).toBeGreaterThan(0)
      for (const s of [...f.vbitSegs, ...f.endmillSegs]) if (!s.rapid) expect(s.z).toBeGreaterThanOrEqual(floor - 1e-6)
    })
  }
})

describe('the male plug\'s cut-out outline', () => {
  const EM: Tool = {
    id: 'em', name: '1/8 EM', type: 'endmill', diameterMM: 3.175, fluteCount: 2,
    rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
  }
  const VB: Tool = {
    id: 'vb', name: '60 V-bit', type: 'vbit', diameterMM: 6.35, fluteCount: 2,
    rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20, vbitAngleDeg: 60,
  }
  const P = {
    angleDeg: 60, pocketDepthMM: 5, stepDownMM: 3, stepoverPercent: 40,
    glueLineMM: 0.2, clearanceMM: 0.1, islandDs: [] as string[], safeHeightMM: 3,
  }
  const BOWTIE = 'M 0 0 L 30 9 L 60 0 L 60 30 L 30 21 L 0 30 Z'
  // Two "letters" — the multi-region text route.
  const LETTERS = 'M 0 0 L 10 0 L 10 20 L 0 20 Z M 16 0 L 26 0 L 26 20 L 16 20 Z'
  const ring = (d: string) => flattenPath(d, 0.05)[0]
  const area = (d: string) => Math.abs(signedArea(ring(d)))

  it('is the shape\'s own outline for one shape — nothing to clear between them', () => {
    const band = plugCutoutD(BOWTIE, 3.175, null)!
    expect(area(band)).toBeCloseTo(area(BOWTIE), 3)
  })

  it('is drawn where the mirrored plug is cut, about the same axis', () => {
    const band = plugCutoutD(BOWTIE.replace('L 30 21', 'L 20 21'), 3.175, 100)!
    const xs = ring(band).map((p) => p[0])
    expect(Math.min(...xs)).toBeCloseTo(140, 3)
    expect(Math.max(...xs)).toBeCloseTo(200, 3)
  })

  it('wraps lettering in one band, a cutter and a half clear of every letter', () => {
    const band = plugCutoutD(LETTERS, 3.175, null)!
    const pts = ring(band)
    expect(flattenPath(band, 0.05)).toHaveLength(1)
    // Every letter corner is inside, and at least 1.5 × the cutter from the band.
    for (const [x, y] of flattenPath(LETTERS, 0.05).flat()) {
      expect(pointInPolygon(x, y, pts)).toBe(true)
      const d = Math.min(...pts.map((p, i) => {
        const q = pts[(i + 1) % pts.length], vx = q[0] - p[0], vy = q[1] - p[1], l2 = vx * vx + vy * vy
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - p[0]) * vx + (y - p[1]) * vy) / l2)) : 0
        return Math.hypot(x - p[0] - t * vx, y - p[1] - t * vy)
      }))
      expect(d).toBeGreaterThan(1.5 * 3.175)
    }
  })

  it('is the plug\'s own path when it would only retrace it — so no copy is drawn on top', () => {
    // One shape, not mirrored: the band is its outline, already on the canvas.
    expect(cutoutIsOwnOutline(BOWTIE, null)).toBe(true)
    // Mirrored about its own centre a symmetric shape lands back on itself…
    expect(cutoutIsOwnOutline(BOWTIE, 30)).toBe(true)
    // …an asymmetric one does not, and needs a path where the mirrored plug is cut.
    expect(cutoutIsOwnOutline('M 0 0 L 60 0 L 60 30 L 20 30 Z', 30)).toBe(false)
    // Lettering's band is a hull round all of it: a path of its own.
    expect(cutoutIsOwnOutline(LETTERS, null)).toBe(false)
  })

  it('drops the plug\'s shallow release ring when the band will free it', async () => {
    const plain = await generateInlayMale(BOWTIE, EM, VB, P)
    const banded = await generateInlayMale(BOWTIE, EM, VB, { ...P, bandD: plugCutoutD(BOWTIE, 3.175, null)! })
    expect(plain.endmillSegs.length).toBeGreaterThan(0)
    expect(banded.endmillSegs).toHaveLength(0)
    expect(banded.vbitSegs).toEqual(plain.vbitSegs)
  })

  it('clears lettering out to the band, and nowhere past it', async () => {
    const band = plugCutoutD(LETTERS, 3.175, null)!
    const m = await generateInlayMale(LETTERS, EM, VB, { ...P, bandD: band })
    const pts = ring(band)
    const cutting = m.endmillSegs.filter((s) => !s.rapid)
    expect(cutting.length).toBeGreaterThan(0)
    for (const s of cutting) expect(pointInPolygon(s.x, s.y, pts)).toBe(true)
    // The gap between the two letters is cleared to the plug depth.
    expect(cutting.some((s) => s.x > 11 && s.x < 15 && s.z <= -P.pocketDepthMM + 1e-6)).toBe(true)
  })
})
