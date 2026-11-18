// A TEXT INLAY, judged by whether the plug goes into the socket.
//
// Lettering whose every stroke the V-bit spans from wall to wall at the inlay depth goes its
// own route (readsAsText): the socket is a plain V-carve grown by the clearance, with no
// end-mill floor at all, and the plug is the letters standing as raised prisms on a cleared
// background (generateInlayMaleText). Neither half looks wrong on its own, so both are
// carved and checked against each other (sim/inlayFit.ts) — the only check that has ever
// caught an inlay bug. Real letterforms from a real font, loaded the way the app loads it.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadFont, generateTextD } from '../shapes/textGenerator'
import { auditInlayFit, inlayFitSummary } from '../sim/inlayFit'
import { generateInlayFemale, generateInlayMale, splitRegions, plugCutoutD } from './inlay'
import { generateGcode } from './gcode'
import { parseGcode } from '../sim/gcodeParser'
import { Heightfield } from '../sim/heightfield'
import { AUDIT_POST, regionFromPaths, offsetRegion, rasterizeRegion } from '../sim/toolpathAudit'
import { flattenPath } from './pathFlattener'
import { pointInPolygon } from './geom'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { Tool } from '../store/toolStore'

const ENDMILL: Tool = {
  id: 'em', name: '1/8 EM', type: 'endmill', diameterMM: 3.175, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const VBIT: Tool = {
  id: 'vb', name: '60 V-bit', type: 'vbit', diameterMM: 6.35, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20, vbitAngleDeg: 60,
}
const PARAMS = {
  angleDeg: 60, pocketDepthMM: 3, stepDownMM: 3, stepoverPercent: 40,
  glueLineMM: 0.2, clearanceMM: 0.1, rampIn: false, safeHeightMM: 3,
}
// The same allowance inlayFit.test.ts gives: a cell either way at every sharp corner. The
// failures this exists for run to whole counters and whole letters.
const SLACK_MM2 = 4

const text = (s: string, fontSize: number) =>
  generateTextD({ type: 'text', x: 40, y: 40, text: s, fontSize, fontFamily: 'Roboto' })

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(readFileSync(`public${decodeURIComponent(url)}`))))
  await loadFont('Roboto')
  vi.unstubAllGlobals()
})
beforeEach(() => {
  useWorkpieceStore.setState({
    widthMM: 260, heightMM: 200, thicknessMM: 12,
    origin: 'bottom-left', zOrigin: 'top', spindleType: 'vfd',
    autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

async function fit(boundaryD: string, over: Partial<typeof PARAMS> = {}, checkMirror = false) {
  return auditInlayFit({
    groups: [{ boundaryD }], roughTool: ENDMILL, wallTool: VBIT,
    params: { ...PARAMS, ...over }, cellMM: 0.15, checkMirror,
  })
}

function expectFits(r: Awaited<ReturnType<typeof fit>>) {
  expect(r.socketCells, inlayFitSummary(r)).toBeGreaterThan(1000)
  expect(r.warnings, inlayFitSummary(r)).toEqual([])
  expect(r.interference.areaMM2, inlayFitSummary(r)).toBeLessThanOrEqual(SLACK_MM2)
  expect(r.surfaceGaps.areaMM2, inlayFitSummary(r)).toBeLessThanOrEqual(SLACK_MM2)
  expect(r.overcut.areaMM2, inlayFitSummary(r)).toBeLessThanOrEqual(SLACK_MM2)
}

// Every stroke here is narrower than the V-bit's width at the inlay depth.
const LETTERING: [string, number][] = [['ABO', 12], ['ABO', 20], ['HI', 20], ['WAVE', 10]]

describe('lettering the V-bit spans stroke to stroke goes the text route', () => {
  it('cuts the socket as a V-carve alone, with no end-mill floor', async () => {
    for (const [s, size] of LETTERING) {
      const d = text(s, size)
      expect(splitRegions(d).length, s).toBeGreaterThan(1)
      const f = await generateInlayFemale(d, ENDMILL, VBIT, { ...PARAMS, islandDs: [] })
      expect(`${s} ${size}: end mill ${f.endmillSegs.length}`).toBe(`${s} ${size}: end mill 0`)
      expect(f.vbitSegs.length, s).toBeGreaterThan(0)
    }
  })

  it('cuts the plug as letters standing on a background the end mill clears', async () => {
    const m = await generateInlayMale(text('ABO', 12), ENDMILL, VBIT, { ...PARAMS, islandDs: [] })
    expect(m.vbitSegs.length).toBeGreaterThan(0)
    // Background, counters and the release profile all go down to the mating plane.
    const deepest = Math.min(...m.endmillSegs.filter(s => !s.rapid).map(s => s.z))
    expect(deepest).toBeCloseTo(-PARAMS.pocketDepthMM, 6)
  })

  it('frees the plug at full depth on every side, past the V-bit\'s reach', async () => {
    // The background pocket stops a cutter radius inside the box the letters are carried
    // on; the release profile is what cuts the plug free, outside it. The fit audit cannot
    // see it — it compares only inside the design — so it is pinned on its own.
    const d = text('ABO', 12)
    const xs: number[] = [], ys: number[] = []
    for (const r of flattenPath(d, 0.05)) for (const [x, y] of r) { xs.push(x); ys.push(y) }
    const m = await generateInlayMale(d, ENDMILL, VBIT, { ...PARAMS, islandDs: [] })
    const floor = m.endmillSegs.filter(s => !s.rapid && s.z <= -PARAMS.pocketDepthMM + 1e-6)
    const reach = VBIT.diameterMM
    expect(Math.min(...floor.map(s => s.x))).toBeLessThan(Math.min(...xs) - reach)
    expect(Math.max(...floor.map(s => s.x))).toBeGreaterThan(Math.max(...xs) + reach)
    expect(Math.min(...floor.map(s => s.y))).toBeLessThan(Math.min(...ys) - reach)
    expect(Math.max(...floor.map(s => s.y))).toBeGreaterThan(Math.max(...ys) + reach)
  })

  it('seats the plug with the finished face whole', { timeout: 30000 }, async () => {
    for (const [s, size] of LETTERING) expectFits(await fit(text(s, size)))
  })

  it('seats it the same once the plug board is turned over', { timeout: 30000 }, async () => {
    expectFits(await fit(text('ABO', 12), {}, true))
  })

  it('takes the clearance off the socket and leaves the plug nominal', { timeout: 30000 }, async () => {
    const d = text('HI', 20)
    const tight = await fit(d, { clearanceMM: 0 })
    const loose = await fit(d, { clearanceMM: 0.3 })
    expect(loose.maleGcode).toBe(tight.maleGcode)
    // The socket's own wall moves out: not merely more cells counted (the audited footprint
    // grows with the clearance too, so that holds whatever the socket does), but a
    // different cut. A V-carve's centreline stays put when both walls of a stroke move out;
    // what moves is its depth — a stroke 2c wider takes the tip c / tan(30°) deeper, and a
    // corner, whose axis runs along the bisector, deeper still.
    const socket = (c: number) => generateInlayFemale(d, ENDMILL, VBIT, { ...PARAMS, clearanceMM: c, islandDs: [] })
    const deepest = (segs: { z: number }[]) => Math.min(...segs.map(s => s.z))
    const deeper = deepest((await socket(0)).vbitSegs) - deepest((await socket(0.3)).vbitSegs)
    expect(deeper).toBeGreaterThan(0.3 / Math.tan(Math.PI / 6) - 0.01)
    expectFits(loose)
  })
})

describe('a letter whose counter is wider than its strokes', () => {
  // A thin-stroked O on its own is one region, so it goes the outline route: a floor pocket
  // a half-width in from the wall, with the counter grown by a half-width kept out of it. At
  // these strokes the grown counter is BIGGER than the floor boundary, and the pocket used to
  // drop it as an island lying outside its boundary — then clear the whole floor, counter and
  // all. The plug's hole then had nothing to land on: a surface gap the size of the counter.
  it('leaves the counter of a thin-stroked O standing in the socket', { timeout: 30000 }, async () => {
    for (const size of [12, 20]) {
      const d = text('O', size)
      const counter = flattenPath(d, 0.05)[1]
      const f = await generateInlayFemale(d, ENDMILL, VBIT, { ...PARAMS, islandDs: [] })
      const inCounter = f.endmillSegs.filter(s => !s.rapid && s.z < -0.1 && pointInPolygon(s.x, s.y, counter))
      expect(`O ${size}: ${inCounter.length} end-mill moves in the counter`).toBe(`O ${size}: 0 end-mill moves in the counter`)
      const r = await fit(d)
      expect(r.surfaceGaps.areaMM2, inlayFitSummary(r)).toBeLessThanOrEqual(SLACK_MM2)
    }
  })
})

const USER_TEST_D = "M129.0163,209.7196 L129.0163,207.6502 L122.2316,207.6502 L122.2316,190.2804 L119.4471,190.2804 L119.4471,207.6502 L112.7473,207.6502 L112.7473,209.7196 L129.0163,209.7196 M136.4935,190 L136.4935,190 Q133.2001,190,131.3556,191.9893 Q129.511,193.9786,129.511,197.223 L129.511,197.223 L129.511,197.8104 Q129.511,200.9212,131.4121,202.9573 Q133.3132,204.9933,136.0553,204.9933 L136.0553,204.9933 Q139.1225,204.9933,140.6562,203.1909 Q142.1898,201.3885,142.1898,198.3979 L142.1898,198.3979 L142.1898,197.0094 L132.4086,197.0094 L132.3662,196.9426 Q132.3662,194.7664,133.3839,193.4112 Q134.4016,192.056,136.4935,192.056 L136.4935,192.056 Q137.907,192.056,138.9742,192.4366 Q140.0413,192.8171,140.8046,193.4846 L140.8046,193.4846 L141.8929,191.7757 Q141.0731,191.028,139.7303,190.514 Q138.3875,190,136.4935,190 M136.0553,202.9239 L136.0553,202.9239 Q134.5995,202.9239,133.6454,201.8625 Q132.6913,200.8011,132.4793,199.1455 L132.4793,199.1455 L132.5076,199.0788 L139.4053,199.0788 L139.4053,199.2924 Q139.4053,200.8678,138.5855,201.8959 Q137.7657,202.9239,136.0553,202.9239 M154.2042,194.1655 L154.2042,194.1655 Q154.2042,195.0334,153.5046,195.5808 Q152.8049,196.1282,150.8543,196.542 L150.8543,196.542 Q148.1546,197.0895,146.7058,198.0775 Q145.257,199.0654,145.257,200.721 L145.257,200.721 Q145.257,202.4833,146.8472,203.7383 Q148.4373,204.9933,150.9674,204.9933 L150.9674,204.9933 Q153.5682,204.9933,155.1795,203.6582 Q156.7909,202.3231,156.7202,200.5474 L156.7202,200.5474 L156.692,200.4673 L154.0346,200.4673 Q154.0346,201.4019,153.1654,202.1629 Q152.2961,202.9239,150.9674,202.9239 L150.9674,202.9239 Q149.4974,202.9239,148.7695,202.2964 Q148.0415,201.6689,148.0415,200.8011 L148.0415,200.8011 Q148.0415,199.9466,148.6705,199.4793 Q149.2995,199.012,151.2642,198.6248 L151.2642,198.6248 Q154.077,198.0641,155.5329,197.036 Q156.9888,196.008,156.9888,194.3525 L156.9888,194.3525 Q156.9888,192.4299,155.3421,191.215 Q153.6954,190,151.0381,190 L151.0381,190 Q148.1122,190,146.4302,191.4019 Q144.7482,192.8037,144.8329,194.6729 L144.8329,194.6729 L144.8612,194.753 L147.5185,194.753 Q147.5892,193.3511,148.6211,192.7036 Q149.6529,192.056,151.0381,192.056 L151.0381,192.056 Q152.5222,192.056,153.3632,192.6502 Q154.2042,193.2443,154.2042,194.1655 M161.5401,208.211 L164.3246,208.211 L164.3246,204.7263 L167.2223,204.7263 L167.2223,202.777 L164.3246,202.777 L164.3246,194.0053 Q164.3246,192.9906,164.7699,192.5768 Q165.2151,192.1629,165.9501,192.1629 L165.9501,192.1629 Q166.1904,192.1629,166.4872,192.223 Q166.7841,192.283,166.982,192.3498 L166.982,192.3498 L167.3636,190.5474 Q167.0526,190.307,166.4448,190.1535 Q165.8371,190,165.2434,190 L165.2434,190 Q163.5472,190,162.5437,190.9679 Q161.5401,191.9359,161.5401,194.0053 L161.5401,194.0053 L161.5401,202.777 L159.109,202.777 L159.109,204.7263 L161.5401,204.7263 L161.5401,208.211"

describe('a lowercase e, its eye standing in a socket too tight round it for the end mill', () => {
  // The floor finish clears what the end mill cannot reach with loops, each an inset of the
  // missed patch. Round the e's eye that patch is a ring — floor with the eye as its hole —
  // and only its outer ring was kept, so every loop ran straight across the eye at the
  // floor: the protrusion the plug's hole lands on was carved away. "Test" at 40 mm, a 60°
  // V-bit, 1 mm deep, as a user drew it — their path as it stood (resized to 19.7 mm after
  // it was placed, which is what puts the eye this close to the end mill's reach).
  it('leaves the eye standing — nothing cuts inside it', async () => {
    const d = USER_TEST_D
    const p = { ...PARAMS, pocketDepthMM: 1, stepDownMM: 1.5, stepoverPercent: 70, glueLineMM: 0, clearanceMM: 0.2, vFloorStepMM: 0.26, rampIn: true, islandDs: [] }
    const eye = splitRegions(d).flatMap(r => r.islandDs).map(iD => flattenPath(iD, 0.05)[0])
    expect(eye.length).toBe(1)
    const f = await generateInlayFemale(d, ENDMILL, VBIT, p)
    // Along every move, not at its ends: a loop sweeping across the eye starts and ends
    // outside it.
    let inEye = 0
    for (const segs of [f.endmillSegs, f.vbitSegs]) for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i]
      if (b.rapid || Math.max(a.z, b.z) > -0.05) continue
      for (let t = 0; t <= 1; t += 0.05)
        if (pointInPolygon(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, eye[0])) { inEye++; break }
    }
    expect(`${inEye} moves through the eye`).toBe('0 moves through the eye')
  })

  it('so the finished face has no hole where the eye was', { timeout: 30000 }, async () => {
    const r = await fit(text('e', 20), { pocketDepthMM: 1, stepDownMM: 1.5, stepoverPercent: 70, glueLineMM: 0, clearanceMM: 0.2 })
    expect(r.surfaceGaps.areaMM2, inlayFitSummary(r)).toBeLessThanOrEqual(SLACK_MM2)
  })
})

describe('a plug of several shapes with no cut-out drawn', () => {
  // Lettering with strokes wide enough for a socket floor goes the OUTLINE route, which frees
  // each letter with only its own release ring. Everything between and round the letters
  // stayed at full height — the board, turned over, lands on the socket's face a plug-depth
  // short (516 mm² standing on a 40 mm TEST). The plug now gets the cut-out the form offers
  // (plugCutoutD) cleared out to the mating plane, as the text route clears its box.
  it('clears everything inside the rubber band round the letters to the mating plane', async () => {
    const D = 1
    const d = text('TEST', 40)
    const p = { ...PARAMS, pocketDepthMM: D, stepDownMM: 1.5, stepoverPercent: 70, glueLineMM: 0, clearanceMM: 0.2, islandDs: [] }
    const f = await generateInlayFemale(d, ENDMILL, VBIT, p)
    expect(f.endmillSegs.length, 'outline route: the socket has a floor').toBeGreaterThan(0)
    const m = await generateInlayMale(d, ENDMILL, VBIT, p)
    const op = (id: string, toolId: string, segments: typeof m.vbitSegs) => ({
      id, name: id, type: 'inlay', role: 'male', phase: id, toolId, pathId: 'p', angleDeg: 60,
      depthMM: 0, stepDownMM: 1, direction: 'climb', status: 'done', segments, color: '#fff', visible: true,
    })
    const parsed = parseGcode(generateGcode([op('v', VBIT.id, m.vbitSegs), op('e', ENDMILL.id, m.endmillSegs)] as never,
      { [VBIT.id]: VBIT, [ENDMILL.id]: ENDMILL }, 'x', AUDIT_POST))
    const cell = 0.1, gx0 = 30, gy0 = 30, W = 90, H = 45
    const grid = { NX: Math.round(W / cell) + 1, NY: Math.round(H / cell) + 1, sx: cell, sy: cell, gx0, gy0, T: 12, orgX: 0, orgY: 0 }
    const hf = new Heightfield(grid); hf.carveAll(parsed.segments, parsed.toolStates)
    const band = rasterizeRegion(offsetRegion(regionFromPaths(plugCutoutD(d, ENDMILL.diameterMM, null)!, []), -2 * cell), grid)
    const letters = rasterizeRegion(offsetRegion(regionFromPaths(d, []), 2 * cell), grid)
    let standing = 0
    for (let k = 0; k < band.length; k++) if (band[k] && !letters[k] && hf.topZ[k] - 12 > -D + 0.05) standing++
    // A cutter cannot reach every inside corner between letters (the T's arm over the E is
    // the biggest), so the claim is the order of it: a few mm², not the whole background.
    expect(standing * cell * cell).toBeLessThan(10)
  })
})

describe('taper lettering, whose strokes the bit spans with no floor', () => {
  // Where a taper's socket has no floor its bottom is the tip BALL, shallower than its cone
  // walls would meet, so a plug with the socket's walls stands proud of it along every
  // stroke's centreline — and a narrow counter's hole, V-carved, is too shallow at the
  // mating plane the same way. Both are cut to match (plugRidgeTrim, and the traced hole),
  // and a sharp inward corner gets the tip on the line (a B's waist). Each case below is one
  // that failed on the way: the B's counters and waist at 12 and 30 mm, an O's counter, a
  // W meeting an A.
  const TAPER: Tool = {
    id: 'tp', name: '10° taper 1mm tip', type: 'taper', diameterMM: 1.0, fluteCount: 2,
    rpm: 18000, xyFeedMmMin: 1200, zFeedMmMin: 300, maxDepthMM: 25, vbitAngleDeg: 10,
  }
  const CASES: [string, number][] = [['ABO', 12], ['B', 12], ['B', 30], ['O', 20], ['HI', 20], ['WAVE', 10]]
  it('seats with nothing in the way, and the face is whole bar a few mm²', { timeout: 60000 }, async () => {
    for (const [s, size] of CASES) {
      const r = await auditInlayFit({
        groups: [{ boundaryD: text(s, size) }], roughTool: ENDMILL, wallTool: TAPER,
        params: { ...PARAMS, angleDeg: 20 }, cellMM: 0.15,
      })
      expect(r.interference.areaMM2, `${s} ${size}: ${inlayFitSummary(r)}`).toBeLessThanOrEqual(0.5)
      // The gaps left are where the trim had to take more than the groove: hairlines at
      // stroke ends and corners. They ran to hundreds of mm² — whole counters — before.
      expect(r.surfaceGaps.areaMM2, `${s} ${size}: ${inlayFitSummary(r)}`).toBeLessThanOrEqual(10)
    }
  })

  // The trim's margin — twice the ball's depth at its tangent radius — is for the band a
  // ball wide either side of a stroke's centreline, where the groove is the ball's curve and
  // the plug's cut is the same curve the other way up. A fit clearance hides it (the socket
  // grows, and the groove deepens by c / tanθ), so it is pinned with none: without the
  // margin a 12 mm ABO stood 0.16 mm proud over 26 mm².
  it('seats with no fit clearance at all', { timeout: 60000 }, async () => {
    for (const [s, size] of [['ABO', 12], ['WAVE', 10]] as [string, number][]) {
      const r = await auditInlayFit({
        groups: [{ boundaryD: text(s, size) }], roughTool: ENDMILL, wallTool: TAPER,
        params: { ...PARAMS, angleDeg: 20, clearanceMM: 0 }, cellMM: 0.1,
      })
      expect(r.interference.areaMM2, `${s} ${size}: ${inlayFitSummary(r)}`).toBeLessThanOrEqual(0.5)
    }
  })
})

describe('a single letter with counters, cut with a V-bit', () => {
  // One letter is one region, so it goes the outline route: a floor pocket, V-carved walls,
  // and on the plug a hole for each counter. Two ways that went wrong, both only near 12 mm:
  //  - a B's two counters, grown to their floor edges, covered the WHOLE floor between them.
  //    Empty and failed both came back from the boolean as null, and the fallback pocketed
  //    the floor round the counters as islands crossing its wall — through the upper counter,
  //    3.2 mm deep (a 13 mm² hole in the finished face);
  //  - an O's counter hole was too narrow for the plug's deep wall band and too wide to
  //    V-carve whole: the bit could not reach the wall beside the stroke, and the plug stood
  //    0.6 mm proud of it (Q, and a 16 mm lowercase o, the same).
  const CASES: [string, number][] = [['B', 12], ['O', 12], ['Q', 12], ['o', 16], ['B', 20]]
  it('seats, and the face is whole', { timeout: 60000 }, async () => {
    for (const [s, size] of CASES) {
      const r = await fit(text(s, size))
      const why = `${s} ${size}: ${inlayFitSummary(r)}`
      expect(r.interference.areaMM2, why).toBeLessThanOrEqual(0.5)
      expect(r.surfaceGaps.areaMM2, why).toBeLessThanOrEqual(SLACK_MM2)
      expect(r.overcut.areaMM2, why).toBeLessThanOrEqual(SLACK_MM2)
    }
  })
})
