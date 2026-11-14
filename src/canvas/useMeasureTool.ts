import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type Konva from 'konva'
import { nearestCandidate, type AnchorCandidate } from '../store/constraints'
import { snapAngle } from './measure'
import type { CanvasView } from './useCanvasView'
import { PICK_HOT_PX } from './useConstrainTool'
import { useRefState } from './useRefState'
import { screenToCNC, type Viewport } from './viewport'

/** The Measure tool. */
export function useMeasureTool(
  { stageRef, viewportRef }: CanvasView,
  activeTool: string,
  allCandidatesRef: MutableRefObject<AnchorCandidate[]>,
) {
  // The Measure tool (canvas/measure): the first click, the second (or the cursor while it
  // is pending), whether the second is down, and the point a click would take now.
  const [measureA, measureARef, setMeasureA] = useRefState<{ x: number; y: number } | null>(null)
  const [measureB, , setMeasureB] = useRefState<{ x: number; y: number } | null>(null)
  const measureDoneRef = useRef(false)
  const [measureHot, measureHotRef, setMeasureHot] = useRefState<{ x: number; y: number } | null>(null)

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
    measureA, measureB, measureHot,
    onMoveMeasureHover, onMeasurePress, clearMeasure,
  }
}
