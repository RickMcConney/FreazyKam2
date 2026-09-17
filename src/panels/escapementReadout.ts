// The escapement's readout, as DATA rather than as markup.
//
// It had two copies — one in ShapePanel, one in PropertiesPanel — worded
// slightly differently and going out of step every time the geometry moved. It
// now has three consumers (those two plus the info popup), which is one more than
// a duplicated block survives, so the lines are built once here and rendered by
// whoever wants them.
//
// Each line carries a TONE, and that is what lets the panels shrink to a single
// button: the button takes the colour of the worst line, so the status is visible
// without the text, and the text lives in a window big enough to read it.

import { escapementDims, escapementEnergy, LANDING_DEPTH, type EscapementSpec } from '../shapes/escapementGenerator'
import type { ReadoutLine, Tone } from './readout'
import { hubGrownWhy } from '../shapes/spokedWheel'

// Re-exported so the escapement's three consumers keep one import.
export { worstTone, type Tone, type ReadoutLine } from './readout'

/**
 * Everything the panels say about an escapement, in reading order: what it is,
 * then what is wrong with it.
 *
 * `len` formats a length in the user's units — the caller's, because the two
 * panels format to different precisions and this is not the place to decide that.
 */
export function escapementReadout(spec: EscapementSpec, len: (mm: number) => string): ReadoutLine[] {
  const d = escapementDims(spec)
  const dead = spec.escType === 'deadbeat'
  const out: ReadoutLine[] = []
  const say = (text: string, tone: Tone = 'plain') => out.push({ text, tone })

  // The span is derived from the tooth count, so it is a readout now — and worth
  // one, since it fixes the arbor spacing and the whole shape of the anchor.
  say(`Pallets span ${d.span} teeth`)
  // The hole spacing, named as such. It used to share a line with the PALLET
  // RADIUS — "arbors X apart · pallets Y from the arbor" — which is two lengths
  // and three mentions of an arbor, and the two are often close in value: at the
  // default span β is 90°, so ρ = R·tan45 = R exactly and the pallet radius reads
  // like a repeat of a number already on screen. The pallet radius is gone; this
  // is the one a plate is actually laid out from. `escapementDims` still reports
  // it for the harnesses, which measure with it.
  say(`Wheel centre to anchor arbor ${len(d.centreDistance)}`)
  // NOTHING HERE ECHOES AN INPUT. A readout earns its space by saying what the
  // form cannot: the beat and the wheel's share of the impulse were arithmetic on
  // two fields already on screen, and lift / lock / recoil arc were the fields
  // themselves. `noImpulse` still quotes the beat, which is the one moment that
  // budget is worth seeing — when drop has eaten all of it.
  //
  // The inputs a line does still name are named as the REFERENCE something
  // derived is being measured against (the dive against the tooth depth, the
  // half swing against the lift), which is the opposite of echoing them.
  //
  // Spelt out, or the next question is why half of a 3° lift is not the 1.79°:
  // the drop lock has to be picked before the impulse can start.
  say(`Pendulum must swing past ${d.minHalfSwingDeg.toFixed(2)}° each way — half the lift, plus ${(d.minHalfSwingDeg - spec.lift / 2).toFixed(2)}° to unlock`)
  // The IMPULSE part alone. `faceWidth` is the whole acting face — locking and
  // impulse are one curve with a corner in it — and printing that as "impulse
  // faces" put 4.61 mm on screen next to a 0.56 mm locking face, 4.61 being the
  // two of them added up.
  say(`Impulse face ${len(d.impulseWidth)} long at ${d.impulseAngleDeg.toFixed(0)}°`)
  say(`Pallets dive ${len(d.palletDive)} past the tips, into ${len(spec.toothDepth)} of tooth`)
  // The drop lock first: it is what a tooth actually lands on, and the one that
  // decides whether the escapement is dead at all.
  //
  // IT SAYS WHICH WAY IT IS MEASURED, and that is not padding. "Lands on 0.07 mm
  // of lock" was the wording, and it reads as a PENETRATION — which is the line
  // right above it (the pallets dive 2 mm past the tips), so the two looked like
  // the same quantity disagreeing by thirty times (Rick, 2026-09-17: "the tooth
  // overlaps the pallet by 2 mm, how can the distance to the corner be 0.07").
  // They are at right angles to each other: the dive is radial, into the tooth
  // SPACE, while the landing is along the locking FACE from the corner the
  // impulse starts at — and at 1° of lock that whole face is half a millimetre.
  //
  // IT ALSO STATES THE LOCKING FACE'S OWN LENGTH, beside the impulse face's on
  // the line above, because the two are not told apart by looking: the pallet has
  // ONE acting face of five or six millimetres with a corner in it, and the
  // locking part is only the last half-millimetre of it at one end (the far end
  // from the arbor on the entry, the near end on the exit — they are not mirror
  // images). Read the long stretch as the locking face and every number here
  // looks an order of magnitude wrong.
  say(dead
    ? `Locking face ${len(d.lockDepth)} long — tooth lands ${len(d.dropLockDepth)} from its corner, running to the far end at full swing`
    : `Recoil face ${len(d.lockDepth)} long`)
  // Where the tooth leaves the gullet, not at the root circle — the gullet is
  // filled well above that, so a thickness taken there is a thickness of solid
  // wheel. The radius rides along as the tightest inside corner on the part.
  say(`Tooth ${len(d.toothBase)} thick where it leaves a ${len(d.gulletRadius)} gullet — ${len(2 * d.gulletRadius)} cutter max`)
  // The tip round, and the one number it changes that nothing else on screen
  // would explain: the wheel does not measure `wheelDia` over its teeth any
  // more. That circle is where the tips ACT — the round's centres lie on it, and
  // it is what the centre distance above was laid out from — while the material
  // stands one round outside it. Worth a line precisely because a caliper says
  // otherwise.
  if (d.tipRound > 0) {
    say(`Tips rounded ${len(d.tipRound)}, acting on the ${len(2 * d.actingRadius)} circle — ${len(2 * (d.actingRadius + d.tipRound))} over the teeth`)
  }
  if (!dead) say(`Recoils ${d.recoilRatio.toFixed(2)}° of wheel per 1° of overswing`)
  // THE ENERGY BUDGET, which is the one line here that answers a question the
  // geometry cannot be read for: turn any knob and this says whether the pendulum
  // is getting more back or less. The drive spends the same every beat — half a
  // tooth under its own torque — so the three shares are what is worth seeing,
  // and the drop being a third of it at the defaults is the fact nobody expects.
  // Percentages rather than energy: the drive's torque is not ours to know, and
  // the comparison between two sets of parameters is what is being asked for.
  const e = escapementEnergy(spec)
  const pc = (v: number) => `${Math.round((v / Math.max(1e-9, e.driveWork)) * 100)}%`
  // "µ 0.2" was the first wording and it read as MICRO — in a line already full of
  // millimetres, the symbol is a unit prefix and not a coefficient (Rick asked
  // what "micro 0.2" meant, which is the whole answer). Spelt out instead: the
  // figure has to stay, because the percentages scale with it and it is an
  // assumption rather than a measurement, but nothing in a readout may be spelt
  // in a symbol the rest of the line makes ambiguous.
  say(`Pendulum gets ${pc(e.delivered)} of the drive — drop loses ${pc(e.dropLoss)}, ` +
    `friction ${pc(e.impulseFriction + e.lockFriction)} over ${len(e.impulseSlide + e.lockSlide)} ` +
    `of slide (wood on wood, ${e.friction} friction)`)
  // No "drawn clear, set the arbors N apart" line: the centre distance is
  // already stated above, and it said the same thing twice.

  if (d.noImpulse) {
    say(`${spec.drop}° of drop uses up the whole ${d.beatDeg.toFixed(2)}° beat — no impulse left.`, 'error')
  }
  if (d.noLock) {
    say(dead
      ? 'Nothing dead under the landing tooth — it arrives on the impulse face, which does not lock it, and the wheel runs straight through. More lock.'
      : 'A tooth never reaches the recoil face — the wheel will run straight through. More recoil arc.', 'error')
  }
  if (d.landingShort) {
    say(`Tooth lands only ${len(d.dropLockDepth)} short of the corner — a centre distance or tips a little off will land it on the impulse face, which does not lock. ${d.fullLandingLockDeg.toFixed(2)}° of lock seats the full ${len(LANDING_DEPTH)}.`, 'warn')
  }
  if (d.divesTooDeep) {
    say(`Pallets dive ${len(d.palletDive)} into ${len(spec.toothDepth)} of tooth — the impulse face reaches the tooth it just locked and the pair will bind. Deeper teeth, or less lock/lift.`, 'error')
  }
  // Poor delivery is worth flagging, and the flag NAMES the term that is eating
  // it — the fix is a different parameter for each, and all three look alike from
  // the efficiency figure alone.
  if (!d.noImpulse && e.efficiency < 0.2) {
    const worst = Math.max(e.dropLoss, e.impulseFriction + e.lockFriction, e.lockFriction)
    const why = worst === e.dropLoss
      ? `${spec.drop}° of drop is thrown away landing the tooth — less drop`
      : e.lockFriction > e.impulseFriction
        ? 'the tooth spends it sliding on the dead face — less lock'
        : 'the tooth spends it sliding on the impulse face — less lift, or more drop'
    say(`Only ${pc(e.delivered)} of the drive reaches the pendulum: ${why}.`, 'warn')
  }
  if (d.hubFouls) say('Pallet hub reaches into the wheel — smaller arbor, or more teeth.', 'warn')
  if (d.faceTooSteep) {
    say(`Impulse faces at ${d.impulseAngleDeg.toFixed(0)}° are steep — less lift, or more drop.`, 'warn')
  }
  if (d.hub.grown) say(`Hub grown to ${len(d.hub.dia)} ${hubGrownWhy(d.hub, spec.spokes)}.`, 'note')
  if (spec.spokes >= 2 && !d.hub.spoked) {
    say(d.hub.maxSpokes >= 2
      ? `No room for ${spec.spokes} spokes — this wheel takes ${d.hub.maxSpokes}. Cut solid.`
      : 'No room for a spoke web on this wheel — cut solid.', 'warn')
  }
  return out
}
