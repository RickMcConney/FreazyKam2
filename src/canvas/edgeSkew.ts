import type { HandleType } from './types'

type Pt = { x: number; y: number }

/**
 * The shear a Shift-drag on an EDGE handle makes, as `{ kx, ky }` for the `skew` transform
 * (x' = x + kx·(y − ay), y' = y + ky·(x − ax), about the anchor).
 *
 * Measured from where the press LANDED, not from where the handle sits, and the movement is
 * what gets snapped, not the pointer. Both matter for getting a shear back: the handle of a
 * sheared selection sits at its bounding-box middle, which is almost never on the grid, so
 * snapping the pointer's position left every drag a residual shear — the pointer could be
 * put back exactly where it started and the shape stayed skewed by the distance to the nearest
 * grid line. Snapping the movement means "no movement" is always "no shear", and every shear
 * is a whole number of grid steps, so a later one can cancel it.
 *
 * Only the movement ALONG the edge counts (top/bottom slide sideways, left/right up and down);
 * the movement across it is the scale this gesture replaces. The edge under the pointer moves
 * by exactly the (snapped) movement: kx · (handle − anchor) = dx.
 *
 * `snapDelta` snaps a distance; pass the identity when snap is off.
 */
export function edgeSkew(
  handle: HandleType,
  anchor: Pt,
  initHandle: Pt,
  press: Pt,
  mouse: Pt,
  snapDelta: (d: number) => number,
): { kx: number; ky: number } {
  const alongX = handle === 't' || handle === 'b'
  if (alongX) {
    const dhy = initHandle.y - anchor.y
    return { kx: dhy !== 0 ? snapDelta(mouse.x - press.x) / dhy : 0, ky: 0 }
  }
  const dhx = initHandle.x - anchor.x
  return { kx: 0, ky: dhx !== 0 ? snapDelta(mouse.y - press.y) / dhx : 0 }
}
