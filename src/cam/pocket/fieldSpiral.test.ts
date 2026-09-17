// The morph spiral's loop forest: one pocket must come out as ONE chain.
//
// The forest is what decides cut ORDER, and a wrong forest is invisible in a coverage
// audit — the pocket is still fully cleared, it is just machined in a nonsensical order.
// Hence a test on the chains themselves.
import { describe, it, expect } from 'vitest'
import { buildIsothermChains } from './fieldSpiral'
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
