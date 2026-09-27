// ─── Ratchet wheel with gravity pawls ─────────────────────────────────────────
//
// A sawtooth wheel on the arbor, and N pawls pinned to the GEAR's face evenly
// round it, so the gear can only turn one way — a clock's click, with gravity for
// the spring. The pawls ride round with the gear. Each one rests its nose on the
// wheel under its own weight, rides up a tooth's back while the gear turns the
// free way, and drops off the tip into the next space; turned the other way, a
// tooth's face meets its nose and it becomes a strut into its pin.
//
// Parts: the wheel (outside profile) and its bore; the pawls (outside profile)
// with their pivot holes; and the HOUSING, a pocket in the gear the whole thing
// sits in. The pivot holes are drilled in the pocket floor at the positions
// drawn — the pawls are drawn where they hang on it.
//
// The construction in the base frame (the WHEEL free anticlockwise relative to
// the pawls, so the GEAR free clockwise; `freeSense` +1 mirrors it at the very
// end, as the track does its right-hand turnout, so the two hands cannot
// disagree):
//
//   Tooth k has its FACE on the radial line at θk, from the root circle Rr out
//   to the tip circle Ro = Rr + h, and its BACK falls straight from (Ro, θk) to
//   (Rr, θk + p). A pawl's nose sits in the notch just clockwise of a face.
//
//   THE PIVOT STANDS ON THE LINE OF ACTION. The face is radial, so it pushes the
//   nose along the tangent; the pivot is put on that tangent, through the middle
//   of the face — so a locked pawl is a strut straight into its pin, with no
//   moment to lift it out, and the nose moves RADIALLY as the pawl swings, which
//   is what riding up a back needs.
//
//   GRAVITY drops a pawl in only while it is on the upper side: swinging in moves
//   it along −u(φ) and gravity pulls along −y, so the share of its weight pulling
//   it in is sin φ. The pawls turn with the gear, so what matters is how many are
//   always high enough, at the worst angle the gear can stop at — which is why
//   there are several, spaced evenly. A pawl on the underside falls AWAY until
//   something catches it.
//
//   THE HOUSING WALL IS THE STOP. The pocket is sized by the pawls — seated, the
//   bosses (which turn in place) usually reach farthest — and a falling pawl
//   swings out until its back rubs the wall. That swing is MEASURED on the
//   outline. Up to STOP_LIMIT the pawl is left plain. Past it, the pawl's weight
//   goes over its pivot and, coming round the top, gravity holds it against the
//   wall instead of dropping it in (and it sweeps into its neighbour); so the
//   back is raised into a HEEL at the nose end, just far enough that the wall
//   catches it a margin past clearing the tips. A long pawl reaches the wall on
//   its own (~32° at 30 mm); the default 24 mm one would swing ~113°. Stop pins
//   were the first cut of this — a pocket that did the job was what was wanted.
//
//   Every pawl is seated at once, so the teeth are a multiple of the pawls. A
//   count that is not is rounded, and the panel says so.
//
// Clearances are built by subtraction: the nose is the notch itself, less the
// clearance, cut out of the wheel AS THE CUTTER LEAVES IT (roots rounded to its
// radius), so the fit cannot drift from the teeth.

import {
  type Pt, clamp, ellipseRing, boolRings, roundConcave, roundConvex, inflateRings, ringToD,
} from './polyOps'

export interface RatchetSpec {
  cx: number; cy: number
  /** Rounded to a multiple of `pawls`, so that every pawl seats at once. */
  teeth: number
  /** Tip circle of the wheel. */
  outerDia: number
  /** Radial depth of a tooth — how far each pawl lifts per click. */
  toothDepth: number
  /** Rounds each tooth's tip — takes the knife edge off the locking face.
   *  Capped at a quarter of the depth, so most of the face still bears. */
  tipRadius: number
  /** Arbor hole in the wheel. */
  bore: number
  pawls: number
  /** Where the first pawl's nose is drawn, degrees CCW from +X. The pawls turn
   *  with the gear, so this only sets the drawing's orientation. */
  pawlAngle: number
  /** Nose to pivot, mm. */
  pawlLength: number
  /** Width of the pawl's body. */
  pawlWidth: number
  /** Pivot pins. */
  pivotDia: number
  clearance: number
  /** The end mill the parts are cut with — it rounds the tooth roots, and the
   *  nose is shaped to seat in what it leaves. */
  toolDia: number
  /** The way the GEAR (carrying the pawls) is free to turn, relative to the
   *  wheel. CCW positive, CNC Y-up. */
  freeSense: 1 | -1
}

export interface RatchetDims {
  tipR: number
  rootR: number
  /** The tooth count actually cut — a multiple of the pawls. */
  teeth: number
  teethRounded: boolean
  pitchDeg: number
  /** How far each pawl swings to clear the tips, degrees. */
  liftDeg: number
  /** Radius of the circle the pivot pins stand on, round the wheel's centre. */
  pivotR: number
  /** The housing pocket. It clears every seated pawl by the clearance, and its
   *  wall is what stops a pawl swinging out. */
  housingR: number
  /** How far a pawl swings before the housing wall catches it, degrees. */
  stopDeg: number
  /** The pawls carry a heel, because on their own they would swing past
   *  STOP_LIMIT before meeting the wall. */
  heeled: boolean
  /** At the worst angle the gear can stop at, how many pawls hang where gravity
   *  drops them into the teeth. */
  engagedMin: number
  /** Some angle leaves no pawl high enough to fall in. */
  mayNotEngage: boolean
  /** No swing lifts the pawl clear of the tips — its pivot end, which turns in
   *  place, reaches into the teeth. Every passing tooth would strike it. */
  cannotClear: boolean
  /** Two pawls overlap, or come within a clearance of each other. */
  pawlsCollide: boolean
  /** The pin needs more wall round it than the pawl's width leaves. */
  bossThin: boolean
  /** The cutter's radius rounds more than half of each tooth face away. */
  toothTooShallow: boolean
  /** The bore leaves no wall inside the root circle. */
  boreTooBig: boolean
}

const DEG = Math.PI / 180
/** Gravity share under which a pawl is liable to bounce and skip a tooth. */
const WEAK_GRAVITY = 0.35
/** The farthest a pawl is asked to swing looking for clearance, radians. */
const MAX_LIFT = Math.PI / 2
/** Wood left round a pin hole, mm. */
const PIN_WALL = 1.5
/** How far a plain pawl may swing before the housing wall catches it — past
 *  this, it gets a heel. Well short of the ~90° at which its weight goes over
 *  the pivot and gravity stops bringing it back. */
const STOP_LIMIT = 45 * (Math.PI / 180)
/** How much further than clearing the tips a HEELED pawl lifts before the wall
 *  catches it, mm at its length — a clearance's worth of slack, so a pawl
 *  bouncing off a tip is not trapped against it. */
const STOP_MARGIN = 1

const polar = (r: number, a: number): Pt => [r * Math.cos(a), r * Math.sin(a)]

function geometry(spec: RatchetSpec) {
  const n = Math.max(1, Math.round(spec.pawls))
  const Z = Math.max(n, Math.round(Math.max(3, spec.teeth) / n) * n)
  const Ro = Math.max(2, spec.outerDia / 2)
  const h = clamp(spec.toothDepth, 0.2, Ro - 1)
  const Rr = Ro - h
  const c = Math.max(0, spec.clearance)
  const toolR = Math.max(0, spec.toolDia / 2)
  const tipRad = clamp(spec.tipRadius ?? 0, 0, h / 4)
  const W = Math.max(1, spec.pawlWidth)
  const pinR = Math.max(0, spec.pivotDia / 2)
  const L = Math.max(W, spec.pawlLength)
  const p = (2 * Math.PI) / Z
  // Base frame: wheel free CCW relative to the pawls, i.e. gear free CW.
  const mirror = spec.freeSense === -1 ? 1 : -1
  // The mirror maps φ to π − φ, so a nose asked for at φ is built at π − φ and
  // lands where it was asked for.
  const toBase = (a: number) => (mirror === 1 ? a : Math.PI - a)
  const faces: number[] = []
  for (let k = 0; k < n; k++) faces.push(toBase(spec.pawlAngle * DEG + (k * 2 * Math.PI) / n))
  const rc = (Ro + Rr) / 2
  return { Z, n, Ro, Rr, h, c, toolR, tipRad, W, L, pinR, p, mirror, faces, phase: faces[0], rc }
}

type G = ReturnType<typeof geometry>

const tangentCW = (f: number): Pt => [Math.sin(f), -Math.cos(f)]

/** The pivot for a nose on face angle `f`: on the tangent through the middle of
 *  the face, clockwise of it (base frame). */
function pivotOf(g: G, f: number): Pt {
  const [x, y] = polar(g.rc, f)
  const [tx, ty] = tangentCW(f)
  return [x + g.L * tx, y + g.L * ty]
}

/** A point `r` out along the face at `f` and `off` clockwise of it. */
function onFace(f: number, r: number, off: number): Pt {
  const [tx, ty] = tangentCW(f)
  return [r * Math.cos(f) + off * tx, r * Math.sin(f) + off * ty]
}

const rotateAbout = (ring: Pt[], [cx, cy]: Pt, a: number): Pt[] =>
  ring.map(([x, y]) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)] as Pt)

/**
 * How far the pawl on face `f` has to swing about its pivot before every part
 * of it is outside the tip circle, radians, found on the outline itself.
 *
 * Not h/L: the nose's lowest corner is not on the tangent through the pivot and
 * the swing is tens of degrees, so the small-angle answer is short — and a stop
 * placed by it (the first cut of this) caught the pawl before it cleared the
 * tips, which is a ratchet that jams both ways.
 *
 * The pivot is clockwise of the nose (base frame), so lifting is a CLOCKWISE
 * swing: the nose, at −L·t from the pivot, moves along −u under +γ.
 *
 * Returns a quarter turn when no swing up to that clears it — a pawl so short
 * that its boss, which turns in place, sits in the teeth. `ratchetDims` reports
 * that as `cannotClear` rather than let the number pass for a lift.
 */
function clearAngle(g: G, f: number, pawl: Pt[][]): number {
  const pivot = pivotOf(g, f)
  const clears = (a: number) =>
    pawl.every((r) => rotateAbout(r, pivot, -a).every(([x, y]) => Math.hypot(x, y) >= g.Ro + g.c))
  let lo = 0, hi = MAX_LIFT
  if (!clears(hi)) return hi
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2
    if (clears(m)) hi = m; else lo = m
  }
  return hi
}

/** The farthest any point of `rings` reaches from the wheel's centre, swung
 *  out by `a` about `pivot`. */
function reachAt(rings: Pt[][], pivot: Pt, a: number): number {
  let far = 0
  for (const r of rings) for (const [x, y] of rotateAbout(r, pivot, -a)) far = Math.max(far, Math.hypot(x, y))
  return far
}

/** The swing, radians, at which `rings` first touches a wall of radius `R` —
 *  stepped a degree at a time (the reach need not grow steadily), then bisected.
 *  Half a turn when it never does. */
function wallAngle(rings: Pt[][], pivot: Pt, R: number): number {
  const step = Math.PI / 180
  for (let a = step; a <= Math.PI; a += step) {
    if (reachAt(rings, pivot, a) < R) continue
    let lo = a - step, hi = a
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2
      if (reachAt(rings, pivot, m) >= R) hi = m; else lo = m
    }
    return hi
  }
  return Math.PI
}

/**
 * Everything decided once, off the first pawl, that holds for all of them (they
 * are one shape turned): the wheel as cut, the swing that clears the tips
 * (`lift`), the housing, the heel, and where the wall stops a pawl.
 *
 * The HOUSING clears every seated pawl by the clearance, and is never so tight
 * that it catches a pawl before it has lifted a margin past clearing the tips.
 * Then the swing to the wall is measured on the plain pawl; within STOP_LIMIT it
 * stays plain. Otherwise the HEEL is the nose's top corner B, raised along the
 * circle it swings on about the pivot by `heel` radians: B swung out by
 * `heel + swing` lands on the wall, so the heel swung out by `swing` does.
 */
function design(g: G) {
  const f = g.faces[0]
  const pivot = pivotOf(g, f)
  const wheel = cutWheel(g)
  const plain = pawlRings(g, f, wheel, 0)
  const lift = clearAngle(g, f, plain)
  const swing = lift + STOP_MARGIN / g.L
  let reach = 0
  for (let i = 0; i <= 24; i++) reach = Math.max(reach, reachAt(plain, pivot, (swing * i) / 24))
  const housingR = Math.max(reachAt(plain, pivot, 0) + g.c, reach)
  if (wallAngle(plain, pivot, housingR) <= STOP_LIMIT) return { wheel, lift, housingR, heel: 0 }
  const B = onFace(f, g.Ro, g.c)
  const heel = Math.max(0, wallAngle([[B]], pivot, housingR) - swing)
  return { wheel, lift, housingR, heel }
}

export function ratchetDims(spec: RatchetSpec): RatchetDims {
  const g = geometry(spec)
  // The fewest pawls high enough, over every angle the gear can stop at. Every
  // pawl is on the circle at spacing 2π/n, so a sweep over one spacing covers it.
  let engagedMin = Infinity
  for (let i = 0; i < 90; i++) {
    const turn = ((i / 90) * 2 * Math.PI) / g.n
    let k = 0
    for (let j = 0; j < g.n; j++) if (Math.sin(turn + (j * 2 * Math.PI) / g.n) >= WEAK_GRAVITY) k++
    engagedMin = Math.min(engagedMin, k)
  }
  const pinR = spec.pivotDia / 2
  const pivot = pivotOf(g, g.faces[0])
  const { wheel, lift, housingR, heel } = design(g)
  const pawl0 = pawlRings(g, g.faces[0], wheel, heel)
  // Where the wall really catches the pawl, off its own outline.
  const stop = wallAngle(pawl0, pivot, housingR)
  // Asked of the outlines themselves, and at BOTH ends of the swing: the pawls
  // lie tangentially, each nose tucked under its neighbour, so two that clear
  // each other seated can meet the moment one lifts — and pawls hanging at
  // different heights (the upper ones seated, the lower ones on the wall) is
  // the ordinary state of the thing. Neighbours are enough: the pawls are all
  // one shape turned, so pawl 0 against pawl 1 stands for every adjacent pair.
  let pawlsCollide = false
  if (g.n > 1) {
    const poses = (f: number, rings: Pt[][]) => [rings, rings.map((r) => rotateAbout(r, pivotOf(g, f), -stop))]
    const a = poses(g.faces[0], pawl0)
    const b = poses(g.faces[1], pawlRings(g, g.faces[1], wheel, heel))
    pawlsCollide = a.some((pa) => b.some((pb) => boolRings('intersection', inflateRings(pa, g.c / 2), pb).length > 0))
  }
  return {
    tipR: g.Ro, rootR: g.Rr,
    teeth: g.Z,
    teethRounded: g.Z !== Math.round(spec.teeth),
    pitchDeg: 360 / g.Z,
    liftDeg: lift / DEG,
    pivotR: Math.hypot(...pivot),
    housingR,
    stopDeg: stop / DEG,
    heeled: heel > 0,
    engagedMin,
    mayNotEngage: engagedMin < 1,
    pawlsCollide,
    cannotClear: lift >= MAX_LIFT - 1e-9,
    bossThin: g.W / 2 < pinR + PIN_WALL,
    toothTooShallow: g.toolR > g.h / 2,
    boreTooBig: spec.bore / 2 > g.Rr - 2,
  }
}

/** The wheel's outline in the base frame, CCW: radial faces, straight backs. */
function wheelRing(g: G): Pt[] {
  const ring: Pt[] = []
  for (let k = 0; k < g.Z; k++) {
    const a = g.phase + k * g.p
    ring.push(polar(g.Rr, a), polar(g.Ro, a))
  }
  return ring
}

/** The wheel as it is cut: the roots rounded to the cutter's radius (an
 *  outside profile cannot get into that corner), and the tips to `tipRadius`.
 *  Everything the pawls are shaped against is this, so they follow both. */
function cutWheel(g: G): Pt[][] {
  return roundConvex(roundConcave([wheelRing(g)], g.toolR), g.tipRad)
}

/** Convex hull, CCW (monotone chain). */
function hull(pts: Pt[]): Pt[] {
  const ps = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = [], upper: Pt[] = []
  for (const p of ps) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/**
 * One pawl on face angle `f`: the hull of a flat nose end and the round boss
 * about the pivot, with the wheel taken out from under it.
 *
 * The NOSE END is flat, parallel to the tooth's face and a clearance off it, from
 * below the root up to the tip circle — so it bears on the whole face — and the
 * rest is whatever the hull and the wheel leave: a top edge running straight to
 * the boss, and an underside that follows the tooth's back and humps over the
 * next tip.
 *
 * It is cuttable as drawn, with no fillet pass. Taking the wheel away grown by
 * the clearance would leave a notch over each tip it straddles of radius the
 * CLEARANCE, which no end mill cuts; so each of those tips also takes out a
 * RELIEF disc of at least the cutter's radius. What is taken away is then all
 * round of at least the cutter's radius, so every inside corner of the pawl is
 * one the cutter can make. Where there is room the relief is a flatter arch
 * rather than a bite: a circle of the tooth depth's radius, centred below the tip
 * so it passes a quarter of the depth above it — "below" in the PAWL's frame,
 * along its own face, not along the tip's radius, which points diagonally across
 * the pawl and bit halfway through it — shrunk, down to the cutter's radius,
 * wherever it would reach the pivot hole's wall.
 * The tip at the top of the pawl's OWN face is left out of that — the pawl stops
 * at the face line and never straddles it, and a disc there would bite the top
 * off the one face that carries the load.
 *
 * `heel` (radians, 0 for none) raises the back at the nose end: the nose's top
 * corner, swung out that far about the pivot, joins the hull — see `design`.
 * Swung about the pivot it rises on the pivot's side of the face line, so the
 * nose face still runs straight and never overhangs the tooth.
 */
function pawlRings(g: G, f: number, wheelCut: Pt[][], heel: number): Pt[][] {
  const pivot = pivotOf(g, f)
  const boss = ellipseRing(pivot[0], pivot[1], g.W / 2, g.W / 2)
  const B = onFace(f, g.Ro, g.c)
  const pts = [onFace(f, g.Rr - 1, g.c), B, ...boss]
  if (heel > 0) pts.push(rotateAbout([B], pivot, -heel)[0])
  const body = hull(pts)
  const tips: Pt[][] = []
  for (let k = 1; k < g.Z; k++) {
    const tip = polar(g.Ro, f - k * g.p)
    const up: Pt = [Math.cos(f), Math.sin(f)]
    // `rise` is how far the arch passes above the tip, `R` its radius; the
    // centre sits R − rise below the tip.
    let rise = Math.max(g.toolR, 0.25 * g.h)
    let R = Math.max(rise, g.h)
    const centre = (): Pt => [tip[0] - (R - rise) * up[0], tip[1] - (R - rise) * up[1]]
    const clear = () => Math.hypot(centre()[0] - pivot[0], centre()[1] - pivot[1]) - R >= g.pinR + PIN_WALL
    while (!clear() && R > rise + 1e-9) R = Math.max(rise, R - 0.25)
    while (!clear() && rise > g.toolR + 1e-9) { rise = Math.max(g.toolR, rise - 0.25); R = rise }
    const [x, y] = centre()
    tips.push(ellipseRing(x, y, R, R))
  }
  const keepOut = boolRings('union', inflateRings(wheelCut, g.c), tips)
  return boolRings('difference', [body], keepOut)
}

export type RatchetPartKey = 'wheel' | 'bore' | 'pawl' | 'pivot' | 'housing'

export interface RatchetPart { key: RatchetPartKey; d: string }

/**
 * Wheel, bore, housing, pawls and pivot holes, each its own path: the wheel and
 * pawls are profiled outside, the housing pocketed into the gear to hold the lot
 * (its wall is the pawls' stop), the pivot holes drilled through the pawls AND
 * the pocket floor.
 */
export function generateRatchetParts(spec: RatchetSpec): RatchetPart[] {
  const g = geometry(spec)
  const place = (r: Pt[]) => r.map(([x, y]) => [spec.cx + g.mirror * x, spec.cy + y] as Pt)
  const out: RatchetPart[] = []

  const wheel = cutWheel(g)
  out.push({ key: 'wheel', d: wheel.map((r) => ringToD(place(r), true)).join(' ') })

  const boreR = clamp(spec.bore / 2, 0, g.Rr - 1)
  if (boreR > 0.25) out.push({ key: 'bore', d: ringToD(place(ellipseRing(0, 0, boreR, boreR)), false) })

  const pawls: string[] = []
  const pivots: string[] = []
  const pr = clamp(spec.pivotDia / 2, 0, g.W / 2 - 0.5)
  const { housingR, heel } = design(g)
  out.push({ key: 'housing', d: ringToD(place(ellipseRing(0, 0, housingR, housingR)), false) })
  for (const f of g.faces) {
    pawls.push(...pawlRings(g, f, wheel, heel).map((r) => ringToD(place(r), true)))
    if (pr > 0.1) {
      const [x, y] = pivotOf(g, f)
      pivots.push(ringToD(place(ellipseRing(x, y, pr, pr)), false))
    }
  }
  out.push({ key: 'pawl', d: pawls.join(' ') })
  if (pivots.length) out.push({ key: 'pivot', d: pivots.join(' ') })
  return out
}

/** Every part in one compound path — the live drag preview. */
export function generateRatchetD(spec: RatchetSpec): string {
  return generateRatchetParts(spec).map((p) => p.d).join(' ')
}
