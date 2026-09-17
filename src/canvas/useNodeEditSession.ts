import { useCallback, useEffect, useRef, useState } from 'react'
import { useRefState } from './useRefState'
import { pushLocalHistory } from './localHistory'
import { usePathsStore } from '../store/pathsStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { useUIStore } from '../store/uiStore'
import { regenerateAffected } from '../cam/regenerate'
import { parseDToNodes, nodesToD, type PathNode } from './nodeUtils'
import type { CrossPathEntry } from './layers/NodeEditLayer'

// One point-edit session: the live editable node copy, weld/connect gesture
// state, the session-local undo stack, and the commit/exit + store-sync
// lifecycle. Extracted from CanvasStage (tofix.md R3); the mouse/keyboard
// gesture handlers stay in CanvasStage and drive this state.

// Local undo entry. `globalStep: true` marks gestures that also wrote one
// atomic global history entry (cross-path join, loop split, trim split) —
// crossing such an entry replays the paired global undo/redo so the other
// path involved is restored in the same step.
export type NodeEditEntry = { nodes: PathNode[]; closed: boolean; globalStep?: boolean }

/** What is on screen, and how big a millimetre is there — see
 *  `collectCrossPathEntries`, which needs both to keep a project full of gears
 *  down to a set of targets a person could actually aim at. */
export interface CrossPathView {
  /** Visible area in CNC mm. */
  minX: number; minY: number; maxX: number; maxY: number
  /** Screen pixels per mm (`Viewport.scale`). */
  scale: number
  /** The node the gesture started from, in CNC mm. Only decides which
   *  candidates the cap keeps, and only when the cap is reached at all. */
  near: { x: number; y: number }
}

/** Two candidates closer together than this ON SCREEN are one target to the
 *  user, so only the first survives. Kept well under the 16 px weld radius so
 *  the ring you aim at is always the one that takes the weld. */
const CANDIDATE_MIN_GAP_PX = 8

/** Backstop for the pathological case the gap above cannot reach (thousands of
 *  open paths, each contributing endpoints that are never decimated). */
const MAX_CROSS_PATH_ENTRIES = 500

// Reparsing every path in the document on every endpoint mousedown is most of
// the cost of opening the gesture, and a gear's `d` is tens of thousands of
// characters. Keyed by path id and validated against `d`, so an edited path
// reparses. A DELETED path's entry is pruned by `collectCrossPathEntries`, the one
// caller — nothing else ever removes an id, so without that every gear deleted or
// pasted-and-removed in a session kept its whole node list until a reload.
const parseCache = new Map<string, { d: string; parsed: { nodes: PathNode[]; closed: boolean } }>()
function parseCached(id: string, d: string): { nodes: PathNode[]; closed: boolean } {
  const hit = parseCache.get(id)
  if (hit && hit.d === d) return hit.parsed
  const parsed = parseDToNodes(d)
  parseCache.set(id, { d, parsed })
  return parsed
}

/**
 * Other-path nodes eligible as weld/connect targets: every node of a closed
 * path, only the two endpoints of an open one. Soft-hidden paths (hidden: true)
 * are invisible on canvas and must not attract welds (bugs.md B1).
 *
 * A CLOSED PATH OFFERS EVERY NODE, AND A GEAR HAS THOUSANDS — so a project with
 * a few gears in it produced tens of thousands of candidates on a single
 * endpoint mousedown, each one a React element and a Konva ring, which made the
 * gesture crawl and in one case took the tab down. `view` is what fixes it, and
 * it does so without taking closed paths out of the feature: candidates you
 * cannot see are dropped, and the survivors are thinned to one per
 * CANDIDATE_MIN_GAP_PX cell of SCREEN, which is the spacing below which two
 * rings are the same ring to whoever is aiming at them. Zoomed in on two nodes,
 * both are offered; zoomed out to where a whole gear is 40 px across, its rim
 * offers a handful.
 *
 * The thinning is per path — two shapes lying on top of each other are two
 * things to weld to — and it never touches an open path's endpoints, which are
 * two per path and are the join the user is nearly always after.
 *
 * A dropped node is still weldable: `refineCrossEntry` walks the whole target
 * path at snap time, so the decimation decides which rings are DRAWN and never
 * which node the weld lands on.
 */
export function collectCrossPathEntries(
  excludePathId: string | null,
  view?: CrossPathView,
): CrossPathEntry[] {
  const { paths } = usePathsStore.getState()
  // Forget parses of paths the document no longer has (see parseCache).
  if (parseCache.size > 0) {
    const live = new Set(paths.map((p) => p.id))
    for (const id of parseCache.keys()) if (!live.has(id)) parseCache.delete(id)
  }
  const open: CrossPathEntry[] = []
  const closed: CrossPathEntry[] = []
  // A margin of one weld radius, so a node just off the edge of the canvas is
  // still a target for an endpoint dragged out to meet it.
  const margin = view ? 16 / view.scale : 0
  const cell = view ? CANDIDATE_MIN_GAP_PX / view.scale : 0
  for (const p of paths) {
    if (p.id === excludePathId || !p.visible || p.hidden) continue
    const parsed = parseCached(p.id, p.d)
    if (parsed.nodes.length < 2) continue
    if (parsed.closed) {
      const seen = view ? new Set<string>() : null
      for (let j = 0; j < parsed.nodes.length; j++) {
        const n = parsed.nodes[j]
        if (view) {
          if (n.x < view.minX - margin || n.x > view.maxX + margin
            || n.y < view.minY - margin || n.y > view.maxY + margin) continue
          const key = `${Math.round(n.x / cell)},${Math.round(n.y / cell)}`
          if (seen!.has(key)) continue
          seen!.add(key)
        }
        closed.push({ pathId: p.id, nodeIdx: j, x: n.x, y: n.y, nodes: parsed.nodes, closed: true })
      }
    } else {
      open.push({ pathId: p.id, nodeIdx: 0, x: parsed.nodes[0].x, y: parsed.nodes[0].y, nodes: parsed.nodes, closed: false })
      const last = parsed.nodes.length - 1
      open.push({ pathId: p.id, nodeIdx: last, x: parsed.nodes[last].x, y: parsed.nodes[last].y, nodes: parsed.nodes, closed: false })
    }
  }
  // Open endpoints first, so the cap only ever bites into closed-path nodes —
  // and when it does bite, it keeps the ones NEAREST the node being dragged.
  // Truncating in document order would have thinned out exactly the region the
  // user was aiming at while keeping rings on the far side of the stock.
  if (open.length >= MAX_CROSS_PATH_ENTRIES) return open
  const budget = MAX_CROSS_PATH_ENTRIES - open.length
  if (closed.length > budget && view) {
    const { x, y } = view.near
    closed.sort((a, b) => ((a.x - x) ** 2 + (a.y - y) ** 2) - ((b.x - x) ** 2 + (b.y - y) ** 2))
  }
  return [...open, ...closed.slice(0, budget)]
}

/**
 * The same target, moved to whichever node of its path is actually nearest
 * `to` — which is what lets `collectCrossPathEntries` draw a thinned set of
 * rings without changing where a weld lands. One pass over one path, and only
 * once a target has been picked, so the cost does not scale with the document.
 *
 * Open paths are left alone: only their two endpoints may be joined to, and
 * both are always offered.
 */
export function refineCrossEntry(entry: CrossPathEntry, to: { x: number; y: number }): CrossPathEntry {
  if (!entry.closed) return entry
  let bestIdx = entry.nodeIdx
  let bestD2 = Infinity
  for (let j = 0; j < entry.nodes.length; j++) {
    const d2 = (entry.nodes[j].x - to.x) ** 2 + (entry.nodes[j].y - to.y) ** 2
    if (d2 < bestD2) { bestD2 = d2; bestIdx = j }
  }
  if (bestIdx === entry.nodeIdx) return entry
  return { ...entry, nodeIdx: bestIdx, x: entry.nodes[bestIdx].x, y: entry.nodes[bestIdx].y }
}

export function useNodeEditSession() {
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)

  // Live editable copy of the path's nodes
  const [editNodes, editNodesRef, setEditNodes] = useRefState<PathNode[]>([])
  const [editClosed, editClosedRef, setEditClosed] = useRefState(false)

  const prevNodeEditPathIdRef = useRef<string | null>(null)
  const editDragInitRef = useRef<{ initialNodes: PathNode[]; startCNC: { x: number; y: number } } | null>(null)
  const [hoveredEditNode, hoveredEditNodeRef, setHoveredEditNode] = useRefState<number | null>(null)
  const [dragNodeIdx, setDragNodeIdx] = useState<number | null>(null)
  const [hoverSegIdx, hoverSegIdxRef, setHoverSegIdx] = useRefState<number | null>(null)
  const [weldTargetIdx, weldTargetIdxRef, setWeldTargetIdx] = useRefState<number | null>(null)
  const [connectSource, connectSourceRef, setConnectSource] = useRefState<number | null>(null)
  const [connectPreviewTo, setConnectPreviewTo] = useState<{ x: number; y: number } | null>(null)
  const [connectSnapTargetIdx, setConnectSnapTargetIdx] = useState<number | null>(null)
  const crossPathEntriesRef = useRef<CrossPathEntry[]>([])
  const [crossPathCandidates, setCrossPathCandidates] = useState<CrossPathEntry[]>([])
  const [crossPathWeldTarget, crossPathWeldTargetRef, setCrossPathWeldTarget] = useRefState<CrossPathEntry | null>(null)
  const localPast = useRef<NodeEditEntry[]>([])
  const localFuture = useRef<NodeEditEntry[]>([])

  // The eight-line "clear connect state" block used to be repeated at six call
  // sites — the canonical version.
  const clearConnectState = useCallback(() => {
    setConnectSource(null)
    setConnectPreviewTo(null)
    setConnectSnapTargetIdx(null)
    setCrossPathWeldTarget(null)
    setCrossPathCandidates([])
    crossPathEntriesRef.current = []
  }, [setConnectSource, setCrossPathWeldTarget])

  // Snapshot the PRE-gesture nodes+closed. `globalStep: true` for gestures that
  // also write one atomic global history entry (join/split) — see NodeEditEntry.
  const pushLocalUndo = useCallback((nodes: PathNode[], closed: boolean, globalStep = false) => {
    pushLocalHistory(localPast.current, { nodes, closed, globalStep })
    localFuture.current = []
    useUIStore.getState().setNodeEditHistoryFlags(true, false)
  }, [])

  // True while THIS component is writing to the paths store mid-session (join/
  // split gestures and their local undo/redo), so the external-change
  // subscription below doesn't re-parse our own writes.
  const selfWriteRef = useRef(false)

  const localUndo = useCallback(() => {
    if (localPast.current.length === 0) return
    const entry = localPast.current[localPast.current.length - 1]
    localFuture.current = [
      { nodes: editNodesRef.current, closed: editClosedRef.current, globalStep: entry.globalStep },
      ...localFuture.current,
    ]
    localPast.current = localPast.current.slice(0, -1)
    if (entry.globalStep) {
      // Replay the gesture's atomic timeline event: restores the joined-away /
      // split-off path and the edited path's stored d in one step. Guarded so
      // the store subscription doesn't clobber the local restore below.
      selfWriteRef.current = true
      useTimelineStore.getState().undo()
      selfWriteRef.current = false
    }
    setEditNodes(entry.nodes)
    setEditClosed(entry.closed)
    useUIStore.getState().setNodeEditHistoryFlags(localPast.current.length > 0, true)
  }, [])

  const localRedo = useCallback(() => {
    if (localFuture.current.length === 0) return
    const entry = localFuture.current[0]
    pushLocalHistory(localPast.current, { nodes: editNodesRef.current, closed: editClosedRef.current, globalStep: entry.globalStep })
    localFuture.current = localFuture.current.slice(1)
    if (entry.globalStep) {
      selfWriteRef.current = true
      useTimelineStore.getState().redo()
      selfWriteRef.current = false
    }
    setEditNodes(entry.nodes)
    setEditClosed(entry.closed)
    useUIStore.getState().setNodeEditHistoryFlags(true, localFuture.current.length > 0)
  }, [])

  const commitEditNodes = useCallback((pid: string, nodes: PathNode[]) => {
    if (!pid) return
    const path = usePathsStore.getState().paths.find((p) => p.id === pid)
    if (!path) return // path removed while editing (e.g. global undo) — nothing to commit
    if (nodes.length < 2) {
      usePathsStore.getState().deletePath(pid)
      return
    }
    const d = nodesToD(nodes, editClosedRef.current)
    if (d === path.d) return // unchanged (e.g. join already wrote this d) — no history entry
    usePathsStore.getState().batchUpdatePaths([{ id: pid, d, shapeParams: null }], 'points')
    regenerateAffected(pid)
  }, [])

  const exitNodeEdit = useCallback(() => {
    const { nodeEditPathId: pid, setNodeEditPathId } = useUIStore.getState()
    if (!pid) return
    setNodeEditPathId(null)  // useEffect handles commit + cleanup
  }, [])

  // Parse path nodes when entering node edit mode; commit + clean up on exit
  useEffect(() => {
    const prevId = prevNodeEditPathIdRef.current
    prevNodeEditPathIdRef.current = nodeEditPathId
    localPast.current = []
    localFuture.current = []
    if (!nodeEditPathId) {
      // Commit using the captured id — nodeEditPathId is already null in the store at this point
      if (prevId) commitEditNodes(prevId, editNodesRef.current)
      setEditNodes([])
      setEditClosed(false)
      clearConnectState()
      useUIStore.getState().setNodeEditUndoRedo(null, null)
      useUIStore.getState().setNodeEditHistoryFlags(false, false)
      return
    }
    const path = usePathsStore.getState().paths.find((p) => p.id === nodeEditPathId)
    if (!path) { setEditNodes([]); return }
    const { nodes, closed } = parseDToNodes(path.d)
    setEditNodes(nodes)
    setEditClosed(closed)
    useUIStore.getState().setNodeEditUndoRedo(localUndo, localRedo)
  }, [nodeEditPathId, localUndo, localRedo, commitEditNodes]) // eslint-disable-line react-hooks/exhaustive-deps

  // While a node-edit session is active, a global undo/redo can rewrite or remove
  // the edited path underneath us (e.g. undoing a cross-path join restores both
  // source paths). Re-sync the live editNodes from the store, or leave the
  // session if the path no longer exists. Our own mid-session writes are skipped
  // via selfWriteRef.
  useEffect(() => {
    if (!nodeEditPathId) return
    return usePathsStore.subscribe((s, prev) => {
      if (selfWriteRef.current) return
      if (s.paths === prev.paths) return
      const cur = s.paths.find((p) => p.id === nodeEditPathId)
      if (!cur) {
        // Path gone (undo past its creation / join) — abandon the session.
        // commitEditNodes finds no path on exit, so nothing is written back.
        useUIStore.getState().setNodeEditPathId(null)
        return
      }
      const prevPath = prev.paths.find((p) => p.id === nodeEditPathId)
      if (prevPath && prevPath.d === cur.d) return
      const { nodes, closed } = parseDToNodes(cur.d)
      setEditNodes(nodes)
      setEditClosed(closed)
      // Local snapshots and connect state reference the pre-undo geometry — drop them.
      localPast.current = []
      localFuture.current = []
      useUIStore.getState().setNodeEditHistoryFlags(false, false)
      clearConnectState()
    })
  }, [nodeEditPathId]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    editNodes, editNodesRef, setEditNodes,
    editClosed, editClosedRef, setEditClosed,
    hoveredEditNode, hoveredEditNodeRef, setHoveredEditNode,
    dragNodeIdx, setDragNodeIdx,
    hoverSegIdx, hoverSegIdxRef, setHoverSegIdx,
    weldTargetIdx, weldTargetIdxRef, setWeldTargetIdx,
    connectSource, connectSourceRef, setConnectSource,
    connectPreviewTo, setConnectPreviewTo,
    connectSnapTargetIdx, setConnectSnapTargetIdx,
    crossPathEntriesRef, crossPathCandidates, setCrossPathCandidates,
    crossPathWeldTarget, crossPathWeldTargetRef, setCrossPathWeldTarget,
    editDragInitRef, selfWriteRef,
    pushLocalUndo, localUndo, localRedo,
    commitEditNodes, exitNodeEdit, clearConnectState,
  }
}
