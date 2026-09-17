import { describe, it, expect, beforeEach } from 'vitest'
import { generateGcode, generateGcodePerTool } from './gcode'
import { parseGcode } from '../sim/gcodeParser'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import type { Tool } from '../store/toolStore'
import type { AnyOperation, MotionSegment, ProfileOperation } from '../store/toolpathStore'

// Deterministic post: RS274 motion grammar (same as the Grbl preset), semicolon
// comments, no unit/homing boilerplate beyond G21/G90.
const POST: PostProcessorProfile = {
  id: 'test-post',
  name: 'Test Post',
  unitMode: 'mm',
  commentStyle: 'semicolon',
  startGcode: 'G21\nG90',
  endGcode: 'M5\nG0 Z10\nM30',
  toolChangeGcode: 'M5\nM0',
  spindleOnTemplate: 'M3 S{s}',
  spindleOffGcode: 'M5',
  rapidTemplate: 'G0 X{x} Y{y} Z{z}',
  cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
  arcCWTemplate: 'G2 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  arcCCWTemplate: 'G3 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  outputArcs: true,
}

const TOOL: Tool = {
  id: 't1', name: 'Test End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const TOOL2: Tool = {
  id: 't2', name: 'Small End Mill', type: 'endmill', diameterMM: 3.175, fluteCount: 2,
  rpm: 24000, xyFeedMmMin: 600, zFeedMmMin: 200, maxDepthMM: 15,
}
const TOOLS = { t1: TOOL, t2: TOOL2 }

function makeOp(segments: MotionSegment[], overrides: Partial<ProfileOperation> = {}): AnyOperation {
  return {
    id: 'op1', name: 'Profile 1', type: 'profile', toolId: 't1', pathId: 'p1',
    side: 'outside', depthMM: 5, stepDownMM: 3, direction: 'climb', rampIn: false,
    status: 'done', segments, color: '#fff', visible: true,
    ...overrides,
  }
}

const cut = (x: number, y: number, z: number, extra: Partial<MotionSegment> = {}): MotionSegment =>
  ({ x, y, z, rapid: false, ...extra })
const rapid = (x: number, y: number, z: number): MotionSegment => ({ x, y, z, rapid: true })

const gen = (ops: AnyOperation[], post: PostProcessorProfile = POST) =>
  generateGcode(ops, TOOLS, 'test-project', post)

beforeEach(() => {
  // Pin every workpiece/machine field the emitter reads. autoFeedEnabled=false +
  // maxFeedMmMin=0 (no cap) make feedsForTool return the tool's stored feeds verbatim.
  useWorkpieceStore.setState({
    widthMM: 100, heightMM: 80, thicknessMM: 12,
    origin: 'bottom-left', zOrigin: 'top', spindleType: 'vfd',
    autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

describe('generateGcode — header and footer', () => {
  it('emits project comments, start gcode, spindle-on, and end gcode', () => {
    const g = gen([makeOp([rapid(0, 0, 5), cut(0, 0, -1), cut(10, 0, -1)])])
    const lines = g.split('\n')
    expect(lines[0]).toBe('; test-project')
    expect(g).toContain('; Post-processor: Test Post')
    expect(g).toContain('; Origin: bottom-left  offset X0.000 Y0.000')
    expect(lines).toContain('G21')
    expect(lines).toContain('G90')
    expect(lines).toContain('M3 S18000')
    expect(lines[lines.length - 1]).toBe('M30')
    // tool comment carries the metadata the sim parser reads back
    expect(g).toContain('dia 6.000mm  flutes:2')
  })

  it('emits only a comment and M30 when there is nothing to export', () => {
    const hidden = makeOp([cut(0, 0, -1), cut(10, 0, -1)], { visible: false })
    const g = gen([hidden])
    expect(g).toContain('; No toolpaths to export.')
    expect(g.split('\n')[g.split('\n').length - 1]).toBe('M30')
    expect(g).not.toContain('G1 ')
  })
})

describe('generateGcode — motion emission', () => {
  it('emits rapids via G0 and cuts via G1 with 2-decimal mm coords', () => {
    const g = gen([makeOp([rapid(10, 10, 5), cut(10, 10, -2), cut(20, 10, -2)])])
    expect(g).toContain('G0 X10.000 Y10.000 Z5.000')
    expect(g).toContain('G1 X20.000 Y10.000 Z-2.000 F1000')
  })

  it('uses plunge feed for pure-Z descents and xy feed for lateral cuts', () => {
    const g = gen([makeOp([rapid(10, 10, 5), cut(10, 10, -2), cut(20, 10, -2)])])
    expect(g).toContain('G1 X10.000 Y10.000 Z-2.000 F300')  // zFeedMmMin
    expect(g).toContain('G1 X20.000 Y10.000 Z-2.000 F1000') // xyFeedMmMin
  })

  it('applies feedScale to the cut feed', () => {
    const g = gen([makeOp([rapid(0, 0, 5), cut(0, 0, -1), cut(15, 0, -1, { feedScale: 0.5 })])])
    expect(g).toContain('G1 X15.000 Y0.000 Z-1.000 F500')
  })

  it('skips zero-motion duplicate segments', () => {
    const g = gen([makeOp([rapid(0, 0, 5), cut(0, 0, -1), cut(10, 0, -1), cut(10, 0, -1)])])
    const dupLines = g.split('\n').filter((l) => l.startsWith('G1 X10.000 Y0.000'))
    expect(dupLines.length).toBe(1)
  })
})

describe('generateGcode — arcs', () => {
  it('emits G3 for a CCW arc with I/J measured from the arc start point', () => {
    const g = gen([makeOp([
      rapid(10, 0, 5),
      cut(10, 0, -1),
      cut(-10, 0, -1, { arc: { cx: 0, cy: 0, cw: false } }),
    ])])
    expect(g).toContain('G3 X-10.000 Y0.000 Z-1.000 I-10.000 J0.000 F1000')
  })

  it('emits a full-circle arc even though start equals end', () => {
    const g = gen([makeOp([
      rapid(10, 0, 5),
      cut(10, 0, -1),
      cut(10, 0, -1, { arc: { cx: 0, cy: 0, cw: true } }),
    ])])
    expect(g).toContain('G2 X10.000 Y0.000 Z-1.000 I-10.000 J0.000 F1000')
  })

  it('runs helical arcs (Z changing) at plunge feed', () => {
    const g = gen([makeOp([
      rapid(10, 0, 5),
      cut(10, 0, 0),
      cut(10, 0, -3, { arc: { cx: 0, cy: 0, cw: true } }),
    ])])
    expect(g).toContain('G2 X10.000 Y0.000 Z-3.000 I-10.000 J0.000 F300')
  })

  // Grbl and FluidNC reject an arc whose two radii disagree (gcode.c):
  //   delta_r = |r_end - r_start|; fail when delta_r > 0.005mm AND > 0.001*r.
  // The 0.001*r term means big arcs are forgiving and small ones get a flat 5µm
  // budget — which is why error 33 ("Gcode invalid target") showed up only on
  // tight corner arcs in a real job. Both radii are measured from the centre the
  // CONTROLLER reconstructs: (last emitted point) + (I,J), rounded as written.
  const arcRadiusMismatchMM = (gcode: string): number => {
    let x = 0, y = 0, worst = 0
    for (const raw of gcode.split('\n')) {
      const line = raw.replace(/[;(].*$/, '').trim()
      if (!line) continue
      const num = (w: string) => {
        const m = new RegExp(`${w}(-?\\d*\\.?\\d+)`).exec(line)
        return m ? parseFloat(m[1]) : null
      }
      const nx = num('X') ?? x, ny = num('Y') ?? y
      if (/\bG[23]\b/.test(line)) {
        const cx = x + (num('I') ?? 0), cy = y + (num('J') ?? 0)
        worst = Math.max(worst, Math.abs(Math.hypot(nx - cx, ny - cy) - Math.hypot(x - cx, y - cy)))
      }
      x = nx; y = ny
    }
    return worst
  }

  it('keeps a small arc inside the radius tolerance Grbl rejects on', () => {
    // r ~= 3.97mm at an awkward centre, the shape that failed: every coordinate
    // and both offsets land mid-way between output steps, so each one rounds.
    const cx = 344.0043, cy = 231.6287, r = 3.96709
    const a0 = 2.4183, a1 = 0.9042
    const sx = cx + r * Math.cos(a0), sy = cy + r * Math.sin(a0)
    const ex = cx + r * Math.cos(a1), ey = cy + r * Math.sin(a1)
    const g = gen([makeOp([
      rapid(sx, sy, 5),
      cut(sx, sy, -1),
      cut(ex, ey, -1, { arc: { cx, cy, cw: false } }),
    ])])
    // Still a real arc, not silently expanded to chords.
    expect(g).toMatch(/\bG3 /)
    // Grbl's own test, applied to the bytes actually written.
    const dr = arcRadiusMismatchMM(g)
    expect(dr <= 0.005 || dr <= 0.001 * r).toBe(true)
  })

  it('expands an arc it cannot express within tolerance instead of emitting it', () => {
    // An arc whose endpoints are not equidistant from its centre cannot be
    // written as G2/G3 at any precision — the controller would reject the block
    // outright (error 33) and abort the job mid-cut. Chords are always accepted,
    // so the emitter degrades to them rather than shipping a file that stops.
    // Start sits at r=10 from the centre, end at r=10.5.
    const g = gen([makeOp([
      rapid(10, 0, 5),
      cut(10, 0, -1),
      cut(0, 10.5, -1, { arc: { cx: 0, cy: 0, cw: false } }),
    ])])
    expect(g).not.toMatch(/\bG[23] /)
    expect(g).toContain('arc expanded to lines')
    // The move still happens, and still ends where it was asked to.
    expect(g).toContain('X0.000 Y10.500 Z-1.000')
  })

  it('expands arcs to G1 chords when the post cannot output arcs', () => {
    const g = gen([makeOp([
      rapid(10, 0, 5),
      cut(10, 0, -1),
      cut(-10, 0, -1, { arc: { cx: 0, cy: 0, cw: false } }),
    ])], { ...POST, outputArcs: false })
    expect(g).not.toContain('G2 ')
    expect(g).not.toContain('G3 ')
    const chords = g.split('\n').filter((l) => l.startsWith('G1 ') && !l.includes('Z-1.000 F300'))
    expect(chords.length).toBeGreaterThan(10)
    // last chord lands on the arc endpoint
    expect(chords[chords.length - 1]).toContain('X-10.000 Y0.000')
  })
})

describe('generateGcode — origin and Z datum', () => {
  it('shifts XY by the workpiece origin offset', () => {
    useWorkpieceStore.setState({ origin: 'center' }) // org = (50, 40)
    const g = gen([makeOp([rapid(60, 50, 5), cut(60, 50, -1), cut(50, 40, -1)])])
    expect(g).toContain('G0 X10.000 Y10.000 Z5.000')
    expect(g).toContain('G1 X0.000 Y0.000 Z-1.000')
    expect(g).toContain('; Origin: center  offset X50.000 Y40.000')
  })

  it('bottom-of-stock Z origin lifts emitted Z by the stock thickness', () => {
    useWorkpieceStore.setState({ zOrigin: 'bottom' }) // thickness 12 → zOff +12
    const g = gen([makeOp([rapid(0, 0, 5), cut(0, 0, 0), cut(10, 0, -12)])])
    expect(g).toContain('G0 X0.000 Y0.000 Z17.000')  // 5 + 12
    expect(g).toContain('G1 X0.000 Y0.000 Z12.000')  // top surface
    expect(g).toContain('G1 X10.000 Y0.000 Z0.000')  // stock bottom = Z0
    // hardcoded retract in endGcode is shifted too
    expect(g).toContain('G0 Z22.000')
  })

  it('converts coordinates and feeds to inches in an inch post', () => {
    const g = gen(
      [makeOp([rapid(25.4, 0, 25.4), cut(25.4, 0, -25.4), cut(50.8, 0, -25.4)])],
      { ...POST, unitMode: 'in', startGcode: 'G20\nG90' },
    )
    expect(g).toContain('G0 X1.0000 Y0.0000 Z1.0000')
    expect(g).toContain('G1 X2.0000 Y0.0000 Z-1.0000 F39') // 1000 mm/min ≈ 39.37 in/min
  })
})

describe('generateGcode — tool changes', () => {
  it('emits tool-change gcode, new tool comment, and new spindle speed at a toolChange marker', () => {
    const g = gen([makeOp([
      rapid(0, 0, 5),
      cut(0, 0, -1),
      cut(10, 0, -1),
      { x: 10, y: 0, z: 5, rapid: true, toolChange: 't2' },
      rapid(20, 0, 5),
      cut(20, 0, -1),
      cut(30, 0, -1),
    ])])
    const lines = g.split('\n')
    const changeIdx = lines.findIndex((l) => l.includes('dia 3.175mm'))
    expect(changeIdx).toBeGreaterThan(0)
    // M5/M0 pause precedes the new-tool comment; new RPM follows it
    expect(lines.slice(0, changeIdx)).toContain('M3 S18000')
    expect(lines.slice(changeIdx - 3, changeIdx)).toEqual(expect.arrayContaining(['M5', 'M0']))
    expect(lines.slice(changeIdx)).toContain('M3 S24000')
    // cuts after the change use the second tool's feed
    expect(g).toContain('G1 X30.000 Y0.000 Z-1.000 F600')
  })
})

describe('generateGcode — arc reconstruction of dense chords', () => {
  it('collapses collinear chord runs to a single G1 move', () => {
    const segs: MotionSegment[] = [rapid(0, 0, 5), cut(0, 0, -1)]
    for (let x = 1; x <= 50; x++) segs.push(cut(x, 0, -1))
    const g = gen([makeOp(segs)])
    const cuts = g.split('\n').filter((l) => l.startsWith('G1 '))
    expect(cuts.length).toBe(2) // plunge + one straight move
    expect(cuts[1]).toBe('G1 X50.000 Y0.000 Z-1.000 F1000')
  })

  it('collapses chords that approximate a circle into G2/G3 arcs', () => {
    // CCW semicircle r=10 about (30,30), 2° chords
    const segs: MotionSegment[] = [rapid(40, 30, 5), cut(40, 30, -1)]
    for (let a = 2; a <= 180; a += 2) {
      const rad = (a * Math.PI) / 180
      segs.push(cut(30 + 10 * Math.cos(rad), 30 + 10 * Math.sin(rad), -1))
    }
    const g = gen([makeOp(segs)])
    const motion = g.split('\n').filter((l) => /^G[123] /.test(l))
    expect(g).toContain('G3 ')
    expect(motion.length).toBeLessThan(10) // 90 chords compressed
  })

  it('leaves feed-overridden segments unfused to preserve their feed', () => {
    const segs: MotionSegment[] = [rapid(0, 0, 5), cut(0, 0, -1)]
    for (let x = 1; x <= 10; x++) segs.push(cut(x, 0, -1, { feedScale: 0.5 }))
    const g = gen([makeOp(segs)])
    const slow = g.split('\n').filter((l) => l.startsWith('G1 ') && l.endsWith('F500'))
    expect(slow.length).toBe(10)
  })
})

describe('generateGcode — round-trip through the simulator parser', () => {
  it('a square profile parses back to the same corners with no warnings', () => {
    const corners: [number, number][] = [[20, 0], [20, 20], [0, 20], [0, 0]]
    const g = gen([makeOp([
      rapid(0, 0, 5),
      cut(0, 0, -2),
      ...corners.map(([x, y]) => cut(x, y, -2)),
      rapid(0, 0, 5),
    ])])
    const parsed = parseGcode(g, 5)
    expect(parsed.warnings).toEqual([])
    const cutSegs = parsed.segments.filter((s) => !s.rapid)
    // plunge + 4 corners survive (collinear-run thinning keeps corners)
    expect(cutSegs.length).toBe(5)
    for (let i = 0; i < corners.length; i++) {
      expect(cutSegs[i + 1].x).toBeCloseTo(corners[i][0], 2)
      expect(cutSegs[i + 1].y).toBeCloseTo(corners[i][1], 2)
      expect(cutSegs[i + 1].z).toBeCloseTo(-2, 2)
    }
    // tool metadata comment round-trips into the parser's tool table
    expect(parsed.toolStates.some((t) => Math.abs(t.toolDiameterMM - 6) < 1e-6)).toBe(true)
  })

  it('a reconstructed arc parses back onto the original circle', () => {
    const segs: MotionSegment[] = [rapid(40, 30, 5), cut(40, 30, -1)]
    for (let a = 2; a <= 180; a += 2) {
      const rad = (a * Math.PI) / 180
      segs.push(cut(30 + 10 * Math.cos(rad), 30 + 10 * Math.sin(rad), -1))
    }
    const parsed = parseGcode(gen([makeOp(segs)]), 5)
    expect(parsed.warnings).toEqual([])
    const arcPts = parsed.segments.filter((s) => !s.rapid && s.z < 0 && (s.x !== s.prevX || s.y !== s.prevY))
    expect(arcPts.length).toBeGreaterThan(4)
    for (const s of arcPts) {
      expect(Math.hypot(s.x - 30, s.y - 30)).toBeCloseTo(10, 1)
    }
    const end = arcPts[arcPts.length - 1]
    expect(end.x).toBeCloseTo(20, 1)
    expect(end.y).toBeCloseTo(30, 1)
  })
})


// ─── Per-tool split ───────────────────────────────────────────────────────────
// One file per tool, for a machine with no changer: the operator loads a tool, runs
// its file, loads the next. What makes it delicate is that the split is by MOTION,
// not by operation — a 3D profile carries both its tools in one segment stream, with
// a `toolChange` marker at the handover — so the question every test here asks is
// whether the cutting survives being cut up.

const TOOL_R: Tool = {
  id: 'tr', name: 'Rough 6mm', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const TOOL_F: Tool = {
  id: 'tf', name: 'Ball 3mm', type: 'ballnose', diameterMM: 3, fluteCount: 2,
  rpm: 24000, xyFeedMmMin: 600, zFeedMmMin: 200, maxDepthMM: 15,
}
const SPLIT_TOOLS = { t1: TOOL, t2: TOOL2, tr: TOOL_R, tf: TOOL_F }

/** A 3D profile: one op, two tools, handed over mid-stream by a toolChange marker. */
const make3d = (over: Partial<AnyOperation> = {}): AnyOperation => ({
  id: 'p3', name: '3D Profile', type: 'profile3d', toolId: 'tf', roughingToolId: 'tr',
  pathId: 'p', status: 'done', color: '#fff', visible: true,
  stepoverPercent: 40, rasterAngleDeg: 0, maxDepthMM: 10,
  segments: [
    rapid(0, 0, 5), cut(0, 0, -3), cut(10, 0, -3),
    { x: 10, y: 0, z: 5, rapid: true, toolChange: 'tf' },
    rapid(20, 0, 5), cut(20, 0, -1), cut(30, 0, -1),
  ],
  ...over,
} as AnyOperation)

const split = (ops: AnyOperation[], tools = SPLIT_TOOLS) =>
  generateGcodePerTool(ops, tools, 'proj', POST)

/** Cutting lines only — the material removal, which splitting must not change. */
const cutLines = (g: string) => g.split('\n').filter((l) => l.startsWith('G1 '))

describe('generateGcodePerTool — which files come out', () => {
  it('makes one file per tool, in order of first use', () => {
    const files = split([
      makeOp([rapid(0, 0, 5), cut(0, 0, -1), cut(10, 0, -1)], { id: 'a', toolId: 't1' }),
      makeOp([rapid(20, 0, 5), cut(20, 0, -1), cut(30, 0, -1)], { id: 'b', toolId: 't2' }),
    ])
    expect(files.map((f) => f.toolId)).toEqual(['t1', 't2'])
    expect(files.map((f) => f.toolName)).toEqual(['Test End Mill', 'Small End Mill'])
    expect(files.map((f) => f.rpm)).toEqual([18000, 24000])
  })

  it('gives a tool ONE file however many times the program comes back to it', () => {
    // The ops list is flat and new ops append, so A, B, A is an ordinary program. Three
    // files would mean loading the first tool twice, which is the thing this avoids.
    const files = split([
      makeOp([rapid(0, 0, 5), cut(0, 0, -1), cut(10, 0, -1)], { id: 'a', toolId: 't1' }),
      makeOp([rapid(20, 0, 5), cut(20, 0, -1), cut(30, 0, -1)], { id: 'b', toolId: 't2' }),
      makeOp([rapid(40, 0, 5), cut(40, 0, -1), cut(50, 0, -1)], { id: 'c', toolId: 't1' }),
    ])
    expect(files.map((f) => f.toolId)).toEqual(['t1', 't2'])
    expect(cutLines(files[0].gcode)).toHaveLength(4)   // both t1 operations
    expect(cutLines(files[1].gcode)).toHaveLength(2)
  })

  it('puts the roughing tool before the finishing one', () => {
    // A 3D profile names its FINISHING tool in `toolId`, so reading that alone would
    // hand the operator the ball nose first and the roughing pass second.
    expect(split([make3d()]).map((f) => f.toolId)).toEqual(['tr', 'tf'])
  })

  it('leaves out everything generateGcode would leave out', () => {
    expect(split([
      makeOp([rapid(0, 0, 5), cut(0, 0, -1)], { id: 'a', visible: false }),
      makeOp([rapid(0, 0, 5), cut(0, 0, -1)], { id: 'b', status: 'error' }),
      makeOp([], { id: 'c' }),
      { ...makeOp([rapid(0, 0, 5), cut(0, 0, -1)], { id: 'd' }), type: 'gcode' } as AnyOperation,
    ])).toEqual([])
  })

  it('skips an operation whose tool is not in the library', () => {
    expect(split([makeOp([rapid(0, 0, 5), cut(0, 0, -1)], { id: 'a', toolId: 'gone' })])).toEqual([])
  })

  it('makes no file for a tool that turns out to cut nothing', () => {
    // A 3D profile names a roughing tool whether or not the generator ended up emitting
    // a roughing pass — a shallow model can hand everything to the finishing tool. The
    // tool list is built from those NAMES, so without the empty check the operator is
    // handed a file that loads a cutter and then cuts nothing with it.
    const noRough = make3d({
      segments: [
        { x: 0, y: 0, z: 5, rapid: true, toolChange: 'tf' },
        rapid(20, 0, 5), cut(20, 0, -1), cut(30, 0, -1),
      ],
    } as Partial<AnyOperation>)
    expect(split([noRough]).map((f) => f.toolId)).toEqual(['tf'])
  })

  it('numbers the files and sanitises the tool name into them', () => {
    const odd: Tool = { ...TOOL, id: 'tx', name: '1/2" Bit: rough/finish' }
    const files = generateGcodePerTool(
      [makeOp([rapid(0, 0, 5), cut(0, 0, -1)], { id: 'a', toolId: 'tx' })], { tx: odd }, 'my proj', POST)
    expect(files[0].filename).toBe('my proj_1_1_2_ Bit_ rough_finish')
    // The file names itself in its own header, so a loose file on a USB stick says
    // which tool it wants.
    expect(files[0].gcode.split('\n')[0]).toBe('; my proj_1_1_2_ Bit_ rough_finish')
  })
})

describe('generateGcodePerTool — the motion survives the split', () => {
  it('cuts exactly what the single-file program cuts, no more and no less', () => {
    // The invariant the whole feature rests on: every cutting move appears in exactly
    // one file, and none is invented. A missed segment is a pass the part never gets.
    const ops = [
      makeOp([rapid(0, 0, 5), cut(0, 0, -1), cut(10, 0, -1)], { id: 'a', toolId: 't1' }),
      make3d(),
      makeOp([rapid(40, 0, 5), cut(40, 0, -1), cut(50, 0, -1)], { id: 'c', toolId: 't2' }),
    ]
    const combined = cutLines(generateGcode(ops, SPLIT_TOOLS, 'proj', POST)).sort()
    const perTool = split(ops).flatMap((f) => cutLines(f.gcode)).sort()
    expect(perTool).toEqual(combined)
  })

  it('sends each half of a 3D profile to its own tool, and only its own', () => {
    const [rough, finish] = split([make3d()])
    expect(cutLines(rough.gcode)).toEqual(['G1 X0.000 Y0.000 Z-3.000 F300', 'G1 X10.000 Y0.000 Z-3.000 F1000'])
    expect(cutLines(finish.gcode)).toEqual(['G1 X20.000 Y0.000 Z-1.000 F200', 'G1 X30.000 Y0.000 Z-1.000 F600'])
  })

  it('turns the handover marker into a plain positioning move', () => {
    // In the combined program that marker is where the operator swaps tools. Inside a
    // single-tool file there is nothing to swap, so it must not carry the pause — the
    // operator would be told to change to the tool already in the spindle.
    const [rough, finish] = split([make3d()])
    for (const f of [rough, finish]) {
      expect(f.gcode).not.toContain('\nM0')
    }
    // It survives as the rapid that positions the finishing tool for its first cut.
    expect(finish.gcode).toContain('G0 X10.000 Y0.000 Z5.000')
  })

  it('gives every file its own spindle speed and its own end block', () => {
    // Each is a complete program: it is loaded and run on its own.
    const files = split([make3d()])
    expect(files[0].gcode).toContain('M3 S18000')
    expect(files[0].gcode).not.toContain('M3 S24000')
    expect(files[1].gcode).toContain('M3 S24000')
    expect(files[1].gcode).not.toContain('M3 S18000')
    for (const f of files) expect(f.gcode.trimEnd().endsWith('M30')).toBe(true)
  })

  it('reports the speed the operator should set for the file', () => {
    const files = split([make3d()])
    expect(files.map((f) => f.rpm)).toEqual([18000, 24000])
  })
})
