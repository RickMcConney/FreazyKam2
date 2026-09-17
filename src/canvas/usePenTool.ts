import { useCallback, useEffect, useRef, useState } from 'react'
import { useRefState } from './useRefState'
import { pushLocalHistory } from './localHistory'
import { useUIStore, type PenNode } from '../store/uiStore'

// Pen-tool session state: live segment preview, closing-hover flag, and the
// pen-local undo/redo stacks (registered as the toolbar/Ctrl+Z handler while
// the pen is active). Extracted from CanvasStage (tofix.md R3); the pen
// mousedown/move/up gesture logic stays in CanvasStage.
export function usePenTool() {
  const [livePen, setLivePen] = useState<{ anchor: { x: number; y: number }; handle: { x: number; y: number } | null } | null>(null)
  const [penClosing, penClosingRef, setPenClosing] = useRefState(false)
  const penPast = useRef<PenNode[][]>([])
  const penFuture = useRef<PenNode[][]>([])

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

  return { livePen, setLivePen, penClosing, penClosingRef, setPenClosing, penPast, penFuture, penUndo, penRedo }
}
