import { create } from 'zustand'

type LiveBBox = { minX: number; minY: number; width: number; height: number }

interface CanvasStore {
  cursorMM: { x: number; y: number } | null
  zoomPct: number
  liveRotationAngle: number | null
  liveBBox: LiveBBox | null
  fitRequest: number
  // Where the active shape tool would place a click — the snapped cursor while idle
  // (ShapeHoverPreview). A store field, not CanvasStage state, so only the preview
  // re-renders as the mouse moves.
  shapeHoverAt: { x: number; y: number } | null
  // The stamp tool's copy, as an OFFSET from the originals (StampPreview).
  stampOffset: { x: number; y: number } | null
  setStampOffset: (o: { x: number; y: number } | null) => void
  setShapeHoverAt: (at: { x: number; y: number } | null) => void
  setCursorMM: (pos: { x: number; y: number } | null) => void
  setZoomPct: (pct: number) => void
  setLiveRotationAngle: (angle: number | null) => void
  setLiveBBox: (bbox: LiveBBox | null) => void
  requestFit: () => void
}

export const useCanvasStore = create<CanvasStore>()((set) => ({
  cursorMM: null,
  zoomPct: 100,
  liveRotationAngle: null,
  liveBBox: null,
  fitRequest: 0,
  shapeHoverAt: null,
  stampOffset: null,
  setStampOffset: (o) => set((s) => (s.stampOffset === o || (o && s.stampOffset && o.x === s.stampOffset.x && o.y === s.stampOffset.y) ? s : { stampOffset: o })),
  setShapeHoverAt: (at) => set((s) => (s.shapeHoverAt === at || (at && s.shapeHoverAt && at.x === s.shapeHoverAt.x && at.y === s.shapeHoverAt.y) ? s : { shapeHoverAt: at })),
  setCursorMM: (pos) => set({ cursorMM: pos }),
  setZoomPct: (pct) => set({ zoomPct: pct }),
  setLiveRotationAngle: (angle) => set({ liveRotationAngle: angle }),
  setLiveBBox: (bbox) => set({ liveBBox: bbox }),
  requestFit: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
}))

/** What the canvas is showing, in CNC mm (Y-up). */
export type ViewRectMM = { minX: number; minY: number; maxX: number; maxY: number }

// The viewport lives in CanvasStage's local state, so the canvas registers a getter here for
// code outside it that needs to know what is on screen — Paste, which brings a copy into view
// when its own position would land it off screen. A getter rather than store state: it is
// read once per gesture, and publishing every pan and zoom would re-render subscribers.
let viewGetter: (() => ViewRectMM | null) | null = null
export function registerViewRect(get: (() => ViewRectMM | null) | null): void { viewGetter = get }
export function visibleRectMM(): ViewRectMM | null { return viewGetter ? viewGetter() : null }

// And the other way: frame a region, as Zoom to fit frames the stock — for a script that has
// to show the same part of the drawing every time (scripts/screenshots).
let viewFitter: ((box: ViewRectMM) => void) | null = null
export function registerViewFit(fit: ((box: ViewRectMM) => void) | null): void { viewFitter = fit }
export function fitViewTo(box: ViewRectMM): void { viewFitter?.(box) }
