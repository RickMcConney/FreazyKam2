import { describe, it, expect } from 'vitest'
import { CutTrail } from './cutTrail'
import type { SimSegment, ToolState } from './gcodeParser'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// 60° V-bit: cut width = 2·|z|·tan(30°) ≈ 1.155·|z|.
const VBIT: ToolState = {
  toolDiameterMM: 12.7, toolVbitHalfAngleTan: Math.tan(Math.PI / 6),
  spindleRpm: 18000, fluteCount: 2,
}
const toolStates = [VBIT]

function seg(prevX: number, prevY: number, prevZ: number, x: number, y: number, z: number, rapid = false): SimSegment {
  return {
    x, y, z, prevX, prevY, prevZ, rapid,
    feedRateMmMin: 1000, lineIdx: 0, durationS: 0.1, startTimeS: 0, toolStateIdx: 0,
  }
}

/** A depth-varying raster line, the shape a photo v-carve emits. */
function rasterLine(y: number, n: number): SimSegment[] {
  const out: SimSegment[] = []
  let px = 0, pz = 0
  for (let i = 1; i <= n; i++) {
    const x = i * 0.5
    const z = -0.3 - 0.3 * Math.sin(i * 0.7)
    out.push(seg(px, y, pz, x, y, z))
    px = x; pz = z
  }
  return out
}

/** Everything the layer draws, flattened into a comparable form. */
function snapshot(t: CutTrail) {
  return {
    widths: [...t.byWidth.entries()]
      .map(([w, polys]) => [w, polys.map((p) => p.join(','))] as const)
      .sort((a, b) => a[0] - b[0]),
    frustums: t.frustums.map((f) => `${f.x0},${f.y0},${f.w0},${f.x1},${f.y1},${f.w1}`),
  }
}

function fromScratch(segments: SimSegment[], upToIdx: number, ox = 0, oy = 0): CutTrail {
  const t = new CutTrail()
  t.sync(segments, upToIdx, ox, oy, toolStates)
  return t
}

// ─── Equivalence: the whole point of accumulating ─────────────────────────────

describe('incremental accumulation matches a from-scratch build', () => {
  const segments = [
    ...rasterLine(0, 40),
    seg(20, 0, -0.5, 20, 0.7, 5, true),      // retract + step over
    ...rasterLine(0.7, 40),
  ]

  it('agrees at every frame of playback', () => {
    const live = new CutTrail()
    for (let i = 0; i < segments.length; i++) {
      live.sync(segments, i, 0, 0, toolStates)
      expect(snapshot(live)).toEqual(snapshot(fromScratch(segments, i)))
    }
  })

  it('agrees when playback jumps several segments per frame', () => {
    const live = new CutTrail()
    for (let i = 0; i < segments.length; i += 7) {
      live.sync(segments, i, 0, 0, toolStates)
      expect(snapshot(live)).toEqual(snapshot(fromScratch(segments, i)))
    }
  })

  it('agrees after scrubbing backwards', () => {
    const live = new CutTrail()
    live.sync(segments, 70, 0, 0, toolStates)
    live.sync(segments, 12, 0, 0, toolStates)
    expect(snapshot(live)).toEqual(snapshot(fromScratch(segments, 12)))
    // …and can play forward again from there.
    live.sync(segments, 70, 0, 0, toolStates)
    expect(snapshot(live)).toEqual(snapshot(fromScratch(segments, 70)))
  })

  it('starts over when the program, the origin or the tool table changes', () => {
    const live = new CutTrail()
    live.sync(segments, 40, 0, 0, toolStates)
    const other = rasterLine(5, 20)
    live.sync(other, 19, 0, 0, toolStates)
    expect(snapshot(live)).toEqual(snapshot(fromScratch(other, 19)))

    live.sync(other, 19, 100, 50, toolStates)
    expect(snapshot(live)).toEqual(snapshot(fromScratch(other, 19, 100, 50)))
  })
})

// ─── Deltas ───────────────────────────────────────────────────────────────────
//
// TrailRaster paints each frame's delta onto what it painted before and never looks
// at the whole trail again, so a segment missing from the deltas is a segment missing
// from the picture.

describe('per-frame deltas cover the whole trail', () => {
  const segments = [
    ...rasterLine(0, 60),
    seg(30, 0, -0.5, 30, 0.7, 5, true),
    ...rasterLine(0.7, 60),
    seg(30, 0.7, -0.4, 40, 0.7, -1.2),   // a taper → frustum
  ]

  /** Every 2-point piece the deltas asked to be drawn, as width|x0,y0,x1,y1 keys. */
  function drawnByDeltas(frameStep: number): Set<string> {
    const t = new CutTrail()
    const drawn = new Set<string>()
    // The last frame lands on the final segment however coarse the stepping is —
    // playback always ends at the end of the program.
    const last = segments.length - 1
    for (let i = 0; ; i = Math.min(i + frameStep, last)) {
      t.sync(segments, i, 0, 0, toolStates)
      for (const [w, polys] of t.pendingByWidth)
        for (const p of polys) drawn.add(`${w}|${p.join(',')}`)
      for (const f of t.pendingFrustums) drawn.add(`f|${f.x0},${f.y0},${f.x1},${f.y1}`)
      t.drainPending()
      if (i >= last) break
    }
    return drawn
  }

  /** The same pieces, read off the complete trail. */
  function drawnByWhole(): Set<string> {
    const t = fromScratch(segments, segments.length - 1)
    const drawn = new Set<string>()
    for (const [w, polys] of t.byWidth) {
      for (const p of polys) {
        for (let i = 0; i + 3 < p.length; i += 2) {
          drawn.add(`${w}|${p[i]},${p[i + 1]},${p[i + 2]},${p[i + 3]}`)
        }
      }
    }
    for (const f of t.frustums) drawn.add(`f|${f.x0},${f.y0},${f.x1},${f.y1}`)
    return drawn
  }

  it('paints every piece exactly once, one segment per frame', () => {
    expect(drawnByDeltas(1)).toEqual(drawnByWhole())
  })

  it('paints every piece exactly once when frames span many segments', () => {
    expect(drawnByDeltas(9)).toEqual(drawnByWhole())
  })

  it('starts a new generation on rewind, so the consumer knows to repaint', () => {
    const t = new CutTrail()
    t.sync(segments, 50, 0, 0, toolStates)
    const gen = t.generation
    t.sync(segments, 60, 0, 0, toolStates)
    expect(t.generation).toBe(gen)      // just more cutting
    t.sync(segments, 10, 0, 0, toolStates)
    expect(t.generation).not.toBe(gen)  // scrubbed back — everything drawn is wrong
  })
})

// ─── What lands where ─────────────────────────────────────────────────────────

describe('trail geometry', () => {
  it('groups a depth-varying pass into few strokes, not one per segment', () => {
    const segments = rasterLine(0, 400)
    const t = fromScratch(segments, segments.length - 1)
    // 400 segments sweeping 0–0.6 mm deep → ≤ 8 distinct 0.1 mm width buckets.
    expect(t.byWidth.size).toBeLessThanOrEqual(8)
    const polylines = [...t.byWidth.values()].reduce((n, polys) => n + polys.length, 0)
    expect(polylines).toBeLessThan(segments.length)
  })

  it('keeps rapids and above-surface moves out of the trail', () => {
    const segments = [
      seg(0, 0, 0, 10, 0, 0, true),     // rapid
      seg(10, 0, 0, 20, 0, 0),          // feed, but at the surface
      seg(20, 0, 0, 20, 0, -1),         // plunge
    ]
    const t = fromScratch(segments, 2)
    const polylines = [...t.byWidth.values()].reduce((n, polys) => n + polys.length, 0)
    expect(polylines + t.frustums.length).toBe(1)   // only the plunge
  })

  it('sends a taper wider than the width rounding to the frustum fill', () => {
    // 0 → 1 mm deep is a 1.15 mm width change: a stroke can't taper, so it is a quad.
    const segments = [seg(0, 0, 0, 5, 0, -1)]
    const t = fromScratch(segments, 0)
    expect(t.frustums.length).toBe(1)
    expect(t.byWidth.size).toBe(0)
  })

  it('offsets the trail by the work origin', () => {
    const segments = [seg(0, 0, -0.5, 5, 0, -0.5)]
    const t = fromScratch(segments, 0, 100, 50)
    const pts = [...t.byWidth.values()][0][0]
    expect(pts.slice(0, 4)).toEqual([100, 50, 105, 50])
  })

  it('holds nothing before the first segment is reached', () => {
    const segments = rasterLine(0, 10)
    const t = fromScratch(segments, -1)
    expect(t.byWidth.size).toBe(0)
    expect(t.frustums.length).toBe(0)
  })
})
