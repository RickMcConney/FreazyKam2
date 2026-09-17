
export interface SimSegment {
  x: number
  y: number
  z: number
  prevX: number
  prevY: number
  prevZ: number
  rapid: boolean
  feedRateMmMin: number
  lineIdx: number       // 0-based line index in the gcode text
  durationS: number     // seconds to traverse this segment
  startTimeS: number    // cumulative elapsed time at the start of this segment
  toolStateIdx: number  // index into ParsedGcode.toolStates (flyweight; see ToolState)
}

// Tool/spindle parameters change only at tool changes, so rather than repeat them
// on every segment we keep a small deduplicated table and store just an index on
// each segment. Resolve with `segTool(seg, toolStates)`.
export interface ToolState {
  toolDiameterMM: number
  toolVbitHalfAngleTan?: number  // set for V-bit AND taper segments; tan(halfAngle)
  // Radius of the ball on a taper's tip. Set only for a taper; a V-bit's tip is a
  // point, and the two are otherwise the same tool — a cone tangent to a tip ball.
  toolTipRadiusMM?: number
  toolBallNose?: boolean         // set for ball nose segments
  toolDrill?: boolean            // set for drill-bit segments (118° point)
  spindleRpm: number             // active spindle speed (S word); 0 if none seen
  fluteCount: number             // from "flutes:N" comment; defaults to 2
}

export interface ParsedGcode {
  lines: string[]
  segments: SimSegment[]
  totalTimeS: number
  toolStates: ToolState[]
  // Deduplicated notes about G-code features the simulator can't honor
  // (non-XY arc planes, absolute arc centers, malformed arcs). Empty for
  // anything this app generates itself; imported external G-code may hit them.
  warnings: string[]
  // Units the PROGRAM is written in, from its own G20/G21 — the first one wins, since
  // that is the modal declaration every start block makes. Everything above is converted
  // to mm regardless (the heightfield, the cut trail and the tool position all assume mm);
  // this is only so the player can show its readouts back in the units of the file it is
  // simulating, which is what the G-code viewer beside it displays.
  units: 'mm' | 'in'
}

const RAPID_MM_PER_MIN = 5000
const MM_PER_INCH = 25.4

const FALLBACK_TOOL_STATE: ToolState = { toolDiameterMM: 3.0, spindleRpm: 0, fluteCount: 2 }

// Resolve a segment's tool parameters from the flyweight table.
export function segTool(seg: SimSegment, toolStates: ToolState[]): ToolState {
  return toolStates[seg.toolStateIdx] ?? FALLBACK_TOOL_STATE
}

// One G-code word: a letter and its number. Global, so `lastIndex` is reset per line.
const WORD_RE = /([A-Za-z])\s*(-?\d*\.?\d+)/g

// Every tool-comment marker read below ("dia", "vbit-angle:", "taper-tip:", "ballnose",
// "drillbit", "flutes:") contains an a, an i or a colon, so a line with none of them
// cannot match any of those regexes. That skips every plain G0/G1 X/Y/Z/F move exactly.
// (Gating on ';' or '(' instead would be cheaper but not equivalent: the markers are
// matched anywhere on the line, comment or not.)
const TOOL_MARKER_HINT = /[ai:]/i

function arcToSegments(
  x0: number, y0: number,
  x1: number, y1: number,
  ii: number, jj: number,
  cw: boolean,
  z0: number,  // start Z (for helical interpolation)
  z1: number,  // end Z
  feedMmMin: number,
  lineIdx: number,
  startTimeS: number,
  toolStateIdx: number,
): SimSegment[] {
  const cx = x0 + ii
  const cy = y0 + jj
  const r = Math.hypot(ii, jj)
  if (r < 0.001) return []

  let a0 = Math.atan2(y0 - cy, x0 - cx)
  let a1 = Math.atan2(y1 - cy, x1 - cx)

  if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
  else { if (a1 <= a0) a1 += 2 * Math.PI }

  const sweep = Math.abs(a1 - a0)
  // Chord count from sagitta tolerance, not a fixed angular step. The
  // heightfield sim carves the chords, not the true arc: at a fixed 5°/chord
  // the sagitta grows with radius (≈ r·0.001), so on a larger circle the
  // inside profile's cut edge fell visibly short of the line the outside
  // profile cut to, leaving an uncut ring at the tangency. 0.01 mm keeps the
  // chord error well inside the carve's half-cell coverage margin.
  const ARC_SAGITTA_TOL_MM = 0.01
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_SAGITTA_TOL_MM / r)))
  const steps = Math.max(4, Math.min(4096, Math.ceil(sweep / Math.max(maxStep, 1e-4))))
  const segs: SimSegment[] = []
  let px = x0, py = y0, pz = z0
  let cumT = startTimeS

  for (let k = 1; k <= steps; k++) {
    const t = k / steps
    const a = a0 + (a1 - a0) * t
    const nx = cx + r * Math.cos(a)
    const ny = cy + r * Math.sin(a)
    const nz = z0 + (z1 - z0) * t  // interpolate Z linearly along the arc (helical support)
    const dist = Math.hypot(nx - px, ny - py, nz - pz)
    const dur = dist / (feedMmMin / 60)
    segs.push({
      x: nx, y: ny, z: nz,
      prevX: px, prevY: py, prevZ: pz,
      rapid: false,
      feedRateMmMin: feedMmMin,
      lineIdx,
      durationS: dur,
      startTimeS: cumT,
      toolStateIdx,
    })
    cumT += dur
    px = nx; py = ny; pz = nz
  }
  return segs
}

export function parseGcode(text: string, initialZMM = 5): ParsedGcode {
  // CRLF too: a line left ending in '\r' defeats the ';' comment strip below ('.' does not
  // match '\r', and '$' is end of string), so a Windows-saved program's comments were
  // parsed as words — "; retract to Z 20" simulated a move. The line count is unchanged,
  // so every lineIdx still points at the same line of the viewer.
  const rawLines = text.split(/\r?\n/)
  const segs: SimSegment[] = []

  let cx = 0, cy = 0, cz = initialZMM
  let feedRate = 1000
  let unitScale = 1
  let programUnits: 'mm' | 'in' = 'mm'
  let unitsDeclared = false
  let motionMode = 0  // 0 = G0, 1 = G1, 2 = G2, 3 = G3
  let absolute = true // G90 (default) vs G91 incremental distance mode
  const warnings = new Set<string>()
  let toolDiameterMM = 3.0
  let toolVbitHalfAngleTan: number | undefined
  let toolTipRadiusMM: number | undefined
  let toolBallNose: boolean | undefined
  let toolDrill: boolean | undefined
  let spindleRpm = 0
  let fluteCount = 2
  let cumT = 0

  // Deduplicated flyweight table of tool/spindle states. Segments store an index
  // into this (toolStateIdx). syncToolState() finds-or-creates the entry matching
  // the current parser state and points curStateIdx at it.
  const toolStates: ToolState[] = [{ toolDiameterMM, spindleRpm, fluteCount }]
  let curStateIdx = 0
  const matchesCur = (t: ToolState) =>
    t.toolDiameterMM === toolDiameterMM && t.toolVbitHalfAngleTan === toolVbitHalfAngleTan &&
    t.toolTipRadiusMM === toolTipRadiusMM &&
    t.toolBallNose === toolBallNose && t.toolDrill === toolDrill &&
    t.spindleRpm === spindleRpm && t.fluteCount === fluteCount
  const syncToolState = () => {
    if (matchesCur(toolStates[curStateIdx])) return
    const found = toolStates.findIndex(matchesCur)
    if (found >= 0) { curStateIdx = found; return }
    curStateIdx = toolStates.length
    toolStates.push({ toolDiameterMM, toolVbitHalfAngleTan, toolTipRadiusMM, toolBallNose, toolDrill, spindleRpm, fluteCount })
  }

  // Axis words: absolute (G90) coordinates, or deltas from the current
  // position in G91 incremental mode.
  const toMM = (value: number | undefined, current: number) =>
    value === undefined ? current : absolute ? value * unitScale : current + value * unitScale

  for (let li = 0; li < rawLines.length; li++) {
    const raw = rawLines[li]

    if (TOOL_MARKER_HINT.test(raw)) {
      // Parse tool diameter from comments: "; Tool: ... dia 6.350mm ..." or "(Tool: ... dia 6.350mm ...)"
      const diamMatch = raw.match(/dia\s+([\d.]+)\s*mm/i)
      if (diamMatch) {
        toolDiameterMM = parseFloat(diamMatch[1])
        toolVbitHalfAngleTan = undefined  // reset; overwritten below if vbit-angle present
        toolTipRadiusMM = undefined        // reset; overwritten below if taper-tip present
        toolBallNose = undefined           // reset; overwritten below if ballnose present
        toolDrill = undefined              // reset; overwritten below if drillbit present
      }

      // Parse V-bit half-angle tangent: "; vbit-angle:30.0" (half-angle in degrees)
      const vbitMatch = raw.match(/vbit-angle:([\d.]+)/i)
      if (vbitMatch) toolVbitHalfAngleTan = Math.tan(parseFloat(vbitMatch[1]) * (Math.PI / 180))

      // Parse a taper's tip ball: "; taper-tip:0.500" (tip DIAMETER in mm). Present only
      // for a taper — a bare vbit-angle with no tip is a V-bit, tip radius 0.
      const tipMatch = raw.match(/taper-tip:([\d.]+)/i)
      if (tipMatch) toolTipRadiusMM = parseFloat(tipMatch[1]) / 2

      // Parse ball nose marker: "; ballnose"
      const ballMatch = /\bballnose\b/i.test(raw)
      if (ballMatch) toolBallNose = true

      // Parse drill-bit marker: "; drillbit" (distinct token — op descriptions
      // like "peck drill · 5mm" contain the bare word "drill" for any tool type)
      const drillMatch = /\bdrillbit\b/i.test(raw)
      if (drillMatch) toolDrill = true

      // Parse flute count: "; ... flutes:2"
      const fluteMatch = raw.match(/flutes:(\d+)/i)
      if (fluteMatch) fluteCount = Math.max(1, parseInt(fluteMatch[1]))

      // Fold any tool-comment changes on this line into the flyweight table.
      if (diamMatch || vbitMatch || tipMatch || fluteMatch || drillMatch || ballMatch) syncToolState()
    }

    // Words, in one pass. A letter's FIRST occurrence on the line is the one that
    // counts; the G words are folded straight into the flags read below.
    const clean = raw.indexOf(';') < 0 && raw.indexOf('(') < 0
      ? raw
      : raw.replace(/;.*$/, '').replace(/\([^)]*\)/g, '')
    let wordCount = 0
    let wF: number | undefined, wS: number | undefined
    let wX: number | undefined, wY: number | undefined, wZ: number | undefined
    let wI: number | undefined, wJ: number | undefined, wR: number | undefined
    let gm: number | undefined
    let g20 = false, g21 = false, g90 = false, g91 = false
    let g18or19 = false, g90dot1 = false, g41or42 = false
    WORD_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WORD_RE.exec(clean)) !== null) {
      wordCount++
      const v = parseFloat(m[2])
      switch (m[1].charCodeAt(0) | 0x20) {  // lower-case the letter
        case 0x67: /* g */ {
          if (Math.abs(v - 20) < 0.001) g20 = true
          if (Math.abs(v - 21) < 0.001) g21 = true
          // Distance mode. Note the tolerance: G90.1/G91.1 (arc-center distance
          // mode) must NOT match here — they're handled as a warning below.
          if (Math.abs(v - 90) < 0.001) g90 = true
          if (Math.abs(v - 91) < 0.001) g91 = true
          if (Math.abs(v - 18) < 0.001 || Math.abs(v - 19) < 0.001) g18or19 = true
          if (Math.abs(v - 90.1) < 0.001) g90dot1 = true
          if (Math.abs(v - 41) < 0.001 || Math.abs(v - 42) < 0.001) g41or42 = true
          // G0-G3 motion mode
          if (gm === undefined && v >= 0 && v <= 3) gm = v
          break
        }
        case 0x66: /* f */ if (wF === undefined) wF = v; break
        case 0x73: /* s */ if (wS === undefined) wS = v; break
        case 0x78: /* x */ if (wX === undefined) wX = v; break
        case 0x79: /* y */ if (wY === undefined) wY = v; break
        case 0x7a: /* z */ if (wZ === undefined) wZ = v; break
        case 0x69: /* i */ if (wI === undefined) wI = v; break
        case 0x6a: /* j */ if (wJ === undefined) wJ = v; break
        case 0x72: /* r */ if (wR === undefined) wR = v; break
      }
    }
    if (wordCount === 0) continue

    if (g20) {
      unitScale = MM_PER_INCH
      if (!unitsDeclared) { programUnits = 'in'; unitsDeclared = true }
    }
    if (g21) {
      unitScale = 1
      if (!unitsDeclared) { programUnits = 'mm'; unitsDeclared = true }
    }
    if (g90) absolute = true
    if (g91) absolute = false

    // Features the simulator doesn't honor — flag instead of silently mis-simulating.
    if (g18or19) warnings.add('G18/G19 arc planes are not supported — arcs simulate in the XY plane')
    if (g90dot1) warnings.add('G90.1 absolute arc centers are not supported — arcs may render incorrectly')
    if (g41or42) warnings.add('G41/G42 cutter compensation is ignored')

    if (gm !== undefined) motionMode = gm

    if (wF !== undefined) feedRate = wF * unitScale

    if (wS !== undefined) { spindleRpm = wS; syncToolState() }

    if (wX === undefined && wY === undefined && wZ === undefined) continue

    const nx = toMM(wX, cx)
    const ny = toMM(wY, cy)
    const nz = toMM(wZ, cz)

    // Arc center offsets. I/J are always relative to the start point (Grbl
    // G91.1 default). R-format arcs derive the center from the radius using
    // Grbl's formula: positive R = minor arc (≤180°), negative R = major arc.
    let ii = (wI ?? 0) * unitScale
    let jj = (wJ ?? 0) * unitScale
    const rWord = wR
    if ((motionMode === 2 || motionMode === 3) && rWord !== undefined
        && wI === undefined && wJ === undefined) {
      let r = rWord * unitScale
      const dx = nx - cx, dy = ny - cy
      const chord = Math.hypot(dx, dy)
      if (chord < 0.0001) {
        warnings.add('R-format arc with coincident start/end point skipped (use I/J for full circles)')
        continue
      }
      const disc = 4 * r * r - dx * dx - dy * dy
      if (disc < -0.0001) {
        warnings.add('R-format arc radius smaller than half the chord — arc flattened')
      }
      let h = -Math.sqrt(Math.max(0, disc)) / chord
      if (motionMode === 3) h = -h
      if (r < 0) { h = -h; r = -r }
      ii = 0.5 * (dx - dy * h)
      jj = 0.5 * (dy + dx * h)
    }

    if (motionMode === 0) {
      const dist = Math.hypot(nx - cx, ny - cy, nz - cz)
      if (dist > 0.0001) {
        const dur = dist / (RAPID_MM_PER_MIN / 60)
        segs.push({
          x: nx, y: ny, z: nz,
          prevX: cx, prevY: cy, prevZ: cz,
          rapid: true,
          feedRateMmMin: RAPID_MM_PER_MIN,
          lineIdx: li,
          durationS: dur,
          startTimeS: cumT,
          toolStateIdx: curStateIdx,
        })
        cumT += dur
      }
    } else if (motionMode === 1) {
      const dist = Math.hypot(nx - cx, ny - cy, nz - cz)
      if (dist > 0.0001) {
        const feed = Math.max(feedRate, 1)
        const dur = dist / (feed / 60)
        segs.push({
          x: nx, y: ny, z: nz,
          prevX: cx, prevY: cy, prevZ: cz,
          rapid: false,
          feedRateMmMin: feed,
          lineIdx: li,
          durationS: dur,
          startTimeS: cumT,
          toolStateIdx: curStateIdx,
        })
        cumT += dur
      }
    } else if (motionMode === 2 || motionMode === 3) {
      if (wI === undefined && wJ === undefined && rWord === undefined)
        warnings.add('G2/G3 arc without I/J or R words — treated as no motion')
      const arcSegs = arcToSegments(cx, cy, nx, ny, ii, jj, motionMode === 2, cz, nz, Math.max(feedRate, 1), li, cumT, curStateIdx)
      segs.push(...arcSegs)
      if (arcSegs.length > 0) {
        const last = arcSegs[arcSegs.length - 1]
        cumT = last.startTimeS + last.durationS
      }
    }

    cx = nx; cy = ny; cz = nz
  }

  return { lines: rawLines, segments: segs, totalTimeS: cumT, toolStates, warnings: [...warnings], units: programUnits }
}

/**
 * Where each line of a program starts, as offsets into the one string.
 *
 * The same lines `parseGcode` splits a program into (`\n` or `\r\n`), without
 * keeping them: a 600k-line program split into an array is 600k separate strings on
 * top of the text itself, and the viewer only ever shows a screenful. Read one back
 * with `lineAt`.
 */
export function lineStartsOf(text: string): Uint32Array {
  let n = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  const starts = new Uint32Array(n)
  let k = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts[k++] = i + 1
  return starts
}

/** Line `i` of `text` without its line ending — `text.split(/\r?\n/)[i]`, without the split. */
export function lineAt(text: string, starts: Uint32Array, i: number): string {
  const start = starts[i]
  const last = i + 1 >= starts.length
  let end = last ? text.length : starts[i + 1] - 1
  if (!last && end > start && text.charCodeAt(end - 1) === 13) end--
  return text.slice(start, end)
}

export function getCurrentSegIdx(segments: SimSegment[], elapsedTimeS: number): number {
  if (segments.length === 0) return -1
  let lo = 0, hi = segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (segments[mid].startTimeS <= elapsedTimeS) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function interpolatePos(
  segments: SimSegment[],
  elapsedTimeS: number,
): { x: number; y: number; z: number } | null {
  if (segments.length === 0) return null
  const idx = getCurrentSegIdx(segments, elapsedTimeS)
  if (idx < 0) return null
  const seg = segments[idx]
  if (seg.durationS <= 0) return { x: seg.x, y: seg.y, z: seg.z }
  const t = Math.max(0, Math.min(1, (elapsedTimeS - seg.startTimeS) / seg.durationS))
  return {
    x: seg.prevX + (seg.x - seg.prevX) * t,
    y: seg.prevY + (seg.y - seg.prevY) * t,
    z: seg.prevZ + (seg.z - seg.prevZ) * t,
  }
}

export function formatSimTime(s: number): string {
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${m}:${ss.toString().padStart(2, '0')}`
}
