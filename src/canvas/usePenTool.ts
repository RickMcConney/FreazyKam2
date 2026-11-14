import { useCallback, useEffect, useRef, useState } from 'react'
import { penNodesToPathD, type PenCurveType } from '../cam/penCurves'
import { nextPathColor } from '../importers/svgImporter'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useUIStore, type PenNode } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { uid } from '../uid'
import type { SnapGuides } from './layers/SnapGuideLayer'
import { pushLocalHistory } from './localHistory'
import { snapAxisDelta } from './objectSnap'
import { onCanvas, type FlatOf } from './pathHit'
import { getBBox } from './selectionUtils'
import type { CanvasView } from './useCanvasView'
import { MOVE_THRESHOLD_PX, OBJECT_SNAP_PX, type CanvasMode, type Gesture } from './useGesture'
import { useRefState } from './useRefState'
import { screenToCNC, type Viewport } from './viewport'

// The pen tool: the live segment preview, the closing-hover flag, snapping, the gestures
// that place points, and the pen-local undo/redo stacks (registered as the toolbar/Ctrl+Z
// handler while the pen is active).
export function usePenTool(g: Gesture, { viewportRef }: CanvasView, getFlat: FlatOf) {
  const { didDragRef, altDown, altDownRef, shiftDown, shiftDownRef, setMode, beginGesture, snapCNC, setSnapGuides } = g
  const [livePen, setLivePen] = useState<{ anchor: { x: number; y: number }; handle: { x: number; y: number } | null } | null>(null)
  const [penClosing, penClosingRef, setPenClosing] = useRefState(false)
  // Object-snapped cursor while the pen tool is active — feeds the pen live
  // preview so it shows exactly where a click would land.
  const [penSnapCursor, setPenSnapCursor] = useState<{ x: number; y: number } | null>(null)
  const penPast = useRef<PenNode[][]>([])
  const penFuture = useRef<PenNode[][]>([])
  const penNodes = useUIStore((s) => s.penNodes)
  const penCurveType = useUIStore((s) => s.penCurveType)
  // Shift (or Alt) held flips the incoming segment between straight and curved.
  const straightHeld = altDown || shiftDown
  const effectiveCurveType: PenCurveType = straightHeld
    ? (penCurveType === 'linear' ? 'catmull-rom' : 'linear')
    : penCurveType

  const penUndo = useCallback(() => {
    if (penPast.current.length === 0) return
    const prev = penPast.current[penPast.current.length - 1]
    penFuture.current = [useUIStore.getState().penNodes, ...penFuture.current]
    penPast.current = penPast.current.slice(0, -1)
    useUIStore.getState().setPenNodes(prev)
    useUIStore.getState().setNodeEditHistoryFlags(penPast.current.length > 0, true)
  }, [])

  const penRedo = useCallback(() => {
    if (penFuture.current.length === 0) return
    const next = penFuture.current[0]
    pushLocalHistory(penPast.current, useUIStore.getState().penNodes)
    penFuture.current = penFuture.current.slice(1)
    useUIStore.getState().setPenNodes(next)
    useUIStore.getState().setNodeEditHistoryFlags(true, penFuture.current.length > 0)
  }, [])

  // Register pen-local undo/redo while the pen tool is active; clear the
  // stacks and unregister when it isn't.
  const activeTool = useUIStore((s) => s.activeTool)
  useEffect(() => {
    if (activeTool === 'pen') {
      useUIStore.getState().setNodeEditUndoRedo(penUndo, penRedo)
      useUIStore.getState().setNodeEditHistoryFlags(false, false)
    } else {
      penPast.current = []
      penFuture.current = []
      if (useUIStore.getState().nodeEditUndo === penUndo) {
        useUIStore.getState().setNodeEditUndoRedo(null, null)
        useUIStore.getState().setNodeEditHistoryFlags(false, false)
      }
    }
  }, [activeTool, penUndo, penRedo])

  // Clear pen snap feedback whenever the pen tool deactivates (Escape, closing
  // commit, and toolbar switches all reset activeTool to 'select').
  useEffect(() => {
    if (activeTool !== 'pen') {
      setPenSnapCursor(null)
      setSnapGuides(null)
    }
  }, [activeTool])

  // Pen-tool snapping: nearest path vertex first (crosshair guides through it),
  // then bbox edge/center axis alignment (same dashed guides as drag snapping),
  // then grid. Committed pen nodes count as vertices/alignment targets too so
  // grid-like pen drawings line up with themselves.
  //
  // The drawing's half is built once per paths state (and re-bucketed only when the zoom
  // moves the snap radius a factor of 2 off the cell size), not on every mouse move: it
  // used to walk every vertex of every visible path, and recompute every bbox, per frame.
  // Vertices go into a grid of cells about one snap radius wide, so a query reads the 3×3
  // cells round the cursor. The axis guides come from the exact `getBBox`, as the drag's
  // `collectSnapTargets` does, not from the 0.5 mm flattened box.
  const penSnapIndexRef = useRef<{
    paths: ImportedPath[]; cell: number; buckets: Map<string, [number, number][]>; xs: number[]; ys: number[]
  } | null>(null)
  const penSnapIndex = useCallback((allPaths: ImportedPath[], tolMM: number) => {
    const cur = penSnapIndexRef.current
    if (cur && cur.paths === allPaths && tolMM <= cur.cell * 2 && tolMM >= cur.cell / 2) return cur
    const cell = tolMM
    const buckets = new Map<string, [number, number][]>()
    const xs: number[] = [], ys: number[] = []
    for (const p of allPaths) {
      if (!onCanvas(p)) continue
      for (const poly of getFlat(p, 0.5)) {
        for (const v of poly) {
          const key = `${Math.floor(v[0] / cell)},${Math.floor(v[1] / cell)}`
          const b = buckets.get(key)
          if (b) b.push(v); else buckets.set(key, [v])
        }
      }
      const bb = getBBox(p.d)
      if (bb) { xs.push(bb.minX, bb.maxX, bb.cx); ys.push(bb.minY, bb.maxY, bb.cy) }
    }
    return (penSnapIndexRef.current = { paths: allPaths, cell, buckets, xs, ys })
  }, [getFlat])

  const snapPenPoint = useCallback((cnc: { x: number; y: number }): { point: { x: number; y: number }; guides: SnapGuides | null } => {
    const { snapEnabled, penNodes } = useUIStore.getState()
    if (!snapEnabled) return { point: cnc, guides: null }
    const vp = viewportRef.current
    const tolMM = OBJECT_SNAP_PX / vp.scale
    const { paths: allPaths } = usePathsStore.getState()
    const { widthMM: wMM, heightMM: hMM } = useWorkpieceStore.getState()
    const idx = penSnapIndex(allPaths, tolMM)

    let bestDist = tolMM
    let bestVert: { x: number; y: number } | null = null
    const r = Math.ceil(tolMM / idx.cell)
    const cx0 = Math.floor(cnc.x / idx.cell), cy0 = Math.floor(cnc.y / idx.cell)
    for (let i = cx0 - r; i <= cx0 + r; i++) {
      for (let j = cy0 - r; j <= cy0 + r; j++) {
        const b = idx.buckets.get(`${i},${j}`)
        if (!b) continue
        for (const [vx, vy] of b) {
          const d = Math.hypot(vx - cnc.x, vy - cnc.y)
          if (d < bestDist) { bestDist = d; bestVert = { x: vx, y: vy } }
        }
      }
    }
    const xs: number[] = [0, wMM, wMM / 2, ...idx.xs]
    const ys: number[] = [0, hMM, hMM / 2, ...idx.ys]
    for (const n of penNodes) {
      const d = Math.hypot(n.x - cnc.x, n.y - cnc.y)
      if (d < bestDist) { bestDist = d; bestVert = { x: n.x, y: n.y } }
      xs.push(n.x)
      ys.push(n.y)
    }
    if (bestVert) return { point: bestVert, guides: { x: bestVert.x, y: bestVert.y } }

    const ox = snapAxisDelta([cnc.x], xs, tolMM)
    const oy = snapAxisDelta([cnc.y], ys, tolMM)
    let x = cnc.x + (ox?.correction ?? 0)
    let y = cnc.y + (oy?.correction ?? 0)
    const grid = snapCNC({ x, y })
    if (!ox) x = grid.x
    if (!oy) y = grid.y
    return { point: { x, y }, guides: ox || oy ? { x: ox?.guide, y: oy?.guide } : null }
  }, [snapCNC, penSnapIndex])

  // Start placing a pen node from the given screen pointer position
  const startPenDraw = useCallback((pointer: { x: number; y: number }) => {
    const vp = viewportRef.current
    const cnc = snapPenPoint(screenToCNC(pointer.x, pointer.y, vp)).point
    const { penNodes: nodes } = useUIStore.getState()

    if (nodes.length >= 2) {
      const first = nodes[0]
      const fsx = vp.x + first.x * vp.scale
      const fsy = vp.y - first.y * vp.scale
      if (Math.hypot(pointer.x - fsx, pointer.y - fsy) < 10) {
        beginGesture({ type: 'pendraw', anchorCNC: cnc, closing: true })
        return
      }
    }

    beginGesture({ type: 'pendraw', anchorCNC: cnc, closing: false })
    setLivePen({ anchor: cnc, handle: null })
  }, [beginGesture, snapPenPoint, setLivePen])

  // Runs for every mode EXCEPT pendraw — highlights the pen's first node when
  // the cursor is near enough to close the path, and tracks the snapped cursor.
  const onMovePenHover = useCallback((cncMouse: { x: number; y: number }, pointer: { x: number; y: number }, vp: Viewport) => {
    const { activeTool: at, penNodes: nodes } = useUIStore.getState()
    if (at === 'pen') {
      const snap = snapPenPoint(cncMouse)
      setPenSnapCursor(snap.point)
      setSnapGuides(snap.guides)
    }
    if (at === 'pen' && nodes.length >= 2) {
      const first = nodes[0]
      const fsx = vp.x + first.x * vp.scale
      const fsy = vp.y - first.y * vp.scale
      const close = Math.hypot(pointer.x - fsx, pointer.y - fsy) < 10
      if (close !== penClosingRef.current) {
        setPenClosing(close)
      }
    } else if (penClosingRef.current) {
      setPenClosing(false)
    }
  }, [snapPenPoint, setPenClosing])

  const onMovePenDraw = useCallback((m: Extract<CanvasMode, { type: 'pendraw' }>, cncMouse: { x: number; y: number }, pointer: { x: number; y: number }, vp: Viewport) => {
    const asx = vp.x + m.anchorCNC.x * vp.scale
    const asy = vp.y - m.anchorCNC.y * vp.scale
    if (Math.hypot(pointer.x - asx, pointer.y - asy) > MOVE_THRESHOLD_PX) {
      didDragRef.current = true
    }
    if (didDragRef.current && !m.closing) {
      // Only track drag handles in bezier mode; other modes auto-compute curves
      if (useUIStore.getState().penCurveType === 'bezier') {
        setLivePen({ anchor: m.anchorCNC, handle: cncMouse })
      }
    }
  }, [setLivePen])

  const finishPenDraw = useCallback((m: Extract<CanvasMode, { type: 'pendraw' }>) => {
    setMode({ type: 'idle' })

    if (m.closing) {
      const { penNodes: nodes, clearPenNodes, penCurveType: ct } = useUIStore.getState()
      if (nodes.length >= 2) {
        const closeNodes = altDownRef.current || shiftDownRef.current
          ? [{ ...nodes[0], corner: true }, ...nodes.slice(1)]
          : nodes
        const d = penNodesToPathD(closeNodes, true, ct)
        if (d) {
          const id = uid('pen')
          const { addPaths: add, selectPath: sel } = usePathsStore.getState()
          add([{ id, name: 'Pen Path', d, visible: true, color: nextPathColor() }], { source: 'pen' })
          sel(id)
        }
      }
      clearPenNodes()
      useUIStore.getState().setActiveTool('select')
      setLivePen(null)
      setPenClosing(false)
      return
    }

    const { addPenNode, penCurveType: ct } = useUIStore.getState()
    const newNode: PenNode = { x: m.anchorCNC.x, y: m.anchorCNC.y }
    if (ct === 'bezier' && didDragRef.current && livePen?.handle) {
      const dx = livePen.handle.x - m.anchorCNC.x
      const dy = livePen.handle.y - m.anchorCNC.y
      newNode.outHandle = livePen.handle
      newNode.inHandle = { x: m.anchorCNC.x - dx, y: m.anchorCNC.y - dy }
    } else if (ct !== 'linear' && (altDownRef.current || shiftDownRef.current)) {
      // Shift (or Alt) held: mark incoming segment as linear (corner). Only affects the segment
      // ending at this node — the outgoing segment uses normal curve logic.
      newNode.corner = true
    }
    pushLocalHistory(penPast.current, [...useUIStore.getState().penNodes])
    penFuture.current = []
    addPenNode(newNode)
    useUIStore.getState().setNodeEditHistoryFlags(true, false)
    setLivePen(null)
    return
  }, [livePen, didDragRef, altDownRef, shiftDownRef, setMode, setPenClosing])

  /** Escape: what has been drawn stays, as an open path. */
  const finishPenOnEscape = useCallback(() => {
    const { setActiveTool, penNodes: nodes, clearPenNodes, penCurveType: ct } = useUIStore.getState()
      if (nodes.length >= 2) {
        const d = penNodesToPathD(nodes, false, ct)
        if (d) {
          const id = uid('pen')
          usePathsStore.getState().addPaths([{ id, name: 'Pen Path', d, visible: true, color: nextPathColor() }], { source: 'pen' })
          usePathsStore.getState().selectPath(id)
        }
      }
    clearPenNodes()
    setActiveTool('select')
    setLivePen(null)
    setPenClosing(false)
    setMode({ type: 'idle' })
  }, [setMode, setPenClosing])

  return {
    livePen, penClosing, penNodes, effectiveCurveType, penSnapCursor, setPenSnapCursor,
    startPenDraw, onMovePenHover, onMovePenDraw, finishPenDraw, finishPenOnEscape,
  }
}
