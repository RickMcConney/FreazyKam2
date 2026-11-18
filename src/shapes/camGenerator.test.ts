// The cam: an Archimedean snail with a lever. The one reason to use the spiral is that
// r = r₀ + kθ lifts the follower the same amount for every degree of handle, so that is
// measured OFF THE EMITTED OUTLINE — after the lever is unioned on and the junction closed,
// the two steps that could quietly eat the face. The rest pins what a user decides from
// (stroke, pressure angle, the two warnings) and what makes it a part you can cut.
// Same claims as scripts/cam-check.mts, which prints them for a look by eye.
import { describe, it, expect } from 'vitest'
import { generateCamParts, generateCamD, camDims, baseDiaForRadius, type CamSpec } from './camGenerator'
import { scaleShapeParams } from './shapeGenerators'
import { flattenPath, type Pt2 } from '../cam/pathFlattener'

const BASE: CamSpec = {
  cx: 120, cy: 90, baseDia: 40, riseMM: 12, sweepDeg: 360,
  boreDia: 8, handleLength: 100, handleWidth: 18,
}
const outlineOf = (s: CamSpec) => flattenPath(generateCamParts(s).find(p => p.key === 'cam')!.d, 0.002)[0] as Pt2[]
const polar = (s: CamSpec, [x, y]: Pt2) => {
  let a = Math.atan2(y - s.cy, x - s.cx)
  if (a < 0) a += 2 * Math.PI
  return { a, r: Math.hypot(x - s.cx, y - s.cy) }
}

/** The face's radius at `deg`, interpolated along the edge that straddles it. */
function faceRadiusAt(s: CamSpec, outline: Pt2[], deg: number): number {
  const a = (deg * Math.PI) / 180
  const crest = s.baseDia / 2 + camDims(s).usableStroke
  for (let i = 0; i < outline.length; i++) {
    const p = polar(s, outline[i]), q = polar(s, outline[(i + 1) % outline.length])
    if (Math.abs(q.a - p.a) > Math.PI) continue                       // the seam
    if (a < Math.min(p.a, q.a) || a > Math.max(p.a, q.a)) continue
    if (Math.min(p.r, q.r) > crest + 0.05) continue                   // the lever
    const t = Math.abs(q.a - p.a) < 1e-12 ? 0 : (a - p.a) / (q.a - p.a)
    return p.r + t * (q.r - p.r)
  }
  return NaN
}

describe('the face is an Archimedean spiral', () => {
  it('lifts the same for every 45° of handle', () => {
    const outline = outlineOf(BASE)
    const want = camDims(BASE).liftPerDeg * 45
    const steps: number[] = []
    for (let deg = 90; deg <= 315; deg += 45) steps.push(faceRadiusAt(BASE, outline, deg) - faceRadiusAt(BASE, outline, deg - 45))
    for (const st of steps) expect(st).toBeCloseTo(want, 2)
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(0.01)
  })

  const CASES: [string, Partial<CamSpec>][] = [
    ['a full turn', {}], ['a 270° sweep', { sweepDeg: 270 }], ['a 180° sweep', { sweepDeg: 180 }],
    ['a steep rise', { riseMM: 30 }], ['a small base', { baseDia: 20, riseMM: 6, handleLength: 70 }],
    ['a wide lever', { handleWidth: 30 }], ['a big cam', { baseDia: 120, riseMM: 40, handleLength: 240, handleWidth: 30, boreDia: 16 }],
  ]
  for (const [name, over] of CASES) {
    it(`stays on r₀ + kθ for ${name}, away from the lever and the step`, () => {
      const s = { ...BASE, ...over }
      const r0 = s.baseDia / 2, k = s.riseMM / (2 * Math.PI), sweep = (s.sweepDeg * Math.PI) / 180
      const crest = r0 + k * sweep
      const bite = Math.asin(Math.min(1, (s.handleWidth / 2 + 2) / r0)) + 0.12
      let worst = 0, n = 0
      for (const p of outlineOf(s)) {
        const { a, r } = polar(s, p)
        if (a < bite || a > sweep - bite || r > crest + 0.05) continue
        worst = Math.max(worst, Math.abs(r - (r0 + k * a))); n++
      }
      expect(n).toBeGreaterThan(20 * (s.sweepDeg / 180))
      expect(worst).toBeLessThan(0.05)
    })
  }

  it('never dips inside the base circle — the follower\'s home', () => {
    for (const sweepDeg of [360, 270, 180]) {
      const s = { ...BASE, sweepDeg }
      const minR = Math.min(...outlineOf(s).map(p => polar(s, p).r))
      expect(minR).toBeGreaterThan(s.baseDia / 2 - 0.05)
    }
  })

  it('runs a short sweep back to the start along the base circle', () => {
    const s = { ...BASE, sweepDeg: 180 }
    const outline = outlineOf(s)
    // Well past the crest's step and clear of the lever at 0°.
    for (const deg of [225, 270, 315]) expect(faceRadiusAt(s, outline, deg)).toBeCloseTo(s.baseDia / 2, 1)
  })
})

describe('it is one part you can cut', () => {
  it('reaches the lever\'s stated length from the pivot', () => {
    for (const handleLength of [70, 100, 160]) {
      const s = { ...BASE, handleLength }
      expect(Math.max(...outlineOf(s).map(p => polar(s, p).r))).toBeCloseTo(handleLength, 1)
    }
  })

  it('is one closed outline that goes round the pivot once, never back on itself', () => {
    const s = BASE
    const outline = outlineOf(s)
    expect(flattenPath(generateCamParts(s).find(p => p.key === 'cam')!.d, 0.05).length).toBe(1)
    let turned = 0
    for (let i = 0; i < outline.length; i++) {
      const a0 = Math.atan2(outline[i][1] - s.cy, outline[i][0] - s.cx)
      const p1 = outline[(i + 1) % outline.length]
      let da = Math.atan2(p1[1] - s.cy, p1[0] - s.cx) - a0
      if (da > Math.PI) da -= 2 * Math.PI
      if (da < -Math.PI) da += 2 * Math.PI
      turned += da
    }
    expect(Math.abs(turned)).toBeCloseTo(2 * Math.PI, 2)
  })

  it('bores the pivot concentric, at its size, as its own part', () => {
    const bore = generateCamParts(BASE).find(p => p.key === 'bore')!
    const rs = (flattenPath(bore.d, 0.002)[0] as Pt2[]).map(p => polar(BASE, p).r)
    expect(Math.min(...rs)).toBeCloseTo(BASE.boreDia / 2, 1)
    expect(Math.max(...rs)).toBeCloseTo(BASE.boreDia / 2, 1)
  })

  it('leaves the bore out when none is asked for', () => {
    expect(generateCamParts({ ...BASE, boreDia: 0 }).map(p => p.key)).toEqual(['cam'])
  })

  it('keeps an oversized bore inside the base circle, so the cam is not cut in two', () => {
    const s = { ...BASE, boreDia: 60 }
    const bore = generateCamParts(s).find(p => p.key === 'bore')!
    const rMax = Math.max(...(flattenPath(bore.d, 0.002)[0] as Pt2[]).map(p => polar(s, p).r))
    expect(rMax).toBeLessThan(s.baseDia / 2)
  })

  it('draws its preview as the same parts', () => {
    expect(generateCamD(BASE)).toBe(generateCamParts(BASE).map(p => p.d).join(' '))
  })
})

describe('the readouts are the geometry', () => {
  it('states the stroke over its own sweep, not the rise per turn', () => {
    expect(camDims({ ...BASE, sweepDeg: 270 }).usableStroke).toBeCloseTo(9, 9)
    expect(camDims({ ...BASE, sweepDeg: 270 }).risePerRev).toBe(12)
    expect(camDims({ ...BASE, sweepDeg: 270 }).maxDia).toBeCloseTo(40 + 18, 9)
  })

  it('puts the worst pressure angle at the base circle: tan φ = k / r₀', () => {
    const k = 12 / (2 * Math.PI)
    expect(camDims(BASE).pressureAngleDeg).toBeCloseTo(Math.atan(k / 20) * 180 / Math.PI, 9)
    expect(camDims(BASE).pressureAngleAtCrestDeg).toBeLessThan(camDims(BASE).pressureAngleDeg)
  })

  it('warns that friction will not hold it once the angle passes 10°', () => {
    // tan 10° · 2π · r₀ is the rise at which a cam of this base starts to unwind itself.
    const atTen = Math.tan(10 * Math.PI / 180) * 2 * Math.PI * 20
    expect(camDims({ ...BASE, riseMM: atTen * 0.98 }).wontHold).toBe(false)
    expect(camDims({ ...BASE, riseMM: atTen * 1.02 }).wontHold).toBe(true)
  })

  it('warns when the lever does not reach past the crest — a lump, not a lever', () => {
    const crest = camDims(BASE).maxDia / 2
    expect(camDims({ ...BASE, handleLength: crest + 5 }).handleTooShort).toBe(false)
    expect(camDims({ ...BASE, handleLength: crest }).handleTooShort).toBe(true)
  })
})

describe('sizing and scaling', () => {
  it('a drag sizes the crest: the base gives way and the rise holds', () => {
    for (const [radius, rise, sweep] of [[40, 12, 360], [25, 6, 270], [60, 20, 180]]) {
      const baseDia = baseDiaForRadius(radius, rise, sweep)
      expect(camDims({ ...BASE, baseDia, riseMM: rise, sweepDeg: sweep }).maxDia / 2).toBeCloseTo(radius, 9)
    }
  })

  it('refuses a stretch on one axis — the lift would stop being linear', () => {
    expect(scaleShapeParams({ type: 'cam', ...BASE } as never, 0, 0, 2, 1)).toBeNull()
  })

  it('scales every dimension together under a uniform scale', () => {
    const p = scaleShapeParams({ type: 'cam', ...BASE } as never, 0, 0, 1.5, 1.5) as unknown as CamSpec
    expect(p.baseDia).toBeCloseTo(60, 9)
    expect(p.riseMM).toBeCloseTo(18, 9)
    expect(p.boreDia).toBeCloseTo(12, 9)
    expect(p.handleLength).toBeCloseTo(150, 9)
    expect(p.handleWidth).toBeCloseTo(27, 9)
    expect(p.cx).toBeCloseTo(180, 9)
  })
})
