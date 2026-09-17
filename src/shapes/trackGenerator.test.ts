// The only useful question about a piece of track is whether it connects to the
// next one, and neither half of a joint looks wrong on its own — so the fit is
// tested by BUTTING two pieces and asking clipper whether they overlap, the same
// way the inlay is judged. Everything else here is a dimension a workshop would
// measure off the finished piece.

import { describe, it, expect } from 'vitest'
import polygonClipping from 'polygon-clipping'
import { generateTrackParts, trackDims, BRIO, type TrackSpec } from './trackGenerator'
import { flattenPath, signedArea } from '../cam/pathFlattener'

const std: TrackSpec = {
  cx: 0, cy: 0, kind: 'straight', length: 144,
  radius: BRIO.radius, sweepDeg: BRIO.sweepDeg,
  hand: 'left', crotch: BRIO.crotch,
  width: BRIO.width, gauge: BRIO.gauge,
  endA: 'female', endB: 'male', endC: 'male',
  pegDia: BRIO.pegDia, neckW: BRIO.neckW, neckL: BRIO.neckL,
  clearance: BRIO.clearance,
  treads: true, treadPitch: BRIO.treadPitch,
}

function part(s: TrackSpec, key: string): string {
  const p = generateTrackParts(s).find((q) => q.key === key)
  if (!p) throw new Error(`no ${key} part`)
  return p.d
}

function rings(d: string): [number, number][][] {
  return flattenPath(d, 0.02) as [number, number][][]
}

function bbox(d: string) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const r of rings(d)) for (const [x, y] of r) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 }
}

function shift(d: string, dx: number): [number, number][][] {
  return rings(d).map((r) => r.map(([x, y]) => [x + dx, y] as [number, number]))
}

/** Area two outlines have in common — nought for a joint that goes together. */
function overlapArea(a: [number, number][][], b: [number, number][][]): number {
  const out = polygonClipping.intersection(a.map((r) => [r]) as never, b.map((r) => [r]) as never)
  let area = 0
  for (const poly of out) for (const ring of poly) area += Math.abs(signedArea(ring as [number, number][]))
  return area
}

/**
 * Piece 1's peg pushed into piece 2's socket with the end faces touching, which
 * is where a joint sits when the layout is pushed together. The shift is worked
 * out from `pegReach` alone — the two bboxes and the length of the peg — so it
 * is measuring the geometry rather than restating it.
 */
function buttedJoint(s: TrackSpec) {
  const male = { ...s, endA: 'plain' as const, endB: 'male' as const }
  const female = { ...s, endA: 'female' as const, endB: 'plain' as const }
  const dm = trackDims(s)
  const a = part(male, 'body'), b = part(female, 'body')
  const faceOfMale = bbox(a).x1 - dm.pegReach
  return { a: rings(a), b: shift(b, faceOfMale - bbox(b).x0), dm }
}

/**
 * Where the arc centre landed once the piece was re-centred on its own bbox.
 * A sector spanning ±θ/2 reaches `ro` at angle 0 and only `ri·cos(θ/2)` at its
 * ends, so its box gives the centre away in closed form — and on a symmetric
 * piece (both ends alike) the pegs move only the Y extent, which is centred
 * anyway. The test above checks that reading before relying on it.
 */
function arcCentre(s: TrackSpec) {
  const half = ((s.sweepDeg / 2) * Math.PI) / 180
  const ri = s.radius - s.width / 2, ro = s.radius + s.width / 2
  return { x: -(ri * Math.cos(half) + ro) / 2, y: 0 }
}

function rotate(rs: [number, number][][], c: { x: number; y: number }, a: number): [number, number][][] {
  const ca = Math.cos(a), sa = Math.sin(a)
  return rs.map((r) => r.map(([x, y]) => {
    const dx = x - c.x, dy = y - c.y
    return [c.x + dx * ca - dy * sa, c.y + dx * sa + dy * ca] as [number, number]
  }))
}

describe('BRIO track — the published dimensions come out of the generator', () => {
  it('a straight piece is 40 wide and as long as its length plus one peg', () => {
    const b = bbox(part(std, 'body'))
    expect(b.h).toBeCloseTo(40, 3)
    expect(b.w).toBeCloseTo(144 + 18.5, 3)   // 7 mm neck + Ø11.5 head reaches 18.5
  })

  it('the length is the PITCH — face to face, what the piece adds to a layout', () => {
    expect(trackDims(std).pitch).toBeCloseTo(144, 6)
    expect(bbox(part({ ...std, endA: 'plain', endB: 'plain' }, 'body')).w).toBeCloseTo(144, 3)
  })

  it('derives the whole socket from the peg and ONE clearance', () => {
    // The guide's Ø16 hole and 8 mm throat want 2.25 radial and 1 a side, which
    // one number cannot do. At 2 the hole is a hair tighter and the throat a
    // hair looser than the published pair — and the throat is the slack that
    // matters least, being what lets a joint be bent rather than what holds it.
    const dm = trackDims(std)
    expect(dm.socketDia).toBeCloseTo(std.pegDia + 2 * std.clearance, 6)   // 15.5
    expect(dm.throatW).toBeCloseTo(std.neckW + 2 * std.clearance, 6)      // 10
    expect(dm.throatL).toBeCloseTo(5, 6)   // the guide's "5 mm long throat"
    // Editing the one number moves both, which is the point of merging them.
    const loose = trackDims({ ...std, clearance: 3 })
    expect(loose.socketDia - dm.socketDia).toBeCloseTo(2, 6)
    expect(loose.throatW - dm.throatW).toBeCloseTo(2, 6)
  })

  it('the grooves sit 26 apart and leave 4 mm of rail outside each one', () => {
    const dm = trackDims(std)
    expect(dm.railMargin).toBeCloseTo(4, 6)
    const g = bbox(part(std, 'groove'))
    expect(g.y0).toBeCloseTo(-13, 3)
    expect(g.y1).toBeCloseTo(13, 3)
  })

  it('the grooves run the full body, face to face, so a flange crosses the joint', () => {
    expect(bbox(part(std, 'groove')).w).toBeCloseTo(144, 3)
  })

  it('a curve quotes its radius to the CENTRELINE, and eight 45s close a circle', () => {
    const dm = trackDims({ ...std, kind: 'curve' })
    expect(dm.innerRadius).toBeCloseTo(162, 6)
    expect(dm.outerRadius).toBeCloseTo(202, 6)
    expect(dm.perCircle).toBeCloseTo(8, 6)
    expect(dm.closesCircle).toBe(true)
    expect(trackDims({ ...std, kind: 'curve', sweepDeg: 50 }).closesCircle).toBe(false)
  })
})

describe('BRIO track — the outline is one region a profile can follow', () => {
  for (const [name, s] of [
    ['socket and peg', std],
    ['two pegs', { ...std, endA: 'male' as const }],
    ['two sockets', { ...std, endB: 'female' as const }],
    ['curved', { ...std, kind: 'curve' as const }],
  ] as [string, TrackSpec][]) {
    it(`${name} leaves a single closed ring, not a body with a disc beside it`, () => {
      const r = rings(part(s, 'body'))
      expect(r).toHaveLength(1)
      expect(signedArea(r[0])).toBeGreaterThan(0)
    })
  }

  it('emits the grooves and the treads as their own parts — three tools, three parts', () => {
    expect(generateTrackParts(std).map((p) => p.key)).toEqual(['body', 'groove', 'tread'])
    expect(generateTrackParts({ ...std, treads: false }).map((p) => p.key)).toEqual(['body', 'groove'])
  })

  it('emits the grooves as OPEN centrelines — the width is the cutter, not the drawing', () => {
    const line = part(std, 'groove')
    expect(line).not.toContain('Z')
    expect(rings(line)).toHaveLength(2)   // one down each groove, and nothing else
  })
})

describe('BRIO track — the joint', () => {
  it('a peg butted into the next piece’s socket touches nothing', () => {
    const { a, b } = buttedJoint(std)
    expect(overlapArea(a, b)).toBeLessThan(0.01)
  })

  it('and it really is IN the socket — the peg passes the mating end face', () => {
    const { a, b, dm } = buttedJoint(std)
    let maleTip = -Infinity, femaleFace = Infinity
    for (const r of a) for (const [x] of r) maleTip = Math.max(maleTip, x)
    for (const r of b) for (const [x] of r) femaleFace = Math.min(femaleFace, x)
    expect(maleTip - femaleFace).toBeCloseTo(dm.pegReach, 3)
  })

  // The test above passes for a peg that merely misses the wood — including one
  // hanging in free air — so this is the mutation that proves it bites: take the
  // slack out and the two pieces have to foul each other.
  it('and fouls it once the clearances are taken away', () => {
    const tight = { ...std, clearance: -0.5 }
    const { a, b } = buttedJoint(tight)
    expect(overlapArea(a, b)).toBeGreaterThan(1)
  })

  it('gives the head and the neck the SAME slack — one joint, one number', () => {
    const dm = trackDims(std)
    expect(dm.headClearance).toBeCloseTo(std.clearance, 6)
    expect(dm.neckClearance).toBeCloseTo(std.clearance, 6)
  })

  it('holds on a curve too, where the joint runs down the TANGENT', () => {
    const s = { ...std, kind: 'curve' as const }
    const dm = trackDims(s)
    const c = arcCentre(s)
    // The guard on the closed form above: the piece's widest point is a point
    // ON the outer arc, so the bbox really does give the arc centre away.
    expect(bbox(part({ ...s, endA: 'male', endB: 'male' }, 'body')).x1 - c.x).toBeCloseTo(dm.outerRadius, 2)

    // Two pieces in a ring: the second is the first turned by one sweep about
    // the arc centre, which is what laying eight of them on the floor does. A
    // connector cut square to the piece instead of square to the RADIAL face
    // would show up here as an overlap, and nowhere else.
    const male = rings(part({ ...s, endA: 'male', endB: 'male' }, 'body'))
    const female = rings(part({ ...s, endA: 'female', endB: 'female' }, 'body'))
    const turned = rotate(female, c, (s.sweepDeg * Math.PI) / 180)
    expect(overlapArea(male, turned)).toBeLessThan(0.01)

    // …and the peg really does stand on the tangent rather than on the radius:
    // its tip is `pegReach` along the tangent from where the centreline arc
    // meets the end face, which is a different point from `pegReach` along the
    // radius by 3.6 mm at this radius — enough to jam a joint, not enough to
    // see on the canvas.
    // Measured in the end's own frame: how far the piece reaches along the
    // TANGENT past where the centreline meets the face, and how wide it is
    // across that. A peg laid on the radius instead would read short here.
    const a1 = ((s.sweepDeg / 2) * Math.PI) / 180
    const ox = c.x + s.radius * Math.cos(a1), oy = c.y + s.radius * Math.sin(a1)
    const ux = -Math.sin(a1), uy = Math.cos(a1)
    let reach = 0, across = 0
    for (const r of male) for (const [x, y] of r) {
      const u = (x - ox) * ux + (y - oy) * uy
      if (u > reach) reach = u
      if (u > s.neckL) across = Math.max(across, Math.abs(-(x - ox) * uy + (y - oy) * ux))
    }
    expect(reach).toBeCloseTo(dm.pegReach, 1)
    // The head is sampled as an inscribed polyline, so it measures a chord
    // tolerance under Ø rather than over it — never over.
    expect(across * 2).toBeLessThanOrEqual(s.pegDia)
    expect(across * 2).toBeGreaterThan(s.pegDia - 0.2)
  })
})

describe('BRIO track — what the panel warns about', () => {
  it('says nothing at the standard numbers', () => {
    const dm = trackDims(std)
    expect([dm.grooveOffTrack, dm.socketBreachesGroove, dm.socketsTooDeep, dm.pegTooThin]).toEqual([false, false, false, false])
  })

  it('catches a socket cut into the groove when the gauge is closed up', () => {
    expect(trackDims({ ...std, gauge: 20 }).socketBreachesGroove).toBe(true)
  })

  it('catches grooves laid off the edge of a narrow piece', () => {
    expect(trackDims({ ...std, width: 28 }).grooveOffTrack).toBe(true)
  })

  it('catches two sockets meeting in the middle of a short piece', () => {
    expect(trackDims({ ...std, endB: 'female', length: 40 }).socketsTooDeep).toBe(true)
  })
})

// ─── The turnout ──────────────────────────────────────────────────────────────

const tn: TrackSpec = { ...std, kind: 'turnout', endA: 'female', endB: 'male', endC: 'male' }

describe('BRIO track — the turnout is two routes out of one toe', () => {
  it('the toe face is shared: both routes start on the same 26 mm gauge', () => {
    // Each route's grooves must leave the toe face exactly where a butted
    // neighbour's do, or the piece is a switch that nothing feeds. All four
    // start there, in coincident pairs, one gauge apart.
    const s = { ...tn, endA: 'plain' as const }
    const toeX = bbox(part(s, 'body')).x0
    const atToe = rings(part(s, 'groove'))
      .map((l) => l.reduce((m, q) => (q[0] < m[0] ? q : m), l[0]))
      .filter((q) => Math.abs(q[0] - toeX) < 0.01)
      .map((q) => q[1])
      .sort((a, b) => a - b)
    expect(atToe).toHaveLength(4)
    expect(atToe[1] - atToe[0]).toBeCloseTo(0, 6)      // straight + branch, one slot
    expect(atToe[3] - atToe[2]).toBeCloseTo(0, 6)
    expect(atToe[2] - atToe[0]).toBeCloseTo(tn.gauge, 6)
  })

  it('grooves BOTH routes end to end — a passive switch has no moving points', () => {
    expect(rings(part(tn, 'groove'))).toHaveLength(4)
  })

  it('the branch heel stands square to its own radial face, one sweep round', () => {
    const dm = trackDims(tn)
    // The heel's centre is `radius·sin θ` along and `radius·(1−cos θ)` aside,
    // and the peg leaves it on the TANGENT — so the piece reaches that much
    // further again in the branch's own direction.
    const th = (tn.sweepDeg * Math.PI) / 180
    const b = bbox(part(tn, 'body'))
    const reach = tn.radius * Math.sin(th) + dm.pegReach * Math.cos(th)
    expect(dm.divergeOffset).toBeCloseTo(tn.radius * (1 - Math.cos(th)), 6)
    // The straight heel's peg still wins on X, so the branch must not exceed it.
    expect(reach).toBeLessThan(b.x1 - b.x0)
  })

  it('the frog falls out of the GAUGE alone — sweep does not move it', () => {
    expect(trackDims(tn).frogDist).toBeCloseTo(Math.sqrt(2 * tn.radius * tn.gauge), 6)
    expect(trackDims({ ...tn, sweepDeg: 60 }).frogDist).toBeCloseTo(trackDims(tn).frogDist, 6)
    expect(trackDims({ ...tn, radius: 300 }).frogDist).toBeGreaterThan(trackDims(tn).frogDist)
  })

  it('leaves one closed ring, both hands, with or without a crotch fillet', () => {
    for (const hand of ['left', 'right'] as const) {
      for (const crotch of [0, 6, 12]) {
        expect(rings(part({ ...tn, hand, crotch }, 'body'))).toHaveLength(1)
      }
    }
  })

  it('the crotch fillet ADDS material and leaves the end faces alone', () => {
    const plain = { ...tn, endA: 'plain' as const, endB: 'plain' as const, endC: 'plain' as const }
    const area = (c: number) => Math.abs(signedArea(rings(part({ ...plain, crotch: c }, 'body'))[0]))
    expect(area(6)).toBeGreaterThan(area(0))
    expect(area(12)).toBeGreaterThan(area(6))
    // A closing leaves convex corners where it found them, so the main leg is
    // still exactly as long as it was asked to be.
    for (const c of [0, 6, 12]) expect(bbox(part({ ...plain, crotch: c }, 'body')).w).toBeCloseTo(tn.length, 2)
  })

  it('a right turnout is the left one flipped, and nothing else', () => {
    const l = rings(part({ ...tn, hand: 'left' }, 'body'))[0]
    const r = rings(part({ ...tn, hand: 'right' }, 'body'))[0]
    expect(r).toHaveLength(l.length)
    // Same set of points, whichever way round the ring each happens to be wound
    // — so it is nearest-neighbour, not index-by-index.
    const A = l.map(([x, y]) => [x, -y] as [number, number])
    let worst = 0
    for (const [ax, ay] of A) {
      let near = Infinity
      for (const [bx, by] of r) near = Math.min(near, Math.hypot(ax - bx, ay - by))
      worst = Math.max(worst, near)
    }
    expect(worst).toBeLessThan(1e-6)
  })
})

describe('BRIO track — the treads', () => {
  const segs = (s: TrackSpec) => rings(part(s, 'tread'))
  const len = (g: [number, number][]) => Math.hypot(g[1][0] - g[0][0], g[1][1] - g[0][1])
  /** Mark positions along the run, measured from the low end of the body. */
  const xs = (s: TrackSpec) => segs(s).map((t) => t[0][0] - bbox(part(s, 'body')).x0).sort((p, q) => p - q)

  it('runs edge to edge in one unbroken line, across the grooves', () => {
    // Plain ends: no socket to displace a mark, so the row is the plain rule.
    const sq = { ...std, endA: 'plain' as const, endB: 'plain' as const }
    const g = segs(sq)
    expect(g).toHaveLength(trackDims(sq).treadCount)  // ONE line per sleeper
    for (const t of g) {
      expect(t).toHaveLength(2)
      expect(len(t)).toBeCloseTo(sq.width, 3)
      // Both ends ON the profile: a mark held off it is a tick in a strip.
      for (const [, y] of t) expect(Math.abs(y)).toBeCloseTo(sq.width / 2, 3)
    }
  })

  it('stands one pitch off each face, so the joint between two pieces reads as a mark', () => {
    // This is the whole reason the row is measured from the face rather than
    // spread over the piece: butt two together and the last mark, the joint and
    // the first mark of the next are one pitch apart each — the seam does the
    // work of the mark that would have been there, and nothing in a layout
    // shows where one piece stops.
    // 216 is eighteen 12s, so both ends come out at exactly one pitch.
    const sq = { ...std, length: 216, endA: 'plain' as const, endB: 'plain' as const }
    const x = xs(sq)
    expect(x[0]).toBeCloseTo(sq.treadPitch, 3)
    expect(sq.length - x[x.length - 1]).toBeCloseTo(sq.treadPitch, 3)
    for (let i = 1; i < x.length; i++) expect(x[i] - x[i - 1]).toBeCloseTo(sq.treadPitch, 3)
    // A length the pitch does NOT divide is where measuring from the face and
    // spreading over the piece part company: the first mark stays at exactly one
    // pitch and the leftover goes to the far end, where a spread would shorten
    // every gap in the row to make it come out even.
    const odd = { ...sq, length: 200 }
    const xo = xs(odd)
    expect(xo[0]).toBeCloseTo(odd.treadPitch, 3)
    for (let i = 1; i < xo.length; i++) expect(xo[i] - xo[i - 1]).toBeCloseTo(odd.treadPitch, 3)
    expect(odd.length - xo[xo.length - 1]).toBeGreaterThan(odd.treadPitch)
  })

  it('lets a socket CUT its mark rather than losing it — a lost mark is a double gap', () => {
    // The mark a pitch in from a socket face lands on the hole. Dropped, that
    // end of the piece would carry a gap of two pitches, which is the one thing
    // the from-the-face layout exists to avoid; cut, what is left of it is the
    // two pieces still in wood.
    const dm = trackDims(std)
    // Deduped: the mark the socket cuts starts twice, once per piece of it.
    const row = (t: TrackSpec) => [...new Set(xs(t).map((v) => +v.toFixed(4)))]
    expect(row(std)).toEqual(row({ ...std, endA: 'plain' }))   // same row, socket or not
    expect(xs(std)[0]).toBeCloseTo(std.treadPitch, 3)
    expect(xs(std)[0]).toBeLessThan(dm.socketDepth)          // …and it IS on the hole
    // One mark in two pieces: one more cut than there are marks.
    const g = segs(std)
    expect(g).toHaveLength(dm.treadCount + 1)
    const b = bbox(part(std, 'body'))
    const hole: [number, number] = [b.x0 + dm.headCentre, 0]
    for (const t of g) {
      for (let k = 0; k <= 20; k++) {
        const f = k / 20
        const p = [t[0][0] + f * (t[1][0] - t[0][0]), t[0][1] + f * (t[1][1] - t[0][1])]
        // The hole is a sampled polygon (TOL = 0.05), so a cut lands on a chord.
        expect(Math.hypot(p[0] - hole[0], p[1] - hole[1])).toBeGreaterThan(dm.socketDia / 2 - 0.05)
      }
    }
  })

  it('marks the catalogue straights the way a real one is marked', () => {
    // At a 12 pitch, measured off each face. 12 divides every catalogue length
    // bar the 54 mini, so all but that one come out at exactly one pitch from
    // both faces — and each is cut in one more piece than it has marks, the
    // socket taking a bite out of the first.
    for (const [length, marks] of [[216, 17], [144, 11], [108, 8], [72, 5], [54, 3]] as [number, number][]) {
      expect(trackDims({ ...std, length }).treadCount).toBe(marks)
      expect(segs({ ...std, length })).toHaveLength(marks + 1)
    }
  })

  it('leaves the branch unmarked until the routes have parted at the frog', () => {
    // Before the frog the branch is still inside the straight leg's stock, and
    // a radial mark laid there runs across the straight route at an angle to
    // every mark already on it.
    const g = segs(tn)
    const tilted = g.filter((t) => Math.abs(t[1][0] - t[0][0]) > 1e-6)
    expect(tilted.length).toBeGreaterThan(0)      // the branch IS marked
    expect(g.length).toBeGreaterThan(tilted.length) // …and so is the straight leg
    const line = (a: [number, number][], b: [number, number][]) => {
      const [dx1, dy1] = [a[1][0] - a[0][0], a[1][1] - a[0][1]]
      const [dx2, dy2] = [b[1][0] - b[0][0], b[1][1] - b[0][1]]
      const t = ((b[0][0] - a[0][0]) * dy2 - (b[0][1] - a[0][1]) * dx2) / (dx1 * dy2 - dy1 * dx2)
      return [a[0][0] + dx1 * t, a[0][1] + dy1 * t] as [number, number]
    }
    // The branch's centre, recovered the same way the curve's is; the toe of the
    // branch is straight below it, so an angle off that IS how far round the
    // branch a mark sits.
    const c = line(tilted[0], tilted[tilted.length - 1])
    const round = tilted.map((t) => {
      const a = Math.atan2(t[0][1] - c[1], t[0][0] - c[0]) + Math.PI / 2
      return (a * 180) / Math.PI
    })
    const dm = trackDims(tn)
    expect(Math.min(...round)).toBeGreaterThan(dm.frogDeg - 0.5)
    expect(Math.max(...round)).toBeLessThan(tn.sweepDeg + 0.5)
  })

  it('lays them radially on a curve, not square across the chord', () => {
    const cv = { ...std, kind: 'curve' as const, endA: 'plain' as const, endB: 'plain' as const }
    const g = segs(cv)
    expect(g.length).toBeGreaterThan(4)
    // Every mark, produced, goes through one common point — which is what
    // radial MEANS. Parallel marks (the bug this catches) never would.
    const hit = (a: [number, number][], b: [number, number][]) => {
      const [dx1, dy1] = [a[1][0] - a[0][0], a[1][1] - a[0][1]]
      const [dx2, dy2] = [b[1][0] - b[0][0], b[1][1] - b[0][1]]
      const den = dx1 * dy2 - dy1 * dx2
      const t = ((b[0][0] - a[0][0]) * dy2 - (b[0][1] - a[0][1]) * dx2) / den
      return [a[0][0] + dx1 * t, a[0][1] + dy1 * t] as [number, number]
    }
    // The centre is taken from the two marks at the ENDS of the arc, 41° apart,
    // where crossing two lines is well conditioned; every other mark is then
    // asked how far its own line passes from that point. Crossing neighbours
    // instead answers the same question through a nearly-parallel intersection,
    // which moves millimetres for a rounding in the last emitted decimal.
    const c = hit(g[0], g[g.length - 1])
    for (const t of g) {
      const [dx, dy] = [t[1][0] - t[0][0], t[1][1] - t[0][1]]
      const off = Math.abs(dx * (c[1] - t[0][1]) - dy * (c[0] - t[0][0])) / Math.hypot(dx, dy)
      // A mark laid square across the chord instead of radially misses the
      // centre by tens of millimetres at the ends of the arc.
      expect(off).toBeLessThan(0.02)
      // …and each one runs from a groove's edge out to a rim of the arc. Both
      // of those edges are chorded polylines (TOL = 0.05 mm), so a mark on a
      // curve stops a sagitta short of the true arc and no closer.
      const r = t.map(([x, y]) => Math.hypot(x - c[0], y - c[1])).sort((p, q) => p - q)
      expect(Math.abs(r[1] - r[0] - cv.width)).toBeLessThan(0.1)
      expect(Math.abs(r[0] - (cv.radius - cv.width / 2))).toBeLessThan(0.1)
      expect(Math.abs(r[1] - (cv.radius + cv.width / 2))).toBeLessThan(0.1)
    }
  })
})

describe('BRIO track — what the turnout warns about', () => {
  it('says nothing at the standard numbers', () => {
    const dm = trackDims(tn)
    expect([dm.frogPastEnd, dm.frogPastSweep, dm.heelsFoul]).toEqual([false, false, false])
  })

  it('catches a main leg that ends inside the frog', () => {
    expect(trackDims({ ...tn, length: 80 }).frogPastEnd).toBe(true)
  })

  it('catches a branch cut off before the frog, where the routes never part', () => {
    expect(trackDims({ ...tn, sweepDeg: 20 }).frogPastSweep).toBe(true)
  })

  it('catches two heels still inside each other’s stock', () => {
    expect(trackDims({ ...tn, sweepDeg: 30 }).heelsFoul).toBe(true)
    expect(trackDims({ ...tn, sweepDeg: 30 }).divergeOffset).toBeLessThan(tn.width)
  })

  it('leaves the straight-piece warnings alone — they are about the main route', () => {
    const dm = trackDims(tn)
    expect([dm.grooveOffTrack, dm.socketBreachesGroove, dm.socketsTooDeep, dm.pegTooThin]).toEqual([false, false, false, false])
  })
})
