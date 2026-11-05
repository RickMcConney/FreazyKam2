import { useEffect } from 'react'
import { runPlan, type ConstraintPlan } from '../store/constraints'
import { bakePathsStep, usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { originWorldXY } from './layers/WorkpieceLayer'
import { nextStepPoint, nudgeStopDelta, snapAxisDelta, type SnapTargets } from './objectSnap'
import type { BBox } from './selectionUtils'
import { beginMoveSession, type Gesture } from './useGesture'

export function useNudge({ modeRef, setLiveTransform, setFollowTransforms, setSnapGuides, setLiveBBox }: Gesture) {
  // ARROW KEYS NUDGE THE SELECTION — 1 mm (0.1" in inch mode), Shift ×10, Alt ÷10.
  // A run of presses is ONE move: each press only previews (the same liveTransform
  // a drag uses, constraint followers included) and the bake lands once the keys go
  // quiet, so holding an arrow down neither floods the history with Move chips nor
  // regenerates every affected toolpath on each key repeat. Anything else — a click
  // anywhere, any other key, the window losing focus — commits the pending nudge
  // first, so an undo or a drag never starts on top of a half-done one.
  useEffect(() => {
    const NUDGE_COMMIT_MS = 400
    const DIRS: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
    }
    // A nudge does not snap within a window — it STOPS on a line it would cross
    // (`nudgeStopDelta`) — so its guides say EXACTLY aligned; the drag's 8 px
    // window would draw a guide under an edge still visibly short of the line.
    const ALIGNED_MM = 0.005
    type Pending = {
      ids: string[]; dx: number; dy: number; timer: number
      bbox: BBox | null
      plan: ConstraintPlan | null
      targets: SnapTargets
    }
    let pending: Pending | null = null
    // The guides OUTLIVE the commit: the bake lands just as the user is looking to
    // see whether the edges line up. There is no mouseup to end the gesture, so
    // they go on the next thing the user does instead — a click, another key,
    // leaving the window — or on the next press that aligns nothing.
    let guidesShown = false
    const clearGuides = () => {
      if (!guidesShown) return
      guidesShown = false
      setSnapGuides(null)
    }

    const flush = () => {
      if (!pending) return
      const { ids, dx, dy, timer } = pending
      window.clearTimeout(timer)
      pending = null
      bakePathsStep(ids, { kind: 'translate', dx, dy }, 'move')
      setLiveTransform(null)
      setFollowTransforms(null)
      setLiveBBox(null)
    }

    const onKey = (e: KeyboardEvent) => {
      // A modifier pressed mid-run changes the step, not the gesture.
      if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') return
      const dir = DIRS[e.key]
      if (!dir) { flush(); clearGuides(); return }
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if (e.ctrlKey || e.metaKey) return
      if (modeRef.current.type !== 'idle') return
      const ui = useUIStore.getState()
      if ((ui.activeTool !== 'select' && ui.activeTool !== 'region') || ui.nodeEditPathId) return
      const { selectedIds } = usePathsStore.getState()
      if (selectedIds.length === 0) return
      e.preventDefault()

      if (pending && (pending.ids.length !== selectedIds.length || pending.ids.some((id, i) => id !== selectedIds[i]))) flush()
      if (!pending) {
        // The same session a drag begins: the same targets to align to, the same followers.
        const { bbox, plan, snapTargets } = beginMoveSession(selectedIds)
        pending = { ids: selectedIds, dx: 0, dy: 0, timer: 0, bbox, plan, targets: snapTargets }
      }
      const base = useWorkpieceStore.getState().units === 'in' ? 2.54 : 1
      const stepMM = base * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
      const p = pending
      const b = p.bbox
      // Snap on, a press goes to the NEXT MULTIPLE OF THE STEP — measured as the
      // drag's grid snap measures it, the bbox's min corner from the stock origin —
      // and a guide line it would jump over on the way is a STOP. Measured off the
      // stock rather than off where the press started, a stop on a guide does not
      // shift the presses after it, and neither does the commit resetting dx to 0.
      // Snap off (S), a press is a plain step and goes straight through.
      const stepAxis = (axis: 0 | 1, cur: number): number => {
        const d = dir[axis]
        if (d === 0 || !b || !useUIStore.getState().snapEnabled) return cur + d * stepMM
        const { origin, widthMM, heightMM } = useWorkpieceStore.getState()
        const org = originWorldXY(origin, widthMM, heightMM)
        const [lo, hi, mid, o, targets] = axis === 0
          ? [b.minX, b.maxX, b.cx, org.x, p.targets.xs]
          : [b.minY, b.maxY, b.cy, org.y, p.targets.ys]
        const onStep = nextStepPoint(lo + cur - o, stepMM, d, ALIGNED_MM) + o - lo
        return nudgeStopDelta([lo, hi, mid], targets, cur, onStep, ALIGNED_MM)
      }
      // Rounded so ten 0.1 mm taps land on 1 mm, not 0.9999999999999999.
      p.dx = Math.round(stepAxis(0, p.dx) * 1e6) / 1e6
      p.dy = Math.round(stepAxis(1, p.dy) * 1e6) / 1e6

      setLiveTransform({ kind: 'translate', pathIds: new Set(p.ids), dx: p.dx, dy: p.dy })
      if (p.bbox) {
        const b = p.bbox
        setLiveBBox({ minX: b.minX + p.dx, minY: b.minY + p.dy, width: b.width, height: b.height })
        const ox = snapAxisDelta([b.minX + p.dx, b.maxX + p.dx, b.cx + p.dx], p.targets.xs, ALIGNED_MM)
        const oy = snapAxisDelta([b.minY + p.dy, b.maxY + p.dy, b.cy + p.dy], p.targets.ys, ALIGNED_MM)
        guidesShown = !!(ox || oy)
        setSnapGuides(guidesShown ? { x: ox?.guide, y: oy?.guide } : null)
      }
      setFollowTransforms(p.plan
        ? runPlan(p.plan, { dx: p.dx, dy: p.dy }).map((mv) => ({
          kind: 'translate' as const, pathIds: new Set(mv.pathIds), dx: mv.dx, dy: mv.dy,
        }))
        : null)
      window.clearTimeout(p.timer)
      p.timer = window.setTimeout(flush, NUDGE_COMMIT_MS)
    }

    // Capture phase, so the commit lands before App's Ctrl+Z handler or the
    // stage's mousedown ever sees the event.
    const commitAndClear = () => { flush(); clearGuides() }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', commitAndClear, true)
    window.addEventListener('blur', commitAndClear)
    return () => {
      commitAndClear()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', commitAndClear, true)
      window.removeEventListener('blur', commitAndClear)
    }
  }, [])
}
