import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { create } from 'zustand'

// ─── Click a path in the list to take it out of the selection, or put it back ────────
//
// A form's path list IS the selection, so the click is a selection edit — the same thing a
// shift-click on the canvas does, without hunting for the path on the canvas. A path
// clicked out would then simply vanish from the list, leaving nothing to click back in, so
// the list remembers the ones it took out (`excluded`) and keeps showing them, struck
// through, IN THE ROW THEY WERE IN. Moved to the bottom, on a long list the row vanished
// from under the pointer and the user could not see what the click had done.
//
// So each excluded path records two neighbours, both taken at the click:
//  - `after`, the row DRAWN above it — the chip of that path draws it straight after
//    itself (`ExcludedAfter`), so it stays in place whatever order the form lists in (a
//    pocket's islands sit under their boundary, not in pick order);
//  - `selAfter`, the path before it in the SELECTION — clicking it back in puts it back
//    there, so its place in the cut order (pick order is cut order) is restored too.
// A neighbour that is itself excluded is followed back to the next one that is not.
//
// That memory belongs to the OPEN FORM (`useExcludedPathsScope`, run by FormShell) AND TO
// THE SELECTION IT WAS MADE FROM: it starts empty, and is dropped when the form closes or
// when anything other than this list changes the selection except by ADDING to it. Opening
// another batch for edit (the form stays mounted), Select Only, a plain click or a click on
// blank canvas all replace or cut the selection, and the struck-out rows belonged to the
// one before — kept, they turned up at the end of the next batch's list. A shift-click that
// adds a path is the one outside write that leaves them standing.

export interface ExcludedPath { id: string; after: string | null; selAfter: string | null }
export const useExcludedPaths = create<{ entries: ExcludedPath[] }>(() => ({ entries: [] }))
// Set while the list itself writes the selection, so the watcher can tell the list's own
// changes (clicking a path out) from someone else's.
let listWriting = false
// The selection array the list last wrote — the store keeps the array it is handed, so
// identity says whether the selection on show is still the list's own doing.
let listSelection: string[] | null = null

/** Is `ids` the selection the path list itself last wrote (no one has changed it since)? */
export function isListSelection(ids: string[]): boolean {
  return ids === listSelection
}

/**
 * Click `id` in the list: out of the selection if it is in, back in if it is out. `rowAbove`
 * is the id of the row drawn above it — only the rendered list knows that order, so the
 * component reads it off the page and hands it in.
 */
export function togglePathInSelection(id: string, rowAbove: string | null): void {
  const { selectedIds, setSelectedIds } = usePathsStore.getState()
  const entries = useExcludedPaths.getState().entries
  const entry = entries.find((e) => e.id === id)
  const rest = entries.filter((e) => e.id !== id)
  listWriting = true
  try {
    const at = selectedIds.indexOf(id)
    if (at >= 0) {
      listSelection = selectedIds.filter((x) => x !== id)
      setSelectedIds(listSelection)
      useExcludedPaths.setState({ entries: [...rest, { id, after: rowAbove, selAfter: selectedIds[at - 1] ?? null }] })
    } else {
      // Back where it was picked: after the nearest earlier path still selected. A path the
      // list never took out (an edited batch's removed member) has no slot and is appended,
      // as a shift-click appends it.
      let index = selectedIds.length
      if (entry) {
        const byId = new Map(entries.map((e) => [e.id, e]))
        let prev = entry.selAfter
        while (prev !== null && !selectedIds.includes(prev)) prev = byId.get(prev)?.selAfter ?? null
        index = prev === null ? 0 : selectedIds.indexOf(prev) + 1
      }
      listSelection = [...selectedIds.slice(0, index), id, ...selectedIds.slice(index)]
      setSelectedIds(listSelection)
      useExcludedPaths.setState({ entries: rest })
    }
  } finally {
    listWriting = false
  }
}

/** Forget every excluded path. */
export function clearExcluded(): void {
  useExcludedPaths.setState({ entries: [] })
}

/**
 * Start the open form's memory afresh and keep it tied to the selection it was made from
 * (see the header). Returns the unsubscribe, which forgets it too.
 */
export function watchSelectionForExclusions(): () => void {
  clearExcluded()
  const unsub = usePathsStore.subscribe((s, p) => {
    if (s.selectedIds === p.selectedIds || listWriting) return
    const now = new Set(s.selectedIds)
    if (!p.selectedIds.every((id) => now.has(id))) clearExcluded()
  })
  return () => { unsub(); clearExcluded() }
}

/**
 * Where each excluded path is drawn: after the row that was above it, or — when that row is
 * no longer drawn (deleted, or the form stopped listing it) — at the end of the list, under
 * the key `undefined`, so it can still be clicked back in. A path back in the selection is
 * the form's to draw and is left out.
 */
export function placeExcluded(entries: ExcludedPath[], paths: ImportedPath[], selected: Set<string>, drawn: Set<string>): Map<string | null | undefined, ImportedPath[]> {
  const out = new Map<string | null | undefined, ImportedPath[]>()
  if (entries.length === 0) return out
  const byId = new Map(paths.map((p) => [p.id, p]))
  const excluded = new Map(entries.map((e) => [e.id, e]))
  // Drawn in place when its chain of rows-above ends at a row that is drawn.
  const placed = (e: ExcludedPath, seen = new Set<string>()): boolean => {
    if (e.after === null) return true
    if (seen.has(e.id)) return false
    seen.add(e.id)
    if (selected.has(e.after) || drawn.has(e.after)) return true
    const up = excluded.get(e.after)
    return !!up && !selected.has(up.id) && placed(up, seen)
  }
  for (const e of entries) {
    const p = byId.get(e.id)
    if (!p || selected.has(e.id)) continue
    const key = placed(e) ? e.after : undefined
    const list = out.get(key)
    if (list) list.push(p); else out.set(key, [p])
  }
  return out
}
