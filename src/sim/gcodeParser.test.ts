import { describe, it, expect } from 'vitest'
import { parseGcode, segTool, lineAt, lineStartsOf } from './gcodeParser'

const last = <T,>(a: T[]) => a[a.length - 1]

describe('parseGcode — linear motion', () => {
  it('parses G0 rapids and G1 feeds with correct endpoints and duration', () => {
    const { segments, totalTimeS } = parseGcode('G21 G90\nG0 X10 Y0 Z5\nG1 X10 Y10 F100')
    expect(segments.length).toBe(2)
    expect(segments[0].rapid).toBe(true)
    const cut = segments[1]
    expect(cut.rapid).toBe(false)
    expect(cut.prevX).toBeCloseTo(10)
    expect(cut.prevY).toBeCloseTo(0)
    expect(cut.x).toBeCloseTo(10)
    expect(cut.y).toBeCloseTo(10)
    expect(cut.feedRateMmMin).toBe(100)
    // 10 mm at 100 mm/min = 6 s
    expect(cut.durationS).toBeCloseTo(6)
    expect(totalTimeS).toBeCloseTo(segments[0].durationS + 6)
  })

  it('G91 incremental mode accumulates deltas', () => {
    const { segments } = parseGcode('G90\nG0 X10\nG91\nG0 X10\nG0 Y-5')
    expect(last(segments).x).toBeCloseTo(20)
    expect(last(segments).y).toBeCloseTo(-5)
  })

  it('G20 converts inches to mm (coords and feed)', () => {
    const { segments } = parseGcode('G20\nG1 X1 Y0 F10')
    expect(last(segments).x).toBeCloseTo(25.4)
    expect(last(segments).feedRateMmMin).toBeCloseTo(254)
  })

  it('modal motion mode persists across lines without a G word', () => {
    const { segments } = parseGcode('G1 X10 F100\nX20\nY5')
    expect(segments.length).toBe(3)
    expect(segments.every((s) => !s.rapid)).toBe(true)
    expect(last(segments).x).toBeCloseTo(20)
    expect(last(segments).y).toBeCloseTo(5)
  })
})

describe('parseGcode — arcs', () => {
  it('I/J semicircle stays on the arc radius and lands on the endpoint', () => {
    // CCW semicircle from (10,0) to (-10,0) centered at origin
    const { segments } = parseGcode('G0 X10 Y0 Z0\nG3 X-10 Y0 I-10 J0 F100')
    const arc = segments.filter((s) => !s.rapid)
    expect(arc.length).toBeGreaterThan(4)
    expect(last(arc).x).toBeCloseTo(-10, 3)
    expect(last(arc).y).toBeCloseTo(0, 3)
    for (const s of arc) {
      expect(Math.hypot(s.x, s.y)).toBeCloseTo(10, 2)
    }
    // CCW: the arc passes through the top (+Y), not the bottom
    expect(Math.max(...arc.map((s) => s.y))).toBeCloseTo(10, 2)
  })

  it('R-format arc derives the center from the radius', () => {
    const { segments, warnings } = parseGcode('G0 X0 Y0 Z0\nG2 X10 Y0 R5 F100')
    const arc = segments.filter((s) => !s.rapid)
    expect(warnings).toEqual([])
    expect(last(arc).x).toBeCloseTo(10, 3)
    // every arc point is 5 mm from the implied center (5, 0)
    for (const s of arc) {
      expect(Math.hypot(s.x - 5, s.y)).toBeCloseTo(5, 2)
    }
  })

  it('interpolates Z linearly along helical arcs', () => {
    const { segments } = parseGcode('G0 X10 Y0 Z0\nG3 X-10 Y0 Z-2 I-10 J0 F100')
    const arc = segments.filter((s) => !s.rapid)
    expect(last(arc).z).toBeCloseTo(-2, 3)
    const mid = arc[Math.floor(arc.length / 2)]
    expect(mid.z).toBeLessThan(0)
    expect(mid.z).toBeGreaterThan(-2)
  })
})

describe('parseGcode — warnings instead of mis-simulation', () => {
  it('flags unsupported planes, arc modes, and cutter comp', () => {
    const { warnings } = parseGcode('G18\nG90.1\nG41\nG1 X5 F100')
    expect(warnings.some((w) => w.includes('G18/G19'))).toBe(true)
    expect(warnings.some((w) => w.includes('G90.1'))).toBe(true)
    expect(warnings.some((w) => w.includes('G41/G42'))).toBe(true)
  })

  it('flags an arc with neither I/J nor R and produces no motion for it', () => {
    const { segments, warnings } = parseGcode('G2 X10 Y0 F100')
    expect(segments.length).toBe(0)
    expect(warnings.some((w) => w.includes('without I/J or R'))).toBe(true)
  })

  it('skips an R-format full circle with a warning', () => {
    const { segments, warnings } = parseGcode('G0 X10 Y0\nG2 X10 Y0 R5 F100')
    expect(segments.filter((s) => !s.rapid).length).toBe(0)
    expect(warnings.some((w) => w.includes('coincident'))).toBe(true)
  })

  it('a CRLF program parses exactly like its LF copy — semicolon comments never become motion', () => {
    const src = ['G21 G90', 'G0 X0 Y0 Z5', 'G1 X10 F100 ; retract to Z 20', '; Y 7', '(dia 3.175mm) G1 Y2']
    const lf = parseGcode(src.join('\n') + '\n')
    const crlf = parseGcode(src.join('\r\n') + '\r\n')
    expect(crlf.segments).toEqual(lf.segments)
    expect(crlf.lines).toEqual(lf.lines)
    expect(crlf.lines.some((l) => l.includes('\r'))).toBe(false)
    expect(crlf.segments.map((s) => [s.x, s.y, s.z])).toEqual([[10, 0, 5], [10, 2, 5]])
  })

  it('never throws on junk input', () => {
    expect(() => parseGcode('hello world\nG1 X\n%%%\n(comment')).not.toThrow()
  })
})

describe('parseGcode — tool state', () => {
  it('reads tool diameter, flutes, and spindle speed into the flyweight table', () => {
    const g = parseGcode('; Tool: 1/4in end mill dia 6.35mm flutes:2\nS18000 M3\nG1 X10 F1000')
    const tool = segTool(g.segments[0], g.toolStates)
    expect(tool.toolDiameterMM).toBeCloseTo(6.35)
    expect(tool.fluteCount).toBe(2)
    expect(tool.spindleRpm).toBe(18000)
  })

  it('parenthesized comments do not generate motion', () => {
    const { segments } = parseGcode('(G1 X100 F500)\n; G0 X50')
    expect(segments.length).toBe(0)
  })
})

describe('lineAt — the viewer reads a line without the program being split', () => {
  it('returns exactly the lines parseGcode splits a program into, LF and CRLF alike', () => {
    for (const text of ['', 'G1 X1', 'G1 X1\n', 'a\r\nb\nc\r\n', '\r\n\r\n', 'x\r', ';c\r\nG0 Z5\r']) {
      const starts = lineStartsOf(text)
      expect(Array.from(starts, (_, i) => lineAt(text, starts, i))).toEqual(parseGcode(text).lines)
    }
  })
})
