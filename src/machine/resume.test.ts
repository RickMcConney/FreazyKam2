import { describe, it, expect, beforeEach } from 'vitest'
import { buildResume, programStarts, restartOptions, type ResumeResult, type RestartOption } from './resume'
import { parseGcode, type SimSegment } from '../sim/gcodeParser'
import { generateGcode } from '../cam/gcode'
import { useWorkpieceStore } from '../store/workpieceStore'
import { BUILTIN_PROFILES } from '../store/postProcessorStore'
import type { Tool } from '../store/toolStore'
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'

const ok = (r: ReturnType<typeof buildResume>): ResumeResult => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`)
  return r
}
const refusal = (r: ReturnType<typeof buildResume>): string => {
  if (r.ok) throw new Error('expected a refusal')
  return r.reason
}
const linesOf = (r: ResumeResult) => r.text.split(/\r?\n/)
const lastOf = <T>(a: T[]): T => a[a.length - 1]
/** The resume's lines from its first line up to (not including) line N's copy. */
const head = (r: ResumeResult) => linesOf(r).slice(0, r.lineInResume - 1)

// ─── A real program, written by our own emitter ───────────────────────────────

const T1: Tool = { id: 't1', name: 'Quarter End Mill', type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1500, zFeedMmMin: 400, maxDepthMM: 25 }
const T2: Tool = { id: 't2', name: 'Eighth End Mill', type: 'endmill', diameterMM: 3.175, fluteCount: 2, rpm: 22000, xyFeedMmMin: 900, zFeedMmMin: 250, maxDepthMM: 12 }

const cut = (x: number, y: number, z: number, extra: Partial<MotionSegment> = {}): MotionSegment => ({ x, y, z, rapid: false, ...extra })
const rapid = (x: number, y: number, z: number): MotionSegment => ({ x, y, z, rapid: true })

/** A square with an arc corner, cut in passes down to `depth`. */
function passes(x0: number, y0: number, depth: number, step: number): MotionSegment[] {
  const s: MotionSegment[] = [rapid(x0, y0, 5)]
  for (let z = -step; z >= -depth - 1e-9; z -= step) {
    s.push(cut(x0, y0, z))
    s.push(cut(x0 + 20, y0, z))
    s.push(cut(x0 + 30, y0 + 10, z, { arc: { cx: x0 + 20, cy: y0 + 10, cw: false } }))
    s.push(cut(x0 + 30, y0 + 25, z))
    s.push(cut(x0, y0 + 25, z))
    s.push(cut(x0, y0, z))
  }
  s.push(rapid(x0, y0, 5))
  return s
}

function op(id: string, name: string, toolId: string, segments: MotionSegment[]): AnyOperation {
  return {
    id, name, type: 'profile', toolId, pathId: 'p', side: 'outside', depthMM: 3, stepDownMM: 1,
    direction: 'climb', rampIn: false, status: 'done', segments, color: '#fff', visible: true,
  }
}

const OPS = [
  op('a', 'Profile 1', 't1', passes(10, 10, 3, 1)),
  op('b', 'Pocket 2', 't2', passes(50, 40, 2, 1)),
]

function program(profileId: string): string {
  const profile = BUILTIN_PROFILES.find((p) => p.id === profileId)!
  return generateGcode(OPS, { t1: T1, t2: T2 }, 'resume-test', profile)
}

/** The moves a program makes from `fromIdx` (0-based line) on, as the simulator parses them. */
const movesFrom = (segs: SimSegment[], fromIdx: number) =>
  segs.filter((s) => s.lineIdx >= fromIdx).map((s) => [s.x, s.y, s.z, s.rapid, s.feedRateMmMin, s.prevX, s.prevY, s.prevZ])

beforeEach(() => {
  useWorkpieceStore.setState({
    widthMM: 100, heightMM: 80, thicknessMM: 12, origin: 'bottom-left', zOrigin: 'top',
    spindleType: 'vfd', autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

describe('buildResume — the resumed file drives the machine exactly as the original from line N on', () => {
  for (const profileId of ['fluidnc-mm', 'grbl-in', 'linuxcnc-mm', 'mach3-mm', 'generic-mm']) {
    it(`at every line of a two-tool program with arcs (${profileId})`, () => {
      const text = program(profileId)
      const lines = text.split('\n')
      const orig = parseGcode(text).segments
      // From the line after the first move (before it the position is not set) to the last
      // move (after it nothing moves, and a resume is refused for that).
      const firstMove = orig[0].lineIdx
      const lastMove = lastOf(orig).lineIdx
      expect(lines.length).toBeGreaterThan(lastMove + 1)
      let checked = 0
      for (let n = firstMove + 2; n <= lastMove + 1; n++) {
        const r = ok(buildResume(text, n))
        const res = parseGcode(r.text).segments
        // Same motion, same feeds, from the same start point.
        expect(movesFrom(res, r.lineInResume - 1), `line ${n}`).toEqual(movesFrom(orig, n - 1))
        // The entry ends where line N−1 left the tool.
        const entry = res.filter((s) => s.lineIdx < r.lineInResume - 1)
        // ...exactly where line N's first move starts: the position the controller holds
        // after line N−1 (not the end of the simulator's last chord of an arc, which lies
        // on the arc's start radius).
        const first = orig.find((s) => s.lineIdx >= n - 1)!
        const last = lastOf(entry)
        expect([last.x, last.y, last.z], `line ${n}`).toEqual([first.prevX, first.prevY, first.prevZ])
        checked++
      }
      expect(checked).toBeGreaterThan(35)
    })
  }
})

describe('buildResume — the entry', () => {
  // Built after the top-level beforeEach has pinned the feeds (Auto Feeds off).
  let text = '', lines: string[] = [], n = 0
  beforeEach(() => {
    text = program('fluidnc-mm')
    lines = text.split('\n')
    // The second pass of Profile 1: a straight cut at Z-2 following the plunge. Found by
    // what it DOES — the line says only `X30.000 F1500`, the rest being modal.
    n = parseGcode(text).segments.find((s) => s.z === -2 && s.x === 30 && s.prevX === 10 && s.y === 10)!.lineIdx + 1
  })

  it('goes straight up first, then across at safe height, then down at the plunge feed', () => {
    const r = ok(buildResume(text, n))
    // The tool starts where a cancel left it: in the cut.
    const entry = parseGcode(r.text, -3).segments.filter((s) => s.lineIdx < r.lineInResume - 1)
    // Up: a pure Z move, as a rapid.
    expect(entry[0]).toMatchObject({ rapid: true, x: 0, y: 0, z: 5, prevX: 0, prevY: 0, prevZ: -3 })
    // Across: at safe height, never lower.
    const across = entry.filter((s) => s.x !== s.prevX || s.y !== s.prevY)
    expect(across.length).toBeGreaterThan(0)
    for (const s of across) expect(s.z === 5 && s.prevZ === 5 && s.rapid).toBe(true)
    // Down: the last move, a feed move straight down at the program's own plunge feed.
    const down = lastOf(entry)
    expect(down).toMatchObject({ rapid: false, x: down.prevX, y: down.prevY, z: -2, feedRateMmMin: 400 })
  })

  it('writes the coordinates as the file wrote them, so an arc on line N starts where its I/J were measured from', () => {
    const arcLine = lines.findIndex((l) => /^G3 /.test(l)) + 1
    const r = ok(buildResume(text, arcLine))
    // The line before the arc says only `X30.000 F1500`; Y and Z are what earlier lines
    // wrote, and the entry carries all three in the file's own text.
    expect(lines[arcLine - 2]).not.toMatch(/Y/)
    expect(head(r)).toContain('G0 X30.000 Y10.000')
    expect(head(r)).toContain('G1 Z-1.000 F400')
  })

  it('restores the cutting feed after the plunge', () => {
    const arcLine = lines.findIndex((l) => /^G3 /.test(l)) + 1
    const h = head(ok(buildResume(text, arcLine)))
    expect(h.slice(-2)).toEqual(['G1 Z-1.000 F400', 'F1500'])
  })

  it('restates the feed in force when the entry has no descent, since line N may not carry one', () => {
    // A program that writes only what changes: line 7 moves at F800 without saying so.
    const t = ['G21', 'G90', 'M3 S18000', 'G0 X0 Y0 Z5', 'G1 X10 F800', 'X20', 'X30'].join('\n')
    const r = ok(buildResume(t, 7))
    expect(lastOf(head(r))).toBe('F800')
    const move = parseGcode(r.text).segments.find((s) => s.lineIdx === r.lineInResume - 1)!
    expect(move).toMatchObject({ x: 30, prevX: 20, feedRateMmMin: 800 })
  })

  it('leaves the feed alone when the one in force is the plunge feed', () => {
    // Line N follows the plunge itself, which set F400: that IS the feed in force.
    expect(lastOf(head(ok(buildResume(text, n))))).toBe('G1 Z-2.000 F400')
  })

  it('needs no plunge feed when the entry point is at safe height', () => {
    const atSafe = lines.findIndex((l) => /^G0 X10\.000 Y10\.000 Z5\.000/.test(l)) + 2
    const r = ok(buildResume(text, atSafe))
    expect(head(r).some((l) => /^G1 /.test(l))).toBe(false)
  })

  it('restates the modal state and restarts the spindle at the speed in force', () => {
    const h = head(ok(buildResume(text, n)))
    expect(h).toContain('G21 G90 G17 G94')
    expect(h).toContain('M3 S18000')
    expect(h.indexOf('M3 S18000')).toBeLessThan(h.findIndex((l) => /^G0 X/.test(l)))
  })

  it('copies the file\'s own preamble and the comment block of the tool in force, so the simulator knows the bit', () => {
    const r = ok(buildResume(text, n))
    expect(linesOf(r)[0]).toBe('(resume-test)')
    expect(head(r).some((l) => /^\(Tool: Quarter End Mill +dia 6\.350mm/.test(l))).toBe(true)
        const ts = parseGcode(r.text)
    expect(ts.toolStates[ts.segments[ts.segments.length - 1].toolStateIdx].toolDiameterMM).toBeCloseTo(3.175, 3)
    expect(ts.toolStates[ts.segments.find((s) => s.lineIdx >= r.lineInResume - 1)!.toolStateIdx].toolDiameterMM).toBeCloseTo(6.35, 3)
  })

  it('carries a V-bit\'s shape lines with its tool comment, so the resume simulates with a V', () => {
    const v = [
      '(v)', 'G21 G90', '(=== V-Carve 1 ===)', '(Tool: 60 V-Bit  dia 6.350mm  flutes:2)', '(vbit-angle:30.000)',
      'M3 S20000', 'G0 X0.000 Y0.000 Z5.000', 'G1 X0.000 Y0.000 Z-1.000 F300', 'G1 X10.000 Y0.000 Z-2.000 F900', 'G0 X10.000 Y0.000 Z5.000', 'M30',
    ].join('\n')
    const r = ok(buildResume(v, 9))
    expect(head(r)).toContain('(vbit-angle:30.000)')
    const p = parseGcode(r.text)
    const ts = p.toolStates[p.segments.find((s) => s.lineIdx >= r.lineInResume - 1)!.toolStateIdx]
    expect(ts.toolVbitHalfAngleTan).toBeCloseTo(Math.tan(Math.PI / 6), 6)
  })

  it('names the operation and the tool, and warns after a tool change', () => {
    const r1 = ok(buildResume(text, n))
    expect(r1).toMatchObject({ operation: 'Profile 1', toolChangesBefore: 0, spindleOn: true, units: 'mm' })
    expect(r1.warnings).toEqual([])
    const inOp2 = parseGcode(text).segments.find((s) => s.z === -1 && s.x === 70 && s.y === 40 && s.prevX === 50)!.lineIdx + 1
    const r2 = ok(buildResume(text, inOp2))
    expect(r2.operation).toBe('Pocket 2')
    expect(r2.toolChangesBefore).toBe(1)
    expect(r2.tool).toMatch(/Eighth End Mill/)
    expect(r2.warnings.join(' ')).toMatch(/changed tools 1 time.*Eighth End Mill/)
    // The tool change's own M0 pause is before the line, so it is not in the resume.
    expect(head(r2).some((l) => /^M0\b/.test(l))).toBe(false)
  })

  it('takes its safe height from where the program\'s XY rapids run', () => {
    expect(ok(buildResume(text, n)).safeZ).toBe(5)
    const r = ok(buildResume(text, n, { safeZ: 12, plungeFeed: 150 }))
    expect(head(r)).toContain('G0 Z12')
    expect(head(r)).toContain('G1 Z-2.000 F150')
  })

  it('can pause after the spindle command, or dwell', () => {
    const p = head(ok(buildResume(text, n, { pauseForSpindle: true, dwellS: 3 })))
    const m3 = p.indexOf('M3 S18000')
    expect(p[m3 + 1]).toMatch(/^M0 \(MSG, /)
    expect(p[m3 + 2]).toBe('G4 P3')
  })

  it('keeps the file\'s line endings', () => {
    const crlf = text.replace(/\n/g, '\r\n')
    const r = ok(buildResume(crlf, n))
    expect(r.text.split('\r\n').length).toBe(linesOf(r).length)
    expect(r.text.replace(/\r\n/g, '')).not.toMatch(/\n/)
  })
})

// ─── Programs from elsewhere: modal words, other dialects ──────────────────────

describe('buildResume — a program that leans on modal words', () => {
  // Another CAM's style: the motion word once, then bare coordinates; F once.
  const OTHER = [
    '%',
    'G21 G90 G17',
    'G0 Z5',
    'M3 S16000',
    'G0 X0 Y0',
    'G1 Z-1 F300',
    'G1 X10 F1200',
    'Y10',
    'G2 X20 Y20 I10 J0',
    'X30 Y10 I0 J-10',
    'X20 Y0 I-10 J0',
    'G0 Z5',
    'M5',
    'M30',
  ].join('\n')

  it('puts the motion mode in force on the first move after the entry', () => {
    const r = ok(buildResume(OTHER, 10))   // 'X30 Y10 I0 J-10', still in G2
    expect(linesOf(r)[r.lineInResume - 1]).toBe('G2 X30 Y10 I0 J-10')
    expect(linesOf(r)[r.lineInResume]).toBe('X20 Y0 I-10 J0')   // only the first one
    const r2 = ok(buildResume(OTHER, 8))   // 'Y10', in G1
    expect(linesOf(r2)[r2.lineInResume - 1]).toBe('G1 Y10')
  })

  it('reproduces the original motion from that line', () => {
    const orig = parseGcode(OTHER).segments
    for (let n = 7; n <= 12; n++) {
      const r = ok(buildResume(OTHER, n))
      expect(movesFrom(parseGcode(r.text).segments, r.lineInResume - 1), `line ${n}`).toEqual(movesFrom(orig, n - 1))
    }
  })

  it('leaves a line that names its own motion word as it is', () => {
    const r = ok(buildResume(OTHER, 9))
    expect(linesOf(r)[r.lineInResume - 1]).toBe('G2 X20 Y20 I10 J0')
  })

  it('takes the plunge feed from the program\'s last move straight down', () => {
    expect(ok(buildResume(OTHER, 10)).plungeFeed).toBe(300)
  })

  it('writes its own notes in the file\'s comment style, or none', () => {
    expect(head(ok(buildResume(OTHER, 10))).some((l) => /RESUMED/.test(l))).toBe(false)
    const semi = OTHER.replace('G21 G90 G17', 'G21 G90 G17 ; setup')
    expect(head(ok(buildResume(semi, 10))).some((l) => /^; RESUMED from line 10/.test(l))).toBe(true)
  })

  it('copies the preamble up to the first move or M-code, and no further', () => {
    const r = ok(buildResume(OTHER, 10))
    expect(head(r).slice(0, 2)).toEqual(['%', 'G21 G90 G17'])
    expect(head(r).filter((l) => l === 'G0 Z5').length).toBe(1)   // the entry's own, not the file's
  })

  it('works out a position reached in a G91 section, once the program is back in G90', () => {
    const rel = ['G21 G90', 'G0 Z5', 'G0 X1 Y1', 'G91', 'G0 X2.5 Y-0.25', 'G90', 'G1 Z-1 F200', 'G1 X10 F800', 'M30'].join('\n')
    const r = ok(buildResume(rel, 8))
    expect(r.entry).toEqual({ x: 3.5, y: 0.75, z: -1 })
    expect(head(r)).toContain('G0 X3.5 Y0.75')
  })

  it('restarts the spindle at the latest S, and leaves it off when the program had stopped it', () => {
    const sp = ['G21 G90', 'G0 Z5', 'M3 S12000', 'G0 X0 Y0', 'S15000', 'G1 Z-1 F200', 'G1 X5 F800', 'M5', 'G0 Z5', 'G0 X9', 'M30'].join('\n')
    expect(head(ok(buildResume(sp, 7)))).toContain('M3 S15000')
    const off = ok(buildResume(sp, 10))
    expect(off.spindleOn).toBe(false)
    expect(head(off).some((l) => /^M[34]/.test(l))).toBe(false)
    expect(off.warnings.join(' ')).toMatch(/spindle is off/)
  })

  it('restates work offset, tool length offset and coolant', () => {
    const lc = ['G21 G90 G55', 'G43 H2', 'G0 Z5', 'M3 S10000', 'M8', 'G0 X0 Y0', 'G1 Z-1 F100', 'G1 X5 F500', 'M30'].join('\n')
    const h = head(ok(buildResume(lc, 8)))
    expect(h).toContain('G21 G90 G55')
    expect(h).toContain('G43 H2')
    expect(h).toContain('M8')
  })
})

describe('buildResume — refuses what a line of G-code cannot be resumed from', () => {
  const base = ['G21 G90', 'G0 Z5', 'M3 S10000', 'G0 X0 Y0', 'G1 Z-1 F100']

  it('a line outside the program, or line 1', () => {
    expect(refusal(buildResume('G0 X1', 0))).toMatch(/not in the program/)
    expect(refusal(buildResume('G0 X1', 5))).toMatch(/not in the program/)
    expect(refusal(buildResume('G0 X1\nG0 X2', 1))).toMatch(/start of the program/)
  })

  it('before the program has set X, Y and Z', () => {
    expect(refusal(buildResume(base.join('\n'), 3))).toMatch(/X\/Y position is not known/)
  })

  it('inside a G91 relative section', () => {
    const t = [...base, 'G91', 'G1 X5 F500', 'G1 Y5', 'G90', 'M30'].join('\n')
    expect(refusal(buildResume(t, 8))).toMatch(/G91/)
  })

  it('after the program has ended', () => {
    const t = [...base, 'G1 X5 F500', 'M30', 'G0 X0'].join('\n')
    expect(refusal(buildResume(t, 8))).toMatch(/ends/)
  })

  it('under cutter compensation, in a canned cycle, in inverse-time feed', () => {
    expect(refusal(buildResume([...base, 'G41 D1', 'G1 X5 F500', 'G1 Y5', 'G40'].join('\n'), 8))).toMatch(/compensation/)
    expect(refusal(buildResume([...base, 'G0 Z5', 'G83 X5 Y5 Z-5 R1 Q1 F100', 'X10 Y5', 'G80'].join('\n'), 8))).toMatch(/canned/)
    expect(refusal(buildResume([...base, 'G93', 'G1 X5 F2', 'G1 Y5 F2'].join('\n'), 8))).toMatch(/G93/)
  })

  it('after G92 has moved the coordinate system', () => {
    expect(refusal(buildResume([...base, 'G92 X0 Y0', 'G1 X5 F500', 'G1 Y5'].join('\n'), 8))).toMatch(/G92/)
  })

  it('after a machine-coordinate or homing move, until the program sets every axis again', () => {
    const t = [...base, 'G53 G0 Z0', 'G0 X1 Y1', 'G0 Z2', 'G1 Z-1 F100', 'G1 X5 F500'].join('\n')
    expect(refusal(buildResume(t, 8))).toMatch(/Z position is not known/)
    expect(ok(buildResume(t, 10)).entry).toEqual({ x: 1, y: 1, z: -1 })
  })

  it('a rotary axis', () => {
    expect(refusal(buildResume([...base, 'G1 A90 F500', 'G1 X5'].join('\n'), 7))).toMatch(/rotary/)
  })

  it('nothing left to cut', () => {
    expect(refusal(buildResume([...base, 'M5', '(done)'].join('\n'), 7))).toMatch(/Nothing moves/)
  })
})

// ─── Restart points: starts, parts, the four options ───────────────────────────────

// Two parts, each cut in passes that lift to safe height between them — the shape of a
// sheet of small parts. Line numbers are noted because the tests are about them.
const SHEET = [
  '(sheet)',                                    // 1
  'G21 G90 G17',                                // 2
  '(=== Profile 1 ===)',                        // 3
  '(Tool: Quarter End Mill  dia 6.350mm  flutes:2)', // 4
  'M3 S18000',                                  // 5
  'G0 X0.000 Y0.000 Z5.000',                    // 6
  'G1 X0.000 Y0.000 Z-1.000 F400',              // 7   start: part 1 pass 1
  'G1 X20.000 Y0.000 Z-1.000 F1500',            // 8
  'G0 X20.000 Y0.000 Z5.000',                   // 9
  'G0 X0.000 Y0.000 Z5.000',                    // 10
  'G1 X0.000 Y0.000 Z-2.000 F400',              // 11  start: part 1 pass 2
  'G1 X20.000 Y0.000 Z-2.000 F1500',            // 12
  'G1 X20.000 Y10.000 Z-2.000 F1500',           // 13
  'G0 X20.000 Y10.000 Z5.000',                  // 14
  '(=== Profile 2 ===)',                        // 15
  'G0 X40.000 Y0.000 Z5.000',                   // 16
  'G0 X40.000 Y0.000 Z0.500',                   // 17  start: part 2 (a rapid down to the ramp height)
  'G1 X50.000 Y0.000 Z-1.000 F1500',            // 18  ramp in, at the cutting feed
  'G1 X60.000 Y0.000 Z-1.000 F1500',            // 19
  'G0 X60.000 Y0.000 Z5.000',                   // 20
  'M5',                                         // 21
  'M30',                                        // 22
].join('\n')

const opt = (os: RestartOption[], kind: RestartOption['kind']) => os.find((o) => o.kind === kind)!

describe('programStarts — where a program comes down from safe height', () => {
  it('finds the line that takes the tool below safe height, not the rapid above it', () => {
    expect(programStarts(SHEET)).toMatchObject({ safeZ: 5, starts: [7, 11, 17] })
  })

  it('groups the starts into the program\'s operations', () => {
    expect(programStarts(SHEET).parts).toEqual([
      { name: 'Profile 1', line: 3, starts: [7, 11] },
      { name: 'Profile 2', line: 15, starts: [17] },
    ])
  })

  it('makes each start its own part in a file with no operation markers', () => {
    const bare = SHEET.split('\n').filter((l) => !/===/.test(l)).join('\n')
    expect(programStarts(bare).parts.map((p) => p.starts)).toEqual([[6], [10], [15]])
  })

  it('does not count a stay-down link between passes as a start', () => {
    // Our own fixture program steps down at depth between passes: one start per operation.
    const text = program('fluidnc-mm')
    const { starts, parts } = programStarts(text)
    expect(starts.length).toBe(2)
    expect(parts.map((p) => p.name)).toEqual(['Profile 1', 'Pocket 2'])
  })
})

describe('restartOptions — the four restarts around where a job stopped', () => {
  it('offers carry on, redo the pass, recut the part and skip to the next part', () => {
    const os = restartOptions(SHEET, 12)   // stopped in part 1, pass 2
    expect(os.map((o) => [o.kind, o.line])).toEqual([['continue', 12], ['pass', 11], ['part', 7], ['next', 17]])
    expect(opt(os, 'continue')).toMatchObject({ operation: 'Profile 1', pass: { index: 2, count: 2 } })
    expect(opt(os, 'part')).toMatchObject({ operation: 'Profile 1', pass: { index: 1, count: 2 } })
    expect(opt(os, 'next')).toMatchObject({ operation: 'Profile 2', pass: { index: 1, count: 1 } })
    for (const o of os) expect(o.result?.ok, o.kind).toBe(true)
  })

  it('restarting at a start invents no descent: the program\'s own plunge or ramp brings the tool down', () => {
    for (const kind of ['pass', 'part', 'next'] as const) {
      const r = opt(restartOptions(SHEET, 12), kind).result as ResumeResult
      expect(head(r).some((l) => /^G1 /.test(l)), kind).toBe(false)
      expect(r.plungeFeed, kind).toBeNull()
      expect(r.entry.z, kind).toBe(5)
    }
    // Skipping to part 2 lands on its own rapid down to the ramp height, then its ramp.
    const next = opt(restartOptions(SHEET, 12), 'next').result as ResumeResult
    expect(linesOf(next).slice(next.lineInResume - 1, next.lineInResume + 1)).toEqual(['G0 X40.000 Y0.000 Z0.500', 'G1 X50.000 Y0.000 Z-1.000 F1500'])
  })

  it('carrying on descends through the kerf at the program\'s plunge feed', () => {
    const r = opt(restartOptions(SHEET, 13), 'continue').result as ResumeResult
    expect(head(r).slice(-3)).toEqual(['G0 X20.000 Y0.000', 'G1 Z-2.000 F400', 'F1500'])
  })

  it('has no next part in the last one', () => {
    const os = restartOptions(SHEET, 19)
    expect(opt(os, 'next')).toMatchObject({ line: null, result: null })
    expect(opt(os, 'part').line).toBe(17)
  })

  it('before the first cut, offers the first part and the one after it', () => {
    const os = restartOptions(SHEET, 5)
    expect(opt(os, 'part').line).toBe(7)
    expect(opt(os, 'pass').line).toBe(7)
    expect(opt(os, 'next').line).toBe(17)
  })
})

describe('buildResume — the descent\'s feed when carrying on mid-cut', () => {
  it('reads a helical entry as the plunge — an arc that descends', () => {
    const helix = ['G21 G90', 'G0 X0 Y0 Z3', 'M3 S18000', 'G0 X0 Y0 Z0', 'G3 X0 Y0 Z-1.5 I-1.3 J0 F138', 'G3 X0 Y0 Z-1.5 I-1.3 J0 F344', 'G3 X0 Y0 Z-1.5 I-1.3 J0 F344', 'M30'].join('\n')
    expect(ok(buildResume(helix, 7)).plungeFeed).toBe(138)
  })

  it('forgets the last tool\'s plunge at a tool change, and looks ahead for this tool\'s own', () => {
    const two = [
      'G21 G90', 'M3 S18000', 'G0 X0 Y0 Z5', 'G1 X0 Y0 Z-1 F400', 'G1 X10 Y0 Z-1 F1500', 'G0 X10 Y0 Z5',
      'M5', 'M0 (MSG, Change to tool T2: small)', 'M3 S22000', 'G0 X20 Y0 Z5', 'G1 X30 Y0 Z-1 F900',   // 11: a ramp in
      'G1 X40 Y0 Z-1 F900', 'G0 X40 Y0 Z5', 'G0 X50 Y0 Z5', 'G1 X50 Y0 Z-1 F250', 'G1 X60 Y0 Z-1 F900', 'M30',
    ].join('\n')
    expect(ok(buildResume(two, 12)).plungeFeed).toBe(250)
  })

  it('descends at a third of the cutting feed for a tool that only ramps in', () => {
    const ramps = ['G21 G90', 'M3 S18000', 'G0 X0 Y0 Z5', 'G0 X0 Y0 Z0.5', 'G1 X10 Y0 Z-1 F900', 'G1 X20 Y0 Z-1 F900', 'G0 X20 Y0 Z5', 'M30'].join('\n')
    const r = ok(buildResume(ramps, 6))
    expect(r.plungeFeed).toBe(300)
    expect(r.warnings).toEqual([])
  })
})
