import { useCallback, useEffect, useRef } from 'react'
import { placeShape } from '../shapes/placeShape'
import {
  generateShapeD,
  SCALE_LOCKED_SHAPES,
  shapeParamsFromConfig,
  shapeParamsFromDrag,
  type ShapeType,
} from '../shapes/shapeGenerators'
import { useUIStore } from '../store/uiStore'
import { MOVE_THRESHOLD_PX, type CanvasMode, type Gesture } from './useGesture'
import { screenToCNC, type Viewport } from './viewport'

/** The shape tools: drag one out, or click to place one at its default size. */
export function useShapeDraw(g: Gesture, viewportRef: { current: Viewport }) {
  const { modeRef, didDragRef, beginGesture, endGesture, snapCNC, setLiveShapeD } = g
  // Tracks the active shape-tool session: once the user has dragged out at least
  // one shape, the tool stays selected for more drags and a subsequent click
  // (no drag) exits to select mode instead of placing another shape.
  const shapeDragSessionRef = useRef<{ tool: string | null; dragged: boolean }>({ tool: null, dragged: false })

  // Reset the shape-drag session whenever the active tool changes (incl. exit
  // via Escape or re-activating the same shape) so a fresh session starts clean.
  useEffect(() => useUIStore.subscribe((s, prev) => {
    if (s.activeTool !== prev.activeTool) shapeDragSessionRef.current = { tool: null, dragged: false }
  }), [])

  // Start drawing a shape from the given CNC point (used by both stage and path mousedown when shape tool active)
  const startDrawShape = useCallback((pointer: { x: number; y: number }) => {
    const vp = viewportRef.current
    const cnc = snapCNC(screenToCNC(pointer.x, pointer.y, vp))
    beginGesture({ type: 'drawshape', startCNC: cnc, currentCNC: cnc })
  }, [beginGesture, snapCNC])

  const onMoveDrawShape = useCallback((m: Extract<CanvasMode, { type: 'drawshape' }>, cncMouse: { x: number; y: number }, pointer: { x: number; y: number }, vp: Viewport) => {
    const startScreenX = vp.x + m.startCNC.x * vp.scale
    const startScreenY = vp.y - m.startCNC.y * vp.scale
    if (Math.hypot(pointer.x - startScreenX, pointer.y - startScreenY) > MOVE_THRESHOLD_PX) {
      didDragRef.current = true
    }
    const snappedCNC = snapCNC(cncMouse)
    // Update currentCNC in the mode ref (no state re-render needed — liveShapeD handles rendering)
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
        setLiveShapeD(generateShapeD(params))
      }
    }
  }, [snapCNC])

  const finishDrawShape = useCallback((m: Extract<CanvasMode, { type: 'drawshape' }>) => {
    endGesture()

    const { activeTool, shapeToolConfig, shapeFromCenter } = useUIStore.getState()
    if (activeTool !== 'select') {
      const shapeType = activeTool as ShapeType
      const session = shapeDragSessionRef.current
      if (session.tool !== activeTool) { session.tool = activeTool; session.dragged = false }
      // For a scale-locked shape a drag IS a click: there is no size to drag
      // out, so it places one at the mousedown point and exits to select, the
      // same as a click does. Nothing here special-cases it beyond this line —
      // the placement and the drag-to-repeat session both follow.
      const dragged = didDragRef.current && !SCALE_LOCKED_SHAPES.has(shapeType)

      // A click (no drag) after the user has already dragged out at least one
      // shape this session means "done" — exit to select without adding a shape.
      if (!dragged && session.dragged) {
        shapeDragSessionRef.current = { tool: null, dragged: false }
        useUIStore.getState().setActiveTool('select')
        return
      }

      // Where it lands: normally the mousedown point, but a scale-locked shape
      // follows the cursor and drops where it was released — the drag chooses
      // its position even though it cannot choose its size. For a plain click
      // the two are the same point (currentCNC starts as startCNC).
      const at = SCALE_LOCKED_SHAPES.has(shapeType) ? m.currentCNC : m.startCNC
      const params = dragged
        ? shapeParamsFromDrag(shapeType, m.startCNC, m.currentCNC, shapeToolConfig, shapeFromCenter)
        : shapeParamsFromConfig(shapeType, at.x, at.y, shapeToolConfig)

      placeShape(params, { fromCenter: shapeFromCenter })

      if (dragged) {
        // Keep the shape tool selected so more shapes can be dragged out.
        session.dragged = true
      } else {
        // A click placed a default-sized shape — exit to select as before.
        shapeDragSessionRef.current = { tool: null, dragged: false }
        useUIStore.getState().setActiveTool('select')
      }
    }
  }, [endGesture])

  return { startDrawShape, onMoveDrawShape, finishDrawShape }
}
