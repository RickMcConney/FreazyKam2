import { create } from 'zustand'

// Which artifact the save dialog is naming.
type SaveKind = 'project' | 'gcode'

interface SaveDialogState {
  open: boolean
  kind: SaveKind
  openSaveDialog: (kind: SaveKind) => void
  closeSaveDialog: () => void
}

// Drives the filename prompt shown before a project save or G-code export. Lives
// in its own store so it can be opened from the toolbar buttons and the Ctrl+S
// keyboard shortcut (App) alike.
export const useSaveDialogStore = create<SaveDialogState>()((set) => ({
  open: false,
  kind: 'project',
  openSaveDialog: (kind) => set({ open: true, kind }),
  closeSaveDialog: () => set({ open: false }),
}))
