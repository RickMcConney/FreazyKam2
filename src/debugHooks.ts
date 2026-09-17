// Dev-only console handles on the stores.
//
// `window.__fkamReplayCheck` used to serve this purpose incidentally — it was
// registered by the replay oracle, which went when undo became a snapshot stack.
// Losing it meant no way to ask a running app what state it is in, which is
// exactly the question a "why did that shortcut do nothing" report needs.
//
//   __fkam.ui().nodeEditPathId     // non-null disables the Delete shortcut
//   __fkam.paths().selectedIds
//   __fkam.focus()                 // what has keyboard focus right now
import { usePathsStore } from './store/pathsStore'
import { useToolpathStore } from './store/toolpathStore'
import { useUIStore } from './store/uiStore'
import { useTimelineStore } from './timeline/timelineStore'

declare global {
  interface Window { __fkam?: Record<string, unknown> }
}

if (import.meta.env.DEV) {
  window.__fkam = {
    paths: () => usePathsStore.getState(),
    ops: () => useToolpathStore.getState(),
    ui: () => useUIStore.getState(),
    timeline: () => useTimelineStore.getState(),
    /** The element the keyboard is talking to — an INPUT here swallows shortcuts. */
    focus: () => {
      const el = document.activeElement as HTMLElement | null
      return el ? { tag: el.tagName, cls: el.className, editable: el.isContentEditable } : null
    },
    /** Why is Delete doing nothing? Answers it in one call. */
    whyNoDelete: () => {
      const ui = useUIStore.getState()
      const el = document.activeElement as HTMLElement | null
      const inInput = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      return {
        selected: usePathsStore.getState().selectedIds,
        nodeEditPathId: ui.nodeEditPathId,
        focused: el?.tagName ?? null,
        verdict: inInput ? 'focus is in a text field — shortcuts are ignored'
          : ui.nodeEditPathId ? 'node edit is active — Delete is reserved for points/segments'
          : usePathsStore.getState().selectedIds.length === 0 ? 'nothing is selected'
          : 'should work',
      }
    },
  }
}
