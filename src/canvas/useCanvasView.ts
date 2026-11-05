import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type Konva from 'konva'
import { layoutExtent } from '../cam/sheets'
import { registerViewFit, registerViewRect, useCanvasStore } from '../store/canvasStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useRealScale } from './screenScale'
import type { BBox } from './selectionUtils'
import { RULER_W, RULER_H } from './types'
import { useSheetLayout } from './useSheets'
import { fitViewport, MAX_ZOOM, minZoomScale, screenToCNC, type Viewport } from './viewport'

/**
 * The stage and the view onto it: size, viewport, fit and zoom. Everything here is about
 * where the drawing is on the screen and nothing about what is being done to it.
 */
export function useCanvasView(selectionBBoxRef: MutableRefObject<BBox | null>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  // Read inside the gesture callbacks, which must not re-create on a resize.
  const sizeRef = useRef(size)
  sizeRef.current = size
  const [viewport, setViewportState] = useState<Viewport>({ x: 0, y: 0, scale: 2 })
  const viewportRef = useRef<Viewport>(viewport)
  const setZoomPct = useCanvasStore((s) => s.setZoomPct)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  // Every sheet, when a nest spread the parts over several: what Fit frames and how far the
  // wheel may zoom out (see minZoomScale).
  const sheets = useSheetLayout()
  const sheetBox = useMemo(() => layoutExtent(sheets, { widthMM, heightMM }), [sheets, widthMM, heightMM])
  const sheetBoxRef = useRef(sheetBox)
  sheetBoxRef.current = sheetBox

  const setViewport = useCallback((v: Viewport | ((p: Viewport) => Viewport)) => {
    const next = typeof v === 'function' ? v(viewportRef.current) : v
    viewportRef.current = next
    setViewportState(next)
    setZoomPct(next.scale)
  }, [setZoomPct])

  // Paste asks what is on screen (store/canvasStore). The ruler strips are drawn over the
  // stage, so they are not counted as view.
  useEffect(() => {
    registerViewRect(() => {
      const { width, height } = sizeRef.current
      if (width <= RULER_W || height <= RULER_H) return null
      const vp = viewportRef.current
      const a = screenToCNC(RULER_W, RULER_H, vp)
      const b = screenToCNC(width, height, vp)
      return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }
    })
    registerViewFit((box) => setViewport(fitViewport(sizeRef.current.width, sizeRef.current.height, box)))
    return () => { registerViewRect(null); registerViewFit(null) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ─── Coming back from sleep ────────────────────────────────────────────────
  //
  // A CANVAS CAN COME BACK BLANK WITH ITS SCENE GRAPH INTACT. The browser is
  // free to throw away a canvas element's backing store when the machine sleeps
  // or memory gets tight — the element and everything Konva holds survive, the
  // pixels do not — and Konva only paints when something asks it to, so nothing
  // ever repaints and the drawing is simply gone until the next pan or click.
  // That is the "my project vanished after the screen went off" report: the
  // document is still there in full (a reload is what actually loses it, which
  // is why refreshing then offers the autosave back).
  //
  // Repainting from the scene graph is the whole fix, and it is cheap enough to
  // do on any of the three signals that can mean "you are being looked at
  // again" — none of them is reliable on its own across browsers, and a
  // redundant redraw of a canvas that is already correct costs one frame.
  useEffect(() => {
    const repaint = () => {
      if (document.visibilityState !== 'visible') return
      // Re-measure first: the same purge can leave the stage sized to a window
      // that has since changed, and a ResizeObserver that fired while hidden may
      // have been the last word on it.
      const el = containerRef.current
      if (el && el.clientWidth > 0 && el.clientHeight > 0) {
        setSize((cur) => cur.width === el.clientWidth && cur.height === el.clientHeight
          ? cur : { width: el.clientWidth, height: el.clientHeight })
      }
      stageRef.current?.batchDraw()
    }
    document.addEventListener('visibilitychange', repaint)
    window.addEventListener('pageshow', repaint)
    window.addEventListener('focus', repaint)
    return () => {
      document.removeEventListener('visibilitychange', repaint)
      window.removeEventListener('pageshow', repaint)
      window.removeEventListener('focus', repaint)
    }
  }, [])

  const fitRequest = useCanvasStore((s) => s.fitRequest)
  const didFitRef = useRef(false)
  useEffect(() => {
    if (size.width > 100 && !didFitRef.current) {
      didFitRef.current = true
      setViewport(fitViewport(size.width, size.height, sheetBox))
    }
  }, [size, sheetBox, setViewport])

  useEffect(() => {
    if (fitRequest === 0 || size.width <= 100) return
    setViewport(fitViewport(size.width, size.height, sheetBoxRef.current))
    // The stock size stays a dependency: a new stock re-fits, as it always has.
  }, [fitRequest, size, widthMM, heightMM, setViewport])

  const fitToWorkpiece = useCallback(() => {
    setViewport(fitViewport(size.width, size.height, sheetBox))
  }, [size, sheetBox, setViewport])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const prevent = (e: WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', prevent, { passive: false })
    return () => el.removeEventListener('wheel', prevent)
  }, [])

  // Scales about a fixed screen point, which is what keeps whatever you are looking at
  // from sliding away as the zoom changes. The wheel and the zoom buttons go through here
  // so both are clamped identically — a button that could pass minZoomScale would leave a
  // view the wheel cannot undo.
  //
  // The wheel passes the cursor. The buttons pass nothing and zoom about the SELECTED
  // part, so a click grows the thing you are working on instead of whatever happens to be
  // mid-screen; with nothing selected they fall back to the centre of the drawing area.
  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    // Cap zoom-out so the table/workpiece can't shrink to a speck; see minZoomScale.
    const wp = useWorkpieceStore.getState()
    const box = sheetBoxRef.current
    const minScale = minZoomScale(size.width, size.height,
      wp.tableLimitWidthMM, wp.tableLimitHeightMM, box.maxX - box.minX, box.maxY - box.minY)
    const midX = RULER_W + (size.width - RULER_W) / 2
    const midY = RULER_H + (size.height - RULER_H) / 2
    const sel = anchor ? null : selectionBBoxRef.current
    setViewport((vp) => {
      const newScale = Math.min(Math.max(vp.scale * factor, minScale), MAX_ZOOM)
      const ratio = newScale / vp.scale
      if (sel) {
        // Hold the part's centre at the screen position it already occupies, exactly as
        // the wheel holds the point under the cursor. If it is currently off-screen there
        // is no such position worth keeping — anchoring out there would zoom about a point
        // you cannot see and leave the part just as invisible — so bring it to the middle.
        const sx = vp.x + sel.cx * vp.scale
        const sy = vp.y - sel.cy * vp.scale
        const visible = sx >= RULER_W && sx <= size.width && sy >= RULER_H && sy <= size.height
        const ax = visible ? sx : midX
        const ay = visible ? sy : midY
        // Solving vp.x + cx*scale = ax and vp.y - cy*scale = ay for the new viewport.
        return { scale: newScale, x: ax - sel.cx * newScale, y: ay + sel.cy * newScale }
      }
      const ax = anchor ? anchor.x : midX
      const ay = anchor ? anchor.y : midY
      return {
        scale: newScale,
        x: ax - (ax - vp.x) * ratio,
        y: ay + (vp.y - ay) * ratio,
      }
    })
  }, [setViewport, size])

  // ACTUAL SIZE: zoom so a millimetre on the stock is a millimetre on the glass, about the
  // selection or the middle of the view as the other zoom buttons are. A display nobody has
  // calibrated has no such zoom (canvas/screenScale.ts), so the button asks for one instead.
  const { pxPerMM: realPx } = useRealScale()
  const zoomToActualSize = useCallback(() => {
    if (realPx === null) { useUIStore.getState().setScreenCalibrationOpen(true); return }
    zoomBy(realPx / viewportRef.current.scale)
  }, [realPx, zoomBy])

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    zoomBy(e.evt.deltaY < 0 ? 1.12 : 1 / 1.12, pointer)
  }, [zoomBy])

  return {
    containerRef, stageRef, size, sizeRef, viewport, viewportRef, setViewport,
    zoomBy, zoomToActualSize, realPx, fitToWorkpiece, handleWheel,
  }
}

export type CanvasView = ReturnType<typeof useCanvasView>
