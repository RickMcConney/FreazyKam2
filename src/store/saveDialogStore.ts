import { create } from 'zustand'
import type { DrawingFormat } from '../io/drawingExport'

// Which artifact the save dialog is naming.
type SaveKind = 'project' | 'gcode' | 'drawing'

interface SaveDialogState {
  open: boolean
  kind: SaveKind
  /** The format a drawing export last went out as — offered again next time, for the session. */
  drawingFormat: DrawingFormat
  openSaveDialog: (kind: SaveKind) => void
  closeSaveDialog: () => void
  setDrawingFormat: (f: DrawingFormat) => void
}

// Drives the filename prompt shown before a project save, a G-code export or a
// drawing (SVG/DXF) export. Lives in its own store so it can be opened from the
// toolbar buttons and the Ctrl+S keyboard shortcut (App) alike.
export const useSaveDialogStore = create<SaveDialogState>()((set) => ({
  open: false,
  kind: 'project',
  drawingFormat: 'svg',
  openSaveDialog: (kind) => set({ open: true, kind }),
  closeSaveDialog: () => set({ open: false }),
  setDrawingFormat: (drawingFormat) => set({ drawingFormat }),
}))
