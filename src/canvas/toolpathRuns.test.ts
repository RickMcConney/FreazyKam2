import { describe, it, expect } from 'vitest'
import { toolpathRuns, swathRuns } from './toolpathRuns'
import { toolRadiusAtHeight } from '../cam/geom'
import type { Tool } from '../store/toolStore'
import type { MotionSegment } from '../store/toolpathStore'

const rapid = (x: number, y: number, z: number): MotionSegment => ({ x, y, z, rapid: true })
const cut = (x: number, y: number, z: number, more: Partial<MotionSegment> = {}): MotionSegment => ({ x, y, z, rapid: false, ...more })

describe('toolpathRuns — the cutting moves the hover glow draws', () => {
  it('draws the cut straight after a rapid from where the rapid ended — a ramp entry', () => {
    const [run] = toolpathRuns([rapid(0, 0, 5), rapid(10, 0, 5), cut(20, 0, -2), cut(30, 0, -2)])
    expect(run.cmds).toEqual([
      { k: 'M', x: 0, y: 0 }, { k: 'M', x: 10, y: 0 },
      { k: 'L', x: 20, y: 0 }, { k: 'L', x: 30, y: 0 },
    ])
  })

  it('draws the first helix turn after a rapid as an arc', () => {
    const [run] = toolpathRuns([rapid(13, 10, 5), cut(13, 10, -2, { arc: { cx: 10, cy: 10, cw: false } })])
    expect(run.cmds[1]).toMatchObject({ k: 'A', cx: 10, cy: 10, r: 3, anticlockwise: false })
    expect((run.cmds[1] as { a1: number; a0: number }).a1 - (run.cmds[1] as { a0: number }).a0).toBeCloseTo(2 * Math.PI)
  })

  it('marks every hole of a peck drill once, as a plunge — it has no XY move to draw', () => {
    // Two holes, two pecks each: rapid over, cut down, rapid up to the chip break, cut down, retract.
    const hole = (x: number, y: number): MotionSegment[] => [rapid(x, y, 5), cut(x, y, -2), rapid(x, y, 0), cut(x, y, -4), rapid(x, y, 5)]
    const [run] = toolpathRuns([...hole(10, 10), ...hole(30, 10)])
    expect(run.cmds.filter((c) => c.k === 'D')).toEqual([{ k: 'D', x: 10, y: 10 }, { k: 'D', x: 30, y: 10 }])
    expect(run.cmds.some((c) => c.k === 'L')).toBe(false)
  })

  it('starts a new run at a tool change, from an unknown position', () => {
    const runs = toolpathRuns([rapid(0, 0, 5), cut(5, 0, -1), { x: 0, y: 0, z: 5, rapid: true, toolChange: 't2' } as MotionSegment, cut(7, 7, -1), cut(9, 7, -1)])
    expect(runs.map((r) => r.toolId)).toEqual([null, 't2'])
    expect(runs[1].cmds).toEqual([{ k: 'M', x: 7, y: 7 }, { k: 'L', x: 9, y: 7 }])
  })
})

describe('swathRuns — the hover glow is as wide as the tool cuts at each depth', () => {
  const VBIT: Tool = { id: 'v', name: '90° V', type: 'vbit', diameterMM: 12, vbitAngleDeg: 90, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 10 }
  const EM: Tool = { ...VBIT, id: 'e', type: 'endmill', diameterMM: 6 }
  const widthOf = (tool: Tool) => (_: string | null, z: number) => 2 * toolRadiusAtHeight(tool, Math.max(0, -z))
  const total = (r: ReturnType<typeof swathRuns>[number]) => [...r.byWidth].map(([w, cmds]) => [w, cmds.filter((c) => c.k === 'L').length])

  it('draws a V-bit at the width of its groove, not at the full diameter of the bit', () => {
    // 90° V-bit 1 mm deep cuts 2 mm wide; its 12 mm diameter would light up six times that.
    const [run] = swathRuns([rapid(0, 0, 5), cut(0, 0, -1), cut(20, 0, -1)], widthOf(VBIT))
    expect([...run.byWidth.keys()]).toEqual([2])
  })

  it('narrows and widens along a sloping carve, piece by piece', () => {
    // From 0 to 3 mm deep over 10 mm: 0 → 6 mm wide, split into ≤ 0.5 mm pieces.
    const [run] = swathRuns([rapid(0, 0, 5), cut(0, 0, 0), cut(10, 0, -3)], widthOf(VBIT))
    const widths = [...run.byWidth.keys()].sort((a, b) => a - b)
    expect(widths[0]).toBeLessThan(0.2)
    expect(widths[widths.length - 1]).toBeGreaterThan(5.8)
    expect(widths.length).toBeGreaterThan(10)
  })

  it('keeps an end mill at its one width, as one group, unsplit', () => {
    const [run] = swathRuns([rapid(0, 0, 5), cut(0, 0, -1), cut(20, 0, -3), cut(20, 20, -3)], widthOf(EM))
    expect(total(run)).toEqual([[6, 2]])
  })

  it('marks a plunge at the width it reaches', () => {
    const [run] = swathRuns([rapid(5, 5, 5), cut(5, 5, -2)], widthOf(VBIT))
    expect([...run.byWidth]).toEqual([[4, [{ k: 'D', x: 5, y: 5 }]]])
  })
})
