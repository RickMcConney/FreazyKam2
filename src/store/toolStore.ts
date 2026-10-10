import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { uid } from '../uid'

export type ToolType = 'endmill' | 'ballnose' | 'bullnose' | 'vbit' | 'taper' | 'drill'
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
  // A bull nose's corner radius: a flat bottom of radius R − r with a quarter-round of r
  // at its edge (a bowl bit is a big one). Only meaningful for the bullnose type; read it
  // through `cornerRadiusMM(tool)` in cam/geom.ts, which clamps it to [0, R].
  cornerRadiusMM?: number
  // The RATED chip load, mm per tooth — the maker's recommended feed per tooth for this
  // bit. Fixed: editing the feed, rpm or flutes never changes it, because judging those
  // against it is the whole point (the chip gauge and the export check warn when they
  // run the bit too hot or too cold). Auto Feeds never aims above it. Shown and editable
  // in the library's Chip column; absent means no rating, and the material-and-size
  // model is the only reference.
  chipLoadMM?: number
  // The library folder the tool is filed in. Absent is MY TOOLS — the user's own rack.
  // Anything imported lands in a NAMED folder (a vendor catalogue is 80 bits the user
  // mostly does not own), so an import never mixes into, renames against or restores
  // over their own tools. A folder exists exactly while a tool names it.
  folder?: string
}

/**
 * The chip load a tool's own feed, rpm and flutes give — feed ÷ (rpm × flutes). How a
 * rating is FILLED IN where there is none (the defaults, a library from before the Chip
 * column, a plain new tool, a file that carries none); never how one is kept up to date.
 * Undefined for a drill (its chip is not a side-cutting one) and for no feed or speed.
 */
export function chipLoadFromFeeds(tool: Tool): number | undefined {
  if (tool.type === 'drill' || !(tool.xyFeedMmMin > 0) || !(tool.rpm > 0)) return undefined
  return Math.round(tool.xyFeedMmMin / (tool.rpm * Math.max(1, tool.fluteCount)) * 1e5) / 1e5
}

/** `tool` with a rated chip load filled in from its own numbers if it has none. */
export function withRatedChip(tool: Tool): Tool {
  if (tool.chipLoadMM !== undefined && tool.chipLoadMM > 0) return tool
  const legacy = (tool as Tool & { makerChipLoadMM?: number }).makerChipLoadMM
  const { makerChipLoadMM: _drop, ...rest } = tool as Tool & { makerChipLoadMM?: number }
  const fz = legacy && legacy > 0 ? legacy : chipLoadFromFeeds(tool)
  return fz === undefined ? rest : { ...rest, chipLoadMM: fz }
}

/** The folder a tool is filed in; '' is My Tools. */
export const folderOf = (t: Tool): string => t.folder ?? ''
export const MY_TOOLS = 'My Tools'

/** Every named folder in the library, in the order they first appear. */
export function folderNames(tools: Tool[]): string[] {
  return [...new Set(tools.map(folderOf).filter((f) => f !== ''))]
}

// The factory set. RPM, feeds, plunge and Max Z of the first four are IDC Woodcraft's
// published numbers for their equivalent bit (1/4" and 1/8" downcut, 60° 1/4"-shank V-bit,
// 1/4" ball nose) — a consistent reference rather than numbers of unknown origin. They are
// used as they stand only with Auto Feeds off; with it on each cut works its own out.
// The drill takes IDC's spindle speed but a moderate plunge: their 1/8" is a Lightning
// drill, built to plunge far harder than a generic twist drill should. No IDC bit matches
// the taper, so it keeps its own.
const FACTORY_TOOLS: Tool[] = [
  { id: 'default-1', name: '1/4" End Mill',   type: 'endmill',  diameterMM: 6.35,  fluteCount: 2, rpm: 19000, xyFeedMmMin: 1778, zFeedMmMin: 762, maxDepthMM: 25.4 },
  { id: 'default-2', name: '1/8" End Mill',   type: 'endmill',  diameterMM: 3.175, fluteCount: 2, rpm: 22000, xyFeedMmMin: 1270, zFeedMmMin: 381, maxDepthMM: 19.05 },
  // Max Z is the depth of the cone: a 1/4" 60° V-bit is 5.5 mm deep at its full width.
  { id: 'default-3', name: '60° V-Bit',       type: 'vbit',     diameterMM: 6.35,  fluteCount: 2, rpm: 22000, xyFeedMmMin: 1524, zFeedMmMin: 508, maxDepthMM: 5.5, vbitAngleDeg: 60 },
  { id: 'default-4', name: '1/4" Ball Nose',  type: 'ballnose', diameterMM: 6.35,  fluteCount: 2, rpm: 19000, xyFeedMmMin: 1778, zFeedMmMin: 762, maxDepthMM: 35.56 },
  // A small bowl bit: ½" across, a 3/16" corner, so ⅛" of flat in the middle. Shape,
  // speeds and feeds are Cadence's "Bowl-Cut Jenny", from the same IDC catalogue.
  { id: 'default-7', name: '1/2" Bull Nose',  type: 'bullnose', diameterMM: 12.7,  fluteCount: 2, rpm: 17000, xyFeedMmMin: 3048, zFeedMmMin: 1524, maxDepthMM: 25.4, cornerRadiusMM: 4.762 },
  { id: 'default-5', name: '3mm Drill',       type: 'drill',    diameterMM: 3.0,   fluteCount: 2, rpm: 17000, xyFeedMmMin: 0,    zFeedMmMin: 500, maxDepthMM: 20.0 },
  // Ø is the TIP ball diameter and maxDepth the usable taper length: together with the
  // 5°/side they say this bit opens out to Ø5.29 mm at 25 mm deep.
  { id: 'default-6', name: '5° Taper 1mm Tip', type: 'taper',   diameterMM: 1.0,   fluteCount: 2, rpm: 18000, xyFeedMmMin: 1200, zFeedMmMin: 300, maxDepthMM: 25.0, vbitAngleDeg: 5 },
]
// Each rated from its own (IDC-matched) numbers; the drill has none.
export const DEFAULT_TOOLS: Tool[] = FACTORY_TOOLS.map(withRatedChip)

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
  // The folder the library panel shows ('' = My Tools) — persisted, like the sort.
  openFolder: string
  setOpenFolder: (folder: string) => void
  renameFolder: (from: string, to: string) => void
  copyToMyTools: (id: string) => string | null   // the copy's id
  // Tools picked lately in a form's tool picker, newest first — what keeps a catalogue
  // bit in the short dropdown after it was found once through Browse library.
  recentToolIds: string[]
  noteToolUsed: (id: string) => void
  moveToFolder: (id: string, folder: string) => void
  setSortBy: (sort: ToolSort | null) => void
  addTool: () => void
  updateTool: (id: string, updates: Partial<Omit<Tool, 'id'>>) => void
  deleteTool: (id: string) => void
  selectTool: (id: string | null) => void
  setTools: (tools: Tool[]) => void
}

const RECENT_MAX = 8

/** `tool` filed in `folder` ('' = My Tools, which is the field ABSENT, not empty). */
export function withFolder(tool: Tool, folder: string): Tool {
  const { folder: _drop, ...rest } = tool
  return folder ? { ...rest, folder } : rest
}

export const useToolStore = create<ToolState>()(
  persist(
    (set) => ({
      tools: DEFAULT_TOOLS,
      selectedToolId: DEFAULT_TOOLS[0].id,
      sortBy: null,
      openFolder: '',

      setSortBy: (sortBy) => set({ sortBy }),

      setOpenFolder: (openFolder) => set({ openFolder }),

      // Renaming onto another folder's name merges the two — that is what the name means.
      renameFolder: (from, to) =>
        set((s) => {
          const name = to.trim() === MY_TOOLS ? '' : to.trim()
          if (!from || name === from) return s
          return {
            tools: s.tools.map((t) => (folderOf(t) === from ? withFolder(t, name) : t)),
            openFolder: s.openFolder === from ? name : s.openFolder,
          }
        }),

      // Taking a catalogue bit into the user's own rack: a COPY, with a fresh id, so the
      // catalogue stays as the vendor published it and a re-import still matches it.
      // Same tool, same id — only where it is filed changes, so every operation cutting
      // with it still finds it. Moving a folder's last tool out is how it disappears.
      moveToFolder: (id, folder) =>
        set((s) => {
          const key = folder.trim() === MY_TOOLS ? '' : folder.trim()
          return { tools: s.tools.map((t) => (t.id === id ? withFolder(t, key) : t)) }
        }),

      copyToMyTools: (id) => {
        const src = useToolStore.getState().tools.find((t) => t.id === id)
        if (!src) return null
        const copy = withFolder({ ...src, id: uid('tool') }, '')
        set((s) => ({ tools: [...s.tools, copy] }))
        return copy.id
      },

      recentToolIds: [],
      noteToolUsed: (id) =>
        set((s) => s.recentToolIds[0] === id ? s
          : { recentToolIds: [id, ...s.recentToolIds.filter((x) => x !== id)].slice(0, RECENT_MAX) }),

      // A new tool copies the selected row when there is one: a library is
      // usually filled in a run of near-identical cutters (same collet, same
      // spindle, one size apart), so the row the user just clicked is a far
      // better starting point than a fixed generic end mill.
      // The new tool goes in the folder the panel is showing — a copy of a row picked in
      // another folder (the selection outlives switching folders) is not the base.
      addTool: () => {
        const id = uid('tool')
        set((s) => {
          const base = s.tools.find((t) => t.id === s.selectedToolId && folderOf(t) === s.openFolder)
          const t: Tool = base
            ? { ...base, id, name: `${base.name} copy` }
            : withFolder(withRatedChip({ id, name: 'New End Mill', type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000, xyFeedMmMin: 2000, zFeedMmMin: 500, maxDepthMM: 20.0 }), s.openFolder)
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
        // A library saved before the Chip column gets each tool rated ONCE from its own
        // numbers (or from the maker's figure an earlier build stored); from then on the
        // rating is the user's, and editing feed or rpm leaves it alone.
        const tools = state.tools.map((t0) => {
          const t = withRatedChip(t0)
          if (t !== t0) changed = true
          if (seen.has(t.id)) { changed = true; return { ...t, id: uid('tool') } }
          seen.add(t.id)
          return t
        })
        if (changed) queueMicrotask(() => useToolStore.setState({ tools }))
      },
    }
  )
)
