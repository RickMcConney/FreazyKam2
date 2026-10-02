import { create } from 'zustand'

type LiveBBox = { minX: number; minY: number; width: number; height: number }

interface CanvasStore {
  cursorMM: { x: number; y: number } | null
  zoomPct: number
  liveRotationAngle: number | null
  liveBBox: LiveBBox | null
  fitRequest: number
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
