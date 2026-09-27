import { describe, it, expect } from 'vitest'
import { generateRatchetParts, ratchetDims, type RatchetSpec } from './ratchetGenerator'
import { DEFAULT_SHAPE_CONFIG } from './shapeGenerators'
import { flattenPath } from '../cam/pathFlattener'
import { pointInPolygon, ptSegDistSq } from '../cam/geom'
import { roundConcave, roundConvex } from './polyOps'
import { signedArea } from '../cam/pathFlattener'

type P = [number, number]
const base: RatchetSpec = { cx: 0, cy: 0, ...DEFAULT_SHAPE_CONFIG.ratchet }
const DEG = Math.PI / 180
const SENSES = [1, -1] as const
const senseName = (s: 1 | -1) => (s === 1 ? 'anticlockwise' : 'clockwise')

function part(spec: RatchetSpec, key: string): P[][] {
  const p = generateRatchetParts(spec).find((q) => q.key === key)
  return p ? (flattenPath(p.d, 0.02) as P[][]) : []
}

const polar = (r: number, a: number): P => [r * Math.cos(a), r * Math.sin(a)]
/** A hole's centre: the middle of its box, which a vertex mean is not. */
const centre = (ring: P[]): P => {
  const xs = ring.map((q) => q[0]), ys = ring.map((q) => q[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}
const rotateAbout = (ring: P[], [cx, cy]: P, a: number): P[] =>
  ring.map(([x, y]) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)])

function distToRing([x, y]: P, ring: P[]): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    best = Math.min(best, ptSegDistSq(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]))
  return Math.sqrt(best)
}

/** Radius at which a ray from the centre at angle `a` leaves the wheel. */
function wheelRadius(wheel: P[], a: number): number {
  let lo = 0, hi = 1000
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2
    if (pointInPolygon(...polar(m, a), wheel)) lo = m; else hi = m
  }
  return lo
}

/** A pawl's nose: its vertex nearest the wheel's centre. */
const noseOf = (r: P[]): P => r.reduce((a, b) => (Math.hypot(...b) < Math.hypot(...a) ? b : a))

/** Each pawl with the pivot hole that lies inside it. */
function pawlsWithPivots(spec: RatchetSpec): { ring: P[]; pivot: P }[] {
  const pivots = part(spec, 'pivot').map(centre)
  return part(spec, 'pawl').map((ring) => ({ ring, pivot: pivots.find((q) => pointInPolygon(q[0], q[1], ring))! }))
}

describe('ratchet — the pawls fit the wheel', () => {
  for (const freeSense of SENSES) {
    for (const pawls of [3, 4]) {
      it(`${pawls} pawls clear the wheel by the clearance all round (gear free ${senseName(freeSense)})`, () => {
        const spec = { ...base, freeSense, pawls }
        const [wheel] = part(spec, 'wheel')
        let worst = Infinity
        for (const q of part(spec, 'pawl').flat()) {
          expect(pointInPolygon(q[0], q[1], wheel)).toBe(false)
          worst = Math.min(worst, distToRing(q, wheel))
        }
        expect(worst).toBeGreaterThan(spec.clearance - 0.02)
        // ...and every nose is seated, not hovering: the clearance IS the gap.
        expect(worst).toBeLessThan(spec.clearance + 0.05)
      })
    }
  }

  it('spaces the pawls evenly, each nose below the tip circle', () => {
    for (const freeSense of SENSES) {
      for (const pawls of [2, 3, 4, 6]) {
        const spec = { ...base, freeSense, pawls, teeth: 12, pawlLength: 16, pawlAngle: 90 }
        const rings = part(spec, 'pawl')
        expect(rings).toHaveLength(pawls)
        const angles = rings.map((r) => {
          const nose = noseOf(r)
          expect(Math.hypot(...nose)).toBeLessThan(spec.outerDia / 2 - 0.6 * spec.toothDepth)
          return Math.atan2(nose[1], nose[0])
        })
        // Each within a tooth of where the even spacing puts it.
        for (let k = 0; k < pawls; k++) {
          const want = (90 + (k * 360) / pawls) * DEG
          const got = angles.some((a) => Math.abs(Math.atan2(Math.sin(a - want), Math.cos(a - want))) < (360 / 12) * DEG)
          expect(got).toBe(true)
        }
      }
    }
  })

  it('gives every pawl only inside corners the cutter can make', () => {
    // A closing at the cutter's radius fills exactly the inside corners an end
    // mill cannot reach; on a pawl it can cut as drawn, it adds (next to) nothing.
    for (const freeSense of SENSES) {
      const spec = { ...base, freeSense }
      for (const ring of part(spec, 'pawl')) {
        const before = Math.abs(signedArea(ring))
        const after = roundConcave([ring], spec.toolDia / 2 - 0.05).reduce((s, r) => s + Math.abs(signedArea(r)), 0)
        expect(after - before).toBeLessThan(0.05)
      }
    }
  })

  it('puts a pivot hole inside every pawl', () => {
    const found = pawlsWithPivots(base)
    expect(found).toHaveLength(base.pawls)
    for (const q of found) expect(q.pivot).toBeDefined()
  })

  it('rounds the teeth to a multiple of the pawls, and says so', () => {
    expect(ratchetDims({ ...base, teeth: 8, pawls: 4 })).toMatchObject({ teeth: 8, teethRounded: false })
    expect(ratchetDims({ ...base, teeth: 10, pawls: 4 })).toMatchObject({ teeth: 12, teethRounded: true })
    expect(ratchetDims({ ...base, teeth: 8, pawls: 3 })).toMatchObject({ teeth: 9, teethRounded: true })
  })
})

describe('ratchet — the wheel', () => {
  const area = (rings: P[][]) => rings.reduce((s, r) => s + Math.abs(signedArea(r)), 0)
  // An opening at radius r takes off exactly the convex corners sharper than r.
  it('rounds every tooth tip to the radius asked for, and no more', () => {
    for (const tipRadius of [0.5, 1.5]) {
      const wheel = part({ ...base, tipRadius }, 'wheel')
      // (Within the arcs' own faceting — they are sampled at a 0.05 mm chord.)
      expect(area(wheel) - area(roundConvex(wheel, tipRadius - 0.05))).toBeLessThan(0.1)
      expect(area(wheel) - area(roundConvex(wheel, tipRadius + 0.5))).toBeGreaterThan(0.05)
    }
    const sharp = part({ ...base, tipRadius: 0 }, 'wheel')
    // Sharp to within the root fillet's round trip through clipper.
    expect(Math.max(...sharp.flat().map((q) => Math.hypot(...q)))).toBeGreaterThan(base.outerDia / 2 - 0.02)
  })
})

describe('ratchet — the pivot is on the line of action', () => {
  // The face is radial, so it pushes the nose along the tangent; with the pivot
  // on that tangent through the middle of the face, a locked pawl is a strut into
  // its pin and nothing lifts it out.
  for (const freeSense of SENSES) {
    it(`stands on the tangent through the middle of the face, trailing the nose (gear free ${senseName(freeSense)})`, () => {
      const spec = { ...base, freeSense }
      const d = ratchetDims(spec)
      for (let k = 0; k < spec.pawls; k++) {
        const u = polar(1, (spec.pawlAngle + (k * 360) / spec.pawls) * DEG)
        const pivot = part(spec, 'pivot').map(centre).find((q) => q[0] * u[0] + q[1] * u[1] > 0
          && Math.abs(q[0] * u[0] + q[1] * u[1] - (d.tipR + d.rootR) / 2) < 0.05)
        expect(pivot).toBeDefined()
        const across = -pivot![0] * u[1] + pivot![1] * u[0]
        // To the drawn hole's chord tolerance (arcs are sampled at 0.05 mm).
        expect(Math.abs(Math.abs(across) - spec.pawlLength)).toBeLessThan(0.05)
        // Turned the locking way the nose LEADS and the pivot trails, so the
        // face drives the nose straight back into the pin: the pivot lies on
        // the gear's free side of the nose.
        expect(Math.sign(across)).toBe(freeSense)
      }
    })
  }
})

describe('ratchet — it turns one way only', () => {
  // Turn the WHEEL a third of a tooth under the pawls and look at what passes
  // under each nose. The way the gear is free (the wheel going the other way,
  // relative to it) it is a tooth's back, rising by a third of the tooth; the
  // locking way it is a face — up to the (rounded) tip, all at once.
  for (const freeSense of SENSES) {
    it(`a gear free ${senseName(freeSense)} lifts its pawls that way and locks the other`, () => {
      const spec = { ...base, freeSense }
      const [wheel] = part(spec, 'wheel')
      const tipR = spec.outerDia / 2
      const step = (360 / spec.teeth / 3) * DEG
      const wheelFree = -freeSense
      for (const ring of part(spec, 'pawl')) {
        const nose = noseOf(ring)
        const a = Math.atan2(nose[1], nose[0])
        // Turning the wheel by +δ brings what was at a − δ round under the nose.
        const highest = (dir: number) => {
          let m = 0
          for (let i = 1; i <= 400; i++) m = Math.max(m, wheelRadius(wheel, a - dir * step * (i / 400)))
          return m
        }
        // (Not quite to the tip circle: the tip is rounded, which lowers it.)
        expect(highest(wheelFree)).toBeLessThan(tipR - 0.5 * spec.toothDepth)
        expect(highest(-wheelFree)).toBeGreaterThan(tipR - 0.15 * spec.toothDepth)
      }
    })
  }
})

describe('ratchet — the housing is the stop', () => {
  // The pocket's wall catches a pawl swinging out. It has to clear every seated
  // pawl, let each lift clear of the tips, and catch it before its weight goes
  // over its pivot — which a plain pawl manages on its own when it is long
  // enough, and a short one does only with a heel.
  const HEELED = { pawlLength: 20, toothDepth: 5, pawlWidth: 12, outerDia: 30 }

  /** Swing the pawl out (the way its nose leaves the centre) by `deg`. */
  const outward = (ring: P[], pivot: P) => {
    // Judged on the NOSE, not the farthest point: the farthest is on the boss,
    // which turns in place and reaches just as far either way. (Judged on that,
    // an earlier harness swung the pawl INTO the wheel and reported a swing of
    // 113° that was never there.)
    const up = Math.hypot(...noseOf(rotateAbout(ring, pivot, 0.05)))
    const down = Math.hypot(...noseOf(rotateAbout(ring, pivot, -0.05)))
    return up > down ? 1 : -1
  }

  for (const freeSense of SENSES) {
    for (const [name, over] of [['plain', {}], ['heeled', HEELED]] as const) {
      it(`clears the ${name} pawls seated, lets them lift clear of the tips, and catches them by 45° (gear free ${senseName(freeSense)})`, () => {
        const spec = { ...base, freeSense, ...over }
        const d = ratchetDims(spec)
        expect(d.heeled).toBe(name === 'heeled')
        const [housing] = part(spec, 'housing')
        expect(Math.max(...housing.map((q) => Math.hypot(...q)))).toBeCloseTo(d.housingR, 3)
        const tipR = spec.outerDia / 2
        for (const { ring, pivot } of pawlsWithPivots(spec)) {
          const out = outward(ring, pivot)
          const reach = (deg: number) => Math.max(...rotateAbout(ring, pivot, out * deg * DEG).map((q) => Math.hypot(...q)))
          // Seated, a clearance inside the wall.
          expect(reach(0)).toBeLessThan(d.housingR - spec.clearance + 0.02)
          // Lifted clear of every tip, still short of the wall...
          const lifted = rotateAbout(ring, pivot, out * (d.liftDeg + 0.1) * DEG)
          expect(Math.min(...lifted.map((q) => Math.hypot(...q)))).toBeGreaterThan(tipR)
          expect(reach(d.liftDeg + 0.1)).toBeLessThan(d.housingR)
          // ...and at the wall where the readout says, well before the weight
          // goes over the pivot.
          expect(reach(d.stopDeg - 0.2)).toBeLessThan(d.housingR)
          expect(reach(d.stopDeg + 0.2)).toBeGreaterThan(d.housingR)
          expect(d.stopDeg).toBeLessThanOrEqual(Math.max(45, d.liftDeg + 5))
        }
      })
    }
  }

  it('puts the heel on only when a plain pawl would swing past 45° to the wall', () => {
    // Long pawls reach the wall on their own; a wide pivot end on a small wheel
    // sets the pocket too far out for that.
    for (const pawlLength of [24, 30, 40]) expect(ratchetDims({ ...base, pawlLength }).heeled).toBe(false)
    const heeled = ratchetDims({ ...base, ...HEELED })
    expect(heeled.heeled).toBe(true)
    // With a heel, the wall catches it a margin past clearing — not at the limit.
    expect(heeled.stopDeg - heeled.liftDeg).toBeLessThan(5)
  })

  it('makes no stop pins — the wall does their job', () => {
    expect(generateRatchetParts(base).some((q) => (q.key as string) === 'stop')).toBe(false)
  })
})

describe('ratchet — gravity drops the pawls in', () => {
  it('counts the pawls high enough to fall in at the worst angle the gear stops at', () => {
    expect(ratchetDims({ ...base, pawls: 2 })).toMatchObject({ engagedMin: 0, mayNotEngage: true })
    expect(ratchetDims({ ...base, pawls: 4 })).toMatchObject({ engagedMin: 1, mayNotEngage: false })
    expect(ratchetDims({ ...base, pawls: 6, teeth: 12, pawlLength: 16 }).engagedMin).toBe(2)
  })
})

describe('ratchet — what the panel warns about', () => {
  it('flags pawls that meet at either end of their swing, not only as drawn', () => {
    expect(ratchetDims(base).pawlsCollide).toBe(false)
    // Eight long pawls: each clears its neighbours seated, as drawn — but a
    // lifted nose swings up into the pawl lying across it.
    expect(ratchetDims({ ...base, pawls: 8, pawlLength: 40 }).pawlsCollide).toBe(true)
  })

  it('flags a pawl too short to lift clear — its pivot end turns in the teeth', () => {
    expect(ratchetDims(base).cannotClear).toBe(false)
    expect(ratchetDims({ ...base, pawlLength: 16 }).cannotClear).toBe(true)
  })

  it('flags a pin with no wood round it, and a tooth the cutter rounds away', () => {
    expect(ratchetDims(base).bossThin).toBe(false)
    expect(ratchetDims({ ...base, pawlWidth: 5 }).bossThin).toBe(true)
    expect(ratchetDims(base).toothTooShallow).toBe(false)
    expect(ratchetDims({ ...base, toothDepth: 2 }).toothTooShallow).toBe(true)
  })
})
