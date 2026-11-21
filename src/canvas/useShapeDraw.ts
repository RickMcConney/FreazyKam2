import { useCallback, useEffect, useRef } from 'react'
import { placeShape } from '../shapes/placeShape'
import { startShapeDefaultsSync } from '../shapes/shapeDefaults'
import {
  generateShapeD,
  SCALE_LOCKED_SHAPES,
  shapeParamsFromConfig,
  shapeParamsFromDrag,
  type ShapeType,
} from '../shapes/shapeGenerators'
import { useUIStore } from '../store/uiStore'
import { useCanvasStore } from '../store/canvasStore'

import { MOVE_THRESHOLD_PX, type CanvasMode, type Gesture } from './useGesture'
import { guideSetter, placeByAnchor } from './placementSnap'
import type { SnapGuides } from './layers/SnapGuideLayer'
import { NON_SHAPE_TOOLS, originShape } from './layers/ShapeHoverPreview'
import { isSlippedClick } from './gestureMath'
import { screenToCNC, type Viewport } from './viewport'

/** The shape tools: drag one out, or click to place one at its default size. */
export function useShapeDraw(g: Gesture, viewportRef: { current: Viewport }) {
  const { modeRef, didDragRef, beginGesture, endGesture, snapCNC, setLiveShape, setSnapGuides } = g
  // A tool change (incl. exit via Escape) takes the hover preview and its guides with it.
  useEffect(() => useUIStore.subscribe((s, prev) => {
    if (s.activeTool !== prev.activeTool) {
      useCanvasStore.getState().setShapeHoverAt(null)
      // The hover's guides go with it — nothing else clears them while idle.
      guidesRef.current.clear()
    }
  }), [])

  // WHERE A CLICK LANDS: the shape — generated at the origin, so the offset IS its
  // position — snapped as a drag of a placed shape snaps (placementSnap), corners and
  // guides and all, the grid taking its origin, which is where a click centres it.
  const placeAt = (raw: { x: number; y: number }): { at: { x: number; y: number }; guides: SnapGuides | null } => {
    const { activeTool, shapeToolConfig } = useUIStore.getState()
    const o = originShape(activeTool, shapeToolConfig)
    if (!o) return { at: snapCNC(raw), guides: null }
    const r = placeByAnchor(o.bbox, o.vertices, { x: 0, y: 0 }, raw, viewportRef.current, snapCNC)
    return { at: r.offset, guides: r.guides }
  }
  const guidesRef = useRef(guideSetter(setSnapGuides))
  const showGuides = (gd: SnapGuides | null) => guidesRef.current.show(gd)

  // The hover preview's position (ShapeHoverPreview): where a click would centre the
  // shape, object-snapped with guides. Only while idle — a press takes over with the
  // drag preview.
  const onMoveShapeHover = useCallback((cncMouse: { x: number; y: number }) => {
    if (NON_SHAPE_TOOLS.has(useUIStore.getState().activeTool)) {
      useCanvasStore.getState().setShapeHoverAt(null)
      return
    }
    const { at, guides } = placeAt(cncMouse)
    useCanvasStore.getState().setShapeHoverAt(at)
    showGuides(guides)
  }, [snapCNC])

  // The selected shape is the default for the next of its type (shapes/shapeDefaults).
  useEffect(() => startShapeDefaultsSync(), [])

  // Start drawing a shape from the given CNC point (used by both stage and path mousedown when shape tool active)
  // When the press went down, for telling a slipped click from a drag (isSlippedClick).
  const pressedAtRef = useRef(0)
  // Where a CLICK of this press would centre the shape — the hover preview's snapped
  // spot, worked out for the press point, so the shape lands where it was shown.
  const clickAtRef = useRef({ x: 0, y: 0 })
  const startDrawShape = useCallback((pointer: { x: number; y: number }) => {
    pressedAtRef.current = performance.now()
    useCanvasStore.getState().setShapeHoverAt(null)
    const vp = viewportRef.current
    const raw = screenToCNC(pointer.x, pointer.y, vp)
    clickAtRef.current = placeAt(raw).at
    const cnc = snapCNC(raw)
    beginGesture({ type: 'drawshape', startCNC: cnc, currentCNC: cnc })
  }, [beginGesture, snapCNC])

  const onMoveDrawShape = useCallback((m: Extract<CanvasMode, { type: 'drawshape' }>, cncMouse: { x: number; y: number }, pointer: { x: number; y: number }, vp: Viewport) => {
    const startScreenX = vp.x + m.startCNC.x * vp.scale
    const startScreenY = vp.y - m.startCNC.y * vp.scale
    if (Math.hypot(pointer.x - startScreenX, pointer.y - startScreenY) > MOVE_THRESHOLD_PX) {
      didDragRef.current = true
    }
    // A scale-locked shape's drag only MOVES it, so it snaps as the hover does, guides
    // and all; anything else is being sized, and its corner takes the plain grid.
    const locked = SCALE_LOCKED_SHAPES.has(useUIStore.getState().activeTool as ShapeType)
    let snappedCNC = snapCNC(cncMouse)
    if (locked) {
      const p = placeAt(cncMouse)
      snappedCNC = p.at
      if (didDragRef.current) showGuides(p.guides)
    } else showGuides(null)
    // Update currentCNC in the mode ref (no state re-render needed — liveShape handles rendering)
    modeRef.current = { ...m, currentCNC: snappedCNC }

    if (didDragRef.current) {
      const { activeTool, shapeToolConfig, shapeFromCenter } = useUIStore.getState()
      if (activeTool !== 'select') {
        const type = activeTool as ShapeType
        // A mechanism sized by its own parameters ignores the drag's SIZE but
        // not its destination: it previews at full size under the cursor and
        // lands where the drag is released. Sizing it by how far the cursor
        // travelled would be the same nonsense the resize handles refuse (see
        // SCALE_LOCKED_SHAPES): a gear dragged to m4.37 meshes with nothing.
        const params = SCALE_LOCKED_SHAPES.has(type)
          ? shapeParamsFromConfig(type, snappedCNC.x, snappedCNC.y, shapeToolConfig)
          : shapeParamsFromDrag(type, m.startCNC, snappedCNC, shapeToolConfig, shapeFromCenter)
        setLiveShape({ d: generateShapeD(params), params })
      }
    }
  }, [snapCNC])

  const finishDrawShape = useCallback((m: Extract<CanvasMode, { type: 'drawshape' }>) => {
    endGesture()
    guidesRef.current.forget()   // endGesture cleared them

    const { activeTool, shapeToolConfig, shapeFromCenter } = useUIStore.getState()
    if (activeTool !== 'select') {
      const shapeType = activeTool as ShapeType
      // For a scale-locked shape a drag IS a click: there is no size to drag
      // out, so it places one at the mousedown point and exits to select, the
      // same as a click does. Nothing here special-cases it beyond this line —
      // the placement follows.
      // A press that moved past the drag threshold but was released quickly and
      // close by is a click whose hand slipped: it places the default shape
      // rather than a sliver a few px across.
      const vp = viewportRef.current
      const slipped = isSlippedClick(performance.now() - pressedAtRef.current,
        Math.hypot(m.currentCNC.x - m.startCNC.x, m.currentCNC.y - m.startCNC.y) * vp.scale)
      const dragged = didDragRef.current && !slipped && !SCALE_LOCKED_SHAPES.has(shapeType)

      // ENDING THE TOOL is Esc, the tool's own button or any other tool — never a
      // click. Every placement, click or drag, keeps the tool on, so a shape selected
      // as the template (the selected shape IS the default — see shapes/shapeDefaults)
      // can be clicked out as many times as wanted. (A click straight after a drag
      // used to exit instead; it read as a click that did nothing.)

      // Where it lands: normally the mousedown point, but a scale-locked shape
      // follows the cursor and drops where it was released — the drag chooses
      // its position even though it cannot choose its size. For a plain click
      // the two are the same point (currentCNC starts as startCNC).
      // A click lands where the hover preview showed it (clickAtRef, object-snapped).
      const at = SCALE_LOCKED_SHAPES.has(shapeType) && didDragRef.current ? m.currentCNC : clickAtRef.current
      const params = dragged
        ? shapeParamsFromDrag(shapeType, m.startCNC, m.currentCNC, shapeToolConfig, shapeFromCenter)
        : shapeParamsFromConfig(shapeType, at.x, at.y, shapeToolConfig)

      placeShape(params, { fromCenter: shapeFromCenter })
    }
  }, [endGesture])

  return { startDrawShape, onMoveDrawShape, finishDrawShape, onMoveShapeHover }
}
