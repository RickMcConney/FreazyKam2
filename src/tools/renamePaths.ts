// RENAMING from the Paths list. A path's name is not only a label: a toolpath's automatic
// name is built from it ("Profile: Rectangle (1/8" End Mill)"), and that is the section
// header the G-code carries and the machine's display shows. So renaming a path renames the
// toolpaths cut from it in the SAME undo step — except one whose name the user typed
// (`nameIsCustom`), which is theirs. Nothing is regenerated: a name cuts nothing.
import { usePathsStore, groupKeyOf, outerGroupOf } from '../store/pathsStore'
import { useToolpathStore, pathIdsOf, type AnyOperation } from '../store/toolpathStore'

/** `ops` with `was` replaced by `now` in the automatic names of those cut from `pathId`. */
export function opsRenamedFor(ops: AnyOperation[], pathId: string, was: string, now: string): AnyOperation[] {
  const marker = `: ${was}`
  let changed = false
  const next = ops.map((op) => {
    if (op.nameIsCustom || !op.name.includes(marker) || !pathIdsOf(op).includes(pathId)) return op
    changed = true
    return { ...op, name: op.name.replace(marker, `: ${now}`) }
  })
  return changed ? next : ops
}

/** Rename one path; blank or unchanged does nothing. One undo step, its toolpaths included. */
export function renamePath(id: string, name: string): void {
  const ps = usePathsStore.getState()
  const p = ps.paths.find((x) => x.id === id)
  const now = name.trim()
  if (!p || !now || now === p.name) return
  // The operations first, silently: the edit below records the step, and its snapshot
  // holds both stores, so one undo takes back both.
  const ops = useToolpathStore.getState().operations
  const renamed = opsRenamedFor(ops, id, p.name, now)
  if (renamed !== ops) useToolpathStore.setState({ operations: renamed })
  ps.applyPathEdit({ updates: [{ id, d: p.d, name: now, nameIsCustom: true }], label: 'Rename', regenerate: false })
}

/**
 * Rename a top-level folder of the Paths list (`groupKeyOf`): an import or multi-part shape
 * is named by `groupName` on every member; a user group has no record of its own, so its
 * name rides on its members too (`groupLabels`, by group id).
 */
export function renameGroup(groupKey: string, name: string): void {
  const ps = usePathsStore.getState()
  const members = ps.paths.filter((p) => groupKeyOf(p) === groupKey)
  const now = name.trim()
  if (members.length === 0 || !now) return
  const user = outerGroupOf(members[0]) === groupKey
  const updates = members
    .filter((p) => (user ? p.groupLabels?.[groupKey] : p.groupName) !== now)
    .map((p) => user
      ? { id: p.id, d: p.d, groupLabels: { ...p.groupLabels, [groupKey]: now } }
      : { id: p.id, d: p.d, groupName: now })
  if (updates.length > 0) ps.applyPathEdit({ updates, label: 'Rename', regenerate: false })
}
