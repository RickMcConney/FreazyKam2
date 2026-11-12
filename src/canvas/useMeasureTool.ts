import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type Konva from 'konva'
import { cellOffset, cellOfPoint } from '../cam/sheets'
import { pointInPolygon } from '../cam/geom'
import { useCanvasStore } from '../store/canvasStore'
import { nearestCandidate, type AnchorCandidate } from '../store/constraints'
import { groupKeyOf } from '../store/pathGroups'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { SnapGuides } from './layers/SnapGuideLayer'
import { measureGaps, snapAngle } from './measure'
import type { Box } from './objectSnap'
import { closestVisiblePath, onCanvas, type FlatOf } from './pathHit'
import { getBBox, getMultiBBox, type BBox } from './selectionUtils'
import type { CanvasView } from './useCanvasView'
import type { Gesture } from './useGesture'
import { PICK_HOT_PX } from './useConstrainTool'
import { useRefState } from './useRefState'
import { screenToCNC, type Viewport } from './viewport'

/** The Measure tool, and the Alt-hover gaps that measure without it. */
export function useMeasureTool(
  g: Gesture,
  { stageRef, viewportRef }: CanvasView,
  getFlat: FlatOf,
  activeTool: string,
  allCandidatesRef: MutableRefObject<AnchorCandidate[]>,
  selectionBBoxRef: MutableRefObject<BBox | null>,
) {
  const { modeRef, altDown, altDownRef } = g
  // The Measure tool (canvas/measure): the first click, the second (or the cursor while it
  // is pending), whether the second is down, and the point a click would take now.
  const [measureA, measureARef, setMeasureA] = useRefState<{ x: number; y: number } | null>(null)
  const [measureB, , setMeasureB] = useRefState<{ x: number; y: number } | null>(null)
  const measureDoneRef = useRef(false)
  const [measureHot, measureHotRef, setMeasureHot] = useRefState<{ x: number; y: number } | null>(null)
  // Alt held over a part with something selected: the gaps between them (canvas/measure).
  const [altMeasure, setAltMeasure] = useState<SnapGuides | null>(null)

  // Leaving the Measure tool drops its line; Escape inside it drops the line first.
  useEffect(() => {
    if (activeTool === 'measure') return
    setMeasureA(null); setMeasureB(null); setMeasureHot(null)
    measureDoneRef.current = false
  }, [activeTool, setMeasureA, setMeasureB, setMeasureHot])

  // Measure tool hover: the point a click would take — a part's corner, edge middle or
  // centre within reach, else the cursor itself — and, while the second point is pending,
  // the line follows it (Shift holds it to 15° steps).
  const onMoveMeasureHover = useCallback((cnc: { x: number; y: number }, vp: Viewport, shift: boolean) => {
    const near = nearestCandidate(allCandidatesRef.current, cnc.x, cnc.y, PICK_HOT_PX / vp.scale)
    const a = measureARef.current
    let pt = near ? { x: near.x, y: near.y } : cnc
    if (a && !measureDoneRef.current && shift && !near) pt = snapAngle(a, pt, 15)
    setMeasureHot(near ? pt : null)
    if (a && !measureDoneRef.current) setMeasureB(pt)
  }, [setMeasureHot, setMeasureB, measureARef])

  // ALT-HOVER MEASURES. With something selected and Alt held, the gaps between the selection
  // and the part under the cursor are drawn (canvas/measure measureGaps). The part is found by
  // its outline first, then as the smallest closed part around the cursor — so hovering
  // anywhere inside a plate measures to the plate — and with nothing there, against the stock
  // sheet the selection is on. A group or multi-part shape is measured as a whole.
  const updateAltMeasure = useCallback((cnc: { x: number; y: number } | null, vp: Viewport) => {
    const ui = useUIStore.getState()
    const sb = selectionBBoxRef.current
    // Not while the Tabs form is open: Alt there is the key that deletes a tab or strip.
    if (!cnc || !altDownRef.current || ui.activeTool !== 'select' || ui.nodeEditPathId
      || ui.tabsFormActive || modeRef.current.type !== 'idle' || !sb) {
      setAltMeasure(null)
      return
    }
    const { paths, selectedIds } = usePathsStore.getState()
    const sel = new Set(selectedIds)
    const others = paths.filter((p) => onCanvas(p) && !sel.has(p.id) && !p.imageSrc)
    let hit = closestVisiblePath(cnc.x, cnc.y, others, 8 / vp.scale, (p) => getFlat(p, 0.05))
    if (!hit) {
      let bestArea = Infinity
      for (const p of others) {
        const b = getBBox(p.d)
        if (!b || cnc.x < b.minX || cnc.x > b.maxX || cnc.y < b.minY || cnc.y > b.maxY) continue
        const area = b.width * b.height
        if (area < bestArea && getFlat(p, 0.05).some((poly) => pointInPolygon(cnc.x, cnc.y, poly))) { bestArea = area; hit = p }
      }
    }
    let target: Box
    if (hit) {
      const key = groupKeyOf(hit)
      const members = key ? others.filter((q) => groupKeyOf(q) === key) : [hit]
      const b = getMultiBBox(members.map((q) => q.d))
      if (!b) { setAltMeasure(null); return }
      target = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }
    } else {
      const { widthMM, heightMM } = useWorkpieceStore.getState()
      const stock = { widthMM, heightMM }
      const o = cellOffset(cellOfPoint(sb.cx, sb.cy, stock), stock)
      target = { minX: o.x, minY: o.y, maxX: o.x + widthMM, maxY: o.y + heightMM }
    }
    const gaps = measureGaps({ minX: sb.minX, minY: sb.minY, maxX: sb.maxX, maxY: sb.maxY }, target)
    setAltMeasure({ gaps, boxes: [target] })
  }, [getFlat, altDownRef])
  // Pressing or letting go of Alt answers at once, without waiting for the mouse to move.
  useEffect(() => {
    updateAltMeasure(altDown ? useCanvasStore.getState().cursorMM : null, viewportRef.current)
  }, [altDown, updateAltMeasure])

  // The first click starts a measurement, the second ends it, and a click after that starts
  // the next. The tool owns the click — no selection, no drag.
  const onMeasurePress = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stagePointer = stageRef.current?.getPointerPosition()
    if (!stagePointer) return
    const cnc = screenToCNC(stagePointer.x, stagePointer.y, viewportRef.current)
    const a = measureARef.current
    let pt = measureHotRef.current ?? cnc
    if (a && !measureDoneRef.current) {
      if (!measureHotRef.current && e.evt.shiftKey) pt = snapAngle(a, pt, 15)
      setMeasureB(pt)
      measureDoneRef.current = true
    } else {
      setMeasureA(pt)
      setMeasureB(pt)
      measureDoneRef.current = false
    }
  }, [stageRef, viewportRef, measureARef, measureHotRef, setMeasureA, setMeasureB])

  /** Drop the line in progress. False when there was none, so Escape can leave the tool. */
  const clearMeasure = useCallback((): boolean => {
    if (!measureARef.current) return false
    setMeasureA(null)
    setMeasureB(null)
    measureDoneRef.current = false
    return true
  }, [measureARef, setMeasureA, setMeasureB])

  return {
    measureA, measureB, measureHot, altMeasure, setAltMeasure,
    onMoveMeasureHover, updateAltMeasure, onMeasurePress, clearMeasure,
  }
}
