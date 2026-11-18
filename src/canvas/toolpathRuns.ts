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
