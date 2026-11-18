import { describe, it, expect } from 'vitest'
import { toolpathRuns } from './toolpathRuns'
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
