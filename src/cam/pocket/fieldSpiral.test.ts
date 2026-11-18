// The morph spiral's loop forest: one pocket must come out as ONE chain.
//
// The forest is what decides cut ORDER, and a wrong forest is invisible in a coverage
// audit — the pocket is still fully cleared, it is just machined in a nonsensical order.
// Hence a test on the chains themselves.
import { describe, it, expect } from 'vitest'
import { buildIsothermChains } from './fieldSpiral'
import { generatePocket } from '../pocket'
import type { Tool } from '../../store/toolStore'
import type { MotionSegment } from '../../store/toolpathStore'
import { insetRing, setGap } from './shared'
import { solveField } from '../spiralField'
import { flattenPath, signedArea, type Pt2 } from '../pathFlattener'
import { generateShapeD, type ShapeParams } from '../../shapes/shapeGenerators'
import { JoinType } from 'clipper2-ts'

function chainsFor(p: ShapeParams, diameterMM: number, stepoverPercent: number) {
  const boundary = flattenPath(generateShapeD(p), 0.05)[0]
  const toolRadius = diameterMM / 2
  const inset = insetRing(boundary, toolRadius, JoinType.Round)
  const g = solveField([inset], [], Math.max(0.25, toolRadius / 4))
  return {
    inset,
    chains: buildIsothermChains(g, inset, [], diameterMM * (stepoverPercent / 100), true,
      Math.abs(signedArea(boundary)), Infinity),
  }
}

const maxRadius = (loop: Pt2[]) => Math.max(...loop.map(q => Math.hypot(q[0], q[1])))

describe('isotherm chains nest under the wall', () => {
  // A star at a small stepover puts the first isotherm right on top of the inset ring: it
  // weaves in and out of it by a fraction of a millimetre, so most of its vertices sample
  // as OUTSIDE and the containment vote cannot place it. It used to become a second root,
  // which left the wall childless — a one-loop chain, which reads as a leaf and therefore
  // seeds a centre fill. The tool bored the middle of the star, drove straight out to the
  // wall, cut a lap round it, and only then came back for the real spiral.
  it('keeps a star at 45% stepover as one chain', () => {
    const star: ShapeParams = { type: 'star', cx: 0, cy: 0, outerRadius: 50, innerRadius: 25, points: 5 }
    const { inset, chains } = chainsFor(star, 3.175, 45)
    expect(chains).toHaveLength(1)
    expect(chains[0].loopsOuterToInner.length).toBeGreaterThan(2)
    const outermost = chains[0].loopsOuterToInner[0]
    // Not the wall — the finishing pass owns that ring, and a chain that keeps it machines
    // it twice. But within one stepover of it, so the two passes still meet.
    expect(maxRadius(outermost)).toBeLessThan(maxRadius(inset) - 0.5)
    expect(setGap([outermost], [inset])).toBeLessThanOrEqual(3.175 * 0.45)
  })

  // Same defect, less visible: it also fired on a plain rectangle with a 1/8" cutter.
  it('keeps a rectangle at 40% stepover as one chain', () => {
    const r: ShapeParams = { type: 'rectangle', x: 0, y: 0, w: 60, h: 35 }
    const { chains } = chainsFor(r, 3.175, 40)
    expect(chains).toHaveLength(1)
  })
})

describe('a morph pocket of several chains enters each one from stock it has already cut', () => {
  // Two 40 mm lobes joined by a 10 mm neck, and three in a row: each lobe is its own chain.
  // Every chain after the first on a level was entered as if the level were already cut
  // there — a G0 a full step down into solid stock, and a "helix" that then descended
  // nothing. And when the hop to the next chain looked safe, the climb to safe height was
  // a diagonal G0 starting at depth, dragging the cutter sideways through the cut at rapid.
  //
  // Judged by replaying the toolpath: every feed move marks the floor it cut (sampled every
  // 0.5 mm), and a rapid may only END below the stock top where something already cut at
  // least that deep within the tool's radius. A rapid that LEAVES depth must go straight up.
  const TOOL: Tool = {
    id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
    rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
  }
  const shapes: Record<string, string> = {
    dumbbell: 'M 0 0 L 40 0 L 40 15 L 60 15 L 60 0 L 100 0 L 100 40 L 60 40 L 60 25 L 40 25 L 40 40 L 0 40 Z',
    threeLobe: 'M 0 0 L 40 0 L 40 15 L 55 15 L 55 0 L 95 0 L 95 15 L 110 15 L 110 0 L 150 0 L 150 40 ' +
      'L 110 40 L 110 25 L 95 25 L 95 40 L 55 40 L 55 25 L 40 25 L 40 40 L 0 40 Z',
  }
  function rapidFaults(segs: MotionSegment[]): string[] {
    const R = TOOL.diameterMM / 2
    const cut: [number, number, number][] = []
    const faults: string[] = []
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i]
      if (b.rapid) {
        if (b.z < -1e-6 && b.z < a.z - 1e-9 &&
            !cut.some(([x, y, z]) => z <= b.z + 1e-6 && Math.hypot(x - b.x, y - b.y) <= R)) {
          faults.push(`G0 into uncut stock at (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) Z${b.z}`)
        }
        if (a.z < -1e-6 && (Math.abs(b.x - a.x) > 1e-6 || Math.abs(b.y - a.y) > 1e-6)) {
          faults.push(`diagonal G0 out of Z${a.z} at (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`)
        }
        continue
      }
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5))
      for (let k = 0; k <= n; k++) {
        const t = k / n
        cut.push([a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t])
      }
    }
    return faults
  }

  for (const [name, d] of Object.entries(shapes)) {
    it(`${name}: no G0 into uncut stock and no diagonal G0 out of the cut, at 30% and 50%, plain and ramped`, () => {
      const faults: string[] = []
      for (const stepoverPercent of [30, 50]) for (const rampIn of [false, true]) {
        const segs = generatePocket(d, TOOL, {
          strategy: 'morph', forceStrategy: true, depthMM: 6, stepDownMM: 3, stepoverPercent,
          direction: 'climb', islandDs: [], angle: 0, rampIn, safeHeightMM: 5,
        } as Parameters<typeof generatePocket>[2])
        faults.push(...rapidFaults(segs).map((f) => `${stepoverPercent}% ramp=${rampIn}: ${f}`))
      }
      expect(faults).toEqual([])
    })
  }
})
