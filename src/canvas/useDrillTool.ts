import { useCallback, useEffect, useRef } from 'react'
import type Konva from 'konva'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { onCanvas, type FlatOf } from './pathHit'
import { extractCircles, type CircleInfo } from './selectionUtils'
import type { CanvasView } from './useCanvasView'
import type { Gesture } from './useGesture'
import { screenToCNC } from './viewport'

/** The drill tool: click points, snapped to holes, with an undo of its own. */
export function useDrillTool(g: Gesture, { stageRef, viewportRef }: CanvasView, getFlat: FlatOf, activeTool: string) {
  const { didDragRef, snapCNC } = g
  const pendingDrillPoints = useUIStore((s) => s.pendingDrillPoints)
  const drillPast = useRef<{ x: number; y: number }[][]>([])

  const drillUndo = useCallback(() => {
    if (drillPast.current.length === 0) return
    const prev = drillPast.current[drillPast.current.length - 1]
    drillPast.current = drillPast.current.slice(0, -1)
    useUIStore.getState().setDrillPoints(prev)
  }, [])

  // Circles a path holds, cached on the path object — paths are replaced, never
  // mutated, so identity is a safe key and a click costs no re-parsing.
  const circleCache = useRef(new WeakMap<ImportedPath, CircleInfo[]>())
  const circlesOf = useCallback((p: ImportedPath): CircleInfo[] => {
    let cs = circleCache.current.get(p)
    if (!cs) { cs = extractCircles(p); circleCache.current.set(p, cs) }
    return cs
  }, [])

  // Snap to a circle CENTRE first, then to the nearest visible path vertex within
  // 10 screen px, then fall back to grid snap.
  //
  // A click near a hole means "drill that hole", not "drill where I clicked" — and
  // the drill tool owns the canvas while it is up, so clicking the circle is the only
  // way left to say it. Near means within the tolerance of the CENTRE or of the RIM,
  // never just "inside": a board outline is a circle too, and its open middle has to
  // stay free ground for the free-placed points this tool also exists for. A hole
  // small enough to be one click wide qualifies anywhere inside it either way. The
  // SMALLEST qualifying circle wins, so a hole nested in a bigger ring is the one
  // that gets drilled.
  const snapDrillPoint = useCallback((cnc: { x: number; y: number }): { x: number; y: number } => {
    const vp = viewportRef.current
    const radiusCNC = 10 / vp.scale
    const { paths: allPaths } = usePathsStore.getState()
    let bestCircle: CircleInfo | null = null
    for (const p of allPaths) {
      if (!onCanvas(p)) continue
      for (const c of circlesOf(p)) {
        const d = Math.hypot(c.cx - cnc.x, c.cy - cnc.y)
        if (d > radiusCNC && Math.abs(d - c.radiusMM) > radiusCNC) continue
        if (!bestCircle || c.radiusMM < bestCircle.radiusMM) bestCircle = c
      }
    }
    if (bestCircle) return { x: bestCircle.cx, y: bestCircle.cy }
    let bestDist = radiusCNC
    let best: { x: number; y: number } | null = null
    for (const p of allPaths) {
      if (!onCanvas(p)) continue
      const polys = getFlat(p, 0.5)
      for (const poly of polys) {
        for (const [vx, vy] of poly) {
          const d = Math.hypot(vx - cnc.x, vy - cnc.y)
          if (d < bestDist) { bestDist = d; best = { x: vx, y: vy } }
        }
      }
    }
    if (best) return best
    return snapCNC(cnc)
  }, [snapCNC, getFlat, circlesOf])

  // Register drill-local undo only while there are pending drill points to undo.
  // When points are empty (e.g. after generation or after undoing all), unregister so
  // the toolbar button and keyboard shortcut fall through to the global path undo.
  useEffect(() => {
    if (activeTool === 'drill' && pendingDrillPoints.length > 0) {
      useUIStore.getState().setNodeEditUndoRedo(drillUndo, null)
      useUIStore.getState().setNodeEditHistoryFlags(true, false)
    } else {
      drillPast.current = []
      if (useUIStore.getState().nodeEditUndo === drillUndo) {
        useUIStore.getState().setNodeEditUndoRedo(null, null)
        useUIStore.getState().setNodeEditHistoryFlags(false, false)
      }
    }
  }, [activeTool, pendingDrillPoints.length, drillUndo])

  const placeDrillPoint = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const { activeTool: curTool } = useUIStore.getState()
    if (curTool === 'drill' && !didDragRef.current && e.evt.button === 0) {
      const pointer = stageRef.current?.getPointerPosition()
      if (pointer) {
        const cnc = screenToCNC(pointer.x, pointer.y, viewportRef.current)
        const { pendingDrillPoints } = useUIStore.getState()
        drillPast.current = [...drillPast.current, pendingDrillPoints]
        useUIStore.getState().addDrillPoint(snapDrillPoint(cnc))
      }
    }
  }, [didDragRef, stageRef, viewportRef, snapDrillPoint])

  return { pendingDrillPoints, placeDrillPoint }
}
