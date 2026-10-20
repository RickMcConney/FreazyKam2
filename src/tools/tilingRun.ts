// Writing a TILING setting (cam/tiling) and keeping its pin holes in step with it.
//
// The pin holes are ordinary paths, one "Tile Pins" path of two circles per station, so
// they can be drilled from the Tiling form or the Drill form like any other holes. Every
// change to the seams or the pins moves them — and adds or removes stations when the tile
// count changes — in the SAME undo step as the setting: the setting is written straight
// to the store and the path edit records the step, and the timeline keeps the stores as
// they stood before the first write of a turn (see the Double-Sided form, which does the
// same for its dowel holes).

import { useWorkpieceStore } from '../store/workpieceStore'
import { usePathsStore, type PathUpdate } from '../store/pathsStore'
import type { ImportedPath } from '../importers/svgImporter'
import { nextPathColor } from '../importers/svgImporter'
import { generateShapeD } from '../shapes/shapeGenerators'
import { stationPins, tileCount, type Tiling } from '../cam/tiling'
import { uid } from '../uid'
import { isTilePinPath } from '../canvas/selectionUtils'

/** Station k's pin holes as one path of two circles, each its own pin's size. */
export function stationD(t: Tiling, k: number): string {
  const s = useWorkpieceStore.getState()
  return stationPins(t, s, k).map((p) => generateShapeD({ type: 'circle', cx: p.x, cy: p.y, radius: p.diaMM / 2 })).join(' ')
}

/** The pin-hole paths still in the drawing, by station. */
export function pinPaths(t: Tiling | null): (ImportedPath | undefined)[] {
  const byId = new Map(usePathsStore.getState().paths.map((p) => [p.id, p]))
  return (t?.pinPathIds ?? []).map((id) => byId.get(id))
}


/**
 * Write `next`, and — once the job has pin holes, or with `makePins` — make the pin-hole
 * paths match it: moved, added for a new station, removed with a station that went, and
 * any pin-hole path that is not one of its stations removed with them.
 */
export function applyTiling(next: Tiling, makePins = false) {
  const ps = usePathsStore.getState()
  const n = tileCount(next)
  const had = next.pinPathIds ?? []
  if (had.length === 0 && !makePins) { useWorkpieceStore.getState().setTiling(next); return }
  const existing = new Map(ps.paths.map((p) => [p.id, p]))
  const updates: PathUpdate[] = []
  const add: ImportedPath[] = []
  const ids: string[] = []
  for (let k = 0; k < n; k++) {
    const d = stationD(next, k)
    const old = had[k] ? existing.get(had[k]) : undefined
    if (old) {
      ids.push(old.id)
      if (old.d !== d) updates.push({ id: old.id, d, shapeParams: null })
    } else {
      const id = uid('tilepin')
      ids.push(id)
      add.push({ id, name: `Tile Pins ${k + 1}`, d, visible: true, color: nextPathColor(), registration: 'tile-pins' })
    }
  }
  const keep = new Set(ids)
  const deleteIds = ps.paths.filter((p) => !keep.has(p.id) && (had.includes(p.id) || isTilePinPath(p))).map((p) => p.id)
  const written = { ...next, pinPathIds: ids }
  if (updates.length === 0 && add.length === 0 && deleteIds.length === 0) {
    useWorkpieceStore.getState().setTiling(written)
    return
  }
  useWorkpieceStore.setState({ tiling: written })
  ps.applyPathEdit({ updates, add, deleteIds, label: 'Tiling' })
}

/** Back to one program: the pin holes and their drilling go, in one step. */
export function removeTiling(t: Tiling) {
  const listed = new Set(t.pinPathIds ?? [])
  const deleteIds = usePathsStore.getState().paths.filter((p) => listed.has(p.id) || isTilePinPath(p)).map((p) => p.id)
  if (deleteIds.length === 0) { useWorkpieceStore.getState().setTiling(null); return }
  useWorkpieceStore.setState({ tiling: null })
  usePathsStore.getState().applyPathEdit({ deleteIds, label: 'Single Board' })
}
