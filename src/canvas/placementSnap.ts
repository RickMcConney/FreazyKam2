import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { resolveMoveSnap } from './gestureMath'
import type { SnapGuides } from './layers/SnapGuideLayer'
import { collectSnapTargets, type SnapTargets } from './objectSnap'
import { onCanvas } from './pathHit'
import type { BBox } from './selectionUtils'
import { OBJECT_SNAP_PX, snapOptions } from './useGesture'
import type { Viewport } from './viewport'

type Pt = { x: number; y: number }

// PLACING SOMETHING THAT FOLLOWS THE CURSOR — the shape tool's hover and the stamp
// (Cmd+D) — snaps exactly as a drag of a placed shape does, so the two cannot learn
// different rules. Shared here rather than in either hook.

// What a placement snaps to: every visible path's edges, centres and corners, and the
// stock's. Unlike a drag it EXCLUDES nothing — a copy butted against its own original
// is the commonest thing a stamp is for. Rebuilt only when the paths or the stock change.
let cache: { paths: unknown; w: number; h: number; targets: SnapTargets } | null = null
export function placementSnapTargets(): SnapTargets {
  const paths = usePathsStore.getState().paths
  const { widthMM, heightMM } = useWorkpieceStore.getState()
  if (cache && cache.paths === paths && cache.w === widthMM && cache.h === heightMM) return cache.targets
  const targets = collectSnapTargets(paths.filter(onCanvas), { widthMM, heightMM }, snapOptions())
  cache = { paths, w: widthMM, h: heightMM, targets }
  return targets
}

/** The OFFSET to give a thing whose box is `ib` and whose corners are `moving` (both
 *  where it stands now) so that its `anchor` follows the cursor `raw` — snapped the
 *  way resolveMoveSnap snaps a drag (corner onto corner, alignment, equal spacing,
 *  grid), with the guides to draw. The grid takes the ANCHOR, not the box corner a
 *  drag snaps: for a shape that is where a click has always centred it. */
export function placeByAnchor(
  ib: BBox, moving: Pt[], anchor: Pt, raw: Pt, vp: Viewport, snapCNC: (p: Pt) => Pt,
): { offset: Pt; guides: SnapGuides | null } {
  const r = resolveMoveSnap(ib, raw.x - anchor.x, raw.y - anchor.y,
    { ...placementSnapTargets(), moving }, OBJECT_SNAP_PX / vp.scale, useUIStore.getState().snapEnabled,
    (p) => {
      // p is the box's min corner at the trial offset; snap the anchor and carry it back.
      const s = snapCNC({ x: p.x - ib.minX + anchor.x, y: p.y - ib.minY + anchor.y })
      return { x: s.x - anchor.x + ib.minX, y: s.y - anchor.y + ib.minY }
    })
  return { offset: { x: r.dx, y: r.dy }, guides: r.guides }
}

/** Guides are gesture state on the stage, so a hover only touches them when it has
 *  something to say — a null every frame would still re-render the stage. */
export function guideSetter(setSnapGuides: (g: SnapGuides | null) => void) {
  let had = false
  return {
    show(g: SnapGuides | null) {
      if (!g && !had) return
      had = !!g
      setSnapGuides(g)
    },
    /** Something else cleared them (endGesture); forget we had any. */
    forget() { had = false },
    clear() { if (had) { had = false; setSnapGuides(null) } },
  }
}
