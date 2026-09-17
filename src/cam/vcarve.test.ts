import { describe, it, expect } from 'vitest'
import { generateVCarve } from './vcarve'
import { classifySubpaths, pointInPolygon, ptSegDistSq, toolRadiusAtHeight, includedAngleDeg } from './geom'
import { flattenPath } from './pathFlattener'
import type { MotionSegment } from '../store/toolpathStore'
import type { Pt2 } from './pathFlattener'
import type { Tool } from '../store/toolStore'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// The V-bit's own vbitAngleDeg is deliberately never read by the generator —
// the operation form passes the angle through VCarveParams.angleDeg.
const vbit = (vbitAngleDeg = 90): Tool => ({
  id: 'vb', name: 'V-Bit', type: 'vbit', diameterMM: 12.7, fluteCount: 2, rpm: 18000,
  xyFeedMmMin: 2000, zFeedMmMin: 400, maxDepthMM: 10, vbitAngleDeg,
})

// 40 × 10 mm rectangle. Medial axis = a horizontal ridge y=5 from (5,5) to (35,5)
// at inscribed radius 5, plus four 45° branches out to the sharp corners (r=0).
const RECT_40x10 = 'M 0 0 L 40 0 L 40 10 L 0 10 Z'

// 40 × 40 square with a concentric 20 × 20 hole: a constant 10 mm wide wall,
// so the medial axis is a closed rectangular loop at inscribed radius 5.
const ANNULUS = 'M 0 0 L 40 0 L 40 40 L 0 40 Z M 10 10 L 10 30 L 30 30 L 30 10 Z'
const HOLE_20x20 = 'M 10 10 L 10 30 L 30 30 L 30 10 Z'

// 40 × 20 rounded rectangle, corner radius 5 — no sharp corners anywhere.
// Medial axis = spine (10,10)→(30,10) at r=10, plus branches to the four arc centres at r=5.
const ROUNDRECT_40x20_R5 =
  'M 5 0 L 35 0 A 5 5 0 0 1 40 5 L 40 15 A 5 5 0 0 1 35 20 L 5 20 A 5 5 0 0 1 0 15 L 0 5 A 5 5 0 0 1 5 0 Z'

const cuts = (segs: MotionSegment[]) => segs.filter(s => !s.rapid)
const minZ = (segs: MotionSegment[]) => Math.min(...segs.map(s => s.z))
const at = (segs: MotionSegment[], x: number, y: number, tol = 0.02) =>
  segs.filter(s => Math.abs(s.x - x) < tol && Math.abs(s.y - y) < tol)
/** Cutting moves passing through (x, y) — excludes the safe-height rapids at the same XY. */
const cutAt = (segs: MotionSegment[], x: number, y: number, tol = 0.02) => cuts(at(segs, x, y, tol))
/** Depth of the cutting moves at (x, y); fails the caller's expectation if the point is missing. */
const depthAt = (segs: MotionSegment[], x: number, y: number, tol = 0.02) => {
  const hits = cutAt(segs, x, y, tol)
  return hits.length ? Math.min(...hits.map(s => s.z)) : NaN
}

// ─── Depth mapping: Z = −min(zStart + r / tan(θ/2), maxDepth) ─────────────────

describe('generateVCarve — depth from medial-axis radius', () => {
  it('cuts the ridge of a 40×10 rectangle at the inscribed radius with a 90° bit', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })

    // tan(45°) = 1, so a 5 mm inscribed radius maps 1:1 to 5 mm of depth.
    expect(minZ(segs)).toBeCloseTo(-5, 6)

    // Ridge endpoints sit one radius in from the short walls.
    expect(depthAt(segs, 5, 5)).toBeCloseTo(-5, 6)
    expect(depthAt(segs, 35, 5)).toBeCloseTo(-5, 6)

    // Sharp corners have zero inscribed radius → the tip just grazes the surface.
    for (const [cx, cy] of [[0, 0], [40, 0], [0, 10], [40, 10]] as const) {
      expect(cutAt(segs, cx, cy).length).toBeGreaterThan(0)
      expect(depthAt(segs, cx, cy)).toBeCloseTo(0, 6)
    }
  })

  it('scales depth by 1/tan(halfAngle) for a 60° bit', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 60, maxDepthMM: 20, islandDs: [],
    })
    // r / tan(30°) = 5 / 0.57735 = 8.6603 mm
    expect(minZ(segs)).toBeCloseTo(-5 / Math.tan(Math.PI / 6), 6)
  })

  it('reads the angle from params, not from the tool', async () => {
    const wrongAngleTool = vbit(30) // tool says 30°, params say 90°
    const segs = await generateVCarve(RECT_40x10, wrongAngleTool, {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(minZ(segs)).toBeCloseTo(-5, 6) // 90° result, not the 30° one (−18.66)
  })

  it('clamps to maxDepthMM without flattening the shallow ends', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 60, maxDepthMM: 3, islandDs: [],
    })
    // Unclamped the ridge would be −8.66; the whole spine is pinned at −3.
    expect(minZ(segs)).toBe(-3)
    expect(depthAt(segs, 5, 5)).toBe(-3)
    // The corner ramps are still shallower than the clamp.
    expect(depthAt(segs, 0, 0)).toBeCloseTo(0, 6)
  })

  it('shifts the whole cut down by zStartMM (male-inlay plug offset)', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [], zStartMM: 1,
    })
    expect(minZ(segs)).toBeCloseTo(-6, 6)             // 1 + 5
    expect(depthAt(segs, 0, 0)).toBeCloseTo(-1, 6)    // r = 0 corner, offset only
  })

  it('never emits a positive cutting Z', async () => {
    const segs = await generateVCarve(ANNULUS, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(cuts(segs).every(s => s.z <= 0)).toBe(true)
  })
})

// ─── Retract framing ──────────────────────────────────────────────────────────

describe('generateVCarve — plunge/retract framing', () => {
  it('brackets each region with a rapid in at safe height and a rapid out', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [], safeHeightMM: 12,
    })

    const first = segs[0], second = segs[1], last = segs[segs.length - 1]

    expect(first.rapid).toBe(true)
    expect(first.z).toBe(12)
    // The plunge happens at the same XY the rapid positioned to.
    expect(second.rapid).toBe(false)
    expect([second.x, second.y]).toEqual([first.x, first.y])

    expect(last.rapid).toBe(true)
    expect(last.z).toBe(12)

    // Everything in between stays down.
    expect(segs.slice(1, -1).some(s => s.rapid)).toBe(false)
  })

  it('defaults safe height to 5 mm', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(segs[0].z).toBe(5)
    expect(segs[segs.length - 1].z).toBe(5)
  })

  it('retracts once per disjoint region', async () => {
    const two = 'M 50 0 L 70 0 L 70 10 L 50 10 Z M 0 0 L 20 0 L 20 10 L 0 10 Z'
    const segs = await generateVCarve(two, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(segs.filter(s => s.rapid).length).toBe(4) // 2 regions × (rapid in + rapid out)
  })
})

// ─── Medial-axis geometry ─────────────────────────────────────────────────────

describe('generateVCarve — medial axis geometry', () => {
  it('finds the spine and corner-arc centres of a rounded rectangle', async () => {
    const segs = await generateVCarve(ROUNDRECT_40x20_R5, vbit(), {
      angleDeg: 90, maxDepthMM: 15, islandDs: [],
    })

    // Spine runs (10,10)→(30,10); half the 20 mm height is the inscribed radius.
    expect(minZ(segs)).toBeCloseTo(-10, 6)
    expect(at(segs, 10, 10).length).toBeGreaterThan(0)
    expect(at(segs, 30, 10).length).toBeGreaterThan(0)

    // The four corner-arc centres are at radius 5.
    for (const [cx, cy] of [[5, 5], [35, 5], [5, 15], [35, 15]] as const) {
      expect(cutAt(segs, cx, cy, 0.01).length).toBeGreaterThan(0)
      expect(depthAt(segs, cx, cy, 0.01)).toBeCloseTo(-5, 1)
    }

    // A shape with no sharp corners must never bring the tip back to the surface
    // mid-cut — that is exactly the discretization noise pruneNoisyBranches kills.
    expect(Math.max(...cuts(segs).map(s => s.z))).toBeLessThan(-4)
  })

  it('walks a constant-width wall as a closed loop at constant depth', async () => {
    const segs = await generateVCarve(ANNULUS, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    const cut = cuts(segs)

    // The four straight runs sit 5 mm from both the outer wall and the counter,
    // so each run's endpoints carve at exactly the inscribed radius.
    for (const [x, y] of [[10, 5], [30, 5], [35, 10], [35, 30], [30, 35], [10, 35], [5, 30], [5, 10]] as const) {
      expect(depthAt(segs, x, y)).toBeCloseTo(-5, 6)
    }

    // Outer sharp corners pull the axis outward: the point equidistant from
    // x=0, y=0 and the hole corner (10,10) is t = 10√2/(1+√2) ≈ 5.858.
    const t = 10 * Math.SQRT2 / (1 + Math.SQRT2)
    expect(minZ(segs)).toBeCloseTo(-t, 3)
    expect(at(segs, t, t, 0.01).length).toBeGreaterThan(0)

    // The four outer corners spur off the loop and taper to the surface.
    for (const [x, y] of [[0, 0], [40, 0], [40, 40], [0, 40]] as const) {
      expect(depthAt(segs, x, y)).toBeCloseTo(0, 6)
    }

    // The skeleton contains a cycle, which the plain leaf-to-leaf traversal cannot
    // cover — findPossiblePath's second pass must close it, so the final cut point
    // is a revisit of a point the tool already passed through.
    const end = cut[cut.length - 1]
    const revisits = cut.filter(s => Math.abs(s.x - end.x) < 1e-9 && Math.abs(s.y - end.y) < 1e-9)
    expect(revisits.length).toBeGreaterThan(1)
  })

  it('covers both arms of a concave L shape', async () => {
    const segs = await generateVCarve('M 0 0 L 30 0 L 30 10 L 10 10 L 10 30 L 0 30 Z', vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(depthAt(segs, 25, 5)).toBeCloseTo(-5, 6) // horizontal arm
    expect(depthAt(segs, 5, 25)).toBeCloseTo(-5, 6) // vertical arm
  })

  it('carves sub-millimetre shapes instead of pruning them away', async () => {
    const segs = await generateVCarve('M 0 0 L 0.4 0 L 0.4 0.4 L 0 0.4 Z', vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(minZ(segs)).toBeCloseTo(-0.2, 6)
  })

  // Two traced leaf shapes from scratch/verror.fkam, a 17-path project where pruning was
  // eating the toolpath. Both are small closed Bézier outlines with narrow rounded tips —
  // the tips read as discretization noise, so the prune walk started there and ran the
  // whole spine. LEAF_OVERPRUNED forks near one end, so the walk found a junction to stop
  // at only after taking 56 of 60 segments; LEAF_SPUR is one of the shapes pruning is
  // genuinely for.
  const LEAF_OVERPRUNED =
    'M178.3181,134.2837 C173.1675,130.1562,168.9342,124.8999,169.287,123.0301 ' +
    'C169.4986,121.9718,172.0739,122.0071,174.2964,123.1007 C177.7184,124.7587,182.622,129.8387,183.6098,132.7315 ' +
    'C183.892,133.5429,183.892,134.1779,183.645,134.8482 C182.8336,136.9649,181.5284,136.8237,178.3181,134.2837 Z'
  const LEAF_SPUR =
    'M327.4725,177.6401 C326.4848,176.5465,326.3789,174.6415,327.1903,173.301 ' +
    'C328.0017,172.031,328.5309,171.6429,331.5295,170.1612 C334.1753,168.8207,336.1156,168.5385,336.7859,169.3146 ' +
    'C337.2092,169.8437,337.1739,170.126,336.4331,171.5371 C335.9392,172.419,334.4223,174.324,333.0464,175.7351 ' +
    'C330.8945,177.9576,330.3653,178.3104,329.307,178.3104 C328.5661,178.3104,327.8606,178.0635,327.4725,177.6401 Z'

  // Regression: this carved a 1.7 mm stub 1.4 mm deep — a 14 mm shape with a 3 mm inscribed
  // radius, so it should run nearly its own length and bottom out on the depth clamp.
  it('does not prune the spine off a small closed curve', async () => {
    const segs = await generateVCarve(LEAF_OVERPRUNED, vbit(60), {
      angleDeg: 60, maxDepthMM: 3, islandDs: [],
    })
    expect(minZ(segs)).toBeCloseTo(-3, 6)
    const cut = cuts(segs)
    let len = 0
    for (let i = 1; i < cut.length; i++) len += Math.hypot(cut[i].x - cut[i - 1].x, cut[i].y - cut[i - 1].y)
    expect(len).toBeGreaterThan(15)
  })

  // The other half of the same change: capping how much a prune may remove must not stop
  // it removing what it is for. Unpruned, this shape's axis carries a spur out to r≈0 at
  // (337.1, 170.1), lifting the tip back to the surface in the middle of the cut.
  it('still prunes a discretization spur off the spine', async () => {
    const segs = await generateVCarve(LEAF_SPUR, vbit(60), {
      angleDeg: 60, maxDepthMM: 3, islandDs: [],
    })
    expect(cutAt(segs, 337.1, 170.1, 0.1)).toEqual([])
    // …and the rest of the cut is unaffected: it still reaches the clamp.
    expect(minZ(segs)).toBeCloseTo(-3, 6)
  })

  it('treats islandDs identically to a hole subpath in the same path', async () => {
    const opts = { angleDeg: 90, maxDepthMM: 10 }
    const fromSubpath = await generateVCarve(ANNULUS, vbit(), { ...opts, islandDs: [] })
    const fromIsland = await generateVCarve('M 0 0 L 40 0 L 40 40 L 0 40 Z', vbit(), {
      ...opts, islandDs: [HOLE_20x20],
    })
    expect(fromIsland).toEqual(fromSubpath)
  })

  // End-to-end form of the classifySubpaths regression below: a W and its own 3 mm inward
  // offset, selected together (scratch/vcarveerror.fkam). The offset must bound the carve,
  // not become a second shape to carve — the toolpath belongs in the 3 mm band between the
  // two outlines and must never enter the island.
  it('keeps the carve out of a concave island instead of carving through it', async () => {
    const outer = 'M 110 220 L 135 150 L 165 150 L 175 210 L 200 210 L 210 150 L 240 150 L 250 235 Z'
    const island = 'M 162.4586 153 L 172.4586 213 L 202.5414 213 L 212.5414 153 L 237.3323 153 ' +
                   'L 246.5813 231.6165 L 114.1060 217.4228 L 137.1142 153 Z'
    const segs = await generateVCarve(outer, vbit(30), {
      angleDeg: 30, maxDepthMM: 3, islandDs: [island],
    })
    // Measured as penetration DEPTH, not point-in-polygon: the axis legitimately runs out
    // to the island's own corners, and a point sitting exactly on a vertex classifies
    // either way. Carving through the island showed up as centimetres, not microns.
    const ring = flattenPath(island, 0.05)[0] as Pt2[]
    let worst = 0
    for (const s of segs) {
      if (s.rapid || !pointInPolygon(s.x, s.y, ring)) continue
      let d2 = Infinity
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        d2 = Math.min(d2, ptSegDistSq(s.x, s.y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]))
      }
      worst = Math.max(worst, Math.sqrt(d2))
    }
    expect(worst).toBeLessThan(0.05)
  })
})

// ─── Ordering and entry selection ─────────────────────────────────────────────

describe('generateVCarve — ordering', () => {
  it('cuts regions left-to-right by centroid X regardless of subpath order', async () => {
    // Right-hand rectangle is written first in the d string.
    const segs = await generateVCarve(
      'M 50 0 L 70 0 L 70 10 L 50 10 Z M 0 0 L 20 0 L 20 10 L 0 10 Z',
      vbit(), { angleDeg: 90, maxDepthMM: 10, islandDs: [] })

    const firstRapid = segs.findIndex(s => s.rapid)
    expect(segs[firstRapid].x).toBeLessThan(25)
    // Second region's entry rapid is on the right.
    const entries = segs.filter((s, i) => s.rapid && (i === 0 || !segs[i - 1].rapid) && s.z === 5)
    expect(entries[0].x).toBeLessThan(entries[1].x)
  })

  it('starts at the skeleton leaf nearest the incoming tool position', async () => {
    const opts = { angleDeg: 90, maxDepthMM: 10, islandDs: [] }
    const fromOrigin = await generateVCarve(RECT_40x10, vbit(), { ...opts, startNear: { x: 0, y: 0 } })
    const fromFarEnd = await generateVCarve(RECT_40x10, vbit(), { ...opts, startNear: { x: 40, y: 10 } })

    expect(fromOrigin[0].x).toBeCloseTo(0, 6)
    expect(fromOrigin[0].y).toBeCloseTo(0, 6)
    expect(fromFarEnd[0].x).toBeCloseTo(40, 6)
    expect(fromFarEnd[0].y).toBeCloseTo(10, 6)
  })
})

// ─── Error handling ───────────────────────────────────────────────────────────

describe('generateVCarve — taper', () => {
  const taper = (sideDeg = 15, tipDiaMM = 1): Tool => ({
    id: 'tp', name: 'Taper', type: 'taper', diameterMM: tipDiaMM, fluteCount: 2, rpm: 18000,
    xyFeedMmMin: 1200, zFeedMmMin: 300, maxDepthMM: 25, vbitAngleDeg: sideDeg,
  })
  // The op's angle is the INCLUDED one (the form converts a taper's per-side entry once,
  // in includedAngleDeg) — so a 15°/side taper is carved as a 30° bit.
  const opts = { angleDeg: 30, maxDepthMM: 20, islandDs: [] as string[] }

  it('rides its tip ball, so it cuts SHALLOWER than a V-bit of the same angle', async () => {
    // At any given width a taper's tip is already that wide before the cone starts, so it
    // reaches the same width with less depth. Cutting it to the V-bit's depth would carve
    // the stroke wider than it is.
    const t = await generateVCarve(RECT_40x10, taper(15, 1), opts)
    const v = await generateVCarve(RECT_40x10, vbit(30), opts)
    const deepest = (segs: Awaited<ReturnType<typeof generateVCarve>>) =>
      Math.min(...segs.filter(s => !s.rapid).map(s => s.z))
    expect(deepest(t)).toBeGreaterThan(deepest(v))
  })

  it('follows the ball/cone profile exactly, not the cone alone', async () => {
    // The 40×10 rectangle's ridge runs at a clearance radius of 5 mm — the cone region for
    // a 0.5 mm tip ball. Depth there is f(5), which is 5/tan LESS the offset that slides
    // the cone onto the ball; asserting the plain 5/tan would pass for a V-bit and fail here.
    const tool = taper(15, 1)
    const th = 15 * Math.PI / 180
    const expected = 5 / Math.tan(th) - 0.5 * (1 / Math.sin(th) - 1)
    const segs = await generateVCarve(RECT_40x10, tool, opts)
    const deepest = Math.min(...segs.filter(s => !s.rapid).map(s => s.z))
    expect(-deepest).toBeCloseTo(expected, 3)
    expect(expected).toBeLessThan(5 / Math.tan(th))   // strictly shallower than the bare cone
  })

  it('carves a stroke narrower than its tip instead of skipping or overcutting it', async () => {
    // A FLAT-tipped bit could not enter a 0.3 mm stroke at all. A ball tip reaches zero
    // width at its point, so the stroke is cut — round-bottomed, and never wider than it is.
    const tool = taper(15, 1)   // 1 mm tip ball, far wider than the stroke
    const NARROW = 'M 0 0 L 20 0 L 20 0.3 L 0 0.3 Z'
    const segs = await generateVCarve(NARROW, tool, opts)
    const cuts = segs.filter(s => !s.rapid)
    expect(cuts.length).toBeGreaterThan(0)
    const deepest = -Math.min(...cuts.map(s => s.z))
    // Depth is the ball's own rise at the stroke's half-width — a shallow round groove.
    expect(deepest).toBeCloseTo(0.5 - Math.sqrt(0.25 - 0.15 * 0.15), 4)
    // The cut is 0.3 mm wide at that depth: exactly the stroke, so nothing is overcut.
    expect(2 * toolRadiusAtHeight(tool, deepest)).toBeCloseTo(0.3, 4)
  })

  it('never cuts outside the shape at a sharp corner, where the tip ball rides', async () => {
    // The machine drives Z LINEARLY between emitted points. A V-bit's depth law is linear
    // in the clearance radius so two endpoints describe the move exactly; a taper's is an
    // arc wherever it is on its tip ball, and a straight chord across that arc runs deeper
    // — deeper being wider. The small radii that put the bit on its ball are the ones at
    // sharp corners, so the error collects there. Before the run was subdivided, a 5°/side
    // taper cut 0.18–0.40 mm outside a star point, a wedge and an L; a V-bit cut none.
    //
    // Measured the way the machine moves: walk each cutting move, and at every step compare
    // the tool's width at the interpolated Z against the true distance to the wall.
    const shapes: [string, string][] = [
      ['wedge', 'M 0,0 L 60,3 L 60,-3 Z'],
      ['L-shape', 'M 0 0 L 30 0 L 30 10 L 10 10 L 10 30 L 0 30 Z'],
    ]
    const tool = taper(5, 1)
    for (const [name, d] of shapes) {
      const rings = flattenPath(d, 0.01)
      const clearance = (x: number, y: number) => {
        let best = Infinity
        for (const ring of rings)
          for (let i = 0; i + 1 < ring.length; i++)
            best = Math.min(best, ptSegDistSq(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]))
        return Math.sqrt(best)
      }
      const segs = await generateVCarve(d, tool, { angleDeg: includedAngleDeg(tool), maxDepthMM: 6, islandDs: [] })
      let worst = 0
      let prev: MotionSegment | null = null
      for (const s of segs) {
        if (!s.rapid && prev) {
          const steps = Math.max(1, Math.ceil(Math.hypot(s.x - prev.x, s.y - prev.y) / 0.05))
          for (let k = 0; k <= steps; k++) {
            const t = k / steps
            const x = prev.x + t * (s.x - prev.x)
            const y = prev.y + t * (s.y - prev.y)
            const z = prev.z + t * (s.z - prev.z)
            if (z >= 0) continue
            worst = Math.max(worst, toolRadiusAtHeight(tool, -z) - clearance(x, y))
          }
        }
        prev = s
      }
      expect(worst, `${name} overcut`).toBeLessThan(0.02)
    }
  })

  it('reduces to the V-bit law when the tip diameter is zero', async () => {
    // A taper is the general family; the V-bit is its zero-tip member. Same segments.
    const asTaper = await generateVCarve(RECT_40x10, { ...taper(15, 0), diameterMM: 0 }, opts)
    const asVbit = await generateVCarve(RECT_40x10, vbit(30), opts)
    expect(asTaper).toEqual(asVbit)
  })
})

describe('generateVCarve — rejections', () => {
  it('rejects a non-V-bit tool', async () => {
    const endmill: Tool = { ...vbit(), type: 'endmill' }
    await expect(generateVCarve(RECT_40x10, endmill, { angleDeg: 90, maxDepthMM: 10, islandDs: [] }))
      .rejects.toThrow('V-Carve requires a V-bit tool')
  })

  it('rejects a degenerate V-bit angle', async () => {
    await expect(generateVCarve(RECT_40x10, vbit(), { angleDeg: 0, maxDepthMM: 10, islandDs: [] }))
      .rejects.toThrow('Invalid V-bit angle')
  })

  it('rejects a path with no closed geometry', async () => {
    // A two-point line used to land on the generic "no geometry" message, because it was
    // dropped by the ≥3-point filter rather than recognised as a stroke. It now gets the
    // open-path message, which says what to do about it — see the block at the bottom.
    await expect(generateVCarve('M 0 0 L 10 10', vbit(), { angleDeg: 90, maxDepthMM: 10, islandDs: [] }))
      .rejects.toThrow(/Path is open/)
    // Nothing drawn at all still reaches the generic message.
    await expect(generateVCarve('', vbit(), { angleDeg: 90, maxDepthMM: 10, islandDs: [] }))
      .rejects.toThrow('No geometry found in path')
  })
})

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('classifySubpaths', () => {
  const square = (x: number, y: number, s: number): Pt2[] =>
    [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]

  it('nests a contained loop as a hole of the larger loop', () => {
    const regions = classifySubpaths([square(10, 10, 20), square(0, 0, 40)])
    expect(regions.length).toBe(1)
    expect(regions[0].holes.length).toBe(1)
    // Largest by area becomes the outer ring regardless of input order.
    expect(regions[0].outer).toEqual(square(0, 0, 40))
  })

  it('keeps disjoint loops as separate regions', () => {
    const regions = classifySubpaths([square(0, 0, 10), square(50, 0, 10)])
    expect(regions.length).toBe(2)
    expect(regions.every(r => r.holes.length === 0)).toBe(true)
  })

  it('treats loops that touch at a vertex as siblings, not holes', () => {
    // Inner loop shares the (10,10) vertex with the outer — the letter-K arm case.
    const outer: Pt2[] = [[0, 0], [40, 0], [40, 40], [0, 40]]
    const touching: Pt2[] = [[10, 10], [30, 10], [30, 30]]
    const withShared: Pt2[] = [[0, 0], ...touching]

    expect(classifySubpaths([outer, touching])[0].holes.length).toBe(1)
    // Once it shares a vertex with the outer ring it is no longer a counter.
    const regions = classifySubpaths([outer, withShared])
    expect(regions.length).toBe(2)
    expect(regions[0].holes.length).toBe(0)
  })

  // Regression: containment used the ring's vertex mean, which only lands inside a convex
  // ring. This W's mean is at (185.6, 185.9) — in the notch under the middle peak, outside
  // the shape — so its own 3 mm inward offset read as a sibling region rather than a hole,
  // and generateVCarve carved a second medial axis straight through the middle of it
  // (scratch/vcarveerror.fkam).
  it('nests a loop inside a concave (W-shaped) parent', () => {
    const wOuter: Pt2[] = [[110, 220], [135, 150], [165, 150], [175, 210], [200, 210],
                           [210, 150], [240, 150], [250, 235]]
    const wInner: Pt2[] = [[162.4586, 153], [172.4586, 213], [202.5414, 213], [212.5414, 153],
                           [237.3323, 153], [246.5813, 231.6165], [114.106, 217.4228], [137.1142, 153]]
    const regions = classifySubpaths([wOuter, wInner])
    expect(regions.length).toBe(1)
    expect(regions[0].outer).toEqual(wOuter)
    expect(regions[0].holes).toEqual([wInner])
  })

  // Even-odd, as the name always said: a ring inside a hole is solid again and starts its
  // own region. This previously read as one region with two holes, so the solid band
  // between the 2nd and 3rd ring went unmachined — the compound-path form of the nested
  // selection bug (scratch/pocketerror.fkam).
  it('handles a hole inside a hole by starting a new region', () => {
    const regions = classifySubpaths([square(0, 0, 60), square(10, 10, 40), square(20, 20, 20)])
    expect(regions.length).toBe(2)
    expect(regions[0].outer).toEqual(square(0, 0, 60))
    expect(regions[0].holes).toEqual([square(10, 10, 40)])
    expect(regions[1].outer).toEqual(square(20, 20, 20))
    expect(regions[1].holes).toEqual([])
  })

  it('keeps alternating down a deeper nest', () => {
    const regions = classifySubpaths([
      square(0, 0, 80), square(10, 10, 60), square(20, 20, 40), square(30, 30, 20),
    ])
    expect(regions.map((r) => [r.outer, r.holes]))
      .toEqual([
        [square(0, 0, 80), [square(10, 10, 60)]],
        [square(20, 20, 40), [square(30, 30, 20)]],
      ])
  })

  // Regression, with the coordinates that produced it (scratch/pocketerror.fkam): these
  // rectangles are nested but NOT concentric, so the stand-in point for an outer ring —
  // taken low in its own bbox — falls inside the ring nested within it. Containment by
  // point test alone then reads the child as the parent, and the pocket came out inside
  // out. A container is always strictly larger, which is what settles it.
  it('does not invert nesting when a ring\'s interior point lands inside its child', () => {
    const rect = (x0: number, y0: number, x1: number, y1: number): Pt2[] =>
      [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    const a = rect(25, 130, 175, 275)
    const b = rect(40, 160, 140, 265)
    const c = rect(50, 165, 100, 255)
    const d = rect(65, 215, 90, 240)
    const regions = classifySubpaths([a, b, c, d])
    expect(regions.map((r) => [r.outer, r.holes])).toEqual([[a, [b]], [c, [d]]])
  })

  it('alternates per branch, not by global depth', () => {
    // One outer with two children; only one of them nests further. The lone child stays a
    // hole while its sibling's child comes back as a region.
    const regions = classifySubpaths([
      square(0, 0, 100), square(5, 5, 40), square(10, 10, 20), square(60, 60, 30),
    ])
    expect(regions.length).toBe(2)
    expect(regions[0].outer).toEqual(square(0, 0, 100))
    expect(regions[0].holes).toEqual([square(5, 5, 40), square(60, 60, 30)])
    expect(regions[1].outer).toEqual(square(10, 10, 20))
  })
})

describe('an open boundary is refused, not carved', () => {
  // A v-carve cuts the MEDIAL AXIS of a region — the ridge equidistant from its walls —
  // so it needs walls all round. `splitSelfIntersecting` closes every subpath
  // implicitly, so an open one used to be carved as though its ends were joined: the
  // medial axis of a shape nobody drew.
  const OPEN_U = 'M 0 0 L 0 40 L 40 40 L 40 0'
  const CLOSED = 'M 0 0 L 0 40 L 40 40 L 40 0 Z'
  const params = { angleDeg: 60, maxDepthMM: 3, islandDs: [] as string[], safeHeightMM: 5 }

  it('refuses an open boundary and names the cut that does work on one', async () => {
    await expect(generateVCarve(OPEN_U, vbit(60), params)).rejects.toThrow(
      'Path is open — a V-carve needs a closed shape. Close the path, or use a centerline profile with the V-bit to cut a groove along it.')
  })

  it('refuses a compound path with one open subpath among closed ones', async () => {
    await expect(generateVCarve(`${CLOSED} M 60 0 L 100 0 L 100 40`, vbit(60), params))
      .rejects.toThrow(/Path has 1 of 2 subpaths open/)
  })

  it('refuses an open ISLAND, which would carve the wrong hole', async () => {
    await expect(generateVCarve(CLOSED, vbit(60), { ...params, islandDs: ['M 10 10 L 30 10 L 30 30'] }))
      .rejects.toThrow(/^Island path is open/)
  })

  it('still carves a closed path', async () => {
    expect((await generateVCarve(CLOSED, vbit(60), params)).length).toBeGreaterThan(0)
  })
})
