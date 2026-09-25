import { generateGcodeWithOps } from './gcode'
import { parseGcode } from '../sim/gcodeParser'
import type { AnyOperation } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'

/**
 * How long each operation runs, in seconds, keyed by op id (review2 F9).
 *
 * The export dialog's total says how long the JOB takes; this says WHICH operation it is
 * spending it on. Same estimate — the program the export writes, through the parser the
 * simulator uses (programmed feeds and a fixed rapid rate, no acceleration, so a floor) —
 * cut up by where each operation's section of the program starts. That is what makes the
 * parts add up to the whole: every move is charged to exactly one op, including the
 * transit into it from wherever the previous one finished. Timing each op as a program of
 * its own charged every one of them a rapid out from the origin instead, and on a clock
 * with 78 small operations the parts came to 8.8 min against a 3.8 min job.
 *
 * Ops that are not in the exported program (hidden, not generated, failed, empty,
 * imported G-code) are absent from the map. Tool-change pauses are not timed — the parser
 * cannot know how long a person takes to swap a bit.
 */
export function opRunTimesS(
  operations: AnyOperation[],
  toolsById: Record<string, Tool>,
  profile: PostProcessorProfile,
): Map<string, number> {
  const out = new Map<string, number>()
  const { gcode, opStarts } = generateGcodeWithOps(operations, toolsById, 'estimate', profile)
  if (opStarts.length === 0) return out
  const { segments } = parseGcode(gcode)
  // Segments come in line order, as do the sections, so one walk assigns every move. A
  // move in the post's start block (a retract some posts open with) goes to the first op
  // and one in its end block to the last, as the transit between ops goes to the op it
  // leads into: every second of the program belongs to exactly one op.
  let k = 0
  for (const seg of segments) {
    while (k + 1 < opStarts.length && seg.lineIdx >= opStarts[k + 1].line) k++
    const id = opStarts[k].opId
    out.set(id, (out.get(id) ?? 0) + seg.durationS)
  }
  // An op whose section parsed to no motion still ran — as nothing.
  for (const { opId } of opStarts) if (!out.has(opId)) out.set(opId, 0)
  return out
}

/** A run time as the app writes it everywhere: `~1h 5m`, `~3m 12s`, `~40s`, or `—`. */
export function fmtDuration(s: number): string {
  if (s <= 0) return '—'
  const t = Math.round(s)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  if (h > 0) return `~${h}h ${m}m`
  if (m > 0) return `~${m}m ${sec}s`
  return `~${sec}s`
}

/** The same, short enough for a chip: `40s`, `3m`, `1h 5m`, or '' for nothing to show. */
export function fmtDurationShort(s: number): string {
  if (!(s > 0)) return ''
  const t = Math.round(s)
  if (t < 60) return `${t}s`
  const m = Math.round(t / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
