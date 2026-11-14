import { useCallback } from 'react'
import type Konva from 'konva'
import { collectSnapTargets, equalSpacingSnap, snapAxisDelta } from './objectSnap'
import { runPlan } from '../store/constraints'
import { bakePathsStep, usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { onCanvas } from './pathHit'
import type { HandleType } from './types'
import type { CanvasView } from './useCanvasView'
import { MOVE_THRESHOLD_PX, OBJECT_SNAP_PX, snapOptions, type CanvasMode, type Gesture } from './useGesture'
import type { useSelectionInfo } from './useSelectionInfo'
import { edgeSkew } from './edgeSkew'
import { screenToCNC, snapPoint, type Viewport } from './viewport'

/** Moving, resizing, skewing and rotating the selection: press, live preview, bake. */
export function useTransformGestures(
  g: Gesture,
  { viewportRef }: CanvasView,
  { selectionBBoxRef, selectionScaleLockedRef, selectionSkewLockedRef, centreResizeRef }: ReturnType<typeof useSelectionInfo>,
) {
  const {
    didDragRef, altDownRef, shiftDownRef, constraintPlanRef, liveTransformRef,
    beginGesture, snapCNC, setLiveTransform, setFollowTransforms, setSnapGuides, setPickDrag,
    setLiveBBox, setLiveRotationAngle,
  } = g

  // Called by SelectionLayer resize handles
  const handleResizeHandleDown = useCallback((handle: HandleType, e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return

    // Handles only exist for the rendered selection, so the memoized bbox is current.
    const { selectedIds: ids } = usePathsStore.getState()
    const bbox = selectionBBoxRef.current
    if (!bbox) return
    // Belt-and-braces: the handles are not drawn for a scale-locked selection,
    // so this is unreachable through the UI — but a scale is one of the
    // gestures that silently changes what a mechanism IS, so it is refused
    // here as well rather than trusted to stay unreachable.
    if (selectionScaleLockedRef.current) return

    const { minX, minY, maxX, maxY, cx, cy } = bbox
    const midX = cx, midY = cy

    // Anchor = opposite corner/edge in CNC space
    const anchorMap: Record<HandleType, { x: number; y: number }> = {
      tl: { x: maxX, y: minY }, tr: { x: minX, y: minY },
      bl: { x: maxX, y: maxY }, br: { x: minX, y: maxY },
      t:  { x: midX, y: minY }, b:  { x: midX, y: maxY },
      l:  { x: maxX, y: midY }, r:  { x: minX, y: midY },
    }
    const handlePosMap: Record<HandleType, { x: number; y: number }> = {
      tl: { x: minX, y: maxY }, tr: { x: maxX, y: maxY },
      bl: { x: minX, y: minY }, br: { x: maxX, y: minY },
      t:  { x: midX, y: maxY }, b:  { x: midX, y: minY },
      l:  { x: minX, y: midY }, r:  { x: maxX, y: midY },
    }

    const allPaths = usePathsStore.getState().paths
    const { widthMM, heightMM } = useWorkpieceStore.getState()
    const snapTargets = collectSnapTargets(allPaths.filter(p => onCanvas(p) && !ids.includes(p.id)), { widthMM, heightMM }, snapOptions())
    const pointer = e.target.getStage()?.getPointerPosition()
    const pressCNC = pointer ? screenToCNC(pointer.x, pointer.y, viewportRef.current) : handlePosMap[handle]

    beginGesture({
      type: 'resize',
      pathIds: ids,
      handle,
      // The whole scale is measured from the anchor (see onMoveResize), so
      // "from centre" is just a different anchor — corner handles, edge handles
      // and Shift-skew all follow with no other change. Off, the opposite corner
      // stays put; on, the shape grows both ways about its middle, which keeps a
      // resized ring concentric with what it was cut around.
      //
      // It is the OBJECT's own parameter that decides (see ShapeParams.fromCenter),
      // not a tool setting, so a shape drawn that way goes on resizing that way
      // and it can be changed from the shape's own panel. ANY flagged path in the
      // selection is enough: scaling the group about its middle is the only
      // reading of "centred" that a mixed selection has.
      anchor: centreResizeRef.current ? { x: cx, y: cy } : anchorMap[handle],
      initHandle: handlePosMap[handle],
      // Where the press landed, which a shear is measured from (see edgeSkew).
      startCNC: pressCNC,
      initBbox: bbox,
      shiftHeld: e.evt.shiftKey,
      snapTargets,
    })
  }, [beginGesture])

  // Called by SelectionLayer rotation handle
  const handleRotateHandleDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return

    const vp = viewportRef.current
    const { selectedIds: ids } = usePathsStore.getState()
    const bbox = selectionBBoxRef.current
    if (!bbox) return

    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const cncMouse = screenToCNC(pointer.x, pointer.y, vp)
    const initAngle = Math.atan2(cncMouse.y - bbox.cy, cncMouse.x - bbox.cx) * 180 / Math.PI

    beginGesture({ type: 'rotate', pathIds: ids, center: { x: bbox.cx, y: bbox.cy }, initAngle })
  }, [beginGesture])

  const onMoveTranslate = useCallback((m: Extract<CanvasMode, { type: 'move' }>, cncMouse: { x: number; y: number }, pointer: { x: number; y: number }, vp: Viewport) => {
    const dx = cncMouse.x - m.startCNC.x
    const dy = cncMouse.y - m.startCNC.y
    // Threshold check in stage pixels
    const startScreenX = vp.x + m.startCNC.x * vp.scale
    const startScreenY = vp.y - m.startCNC.y * vp.scale
    if (Math.hypot(pointer.x - startScreenX, pointer.y - startScreenY) > MOVE_THRESHOLD_PX) {
      didDragRef.current = true
    }
    if (didDragRef.current) {
      let finalDx = dx, finalDy = dy
      // Shift-drag is the drag lock's override on the select tool, so the axis lock it
      // used to give is kept only for the Constrain tool's point drag.
      if (m.pick && shiftDownRef.current) {
        if (Math.abs(dx) > Math.abs(dy)) finalDy = 0
        else finalDx = 0
      }
      // Object snap first (bbox edges/centers to other shapes' edges/centers),
      // then grid snap only on the axes that didn't object-snap.
      const ib = m.initBbox
      const snapOn = useUIStore.getState().snapEnabled
      const tolMM = OBJECT_SNAP_PX / vp.scale
      let ox = snapOn ? snapAxisDelta([ib.minX + finalDx, ib.maxX + finalDx, ib.cx + finalDx], m.snapTargets.xs, tolMM) : null
      let oy = snapOn ? snapAxisDelta([ib.minY + finalDy, ib.maxY + finalDy, ib.cy + finalDy], m.snapTargets.ys, tolMM) : null
      // Equal spacing competes with alignment on each axis, and the nearer one wins —
      // both are measured from where the cursor has the box, before either is applied.
      const at = { minX: ib.minX + finalDx, maxX: ib.maxX + finalDx, minY: ib.minY + finalDy, maxY: ib.maxY + finalDy }
      const ex = snapOn ? equalSpacingSnap(at, m.snapTargets.boxes, 'x', tolMM) : null
      const ey = snapOn ? equalSpacingSnap(at, m.snapTargets.boxes, 'y', tolMM) : null
      const useEx = !!ex && (!ox || ex.dist < Math.abs(ox.correction) - 1e-9)
      const useEy = !!ey && (!oy || ey.dist < Math.abs(oy.correction) - 1e-9)
      if (useEx) ox = null
      if (useEy) oy = null
      if (ox) finalDx += ox.correction
      if (oy) finalDy += oy.correction
      if (useEx) finalDx += ex!.correction
      if (useEy) finalDy += ey!.correction
      const gridSnapped = snapCNC({ x: ib.minX + finalDx, y: ib.minY + finalDy })
      if (!ox && !useEx) finalDx = gridSnapped.x - ib.minX
      if (!oy && !useEy) finalDy = gridSnapped.y - ib.minY
      const gaps = [...(useEx ? ex!.marks : []), ...(useEy ? ey!.marks : [])]
      setSnapGuides(ox || oy || gaps.length > 0
        ? { x: ox?.guide, y: oy?.guide, ...(gaps.length > 0 ? { gaps } : {}) }
        : null)
      setLiveTransform({ kind: 'translate', pathIds: new Set(m.pathIds), dx: finalDx, dy: finalDy })
      setLiveBBox({ minX: ib.minX + finalDx, minY: ib.minY + finalDy, width: ib.width, height: ib.height })
      // The Constrain tool's second point riding along: the dimension being made
      // is redrawn from this, so the numbers on it are the ones mouseup stores.
      if (m.pick) setPickDrag({ dx: finalDx, dy: finalDy })
      // Everything the constraints carry along, previewed with the drag. The
      // dragged bodies are in here too — a part pinned to a stock edge is
      // CORRECTED by its constraint rather than following the cursor, and the
      // preview has to show that or the part jumps on mouse-up.
      // A move-drag turns nothing, so `mv.rotDeg` is absent on every move it can
      // produce (a follower only turns when the part holding it CHANGES ANGLE,
      // and a translation cannot) — which is why one transform per body is
      // enough here, DesignLayer taking the first that matches a path.
      const plan = constraintPlanRef.current
      setFollowTransforms(plan
        ? runPlan(plan, { dx: finalDx, dy: finalDy }).map((mv) => ({
          kind: 'translate' as const, pathIds: new Set(mv.pathIds), dx: mv.dx, dy: mv.dy,
        }))
        : null)
    }
  }, [snapCNC, setLiveTransform, setLiveBBox])

  const onMoveResize = useCallback((m: Extract<CanvasMode, { type: 'resize' }>, cncMouse: { x: number; y: number }, e: Konva.KonvaEventObject<MouseEvent>, vp: Viewport) => {
    didDragRef.current = true
    const { anchor, initHandle, pathIds, handle, shiftHeld } = m
    const isCorner = handle === 'tl' || handle === 'tr' || handle === 'bl' || handle === 'br'
    // Shift on an EDGE handle shears along that edge; Shift on a corner is the uniform scale
    // below, so the two never compete. Alt is kept as an alias for the edge shear only —
    // some Linux window managers never pass Alt+drag to the page. An image refuses skew
    // (see selectionSkewLocked); the edge handle then just scales.
    const skewKey = shiftDownRef.current || e.evt.shiftKey || altDownRef.current || e.evt.altKey
    const skewing = skewKey && !isCorner && !selectionSkewLockedRef.current

    // The dragged handle IS the moving edge/corner of the bbox (the anchor is the
    // opposite one and stays put), so object-snapping the handle position aligns
    // those edges to other shapes' edges/centers — same targets and guides as a
    // drag. Grid snap then applies only on the axes that didn't object-snap.
    // Uniform (Shift) scaling and Shift-skew derive both axes from one combined
    // gesture, so a per-axis snap would draw a guide the shape never lands on:
    // those keep plain grid snap and no guides.
    // A shear takes the whole branch below: it snaps its MOVEMENT (see edgeSkew), not the pointer.
    if (skewing) {
      const { units } = useWorkpieceStore.getState()
      const snap = useUIStore.getState().snapEnabled
      const { kx, ky } = edgeSkew(handle, anchor, initHandle, m.startCNC, cncMouse,
        (d) => snap ? snapPoint({ x: d, y: d }, vp, units, { x: 0, y: 0 }).x : d)
      setSnapGuides(null)
      setLiveTransform({ kind: 'skew', pathIds: new Set(pathIds), kx, ky, ax: anchor.x, ay: anchor.y })
      return
    }

    const snapOn = useUIStore.getState().snapEnabled && !(shiftHeld && isCorner)
    const tolMM = OBJECT_SNAP_PX / vp.scale
    // Edge handles only move one axis; the other is the bbox mid-line and must not snap.
    const ox = snapOn && handle !== 't' && handle !== 'b' ? snapAxisDelta([cncMouse.x], m.snapTargets.xs, tolMM) : null
    const oy = snapOn && handle !== 'l' && handle !== 'r' ? snapAxisDelta([cncMouse.y], m.snapTargets.ys, tolMM) : null
    const gridSnapped = snapCNC(cncMouse)
    const snappedMouse = {
      x: ox ? cncMouse.x + ox.correction : gridSnapped.x,
      y: oy ? cncMouse.y + oy.correction : gridSnapped.y,
    }
    setSnapGuides(ox || oy ? { x: ox?.guide, y: oy?.guide } : null)

    const dhx = initHandle.x - anchor.x
    const dhy = initHandle.y - anchor.y
    const newHx = snappedMouse.x - anchor.x
    const newHy = snappedMouse.y - anchor.y

    let sx = dhx !== 0 ? newHx / dhx : 1
    let sy = dhy !== 0 ? newHy / dhy : 1

    // Edge handles constrain one axis
    if (handle === 't' || handle === 'b') sx = 1
    if (handle === 'l' || handle === 'r') sy = 1

    // Uniform scale for corners with Shift
    if (shiftHeld && !['t','b','l','r'].includes(handle)) {
      const s = Math.sign(sx) * Math.hypot(newHx, newHy) / Math.hypot(dhx, dhy)
      sx = s; sy = Math.sign(sy) * Math.abs(s)
    }

    // Prevent degenerate scales
    if (Math.abs(sx) < 0.001) sx = Math.sign(sx) * 0.001
    if (Math.abs(sy) < 0.001) sy = Math.sign(sy) * 0.001

    setLiveTransform({ kind: 'scale', pathIds: new Set(pathIds), sx, sy, ax: anchor.x, ay: anchor.y })
    const ib = m.initBbox
    const x1 = anchor.x + (ib.minX - anchor.x) * sx, x2 = anchor.x + (ib.maxX - anchor.x) * sx
    const y1 = anchor.y + (ib.minY - anchor.y) * sy, y2 = anchor.y + (ib.maxY - anchor.y) * sy
    setLiveBBox({ minX: Math.min(x1, x2), minY: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) })
  }, [snapCNC, setLiveTransform, setLiveBBox])

  const onMoveRotate = useCallback((m: Extract<CanvasMode, { type: 'rotate' }>, cncMouse: { x: number; y: number }) => {
    didDragRef.current = true
    const currentAngle = Math.atan2(cncMouse.y - m.center.y, cncMouse.x - m.center.x) * 180 / Math.PI
    let delta = currentAngle - m.initAngle
    if (useUIStore.getState().snapEnabled) delta = Math.round(delta / 5) * 5
    setLiveTransform({ kind: 'rotate', pathIds: new Set(m.pathIds), angle: delta, cx: m.center.x, cy: m.center.y })
    setLiveRotationAngle(delta)
  }, [setLiveTransform, setLiveRotationAngle])

  // A released drag becomes the document. Read from the ref, not from state: a mouseup that
  // lands before React commits the last mousemove still bakes the final transform.
  const bakeMove = useCallback((m: Extract<CanvasMode, { type: 'move' }>) => {
    const lt = liveTransformRef.current
    if (lt && lt.kind === 'translate') {
      const { dx, dy } = lt
      // A drag that snapped back to where it began changes nothing, so it records
      // nothing and regenerates nothing (see isIdentityStep).
      // Only the DRAGGED paths are baked. What the constraints carried along
      // was a preview of the solve, and the solve itself runs inside
      // applyPathEdit against the geometry as it will BE — baking the preview
      // here as well would move those bodies twice.
      bakePathsStep(m.pathIds, { kind: 'translate', dx, dy }, 'move')
    }
  }, [liveTransformRef])

  const bakeResize = useCallback((m: Extract<CanvasMode, { type: 'resize' }>) => {
    const lt = liveTransformRef.current
    if (lt && lt.kind === 'scale') {
      const { sx, sy, ax, ay } = lt
      bakePathsStep(m.pathIds, { kind: 'scale', sx, sy, ax, ay }, 'scale')
    } else if (lt && lt.kind === 'skew') {
      const { kx, ky, ax, ay } = lt
      bakePathsStep(m.pathIds, { kind: 'skew', kx, ky, ax, ay }, 'skew')
    }
  }, [liveTransformRef])

  const bakeRotate = useCallback((m: Extract<CanvasMode, { type: 'rotate' }>) => {
    const lt = liveTransformRef.current
    if (lt && lt.kind === 'rotate') {
      const { angle, cx, cy } = lt
      bakePathsStep(m.pathIds, { kind: 'rotate', angle, cx, cy }, 'rotate')
    }
  }, [liveTransformRef])

  return {
    handleResizeHandleDown, handleRotateHandleDown,
    onMoveTranslate, onMoveResize, onMoveRotate,
    bakeMove, bakeResize, bakeRotate,
  }
}
