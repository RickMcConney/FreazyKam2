import { describe, it, expect, beforeEach } from 'vitest'
import {
  targetChipLoad, rigidityFeedFactor, feedsForTool, effectiveStepDownMM,
  seedStepDownMM, trochoidalEngagementFraction,
} from './feeds'
import { useWorkpieceStore, MATERIAL_INFO } from '../store/workpieceStore'
import type { Tool } from '../store/toolStore'

const EM6: Tool = {
  id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 2500, zFeedMmMin: 500, maxDepthMM: 25,
}

/** The machine/material state every number here is derived from. */
const machine = (over: Record<string, unknown> = {}) =>
  useWorkpieceStore.setState({
    material: 'oak', machineRigidity: 3, maxFeedMmMin: 0,
    minSpindleRpm: 8000, maxSpindleRpm: 24000, autoFeedEnabled: true, ...over,
  } as Parameters<typeof useWorkpieceStore.setState>[0])

beforeEach(() => machine())

describe('targetChipLoad', () => {
  it('is the manufacturer figure for the tool type at the reference diameter', () => {
    // A property of tool type + diameter + material ONLY — machine rigidity is
    // deliberately absent, because that scales the feed, not the chip.
    expect(targetChipLoad('endmill', 6, 1)).toBeCloseTo(0.05, 6)
    expect(targetChipLoad('ballnose', 6, 1)).toBeCloseTo(0.04, 6)
    expect(targetChipLoad('vbit', 6, 1)).toBeCloseTo(0.03, 6)
    expect(targetChipLoad('drill', 6, 1)).toBeCloseTo(0.05, 6)
  })

  it('scales with diameter, but only within 0.3× and 2×', () => {
    // A bigger cutter takes a bigger bite; the clamps stop a 0.5 mm engraver being
    // handed a chip it cannot survive, and a 60 mm surfacing bit an absurd one.
    expect(targetChipLoad('endmill', 12, 1)).toBeCloseTo(0.1, 6)
    expect(targetChipLoad('endmill', 1, 1)).toBeCloseTo(0.05 * 0.3, 6)
    expect(targetChipLoad('endmill', 60, 1)).toBeCloseTo(0.05 * 2, 6)
  })

  it('divides by hardness, and treats a zero hardness as 1', () => {
    expect(targetChipLoad('endmill', 6, 2)).toBeCloseTo(0.025, 6)
    expect(targetChipLoad('endmill', 6, 0)).toBe(targetChipLoad('endmill', 6, 1))
  })
})

describe('rigidityFeedFactor', () => {
  it('runs from a light chip on a hobby gantry to a heavy one on a stiff machine', () => {
    expect([1, 2, 3, 4, 5].map(rigidityFeedFactor)).toEqual([0.35, 0.5, 0.65, 0.95, 1.1])
  })

  it('rounds and clamps a rigidity outside 1..5', () => {
    expect(rigidityFeedFactor(0)).toBe(0.35)
    expect(rigidityFeedFactor(9)).toBe(1.1)
    expect(rigidityFeedFactor(3.4)).toBe(0.65)
    expect(rigidityFeedFactor(3.6)).toBe(0.95)
  })
})

describe('feedsForTool — auto feeds OFF', () => {
  it('keeps the tool\'s own numbers', () => {
    machine({ autoFeedEnabled: false })
    expect(feedsForTool(EM6)).toEqual({
      xyFeedMmMin: 2500, plungeMmMin: 500, rpm: 18000, rpmAdjusted: false, spindleTooFast: false,
    })
  })

  it('still honours the machine\'s maximum feed, which is a hard limit', () => {
    // The one thing auto-off does not get to override: the gantry cannot go faster
    // than it can go.
    machine({ autoFeedEnabled: false, maxFeedMmMin: 1200 })
    const f = feedsForTool(EM6)
    expect(f.xyFeedMmMin).toBe(1200)
    expect(f.plungeMmMin).toBe(500)   // already under the cap
  })
})

describe('feedsForTool — auto feeds ON', () => {
  it('holds the aimed chip load: feed = chip × flutes × rpm', () => {
    // The whole model in one identity. Chip load does not depend on depth of cut, so
    // when the machine cannot feed fast enough the fix is to slow the SPINDLE — which
    // is why rpm is an output here and not an input.
    const f = feedsForTool(EM6)
    const aim = targetChipLoad('endmill', 6, MATERIAL_INFO.oak.hardness) * rigidityFeedFactor(3)
    expect(f.xyFeedMmMin / (f.rpm * EM6.fluteCount)).toBeCloseTo(aim, 9)
  })

  it('feeds harder on a stiffer machine and gentler on a softer one', () => {
    machine({ machineRigidity: 1 })
    const soft = feedsForTool(EM6).xyFeedMmMin
    machine({ machineRigidity: 5 })
    const stiff = feedsForTool(EM6).xyFeedMmMin
    expect(stiff).toBeGreaterThan(soft)
    expect(stiff / soft).toBeCloseTo(1.1 / 0.35, 6)
  })

  it('never exceeds the machine\'s maximum feed, and drops the rpm to stay under it', () => {
    machine({ maxFeedMmMin: 500 })
    const f = feedsForTool(EM6)
    // Just UNDER, never over: the rpm is rounded to a whole number, and rounding down
    // is the only safe direction when the cap is what the gantry can physically do.
    expect(f.xyFeedMmMin).toBeLessThanOrEqual(500)
    expect(f.xyFeedMmMin).toBeCloseTo(500, 1)
    expect(f.rpm).toBeLessThan(24000)
    expect(f.rpm).toBeGreaterThanOrEqual(8000)
  })

  it('keeps the rpm inside the spindle\'s own range', () => {
    machine({ minSpindleRpm: 10000, maxSpindleRpm: 12000, maxFeedMmMin: 100000 })
    expect(feedsForTool(EM6).rpm).toBe(12000)
    machine({ minSpindleRpm: 10000, maxSpindleRpm: 12000, maxFeedMmMin: 1 })
    expect(feedsForTool(EM6).rpm).toBe(10000)
  })

  it('says when it changed the rpm the tool was saved with', () => {
    expect(feedsForTool(EM6).rpmAdjusted).toBe(true)
    expect(feedsForTool({ ...EM6, rpm: 24000 }).rpmAdjusted).toBe(false)
  })

  it('gives the plunge a floor so it never creeps to nothing', () => {
    machine({ maxFeedMmMin: 60 })
    expect(feedsForTool(EM6).plungeMmMin).toBe(50)
  })
})

describe('feedsForTool — the surface-speed ceiling on metals', () => {
  it('caps the rpm so the edge does not burn in aluminium', () => {
    // rpm = Vc / (π·d), FLOORED so rounding can never nudge Vc over the limit.
    machine({ material: 'aluminum', minSpindleRpm: 3000 })
    const vcRpm = Math.floor((150 * 1000) / (Math.PI * 6))
    const f = feedsForTool(EM6)
    expect(f.rpm).toBe(vcRpm)
    expect(f.spindleTooFast).toBe(false)
  })

  it('flags a spindle that cannot go slow enough, rather than pretending', () => {
    // A trim router idling at 8000 rpm is already past aluminium's safe surface speed
    // for a 6 mm cutter. Nothing here can fix that — the answer is a smaller bit or a
    // VFD — so it is reported instead of being silently ignored.
    machine({ material: 'aluminum', minSpindleRpm: 8000 })
    const f = feedsForTool(EM6)
    expect(f.spindleTooFast).toBe(true)
    expect(f.rpm).toBe(8000)   // the machine's floor still wins; it cannot go slower
  })

  it('leaves wood alone — it has no Vc ceiling', () => {
    machine({ material: 'oak', minSpindleRpm: 8000, maxFeedMmMin: 100000 })
    expect(feedsForTool(EM6)).toMatchObject({ rpm: 24000, spindleTooFast: false })
  })
})

describe('effectiveStepDownMM', () => {
  it('hands back the user\'s own value when auto feeds are off', () => {
    machine({ autoFeedEnabled: false })
    expect(effectiveStepDownMM(EM6, 7.3, 20)).toBe(7.3)
  })

  it('divides the total depth into whole, even passes', () => {
    // 10 mm at a ~3 mm ideal comes out as three 3.33 mm passes, not three and a stub.
    const step = effectiveStepDownMM(EM6, 0, 10)
    expect(10 / step).toBeCloseTo(Math.round(10 / step), 9)
  })

  it('never overshoots the ideal depth by more than a tenth to get an even division', () => {
    // Rounding to the nearest pass count can overshoot badly — 4 mm at a 3.04 ideal
    // rounds to ONE 4 mm pass, a third deeper than the machine should take. The cap
    // forces another, shallower pass instead.
    const ideal = effectiveStepDownMM(EM6, 0, 0)   // no total depth = the raw ideal
    for (const total of [4, 7, 10, 13, 20, 100]) {
      const step = effectiveStepDownMM(EM6, 0, total)
      expect(step).toBeLessThanOrEqual(ideal * 1.1 + 1e-9)
      expect(total / step).toBeCloseTo(Math.round(total / step), 9)
    }
  })

  it('takes a shallower pass on a soft machine and in a hard material', () => {
    machine({ machineRigidity: 1 })
    const soft = effectiveStepDownMM(EM6, 0, 0)
    machine({ machineRigidity: 5 })
    const stiff = effectiveStepDownMM(EM6, 0, 0)
    expect(stiff).toBeGreaterThan(soft)

    machine({ machineRigidity: 3, material: 'pine' })
    const easy = effectiveStepDownMM(EM6, 0, 0)
    machine({ machineRigidity: 3, material: 'aluminum' })
    expect(effectiveStepDownMM(EM6, 0, 0)).toBeLessThan(easy)
  })

  it('limits a bit under 1/8" to half its diameter', () => {
    // Small cutters are far more fragile, so they never get the full-diameter pass a
    // bigger one may take.
    machine({ machineRigidity: 5, material: 'pine' })
    expect(effectiveStepDownMM({ ...EM6, diameterMM: 3, maxDepthMM: 15 }, 0, 0)).toBeLessThanOrEqual(1.5)
    expect(effectiveStepDownMM({ ...EM6, diameterMM: 6 }, 0, 0)).toBeGreaterThan(1.5)
  })

  it('steps deeper when the radial engagement is light', () => {
    // A trochoidal pass barely touches the wall and the unengaged flute sheds heat, so
    // the axial depth can climb well past what a full-slot cut allows.
    const slotting = effectiveStepDownMM(EM6, 0, 20)
    expect(effectiveStepDownMM(EM6, 0, 20, 0.2)).toBeGreaterThan(slotting)
    // Full engagement is the same as saying nothing.
    expect(effectiveStepDownMM(EM6, 0, 20, 1)).toBe(slotting)
  })

  it('lets the engagement boost climb only as far as the flute length', () => {
    // The boost is what allows a pass deeper than a diameter at all, and the tool's
    // usable flute length is where it stops. NOTE the floor: `fluteCap` is
    // max(diameterCap, maxDepthMM), so a tool whose stated max depth is SHORTER than
    // its diameter is still allowed a diameter-deep pass — maxDepthMM raises the
    // ceiling, it does not lower it.
    machine({ machineRigidity: 5, material: 'pine' })
    const deep = effectiveStepDownMM({ ...EM6, diameterMM: 6, maxDepthMM: 10 }, 0, 50, 0.05)
    expect(deep).toBeLessThanOrEqual(10)
    expect(deep).toBeGreaterThan(6)   // the boost really did take it past a diameter
  })
})

describe('seedStepDownMM', () => {
  it('seeds half a diameter for a mill and a whole one for a drill', () => {
    // A conservative full-slot pass for a cutter; a drill pecks a diameter at a time.
    expect(seedStepDownMM(EM6)).toBe(3)
    expect(seedStepDownMM({ ...EM6, type: 'drill' })).toBe(6)
  })

  it('never seeds a depth the tool cannot reach', () => {
    expect(seedStepDownMM({ ...EM6, maxDepthMM: 2 })).toBe(2)
  })

  it('falls back to 3 mm with no usable tool', () => {
    expect(seedStepDownMM(null)).toBe(3)
    expect(seedStepDownMM(undefined)).toBe(3)
    expect(seedStepDownMM({ ...EM6, diameterMM: 0 })).toBe(3)
  })
})

describe('trochoidalEngagementFraction', () => {
  it('is the forward advance per loop as a fraction of the diameter', () => {
    expect(trochoidalEngagementFraction(EM6, 1)).toBeCloseTo(1 / 6, 9)
    expect(trochoidalEngagementFraction(EM6, 6)).toBeCloseTo(1, 9)
  })

  it('reads a zero-diameter tool as full engagement, the safe answer', () => {
    expect(trochoidalEngagementFraction({ ...EM6, diameterMM: 0 }, 1)).toBe(1)
  })
})
