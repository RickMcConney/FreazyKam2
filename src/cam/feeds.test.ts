import { describe, it, expect, beforeEach } from 'vitest'
import {
  targetChipLoad, aimChipLoad, minChipLoad, rigidityChipFactor, rigidityFeedCeilingMmMin,
  feedsForTool, effectiveStepDownMM, seedStepDownMM, trochoidalEngagementFraction,
} from './feeds'
import { useWorkpieceStore, MATERIAL_INFO } from '../store/workpieceStore'
import { maxCutRadiusMM, feedDiameterMM } from './geom'
import type { Tool } from '../store/toolStore'

const EM6: Tool = {
  id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 2500, zFeedMmMin: 500, maxDepthMM: 25,
}

// A taper's stored diameter is its 1 mm TIP; it cuts about 6 mm wide at its Max Z.
const TAPER: Tool = {
  id: 'tp', name: 'Taper', type: 'taper', diameterMM: 1, fluteCount: 2, vbitAngleDeg: 7.5,
  rpm: 18000, xyFeedMmMin: 2500, zFeedMmMin: 500, maxDepthMM: 20,
}

/** The machine/material state every number here is derived from. */
const machine = (over: Record<string, unknown> = {}) =>
  useWorkpieceStore.setState({
    material: 'oak', machineRigidity: 3, maxFeedMmMin: 0,
    minSpindleRpm: 8000, maxSpindleRpm: 24000, autoFeedEnabled: true, ...over,
  } as Parameters<typeof useWorkpieceStore.setState>[0])

beforeEach(() => machine())

describe('targetChipLoad', () => {
  it('is the material\'s own chart figure for a 6 mm end mill', () => {
    // A property of tool type + diameter + material ONLY — machine rigidity is
    // deliberately absent, because it trims the chip later, within the material's floor.
    for (const m of ['pine', 'oak', 'delrin', 'aluminum'] as const)
      expect(targetChipLoad('endmill', 6, m)).toBeCloseTo(MATERIAL_INFO[m].chipLoadMM, 9)
  })

  it('gives each tool type its share of an end mill\'s chip', () => {
    const em = targetChipLoad('endmill', 6, 'oak')
    expect(targetChipLoad('ballnose', 6, 'oak') / em).toBeCloseTo(0.8, 9)
    expect(targetChipLoad('taper', 6, 'oak') / em).toBeCloseTo(0.7, 9)
    expect(targetChipLoad('vbit', 6, 'oak') / em).toBeCloseTo(0.6, 9)
    expect(targetChipLoad('drill', 6, 'oak') / em).toBeCloseTo(1, 9)
  })

  it('scales with diameter, but only within 0.3× and 2×', () => {
    // A bigger cutter takes a bigger bite; the clamps stop a 0.5 mm engraver being
    // handed a chip it cannot survive, and a 60 mm surfacing bit an absurd one.
    const at6 = targetChipLoad('endmill', 6, 'oak')
    expect(targetChipLoad('endmill', 12, 'oak')).toBeCloseTo(2 * at6, 9)
    expect(targetChipLoad('endmill', 1, 'oak')).toBeCloseTo(0.3 * at6, 9)
    expect(targetChipLoad('endmill', 60, 'oak')).toBeCloseTo(2 * at6, 9)
  })

  it('is set by the material, not its hardness — Delrin is harder than MDF and still takes a thicker chip', () => {
    // Under the old hardness-only model Delrin (0.9) got a thinner chip than MDF
    // (0.8). A plastic needs a THICK chip to carry its heat away.
    expect(MATERIAL_INFO.delrin.hardness).toBeGreaterThan(MATERIAL_INFO.mdf.hardness)
    expect(targetChipLoad('endmill', 6, 'delrin')).toBeGreaterThan(targetChipLoad('endmill', 6, 'mdf'))
  })
})

describe('aimChipLoad', () => {
  it('trims the chip on a softer machine', () => {
    expect([1, 2, 3, 4, 5].map(rigidityChipFactor)).toEqual([0.6, 0.7, 0.8, 0.95, 1.05])
    expect(aimChipLoad('endmill', 6, 'oak', 5)).toBeGreaterThan(aimChipLoad('endmill', 6, 'oak', 1))
  })

  it('never trims below the material\'s floor, which for a plastic is most of its chip', () => {
    // The floor is what stops a light machine melting plastic: a hobby gantry gets
    // the SAME chip in Delrin as a prosumer one, and is protected by a lower feed instead.
    for (const R of [1, 2, 3, 4, 5])
      expect(aimChipLoad('endmill', 3, 'delrin', R)).toBeGreaterThanOrEqual(minChipLoad('endmill', 3, 'delrin'))
    expect(minChipLoad('endmill', 6, 'delrin') / targetChipLoad('endmill', 6, 'delrin')).toBeCloseTo(0.85, 9)
    expect(aimChipLoad('endmill', 6, 'delrin', 1)).toBe(aimChipLoad('endmill', 6, 'delrin', 3))
  })

  it('floors wood lower than plastic, and metal between them', () => {
    const frac = (m: 'pine' | 'delrin' | 'aluminum') => minChipLoad('endmill', 6, m) / targetChipLoad('endmill', 6, m)
    expect(frac('pine')).toBeLessThan(frac('aluminum'))
    expect(frac('aluminum')).toBeLessThan(frac('delrin'))
  })

  it('rounds and clamps a rigidity outside 1..5', () => {
    expect(rigidityChipFactor(0)).toBe(0.6)
    expect(rigidityChipFactor(9)).toBe(1.05)
    expect(rigidityChipFactor(3.4)).toBe(0.8)
    expect(rigidityChipFactor(3.6)).toBe(0.95)
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
  const chip = (f: { xyFeedMmMin: number; rpm: number }, t: Tool) => f.xyFeedMmMin / (f.rpm * t.fluteCount)

  it('holds the aimed chip load: feed = chip × flutes × rpm', () => {
    // The whole model in one identity. Chip load does not depend on depth of cut, so
    // when the machine should feed slower the fix is to slow the SPINDLE — which is
    // why rpm is an output here and not an input.
    const f = feedsForTool(EM6)
    expect(chip(f, EM6)).toBeCloseTo(aimChipLoad('endmill', 6, 'oak', 3), 9)
  })

  it('cuts a 3 mm single-flute bit in Delrin on a hobby machine with a chip that clears its heat', () => {
    // The case that melted: hardness alone handed this bit 0.0097 mm/tooth at
    // 19,000 rpm = 185 mm/min. Acetal wants ~0.08 mm/tooth on a 1/8" O-flute.
    const O3: Tool = { ...EM6, id: 'o3', diameterMM: 3, fluteCount: 1, maxDepthMM: 12 }
    machine({ material: 'delrin', machineRigidity: 1, maxFeedMmMin: 3000, maxSpindleRpm: 19000 })
    const f = feedsForTool(O3)
    expect(chip(f, O3)).toBeGreaterThanOrEqual(minChipLoad('endmill', 3, 'delrin') - 1e-9)
    expect(chip(f, O3)).toBeGreaterThan(0.06)
    expect(f.xyFeedMmMin).toBeGreaterThan(1000)
  })

  it('protects a softer machine with a lower feed and a slower spindle', () => {
    machine({ machineRigidity: 1 })
    const soft = feedsForTool(EM6)
    machine({ machineRigidity: 5 })
    const stiff = feedsForTool(EM6)
    expect(stiff.xyFeedMmMin).toBeGreaterThan(soft.xyFeedMmMin)
    expect(stiff.rpm).toBeGreaterThan(soft.rpm)
    expect(soft.xyFeedMmMin).toBeCloseTo(rigidityFeedCeilingMmMin(1), 0)
  })

  it('in a plastic, gives a softer machine the SAME chip at a slower spindle', () => {
    machine({ material: 'delrin', machineRigidity: 1, minSpindleRpm: 3000 })
    const soft = feedsForTool(EM6)
    machine({ material: 'delrin', machineRigidity: 3, minSpindleRpm: 3000 })
    const mid = feedsForTool(EM6)
    expect(chip(soft, EM6)).toBeCloseTo(chip(mid, EM6), 9)
    expect(soft.rpm).toBeLessThan(mid.rpm)
  })

  it('when the spindle cannot slow further, thins a wood chip only to its floor, then runs over the soft feed target', () => {
    // Pine at R1 on an 8000 rpm router: 8000 rpm at the aimed chip overshoots the
    // 1200 mm/min target, so the chip gives way first — but never into "rubbing".
    machine({ material: 'pine', machineRigidity: 1 })
    const f = feedsForTool(EM6)
    expect(f.rpm).toBe(8000)
    expect(f.xyFeedMmMin).toBeCloseTo(1200, 6)
    expect(chip(f, EM6)).toBeGreaterThanOrEqual(0.8 * aimChipLoad('endmill', 6, 'pine', 1) - 1e-9)
    // A plastic keeps its chip and exceeds the target instead.
    machine({ material: 'hdpe', machineRigidity: 1 })
    const p = feedsForTool(EM6)
    expect(p.rpm).toBe(8000)
    expect(chip(p, EM6)).toBeCloseTo(aimChipLoad('endmill', 6, 'hdpe', 1), 9)
    expect(p.xyFeedMmMin).toBeGreaterThan(rigidityFeedCeilingMmMin(1))
  })

  it('never thins its own chip into the band the simulator and preflight call rubbing', () => {
    // A router that idles at 20,000 rpm forces the thinning at every rigidity. The
    // gauge reads "rubbing" under 0.75× the aim, so auto feeds must stay above that.
    for (const R of [1, 2, 3, 4, 5]) {
      machine({ material: 'pine', machineRigidity: R, minSpindleRpm: 20000 })
      const f = feedsForTool(EM6)
      expect(chip(f, EM6) / aimChipLoad('endmill', 6, 'pine', R), `R${R}`).toBeGreaterThanOrEqual(0.8 - 1e-9)
    }
  })

  it('never exceeds the machine\'s maximum feed, and drops the rpm to stay under it', () => {
    machine({ maxFeedMmMin: 500, minSpindleRpm: 1000 })
    const f = feedsForTool(EM6)
    // Just UNDER, never over: the rpm is rounded to a whole number, and rounding down
    // is the only safe direction when the cap is what the gantry can physically do.
    expect(f.xyFeedMmMin).toBeLessThanOrEqual(500)
    expect(f.xyFeedMmMin).toBeCloseTo(500, 0)
    expect(f.rpm).toBeLessThan(24000)
    expect(f.rpm).toBeGreaterThanOrEqual(1000)
  })

  it('keeps the rpm inside the spindle\'s own range', () => {
    machine({ machineRigidity: 5, minSpindleRpm: 10000, maxSpindleRpm: 12000, maxFeedMmMin: 100000 })
    expect(feedsForTool(EM6).rpm).toBe(12000)
    machine({ minSpindleRpm: 10000, maxSpindleRpm: 12000, maxFeedMmMin: 1 })
    expect(feedsForTool(EM6).rpm).toBe(10000)
  })

  it('says when it changed the rpm the tool was saved with', () => {
    const f = feedsForTool(EM6)
    expect(f.rpmAdjusted).toBe(true)
    expect(feedsForTool({ ...EM6, rpm: f.rpm }).rpmAdjusted).toBe(false)
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

  it('judges a taper by its widest cutting diameter, not its tip', () => {
    // Surface speed peaks where the tool is widest. Taken from the 1 mm tip, the
    // ceiling (~47,000 rpm) sat above the spindle's top speed and capped nothing.
    machine({ material: 'aluminum', minSpindleRpm: 3000 })
    const vcRpm = Math.floor((150 * 1000) / (Math.PI * 2 * maxCutRadiusMM(TAPER)))
    expect(vcRpm).toBeLessThan(24000)
    expect(feedsForTool(TAPER).rpm).toBe(vcRpm)
  })

  it('leaves wood alone — it has no Vc ceiling', () => {
    machine({ material: 'oak', machineRigidity: 5, minSpindleRpm: 8000, maxFeedMmMin: 100000 })
    expect(feedsForTool(EM6)).toMatchObject({ rpm: 24000, spindleTooFast: false })
  })
})

describe('effectiveStepDownMM', () => {
  it('sizes a taper\'s step-down by its mean cutting diameter, not its tip', () => {
    // The same cap an end mill of that diameter gets; the 1 mm tip gave a quarter of it.
    const asMill: Tool = { ...EM6, diameterMM: feedDiameterMM(TAPER), maxDepthMM: TAPER.maxDepthMM }
    expect(feedDiameterMM(TAPER)).toBeGreaterThan(3)
    expect(effectiveStepDownMM(TAPER, 0, 12)).toBeCloseTo(effectiveStepDownMM(asMill, 0, 12), 9)
  })

  it('hands back the user\'s own value when auto feeds are off', () => {
    machine({ autoFeedEnabled: false })
    expect(effectiveStepDownMM(EM6, 7.3, 20)).toBe(7.3)
  })

  it('never hands back a step-down no pass can take, even with auto feeds off', () => {
    // A 0 (hand-edited file, stale form default) looped inlay and profile3d forever.
    machine({ autoFeedEnabled: false })
    expect(effectiveStepDownMM(EM6, 0, 20)).toBe(0.01)
    expect(effectiveStepDownMM(EM6, NaN, 20)).toBe(0.01)
    expect(effectiveStepDownMM(EM6, -2, 20)).toBe(2)
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
