import { describe, it, expect, beforeEach } from 'vitest'
import { toolProfileHeightMM, toolRadiusAtHeight, cornerRadiusMM } from './geom'
import { bullKernel, ballKernel, flatKernel } from './profile3d'
import { generateGcode } from './gcode'
import { parseGcode, segTool, toolTypeOf } from '../sim/gcodeParser'
import { Heightfield } from '../sim/heightfield'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import type { Tool } from '../store/toolStore'
import type { AnyOperation } from '../store/toolpathStore'

// A BULL NOSE is a flat bottom of radius R − r rounded into the wall by a corner of radius
// r. It is the family the two straight-shanked tools belong to — r = 0 is the end mill and
// r = R the ball nose — so most of these pin it against those two ends.

const tool = (over: Partial<Tool>): Tool => ({
  id: 't', name: 'T', type: 'bullnose', diameterMM: 10, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20, cornerRadiusMM: 2, ...over,
})
const BULL = tool({})                                   // Ø10, corner 2: flat out to radius 3

describe('the bull nose profile', () => {
  it('is flat across its middle, out to R − r', () => {
    for (const d of [0, 1, 2.9, 3]) expect(toolProfileHeightMM(BULL, d)).toBe(0)
  })

  it('rises as a quarter-round of the corner radius, reaching r at the rim', () => {
    expect(toolProfileHeightMM(BULL, 4)).toBeCloseTo(2 - Math.sqrt(3), 12)   // 1 mm into the corner
    expect(toolProfileHeightMM(BULL, 5)).toBeCloseTo(2, 12)
  })

  it('cuts the full radius from the top of the corner up, and its flat at the tip', () => {
    expect(toolRadiusAtHeight(BULL, 0)).toBe(3)
    expect(toolRadiusAtHeight(BULL, 2)).toBe(5)
    expect(toolRadiusAtHeight(BULL, 10)).toBe(5)
  })

  it('has radius-at-height as the exact inverse of its profile across the corner', () => {
    for (const d of [3.1, 3.5, 4, 4.5, 4.99]) {
      expect(toolRadiusAtHeight(BULL, toolProfileHeightMM(BULL, d))).toBeCloseTo(d, 9)
    }
  })

  it('with no corner is an end mill', () => {
    const flat = tool({ cornerRadiusMM: 0 })
    const em = tool({ type: 'endmill' })
    for (const d of [0, 2, 4.9, 5]) expect(toolProfileHeightMM(flat, d)).toBe(toolProfileHeightMM(em, d))
    for (const h of [0, 1, 5]) expect(toolRadiusAtHeight(flat, h)).toBe(toolRadiusAtHeight(em, h))
  })

  it('with a corner of the full radius is a ball nose', () => {
    const round = tool({ cornerRadiusMM: 5 })
    const ball = tool({ type: 'ballnose' })
    for (const d of [0, 1, 3, 4.5, 5]) expect(toolProfileHeightMM(round, d)).toBeCloseTo(toolProfileHeightMM(ball, d), 12)
    for (const h of [0, 0.5, 2, 5]) expect(toolRadiusAtHeight(round, h)).toBeCloseTo(toolRadiusAtHeight(ball, h), 12)
  })

  it('reads a corner wider than the tool as the full radius, and a missing one as none', () => {
    expect(cornerRadiusMM(tool({ cornerRadiusMM: 99 }))).toBe(5)
    expect(cornerRadiusMM(tool({ cornerRadiusMM: undefined }))).toBe(0)
    expect(cornerRadiusMM(tool({ cornerRadiusMM: -1 }))).toBe(0)
  })

  it('sits between the end mill and the ball nose everywhere — never below the one, never above the other', () => {
    // Why an end mill was the SAFE stand-in for a bowl bit and a ball nose the gouging one.
    const ball = tool({ type: 'ballnose' })
    for (let d = 0; d <= 5; d += 0.25) {
      expect(toolProfileHeightMM(BULL, d)).toBeGreaterThanOrEqual(0)
      expect(toolProfileHeightMM(BULL, d)).toBeLessThanOrEqual(toolProfileHeightMM(ball, d) + 1e-12)
    }
  })
})

describe('the bull nose 3D Profile kernel', () => {
  // A kernel term is how far the tool's surface sits BELOW its centre height: R − f(d).
  it('is R minus the profile, the same as every other tool kernel', () => {
    const k = bullKernel(5, 2)
    for (const d of [0, 2, 3, 3.5, 4, 4.9]) expect(k.termAtDistSq(d * d)).toBeCloseTo(5 - toolProfileHeightMM(BULL, d), 12)
  })

  it('with no corner matches the flat kernel, and with a full corner the ball kernel', () => {
    for (const d of [0, 2, 4, 4.9]) {
      expect(bullKernel(5, 0).termAtDistSq(d * d)).toBeCloseTo(flatKernel(5).termAtDistSq(d * d), 12)
      expect(bullKernel(5, 5).termAtDistSq(d * d)).toBeCloseTo(ballKernel(5).termAtDistSq(d * d), 12)
    }
  })
})

describe('a bull nose through the G-code and the simulator', () => {
  const POST: PostProcessorProfile = {
    id: 'p', name: 'P', unitMode: 'mm', commentStyle: 'semicolon',
    startGcode: 'G21\nG90', endGcode: 'M30', toolChangeGcode: 'M0',
    spindleOnTemplate: 'M3 S{s}', spindleOffGcode: 'M5',
    rapidTemplate: 'G0 X{x} Y{y} Z{z}', cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
    arcCWTemplate: 'G2 X{x} Y{y} Z{z} I{i} J{j} F{f}', arcCCWTemplate: 'G3 X{x} Y{y} Z{z} I{i} J{j} F{f}',
    outputArcs: false,
  }
  beforeEach(() => {
    useWorkpieceStore.setState({
      widthMM: 100, heightMM: 80, thicknessMM: 12, origin: 'bottom-left', zOrigin: 'top',
      spindleType: 'vfd', autoFeedEnabled: false, maxFeedMmMin: 0,
    })
  })

  // One straight pass along Y = 40 at 3 mm deep.
  const op = {
    id: 'o', name: 'Groove', type: 'profile', toolId: 't', pathId: 'p', side: 'on', depthMM: 3,
    stepDownMM: 3, direction: 'climb', rampIn: false, status: 'done', color: '#fff', visible: true,
    segments: [
      { x: 20, y: 40, z: 5, rapid: true }, { x: 20, y: 40, z: -3, rapid: false }, { x: 80, y: 40, z: -3, rapid: false },
    ],
  } as unknown as AnyOperation
  const program = () => generateGcode([op], { t: BULL }, 'bull', POST)

  it('names the corner radius in the tool comment, where the simulator reads it', () => {
    expect(program()).toMatch(/bullnose-r:2\.000/)
    const { segments, toolStates } = parseGcode(program())
    const ts = segTool(segments.find((s) => !s.rapid)!, toolStates)
    expect(ts.toolCornerRadiusMM).toBe(2)
    expect(toolTypeOf(ts)).toBe('bullnose')
  })

  it('a later tool comment without the marker is not a bull nose', () => {
    const { segments, toolStates } = parseGcode('; dia 10.000mm bullnose-r:2\nG1 X1 Z-1 F100\n; dia 6.000mm\nG1 X2 Z-1 F100')
    expect(segTool(segments[1], toolStates).toolCornerRadiusMM).toBeUndefined()
  })

  it('the simulator carves the groove flat across the middle and rounded at its edges', () => {
    const { segments, toolStates } = parseGcode(program())
    const hf = new Heightfield({ NX: 101, NY: 81, sx: 1, sy: 1, gx0: 0, gy0: 0, T: 12, orgX: 0, orgY: 0 })
    hf.carveAll(segments, toolStates)
    const at = (dy: number) => hf.heightAt(50, 40 + dy)!
    for (const dy of [0, 1, 2, 3, -3]) expect(at(dy)).toBeCloseTo(9, 4)         // the flat, 3 mm deep
    expect(at(4)).toBeCloseTo(9 + 2 - Math.sqrt(3), 4)                           // 1 mm into the corner
    expect(at(-4)).toBeCloseTo(9 + 2 - Math.sqrt(3), 4)
    expect(at(6)).toBe(12)                                                        // outside the tool
  })
})
