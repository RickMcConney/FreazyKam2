// ─── BRIO-compatible wooden train track ──────────────────────────────────────
//
// A straight or a curved piece of toy railway, cut flat from 12 mm stock: the
// outline (with the pegs on it and the sockets bitten out of it) and the two
// grooves the wheel flanges run in.
//
// The published dimensions (woodenrailway.info/track/brio-track-guide) are:
//
//   body      40 mm wide, 12 mm thick
//   grooves   6 mm wide, 3 mm deep, 20 mm apart — 26 mm centre to centre
//   male      an 11.5 mm peg on a 7 mm long neck
//   female    15–17 mm across with a 5 mm long throat
//   curves    eight 45° arcs to a circle
//
// A TURNOUT is the union of a straight leg and a branch that leaves the same toe
// face on a tangent, and it is a PASSIVE switch — there are no moving points, so
// both routes are grooved right through and the flange takes whichever groove it
// rolls into. That is why the throat and the frog look like mistakes and are not:
// at the toe the straight groove and the branch's inner groove come out of the
// same slot and peel apart over the first few centimetres, and at the frog the
// branch's OUTER groove crosses the straight's inner one outright. Both are what
// the real piece does. What is NOT allowed to stay as it comes out of the union
// is the crotch where the two legs part — a 41° notch at the standard numbers,
// which no round bit cuts and which is a feather edge of short grain on both
// sides. It gets a `crotch` fillet, by the same morphological closing the cutting
// board blends its handle with.
//
// **THE JOINT IS THE WHOLE POINT, AND IT IS A LOOSE ONE.** The peg is much
// smaller than the socket on purpose: the slack is what lets a joint be pulled a
// couple of millimetres apart and bent a few degrees without the cars coming off,
// which is how a floor layout survives a child. So the socket is NOT a separate
// standard to be typed in — it is derived from the peg plus two clearances, and
// the hole is centred on where a butted peg's head lands. That makes the fit
// impossible to get wrong by editing one number and forgetting the other, and it
// is why `clearance` is the parameter while socket Ø, throat width and throat
// length are readouts. ONE number does both slacks: the head in the hole and the
// neck in the throat are the same joint and want the same fit, and two numbers
// for it were two ways to say the same thing and one more to get wrong.
//
// **THE PEG'S NECK RUNS ALL THE WAY TO THE HEAD'S CENTRE, not to its edge.**
// `neckL` is the VISIBLE neck — face to where the head starts — so the head sits
// at `neckL + pegDia/2` and the rectangle that makes the neck is drawn out to
// that same point. Stopped at `neckL` the rectangle would meet the circle at
// exactly one point and the union would be a bar and a disc touching at a
// corner; run through to the centre it is a bone. Same trick for the throat.
//
// **THE GROOVE IS EMITTED AS A SEPARATE PART, and as a CENTRELINE.** It is the
// open polyline down the middle of each groove: cut it with a 6 mm bit in one
// pass and the width is right by construction, and the bit sweeping past the end
// face carries the groove out to it, which is why nothing needs a lead-in. So
// the piece states no groove width at all — the width IS the cutter, and the
// only thing the drawing owes it is where its middle runs. Different tool,
// different operation from the outline, which is the same reason the gear hands
// over parts rather than one compound path.
//
// **THE ROW IS MEASURED FROM THE END FACE, ONE PITCH IN, so that the JOINT
// ITSELF READS AS A MARK.** Marks sit at one pitch, two pitches, three pitches
// from the face, and the last one stands a pitch back from the far face — so two
// pieces butted together carry the rhythm across the joint with no break in it,
// and the line where they meet does the work of the mark that would have been
// there. That is the whole reason the row is not centred on the piece: centred,
// every joint in a layout is a gap of its own width, and the eye finds it.
//
// A mark that meets a SOCKET is not dropped — it is cut by the hole and comes
// out as the two pieces of it that are still in wood, which is what the clip
// does with everything else. Dropped, it leaves a gap of two pitches at one end
// of the piece and that is the one thing this layout exists to avoid.
//
// **A MARK RUNS EDGE TO EDGE, IN ONE UNBROKEN LINE.** It is not broken at the
// grooves and it is not held off the profile: a sleeper crosses the whole track
// and the mark says so, for one plunge. Where it passes a groove the bit is over
// a 3 mm hole and cuts nothing, so what appears in the wood is the two bands
// outboard of the rails and the spine between them — which is the same cut as
// stopping and restarting at every groove edge, with four fewer plunges in it.
// Trimmed back to the bands it becomes a row of ticks floating in a 4 mm strip,
// which is what the first cut of this did.
//
// A track is SCALE-LOCKED. Every number in it is a fit against pieces made by
// somebody else — a track scaled to 90% is a very good drawing of something that
// connects to nothing.

import { type Pt, arcInto, boolRings, ccw, clamp, ellipseRing, fmt, ringToD, roundConcave } from './polyOps'

export type TrackKind = 'straight' | 'curve' | 'turnout'
/** Which side a turnout's branch leaves on. A mirror would do it, but a
 *  mirrored path loses its shapeParams and stops being a turnout. */
export type TrackHand = 'left' | 'right'
/** What each end carries. `plain` is a square end — a buffer stop, or a blank to
 *  cut a joint into by hand. */
export type TrackEnd = 'male' | 'female' | 'plain'

export interface TrackSpec {
  cx: number; cy: number
  kind: TrackKind
  /** Straight and turnout: body length FACE TO FACE, which is also what the piece
   *  adds to a layout — the peg lives inside its neighbour's socket. On a turnout
   *  it is the STRAIGHT leg, so the piece drops in where an A-track was. */
  length: number
  /** Curve and turnout: radius to the track's CENTRELINE, not to either edge. */
  radius: number
  /** Curve and turnout: the arc it turns through. 45° puts eight to a circle. */
  sweepDeg: number
  /** Turnout only: which side the branch leaves on. */
  hand: TrackHand
  /** Turnout only: fillet in the crotch where the two legs part. */
  crotch: number
  /** Across the piece. 40 on real track. */
  width: number
  /** Groove centre to groove centre. 26 on real track. */
  gauge: number
  /** The low-X (straight) or low-angle (curve) end; a turnout's TOE. */
  endA: TrackEnd
  /** The far end; a turnout's straight heel. */
  endB: TrackEnd
  /** Turnout only: the branch's heel. */
  endC: TrackEnd
  /** Peg head diameter. */
  pegDia: number
  /** Peg neck width. */
  neckW: number
  /** VISIBLE neck: the end face to where the head starts. */
  neckL: number
  /** The slack in the joint, and the only number that sets it: the socket's
   *  radius over the peg head's, and the throat's half-width over the neck's. */
  clearance: number
  /** Engrave the sleeper marks right across the run. */
  treads: boolean
  /** Mark to mark along the run, and the standoff from each end face with it —
   *  which is what carries the row across a joint unbroken. */
  treadPitch: number
}

/** Real BRIO, for the panel defaults and for anyone resetting a piece back to
 *  the standard. Thickness and groove depth are cut depths, not geometry, so
 *  they are here to be quoted rather than drawn. */
export const BRIO = {
  width: 40, thickness: 12,
  grooveW: 6, grooveDepth: 3, gauge: 26,
  pegDia: 11.5, neckW: 6, neckL: 7,
  /** One slack for both halves of the joint. Real BRIO is 2.25 radial and 1 per
   *  side — a Ø16 hole and an 8 mm throat — which two numbers can hit and one
   *  cannot; at 2 the hole comes out Ø15.5 and the throat 10 wide, and the peg
   *  still goes in with room to be pulled and bent. */
  clearance: 2,
  radius: 182, sweepDeg: 45,
  /** Enough to take the notch off the crotch without bridging the two heels. */
  crotch: 6,
  /** The catalogue straights: mini, middle, short, medium, long. */
  lengths: [54, 72, 108, 144, 216],
  /** Sleeper marks, measured off a real 216 long straight: 12 apart, which is
   *  also the standoff from each end face. */
  treadPitch: 12,
} as const

/** How far a feature reaches into the body before the boolean, so a union or a
 *  difference never runs along a coincident edge. */
const EMBED = 0.5

/** The shortest piece of a tread mark worth emitting. Below this it is a tick
 *  the length of the bit that cuts it — a dot on the canvas and a plunge in the
 *  G-code — so a band that has been clipped down to nothing drops out entirely
 *  rather than being drawn as a blemish. */
const MIN_TREAD = 0.5

/** The joint slack, made safe. A `.fkam` saved when the hole and the throat had
 *  a clearance each carries neither name, so it falls back to the standard
 *  rather than to NaN — and a socket sized NaN is a piece with no socket. */
function clearanceOf(s: TrackSpec): number {
  // Only a MISSING figure falls back. A negative one is a legitimate thing to
  // draw — it is an interference fit, and the joint test uses it to prove that
  // asking clipper whether two butted pieces overlap can answer yes.
  return Number.isFinite(s.clearance) ? s.clearance : BRIO.clearance
}

/** The tread pitch, made safe. A `.fkam` saved before the marks existed has no
 *  figure for it, and a track loaded out of one has to be able to have them
 *  turned on without the piece coming back blank — so a missing or nonsense
 *  figure falls back to the standard rather than to NaN. */
function treadPitch(s: TrackSpec): number {
  return Number.isFinite(s.treadPitch) && s.treadPitch > 0 ? s.treadPitch : BRIO.treadPitch
}

/**
 * Where the marks go along one leg: one pitch in from the face, and every pitch
 * after that until one pitch short of the far face. Measured from the face and
 * not spread over the piece — that is what makes the joint between two pieces
 * land where a mark would have been, so a layout marks out unbroken. Nothing
 * displaces a mark: one that meets a socket is cut by the hole like any other
 * feature, since losing it would leave a two-pitch gap at that end.
 */
function stations(s: TrackSpec, len: number, from = 0): number[] {
  const pitch = treadPitch(s)
  const out: number[] = []
  for (let k = 1; k * pitch <= len - pitch + 1e-9; k++) {
    if (k * pitch >= from) out.push(k * pitch)
  }
  return out
}

/** Every station on the piece — both legs of a turnout — which is what the panel
 *  counts. Built from the same function that lays the marks, so the readout
 *  cannot say one thing while the geometry does another. */
function allStations(s: TrackSpec): number[] {
  if (!s.treads) return []
  if (s.kind === 'curve') return stations(s, curveRadius(s) * curveSweep(s))
  const straight = stations(s, Math.max(1, s.length))
  if (s.kind !== 'turnout') return straight
  const R = curveRadius(s)
  // The branch is measured round its own arc, and may not start before the frog.
  const frogArc = R * Math.asin(clamp(Math.sqrt(2 * R * s.gauge) / (R + s.gauge / 2), -1, 1))
  return [...straight, ...stations(s, R * curveSweep(s), frogArc)]
}

// ─── Dimensions and fit ───────────────────────────────────────────────────────

export interface TrackDims {
  /** Face to face (straight) or along the centreline arc (curve). */
  bodyLength: number
  /** What one piece advances a layout: the length, or a curve's chord. */
  pitch: number
  /** The whole extent along the run, pegs included — what the stock must hold. */
  overall: number
  innerRadius: number
  outerRadius: number
  /** 360/sweep — how many of this piece make a circle. */
  perCircle: number
  closesCircle: boolean
  /** End face to the head's centre; the socket's hole is centred here too. */
  headCentre: number
  /** End face to the tip of the peg. */
  pegReach: number
  socketDia: number
  throatW: number
  /** End face to the front of the hole — the published "throat length". */
  throatL: number
  /** End face to the back of the hole. */
  socketDepth: number
  /** Slack of the head in the hole, radial. */
  headClearance: number
  /** Slack of the neck in the throat, per side. */
  neckClearance: number
  /** Groove's outer edge to the edge of the track — the outer flange. 4 on real track. */
  railMargin: number
  /** The hole to the groove's inner edge — what is left of the centre spine. */
  spineMargin: number
  grooveOffTrack: boolean
  socketBreachesGroove: boolean
  socketsTooDeep: boolean
  pegTooThin: boolean

  // ── turnout ──
  /** Toe face to the frog, along the straight route: where the branch's OUTER
   *  groove crosses the straight's inner one. √(2·R·gauge) — it depends on the
   *  gauge, not on the sweep, so a shallower branch does not move it. */
  frogDist: number
  /** How far round the branch the frog sits — the sweep must reach past it or
   *  the piece ends in the middle of the crossing. */
  frogDeg: number
  /** How far the branch has stepped sideways by its heel. */
  divergeOffset: number
  /** The straight leg stops before the routes have finished crossing. */
  frogPastEnd: boolean
  /** The branch is cut off before the frog — the two routes never separate. */
  frogPastSweep: boolean
  /** The two heels are still in each other's stock. */
  heelsFoul: boolean

  // ── treads ──
  /** How many sleeper marks the piece carries, both legs of a turnout counted. */
  treadCount: number
  /** Mark to mark — the pitch, made safe; nothing is stretched to fit. */
  treadSpacing: number
  /** The marks are closer together than they are long — a hatch, not sleepers. */
  treadsCrowded: boolean
}

export function trackDims(s: TrackSpec): TrackDims {
  const half = s.gauge / 2
  // The flange slot is the CUTTER's width, not the drawing's — the piece states
  // no groove width — so the standard one is what the fit readouts are quoted
  // against, the same way thickness and groove depth are.
  const hw = BRIO.grooveW / 2
  const headCentre = s.neckL + s.pegDia / 2
  const clear = clearanceOf(s)
  const socketDia = s.pegDia + 2 * clear
  const throatW = s.neckW + 2 * clear
  const sweep = curveSweep(s)
  const R = curveRadius(s)

  // A turnout is quoted on its MAIN route: that is the run it substitutes for in
  // a layout, and the branch is described by its radius and sweep like any curve.
  const bodyLength = s.kind === 'curve' ? R * sweep : s.length
  const pitch = s.kind === 'curve' ? 2 * R * Math.sin(sweep / 2) : s.length
  const pegReach = s.neckL + s.pegDia
  const socketDepth = headCentre + socketDia / 2
  const ends = s.kind === 'turnout' ? [s.endA, s.endB, s.endC] : [s.endA, s.endB]
  // The branch's outer groove sits at R + gauge/2 from a centre `radius` off the
  // straight route, and crosses the straight's inner groove where that circle
  // meets y = gauge/2 — which reduces to √(2·R·gauge), the sweep playing no part.
  const frogDist = Math.sqrt(2 * R * s.gauge)
  const frogDeg = (Math.asin(clamp(frogDist / (R + s.gauge / 2), -1, 1)) * 180) / Math.PI
  const divergeOffset = R * (1 - Math.cos(sweep))

  // Counted off the same layout the marks are cut from, both legs of a turnout
  // included — so the readout cannot say one thing while the piece does another.
  const treadN = allStations(s).length
  const railMargin = s.width / 2 - half - hw

  return {
    bodyLength,
    pitch,
    overall: pitch + [s.endA, s.endB].filter((e) => e === 'male').length * pegReach,
    innerRadius: R - s.width / 2,
    outerRadius: R + s.width / 2,
    perCircle: 360 / Math.max(1e-6, s.sweepDeg),
    closesCircle: Math.abs(360 / Math.max(1e-6, s.sweepDeg) - Math.round(360 / Math.max(1e-6, s.sweepDeg))) < 1e-6,
    headCentre,
    pegReach,
    socketDia,
    throatW,
    throatL: headCentre - socketDia / 2,
    socketDepth,
    headClearance: clear,
    neckClearance: clear,
    railMargin,
    spineMargin: half - hw - socketDia / 2,
    grooveOffTrack: half + hw > s.width / 2,
    socketBreachesGroove: socketDia / 2 > half - hw || throatW / 2 > half - hw,
    socketsTooDeep: ends.filter((e) => e === 'female').length * socketDepth > bodyLength,
    // The neck is what the whole joint hangs off — thinner than the head is
    // deep, and it is the grain-short piece that snaps first.
    pegTooThin: s.neckW >= s.pegDia,

    frogDist,
    frogDeg,
    divergeOffset,
    frogPastEnd: s.kind === 'turnout' && frogDist > s.length,
    frogPastSweep: s.kind === 'turnout' && frogDeg > s.sweepDeg,
    // Two end faces inside 40 mm of each other have no stock between them to be
    // two pieces of track, whatever the drawing looks like.
    heelsFoul: s.kind === 'turnout' && divergeOffset < s.width,

    treadCount: treadN,
    treadSpacing: treadPitch(s),
    // A mark is the whole width of the track now, so "closer than they are long"
    // is no test at all; the flange slot is the smallest feature on the piece
    // and marks tighter than that stop reading as sleepers.
    treadsCrowded: treadN > 0 && treadPitch(s) < BRIO.grooveW,
  }
}

// ─── Frames ───────────────────────────────────────────────────────────────────
//
// Every connector is drawn in the frame of the end face it sits on: u out along
// the joint's axis (away from the body), v across it. That is the one thing that
// lets a straight and a curve share all of the connector geometry — on a curve
// the axis is the TANGENT at the end, which is what makes a ring of eight pieces
// meet squarely.

interface EndFrame { ox: number; oy: number; ux: number; uy: number }

function place(fr: EndFrame, u: number, v: number): Pt {
  return [fr.ox + u * fr.ux - v * fr.uy, fr.oy + u * fr.uy + v * fr.ux]
}

function curveSweep(s: TrackSpec): number {
  return (clamp(s.sweepDeg, 1, 350) * Math.PI) / 180
}

function curveRadius(s: TrackSpec): number {
  return Math.max(s.width / 2 + 1, s.radius)
}

/**
 * A turnout's branch, in the LEFT-handed frame everything is built in: the toe
 * face is at x=0 with the straight leg running down +x, and the branch curls up
 * from the same face about a centre directly above it. A right-handed piece is
 * this mirrored in y at the very end — the geometry cannot disagree with itself
 * that way, and there is only one of it to get right.
 */
function branchArc(s: TrackSpec) {
  const R = curveRadius(s)
  const sweep = curveSweep(s)
  // Angles about (0, R): the toe end of the branch is straight below its centre.
  return { cy: R, R, sweep, a0: -Math.PI / 2, a1: sweep - Math.PI / 2 }
}

/** Every end the piece has, with what it carries — toe first. */
function connectors(s: TrackSpec): { fr: EndFrame; end: TrackEnd }[] {
  if (s.kind === 'turnout') {
    const { R, sweep } = branchArc(s)
    const L = Math.max(1, s.length)
    return [
      { fr: { ox: 0, oy: 0, ux: -1, uy: 0 }, end: s.endA },
      { fr: { ox: L, oy: 0, ux: 1, uy: 0 }, end: s.endB },
      // The branch's heel, square to its own radial face — so the tangent again.
      {
        fr: {
          ox: R * Math.sin(sweep), oy: R * (1 - Math.cos(sweep)),
          ux: Math.cos(sweep), uy: Math.sin(sweep),
        },
        end: s.endC,
      },
    ]
  }
  if (s.kind === 'straight') {
    const L = Math.max(1, s.length)
    return [
      { fr: { ox: 0, oy: 0, ux: -1, uy: 0 }, end: s.endA },
      { fr: { ox: L, oy: 0, ux: 1, uy: 0 }, end: s.endB },
    ]
  }
  const R = curveRadius(s)
  const sweep = curveSweep(s)
  const a0 = -sweep / 2, a1 = sweep / 2
  return [
    // Out of the low end is the direction of DECREASING angle.
    { fr: { ox: R * Math.cos(a0), oy: R * Math.sin(a0), ux: Math.sin(a0), uy: -Math.cos(a0) }, end: s.endA },
    { fr: { ox: R * Math.cos(a1), oy: R * Math.sin(a1), ux: -Math.sin(a1), uy: Math.cos(a1) }, end: s.endB },
  ]
}

// ─── Rings ────────────────────────────────────────────────────────────────────

function rectRing(x: number, y: number, w: number, h: number): Pt[] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
}

/** An arc, as an open polyline starting on `a0`. */
function arcPoly(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  const out: Pt[] = [[cx + r * Math.cos(a0), cy + r * Math.sin(a0)]]
  arcInto(out, cx, cy, r, r, a0, a1)
  return out
}

/** An annular sector — the shape of every curved leg here. */
function sectorRing(cx: number, cy: number, ri: number, ro: number, a0: number, a1: number): Pt[] {
  const ring = arcPoly(cx, cy, ri, a0, a1)
  ring.push([cx + ro * Math.cos(a1), cy + ro * Math.sin(a1)])
  arcInto(ring, cx, cy, ro, ro, a1, a0)
  return ccw(ring)
}

function bodyRings(s: TrackSpec): Pt[][] {
  const hw = s.width / 2
  if (s.kind === 'straight') return [rectRing(0, -hw, Math.max(1, s.length), s.width)]
  if (s.kind === 'curve') {
    const R = curveRadius(s)
    const sweep = curveSweep(s)
    return [sectorRing(0, 0, R - hw, R + hw, -sweep / 2, sweep / 2)]
  }
  const { cy, R, a0, a1 } = branchArc(s)
  const legs = boolRings(
    'union',
    [rectRing(0, -hw, Math.max(1, s.length), s.width)],
    [sectorRing(0, cy, R - hw, R + hw, a0, a1)],
  )
  // The closing fills the crotch with a tangent arc and leaves every convex
  // corner — the end faces included — exactly where it found them, which is why
  // it can run before the pegs and sockets go on without touching them.
  return roundConcave(legs, clamp(s.crotch, 0, hw))
}

/** The bone: a neck run through to the head's centre, unioned with the head. */
function pegRings(fr: EndFrame, s: TrackSpec): Pt[][] {
  const headCentre = s.neckL + s.pegDia / 2
  const hw = s.neckW / 2
  const neck = [
    place(fr, -EMBED, -hw), place(fr, headCentre, -hw),
    place(fr, headCentre, hw), place(fr, -EMBED, hw),
  ]
  const c = place(fr, headCentre, 0)
  const head = ellipseRing(c[0], c[1], s.pegDia / 2, s.pegDia / 2)
  return boolRings('union', [ccw(neck)], [head])
}

/** The keyhole to bite out. Reaches OUT past the face so the notch opens on it. */
function socketRings(fr: EndFrame, s: TrackSpec): Pt[][] {
  const d = trackDims(s)
  const hw = d.throatW / 2
  const throat = [
    place(fr, EMBED, -hw), place(fr, -d.headCentre, -hw),
    place(fr, -d.headCentre, hw), place(fr, EMBED, hw),
  ]
  const c = place(fr, -d.headCentre, 0)
  const hole = ellipseRing(c[0], c[1], d.socketDia / 2, d.socketDia / 2)
  return boolRings('union', [ccw(throat)], [hole])
}

function outlineRings(s: TrackSpec): Pt[][] {
  const ends = connectors(s)
  let rings = bodyRings(s)
  // Every peg first, then every socket: a socket bitten out before a neighbouring
  // peg is unioned on would be partly filled back in by it.
  for (const { fr, end } of ends) {
    if (end === 'male') rings = boolRings('union', rings, pegRings(fr, s))
  }
  for (const { fr, end } of ends) {
    if (end === 'female') rings = boolRings('difference', rings, socketRings(fr, s))
  }
  return rings
}

/** Groove centrelines, as open polylines. They run the full body, face to face:
 *  a flange has to roll across the joint, so a groove that stops short of the
 *  end is a step for it to climb. */
function grooveLines(s: TrackSpec): Pt[][] {
  const half = s.gauge / 2
  const straight = (L: number): Pt[][] => [[[0, half], [L, half]], [[0, -half], [L, -half]]]
  if (s.kind === 'straight') return straight(Math.max(1, s.length))
  if (s.kind === 'curve') {
    const R = curveRadius(s)
    const sweep = curveSweep(s)
    return [arcPoly(0, 0, R + half, -sweep / 2, sweep / 2), arcPoly(0, 0, R - half, -sweep / 2, sweep / 2)]
  }
  // BOTH routes are grooved end to end. A passive switch has no moving points,
  // so a flange has to find a continuous groove whichever way it goes — which
  // means the two pairs share a slot at the throat and cross outright at the
  // frog, and neither may be trimmed back to tidy that up.
  const { cy, R, a0, a1 } = branchArc(s)
  return [
    ...straight(Math.max(1, s.length)),
    arcPoly(0, cy, R - half, a0, a1),
    arcPoly(0, cy, R + half, a0, a1),
  ]
}

// ─── Treads ───────────────────────────────────────────────────────────────────
//
// A sleeper mark is one straight chord drawn clean across the run and then cut
// back to what is solid. Everything the marks have to respect is already a ring
// somebody else built — the body, the sockets, the grooves — so the whole of the
// work is a segment clipped against those, and a curve, a crotch fillet, a peg
// and a socket all come out right without any of them being named here.

/** Even-odd point-in-polygon. Everything clipped against comes out of
 *  `boolRings`, which returns outer rings only, so even-odd and
 *  winding agree and the cheaper of the two will do. */
function inRings(p: Pt, rings: Pt[][]): boolean {
  let inside = false
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]
      const [xj, yj] = r[j]
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** Where a + t·(dx,dy) crosses the edge q0→q1, or null if it misses it. */
function edgeParam(a: Pt, dx: number, dy: number, q0: Pt, q1: Pt): number | null {
  const ex = q1[0] - q0[0], ey = q1[1] - q0[1]
  const den = dx * ey - dy * ex
  if (Math.abs(den) < 1e-12) return null
  const wx = q0[0] - a[0], wy = q0[1] - a[1]
  const t = (wx * ey - wy * ex) / den
  const u = (wx * dy - wy * dx) / den
  return t < 0 || t > 1 || u < 0 || u > 1 ? null : t
}

/**
 * The parts of a→b that lie inside `rings`. Every crossing is a breakpoint; each
 * interval between two of them is wholly in or wholly out, so its MIDPOINT
 * decides the lot — which is what makes this immune to the near-tangent contacts
 * a mark makes with an edge it only grazes.
 */
function clipSegment(a: Pt, b: Pt, rings: Pt[][]): Pt[][] {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const ts = [0, 1]
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const t = edgeParam(a, dx, dy, r[j], r[i])
      if (t !== null) ts.push(t)
    }
  }
  ts.sort((p, q) => p - q)
  const out: Pt[][] = []
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1], t1 = ts[i]
    if (t1 - t0 < 1e-9) continue
    const tm = (t0 + t1) / 2
    if (!inRings([a[0] + dx * tm, a[1] + dy * tm], rings)) continue
    const p0: Pt = [a[0] + dx * t0, a[1] + dy * t0]
    const p1: Pt = [a[0] + dx * t1, a[1] + dy * t1]
    // Two intervals either side of a crossing that changed nothing (an edge the
    // chord grazes) are one piece of mark, and joining them here is what keeps
    // it from being emitted as two lines with a plunge between them.
    const prev = out[out.length - 1]
    if (prev && Math.hypot(prev[1][0] - p0[0], prev[1][1] - p0[1]) < 1e-9) prev[1] = p1
    else out.push([p0, p1])
  }
  return out
}

/** What a mark may be drawn on: the body, with every socket taken out of it.
 *  Nothing is eroded — a sleeper end runs out to the profile and is meant to
 *  touch it. Pegs are not in `bodyRings` at all, which is the answer wanted: a
 *  mark across a peg is a mark across the one part of the piece that has to
 *  slide into somebody else's socket. */
function treadField(s: TrackSpec): Pt[][] {
  let keep = bodyRings(s)
  for (const { fr, end } of connectors(s)) {
    if (end !== 'female') continue
    keep = boolRings('difference', keep, socketRings(fr, s))
  }
  return keep
}

/** The sleeper marks, as open polylines right across the run. */
function treadLines(s: TrackSpec): Pt[][] {
  if (!s.treads) return []
  const keep = treadField(s)
  if (keep.length === 0) return []
  // Drawn PAST both edges of the track and trimmed back to the profile by the
  // clip, so no branch of this has to work out where the wood ends. The grooves
  // are not clipped against at all: one crossed is a hole the bit passes over,
  // and breaking the line there would be the same cut with two more plunges.
  const edge = s.width

  const out: Pt[][] = []
  const add = (a: Pt, b: Pt) => {
    for (const seg of clipSegment(a, b, keep)) {
      if (Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]) >= MIN_TREAD) out.push(seg)
    }
  }
  // v is ACROSS the run in both frames — +y on a straight, outward on a curve —
  // which is what lets one span serve a straight leg and an arc.
  const across = (x: number) => add([x, -edge], [x, edge])
  const radial = (cy: number, R: number, a: number) => {
    const c = Math.cos(a), sn = Math.sin(a)
    add([(R - edge) * c, cy + (R - edge) * sn], [(R + edge) * c, cy + (R + edge) * sn])
  }

  if (s.kind === 'curve') {
    const R = curveRadius(s)
    const sweep = curveSweep(s)
    for (const t of stations(s, R * sweep)) radial(0, R, -sweep / 2 + t / R)
    return out
  }

  const L = Math.max(1, s.length)
  for (const t of stations(s, L)) across(t)
  if (s.kind !== 'turnout') return out

  // The branch gets its own row, but only PAST THE FROG: before it the two
  // routes are still in each other's stock, and a radial mark laid there runs
  // across the straight route at an angle to everything already marked on it.
  const { cy, R, a0, sweep } = branchArc(s)
  const frogArc = (R * trackDims(s).frogDeg * Math.PI) / 180
  for (const t of stations(s, R * sweep, frogArc)) radial(cy, R, a0 + t / R)
  return out
}

// ─── Emission ─────────────────────────────────────────────────────────────────

function shiftRings(rings: Pt[][], dx: number, dy: number): Pt[][] {
  return rings.map((r) => r.map(([x, y]) => [x + dx, y + dy] as Pt))
}

/** A right-hand turnout is the left-hand one flipped, and that is the whole of
 *  the difference — flipping at the end rather than signing every angle is what
 *  keeps the two hands from ever disagreeing. Winding is fixed on emission. */
function mirrorRings(rings: Pt[][]): Pt[][] {
  return rings.map((r) => r.map(([x, y]) => [x, -y] as Pt))
}

function polyToD(pts: Pt[]): string {
  return 'M' + pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L')
}

export interface TrackPart { key: string; d: string }

/**
 * The piece, centred on the OUTLINE's bounding box — the extent the stock has to
 * hold, pegs included, which is the same reading the gear gives for a wheel with
 * a pinion beside it.
 */
export function generateTrackParts(s: TrackSpec): TrackPart[] {
  const flip = s.kind === 'turnout' && s.hand === 'right'
  const outline = flip ? mirrorRings(outlineRings(s)) : outlineRings(s)
  if (outline.length === 0) return []

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const ring of outline) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const dx = s.cx - (minX + maxX) / 2
  const dy = s.cy - (minY + maxY) / 2

  const parts: TrackPart[] = [{
    key: 'body',
    d: shiftRings(outline, dx, dy).map((r) => ringToD(r, true)).join(' '),
  }]

  const raw = grooveLines(s)
  const grooves = shiftRings(flip ? mirrorRings(raw) : raw, dx, dy).map(polyToD)
  if (grooves.length > 0) parts.push({ key: 'groove', d: grooves.join(' ') })

  // Its own part, like the grooves and for the same reason: a sleeper mark is
  // scratched with a V bit a millimetre down and has nothing to do with either
  // the profiled outline or the 3 mm slots. Always open polylines — a mark is a
  // line to follow, never a region to clear.
  const treads = treadLines(s)
  if (treads.length > 0) {
    parts.push({
      key: 'tread',
      d: shiftRings(flip ? mirrorRings(treads) : treads, dx, dy).map(polyToD).join(' '),
    })
  }

  return parts
}

export function generateTrackD(s: TrackSpec): string {
  return generateTrackParts(s).map((p) => p.d).join(' ')
}
