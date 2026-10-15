import { describe, it, expect } from 'vitest'
import {
  traceImage, traceThresholds, otsuThreshold, multiOtsu, autoThreshold, simplifyRingLocked, segPoint, segPiece,
  thinMask, traceSkeleton, despeckleMask, DEFAULT_TRACE, MAX_TRACE_LOOPS,
  type TraceParams, type Seg,
} from './imageTrace'
import type { PhotoImage } from '../cam/photoVcarve'
import type { RectInfo } from '../canvas/selectionUtils'
import { flattenPath, type Pt2 } from '../cam/pathFlattener'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A picture painted from `tone(x, y)` (0 black … 255 white) in pixel coordinates, row 0 at
 * the TOP, supersampled 4×4 so every edge is anti-aliased the way a real drawing's is —
 * the tracer places its lines by interpolating that soft edge.
 */
function paint(w: number, h: number, tone: (x: number, y: number) => number): PhotoImage {
  const lum = new Uint8Array(w * h)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let sum = 0
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) sum += tone(c + (i + 0.5) / 4, r + (j + 0.5) / 4)
    lum[r * w + c] = Math.round(sum / 16)
  }
  return { lum, w, h }
}

// 400 × 200 px laid on the stock as 100 × 50 mm at (10, 20): 0.25 mm per pixel.
const RECT: RectInfo = { p0: { x: 10, y: 20 }, widthMM: 100, heightMM: 50, rotationDeg: 0 }
const MM = 0.25
/** Stock mm of the pixel-space point (x, y) — Y flips, since row 0 is the top of the picture. */
const toMM = (x: number, y: number): Pt2 => [RECT.p0.x + x * MM, RECT.p0.y + RECT.heightMM - y * MM]

const trace = (img: PhotoImage, over: Partial<TraceParams> = {}, rect = RECT) =>
  traceImage(img, rect, { ...DEFAULT_TRACE, ...over })

const dist = (a: Pt2, b: Pt2) => Math.hypot(a[0] - b[0], a[1] - b[1])
const points = (ds: string[]) => ds.flatMap((d) => flattenPath(d, 0.01).flat())
const radii = (d: string, c: Pt2) => {
  const r = flattenPath(d, 0.01).flat().map((p) => dist(p, c))
  return { min: Math.min(...r), max: Math.max(...r) }
}

/** Even-odd containment of `p` in the region the outlines `ds` bound. */
function inside(ds: string[], p: Pt2): boolean {
  let c = false
  for (const ring of ds.flatMap((d) => flattenPath(d, 0.005))) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j]
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c
    }
  }
  return c
}

/** Distance from `p` to the nearest edge of the outlines `ds`. */
function edgeDist(ds: string[], p: Pt2): number {
  let best = Infinity
  for (const ring of ds.flatMap((d) => flattenPath(d, 0.005))) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 0
      best = Math.min(best, Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy))
    }
  }
  return best
}

// Anti-aliased coverage of a signed distance (negative = inside).
const cover = (sd: number) => Math.max(0, Math.min(1, 0.5 - sd))

// A black ring (outer R 80 px, inner R 40 px) centred at pixel (100, 100), a black square
// from (260, 20) to (360, 100), on white — the square in the TOP half, so a picture laid
// on the stock upside down puts it somewhere else.
const RING_C: Pt2 = toMM(100, 100)
const ringAndSquare = paint(400, 200, (x, y) => {
  const d = Math.hypot(x - 100, y - 100)
  const ring = Math.min(cover(d - 80), cover(40 - d))
  const sq = Math.min(cover(260 - x), cover(x - 360), cover(20 - y), cover(y - 100))
  return 255 * (1 - Math.max(ring, sq))
})

// Cartoon-shaped, three tones: a grey (170) disk of R 70 at (200, 100) with a black
// outline 6 px wide round it, on white — the shape whose soft line edges gave the middle
// tone its hairline rim.
const cartoon = paint(400, 200, (x, y) => {
  const d = Math.hypot(x - 200, y - 100)
  const line = Math.min(cover(d - 76), cover(70 - d))
  const fill = cover(d - 70)
  return 255 * (1 - line) - (255 - 170) * fill * (1 - line)
})

// The features that broke multi-tone nesting on a real cartoon, all in one picture: a
// black outline round grey fill; a black stroke crossing the fill at an angle (where the
// grey's edge leaves the line's — a junction); a white highlight in the grey; and a white
// "toenail" cut into a black blob with a grey shadow over half of it (a hole the two tones
// share part of the edge of); and a thin grey wedge tapering to a point along a straight
// black bar, the shape whose smoothed far edge bulged across the bar. Every edge anti-aliased, so the in-between grey of the
// lines' soft edges is there too.
const busy = paint(400, 200, (x, y) => {
  const d = Math.hypot(x - 150, y - 100)
  const outline = Math.min(cover(d - 86), cover(80 - d))
  const fill = cover(d - 80)
  const stroke = Math.min(cover(Math.abs((x - 150) * 0.6 - (y - 100) * 0.8) - 4), cover(d - 80))
  const highlight = cover(Math.hypot(x - 120, y - 70) - 14)
  const blob = Math.min(cover(270 - x), cover(x - 380), cover(40 - y), cover(y - 160))
  const nail = Math.min(cover(-(y - 70) + (x - 300) * 0.0), cover(y - 130), cover(Math.abs(x - 325) - (y - 70) * 0.45))
  const shadow = nail * cover(x - 325)
  const bar = Math.min(cover(Math.abs(y - 185) - 4), cover(20 - x), cover(x - 380))
  const wedge = Math.min(cover(181 - (x - 60) * 0.04 - y), cover(y - 181), cover(60 - x), cover(x - 260))
  const black = Math.max(outline, stroke, blob * (1 - nail), bar)
  const grey = Math.max(fill * (1 - highlight), shadow, wedge)
  return 255 * (1 - black) - (255 - 160) * grey * (1 - black)
})

// ─── Thresholds ───────────────────────────────────────────────────────────────

describe('automatic thresholds', () => {
  const twoTone = (dark: number, light: number, darkShare: number) => {
    const lum = new Uint8Array(1000)
    lum.fill(light); lum.fill(dark, 0, Math.round(1000 * darkShare))
    return lum
  }

  it("Otsu's cut separates a two-tone histogram: dark is below it, light at or above it", () => {
    const t = otsuThreshold(twoTone(30, 220, 0.3))
    expect(t).toBeGreaterThan(30)
    expect(t).toBeLessThanOrEqual(220)
  })

  it('a crisp two-tone drawing is cut at mid-grey, where its anti-aliased edges are halfway', () => {
    const lum = twoTone(0, 255, 0.05)
    for (let i = 0; i < 20; i++) lum[100 + i] = 40 + 9 * i   // a few edge pixels, all the way up
    expect(otsuThreshold(lum)).toBeGreaterThan(110)
    expect(otsuThreshold(lum)).toBeLessThan(145)
  })

  it('the multi-class cuts separate three tones, one cut between each neighbouring pair', () => {
    const lum = new Uint8Array(900)
    lum.fill(20, 0, 300); lum.fill(128, 300, 600); lum.fill(240, 600, 900)
    const [t1, t2] = multiOtsu(lum, 3)
    expect(t1).toBeGreaterThan(20); expect(t1).toBeLessThanOrEqual(128)
    expect(t2).toBeGreaterThan(128); expect(t2).toBeLessThanOrEqual(240)
  })

  it('with a real middle tone, dark cuts below it (the linework) and light above it (all but background)', () => {
    const lum = new Uint8Array(1000)
    lum.fill(10, 0, 100); lum.fill(200, 100, 500); lum.fill(250, 500, 1000)
    expect(autoThreshold(lum, 'dark')).toBeLessThanOrEqual(200)
    expect(autoThreshold(lum, 'light')).toBeGreaterThan(200)
    expect(autoThreshold(lum, 'light')).toBeLessThanOrEqual(250)
  })

  it('a plain two-tone picture uses the ordinary cut for dark and light alike — its anti-aliasing is not a tone', () => {
    const lum = twoTone(0, 255, 0.4)
    for (let i = 0; i < 40; i++) lum[i] = 128      // a sliver of edge pixels, well under 10 %
    expect(autoThreshold(lum, 'dark')).toBe(otsuThreshold(lum))
    expect(autoThreshold(lum, 'light')).toBe(otsuThreshold(lum))
  })

  it("the cartoon's auto cut traces the black line, not the grey fill", () => {
    const r = trace(cartoon, { smoothing: 0 })
    // The line is a ring 70–76 px out: two outlines, nothing at the fill's centre.
    expect(r.ds).toHaveLength(2)
    expect(inside(r.ds, toMM(200, 100))).toBe(false)
    expect(inside(r.ds, toMM(273, 100))).toBe(true)
  })

  it('manual multi-tone cuts are used as given, darkest break innermost for a dark trace', () => {
    const lum = new Uint8Array(900)
    lum.fill(20, 0, 300); lum.fill(128, 300, 600); lum.fill(240, 600, 900)
    const p = { ...DEFAULT_TRACE, tones: 4, autoThreshold: false, cuts: [200, 60, 100] }
    expect(traceThresholds(lum, p)).toEqual([60, 100, 200])
    expect(traceThresholds(lum, { ...p, trace: 'light' })).toEqual([200, 100, 60])
  })

  it('manual cuts give way to the automatic ones when Auto is on or their count does not match the tones', () => {
    const lum = new Uint8Array(900)
    lum.fill(20, 0, 300); lum.fill(128, 300, 600); lum.fill(240, 600, 900)
    const auto = multiOtsu(lum, 3)
    expect(traceThresholds(lum, { ...DEFAULT_TRACE, tones: 3, autoThreshold: true, cuts: [50, 60] })).toEqual(auto)
    expect(traceThresholds(lum, { ...DEFAULT_TRACE, tones: 3, autoThreshold: false, cuts: [50, 60, 70] })).toEqual(auto)
  })

  it('a manual cut moves the tone boundary: the grey fill drops out of tone 2 when the upper cut sits below grey', () => {
    // Cartoon grey is 170: a cut at 200 takes it into tone 2, one at 150 leaves it out.
    const at = (upper: number) => trace(cartoon, { tones: 3, autoThreshold: false, cuts: [60, upper], smoothing: 50 })
    const t2 = (r: ReturnType<typeof at>) => r.ds.filter((_, i) => r.levels[i] === 2)
    expect(inside(t2(at(200)), toMM(200, 100))).toBe(true)
    expect(inside(t2(at(150)), toMM(200, 100))).toBe(false)
  })
})

// ─── Outlines ─────────────────────────────────────────────────────────────────

describe('outline trace', () => {
  it('lands on the drawn edges to a few hundredths of a mm, in stock mm with Y up', () => {
    const r = trace(ringAndSquare, { smoothing: 0, autoThreshold: false, threshold: 128 })
    expect(r.ds).toHaveLength(3)                      // ring outer, ring hole, square
    const [outer, hole] = r.ds.filter((d) => radii(d, RING_C).max < 25).sort((a, b) => radii(b, RING_C).max - radii(a, RING_C).max)
    expect(radii(outer, RING_C).min).toBeCloseTo(20, 1)   // 80 px × 0.25 mm
    expect(radii(outer, RING_C).max).toBeCloseTo(20, 1)
    expect(radii(hole, RING_C).min).toBeCloseTo(10, 1)
    expect(radii(hole, RING_C).max).toBeCloseTo(10, 1)
    // The square's rows 20…100 are 5…25 mm down from the top of a 50 mm picture at y 20:
    // Y is flipped, so it sits at y 45…65.
    const sq = flattenPath(r.ds.find((d) => radii(d, RING_C).max > 25)!, 0.01).flat()
    expect(Math.min(...sq.map((p) => p[0]))).toBeCloseTo(75, 1)
    expect(Math.max(...sq.map((p) => p[1]))).toBeCloseTo(65, 1)
    expect(Math.min(...sq.map((p) => p[1]))).toBeCloseTo(45, 1)
  })

  it("follows the picture's rotation on the stock", () => {
    const rot: RectInfo = { ...RECT, rotationDeg: 90 }
    const r = trace(ringAndSquare, { smoothing: 0, autoThreshold: false, threshold: 128 }, rot)
    // Rotated 90° CCW about p0: picture (u, v) goes to (p0.x − v, p0.y + u).
    const u = 100 * MM, v = RECT.heightMM - 100 * MM
    const c: Pt2 = [RECT.p0.x - v, RECT.p0.y + u]
    const outer = r.ds.map((d) => radii(d, c)).filter((q) => q.max < 25).sort((a, b) => b.max - a.max)[0]
    expect(outer.min).toBeCloseTo(20, 1)
    expect(outer.max).toBeCloseTo(20, 1)
  })

  it('keeps a square sharp — four straight sides — while smoothing rounds the curves', () => {
    const r = trace(ringAndSquare, { smoothing: 50, autoThreshold: false, threshold: 128 })
    const sq = r.ds.find((d) => radii(d, RING_C).max > 25)!
    expect(sq.match(/C/g)).toBeNull()
    expect(sq.match(/[ML]/g)).toHaveLength(4)        // M + three L; Z closes the fourth side
    const outer = r.ds.find((d) => radii(d, RING_C).max > 15 && radii(d, RING_C).max < 25)!
    expect(outer.match(/C/g)!.length).toBeGreaterThan(4)
  })

  it('traces the light side instead when asked: the ring hole and the background, not the ring', () => {
    const r = trace(ringAndSquare, { trace: 'light', smoothing: 0, autoThreshold: false, threshold: 128 })
    expect(inside(r.ds, RING_C)).toBe(true)          // the hole is light
    expect(inside(r.ds, toMM(100, 40))).toBe(false)  // the ring itself is not
    expect(inside(r.ds, toMM(390, 10))).toBe(true)   // nor is the background missed
  })

  it('a speck takes the colour around it: a dark fleck on white goes, a white fleck in black fills', () => {
    const img = paint(400, 200, (x, y) => {
      const blob = Math.min(cover(100 - x), cover(x - 300), cover(40 - y), cover(y - 160))
      const whiteFleck = Math.hypot(x - 200, y - 100) < 1.5
      const darkFleck = Math.hypot(x - 350, y - 20) < 1.5
      return blob && !whiteFleck ? (blob ? 255 * (1 - blob) : 255) : darkFleck ? 0 : whiteFleck ? 255 : 255 * (1 - blob)
    })
    const r = trace(img, { smoothing: 0, minSpeckMM: 1, autoThreshold: false, threshold: 128 })
    expect(r.ds).toHaveLength(1)                       // the blob, with no hole and no fleck
    expect(inside(r.ds, toMM(200, 100))).toBe(true)
    expect(inside(r.ds, toMM(350, 20))).toBe(false)
    expect(r.specks).toBe(2)
  })

  it('refuses a trace of more than MAX_TRACE_LOOPS outlines rather than flooding the document', () => {
    const img = paint(400, 400, (x, y) => (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 255 : 0)
    expect(() => trace(img, { minSpeckMM: 0, autoThreshold: false, threshold: 128 })).toThrow(String(MAX_TRACE_LOOPS))
  })
})

// ─── Thicken ──────────────────────────────────────────────────────────────────

describe('thicken lines', () => {
  // A 4 px (1 mm) black bar across the middle.
  const bar = paint(400, 200, (x, y) => 255 * (1 - Math.min(cover(Math.abs(y - 100) - 2), cover(50 - x), cover(x - 350))))
  // The bar is horizontal, so its outline's height is the line's width.
  const width = (ds: string[]) => {
    const ys = points(ds).map((p) => p[1])
    return Math.max(...ys) - Math.min(...ys)
  }

  it('widens a line by the Thicken amount in total, half on each side', () => {
    const thin = width(trace(bar, { smoothing: 0 }).ds)
    const thick = width(trace(bar, { smoothing: 0, thickenMM: 3 }).ds)
    expect(thin).toBeCloseTo(1, 1)
    expect(thick - thin).toBeCloseTo(3, 1)
  })
})

// ─── Multi-tone ───────────────────────────────────────────────────────────────

describe('multi-tone trace', () => {
  it('splits three tones into two nested levels, each tagged with its level', () => {
    const r = trace(cartoon, { tones: 3, smoothing: 50 })
    expect(r.thresholds).toHaveLength(2)
    expect(new Set(r.levels)).toEqual(new Set([1, 2]))
    const t1 = r.ds.filter((_, i) => r.levels[i] === 1), t2 = r.ds.filter((_, i) => r.levels[i] === 2)
    expect(inside(t1, toMM(273, 100))).toBe(true)     // the line is tone 1…
    expect(inside(t2, toMM(273, 100))).toBe(true)     // …and inside tone 2 too: levels nest
    expect(inside(t1, toMM(200, 100))).toBe(false)    // the grey fill is tone 2 only
    expect(inside(t2, toMM(200, 100))).toBe(true)
  })

  // Every point of the outer tone's outline is outside the inner tone or on its edge:
  // where the two coincide they are the same curve, never two that cross.
  const nests = (over: Partial<TraceParams>) => {
    const r = trace(busy, { tones: 3, minSpeckMM: 0.5, ...over })
    const t1 = r.ds.filter((_, i) => r.levels[i] === 1), t2 = r.ds.filter((_, i) => r.levels[i] === 2)
    let worst = 0
    for (const p of points(t2)) if (inside(t1, p)) worst = Math.max(worst, edgeDist(t1, p))
    return worst
  }
  for (const smoothing of [0, 50, 100]) {
    it(`the outer tone never cuts into the inner one (smoothing ${smoothing})`, () => {
      expect(nests({ smoothing })).toBeLessThan(0.01)
    })
  }
  it('the outer tone never cuts into the inner one when thickened either', () => {
    expect(nests({ smoothing: 50, thickenMM: 2 })).toBeLessThan(0.01)
    expect(nests({ smoothing: 100, thickenMM: 1 })).toBeLessThan(0.01)
  })

  it('writes an edge it shares with the inner tone as that curve, not as a run of tiny segments', () => {
    const r = trace(busy, { tones: 3, smoothing: 50, minSpeckMM: 0.5 })
    const cmds = (l: number) => r.ds.filter((_, i) => r.levels[i] === l).join(' ').match(/[MLC]/g)!.length
    expect(cmds(2)).toBeLessThan(4 * cmds(1))
  })

  it('the outer tone stays whole — a few outlines, not a scatter of slivers along the inner edge', () => {
    for (const smoothing of [50, 100]) {
      const r = trace(busy, { tones: 3, smoothing, minSpeckMM: 0.5 })
      expect(r.levels.filter((l) => l === 2).length).toBeLessThan(20)
    }
  })

  it('drops a pale halo hanging off a line, but keeps a pale area of its own', () => {
    // The cartoon with a lump of near-white (232) on the outside of its outline — the
    // JPEG ringing beside a real line — and a patch of the same grey off on its own.
    // Both are in tone 2 at a cut of 240; only the patch is a tone the picture shows.
    const img = paint(400, 200, (x, y) => {
      const d = Math.hypot(x - 200, y - 100)
      const line = Math.min(cover(d - 76), cover(70 - d))
      const fill = cover(d - 70)
      const lump = cover(Math.hypot(x - 279, y - 100) - 3) * (1 - line)
      const patch = Math.min(cover(20 - x), cover(x - 50), cover(20 - y), cover(y - 50))
      const pale = Math.max(lump, patch)
      return (255 * (1 - line) - (255 - 170) * fill * (1 - line)) - (255 - 232) * pale * (1 - fill)
    })
    const r = trace(img, { tones: 3, autoThreshold: false, cuts: [90, 240], smoothing: 50 })
    const t2 = r.ds.filter((_, i) => r.levels[i] === 2)
    expect(inside(t2, toMM(280, 100))).toBe(false)   // the halo is gone…
    expect(inside(t2, toMM(35, 35))).toBe(true)      // …the patch is not…
    expect(inside(t2, toMM(200, 100))).toBe(true)    // …nor the grey fill inside the line
  })

  it('a lighter tone squeezed into a V narrower than the speck size joins the darker tone', () => {
    // A black block with a grey (170) wedge cut into it, 0 px wide at x = 50 opening to
    // 30 px at x = 350. With specks at 2 mm (8 px) the wedge's narrow tip, 4 px (1 mm)
    // across at x = 90, fills black; its wide end stays grey. With specks off it is grey.
    const img = paint(400, 200, (x, y) => {
      const box = Math.min(cover(20 - x), cover(x - 380), cover(40 - y), cover(y - 160))
      const wedge = cover(Math.abs(y - 100) - Math.max(0, (x - 50) * 0.05))
      return 255 - box * (255 - 170 * wedge)
    })
    const t1 = (minSpeckMM: number) => {
      const r = trace(img, { tones: 3, autoThreshold: false, cuts: [90, 240], smoothing: 0, minSpeckMM })
      return r.ds.filter((_, i) => r.levels[i] === 1)
    }
    expect(inside(t1(2), toMM(90, 100))).toBe(true)
    expect(inside(t1(2), toMM(320, 100))).toBe(false)
    expect(inside(t1(0), toMM(90, 100))).toBe(false)
  })

  for (const smoothing of [0, 50, 100]) {
    it(`leaves no outline smaller than a speck where a light V meets a line and a darker area (smoothing ${smoothing})`, () => {
      // Black left of x = 200, mid grey (150) right of it, and a pale (220) V between the
      // two running down to a point at (200, 100) — the corner where a tone boundary meets
      // a drawn line. With Smoothing on, the band's opening used to shave the filled tip
      // of the V back off, and it came out as a small triangle of its own.
      const img = paint(400, 200, (x, y) => {
        const box = Math.min(cover(20 - x), cover(x - 380), cover(20 - y), cover(y - 180))
        const black = cover(x - 200)
        const pale = Math.min(cover(200 - x), cover(x - 200 - Math.max(0, (100 - y) / 4)), cover(y - 100))
        return 255 - box * (255 - (1 - black) * (150 + 70 * pale))
      })
      const r = trace(img, { tones: 4, autoThreshold: false, cuts: [90, 195, 240], smoothing, minSpeckMM: 2 })
      const ringArea = (ring: Pt2[]) => Math.abs(ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p[0] * q[1] - q[0] * p[1] }, 0)) / 2
      const smallest = Math.min(...r.ds.flatMap((d) => flattenPath(d, 0.01)).map(ringArea))
      expect(smallest).toBeGreaterThan(2 * 2)
    })
  }

  it('leaves no hairline rim of the middle tone round a line: no band of it narrower than the bit', () => {
    // The black line's soft outer edge is in-between grey all the way round. Thickened for
    // a 2 mm bit, tone 2's outside edge must sit ON tone 1's, not a hair beyond it.
    // Smoothing 0, so nothing but the bit width is there to remove the rim.
    const r = trace(cartoon, { tones: 3, smoothing: 0, thickenMM: 2 })
    const t1 = r.ds.filter((_, i) => r.levels[i] === 1), t2 = r.ds.filter((_, i) => r.levels[i] === 2)
    const outer2 = t2.reduce((a, b) => (radii(a, toMM(200, 100)).max > radii(b, toMM(200, 100)).max ? a : b))
    for (const p of flattenPath(outer2, 0.05).flat()) expect(edgeDist(t1, p)).toBeLessThan(0.01)
  })
})

// ─── Centerlines ──────────────────────────────────────────────────────────────

describe('centerline trace', () => {
  const center = (img: PhotoImage, over: Partial<TraceParams> = {}) =>
    trace(img, { mode: 'centerline', autoThreshold: false, threshold: 128, ...over })

  it('makes one open path down the middle of a stroke', () => {
    const bar = paint(400, 200, (x, y) => 255 * (1 - Math.min(cover(Math.abs(y - 100) - 4), cover(50 - x), cover(x - 350))))
    const r = center(bar)
    expect(r.ds).toHaveLength(1)
    expect(r.ds[0].endsWith('Z')).toBe(false)
    for (const p of flattenPath(r.ds[0], 0.01).flat()) expect(Math.abs(p[1] - toMM(0, 100)[1])).toBeLessThan(0.15)
    const xs = flattenPath(r.ds[0], 0.01).flat().map((p) => p[0])
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(70)   // the bar is 75 mm long
  })

  it('trims the stub a bump on the side of a stroke thins into, so the stroke stays one path', () => {
    const bumpy = paint(400, 200, (x, y) => {
      const bar = Math.min(cover(Math.abs(y - 100) - 6), cover(50 - x), cover(x - 350))
      const bump = Math.min(cover(Math.abs(x - 200) - 3), cover(91 - y), cover(y - 100))
      return 255 * (1 - Math.max(bar, bump))
    })
    expect(center(bumpy).ds).toHaveLength(1)
  })

  it('an L is one path, not a corner triangle', () => {
    const L = paint(400, 200, (x, y) => {
      const v = Math.min(cover(Math.abs(x - 100) - 4), cover(30 - y), cover(y - 150))
      const hz = Math.min(cover(Math.abs(y - 150) - 4), cover(96 - x), cover(x - 300))
      return 255 * (1 - Math.max(v, hz))
    })
    expect(center(L).ds).toHaveLength(1)
  })

  it('a T is three paths meeting at one junction', () => {
    const T = paint(400, 200, (x, y) => {
      const top = Math.min(cover(Math.abs(y - 40) - 4), cover(80 - x), cover(x - 320))
      const stem = Math.min(cover(Math.abs(x - 200) - 4), cover(36 - y), cover(y - 170))
      return 255 * (1 - Math.max(top, stem))
    })
    const r = center(T)
    expect(r.ds).toHaveLength(3)
    // Every path has an end at the junction.
    const ends = r.ds.map((d) => { const pts = flattenPath(d, 0.01)[0]; return [pts[0], pts[pts.length - 1]] })
    const j = toMM(200, 40)
    for (const [a, b] of ends) expect(Math.min(dist(a, j), dist(b, j))).toBeLessThan(1.5)
  })

  it('a ring is one closed loop, and a white fleck inside a stroke does not open a second one', () => {
    const ring = paint(400, 200, (x, y) => {
      const d = Math.hypot(x - 200, y - 100)
      const fleck = Math.hypot(x - 260, y - 100) < 1.2
      return fleck ? 255 : 255 * (1 - Math.min(cover(d - 66), cover(54 - d)))
    })
    const r = center(ring, { minSpeckMM: 1 })
    expect(r.ds).toHaveLength(1)
    expect(r.ds[0].endsWith('Z')).toBe(true)
    const rr = radii(r.ds[0], toMM(200, 100))
    expect(rr.min).toBeGreaterThan(14); expect(rr.max).toBeLessThan(16)   // 60 px = 15 mm
  })

  it('ignores the Tones setting: a centerline is a two-tone question', () => {
    // At four tones the first multi-class cut is NOT the two-tone auto cut, so this tells them apart.
    const r = center(busy, { tones: 4, autoThreshold: true })
    expect(r.thresholds).toEqual([autoThreshold(busy.lum, 'dark')])
  })
})

// ─── Building blocks ──────────────────────────────────────────────────────────

describe('thinning', () => {
  it('leaves a skeleton one pixel wide — no 2×2 block of set pixels anywhere', () => {
    const w = 120, h = 80
    const mask = new Uint8Array(w * h)
    for (let y = 10; y < 70; y++) for (let x = 10; x < 110; x++) mask[y * w + x] = 1
    thinMask(mask, w, h)
    let set = 0
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      set += mask[y * w + x]
      expect(mask[y * w + x] && mask[y * w + x + 1] && mask[(y + 1) * w + x] && mask[(y + 1) * w + x + 1]).toBeFalsy()
    }
    expect(set).toBeGreaterThanOrEqual(30)   // a 100 × 60 block leaves a spine ~40 px long
  })

  it('walks a plus sign into four arms from one junction', () => {
    const w = 41, h = 41
    const mask = new Uint8Array(w * h)
    for (let i = 5; i < 36; i++) { mask[20 * w + i] = 1; mask[i * w + 20] = 1 }
    const paths = traceSkeleton(mask, w, h)
    expect(paths).toHaveLength(4)
    for (const p of paths) expect(p.pts.some(([x, y]) => x === 20 && y === 20)).toBe(true)
  })

  it('despeckling fills a small hole and removes a small fleck, leaving big regions alone', () => {
    const w = 60, h = 40
    const mask = new Uint8Array(w * h)
    for (let y = 5; y < 35; y++) for (let x = 5; x < 35; x++) mask[y * w + x] = 1
    mask[20 * w + 20] = 0                 // a one-pixel hole in the block
    mask[20 * w + 50] = 1                 // a one-pixel fleck on its own
    expect(despeckleMask(mask, w, h, 4)).toBe(2)
    expect(mask[20 * w + 20]).toBe(1)
    expect(mask[20 * w + 50]).toBe(0)
    expect(mask[10 * w + 10]).toBe(1)
  })
})

describe('shared edges', () => {
  it('a piece of a curve is exactly that stretch of it', () => {
    const g: Seg = { p0: [0, 0], c: [[3, 8], [9, -4]], p1: [12, 2] }
    const p0 = segPoint(g, 0.2), p1 = segPoint(g, 0.7)
    const piece = segPiece(g, 0.2, 0.7, p0, p1)
    for (const s of [0, 0.25, 0.5, 0.75, 1]) {
      const a = segPoint(piece, s), b = segPoint(g, 0.2 + 0.5 * s)
      expect(dist(a, b)).toBeLessThan(1e-9)
    }
    // Reversed, it runs the same stretch backwards.
    const back = segPiece(g, 0.7, 0.2, p1, p0)
    expect(dist(segPoint(back, 0.25), segPoint(g, 0.575))).toBeLessThan(1e-9)
  })

  it('the locked simplify keeps every vertex the `near` test flags, so an edge hugging the inner tone is not cut across', () => {
    // A free run bowing 0.3 mm off straight — well inside a 1 mm tolerance, so plain
    // Douglas–Peucker drops the whole bow — but flagged as near the inner outline.
    const run: Pt2[] = Array.from({ length: 21 }, (_, i) => [i, 0.3 * Math.sin(Math.PI * i / 20)] as Pt2)
    const ring: Pt2[] = [...run, [20, 10], [0, 10]]
    const plain = simplifyRingLocked(ring, 1, new Set())
    expect(plain.length).toBeLessThan(6)
    const kept = simplifyRingLocked(ring, 1, new Set(), (p) => p[1] < 1)
    for (const p of run) expect(kept.some((q) => q[0] === p[0] && q[1] === p[1])).toBe(true)
  })

  it('the locked simplify never drops a locked vertex, however straight the run through it', () => {
    const ring: Pt2[] = [[0, 0], [1, 0.0001], [2, 0], [3, 0.0001], [4, 0], [4, 4], [0, 4]]
    const key = (p: Pt2) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`
    const out = simplifyRingLocked(ring, 0.5, new Set([key([2, 0])]))
    expect(out.some((p) => p[0] === 2 && p[1] === 0)).toBe(true)
  })
})
