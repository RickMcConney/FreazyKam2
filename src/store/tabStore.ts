import { create } from 'zustand'
import { flattenPath, type Pt2 } from '../cam/pathFlattener'
import { useTimelineStore } from '../timeline/timelineStore'
import { uid } from '../uid'

export interface Tab {
  id: string
  pathId: string
  t: number        // 0..1 arc-length fraction along the source design path
  lengthMM: number
  heightMM: number // height above cut bottom (G-code lifts to -(depth - heightMM))
}

interface TabState {
  tabs: Tab[]
  // Replace all tabs for a path with evenly-spaced new ones, snapped to segment midpoints
  applyTabs: (pathId: string, count: number, d: string, lengthMM: number, heightMM: number) => void
  deleteTab: (id: string) => void
  deletePathTabs: (pathId: string) => void
  updateTabT: (id: string, t: number) => void
  getPathTabs: (pathId: string) => Tab[]
  replaceTabs: (tabs: Tab[]) => void  // used by project load
}

export const useTabStore = create<TabState>()((set, get) => ({
  tabs: [],

  applyTabs: (pathId, count, d, lengthMM, heightMM) => {
    const existing = get().tabs.filter((t) => t.pathId !== pathId)
    const newTabs: Tab[] = []

    // Build arc-length index across all subpaths (same structure as designPathAtT in profile.ts)
    const subpaths = flattenPath(d, 0.05)
    interface SubSeg { pts: Pt2[]; startLen: number; cumLens: number[]; segLen: number }
    const subSegs: SubSeg[] = []
    let totalLen = 0
    for (const sp of subpaths) {
      const cumLens: number[] = [0]
      for (let i = 1; i < sp.length; i++) {
        cumLens.push(cumLens[i - 1] + Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]))
      }
      const segLen = cumLens[cumLens.length - 1]
      subSegs.push({ pts: sp, startLen: totalLen, cumLens, segLen })
      totalLen += segLen
    }

    for (let i = 0; i < count; i++) {
      const initialT = (i + 0.5) / count
      let snappedT = initialT

      if (totalLen > 1e-6) {
        const target = initialT * totalLen
        outer: for (const ss of subSegs) {
          const localTarget = target - ss.startLen
          if (localTarget > ss.segLen && ss !== subSegs[subSegs.length - 1]) continue
          for (let j = 1; j < ss.pts.length; j++) {
            if (ss.cumLens[j] >= localTarget - 1e-10 || j === ss.pts.length - 1) {
              const midLen = ss.startLen + (ss.cumLens[j - 1] + ss.cumLens[j]) / 2
              snappedT = midLen / totalLen
              break outer
            }
          }
        }
      }

      newTabs.push({
        id: uid('tab'),
        pathId,
        t: snappedT,
        lengthMM,
        heightMM,
      })
    }

    set({ tabs: [...existing, ...newTabs] })
    // Tab edits join the path's Tabs step while it is the LATEST one. Once anything has
    // been recorded after it, an edit records its own — it needs its own undo step (see
    // joinsTip in timelineStore).
    const tl = useTimelineStore.getState()
    if (!tl.joinsTip([{ tabsOf: pathId }])) {
      tl.record({ kind: 'tabs.apply', pathId, tabs: newTabs })
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

  deletePathTabs: (pathId) => {
    const ids = get().tabs.filter((t) => t.pathId === pathId).map((t) => t.id)
    if (ids.length === 0) return
    set((s) => ({ tabs: s.tabs.filter((t) => t.pathId !== pathId) }))
    const tl = useTimelineStore.getState()
    if (!tl.joinsTip([{ tabsOf: pathId }])) {
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
