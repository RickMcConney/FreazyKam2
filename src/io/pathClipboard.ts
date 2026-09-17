// Copying paths from one project to another.
//
// The gesture is Ctrl+C / Ctrl+V and the payload is the app's OWN objects, not
// SVG — which is the whole point. A path here is not an outline: it carries the
// parameters it was generated from (`shapeParams`), the corner recipe `d` was
// cut with, the provenance a form reopens on, and its group, clock and
// user-group membership. An SVG round-trip would hand back a dead outline, and a
// gear that cannot be re-cut at m4 is not a copy of a gear.
//
// It rides the SYSTEM clipboard as text, so it crosses browser tabs and windows
// — which is what "another project" means here — and it goes through the
// document's own `copy`/`paste` events rather than `navigator.clipboard`, which
// needs a permission prompt to READ.
//
// THE WORK IS THE ID REMAP, not the transfer. Every id in the payload has to be
// reissued, and reissued CONSISTENTLY: a gear's three parts share a `groupId`
// and must go on sharing one, a clock's parts share a `clockId`, a user group is
// a chain of ids, and a pattern's copies share a `definition.id`. Reuse an id
// and the paste joins the group it was copied from; reissue them independently
// and a gear arrives as three unrelated paths that no longer regenerate
// together.

import { usePathsStore } from '../store/pathsStore'
import { copyPaths, constraintsWithin, withHiddenSources } from '../store/copyPaths'
import { useTabStore, type Tab } from '../store/tabStore'
import { useConstraintsStore } from '../store/constraintsStore'
import type { Constraint } from '../store/constraints'
import { useUIStore } from '../store/uiStore'
import type { ImportedPath } from '../importers/svgImporter'

/** Marks the text as ours. Anything else on the clipboard is left to the browser. */
const MARKER = 'freazykam/paths'
const VERSION = 1

/** How far a paste lands from the original when it recognises its own project —
 *  the same nudge `duplicateSelected` uses, and for the same reason: a copy
 *  landing exactly on top of what it was copied from looks like nothing
 *  happened. */
const SAME_DOC_OFFSET_MM = 5

export interface ClipboardPayload {
  kind: typeof MARKER
  version: number
  paths: ImportedPath[]
  /** Holding tabs belong TO a path and reference nothing else, so they travel
   *  with it. Operations deliberately do NOT: they name a tool and can sit on
   *  another operation's floor (`startFrom`), neither of which the other project
   *  need have, and a half-valid operation is worse than none. */
  tabs: Tab[]
  /** The constraints among the copied paths — only those with BOTH ends in the
   *  set, which is `duplicateSelected`'s rule and `userGroups`' rule before it:
   *  a constraint with one end left behind is not a copy of anything the user
   *  selected, and re-pointing it at what stayed would tie the new parts to the
   *  old ones. A stock edge counts as copied — it is ground, and every project
   *  has one. Older payloads have no field here; those paste unconstrained. */
  constraints?: Constraint[]
}

/** Which constraints travel with `paths` — both ends copied, or it stays behind. The rule
 *  lives with the copy itself now (store/copyPaths); re-exported so existing importers
 *  keep one place to ask. */
export { constraintsWithin }

export function serializePaths(paths: ImportedPath[], tabs: Tab[], constraints: Constraint[] = []): string {
  const ids = new Set(paths.map((p) => p.id))
  const payload: ClipboardPayload = {
    kind: MARKER,
    version: VERSION,
    paths,
    tabs: tabs.filter((t) => ids.has(t.pathId)),
    constraints: constraintsWithin(constraints, ids),
  }
  return JSON.stringify(payload)
}

/** The payload in this text, or null if it is not ours — which is most text. */
export function parsePaths(text: string): ClipboardPayload | null {
  if (!text || !text.includes(MARKER)) return null
  try {
    const data = JSON.parse(text) as Partial<ClipboardPayload>
    if (data?.kind !== MARKER || !Array.isArray(data.paths) || data.paths.length === 0) return null
    return {
      kind: MARKER,
      version: typeof data.version === 'number' ? data.version : VERSION,
      paths: data.paths as ImportedPath[],
      tabs: Array.isArray(data.tabs) ? (data.tabs as Tab[]) : [],
      constraints: Array.isArray(data.constraints) ? (data.constraints as Constraint[]) : [],
    }
  } catch {
    return null
  }
}

/**
 * The payload as objects this document can hold: every id reissued, everything
 * that was shared still shared, and everything pointing OUT of the copied set
 * let go of.
 *
 * `existingIds` are the paths already in the document. They decide two things:
 * whether this is a paste back into the project the copy came from (so it is
 * nudged clear rather than landing exactly on the original), and nothing else —
 * ids are reissued either way, because a paste is a new object even when it is a
 * copy of one that is still there.
 */
export function remapForPaste(
  payload: ClipboardPayload,
  existingIds: Set<string>,
): { paths: ImportedPath[]; tabs: Tab[]; constraints: Constraint[] } {
  const sameDoc = payload.paths.some((p) => existingIds.has(p.id))
  // The one copy Duplicate makes too (store/copyPaths). What is Paste's own: the nudge only
  // when the copy recognises its own project, and a recipe that could not come is DROPPED
  // rather than recorded as "copied from" — the path it would name may be in another
  // project entirely. Tabs and constraints are filtered again on the way in, because a
  // payload is text off the system clipboard and may say anything.
  const { paths, tabs, constraints } = copyPaths(
    payload.paths, payload.tabs, payload.constraints ?? [],
    { offsetMM: sameDoc ? SAME_DOC_OFFSET_MM : 0, pathIdPrefix: 'path-paste', lostRecipe: 'drop' },
  )
  return { paths, tabs, constraints }
}

/** Put the current selection on the clipboard. Returns how many paths went. */
export function copySelectionToClipboard(e: ClipboardEvent): number {
  const { paths, selectedIds } = usePathsStore.getState()
  const selectedCount = paths.filter((p) => selectedIds.includes(p.id)).length
  if (selectedCount === 0) return 0
  // The selection AND the hidden paths it is generated from, exactly as Duplicate takes
  // them (store/copyPaths). Copy used to put a boolean on the clipboard without its
  // operands, so the paste had to drop the recipe and arrived as dead outline where a
  // duplicate of the same boolean reopened in its form.
  const picked = withHiddenSources(selectedIds, paths)
  e.clipboardData?.setData('text/plain', serializePaths(
    picked, useTabStore.getState().tabs, useConstraintsStore.getState().constraints))
  e.preventDefault()
  return selectedCount
}

/** Take paths off the clipboard text, if it is ours. Returns how many arrived. */
export function pastePathsFromText(text: string): number {
  const payload = parsePaths(text)
  if (!payload) return 0
  const store = usePathsStore.getState()
  const { paths, tabs, constraints } = remapForPaste(payload, new Set(store.paths.map((p) => p.id)))
  if (paths.length === 0) return 0
  // Selected: what was COPIED, never the hidden operands that rode along with it — the
  // same rule Duplicate follows, since selecting something invisible leaves the panel
  // describing a thing that is not on screen.
  const shown = paths.filter((p) => !p.hidden)
  const selected = shown.length > 0 ? shown : paths
  store.addPaths(paths, { source: 'paste', label: selected.length === 1 ? selected[0].name : `Paste ×${selected.length}` })
  store.setSelectedIds(selected.map((p) => p.id))
  if (tabs.length > 0) useTabStore.getState().replaceTabs([...useTabStore.getState().tabs, ...tabs])
  // Installed raw, like every other cleanup that rides inside somebody else's
  // edit: `addPaths` has already recorded, and the snapshot it takes is what
  // undo restores — so one Ctrl+Z takes the paths and their constraints back
  // together. They arrive already satisfied (the geometry came over with them),
  // and a solve over satisfied constraints emits no moves, so there is nothing
  // to run here.
  if (constraints.length > 0) {
    const cs = useConstraintsStore.getState()
    cs.replaceConstraints([...cs.constraints, ...constraints])
  }
  // The count the status bar reports is what the user copied, not the operands with it.
  return selected.length
}

/**
 * Wire the document's clipboard events. Installed once from App.
 *
 * It steps aside for ordinary text: a field being typed in, or any live text
 * selection on the page — the G-code viewer copies its own selection that way,
 * and a document-level handler that overwrote the clipboard afterwards would
 * take that away.
 */
export function installPathClipboard(): () => void {
  const inText = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null
    if (!el) return false
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  }
  const textSelected = () => (window.getSelection()?.toString().length ?? 0) > 0

  const onCopy = (e: ClipboardEvent) => {
    if (inText(e.target) || textSelected()) return
    const n = copySelectionToClipboard(e)
    if (n > 0) useUIStore.getState().showStatus(`${n} path${n > 1 ? 's' : ''} copied — paste into any project.`)
  }
  const onCut = (e: ClipboardEvent) => {
    if (inText(e.target) || textSelected()) return
    const n = copySelectionToClipboard(e)
    if (n === 0) return
    usePathsStore.getState().deleteSelected()
    useUIStore.getState().showStatus(`${n} path${n > 1 ? 's' : ''} cut.`)
  }
  const onPaste = (e: ClipboardEvent) => {
    if (inText(e.target)) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    const n = pastePathsFromText(text)
    if (n === 0) return                     // not ours — leave it to the browser
    e.preventDefault()
    useUIStore.getState().showStatus(`${n} path${n > 1 ? 's' : ''} pasted.`)
  }

  document.addEventListener('copy', onCopy)
  document.addEventListener('cut', onCut)
  document.addEventListener('paste', onPaste)
  return () => {
    document.removeEventListener('copy', onCopy)
    document.removeEventListener('cut', onCut)
    document.removeEventListener('paste', onPaste)
  }
}
