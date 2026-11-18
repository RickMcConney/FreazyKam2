import type { MotionSegment } from '../store/toolpathStore'

/** One drawing command of a toolpath's cutting moves, in CNC mm: a pen move, a line, or an
 *  arc as canvas `arc()` takes it (canvas angles run +x towards +y, which in CNC Y-up is
 *  CCW — so a CW arc is `anticlockwise`). */
export type RunCmd =
  | { k: 'M'; x: number; y: number }
  | { k: 'L'; x: number; y: number }
  /** A PLUNGE: a cut straight down, no XY to draw. Drawn as a disc the size of the bit — a
   *  peck drill's toolpath is nothing else, and as a zero-length line the canvas prunes it,
   *  so hovering a drill op lit up nothing at all. Once per spot, however many pecks. */
  | { k: 'D'; x: number; y: number }
  | { k: 'A'; cx: number; cy: number; r: number; a0: number; a1: number; anticlockwise: boolean }

/** The cutting moves of one TOOL, between tool changes; `toolId: null` is the op's own
 *  tool until the first change. */
export interface CmdRun { toolId: string | null; cmds: RunCmd[] }

/**
 * A toolpath's CUTTING moves as drawing commands, split into one run per tool. A rapid is
 * a pen move — but it leaves the pen at a KNOWN point, so the cut after it is drawn FROM
 * there: a ramp or a helix straight after a G0 is a cut like any other. Only the first move
 * of a run starts from nowhere. (Treating a rapid as "pen position unknown" dropped the
 * first cut after every rapid: invisible for a vertical plunge, which has no XY to draw,
 * but the first turn of every helical entry went missing from the hover glow.)
 */
export function toolpathRuns(segs: MotionSegment[]): CmdRun[] {
  const runs: CmdRun[] = [{ toolId: null, cmds: [] }]
  let cmds = runs[0].cmds
  let known = false
  let px = 0, py = 0
  let spots = new Set<string>()   // plunge spots already marked in this run
  for (const g of segs) {
    if (g.toolChange) {
      known = false
      cmds = []
      spots = new Set()
      runs.push({ toolId: g.toolChange, cmds })
      continue
    }
    if (g.rapid || !known) {
      cmds.push({ k: 'M', x: g.x, y: g.y })
      known = true
      px = g.x; py = g.y
      continue
    }
    if (!g.arc && Math.abs(g.x - px) < 1e-6 && Math.abs(g.y - py) < 1e-6) {
      const key = `${g.x},${g.y}`
      if (!spots.has(key)) { spots.add(key); cmds.push({ k: 'D', x: g.x, y: g.y }) }
      continue
    }
    if (g.arc) {
      const { cx, cy, cw } = g.arc
      const r = Math.hypot(px - cx, py - cy)
      if (r < 0.001) cmds.push({ k: 'L', x: g.x, y: g.y })
      else {
        const a0 = Math.atan2(py - cy, px - cx)
        const full = Math.abs(px - g.x) < 0.001 && Math.abs(py - g.y) < 0.001
        const a1 = full ? a0 + (cw ? -2 * Math.PI : 2 * Math.PI) : Math.atan2(g.y - cy, g.x - cx)
        cmds.push({ k: 'A', cx, cy, r, a0, a1, anticlockwise: cw })
      }
    } else cmds.push({ k: 'L', x: g.x, y: g.y })
    px = g.x; py = g.y
  }
  return runs
}

/** One tool's cutting moves grouped by the WIDTH the tool cuts them at (mm, rounded to
 *  `quantumMM`), so each group strokes at one line width. */
export interface SwathRun { toolId: string | null; byWidth: Map<number, RunCmd[]> }

/**
 * The hover glow's SWATH: what the tool sweeps, drawn at the width it actually cuts at each
 * move's depth (`widthAt(toolId, z)`) — not the bit's full width, which for a V-bit is how
 * wide it would cut buried to its shank: a shallow V-carve lit up as a fat band over the
 * whole drawing. A straight-walled tool gives one width and comes out as `toolpathRuns` did.
 * A move whose two ends cut different widths (a V-carve sloping along a medial edge) is
 * split into pieces at most `maxPieceMM` long, each at its middle's width, so the swath
 * narrows and widens along it; an arc is drawn whole, at its middle's width.
 */
export function swathRuns(
  segs: MotionSegment[],
  widthAt: (toolId: string | null, z: number) => number,
  quantumMM = 0.05,
  maxPieceMM = 0.5,
): SwathRun[] {
  const q = (w: number) => Math.max(quantumMM, Math.round(w / quantumMM) * quantumMM)
  const runs: SwathRun[] = [{ toolId: null, byWidth: new Map() }]
  let run = runs[0]
  let known = false
  let px = 0, py = 0, pz = 0
  let spots = new Set<string>()
  const into = (w: number) => { let l = run.byWidth.get(w); if (!l) { l = []; run.byWidth.set(w, l) } return l }
  for (const g of segs) {
    if (g.toolChange) {
      known = false
      spots = new Set()
      run = { toolId: g.toolChange, byWidth: new Map() }
      runs.push(run)
      continue
    }
    if (g.rapid || !known) { known = true; px = g.x; py = g.y; pz = g.z; continue }
    const w = (z: number) => q(widthAt(run.toolId, z))
    if (!g.arc && Math.abs(g.x - px) < 1e-6 && Math.abs(g.y - py) < 1e-6) {
      // A plunge: the disc it leaves, at the depth it reaches.
      const wd = w(Math.min(g.z, pz))
      const key = `${g.x},${g.y},${wd}`
      if (!spots.has(key)) { spots.add(key); into(wd).push({ k: 'D', x: g.x, y: g.y }) }
      pz = g.z
      continue
    }
    if (g.arc) {
      const { cx, cy, cw } = g.arc
      const r = Math.hypot(px - cx, py - cy)
      const list = into(w((pz + g.z) / 2))
      list.push({ k: 'M', x: px, y: py })
      if (r < 0.001) list.push({ k: 'L', x: g.x, y: g.y })
      else {
        const a0 = Math.atan2(py - cy, px - cx)
        const full = Math.abs(px - g.x) < 0.001 && Math.abs(py - g.y) < 0.001
        const a1 = full ? a0 + (cw ? -2 * Math.PI : 2 * Math.PI) : Math.atan2(g.y - cy, g.x - cx)
        list.push({ k: 'A', cx, cy, r, a0, a1, anticlockwise: cw })
      }
    } else {
      const len = Math.hypot(g.x - px, g.y - py)
      const n = w(pz) === w(g.z) ? 1 : Math.max(1, Math.ceil(len / maxPieceMM))
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n
        const list = into(w(pz + ((t0 + t1) / 2) * (g.z - pz)))
        const last = list[list.length - 1]
        const x0 = px + t0 * (g.x - px), y0 = py + t0 * (g.y - py)
        // Continue the group's open line when this piece starts where it ended.
        if (!last || last.k === 'D' || last.k === 'A' || Math.abs(last.x - x0) > 1e-9 || Math.abs(last.y - y0) > 1e-9) list.push({ k: 'M', x: x0, y: y0 })
        list.push({ k: 'L', x: px + t1 * (g.x - px), y: py + t1 * (g.y - py) })
      }
    }
    px = g.x; py = g.y; pz = g.z
  }
  return runs
}
