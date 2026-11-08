import { create } from 'zustand'
import { flattenPath } from '../cam/pathFlattener'
import { tabPositions } from '../cam/tabPlacement'
import { useTimelineStore } from '../timeline/timelineStore'
import { uid } from '../uid'

export interface Tab {
  id: string
  pathId: string
  t: number        // 0..1 arc-length fraction along the source design path
  lengthMM: number
  heightMM: number // height above cut bottom (G-code lifts to -(depth - heightMM))
  // Shared by every tab ONE click put on several paths, so the strip draws them as one chip
  // — the way a batch of operations is one chip. Absent when the click tabbed one path.
  batchId?: string
}

interface TabState {
  tabs: Tab[]
  // Replace all tabs for a path with evenly-spaced new ones, snapped to segment midpoints
  applyTabs: (pathId: string, count: number, d: string, lengthMM: number, heightMM: number) => void
  // The same for every path in `paths` at once — one store write and ONE undo step, so a
  // sheet of parts is tabbed in one click and taken back in one undo.
  // (On a tight nest a neighbour's cut sweeps per-path tabs away: see the sheet's bridges,
  // cam/bridges.ts.)
  applyTabsMany: (paths: { id: string; d: string }[], count: number, lengthMM: number, heightMM: number) => void
  deleteTab: (id: string) => void
  deletePathTabs: (pathId: string) => void
  // Every tab on these paths, as one undo step.
  deleteTabsOf: (pathIds: string[]) => void
  updateTabT: (id: string, t: number) => void
  getPathTabs: (pathId: string) => Tab[]
  replaceTabs: (tabs: Tab[]) => void  // used by project load
}

export const useTabStore = create<TabState>()((set, get) => ({
  tabs: [],

  applyTabs: (pathId, count, d, lengthMM, heightMM) => get().applyTabsMany([{ id: pathId, d }], count, lengthMM, heightMM),

  applyTabsMany: (paths, count, lengthMM, heightMM) => {
    if (paths.length === 0) return
    const ids = new Set(paths.map((p) => p.id))
    const existing = get().tabs.filter((t) => !ids.has(t.pathId))
    const batchId = paths.length > 1 ? uid('tabs') : undefined
    const newTabs = paths.flatMap((p) => tabsAlong(p.id, count, p.d, lengthMM, heightMM)
      .map((t) => (batchId ? { ...t, batchId } : t)))
    set({ tabs: [...existing, ...newTabs] })
    // Tab edits join the paths' Tabs step while it is the LATEST one — and only when it
    // covers EVERY path here, or tabbing a second part would fold into the first part's
    // step. Otherwise this records its own (see joinsTip in timelineStore).
    const tl = useTimelineStore.getState()
    if (!paths.every((p) => tl.joinsTip([{ tabsOf: p.id }]))) {
      tl.record({
        kind: 'tabs.apply', pathId: paths[0].id, tabs: newTabs,
        ...(paths.length > 1 ? { linked: paths.slice(1).map((p) => p.id) } : {}),
      })
    }
  },

  deleteTab: (id) => {
    const pathId = get().tabs.find((t) => t.id === id)?.pathId
    set((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) }))
    const tl = useTimelineStore.getState()
    if (!pathId || !tl.joinsTip([{ tabsOf: pathId }])) {
      tl.record({ kind: 'tabs.delete', tabIds: [id] })
    }
  },

  deletePathTabs: (pathId) => get().deleteTabsOf([pathId]),

  deleteTabsOf: (pathIds) => {
    const of = new Set(pathIds)
    const ids = get().tabs.filter((t) => of.has(t.pathId)).map((t) => t.id)
    if (ids.length === 0) return
    set((s) => ({ tabs: s.tabs.filter((t) => !of.has(t.pathId)) }))
    const tl = useTimelineStore.getState()
    if (!pathIds.every((id) => tl.joinsTip([{ tabsOf: id }]))) {
      tl.record({ kind: 'tabs.delete', tabIds: ids })
    }
  },

  updateTabT: (id, t) => {
    const clamped = Math.max(0, Math.min(1, t))
    set((s) => ({ tabs: s.tabs.map((tab) => tab.id === id ? { ...tab, t: clamped } : tab) }))
    const tab = get().tabs.find((x) => x.id === id)
    const tl = useTimelineStore.getState()
    if (!tab || !tl.joinsTip([{ tabsOf: tab.pathId }])) {
      tl.record({ kind: 'tabs.moveT', tabId: id, t01: clamped })
    }
  },

  getPathTabs: (pathId) => get().tabs.filter((t) => t.pathId === pathId),

  replaceTabs: (tabs) => set({ tabs }),
}))

// `count` tabs evenly spaced along `d` by arc length, kept off its corners (cam/tabPlacement.ts).
function tabsAlong(pathId: string, count: number, d: string, lengthMM: number, heightMM: number): Tab[] {
  return tabPositions(flattenPath(d, 0.05), count, lengthMM).map((t) => ({
    id: uid('tab'), pathId, t, lengthMM, heightMM,
  }))
}

/**
 * The tabs a generation of `pathId` must honour — `undefined` when it has none.
 *
 * ONE RULE FOR EVERY CALLER. `regenerate.ts` passed the path's tabs to the
 * profile and trochoidal generators while ProfileForm and TrochoidalForm passed
 * nothing, so re-Generating from a form after tabs were applied cut the part free —
 * and export did not notice, since nothing about the op's inputs looked stale.
 */
export function tabsForGeneration(pathId: string): Tab[] | undefined {
  const tabs = useTabStore.getState().getPathTabs(pathId)
  return tabs.length > 0 ? tabs : undefined
}
