import { useCallback, useEffect, useState } from 'react'
import type Konva from 'konva'
import { clockAssemblyFromPaths, clockMotionFromPaths, clockPlate, clockRoot, defaultLinkAngles, dragLinkAngle, linkAngleAt } from '../shapes/clockTrain'
import { clockSpecOf, setClockSpec, usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { CanvasMode, Gesture } from './useGesture'
import { useRefState } from './useRefState'

/** Arranging a clock's going train: dragging the joints of its linkage. */
export function useClockLinkage({ didDragRef, setMode }: Gesture) {
  // The linkage being arranged. Held HERE rather than in a store for the same
  // reason liveTransform is: it changes on every mouse move, and only the
  // committed value (on the clock's own chip) has to outlive the gesture.
  const [linkAngles, linkAnglesRef, setLinkAngles] = useRefState<number[] | null>(null)
  const [hoverLinkNode, setHoverLinkNode] = useState<number | null>(null)
  const clockLinkPathId = useUIStore((s) => s.clockLinkPathId)

  // The assembly and root the linkage drag works against — the same ones the
  // layer draws, so a joint lands where the cursor is rather than near it.
  const linkFrame = useCallback(() => {
    const st = usePathsStore.getState()
    const clockId = st.paths.find((p) => p.id === useUIStore.getState().clockLinkPathId)?.clockId
    if (!clockId) return null
    const assembly = clockAssemblyFromPaths(st.paths, clockId)
    if (assembly.length < 2) return null
    const wp = useWorkpieceStore.getState()
    const root = clockRoot(wp.widthMM, wp.heightMM, assembly[assembly.length - 1].params)
    // The motion work too, or its joint has no plate entry to be dragged around.
    return { clockId, assembly, motion: clockMotionFromPaths(st.paths, clockId), root }
  }, [])

  const handleLinkNodeDown = useCallback((nodeIdx: number, e: Konva.KonvaEventObject<MouseEvent>) => {
    e.cancelBubble = true
    didDragRef.current = false
    setHoverLinkNode(nodeIdx)
    setMode({ type: 'clocklink-drag', nodeIdx })
  }, [])

  /**
   * Swing one link so its far joint follows the cursor.
   *
   * The LENGTH is not negotiable — it is the centre distance the mesh runs at —
   * so the joint rides a circle about the arbor it hangs from and only the ANGLE
   * changes. `angles[k]` alone is written: everything toward the drive wheel then
   * translates rigidly (it is built off this joint with its own angles intact)
   * and everything toward the escapement stays exactly where it was. One drag,
   * one angle, which is what makes this arrangeable rather than whippy.
   */
  const onMoveClockLink = useCallback((m: Extract<CanvasMode, { type: 'clocklink-drag' }>, cnc: { x: number; y: number }, shift: boolean) => {
    const f = linkFrame()
    const cur = linkAnglesRef.current
    if (!f || !cur) return
    const plate = clockPlate(f.assembly, cur, f.motion)
    if (!plate) return
    // Shift snaps to 15° — an ANGLE snap, deliberately separate from the object
    // snap in uiStore, which is about edges lining up and means nothing here.
    const deg = dragLinkAngle(plate, f.root, m.nodeIdx, cnc, shift ? 15 : 0)
    if (deg === null) return
    const next = cur.slice()
    next[m.nodeIdx] = deg
    setLinkAngles(next)
  }, [linkFrame, linkAnglesRef, setLinkAngles])

  /** Write the arrangement onto the clock's parts, which is where its spec
   *  lives. No geometry moves — the parts are still cut flat where they lie — so
   *  there is nothing to regenerate and nothing to record. */
  const commitClockLink = useCallback(() => {
    const f = linkFrame()
    const angles = linkAnglesRef.current
    if (!f || !angles) return
    const spec = clockSpecOf(usePathsStore.getState().paths, f.clockId)
    if (spec) setClockSpec(f.clockId, { ...spec, linkAngles: angles })
  }, [linkFrame, linkAnglesRef])

  // Entering linkage mode takes a working copy of the clock's committed angles;
  // leaving drops it. Defaults fill in per element, so a clock that predates the
  // field arranges from the lean it was drawn with rather than from nothing.
  useEffect(() => {
    if (!clockLinkPathId) { setLinkAngles(null); setHoverLinkNode(null); return }
    const allPaths = usePathsStore.getState().paths
    const clockId = allPaths.find((p) => p.id === clockLinkPathId)?.clockId
    const stored = clockSpecOf(allPaths, clockId)?.linkAngles
    const n = defaultLinkAngles().length
    setLinkAngles(Array.from({ length: n }, (_, i) => (linkAngleAt(stored, i) * 180) / Math.PI))
  }, [clockLinkPathId, setLinkAngles])

  const finishClockLinkDrag = useCallback(() => {
    setMode({ type: 'idle' })
    commitClockLink()
  }, [setMode, commitClockLink])

  return { linkAngles, hoverLinkNode, handleLinkNodeDown, onMoveClockLink, finishClockLinkDrag }
}
