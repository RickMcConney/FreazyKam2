import { describe, it, expect } from 'vitest'
import { generatePocket, type PocketParams } from '../pocket'
import { GeometryTooSmallError } from '../errors'
import type { Tool } from '../../store/toolStore'

const TOOL: Tool = {
  id: 't', name: '3mm', type: 'endmill', diameterMM: 3, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20,
}
const params = (islandDs: string[]): PocketParams => ({
  strategy: 'raster', depthMM: 2, stepDownMM: 2, stepoverPercent: 40,
  direction: 'climb', islandDs, angle: 0, rampIn: false, safeHeightMM: 5,
} as PocketParams)
const rect = (x: number, y: number, w: number, h: number) =>
  `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`

describe('an island that encloses the whole pocket', () => {
  // Islands are matched to a boundary by having a vertex inside it, and one that covers the
  // boundary entirely has none. It used to be dropped — read as "no island" — and the area
  // it was there to keep was cleared. The inlay socket of a thin-stroked O did exactly that.
  it('leaves nothing to cut', () => {
    expect(() => generatePocket(rect(20, 20, 30, 30), TOOL, params([rect(10, 10, 50, 50)])))
      .toThrow(GeometryTooSmallError)
  })

  it('covers only the region it encloses, not the others in the same path', () => {
    const two = `${rect(20, 20, 30, 30)} ${rect(80, 20, 30, 30)}`
    const segs = generatePocket(two, TOOL, params([rect(10, 10, 50, 50)]))
    const cuts = segs.filter(s => !s.rapid && s.z < 0)
    expect(cuts.length).toBeGreaterThan(10)
    expect(cuts.every(s => s.x > 75)).toBe(true)
  })
})
