import { useCallback, useEffect } from 'react'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useTabStore } from '../store/tabStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { regenerateAffected } from '../cam/regenerate'
import { stripAt, type StripPick } from '../cam/bridgePick'
import { cornerClearMM } from '../cam/bridges'
import { tabTAt, tabPointAt } from '../cam/tabPlacement'
import { tabOutline } from '../cam/stlOutline'
import type { ImportedPath } from '../store/pathsStore'
import { holdIndexNow, cutterRadiusFor, addStrip } from '../tools/bridgesRun'
import { closestVisiblePath, onCanvas, type FlatOf } from './pathHit'
import type { CanvasView } from './useCanvasView'
import { screenToCNC } from './viewport'

// The Tabs form's CLICK TO PLACE (uiStore.tabPlace). It places the kind the form's Hold With
// toggle is on — never decides for itself:
//
//   - STRIPS: a strip from the outline nearest the click, square across the gap to the part
//     beyond it (cam/bridgePick — ends off the corners, the same kind of join the network
//     lays); or, where no part is in reach in front, a stub into the open stock, which is
//     joined to the sheet's edge. Strips join only PARTS — closed outlines not inside another (`holdableParts`),
//     as the network's do.
//   - TABS: a tab on the outline nearest the click, off its corners.
//
// Hovering shows where, as a ghost (`holdPreview`, HoldPreviewLayer), so the click is never
// a guess.

/** The widest gap a click joins across, and how far round the outline it may slide to clear a corner. */
const REACH_MM = 30
const GRAB_PX = 12

type HoldPlan =
  | { kind: 'strip'; pick: StripPick; widthMM: number; heightMM: number }
  | { kind: 'tab'; pathId: string; d: string; t: number; x: number; y: number; tx: number; ty: number }
  | null

// The cutter radius the corner clearance is judged with — the widest one cutting round any
// part, worked out once per index (it walks every op).
let radiusMemo: { index: object; r: number } | null = null

function planAt(x: number, y: number, scale: number, getFlat: FlatOf): HoldPlan {
  const place = useUIStore.getState().tabPlace
  if (!place) return null
  const ix = holdIndexNow()
  const bridges = useWorkpieceStore.getState().bridges
  // A strip added to a set is the set's width: they are one setting.
  const widthMM = bridges?.widthMM ?? place.widthMM
  const heightMM = bridges?.heightMM ?? place.heightMM
  if (place.kind === 'bridges') {
    if (ix.parts.length === 0) return null
    if (radiusMemo?.index !== ix) radiusMemo = { index: ix, r: cutterRadiusFor(ix.parts.map((p) => p.id)) }
    const toolRadiusMM = radiusMemo.r
    const searchMM = 2 * cornerClearMM(widthMM, toolRadiusMM) + 2
    const pick = stripAt(ix, x, y, { widthMM, toolRadiusMM, reachMM: REACH_MM, searchMM, pickMM: REACH_MM })
    // Only where the click IS — on the strip, give or take the slide off a corner. Without
    // it a click out in open stock reached the nearest outline 30 mm away and joined it to
    // whatever lay beyond.
    if (pick && distToSeg(x, y, pick.line) <= GRAB_PX / scale + widthMM / 2 + searchMM) {
      return { kind: 'strip', pick, widthMM, heightMM }
    }
    // No part across from the outline: a stub into the open stock — but only for a click ON
    // the outline (or on where the stub would go), not one out in the middle of the waste.
    const stub = stripAt(ix, x, y, { widthMM, toolRadiusMM, reachMM: REACH_MM, searchMM, pickMM: REACH_MM, toPart: 'frame' })
    if (stub && distToSeg(x, y, stub.line) <= GRAB_PX / scale + widthMM / 2 + searchMM) {
      return { kind: 'strip', pick: stub, widthMM, heightMM }
    }
    return null
  }
  // A model or a picture takes tabs too: a 3D Profile round it leaves them (cam/profile3dTabs).
  const paths = usePathsStore.getState().paths.filter(onCanvas)
  // A model is picked by, and tabbed on, its silhouette (cam/stlOutline), not its box.
  const outlineOf = (p: ImportedPath) => (p.stlSrc && p.stlModelBounds ? tabOutline(p) : getFlat(p, 0.05))
  const hit = closestVisiblePath(x, y, paths, GRAB_PX / scale, outlineOf)
  if (!hit) return null
  const polys = outlineOf(hit)
  const t = tabTAt(polys, x, y, place.lengthMM)
  if (t === null) return null
  const at = tabPointAt(polys, t)
  return at ? { kind: 'tab', pathId: hit.id, d: hit.d, t, ...at } : null
}

function distToSeg(x: number, y: number, l: { x1: number; y1: number; x2: number; y2: number }): number {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1, l2 = dx * dx + dy * dy
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - l.x1) * dx + (y - l.y1) * dy) / l2)) : 0
  return Math.hypot(x - l.x1 - u * dx, y - l.y1 - u * dy)
}

export function useTabPlaceTool({ stageRef, viewportRef }: CanvasView, getFlat: FlatOf) {
  const active = useUIStore((s) => s.tabPlace !== null && s.tabsFormActive)

  // The ghost follows the pointer. Konva's own namespaced listener, so it neither depends on
  // nor disturbs the stage's mode machinery; one plan per animation frame however fast the
  // mouse moves.
  useEffect(() => {
    const stage = stageRef.current
    if (!active || !stage) return
    let frame = 0
    const onMove = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const p = stage.getPointerPosition()
        const ui = useUIStore.getState()
        if (!p || !ui.tabPlace) return
        const vp = viewportRef.current
        const cnc = screenToCNC(p.x, p.y, vp)
        const plan = planAt(cnc.x, cnc.y, vp.scale, getFlat)
        const place = ui.tabPlace
        ui.setHoldPreview(!plan ? null
          : plan.kind === 'strip' ? { kind: 'strip', ...plan.pick.line, widthMM: plan.widthMM }
            : { kind: 'tab', x: plan.x, y: plan.y, tx: plan.tx, ty: plan.ty, lengthMM: place.lengthMM, heightMM: place.heightMM })
      })
    }
    const onLeave = () => useUIStore.getState().setHoldPreview(null)
    stage.on('mousemove.tabplace', onMove)
    stage.on('mouseleave.tabplace', onLeave)
    return () => {
      cancelAnimationFrame(frame)
      stage.off('mousemove.tabplace')
      stage.off('mouseleave.tabplace')
      useUIStore.getState().setHoldPreview(null)
    }
  }, [active, stageRef, viewportRef, getFlat])

  /** A press while click-to-place is on: place what the ghost shows. True when it took the press. */
  const placeHoldAt = useCallback((sx: number, sy: number): boolean => {
    const ui = useUIStore.getState()
    if (!ui.tabPlace || !ui.tabsFormActive) return false
    const vp = viewportRef.current
    const cnc = screenToCNC(sx, sy, vp)
    const plan = planAt(cnc.x, cnc.y, vp.scale, getFlat)
    if (plan?.kind === 'strip') addStrip(plan.pick.line, plan.pick.a, plan.pick.b, plan.widthMM, plan.heightMM)
    else if (plan?.kind === 'tab') {
      useTabStore.getState().addTab(plan.pathId, plan.t, ui.tabPlace.lengthMM, ui.tabPlace.heightMM)
      regenerateAffected(plan.pathId)
    }
    ui.setHoldPreview(null)
    // A press in place mode never selects or drags, whether or not it placed anything.
    return true
  }, [viewportRef, getFlat])

  return { placeHoldAt }
}
