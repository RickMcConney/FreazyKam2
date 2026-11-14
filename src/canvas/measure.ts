// ─── Measuring ────────────────────────────────────────────────────────────────
//
// The Measure tool, which changes nothing in the drawing: two clicks, each snapping to a
// part's corners, edge middles and centre (the Constrain tool's points); the line is
// labelled with its length, ΔX, ΔY and angle (`measureReadout`). Shift holds the line to
// 15° steps.
//
// Pure. CNC mm, Y-up; angles CCW-positive from +X.

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
