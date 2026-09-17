// ─── Pendulum ─────────────────────────────────────────────────────────────────
//
// A rod with a suspension hole and a bob on it — the simplest thing that can be
// cut flat and still keep time.
//
// ONE NUMBER MATTERS AND IT IS `length`: suspension hole to the CENTRE OF
// OSCILLATION, which for a light rod and a heavy bob is the bob's centre. The
// beat follows from it and from nothing else on the drawing —
//
//     T = 2π√(L/g),  beat = T/2  ⟹  beat = π√(L/g)
//
// — so the panel quotes the beat rather than making anyone work it out, and a
// clock hands the length straight down from the beat it was designed for
// (`pendulumLengthMM` in clockTrain.ts is the same formula solved the other way).
//
// `cx, cy` IS THE SUSPENSION POINT, not the middle of the drawing. That is what
// makes the shape placeable: a pendulum hangs from a point, the clock preview
// hangs it from the anchor arbor, and everything else on it is below that point
// by a known amount. Putting the origin at the centroid would move the
// suspension every time the bob changed size.
//
// What this deliberately is NOT: a compensated pendulum, or a rod whose own mass
// is accounted for. A real wooden rod raises the centre of oscillation a little
// above the bob centre, so a clock built to these numbers will run a touch fast
// and is regulated by raising the bob — which is what the rating nut under it is
// for, and why no drawing can be the last word on the rate.

import { clamp } from './polyOps'

/** mm/s². Shared with clockTrain's `G_MM`; stated once there and imported here
 *  would be a cycle, so the two are pinned equal by a test instead. */
const G_MM = 9806.65

export interface PendulumSpec {
  /** THE SUSPENSION POINT — centre of the hanging hole. Everything is below it. */
  cx: number
  cy: number
  /** Suspension hole to bob centre, mm. The only dimension the rate depends on. */
  length: number
  /** Rod width, mm. */
  rodWidth: number
  /** Bob half-width and half-height, mm. A bob is a lens seen edge-on, so its
   *  MAJOR AXIS LIES ACROSS the rod and `bobRx` is normally the larger — but both
   *  are free, because nothing about the rate depends on the bob's shape, only on
   *  where its centre sits. */
  bobRx: number
  bobRy: number
  /** Suspension hole Ø, mm. 0 for none. */
  bore: number
}

export interface PendulumDims {
  /** Seconds per beat — half a period. What a clock is described by. */
  beatSeconds: number
  /** Seconds for a full swing out and back. */
  periodSeconds: number
  /** Overall length of the rod, mm — it runs a rod's width past each end. */
  rodLength: number
  /** Stock between the hole and the top of the rod, mm. */
  boreEdge: number
  /** The hole has eaten the rod: it is wider than the rod or has no shoulder
   *  left beside it. */
  boreTooBig: boolean
  /** The bob is narrower than the rod, so there is no bob to see. */
  bobTooSmall: boolean
}

const f = (n: number): string => String(+n.toFixed(4))

/** Seconds per beat for a pendulum of this length — `π√(L/g)`. */
export function pendulumBeat(lengthMM: number): number {
  return Math.PI * Math.sqrt(Math.max(0.1, lengthMM) / G_MM)
}

/** The one place a pendulum's numbers are worked out, shared by the generator
 *  and both panels so a readout can never disagree with the geometry. */
export function pendulumDims(spec: PendulumSpec): PendulumDims {
  const rodWidth = Math.max(0.5, spec.rodWidth)
  const bobRy = Math.max(0.1, spec.bobRy)
  const bore = Math.max(0, spec.bore)
  const beat = pendulumBeat(spec.length)
  return {
    beatSeconds: beat,
    periodSeconds: 2 * beat,
    rodLength: Math.max(0.1, spec.length) + bobRy + 2 * rodWidth,
    boreEdge: rodWidth - bore / 2,
    boreTooBig: bore > 0 && bore >= rodWidth * 0.8,
    bobTooSmall: Math.max(0.1, spec.bobRx) * 2 <= rodWidth,
  }
}

export type PendulumPartKey = 'rod' | 'bore' | 'bob'

export interface PendulumPart { key: PendulumPartKey; d: string }

/**
 * Rod, hole and bob as separate parts — they are three different cuts (a
 * profile, a drill and a profile), which is the same reason a gear comes out in
 * pieces rather than as one compound path.
 */
export function generatePendulumParts(spec: PendulumSpec): PendulumPart[] {
  const { cx, cy } = spec
  const length = Math.max(0.1, spec.length)
  const rodWidth = Math.max(0.5, spec.rodWidth)
  const bobRx = Math.max(0.1, spec.bobRx)
  const bobRy = Math.max(0.1, spec.bobRy)
  const hw = rodWidth / 2
  // A rod's width of stock above the hole and below the bob: enough to carry the
  // suspension pin without splitting out, and enough to take a rating nut.
  const top = cy + rodWidth
  const bottom = cy - length - bobRy - rodWidth

  const parts: PendulumPart[] = [{
    key: 'rod',
    d: `M${f(cx - hw)},${f(bottom)} L${f(cx + hw)},${f(bottom)} L${f(cx + hw)},${f(top)} L${f(cx - hw)},${f(top)} Z`,
  }]

  // Clamped so the hole always leaves a shoulder — a bore wider than the rod
  // does not draw a slightly wrong pendulum, it draws a rod cut in two.
  const boreR = clamp(spec.bore / 2, 0, hw * 0.8)
  if (boreR > 0.25) {
    parts.push({
      key: 'bore',
      d: `M${f(cx - boreR)},${f(cy)} A${f(boreR)},${f(boreR)},0,0,0,${f(cx + boreR)},${f(cy)}`
        + ` A${f(boreR)},${f(boreR)},0,0,0,${f(cx - boreR)},${f(cy)} Z`,
    })
  }

  const by = cy - length
  parts.push({
    key: 'bob',
    d: `M${f(cx - bobRx)},${f(by)} A${f(bobRx)},${f(bobRy)},0,0,0,${f(cx + bobRx)},${f(by)}`
      + ` A${f(bobRx)},${f(bobRy)},0,0,0,${f(cx - bobRx)},${f(by)} Z`,
  })

  return parts
}

/** Every part in one compound path — the drag preview, and the fallback for
 *  anywhere that still wants a single `d`. */
export function generatePendulumD(spec: PendulumSpec): string {
  return generatePendulumParts(spec).map((p) => p.d).join(' ')
}

/** Length that makes a pendulum of this drawn height — used when placing by drag.
 *  The drag box is the whole rod, and the length is what sets the beat, so the
 *  box has to be solved backwards through `rodLength`. */
export function lengthForHeight(height: number, rodWidth: number, bobRy: number): number {
  return Math.max(1, height - bobRy - 2 * Math.max(0.5, rodWidth))
}
