import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { allAnchorCandidates, bodyKeyOf, bodyPathsOf, measureBetween, nearestCandidate, type AnchorCandidate } from '../store/constraints'
import { useConstraintsStore } from '../store/constraintsStore'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { uid } from '../uid'
import { closestVisiblePath, onCanvas, type FlatOf } from './pathHit'
import type { CanvasView } from './useCanvasView'
import { beginMoveSession, EMPTY_BBOX, type Gesture } from './useGesture'
import { useRefState } from './useRefState'
import { screenToCNC, type Viewport } from './viewport'

const PICK_SHOW_PX = 70      // screen px within which a part offers its constraint points
export const PICK_HOT_PX = 16       // screen px within which one of those points would be taken by a click

export function useConstrainTool(g: Gesture, { stageRef, viewportRef }: CanvasView, getFlat: FlatOf, activeTool: string) {
  const { modeRef, didDragRef, constraintPlanRef, setPickDrag, setMode, beginGesture, endGesture } = g
  const paths = usePathsStore((s) => s.paths)
  // ── The Constrain tool ─────────────────────────────────────────────────────
  // Two clicks: a point on one part, a point on another. `pickCandidates` is
  // what the hovered part offers, `pickHot` the one a click would take, and
  // `pickHeld` the first point once it has been taken. The tool STAYS ON after
  // placing one, so a row of holes is one gesture each; Escape drops a half-made
  // constraint, and Escape again leaves the tool.
  //
  // THE SECOND CLICK MAY BE A DRAG, which is the other half of the gesture: a
  // press on a point of another part moves that part, with the dimension and its
  // numbers live on screen, and the constraint is created holding wherever it is
  // let go. Placing by eye and placing by number are the same gesture then —
  // drag it roughly right, then type the figure into the row that has just taken
  // the keyboard. It borrows the `move` mode to do it (see `CanvasMode`).
  const [pickCandidates, setPickCandidates] = useState<AnchorCandidate[]>([])
  const [pickHot, pickHotRef, setPickHot] = useRefState<AnchorCandidate | null>(null)
  const [pickHeld, pickHeldRef, setPickHeld] = useRefState<AnchorCandidate | null>(null)

  // ENTERING THE TOOL CLEARS THE SELECTION, and that is not tidiness: a selected
  // shape carries resize/rotate handles in the interactive layer ABOVE the
  // stage, and those swallow the click before the tool ever sees it — so the
  // points nearest a selected part were exactly the ones that could not be
  // picked. The handles are suppressed below as well; this is the other half,
  // and it also leaves the canvas clean to work on.
  useEffect(() => {
    const ui = useUIStore.getState()
    if (activeTool !== 'constrain') {
      setPickHeld(null)
      setPickCandidates([])
      setPickDrag(null)
      ui.setFocusConstraint(null)
      ui.setConstrainSubject([])
      return
    }
    // WHAT WAS SELECTED IS REMEMBERED FIRST. Clearing the selection also cleared
    // the panel's rows, so pressing the button with the part you were about to
    // work on selected emptied the very list you had just been reading. The
    // subject outlives the selection; see `constrainSubjectIds`.
    ui.setConstrainSubject(usePathsStore.getState().selectedIds)
    usePathsStore.getState().selectPath(null)
  }, [activeTool, setPickHeld])

  // Hover for the Constrain tool: which part is under the pointer, what points
  // it offers, and which of them a click would take. Recomputed per frame, which
  // is affordable because it only ever looks at ONE path — the one the proximity
  // search already found — rather than at the whole drawing.
  // Every pickable point in the drawing, built once and reused for the whole
  // session — one bbox flatten per body, not one per frame.
  const allCandidates = useMemo(
    () => (activeTool === 'constrain' || activeTool === 'measure' ? allAnchorCandidates(paths) : []),
    [activeTool, paths])
  // Mirrored into a ref, and the hover handler reads THAT. `handleMouseMove` is
  // one big memoized dispatcher, so a per-frame handler reached through it is
  // only as fresh as that dispatcher's dependency list — and a candidate list
  // captured in a closure goes stale the moment anything moves, which showed as
  // markers sitting where each part was when it was drawn. The dependency is
  // listed as well; this is what makes it not matter if the next one is missed.
  const allCandidatesRef = useRef(allCandidates)
  allCandidatesRef.current = allCandidates

  // Hover for the Constrain tool.
  //
  // SEARCHED AS POINTS, NOT AS PATHS. Finding the path under the cursor first
  // and then offering its anchors only worked while the cursor was near an
  // OUTLINE, so the centre of a big circle and the corners of a large rectangle
  // could not be reached at all — they are nowhere near the geometry they belong
  // to, and zooming in made it worse. Two radii, both in SCREEN pixels so they
  // feel the same at every zoom: a generous one decides whose points to show, so
  // a part lights up as it is approached, and a tight one decides which point a
  // click would actually take.
  const onMoveConstrainHover = useCallback((cnc: { x: number; y: number }, vp: Viewport) => {
    const all = allCandidatesRef.current
    const near = nearestCandidate(all, cnc.x, cnc.y, PICK_SHOW_PX / vp.scale)
    // Falling back to the outline keeps a part's points visible while the cursor
    // is over its edge but not near any one of them.
    let bodyKey = near?.body ?? null
    if (!bodyKey) {
      const { paths: live } = usePathsStore.getState()
      const hit = closestVisiblePath(cnc.x, cnc.y, live.filter((p) => onCanvas(p)), 12 / vp.scale, (p) => getFlat(p, 0.05))
      const self = hit ? live.find((p) => p.id === hit.id) : undefined
      bodyKey = self ? bodyKeyOf(self) : null
    }
    const list = bodyKey ? all.filter((c) => c.body === bodyKey) : []
    setPickCandidates(list)
    setPickHot(nearestCandidate(list, cnc.x, cnc.y, PICK_HOT_PX / vp.scale))
  }, [getFlat, setPickHot])

  /**
   * Make the constraint between two picked points, from where the parts stand
   * NOW.
   *
   * Read off the live store rather than off the candidates' own coordinates:
   * those were measured when the markers were drawn, and the second point may
   * since have been dragged and baked. Same reason `measureBetween` exists at
   * all — what is created is what is already there.
   */
  const commitConstraint = useCallback((held: AnchorCandidate, hot: AnchorCandidate) => {
    const ui = useUIStore.getState()
    const paths = usePathsStore.getState().paths
    const { widthMM, heightMM } = useWorkpieceStore.getState()
    const now = measureBetween(paths, held.ref, hot.ref, { widthMM, heightMM })
    if (!now) { setPickHeld(null); return }
    const id = uid('con')
    // ALIGNMENT COMES WITH IT. A follower that does not turn with the part
    // holding it is the surprising case — the chain is meant to behave like the
    // group the user thinks it is — and holding the angle the parts ALREADY
    // stand at moves nothing, so this is free until something is rotated. Not
    // against the stock, which does not turn.
    const align = held.ref.kind === 'stock' || hot.ref.kind === 'stock'
      ? {} : { alignDeg: now.alignDeg }
    useConstraintsStore.getState().addConstraint(ui.constrainMode === 'xy'
      ? { id, mode: 'xy', from: held.ref, to: hot.ref, offsetXMM: now.offsetXMM, offsetYMM: now.offsetYMM, ...align }
      : { id, from: held.ref, to: hot.ref, distanceMM: now.distanceMM, angleDeg: now.angleDeg, ...align })
    setPickHeld(null)
    // Hand the keyboard to the new constraint's first number — two clicks and
    // then type, without reaching for the sidebar. Deliberately WITHOUT
    // selecting the two parts: a selection puts handles back over them and the
    // next pick cannot get through. The panel finds the constraint through
    // `focusConstraintId` instead, which is what that field is for.
    ui.setFocusConstraint(id)
  }, [setPickHeld])

  /** Which body a picked point belongs to, or null for a stock edge. */
  const bodyOfRef = useCallback((r: AnchorCandidate['ref']): string | null => {
    if (r.kind === 'stock') return null
    const p = usePathsStore.getState().paths.find((q) => q.id === r.id)
    return p ? bodyKeyOf(p) : null
  }, [])

  /** Take a point. The second one creates the constraint. */
  const onConstrainClick = useCallback(() => {
    const hot = pickHotRef.current
    if (!hot) return
    const held = pickHeldRef.current
    if (!held) {
      // A new pick supersedes the last constraint's row: `focusConstraintId` is
      // what keeps that row on screen with nothing selected, so it has to go
      // when the user moves on, or the panel would show a stale one while the
      // next dimension is being drawn.
      useUIStore.getState().setFocusConstraint(null)
      setPickHeld(hot)
      return
    }
    // Two points on the SAME body is a measurement, not a constraint — a part
    // cannot hold itself at a distance from itself, and the solver ignores it.
    // Treat the second click as re-picking the first instead of making a dud.
    const heldBody = bodyOfRef(held.ref)
    if (heldBody !== null && heldBody === bodyOfRef(hot.ref)) { setPickHeld(hot); return }
    commitConstraint(held, hot)
  }, [pickHotRef, pickHeldRef, setPickHeld, commitConstraint, bodyOfRef])

  // THE SECOND POINT MAY BE DRAGGED THERE. Once the first point is down, a press on a point
  // of ANOTHER part starts moving that part, and mouseup creates the constraint holding
  // wherever it was let go — so an offset can be dialled in by eye, with the numbers live on
  // the dimension, instead of being placed and then typed. A press that never moves is still
  // a click and still just takes the point (see `handleMouseUp`), so nothing about the
  // two-click gesture changes.
  const onConstrainPress = useCallback(() => {
    didDragRef.current = false
    const heldPick = pickHeldRef.current
    const hotPick = pickHotRef.current
    const hotRef = hotPick?.ref
    const heldBody = heldPick ? bodyOfRef(heldPick.ref) : null
    const hotBody = hotPick ? bodyOfRef(hotPick.ref) : null
    if (heldPick && hotPick && hotRef && hotRef.kind !== 'stock' && hotBody !== null && hotBody !== heldBody) {
      const stagePointer = stageRef.current?.getPointerPosition()
      const vp = viewportRef.current
      if (stagePointer) {
        const cnc = screenToCNC(stagePointer.x, stagePointer.y, vp)
        const { paths: allPaths } = usePathsStore.getState()
        // The whole BODY, which is the unit a constraint moves — dragging a
        // gear's rim away from its bore would take the gear apart.
        const moveIds = bodyPathsOf(allPaths, hotRef.id).map((p) => p.id)
        if (moveIds.length > 0) {
          const session = beginMoveSession(moveIds)
          constraintPlanRef.current = session.plan
          setPickDrag(null)
          beginGesture({
            type: 'move', pathIds: moveIds, startCNC: cnc, snapTargets: session.snapTargets,
            initBbox: session.bbox ?? EMPTY_BBOX,
            pick: { held: heldPick, hot: hotPick },
          })
          return
        }
      }
    }
    onConstrainClick()
    setMode({ type: 'idle' })
  }, [didDragRef, pickHeldRef, pickHotRef, bodyOfRef, stageRef, viewportRef, constraintPlanRef,
      setPickDrag, beginGesture, onConstrainClick, setMode])

  /** The drag of a second point has landed: the constraint holds wherever it stopped. */
  const landDraggedPoint = useCallback((pick: { held: AnchorCandidate; hot: AnchorCandidate }) => {
    commitConstraint(pick.held, pick.hot)
    // The markers were measured before the part moved, so every one of them
    // is now in the wrong place. Dropped rather than left to the next
    // mousemove, which is only "immediately" if the pointer moves at all.
    setPickCandidates([])
    setPickHot(null)
  }, [commitConstraint, setPickHot])

  /** Escape: a half-made constraint goes first, and the tool stays on. */
  const escapeConstrain = useCallback((): boolean => {
    if (!pickHeldRef.current) return false
    // Same two-stage Escape the pen has, and for the same reason — the commonest
    // thing to want out of is the gesture, not the tool. A drag in flight is part
    // of that gesture: dropping the preview without dropping the mode would leave
    // the part hanging at an offset nothing will ever bake.
    if (modeRef.current.type === 'move' && modeRef.current.pick) endGesture()
    setPickDrag(null)
    setPickHeld(null)
    return true
  }, [pickHeldRef, modeRef, endGesture, setPickDrag, setPickHeld])

  /** Leaving the tool, or its gesture: nothing half-made and no markers left behind. */
  const dropPicks = useCallback(() => {
    setPickHeld(null)
    setPickCandidates([])
  }, [setPickHeld])

  return {
    pickCandidates, pickHot, pickHeld, pickHeldRef, setPickHeld, allCandidatesRef,
    onMoveConstrainHover, onConstrainClick, onConstrainPress, landDraggedPoint, escapeConstrain, dropPicks,
  }
}
