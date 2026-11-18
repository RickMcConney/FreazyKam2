import { describe, it, expect } from 'vitest'
import { wordsOf, codeOf, takesAxisArgs, isProbeG, isCannedG, isMotionG } from './gcodeWords'
import { parseGcode } from './gcodeParser'
import { buildResume } from '../machine/resume'
import { compactMotionLine, unknownModal } from '../cam/gcode'

const lex = (line: string) => wordsOf(codeOf(line)).map((w) => `${w.letter}${w.value}`)
const lastEnd = (text: string) => {
  const s = parseGcode(text).segments
  const e = s[s.length - 1]
  return [e.x, e.y, e.z]
}

describe('one G-code lexer: the simulator, resume and the writer read a line the same way', () => {
  it('reads a signed, a trailing-point and a leading-point number as the number written', () => {
    expect(lex('G0 X+5 Y5. Z-.5 A.25')).toEqual(['G0', 'X5', 'Y5', 'Z-0.5', 'A0.25'])
  })

  it('reads lower-case letters run together with their numbers', () => {
    expect(lex('g1x3y-4f600')).toEqual(['G1', 'X3', 'Y-4', 'F600'])
  })

  it('reads no words inside a paren or semicolon comment, nor a trailing checksum', () => {
    expect(lex('G1 X1 (X9 Y9) Y2 ; Z-3')).toEqual(['G1', 'X1', 'Y2'])
    expect(lex('G1 X1 Y2*57')).toEqual(['G1', 'X1', 'Y2'])
  })

  it('the simulator moves to a +signed axis word, where it used to drop it', () => {
    expect(lastEnd('G21 G90\nG0 X0 Y0 Z5\nG1 X+5 Y+6 F600')).toEqual([5, 6, 5])
  })

  it('resume restores the position a +signed word put the tool at, as the simulator reads it', () => {
    const text = 'G21 G90\nG0 X+5 Y+6 Z5\nM3 S18000\nG1 Z-1 F300\nG1 X10\nG1 X20\nM30'
    const r = buildResume(text, 6)
    if (!r.ok) throw new Error(r.reason)
    expect([r.entry.x, r.entry.y, r.entry.z]).toEqual([10, 6, -1])
    expect(lastEnd(text.split('\n').slice(0, 5).join('\n'))).toEqual([10, 6, -1])
  })

  it("the writer's compaction treats a +signed word as the value the controller already holds", () => {
    const st = { ...unknownModal(), g: 1, x: 5, y: 6, z: -1, f: 600 }
    expect(compactMotionLine('G1 X+5 Y+6 Z-1 F600', st)).toBe('')
    expect(compactMotionLine('G1 X+7 Y+6 Z-1 F600', st)).toBe('X+7')
  })
})

describe('one G-word classifier: which G words move and which only take arguments', () => {
  it('G10, G28, G30, G53 and G92.x take their axis words as arguments, not a destination', () => {
    for (const g of [10, 28, 30, 53, 92, 92.1, 92.2, 92.3]) expect(takesAxisArgs(g), `G${g}`).toBe(true)
    for (const g of [0, 1, 2, 3, 4, 17, 20, 21, 38.2, 54, 80, 81, 90, 90.1, 91]) expect(takesAxisArgs(g), `G${g}`).toBe(false)
  })

  it('G0–G3 are motion modes; G38.x is a probe; G73 and G81–G89 are canned cycles', () => {
    expect([0, 1, 2, 3].every(isMotionG)).toBe(true)
    expect([4, 2.5, 38.2, 80].some(isMotionG)).toBe(false)
    expect([38.2, 38.3, 38.4, 38.5].every(isProbeG)).toBe(true)
    expect([73, 81, 83, 89].every(isCannedG)).toBe(true)
    expect([80, 90, 81.5, 72].some(isCannedG)).toBe(false)
  })

  it('a G53 move neither moves the simulated tool nor is taken as a cut', () => {
    expect(lastEnd('G21 G90\nG0 X1 Y2 Z5\nG53 G0 Z-5')).toEqual([1, 2, 5])
  })

  it('a probe stops short of its axis word: the simulated tool does not bore to it', () => {
    expect(lastEnd('G21 G90\nG0 X1 Y2 Z5\nG38.2 Z-110 F50')).toEqual([1, 2, 5])
  })
})
