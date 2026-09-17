import { create } from 'zustand'

interface ProjectState {
  name: string
  isDirty: boolean
  setName: (name: string) => void
  markDirty: () => void
  markClean: () => void
}

export const useProjectStore = create<ProjectState>()((set) => ({
  name: 'Untitled Project',
  isDirty: false,
  setName: (name) => set({ name }),
  markDirty: () => set({ isDirty: true }),
  markClean: () => set({ isDirty: false }),
}))
