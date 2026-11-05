import { useCallback } from 'react'
import type Konva from 'konva'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import type { CrossPathEntry } from './layers/NodeEditLayer'
import {
  connectEndpointToInterior, deleteSegment, endpointToMidpointWeld, insertNodeOnSegment, joinPaths,
  joinPathsConnect, nodesToD, removeNode, splitCompoundPath, toggleNodeCurvature, weldNodes,
} from './nodeUtils'
import { closestVisiblePath, onCanvas, type FlatOf } from './pathHit'
import type { CanvasView } from './useCanvasView'
import type { CanvasMode, Gesture } from './useGesture'
import { collectCrossPathEntries, refineCrossEntry, type useNodeEditSession } from './useNodeEditSession'
import { screenToCNC, visibleCNC, type Viewport } from './viewport'

/**
 * The point-edit gestures. The session state and its local undo are in useNodeEditSession;
 * this is what the mouse and the Delete key do to it.
 */
export function useNodeEditGestures(
  g: Gesture,
  { stageRef, viewportRef, sizeRef }: CanvasView,
  session: ReturnType<typeof useNodeEditSession>,
  getFlat: FlatOf,
) {
  const { didDragRef, altDownRef, setMode, beginGesture, snapCNC } = g
  const {
    editNodesRef, setEditNodes,
    editClosedRef, setEditClosed,
    hoveredEditNodeRef, setHoveredEditNode,
    setDragNodeIdx,
    hoverSegIdxRef, setHoverSegIdx,
    weldTargetIdxRef, setWeldTargetIdx,
    connectSourceRef, setConnectSource,
    setConnectPreviewTo, setConnectSnapTargetIdx,
    crossPathEntriesRef, setCrossPathCandidates,
    crossPathWeldTargetRef, setCrossPathWeldTarget,
    editDragInitRef,
    pushLocalUndo, commitNodeEditGlobal, clearConnectState,
  } = session

  /** Delete/Backspace in point edit: the hovered point, else the hovered segment. */
  const onDeleteKey = useCallback((e: KeyboardEvent) => {
    const { nodeEditPathId: pid } = useUIStore.getState()
    if (!pid) return
    if (hoveredEditNodeRef.current !== null) {
      // Delete hovered node
      e.stopImmediatePropagation()
      e.preventDefault()
      const idx = hoveredEditNodeRef.current
      pushLocalUndo(editNodesRef.current, editClosedRef.current)
      const next = removeNode(editNodesRef.current, idx)
      setEditNodes(next)
      setHoveredEditNode(null)
    } else if (hoverSegIdxRef.current !== null) {
      // Trim hovered segment
      e.stopImmediatePropagation()
      e.preventDefault()
      const segIdx = hoverSegIdxRef.current
      const old = editNodesRef.current
      const oldClosed = editClosedRef.current
      const result = deleteSegment(old, segIdx, editClosedRef.current)
      const secondD = result.secondPath ? nodesToD(result.secondPath, false) : null
      if (secondD) {
        // Trim split also adds a new path — commit remainder + add it as ONE
        // atomic global entry, and mark this local step as global so a
        // single local undo removes the split-off path again.
        commitNodeEditGlobal({
          gesture: 'trim', undoFrom: old, undoClosed: oldClosed,
          d: nodesToD(result.nodes, result.closed), nextNodes: result.nodes, nextClosed: result.closed,
          splitOff: { idPrefix: 'trim', d: secondD },
        })
      } else {
        // Plain trim — pure node edit, local undo handles it.
        pushLocalUndo(old, oldClosed)
        setEditNodes(result.nodes)
        if (result.closed !== oldClosed) setEditClosed(result.closed)
      }
      setHoverSegIdx(null)
    }
  }, [pushLocalUndo, commitNodeEditGlobal])

  const handleNodeMouseDown = useCallback((nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => {
    if (kind === 'anchor' && (e.evt.altKey || altDownRef.current)) {
      e.cancelBubble = true
      e.evt.preventDefault()
      const old = editNodesRef.current
      const next = toggleNodeCurvature(old, nodeIdx, editClosedRef.current)
      pushLocalUndo(old, editClosedRef.current)
      setEditNodes(next)
      return
    }

    const vp = viewportRef.current
    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const cnc = { x: (pointer.x - vp.x) / vp.scale, y: (vp.y - pointer.y) / vp.scale }

    editDragInitRef.current = {
      initialNodes: editNodesRef.current.map((n) => ({
        ...n,
        handleIn: n.handleIn ? { ...n.handleIn } : undefined,
        handleOut: n.handleOut ? { ...n.handleOut } : undefined,
      })),
      startCNC: cnc,
    }
    beginGesture({ type: 'nodedit-drag', nodeIdx, kind })
    setDragNodeIdx(kind === 'anchor' ? nodeIdx : null)

    // Gather cross-path weld candidates when dragging an endpoint of an open path
    crossPathEntriesRef.current = []
    setCrossPathWeldTarget(null)
    if (kind === 'anchor' && !editClosedRef.current) {
      const curNodes = editNodesRef.current
      if (nodeIdx === 0 || nodeIdx === curNodes.length - 1) {
        const { nodeEditPathId: pid } = useUIStore.getState()
        const entries = collectCrossPathEntries(pid, visibleCNC(vp, sizeRef.current, curNodes[nodeIdx]))
        crossPathEntriesRef.current = entries
        setCrossPathCandidates(entries)
      }
    } else {
      setCrossPathCandidates([])
    }
  }, [beginGesture])

  const handleSegmentMouseDown = useCallback((segIdx: number, cncX: number, cncY: number) => {
    const { nodeEditPathId: pid } = useUIStore.getState()
    if (!pid) return
    const old = editNodesRef.current
    const next = insertNodeOnSegment(old, segIdx, cncX, cncY, editClosedRef.current)
    pushLocalUndo(old, editClosedRef.current)
    setEditNodes(next)
  }, [pushLocalUndo])

  const handlePathDblClick = useCallback((id: string) => {
    const path = usePathsStore.getState().paths.find((p) => p.id === id)
    if (!path) return
    const subDs = splitCompoundPath(path.d)
    if (subDs.length > 1) {
      usePathsStore.getState().splitPath(id, subDs)
      return
    }
    const { setNodeEditPathId, setActiveTool } = useUIStore.getState()
    setActiveTool('select')
    usePathsStore.getState().selectPath(id)
    setNodeEditPathId(id)
  }, [])

  const handleHoveredNodeChange = useCallback((idx: number | null) => {
    setHoveredEditNode(idx)
  }, [])

  const handleStageDblClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return
    const { activeTool, nodeEditPathId: neid } = useUIStore.getState()
    if (activeTool !== 'select' && activeTool !== 'region') return
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    const vp = viewportRef.current
    const cnc = screenToCNC(pointer.x, pointer.y, vp)
    const { paths } = usePathsStore.getState()
    const candidates = paths.filter((p) => onCanvas(p) && p.id !== neid)
    const hit = closestVisiblePath(cnc.x, cnc.y, candidates, 8 / vp.scale, (p) => getFlat(p, 0.05))
    if (hit) handlePathDblClick(hit.id)
  }, [handlePathDblClick, getFlat])

  const onMoveConnectPreview = useCallback((cncMouse: { x: number; y: number }, vp: Viewport) => {
    // Caller already checks this, but the narrowing doesn't cross the call.
    const srcIdx = connectSourceRef.current
    if (srcIdx === null) return
    const nodes = editNodesRef.current
    if (nodes[srcIdx]) {
      const snapMM = 16 / vp.scale
      let bestDist = snapMM
      let snapSameIdx: number | null = null
      let snapCrossEntry: CrossPathEntry | null = null
      let snapPos = cncMouse

      for (let j = 0; j < nodes.length; j++) {
        if (j === srcIdx) continue
        const dist = Math.hypot(cncMouse.x - nodes[j].x, cncMouse.y - nodes[j].y)
        if (dist < bestDist) {
          bestDist = dist
          snapSameIdx = j
          snapPos = { x: nodes[j].x, y: nodes[j].y }
        }
      }

      for (const cand of crossPathEntriesRef.current) {
        const dist = Math.hypot(cncMouse.x - cand.x, cncMouse.y - cand.y)
        if (dist < bestDist) {
          bestDist = dist
          snapCrossEntry = cand
          snapSameIdx = null
        }
      }
      if (snapCrossEntry) {
        // As in the drag weld: the thinned rings choose the PATH, the full node
        // list of that path chooses the node.
        snapCrossEntry = refineCrossEntry(snapCrossEntry, cncMouse)
        snapPos = { x: snapCrossEntry.x, y: snapCrossEntry.y }
      }

      setConnectPreviewTo(snapPos)
      setConnectSnapTargetIdx(snapSameIdx)
      setCrossPathWeldTarget(snapCrossEntry)
    }
  }, [setCrossPathWeldTarget])

  const onMoveNodeEditDrag = useCallback((m: Extract<CanvasMode, { type: 'nodedit-drag' }>, cncMouse: { x: number; y: number }, e: Konva.KonvaEventObject<MouseEvent>) => {
    // Caller already checks init, but the narrowing doesn't cross the call.
    const init = editDragInitRef.current
    if (!init) return
    didDragRef.current = true
    const dx = cncMouse.x - init.startCNC.x
    const dy = cncMouse.y - init.startCNC.y
    const WELD_THRESHOLD_MM = 16 / viewportRef.current.scale
    let newWeldTarget: number | null = null
    let newCrossTarget: CrossPathEntry | null = null
    const updatedNodes = init.initialNodes.map((n, i) => {
      if (i !== m.nodeIdx) return n
      if (m.kind === 'anchor') {
        const snapped = snapCNC({ x: n.x + dx, y: n.y + dy })
        const sdx = snapped.x - n.x
        const sdy = snapped.y - n.y
        // Check for same-path weld snap first
        for (let j = 0; j < init.initialNodes.length; j++) {
          if (j === m.nodeIdx) continue
          const other = init.initialNodes[j]
          const distSq = (snapped.x - other.x) ** 2 + (snapped.y - other.y) ** 2
          if (distSq < WELD_THRESHOLD_MM ** 2) {
            newWeldTarget = j
            const wdx = other.x - n.x
            const wdy = other.y - n.y
            return { ...n, x: other.x, y: other.y,
              handleIn: n.handleIn ? { x: n.handleIn.x + wdx, y: n.handleIn.y + wdy } : undefined,
              handleOut: n.handleOut ? { x: n.handleOut.x + wdx, y: n.handleOut.y + wdy } : undefined,
            }
          }
        }
        // Check for cross-path weld snap (only available for endpoints of open paths)
        for (const cand of crossPathEntriesRef.current) {
          const distSq = (snapped.x - cand.x) ** 2 + (snapped.y - cand.y) ** 2
          if (distSq < WELD_THRESHOLD_MM ** 2) {
            // The rings drawn for a closed path are a thinned set; the weld
            // itself lands on the node actually nearest the cursor.
            const entry = refineCrossEntry(cand, snapped)
            newCrossTarget = entry
            const wdx = entry.x - n.x
            const wdy = entry.y - n.y
            return { ...n, x: entry.x, y: entry.y,
              handleIn: n.handleIn ? { x: n.handleIn.x + wdx, y: n.handleIn.y + wdy } : undefined,
              handleOut: n.handleOut ? { x: n.handleOut.x + wdx, y: n.handleOut.y + wdy } : undefined,
            }
          }
        }
        return {
          ...n,
          x: snapped.x,
          y: snapped.y,
          handleIn: n.handleIn ? { x: n.handleIn.x + sdx, y: n.handleIn.y + sdy } : undefined,
          handleOut: n.handleOut ? { x: n.handleOut.x + sdx, y: n.handleOut.y + sdy } : undefined,
        }
      }
      if (m.kind === 'handle-in') {
        const handleIn = { x: (n.handleIn?.x ?? n.x) + dx, y: (n.handleIn?.y ?? n.y) + dy }
        const handleOut = (altDownRef.current || e.evt.altKey) && n.handleOut
          ? { x: 2 * n.x - handleIn.x, y: 2 * n.y - handleIn.y }
          : n.handleOut
        return { ...n, handleIn, handleOut }
      }
      const handleOut = { x: (n.handleOut?.x ?? n.x) + dx, y: (n.handleOut?.y ?? n.y) + dy }
      const handleIn = (altDownRef.current || e.evt.altKey) && n.handleIn
        ? { x: 2 * n.x - handleOut.x, y: 2 * n.y - handleOut.y }
        : n.handleIn
      return { ...n, handleIn, handleOut }
    })
    setWeldTargetIdx(newWeldTarget)
    setCrossPathWeldTarget(newCrossTarget)
    setEditNodes(updatedNodes)
  }, [snapCNC, setWeldTargetIdx, setCrossPathWeldTarget, setEditNodes])

  /** Connect mode completed on another path. True when this release was that. */
  const finishCrossConnect = useCallback((m: CanvasMode): boolean => {
    // Complete cross-path connection from connect mode (user clicked while snapped to other-path node)
    if (connectSourceRef.current !== null && crossPathWeldTargetRef.current !== null && m.type === 'idle') {
      const cs = connectSourceRef.current
      const crossTarget = crossPathWeldTargetRef.current
      const nodes = editNodesRef.current
      const joined = joinPathsConnect(
        nodes, cs,
        crossTarget.nodes, crossTarget.nodeIdx, crossTarget.closed,
      )
      if (joined) {
        const newD = nodesToD(joined, false)
        // Join deletes the other path via ONE atomic global entry; a global-
        // marked local step lets Ctrl+Z revert both, in-session, in one press.
        if (newD) commitNodeEditGlobal({
          gesture: 'join', undoFrom: nodes, undoClosed: editClosedRef.current,
          d: newD, nextNodes: joined, nextClosed: false, deleteIds: [crossTarget.pathId],
        })
      }
      clearConnectState()
      return true
    }
    return false
  }, [])

  const finishNodeDrag = useCallback((m: Extract<CanvasMode, { type: 'nodedit-drag' }>) => {
    setMode({ type: 'idle' })
    const initSnap = editDragInitRef.current?.initialNodes
    editDragInitRef.current = null
    setDragNodeIdx(null)
    setCrossPathCandidates([])
    crossPathEntriesRef.current = []
    const crossTgt = crossPathWeldTargetRef.current
    setCrossPathWeldTarget(null)
    const tgt = weldTargetIdxRef.current
    setWeldTargetIdx(null)

    if (crossTgt !== null && didDragRef.current) {
      // Cross-path join: merge the current path with another path at their endpoints
      const joined = joinPaths(
        editNodesRef.current, m.nodeIdx, editClosedRef.current,
        crossTgt.nodes, crossTgt.nodeIdx, crossTgt.closed,
      )
      if (joined) {
        const newD = nodesToD(joined, false)
        // Join deletes the other path via ONE atomic global entry; a global-
        // marked local step lets Ctrl+Z revert both, in-session, in one press.
        if (newD) commitNodeEditGlobal({
          gesture: 'join', undoFrom: initSnap ?? null, undoClosed: editClosedRef.current,
          d: newD, nextNodes: joined, nextClosed: false, deleteIds: [crossTgt.pathId],
        })
      }
    } else if (tgt !== null && didDragRef.current) {
      const curNodes = editNodesRef.current
      const curClosed = editClosedRef.current
      const n = curNodes.length
      const srcIsEndpoint = !curClosed && (m.nodeIdx === 0 || m.nodeIdx === n - 1)
      const tgtIsEndpoint = tgt === 0 || tgt === n - 1
      const lollipop = srcIsEndpoint && !tgtIsEndpoint
        ? endpointToMidpointWeld(curNodes, m.nodeIdx, tgt) : null

      if (lollipop) {
        // Endpoint-to-midpoint: create a closed loop and keep the remainder
        const { loopNodes, remainNodes } = lollipop
        const loopD = nodesToD(loopNodes, true)
        const remainD = nodesToD(remainNodes, false)
        // Loop split adds a new path via ONE atomic global entry; a global-
        // marked local step lets Ctrl+Z revert both, in-session, in one press.
        if (remainD) commitNodeEditGlobal({
          gesture: 'weld', undoFrom: initSnap ?? null, undoClosed: curClosed,
          d: remainD, nextNodes: remainNodes, nextClosed: false,
          splitOff: loopD ? { idPrefix: 'weld-loop', d: loopD } : null,
        })
      } else {
        // Standard same-path weld (endpoint→endpoint close, or mid→any merge) —
        // pure node edit, store untouched until commit, so local undo handles it.
        if (initSnap) pushLocalUndo(initSnap, curClosed)
        const result = weldNodes(curNodes, m.nodeIdx, tgt, curClosed)
        setEditNodes(result.nodes)
        if (result.closed !== curClosed) {
          setEditClosed(result.closed)
        }
      }
    } else if (initSnap && didDragRef.current) {
      pushLocalUndo(initSnap, editClosedRef.current)
    }

    // No-drag on an anchor: toggle connect mode or complete connection
    if (!didDragRef.current && m.kind === 'anchor') {
      const cs = connectSourceRef.current
      const nodes = editNodesRef.current
      const closed = editClosedRef.current
      const n = nodes.length
      const mIsEndpoint = !closed && (m.nodeIdx === 0 || m.nodeIdx === n - 1)


      if (cs !== null && cs !== m.nodeIdx) {
        if (mIsEndpoint) {
          // Connect source endpoint to other endpoint → close path
          pushLocalUndo(nodes, editClosedRef.current)
          setEditClosed(true)
          clearConnectState()
        } else {
          // Connect source endpoint to interior node — split into closed loop + open remainder,
          // both nodes preserved (no merging, no deletion)
          const result = connectEndpointToInterior(nodes, cs, m.nodeIdx)
          if (result) {
            const { loopNodes, remainNodes } = result
            const loopD = nodesToD(loopNodes, true)
            const remainD = nodesToD(remainNodes, false)
            // Loop split adds a new path via ONE atomic global entry; a global-
            // marked local step lets Ctrl+Z revert both, in-session, in one press.
            if (remainD) commitNodeEditGlobal({
              gesture: 'weld', undoFrom: nodes, undoClosed: editClosedRef.current,
              d: remainD, nextNodes: remainNodes, nextClosed: false,
              splitOff: loopD ? { idPrefix: 'connect-loop', d: loopD } : null,
            })
            clearConnectState()
          }
          // else: degenerate (adjacent endpoints only, nothing to split) — stay in connect mode
        }
      } else if (cs === m.nodeIdx) {
        // Cancel: click source again
        clearConnectState()
      } else if (cs === null && mIsEndpoint) {
        // Enter connect mode — populate cross-path candidates
        setConnectSource(m.nodeIdx)
        const { nodeEditPathId: pid } = useUIStore.getState()
        const entries = collectCrossPathEntries(pid, visibleCNC(viewportRef.current, sizeRef.current, editNodesRef.current[m.nodeIdx]))
        crossPathEntriesRef.current = entries
        setCrossPathCandidates(entries)
      }
      // else: non-endpoint click with no connect mode active → do nothing
    }
  }, [])

  return {
    onDeleteKey, handleNodeMouseDown, handleSegmentMouseDown, handleHoveredNodeChange, handleStageDblClick,
    onMoveConnectPreview, onMoveNodeEditDrag, finishCrossConnect, finishNodeDrag,
  }
}
