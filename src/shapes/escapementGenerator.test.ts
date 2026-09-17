import { describe, it, expect } from 'vitest'
import {
  carriedPinion, generateEscapementParts, escapementDims, escapementEnergy, escapementPose, anchorOffset, escapementSpan, LANDING_DEPTH,
  __escBackCorner, __escFaces, __escLockCorner, __escLockPoints, __escBackEdge, __escToothRing, __escLocus,
  type EscapementSpec,
} from './escapementGenerator'
import { flattenPath } from '../cam/pathFlattener'
import { pointInPolygon } from '../cam/geom'
import { scaleShapeParams, type ShapeParams } from './shapeGenerators'

// Whether the thing actually escapes is a question about the wheel and the
// anchor TOGETHER, and it is answered by running the mesh — see
// `scripts/escapement-check.mts`. What is pinned here is everything that can be
// checked on one part at a time: the construction the pallets are placed by, the
// inputs that make an escapement that cannot run, and the emitted parts.

const BASE: EscapementSpec = {
  cx: 0, cy: 0, escType: 'deadbeat', teeth: 30, wheelDia: 100,
  toothDepth: 6, drop: 2, lift: 3, lock: 1.5, draw: 2, recoilArc: 4,
  armWidth: 8, bore: 6, hubDia: 20, spokes: 5, anchorBore: 6,
  clockwise: false,
}

describe('escapement — the classic construction', () => {
  it('puts the arbor where the tangents to the tip circle cross', () => {
    // L = R/cos(β/2) and ρ = R·tan(β/2), which together say AP ⟂ OP: the
    // pallet arms lie along tangents. Everything else rests on this.
    for (const teeth of [22, 30, 42]) {
      const d = escapementDims({ ...BASE, teeth })
      const R = BASE.wheelDia / 2
      const beta = (escapementSpan(teeth) * 2 * Math.PI) / teeth
      expect(d.centreDistance).toBeCloseTo(R / Math.cos(beta / 2), 9)
      expect(d.palletRadius).toBeCloseTo(R * Math.tan(beta / 2), 9)
      // Right angle at the pallet: L² = R² + ρ².
      expect(d.centreDistance ** 2).toBeCloseTo(R ** 2 + d.palletRadius ** 2, 6)
    }
  })

  it('spends the beat on impulse and drop and nothing else', () => {
    const d = escapementDims(BASE)
    expect(d.beatDeg).toBeCloseTo(180 / BASE.teeth, 12)
    expect(d.wheelImpulseDeg + BASE.drop).toBeCloseTo(d.beatDeg, 9)
  })

  it('always spans an ODD number of half teeth, whatever the tooth count', () => {
    // The wheel gives up half a tooth per beat, so the pallets have to stand an
    // odd number of half pitches apart or one releases without the other
    // catching — the classic way to draw an escapement that cannot run. It used
    // to be a field with a red warning under it; now it is derived, so the whole
    // failure mode is gone and this is what says so.
    //
    // Note what a plain "N/4 to the nearest half" would do: at 28, 32, 36, 40 it
    // lands on a WHOLE tooth, which is exactly the broken case.
    for (let n = 6; n <= 120; n++) {
      const s = escapementSpan(n)
      expect(s * 2).toBe(Math.round(s * 2))
      expect(Math.round(s * 2) % 2).toBe(1)
      // And near N/4, which is what puts the pallets either side of the wheel.
      expect(Math.abs(s - n / 4)).toBeLessThanOrEqual(0.5)
      expect(escapementDims({ ...BASE, teeth: n }).span).toBe(s)
    }
  })

  it('flags a drop that leaves no impulse', () => {
    expect(escapementDims({ ...BASE, drop: 2 }).noImpulse).toBe(false)
    expect(escapementDims({ ...BASE, drop: 6 }).noImpulse).toBe(true)
  })
})

describe('escapement — the acting faces', () => {
  it('locks on an arc concentric with the arbor', () => {
    // This is what "dead" means: a circle centred on the pivot is unmoved by
    // rotation about it, so the tooth resting on it stays where it is while the
    // pendulum swings on. Draw is the one thing allowed to break it, and only
    // by the couple of degrees that pulls the pallet in.
    //
    // Still exactly concentric with a tip round in the picture, which is the
    // whole reason the faces are OFFSET by it rather than left alone: an arc
    // concentric with the arbor offsets to another arc concentric with the
    // arbor, so the tooth's round beds on a dead face just as its point did.
    // Asked of the dead face PROPER — `__escLockPoints` is where the round on the
    // locking corner starts, and the corner is not dead, which is the point of
    // measuring the landing from it.
    for (const side of ['entry', 'exit'] as const) {
      const spec = { ...BASE, draw: 0 }
      const face = __escFaces(spec, side)
      const n = __escLockPoints(spec, side)
      const r = face.slice(0, n).map((p) => Math.hypot(p[0], p[1]))
      expect(r.length).toBeGreaterThan(10)
      // The arc itself, to nine places. Its LAST point is the corner fillet's
      // tangency, which is built against the chord into that corner rather than
      // against the arc, so it sits a third of a micron inside it — pinned too,
      // because a fillet that missed its tangency by anything real would leave a
      // step on the one face a tooth rests on.
      for (const v of r.slice(0, -1)) expect(v).toBeCloseTo(r[0], 9)
      expect(r[r.length - 1]).toBeCloseTo(r[0], 3)
    }
  })

  it('leans each locking face towards its OWN stock when draw is asked for', () => {
    // Draw leans the face off concentric so the drive tightens the lock rather
    // than picking it — and which way that is differs between the pallets,
    // because their stock is on opposite sides of their faces. The entry's lies
    // towards the arbor and the exit's away from it, so the face has to close on
    // the arbor as the lock deepens on one and open away from it on the other.
    //
    // Leaning both the same way (the obvious reading of "draw leans it inward")
    // draws the entry and REPELS the exit: its face travels out through itself
    // into the tooth, which is a lock that trips, and on the canvas it is the
    // exit tooth embedded in the pallet while the entry stands off by the same
    // amount. Nothing else catches it — the profile is a clean curve either way,
    // and the mesh check measured 0.04 mm.
    for (const side of ['entry', 'exit'] as const) {
      const spec = { ...BASE, draw: 3 }
      const face = __escFaces(spec, side)
      const n = __escLockPoints(spec, side)                 // the dead face proper
      const r = face.slice(0, n).map((p) => Math.hypot(p[0], p[1]))
      const deep = r[0], atImpulse = r[r.length - 1]        // face[0] is deepest
      if (side === 'entry') expect(deep).toBeLessThan(atImpulse)
      else expect(deep).toBeGreaterThan(atImpulse)
      // And by the amount asked for — as an ANGLE off concentric, over the face's
      // own length. Not as a radial spread over the lock angle: the face no longer
      // spans the whole lock (the round on the locking corner stands back from the
      // end of it) and the offset for the tooth's tip round moves the whole face
      // out by a round while leaving its angular extent alone, which takes a
      // radius-per-radian figure 1.7% off while the ANGLE it leans at is still the
      // angle that was asked for. To a tenth of a degree, which is what those two
      // second-order effects come to.
      let len = 0
      for (let i = 1; i < n; i++) {
        len += Math.hypot(face[i][0] - face[i - 1][0], face[i][1] - face[i - 1][1])
      }
      const lean = (Math.atan(Math.abs(deep - atImpulse) / len) * 180) / Math.PI
      expect(Math.abs(lean - 3)).toBeLessThan(0.1)
    }
  })

  it('makes the drive assist the lock on both pallets, not one', () => {
    // The test of draw is not the outline but the WHEEL. Hold the tooth and
    // deepen the lock: a drawing face retreats in the tooth's own direction of
    // travel, so the wheel creeps forward to stay in touch and the drive is
    // doing the work of pulling the pallet in. A repelling face advances into
    // the tooth instead, and the drive is fighting the lock.
    //
    // The tooth's travel at the pallet runs straight into the stock (AP ⟂ OP is
    // what makes that true), so "retreats" is simply "moves into its own stock".
    for (const draw of [2, 6, 12]) {
      for (const side of ['entry', 'exit'] as const) {
        const spec = { ...BASE, draw }
        const face = __escFaces(spec, side).slice(0, __escLockPoints(spec, side))
        const rDeep = Math.hypot(face[0][0], face[0][1])
        const rShallow = Math.hypot(face[face.length - 1][0], face[face.length - 1][1])
        const intoStock = side === 'entry' ? rShallow - rDeep : rDeep - rShallow
        expect(intoStock).toBeGreaterThan(0)
      }
    }
    // And nothing at all when none is asked for: the face is the dead arc.
    for (const side of ['entry', 'exit'] as const) {
      const spec = { ...BASE, draw: 0 }
      // One short of the corner: the last point is the fillet's tangency, which
      // is a third of a micron off the arc by construction.
      const face = __escFaces(spec, side).slice(0, __escLockPoints(spec, side) - 1)
      expect(Math.hypot(face[0][0], face[0][1]))
        .toBeCloseTo(Math.hypot(face[face.length - 1][0], face[face.length - 1][1]), 9)
    }
  })

  it('gives a recoil escapement no dead arc at all', () => {
    for (const side of ['entry', 'exit'] as const) {
      const face = __escFaces({ ...BASE, escType: 'recoil' }, side)
      const r = face.slice(0, 24).map((p) => Math.hypot(p[0], p[1]))
      // Every point at a different radius from the arbor — the wheel is driven
      // back through the whole of it.
      expect(Math.abs(r[0] - r[r.length - 1])).toBeGreaterThan(0.1)
    }
  })

  it('cuts the two faces differently, because the wheel turns one way', () => {
    // Every hand construction draws an anchor symmetric. The true loci are not:
    // the entry and exit act on the same rotation, so mirroring one does not
    // give the other.
    const e = __escFaces(BASE, 'entry')
    const x = __escFaces(BASE, 'exit')
    const mirrored = e.map(([px, py]) => [-px, py] as [number, number])
    const diff = Math.max(...x.map((p, i) => Math.hypot(p[0] - mirrored[i][0], p[1] - mirrored[i][1])))
    expect(diff).toBeGreaterThan(0.01)
  })
})

describe('escapement — emission', () => {
  it('emits the wheel and the anchor as separate parts', () => {
    const keys = generateEscapementParts(BASE).map((p) => p.key)
    expect(keys).toContain('wheel')
    expect(keys).toContain('anchor')
    expect(keys).toContain('spokes')
    expect(keys).toContain('bore')
    expect(keys).toContain('anchorbore')
  })

  it('drops the parts that were not asked for', () => {
    const keys = generateEscapementParts({ ...BASE, spokes: 0, bore: 0, anchorBore: 0 }).map((p) => p.key)
    expect(keys).toEqual(['wheel', 'anchor'])
  })

  it('mirrors for a clockwise wheel and leaves the readouts alone', () => {
    // The teeth lean the way the wheel runs, so this is geometry rather than a
    // view option — but it is a reflection, so no dimension changes.
    const ccw = generateEscapementParts(BASE)
    const cw = generateEscapementParts({ ...BASE, clockwise: true })
    expect(cw.map((p) => p.key)).toEqual(ccw.map((p) => p.key))
    expect(cw[0].d).not.toEqual(ccw[0].d)
    expect(escapementDims({ ...BASE, clockwise: true })).toEqual(escapementDims(BASE))
  })

  it('draws the anchor clear of the wheel, not at the centre distance', () => {
    const parts = generateEscapementParts(BASE)
    const ys = (d: string) => d.replace(/Z/g, ' ').split(/[ML]/).slice(1)
      .map((p) => Number(p.split(',')[1])).filter((v) => Number.isFinite(v))
    const wheelTop = Math.max(...ys(parts.find((p) => p.key === 'wheel')!.d))
    const anchorLow = Math.min(...ys(parts.find((p) => p.key === 'anchor')!.d))
    expect(anchorLow).toBeGreaterThan(wheelTop)
  })

  it('gives the wheel a whole number of teeth', () => {
    for (const teeth of [15, 30, 48]) {
      const d = escapementDims({ ...BASE, teeth })
      expect(d.toothPitchDeg).toBeCloseTo(360 / teeth, 12)
    }
  })
})

// The escape wheel carries the third wheel's pinion, like every other driven
// wheel in a clock: the pins go through its hub and one loose cheek caps them.
// Stated in PIN CIRCLE rather than module, because an escapement has none — that
// circle belongs to the mesh with the wheel before it.
describe('escapement — the pinion the wheel carries', () => {
  const carrier: EscapementSpec = { ...BASE, arborPins: 12, arborPinCircleDia: 48, arborPinDia: 5 }

  it('carries nothing unless asked', () => {
    expect(carriedPinion(BASE)).toBeNull()
    expect(generateEscapementParts(BASE).some((p) => p.key === 'arborpins')).toBe(false)
    // …and asking changes nothing about the wheel it escapes with.
    expect(escapementDims(carrier).centreDistance).toBeCloseTo(escapementDims(BASE).centreDistance, 9)
    const teeth = (p: EscapementSpec) => generateEscapementParts(p).find((x) => x.key === 'wheel')!.d
    expect(teeth(carrier)).toBe(teeth(BASE))
  })

  it('grows the hub to hold the holes, and drills them in solid stock', () => {
    const grown = escapementDims(carrier).hub
    expect(grown.dia).toBeGreaterThan(escapementDims(BASE).hub.dia)
    expect(grown.dia).toBeCloseTo(carriedPinion(carrier)!.hubDia, 9)

    const parts = generateEscapementParts(carrier)
    const holes = flattenPath(parts.find((p) => p.key === 'arborpins')!.d, 0.01)
    const windows = flattenPath(parts.find((p) => p.key === 'spokes')!.d, 0.05)
    expect(holes).toHaveLength(12)
    for (const h of holes) {
      // Measured radially — a sampled circle's vertex mean is not its centre.
      const rs = h.map(([x, y]) => Math.hypot(x, y))
      expect(Math.min(...rs)).toBeCloseTo(24 - 2.5, 1)
      expect(Math.max(...rs)).toBeCloseTo(24 + 2.5, 1)
      for (const v of h) {
        expect(Math.hypot(v[0], v[1])).toBeLessThan(grown.dia / 2)
        expect(Math.hypot(v[0], v[1])).toBeGreaterThan(carrier.bore / 2)
        for (const w of windows) expect(pointInPolygon(v[0], v[1], w)).toBe(false)
      }
    }
  })
})

describe('escapement — the energy budget', () => {
  // The one thing about an escapement that cannot be read off the drawing: of
  // what the drive spends, how much does the pendulum get back? Asked for so that
  // turning a knob shows whether the pendulum is gaining or losing
  // (Rick, 2026-09-17).

  it('hands the anchor the wheel\'s whole impulse before friction', () => {
    // THE IDENTITY THE INTEGRATION IS WORTH DOING. For a conjugate pair the work
    // out at the anchor equals the work in at the wheel exactly — ∫F·d_A dφ =
    // M·μ — and it only comes out that way if the contact normal is right at
    // every step. Get the normal wrong (take it along the face, say, or forget
    // that it passes through the pair's instant centre) and the faces still look
    // perfect, the mesh still meshes, and this number quietly stops matching.
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const drop of [1, 2, 3]) {
        for (const lift of [2, 3, 6]) {
          const spec = { ...BASE, escType, drop, lift }
          const e = escapementEnergy(spec)
          const mu = (escapementDims(spec).wheelImpulseDeg * Math.PI) / 180
          expect(e.impulseWork, `${escType} drop ${drop} lift ${lift}`).toBeCloseTo(mu, 3)
        }
      }
    }
  })

  it('spends the whole beat every beat, and loses the drop out of it', () => {
    // The drive gives up half a tooth per beat whatever the escapement does with
    // it, so the budget's total is the BEAT and not the impulse — which is what
    // makes drop cost twice: it takes from the impulse and adds to the loss.
    for (const drop of [0.5, 2, 4]) {
      const spec = { ...BASE, drop }
      const e = escapementEnergy(spec)
      const beat = (escapementDims(spec).beatDeg * Math.PI) / 180
      expect(e.driveWork).toBeCloseTo(beat, 9)
      expect(e.dropLoss / e.driveWork).toBeCloseTo(drop / escapementDims(spec).beatDeg, 6)
    }
    // And it is the biggest single lever on what the pendulum gets.
    const less = escapementEnergy({ ...BASE, drop: 1 })
    const more = escapementEnergy({ ...BASE, drop: 3 })
    expect(less.delivered).toBeGreaterThan(more.delivered * 1.4)
  })

  it('charges whatever the tooth rubs on before the impulse, out and back', () => {
    // Out to the extreme of the swing and back again: friction does not care
    // which way the tooth is going. A deep lock is what that punishes.
    const shallow = escapementEnergy({ ...BASE, lock: 1.5 })
    const deep = escapementEnergy({ ...BASE, lock: 6 })
    expect(deep.lockSlide).toBeGreaterThan(shallow.lockSlide * 3)
    expect(deep.efficiency).toBeLessThan(shallow.efficiency / 2)

    // AND A RECOIL RUBS ON ITS RECOIL FACE, which was charged nothing at first —
    // `recoilArc` moved no number on the readout, which for a recoil's biggest
    // parameter cannot be right (Rick spotted it, 2026-09-17). It is the same
    // integral as the impulse, the locus simply carrying on past t = −0.5, and it
    // is a LONGER rub under a HIGHER force than a deadbeat's dead face: the
    // impulse face's normal stands 53° off radial, so the arm about the wheel is
    // 0.6R where the dead face's is R.
    for (const arc of [0.5, 1, 1.5]) {
      const r = escapementEnergy({ ...BASE, escType: 'recoil', recoilArc: arc })
      expect(r.lockSlide, `arc ${arc}`).toBeGreaterThan(0)
      expect(r.lockFriction, `arc ${arc}`).toBeGreaterThan(0)
    }
    // Out AND back, pinned against the locus itself: the recoil stretch is the
    // first 24 points of the profile the faces are generated from, so its length
    // is measurable without going through the budget at all.
    for (const arc of [0.5, 1.5, 3]) {
      const spec = { ...BASE, escType: 'recoil' as const, recoilArc: arc }
      const l = __escLocus(spec, 'entry')
      let oneWay = 0
      for (let i = 1; i <= 24; i++) {
        oneWay += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1])
      }
      expect(escapementEnergy(spec).lockSlide, `arc ${arc}`).toBeCloseTo(2 * oneWay, 6)
    }
    const tight = escapementEnergy({ ...BASE, escType: 'recoil', recoilArc: 0.5 })
    const wide = escapementEnergy({ ...BASE, escType: 'recoil', recoilArc: 3 })
    expect(wide.lockSlide).toBeGreaterThan(tight.lockSlide * 4)
    expect(wide.efficiency).toBeLessThan(tight.efficiency / 2)
    // So the recoil is NOT the more efficient escapement, which is what the
    // missing term made it look like. At the same modest settings it rubs four
    // times as far as the deadbeat and delivers a third of what it does.
    const recoil = escapementEnergy({ ...BASE, escType: 'recoil' })
    expect(recoil.lockSlide).toBeGreaterThan(shallow.lockSlide * 3)
    expect(recoil.efficiency).toBeLessThan(shallow.efficiency)
  })

  it('costs nothing for draw, because a drawn lock is a spring and not a brake', () => {
    // Draw does work on the pendulum as the lock deepens and takes the same work
    // back on the way out, so it cannot show up in an energy budget — it costs
    // unlocking FORCE and rate, which are different questions. Worth pinning
    // because the obvious reading of draw is that it must cost energy, and a
    // budget that agreed with the obvious reading would be wrong.
    const none = escapementEnergy({ ...BASE, draw: 0 })
    const lots = escapementEnergy({ ...BASE, draw: 9 })
    expect(lots.delivered).toBeCloseTo(none.delivered, 6)
  })

  it('is the same escapement at any size', () => {
    // Friction work is force times slide, the force goes as 1/R and the slide as
    // R, so efficiency is a pure function of the ANGLES. A budget that drifted
    // with the wheel's diameter would be one measuring something else.
    //
    // To a couple of points rather than exactly, and the residue is honest: three
    // of the lengths in here are ABSOLUTE — `tipRound`, `LANDING_DEPTH` and the
    // `RUN_MARGIN` that sits in the dead-face rub — so each is a bigger share of a
    // small wheel. Over Ø40…Ø300 the delivery runs 29.1, 30.7, 32.0, 31.4, 30.6%:
    // a couple of points of camber with the peak near Ø100, and nothing like the
    // 4:1 the slides themselves move over.
    const small = escapementEnergy({ ...BASE, wheelDia: 40 })
    const big = escapementEnergy({ ...BASE, wheelDia: 200 })
    expect(Math.abs(small.efficiency - big.efficiency)).toBeLessThan(0.03)
    expect(big.impulseSlide).toBeGreaterThan(small.impulseSlide * 3)
    expect(big.lockSlide).toBeGreaterThan(small.lockSlide * 2)
  })
})

describe('escapement — as a shape', () => {
  const params = (): ShapeParams => ({ type: 'escapement', ...BASE })

  it('scales its lengths and holds its angles', () => {
    const out = scaleShapeParams(params(), 0, 0, 2, 2)
    expect(out).not.toBeNull()
    if (out?.type !== 'escapement') throw new Error('wrong type')
    expect(out.wheelDia).toBe(200)
    expect(out.toothDepth).toBe(12)
    expect(out.bore).toBe(12)
    // The mechanism is angles and tooth counts — scaling must not touch them.
    expect(out.teeth).toBe(30)
    expect(out.lift).toBe(3)
    expect(out.drop).toBe(2)
  })

  it('gives up its params under a non-uniform scale', () => {
    // Stretched on one axis the pallets no longer stand on tangents to the tip
    // circle, and the whole construction is that tangency.
    expect(scaleShapeParams(params(), 0, 0, 2, 1)).toBeNull()
  })
})

describe('escapement — the teeth', () => {
  it('leans each tooth forward, with the tip overhanging the space in front', () => {
    // The wheel runs clockwise, so a tooth's stock must lie BEHIND its tip and
    // the space in front of it must be clear — that space is where the pallet's
    // impulse face stands at the lock. Lean them the other way, or put the
    // undercut's foot in front of the tip, and the pair binds: the wheel's own
    // root drives into the pallet. Both were live bugs; the mesh found them and
    // the outline did not.
    const parts = generateEscapementParts({ ...BASE, clockwise: true })
    const pts = parts.find((p) => p.key === 'wheel')!.d
      .replace(/[MZ]/g, ' ').split('L').map((s) => s.trim().split(',').map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite))
    // Measured off the emitted outline rather than the nominal circle: the
    // teeth are cut short by the running clearance, and the root-fillet closing
    // moves a tip by a few microns on its way through clipper.
    const R = Math.max(...pts.map((p) => Math.hypot(p[0], p[1])))
    const tips = pts.filter((p) => Math.hypot(p[0], p[1]) > R - 0.01)
    expect(tips.length).toBeGreaterThanOrEqual(BASE.teeth)

    // Just in FRONT of a tip (smaller angle, the way it runs) there must be no
    // stock at all down to the root; just BEHIND it there must be.
    const rRoot = escapementDims(BASE).wheelRootDia / 2
    const at = (ang: number, r: number) => [r * Math.cos(ang), r * Math.sin(ang)] as [number, number]
    const inside = (p: [number, number]) => {
      let c = false
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i] as [number, number], [xj, yj] = pts[j] as [number, number]
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c
      }
      return c
    }
    const tip = Math.atan2(tips[0][1], tips[0][0])
    const step = (2 * Math.PI) / BASE.teeth
    const mid = (rRoot + R) / 2
    expect(inside(at(tip - step * 0.15, mid))).toBe(false)   // in front — clear
    expect(inside(at(tip + step * 0.15, mid))).toBe(true)    // behind — stock
  })
})

describe('escapement — the tooth\'s tip round', () => {
  // A tooth that comes to a knife edge chips, and a chipped tip has spent the
  // landing. So the tip is ROUNDED — and the pallet faces are the loci of the
  // point it used to come to, so rounding it without carrying the round through
  // the construction would bed the tooth on a curve the escapement was never
  // drawn for. What is pinned here is that it IS carried through.

  const dist = (p: [number, number], line: [number, number][]) => {
    let best = Infinity
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1], [bx, by] = line[i]
      const dx = bx - ax, dy = by - ay
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
      best = Math.min(best, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]))
    }
    return best
  }

  it('stands each acting face exactly one round off the locus it is drawn from', () => {
    // THIS is what says the lock and the release are untouched. The tooth acts by
    // an arc of radius r whose centre traces the locus, so the face it bears on
    // is the curve every one of those arcs touches — the locus offset by r. Get
    // that offset wrong in either direction and nothing else here would notice:
    // the outline is a clean curve, the mesh still meshes, and the escapement
    // simply locks and releases at the wrong angles.
    //
    // Sampled off the locus polyline, so the tolerance carries its chords: the
    // dead arc's are 0.07 mm long and cut inside the true arc by a ten-thousandth.
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const draw of [0, 2]) {
        for (const side of ['entry', 'exit'] as const) {
          const spec = { ...BASE, escType, draw }
          const r = escapementDims(spec).tipRound
          const face = __escFaces(spec, side)
          const locus = __escLocus(spec, side)
          const n = __escLockPoints(spec, side)
          const fillet = escapementDims(spec).lockRound > 0 ? 8 : 0
          for (let i = 0; i < face.length; i++) {
            const d = dist(face[i], locus)
            // Never inside the tooth's own round, anywhere — including the fillet
            // on the locking corner, which only ever cuts material away.
            expect(d, `${escType} ${side} ${i}`).toBeGreaterThan(r - 1e-3)
            // And exactly one round off it on the two faces proper. The stretch
            // between them is the corner fillet, which stands further off.
            if (i < n - 1 || i > n + fillet) {
              expect(d, `${escType} ${side} ${i}`).toBeCloseTo(r, 3)
            }
          }
        }
      }
    }
  })

  it('rounds the tip to the radius it reports, tangent to both flanks', () => {
    // Tangent to both, or the round is a chamfer with two new corners on it — and
    // the outline shows a smooth tip either way at this scale. What a round that
    // is not tangent really does is cross the flank it should touch: the arc's
    // tail then stands 25 µm outside the back of the tooth, or (cut short at the
    // crossing instead) meets it at a 13° kink. Both were live, on wheels whose
    // outlines and mesh checks were perfectly clean — see `tipFit`.
    for (const wheelDia of [40, 100, 200]) {
      for (const toothDepth of [2, 6, 12]) {
        const spec = { ...BASE, wheelDia, toothDepth }
        const { tipRound: r, actingRadius: R } = escapementDims(spec)
        const ring = __escToothRing(spec)
        if (r === 0) {
          // A tooth that comes to a 1° point gets no round at all, and says so
          // by reporting none: the set-back would be a hundred radii, which is
          // most of the tooth. A 12 mm tooth on a 40 mm blank is the case, and it
          // is pathological for its own reasons — what matters is that it still
          // comes out as the wheel it always was, tips on the tip circle.
          expect(Math.max(...ring.map((p) => Math.hypot(p[0], p[1])))).toBeCloseTo(wheelDia / 2, 9)
          expect(R).toBeCloseTo(wheelDia / 2, 9)
          continue
        }
        // The crown, and the run of points either side of it that are the round.
        let k = 0
        for (let i = 0; i < ring.length; i++) {
          if (Math.hypot(...ring[i]) > Math.hypot(...ring[k])) k = i
        }
        const centre: [number, number] = [ring[k][0] * (R / (R + r)), ring[k][1] * (R / (R + r))]
        const onRound = (i: number) =>
          Math.abs(Math.hypot(ring[(i + ring.length) % ring.length][0] - centre[0],
                              ring[(i + ring.length) % ring.length][1] - centre[1]) - r) < 1e-6
        let lo = k, hi = k
        while (onRound(lo - 1)) lo--
        while (onRound(hi + 1)) hi++
        // Eight sampled steps and the crown spliced in where it is passed.
        expect(hi - lo + 1, `Ø${wheelDia} d${toothDepth}`).toBeGreaterThanOrEqual(8)
        // TANGENT, asked of the flanks themselves rather than of how sharply the
        // outline turns: a round spanning most of a half circle in eight steps
        // turns 22° at every one of its own samples, so no turn threshold can
        // tell a sampling step from a step left by a round that missed its
        // flank. At a tangency the flank runs square to the radius through it,
        // and that is exact whatever the sampling.
        const square = (t: [number, number], from: [number, number], tol: number, what: string) => {
          const d = [t[0] - from[0], t[1] - from[1]]
          const n = [t[0] - centre[0], t[1] - centre[1]]
          const cos = (d[0] * n[0] + d[1] * n[1]) / (Math.hypot(...d) * Math.hypot(...n))
          expect(Math.abs(cos), `Ø${wheelDia} d${toothDepth} ${what}`).toBeLessThan(tol)
        }
        const at = (i: number) => ring[(i + ring.length) % ring.length]
        // The LAND's tangency is exact: it is one straight chord, and the round
        // is inscribed against its own line.
        square(at(lo), at(lo - 1), 0.02, 'land tangency')
        // The BACK's carries the flank's own turn over the set-back. The corner
        // is built from the directions the flanks leave the APEX on, and the
        // tangency sits a third of a millimetre down from there, by which point a
        // flank drawn in polar terms has swung a little: 0.3° on the default
        // wheel, 2.4° on a 40 mm one with a 2 mm tooth. A kink that small on the
        // one surface of a tooth that nothing acts against is not worth another
        // solve; a round that had missed the flank outright would read 20° here.
        square(at(hi), at(hi + 1), 0.05, 'back tangency')
      }
    }
  })

  it('rounds the pallet\'s locking corner, and measures the landing from the round', () => {
    // The corner where the locking face turns into the impulse face is the one a
    // tooth climbs over on every beat, at the moment the pallet is deepest in it
    // — so it is rounded too. That costs dead face, because the round stands back
    // from where the corner was, and the landing is measured from where the round
    // STARTS: buy nothing back and the escapement quietly lands a sixth of a
    // millimetre shallower than `LANDING_DEPTH`, which is the margin every build
    // error is spent from.
    const d = escapementDims(BASE)
    expect(d.lockRound).toBeGreaterThan(0.1)
    expect(escapementDims({ ...BASE, escType: 'recoil' }).lockRound).toBe(0)

    for (const side of ['entry', 'exit'] as const) {
      const face = __escFaces(BASE, side)
      const n = __escLockPoints(BASE, side)
      // No sharp turn left at the corner — it used to be 56° at one vertex.
      let worst = 0
      for (let i = 1; i < face.length - 1; i++) {
        const u = [face[i][0] - face[i - 1][0], face[i][1] - face[i - 1][1]]
        const v = [face[i + 1][0] - face[i][0], face[i + 1][1] - face[i][1]]
        worst = Math.max(worst, Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])))
      }
      expect((worst * 180) / Math.PI, side).toBeLessThan(15)
      // And the round is the one reported, on a single centre.
      // And the round is the one reported. Three CONSECUTIVE points of it sit on
      // a circle of radius g, so the sagitta across the outer two gives g back —
      // the fillet is sampled at even steps, so the middle one is the midpoint.
      const [a, mid, b] = [face[n + 1], face[n + 2], face[n + 3]]
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1])
      const midChord = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const sag = Math.hypot(mid[0] - midChord[0], mid[1] - midChord[1])
      const radius = (chord * chord) / (8 * sag) + sag / 2
      expect(radius, side).toBeGreaterThan(d.lockRound * 0.9)
      expect(radius, side).toBeLessThan(d.lockRound * 1.1)
    }

    // The lock that seats the full landing is a fixed point: quote it, use it,
    // and the landing really is full. It was not, while the corner's round was
    // sized from the lock — the readout then said 2.01°, and at 2.01° the corner
    // was bigger and the landing short again.
    const quoted = escapementDims({ ...BASE, lock: 1 }).fullLandingLockDeg
    const fixed = escapementDims({ ...BASE, lock: quoted })
    expect(fixed.landingShort).toBe(false)
    // Within the slack, not exactly: the landing is MEASURED on the profile and
    // the two pallets do not land alike, so the worse of them lands a few
    // hundredths short of the millimetre asked for. What matters is that taking
    // the lock the warning quotes silences the warning.
    expect(Math.abs(fixed.dropLockDepth - LANDING_DEPTH)).toBeLessThan(0.1)
    expect(escapementDims({ ...BASE, lock: quoted - 0.5 }).landingShort).toBe(true)
  })
})

describe('escapement — the leading face', () => {
  it('is dead flat from the tip round to the root', () => {
    // This is the face a pallet's LOCKING face beds on, and it used to be three
    // pieces: a relieved tip land, a radial stretch below it, and a bow flaring
    // forward to the root. What they made was a DISHED face (Rick, 2026-09-17) —
    // 4.4° of kink where the land met the radial stretch, and against the land's
    // own line the surface stood 0.035 mm forward at a sixth of the depth and
    // 1.12 mm forward at the root. A dished face beds on its two ends, which
    // means the drive lands on the tip's round and on the root's flare instead of
    // along the face.
    //
    // Measured off the RAW ring: the emitted outline has been through the gullet
    // closing, which resamples it and would flatter this by collapsing the
    // straight run to one edge.
    for (const wheelDia of [40, 100, 200]) {
      for (const toothDepth of [2, 6, 12]) {
        for (const teeth of [15, 30, 60]) {
          const spec = { ...BASE, wheelDia, toothDepth, teeth }
          const { actingRadius: R, tipRound: r, wheelRootDia } = escapementDims(spec)
          const rRoot = wheelRootDia / 2
          const ring = __escToothRing(spec)
          let k = 0
          for (let i = 0; i < ring.length; i++) {
            if (Math.hypot(...ring[i]) > Math.hypot(...ring[k])) k = i
          }
          // Back down the leading face from the round's own tangency.
          const c: [number, number] = [ring[k][0] * (R / (R + r)), ring[k][1] * (R / (R + r))]
          const onRound = (i: number) => r > 0
            && Math.abs(Math.hypot(ring[i][0] - c[0], ring[i][1] - c[1]) - r) < 1e-6
          let lo = k
          while (onRound((lo - 1 + ring.length) % ring.length)) lo--
          const face: [number, number][] = []
          for (let i = lo; i > lo - 60; i--) {
            const p = ring[(i + ring.length) % ring.length]
            face.push(p)
            if (Math.hypot(...p) <= rRoot + 1e-9) break
          }
          expect(face.length, `Ø${wheelDia} d${toothDepth} ${teeth}t`).toBeGreaterThan(4)
          // Every point on the straight line between its ends, to the micron.
          const a = face[0], b = face[face.length - 1]
          const dx = b[0] - a[0], dy = b[1] - a[1]
          const len = Math.hypot(dx, dy)
          for (const p of face) {
            const off = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len
            expect(off, `Ø${wheelDia} d${toothDepth} ${teeth}t at r ${Math.hypot(...p).toFixed(2)}`)
              .toBeLessThan(0.002)
          }
        }
      }
    }
  })

  it('leans the whole face back, so it clears the impulse face at every depth', () => {
    // Flat is not enough on its own: the face has to lean AWAY from the space in
    // front of the tooth, because that space is where the pallet's impulse face
    // stands at the lock. One straight face relieved at the tip is relieved at
    // every depth below it — which the three-piece version was not, its radial
    // stretch giving the relief back as it went down.
    for (const side of ['entry', 'exit'] as const) {
      const ring = __escToothRing(BASE)
      const { actingRadius: R, tipRound: r } = escapementDims(BASE)
      let k = 0
      for (let i = 0; i < ring.length; i++) {
        if (Math.hypot(...ring[i]) > Math.hypot(...ring[k])) k = i
      }
      const c: [number, number] = [ring[k][0] * (R / (R + r)), ring[k][1] * (R / (R + r))]
      let lo = k
      while (Math.abs(Math.hypot(ring[lo - 1][0] - c[0], ring[lo - 1][1] - c[1]) - r) < 1e-6) lo--
      // Going down the face, every point is FURTHER round the wheel than the one
      // above it — increasing angle is behind the tooth, so that is leaning back.
      // Measured as a difference from the tangency and unwrapped, since the tooth
      // this lands on can sit anywhere, the branch cut at ±180° included.
      const base = Math.atan2(ring[lo][1], ring[lo][0])
      const off = (p: [number, number]) => {
        let v = Math.atan2(p[1], p[0]) - base
        while (v > Math.PI) v -= 2 * Math.PI
        while (v < -Math.PI) v += 2 * Math.PI
        return v
      }
      // Down the face only — past its foot the root land curves back round, and
      // the root land is not the face.
      const rRoot = escapementDims(BASE).wheelRootDia / 2
      let prev = 0, walked = 0
      for (let i = lo - 1; i > lo - 20; i--) {
        const p = ring[(i + ring.length) % ring.length]
        if (Math.hypot(p[0], p[1]) <= rRoot + 1e-9) break
        expect(off(p), side).toBeGreaterThan(prev)
        prev = off(p)
        walked++
      }
      expect(walked, side).toBeGreaterThan(6)
    }
  })
})

describe('escapement — the pallet tip', () => {
  it('leaves the tooth clear of the relieved back at release', () => {
    // The pallet comes to a point at the release corner — no tip land — so the
    // edge a tooth has to get past there is the relieved BACK, starting at the
    // corner itself. The pallet withdraws while the tooth runs on, so the two
    // part fast; this pins that they really do, because the binding check
    // cannot see it (grazing is not interference) and the outline shows only a
    // thin wedge.
    for (const spec of [BASE, { ...BASE, escType: 'recoil' as const }]) {
      const S = { ...spec, clockwise: true }
      const L = escapementDims(S).centreDistance
      const R = S.wheelDia / 2
      const wheel = generateEscapementParts(S).find((p) => p.key === 'wheel')!.d
        .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][]
      const tips = wheel.filter((p) => Math.hypot(p[0], p[1]) > R - 0.02)
      const rot = (p: [number, number], a: number): [number, number] =>
        [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]

      for (const side of ['entry', 'exit'] as const) {
        const [c0, c1] = __escBackEdge(S, side)
        let closest = Infinity
        for (let i = 0; i < 200; i++) {
          const pose = escapementPose(S, i / 200)
          const phi = (pose.anchorDeg * Math.PI) / 180
          const adv = (-pose.wheelDeg * Math.PI) / 180
          const toWheel = (p: [number, number]) => {
            const q = rot(p, phi)
            return rot([q[0], q[1] + L], adv)
          }
          const a = toWheel(c0), b = toWheel(c1)
          // Past the working corner itself — the tooth is meant to touch there.
          const s0: [number, number] = [a[0] + (b[0] - a[0]) * 0.25, a[1] + (b[1] - a[1]) * 0.25]
          const dx = b[0] - s0[0], dy = b[1] - s0[1]
          for (const t of tips) {
            const u = Math.max(0, Math.min(1, ((t[0] - s0[0]) * dx + (t[1] - s0[1]) * dy) / (dx * dx + dy * dy || 1)))
            closest = Math.min(closest, Math.hypot(s0[0] + u * dx - t[0], s0[1] + u * dy - t[1]))
          }
        }
        expect(closest).toBeGreaterThan(0.2)
      }
    }
  })
})

describe('escapement — the tip circle', () => {
  it('centres each tooth tip\'s ROUND on the circle the pallets were laid out for', () => {
    // `wheelDia` is the circle the tooth tips ACT on — where the centres of their
    // rounds sit, which is what the arbor was placed for and what the centre
    // distance is a question about. The wheel's material therefore stands exactly
    // one round proud of it: the crown of each round is `tipRound` outside the
    // circle, and a caliper across the teeth reads `wheelDia` + 2·`tipRound`.
    //
    // Pinning the material rather than the acting circle on purpose — the acting
    // circle is arithmetic, the material is what a tooth is, and if a round ever
    // came out sitting inside the tip circle instead of on it the pallets would
    // be laid out for a tooth that does not reach them.
    const tipR = (spec: EscapementSpec) => {
      const pts = generateEscapementParts(spec).find((p) => p.key === 'wheel')!.d
        .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite))
      return Math.max(...pts.map((p) => Math.hypot(p[0] - spec.cx, p[1] - spec.cy)))
    }
    // To 0.03 mm, not to six places: the gullet closing is a clipper offset pass
    // over the whole outline, and its resampling error scales with the radius —
    // which is millimetres now rather than the 0.6 mm it used to be, so a tip
    // moves by about twelve microns instead of two. A closing cannot shorten a
    // convex corner in theory; this is the sampling, and tightening the test
    // would only be pinning that.
    for (const wheelDia of [60, 100, 180]) {
      const spec = { ...BASE, wheelDia }
      const d = escapementDims(spec)
      expect(d.actingRadius).toBeCloseTo(wheelDia / 2, 9)
      expect(d.tipRound).toBeGreaterThan(0.1)
      expect(Math.abs(tipR(spec) - (wheelDia / 2 + d.tipRound))).toBeLessThan(0.03)
    }
  })

  it('leaves the lock the swing\'s own depth, less what the corner rounds cost', () => {
    // The swing buries the pallet by ρ·lock, and the tooth can rest on all of it
    // but the stretch at the corner end that the two rounds take: the tip round's
    // offset trims the corner back and the round ON the corner takes more, and
    // `lockDepth` is the dead face actually left between the two. Reported that
    // way rather than as the raw ρ·lock because it is the number a tooth has to
    // land in, and the raw one silently over-states it by a third of a millimetre.
    const d = escapementDims(BASE)
    const rho = d.palletRadius
    const raw = (rho * (BASE.lock * Math.PI)) / 180
    expect(d.lockDepth).toBeLessThan(raw)
    expect(d.lockDepth).toBeGreaterThan(raw - 2 * (d.tipRound + 0.3))
    expect(d.noLock).toBe(false)
    // With no round at all it would be the whole of it — which is what the
    // measured shortfall has to be made of, so check it against the geometry
    // rather than against a number typed in here.
    // Measured on BOTH pallets and compared against the worse, because that is
    // what the readout reports: the two faces are not mirror images, so the same
    // lock angle is a different LENGTH on each (51.4 from the arbor on the entry,
    // 48.3 on the exit) and quoting the better of them would overstate the lock a
    // tooth can actually rest in.
    let worst = Infinity
    for (const side of ['entry', 'exit'] as const) {
      const face = __escFaces(BASE, side)
      const n = __escLockPoints(BASE, side)
      let len = 0
      for (let i = 1; i < n; i++) len += Math.hypot(face[i][0] - face[i - 1][0], face[i][1] - face[i - 1][1])
      worst = Math.min(worst, len)
    }
    expect(d.lockDepth).toBeCloseTo(worst, 6)
    // And nothing to lock on at all is still reported, now only when the lock
    // itself is gone.
    expect(escapementDims({ ...BASE, lock: 0 }).noLock).toBe(true)
  })
})

describe('escapement — the tooth depth', () => {
  it('cuts a tooth as deep as it was asked for, at every depth', () => {
    // `toothDepth` sets the root circle, and for half a day the GULLET FILL then
    // overruled it: the fill was sized by what it may not bury above the pallet's
    // floor, which bounds its top and says nothing about its bottom, and a disc
    // too big to descend into a deep narrow gullet jams high and solidifies
    // everything under it. Deepening the tooth made the gullet deeper AND
    // narrower, so a bigger disc jammed higher still — past about 10 mm the floor
    // rose faster than the root fell, and 24 mm of tooth depth emitted a 1.26 mm
    // tooth. The wheel came out nearly a circle, which is how it was noticed; no
    // clearance, binding or fill-position check could see it, because none of
    // them asked this.
    for (const toothDepth of [2, 4, 6, 8, 10, 14, 18, 24]) {
      const spec = { ...BASE, toothDepth }
      const pts = generateEscapementParts(spec).find((p) => p.key === 'wheel')!.d
        .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][]
      const rs = pts.map((p) => Math.hypot(p[0] - spec.cx, p[1] - spec.cy))
      const floor = Math.min(...rs)
      const root = escapementDims(spec).wheelRootDia / 2
      // Measured off the EMITTED outline, so it sees the gullet closing. To
      // 0.05 mm: the closing is a clipper pass and resamples everything it
      // touches.
      expect(Math.abs(floor - root), `toothDepth ${toothDepth}`).toBeLessThan(0.05)
      // Root to CROWN, which is the tooth there is in the wood. Not from the tip
      // circle: that is where the tips' rounds are centred, so the crown stands a
      // round outside it, and a depth measured from it would be short by exactly
      // that — which is the shape of mistake this test exists to catch.
      expect(Math.abs((Math.max(...rs) - floor) - toothDepth), `toothDepth ${toothDepth}`).toBeLessThan(0.05)
    }
  })
})

describe('escapement — bowed tooth flanks', () => {
  it('leaves no step where a flank meets the root land', () => {
    // The bow is ANGULAR, so a bowed foot stays ON the root circle and the land
    // simply runs between the feet it is given. Displace the foot off that circle
    // instead — which a bow taken perpendicular to the flank does — and the land
    // still starts where the foot used to be, leaving a visible step at every
    // tooth that no dimension catches.
    //
    // The bow is fixed at `TOOTH_BOW` now rather than asked for, so this is swept
    // over the WHEEL instead: the invariant has to hold at any size.
    //
    // Tested on the RAW ring: the emitted outline has been through the gullet
    // closing, which resamples it and collapses straight runs, so a long edge
    // there means nothing.
    for (const wheelDia of [40, 100, 200]) {
      const spec = { ...BASE, wheelDia }
      const rRoot = escapementDims(spec).wheelRootDia / 2
      const ring = __escToothRing(spec)
      // The invariant itself: the profile never leaves the band between root and
      // tip, and it REACHES the root circle exactly. A bow taken perpendicular to
      // the flank pushes the foot off that circle, and then the land — which is
      // still drawn on it — no longer meets the flank.
      const rs = ring.map((p) => Math.hypot(p[0], p[1]))
      expect(Math.min(...rs)).toBeCloseTo(rRoot, 9)
      // And reaches the CROWN of the tip round exactly — one round outside the
      // tip circle the pallets are laid out on. Exactly, because the apex the
      // flanks are drawn to is solved for it: the round inscribed in the corner
      // up there has to come back down to precisely this circle, or the wheel is
      // not the size it was asked to be.
      expect(Math.max(...rs)).toBeCloseTo(wheelDia / 2 + escapementDims(spec).tipRound, 9)
    }
  })
})

describe('escapement — the deep-lock corner relief', () => {
  // The exit pallet's face runs into the side of its own arm, at a right angle
  // (AP ⟂ OP), and the lock plus its landing allowance is barely 2 mm of face.
  // So whatever radius the cutter leaves in that inside corner lands ON the
  // working face unless the drawing gives it somewhere else to go — which is
  // what `lockRelief` cuts. The question is not what the outline looks like but
  // whether a real cutter can reach the whole face, so that is what is asked
  // here: roll the bit down the face and see if anything stops it.
  const BIT = 3.175

  const outline = (spec: EscapementSpec): [number, number][] =>
    (generateEscapementParts(spec).find((p) => p.key === 'anchor')!.d
      .match(/[MLAC][^MLACZQ]*/g) || [])
      .map((c) => c.match(/-?\d+(\.\d+)?/g)!)
      .map((v) => [Number(v[v.length - 2]), Number(v[v.length - 1])] as [number, number])

  /** How far the bit can be pushed onto each point of the face before it fouls
   *  the anchor — negative is how deep the anchor stands in its way. */
  const reach = (spec: EscapementSpec, side: 'entry' | 'exit'): number => {
    const R = spec.wheelDia / 2
    const dm = escapementDims(spec)
    const L = dm.centreDistance
    const beta = (dm.span * 2 * Math.PI) / spec.teeth
    const yA = anchorOffset(spec)
    const mir = spec.clockwise ? 1 : -1
    const sgn = side === 'entry' ? -1 : 1
    // The stock lies on `m`, so the cutter comes at the face from the other side.
    const P: [number, number] = [sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2) - L]
    const un = Math.hypot(P[0], P[1])
    const m: [number, number] = side === 'entry' ? [-P[0] / un, -P[1] / un] : [P[0] / un, P[1] / un]
    const poly = outline(spec)

    let worst = Infinity
    const face = __escFaces(spec, side)
    for (let k = 0; k < face.length; k++) {
      const p = face[k]
      // Bit rolled along the face: tangent to it, on the side the tooth is. The
      // offset is the face's OWN normal — the impulse face is nowhere near
      // perpendicular to the arm, so `m` is not it.
      const a = face[Math.max(0, k - 1)], b = face[Math.min(face.length - 1, k + 1)]
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      const nx = -(b[1] - a[1]) / tl, ny = (b[0] - a[0]) / tl
      const sg = nx * m[0] + ny * m[1] > 0 ? -1 : 1
      const c: [number, number] = [
        spec.cx + mir * (p[0] + sg * nx * BIT / 2), spec.cy + (p[1] + sg * ny * BIT / 2) + yA,
      ]
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, ay] = poly[j], [bx, by] = poly[i]
        const dx = bx - ax, dy = by - ay
        const t = Math.max(0, Math.min(1, ((c[0] - ax) * dx + (c[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
        worst = Math.min(worst, Math.hypot(ax + t * dx - c[0], ay + t * dy - c[1]) - BIT / 2)
      }
    }
    return worst
  }

  it('lets a 1/8" bit reach every point of both acting faces', () => {
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const clockwise of [false, true]) {
        for (const armWidth of [4, 8, 14]) {
        for (const side of ['entry', 'exit'] as const) {
          // Zero is the bit resting exactly on the face, which is what cutting
          // it means; under that is the anchor standing in its way. A few
          // hundredths are left and are not worth chasing: a bit cannot cut the
          // kink where the lock face meets the impulse face sharp either, and
          // the nib's own outward edge leaves the face's line by 3° past the
          // deep end. Both are rounded corners on the finished pallet, not a
          // lump on an acting face — which at 1.3 mm is what this used to be.
          expect(reach({ ...BASE, escType, clockwise, armWidth }, side)).toBeGreaterThan(-0.06)
        }
        }
      }
    }
  })

  it('stands the deep-lock corner clear of the end of the face', () => {
    // The corner is moved AWAY FROM THE WHEEL, along the face's own line, until
    // there is a whole fillet's set-back between it and the last of the face.
    // Rounding it where it sits would take the set-back out of the lock.
    expect(__escLockCorner(BASE, 'entry')).toBeNull()
    for (const escType of ['deadbeat', 'recoil'] as const) {
      const spec = { ...BASE, escType }
      const corner = __escLockCorner(spec, 'exit')!
      const deep = __escFaces(spec, 'exit')[0]
      expect(corner.taper).toBeGreaterThan(0)
      // Measured along the face's own line, which is where the corner slides.
      expect(Math.hypot(corner.at[0] - deep[0], corner.at[1] - deep[1]))
        .toBeGreaterThan(BIT / 2)
    }
  })

  it('rounds the corner the pallet\'s back makes with its arm', () => {
    // The other inside corner, and the other one no cutter cuts sharp — but
    // nothing acts on the back of a pallet and there is room where it stands,
    // so it is rounded in place. It is the entry pallet that has one: the exit
    // nib's back runs out through its arm's OUTER edge and is cut off there.
    expect(__escBackCorner(BASE, 'exit')).toBeNull()
    for (const escType of ['deadbeat', 'recoil'] as const) {
      expect(__escBackCorner({ ...BASE, escType }, 'entry')).not.toBeNull()
    }
  })

  it('leaves no sharp node at either corner it rounds', () => {
    // The failure mode of picking corners by coordinate is silence: a target
    // that misses rounds nothing and the outline comes out exactly as sharp as
    // it went in. A treated corner is REPLACED by its two tangent points, so
    // the corner's own position is what must no longer be a node.
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const clockwise of [false, true]) {
        const spec = { ...BASE, escType, clockwise }
        const mir = clockwise ? 1 : -1
        const yA = anchorOffset(spec)
        const poly = outline(spec)
        for (const side of ['entry', 'exit'] as const) {
          for (const raw of [__escLockCorner(spec, side)?.at, __escBackCorner(spec, side)]) {
            if (!raw) continue
            const at = [spec.cx + mir * raw[0], spec.cy + raw[1] + yA]
            const near = Math.min(...poly.map((q) => Math.hypot(q[0] - at[0], q[1] - at[1])))
            expect(near).toBeGreaterThan(0.4)
          }
        }
      }
    }
  })

  it('takes the set-back off the arm at the pallet, not at the hub', () => {
    // An arm carries its bending at the hub; the pallet end is where it can be
    // spared. And the flank it comes off is the WHEEL side, so the taper can
    // only ever open the running clearance.
    const corner = __escLockCorner(BASE, 'exit')!
    expect(corner.taper).toBeLessThan(BASE.armWidth / 2)
  })
})

describe('escapement — the drop lock', () => {
  // A tooth arrives by FALLING, and what it falls onto decides whether the
  // escapement is a deadbeat or a thing that trips through every beat. The bare
  // loci give each pallet an impulse beginning at the very anchor angle at which
  // the other releases, so the tooth meets the corner between the two faces —
  // and the running clearance then carries it past that corner onto a face lying
  // ~53° off the wheel's radius, where it slides instead of locking. Nothing in
  // the outline, in the readouts or in the binding check can see it: the pair
  // meshes perfectly and never touches. Only asking WHERE the tooth lands does.

  const rot = (p: [number, number], a: number): [number, number] =>
    [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]
  const rad = (d: number) => (d * Math.PI) / 180

  /** Where a tooth first comes to rest on one pallet, as a fractional index into
   *  that pallet's acting profile. Driven by the same pose the animation runs. */
  const landing = (spec: EscapementSpec, side: 'entry' | 'exit') => {
    const L = escapementDims(spec).centreDistance
    const mir = spec.clockwise ? 1 : -1
    const face = __escFaces(spec, side)
    const wheel = generateEscapementParts(spec).find((p) => p.key === 'wheel')!.d
      .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][]
    // WHAT ACTS IS THE CENTRE OF EACH TOOTH TIP'S ROUND, so that is what is
    // tracked: the crown of a round is radially outside its own centre by the
    // radius, so a crown taken off the emitted outline gives the centre exactly.
    // Chasing the crowns themselves instead measures the landing from whichever
    // sample of the round happens to be nearest the face — up to 0.05 mm of arc
    // away from the tangency, which is the whole tolerance this test has.
    const { actingRadius, tipRound } = escapementDims(spec)
    const pitchA = (2 * Math.PI) / Math.round(spec.teeth)
    const near = wheel.filter((p) => Math.hypot(p[0], p[1]) > actingRadius + tipRound - 0.05)
    // ONE POINT PER TOOTH, the highest: the centre is radially under the CROWN
    // and under nothing else, so a sample a few degrees round the arc from it
    // reconstructs a centre 0.06 mm out — which reads as the tooth standing
    // inside the face it is resting on.
    const tips = near
      .filter((p) => !near.some((q) => {
        let da = Math.atan2(q[1], q[0]) - Math.atan2(p[1], p[0])
        while (da > Math.PI) da -= 2 * Math.PI
        while (da < -Math.PI) da += 2 * Math.PI
        return Math.abs(da) < pitchA / 3 && Math.hypot(q[0], q[1]) > Math.hypot(p[0], p[1])
      }))
      .map((p) => {
        const k = actingRadius / Math.hypot(p[0], p[1])
        return [p[0] * k, p[1] * k] as [number, number]
      })
    // Into the anchor's own frame, where the faces live — and back out of the
    // mirror the emitted parts were placed through.
    const toAnchor = (w: [number, number], thW: number, thA: number): [number, number] => {
      const world = rot(w, thW)
      const q = rot([world[0], world[1] - L], -thA)
      return [mir * q[0], q[1]]
    }
    // The landing is the instant AFTER the drop, and the drop is the one moment
    // the wheel angle jumps — so find the jump rather than guess a phase. Asking
    // for the closest approach over the whole cycle would answer nothing: the
    // tooth is ON the face for most of a beat, at a distance of zero.
    const N = 4000
    const w = (i: number) => escapementPose(spec, i / N).wheelDeg
    let best = { d: Infinity, at: 0 }
    for (let i = 1; i <= N; i++) {
      if (Math.abs(w(i) - w(i - 1)) < spec.drop * 0.5) continue
      const pose = escapementPose(spec, i / N)
      for (const t of tips) {
        const q = toAnchor(t, rad(pose.wheelDeg), rad(pose.anchorDeg))
        for (let k = 1; k < face.length; k++) {
          const [ax, ay] = face[k - 1], [bx, by] = face[k]
          const dx = bx - ax, dy = by - ay
          const u = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
          const dd = Math.hypot(ax + u * dx - q[0], ay + u * dy - q[1])
          if (dd < best.d) best = { d: dd, at: k - 1 + u }
        }
      }
    }
    return best
  }

  it('lands the tooth on dead face, clear of the corner it turns into impulse at', () => {
    for (const clockwise of [false, true]) {
      for (const clearance of [0, 0.3, 0.6]) {
        for (const side of ['entry', 'exit'] as const) {
          const spec = { ...BASE, clockwise, clearance }
          const hit = landing(spec, side)
          const face = __escFaces(spec, side)
          const nLock = __escLockPoints(spec, side)   // face[nLock - 1] ends the dead face
          // The round comes to rest ONE RADIUS off the face, which is what being
          // tangent to it means. To a tenth of a millimetre, because the pose
          // driving this does not model the DRAW CREEP: a drawing face lets the
          // wheel creep forward a few hundredths of a degree to stay in touch as
          // the lock deepens, and `escapementPose` holds the wheel dead through
          // the lock instead. The gap is that creep, and it closes as the anchor
          // swings on. Measured the other way round it was 0.077 mm of
          // interference before the corner trim, which is how it was found.
          expect(Math.abs(hit.d - escapementDims(spec).tipRound)).toBeLessThan(0.1)
          // On the locking arc, not on the impulse face past it.
          expect(hit.at).toBeLessThan(nLock - 1)
          // And clear of the corner by real dead face, measured as a length —
          // this is the whole of the fix, and it is what the clearance eats.
          const k = Math.floor(hit.at)
          const p: [number, number] = [
            face[k][0] + (face[k + 1][0] - face[k][0]) * (hit.at - k),
            face[k][1] + (face[k + 1][1] - face[k][1]) * (hit.at - k),
          ]
          const B = face[nLock - 1]
          const under = Math.hypot(p[0] - B[0], p[1] - B[1])
          expect(under).toBeGreaterThan(0.1)
          // And the panel's figure is the CONSERVATIVE one: it reports the worse
          // of the two pallets, so it never overstates what this one has under
          // it. The gap between them is the two faces' own difference — they sit
          // at 51.4 and 48.3 from the arbor and are not mirror images — which is
          // why this is a floor and not an equality.
          const said = escapementDims(spec).dropLockDepth
          expect(under).toBeGreaterThan(said - 0.02)
          expect(under).toBeLessThan(said + 0.12)
          // With run to lock still left above it — all of the lock as drop lock
          // and the supplementary arc drives the tooth off the deep end.
          expect(hit.at).toBeGreaterThan(0.5)
        }
      }
    }
  })

  it('never doubles the acting profile back on itself', () => {
    // The tempting way to give the tooth somewhere dead to land is to run the
    // dead arc on PAST the start of impulse. It cannot work — past that point is
    // the impulse face's own ground, so the extension retraces it, and the
    // boolean drops the zero-width spur without a word. What is left is the bare
    // corner it was meant to cover, one twentieth of the face shorter.
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const side of ['entry', 'exit'] as const) {
        const face = __escFaces({ ...BASE, escType }, side)
        for (let i = 1; i < face.length - 1; i++) {
          let t = Math.atan2(face[i + 1][1] - face[i][1], face[i + 1][0] - face[i][0])
            - Math.atan2(face[i][1] - face[i - 1][1], face[i][0] - face[i - 1][0])
          while (t > Math.PI) t -= 2 * Math.PI
          while (t < -Math.PI) t += 2 * Math.PI
          expect(Math.abs((t * 180) / Math.PI)).toBeLessThan(150)
        }
        // And no duplicated vertex where the lock arc hands over to the impulse.
        for (let i = 1; i < face.length; i++) {
          expect(Math.hypot(face[i][0] - face[i - 1][0], face[i][1] - face[i - 1][1]))
            .toBeGreaterThan(1e-9)
        }
      }
    }
  })

  it('spends the drop lock OUT of the lock, and reports both', () => {
    // The tooth lands on part of the lock and the supplementary arc runs it to
    // the rest. Asking for more lock buys more of both until the drop lock has
    // all the dead face it wants, which is a fixed length past the clearance.
    for (const lock of [1, 1.5, 3, 6]) {
      const d = escapementDims({ ...BASE, lock })
      expect(d.dropLockDepth).toBeGreaterThan(0)
      expect(d.dropLockDepth).toBeLessThanOrEqual(d.lockDepth + 1e-9)
      expect(d.noLock).toBe(false)
    }
    // Too little lock to seat a landing in, and it says so — the tooth would
    // arrive on the impulse face. This is stricter than the old test (which only
    // caught the clearance eating the lock ENTIRELY) and it has to be: a tooth
    // landing on the impulse face is exactly as broken and looks exactly as fine.
    expect(escapementDims({ ...BASE, lock: 0.5 }).noLock).toBe(true)
  })

  it('deepens the landing with the lock until it reaches LANDING_DEPTH, and says when it falls short', () => {
    // The landing is the margin every build error is spent from. It used to be
    // capped at the run margin whatever the lock, so asking for more lock only
    // lengthened the run — and a wooden clock ran through on 0.5 mm of it.
    const full = escapementDims({ ...BASE, lock: 3 })
    expect(Math.abs(full.dropLockDepth - LANDING_DEPTH)).toBeLessThan(0.1)
    expect(full.landingShort).toBe(false)
    // Short of it the run keeps its half millimetre and the landing gets the rest,
    // so it is shallow rather than absent — flagged, not fatal.
    const short = escapementDims({ ...BASE, lock: 1.5 })
    expect(short.noLock).toBe(false)
    expect(short.landingShort).toBe(true)
    expect(short.dropLockDepth).toBeLessThan(LANDING_DEPTH)
    // The run margin, as delivered: asked for as 0.5 mm at the nominal pallet
    // radius and measured on the worse pallet's own face, which sits nearer the
    // arbor than that — so it lands a couple of percent under. Exactly 0.5 would
    // mean the readout was quoting the request back rather than measuring.
    expect(Math.abs((short.lockDepth - short.dropLockDepth) - 0.5)).toBeLessThan(0.03)
    // And the lock the warning quotes is the one that fixes it.
    const fixed = escapementDims({ ...BASE, lock: short.fullLandingLockDeg })
    expect(fixed.landingShort).toBe(false)
    expect(Math.abs(fixed.dropLockDepth - LANDING_DEPTH)).toBeLessThan(0.1)
  })

  it('gives a recoil anchor none of it', () => {
    // A recoil has no dead face and is not supposed to: its tooth lands on the
    // impulse face and drives the wheel back, which is what a recoil escapement
    // IS. So the embrace is left alone and its faces sit where the bare loci put
    // them, whatever the lock is asked to be.
    expect(escapementDims({ ...BASE, escType: 'recoil' }).dropLockDepth).toBe(0)
    for (const side of ['entry', 'exit'] as const) {
      const a = __escFaces({ ...BASE, escType: 'recoil', lock: 0 }, side)
      const b = __escFaces({ ...BASE, escType: 'recoil', lock: 3 }, side)
      for (let i = 0; i < a.length; i++) {
        expect(a[i][0]).toBeCloseTo(b[i][0], 12)
        expect(a[i][1]).toBeCloseTo(b[i][1], 12)
      }
    }
  })

  it('still gives up exactly half a tooth per beat', () => {
    // The embrace shifts each pallet's impulse window off the anchor's neutral,
    // in opposite senses, so the handover arithmetic in `escapementPose` had to
    // move with it. If it did not, the wheel loses or gains on every beat.
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const clockwise of [false, true]) {
        const spec = { ...BASE, escType, clockwise }
        const w = (p: number) => escapementPose(spec, p).wheelDeg
        const halfTooth = (clockwise ? -1 : 1) * 180 / BASE.teeth
        expect(w(0.5) - w(0)).toBeCloseTo(halfTooth, 9)
        expect(w(1) - w(0.5)).toBeCloseTo(halfTooth, 9)
        expect(w(3) - w(2)).toBeCloseTo(2 * halfTooth, 9)
      }
    }
  })
})

describe('escapement — the wedge\'s leading edge', () => {
  // Past the deep end of the acting face the pallet carries on into the arm, and
  // that last stretch used to leave along the WHEEL'S RADIAL. The two directions
  // agree only at the tangency point the whole construction is built on, and the
  // deep lock is a lock's worth of arc past it — 6° by the far end of the entry
  // pallet, which on a 5 mm run puts the top of the arm 0.6 mm off the line the
  // face was on. It reads as the pallet swinging away from the arbor at exactly
  // the point the face ends, with nothing behind it.
  it('carries the locking face straight on into the arm, with no break at its end', () => {
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const clockwise of [false, true]) {
        for (const side of ['entry', 'exit'] as const) {
          const spec = { ...BASE, escType, clockwise }
          const mir = clockwise ? 1 : -1
          const yA = anchorOffset(spec)
          const place = (p: [number, number]): [number, number] =>
            [spec.cx + mir * p[0], spec.cy + p[1] + yA]
          const face = __escFaces(spec, side)
          // The deep-lock end and the direction the face is going when it gets
          // there — both in placed coordinates, since that is where the outline
          // is and the mirror reverses the sense of x.
          const end = place(face[0]), prev = place(face[1])
          const len = Math.hypot(end[0] - prev[0], end[1] - prev[1])
          const dir: [number, number] = [(end[0] - prev[0]) / len, (end[1] - prev[1]) / len]

          const poly = (generateEscapementParts(spec).find((p) => p.key === 'anchor')!.d
            .match(/[MLAC][^MLACZQ]*/g) || [])
            .map((c) => c.match(/-?\d+(\.\d+)?/g)!)
            .map((v) => [Number(v[v.length - 2]), Number(v[v.length - 1])] as [number, number])

          // A millimetre on along the face's own line must still be ON the
          // outline. Off the wheel's radial instead it is a tenth of a
          // millimetre clear of it, and the deep-lock fillet has not started
          // that soon on either pallet.
          const probe: [number, number] = [end[0] + dir[0], end[1] + dir[1]]
          let best = Infinity
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [ax, ay] = poly[j], [bx, by] = poly[i]
            const dx = bx - ax, dy = by - ay
            const u = Math.max(0, Math.min(1, ((probe[0] - ax) * dx + (probe[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
            best = Math.min(best, Math.hypot(ax + u * dx - probe[0], ay + u * dy - probe[1]))
          }
          expect(best).toBeLessThan(0.03)
        }
      }
    }
  })
})
