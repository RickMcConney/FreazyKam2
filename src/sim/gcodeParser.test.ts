import { describe, it, expect } from 'vitest'
import { parseGcode, segTool, lineAt, lineStartsOf, formatSimTime, messagesReached } from './gcodeParser'

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

describe('parseGcode — stay-down links run at feed', () => {
  // Cut at Z-2, then: rise to Z-1.5, move fast, drop back to Z-2 — a link, by its shape.
  const prog = (rise: string, run: string, drop: string) =>
    parseGcode(`G21 G90\nG1 X0 Y0 Z-2 F300\nG1 X10 F1000\n${rise}\n${run}\n${drop}\nG1 X40 F1000`)
  const link = (p: ReturnType<typeof parseGcode>) => p.segments.filter((s) => s.travel)

  it('recognises a small vertical rise, faster moves at that height and a drop back to the same depth', () => {
    const p = prog('G1 Z-1.5 F300', 'G1 X20 F2500\nG1 X30 Y5 F2500', 'G1 Z-2 F300')
    expect(link(p).length).toBe(4)                  // rise, two moves, drop
    expect(p.segments.find((s) => s.x === 40)!.travel).toBeUndefined()
  })

  it('leaves a tab alone — same shape, but at cutting feed, because it does cut', () => {
    expect(link(prog('G1 Z-1.5 F300', 'G1 X20 F1000', 'G1 Z-2 F300')).length).toBe(0)
  })

  it('leaves a lift of more than a millimetre alone', () => {
    expect(link(prog('G1 Z-0.5 F300', 'G1 X20 F2500', 'G1 Z-2 F300')).length).toBe(0)
  })

  it('leaves a rise that comes down somewhere else alone', () => {
    expect(link(prog('G1 Z-1.5 F300', 'G1 X20 F2500', 'G1 Z-3 F300')).length).toBe(0)
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

  it('reads which way the flutes twist from the tool name on the dia line, upcut when it says nothing', () => {
    const helixOf = (comment: string) => {
      const g = parseGcode(`${comment}\nG1 X10 F1000`)
      return segTool(g.segments[0], g.toolStates).toolHelix ?? 'up'
    }
    expect(helixOf('; Tool: 1/4 Downcut Spiral  dia 6.35mm  flutes:2')).toBe('down')
    expect(helixOf('; Tool: 1/4 Compression  dia 6.35mm  flutes:2')).toBe('compression')
    expect(helixOf('; Tool: 1/4in end mill dia 6.35mm flutes:2')).toBe('up')
  })

  it('a later tool without a twist in its name goes back to upcut', () => {
    const g = parseGcode('; Tool: 1/8 Down Cut dia 3.175mm\nG1 X10 F1000\n; Tool: 1/4 End Mill dia 6.35mm\nG1 X20')
    expect(segTool(g.segments[0], g.toolStates).toolHelix).toBe('down')
    expect(segTool(g.segments[1], g.toolStates).toolHelix ?? 'up').toBe('up')
  })

  it('parenthesized comments do not generate motion', () => {
    const { segments } = parseGcode('(G1 X100 F500)\n; G0 X50')
    expect(segments.length).toBe(0)
  })
})

describe('parseGcode — operator messages, by FluidNC\'s own rules', () => {
  it('reads MSG anywhere in a parenthesised comment, and PRINT/DEBUG only at its start', () => {
    const { messages } = parseGcode([
      'M0 (MSG, Change to tool T2: 1/8 Downcut)',
      '(PRINT, Op 1 of 2: Pocket)',
      '(DEBUG, x is #<_x>)',
      '(a note that mentions PRINT, but is not one)',
    ].join('\n'))
    expect(messages.map((m) => [m.kind, m.text])).toEqual([
      ['msg', 'Change to tool T2: 1/8 Downcut'],
      ['print', 'Op 1 of 2: Pocket'],
      ['debug', 'x is #<_x>'],
    ])
  })

  it('ignores a semicolon comment, which the controller drops unread', () => {
    expect(parseGcode('; (MSG, not sent)\nG1 X1 F100 ; MSG, nor this').messages).toEqual([])
  })

  it('ties each message to the move it precedes, a message on a move line coming before that move', () => {
    const { messages, segments } = parseGcode([
      'G0 X1', '(PRINT, second)', 'G1 X2 F100 (MSG, on the third move)', 'G1 X3', '(PRINT, after the last)',
    ].join('\n'))
    // The MSG sits on the line of move 1 and is sent as that line starts, so it ties to
    // move 1 too — not to the move after it.
    expect(messages.map((m) => m.segIdx)).toEqual([1, 1, segments.length])
    expect(messages.map((m) => m.lineIdx)).toEqual([1, 2, 4])
  })

  it('counts a message reached from the start of its move, and one after the last move once the run is over', () => {
    const p = parseGcode('(PRINT, start)\nG1 X10 F600\n(PRINT, middle)\nG1 X20\n(PRINT, end)')
    const at = (t: number) => messagesReached(p.messages, p.segments, t, p.totalTimeS)
    expect(at(0)).toBe(1)
    expect(at(p.segments[1].startTimeS - 1e-6)).toBe(1)
    expect(at(p.segments[1].startTimeS)).toBe(2)
    expect(at(p.totalTimeS - 1e-6)).toBe(2)
    expect(at(p.totalTimeS)).toBe(3)
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

describe('formatSimTime', () => {
  it('reads hh:mm:ss, hours always shown so the clock keeps one width', () => {
    expect(formatSimTime(0)).toBe('00:00:00')
    expect(formatSimTime(192.7)).toBe('00:03:12')
    expect(formatSimTime(4512)).toBe('01:15:12')
    expect(formatSimTime(36000)).toBe('10:00:00')
  })
})
