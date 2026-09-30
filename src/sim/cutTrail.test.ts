import { describe, it, expect } from 'vitest'
import { CutTrail, heatBand, heatPieces, heatOnTop, HEAT_NEUTRAL, type HeatSpec, type TrailBatch } from './cutTrail'
import { parseGcode, type SimSegment, type ToolState } from './gcodeParser'
import { aimChipLoad } from '../cam/feeds'

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

/** Everything the layer draws, flattened into a comparable form — batch by batch. */
function snapshot(t: CutTrail) {
  return t.batches.map((b) => ({
    band: b.band,
    widths: [...b.byWidth.entries()]
      .map(([w, polys]) => [w, polys.map((p) => p.join(','))] as const)
      .sort((a, b2) => a[0] - b2[0]),
    frustums: b.frustums.map((f) => `${f.x0},${f.y0},${f.w0},${f.x1},${f.y1},${f.w1}`),
  }))
}

const allPolys = (bs: TrailBatch[]) => bs.flatMap((b) => [...b.byWidth.values()].flat())
const allFrustums = (bs: TrailBatch[]) => bs.flatMap((b) => b.frustums)
const widthCount = (bs: TrailBatch[]) => new Set(bs.flatMap((b) => [...b.byWidth.keys()])).size

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
      for (const b of t.pendingBatches) for (const [w, polys] of b.byWidth)
        for (const p of polys) drawn.add(`${w}|${p.join(',')}`)
      for (const f of allFrustums(t.pendingBatches)) drawn.add(`f|${f.x0},${f.y0},${f.x1},${f.y1}`)
      t.drainPending()
      if (i >= last) break
    }
    return drawn
  }

  /** The same pieces, read off the complete trail. */
  function drawnByWhole(): Set<string> {
    const t = fromScratch(segments, segments.length - 1)
    const drawn = new Set<string>()
    for (const [w, polys] of t.batches.flatMap((b) => [...b.byWidth.entries()])) {
      for (const p of polys) {
        for (let i = 0; i + 3 < p.length; i += 2) {
          drawn.add(`${w}|${p[i]},${p[i + 1]},${p[i + 2]},${p[i + 3]}`)
        }
      }
    }
    for (const f of allFrustums(t.batches)) drawn.add(`f|${f.x0},${f.y0},${f.x1},${f.y1}`)
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
    // One colour throughout, so one batch — the grouping by width is unchanged by the heat map.
    expect(t.batches.length).toBe(1)
    expect(widthCount(t.batches)).toBeLessThanOrEqual(8)
    expect(allPolys(t.batches).length).toBeLessThan(segments.length)
  })

  it('keeps rapids and above-surface moves out of the trail', () => {
    const segments = [
      seg(0, 0, 0, 10, 0, 0, true),     // rapid
      seg(10, 0, 0, 20, 0, 0),          // feed, but at the surface
      seg(20, 0, 0, 20, 0, -1),         // plunge
    ]
    const t = fromScratch(segments, 2)
    expect(allPolys(t.batches).length + allFrustums(t.batches).length).toBe(1)   // only the plunge
  })

  it('sends a taper wider than the width rounding to the frustum fill', () => {
    // 0 → 1 mm deep is a 1.15 mm width change: a stroke can't taper, so it is a quad.
    const segments = [seg(0, 0, 0, 5, 0, -1)]
    const t = fromScratch(segments, 0)
    expect(allFrustums(t.batches).length).toBe(1)
    expect(allPolys(t.batches).length).toBe(0)
  })

  it('offsets the trail by the work origin', () => {
    const segments = [seg(0, 0, -0.5, 5, 0, -0.5)]
    const t = fromScratch(segments, 0, 100, 50)
    const pts = allPolys(t.batches)[0]
    expect(pts.slice(0, 4)).toEqual([100, 50, 105, 50])
  })

  it('holds nothing before the first segment is reached', () => {
    const segments = rasterLine(0, 10)
    const t = fromScratch(segments, -1)
    expect(t.batches.length).toBe(0)
  })
})

// ─── The heat map ─────────────────────────────────────────────────────────────

describe('the chip-load heat map', () => {
  // A 3 mm single-flute bit in Delrin on a hobby machine at 18,000 rpm, fed at exactly
  // the aimed chip — the job that melted.
  const HEAT: HeatSpec = { material: 'delrin', rigidity: 1 }
  const aim = aimChipLoad('endmill', 3, 'delrin', 1)
  const feed = Math.round(aim * 18000 * 60) / 60
  const LIM = { accelXYMmS2: 200, accelZMmS2: 50, maxRateXYMmMin: 4000, maxRateZMmMin: 400, junctionDeviationMM: 0.04 }
  const program = (moves: string) => parseGcode(
    `G21 G90\n(Tool: dia 3.000mm flutes:1)\nM3 S18000\nG0 X0 Y0 Z1\nG1 Z-1 F200\n${moves}\nG0 Z5`, 5, LIM)

  it('uses the chip gauge\'s own edges: rubbing under 0.75 of the aim, heavy over 1.4', () => {
    expect(heatBand(0.74)).toBeLessThan(4)
    expect(heatBand(0.75)).toBe(4)
    expect(heatBand(1.4)).toBe(4)
    expect(heatBand(1.41)).toBe(5)
    // …and grades the rubbing side, since how far short a cut falls is the question.
    expect(heatBand(0.2)).toBeLessThan(heatBand(0.5))
    expect(heatBand(0.5)).toBeLessThan(heatBand(0.7))
  })

  it('reads a long pass at the aimed feed as the sweet spot, with red where it speeds up and slows down', () => {
    const p = program(`G1 X100 F${feed}`)
    const pass = p.segments.find((sg) => sg.x === 100 && !sg.rapid)!
    const pieces = heatPieces(pass, p.toolStates, HEAT)
    expect(pieces[0][2]).toBeLessThan(4)                      // leaving the plunge
    expect(pieces[pieces.length - 1][2]).toBeLessThan(4)      // stopping for the retract
    expect(pieces.some(([, , b]) => b === 4)).toBe(true)
    // The ramps are short: most of 100 mm runs at the aim.
    const good = pieces.filter(([, , b]) => b === 4).reduce((n, [a, b2]) => n + (b2 - a), 0)
    expect(good).toBeGreaterThan(0.9)
    // Pieces tile the move exactly, in order.
    expect(pieces[0][0]).toBe(0)
    expect(pieces[pieces.length - 1][1]).toBe(1)
    for (let k = 1; k < pieces.length; k++) expect(pieces[k][0]).toBeCloseTo(pieces[k - 1][1], 12)
    // …and no two neighbours share a band: a run of one colour is one piece to stroke.
    for (let k = 1; k < pieces.length; k++) expect(pieces[k][2]).not.toBe(pieces[k - 1][2])
  })

  it('turns a square corner red — the machine nearly stops there and the spindle does not', () => {
    const p = program(`G1 X50 F${feed}\nG1 Y50 F${feed}`)
    const into = p.segments.find((sg) => sg.x === 50 && sg.y === 0 && !sg.rapid)!
    const out = p.segments.find((sg) => sg.y === 50 && !sg.rapid)!
    const last = heatPieces(into, p.toolStates, HEAT)
    expect(last[last.length - 1][2]).toBeLessThanOrEqual(2)
    expect(heatPieces(out, p.toolStates, HEAT)[0][2]).toBeLessThanOrEqual(2)
  })

  it('leaves what the gauge does not judge neutral: going down, a drill, no spindle, no heat spec', () => {
    const p = program(`G1 X50 F${feed}`)
    const plunge = p.segments.find((sg) => sg.z < sg.prevZ && !sg.rapid)!
    expect(heatPieces(plunge, p.toolStates, HEAT)).toEqual([[0, 1, HEAT_NEUTRAL]])
    const pass = p.segments.find((sg) => sg.x === 50 && !sg.rapid)!
    expect(heatPieces(pass, p.toolStates, null)).toEqual([[0, 1, HEAT_NEUTRAL]])
    const drill = p.toolStates.map((t) => ({ ...t, toolDrill: true }))
    expect(heatPieces(pass, drill, HEAT)).toEqual([[0, 1, HEAT_NEUTRAL]])
    const noSpindle = p.toolStates.map((t) => ({ ...t, spindleRpm: 0 }))
    expect(heatPieces(pass, noSpindle, HEAT)).toEqual([[0, 1, HEAT_NEUTRAL]])
  })

  it('colours a program timed without acceleration by its programmed chip, whole', () => {
    const p = parseGcode(`G21 G90\n(Tool: dia 3.000mm flutes:1)\nM3 S18000\nG1 X0 Z-1 F200\nG1 X50 F${feed / 3}`)
    const pass = p.segments.find((sg) => sg.x === 50)!
    expect(heatPieces(pass, p.toolStates, HEAT)).toEqual([[0, 1, heatBand(1 / 3)]])
  })

  it('keeps the trail in cut order, one batch per run of one colour', () => {
    const t = new CutTrail()
    const p = program(`G1 X50 F${feed}\nG1 Y50 F${feed}`)
    t.sync(p.segments, p.segments.length - 1, 0, 0, p.toolStates, HEAT)
    // Neighbouring batches always differ in colour (a same-colour run joins the last batch)…
    for (let k = 1; k < t.batches.length; k++) expect(t.batches[k].band).not.toBe(t.batches[k - 1].band)
    // …and the corner's red sits BETWEEN two runs of green, as it was cut.
    const bands = t.batches.map((b) => b.band)
    const hot = (b: number) => b >= 1 && b <= 3
    const green = bands.indexOf(4)
    const corner = bands.findIndex((b, k) => k > green && hot(b))
    expect(green).toBeGreaterThanOrEqual(0)
    expect(corner).toBeGreaterThan(green)
    expect(bands.indexOf(4, corner)).toBeGreaterThan(corner)
  })

  describe('accumulates with heat exactly as it does without', () => {
    const p = program(Array.from({ length: 12 }, (_, i) =>
      `G1 X${(i % 2 ? 0 : 30)} Y${i * 2} F${feed}\nG1 Y${i * 2 + 2} F${feed}`).join('\n'))

    it('agrees with a from-scratch build at every frame', () => {
      const live = new CutTrail()
      for (let i = 0; i < p.segments.length; i++) {
        live.sync(p.segments, i, 0, 0, p.toolStates, HEAT)
        const whole = new CutTrail()
        whole.sync(p.segments, i, 0, 0, p.toolStates, HEAT)
        expect(snapshot(live)).toEqual(snapshot(whole))
      }
    })

    it('paints every piece exactly once through its deltas', () => {
      const t = new CutTrail()
      const drawn: string[] = []
      for (let i = 0; i < p.segments.length; i++) {
        t.sync(p.segments, i, 0, 0, p.toolStates, HEAT)
        for (const bt of t.pendingBatches) for (const [w, polys] of bt.byWidth)
          for (const q of polys) drawn.push(`${bt.band}:${w}|${q.join(',')}`)
        t.drainPending()
      }
      const whole: string[] = []
      for (const bt of t.batches) for (const [w, polys] of bt.byWidth)
        for (const q of polys) for (let j = 0; j + 3 < q.length; j += 2)
          whole.push(`${bt.band}:${w}|${q[j]},${q[j + 1]},${q[j + 2]},${q[j + 3]}`)
      expect(drawn.sort()).toEqual(whole.sort())
    })

    // What the user sees: the finished view is painted from scratch from `batches`,
    // playback frame by frame from `pendingBatches`. Paint both onto a grid the way the
    // raster does — opaque, in order, a round brush, a hot band over and a cool one
    // under (TrailRaster.paintBatches) — and the pictures must be the same. Grouping the
    // whole trail by colour made them differ: every green stroke landed on top in the
    // finished view, and the red corners seen during playback vanished.
    function paint(grid: Map<string, number>, batches: TrailBatch[], hotWins = true) {
      const CELL = 0.25
      for (const b of batches) for (const [w, polys] of b.byWidth) for (const q of polys) {
        const r = w / 2
        for (let j = 0; j + 3 < q.length; j += 2) {
          const [ax, ay, bx, by] = [q[j], q[j + 1], q[j + 2], q[j + 3]]
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / CELL))
          for (let k = 0; k <= n; k++) {
            const cx = ax + (bx - ax) * (k / n), cy = ay + (by - ay) * (k / n)
            for (let dx = -r; dx <= r; dx += CELL) for (let dy = -r; dy <= r; dy += CELL)
              if (dx * dx + dy * dy <= r * r) {
                const key = `${Math.round((cx + dx) / CELL)},${Math.round((cy + dy) / CELL)}`
                if (!hotWins || heatOnTop(b.band) || !grid.has(key)) grid.set(key, b.band)
              }
          }
        }
      }
    }

    it('finishes showing exactly what playback painted — the hot corners are not painted over', () => {
      const played = new Map<string, number>()
      const t = new CutTrail()
      for (let i = 0; i < p.segments.length; i++) {
        t.sync(p.segments, i, 0, 0, p.toolStates, HEAT)
        paint(played, t.pendingBatches)
        t.drainPending()
      }
      const finished = new Map<string, number>()
      paint(finished, t.batches)
      expect(finished).toEqual(played)
      // And there IS something hot to lose: the corners show red at the end.
      expect([...finished.values()].some((b) => b >= 1 && b <= 3)).toBe(true)
    })

    it('keeps every hot spot visible, however much cooler cutting crosses it afterwards', () => {
      // The cut is the tool's full width, so the green of the same pass getting back up to
      // speed lands within a radius of the corner it just slowed for. In plain cut order it
      // covered all but a crescent of the red.
      const t = new CutTrail()
      t.sync(p.segments, p.segments.length - 1, 0, 0, p.toolStates, HEAT)
      const everHot = new Map<string, number>()
      paint(everHot, t.batches.filter((b) => heatOnTop(b.band)), false)
      const finished = new Map<string, number>()
      paint(finished, t.batches)
      expect(everHot.size).toBeGreaterThan(0)
      for (const [cell] of everHot) expect(heatOnTop(finished.get(cell)!), cell).toBe(true)
      // …which plain last-cut-wins painting does not manage.
      const lastWins = new Map<string, number>()
      paint(lastWins, t.batches, false)
      expect([...everHot.keys()].some((cell) => !heatOnTop(lastWins.get(cell)!))).toBe(true)
    })

    it('starts over when the material or the machine it is judged against changes', () => {
      const t = new CutTrail()
      t.sync(p.segments, 10, 0, 0, p.toolStates, HEAT)
      const gen = t.generation
      t.sync(p.segments, 10, 0, 0, p.toolStates, { ...HEAT })
      expect(t.generation).toBe(gen)            // same values, new object: nothing to redo
      t.sync(p.segments, 10, 0, 0, p.toolStates, { ...HEAT, material: 'pine' })
      expect(t.generation).toBe(gen + 1)
    })
  })
})
