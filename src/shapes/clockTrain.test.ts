import { describe, it, expect } from 'vitest'
import {
  CLOCK_PART_ORDER, TRAIN_PART_ORDER, solveMotionWork, MOTION_RATIOS, MOTION_LINK,
  clockArborClashes, clockMotionFromPaths, type ClockMotion, DEFAULT_CLOCK_SPEC, G_MM, clockRoot, defaultLinkAngles, clockAssemblyFromPaths, clockPlate, clockPose,
  designClock, escapeRevSeconds, layoutClock,
  pendulumLengthMM, pinForTooth, solveDrive, solveTrain, trainRatio,
  dragLinkAngle, escapeClockwiseFor, trainWheelsOf, meshCountOf, trainSenses,
  DEFAULT_TRAIN_WHEELS, LEGACY_TRAIN_WHEELS,
  type ClockAssembly, type ClockPlate, type ClockSpec,
} from './clockTrain'
import { gearHubOf, gearMesh, generateGearParts, pinionDims } from './gearGenerator'
import { generatePendulumParts, pendulumBeat } from './pendulumGenerator'
import { DEFAULT_SHAPE_CONFIG, generateShapeParts, type ShapeParams } from './shapeGenerators'
import { getMultiBBox } from '../canvas/selectionUtils'
import { flattenPath } from '../cam/pathFlattener'

const BASE = {
  gear: DEFAULT_SHAPE_CONFIG.gear,
  escapement: DEFAULT_SHAPE_CONFIG.escapement,
  pendulum: DEFAULT_SHAPE_CONFIG.pendulum,
}
/**
 * The FOUR-wheel train, on 12-pin pinions: what a clock was before three wheels
 * became the default, and still an option (`ClockSpec.trainWheels`).
 *
 * Most of the structural tests below are written against it rather than against
 * the default, and deliberately: it is the LONGER walk, with a third wheel and a
 * fourth mesh, so it exercises every index a three-wheel train does and one
 * more. The three-wheel default gets its own tests for the things that are
 * genuinely different about it — the mesh count, the pin floor that makes two
 * meshes possible, and the handedness that follows from an even mesh count.
 */
const FOUR: ClockSpec = { ...DEFAULT_CLOCK_SPEC, trainWheels: 4, minPins: 12 }

/** The going train only — the pendulum hangs off the anchor and is on no arbor,
 *  so it is not part of what stands up as a plate. */
const trainOf = (d: ReturnType<typeof designClock>): ClockAssembly =>
  d.parts.filter((p) => TRAIN_PART_ORDER.includes(p.key))
    .map((p) => ({ key: p.key, params: p.params as ClockAssembly[number]['params'] }))

describe('pendulum', () => {
  it('gives the seconds pendulum for a one-second beat', () => {
    // The classic 994 mm. The beat is HALF a period, so this is a 2 s pendulum.
    expect(pendulumLengthMM(1)).toBeCloseTo(993.6, 1)
  })

  it('scales as the square of the beat', () => {
    expect(pendulumLengthMM(2) / pendulumLengthMM(1)).toBeCloseTo(4, 6)
  })
})

describe('escape wheel', () => {
  it('turns once a minute on a seconds pendulum with 30 teeth', () => {
    // Half a tooth per beat, so 30 teeth is 60 beats.
    expect(escapeRevSeconds(1, 30)).toBe(60)
  })

})

describe('going train', () => {
  it('is 60:1 at the default spec', () => {
    // Escape wheel once a minute, great wheel once an hour.
    expect(trainRatio(DEFAULT_CLOCK_SPEC)).toBeCloseTo(60, 9)
  })

  it('solves the default three-wheel clock as 64 / 60 on 8-pin pinions', () => {
    // The standard English seconds-pendulum going train: 64/8 then 60/8 is
    // 8 × 7.5, exactly 60:1. Two meshes rather than three is what a wooden clock
    // wants — every mesh and every pair of pivots costs torque a wooden train
    // has none of to spare — and an 8-pin LANTERN is what makes a 7.75:1 mesh
    // reasonable, the pin being a full cylinder with no undercut to fight.
    const t = solveTrain(60, 8, undefined, 2)
    expect(t.exact).toBe(true)
    expect(t.meshes.map((m) => m.teeth)).toEqual([64, 60])
    expect(t.meshes.map((m) => m.pins)).toEqual([8, 8])
    expect(t.errorSecPerDay).toBeCloseTo(0, 9)
  })

  it('solves the four-wheel train as 48 / 48 / 45 on 12-pin pinions', () => {
    const t = solveTrain(60, 12, undefined, 3)
    expect(t.exact).toBe(true)
    expect(t.meshes.map((m) => m.teeth)).toEqual([48, 48, 45])
    expect(t.meshes.map((m) => m.pins)).toEqual([12, 12, 12])
    expect(t.errorSecPerDay).toBeCloseTo(0, 9)
  })

  it('splits the ratio across however many meshes it is given', () => {
    for (const meshes of [2, 3]) {
      expect(solveTrain(60, 8, undefined, meshes).meshes).toHaveLength(meshes)
    }
  })

  it('keeps the biggest reduction at the great wheel', () => {
    for (const meshes of [2, 3]) {
      for (const ratio of [40, 48, 60, 64, 72, 90, 120]) {
        const t = solveTrain(ratio, 12, undefined, meshes)
        const rs = t.meshes.map((m) => m.teeth / m.pins)
        for (let i = 1; i < rs.length; i++) expect(rs[i - 1]).toBeGreaterThanOrEqual(rs[i])
      }
    }
  })

  it('hits every reachable ratio exactly — a train that is close is not a clock', () => {
    for (const meshes of [2, 3]) {
      for (const ratio of [30, 40, 48, 60, 64, 72, 80, 90, 96, 120]) {
        const t = solveTrain(ratio, 12, undefined, meshes)
        expect(t.exact, `${ratio} over ${meshes}`).toBe(true)
        expect(t.actualRatio).toBeCloseTo(ratio, 9)
      }
    }
  })

  it('respects the pin floor', () => {
    for (const meshes of [2, 3]) {
      for (const pins of [8, 10, 12, 14]) {
        const t = solveTrain(60, pins, undefined, meshes)
        for (const m of t.meshes) expect(m.pins).toBeGreaterThanOrEqual(pins)
      }
    }
  })

  it('prefers the fewest pins when several trains are exact', () => {
    // 60:1 is reachable on plain 12-pin pinions, so nothing should go fatter.
    expect(solveTrain(60, 12, undefined, 3).meshes.every((m) => m.pins === 12)).toBe(true)
    // …and on plain 8-pin ones over two meshes, which is the default clock.
    expect(solveTrain(60, 8, undefined, 2).meshes.every((m) => m.pins === 8)).toBe(true)
  })

  it('reports the rate error rather than pretending, when nothing is exact', () => {
    // 600/11 needs an 11 somewhere in the pinions and cannot get one.
    const t = solveTrain(600 / 11, 12, undefined, 3)
    expect(t.exact).toBe(false)
    expect(Math.abs(t.errorSecPerDay)).toBeGreaterThan(0)
    // Still the best available — well under a minute a day.
    expect(Math.abs(t.errorSecPerDay)).toBeLessThan(60)
  })

  it('signs the error the way a clock reads it — a slow train loses', () => {
    const slow = solveTrain(60, 12, undefined, 3)
    // A train geared 1% slower than needed makes the hands lose ~864 s/day.
    const t = { ...slow, actualRatio: 60 * 1.01 }
    expect(86400 * (t.targetRatio / t.actualRatio - 1)).toBeLessThan(0)
  })
})

describe('three wheels or four', () => {
  const three = designClock(DEFAULT_CLOCK_SPEC, BASE)
  const four = designClock(FOUR, BASE)
  const keys = (d: ReturnType<typeof designClock>) => d.parts.map((p) => p.key)

  it('builds a new clock with three wheels and reads an older one as four', () => {
    // A three-wheel going train is what a wooden clock wants: one fewer mesh and
    // two fewer pivots to lose torque in, which is what such a train is always
    // short of — and it cannot be bought back by hanging more weight, since the
    // weight is also what wears wooden pivots.
    expect(DEFAULT_TRAIN_WHEELS).toBe(3)
    expect(trainWheelsOf(DEFAULT_CLOCK_SPEC)).toBe(3)
    expect(meshCountOf(DEFAULT_CLOCK_SPEC)).toBe(2)
    // Absent, as on every clock designed before there was a choice — it has to
    // open cutting exactly what it always cut. Same rule as `module`.
    expect(trainWheelsOf({ trainWheels: undefined })).toBe(LEGACY_TRAIN_WHEELS)
    expect(LEGACY_TRAIN_WHEELS).toBe(4)
  })

  it('cuts 64 / 60 on 8-pin pinions for the default, and has no third wheel', () => {
    expect(three.train.meshes.map((m) => `${m.teeth}/${m.pins}`)).toEqual(['64/8', '60/8'])
    expect(three.train.exact).toBe(true)
    expect(keys(three)).toEqual(['drive', 'great', 'second', 'escapement', 'pendulum'])
    expect(keys(four)).toEqual(['drive', 'great', 'second', 'third', 'escapement', 'pendulum'])
  })

  it('turns the great wheel clockwise on either train — the minute hand is on it', () => {
    // Every external mesh reverses the sense, so the count decides the
    // escapement's handedness. Get it wrong and the hands run backwards, and
    // nothing errors: back relief would take the ACTING flank off every wheel.
    for (const d of [three, four]) {
      const senses = trainSenses(d.escapeClockwise, d.trainWheels + 1)
      expect(senses[1], `${d.trainWheels} wheels`).toBe(-1)      // −1 is clockwise
    }
    // …and the ends agree only over an EVEN number of meshes, which is what puts
    // a seconds mark on the escape wheel the right way round at three.
    expect(escapeClockwiseFor(3)).toBe(true)
    expect(escapeClockwiseFor(4)).toBe(false)
    const s3 = trainSenses(three.escapeClockwise, 4)
    expect(s3[3]).toBe(s3[1])
    const s4 = trainSenses(four.escapeClockwise, 5)
    expect(s4[4]).not.toBe(s4[1])
  })

  it('stamps that handedness on the escapement over the user’s own default', () => {
    // Which way the hands go is a decision about the CLOCK, like backlash and
    // pin diameter — not the Escapement defaults' to give.
    for (const clockwise of [true, false]) {
      const base = { ...BASE, escapement: { ...BASE.escapement, clockwise } }
      for (const spec of [DEFAULT_CLOCK_SPEC, FOUR]) {
        const d = designClock(spec, base)
        const esc = d.parts.find((p) => p.key === 'escapement')!.params
        if (esc.type !== 'escapement') throw new Error('not an escapement')
        expect(esc.clockwise, `${d.trainWheels} wheels from ${clockwise}`)
          .toBe(escapeClockwiseFor(d.trainWheels))
      }
    }
  })

  it('still turns the great wheel once an hour and the escape wheel once a minute', () => {
    for (const d of [three, four]) {
      const at = (key: string) => d.parts.find((p) => p.key === key)!.revSeconds
      expect(at('great'), `${d.trainWheels} wheels`).toBeCloseTo(3600, 6)
      expect(at('escapement')).toBeCloseTo(60, 6)
      // …and the arbor after the great wheel at the ratio of every mesh BELOW
      // it, which is one mesh on a three-wheel train and two on a four-wheel one.
      const below = d.train.meshes.slice(1).reduce((r, m) => r * (m.teeth / m.pins), 1)
      expect(at('second')).toBeCloseTo(60 * below, 6)
    }
  })

  it('hands the escape wheel the LAST mesh’s pinion, whatever the count', () => {
    for (const d of [three, four]) {
      const esc = d.parts.find((p) => p.key === 'escapement')!.params
      if (esc.type !== 'escapement') throw new Error('not an escapement')
      const last = d.train.meshes[d.train.meshes.length - 1]
      const lastModule = d.modules.meshes[d.modules.meshes.length - 1]
      expect(esc.arborPins, `${d.trainWheels} wheels`).toBe(last.pins)
      // The pin CIRCLE is the mating pinion's pitch circle, which belongs to the
      // mesh before it — the escape wheel has no module of its own to work it out.
      expect(esc.arborPinCircleDia).toBeCloseTo(lastModule.module * last.pins, 9)
      expect(esc.arborPinDia).toBe(lastModule.pinDia)
    }
  })

  it('never lightens the GREAT wheel’s own lantern, however few meshes there are', () => {
    // The small dowel is for the fast end, where torque has fallen by the whole
    // train ratio and pin INERTIA is what the escapement fights. With only three
    // meshes in all, "the last two" would reach the lantern the great wheel
    // drives — the most heavily loaded pinion in the going train.
    const large = DEFAULT_CLOCK_SPEC.pinDia, small = DEFAULT_CLOCK_SPEC.pinDiaFine!
    const fam = three.modules
    expect(fam.meshes).toHaveLength(3)
    expect(fam.meshes[2].pinDia).toBe(small)                     // the escape mesh
    expect(fam.meshes[1].pinDia).toBe(large)                     // the great wheel's own
    // …and it is the RULE deciding that, not the cap merely failing to bite.
    expect(pinForTooth(fam.meshes[1].module, large, small, DEFAULT_CLOCK_SPEC.backlash)).toBe(large)
  })

  // THE CHANGEOVER IS WHERE THE TWO MEMBERS ARE THE SAME SIZE, and a three-wheel
  // train sits close enough to it that the board decides. Pinned as a boundary,
  // not as a sample: the old fraction-of-pitch rule switched at m4.09 and this
  // one at m3.92, which is the whole difference between the great wheel's
  // lantern keeping the fat dowel on a 260 mm board and losing it.
  it('gives the slow end the fattest pin its tooth can still push', () => {
    const large = 6, small = 3, backlash = 0.3
    // π·m − 6 − 0.3 = 6 at m = 12.3/π.
    const flip = (large + large + backlash) / Math.PI
    expect(pinForTooth(flip + 0.01, large, small, backlash)).toBe(large)
    expect(pinForTooth(flip - 0.01, large, small, backlash)).toBe(small)
    // …and at the changeover the tooth is exactly as thick as the pin, which is
    // the whole statement of the rule.
    expect(Math.PI * flip - large - backlash).toBeCloseTo(large, 9)
    // Backlash is part of it — it comes off the tooth, not off the pin.
    expect(pinForTooth(flip, large, small, 0)).toBe(large)
    expect(pinForTooth(flip, large, small, 1)).toBe(small)
  })

  it('keeps the fat pin on the great wheel down to a board a three-wheel train fits', () => {
    // The failure this replaced: at 260 the old rule had already gone thin on the
    // most heavily loaded lantern in the going train.
    const pins = (maxWheelDia: number) =>
      designClock({ ...DEFAULT_CLOCK_SPEC, maxWheelDia }, BASE).modules.meshes.map((m) => m.pinDia)
    expect(pins(280)).toEqual([6, 6, 3])
    expect(pins(260)).toEqual([6, 6, 3])
    // …and gives it up where the tooth really is the weaker member: at 240 the
    // great wheel is m3.64, so a Ø6 pin would leave 5.1 mm of tooth pushing it.
    expect(pins(240)).toEqual([3, 3, 3])
  })

  it('stands a three-wheel train up on four arbors that all mesh', () => {
    const plate = clockPlate(trainOf(three), DEFAULT_CLOCK_SPEC.linkAngles)!
    expect(plate.arbors.map((a) => a.key)).toEqual(['drive', 'great', 'second', 'escapement'])
    // Every arbor but the last reaches the next one at a real centre distance.
    for (let i = 0; i < plate.arbors.length - 1; i++) {
      expect(plate.arbors[i].centreDistance, `arbor ${i}`).toBeGreaterThan(0)
    }
    expect(plate.arbors[plate.arbors.length - 1].centreDistance).toBe(0)
  })
})

describe('holding a tooth count', () => {
  // Against the FOUR-wheel train: three meshes is the longer walk, so it
  // exercises both a held wheel that is walked and one that is derived.
  const ratio = trainRatio(FOUR)
  const solve = (locked?: (number | null)[]) => solveTrain(ratio, FOUR.minPins, locked, 3)

  it('keeps the train exact round the wheel the user pinned', () => {
    for (const [i, teeth] of [[0, 60], [1, 40], [2, 36], [0, 96]] as const) {
      const locked = [null, null, null] as (number | null)[]
      locked[i] = teeth
      const t = solve(locked)
      // The pinned wheel is where it was pinned — the array is per WHEEL, and a
      // solution that moved it to another arbor would be answering another
      // question.
      expect(t.meshes[i].teeth).toBe(teeth)
      // …and the rate, which is the whole point, is still exact.
      expect(t.exact).toBe(true)
      expect(t.actualRatio).toBeCloseTo(ratio, 9)
    }
  })

  it('solves the last free wheel whichever two are held', () => {
    for (const locked of [[60, 40, null], [60, null, 40], [null, 50, 48]] as (number | null)[][]) {
      const t = solve(locked)
      locked.forEach((v, i) => { if (v !== null) expect(t.meshes[i].teeth).toBe(v) })
      expect(t.exact).toBe(true)
    }
  })

  // Three held is not a search at all — it is a train being REPORTED, and it has
  // to be reported honestly rather than quietly re-solved.
  it('reports a fully held train as it stands, right or wrong', () => {
    const good = solve([48, 48, 45])
    expect(good.meshes.map((m) => m.teeth)).toEqual([48, 48, 45])
    expect(good.exact).toBe(true)

    const bad = solve([48, 48, 44])
    expect(bad.meshes.map((m) => m.teeth)).toEqual([48, 48, 44])
    expect(bad.exact).toBe(false)
    expect(Math.abs(bad.errorSecPerDay)).toBeGreaterThan(60)
  })

  // The bounds stop the SEARCH proposing silly wheels; a number the user typed
  // is not a proposal. It is the readout's job to say so, not the solver's.
  it('accepts a held count the search would never have proposed', () => {
    const t = solve([7, null, null])
    expect(t.meshes[0].teeth).toBe(7)
    expect(t.exact).toBe(true)
  })

  // Holding nothing must leave the old answer alone — the sort included, which
  // is skipped whenever anything is held.
  it('changes nothing when nothing is held', () => {
    const bare = solve()
    expect(bare.meshes.map((m) => `${m.teeth}/${m.pins}`)).toEqual(['48/12', '48/12', '45/12'])
    expect(solve([null, null, null])).toEqual(bare)
    // Sorted descending by mesh ratio, biggest wheel at the great arbor.
    const rs = bare.meshes.map((m) => m.teeth / m.pins)
    expect(rs[0]).toBeGreaterThanOrEqual(rs[1])
    expect(rs[1]).toBeGreaterThanOrEqual(rs[2])
  })

  // A spec from before the field existed, or one carrying junk: every entry has
  // to fill in as "free" rather than NaN the search. Same trap as `cycOf`.
  it('reads a short or broken hold array as nothing held', () => {
    const bare = solve()
    for (const junk of [[], [null], [NaN, null, null], [0, null, null], [undefined as never]]) {
      expect(solve(junk as (number | null)[])).toEqual(bare)
    }
  })

  // The DERIVED wheel is the last FREE one, not a fixed index — with two meshes
  // holding the great wheel leaves only the second to solve with.
  it('solves round a hold on a two-mesh train too', () => {
    const t = solveTrain(60, 8, [64, null], 2)
    expect(t.meshes.map((m) => m.teeth)).toEqual([64, 60])
    expect(t.exact).toBe(true)
    const other = solveTrain(60, 8, [null, 60], 2)
    expect(other.meshes[1].teeth).toBe(60)
    expect(other.exact).toBe(true)
  })

  it('carries the holds into the emitted wheels', () => {
    const design = designClock({ ...FOUR, lockedTeeth: [60, null, null] }, BASE)
    const great = design.parts.find((p) => p.key === 'great')!.params
    if (great.type !== 'gear') throw new Error('not a gear')
    expect(great.teeth).toBe(60)
    expect(design.train.exact).toBe(true)
  })
})

describe('drive wheel', () => {
  it('gives about the run asked for at the default spec', () => {
    const d = solveDrive(FOUR, 12)
    expect(d.turns).toBeCloseTo(1000 / (Math.PI * 40), 6)
    expect(d.runHours).toBeGreaterThan(22)
    expect(d.runHours).toBeLessThan(26)
    expect(d.clampedSmall).toBe(false)
  })

  it('runs longer per turn as the drum shrinks', () => {
    const fat = solveDrive({ ...FOUR, drumDia: 60 }, 12)
    const thin = solveDrive({ ...FOUR, drumDia: 25 }, 12)
    expect(thin.turns).toBeGreaterThan(fat.turns)
    // Same run asked for, so the thinner drum needs less wheel.
    expect(thin.teeth).toBeLessThan(fat.teeth)
  })

  it('says so when the run asked for needs a wheel smaller than a wheel can be', () => {
    const d = solveDrive({ ...FOUR, runHours: 2 }, 12)
    expect(d.clampedSmall).toBe(true)
    // Held at the floor, so it runs LONGER than asked — never shorter.
    expect(d.runHours).toBeGreaterThan(2)
  })
})

describe('tooth size, one module per mesh', () => {
  const design = designClock(FOUR, BASE)
  const fam = design.modules

  it('tapers from the GREAT wheel, the drive wheel sharing its tooth size', () => {
    expect(fam.meshes).toHaveLength(4)
    // The drive wheel meshes with the great arbor's lantern and nothing else,
    // and the weight acts through the great wheel — so there is no load case
    // wanting its teeth coarser. Tapering from the drive end made it the biggest
    // wheel in the clock for nothing, and it is the one wheel whose hub is not
    // free to grow (see the drum).
    expect(fam.meshes[0].module).toBeCloseTo(fam.meshes[1].module, 9)
    for (let i = 2; i < fam.meshes.length; i++) {
      expect(fam.meshes[i].module).toBeLessThan(fam.meshes[i - 1].module)
    }
  })

  it('scales the family so the biggest wheel just fits, and says which one did', () => {
    const cap = FOUR.maxWheelDia!
    for (const m of fam.meshes) expect(m.wheelDia).toBeLessThanOrEqual(cap + 1e-6)
    // One of them is AT the cap — otherwise the fit left room on the board.
    expect(fam.meshes[fam.binding].wheelDia).toBeCloseTo(cap, 6)
  })

  it('holds the taper exactly between neighbours, from the great wheel on', () => {
    const t = FOUR.toothTaper!
    for (let i = 2; i < fam.meshes.length; i++) {
      expect(fam.meshes[i].module / fam.meshes[i - 1].module).toBeCloseTo(t, 9)
    }
  })

  it('pins the two FAST arbors small, whatever their pitch would suggest', () => {
    // The third wheel and the escape wheel carry those two lanterns. Fitting the
    // pin to the pitch is a strength argument and strength is not scarce there —
    // torque has fallen by the whole train ratio — while their INERTIA is what
    // the escapement starts and stops twice a second. Nothing is risked going
    // thin: the tooth is `π·m − pin − backlash`, so a smaller pin leaves MORE.
    const small = FOUR.pinDiaFine!
    expect(fam.meshes[2].pinDia).toBe(small)
    expect(fam.meshes[3].pinDia).toBe(small)
    // …even on a board roomy enough that the pitch would have taken the big one.
    const roomy = designClock({ ...FOUR, maxWheelDia: 400 }, BASE).modules
    expect(roomy.meshes[0].pinDia).toBe(FOUR.pinDia)
    expect(roomy.meshes[2].pinDia).toBe(small)
    expect(roomy.meshes[3].pinDia).toBe(small)
    expect(pinForTooth(roomy.meshes[2].module, FOUR.pinDia, small, FOUR.backlash))
      .toBe(FOUR.pinDia)          // the rule really is being overridden
  })

  it('pins the slow end for its pitch, and never fatter as the teeth get finer', () => {
    const large = FOUR.pinDia, small = FOUR.pinDiaFine!
    expect(large).toBeGreaterThan(small)
    for (const m of fam.meshes) expect([large, small]).toContain(m.pinDia)
    // Never a bigger pin on a finer mesh — that is the whole point of having two.
    for (let i = 1; i < fam.meshes.length; i++) {
      expect(fam.meshes[i].pinDia).toBeLessThanOrEqual(fam.meshes[i - 1].pinDia)
    }
    // And the wheel is cut for the pin it will actually run on.
    const md = (i: number) => fam.meshes[i].pinDia
    const own = (key: string) => (design.parts.find((x) => x.key === key)!.params as { pinDia: number }).pinDia
    expect(own('drive')).toBe(md(0))
    expect(own('great')).toBe(md(1))
    expect(own('second')).toBe(md(2))
    expect(own('third')).toBe(md(3))
  })

  it('drills each wheel for the PIN of the mesh before it, not its own', () => {
    // Same trap as the pin CIRCLE: the holes through a wheel's hub take the
    // previous mesh's dowel, and with two sizes in the clock those differ.
    const carriedDia = (key: string) =>
      (design.parts.find((x) => x.key === key)!.params as { arborPinDia?: number }).arborPinDia
    expect(carriedDia('great')).toBe(fam.meshes[0].pinDia)
    expect(carriedDia('second')).toBe(fam.meshes[1].pinDia)
    expect(carriedDia('third')).toBe(fam.meshes[2].pinDia)
    expect(carriedDia('escapement')).toBe(fam.meshes[3].pinDia)
  })

  it('gives every mesh one pin when the two sizes are set equal', () => {
    const f = designClock({ ...FOUR, pinDiaFine: FOUR.pinDia }, BASE).modules
    for (const m of f.meshes) expect(m.pinDia).toBe(FOUR.pinDia)
  })

  it('reads a clock designed before there were two as one pin throughout', () => {
    const f = designClock({ ...FOUR, pinDia: 5, pinDiaFine: undefined }, BASE).modules
    for (const m of f.meshes) expect(m.pinDia).toBe(5)
  })

  it('is uniform at a taper of 1 — one module for the whole clock', () => {
    const f = designClock({ ...FOUR, toothTaper: 1 }, BASE).modules
    for (const m of f.meshes) expect(m.module).toBeCloseTo(f.meshes[0].module, 9)
  })

  // A clock designed before per-mesh modules carries `module` and no
  // `maxWheelDia`. It must open cutting exactly what it always cut, rather than
  // being silently resized by a cap it never had — the `linkAngles` trap.
  it('reads a legacy clock as one module throughout, unresized', () => {
    // No `trainWheels` either, which is what such a clock really carries — and
    // it has to read back as the four-wheel train it was cut as.
    const legacy = { ...FOUR, trainWheels: undefined, maxWheelDia: undefined, toothTaper: undefined, module: 4 }
    expect(trainWheelsOf(legacy)).toBe(4)
    const f = designClock(legacy, BASE).modules
    for (const m of f.meshes) {
      expect(m.module).toBe(4)
      expect(m.locked).toBe(true)
    }
    expect(f.binding).toBe(-1)
  })

  it('takes a held mesh out of the fit and leaves the rest tapering', () => {
    const f = designClock({ ...FOUR, lockedModules: [null, null, 3, null] }, BASE).modules
    expect(f.meshes[2].module).toBe(3)
    expect(f.meshes[2].locked).toBe(true)
    // The free ones are untouched by the hold.
    expect(f.meshes[0].module).toBeCloseTo(fam.meshes[0].module, 9)
    expect(f.meshes[3].module).toBeCloseTo(fam.meshes[3].module, 9)
  })

  // THE PIN CIRCLE THROUGH A WHEEL'S HUB BELONGS TO THE MESH BEFORE IT, not to
  // the wheel's own. The two were the same number while a clock had one module;
  // under a taper they never are, and taking this wheel's own would put the pins
  // on a circle no wheel is cut for.
  it('drills each wheel for the PREVIOUS mesh, not its own', () => {
    const md = (i: number) => fam.meshes[i].module
    const [m1, m2, m3] = design.train.meshes
    const carried = (key: string) => {
      const p = design.parts.find((x) => x.key === key)!.params as { arborPinCircleDia?: number }
      return p.arborPinCircleDia ?? 0
    }
    expect(carried('great')).toBeCloseTo(md(0) * design.drive.pins, 9)
    expect(carried('second')).toBeCloseTo(md(1) * m1.pins, 9)
    expect(carried('third')).toBeCloseTo(md(2) * m2.pins, 9)
    expect(carried('escapement')).toBeCloseTo(md(3) * m3.pins, 9)
    // …and it is a REAL distinction: none of those equals the wheel's own module.
    const own = (key: string) => {
      const p = design.parts.find((x) => x.key === key)!.params as { module?: number }
      return p.module ?? 0
    }
    expect(carried('second')).not.toBeCloseTo(own('second') * m1.pins, 3)
  })

  it('meshes each wheel with the lantern it was cut for', () => {
    // A mesh's two members must agree about the module, or the epicycloid the
    // wheel's face is cut to is not the path the pin centre takes.
    const md = (i: number) => fam.meshes[i].module
    const own = (key: string) => (design.parts.find((x) => x.key === key)!.params as { module: number }).module
    expect(own('drive')).toBeCloseTo(md(0), 9)
    expect(own('great')).toBeCloseTo(md(1), 9)
    expect(own('second')).toBeCloseTo(md(2), 9)
    expect(own('third')).toBeCloseTo(md(3), 9)
  })
})

// THE DRIVE WHEEL'S HUB IS THE DRUM, and it is the one hub in the clock that may
// not be grown: the run time was worked out from that diameter, and a wider hub
// puts the cord against the hub instead. `seatHub` treats hubDia as a FLOOR and
// raises it to seat the spokes — right everywhere else, backwards here.
describe('the drive wheel against its drum', () => {
  const withSpokes = (spokes: number, maxWheelDia = 280) => {
    const base = { ...BASE, gear: { ...BASE.gear, spokes } }
    const design = designClock({ ...FOUR, maxWheelDia }, base)
    const g = design.parts.find((p) => p.key === 'drive')!.params as Extract<ShapeParams, { type: 'gear' }>
    // `gearHubOf`, not `gearHub` with the loose numbers: a clock wheel is
    // cycloidal and its rim is measured in from a root cut to clear the pin, so
    // spelling the arguments out again would seat this hub on a wheel that is
    // not the one the design emitted.
    return { g, hub: gearHubOf(g) }
  }

  it('keeps the hub ON the drum, giving up spokes to do it', () => {
    // It bit as soon as tooth size tapered: spokes are 2.5·m wide and the drive
    // wheel is now the COARSEST mesh, so at 6 spokes the hub swallowed the drum
    // — which reads as the drum no longer being drawn, nothing emitting a hub
    // circle of its own.
    for (const asked of [4, 5, 6, 8, 10]) {
      const { g, hub } = withSpokes(asked)
      expect(hub.dia, `${asked} spokes`).toBeLessThanOrEqual(FOUR.drumDia + 0.05)
      expect(g.spokes).toBeLessThanOrEqual(asked)
      expect(g.hubDia).toBe(FOUR.drumDia)
    }
  })

  it('gives up no more than it has to', () => {
    // Most spokes at the smallest hub, not fewest — dropping further buys
    // nothing, and a wheel with two spokes is not what anyone asked for.
    expect(withSpokes(5).g.spokes).toBe(5)
    expect(withSpokes(10).g.spokes).toBeGreaterThan(2)
  })

  it('gets as close as the wheel allows when the drum is out of reach', () => {
    // Past a certain module the stock the ARBOR needs round the bore is already
    // wider than the drum, and that floor does not depend on the count — so no
    // number of spokes reaches it. Landing on the arbor's floor is still far
    // better than seating every spoke asked for.
    const wide = withSpokes(8, 700)
    const naive = gearHubOf({ ...wide.g, spokes: 8 })
    expect(wide.hub.dia).toBeGreaterThan(FOUR.drumDia)   // genuinely unreachable
    expect(wide.hub.dia).toBeLessThan(naive.dia)                        // …but much closer than doing nothing
  })

  it('draws the drum as a circle of its own, whatever the spokes do', () => {
    // Nothing else draws it reliably. The spoke windows imply the hub, but only
    // where there IS a window: at a count whose windows come out as slivers the
    // fillets eat the inner arc, and a solid wheel has no window at all — so the
    // drum simply stopped being visible. It is the diameter the run time was
    // worked out from, so it is worth cutting to rather than inferring.
    for (const asked of [0, 5, 8]) {
      const base = { ...BASE, gear: { ...BASE.gear, spokes: asked } }
      const design = designClock(FOUR, base)
      const g = design.parts.find((p) => p.key === 'drive')!.params
      const hub = generateGearParts(g as Extract<ShapeParams, { type: 'gear' }>).find((p) => p.key === 'hub')
      expect(hub, `${asked} spokes`).toBeTruthy()
      const rs = flattenPath(hub!.d, 0.02).flat().map((q) => Math.hypot(q[0], q[1]))
      expect(2 * Math.max(...rs), `${asked} spokes`).toBeCloseTo(FOUR.drumDia, 1)
    }
  })

  it('is the only wheel that draws one — the rest have no drum', () => {
    const design = designClock(FOUR, BASE)
    for (const key of ['great', 'second', 'third']) {
      const g = design.parts.find((p) => p.key === key)!.params as Extract<ShapeParams, { type: 'gear' }>
      expect(generateGearParts(g).some((p) => p.key === 'hub'), key).toBe(false)
    }
  })

  it('still cuts spokes — it does not quietly go solid', () => {
    for (const asked of [4, 5, 6, 8, 10]) expect(withSpokes(asked).hub.spoked, `${asked}`).toBe(true)
  })
})

describe('the motion work', () => {
  // Its SIZE is a distance now, and its module falls out of that: the counts are
  // forced, so `C = m(P+T)/2` has exactly one unknown left. It is cut at its own
  // module because it meshes with nothing in the train.
  // …and it is OFF by default, a clock being a going train with hands added.
  const mw = designClock({ ...FOUR, motionWork: true }, BASE).motion!
  const MW_MODULE = mw.module

  // BOTH MESHES SPAN THE SAME PAIR OF ARBORS — the hour wheel is concentric with
  // the minute arbor — so the two centre distances must be the same distance.
  // That is the whole constraint on the counts, and nothing else here checks it:
  // the parts are drawn clear of each other, so a mismatch looks fine on the
  // stock and cannot be assembled.
  it('runs both meshes at one centre distance', () => {
    const m = MW_MODULE
    // A lantern's pins sit on a pitch circle of m·P/2, the same rule the teeth
    // are cut to, so a mesh's centre distance is m(P + T)/2 either way round.
    const first = (m * (mw.cannonPins + mw.minuteTeeth)) / 2
    const second = (m * (mw.minutePins + mw.hourTeeth)) / 2
    expect(second).toBeCloseTo(first, 9)
    expect(mw.centreDistanceMM).toBeCloseTo(first, 9)
  })

  it('gears the hour hand down by exactly 12', () => {
    expect(mw.ratio).toBeCloseTo(12, 12)
    expect(mw.minuteTeeth / mw.cannonPins).toBeCloseTo(MOTION_RATIOS[0], 12)
    expect(mw.hourTeeth / mw.minutePins).toBeCloseTo(MOTION_RATIOS[1], 12)
  })

  // k = 2 of the P₁ = 5k / P₂ = 4k family, which is the classic motion work —
  // the numbers a clockmaker would recognise, and they fall out of the equal
  // centre distance rather than being chosen.
  it('comes out at the classic 10/30 and 8/32', () => {
    expect([mw.cannonPins, mw.minuteTeeth, mw.minutePins, mw.hourTeeth]).toEqual([10, 30, 8, 32])
  })

  it('adds two wheels off the great arbor, and only when asked', () => {
    const off = designClock(FOUR, BASE)
    expect(off.motion).toBeNull()
    expect(off.parts.some((p) => p.key === 'minute' || p.key === 'hour')).toBe(false)

    const on = designClock({ ...FOUR, motionWork: true }, BASE)
    expect(on.parts.map((p) => p.key)).toEqual(CLOCK_PART_ORDER)
    // The going train is untouched by them: same wheels, same rate.
    expect(trainOf(on).map((p) => p.key)).toEqual(TRAIN_PART_ORDER)
    expect(trainOf(on).map((p) => (p.params as { teeth: number }).teeth))
      .toEqual(trainOf(off).map((p) => (p.params as { teeth: number }).teeth))
  })

  // The hour wheel turns once every 12 great-wheel revolutions — which is 12
  // hours only when the great wheel is the minute arbor, and the readout is what
  // says so when it is not.
  it('turns the hour wheel once every 12 turns of the great wheel', () => {
    const on = designClock({ ...FOUR, motionWork: true }, BASE)
    const great = on.parts.find((p) => p.key === 'great')!
    const hour = on.parts.find((p) => p.key === 'hour')!
    const minute = on.parts.find((p) => p.key === 'minute')!
    expect(hour.revSeconds / great.revSeconds).toBeCloseTo(12, 9)
    expect(minute.revSeconds / great.revSeconds).toBeCloseTo(3, 9)
    expect(great.revSeconds).toBeCloseTo(3600, 6)
  })

  // Each wheel is emitted with the lantern it MESHES with, exactly as a train
  // wheel is — which is what makes them two parts to cut and not four.
  it('emits each wheel with the pinion it runs against', () => {
    const on = designClock({ ...FOUR, motionWork: true }, BASE)
    for (const [key, teeth, pins] of [
      ['minute', mw.minuteTeeth, mw.cannonPins],
      ['hour', mw.hourTeeth, mw.minutePins],
    ] as const) {
      const part = on.parts.find((p) => p.key === key)!
      if (part.params.type !== 'gear') throw new Error('not a gear')
      expect(part.params.teeth).toBe(teeth)
      expect(part.params.mateTeeth).toBe(pins)
      expect(part.params.emitPinion).toBe(true)
      // Cycloidal like everything else in the clock, and on the same module.
      expect(part.params.toothProfile).toBe('cycloidal')
      expect(part.params.module).toBe(MW_MODULE)
    }
  })
})

describe('the emitted clock', () => {
  const design = designClock(FOUR, BASE)

  it('is a drive wheel, three going wheels, an escapement and a pendulum', () => {
    // The motion work is optional, so the emitted parts are CLOCK_PART_ORDER
    // less what was not asked for — never a different order.
    expect(design.parts.map((p) => p.key))
      .toEqual(CLOCK_PART_ORDER.filter((k) => k !== 'minute' && k !== 'hour'))
    expect(design.parts.map((p) => p.name))
      .toEqual(['Drive Wheel', 'Great Wheel', 'Second Wheel', 'Third Wheel', 'Escapement', 'Pendulum'])
  })

  it('carries the tooth counts Rick specified', () => {
    const teeth = trainOf(design).map((p) => p.params.teeth)
    expect(teeth.slice(1)).toEqual([48, 48, 45, 30])
  })

  // Backlash and pin diameter are decisions about the CLOCK — every mesh runs on
  // the same play and every lantern is pinned with the same rod — so they come
  // from the spec and override the Gear defaults on every wheel, the motion work
  // included. Set per wheel they meant opening seven chips to change one thing.
  it('gives every wheel the clock\'s own backlash, and one of its two pins', () => {
    const spec = { ...FOUR, motionWork: true, backlash: 0.45, pinDia: 3.5, pinDiaFine: 2 }
    const gears = designClock(spec, BASE).parts.filter((p) => p.params.type === 'gear')
    expect(gears).toHaveLength(6)          // four train wheels + the two motion ones
    for (const p of gears) {
      if (p.params.type !== 'gear') throw new Error('not a gear')
      expect(p.params.backlash).toBe(0.45)
      // Backlash is ONE figure for the clock; the pin is not — each mesh takes
      // whichever of the two dowels suits its own pitch, and the motion work
      // always takes the small one.
      expect([3.5, 2]).toContain(p.params.pinDia)
      // …and everything NOT the clock's business is still the user's default.
      expect(p.params.bore).toBe(BASE.gear.bore)
      expect(p.params.spokes).toBe(BASE.gear.spokes)
    }
    // A spec saved before the fields existed falls back to those defaults rather
    // than to NaN — the `cycOf` trap, and an undefined pin diameter does not draw
    // a wrong tooth, it makes every coordinate NaN.
    const old = { ...FOUR } as Partial<typeof FOUR>
    delete old.backlash; delete old.pinDia
    const first = designClock(old as typeof FOUR, BASE).parts[0].params
    if (first.type !== 'gear') throw new Error('not a gear')
    expect(first.backlash).toBe(BASE.gear.backlash)
    expect(first.pinDia).toBe(BASE.gear.pinDia)
  })

  // THE DRIVE WHEEL'S HUB IS THE DRUM. The cord winds on that arbor and the run
  // time was worked out from that diameter, so the wheel is cut to it and the
  // two cannot disagree. A floor, like every hub: seatHub still grows it when the
  // arbor or the spokes need more, and the readout says so, because then the cord
  // rides against the hub instead of the drum.
  it('cuts the drive wheel\'s hub to the drum', () => {
    for (const drumDia of [40, 80, 25]) {
      const drive = designClock({ ...FOUR, drumDia }, BASE).parts.find((p) => p.key === 'drive')!
      if (drive.params.type !== 'gear') throw new Error('not a gear')
      expect(drive.params.hubDia).toBe(drumDia)
      // …and only that wheel: no other arbor carries the cord.
      const others = designClock({ ...FOUR, drumDia, motionWork: true }, BASE)
        .parts.filter((p) => p.key !== 'drive' && p.params.type === 'gear')
      for (const p of others) {
        if (p.params.type !== 'gear') throw new Error('not a gear')
        expect(p.params.hubDia).toBe(BASE.gear.hubDia)
      }
    }
  })

  // EVERY DRIVEN WHEEL CARRIES ITS OWN PINION'S PINS — the wheel is that
  // lantern's near cheek, so the holes go through its hub and the cheek drawn
  // beside the wheel BEFORE it caps the far ends. The drive wheel carries none
  // (nothing drives it but the cord) and neither does the hour wheel (nothing is
  // driven off the hour arbor).
  it('gives every driven wheel the pins of the pinion on its own arbor', () => {
    const spec = { ...FOUR, motionWork: true }
    const design = designClock(spec, BASE)
    const pinsOf = (key: string) => {
      const p = design.parts.find((x) => x.key === key)!.params as { arborPins?: number; arborPinCircleDia?: number }
      return [p.arborPins ?? 0, p.arborPinCircleDia ?? 0]
    }
    const [m1, m2, m3] = design.train.meshes
    // Each wheel carries the pinion the wheel BEFORE it drives — so the pin
    // circle is the PREVIOUS mesh's module, not this wheel's own. The two were
    // the same number while a clock had one module; under a taper they never
    // are, and using this wheel's own would put the pins on a circle no wheel is
    // cut for.
    const md = (i: number) => design.modules.meshes[i].module
    expect(pinsOf('great')).toEqual([design.drive.pins, md(0) * design.drive.pins])
    expect(pinsOf('second')).toEqual([m1.pins, md(1) * m1.pins])
    expect(pinsOf('third')).toEqual([m2.pins, md(2) * m2.pins])
    expect(pinsOf('escapement')).toEqual([m3.pins, md(3) * m3.pins])
    // The minute wheel shares the stud with the pinion driving the hour wheel —
    // and both of the motion work's meshes are cut at ITS module, which comes
    // from its arbor spacing and has nothing to do with the train's.
    expect(pinsOf('minute')).toEqual([
      design.motion!.minutePins, design.motion!.module * design.motion!.minutePins,
    ])
    // …and these two carry nothing.
    expect(pinsOf('drive')).toEqual([0, 0])
    expect(pinsOf('hour')).toEqual([0, 0])
  })

  // The pin circle a wheel carries is the SAME circle as the cheek drawn beside
  // the wheel before it — they hold the same pins, so a mismatch means the parts
  // do not go together.
  it('drills each wheel on the circle of the cheek that caps it', () => {
    const design = designClock({ ...FOUR, motionWork: true }, BASE)
    for (const [wheel, driver] of [
      ['great', 'drive'], ['second', 'great'], ['third', 'second'], ['escapement', 'third'],
      ['minute', 'hour'],
    ] as const) {
      const carried = design.parts.find((p) => p.key === wheel)!.params as { arborPinCircleDia?: number }
      const cheek = pinionDims(design.parts.find((p) => p.key === driver)!.params as never)!
      expect(carried.arborPinCircleDia).toBeCloseTo(cheek.pinCircleDia, 9)
    }
  })

  it('cuts the pendulum to the length the beat demands', () => {
    const pend = design.parts.find((p) => p.key === 'pendulum')!.params
    if (pend.type !== 'pendulum') throw new Error('not a pendulum')
    // Round-trips through the pendulum's own formula, so the two files cannot
    // disagree about g or about the beat being HALF a period.
    expect(pendulumBeat(pend.length)).toBeCloseTo(FOUR.beatSeconds, 9)
    expect(pend.length).toBeCloseTo(pendulumLengthMM(FOUR.beatSeconds), 9)
    // And it takes the user's Pendulum defaults for everything else.
    expect(pend.bobRx).toBe(DEFAULT_SHAPE_CONFIG.pendulum.bobRx)
    expect(pend.rodWidth).toBe(DEFAULT_SHAPE_CONFIG.pendulum.rodWidth)
  })

  it('cuts every wheel cycloidal with a lantern pinion — an involute wheel is not conjugate to a pin', () => {
    for (const p of design.parts) {
      if (p.params.type !== 'gear') continue
      expect(p.params.toothProfile).toBe('cycloidal')
      expect(p.params.emitPinion).toBe(true)
      expect(p.params.mateTeeth).toBeGreaterThanOrEqual(FOUR.minPins)
    }
  })

  it('overrides the counts, module, pin and profile — the rest is the user default', () => {
    const g = design.parts[1].params
    if (g.type !== 'gear') throw new Error('great wheel is not a gear')
    expect(g.bore).toBe(DEFAULT_SHAPE_CONFIG.gear.bore)
    expect(g.hubDia).toBe(DEFAULT_SHAPE_CONFIG.gear.hubDia)
    expect(g.spokes).toBe(DEFAULT_SHAPE_CONFIG.gear.spokes)
    expect(g.backlash).toBe(DEFAULT_SHAPE_CONFIG.gear.backlash)
    // NOT the Gear default: the pin comes with the MESH now, one of the clock's
    // two dowels, picked for that mesh's own pitch.
    expect(g.pinDia).toBe(designClock(FOUR, BASE).modules.meshes[1].pinDia)
    const e = design.parts[4].params
    if (e.type !== 'escapement') throw new Error('last part is not an escapement')
    expect(e.escType).toBe(DEFAULT_SHAPE_CONFIG.escapement.escType)
    expect(e.toothDepth).toBe(DEFAULT_SHAPE_CONFIG.escapement.toothDepth)
  })

  it('gives each arbor the period the train says it should have', () => {
    // Escape wheel once a minute, great wheel once an hour — the whole point.
    const by = Object.fromEntries(design.parts.map((p) => [p.key, p.revSeconds]))
    expect(by.escapement).toBeCloseTo(60, 6)
    expect(by.great).toBeCloseTo(3600, 6)
    // And each wheel is slower than the one it drives.
    expect(by.drive).toBeGreaterThan(by.great)
    expect(by.great).toBeGreaterThan(by.second)
    expect(by.second).toBeGreaterThan(by.third)
    expect(by.third).toBeGreaterThan(by.escapement)
  })

  it('draws every part, and lays them out clear of each other', () => {
    const placed = layoutClock(design.parts, { widthMM: 620, heightMM: 400 }, 10, 12)
    const boxes = placed.map((p) => {
      const geo = generateShapeParts(p.params)
      expect(geo && geo.length).toBeGreaterThan(0)
      return getMultiBBox(geo!.map((g) => g.d))!
    })
    for (const b of boxes) expect(b).toBeTruthy()
    // No two parts overlap — they are things to be cut, not an assembly drawing.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const overlaps = a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
        expect(overlaps, `${placed[i].name} overlaps ${placed[j].name}`).toBe(false)
      }
    }
  })

  it('stands the pendulum clear of the stock rather than packing it', () => {
    // A seconds pendulum is 994 mm of rod against a 300 mm board. Packed in, it
    // took a row a metre tall and pushed the whole train off the top of the
    // stock on its way to centring the block — the one part that will never be
    // cut from this board deciding where every wheel went.
    const stock = { widthMM: 300, heightMM: 300 }
    const placed = layoutClock(design.parts, stock, 10, 12)
    const boxOf = (key: string) => {
      const p = placed.find((q) => q.key === key)!
      return getMultiBBox(generateShapeParts(p.params)!.map((g) => g.d))!
    }
    expect(boxOf('pendulum').minX).toBeGreaterThanOrEqual(stock.widthMM)
    // …and the wheels are laid out as though it were not there at all.
    const train = placed.filter((p) => p.key !== 'pendulum')
    const tb = getMultiBBox(train.flatMap((p) => generateShapeParts(p.params)!.map((g) => g.d)))!
    // 3 places, not 6: the bbox is measured off the emitted `d`, whose numbers
    // are written to 4 decimals, so the ruler carries 5e-5 mm of rounding. The
    // centring itself is exact.
    expect((tb.minX + tb.maxX) / 2).toBeCloseTo(stock.widthMM / 2, 3)
  })

  it('centres the wheels on the stock when they fit', () => {
    const stock = { widthMM: 620, heightMM: 1200 }
    const placed = layoutClock(design.parts, stock, 10, 12).filter((p) => p.key !== 'pendulum')
    const b = getMultiBBox(placed.flatMap((p) => generateShapeParts(p.params)!.map((g) => g.d)))!
    expect((b.minX + b.maxX) / 2).toBeCloseTo(stock.widthMM / 2, 3)
    expect((b.minY + b.maxY) / 2).toBeCloseTo(stock.heightMM / 2, 3)
    // Every wheel actually on the board.
    expect(b.minX).toBeGreaterThanOrEqual(0)
    expect(b.maxX).toBeLessThanOrEqual(stock.widthMM)
    expect(b.minY).toBeGreaterThanOrEqual(0)
    expect(b.maxY).toBeLessThanOrEqual(stock.heightMM)
  })

  it('hangs an overflowing block off the BOTTOM instead of straddling the stock', () => {
    // Centred, a block taller than the stock puts its first row entirely above
    // the board and its last entirely below — the arrangement that gets the
    // fewest wheels onto it. From the top edge, everything that fits is on it.
    const stock = { widthMM: 300, heightMM: 300 }
    const placed = layoutClock(design.parts, stock, 10, 12).filter((p) => p.key !== 'pendulum')
    const b = getMultiBBox(placed.flatMap((p) => generateShapeParts(p.params)!.map((g) => g.d)))!
    expect(b.maxY).toBeLessThanOrEqual(stock.heightMM)
    expect(b.maxY).toBeGreaterThan(stock.heightMM * 0.8)   // hard against the top edge
    const onStock = placed.filter((p) => {
      const q = getMultiBBox(generateShapeParts(p.params)!.map((g) => g.d))!
      return q.minY >= 0 && q.maxY <= stock.heightMM
    })
    expect(onStock.length).toBeGreaterThan(0)
  })

  it('wraps into rows instead of running off the stock', () => {
    const wide = layoutClock(design.parts, { widthMM: 5020, heightMM: 400 }, 10, 12)
    const narrow = layoutClock(design.parts, { widthMM: 420, heightMM: 400 }, 10, 12)
    // The pendulum stands BESIDE the board rather than being packed, so it is
    // left out of the extent — it is a metre of rod either way and would swamp
    // the very difference this measures.
    const extent = (parts: typeof design.parts) => {
      const b = getMultiBBox(parts.filter((p) => p.key !== 'pendulum')
        .flatMap((p) => generateShapeParts(p.params)!.map((g) => g.d)))!
      return { w: b.maxX - b.minX, h: b.maxY - b.minY }
    }
    expect(extent(narrow).w).toBeLessThan(extent(wide).w)
    expect(extent(narrow).h).toBeGreaterThan(extent(wide).h)
  })
})

describe('the assembled clock', () => {
  const design = designClock(FOUR, BASE)
  const plate = clockPlate(trainOf(design))!

  it('stands every arbor at the spacing its own mesh runs at', () => {
    // Not the drawn positions — the pitch circles tangent, which is the number
    // the plate is drilled from.
    for (let k = 0; k < plate.arbors.length - 1; k++) {
      const a = plate.arbors[k], b = plate.arbors[k + 1]
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(a.centreDistance, 9)
      expect(a.centreDistance).toBeCloseTo(gearMesh(trainOf(design)[k].params as never).centreDistance, 9)
    }
  })

  it('climbs — weight at the bottom, escapement at the top', () => {
    for (let k = 0; k < plate.arbors.length - 1; k++) {
      expect(plate.arbors[k + 1].y).toBeGreaterThan(plate.arbors[k].y)
    }
    // And the pallet arbor is above the escape wheel, where the generator draws it.
    expect(plate.anchor.y).toBeGreaterThan(plate.arbors[plate.arbors.length - 1].y)
  })

  it('turns every arbor at exactly its train ratio off the escape wheel', () => {
    // The train is rigid: the only kinematics in a clock are the escapement's,
    // and each mesh both reduces AND reverses.
    const a = clockPose(trainOf(design), plate, 0)
    const b = clockPose(trainOf(design), plate, 1)
    const escStep = b.wheelDeg[4] - a.wheelDeg[4]
    let want = 1
    for (let k = 3; k >= 0; k--) {
      want *= -1 / gearMesh(trainOf(design)[k].params as never).ratio
      expect((b.wheelDeg[k] - a.wheelDeg[k]) / escStep).toBeCloseTo(want, 9)
    }
  })

  it('advances the escape wheel exactly one tooth per period', () => {
    const a = clockPose(trainOf(design), plate, 0)
    const b = clockPose(trainOf(design), plate, 1)
    expect(Math.abs(b.wheelDeg[4] - a.wheelDeg[4])).toBeCloseTo(360 / FOUR.escapeTeeth, 9)
  })

  it('phases each mesh for the angle it actually sits at, not for +x', () => {
    // The formula reduces to gearPose when the mate lies along +x, which is the
    // one case gearMesh solves directly — so that is the anchor for the rest.
    //
    // ASK gearMesh FOR THE SAME MESH clockPose ASKED FOR, which means handing it
    // the same DRIVE SENSE. `matePhaseDeg` carries the settle onto the driving
    // flank, so it moves by the whole play when the sense flips — and the sense
    // ALTERNATES back along the chain from the escape wheel, because a train is
    // a chain of external meshes. Called with the default (a gear running CCW)
    // this reads half the train as 0.7° out of phase, which is the play at those
    // meshes and not an error in the pose.
    const flat = { ...plate, arbors: plate.arbors.map((a) => ({ ...a, toNext: 0 })) }
    const pose = clockPose(trainOf(design), flat, 0.37)
    const esc = trainOf(design)[4].params
    let sense: 1 | -1 = esc.type === 'escapement' && esc.clockwise ? -1 : 1
    const senses: (1 | -1)[] = []
    for (let k = 3; k >= 0; k--) { sense = sense === 1 ? -1 : 1; senses[k] = sense }
    for (let k = 3; k >= 0; k--) {
      const mesh = gearMesh(trainOf(design)[k].params as never, senses[k])
      expect(pose.pinionDeg[k + 1]).toBeCloseTo(mesh.matePhaseDeg - pose.wheelDeg[k] * mesh.ratio, 9)
    }
  })
})

describe('the motion work, assembled', () => {
  const spec = { ...FOUR, motionWork: true }
  const design = designClock(spec, BASE)
  const asm = trainOf(design)
  const motion: ClockMotion = {
    minute: design.parts.find((p) => p.key === 'minute')!.params as ClockMotion['minute'],
    hour: design.parts.find((p) => p.key === 'hour')!.params as ClockMotion['hour'],
  }
  const plate = clockPlate(asm, spec.linkAngles, motion)!
  const great = asm.findIndex((p) => p.key === 'great')

  it('hangs its arbor off the GREAT arbor, at the distance both meshes run at', () => {
    expect(plate.motion).not.toBeNull()
    expect(plate.motion!.hostIdx).toBe(great)
    const host = plate.arbors[great]
    expect(Math.hypot(plate.motion!.x - host.x, plate.motion!.y - host.y))
      .toBeCloseTo(designClock(spec, BASE).motion!.centreDistanceMM, 6)
  })

  it('is absent from the going train it hangs off', () => {
    // The arbors are the TRAIN's, five of them; the motion work adds a branch,
    // not a sixth arbor — letting it into the chain would gear the escapement
    // through the hour hand.
    expect(plate.arbors).toHaveLength(TRAIN_PART_ORDER.length)
    expect(clockPlate(asm, spec.linkAngles)!.motion).toBeNull()
  })

  // BOTH HANDS GO ROUND THE SAME WAY and the hour one twelve times slower. A
  // sign error here draws a perfectly good mesh running backwards, which no
  // clearance check can see.
  it('turns the hour wheel 1/12 of the great wheel, the same way round', () => {
    const a = clockPose(asm, plate, 0, motion)
    const b = clockPose(asm, plate, 40, motion)
    const dGreat = b.wheelDeg[great] - a.wheelDeg[great]
    expect((b.motion!.hourDeg - a.motion!.hourDeg) / dGreat).toBeCloseTo(1 / 12, 9)
    // The minute wheel is between them and runs backwards at 3:1, as an external
    // mesh must.
    expect((b.motion!.minuteDeg - a.motion!.minuteDeg) / dGreat).toBeCloseTo(-1 / 3, 9)
    // The cannon pinion is FIXED to the great arbor — not geared to it.
    expect(b.motion!.cannonDeg).toBeCloseTo(b.wheelDeg[great], 9)
  })

  it('has no pose without the parts, and no parts without both wheels', () => {
    expect(clockPose(asm, plate, 0.3).motion).toBeNull()
    const paths = [
      { clockId: 'c1', clockPart: 'minute', shapeParams: motion.minute },
      { clockId: 'c1', clockPart: 'hour', shapeParams: motion.hour },
    ]
    expect(clockMotionFromPaths(paths, 'c1')).not.toBeNull()
    expect(clockMotionFromPaths(paths.slice(0, 1), 'c1')).toBeNull()
    expect(clockMotionFromPaths(paths, 'c2')).toBeNull()
  })

  // THE BRANCH IS MEASURED THE OTHER WAY ROUND from a train link: its host is
  // what is fixed, so the angle runs from the host out to the cursor.
  it('drags its joint onto the ray from the great arbor to the cursor', () => {
    const root = { x: 150, y: 100 }
    for (const cursor of [{ x: 400, y: 120 }, { x: 60, y: -80 }, { x: 150, y: 400 }]) {
      const deg = dragLinkAngle(plate, root, MOTION_LINK, cursor)!
      const next = spec.linkAngles.slice()
      next[MOTION_LINK] = deg
      const after = clockPlate(asm, next, motion)!
      const host = { x: root.x + after.arbors[great].x, y: root.y + after.arbors[great].y }
      const joint = { x: root.x + after.motion!.x, y: root.y + after.motion!.y }
      const toCursor = Math.atan2(cursor.y - host.y, cursor.x - host.x)
      const toJoint = Math.atan2(joint.y - host.y, joint.x - host.x)
      expect(Math.cos(toCursor - toJoint)).toBeCloseTo(1, 9)
      expect(Math.hypot(joint.x - host.x, joint.y - host.y))
        .toBeCloseTo(after.motion!.centreDistance, 9)
      // …and nothing in the train moved with it.
      for (let i = 0; i < after.arbors.length; i++) {
        expect(after.arbors[i].x).toBeCloseTo(plate.arbors[i].x, 9)
        expect(after.arbors[i].y).toBeCloseTo(plate.arbors[i].y, 9)
      }
    }
  })

  // The frame is what a plate has to be, so it has to CONTAIN the motion work —
  // whether that makes it any bigger depends on where the branch is swung, and
  // at the default angle the train's own wheels already reach further.
  it('counts its wheels in the frame the plate has to be', () => {
    const m = plate.motion!
    const host = plate.arbors[m.hostIdx]
    for (const [x, y, r] of [
      [m.x, m.y, m.minuteRadius],
      [host.x, host.y, m.hourRadius],
    ] as const) {
      expect(plate.bbox.minX).toBeLessThanOrEqual(x - r + 1e-9)
      expect(plate.bbox.maxX).toBeGreaterThanOrEqual(x + r - 1e-9)
      expect(plate.bbox.minY).toBeLessThanOrEqual(y - r + 1e-9)
      expect(plate.bbox.maxY).toBeGreaterThanOrEqual(y + r - 1e-9)
    }
    // …and swinging the branch out past the train DOES grow it. (At the default
    // angle it does not: a 200 mm great wheel already reaches further than an
    // 80 mm branch carrying a 128 mm one, which is why the containment above is
    // the invariant and this is only the case that shows the box is live.)
    const swung = spec.linkAngles.slice()
    swung[MOTION_LINK] = 180
    const wide = clockPlate(asm, swung, motion)!
    expect(wide.bbox.minX).toBeLessThan(clockPlate(asm, swung)!.bbox.minX)
  })
})

describe('arbors through wheels', () => {
  const spec = { ...FOUR, motionWork: true }
  const design = designClock(spec, BASE)
  const asm = trainOf(design)
  const motion: ClockMotion = {
    minute: design.parts.find((p) => p.key === 'minute')!.params as ClockMotion['minute'],
    hour: design.parts.find((p) => p.key === 'hour')!.params as ClockMotion['hour'],
  }
  const plate = clockPlate(asm, spec.linkAngles, motion)!

  // An arbor is a rod from plate to plate, so it is at EVERY depth: a wheel whose
  // tip circle contains one has nowhere to turn. Two WHEELS overlapping is the
  // opposite case and is normal — they sit at different depths on their arbors.
  it('finds a wheel with a foreign arbor inside its rim', () => {
    const found = clockArborClashes(plate)
    for (const c of found) {
      const wheel = plate.arbors.find((a) => a.key === c.wheel)!
      const arbor = c.arbor === 'anchor' ? plate.anchor : plate.arbors.find((a) => a.key === c.arbor)!
      const d = Math.hypot(arbor.x - wheel.x, arbor.y - wheel.y)
      expect(d).toBeLessThan(wheel.wheelRadius)
      expect(c.depthMM).toBeCloseTo(wheel.wheelRadius - d, 9)
    }
    // Nothing is ever reported against its own arbor, or the escape wheel
    // against the pallet arbor that is supposed to sweep it.
    expect(found.some((c) => c.arbor === c.wheel)).toBe(false)
    expect(found.some((c) => c.arbor === 'anchor' && c.wheel === 'escapement')).toBe(false)
  })

  // Folding the linkage is what breaks it in a train that was fine: the drive
  // wheel swung onto the third arbor, say.
  it('catches an arbor folded onto another wheel', () => {
    // Doubled back on itself — links 0 and 2 out one way, 1 and 3 straight back
    // — which piles four arbors into the same handspan. A straight or gently
    // leaning train keeps every clearance, which is the other half of this test.
    const folded = clockArborClashes(clockPlate(asm, [0, 180, 0, 180, 0], motion)!)
    const leaning = clockArborClashes(clockPlate(asm, spec.linkAngles, motion)!)
    expect(folded.length).toBeGreaterThan(leaning.length + 5)
    for (const straight of [[0, 0, 0, 0, 0], [90, 90, 90, 90, 0], [10, -10, 10, -10, 0]]) {
      expect(clockArborClashes(clockPlate(asm, straight, motion)!).length).toBe(leaning.length)
    }
  })

  // The motion work is in FRONT of the front plate and the great wheel is
  // between the plates, so the stud landing inside the great wheel is not a
  // clash — the same "different depths" that lets neighbouring wheels overlap.
  // What IS checked in front is the pair that really shares that space.
  it('does not call the stud inside the great wheel a clash', () => {
    const great = plate.arbors[plate.motion!.hostIdx]
    // The default 12-pin train has exactly that arrangement…
    expect(plate.motion!.centreDistance).toBeLessThan(great.wheelRadius)
    expect(clockArborClashes(plate).some((c) => c.arbor === 'motion' || c.wheel === 'minute')).toBe(false)
    // …and widening the arbor spacing walks the stud out past the rim.
    const bigger = designClock({ ...spec, motionCentreMM: great.wheelRadius + 20 }, BASE)
    const big = clockPlate(trainOf(bigger), spec.linkAngles, {
      minute: bigger.parts.find((p) => p.key === 'minute')!.params as ClockMotion['minute'],
      hour: bigger.parts.find((p) => p.key === 'hour')!.params as ClockMotion['hour'],
    })!
    expect(big.motion!.centreDistance).toBeGreaterThan(plate.arbors[big.motion!.hostIdx].wheelRadius)
  })

  // …and the SPACING is the one free number: the ratios and the equal centre
  // distance fix the counts, so the module is what falls out of a distance and
  // every spacing is still exactly 12:1 with both meshes at that one distance.
  it('keeps 12:1 and one centre distance at every spacing', () => {
    for (const C of [40, 80, 112, 200]) {
      const mw = solveMotionWork(C, 3, 0.3)
      expect(mw.ratio).toBeCloseTo(12, 12)
      expect(mw.centreDistanceMM).toBeCloseTo(C, 9)
      expect((mw.module * (mw.cannonPins + mw.minuteTeeth)) / 2).toBeCloseTo(C, 9)
      expect((mw.module * (mw.minutePins + mw.hourTeeth)) / 2).toBeCloseTo(C, 9)
    }
  })

  it('scales its module with the spacing, and pins it with the SMALL dowel', () => {
    // The hands and a cannon-pinion clutch are next to no load, so nothing here
    // wants the fat pin — and the module comes from a clearance distance rather
    // than from strength, so a fat pin would as likely as not be most of the
    // tooth space.
    const a = solveMotionWork(80, 3, 0.3), b = solveMotionWork(160, 3, 0.3)
    expect(b.module).toBeCloseTo(2 * a.module, 9)
    const d = designClock({ ...FOUR, motionWork: true }, BASE)
    expect(d.motion!.pinDia).toBe(FOUR.pinDiaFine)
    for (const key of ['minute', 'hour']) {
      const g = d.parts.find((p) => p.key === key)!.params as Extract<ShapeParams, { type: 'gear' }>
      expect(g.pinDia, key).toBe(FOUR.pinDiaFine)
      expect(g.module, key).toBeCloseTo(d.motion!.module, 9)
    }
  })

  it('recovers the spacing of a clock designed when it was a size number', () => {
    // `motionSize` k against the module that clock was cut at — which for one is
    // the single module its whole train shared — is the same distance.
    const legacy = {
      ...FOUR, motionWork: true, motionCentreMM: undefined,
      motionSize: 3, maxWheelDia: undefined, toothTaper: undefined, module: 4,
    }
    expect(designClock(legacy, BASE).motion!.centreDistanceMM).toBeCloseTo(10 * 3 * 4, 9)
  })
})

describe('finding a clock again', () => {
  const design = designClock(FOUR, BASE)
  const paths = design.parts.flatMap((p, i) => [
    { clockId: 'c1', clockPart: p.key, shapeParams: p.params, id: `a${i}` },
    // Every wheel is several paths sharing one set of params — teeth, bore,
    // spokes — so the reader must take one, not all of them.
    { clockId: 'c1', clockPart: p.key, shapeParams: p.params, id: `b${i}` },
  ])

  it('reads one part per wheel, in train order', () => {
    const asm = clockAssemblyFromPaths(paths, 'c1')
    expect(asm.map((a) => a.key)).toEqual(TRAIN_PART_ORDER)
  })

  it('ignores other clocks and unmarked paths', () => {
    const noise = [...paths,
      { clockId: 'c2', clockPart: 'great', shapeParams: design.parts[1].params, id: 'x' },
      { shapeParams: design.parts[1].params, id: 'y' }]
    expect(clockAssemblyFromPaths(noise, 'c1')).toHaveLength(5)
    expect(clockAssemblyFromPaths(noise, 'c2')).toHaveLength(1)
  })

  it('returns a short list when a wheel has been deleted, rather than a hole', () => {
    const asm = clockAssemblyFromPaths(paths.filter((p) => p.clockPart !== 'second'), 'c1')
    expect(asm.map((a) => a.key)).toEqual(['drive', 'great', 'third', 'escapement'])
  })

  it('reads the wheel as it stands NOW, not as it was designed', () => {
    const edited = paths.map((p) =>
      p.clockPart === 'great' && p.shapeParams.type === 'gear'
        ? { ...p, shapeParams: { ...p.shapeParams, teeth: 60 } }
        : p)
    const asm = clockAssemblyFromPaths(edited, 'c1')
    expect(asm[1].params.teeth).toBe(60)
  })
})

describe('the pendulum and the clock agree', () => {
  it('uses the same g — the two files each state it, so nothing links them but this', () => {
    // pendulumLengthMM and pendulumBeat are inverses ONLY if g matches. A silent
    // divergence would cut every clock's rod to the wrong length.
    for (const beat of [0.25, 0.5, 1, 1.5, 2]) {
      expect(pendulumBeat(pendulumLengthMM(beat))).toBeCloseTo(beat, 9)
    }
    expect(G_MM).toBe(9806.65)
  })

  it('hangs its bob with the major axis ACROSS the rod', () => {
    // A bob is a lens seen edge-on. Only the default's orientation is pinned —
    // both radii stay free.
    expect(DEFAULT_SHAPE_CONFIG.pendulum.bobRx).toBeGreaterThan(DEFAULT_SHAPE_CONFIG.pendulum.bobRy)
    const pend = designClock(FOUR, BASE).parts.find((p) => p.key === 'pendulum')!.params
    if (pend.type !== 'pendulum') throw new Error('not a pendulum')
    expect(pend.bobRx).toBeGreaterThan(pend.bobRy)
  })

  it('puts the suspension point at cx,cy and everything else below it', () => {
    // What lets the preview hang it off the pallet arbor with a plain place-and-
    // rock, and what keeps the hanging hole still when the bob is resized.
    const spec = { ...DEFAULT_SHAPE_CONFIG.pendulum, cx: 0, cy: 0 }
    const box = getMultiBBox(generatePendulumParts(spec).map((p) => p.d))!
    expect(box.maxY).toBeCloseTo(spec.rodWidth, 6)   // a rod's width of stock above the hole
    expect(box.minY).toBeLessThan(-spec.length)      // and the bob well below it
    const fat = getMultiBBox(generatePendulumParts({ ...spec, bobRx: 200 }).map((p) => p.d))!
    expect(fat.maxY).toBeCloseTo(box.maxY, 6)
  })
})

describe('the linkage', () => {
  const design = designClock(FOUR, BASE)
  const asm = trainOf(design)
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y)

  const ANGLE_SETS: [string, number[] | undefined][] = [
    ['default (absent)', undefined],
    ['the stated default', defaultLinkAngles()],
    ['straight up', [90, 90, 90, 90]],
    ['folded right back', [90, 270, 90, 270]],
    ['flat across', [0, 0, 0, 0]],
    ['a jumble', [12, 205, 331, 77]],
    ['negative and past 360', [-40, 400, -180, 725]],
    ['short — only two given', [30, 200]],
    ['sparse — a hole in the middle', [30, undefined as unknown as number, 200, 10]],
    ['nonsense entries', [NaN, Infinity, 45, null as unknown as number]],
  ]

  it('holds every link at the centre distance its mesh runs at, whatever the angles', () => {
    // The lengths are FORCED — only the angles are the user's. This is the whole
    // invariant of the linkage, and it must survive any input at all.
    for (const [name, angles] of ANGLE_SETS) {
      const plate = clockPlate(asm, angles)!
      for (let k = 0; k < plate.arbors.length - 1; k++) {
        const got = dist(plate.arbors[k], plate.arbors[k + 1])
        expect(got, `${name}: link ${k}`).toBeCloseTo(plate.arbors[k].centreDistance, 9)
        expect(plate.arbors[k].centreDistance).toBeCloseTo(gearMesh(asm[k].params as never).centreDistance, 9)
      }
    }
  })

  it('never emits a NaN, however broken the angles', () => {
    // An undefined or nonsense angle does not draw a slightly wrong plate — it
    // NaNs every coordinate and the clock silently stops rendering. Same trap as
    // cycOf and toothCurve.
    for (const [name, angles] of ANGLE_SETS) {
      const plate = clockPlate(asm, angles)!
      for (const a of plate.arbors) {
        expect(Number.isFinite(a.x), `${name}: x`).toBe(true)
        expect(Number.isFinite(a.y), `${name}: y`).toBe(true)
        expect(Number.isFinite(a.toNext), `${name}: toNext`).toBe(true)
      }
      for (const v of [plate.anchor.x, plate.anchor.y, plate.bbox.minX, plate.bbox.maxY]) {
        expect(Number.isFinite(v), name).toBe(true)
      }
    }
  })

  it('roots the chain at the ESCAPE arbor, at the origin', () => {
    // The escapement is what does not move: its anchor sits +y from its wheel and
    // the pendulum hangs off that, so a link angle must never tip it.
    for (const [name, angles] of ANGLE_SETS) {
      const plate = clockPlate(asm, angles)!
      const esc = plate.arbors[plate.arbors.length - 1]
      expect(esc.key, name).toBe('escapement')
      expect(esc.x, name).toBeCloseTo(0, 9)
      expect(esc.y, name).toBeCloseTo(0, 9)
      // …and the anchor is always straight above it, at the escapement's own
      // centre distance, whatever the train is doing.
      expect(plate.anchor.x, name).toBeCloseTo(0, 9)
      expect(plate.anchor.y, name).toBeGreaterThan(0)
    }
  })

  it('moves the DRIVE end when an angle changes, and nothing on the escape side', () => {
    // Dragging joint k changes angles[k] alone; everything toward the drive wheel
    // translates rigidly and everything toward the escapement stays put.
    const base = clockPlate(asm, defaultLinkAngles())!
    for (let k = 0; k < 4; k++) {
      const bent = defaultLinkAngles()
      bent[k] += 25
      const p = clockPlate(asm, bent)!
      for (let i = k + 1; i < p.arbors.length; i++) {
        expect(dist(p.arbors[i], base.arbors[i]), `link ${k}, arbor ${i}`).toBeCloseTo(0, 9)
      }
      expect(dist(p.arbors[k], base.arbors[k])).toBeGreaterThan(0.1)
    }
  })

  it('defaults per element rather than throwing the given angles away', () => {
    const short = clockPlate(asm, [30, 200])!
    const full = clockPlate(asm, [30, 200, ...defaultLinkAngles().slice(2)])!
    for (let i = 0; i < short.arbors.length; i++) {
      expect(short.arbors[i].x).toBeCloseTo(full.arbors[i].x, 9)
      expect(short.arbors[i].y).toBeCloseTo(full.arbors[i].y, 9)
    }
  })
})

describe('where the clock sits on the stock', () => {
  const design = designClock(FOUR, BASE)
  const asm = trainOf(design)
  const esc = asm[asm.length - 1].params

  it('is X-centred, and puts the escapement\'s TOP at the top of the stock', () => {
    // The root is the escape ARBOR, and the anchor stands above it, so what is
    // pinned to the stock's top edge is the escapement's whole extent — not the
    // arbor. On a short stock that puts the arbor low; on a tall one, high.
    const geo = generateShapeParts({ ...(esc as Extract<typeof esc, { type: 'escapement' }>), cx: 0, cy: 0 })!
    const escTop = getMultiBBox(geo.map((g) => g.d))!.maxY
    for (const [W, H] of [[300, 200], [1220, 2440], [600, 600]] as const) {
      const r = clockRoot(W, H, esc)
      expect(r.x).toBeCloseTo(W / 2, 9)
      expect(r.y + escTop).toBeCloseTo(H - 10, 9)   // ROOT_MARGIN
    }
  })

  it('is TOP-anchored and not centred — a taller stock moves it by the full height', () => {
    // The sharp version of the rule: centring would move the root by HALF the
    // height difference, top-anchoring by all of it.
    const a = clockRoot(300, 200, esc)
    const b = clockRoot(300, 600, esc)
    expect(b.y - a.y).toBeCloseTo(400, 9)
    expect(b.x).toBeCloseTo(a.x, 9)
  })

  it('does not depend on the arrangement — it cannot drift as the user drags', () => {
    // A pure function of the stock and the ESCAPEMENT. If this ever starts
    // reading the assembly, the clock slides under the cursor mid-drag.
    const a = clockRoot(300, 200, esc)
    const b = clockRoot(300, 200, esc)
    expect(a).toEqual(b)
    // Bending the train every which way must not move it.
    for (const angles of [[0, 0, 0, 0], [90, 270, 12, 331]]) {
      clockPlate(asm, angles)
      expect(clockRoot(300, 200, esc)).toEqual(a)
    }
  })

  it('leaves room for the escapement above the escape arbor', () => {
    // The root IS the escape arbor, and the anchor stands above it — so the
    // margin has to clear the whole escapement, not just the wheel.
    const plate = clockPlate(asm)!
    const r = clockRoot(300, 200, esc)
    expect(r.y + plate.anchor.y).toBeLessThan(200)
  })
})

describe('dragging a joint', () => {
  const design = designClock(FOUR, BASE)
  const asm = trainOf(design)
  const root = { x: 150, y: 100 }
  const world = (p: ClockPlate, i: number) => ({ x: root.x + p.arbors[i].x, y: root.y + p.arbors[i].y })

  /** Apply one drag the way CanvasStage does, and hand back the new plate. */
  const drag = (angles: number[], k: number, cursor: { x: number; y: number }, snap = 0) => {
    const before = clockPlate(asm, angles)!
    const deg = dragLinkAngle(before, root, k, cursor, snap)
    if (deg === null) return null
    const next = angles.slice()
    next[k] = deg
    return { before, after: clockPlate(asm, next)!, next }
  }

  it('puts the joint on the ray from its parent to the cursor, at the link length', () => {
    // The length is the centre distance and is not negotiable, so the joint can
    // only ride its circle — the best it can do is line up with the cursor.
    for (let k = 0; k < 4; k++) {
      for (const cursor of [{ x: 40, y: 300 }, { x: 400, y: -50 }, { x: 150, y: 500 }]) {
        const r = drag(defaultLinkAngles(), k, cursor)!
        const parent = world(r.after, k + 1)
        const got = world(r.after, k)
        const toCursor = Math.atan2(cursor.y - parent.y, cursor.x - parent.x)
        const toJoint = Math.atan2(got.y - parent.y, got.x - parent.x)
        // Same bearing from the parent…
        expect(Math.cos(toCursor - toJoint)).toBeCloseTo(1, 9)
        // …at exactly the link's own length.
        expect(Math.hypot(got.x - parent.x, got.y - parent.y))
          .toBeCloseTo(r.after.arbors[k].centreDistance, 9)
      }
    }
  })

  it('leaves the escapement side untouched and carries the drive side rigidly', () => {
    for (let k = 0; k < 4; k++) {
      const r = drag(defaultLinkAngles(), k, { x: 500, y: 400 })!
      // Nothing from the dragged joint's parent onwards moves…
      for (let i = k + 1; i < r.after.arbors.length; i++) {
        expect(r.after.arbors[i].x).toBeCloseTo(r.before.arbors[i].x, 9)
        expect(r.after.arbors[i].y).toBeCloseTo(r.before.arbors[i].y, 9)
      }
      // …and the drive side keeps its own shape, moving as one piece.
      const dx = r.after.arbors[k].x - r.before.arbors[k].x
      const dy = r.after.arbors[k].y - r.before.arbors[k].y
      for (let i = 0; i < k; i++) {
        expect(r.after.arbors[i].x - r.before.arbors[i].x).toBeCloseTo(dx, 9)
        expect(r.after.arbors[i].y - r.before.arbors[i].y).toBeCloseTo(dy, 9)
      }
    }
  })

  it('changes exactly one angle', () => {
    const base = defaultLinkAngles()
    for (let k = 0; k < 4; k++) {
      const r = drag(base, k, { x: 20, y: 400 })!
      for (let i = 0; i < base.length; i++) {
        if (i === k) continue
        expect(r.next[i]).toBe(base[i])
      }
    }
  })

  it('snaps to 15° when asked, and holds when the cursor is on the parent arbor', () => {
    const r = drag(defaultLinkAngles(), 1, { x: 333, y: 271 }, 15)!
    expect(r.next[1] % 15).toBeCloseTo(0, 9)
    // Every angle is equally good there, so refuse rather than snap to zero.
    const p = clockPlate(asm, defaultLinkAngles())!
    expect(dragLinkAngle(p, root, 1, world(p, 2))).toBeNull()
    // …and the root has no parent to hang from.
    expect(dragLinkAngle(p, root, p.arbors.length - 1, { x: 0, y: 0 })).toBeNull()
  })
})
