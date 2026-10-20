// The other side of a double-sided board in the 3D view (sim/otherSide): the other face's
// program is carved from underneath, mirrored into this face's frame. A mirror that is off
// by the job origin, or the wrong way round, puts side A's cuts under the wrong spot of
// side B — and nothing about the picture would say so.
import { describe, it, expect } from 'vitest'
import { mirrorForOtherSide } from './otherSide'
import { Heightfield, gridForSegments } from './heightfield'
import type { SimSegment, ToolState } from './gcodeParser'

const W = 100, H = 60, T = 10
const tools = [{ toolDiameterMM: 6, fluteCount: 2 } as ToolState]
// A cutting move in workpiece-local mm, written relative to the job origin as G-code is.
const cut = (x0: number, y0: number, x1: number, y1: number, z: number, org: { x: number; y: number }): SimSegment => ({
  prevX: x0 - org.x, prevY: y0 - org.y, prevZ: z, x: x1 - org.x, y: y1 - org.y, z,
  rapid: false, feedRateMmMin: 1000, lineIdx: 0, durationS: 1, startTimeS: 0, toolStateIdx: 0,
})

describe("the other face's program", () => {
  for (const org of [{ x: 0, y: 0 }, { x: 50, y: 30 }, { x: 100, y: 60 }]) {
    it(`lands under the spot it was cut beneath, whatever the job origin (${org.x}, ${org.y})`, () => {
      // Side B's x = 75 is the board's x = 25 seen from side A, for a left-right flip.
      const [m] = mirrorForOtherSide([cut(75, 20, 75, 40, -6, org)], 'left-right', W, H, org.x, org.y)
      expect(m.x + org.x).toBeCloseTo(25, 9)
      expect(m.prevX + org.x).toBeCloseTo(25, 9)
      expect(m.y + org.y).toBeCloseTo(40, 9)
    })
  }

  it('mirrors across the other axis for a top-bottom flip', () => {
    const org = { x: 0, y: 0 }
    const [m] = mirrorForOtherSide([cut(20, 50, 40, 50, -6, org)], 'top-bottom', W, H, 0, 0)
    expect([m.prevX, m.x, m.y]).toEqual([20, 40, 10])
  })

  it('carved from underneath, meets a cut from this face in a hole — and only where both cut', () => {
    const org = { x: 50, y: 30 }
    const top = [cut(25, 10, 25, 50, -6, org)]
    const under = mirrorForOtherSide([cut(75, 20, 75, 40, -6, org)], 'left-right', W, H, org.x, org.y)
    const g = gridForSegments(W, H, T, top, tools, org.x, org.y, 0.5)
    const a = new Heightfield(g), b = new Heightfield(g)
    a.carveAll(top, tools)
    b.carveAll(under, tools)
    // The board between the faces: this face's surface down to the other face's coming up.
    const gap = (x: number, y: number) => a.heightAt(x, y)! - (T - b.heightAt(x, y)!)
    expect(gap(25, 30)).toBeLessThanOrEqual(0)     // 6 + 6 through a 10 mm board
    expect(gap(25, 15)).toBeCloseTo(4, 6)          // only this face: 4 mm left
  })
})
