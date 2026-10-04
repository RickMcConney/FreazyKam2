// `regionOf`: the region {tip surface ≥ z} inside the box, from one level's contours. Its
// contours keep the material on their RIGHT, and one that runs off the box is closed by
// walking the box's edge clockwise to where the next comes back in. Every waterline flat
// is built from these regions, so a wrong closure is a flat cut in the wrong place or not
// cut at all (B6 lived here). Each case is a level with a known answer, checked by area.
import { describe, it, expect } from 'vitest'
import { areaPathsD } from 'clipper2-ts'
import { regionOf, type Chain } from './waterline'
import type { BBox } from '../canvas/selectionUtils'

const box: BBox = { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10, cx: 5, cy: 5 }

/** A contour through `pts` at level 0, open or closed. */
function chain(pts: [number, number][], closed = false): Chain {
  const flat: number[] = []
  for (const [x, y] of pts) flat.push(x, y, 0)
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  return { pts: flat, closed, minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}
const area = (chains: Chain[], edgeIn = false) => areaPathsD(regionOf(chains, box, edgeIn))

describe('regionOf closes a level\'s contours along the box', () => {
  it('one contour straight across: the material side is the half below it', () => {
    // Walking +x, the right is −y.
    expect(area([chain([[0, 5], [10, 5]])])).toBeCloseTo(50, 6)
  })

  it('two contours on opposite sides: the band between them, not either outside strip', () => {
    // Up x = 3 (material to +x) and down x = 7 (material to −x).
    expect(area([chain([[3, 0], [3, 10]]), chain([[7, 10], [7, 0]])])).toBeCloseTo(40, 6)
  })

  it('a contour that leaves and comes back in on the same side: only the bump it bounds', () => {
    // Clockwise over a triangle standing on the bottom edge.
    expect(area([chain([[3, 0], [5, 2], [7, 0]])])).toBeCloseTo(4, 6)
  })

  it('a contour across a corner: the corner it cuts off, with the corner itself in it', () => {
    expect(area([chain([[0, 4], [4, 0]])])).toBeCloseTo(8, 6)
  })

  it('a contour across a corner the other way: everything BUT that corner', () => {
    expect(area([chain([[4, 0], [0, 4]])])).toBeCloseTo(92, 6)
  })

  it('a closed contour round a peak, the box edge below the level: just the peak', () => {
    // Clockwise round [4, 6]²: material inside, on the right.
    expect(area([chain([[4, 4], [4, 6], [6, 6], [6, 4]], true)], false)).toBeCloseTo(4, 6)
  })

  it('a closed contour round a pit, the box edge above the level: the box less the pit', () => {
    // Anticlockwise round [4, 6]²: material outside. With no contour reaching the box's
    // edge, a pit's lowest level once read as no region at all.
    expect(area([chain([[4, 4], [6, 4], [6, 6], [4, 6]], true)], true)).toBeCloseTo(96, 6)
  })
})
