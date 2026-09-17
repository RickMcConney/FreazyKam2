// The DOCUMENT list: paths, their visibility and their SVG import groups.
//
// Toolpaths used to live in the bottom half of this panel. They moved to the Operations
// strip under the canvas (panels/OperationsPanel.tsx), which shows them in true program
// order — this panel grouped them by tool id regardless of their actual order, so a list
// running A, B, A drew two tidy groups while the machine performed three tool changes.
import { ICON } from '../theme'
import { Eye, EyeOff, Trash2, Layers, ChevronRight, ChevronDown, FolderOpen, Folder, Image, Box } from 'lucide-react'
import { usePathsStore, groupKeyOf, outerGroupOf } from '../store/pathsStore'

export default function PathsPanel() {
  const {
    paths, selectedIds, collapsedGroups,
    selectPath, toggleVisibility, deletePath,
    toggleGroupVisibility, toggleGroupCollapsed, deleteGroup,
    showPath,
  } = usePathsStore()
  // Separate grouped vs ungrouped paths; preserve original order within groups
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
            // A user group has no name of its own — it is whatever the user put
            // in it — so it is labelled for what it is, with the member count
            // already shown beside it.
            const groupName = outerGroupOf(members[0]) === groupId
              ? 'Group'
              : members[0].groupName ?? groupId
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

                {/* Member paths */}
                {!collapsed && (
                  <ul className="ml-5 space-y-0.5 mt-0.5">
                    {members.map((p) => (
                      <li
                        key={p.id}
                        className={[
                          'flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer group',
                          selectedIds.includes(p.id) ? 'bg-blue-600/20 text-blue-300' : 'hover:bg-gray-300/50 dark:hover:bg-neutral-700/50',
                        ].join(' ')}
                        onClick={(e) => selectPath(selectedIds.includes(p.id) && selectedIds.length === 1 ? null : p.id, e.shiftKey)}
                      >
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                        <span className="flex-1 text-body truncate text-gray-800 dark:text-neutral-200">{p.name}</span>
                        <button
                          title={p.visible ? 'Hide path' : 'Show path'}
                          onClick={(e) => { e.stopPropagation(); toggleVisibility(p.id) }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity"
                        >
                          {p.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                        </button>
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
