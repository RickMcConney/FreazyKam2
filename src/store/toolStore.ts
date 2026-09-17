import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { uid } from '../uid'

export type ToolType = 'endmill' | 'ballnose' | 'vbit' | 'taper' | 'drill'
export type CuttingDirection = 'climb' | 'conventional'

export interface Tool {
  id: string
  name: string
  type: ToolType
  diameterMM: number
  fluteCount: number
  rpm: number
  xyFeedMmMin: number
  zFeedMmMin: number
  maxDepthMM: number
  // The cone angle, in the convention each tool type is SOLD in: a V-bit's is the
  // full INCLUDED angle (a 60° V-bit is 30° per side), a taper's is the angle PER
  // SIDE (a 5° taper is 10° included). Nothing outside the tool library reads this
  // field raw — `includedAngleDeg(tool)` in cam/geom.ts is the one place the two
  // conventions meet, and everything downstream works in included angle / its half.
  vbitAngleDeg?: number  // only meaningful for vbit and taper types
}

const DEFAULT_TOOLS: Tool[] = [
  { id: 'default-1', name: '1/4" End Mill',   type: 'endmill',  diameterMM: 6.35,  fluteCount: 2, rpm: 18000, xyFeedMmMin: 2500, zFeedMmMin: 500, maxDepthMM: 25.0 },
  { id: 'default-2', name: '1/8" End Mill',   type: 'endmill',  diameterMM: 3.175, fluteCount: 2, rpm: 24000, xyFeedMmMin: 1500, zFeedMmMin: 300, maxDepthMM: 15.0 },
  { id: 'default-3', name: '60° V-Bit',       type: 'vbit',     diameterMM: 6.35,  fluteCount: 2, rpm: 18000, xyFeedMmMin: 2000, zFeedMmMin: 400, maxDepthMM: 10.0, vbitAngleDeg: 60 },
  { id: 'default-4', name: '1/4" Ball Nose',  type: 'ballnose', diameterMM: 6.35,  fluteCount: 2, rpm: 18000, xyFeedMmMin: 2000, zFeedMmMin: 400, maxDepthMM: 20.0 },
  { id: 'default-5', name: '3mm Drill',       type: 'drill',    diameterMM: 3.0,   fluteCount: 2, rpm: 12000, xyFeedMmMin: 0,    zFeedMmMin: 200, maxDepthMM: 20.0 },
  // Ø is the TIP ball diameter and maxDepth the usable taper length: together with the
  // 5°/side they say this bit opens out to Ø5.29 mm at 25 mm deep.
  { id: 'default-6', name: '5° Taper 1mm Tip', type: 'taper',   diameterMM: 1.0,   fluteCount: 2, rpm: 18000, xyFeedMmMin: 1200, zFeedMmMin: 300, maxDepthMM: 25.0, vbitAngleDeg: 5 },
]

// How the library table is ordered for display. The tools array itself keeps its
// creation order (that's what `addTool` appends to and what `sortBy: null`
// shows); this is a view preference, persisted with the library so leaving the
// panel and coming back doesn't move every row.
export type ToolSortKey = 'name' | 'type' | 'diameter'
export interface ToolSort { key: ToolSortKey; dir: 'asc' | 'desc' }

interface ToolState {
  tools: Tool[]
  selectedToolId: string | null
  sortBy: ToolSort | null
  setSortBy: (sort: ToolSort | null) => void
  addTool: () => void
  updateTool: (id: string, updates: Partial<Omit<Tool, 'id'>>) => void
  deleteTool: (id: string) => void
  selectTool: (id: string | null) => void
  setTools: (tools: Tool[]) => void
}

export const useToolStore = create<ToolState>()(
  persist(
    (set) => ({
      tools: DEFAULT_TOOLS,
      selectedToolId: DEFAULT_TOOLS[0].id,
      sortBy: null,

      setSortBy: (sortBy) => set({ sortBy }),

      // A new tool copies the selected row when there is one: a library is
      // usually filled in a run of near-identical cutters (same collet, same
      // spindle, one size apart), so the row the user just clicked is a far
      // better starting point than a fixed generic end mill.
      addTool: () => {
        const id = uid('tool')
        set((s) => {
          const base = s.tools.find((t) => t.id === s.selectedToolId)
          const t: Tool = base
            ? { ...base, id, name: `${base.name} copy` }
            : { id, name: 'New End Mill', type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000, xyFeedMmMin: 2000, zFeedMmMin: 500, maxDepthMM: 20.0 }
          return { tools: [...s.tools, t], selectedToolId: id }
        })
      },

      updateTool: (id, updates) =>
        set((s) => ({ tools: s.tools.map((t) => t.id === id ? { ...t, ...updates } : t) })),

      deleteTool: (id) =>
        set((s) => {
          if (s.tools.length <= 1) return s
          const tools = s.tools.filter((t) => t.id !== id)
          return { tools, selectedToolId: s.selectedToolId === id ? tools[0]?.id ?? null : s.selectedToolId }
        }),

      selectTool: (id) => set({ selectedToolId: id }),

      setTools: (tools) =>
        set({ tools, selectedToolId: tools[0]?.id ?? null }),
    }),
    {
      name: 'freazykam-tools',
      // Heal libraries saved while ids came from a session counter that reset
      // every launch: two sessions could both mint "tool-101", leaving duplicate
      // ids in localStorage (updateTool/deleteTool then hit both rows). Re-id
      // every duplicate after the first; operations referencing the shared id
      // keep resolving to the first (kept) tool. Deferred a microtask because
      // this callback runs during store creation, before useToolStore exists.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const seen = new Set<string>()
        let changed = false
        const tools = state.tools.map((t) => {
          if (seen.has(t.id)) { changed = true; return { ...t, id: uid('tool') } }
          seen.add(t.id)
          return t
        })
        if (changed) queueMicrotask(() => useToolStore.setState({ tools }))
      },
    }
  )
)
