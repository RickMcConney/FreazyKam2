// The toolpath of a job loaded from the SD card, flattened to XY polylines for the
// go-to map. G-code coordinates are work coordinates, which is what the map draws
// in, so nothing is shifted. The simulator's parser reads it (arcs, G91, inch
// programs all converted to mm) — this only decides what to draw.

import { parseGcode } from '../sim/gcodeParser'
import type { MotionSegment } from '../store/toolpathStore'
import { MAX_GCODE_LINE } from '../cam/gcode'

/**
 * Lines a controller may refuse as too long — Grbl's limit is 80, and FluidNC in the
 * field aborted a job (error 14, ALARM 17) on a 142-character comment. Said BEFORE
 * Run, since the controller only finds out when it reaches the line.
 */
export function longLines(text: string, max = MAX_GCODE_LINE): number[] {
  const out: number[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) if (lines[i].length > max) out.push(i + 1)
  return out
}

export interface JobPreview {
  cuts: [number, number][][]     // feed moves, broken wherever a rapid intervenes
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null   // of the cuts
  segments: number               // moves in the program, before thinning
  // For the Z bar: the deepest feed move, and the program's own safe height — the
  // Z its XY rapids travel at most often (the first and last rapids may sit higher,
  // so the commonest, not the highest). Null when the program has none.
  deepestZ: number | null
  safeZ: number | null
  warnings: string[]
}

/**
 * A point closer than `minStepMM` to the last one kept is dropped: a big 3D
 * program has hundreds of thousands of moves, far more than a map can show.
 * Each polyline's last point is always kept, so no cut appears shortened.
 */
export function jobPreview(text: string, minStepMM = 0.2): JobPreview {
  const parsed = parseGcode(text)
  const cuts: [number, number][][] = []
  let cur: [number, number][] | null = null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let deepestZ = Infinity
  const rapidZ = new Map<number, number>()   // hundredths of a mm → count
  const flush = () => {
    if (cur && cur.length > 1) cuts.push(cur)
    cur = null
  }
  for (let i = 0; i < parsed.segments.length; i++) {
    const s = parsed.segments[i]
    if (s.rapid) {
      flush()
      if (s.x !== s.prevX || s.y !== s.prevY) {
        const k = Math.round(s.z * 100)
        rapidZ.set(k, (rapidZ.get(k) ?? 0) + 1)
      }
      continue
    }
    deepestZ = Math.min(deepestZ, s.prevZ, s.z)
    // A plunge or retract adds no XY line, but it does not break the cut either.
    if (!cur) cur = [[s.prevX, s.prevY]]
    const last = cur[cur.length - 1]
    const nextIsRapid = i + 1 >= parsed.segments.length || parsed.segments[i + 1].rapid
    if (Math.hypot(s.x - last[0], s.y - last[1]) >= minStepMM || nextIsRapid) {
      if (s.x !== last[0] || s.y !== last[1]) cur.push([s.x, s.y])
    }
    minX = Math.min(minX, s.prevX, s.x); maxX = Math.max(maxX, s.prevX, s.x)
    minY = Math.min(minY, s.prevY, s.y); maxY = Math.max(maxY, s.prevY, s.y)
  }
  flush()
  let safeZ: number | null = null, best = 0
  for (const [k, n] of rapidZ) if (n > best) { best = n; safeZ = k / 100 }
  return {
    cuts,
    bounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null,
    segments: parsed.segments.length,
    deepestZ: Number.isFinite(deepestZ) ? deepestZ : null,
    safeZ,
    warnings: [...longLineWarning(text), ...parsed.warnings],
  }
}

function longLineWarning(text: string): string[] {
  const long = longLines(text)
  if (!long.length) return []
  const where = long.length <= 3 ? `line${long.length > 1 ? 's' : ''} ${long.join(', ')}` : `${long.length} lines (first: ${long[0]})`
  return [`${where} longer than ${MAX_GCODE_LINE} characters — the controller may stop the job there with "Line too long". Regenerate it from FreazyKam, or shorten the line.`]
}

/**
 * The same picture for the CURRENT DESIGN's toolpaths, straight from their motion
 * segments (no G-code needed): cutting moves only, arcs expanded, shifted by
 * (dx, dy) from stock-local into work coordinates. Rapids and stay-down travel
 * moves break the line, as rapids do in a program.
 */
export function segmentCuts(segmentLists: MotionSegment[][], dx: number, dy: number, minStepMM = 0.2): [number, number][][] {
  const cuts: [number, number][][] = []
  for (const segs of segmentLists) {
    if (!segs.length) continue
    let cur: [number, number][] | null = null
    let px = segs[0].x, py = segs[0].y
    const flush = () => { if (cur && cur.length > 1) cuts.push(cur); cur = null }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (s.toolChange) continue
      if (s.rapid || s.travel) { flush(); px = s.x; py = s.y; continue }
      if (!cur) cur = [[px + dx, py + dy]]
      const pts = s.arc ? arcPoints(px, py, s.x, s.y, s.arc.cx, s.arc.cy, s.arc.cw) : [[s.x, s.y] as [number, number]]
      for (let k = 0; k < pts.length; k++) {
        const [x, y] = pts[k]
        const last = cur[cur.length - 1]
        const isEnd = k === pts.length - 1 && (i + 1 >= segs.length || segs[i + 1].rapid || segs[i + 1].travel)
        if (Math.hypot(x + dx - last[0], y + dy - last[1]) >= minStepMM || isEnd) {
          if (x + dx !== last[0] || y + dy !== last[1]) cur.push([x + dx, y + dy])
        }
      }
      px = s.x; py = s.y
    }
    flush()
  }
  return cuts
}

// An arc from (px, py) to (x, y) about (cx, cy) as points after the start, 5° apart.
// End = start is a full circle.
function arcPoints(px: number, py: number, x: number, y: number, cx: number, cy: number, cw: boolean): [number, number][] {
  const r = Math.hypot(px - cx, py - cy)
  if (r < 1e-3) return [[x, y]]
  const a0 = Math.atan2(py - cy, px - cx)
  let a1 = Math.atan2(y - cy, x - cx)
  if (Math.abs(px - x) < 1e-3 && Math.abs(py - y) < 1e-3) a1 = a0 + (cw ? -2 : 2) * Math.PI
  else if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
  else if (a1 <= a0) a1 += 2 * Math.PI
  const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / (5 * Math.PI / 180)))
  const out: [number, number][] = []
  for (let k = 1; k < n; k++) {
    const a = a0 + ((a1 - a0) * k) / n
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  out.push([x, y])
  return out
}
