import { create } from 'zustand'

interface ProjectState {
  name: string
  isDirty: boolean
  // Which document is open. Bumped every time the document is swapped out from under the
  // UI (New Project, project load, autosave restore), so work that finishes LATER can tell
  // that the document it was started in is gone — a node-edit session commits from a React
  // effect that runs after a load has already installed the new paths, and would otherwise
  // write its nodes into whichever path in the new document happens to share the id.
  documentEpoch: number
  bumpDocumentEpoch: () => void
  setName: (name: string) => void
  markDirty: () => void
  markClean: () => void
}

export const useProjectStore = create<ProjectState>()((set) => ({
  name: 'Untitled Project',
  isDirty: false,
  documentEpoch: 0,
  bumpDocumentEpoch: () => set((s) => ({ documentEpoch: s.documentEpoch + 1 })),
  setName: (name) => set({ name }),
  markDirty: () => set({ isDirty: true }),
  markClean: () => set({ isDirty: false }),
}))
