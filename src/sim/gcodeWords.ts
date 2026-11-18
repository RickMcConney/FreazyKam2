// THE G-code lexer and G-word classifier, shared by the simulator (sim/gcodeParser), the
// resume planner (machine/resume) and the writer's modal compaction (cam/gcode).
//
// There were three lexers with three number syntaxes, and only resume knew which G words
// take axis words WITHOUT moving to them — which is how the simulator came to run
// `G53 G0 Z-5` as a rapid 5 mm into the stock. One reading of a line, here, for all three.

/** A word's number: optional sign, then `5`, `5.`, `5.25` or `.25`. */
const WORD_SRC = String.raw`([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))`

/**
 * A fresh global word matcher: group 1 the letter, group 2 the number as written.
 * One per module, never shared — a global RegExp carries `lastIndex` between calls, so
 * two lexing loops interleaved on one instance would each skip the other's words.
 */
export const wordMatcher = (): RegExp => new RegExp(WORD_SRC, 'g')

/** The code part of a line: `( … )` and `;` comments and a trailing `*NN` checksum removed. */
export function codeOf(raw: string): string {
  return raw.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').replace(/\*\d+\s*$/, '').trim()
}

export interface GWord { letter: string; value: number; raw: string }

const LEX = wordMatcher()
/** Every word on a code line (comments already removed), letters upper-cased. */
export function wordsOf(code: string): GWord[] {
  const out: GWord[] = []
  LEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LEX.exec(code)) !== null) out.push({ letter: m[1].toUpperCase(), value: parseFloat(m[2]), raw: m[2] })
  return out
}

const near = (v: number, n: number) => Math.abs(v - n) < 1e-3

/** G0–G3: a modal motion mode. */
export const isMotionG = (v: number): boolean => v >= 0 && v <= 3 && near(v, Math.round(v))

/** G73 and G81–G89: a canned drilling cycle, which is a motion mode of its own. */
export const isCannedG = (v: number): boolean =>
  near(v, Math.round(v)) && (Math.round(v) === 73 || (Math.round(v) >= 81 && Math.round(v) <= 89))

/** G38.x: a probe. Its axis word is a limit to stop short of, not a destination. */
export const isProbeG = (v: number): boolean => v >= 38 && v < 39

/** G10 and G92.x change the coordinate system. Their axis words are the new offsets. */
export const isOffsetG = (v: number): boolean => [10, 92, 92.1, 92.2, 92.3].some((n) => near(v, n))

/** G28/G30 go home through a point; G53 moves in MACHINE coordinates. Either way the work
 *  position afterwards is not one the program states. */
export const isHomeOrMachineG = (v: number): boolean => near(v, 28) || near(v, 30) || near(v, 53)

/**
 * A G word whose axis words on the same line are ARGUMENTS, not a move in the modal
 * G0/G1: G10/G92.x (offsets), G28/G30 (home via), G53 (machine coordinates).
 */
export const takesAxisArgs = (v: number): boolean => isOffsetG(v) || isHomeOrMachineG(v)
