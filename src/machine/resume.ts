// Resume a G-code program from a chosen line — after a Cancel, a broken bit, a power cut.
//
// A bare "start from line N" is not a restart: line N runs in whatever state the machine
// is in, and the program's state at that line was built up by everything before it. So
// the restart is a NEW file, built here from the text of the one that ran:
//
//   1. the file's own preamble, copied (everything before its first move, M-code or
//      operation marker — so LinuxCNC's G64, Mach3's G40/G49/G80 come through);
//   2. the modal state in force at line N restated (units, distance, plane, work
//      offset, feed mode, arc-centre mode, tool length offset), and the comment block
//      describing the tool in force, so the simulator and the operator both know the bit;
//   3. the ENTRY: straight up to safe Z (the bit may still be in the cut), spindle and
//      coolant as they were, across at safe Z to where line N−1 left the tool, down at
//      plunge feed, then the feed that was in force;
//   4. lines N to the end, verbatim — except that the first move among them gets the
//      motion mode in force written onto it when it has none of its own, since the entry
//      just left the controller in G1.
//
// Nothing is regenerated: the entry is the only motion invented, as plain G0/G1, and
// everything else is the file's own text in its own dialect. That is what lets this work
// for any controller and any CAM program's output, not only ours. The entry goes to the END
// of line N−1 exactly — the file's own coordinate text where it has it — because an arc on
// line N measures its I/J from that point, and a controller rejects (error 33) or bends an
// arc whose start is off.
//
// Refused rather than guessed: a restart inside G91 (relative) or G93 (inverse time), under
// cutter compensation, inside a canned cycle, after program end, after G92/G10 changed the
// coordinate system, with rotary axes, or before the program has set X, Y and Z. Each of
// these is a state a line of G-code cannot be resumed from without knowing more than the
// file says.
//
// Line numbers are 1-based, as a sender or an editor shows them. Pure: text in, text out.

import { commentLines } from '../cam/gcode'

export interface ResumeOptions {
  /** Clearance height, in the file's units. Default: the Z the program's XY rapids travel
   *  at most often (its own safe height), never below the entry point. */
  safeZ?: number
  /** Feed for the final descent, file units per minute. Default: the program's own plunge
   *  feed — the last downward Z-only feed move before the line. */
  plungeFeed?: number
  /** A G4 dwell after the spindle comes on, seconds. Default none. P is in seconds on
   *  Grbl, FluidNC and LinuxCNC; Mach3 may read it as milliseconds. */
  dwellS?: number
  /** Stop (M0) after the spindle command, before any move, so the operator can check a
   *  router that is switched by hand. Default false. */
  pauseForSpindle?: boolean
}

export interface ResumeResult {
  ok: true
  text: string
  /** The line resumed at (1-based) and where line N lands in the new file (1-based). */
  line: number
  lineInResume: number
  /** Where the entry puts the tool — the end of line N−1, in the file's units. */
  entry: { x: number; y: number; z: number }
  safeZ: number
  /** The descent's feed; null when the entry point is at safe height and there is none. */
  plungeFeed: number | null
  units: 'mm' | 'in' | null
  spindleOn: boolean
  /** Tool changes (M6, or an M0 whose comment names a tool) before the line. */
  toolChangesBefore: number
  /** The tool comment in force (e.g. `1/4" End Mill  dia 6.350mm  flutes:2`), if any. */
  tool: string | null
  /** The operation the line is in, from a `=== name ===` marker, if any. */
  operation: string | null
  warnings: string[]
}

export interface ResumeRefusal {
  ok: false
  reason: string
}

interface AxisPos { v: number; raw: string }

interface ModalState {
  units: 'G20' | 'G21' | null
  relative: boolean
  arcDistance: 'G90.1' | 'G91.1' | null
  plane: 'G17' | 'G18' | 'G19' | null
  wcs: string | null
  feedMode: 'G93' | 'G94' | 'G95' | null
  cutterComp: boolean
  tlo: string | null
  motion: number | null
  F: string | null
  S: string | null
  spindle: 'M3' | 'M4' | 'M5' | null
  mist: boolean
  flood: boolean
  ended: boolean
  offsetChanged: boolean
  rotary: boolean
  pos: { x: AxisPos | null; y: AxisPos | null; z: AxisPos | null }
  plungeF: string | null
  toolChanges: number
  toolBlock: string[]
  toolName: string | null
  operation: string | null
}

const CANNED = new Set([73, 81, 82, 83, 84, 85, 86, 87, 88, 89])
const WORD_RE = /([A-Za-z])\s*([-+]?\d*\.?\d+)/g
// The tool-shape markers our writer puts after a tool's `dia` comment (and the simulator
// reads), so the block describing the tool in force can be carried into the resume.
const DIA_RE = /\bdia\s+[\d.]+\s*(mm|in)\b/i
const TOOL_MARKER_RE = /vbit-angle:|taper-tip:|\bballnose\b|bullnose-r:|\bdrillbit\b|fzmax:|flutes:/i
const OP_RE = /===\s*(.+?)\s*===/

const eq = (a: number, b: number) => Math.abs(a - b) < 1e-4

/** The code part of a line: comments, block-delete and checksums removed. */
function codeOf(raw: string): string {
  return raw.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').replace(/\*\d+\s*$/, '').trim()
}

function commentOnly(raw: string): boolean {
  return raw.trim() !== '' && codeOf(raw) === ''
}

interface Word { letter: string; value: number; raw: string }

function wordsOf(code: string): Word[] {
  const out: Word[] = []
  WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RE.exec(code)) !== null) out.push({ letter: m[1].toUpperCase(), value: parseFloat(m[2]), raw: m[2] })
  return out
}

const fmtNum = (v: number): string => {
  const s = v.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

function freshState(): ModalState {
  return {
    units: null, relative: false, arcDistance: null, plane: null, wcs: null, feedMode: null,
    cutterComp: false, tlo: null, motion: null, F: null, S: null, spindle: null,
    mist: false, flood: false, ended: false, offsetChanged: false, rotary: false,
    pos: { x: null, y: null, z: null }, plungeF: null,
    toolChanges: 0, toolBlock: [], toolName: null, operation: null,
  }
}

function snapshot(s: ModalState): ModalState {
  return { ...s, pos: { ...s.pos }, toolBlock: [...s.toolBlock] }
}

/** Apply one line to the state. Returns whether the line moved the tool (axis words that
 *  went to a motion, not to G92/G10/G4). */
function applyLine(s: ModalState, raw: string): { moved: boolean; rapidXY: boolean; plunged: boolean } {
  // Comments first: tool blocks and operation markers live there.
  if (commentOnly(raw)) {
    const op = raw.match(OP_RE)
    if (op) s.operation = op[1]
    if (DIA_RE.test(raw)) { s.toolBlock = [raw]; s.toolName = raw.replace(/^\s*[(;]\s*|\)\s*$/g, '').trim() }
    else if (TOOL_MARKER_RE.test(raw) && s.toolBlock.length) s.toolBlock.push(raw)
    return { moved: false, rapidXY: false, plunged: false }
  }
  const code = codeOf(raw)
  if (!code) return { moved: false, rapidXY: false, plunged: false }
  const words = wordsOf(code)

  let motionWord: number | null = null
  let nonModalAxis = false   // G4/G10/G28/G30/G53/G92 take this line's axis words
  let unknownAfter = false   // G28/G30/G38.x/G53 leave the work position unknown
  const ax: Partial<Record<'X' | 'Y' | 'Z', Word>> = {}
  let H: string | null = null

  for (const w of words) {
    const v = w.value
    switch (w.letter) {
      case 'G':
        if (eq(v, 0) || eq(v, 1) || eq(v, 2) || eq(v, 3)) motionWord = Math.round(v)
        else if (eq(v, 80)) motionWord = 80
        else if (CANNED.has(Math.round(v)) && eq(v, Math.round(v))) motionWord = Math.round(v)
        else if (v >= 38.15 && v < 38.65) { motionWord = null; unknownAfter = true; nonModalAxis = true }
        else if (eq(v, 4)) nonModalAxis = true
        else if (eq(v, 10) || eq(v, 92) || eq(v, 92.1) || eq(v, 92.2) || eq(v, 92.3)) { s.offsetChanged = true; nonModalAxis = true }
        else if (eq(v, 28) || eq(v, 30) || eq(v, 53)) { unknownAfter = true; nonModalAxis = true }
        else if (eq(v, 20) || eq(v, 21)) {
          const u = eq(v, 20) ? 'G20' : 'G21'
          // A unit switch after a position was set leaves that position in the old units.
          if (s.units && s.units !== u) s.pos = { x: null, y: null, z: null }
          s.units = u
        }
        else if (eq(v, 90)) s.relative = false
        else if (eq(v, 91)) s.relative = true
        else if (eq(v, 90.1)) s.arcDistance = 'G90.1'
        else if (eq(v, 91.1)) s.arcDistance = 'G91.1'
        else if (eq(v, 17)) s.plane = 'G17'
        else if (eq(v, 18)) s.plane = 'G18'
        else if (eq(v, 19)) s.plane = 'G19'
        else if (eq(v, 93)) s.feedMode = 'G93'
        else if (eq(v, 94)) s.feedMode = 'G94'
        else if (eq(v, 95)) s.feedMode = 'G95'
        else if (eq(v, 40)) s.cutterComp = false
        else if (eq(v, 41) || eq(v, 42) || eq(v, 41.1) || eq(v, 42.1)) s.cutterComp = true
        else if (eq(v, 49)) s.tlo = 'G49'
        else if (v >= 43 && v < 44) s.tlo = `G${w.raw}`
        else if (v >= 54 && v <= 59.3) s.wcs = `G${w.raw}`
        break
      case 'M': {
        const m = Math.round(v)
        if (m === 2 || m === 30) s.ended = true
        else if (m === 3) s.spindle = 'M3'
        else if (m === 4) s.spindle = 'M4'
        else if (m === 5) s.spindle = 'M5'
        else if (m === 6) { s.toolChanges++; s.plungeF = null }
        else if (m === 7) s.mist = true
        else if (m === 8) s.flood = true
        else if (m === 9) { s.mist = false; s.flood = false }
        else if ((m === 0 || m === 1) && /tool/i.test(raw)) { s.toolChanges++; s.plungeF = null }
        break
      }
      case 'F': s.F = w.raw; break
      case 'S': s.S = w.raw; break
      case 'H': H = w.raw; break
      case 'X': case 'Y': case 'Z': ax[w.letter] = w; break
      case 'A': case 'B': case 'C': s.rotary = true; break
    }
  }
  if (H !== null && s.tlo && s.tlo !== 'G49' && !/H/.test(s.tlo)) s.tlo = `${s.tlo} H${H}`
  if (motionWord !== null) s.motion = motionWord

  const hasAxis = ax.X || ax.Y || ax.Z
  if (unknownAfter) {
    s.pos = { x: null, y: null, z: null }
    return { moved: true, rapidXY: false, plunged: false }
  }
  if (!hasAxis || nonModalAxis) return { moved: false, rapidXY: false, plunged: false }

  const before = { ...s.pos }
  for (const [k, key] of [['X', 'x'], ['Y', 'y'], ['Z', 'z']] as const) {
    const w = ax[k]
    if (!w) continue
    if (s.relative) {
      const prev = s.pos[key]
      s.pos[key] = prev ? { v: prev.v + w.value, raw: fmtNum(prev.v + w.value) } : null
    } else {
      s.pos[key] = { v: w.value, raw: w.raw }
    }
  }
  // The program's own plunge feed: a feed move straight down, or a helix (an arc that
  // descends — our writer runs those at the plunge feed, and so do most CAM programs).
  // X and Y may be written on a straight plunge (our writer puts all three on every
  // move) — they must not CHANGE. A straight RAMP is not counted: ours runs at the
  // cutting feed. Forgotten at a tool change (above): the next tool has its own.
  const still = (k: 'x' | 'y') => before[k] !== null && s.pos[k] !== null && before[k]!.v === s.pos[k]!.v
  const down = !!(ax.Z && before.z && s.pos.z && s.pos.z.v < before.z.v && s.F)
  const plunged = down && ((s.motion === 1 && still('x') && still('y')) || s.motion === 2 || s.motion === 3)
  if (plunged) s.plungeF = s.F
  const rapidXY = s.motion === 0 && !!(ax.X || ax.Y)
  return { moved: true, rapidXY, plunged }
}

/**
 * The line (0-based) from `from` on that moves in the MODAL motion mode — axis words and
 * no motion word of its own — before any line names one; −1 if a motion word comes first.
 * That line is the one that would otherwise run in the entry's G1.
 */
function modalMoveAt(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    const words = wordsOf(codeOf(lines[i]))
    const gs = words.filter((w) => w.letter === 'G').map((w) => w.value)
    if (gs.some((v) => v <= 3.0001 || (v >= 38 && v < 39) || eq(v, 80) || CANNED.has(Math.round(v)))) return -1
    const nonModal = gs.some((v) => eq(v, 4) || eq(v, 10) || eq(v, 28) || eq(v, 30) || eq(v, 53) || (v >= 92 && v < 93))
    if (!nonModal && words.some((w) => w.letter === 'X' || w.letter === 'Y' || w.letter === 'Z')) return i
  }
  return -1
}

/** The program's own safe height: the Z its XY rapids travel at most often (the first
 *  and last may sit higher). Ties go to the higher. Null for a program with no XY rapids. */
function commonestZ(counts: Map<string, { v: number; n: number }>): number | null {
  let z: number | null = null
  let best = 0
  for (const e of counts.values()) if (e.n > best || (e.n === best && z !== null && e.v > z)) { best = e.n; z = e.v }
  return z
}

/** The comment style the file itself uses, so the lines written here read like its own. */
function commentStyleOf(lines: string[]): 'parenthesis' | 'semicolon' | 'none' {
  if (lines.some((l) => /\([^)]*\)/.test(l))) return 'parenthesis'
  if (lines.some((l) => l.includes(';'))) return 'semicolon'
  return 'none'
}

/**
 * Build the restart program for `text` resuming at `line` (1-based): the line runs
 * first in the new file, with the machine put into the state the original program had
 * built up by then and the tool brought to where the line before it left off.
 */
export function buildResume(text: string, line: number, opts: ResumeOptions = {}): ResumeResult | ResumeRefusal {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    return { ok: false, reason: `Line ${line} is not in the program (it has ${lines.length} lines).` }
  }
  if (line === 1) return { ok: false, reason: 'Line 1 is the start of the program — run it as it is.' }

  const s = freshState()
  const rapidZCount = new Map<string, { v: number; n: number }>()
  let at: ModalState | null = null
  let firstMoveAt = -1        // first line of the WHOLE file that moves or starts anything
  let moveAtOrAfter = -1      // first line ≥ N that moves
  let plungeAhead: string | null = null   // the same tool's first plunge from line N on
  for (let i = 0; i < lines.length; i++) {
    if (i === line - 1) at = snapshot(s)
    const raw = lines[i]
    const code = codeOf(raw)
    const r = applyLine(s, raw)
    if (firstMoveAt < 0 && (r.moved || /[MT]\s*\d/i.test(code) || OP_RE.test(raw) || /\((MSG|PRINT)/i.test(raw))) firstMoveAt = i
    if (r.moved && i >= line - 1 && moveAtOrAfter < 0) moveAtOrAfter = i
    if (r.plunged && at && plungeAhead === null && s.toolChanges === at.toolChanges) plungeAhead = s.plungeF
    if (r.rapidXY && s.pos.z) {
      const e = rapidZCount.get(s.pos.z.raw) ?? { v: s.pos.z.v, n: 0 }
      e.n++
      rapidZCount.set(s.pos.z.raw, e)
    }
  }
  const st = at!

  if (st.ended) return { ok: false, reason: `The program ends (M2/M30) before line ${line}.` }
  if (moveAtOrAfter < 0) return { ok: false, reason: `Nothing moves from line ${line} on.` }
  if (st.relative) return { ok: false, reason: `Line ${line} is inside a G91 (relative) section — choose a line where the program is absolute (G90).` }
  if (st.feedMode === 'G93') return { ok: false, reason: `Line ${line} is in G93 inverse-time feed mode, which cannot be resumed part way.` }
  if (st.cutterComp) return { ok: false, reason: `Cutter compensation (G41/G42) is on at line ${line} — choose a line before it starts or after G40.` }
  if (st.motion !== null && CANNED.has(st.motion)) return { ok: false, reason: `Line ${line} is inside a canned drilling cycle — choose the line that starts the cycle, or one after G80.` }
  if (st.offsetChanged) return { ok: false, reason: `The program changes its coordinate system (G92/G10) before line ${line}, which a resume cannot rebuild.` }
  if (st.rotary) return { ok: false, reason: `The program moves a rotary axis (A/B/C) before line ${line}; only X, Y and Z can be resumed.` }
  const { x, y, z } = st.pos
  if (!x || !y || !z) {
    const missing = (['X', 'Y', 'Z'] as const).filter((k) => !st.pos[k.toLowerCase() as 'x' | 'y' | 'z'])
    return { ok: false, reason: `The tool's ${missing.join('/')} position is not known at line ${line} — the program has not set it yet, or a G28/G30/G53/probe move came before it.` }
  }

  const warnings: string[] = []

  // Safe height: the program's own (where its XY rapids run most often), else the option.
  const progSafe = commonestZ(rapidZCount)
  const askedSafe = opts.safeZ ?? progSafe
  if (askedSafe === null || !Number.isFinite(askedSafe)) {
    return { ok: false, reason: 'The program has no rapid moves to take a safe height from — give one.' }
  }
  const safeZ = Math.max(askedSafe, z.v)
  if (opts.safeZ === undefined && progSafe !== null && progSafe < z.v) {
    warnings.push(`The entry point is above the program's safe height; the entry runs at Z${z.raw}.`)
  }

  // The descent's feed — needed only when the entry point is below the safe height.
  const descends = z.v < safeZ
  let plungeRaw: string | null = null
  // The program's plunge feed for this tool: the last plunge before the line, else its
  // first one after. A program that only ramps has none, and then the descent runs at a
  // third of the cutting feed — slower is the safe direction, and the descent should be
  // through the kerf line N−1 left, unless the line chosen is ahead of where the cut stopped.
  if (opts.plungeFeed !== undefined && opts.plungeFeed > 0) plungeRaw = fmtNum(opts.plungeFeed)
  else if (st.plungeF) plungeRaw = st.plungeF
  else if (plungeAhead) plungeRaw = plungeAhead
  else if (st.F && descends) plungeRaw = fmtNum(parseFloat(st.F) / 3)
  else if (descends) return { ok: false, reason: `No feed rate is set by line ${line} to descend at — give a plunge feed.` }

  // The first move from line N on must not inherit the entry's G1.
  const needsMode = modalMoveAt(lines, line - 1)
  if (needsMode >= 0 && (st.motion === null || st.motion > 3)) {
    return { ok: false, reason: `The motion mode (G0/G1/G2/G3) is not set by line ${line}.` }
  }

  const style = commentStyleOf(lines)
  const note = (t: string): string[] => commentLines(t, style)
  const out: string[] = []

  // 1. The file's own preamble.
  const preambleEnd = firstMoveAt < 0 ? 0 : firstMoveAt
  for (let i = 0; i < Math.min(preambleEnd, line - 1); i++) out.push(lines[i])
  while (out.length && out[out.length - 1].trim() === '') out.pop()

  // 2. Modal state and the tool in force.
  out.push(...note(`RESUMED from line ${line}${st.operation ? ` - ${st.operation}` : ''}`))
  out.push(...note('Zero X, Y and Z exactly as for the original run'))
  out.push(...st.toolBlock)
  const modal = [st.units, 'G90', st.plane, st.feedMode, st.arcDistance, st.wcs].filter(Boolean).join(' ')
  out.push(modal)
  if (st.tlo) out.push(st.tlo)

  // 3. The entry.
  out.push(`G0 Z${fmtNum(safeZ)}`)
  const spindleOn = st.spindle === 'M3' || st.spindle === 'M4'
  if (spindleOn) out.push(`${st.spindle}${st.S !== null ? ` S${st.S}` : ''}`)
  else warnings.push(`The spindle is off at line ${line}; the resume does not start it.`)
  if (spindleOn && opts.pauseForSpindle) {
    out.push(style === 'parenthesis' ? 'M0 (MSG, Check the spindle is running, then cycle start)' : `M0${note('Check the spindle is running, then cycle start').map((c) => ` ${c}`).join('')}`)
  }
  if (spindleOn && opts.dwellS && opts.dwellS > 0) out.push(`G4 P${fmtNum(opts.dwellS)}`)
  if (st.mist) out.push('M7')
  if (st.flood) out.push('M8')
  out.push(`G0 X${x.raw} Y${y.raw}`)
  if (descends) out.push(`G1 Z${z.raw} F${plungeRaw}`)
  if (descends && st.F !== null && st.F !== plungeRaw) out.push(`F${st.F}`)

  // 4. The rest of the program, verbatim but for the motion mode on its first move.
  const lineInResume = out.length + 1
  for (let i = line - 1; i < lines.length; i++) {
    if (i === needsMode) out.push(`G${st.motion} ${lines[i].trimStart()}`)
    else out.push(lines[i])
  }

  if (st.toolChanges > 0) {
    warnings.push(`The program changed tools ${st.toolChanges} time${st.toolChanges === 1 ? '' : 's'} before line ${line}${st.toolName ? ` — the router must hold: ${st.toolName}` : ''}.`)
  }

  return {
    ok: true,
    text: out.join(eol),
    line,
    lineInResume,
    entry: { x: x.v, y: y.v, z: z.v },
    safeZ,
    plungeFeed: descends && plungeRaw !== null ? parseFloat(plungeRaw) : null,
    units: st.units === 'G20' ? 'in' : st.units === 'G21' ? 'mm' : null,
    spindleOn,
    toolChangesBefore: st.toolChanges,
    tool: st.toolName,
    operation: st.operation,
    warnings,
  }
}

// ─── Where a program can be restarted ─────────────────────────────────────────────

/** A part of the program: an operation (our writer's `=== name ===` marker), or — in a
 *  file with no markers — each descent from safe height on its own. */
export interface ProgramPart {
  name: string | null
  /** The marker's line, or the part's first start where there is no marker (1-based). */
  line: number
  /** Lines where the tool comes down from safe height inside this part (1-based). */
  starts: number[]
}

export interface ProgramStarts {
  safeZ: number | null
  /** Every line where the tool first goes below safe height after being at or above it. */
  starts: number[]
  parts: ProgramPart[]
}

/**
 * The places a program can be restarted CLEANLY — where the tool comes down from safe
 * height, so the line before leaves it at safe height and a resume from there invents no
 * descent: the program's own plunge or ramp-in does it. A link that stays down between
 * passes is not one; the start is the line that takes the tool BELOW safe height, not the
 * rapid that positions it above.
 */
export function programStarts(text: string): ProgramStarts {
  const lines = text.split(/\r?\n/)
  const s = freshState()
  const rapidZCount = new Map<string, { v: number; n: number }>()
  const zAfter: number[] = new Array(lines.length).fill(NaN)
  const markers: { line: number; name: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const op = s.operation
    const r = applyLine(s, lines[i])
    if (s.operation !== op || (commentOnly(lines[i]) && OP_RE.test(lines[i]))) markers.push({ line: i + 1, name: s.operation! })
    zAfter[i] = s.pos.z ? s.pos.z.v : NaN
    if (r.rapidXY && s.pos.z) {
      const e = rapidZCount.get(s.pos.z.raw) ?? { v: s.pos.z.v, n: 0 }
      e.n++
      rapidZCount.set(s.pos.z.raw, e)
    }
  }
  const safeZ = commonestZ(rapidZCount)
  const starts: number[] = []
  if (safeZ !== null) {
    const EPS = 1e-6
    let prev = NaN
    for (let i = 0; i < lines.length; i++) {
      const z = zAfter[i]
      if (prev >= safeZ - EPS && z < safeZ - EPS) starts.push(i + 1)
      prev = z
    }
  }
  let parts: ProgramPart[]
  if (markers.length) {
    parts = markers.map((m, k) => {
      const end = k + 1 < markers.length ? markers[k + 1].line : Infinity
      return { name: m.name, line: m.line, starts: starts.filter((l) => l > m.line && l < end) }
    })
    // Starts ahead of the first marker belong to no operation; give them a part of their own.
    const lead = starts.filter((l) => l < markers[0].line)
    if (lead.length) parts.unshift({ name: null, line: lead[0], starts: lead })
  } else {
    parts = starts.map((l) => ({ name: null, line: l, starts: [l] }))
  }
  return { safeZ, starts, parts: parts.filter((p) => p.starts.length) }
}

export type RestartKind = 'continue' | 'pass' | 'part' | 'next'

export interface RestartOption {
  kind: RestartKind
  /** The line it restarts at (1-based); null when there is none (no next part). */
  line: number | null
  /** The part the line is in, and which of its starts the line is at or after. */
  operation: string | null
  pass: { index: number; count: number } | null
  result: ResumeResult | ResumeRefusal | null
}

/**
 * The four restarts around the line a job stopped at: carry on from that line (a descent
 * through the kerf already cut), redo the pass it was in, recut its part from the part's
 * first start, or skip to the next part's first start. The last three begin at a start,
 * so the program's own entry brings the tool down.
 */
export function restartOptions(text: string, stopLine: number, opts: ResumeOptions = {}): RestartOption[] {
  const { parts } = programStarts(text)
  // The part the stop is in: the last one beginning at or before it. Before every part —
  // stopped ahead of the first cut — the first part.
  let k = -1
  for (let i = 0; i < parts.length; i++) if (parts[i].line <= stopLine) k = i
  const part = parts[Math.max(0, k)] ?? null
  const inPart = k >= 0
  const passStart = part ? ([...part.starts].reverse().find((l) => l <= stopLine) ?? part.starts[0]) : null
  const next = parts[k + 1] ?? null

  const where = (line: number | null) => {
    if (line === null) return { operation: null, pass: null }
    let p: ProgramPart | null = null
    for (const q of parts) if (q.line <= line) p = q
    if (!p) return { operation: null, pass: null }
    const before = p.starts.filter((l) => l <= line).length
    return { operation: p.name, pass: { index: Math.max(1, before), count: p.starts.length } }
  }
  const make = (kind: RestartKind, line: number | null): RestartOption => ({
    kind, line, ...where(line), result: line === null ? null : buildResume(text, line, opts),
  })
  return [
    make('continue', stopLine),
    make('pass', inPart ? passStart : part?.starts[0] ?? null),
    make('part', part?.starts[0] ?? null),
    make('next', inPart ? (next?.starts[0] ?? null) : (parts[1]?.starts[0] ?? null)),
  ]
}
