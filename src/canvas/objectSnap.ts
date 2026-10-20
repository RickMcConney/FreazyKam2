import { getBBox } from './selectionUtils'

// Object snapping: while dragging a selection, its bbox edges/centers snap to
// the bbox edges/centers of every other on-canvas path plus the workpiece
// bounds. Targets are collected once at drag start; each mousemove frame then
// only scans a small number array per axis.

/** `boxes`: every other shape's box, for the equal-spacing snap (the stock is not one). */
export interface SnapTargets { xs: number[]; ys: number[]; boxes: Box[] }

export interface Box { minX: number; minY: number; maxX: number; maxY: number }

// `paths` must already be filtered to on-canvas paths excluding the dragged ones.
//
// `opts.sheets`: where every OTHER sheet's corner is (cam/sheets) — their edges and centre
// lines snap like the stock's, so a part dragged on sheet 2 lines up with sheet 2.
// `opts.mirror`: on a double-sided job, a shape's image on the other side of the board
// (cam/doubleSided `otherSideBox`), or null — so a part on one side lines up with what is
// on the other, as the guide draws it.
export function collectSnapTargets(
  paths: { d: string }[],
  workpiece: { widthMM: number; heightMM: number },
  opts: { sheets?: { x: number; y: number }[]; mirror?: (b: Box) => Box | null } = {},
): SnapTargets {
  const W = workpiece.widthMM, H = workpiece.heightMM
  const xs: number[] = [0, W, W / 2]
  const ys: number[] = [0, H, H / 2]
  for (const o of opts.sheets ?? []) {
    if (o.x === 0 && o.y === 0) continue
    xs.push(o.x, o.x + W, o.x + W / 2)
    ys.push(o.y, o.y + H, o.y + H / 2)
  }
  const boxes: Box[] = []
  const add = (b: Box) => {
    xs.push(b.minX, b.maxX, (b.minX + b.maxX) / 2)
    ys.push(b.minY, b.maxY, (b.minY + b.maxY) / 2)
    boxes.push(b)
  }
  for (const p of paths) {
    const b = getBBox(p.d)
    if (!b) continue
    const box = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }
    add(box)
    const m = opts.mirror?.(box)
    if (m) add(m)
  }
  return { xs, ys, boxes }
}

/** One gap the equal-spacing snap matched: from `from` to `to` along `axis`, drawn across
 *  at `at` on the other axis. */
export interface GapMark { axis: 'x' | 'y'; from: number; to: number; at: number }

// EQUAL SPACING: the dragged box `d` (where the drag has it now) snapped along `axis` so the
// gaps to its neighbours come out equal. Its neighbours are the boxes in the same ROW (for
// x; column for y) — those overlapping it on the other axis — nearest on each side. Two
// ways a gap can be matched:
//   - BETWEEN two neighbours, with the same gap on both sides of it;
//   - BESIDE a neighbour, the gap that neighbour already has to ITS next one on the far side,
//     so a third part dropped after two spaced ones takes their spacing.
// Returns the correction to add to the drag on that axis and the gaps to draw, or null when
// no candidate is within `tolMM`. Gaps under 0.01 mm (touching) are not offered.
export function equalSpacingSnap(
  d: Box,
  boxes: Box[],
  axis: 'x' | 'y',
  tolMM: number,
): { correction: number; dist: number; marks: GapMark[] } | null {
  const X = axis === 'x'
  const lo = (b: Box) => (X ? b.minX : b.minY), hi = (b: Box) => (X ? b.maxX : b.maxY)
  const plo = (b: Box) => (X ? b.minY : b.minX), phi = (b: Box) => (X ? b.maxY : b.maxX)
  const overlaps = (a: Box, b: Box) => Math.min(phi(a), phi(b)) > Math.max(plo(a), plo(b))
  const row = boxes.filter((b) => overlaps(b, d))
  if (row.length === 0) return null
  const dLo = lo(d), dHi = hi(d), size = dHi - dLo, mid = (dLo + dHi) / 2
  // Nearest wholly to one side of a point: the box with the greatest `hi` at or before it,
  // or the least `lo` at or after it.
  const before = (at: number, of: Box[]) => {
    let best: Box | null = null
    for (const b of of) if (hi(b) <= at + 1e-9 && (!best || hi(b) > hi(best))) best = b
    return best
  }
  const after = (at: number, of: Box[]) => {
    let best: Box | null = null
    for (const b of of) if (lo(b) >= at - 1e-9 && (!best || lo(b) < lo(best))) best = b
    return best
  }
  // Where a gap line is drawn across: the middle of where the two boxes overlap.
  const across = (a: Box, b: Box) => (Math.max(plo(a), plo(b)) + Math.min(phi(a), phi(b))) / 2
  const mark = (from: number, to: number, a: Box, b: Box): GapMark => ({ axis, from, to, at: across(a, b) })

  // Sides are told by the dragged box's middle, so a neighbour it is sliding over (on the
  // way to a smaller gap than the one it has) is still on the side it came from.
  const L = before(mid, row), R = after(mid, row)
  let best: { correction: number; dist: number; marks: GapMark[] } | null = null
  const offer = (newLo: number, marks: (at: number) => GapMark[], gap: number) => {
    if (gap < 0.01) return
    const correction = newLo - dLo, dist = Math.abs(correction)
    if (dist < tolMM && (!best || dist < best.dist)) best = { correction, dist, marks: marks(newLo) }
  }
  if (L && R) {
    const gap = (lo(R) - hi(L) - size) / 2
    offer(hi(L) + gap, (n) => [mark(hi(L), n, L, d), mark(n + size, lo(R), d, R)], gap)
  }
  if (L) {
    const LL = before(lo(L), row.filter((b) => b !== L && overlaps(b, L)))
    if (LL) {
      const gap = lo(L) - hi(LL)
      offer(hi(L) + gap, (n) => [mark(hi(LL), lo(L), LL, L), mark(hi(L), n, L, d)], gap)
    }
  }
  if (R) {
    const RR = after(hi(R), row.filter((b) => b !== R && overlaps(b, R)))
    if (RR) {
      const gap = lo(RR) - hi(R)
      offer(lo(R) - gap - size, (n) => [mark(n + size, lo(R), d, R), mark(hi(R), lo(RR), R, RR)], gap)
    }
  }
  return best
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
