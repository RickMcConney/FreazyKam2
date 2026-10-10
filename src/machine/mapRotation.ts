// The go-to map can be turned, so it matches the table as seen from where the user sits.
// These are the two directions of that one mapping, shared by the map (drawing and
// clicks) and the jog pad (whose arrows move the tool the way they point ON THE MAP), so the
// two can never disagree about which way is which.
//
// The map draws work coordinates through `rotate(θ) scale(1,−1)` — the Y-flip that puts
// work +Y up, then θ clockwise on screen — which sends work (x, y) to SVG (screen, y-down)
//   ( cosθ·x + sinθ·y ,  sinθ·x − cosθ·y )
// That matrix is a reflection, so it is its own inverse.

export type MapRotation = 0 | 90 | 180 | 270

const cs = (rot: MapRotation) => {
  const r = (rot * Math.PI) / 180
  return [Math.round(Math.cos(r)), Math.round(Math.sin(r))] as const
}

/** Work (x, y) → SVG coordinates (screen axes, y DOWN) on a map turned `rot` clockwise. */
export function workToMap(x: number, y: number, rot: MapRotation): [number, number] {
  const [c, s] = cs(rot)
  return [c * x + s * y + 0, s * x - c * y + 0]
}

/**
 * A direction on screen — `right` +1 is rightwards, `up` +1 is upwards — as a work-coordinate
 * direction, on a map turned `rot` clockwise. What a jog arrow must send so the tool moves
 * the way the arrow points on the map.
 */
export function screenDirToWork(right: number, up: number, rot: MapRotation): { x: number; y: number } {
  const [c, s] = cs(rot)
  // The same reflection applied to the screen vector (right, −up) in y-down coordinates.
  return { x: c * right - s * up + 0, y: s * right + c * up + 0 }   // + 0: no −0
}
