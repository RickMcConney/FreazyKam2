import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import { otherSideBox } from '../cam/doubleSided'
import { cellOffset } from '../cam/sheets'
import { useCanvasStore } from '../store/canvasStore'
import { planConstraints, type AnchorCandidate, type ConstraintPlan } from '../store/constraints'
import { useConstraintsStore } from '../store/constraintsStore'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { SnapGuides } from './layers/SnapGuideLayer'
import { originWorldXY } from './layers/WorkpieceLayer'
import { collectSnapTargets, type Box, type SnapTargets } from './objectSnap'
import { onCanvas } from './pathHit'
import { getMultiBBox, type BBox } from './selectionUtils'
import type { HandleType, LiveTransform } from './types'
import { useRefState } from './useRefState'
import { sheetLayoutNow } from './useSheets'
import { snapPoint, type Viewport } from './viewport'

export type CanvasMode =
  | { type: 'idle' }
  | { type: 'pan' }
  // `pick` is the Constrain tool borrowing this mode: the second point of a
  // half-made constraint is being DRAGGED, and mouseup creates the constraint
  // holding wherever it landed. Borrowed rather than given a mode of its own so
  // the drag gets object snap, grid snap, Shift axis-lock and the live preview
  // of the part's OWN constraints for nothing — and so the two kinds of drag
  // cannot bake differently.
  | { type: 'move'; pathIds: string[]; startCNC: { x: number; y: number }; initBbox: BBox; snapTargets: SnapTargets; pick?: { held: AnchorCandidate; hot: AnchorCandidate }; narrowTo?: string }
  | { type: 'resize'; pathIds: string[]; handle: HandleType; anchor: { x: number; y: number }; initHandle: { x: number; y: number }; startCNC: { x: number; y: number }; initBbox: BBox; shiftHeld: boolean; snapTargets: SnapTargets }
  | { type: 'rotate'; pathIds: string[]; center: { x: number; y: number }; initAngle: number }
  | { type: 'dragbox'; startScreen: { x: number; y: number } }
  | { type: 'drawshape'; startCNC: { x: number; y: number }; currentCNC: { x: number; y: number } }
  | { type: 'pendraw'; anchorCNC: { x: number; y: number }; closing: boolean }
  | { type: 'nodedit-drag'; nodeIdx: number; kind: 'anchor' | 'handle-in' | 'handle-out' }
  // Dragging a joint of a clock's going train. Only ONE angle changes — the link
  // from this arbor to the next — and everything on the drive side of it
  // translates rigidly; see onMoveClockLink.
  | { type: 'clocklink-drag'; nodeIdx: number }

export const MOVE_THRESHOLD_PX = 4  // pixels before a click is treated as a drag
export const OBJECT_SNAP_PX = 8     // screen px within which a dragged bbox edge snaps to another shape's edge
export const EMPTY_BBOX: BBox = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0, cx: 0, cy: 0 }

/**
 * What snapping needs beyond the shapes themselves: every sheet's corner, and on a
 * double-sided job the mirror that carries a shape to the other side of the board — so a
 * part lines up with its own sheet and with what is on the other face.
 */
export function snapOptions() {
  const wp = useWorkpieceStore.getState()
  const sheets = sheetLayoutNow().map((c) => cellOffset(c, wp))
  const ds = wp.doubleSided
  return { sheets, mirror: ds ? (b: Box) => otherSideBox(ds.flip, wp, b) : undefined }
}

/**
 * What a MOVE of `ids` measures against, built once when it starts.
 *
 * Three gestures move paths — a click-drag, the Constrain tool's drag of a
 * second point, and an arrow-key nudge — and each built these three things by
 * hand (review2 S3). One place, so they cannot disagree about what a part snaps
 * to or which followers ride along:
 *  - `bbox`: the moved paths' exact box, which the snaps align (null when there
 *    is no geometry — a nudge then moves without snapping);
 *  - `snapTargets`: every OTHER visible shape's edges and centres, and the
 *    stock's;
 *  - `plan`: the constraint solve for this set, resolved now so each frame of
 *    the preview is arithmetic (see `constraintPlanRef`).
 */
export function beginMoveSession(ids: string[]): { bbox: BBox | null; snapTargets: SnapTargets; plan: ConstraintPlan | null } {
  const allPaths = usePathsStore.getState().paths
  const { widthMM, heightMM } = useWorkpieceStore.getState()
  const moving = new Set(ids)
  return {
    bbox: getMultiBBox(allPaths.filter((p) => moving.has(p.id)).map((p) => p.d)),
    snapTargets: collectSnapTargets(allPaths.filter((p) => onCanvas(p) && !moving.has(p.id)), { widthMM, heightMM }, snapOptions()),
    plan: planConstraints(allPaths, useConstraintsStore.getState().constraints, { widthMM, heightMM }, ids).plan,
  }
}

/**
 * The state every interaction mode shares: which gesture is live (`modeRef`), whether it
 * has become a drag, the modifier keys, and every live preview. The previews live together
 * because `endGesture` has to clear all of them, and a preview it does not know about is a
 * preview that outlives its gesture.
 */
export function useGesture(viewportRef: MutableRefObject<Viewport>) {
  const spaceHeldRef = useRef(false)

  const modeRef = useRef<CanvasMode>({ type: 'idle' })
  // Ref pair, not plain state: mouseup bakes from liveTransformRef so a mouseup
  // that lands before React commits the last mousemove's render still bakes the
  // final transform, not the previous frame's (bugs.md B6).
  const [liveTransform, liveTransformRef, setLiveTransform] = useRefState<LiveTransform | null>(null)

  // THE CONSTRAINT SOLVE FOR THE DRAG IN FLIGHT, previewed live.
  //
  // Built ONCE on mousedown (`planConstraints` flattens geometry and settles the
  // walk order) and then run as pure arithmetic on every mousemove — the `d`
  // strings do not change until mouse-up, and every constrained move is a
  // translation, so nothing has to be re-resolved. Re-solving from scratch each
  // frame would flatten every path of every constrained body at pointer rate,
  // which on a gear is exactly the kind of per-frame cost this canvas avoids
  // everywhere else. Same code path as the real solve, so what is previewed is
  // what lands.
  const constraintPlanRef = useRef<ConstraintPlan | null>(null)
  const [followTransforms, setFollowTransforms] = useState<LiveTransform[] | null>(null)

  // How far the second point has been DRAGGED, while it is being dragged. The
  // pending dimension is drawn from the hot candidate plus this — every body
  // moves by a pure translation, so the point the constraint will measure to
  // moves by exactly the drag, and the numbers on screen are the numbers that
  // will be stored.
  const [pickDrag, setPickDrag] = useState<{ dx: number; dy: number } | null>(null)
  // Ref-backed like liveTransform: mouseup reads the ref, so a release that lands before
  // React commits the last mousemove's box selects with THAT box, not the frame before.
  // `op`: a plain drag ADDS what the box catches to the selection, Shift (or Alt) at the
  // press REMOVES it. Only the region tool's box REPLACES.
  const [dragBox, dragBoxRef, setDragBox] = useRefState<{ sx: number; sy: number; ex: number; ey: number; op: 'replace' | 'add' | 'remove' } | null>(null)
  const [snapGuides, setSnapGuides] = useState<SnapGuides | null>(null)
  const [liveShapeD, setLiveShapeD] = useState<string | null>(null)
  const [altDown, altDownRef, setAltDown] = useRefState(false)
  // Shift held: state for the pen preview, ref for the move axis lock and the gestures that
  // read a key held before the press.
  const [shiftDown, shiftDownRef, setShiftDown] = useRefState(false)
  const didDragRef = useRef(false)

  const setLiveRotationAngle = useCanvasStore((s) => s.setLiveRotationAngle)
  const setLiveBBox = useCanvasStore((s) => s.setLiveBBox)

  const setMode = useCallback((m: CanvasMode) => {
    modeRef.current = m
  }, [])

  // ONE START AND ONE END FOR EVERY POINTER GESTURE (review2 A4). A press
  // starts from "not dragged yet" whatever the mode; the release (or the
  // window's fallback for a release off the canvas, below handleMouseUp) goes
  // back to idle with EVERY live preview cleared, not only the ones its own
  // mode drew. Each mode used to clear its own subset — move six things,
  // resize four, rotate three — which is exactly how a preview outlives the
  // gesture that drew it. Clearing one that is already null costs nothing.
  const beginGesture = useCallback((m: CanvasMode) => {
    didDragRef.current = false
    setMode(m)
  }, [setMode])

  const endGesture = useCallback(() => {
    setLiveTransform(null)
    setFollowTransforms(null)
    constraintPlanRef.current = null
    setLiveBBox(null)
    setLiveRotationAngle(null)
    setSnapGuides(null)
    setPickDrag(null)
    setDragBox(null)
    setLiveShapeD(null)
    setMode({ type: 'idle' })
  }, [setMode, setLiveTransform, setLiveBBox, setLiveRotationAngle, setDragBox])

  const snapCNC = useCallback((cnc: { x: number; y: number }): { x: number; y: number } => {
    const { snapEnabled } = useUIStore.getState()
    if (!snapEnabled) return cnc
    const { units, origin, widthMM, heightMM } = useWorkpieceStore.getState()
    const org = originWorldXY(origin, widthMM, heightMM)
    return snapPoint(cnc, viewportRef.current, units, org)
  }, [])

  return {
    modeRef, didDragRef, spaceHeldRef,
    altDown, altDownRef, setAltDown,
    shiftDown, shiftDownRef, setShiftDown,
    setMode, beginGesture, endGesture, snapCNC,
    liveTransform, liveTransformRef, setLiveTransform,
    constraintPlanRef, followTransforms, setFollowTransforms,
    pickDrag, setPickDrag,
    dragBox, dragBoxRef, setDragBox,
    snapGuides, setSnapGuides,
    liveShapeD, setLiveShapeD,
    setLiveBBox, setLiveRotationAngle,
  }
}

export type Gesture = ReturnType<typeof useGesture>
