// ─── Spoked web: hub sizing and the windows between the spokes ───────────────
//
// Shared by every shape that is a wheel with a lightened web — the gear and the
// escape wheel — because the arithmetic is about the SPOKE, not about the teeth.
// A gear states its spoke width as 2.5·module and an escape wheel states it in
// millimetres, but from there on the question is identical: how much hub does a
// given number of spokes need to land on, and how much rim is left over.
//
// Everything here is expressed in terms of `spokeW`, which is what makes the two
// callers one code path. The gear's original constants map onto it exactly —
// SPOKE 2.5·m is the width, WEB 1.5·m is 0.6·spokeW, and HUB 2·m is 0.8·spokeW —
// so this is a rename of the gear's own rules, not a new set of them.

import { type Pt, clamp, arcInto, roundConvex, ellipseRing } from './polyOps'

/** Daylight left between two spokes where they meet the hub, radians. */
const SPOKE_GAP = 0.15
/** Least radial room a window needs, and the least stock round the bore, as
 *  fractions of the spoke width. */
const WEB = 0.6
const HUB_RING = 0.8

/** What raised the hub above the diameter that was asked for. */
export type HubFloor = 'bore' | 'spokes' | 'pins'

export interface HubFit {
  /** The diameter actually used. */
  dia: number
  /** It had to be grown past what was asked for. */
  grown: boolean
  /** WHICH floor grew it, or null when the asked-for diameter stood. Named
   *  rather than implied, because a hub field that does nothing is otherwise
   *  indistinguishable from a hub field that is broken: the bore's own floor
   *  (and a carried pinion's pin ring) sit under every wheel, so a typed
   *  diameter below them changes nothing and there is nothing on the drawing
   *  to say so. */
  grownFor: HubFloor | null
  /** Windows will really be cut — false means the web has no room and the wheel
   *  comes out solid. */
  spoked: boolean
  /** Most spokes this wheel can take at ANY hub diameter, before the hub runs
   *  into the rim. */
  maxSpokes: number
}

/**
 * Resolve the hub.
 *
 * Spokes are a fixed width, so what limits their number is the circumference
 * they have to land on — which is why the answer is to grow the hub rather than
 * to refuse the count or, worse, to drop every window and hand back a solid
 * wheel with no explanation. Seating `n` spokes with `SPOKE_GAP` of daylight
 * between them needs
 *
 *     hubR ≥ (spokeW/2) / sin(π/n − SPOKE_GAP/2)
 *
 * so `hubDia` is treated as a FLOOR and raised to that when it falls short. The
 * hub can only grow until it meets the rim, which is the real ceiling on the
 * count (`maxSpokes`); past 2π/SPOKE_GAP spokes no hub is big enough at all.
 *
 * THERE ARE THREE FLOORS AND THE WINNER IS NAMED. The spokes are only one of
 * them: the axle wants `HUB_RING·spokeW` of stock round it whatever the web
 * does, and a wheel carrying a lantern's pin holes wants the ring those need.
 * Folding them together before the comparison — which is what this did, by
 * taking `max(asked, minR)` as the asked-for figure — meant a hub raised by the
 * bore was reported as not grown at all, so the field silently ignored
 * everything typed below it. They are compared separately now and `grownFor`
 * says which one bound.
 */
export function seatHub(
  rimInner: number, boreR: number, hubDia: number, spokes: number, spokeW: number,
  /** Hub the pin holes of a carried lantern pinion need, if the wheel carries
   *  one — a third floor, and the largest simply wins. */
  carriedDia = 0,
): HubFit {
  const minR = boreR + HUB_RING * spokeW    // stock the axle needs round it
  const ceiling = rimInner - WEB * spokeW   // past this there is no web left
  const hw = spokeW / 2

  // Smallest hub that seats n spokes; Infinity when no hub can.
  const seat = (n: number) => {
    const room = Math.PI / n - SPOKE_GAP / 2
    return room <= 1e-6 ? Infinity : hw / Math.sin(room)
  }
  let maxSpokes = 0
  for (let n = 2; n <= Math.floor((2 * Math.PI) / SPOKE_GAP); n++) {
    if (Math.max(minR, seat(n)) <= ceiling) maxSpokes = n
  }

  const asked = Math.max(0, hubDia / 2)
  const n = Math.round(spokes)
  const need = n >= 2 ? seat(n) : Infinity

  let r = asked
  let grownFor: HubFloor | null = null
  const floor = (v: number, why: HubFloor) => {
    if (isFinite(v) && v > r) { r = v; grownFor = why }
  }
  floor(minR, 'bore')
  floor(carriedDia / 2, 'pins')
  floor(need, 'spokes')

  // 0.05 mm, not an epsilon: growing the hub by a few microns to seat the last
  // spoke is true but not worth telling anyone about.
  const grown = r > asked + 0.025
  return {
    dia: 2 * r,
    grown,
    grownFor: grown ? grownFor : null,
    spoked: n >= 2 && isFinite(need) && r <= ceiling,
    maxSpokes,
  }
}

/**
 * Why the hub grew, as a phrase to follow "Hub grown to 24 mm ".
 *
 * One wording for all three panels, because the three floors are easy to
 * confuse for each other and a message naming the wrong one is worse than none:
 * a maker who reads "to seat 5 spokes" under a hub the BORE raised will go and
 * change the spoke count, and nothing will move.
 */
export function hubGrownWhy(fit: HubFit, spokes: number): string {
  switch (fit.grownFor) {
    case 'spokes': return `to seat ${Math.round(spokes)} spokes`
    case 'pins':   return 'to hold the pinion pin holes'
    default:       return 'to leave stock round the bore'
  }
}

/** The windows between the spokes, as CW holes. `seatHub` has already sized the
 *  hub so they fit, so this only has to draw them. */
export function spokeWindows(n: number, rimInner: number, hubOuter: number, spokeW: number): Pt[][] {
  if (n < 2 || rimInner - hubOuter < WEB * spokeW) return []
  const hw = Math.min(spokeW / 2, hubOuter * 0.9)
  // Angular half-width of a straight-sided spoke, which is widest at the hub.
  const halfAt = (r: number) => Math.asin(clamp(hw / r, -1, 1))
  const step = (2 * Math.PI) / n
  if (step - 2 * halfAt(hubOuter) < SPOKE_GAP * 0.5) return []   // belt and braces
  const fillet = Math.min(WEB * spokeW, (rimInner - hubOuter) * 0.25, hw * 0.9)

  const out: Pt[][] = []
  for (let i = 0; i < n; i++) {
    const a0 = i * step, a1 = a0 + step
    const ring: Pt[] = []
    const radial = (from: number, to: number, side: 1 | -1, centre: number) => {
      const steps = 24
      for (let k = 0; k <= steps; k++) {
        const r = from + ((to - from) * k) / steps
        const a = centre + side * halfAt(r)
        ring.push([r * Math.cos(a), r * Math.sin(a)])
      }
    }
    radial(hubOuter, rimInner, 1, a0)                     // up this spoke's + side
    arcInto(ring, 0, 0, rimInner, rimInner, a0 + halfAt(rimInner), a1 - halfAt(rimInner))
    radial(rimInner, hubOuter, -1, a1)                    // down the next spoke's − side
    arcInto(ring, 0, 0, hubOuter, hubOuter, a1 - halfAt(hubOuter), a0 + halfAt(hubOuter))
    // The window's convex corners are the WEB's concave ones — the stress
    // risers where a spoke meets the hub and the rim.
    for (const r of roundConvex([ring], fillet)) out.push(r)
  }
  return out
}

// ─── The pinion a wheel CARRIES ───────────────────────────────────────────────
//
// A lantern pinion is a pin circle between two cheeks, and one of those cheeks
// can be the WHEEL that shares its arbor: drill the pin holes through the
// wheel's hub, stand the pins in them, and cap the far ends with a single loose
// cheek. That is one part fewer per arbor, and — the real reason — it takes the
// pinion's clocking out of the assembly: pins set in the wheel cannot creep
// round it, where a pinion glued on an arbor can.
//
// It costs the wheel its hub: the holes have to fall in solid stock with a rim
// round them, so the hub becomes a FLOOR of `pinRing().hubDia` — which is what
// `seatHub` already does for spokes, and the two floors simply take the larger.
// Shared by the gear and the escape wheel because it is a question about the
// HUB, and neither of them owns that.
//
// Stated in PIN CIRCLE rather than in module, because the escape wheel has no
// module of its own: the circle its pins ride is the mating pinion's pitch
// circle, which belongs to the mesh with the wheel BEFORE it.

/** Stock left outside a pin hole: × the pin, never less than 1.5 mm. */
const PIN_RING_RIM = 0.4

export interface PinRing {
  pins: number
  pinDia: number
  pinCircleDia: number
  /** Hub the wheel needs to carry these holes with a rim round them. */
  hubDia: number
  /** Wood between two neighbouring holes, mm. Negative means they merge. */
  gap: number
}

/** The ring of pin holes a wheel carries, or null if it carries none. */
export function pinRing(
  pins: number | undefined,
  pinCircleDia: number | undefined,
  pinDia: number | undefined,
): PinRing | null {
  const n = Math.round(pins ?? 0)
  const dia = pinDia ?? 0
  const circle = pinCircleDia ?? 0
  if (n < 2 || dia <= 0 || circle <= 0) return null
  const rim = Math.max(1.5, PIN_RING_RIM * dia)
  return {
    pins: n,
    pinDia: dia,
    pinCircleDia: circle,
    hubDia: circle + dia + 2 * rim,
    gap: circle * Math.sin(Math.PI / n) - dia,
  }
}

/** Those holes as rings, centred on the wheel's own centre. */
export function pinRingHoles(cx: number, cy: number, ring: PinRing): Pt[][] {
  const r = ring.pinCircleDia / 2
  const out: Pt[][] = []
  for (let i = 0; i < ring.pins; i++) {
    const a = (i * 2 * Math.PI) / ring.pins
    out.push(ellipseRing(cx + r * Math.cos(a), cy + r * Math.sin(a), ring.pinDia / 2, ring.pinDia / 2))
  }
  return out
}
