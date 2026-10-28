// The DOCUMENT list: paths, their visibility and their SVG import groups.
//
// Toolpaths are its sibling view in the same sidebar tab (panels/ToolpathsPanel.tsx),
// which shows them in true program order. They once lived in the bottom half of this
// panel, grouped by tool id regardless of their actual order — so a list running A, B, A
// drew two tidy groups while the machine performed three tool changes.
import { useState } from 'react'
import { ICON } from '../theme'
import { Eye, EyeOff, Trash2, Layers, ChevronRight, ChevronDown, FolderOpen, Folder, Image, Box } from 'lucide-react'
import { usePathsStore, groupKeyOf, outerGroupOf, type ImportedPath } from '../store/pathsStore'
import { sourceTree, type SourceItem } from './sourceTree'

const iconBtn = 'opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity'
// The list is ALPHABETICAL at every level, folders before rows — natural order, so
// "Part 2" comes before "Part 10". Document order still lives in the Objects strip.
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare
function sortItems(items: SourceItem[]): SourceItem[] {
  const nameOf = (it: SourceItem) => (it.kind === 'path' ? it.path.name : it.name)
  return [...items].sort((a, b) =>
    (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || byName(nameOf(a), nameOf(b)))
}

const deleteBtn = 'opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400 transition-opacity'

/** One path inside a folder. */
function MemberRow({ p }: { p: ImportedPath }) {
  const selected = usePathsStore((s) => s.selectedIds.includes(p.id))
  const onlySelected = usePathsStore((s) => s.selectedIds.length === 1)
  const { selectPath, toggleVisibility, deletePath } = usePathsStore.getState()
  return (
    <li
      className={[
        'flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer group',
        selected ? 'bg-blue-600/20 text-blue-300' : 'hover:bg-gray-300/50 dark:hover:bg-neutral-700/50',
      ].join(' ')}
      onClick={(e) => selectPath(selected && onlySelected ? null : p.id, e.shiftKey)}
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
      <span className="flex-1 text-body truncate text-gray-800 dark:text-neutral-200">{p.name}</span>
      <button title={p.visible ? 'Hide path' : 'Show path'}
        onClick={(e) => { e.stopPropagation(); toggleVisibility(p.id) }} className={iconBtn}>
        {p.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
      </button>
      <button title="Delete path" onClick={(e) => { e.stopPropagation(); deletePath(p.id) }} className={deleteBtn}>
        <Trash2 size={ICON.sm} />
      </button>
    </li>
  )
}

/**
 * The inside of an import folder: the file's own groups as folders (see sourceTree). They
 * start CLOSED — a sheet of 127 parts open would bury everything below it — and clicking
 * the name selects the whole part, which is the everyday reason to look for one here.
 */
function SourceItems({ items, open, onToggle }: {
  items: SourceItem[]
  open: ReadonlySet<string>
  onToggle: (id: string) => void
}) {
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const { setSelectedIds, setPathsVisible, applyPathEdit } = usePathsStore.getState()
  return (
    <ul className="ml-5 space-y-0.5 mt-0.5">
      {sortItems(items).map((it) => {
        if (it.kind === 'path') return <MemberRow key={it.path.id} p={it.path} />
        const isOpen = open.has(it.id)
        const ids = it.paths.map((p) => p.id)
        const allVisible = it.paths.every((p) => p.visible)
        const anySelected = ids.some((id) => selectedIds.includes(id))
        return (
          <li key={it.id}>
            <div
              className={[
                'flex items-center gap-1 px-1 py-1 rounded cursor-pointer group select-none',
                anySelected ? 'bg-blue-600/10' : 'hover:bg-gray-300/50 dark:hover:bg-neutral-700/50',
              ].join(' ')}
              title="Click to select this group's paths; shift-click to add them"
              onClick={(e) => setSelectedIds(e.shiftKey
                ? [...selectedIds, ...ids.filter((id) => !selectedIds.includes(id))]
                : ids)}
            >
              <button title={isOpen ? 'Collapse' : 'Expand'}
                onClick={(e) => { e.stopPropagation(); onToggle(it.id) }}
                className="text-gray-600 dark:text-neutral-400 flex-shrink-0">
                {isOpen ? <ChevronDown size={ICON.sm} /> : <ChevronRight size={ICON.sm} />}
              </button>
              <span className="text-gray-600 dark:text-neutral-400 flex-shrink-0">
                {isOpen ? <FolderOpen size={ICON.sm} /> : <Folder size={ICON.sm} />}
              </span>
              <span className="flex-1 text-body truncate text-gray-700 dark:text-neutral-300" title={it.name}>{it.name}</span>
              <span className="text-xs text-gray-600 dark:text-neutral-400 flex-shrink-0 mr-1">{it.paths.length}</span>
              <button title={allVisible ? 'Hide group' : 'Show group'}
                onClick={(e) => { e.stopPropagation(); setPathsVisible(ids, !allVisible) }} className={iconBtn}>
                {allVisible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
              </button>
              <button title="Delete group" onClick={(e) => { e.stopPropagation(); applyPathEdit({ deleteIds: ids }) }} className={deleteBtn}>
                <Trash2 size={ICON.sm} />
              </button>
            </div>
            {isOpen && <SourceItems items={it.items} open={open} onToggle={onToggle} />}
          </li>
        )
      })}
    </ul>
  )
}

export default function PathsPanel() {
  const {
    paths, selectedIds, collapsedGroups,
    selectPath, toggleVisibility, deletePath,
    toggleGroupVisibility, toggleGroupCollapsed, deleteGroup,
    showPath,
  } = usePathsStore()
  // Which of the file's own groups are open — closed unless opened, and per session.
  const [openSource, setOpenSource] = useState<ReadonlySet<string>>(new Set())
  const toggleSource = (id: string) => setOpenSource((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  // Separate grouped vs ungrouped paths (both sorted by name below)
  const groupOrder: string[] = []
  const groupMap = new Map<string, typeof paths>()
  const ungrouped: typeof paths = []

  // Either axis makes a folder: an import/shape group, or a group the user tied
  // together — and a path in both is listed under the user's, which is the outer
  // one (groupKeyOf).
  for (const p of paths) {
    const key = groupKeyOf(p)
    if (key) {
      if (!groupMap.has(key)) {
        groupMap.set(key, [])
        groupOrder.push(key)
      }
      groupMap.get(key)!.push(p)
    } else {
      ungrouped.push(p)
    }
  }

  // A user group has no name of its own — it is whatever the user put in it — so it
  // is labelled for what it is, with the member count already shown beside it.
  const groupNameOf = (groupId: string) => {
    const first = groupMap.get(groupId)![0]
    return outerGroupOf(first) === groupId ? 'Group' : first.groupName ?? groupId
  }
  groupOrder.sort((a, b) => byName(groupNameOf(a), groupNameOf(b)))
  ungrouped.sort((a, b) => byName(a.name, b.name))

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Path list */}
      <p className="px-3 pt-2 pb-1 text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider">Paths</p>

      {paths.length === 0 ? (
        <div className="px-3 py-6 text-body text-gray-600 dark:text-neutral-400 text-center">
          <Layers size={ICON.lg} className="mx-auto mb-2 opacity-30" />
          No paths yet. Use the Import button in the toolbar.
        </div>
      ) : (
        <ul className="px-2 pb-2 space-y-0.5">
          {/* SVG import groups */}
          {groupOrder.map((groupId) => {
            const members = groupMap.get(groupId)!
            const collapsed = collapsedGroups.has(groupId)
            const groupName = groupNameOf(groupId)
            const allVisible = members.every((p) => p.visible)
            const anySelected = members.some((p) => selectedIds.includes(p.id))

            return (
              <li key={groupId}>
                {/* Folder header row */}
                <div
                  className={[
                    'flex items-center gap-1 px-1 py-1 rounded cursor-pointer group select-none',
                    anySelected ? 'bg-blue-600/10' : 'hover:bg-gray-300/50 dark:hover:bg-neutral-700/50',
                  ].join(' ')}
                  onClick={() => toggleGroupCollapsed(groupId)}
                >
                  <span className="text-gray-600 dark:text-neutral-400 flex-shrink-0">
                    {collapsed ? <ChevronRight size={ICON.sm} /> : <ChevronDown size={ICON.sm} />}
                  </span>
                  <span className="text-gray-600 dark:text-neutral-400 flex-shrink-0">
                    {collapsed ? <Folder size={ICON.sm} /> : <FolderOpen size={ICON.sm} />}
                  </span>
                  <span className="flex-1 text-body truncate text-gray-700 dark:text-neutral-300 font-medium" title={groupName}>
                    {groupName}
                  </span>
                  <span className="text-xs text-gray-600 dark:text-neutral-400 flex-shrink-0 mr-1">
                    {members.length}
                  </span>
                  <button
                    title={allVisible ? 'Hide group' : 'Show group'}
                    onClick={(e) => { e.stopPropagation(); toggleGroupVisibility(groupId) }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity"
                  >
                    {allVisible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                  </button>
                  <button
                    title="Delete group"
                    onClick={(e) => { e.stopPropagation(); deleteGroup(groupId) }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400 transition-opacity"
                  >
                    <Trash2 size={ICON.sm} />
                  </button>
                </div>

                {/* Member paths, in the file's own groups where it had any */}
                {!collapsed && <SourceItems items={sourceTree(members)} open={openSource} onToggle={toggleSource} />}
              </li>
            )
          })}

          {/* Ungrouped paths (shapes, pen tool, etc.) */}
          {ungrouped.map((p) => (
            <li
              key={p.id}
              className={[
                'flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer group',
                p.hidden ? 'opacity-40' : '',
                selectedIds.includes(p.id) ? 'bg-blue-600/20 text-blue-300' : 'hover:bg-gray-300/50 dark:hover:bg-neutral-700/50',
              ].join(' ')}
              onClick={(e) => selectPath(selectedIds.includes(p.id) && selectedIds.length === 1 ? null : p.id, e.shiftKey)}
            >
              {p.stlSrc
                ? <Box size={ICON.sm} className="flex-shrink-0 text-gray-600 dark:text-neutral-400" />
                : p.imageSrc
                  ? <Image size={ICON.sm} className="flex-shrink-0 text-gray-600 dark:text-neutral-400" />
                  : <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
              }
              <span className="flex-1 text-body truncate text-gray-800 dark:text-neutral-200">{p.name}</span>
              {p.hidden && (
                <button
                  title="Restore (un-hide from boolean op)"
                  onClick={(e) => { e.stopPropagation(); showPath(p.id) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-amber-600 dark:text-amber-400 transition-opacity"
                >
                  <Eye size={ICON.sm} />
                </button>
              )}
              {!p.hidden && (
                <button
                  title={p.visible ? 'Hide path' : 'Show path'}
                  onClick={(e) => { e.stopPropagation(); toggleVisibility(p.id) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity"
                >
                  {p.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                </button>
              )}
              <button
                title="Delete path"
                onClick={(e) => { e.stopPropagation(); deletePath(p.id) }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400 transition-opacity"
              >
                <Trash2 size={ICON.sm} />
              </button>
            </li>
          ))}
        </ul>
      )}

    </div>
  )
}
