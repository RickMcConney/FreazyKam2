import { create } from 'zustand'
import { tabOutline } from '../cam/stlOutline'
import type { StlModelBounds } from '../importers/svgImporter'
import { tabPositions } from '../cam/tabPlacement'
import { useTimelineStore } from '../timeline/timelineStore'
import { uid } from '../uid'

export interface Tab {
  id: string
  pathId: string
  t: number        // 0..1 arc-length fraction along the source design path
  lengthMM: number
  heightMM: number // height above the STOCK's bottom, whatever the cut's depth (cam/profile holdTopZ)
  // Shared by every tab ONE click put on several paths, so the strip draws them as one chip
  // — the way a batch of operations is one chip. Absent when the click tabbed one path.
  batchId?: string
  // Placed or moved BY HAND (click-to-place, a drag): Apply spaces its tabs round this one
  // and never replaces it.
  manual?: true
}

/** A path tabs are applied to: its outline, and the model when it is an STL. */
export interface TabTarget { id: string; d: string; stlSrc?: string; stlModelBounds?: StlModelBounds }

interface TabState {
  tabs: Tab[]
  // Replace all tabs for a path with evenly-spaced new ones, snapped to segment midpoints
  applyTabs: (pathId: string, count: number, d: string, lengthMM: number, heightMM: number) => void
  // The same for every path in `paths` at once — one store write and ONE undo step, so a
  // sheet of parts is tabbed in one click and taken back in one undo.
  // (On a tight nest a neighbour's cut sweeps per-path tabs away: see the sheet's bridges,
  // cam/bridges.ts.)
  // A model's tabs go on its silhouette, not its box (cam/stlOutline `tabOutline`).
  applyTabsMany: (paths: TabTarget[], count: number, lengthMM: number, heightMM: number) => void
  // One tab, where the Tabs form's click-to-place put it. Its own undo step (or the paths'
  // Tabs step while that is the latest, as every tab edit).
  addTab: (pathId: string, t: number, lengthMM: number, heightMM: number) => void
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
    // HAND-PLACED TABS STAY WHERE THEY WERE PUT (`manual`), at the size being applied — the
    // size is the form's, the place is the user's. An evenly spaced one that would overlap
    // one of them is left out: it would be the same tab twice.
    const newTabs = paths.flatMap((p) => {
      const kept = get().tabs.filter((t) => t.pathId === p.id && t.manual).map((t) => ({ ...t, lengthMM, heightMM }))
      const polys = tabOutline(p)
      let len = 0
      for (const r of polys) for (let i = 1; i < r.length; i++) len += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1])
      const near = (a: number, b: number) => { const dt = Math.abs(a - b); return Math.min(dt, 1 - dt) * len < lengthMM }
      const even = tabsAlong(p.id, count, polys, lengthMM, heightMM).filter((t) => !kept.some((k) => near(k.t, t.t)))
      return [...kept, ...even].map((t) => (batchId ? { ...t, batchId } : t))
    })
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

  addTab: (pathId, t, lengthMM, heightMM) => {
    const tab: Tab = { id: uid('tab'), pathId, t: Math.max(0, Math.min(1, t)), lengthMM, heightMM, manual: true }
    set((s) => ({ tabs: [...s.tabs, tab] }))
    const tl = useTimelineStore.getState()
    if (!tl.joinsTip([{ tabsOf: pathId }])) tl.record({ kind: 'tabs.apply', pathId, tabs: [tab] })
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
    set((s) => ({ tabs: s.tabs.map((tab) => tab.id === id ? { ...tab, t: clamped, manual: true } : tab) }))
    const tab = get().tabs.find((x) => x.id === id)
    const tl = useTimelineStore.getState()
    if (!tab || !tl.joinsTip([{ tabsOf: tab.pathId }])) {
      tl.record({ kind: 'tabs.moveT', tabId: id, t01: clamped })
    }
  },

  getPathTabs: (pathId) => get().tabs.filter((t) => t.pathId === pathId),

  replaceTabs: (tabs) => set({ tabs }),
}))

// `count` tabs evenly spaced along the outline by arc length, kept off its corners (cam/tabPlacement.ts).
function tabsAlong(pathId: string, count: number, polys: [number, number][][], lengthMM: number, heightMM: number): Tab[] {
  return tabPositions(polys, count, lengthMM).map((t) => ({
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
