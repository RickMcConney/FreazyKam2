import { useCallback, useEffect, useRef } from 'react'
import { Stage, Layer, Group, Circle } from 'react-konva'
import type Konva from 'konva'
import { useCanvasStore } from '../store/canvasStore'
import { usePathsStore, expandUserGroups } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { importFile } from '../io/importFile'
import SimulationPlayer from '../sim/SimulationPlayer'
import { CanvasHints } from './CanvasHints'
import { ConstraintLayerLive, NodeEditDimensionOverlay, PenLengthOverlay } from './CanvasOverlays'
import { ZoomControls } from './ZoomControls'
import { applyDragBox } from './dragBoxSelect'
import { BridgeLayer } from './layers/BridgeLayer'
import { ClockAnimLayer } from './layers/ClockAnimLayer'
import { ClockLinkageLayer } from './layers/ClockLinkageLayer'
import { ConstraintPickLayer } from './layers/ConstraintPickLayer'
import { CornerPickLayer } from './layers/CornerPickLayer'
import { DesignLayer } from './layers/DesignLayer'
import { DoubleSidedGuideLayer } from './layers/DoubleSidedGuideLayer'
import { EscapementAnimLayer } from './layers/EscapementAnimLayer'
import { GearAnimLayer } from './layers/GearAnimLayer'
import { GridLayer } from './layers/GridLayer'
import { HoverHighlightLayer } from './layers/HoverHighlightLayer'
import { HoldPreviewLayer } from './layers/HoldPreviewLayer'
import { MeasureLayer } from './layers/MeasureLayer'
import { NodeEditLayer } from './layers/NodeEditLayer'
import { OriginLayer } from './layers/OriginLayer'
import { PenLayer } from './layers/PenLayer'
import { SelectionLayer, SelectionHandleLayer } from './layers/SelectionLayer'
import { ShapePreviewLayer } from './layers/ShapePreviewLayer'
import { SheetLabelLayer } from './layers/SheetLabelLayer'
import { SimulationLayer } from './layers/SimulationLayer'
import { SnapGuideLayer } from './layers/SnapGuideLayer'
import { TabLayer } from './layers/TabLayer'
import { TilingLayer } from './layers/TilingLayer'
import { ToolpathLayer } from './layers/ToolpathLayer'
import { TracePreviewLayer } from './layers/TracePreviewLayer'
import { WorkpieceLayer } from './layers/WorkpieceLayer'
import { closestVisiblePath, imageUnder, onCanvas, useFlatCache } from './pathHit'
import { dragBoxEncloses } from './selectionUtils'
import { useCanvasKeys } from './useCanvasKeys'
import { useCanvasView } from './useCanvasView'
import { useClockLinkage } from './useClockLinkage'
import { useConstrainTool } from './useConstrainTool'
import { useDrillTool } from './useDrillTool'
import { useTabPlaceTool } from './useTabPlaceTool'
import { beginMoveSession, EMPTY_BBOX, MOVE_THRESHOLD_PX, useGesture } from './useGesture'
import { useMeasureTool } from './useMeasureTool'
import { useNodeEditGestures } from './useNodeEditGestures'
import { useNodeEditSession } from './useNodeEditSession'
import { useNudge } from './useNudge'
import { usePenTool } from './usePenTool'
import { useRegionPick } from './useRegionPick'
import { useSelectionInfo } from './useSelectionInfo'
import { useShapeDraw } from './useShapeDraw'
import { useTransformGestures } from './useTransformGestures'
import { screenToCNC } from './viewport'

export type { Viewport } from './viewport'

/**
 * The Konva stage and the dispatch of its pointer events. Each interaction mode is a hook of
 * its own (the use* imports above); what is left here is the part that has to see all of them
 * at once: which mode a press starts, the order a mouse move visits them, how a release ends
 * them, and the layer stack.
 */
export default function CanvasStage() {
  const selection = useSelectionInfo()
  const { selectionBBox, selectionScaleLocked, selectionSkewLocked, centreResize } = selection
  const view = useCanvasView(selection.selectionBBoxRef)
  const {
    containerRef, stageRef, size, viewport, viewportRef, setViewport,
    zoomBy, zoomToActualSize, realPx, fitToWorkpiece, handleWheel,
  } = view
  const gesture = useGesture(viewportRef)
  const {
    modeRef, didDragRef, spaceHeldRef, altDown, shiftDown, setMode, beginGesture, endGesture,
    liveTransform, constraintPlanRef, followTransforms, pickDrag,
    dragBox, dragBoxRef, setDragBox, snapGuides, setSnapGuides, liveShapeD, setLiveShapeD,
  } = gesture
  const getFlat = useFlatCache()

  // Written, never subscribed: the cursor changes on every mouse move, and a subscription
  // here re-ran this whole component each time. Whatever follows the cursor subscribes
  // for itself (ConstraintLayerLive, PenLengthOverlay).
  const setCursorMM = useCanvasStore((s) => s.setCursorMM)
  const selectPath = usePathsStore((s) => s.selectPath)
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)
  // A running mesh animation draws the whole group itself, in mesh, so the
  // group's own paths step aside for it — an escapement's wheel and anchor, or a
  // gear and the lantern it emitted.
  const meshAnimPathId = useUIStore((s) => s.meshAnimPathId)
  // The trace being re-done is hidden while its preview shows, so old and new do not overlap.
  const tracePreviewGroupId = useUIStore((s) => s.tracePreview?.groupId)
  const meshAnimGroupId = usePathsStore((s) =>
    s.paths.find((p) => p.id === meshAnimPathId)?.groupId ?? null)
  // A running CLOCK draws all its wheels itself, in mesh, so every one of its
  // groups steps aside — which is why this is a separate exclusion from the
  // single-group one above rather than another user of it.
  const clockAnimPathId = useUIStore((s) => s.clockAnimPathId)
  const clockLinkPathId = useUIStore((s) => s.clockLinkPathId)
  // Both previews draw the whole clock themselves, so its paths step aside for
  // either. One id covers both because the two modes are mutually exclusive.
  const clockAnimId = usePathsStore((s) => {
    const id = clockAnimPathId ?? clockLinkPathId
    return s.paths.find((p) => p.id === id)?.clockId ?? null
  })
  const cornerPickPathId = useUIStore((s) => s.cornerPickPathId)
  // While the Tabs form is open the tabs are what gets dragged: the resize handles sit at
  // the middle of each side, exactly where four tabs on a rectangle land, so a grab meant
  // for a tab moved a side of the part instead.
  const tabsFormActive = useUIStore((s) => s.tabsFormActive)

  const activeTool = useUIStore((s) => s.activeTool)

  const { linkAngles, hoverLinkNode, handleLinkNodeDown, onMoveClockLink, finishClockLinkDrag } = useClockLinkage(gesture)

  // Node-edit session state + local undo + commit/exit lifecycle
  const session = useNodeEditSession()
  const {
    editNodes, editClosed, hoveredEditNode, dragNodeIdx,
    hoverSegIdx, setHoverSegIdx, weldTargetIdx,
    connectSource, connectSourceRef, connectPreviewTo, connectSnapTargetIdx,
    crossPathCandidates, crossPathWeldTarget, crossPathWeldTargetRef,
    editDragInitRef, exitNodeEdit, clearConnectState,
  } = session
  const {
    livePen, penClosing, penNodes, effectiveCurveType, penSnapCursor, setPenSnapCursor,
    startPenDraw, onMovePenHover, onMovePenDraw, finishPenDraw, finishPenOnEscape,
  } = usePenTool(gesture, view, getFlat)
  const { startDrawShape, onMoveDrawShape, finishDrawShape } = useShapeDraw(gesture, viewportRef)
  const { regionPreviewD, setRegionPreviewD, onMoveRegionHover, pickRegionAt } = useRegionPick(getFlat, activeTool)
  const {
    pickCandidates, pickHot, pickHeld, allCandidatesRef,
    onMoveConstrainHover, onConstrainClick, onConstrainPress, landDraggedPoint, escapeConstrain, dropPicks,
  } = useConstrainTool(gesture, view, getFlat, activeTool)
  const {
    measureA, measureB, measureHot,
    onMoveMeasureHover, onMeasurePress, clearMeasure,
  } = useMeasureTool(view, activeTool, allCandidatesRef)
  const { pendingDrillPoints, placeDrillPoint } = useDrillTool(gesture, view, getFlat, activeTool)
  const { placeHoldAt } = useTabPlaceTool(view, getFlat)
  const {
    handleResizeHandleDown, handleRotateHandleDown,
    onMoveTranslate, onMoveResize, onMoveRotate,
    bakeMove, bakeResize, bakeRotate,
  } = useTransformGestures(gesture, view, selection)
  const {
    onDeleteKey, handleNodeMouseDown, handleSegmentMouseDown, handleHoveredNodeChange, handleStageDblClick,
    onMoveConnectPreview, onMoveNodeEditDrag, finishCrossConnect, finishNodeDrag,
  } = useNodeEditGestures(gesture, view, session, getFlat)

  useCanvasKeys(gesture, {
    onDeleteKey,
    escapeNodeEdit: () => {
      if (connectSourceRef.current !== null) clearConnectState()
      else exitNodeEdit()
    },
    finishPenOnEscape,
    clearMeasure,
    escapeConstrain,
    cancelTool: () => {
      setLiveShapeD(null)
      dropPicks()
      setMode({ type: 'idle' })
    },
  })

  // Dropped files go through the same shared import pipeline as the toolbar
  // Import button (io/importFile.ts) — all formats, same prompts and messages.
  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    for (const file of e.dataTransfer.files) importFile(file)
  }, [])

  const panStartRef = useRef({ mouseX: 0, mouseY: 0, vpX: 0, vpY: 0 })

  const handleStageMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (connectSourceRef.current !== null) {
      if (crossPathWeldTargetRef.current !== null) {
        // Snapped to a cross-path node — let mouseup complete the connection
        didDragRef.current = false
        return
      }
      clearConnectState()
    }
    if (e.evt.button === 1 || spaceHeldRef.current) {
      e.evt.preventDefault()
      const vp = viewportRef.current
      panStartRef.current = { mouseX: e.evt.clientX, mouseY: e.evt.clientY, vpX: vp.x, vpY: vp.y }
      setMode({ type: 'pan' })
      return
    }
    if (e.evt.button !== 0) return

    const { activeTool, nodeEditPathId: neid } = useUIStore.getState()

    // Pen tool — start placing a node
    if (activeTool === 'pen') {
      const stagePointer = stageRef.current?.getPointerPosition()
      if (stagePointer) startPenDraw(stagePointer)
      return
    }

    if (activeTool === 'measure') { onMeasurePress(e); return }

    // The tool owns the click while it is on: never a selection change or a drag box.
    if (activeTool === 'constrain') { onConstrainPress(); return }

    // The Tabs form's click-to-place owns the click the same way: a strip or a tab where it
    // lands, never a selection change or a drag box. (A press on a strip or tab marker never
    // gets here — those take their own presses, to drag or Alt-delete.)
    {
      const sp = stageRef.current?.getPointerPosition()
      if (sp && placeHoldAt(sp.x, sp.y)) {
        didDragRef.current = false
        setMode({ type: 'idle' })
        return
      }
    }

    // Drill tool: capture click for placement in mouseup, don't deselect or start dragbox
    if (activeTool === 'drill') {
      didDragRef.current = false
      setMode({ type: 'idle' })
      return
    }

    // Shape draw tool active
    if (activeTool !== 'select' && activeTool !== 'region') {
      const stagePointer = stageRef.current?.getPointerPosition()
      if (stagePointer) startDrawShape(stagePointer)
      return
    }

    const stagePointer = stageRef.current?.getPointerPosition()
    if (!stagePointer) return
    const vp = viewportRef.current
    const cnc = screenToCNC(stagePointer.x, stagePointer.y, vp)

    // Find the closest visible path within 8 screen pixels
    const { paths } = usePathsStore.getState()
    const candidates = paths.filter((p) => onCanvas(p) && p.id !== neid)
    const hit = closestVisiblePath(cnc.x, cnc.y, candidates, 8 / vp.scale, (p) => getFlat(p, 0.05))
      ?? (activeTool === 'select' ? imageUnder(cnc.x, cnc.y, candidates, (p) => getFlat(p, 0.05)) : null)

    if (hit) {
      if (neid && neid !== hit.id) exitNodeEdit()
      const { selectedIds: currentIds, paths: allNow } = usePathsStore.getState()
      // A user group is ONE thing to click: hitting any member takes the whole
      // group. The way back to a single path inside one is a SECOND click: a click on a
      // member of a group that is already the whole selection, which never became a drag,
      // narrows to that member on release (`narrowTo`) — so dragging the group still
      // moves the group. Alt-click does it at once, and the paths list reaches a member
      // directly; double-click is already point-edit/split.
      const hitIds = e.evt.altKey ? [hit.id] : expandUserGroups([hit.id], allNow)
      const narrowTo = activeTool === 'select' && !e.evt.shiftKey && !e.evt.altKey
        && hitIds.length > 1 && currentIds.length === hitIds.length
        && hitIds.every((id) => currentIds.includes(id))
        ? hit.id : undefined
      // Shift-drag MOVES (it is the drag lock's override), so a Shift press on a part that
      // is already selected must not take it out of the selection on the way: the rest
      // would be dragged without it. Taking it out waits for a release that never became
      // a drag (`toggleOutOnClick`). Adding an unselected part still happens on the press,
      // so the drag carries it.
      let toggleOutOnClick: string[] | undefined
      if (e.evt.shiftKey) {
        // Toggle the whole group's membership, not one path's: half a group in
        // the selection is a state no click could get back out of.
        const allIn = hitIds.every((id) => currentIds.includes(id))
        if (allIn) toggleOutOnClick = hitIds
        else usePathsStore.getState().setSelectedIds([...currentIds, ...hitIds.filter((id) => !currentIds.includes(id))])
      } else if (!currentIds.includes(hit.id)) {
        usePathsStore.getState().setSelectedIds(hitIds)
      }
      // The Tabs form edits tabs, not shapes: a press on the part selects it but never
      // moves it. Zoomed out, a press aimed at a tab lands on the outline as often as on
      // the tab, and dragged the whole part off its place.
      if (useUIStore.getState().tabsFormActive) {
        didDragRef.current = false
        setMode({ type: 'idle' })
        return
      }
      // DRAGGING LOCKED (toolbar lock, L): the press has selected, but the outline does not
      // move — handles, arrow keys and typed values still do, and Shift-drag overrides.
      // The drag draws a selection box instead, which is otherwise impossible to start on
      // a crowded nest, where every press lands on a part.
      if (useUIStore.getState().moveLocked && !e.evt.shiftKey) {
        // Always an ADDING box: Shift is the override, and Alt on a part already means
        // "just this member", so neither can ask for a removing one here.
        const op = activeTool === 'region' ? 'replace' : 'add'
        beginGesture({ type: 'dragbox', startScreen: { x: stagePointer.x, y: stagePointer.y }, onPath: { narrowTo } })
        setDragBox({ sx: stagePointer.x, sy: stagePointer.y, ex: stagePointer.x, ey: stagePointer.y, op })
        return
      }
      const moveIds = usePathsStore.getState().selectedIds
      const session = beginMoveSession(moveIds)
      constraintPlanRef.current = session.plan
      beginGesture({ type: 'move', pathIds: moveIds, startCNC: cnc, initBbox: session.bbox ?? EMPTY_BBOX, snapTargets: session.snapTargets, narrowTo, toggleOutOnClick })
    } else {
      if (neid) { exitNodeEdit(); return }
      // Region picking (on while the Pocket form is open) decides on mouseup: a
      // press that never moves picks the enclosed area under it, so the selection
      // has to survive until then — a drag is still a drag box.
      // A box always EDITS the selection it starts from — a plain drag ADDS, Shift (or Alt)
      // REMOVES — so the selection has to survive the press. A plain CLICK that never becomes
      // a drag is what clears it, on release (below); a Shift click on empty canvas does
      // nothing. The region tool keeps its own rule: replace, decided on release.
      const op = activeTool === 'region' ? 'replace' : e.evt.shiftKey || e.evt.altKey ? 'remove' : 'add'
      beginGesture({ type: 'dragbox', startScreen: { x: stagePointer.x, y: stagePointer.y } })
      setDragBox({ sx: stagePointer.x, sy: stagePointer.y, ex: stagePointer.x, ey: stagePointer.y, op })
    }
  }, [selectPath, setMode, beginGesture, startDrawShape, startPenDraw, exitNodeEdit, getFlat,
      onMeasurePress, onConstrainPress, placeHoldAt])

  // ─── per-mode mousemove handlers ──────────────────────────────────────────
  // handleMouseMove was a ~275-line chain of `if (m.type === …)` guards. Each
  // one is its own callback now; the dispatcher below keeps the ORIGINAL control
  // flow, which is not a plain switch: pan/move/resize/rotate consume the event,
  // but dragbox and drawshape deliberately fall through to the pen close-hover
  // check, and idle runs both that and the connect preview. Collapsing those
  // into returning switch cases would silently kill the pen hover indicator.
  // Each lists what IT uses. They shared one copy-pasted list of five stable
  // references that had nothing to do with any of them (review2 A4) — correct
  // only because everything in it happened to be stable, and silently stale the
  // day one of them closed over something that was not.

  const onMovePan = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    // Pan uses clientX/Y deltas — both are in screen pixels so delta is correct
    const { mouseX, mouseY, vpX, vpY } = panStartRef.current
    setViewport((v) => ({ ...v, x: vpX + (e.evt.clientX - mouseX), y: vpY + (e.evt.clientY - mouseY) }))
  }, [setViewport])

  const onMoveDragbox = useCallback((pointer: { x: number; y: number }) => {
    const db = dragBoxRef.current
    if (db) setDragBox({ ...db, ex: pointer.x, ey: pointer.y })
  }, [setDragBox])

  const moveBody = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current
    const vp = viewportRef.current

    // Stage pointer position is in Konva stage coords (same as container coords)
    const pointer = stage?.getPointerPosition()

    if (pointer) {
      setCursorMM({ x: (pointer.x - vp.x) / vp.scale, y: (vp.y - pointer.y) / vp.scale })
    }

    const m = modeRef.current

    // Pan works off screen-pixel deltas, so it runs before the CNC conversion
    // and without needing a stage pointer.
    if (m.type === 'pan') return onMovePan(e)

    if (!pointer) return
    const cncMouse = screenToCNC(pointer.x, pointer.y, vp)

    // Modes that fully consume the move.
    if (m.type === 'move')   return onMoveTranslate(m, cncMouse, pointer, vp)
    if (m.type === 'resize') return onMoveResize(m, cncMouse, e, vp)
    if (m.type === 'rotate') return onMoveRotate(m, cncMouse)

    // Modes that handle the move and then fall through to the shared checks.
    if (m.type === 'dragbox')   onMoveDragbox(pointer)
    if (m.type === 'drawshape') onMoveDrawShape(m, cncMouse, pointer, vp)

    if (m.type !== 'pendraw') onMovePenHover(cncMouse, pointer, vp)

    if (m.type === 'idle' && connectSourceRef.current !== null) onMoveConnectPreview(cncMouse, vp)
    if (useUIStore.getState().activeTool === 'constrain') { onMoveConstrainHover(cncMouse, vp); return }
    if (useUIStore.getState().activeTool === 'measure') { onMoveMeasureHover(cncMouse, vp, e.evt.shiftKey); return }
    if (useUIStore.getState().activeTool === 'region') {
      if (m.type === 'idle') onMoveRegionHover(cncMouse, vp)
      else setRegionPreviewD(null)
    }
    if (m.type === 'pendraw') onMovePenDraw(m, cncMouse, pointer, vp)
    if (m.type === 'clocklink-drag') { onMoveClockLink(m, cncMouse, e.evt.shiftKey); return }
    if (m.type === 'nodedit-drag' && editDragInitRef.current) onMoveNodeEditDrag(m, cncMouse, e)
  }, [setCursorMM, onMovePan, onMoveTranslate, onMoveResize, onMoveRotate, onMoveDragbox,
      onMoveDrawShape, onMovePenHover, onMoveConnectPreview, onMovePenDraw, onMoveNodeEditDrag,
      onMoveConstrainHover, onMoveRegionHover, onMoveMeasureHover])

  const handleMouseMove = moveBody

  const handleMouseUp = useCallback((_e: Konva.KonvaEventObject<MouseEvent>) => {
    const m = modeRef.current
    const vp = viewportRef.current

    if (finishCrossConnect(m)) return

    if (m.type === 'pan') {
      endGesture()
      return
    }

    if (m.type === 'move' && didDragRef.current) {
      bakeMove(m)
      endGesture()
      // AFTER the bake, so the constraint is measured off where the part now IS
      // — it is created holding what is already there, and what is already there
      // is the drag that has just landed. Two history entries, the move and the
      // constraint, which is what they are: the part really did move.
      if (m.pick) landDraggedPoint(m.pick)
      return
    }

    if (m.type === 'resize' && didDragRef.current) {
      bakeResize(m)
      endGesture()
      return
    }

    if (m.type === 'rotate' && didDragRef.current) {
      bakeRotate(m)
      endGesture()
      return
    }

    if (m.type === 'move' && !didDragRef.current) {
      // Pure click without drag — selection already updated on mousedown. Under
      // the Constrain tool there was no selection to update: a press that never
      // moved is the ordinary second click, and takes the point where it is.
      endGesture()
      if (m.pick) onConstrainClick()
      // The second click on a group: down to the one path under it.
      else if (m.narrowTo) usePathsStore.getState().setSelectedIds([m.narrowTo])
      // A Shift click on a part already selected: out of the selection, now that it is
      // known not to have been a drag.
      else if (m.toggleOutOnClick) {
        const out = new Set(m.toggleOutOnClick)
        const ps = usePathsStore.getState()
        ps.setSelectedIds(ps.selectedIds.filter((id) => !out.has(id)))
      }
      return
    }

    if (m.type === 'dragbox') {
      const box = dragBoxRef.current
      if (box) {
        const { sx, sy, ex, ey } = box
        if (Math.hypot(ex - sx, ey - sy) > MOVE_THRESHOLD_PX) {
          applyDragBox(box, vp)
        } else if (m.onPath) {
          // A click on a part with dragging locked: the press already selected it.
          if (m.onPath.narrowTo) usePathsStore.getState().setSelectedIds([m.onPath.narrowTo])
        } else if (box.op === 'add') {
          // A plain click on empty canvas: deselect.
          usePathsStore.getState().selectPath(null)
        } else if (useUIStore.getState().activeTool === 'region') {
          // A click off every line: pick the enclosed area there, or deselect
          // when nothing encloses it, as a click on empty canvas always does.
          const cnc = screenToCNC(sx, sy, vp)
          if (!pickRegionAt(cnc, _e.evt.shiftKey)) usePathsStore.getState().selectPath(null)
        }
      }
      endGesture()
      return
    }

    if (m.type === 'drawshape') { finishDrawShape(m); return }
    if (m.type === 'clocklink-drag') { finishClockLinkDrag(); return }
    if (m.type === 'nodedit-drag') { finishNodeDrag(m); return }
    if (m.type === 'pendraw') { finishPenDraw(m); return }

    // Drill tool: place a point on any non-drag LEFT click — right/middle
    // releases never placed a mousedown here (button !== 0 returns early), so
    // without the button check they'd inherit a stale didDragRef (bugs.md B5)
    placeDrillPoint(_e)

    setMode({ type: 'idle' })
  }, [setMode, endGesture, finishCrossConnect, bakeMove, bakeResize, bakeRotate, landDraggedPoint, onConstrainClick,
      pickRegionAt, finishDrawShape, finishClockLinkDrag, finishNodeDrag, finishPenDraw, placeDrillPoint])

useNudge(gesture)

  // A GESTURE RELEASED OFF THE CANVAS STILL ENDS. Konva only hears a mouseup on its own
  // content element, so a resize (or move, rotate, drag box, point drag…) let go over the
  // sidebar never reached handleMouseUp: the mode stayed live, the next mouse move went on
  // transforming with no button held, and the preview transform was never cleared — the
  // shape was drawn where it was not, so clicking it missed. The window hears every
  // release, including one outside the browser (the browser keeps delivering to the page
  // that saw the press). A release ON the canvas reaches the stage first, on the way up to
  // the window, and every branch of handleMouseUp leaves the mode idle — so this only ever
  // runs for the releases the stage missed. Losing focus mid-drag (Alt+Tab) has no mouseup
  // at all and ends the gesture the same way.
  const handleMouseUpRef = useRef(handleMouseUp)
  handleMouseUpRef.current = handleMouseUp
  useEffect(() => {
    const finish = (evt: MouseEvent) => {
      if (modeRef.current.type === 'idle') return
      handleMouseUpRef.current({ evt } as unknown as Konva.KonvaEventObject<MouseEvent>)
    }
    const onBlur = () => finish(new MouseEvent('mouseup'))
    window.addEventListener('mouseup', finish)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mouseup', finish)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const getCursor = () => {
    if (nodeEditPathId) return 'default'
    if (activeTool === 'drill') return 'crosshair'
    if (activeTool === 'pen') return 'crosshair'
    if (activeTool !== 'select' && activeTool !== 'region') return 'crosshair'
    switch (modeRef.current.type) {
      case 'pan': return 'grabbing'
      case 'move': return 'move'
      case 'resize': return 'crosshair'
      case 'rotate': return 'crosshair'
      case 'dragbox': return 'crosshair'
      default: return spaceHeldRef.current ? 'grab' : 'default'
    }
  }

  // dragBox coords are in Konva stage space = container-relative pixels, no offset needed
  const dragBoxStyle = dragBox ? {
    left: Math.min(dragBox.sx, dragBox.ex),
    top: Math.min(dragBox.sy, dragBox.ey),
    width: Math.abs(dragBox.ex - dragBox.sx),
    height: Math.abs(dragBox.ey - dragBox.sy),
  } : null

  return (
    <div
      ref={containerRef}
      data-testid="canvas-stage"
      className="w-full h-full relative overflow-hidden select-none"
      style={{ cursor: getCursor() }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleCanvasDrop}
    >
      {size.width > 0 && size.height > 0 && <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        onWheel={handleWheel}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          setCursorMM(null)
          setPenSnapCursor(null)
          if (modeRef.current.type === 'idle') setSnapGuides(null)
        }}
        onDblClick={handleStageDblClick}
      >
        {/* Layer 1: All CNC-space content (Y-flipped). Groups render in z-order within this single canvas. */}
        <Layer x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={-viewport.scale}>
          <WorkpieceLayer viewport={viewport} />
          <GridLayer viewport={viewport} stageWidth={size.width} stageHeight={size.height} />
          <DoubleSidedGuideLayer viewport={viewport} />
          <DesignLayer
            viewport={viewport}
            liveTransform={liveTransform}
            followTransforms={followTransforms}
            excludePathId={nodeEditPathId}
            excludeGroupId={meshAnimGroupId ?? tracePreviewGroupId}
            excludeClockId={clockAnimId}
          />
          {nodeEditPathId && (
            <NodeEditLayer
              viewport={viewport}
              nodes={editNodes}
              closed={editClosed}
              hoveredNodeIdx={hoveredEditNode}
              spaceHeldRef={spaceHeldRef}
              onNodeMouseDown={handleNodeMouseDown}
              onSegmentMouseDown={handleSegmentMouseDown}
              onHoveredNodeChange={handleHoveredNodeChange}
              onHoverSegChange={(idx) => setHoverSegIdx(idx)}
              weldTargetIdx={weldTargetIdx}
              crossPathCandidates={crossPathCandidates}
              crossPathWeldTarget={crossPathWeldTarget}
              connectSourceIdx={connectSource}
              connectPreviewTo={connectPreviewTo}
              connectSnapTargetIdx={connectSnapTargetIdx}
            />
          )}
          <ToolpathLayer viewport={viewport} />
          <BridgeLayer viewport={viewport} />
          <TabLayer viewport={viewport} />
          <ShapePreviewLayer viewport={viewport} d={liveShapeD} />
          <TracePreviewLayer viewport={viewport} />
          {activeTool === 'region' && <ShapePreviewLayer viewport={viewport} d={regionPreviewD} />}
          <EscapementAnimLayer viewport={viewport} />
          <GearAnimLayer viewport={viewport} />
          <ClockAnimLayer viewport={viewport} />
          {clockLinkPathId && (
            <ClockLinkageLayer
              viewport={viewport}
              liveAngles={linkAngles}
              onNodeMouseDown={handleLinkNodeDown}
              activeNode={hoverLinkNode}
            />
          )}
          <CornerPickLayer viewport={viewport} />
          {activeTool === 'constrain' && (
            <ConstraintPickLayer
              viewport={viewport}
              candidates={pickCandidates}
              hot={pickHot}
              held={pickHeld}
              drag={pickDrag}
            />
          )}
          {activeTool === 'pen' && (
            <PenLayer
              viewport={viewport}
              penNodes={penClosing && (altDown || shiftDown) && penNodes.length >= 1
                ? [{ ...penNodes[0], corner: true }, ...penNodes.slice(1)]
                : penNodes}
              livePen={livePen}
              penClosing={penClosing}
              curveType={effectiveCurveType}
              snappedCursor={penSnapCursor}
            />
          )}
          {activeTool === 'drill' && pendingDrillPoints.length > 0 && (
            <Group listening={false}>
              {pendingDrillPoints.map((pt, i) => (
                <Circle
                  key={i}
                  x={pt.x}
                  y={pt.y}
                  radius={3 / viewport.scale}
                  fill="#f97316"
                  stroke="#ffffff"
                  strokeWidth={1 / viewport.scale}
                  listening={false}
                />
              ))}
            </Group>
          )}
        </Layer>

        {/* Layer 2: The 2D simulation, on a canvas of its own. It changes every frame of a
            playback, and on layer 1 that repainted every path and toolpath of the drawing
            sixty times a second to move one tool marker — on a nest of thousands of parts
            the whole cost of a 2D sim. Drawn above everything in layer 1, so the previews
            that sat after it there (shape, trace, pen, drill points) now sit under it. */}
        <Layer x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={-viewport.scale} listening={false}>
          <SimulationLayer viewport={viewport} />
          {/* Over the sim, for the same reason it has this layer: it changes as fast as
              the pointer runs down the Toolpaths list, and on layer 1 every change would
              repaint the whole drawing. */}
          <HoverHighlightLayer viewport={viewport} />
          <HoldPreviewLayer />
        </Layer>

        {/* Layer 3: Screen-space overlay — origin indicator, selection outline, rulers. */}
        <Layer listening={false}>
          <OriginLayer viewport={viewport} />
          <SheetLabelLayer viewport={viewport} />
          {/* COMMITTED DIMENSIONS ARE HIDDEN WHILE ANYTHING IS BEING DRAGGED. One
              is drawn from the baked `d`, which does not change until mouse-up,
              so mid-drag it would hang behind at the old positions while the
              geometry moves out from under it. Re-deriving it every frame is the
              one thing not to do here: resolving a constraint's ends means
              re-flattening every path of every body it touches, which is the
              cost the plan/run split exists to keep out of the pointer path (see
              store/constraints.ts). The parts are what the user is looking at
              during a drag; the numbers come back the moment it lands.

              THE ONE BEING MADE IS THE EXCEPTION, and it is exactly the case
              that pays for itself: its two ends are known points translating
              rigidly, so it costs two additions a frame and it is the only thing
              telling the user what the offset they are dragging out actually
              is. */}
          <ConstraintLayerLive viewport={viewport} hideCommitted={!!liveTransform} held={pickHeld} hot={pickHot} drag={pickDrag} />
          {!nodeEditPathId && !cornerPickPathId && activeTool !== 'constrain' && selectionBBox && (
            <SelectionLayer
              viewport={viewport}
              bbox={selectionBBox}
              liveTransform={liveTransform}
              noRotate={tabsFormActive}
            />
          )}
          {activeTool === 'measure' && (
            <MeasureLayer viewport={viewport} a={measureA} b={measureB} hot={measureHot} />
          )}
          {snapGuides && (
            <SnapGuideLayer viewport={viewport} guides={snapGuides} width={size.width} height={size.height} />
          )}
        </Layer>

        {/* Layer 4: Interactive handles — selection resize/rotate circles, and a tiled
            job's seams (dragged along the slide axis). */}
        <Layer>
          <TilingLayer viewport={viewport} />
          {!nodeEditPathId && !cornerPickPathId && !tabsFormActive && activeTool !== 'constrain' && selectionBBox && (
            <SelectionHandleLayer
              viewport={viewport}
              bbox={selectionBBox}
              liveTransform={liveTransform}
              onResizeHandleDown={handleResizeHandleDown}
              onRotateHandleDown={handleRotateHandleDown}
              scaleLocked={selectionScaleLocked}
            />
          )}
        </Layer>
      </Stage>}


      {/* Drag-box selection overlay. SOLID means the box takes only what it wholly
          contains, DASHED that touching is enough — the CAD convention, and the
          only thing on screen that says which of the two a drag is going to do. */}
      {dragBox && dragBoxStyle && (
        <div
          className={`absolute border pointer-events-none ${
            dragBox.op === 'remove' ? 'border-red-400 bg-red-400/10' : 'border-blue-400 bg-blue-400/10'} ${
            dragBoxEncloses(dragBox) ? '' : 'border-dashed'}`}
          style={dragBoxStyle}
        />
      )}

      <PenLengthOverlay viewport={viewport} draggingHandle={livePen !== null} snappedCursor={penSnapCursor} />
      <NodeEditDimensionOverlay viewport={viewport} nodes={editNodes} closed={editClosed} dragNodeIdx={dragNodeIdx} hoverSegIdx={hoverSegIdx} />

      <CanvasHints
        connecting={connectSource !== null}
        hoveredEditNode={hoveredEditNode}
        hoverSegIdx={hoverSegIdx}
        penClosing={penClosing}
        pickHeld={pickHeld}
        centreResize={centreResize}
        skewLocked={selectionSkewLocked}
      />

      <SimulationPlayer />

      <ZoomControls zoomBy={zoomBy} fitToWorkpiece={fitToWorkpiece} zoomToActualSize={zoomToActualSize} realPx={realPx} />
    </div>
  )
}
