import { useCallback, useEffect, useRef } from 'react'
import type { ImportedPath } from '../importers/svgImporter'
import { useCanvasStore } from '../store/canvasStore'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import type { SnapGuides } from './layers/SnapGuideLayer'
import { collectVertices } from './objectSnap'
import { guideSetter, placeByAnchor } from './placementSnap'
import { getMultiBBox, type BBox } from './selectionUtils'
import type { Gesture } from './useGesture'
import { screenToCNC, type Viewport } from './viewport'

type Pt = { x: number; y: number }

/** The originals being stamped, as they stand now: their paths, box and corners. Cached
 *  on the paths array, so a mouse move does not re-measure them; an undo that changes
 *  or removes them is picked up on the next move. */
let srcCache: { paths: unknown; ids: string[]; value: StampSource | null } | null = null
export interface StampSource { paths: ImportedPath[]; bbox: BBox; vertices: Pt[] }
export function stampSource(): StampSource | null {
  const { paths } = usePathsStore.getState()
  const { stampIds } = useUIStore.getState()
  if (srcCache && srcCache.paths === paths && srcCache.ids === stampIds) return srcCache.value
  const ids = new Set(stampIds)
  const src = paths.filter((p) => ids.has(p.id) && !p.hidden)
  const bbox = src.length ? getMultiBBox(src.map((p) => p.d)) : null
  const value = bbox ? { paths: src, bbox, vertices: collectVertices(src) } : null
  srcCache = { paths, ids: stampIds, value }
  return value
}

/**
 * THE STAMP (Cmd+D): copies of the selection follow the cursor and every click places
 * one, the way the shape tool stamps shapes — Duplicate used to drop one copy 5 mm off
 * the original, which then had to be dragged to where it was wanted, once per copy.
 *
 * It is a TOOL (`activeTool: 'stamp'`), so everything that ends a tool ends it — Esc,
 * picking another tool, Cmd+D again — and double-click, drag-box and the selection
 * handles stay out of its way as they do for the shape tools. The cursor holds the
 * copy's CENTRE, snapped exactly as a drag of a placed part (placementSnap): corner
 * onto corner, alignment, equal spacing, grid — against everything, the originals
 * included, since butting a copy against its original is what a stamp is mostly for.
 * Each click is one Duplicate (pathsStore.duplicatePaths, one undo step) of the
 * ORIGINALS, and selects what it made.
 */
export function useStampTool(g: Gesture, viewportRef: { current: Viewport }) {
  const { snapCNC, setSnapGuides } = g
  const guides = useRef(guideSetter(setSnapGuides))

  // Leaving the tool takes the preview and its guides with it.
  useEffect(() => useUIStore.subscribe((s, prev) => {
    if (s.activeTool !== prev.activeTool && prev.activeTool === 'stamp') {
      useCanvasStore.getState().setStampOffset(null)
      guides.current.clear()
    }
  }), [])

  const placeAt = (raw: Pt): { offset: Pt; guides: SnapGuides | null } | null => {
    const src = stampSource()
    if (!src) return null
    return placeByAnchor(src.bbox, src.vertices, { x: src.bbox.cx, y: src.bbox.cy }, raw, viewportRef.current, snapCNC)
  }

  const onMoveStampHover = useCallback((cncMouse: Pt) => {
    if (useUIStore.getState().activeTool !== 'stamp') return
    const p = placeAt(cncMouse)
    useCanvasStore.getState().setStampOffset(p?.offset ?? null)
    guides.current.show(p?.guides ?? null)
  }, [snapCNC])

  /** A press places a copy where the preview stood — or ends the tool when what it
   *  copies is gone (deleted, or undone away). */
  const onStampPress = useCallback((pointer: Pt) => {
    const p = placeAt(screenToCNC(pointer.x, pointer.y, viewportRef.current))
    if (!p) { useUIStore.getState().setActiveTool('select'); return }
    usePathsStore.getState().duplicatePaths(useUIStore.getState().stampIds, { dx: p.offset.x, dy: p.offset.y })
  }, [snapCNC])

  return { onMoveStampHover, onStampPress }
}
