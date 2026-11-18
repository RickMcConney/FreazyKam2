// The arithmetic of the move and resize gestures: where a dragged selection lands and how a
// handle drag turns into a scale. Pure — the hooks in useTransformGestures read the stores
// and the pointer, call these, and push the answers into the live previews — so the rules
// that decide where a part ends up can be pinned in a node test (gestureMath.test.ts).
import { equalSpacingSnap, snapAxisDelta, type Box, type SnapTargets } from './objectSnap'
import type { SnapGuides } from './layers/SnapGuideLayer'
import type { HandleType } from './types'

type Pt = { x: number; y: number }

/**
 * Where a dragged selection lands, given how far the cursor has carried it (dx, dy — any
 * axis lock already applied) from where its box started (`ib`).
 *
 * Per axis, three snaps compete, and in this order:
 *  1. ALIGNMENT — an edge or the centre of the box onto another shape's edge or centre
 *     (`snapAxisDelta`), within `tolMM`.
 *  2. EQUAL SPACING — the box into the gap that matches its neighbours' spacing
 *     (`equalSpacingSnap`). It competes with alignment, and the NEARER one wins; both are
 *     measured from where the cursor has the box, before either is applied.
 *  3. GRID — only on an axis neither of the above took, and applied to the box's min
 *     corner (`gridSnap`, which is the identity with snap off).
 * `snapOn` false turns 1 and 2 off; the grid is the caller's to switch.
 */
export function resolveMoveSnap(
  ib: Box & { cx: number; cy: number },
  dx: number, dy: number,
  targets: SnapTargets, tolMM: number, snapOn: boolean,
  gridSnap: (p: Pt) => Pt,
): { dx: number; dy: number; guides: SnapGuides | null } {
  let finalDx = dx, finalDy = dy
  let ox = snapOn ? snapAxisDelta([ib.minX + finalDx, ib.maxX + finalDx, ib.cx + finalDx], targets.xs, tolMM) : null
  let oy = snapOn ? snapAxisDelta([ib.minY + finalDy, ib.maxY + finalDy, ib.cy + finalDy], targets.ys, tolMM) : null
  const at = { minX: ib.minX + finalDx, maxX: ib.maxX + finalDx, minY: ib.minY + finalDy, maxY: ib.maxY + finalDy }
  const ex = snapOn ? equalSpacingSnap(at, targets.boxes, 'x', tolMM) : null
  const ey = snapOn ? equalSpacingSnap(at, targets.boxes, 'y', tolMM) : null
  const useEx = !!ex && (!ox || ex.dist < Math.abs(ox.correction) - 1e-9)
  const useEy = !!ey && (!oy || ey.dist < Math.abs(oy.correction) - 1e-9)
  if (useEx) ox = null
  if (useEy) oy = null
  if (ox) finalDx += ox.correction
  if (oy) finalDy += oy.correction
  if (useEx) finalDx += ex!.correction
  if (useEy) finalDy += ey!.correction
  const gridSnapped = gridSnap({ x: ib.minX + finalDx, y: ib.minY + finalDy })
  if (!ox && !useEx) finalDx = gridSnapped.x - ib.minX
  if (!oy && !useEy) finalDy = gridSnapped.y - ib.minY
  const gaps = [...(useEx ? ex!.marks : []), ...(useEy ? ey!.marks : [])]
  const guides = ox || oy || gaps.length > 0
    ? { x: ox?.guide, y: oy?.guide, ...(gaps.length > 0 ? { gaps } : {}) }
    : null
  return { dx: finalDx, dy: finalDy, guides }
}

const isEdgeHandle = (h: HandleType) => h === 't' || h === 'b' || h === 'l' || h === 'r'

/**
 * Where a resize handle lands. The handle stands on the box's edge (the anchor is the
 * opposite one and stays put), so object-snapping the POINTER aligns that edge to other
 * shapes' edges and centres — the drag's own targets and guides. An edge handle moves one
 * axis only, and the other (the box's mid-line) must not snap. The grid takes an axis the
 * object snap did not. `snapOn` is the caller's: a Shift corner drag (uniform scale)
 * derives both axes from one combined gesture, so a per-axis snap would draw a guide the
 * shape never lands on, and it passes false.
 */
export function resolveResizePoint(
  handle: HandleType, cncMouse: Pt,
  targets: SnapTargets, tolMM: number, snapOn: boolean,
  gridSnap: (p: Pt) => Pt,
): { point: Pt; guides: SnapGuides | null } {
  const ox = snapOn && handle !== 't' && handle !== 'b' ? snapAxisDelta([cncMouse.x], targets.xs, tolMM) : null
  const oy = snapOn && handle !== 'l' && handle !== 'r' ? snapAxisDelta([cncMouse.y], targets.ys, tolMM) : null
  const gridSnapped = gridSnap(cncMouse)
  return {
    point: {
      x: ox ? cncMouse.x + ox.correction : gridSnapped.x,
      y: oy ? cncMouse.y + oy.correction : gridSnapped.y,
    },
    guides: ox || oy ? { x: ox?.guide, y: oy?.guide } : null,
  }
}

/**
 * The scale a handle drag asks for, about `anchor`: the handle's new offset from the
 * anchor over its old one, per axis. An edge handle leaves the other axis at 1. `uniform`
 * (Shift on a corner) takes one factor from the diagonal distance, keeping each axis's own
 * sign so a corner dragged through the anchor still mirrors. Never below 0.001 in size, so
 * a drag onto the anchor does not collapse the shape to nothing.
 */
export function resizeScale(
  handle: HandleType, anchor: Pt, initHandle: Pt, point: Pt, uniform: boolean,
): { sx: number; sy: number } {
  const dhx = initHandle.x - anchor.x
  const dhy = initHandle.y - anchor.y
  const newHx = point.x - anchor.x
  const newHy = point.y - anchor.y
  let sx = dhx !== 0 ? newHx / dhx : 1
  let sy = dhy !== 0 ? newHy / dhy : 1
  if (handle === 't' || handle === 'b') sx = 1
  if (handle === 'l' || handle === 'r') sy = 1
  if (uniform && !isEdgeHandle(handle)) {
    const s = Math.sign(sx) * Math.hypot(newHx, newHy) / Math.hypot(dhx, dhy)
    sx = s; sy = Math.sign(sy) * Math.abs(s)
  }
  // Not Math.sign(s) * 0.001: a handle dropped EXACTLY on its anchor (the grid snaps it
  // there) has s = 0, whose sign is 0, and a zero scale baked a zero-width outline and a
  // placement matrix with no inverse. Exactly 0 reads as not mirrored.
  if (Math.abs(sx) < 0.001) sx = sx < 0 ? -0.001 : 0.001
  if (Math.abs(sy) < 0.001) sy = sy < 0 ? -0.001 : 0.001
  return { sx, sy }
}

/** The box `ib` scaled by (sx, sy) about `anchor`, as the live preview draws it. */
export function scaledBox(ib: Box, anchor: Pt, sx: number, sy: number): { minX: number; minY: number; width: number; height: number } {
  const x1 = anchor.x + (ib.minX - anchor.x) * sx, x2 = anchor.x + (ib.maxX - anchor.x) * sx
  const y1 = anchor.y + (ib.minY - anchor.y) * sy, y2 = anchor.y + (ib.maxY - anchor.y) * sy
  return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}
