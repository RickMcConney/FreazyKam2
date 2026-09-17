import { getBBox } from './selectionUtils'

// Object snapping: while dragging a selection, its bbox edges/centers snap to
// the bbox edges/centers of every other on-canvas path plus the workpiece
// bounds. Targets are collected once at drag start; each mousemove frame then
// only scans a small number array per axis.

export interface SnapTargets { xs: number[]; ys: number[] }

// `paths` must already be filtered to on-canvas paths excluding the dragged ones.
export function collectSnapTargets(
  paths: { d: string }[],
  workpiece: { widthMM: number; heightMM: number },
): SnapTargets {
  const xs: number[] = [0, workpiece.widthMM, workpiece.widthMM / 2]
  const ys: number[] = [0, workpiece.heightMM, workpiece.heightMM / 2]
  for (const p of paths) {
    const b = getBBox(p.d)
    if (!b) continue
    xs.push(b.minX, b.maxX, b.cx)
    ys.push(b.minY, b.maxY, b.cy)
  }
  return { xs, ys }
}

// `edges` are the dragged bbox's candidate values on one axis at the current
// drag delta. Returns the correction to add to that delta plus the matched
// target value (where the alignment guide is drawn), or null when nothing is
// within `tolMM`.
export function snapAxisDelta(
  edges: number[],
  targets: number[],
  tolMM: number,
): { correction: number; guide: number } | null {
  let best: { correction: number; guide: number } | null = null
  let bestDist = tolMM
  for (const e of edges) {
    for (const t of targets) {
      const dist = Math.abs(t - e)
      if (dist < bestDist) {
        bestDist = dist
        best = { correction: t - e, guide: t }
      }
    }
  }
  return best
}

// THE NEXT MULTIPLE OF `step` STRICTLY PAST `pos` in direction `dir` (sign only).
// A nudge with snap on moves to these points, so a stop on a guide line does not
// shift where the presses after it land — from 12.4 the next 1 mm point is 13, not
// 13.4. A `pos` already on a point (within `onPointMM`) moves a whole step off it.
export function nextStepPoint(pos: number, step: number, dir: number, onPointMM: number): number {
  return dir > 0
    ? (Math.floor((pos + onPointMM) / step) + 1) * step
    : (Math.ceil((pos - onPointMM) / step) - 1) * step
}

// A NUDGE STOPS ON A LINE IT WOULD OTHERWISE JUMP OVER. `cur` is the delta the
// dragged bbox's `edges` stand at now and `next` the delta the key press asks for;
// the result is the delta to take — the nearest one, in the direction of travel,
// that puts any edge ON a target, else `next`. A line an edge already sits on
// (within `onLineMM`) is not a stop, or the next press could never leave it.
export function nudgeStopDelta(
  edges: number[],
  targets: number[],
  cur: number,
  next: number,
  onLineMM: number,
): number {
  const dir = Math.sign(next - cur)
  if (dir === 0) return next
  let best = next
  for (const e of edges) {
    for (const t of targets) {
      const at = t - e
      if (dir > 0 ? at > cur + onLineMM && at < best : at < cur - onLineMM && at > best) best = at
    }
  }
  return best
}
