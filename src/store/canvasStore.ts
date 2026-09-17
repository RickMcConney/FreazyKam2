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
