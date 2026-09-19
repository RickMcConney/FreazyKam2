// Everything the clock designer says about a clock, as data.
//
// Same move as the escapement's (see readout.ts): the numbers were a full page of
// the app's smallest type inside a 320 px sidebar, above the very controls being
// stepped — and they pushed the Add/Update button off the bottom of the tab. They
// are built once here, shown at body size in a floating window, and stood for in
// the sidebar by one button carrying the worst tone.

import {
  clockArborClashes, clockPlate, clockWheelClashes, designClock, TRAIN_PART_ORDER,
  MIN_MESH_RATIO, MAX_MESH_RATIO, CLOCK_ROOT_BIT_DIA,
  type ClockAssembly, type ClockBase, type ClockMotion, type ClockSpec,
} from '../shapes/clockTrain'
import { carriedPinion as gearCarried, gearDims, gearHubOf, gearMesh, pinionDims } from '../shapes/gearGenerator'
import {
  carriedPinion as escCarried, escapementDims, escapementToothClearance, TOOTH_CLEAR,
  LANDING_DEPTH, LANDING_PER_CENTRE_MM, LANDING_WARN,
} from '../shapes/escapementGenerator'
import { pendulumDims } from '../shapes/pendulumGenerator'
import { worstTone, type ReadoutLine, type Tone } from './readout'

/** Seconds as the interval a clockmaker would say out loud. */
export function fmtPeriod(sec: number): string {
  if (sec < 90) return `${+sec.toFixed(2)} s`
  const min = sec / 60
  if (min < 90) return `${+min.toFixed(2)} min`
  return `${+(min / 60).toFixed(2)} h`
}

/** One row of the parts table: how big a wheel is, and how far to the next arbor. */
export interface ClockPartRow {
  name: string
  counts: string
  size: number
  centre: number
  drives: string
  period: number
}

export interface ClockReadout {
  sections: { title: string; lines: ReadoutLine[] }[]
  rows: ClockPartRow[]
  /** Frame the arrangement needs, if the train could be laid out. */
  frame: { w: number; h: number } | null
  tone: Tone
}

/** A part key as the panel names it — the arbor-clash lines read as sentences. */
const PART_NAMES: Record<string, string> = {
  drive: 'drive wheel', great: 'great wheel', second: 'second wheel', third: 'third wheel',
  escapement: 'escape wheel', anchor: 'pallet', minute: 'minute wheel', hour: 'hour wheel',
  motion: "minute wheel's stud", pendulum: 'pendulum',
}
const nameOf = (k: string) => PART_NAMES[k] ?? k

export function clockReadout(
  spec: ClockSpec,
  base: ClockBase,
  stock: { widthMM: number; heightMM: number },
  len: (mm: number) => string,
): ClockReadout {
  const design = designClock(spec, base)
  const { train, drive } = design

  const rows: ClockPartRow[] = design.parts.map((p) => {
    if (p.params.type === 'gear') {
      const g = p.params
      const d = gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, { mateTeeth: g.mateTeeth, pinDia: g.pinDia })
      const pin = pinionDims(g)
      const motion = p.key === 'minute' || p.key === 'hour'
      return {
        name: p.name,
        // The motion work's pinion DRIVES its wheel — the one place in a clock
        // where that is true — so the arrow is drawn the other way round.
        counts: motion ? `${g.mateTeeth} pins → ${g.teeth}t` : `${g.teeth}t → ${g.mateTeeth} pins`,
        size: d.outsideDia,
        // Every row's spacing is from THIS arbor to the arbor of what it drives:
        // wheel pitch radius + its pinion's, which is where the pitch circles
        // come tangent. The motion work's two are the SAME distance — both
        // meshes span the minute arbor and the intermediate one.
        centre: pin?.centreDistance ?? 0,
        drives: motion ? 'minute arbor to the motion-work arbor' : 'to the next arbor',
        period: p.revSeconds,
      }
    }
    if (p.params.type === 'escapement') {
      const dm = escapementDims(p.params)
      return {
        name: p.name,
        counts: `${p.params.teeth}t · spans ${dm.span}`,
        size: p.params.wheelDia,
        centre: dm.centreDistance,
        drives: 'to the pallet arbor',
        period: p.revSeconds,
      }
    }
    // The pendulum is on no arbor — it HANGS from the pallet arbor — so its
    // spacing column is blank rather than a number that would read as one more
    // hole to drill.
    const pd = pendulumDims(p.params)
    return {
      name: p.name,
      counts: `${len(p.params.length)} long`,
      size: pd.rodLength,
      centre: 0,
      drives: 'hangs from the pallet arbor',
      period: p.revSeconds,
    }
  })

  const escPart = design.parts.find((p) => p.params.type === 'escapement')
  const escDims = escPart?.params.type === 'escapement' ? escapementDims(escPart.params) : null
  const pendPart = design.parts.find((p) => p.params.type === 'pendulum')
  const pendLength = pendPart?.params.type === 'pendulum' ? pendPart.params.length : 0
  // THE PENDULUM IS LEFT OUT OF THIS. It is a metre of rod and is laid out
  // BESIDE the board rather than on it (see layoutClock), so measuring it
  // against the stock warned that every clock overhangs — on the one part that
  // is never packed there, and about the one dimension nothing can be done
  // about, since the length IS the rate. `rows` is a map over `design.parts`, so
  // the two line up by index.
  const biggest = Math.max(...design.parts
    .map((p, i) => (p.key === 'pendulum' ? 0 : rows[i].size)))

  // The frame this arrangement needs — the TRAIN's extent, not the whole
  // assembly's: the pendulum is a metre long and hangs outside the plate.
  // The GOING TRAIN's parts, by key — not "everything that is not a pendulum".
  // The motion work is gears too, and letting it in would put its two wheels in
  // the arbor chain as though the train ran through them.
  // …with the motion work handed in separately, as the BRANCH it is — the frame
  // has to contain it, which is what the arrange view draws.
  const motionParts: ClockMotion | null = design.motion ? {
    minute: design.parts.find((p) => p.key === 'minute')!.params as ClockMotion['minute'],
    hour: design.parts.find((p) => p.key === 'hour')!.params as ClockMotion['hour'],
  } : null
  const plate = clockPlate(
    design.parts.filter((p) => TRAIN_PART_ORDER.includes(p.key)) as ClockAssembly,
    spec.linkAngles,
    motionParts,
  )
  const clashes = plate ? clockWheelClashes(plate) : []
  // An arbor inside a wheel is a different and much worse thing than two wheels
  // overlapping — see clockArborClashes.
  const arborClashes = plate ? clockArborClashes(plate) : []

  const sections: ClockReadout['sections'] = []
  const section = (title: string) => {
    const lines: ReadoutLine[] = []
    sections.push({ title, lines })
    return (text: string, tone: Tone = 'plain') => lines.push({ text, tone })
  }

  // ── The pendulum, and what it forces ──────────────────────────────────────
  const pend = section('Pendulum')
  pend(`Pendulum ${len(design.pendulumMM)} to the centre of oscillation`)
  pend(`Escape wheel turns once every ${fmtPeriod(design.escRevSeconds)}`)
  if (escDims) pend(`Must swing past ${escDims.minHalfSwingDeg.toFixed(2)}° each way to unlock`)
  // The rod is cut to the length the beat demands; the bob's size and the rod's
  // width are the user's Pendulum defaults, untouched.
  pend(`Rod cut to ${len(pendLength)}, hole to bob centre — regulate by raising the bob.`)
  // The escapement takes the user's Escapement defaults with only its tooth count
  // changed, and that alone can break an otherwise fine escapement — so the fatal
  // readouts are repeated here rather than left to be found on the chip afterwards.
  if (escDims?.divesTooDeep) pend(
    `Pallets dive ${len(escDims.palletDive)} into the teeth and the pair will bind. `
    + 'Deeper teeth or less lock/lift in the Escapement defaults.', 'error')
  if (escDims?.noImpulse) pend(
    `Drop uses up the whole ${escDims.beatDeg.toFixed(2)}° beat at ${spec.escapeTeeth} teeth — no impulse left.`, 'error')
  if (escDims?.noLock) pend(
    'Nothing left for a tooth to lock on — less clearance, or more lock, in the Escapement defaults.', 'error')
  const escClear = escPart?.params.type === 'escapement' ? escapementToothClearance(escPart.params) : null
  if (escClear && escClear.clearance < TOOTH_CLEAR) pend(
    escClear.clearance < 0.02
      ? `The ${escClear.side} pallet's tip hits the back of an escape tooth — the pair will jam. More drop in the Escapement defaults.`
      : `The ${escClear.side} pallet's tip passes only ${len(escClear.clearance)} from the back of an escape tooth — `
        + 'a centre distance a little short will jam it. More drop in the Escapement defaults.',
    escClear.clearance < 0.02 ? 'error' : 'warn')
  // Worded and toned as the escapement's own readout words it — a note while
  // the landing is still worth a millimetre of centre distance, a warning under
  // `LANDING_WARN`.
  if (escDims?.landingShort) pend(
    `Escape tooth lands ${len(escDims.dropLockDepth)} from the corner, under the ${len(LANDING_DEPTH)} target — `
    + `a centre distance about ${len(escDims.dropLockDepth / LANDING_PER_CENTRE_MM)} long would use it up. `
    + `${escDims.fullLandingLockDeg.toFixed(2)}° of lock in the Escapement defaults seats the full landing.`,
    escDims.dropLockDepth < LANDING_WARN ? 'warn' : 'note')

  // ── The going train ───────────────────────────────────────────────────────
  const going = section('Going train')
  going(`${design.trainWheels} wheels, ${train.meshes.length} meshes at ${+train.actualRatio.toFixed(4)}:1`)
  going(`${train.meshes.map((m) => `${m.teeth}/${m.pins}`).join(' · ')} · escape ${spec.escapeTeeth}`)
  // WHICH WAY EACH END TURNS, and it is the wheel count that decides it: every
  // mesh reverses the sense, so the great wheel and the escape wheel agree only
  // when there is an even number of meshes between them. The escapement's
  // handedness is set from that rather than taken from the user's Escapement
  // default — otherwise a three-wheel clock runs its hands backwards — so this
  // is where a maker is told what was decided for them.
  going(`Escape wheel runs ${design.escapeClockwise ? 'clockwise' : 'anticlockwise'}, `
    + `set by the ${train.meshes.length} meshes rather than by the Escapement defaults: the minute hand `
    + 'is on the great arbor and has to go round clockwise, and every mesh reverses the sense.'
    + (design.trainWheels === 3
      ? ' With two meshes the two ends agree, so the escape wheel turns clockwise too.'
      : ' With three meshes the two ends disagree, so the escape wheel turns the other way from the hands.'))
  // A SECONDS HAND OFF THE ESCAPE ARBOR is why a longcase puts one there — but
  // it only reads seconds when the escape wheel really does turn once a minute,
  // which is a fact about THESE numbers (`escapeTeeth × 2 × beat`) and not about
  // the design. Nothing is cut for it either way; it is a mark on a wheel.
  const secondsHand = Math.abs(design.escRevSeconds - 60) < 1e-6
  if (secondsHand && design.escapeClockwise) going(
    `The escape wheel turns once a minute and clockwise, so a mark on it is a SECONDS HAND — `
    + `one step per beat, ${spec.escapeTeeth} teeth reading every second second. It is a recoil `
    + 'escapement, so the mark kicks back a little on each tick before it settles, exactly as a '
    + 'longcase seconds hand does. Behind the plate: read it on the wheel itself, or carry the escape '
    + 'arbor through the front and put a hand on it.', 'note')
  else if (secondsHand) going(
    'The escape wheel turns once a minute, but anticlockwise on this train — a mark on it would run '
    + 'backwards against the hands. Three wheels puts it the right way round.', 'note')
  // Backlash and pin diameter are the clock's, not each wheel's — so this is
  // where they are reported, and where a pin that cannot work is caught once
  // rather than seven times over.
  const gears = design.parts.filter((p) => p.params.type === 'gear')
    .map((p) => ({ name: p.name, g: p.params as Extract<typeof p.params, { type: 'gear' }> }))
  const fat = gears.filter(({ g }) =>
    gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, { mateTeeth: g.mateTeeth, pinDia: g.pinDia }).pinTooFat)
  // The play comes out at the backlash EXACTLY, and stating that is the point:
  // a lantern's wheel is the only half of the pair cut to a thickness, so it
  // gives up the whole figure rather than half of it (see gearGenerator's
  // cycloidalHalfTooth). Measured rather than asserted — a wheel someone has
  // edited by hand would show the difference.
  const play = gears.length > 0 ? Math.max(...gears.map(({ g }) => gearMesh(g).playAtPitch)) : 0
  const pinList = [...new Set(design.modules.meshes.map((m) => +m.pinDia.toFixed(2)))]
  going(`${pinList.length > 1 ? `Ø${pinList.join(' and Ø')} pins` : `Ø${pinList[0]} pins`} and `
    + `${len(spec.backlash)} of backlash — ${len(play)} of play at each mesh, the wheels being the only `
    + 'half cut to a thickness. Which mesh takes which pin is below.')
  // BACK RELIEF MAKES A WHEEL HANDED, which is the one thing about it a maker has
  // to be told: the flank that does not act is cut away for pin clearance, so a
  // wheel fitted the wrong way round has no acting face at all. Every wheel in a
  // train alternates, so this cannot be stated as one direction for the clock.
  const relieved = gears.filter(({ g }) => (g.backRelief ?? 0) > 0)
  if (relieved.length > 0) going(
    `Backs of the teeth cut away on ${relieved.length === gears.length ? 'every wheel' : relieved.map((r) => r.name).join(', ')}`
    + ' for pin clearance, so each wheel runs ONE way only and neighbours turn opposite ways.'
    + ' Cut side up as drawn, and do not flip a wheel over.')
  // The two wheels of the motion work are the only ones in a clock the PINS
  // drive, so their teeth lean the other way from every wheel around them. It
  // looks like a mistake on the drawing and is not; saying so here is cheaper
  // than being asked.
  if (relieved.some(({ g }) => g.drivenByPins)) going(
    'The motion work is the exception: its cannon pinion DRIVES the minute wheel and its'
    + ' minute pinion the hour wheel, so those two lean the opposite way from the train.')
  // Named per WHEEL rather than against one module, the clock no longer having
  // one: the wheel knows its own, and the Tooth size section below says which
  // mesh each belongs to.
  if (fat.length > 0) going(
    'Pins leave no tooth to speak of on '
    + `${fat.map((f) => `${f.name} (module ${+f.g.module.toFixed(2)})`).join(', ')} — the pair will not turn. `
    + 'Thinner pins, a bigger max wheel Ø, or a taper nearer 1.', 'error')
  // WHAT THE USER IS HOLDING, and what it cost. A locked count bypasses the
  // mesh-ratio bounds the search is held to — a number someone typed is not a
  // proposal — so the one thing to say about it is when it has gone somewhere
  // the solver would never have gone on its own.
  const wheelName = ['Great', 'Second', 'Third']
  const held = train.meshes
    .map((m, i) => ({ m, i, at: spec.lockedTeeth?.[i] ?? null }))
    .filter((x) => x.at !== null)
  if (held.length > 0) {
    going(`Held: ${held.map((x) => `${wheelName[x.i]} ${x.m.teeth}t`).join(', ')}`
      + (held.length === train.meshes.length
        ? ' — every wheel, so nothing is left to solve with.'
        : ' — the rest are solved round them.'))
    for (const { m, i } of held) {
      const r = m.teeth / m.pins
      if (r < MIN_MESH_RATIO || r > MAX_MESH_RATIO) going(
        `${wheelName[i]} at ${m.teeth}t on a ${m.pins}-pin pinion is ${+r.toFixed(2)}:1 — outside the `
        + `${MIN_MESH_RATIO}–${MAX_MESH_RATIO}:1 the solver keeps to. It will run, but it is a wheel not `
        + 'worth its arbor, or one too big for the case.', 'warn')
    }
  }
  if (train.exact) going("Train is exact — the rate is the pendulum's alone.")
  else going(
    `No exact train at these numbers: the hands ${train.errorSecPerDay < 0 ? 'lose' : 'gain'} `
    + `${Math.abs(train.errorSecPerDay).toFixed(1)} s a day, which no regulating will fix. `
    + (held.length > 0
      ? `Let one of the held wheels go, or change the escape tooth count or minimum pin count.`
      : 'Try a different escape tooth count or minimum pin count.'), 'error')

  // ── The weight ────────────────────────────────────────────────────────────
  const weight = section('Weight drive')
  weight(`${drive.teeth}/${drive.pins} onto the great wheel · ${drive.turns.toFixed(1)} turns of cord`)
  weight(`Runs ${drive.runHours.toFixed(1)} h per wind. Wind the cord on a ${len(spec.drumDia)} drum on this arbor.`)
  // The drive wheel's hub IS the drum — same arbor, same diameter, and the run
  // time was worked out from that diameter, so the two must not disagree.
  const driveGear = design.parts.find((p) => p.key === 'drive')?.params
  if (driveGear?.type === 'gear') {
    const hub = gearHubOf(driveGear)
    weight(`Its hub is cut to the drum, ${len(spec.drumDia)} — the wheel is the drum's face, so the cord `
      + 'winds against it.')
    // THE ONE WHEEL THAT GIVES UP SPOKES RATHER THAN GROWING ITS HUB, since that
    // hub is the drum the run time was worked out from. Said out loud because it
    // is a number the user set on their Gear defaults and will not otherwise see
    // change — and it changes most on the drive wheel, which the taper makes the
    // coarsest mesh in the clock, so its spokes are the widest.
    if (driveGear.spokes < base.gear.spokes) weight(
      `Cut with ${driveGear.spokes} spokes rather than ${base.gear.spokes}: at module `
      + `${+driveGear.module.toFixed(2)} a spoke is ${len(2.5 * driveGear.module)} wide, and more than that `
      + `will not seat inside a ${len(spec.drumDia)} hub. Growing the hub instead would put the cord against `
      + 'it, and the run time comes from the drum.', 'note')
    // Not attributed to the spokes: `seatHub` takes the largest of three floors —
    // what was asked, what the arbor needs round it, and what the spokes need to
    // land on — and HubFit does not say which bit. What matters is only that the
    // hub came out wider than the drum.
    if (hub.dia > spec.drumDia + 0.05) weight(
      `That wheel's hub still comes out ${len(hub.dia)} — its arbor and spokes need that much stock — which is `
      + `wider than the ${len(spec.drumDia)} drum, so the cord would ride up against it. A fatter drum, or `
      + 'fewer spokes.', 'warn')
    if (!hub.spoked && driveGear.spokes >= 2) weight(
      `No room for ${driveGear.spokes} spokes outside a ${len(hub.dia)} hub, so the drive wheel comes out `
      + 'solid.', 'note')
  }
  if (drive.clampedSmall) weight(
    `A ${spec.runHours} h run wants a drive wheel smaller than its own pinion. Held at ${drive.teeth} teeth, `
    + `so it runs ${drive.runHours.toFixed(1)} h — for a shorter run use a fatter drum or less drop.`, 'warn')

  // ── The hour hand ─────────────────────────────────────────────────────────
  const mw = design.motion
  if (mw) {
    const hands = section('Motion work')
    hands(`${mw.cannonPins}/${mw.minuteTeeth} then ${mw.minutePins}/${mw.hourTeeth} — ${mw.ratio}:1 to the hour hand`)
    hands(`Both meshes run at ${len(mw.centreDistanceMM)}: the hour wheel is CONCENTRIC with the minute `
      + 'arbor, so its tube runs over the cannon pinion and the two meshes span the same pair of arbors. '
      + 'That equality is what fixes the counts.')
    // ITS MODULE FALLS OUT OF THE SPACING, and the spacing is chosen for
    // clearance rather than for strength, so it is the one place in the clock
    // where the tooth size is nobody's decision — worth stating, and worth
    // checking against the pin.
    hands(`That spacing puts it at module ${+mw.module.toFixed(2)} on Ø${+mw.pinDia.toFixed(2)} pins — the `
      + `clock's small dowel, since the hands and a clutch are next to no load — for a tooth of `
      + `${len(mw.toothMM)} at the pitch line. Its module is its own: it meshes with nothing in the train.`)
    if (mw.toothMM <= 0) hands(
      `At that spacing the Ø${+mw.pinDia.toFixed(2)} pin is wider than the whole tooth space — the motion `
      + 'work cannot turn. Wider arbor spacing, or a smaller "pin Ø small".', 'error')
    else if (mw.toothMM < mw.pinDia) hands(
      `Its teeth are ${len(mw.toothMM)} at the pitch line, thinner than the Ø${+mw.pinDia.toFixed(2)} pin `
      + 'driving them. Wider arbor spacing, or a smaller "pin Ø small".', 'warn')
    hands(`Cannon pinion (${mw.cannonPins} pins) is fixed to the minute arbor, and it is the DRIVER — the `
      + 'one place in a clock where a pinion drives a wheel. The load is the hands and the friction of the '
      + 'cannon-pinion clutch, so the flank contact that follows from that is of no consequence here.', 'note')
    // WHERE THE STUD LANDS. The minute wheel turns on a stud fixed to the front
    // plate, and with a big great wheel that stud sits inside the great wheel's
    // circle. Not a collision — the great wheel is between the plates and the
    // motion work is in front of them, the same "different depths" that lets
    // neighbouring wheels overlap — but it decides how the plate is made, so it
    // is said rather than left to be noticed. Widening the arbor spacing walks
    // the stud out past the rim, and the readout can now name the figure to type
    // rather than a size number to try.
    const host = plate?.motion ? plate.arbors[plate.motion.hostIdx] : null
    if (host && plate?.motion) {
      const clear = plate.motion.centreDistance - host.wheelRadius
      if (clear < 0) {
        const needed = Math.ceil(host.wheelRadius + 1)
        hands(`The minute wheel's stud lands ${len(-clear)} inside the great wheel's rim. That works only `
          + 'with the motion work in FRONT of the front plate, which is where it normally goes — the great '
          + `wheel is between the plates. For a stud clear of the rim, set the arbor spacing to `
          + `${len(needed)} or more — at ${mw.cannonPins}/${mw.minuteTeeth} that is a module of `
          + `${+(2 * needed / (mw.cannonPins + mw.minuteTeeth)).toFixed(2)}.`, 'warn')
      } else {
        hands(`The stud clears the great wheel's rim by ${len(clear)}, so the motion work can go on either `
          + 'side of the front plate.')
      }
    }
    if (Math.abs(spec.greatWheelMin - 60) > 1e-9) hands(
      `The great wheel turns once every ${spec.greatWheelMin} min, not 60, so the minute hand is not on it `
      + `and this ${mw.ratio}:1 puts the hour hand round once every ${fmtPeriod(spec.greatWheelMin * 60 * mw.ratio)}.`,
      'warn')
    hands("Two things to cut for rather than draw: the HOUR WHEEL turns on the cannon pinion's TUBE, so bore "
      + 'it to clear that tube and not the arbor; and the cannon pinion is a friction fit on the arbor, which '
      + 'is what lets the hands be set without moving the train.', 'note')
    hands('It is drawn and run with the rest: the minute wheel takes an arbor of its own off the great '
      + 'wheel — one more joint to drag when arranging — and the hour wheel turns on the great arbor '
      + 'itself. It changes no rate, so the going train is solved without it.', 'note')
  }

  // ── What will be cut ──────────────────────────────────────────────────────
  // ── Tooth size, one mesh at a time ────────────────────────────────────────
  //
  // The clock has no single module any more: each mesh has its own, scaled so
  // the biggest wheel just fits the board and tapering toward the escapement.
  // So every per-mesh limit that used to be answered once for the whole clock
  // has to be answered once per mesh.
  const teeth = section('Tooth size')
  // Named off the ARBORS this train actually has — a three-wheel one runs
  // drive → great → second → escape and has no third wheel to name.
  const arborNames = ['drive', ...['great', 'second', 'third'].slice(0, design.trainWheels - 1), 'escape']
  const MESH_NAMES = arborNames.slice(0, -1).map((a, i) => `${a} → ${arborNames[i + 1]}`)
  const chain: { teeth: number; pins: number }[] = [
    { teeth: drive.teeth, pins: drive.pins }, ...train.meshes,
  ]
  const bitR = CLOCK_ROOT_BIT_DIA / 2
  teeth('Tooth size is scaled to the largest wheel that fits, not chosen — a mesh only needs its OWN wheel '
    + 'and lantern to share a module, so each may have its own. It falls from the GREAT wheel toward the '
    + 'escapement because torque does; the drive wheel shares the great wheel\'s, having no reason for '
    + 'coarser teeth than the wheel the weight acts through.', 'note')
  // THE SLOW END'S RULE AND THE FAST END'S ARE DIFFERENT ARGUMENTS, so they are
  // stated as two lines rather than one. The slow end is choosing between two
  // members that both have to survive; the fast end is not choosing at all.
  teeth('The SLOW end takes the fattest of the two dowels its tooth can still push: the large pin while it '
    + 'leaves a tooth at least as thick as itself, the small one after that. A lantern mesh has two members '
    + 'that fail differently — the pin is a beam between its cheeks and wants to be fat, while the tooth is '
    + "what is LEFT of the circular pitch once the pin and the backlash are out of it — so past that point "
    + 'the fat pin is no longer the strong answer, it is the reason the tooth breaks across the grain.',
    'note')
  teeth(`The ${design.trainWheels === 3 ? 'escape arbor ALONE is' : 'two FAST arbors — the third wheel and '
    + 'the escape wheel — are'} pinned SMALL whatever the teeth could have taken, because strength is not `
    + 'what is scarce down there: torque has fallen by the whole train ratio, while the pins’ inertia is '
    + 'what the escapement starts and stops twice a second. Nothing is risked by going thin — a smaller pin '
    + "only ever leaves MORE tooth. The GREAT wheel's own lantern is never lightened this way: it carries "
    + 'the weight’s torque undivided and is the most heavily loaded pinion in the going train.', 'note')
  design.modules.meshes.forEach((m, i) => {
    const mesh = chain[i]
    if (!mesh) return
    teeth(`${MESH_NAMES[i]}: ${mesh.teeth}t on ${mesh.pins} pins of Ø${+m.pinDia.toFixed(2)}, module `
      + `${m.module.toFixed(2)} → wheel ${len(m.wheelDia)}, tooth ${len(m.toothMM)} at the pitch line`
      + `${m.locked ? ' (held)' : ''}${design.modules.binding === i ? ' — this one set the scale' : ''}`)
    // A LANTERN'S TOOTH IS WHAT THE PIN LEAVES: `π·m − pin Ø − backlash`. The pin
    // is an absolute dowel, so a fine mesh runs out of tooth long before it runs
    // out of room — and `pinTooFat` will not catch it, firing only below 5% of
    // the circular pitch.
    if (m.toothMM <= 0) teeth(
      `${MESH_NAMES[i]}: the ${len(m.pinDia)} pin is wider than the whole tooth space — that pair cannot turn. `
      + 'A bigger max wheel Ø, a taper nearer 1, or a smaller pin.', 'error')
    else if (m.toothMM < m.pinDia) teeth(
      `${MESH_NAMES[i]}: its teeth are ${len(m.toothMM)} at the pitch line, thinner than the ${len(m.pinDia)} `
      + 'pin pushing them. Wooden teeth that thin break across the grain — a taper nearer 1, a bigger max '
      + 'wheel Ø, or a smaller "pin Ø small".', 'warn')  })
  // The root is filled at 0.38·m whatever cuts it, so a fine mesh has a root
  // corner no bit can reach into — and for a lantern that is not cosmetic, since
  // the pin has to get down into that space. ONE line naming them, not one per
  // mesh: the advice is identical, and on a small board every mesh trips it,
  // which buried the tooth-thickness warnings that actually differ.
  const tight = design.modules.meshes
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => 0.38 * m.module < bitR)
  if (tight.length > 0) teeth(
    `Root fillet inside what a ${len(CLOCK_ROOT_BIT_DIA)} bit can cut on ${tight.length} mesh`
    + `${tight.length > 1 ? 'es' : ''} — ${tight.map(({ m, i }) => `${MESH_NAMES[i]} ${len(0.38 * m.module)}`).join(', ')}`
    + '. Those roots come out fuller than drawn and the pin has to reach into them: cut those wheels with a '
    + 'smaller bit, or coarsen the taper.', 'note')

  const parts = section('Parts')
  if (plate) parts(
    `Frame ${len(plate.bbox.maxX - plate.bbox.minX)} × ${len(plate.bbox.maxY - plate.bbox.minY)} as arranged `
    + '— select a wheel and press Arrange linkage to fold the train.')
  parts("The last column is that arbor to the next one — the escapement's is its wheel to the pallet arbor. "
    + 'Parts are laid out CLEAR of each other, never in mesh, so drill the plate from those spacings rather '
    + 'than from the drawing.')
  if (clashes.length > 0) parts(
    `${clashes.length} pair${clashes.length > 1 ? 's' : ''} of non-neighbouring wheels overlap in this `
    + 'arrangement. Neighbours always do (they run at different depths); these have no reason to.', 'warn')
  // THE PINS GO IN THE WHEEL, not in a pinion of its own — so say what that
  // means for the cutting, and catch the two ways it can fail. Both are about
  // the wheel's HUB, which is why they belong here and not with the ratios.
  const carried = design.parts.flatMap((p) => {
    const g = p.params
    if (g.type === 'gear') { const c = gearCarried(g); return c ? [{ name: p.name, c, bore: g.bore }] : [] }
    if (g.type === 'escapement') { const c = escCarried(g); return c ? [{ name: p.name, c, bore: g.bore }] : [] }
    return []
  })
  if (carried.length > 0) {
    parts(`Every driven wheel carries its own pinion's pins: ${carried.length} wheels are drilled through the `
      + 'hub on their pin circle, the pins stand in those holes, and the cheek drawn beside the wheel BEFORE '
      + 'each one caps the far ends — so cut ONE cheek per pinion, not two. The hub is grown to hold the '
      + 'holes, which is why it comes out bigger than the Gear default.', 'note')
    for (const { name, c, bore } of carried) {
      if (c.gap < 1) parts(
        `${name}: only ${len(Math.max(0, c.gap))} of wood between its pin holes — fewer pins, thinner pins, `
        + 'or a bigger module.', 'warn')
      if (c.pinCircleDia / 2 - c.pinDia / 2 < bore / 2 + 1) parts(
        `${name}: its pin holes break into the ${len(bore)} arbor hole. A smaller bore, or fewer pins on that `
        + 'mesh so the pin circle is wider.', 'error')
    }
  }

  // A wheel with an arbor through it cannot turn at all, which is worse than the
  // overlap above — an arbor is a rod from plate to plate, so it is at EVERY
  // depth, and there is no "they run at different depths" to save it.
  for (const c of arborClashes) parts(
    `The ${nameOf(c.wheel)}'s teeth sweep ${len(c.depthMM)} over the ${nameOf(c.arbor)} arbor, which runs `
    + 'the whole way between the plates. Fewer teeth on that wheel, a smaller module, a different '
    + 'arrangement — or carry that arbor as a stub in one plate only.', 'warn')
  if (biggest > Math.min(stock.widthMM, stock.heightMM)) parts(
    `The largest part is ${len(biggest)} across on ${len(stock.widthMM)} × ${len(stock.heightMM)} stock — it `
    + 'will overhang. A smaller module, a shorter beat, or bigger stock.', 'warn')
  parts('Wheels take your Gear defaults (bore, hub, spokes, markings) and the escapement takes your '
    + 'Escapement defaults. The counts, module, backlash, pin Ø and cycloidal profile come from here, since '
    + 'those are decisions about the whole clock — tweak anything else per part through its own chip.', 'note')
  parts('Select any wheel afterwards and press Animate whole clock to stand the train up at those spacings '
    + 'and run it, and click the Clock chip to come back here and try a different beat on the same clock.', 'note')

  return {
    sections,
    rows,
    frame: plate ? { w: plate.bbox.maxX - plate.bbox.minX, h: plate.bbox.maxY - plate.bbox.minY } : null,
    tone: worstTone(sections.flatMap((s) => s.lines)),
  }
}
