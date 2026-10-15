// ─── Measuring ────────────────────────────────────────────────────────────────
//
// Two read-only ways to measure, neither of which changes the drawing:
//   - ALT-HOVER: with something selected, hold Alt and hover another part — the gaps
//     between the two boxes are drawn and labelled (`measureGaps`). Hovering empty canvas
//     measures against the stock sheet instead, which says where the part sits on it.
//   - THE MEASURE TOOL: two clicks, each snapping to a part's corners, edge middles and
//     centre (the Constrain tool's points); the line is labelled with its length, ΔX, ΔY
//     and angle (`measureReadout`). Shift holds the line to 15° steps.
//
// Pure. CNC mm, Y-up; angles CCW-positive from +X.

import type { Box, GapMark } from './objectSnap'

/**
 * The distances between box `s` (the selection) and box `h` (what is hovered), as gaps to
 * draw. Per axis:
 *   - apart: the one gap between their facing edges;
 *   - one inside the other: the two gaps from the inner box's edges out to the outer's —
 *     where a part sits within the plate (or stock) around it;
 *   - partly overlapping: nothing, since neither "gap" nor "inset" says anything true.
 * Each gap is drawn across through the middle of where the two boxes overlap on the other
 * axis, or through the selection's middle when they do not. Gaps under 0.001 mm are left out.
 */
export function measureGaps(s: Box, h: Box): GapMark[] {
  const out: GapMark[] = []
  for (const axis of ['x', 'y'] as const) {
    const X = axis === 'x'
    const lo = (b: Box) => (X ? b.minX : b.minY), hi = (b: Box) => (X ? b.maxX : b.maxY)
    const plo = (b: Box) => (X ? b.minY : b.minX), phi = (b: Box) => (X ? b.maxY : b.maxX)
    const oLo = Math.max(plo(s), plo(h)), oHi = Math.min(phi(s), phi(h))
    const at = oHi > oLo ? (oLo + oHi) / 2 : (plo(s) + phi(s)) / 2
    const add = (from: number, to: number, where = at) => { if (to - from > 1e-3) out.push({ axis, from, to, at: where }) }
    if (hi(s) <= lo(h)) add(hi(s), lo(h))
    else if (hi(h) <= lo(s)) add(hi(h), lo(s))
    else if (lo(h) <= lo(s) && hi(s) <= hi(h)) {
      // The selection inside the hovered box: measured through the selection's own middle.
      const mid = (plo(s) + phi(s)) / 2
      add(lo(h), lo(s), mid); add(hi(s), hi(h), mid)
    } else if (lo(s) <= lo(h) && hi(h) <= hi(s)) {
      const mid = (plo(h) + phi(h)) / 2
      add(lo(s), lo(h), mid); add(hi(h), hi(s), mid)
    }
  }
  return out
}

export interface Readout { distMM: number; dxMM: number; dyMM: number; angleDeg: number }

/** Length, run, rise and angle from `a` to `b`. */
export function measureReadout(a: { x: number; y: number }, b: { x: number; y: number }): Readout {
  const dx = b.x - a.x, dy = b.y - a.y
  const angle = Math.atan2(dy, dx) * 180 / Math.PI
  return { distMM: Math.hypot(dx, dy), dxMM: dx, dyMM: dy, angleDeg: Math.abs(angle) < 1e-9 ? 0 : angle }
}

/** `b` turned about `a` onto the nearest multiple of `stepDeg`, keeping its distance. */
export function snapAngle(a: { x: number; y: number }, b: { x: number; y: number }, stepDeg: number): { x: number; y: number } {
  const dx = b.x - a.x, dy = b.y - a.y, r = Math.hypot(dx, dy)
  if (r < 1e-12) return b
  const step = stepDeg * Math.PI / 180
  const th = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: a.x + r * Math.cos(th), y: a.y + r * Math.sin(th) }
}
