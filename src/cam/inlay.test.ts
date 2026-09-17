import { describe, it, expect } from 'vitest'
import { splitRegions, generateInlayFemale, generateInlayMale } from './inlay'
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
})
