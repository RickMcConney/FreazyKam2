// Writing a DOUBLE-SIDED setting (cam/doubleSided) and keeping its dowel holes, and side
// B's parts, in step with it. Every write here is ONE undo step: the setting is written
// straight to the store and the path edit records the step, and the timeline keeps the
// stores as they stood before the first write of a turn (tools/tilingRun does the same).

import { useWorkpieceStore } from '../store/workpieceStore'
import { usePathsStore, type PathUpdate } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { nextPathColor } from '../importers/svgImporter'
import { generateShapeD } from '../shapes/shapeGenerators'
import { applyTransformSteps } from '../canvas/selectionUtils'
import { pathCell } from '../canvas/useSheets'
import { sameCell, STOCK_CELL } from '../cam/sheets'
import { backCell, dowelHolesD, otherSideSteps, type DoubleSided, type FlipDirection } from '../cam/doubleSided'
import { uid } from '../uid'

const FLIP_NAMES: Record<FlipDirection, string> = { 'left-right': 'Left ↔ Right', 'top-bottom': 'Top ↔ Bottom' }

const circleD = (cx: number, cy: number, radius: number) => generateShapeD({ type: 'circle', cx, cy, radius })
export const dowelD = (ds: DoubleSided) => dowelHolesD(ds, useWorkpieceStore.getState(), circleD)

/** The dowel-holes path of `ds`, if it is still in the drawing. */
export function dowelPathOf(ds: DoubleSided | null) {
  return ds?.dowelPathId ? usePathsStore.getState().paths.find((p) => p.id === ds.dowelPathId) : undefined
}

/**
 * Write a new setting and add (or move) the dowel holes to match it, as ONE undo step. The
 * setting is written straight to the store and the path edit records the step: the
 * timeline keeps the stores as they stood before the first write of a turn, so undo puts
 * the setting and the holes back together. With no path edit to make, the setting
 * records itself.
 */
export function applyDoubleSided(next: DoubleSided, addHoles = false) {
  const ps = usePathsStore.getState()
  const path = dowelPathOf(next)
  const d = dowelD(next)
  if (!path && addHoles) {
    const id = uid('dowel')
    useWorkpieceStore.setState({ doubleSided: { ...next, dowelPathId: id } })
    ps.addPaths([{ id, name: 'Dowel Holes', d, visible: true, color: nextPathColor(), registration: 'dowel' }], { label: 'Dowel Holes' })
    ps.selectPath(id)
  } else if (path && path.d !== d) {
    useWorkpieceStore.setState({ doubleSided: next })
    ps.applyPathEdit({ updates: [{ id: path.id, d, shapeParams: null }], label: 'Dowel Pins' })
  } else {
    useWorkpieceStore.getState().setDoubleSided(next)
  }
}

/**
 * Turn the board over the other way. Side B is side A as seen after the flip, so its parts
 * go to the new back sheet: back onto side A through the old flip, then out through the new
 * one (a half turn, net). Their toolpaths regenerate there with them, the dowel holes move
 * onto the new axis, and it is all ONE edit, so one undo puts it back.
 */
export function changeFlip(ds: DoubleSided, flip: FlipDirection) {
  if (flip === ds.flip) return
  const stock = useWorkpieceStore.getState()
  const oldBack = backCell(ds.flip)
  const steps = [...otherSideSteps(ds.flip, oldBack, stock), ...otherSideSteps(flip, STOCK_CELL, stock)]
  const ps = usePathsStore.getState()
  const next = { ...ds, flip }
  const updates: PathUpdate[] = ps.paths
    .filter((p) => p.id !== ds.dowelPathId && sameCell(pathCell(p, stock), oldBack))
    .map((p) => {
      const res = applyTransformSteps(p, steps)
      return { id: p.id, d: res.d, shapeParams: res.shapeParams, transforms: steps }
    })
  const dowel = dowelPathOf(next)
  if (dowel) updates.push({ id: dowel.id, d: dowelD(next), shapeParams: null })
  if (updates.length === 0) { useWorkpieceStore.getState().setDoubleSided(next); return }
  useWorkpieceStore.setState({ doubleSided: next })
  ps.applyPathEdit({ updates, gesture: 'transform', label: `Flip ${FLIP_NAMES[flip]}` })
  // Still looking at side B, now that it is somewhere else.
  const ui = useUIStore.getState()
  if (sameCell(ui.activeSheet, oldBack)) ui.setActiveSheet(backCell(flip))
}

/**
 * Back to an ordinary job: the dowel holes go, and their drilling with them (an op goes
 * with its path), in one step. Side B's parts stay where they are, as a second sheet.
 */
export function makeSingleSided(ds: DoubleSided) {
  // Its own holes, and any other dowel holes a lost track of (see ImportedPath.registration).
  const deleteIds = usePathsStore.getState().paths
    .filter((p) => p.id === ds.dowelPathId || p.registration === 'dowel').map((p) => p.id)
  if (deleteIds.length === 0) { useWorkpieceStore.getState().setDoubleSided(null); return }
  useWorkpieceStore.setState({ doubleSided: null })
  usePathsStore.getState().applyPathEdit({ deleteIds, label: 'Single-Sided' })
}

