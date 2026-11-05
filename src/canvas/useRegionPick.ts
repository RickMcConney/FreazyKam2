import { useCallback, useEffect, useRef, useState } from 'react'
import { signedArea } from '../cam/pathFlattener'
import { pointInPolygon } from '../cam/geom'
import { createRegionFinder, regionToD, type RegionFinder } from '../cam/regionPick'
import { nextPathColor } from '../importers/svgImporter'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { uid } from '../uid'
import { closestVisiblePath, onCanvas, type FlatOf } from './pathHit'
import type { Viewport } from './viewport'

// Fine enough that a region's curved edges sit well inside any pocket tolerance
// (POCKET_FLATTEN_TOL_MM is 0.05), since the region is emitted as a polyline.
const REGION_FLATTEN_TOL_MM = 0.01

/** Picking an enclosed area of the drawing, with its hover preview. */
export function useRegionPick(getFlat: FlatOf, activeTool: string) {
  // Region picking (cam/regionPick.ts), on while the Pocket form is open. The planar graph of every visible stroke is
  // built once per paths state, so hovering — which previews the region under the
  // cursor — only runs the face lookup. Paths are replaced, never mutated, so the
  // array's identity is the cache key.
  const [regionPreviewD, setRegionPreviewD] = useState<string | null>(null)
  const regionFinderRef = useRef<{ paths: ImportedPath[]; find: RegionFinder } | null>(null)
  const getRegionFinder = useCallback((): RegionFinder => {
    const { paths } = usePathsStore.getState()
    const cached = regionFinderRef.current
    if (cached && cached.paths === paths) return cached.find
    const strokes = paths.filter(onCanvas).flatMap((p) => getFlat(p, REGION_FLATTEN_TOL_MM))
    const find = createRegionFinder(strokes)
    regionFinderRef.current = { paths, find }
    return find
  }, [getFlat])
  // Region picking shares the canvas with ordinary selection, so the area under the
  // cursor is previewed only where a click would pick it: off every line (a click
  // there selects that path) and outside point edit.
  const onMoveRegionHover = useCallback((cnc: { x: number; y: number }, vp: Viewport) => {
    const { paths } = usePathsStore.getState()
    const onLine = !!useUIStore.getState().nodeEditPathId ||
      !!closestVisiblePath(cnc.x, cnc.y, paths.filter(onCanvas), 8 / vp.scale, (p) => getFlat(p, 0.05))
    const region = onLine ? null : getRegionFinder()([cnc.x, cnc.y])
    const d = region ? regionToD(region) : null
    setRegionPreviewD((prev) => (prev === d ? prev : d))
  }, [getRegionFinder, getFlat])
  // Pick the enclosed area around `cnc` and select it (added to the selection with
  // shift). An area that one existing closed path already bounds, with nothing inside
  // it, selects that path rather than stacking a copy on it. False when `cnc` is not
  // enclosed.
  const pickRegionAt = useCallback((cnc: { x: number; y: number }, additive: boolean): boolean => {
    const region = getRegionFinder()([cnc.x, cnc.y])
    if (!region) return false
    const store = usePathsStore.getState()
    let id: string | undefined
    if (region.holes.length === 0) {
      const area = Math.abs(signedArea(region.outer))
      id = store.paths.find((p) => {
        if (!onCanvas(p)) return false
        const rings = getFlat(p, REGION_FLATTEN_TOL_MM)
        if (rings.length !== 1) return false
        const ring = rings[0]
        const [a, b] = [ring[0], ring[ring.length - 1]]
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-3) return false
        return Math.abs(Math.abs(signedArea(ring)) - area) <= area * 1e-3 &&
          pointInPolygon(cnc.x, cnc.y, ring)
      })?.id
    }
    if (!id) {
      id = uid('region')
      store.addPaths([{ id, name: 'Region', d: regionToD(region), visible: true, color: nextPathColor() }], { source: 'region' })
    }
    const { selectedIds } = usePathsStore.getState()
    usePathsStore.getState().setSelectedIds(additive
      ? (selectedIds.includes(id) ? selectedIds : [...selectedIds, id])
      : [id])
    setRegionPreviewD(null)
    return true
  }, [getRegionFinder, getFlat])

  // A region preview belongs to one hover session of region picking.
  useEffect(() => { if (activeTool !== 'region') setRegionPreviewD(null) }, [activeTool])

  return { regionPreviewD, setRegionPreviewD, onMoveRegionHover, pickRegionAt }
}
