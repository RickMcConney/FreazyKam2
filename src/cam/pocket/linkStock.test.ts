// A pocket's stay-down links and lifted entries never move into stock the pass has not cut.
// Judged the way the simulator judges a rapid (sim/rapidGouge.ts): every `travel` and
// `rapid` move is run through the carve as a G0 would be, with the pocket's cuts before it.
import { describe, it, expect } from 'vitest'
import { generatePocket, type PocketParams } from '../pocket'
import { SweptArea } from './shared'
import { ptSegDistSq } from '../geom'
import { findRapidGouges } from '../../sim/rapidGouge'
import type { SimSegment } from '../../sim/gcodeParser'
import type { MotionSegment } from '../../store/toolpathStore'
import type { Tool } from '../../store/toolStore'
import type { Pt2 } from '../pathFlattener'

const TOOL: Tool = {
  id: 't1', name: 'em6', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const params = (over: Partial<PocketParams> = {}): PocketParams => ({
  strategy: 'raster', depthMM: 3, stepDownMM: 3, stepoverPercent: 25,
  direction: 'climb', islandDs: [], angle: 0, rampIn: false, safeHeightMM: 5,
  ...over,
} as PocketParams)

// Motion as the simulator sees it once written with links as G0: a travel move IS a rapid.
function asProgram(segs: MotionSegment[]): SimSegment[] {
  const out: SimSegment[] = []
  let p = { x: 0, y: 0, z: 5 }
  for (const s of segs) {
    out.push({ x: s.x, y: s.y, z: s.z, prevX: p.x, prevY: p.y, prevZ: p.z, rapid: !!(s.rapid || s.travel),
      feedRateMmMin: 1000, lineIdx: out.length, durationS: 0, startTimeS: 0, toolStateIdx: 0 })
    p = s
  }
  return out
}
const STOCK = { widthMM: 200, heightMM: 140, thicknessMM: 10, orgX: 0, orgY: 0 }
const hits = (segs: MotionSegment[]) =>
  findRapidGouges(asProgram(segs), [{ toolDiameterMM: 6, spindleRpm: 18000, fluteCount: 2 }], STOCK)

// An ellipse with two elliptical islands — the shape of scratch/ovals.fkam, where both
// faults were found — as polygons.
const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 96) =>
  'M ' + Array.from({ length: n }, (_, k) => {
    const a = (k / n) * 2 * Math.PI
    return `${(cx + rx * Math.cos(a)).toFixed(4)} ${(cy + ry * Math.sin(a)).toFixed(4)}`
  }).join(' L ') + ' Z'
const OVAL = ellipse(100, 70, 90, 60)
const ISLANDS = [ellipse(70, 70, 18, 28), ellipse(135, 60, 20, 14)]

describe('a pocket never moves into stock it has not cut, except at feed', () => {
  it('rides a raster link only over cut ground, then cuts the rest of the way into the row', () => {
    for (const angle of [0, 30, 140]) {
      for (const stepoverPercent of [25, 60, 90]) {
        const segs = generatePocket(OVAL, TOOL, params({ angle, stepoverPercent, islandDs: ISLANDS }))
        expect(`${angle}deg ${stepoverPercent}%: ${hits(segs).length}`).toBe(`${angle}deg ${stepoverPercent}%: 0`)
      }
    }
  })

  it('enters a finishing ring from safe height without rapiding down beside the stock the roughing left', () => {
    // Every strategy hands its finishing rings to the same entry, and before the fix every
    // one of them hit it somewhere in this sweep (raster at 140°, contour and morph at
    // every angle) — a G0 straight down to the floor, beside a wall the roughing had not
    // reached. The same at the stepdown ovals.fkam uses, a hair over the depth.
    for (const strategy of ['raster', 'contour', 'morph'] as const) {
      for (const angle of [0, 140]) {
        for (const stepoverPercent of [25, 45]) {
          const segs = generatePocket(OVAL, TOOL, params({
            strategy, angle, stepoverPercent, islandDs: ISLANDS, rampIn: true, stepDownMM: 3.025, safeHeightMM: 3,
          }))
          const label = `${strategy} ${angle}deg ${stepoverPercent}%`
          expect(`${label}: ${hits(segs).length}`).toBe(`${label}: 0`)
        }
      }
    }
  })
})

describe('SweptArea — the ground a pass has cleared', () => {
  it('marks exactly the cells within the tool radius of a move, at any angle', () => {
    const cell = 0.25, r = 3
    const moves: [Pt2, Pt2][] = [[[10, 10], [40, 10]], [[12, 30], [12, 5]], [[5, 5], [37, 23.3]], [[30, 30], [30.001, 30]], [[20, 20], [20, 20]]]
    for (const [a, b] of moves) {
      const area = new SweptArea(0, 0, 50, 40, cell)
      area.add(a, b, r)
      const cells = (area as unknown as { cells: Uint8Array; nx: number }).cells
      const nx = (area as unknown as { nx: number }).nx
      let wrong = 0
      for (let k = 0; k < cells.length; k++) {
        const x = (k % nx) * cell, y = Math.floor(k / nx) * cell
        const d2 = ptSegDistSq(x, y, a[0], a[1], b[0], b[1])
        // Cells a hair either side of the rim may go either way in floating point.
        if (Math.abs(Math.sqrt(d2) - r) < 1e-9) continue
        if ((d2 <= r * r ? 1 : 0) !== cells[k]) wrong++
      }
      expect(`${a}→${b}: ${wrong}`).toBe(`${a}→${b}: 0`)
    }
  })

  it('reads a link as clear back down a cut row, and stops it where uncut ground begins', () => {
    const area = new SweptArea(0, 0, 100, 40, 0.3)
    area.add([10, 20], [80, 20], 3)
    expect(area.clearedFraction([80, 20], [10, 20], 3)).toBe(1)
    // A link that turns off the row at x = 40 is clear up to about there and no further.
    // A link turning straight off the row leaves cut ground within a fraction of a radius.
    expect(area.clearedFraction([40, 20], [40, 35], 3) * 15).toBeLessThan(1)
  })
})
