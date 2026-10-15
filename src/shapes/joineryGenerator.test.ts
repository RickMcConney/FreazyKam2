import { describe, it, expect } from 'vitest'
import {
  fingerCount, generateFingerJointParts, generateBoxParts, boxDims, dovetailAssembled, dovetailDims, dovetailWaste,
  bowtieRings, generateBowtieParts, generateDovetailParts, ringsArea,
  type FingerJointSpec, type BoxSpec, type DovetailSpec, type BowtieSpec, type JointPart,
} from './joineryGenerator'
import { boolRings, roundConcave, inflateRings, type Pt } from './polyOps'
import { flattenPath } from '../cam/pathFlattener'
import { pointInPolygon } from '../cam/geom'
import { generateProfile } from '../cam/profile'
import type { Tool } from '../store/toolStore'

/** A part's rings, moved so its bounding box starts at the origin — the panel's own frame. */
function local(part: JointPart | undefined): Pt[][] {
  const rings = flattenPath(part!.d, 0.01) as Pt[][]
  const x0 = Math.min(...rings.flat().map((p) => p[0])), y0 = Math.min(...rings.flat().map((p) => p[1]))
  return rings.map((r) => r.map(([x, y]) => [x - x0, y - y0] as Pt))
}
const part = (parts: JointPart[], key: string) => parts.find((p) => p.key === key)
const solid = (rings: Pt[][], x: number, y: number) => rings.some((r) => pointInPolygon(x, y, r))
const overlap = (a: Pt[][], b: Pt[][]) => ringsArea(boolRings('intersection', a, b))
/** How far proud of `rings` a router with a bit of radius `r` leaves anything — what it
 *  cannot get into, measured as distance, since a difference of two arc polygonisations
 *  is a scatter of micron-thin slivers whose AREA adds up to something. */
function uncuttable(rings: Pt[][], r: number): number {
  let worst = 0
  for (const ring of boolRings('difference', roundConcave(rings, r), rings)) {
    for (const [x, y] of ring) worst = Math.max(worst, distToRings(rings, x, y))
  }
  return worst
}

function distToRings(rings: Pt[][], x: number, y: number): number {
  let best = Infinity
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / l2)) : 0
    best = Math.min(best, Math.hypot(x - a[0] - t * vx, y - a[1] - t * vy))
  }
  return best
}

describe('finger count', () => {
  it('is odd, at least three, and as near the target finger width as an odd count gets', () => {
    expect(fingerCount(100, 20, 6, 3)).toBe(5)
    // 120 / 15 = 8: nine fingers of 13.3 are nearer 15 than seven of 17.1.
    expect(fingerCount(120, 15, 6, 3)).toBe(9)
    expect(fingerCount(30, 20, 6, 3)).toBe(3)
  })

  it('never makes a finger narrower than the board is thick', () => {
    const n = fingerCount(100, 5, 12, 6.35)
    expect(n % 2).toBe(1)
    expect(100 / n).toBeGreaterThanOrEqual(12)
  })
})

describe('finger joint pair', () => {
  const FJ: FingerJointSpec = {
    cx: 0, cy: 0, width: 100, lengthA: 80, lengthB: 70, thickness: 12, fingerW: 20,
    clearance: 0.2, toolDia: 6.35, relief: 'dogbone', cut: 'board',
  }
  const boards = (over: Partial<FingerJointSpec> = {}) => {
    const parts = generateFingerJointParts({ ...FJ, ...over })
    return { A: local(part(parts, 'boardA')), B: local(part(parts, 'boardB')) }
  }
  const seg = 100 / 5

  it('alternates the two boards\' fingers along the joint, each where the other has a notch', () => {
    const { A, B } = boards()
    for (let i = 0; i < 5; i++) {
      const s = (i + 0.5) * seg
      expect(solid(A, s, 80 - 6)).toBe(i % 2 === 0)
      expect(solid(B, s, 70 - 6)).toBe(i % 2 === 1)
    }
  })

  it('cuts each notch exactly as deep as the other board is thick', () => {
    const { A } = boards()
    expect(solid(A, 1.5 * seg, 80 - 12 + 0.05)).toBe(false)
    expect(solid(A, 1.5 * seg, 80 - 12 - 0.05)).toBe(true)
  })

  it('leaves the clearance between a finger and the notch it goes in, half from each board', () => {
    const { A, B } = boards()
    // A's first finger ends at seg − c/2; B's first finger starts at seg + c/2.
    expect(solid(A, seg - 0.1 - 0.01, 80 - 6)).toBe(true)
    expect(solid(A, seg - 0.1 + 0.01, 80 - 6)).toBe(false)
    expect(solid(B, seg + 0.1 - 0.01, 70 - 6)).toBe(false)
    expect(solid(B, seg + 0.1 + 0.01, 70 - 6)).toBe(true)
  })

  for (const relief of ['dogbone', 'tbone'] as const) {
    it(`lets a square finger seat fully in a notch the router leaves round-cornered (${relief})`, () => {
      const { A } = boards({ relief })
      // What the router leaves of A — every inside corner at the bit's radius — against
      // B's second finger standing in A's notch.
      const machined = roundConcave(A, 6.35 / 2)
      const finger: Pt[] = [[seg + 0.1, 80 - 12], [2 * seg - 0.1, 80 - 12], [2 * seg - 0.1, 81], [seg + 0.1, 81]]
      expect(overlap(machined, [finger])).toBeLessThan(0.01)
    })
  }

  it('cutting only the joint, makes each board\'s waste ONE pocket — the notches joined through air past its end', () => {
    const parts = generateFingerJointParts({ ...FJ, cut: 'joint' })
    expect(parts.map((p) => p.key)).toEqual(['jointA', 'jointB'])
    for (const p of parts) expect(flattenPath(p.d, 0.01)).toHaveLength(1)
  })

  it('cutting only the joint, pockets out the notches and leaves the fingers and the board behind them', () => {
    for (const [key, len, finger] of [['jointA', 80, 0], ['jointB', 70, 1]] as const) {
      const waste = local(part(generateFingerJointParts({ ...FJ, cut: 'joint' }), key))
      // Back into the board's own frame: the band reaches `mg` past each side and the end.
      const xs = waste.flat().map((q) => q[0]), ys = waste.flat().map((q) => q[1])
      const mg = (Math.max(...xs) - 100) / 2, top = Math.max(...ys)
      const at = (x: number, y: number) => solid(waste, x + mg, y - len + top - mg)
      for (let i = 0; i < 5; i++) {
        const s = (i + 0.5) * seg
        expect(at(s, len - 6)).toBe(i % 2 !== finger)   // notch: cut; finger: left
        expect(at(s, len - 12 - 1)).toBe(false)          // the board below the joint: untouched
      }
      expect(at(50, len + 1)).toBe(true)                  // past the end: the strip of air
    }
  })

  it('cutting only the joint, an inside profile goes round each board\'s waste in ONE loop', () => {
    const tool = { id: 't', name: 'em', type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25 } as Tool
    for (const p of generateFingerJointParts({ ...FJ, cut: 'joint' })) {
      const segs = generateProfile(p.d, tool, { side: 'inside', depthMM: 12, stepDownMM: 12, direction: 'climb', safeHeightMM: 5 })
      // One plunge in from safe height and one retract at the end — nothing in between.
      expect(segs.filter((m) => m.rapid && m.z > 0)).toHaveLength(2)
    }
  })

  it('without a relief the router\'s round corners hold the finger off the bottom', () => {
    const { A } = boards({ relief: 'none' })
    const finger: Pt[] = [[seg + 0.1, 80 - 12], [2 * seg - 0.1, 80 - 12], [2 * seg - 0.1, 81], [seg + 0.1, 81]]
    expect(overlap(roundConcave(A, 6.35 / 2), [finger])).toBeGreaterThan(1)
  })
})

describe('finger-joint box', () => {
  const BOX: BoxSpec = {
    cx: 0, cy: 0, w: 150, d: 100, h: 80, inside: false, thickness: 6, fingerW: 15,
    clearance: 0.1, toolDia: 3.175, relief: 'dogbone', lid: true,
  }

  it('makes six panels with a lid and five without', () => {
    expect(generateBoxParts(BOX).map((p) => p.key).sort()).toEqual(['back', 'bottom', 'front', 'left', 'right', 'top'])
    expect(generateBoxParts({ ...BOX, lid: false }).map((p) => p.key).sort()).toEqual(['back', 'bottom', 'front', 'left', 'right'])
  })

  it('gives every corner cube to the front or back and to no other panel', () => {
    const parts = generateBoxParts(BOX)
    const { w, d, h } = boxDims(BOX).outer
    const front = local(part(parts, 'front')), back = local(part(parts, 'back'))
    const bottom = local(part(parts, 'bottom')), top = local(part(parts, 'top'))
    const left = local(part(parts, 'left')), right = local(part(parts, 'right'))
    const corners = (a: number, b: number) => [[3, 3], [a - 3, 3], [3, b - 3], [a - 3, b - 3]]
    for (const [x, y] of corners(w, h)) { expect(solid(front, x, y)).toBe(true); expect(solid(back, x, y)).toBe(true) }
    for (const [x, y] of corners(w, d)) { expect(solid(bottom, x, y)).toBe(false); expect(solid(top, x, y)).toBe(false) }
    for (const [x, y] of corners(d, h)) { expect(solid(left, x, y)).toBe(false); expect(solid(right, x, y)).toBe(false) }
  })

  it('notches each edge where its mate keeps a finger — the front against the bottom', () => {
    const parts = generateBoxParts(BOX)
    const { nW } = boxDims(BOX)
    const W = boxDims(BOX).outer.w, seg = W / nW
    const front = local(part(parts, 'front')), bottom = local(part(parts, 'bottom'))
    for (let i = 1; i < nW - 1; i++) {
      const s = (i + 0.5) * seg
      expect(solid(front, s, 3)).not.toBe(solid(bottom, s, 3))
    }
  })

  it('sizes from the inside by adding the walls — and the bottom and lid to the height', () => {
    expect(boxDims({ ...BOX, inside: true }).outer).toEqual({ w: 162, d: 112, h: 92 })
    expect(boxDims({ ...BOX, inside: true, lid: false }).outer.h).toBe(86)
    expect(boxDims({ ...BOX, inside: true }).inner).toEqual({ w: 150, d: 100, h: 80 })
  })

  it('draws plain panels, not nothing, when the box is too small for its walls', () => {
    const parts = generateBoxParts({ ...BOX, w: 8 })
    expect(boxDims({ ...BOX, w: 8 }).tooSmall).toBe(true)
    expect(parts).toHaveLength(6)
  })
})

describe('edge dovetails', () => {
  const DV: DovetailSpec = {
    cx: 0, cy: 0, length: 200, depthA: 40, depthB: 40, tails: 4, tailW: 30, tailDepth: 20,
    angleDeg: 14, clearance: 0.15, toolDia: 6.35,
  }
  const { panelA, panelB } = dovetailAssembled(DV)

  it('does not overlap where the panels assemble', () => {
    expect(overlap(panelA, panelB)).toBeLessThan(0.01)
  })

  it('leaves exactly the clearance between them all along the tails', () => {
    let lo = Infinity, hi = 0
    for (const ring of panelB) for (const [x, y] of ring) {
      if (x < 1 || x > 199 || y > DV.tailDepth + 1) continue
      const d = distToRings(panelA, x, y)
      lo = Math.min(lo, d); hi = Math.max(hi, d)
    }
    expect(lo).toBeGreaterThan(DV.clearance - 0.02)
    expect(hi).toBeLessThan(DV.clearance + 0.02)
  })

  it('locks: B overhangs each tail at the seam, so the panels cannot be pulled straight apart', () => {
    // 5 mm up, clear of the fillet at the tail's root: B stands just outside the tail's
    // flank there, at an x the tail's own wider end covers further in.
    const neck = dovetailDims(DV).neck, flare = Math.tan(DV.angleDeg * Math.PI / 180)
    for (let i = 0; i < 4; i++) {
      const x = (i + 0.5) * 50 + neck / 2 + 5 * flare + DV.clearance + 0.5
      expect(solid(panelB, x, 5)).toBe(true)
      expect(solid(panelA, x, DV.tailDepth - 3)).toBe(true)
    }
  })

  it('has no inside corner on either panel that the bit cannot cut', () => {
    expect(uncuttable(panelA, 0.98 * DV.toolDia / 2)).toBeLessThan(0.02)
    expect(uncuttable(panelB, 0.98 * DV.toolDia / 2)).toBeLessThan(0.02)
  })

  it('cutting only the joint, pockets each panel\'s waste and nothing of the panel', () => {
    const { jointA, jointB } = dovetailWaste(DV, panelA, panelB)
    expect(jointA).toHaveLength(1)
    expect(jointB).toHaveLength(1)
    expect(overlap(jointA, panelA)).toBeLessThan(0.01)
    expect(overlap(jointB, panelB)).toBeLessThan(0.01)
    for (let i = 0; i < 4; i++) {
      const mid = (i + 0.5) * 50
      expect(solid(jointA, mid + 25, DV.tailDepth / 2)).toBe(true)   // between two tails: A's waste
      expect(solid(jointB, mid, DV.tailDepth / 2)).toBe(true)        // a socket: B's waste
      expect(solid(jointA, mid, -DV.toolDia - 3)).toBe(false)        // A's body behind the seam
      expect(solid(jointB, mid + 25, DV.tailDepth + DV.toolDia + 3)).toBe(false)   // B's body behind the sockets
    }
  })

  it('makes joint pockets by default, and whole panels only when asked', () => {
    expect(generateDovetailParts(DV).map((p) => p.key)).toEqual(['jointB', 'jointA'])
    expect(generateDovetailParts({ ...DV, cut: 'board' }).map((p) => p.key)).toEqual(['panelB', 'panelA'])
  })
})

describe('bowtie keys', () => {
  const BT: BowtieSpec = { cx: 0, cy: 0, length: 60, width: 30, waist: 12, clearance: 0.15, toolDia: 6.35, style: 'straight' }
  const { key, socket } = bowtieRings(BT)

  it('fits the key in its socket with the clearance all round', () => {
    expect(ringsArea(boolRings('difference', key, socket))).toBeLessThan(0.01)
    let worst = 0
    for (const [x, y] of socket[0]) worst = Math.max(worst, distToRings(key, x, y))
    expect(worst).toBeLessThan(BT.clearance + 0.02)
  })

  it('has no inside corner on the key or the socket that the bit cannot cut', () => {
    expect(uncuttable(key, 0.98 * BT.toolDia / 2)).toBeLessThan(0.02)
    expect(uncuttable(socket, 0.98 * BT.toolDia / 2)).toBeLessThan(0.02)
  })

  it('lays the key out clear of the socket, so one bit can cut round both', () => {
    const parts = generateBowtieParts(BT)
    const s = flattenPath(part(parts, 'socket')!.d, 0.01).flat(), k = flattenPath(part(parts, 'key')!.d, 0.01).flat()
    expect(Math.min(...k.map((p) => p[0])) - Math.max(...s.map((p) => p[0]))).toBeGreaterThan(2 * BT.toolDia)
  })

  it('is one sharp six-cornered outline for the Inlay operation with a V-bit', () => {
    const parts = generateBowtieParts({ ...BT, style: 'vbit' })
    expect(parts.map((p) => p.key)).toEqual(['outline'])
    expect(flattenPath(parts[0].d, 0.01)[0].length).toBeLessThanOrEqual(7)
  })

  it('a socket is the key grown by the clearance, so a key never jams in it', () => {
    expect(ringsArea(boolRings('difference', inflateRings(key, BT.clearance - 0.02), socket))).toBeLessThan(0.01)
  })
})
