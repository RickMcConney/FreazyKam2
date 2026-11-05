import { usePathsStore, expandUserGroups } from '../store/pathsStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { onCanvas } from './pathHit'
import { dragBoxEncloses, getBBox, isRegistrationPath, locationOrder, wholeGroupsOnly } from './selectionUtils'
import { screenToCNC, type Viewport } from './viewport'

export interface DragBox { sx: number; sy: number; ex: number; ey: number; op: 'replace' | 'add' | 'remove' }

/** A released drag box becomes the selection. */
export function applyDragBox(dragBox: DragBox, vp: Viewport) {
  const { sx, sy, ex, ey } = dragBox
  const x1 = Math.min(sx, ex), x2 = Math.max(sx, ex)
  const y1 = Math.min(sy, ey), y2 = Math.max(sy, ey)

  // Convert drag box to CNC bounds
  const cncMin = screenToCNC(x1, y2, vp)  // y2 is lower on screen = lower CNC y
  const cncMax = screenToCNC(x2, y1, vp)  // y1 is higher on screen = higher CNC y

  // WHICH WAY THE BOX WAS DRAWN CHOOSES WHAT IT CATCHES — the CAD
  // convention, and the reason for it is that on a crowded drawing the two
  // questions are genuinely different: "everything this line runs across"
  // and "these things and nothing they overlap". Drawn rightwards it
  // catches anything TOUCHED, which is what it always did; drawn back to
  // the left it catches only what is wholly INSIDE. Taken from x alone,
  // not from the diagonal, so every drag has an answer — a box dragged
  // straight down has no other axis to ask, and the hand remembers left
  // and right rather than a quadrant.
  const enclose = dragBoxEncloses(dragBox)

  const { paths: allPaths } = usePathsStore.getState()
  const caught = allPaths.filter((p) => {
    if (!onCanvas(p)) return false
    // Dowel and tile-pin holes are clicked, never boxed (isRegistrationPath).
    if (isRegistrationPath(p)) return false
    // The exact, cached box: the same one the selection handles draw, so a
    // box that visibly encloses a part's handles catches it.
    const bb = getBBox(p.d)
    if (!bb) return false
    const { minX, minY, maxX, maxY } = bb
    return enclose
      ? minX >= cncMin.x && maxX <= cncMax.x && minY >= cncMin.y && maxY <= cncMax.y
      : minX <= cncMax.x && maxX >= cncMin.x && minY <= cncMax.y && maxY >= cncMin.y
  })
  // Catching part of a group catches all of it — same rule as a click.
  const ids = expandUserGroups(caught.map((p) => p.id), allPaths)
  // …which is exactly what an ENCLOSING box must not do. A group is ONE
  // object, so "wholly inside" is a question about the whole of it: expand
  // first (a group half in the box would otherwise come back as its
  // enclosed parts, which is not a thing the user can see or click), then
  // drop any group with a part left outside. Hidden members are not in the
  // running either way, so they cannot hold a group out of the selection.
  // In LOCATION order, bottom left to top right: a box has no picks to record,
  // and the forms cut in selection order (see locationOrder).
  const boxed = enclose ? wholeGroupsOnly(ids, caught, allPaths) : ids
  const ps = usePathsStore.getState()
  const order = (list: string[]) => locationOrder(list, allPaths, useWorkpieceStore.getState())
  if (dragBox.op === 'replace') {
    ps.setLocationSelection(order(boxed))
  } else {
    // Shift adds, Alt removes. A selection that was itself a box's (or is
    // empty) stays in location order, re-ordered over what it now holds; one
    // made by picking keeps its picks, with what a box adds after them.
    const base = ps.selectedIds
    const wasLocation = base.length === 0 || ps.locationSelection === base
    const boxedSet = new Set(boxed)
    if (dragBox.op === 'add') {
      const have = new Set(base)
      const added = boxed.filter((id) => !have.has(id))
      if (wasLocation) ps.setLocationSelection(order([...base, ...added]))
      else ps.setSelectedIds([...base, ...order(added)])
    } else {
      const kept = base.filter((id) => !boxedSet.has(id))
      if (wasLocation && kept.length) ps.setLocationSelection(order(kept))
      else ps.setSelectedIds(kept)
    }
  }
}
