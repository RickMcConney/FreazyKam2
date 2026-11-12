// The DOCUMENT list: paths, their visibility and their SVG import groups.
//
// Toolpaths are its sibling view in the same sidebar tab (panels/ToolpathsPanel.tsx),
// which shows them in true program order. They once lived in the bottom half of this
// panel, grouped by tool id regardless of their actual order — so a list running A, B, A
// drew two tidy groups while the machine performed three tool changes.
//
// On a MULTI-SHEET drawing the list is folders, one per sheet (cam/sheets), as the
// Toolpaths list is: each path under the sheet it LIES on, so a group spread over two
// sheets by a nest shows under both, with its members on each. One sheet: no sheet folders.
//
// Hovering a row or any folder lights its paths up on the canvas (`uiStore.hoverPathIds`,
// HoverHighlightLayer). The pencil renames a path or a top-level folder in place
// (tools/renamePaths — a path's toolpaths are renamed with it).
import { useEffect, useState } from 'react'
import { ICON } from '../theme'
import { Eye, EyeOff, Trash2, Layers, ChevronRight, ChevronDown, FolderOpen, Folder, Image, Box, Pencil } from 'lucide-react'
import { usePathsStore, groupKeyOf, outerGroupOf, type ImportedPath } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { cellKey, sameCell, type Cell } from '../cam/sheets'
import { pathCell, sheetName, useActiveSheet } from '../canvas/useSheets'
import { renamePath, renameGroup } from '../tools/renamePaths'
import { sourceTree, type SourceItem } from './sourceTree'

const iconBtn = 'opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity'
const deleteBtn = 'opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400 transition-opacity'
// The list is ALPHABETICAL at every level, folders before rows — natural order, so
// "Part 2" comes before "Part 10". Document order still lives in the Objects strip.
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare
function sortItems(items: SourceItem[]): SourceItem[] {
  const nameOf = (it: SourceItem) => (it.kind === 'path' ? it.path.name : it.name)
  return [...items].sort((a, b) =>
    (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || byName(nameOf(a), nameOf(b)))
}

const hover = (ids: string[]) => useUIStore.getState().setHoverPathIds(ids)

/**
 * A name that can be edited in place: the text, or — while `editing` — a field holding it.
 * Enter or leaving the field commits, Escape gives up. The row it sits in selects on click,
 * so the field keeps its clicks and keys to itself.
 */
function NameField({ name, editing, onDone, className }: {
  name: string; editing: boolean; onDone: (name: string | null) => void; className: string
}) {
  const [draft, setDraft] = useState(name)
  useEffect(() => { if (editing) setDraft(name) }, [editing, name])
  if (!editing) return <span className={`flex-1 min-w-0 truncate ${className}`} title={name}>{name}</span>
  return (
    <input autoFocus value={draft} aria-label="Name"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onDone(draft)
        else if (e.key === 'Escape') onDone(null)
      }}
      onBlur={() => onDone(draft)}
      className="flex-1 min-w-0 px-1 h-5 rounded border border-blue-500 bg-white dark:bg-neutral-900 text-body text-gray-900 dark:text-neutral-100 focus:outline-none" />
  )
}

function RenameButton({ onClick }: { onClick: () => void }) {
  return (
    <button title="Rename" onClick={(e) => { e.stopPropagation(); onClick() }} className={iconBtn}>
      <Pencil size={ICON.sm} />
    </button>
  )
}

/** One path: a row of a folder, or a loose one at the top level. */
function PathRow({ p }: { p: ImportedPath }) {
  const selected = usePathsStore((s) => s.selectedIds.includes(p.id))
  const onlySelected = usePathsStore((s) => s.selectedIds.length === 1)
  const { selectPath, toggleVisibility, deletePath, showPath } = usePathsStore.getState()
  const [renaming, setRenaming] = useState(false)
  return (
    <li
      className={[
        'flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer group',
        p.hidden ? 'opacity-40' : '',
        selected ? 'bg-blue-600/20 text-blue-300' : 'hover:bg-gray-300/50 dark:hover:bg-neutral-700/50',
      ].join(' ')}
      onMouseEnter={() => hover([p.id])} onMouseLeave={() => hover([])}
      onClick={(e) => selectPath(selected && onlySelected ? null : p.id, e.shiftKey)}
    >
      {p.stlSrc
        ? <Box size={ICON.sm} className="flex-shrink-0 text-gray-600 dark:text-neutral-400" />
        : p.imageSrc
          ? <Image size={ICON.sm} className="flex-shrink-0 text-gray-600 dark:text-neutral-400" />
          : <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />}
      <NameField name={p.name} editing={renaming} className="text-body text-gray-800 dark:text-neutral-200"
        onDone={(name) => { setRenaming(false); if (name !== null) renamePath(p.id, name) }} />
      {!renaming && <RenameButton onClick={() => setRenaming(true)} />}
      {p.hidden ? (
        <button title="Restore (un-hide from boolean op)"
          onClick={(e) => { e.stopPropagation(); showPath(p.id) }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-amber-600 dark:text-amber-400 transition-opacity">
          <Eye size={ICON.sm} />
        </button>
      ) : (
        <button title={p.visible ? 'Hide path' : 'Show path'}
          onClick={(e) => { e.stopPropagation(); toggleVisibility(p.id) }} className={iconBtn}>
          {p.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
        </button>
      )}
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
 * Their names are the file's (what labels and assembly go by) and are not renamed here.
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
        if (it.kind === 'path') return <PathRow key={it.path.id} p={it.path} />
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
              onMouseEnter={() => hover(ids)} onMouseLeave={() => hover([])}
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

/** A top-level folder: an import, a multi-part shape, or a group the user tied together. */
function GroupFolder({ groupId, name, members, openSource, toggleSource }: {
  groupId: string; name: string; members: ImportedPath[]
  openSource: ReadonlySet<string>; toggleSource: (id: string) => void
}) {
  const collapsed = usePathsStore((s) => s.collapsedGroups.has(groupId))
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const { toggleGroupCollapsed, setPathsVisible, applyPathEdit } = usePathsStore.getState()
  const [renaming, setRenaming] = useState(false)
  // Acting on the members SHOWN: under a sheet folder that is the part of the group on
  // that sheet, which is what its eye and its delete are seen to be beside.
  const ids = members.map((p) => p.id)
  const allVisible = members.every((p) => p.visible)
  const anySelected = members.some((p) => selectedIds.includes(p.id))
  return (
    <li>
      <div
        className={[
          'flex items-center gap-1 px-1 py-1 rounded cursor-pointer group select-none',
          anySelected ? 'bg-blue-600/10' : 'hover:bg-gray-300/50 dark:hover:bg-neutral-700/50',
        ].join(' ')}
        onMouseEnter={() => hover(ids)} onMouseLeave={() => hover([])}
        onClick={() => toggleGroupCollapsed(groupId)}
      >
        <span className="text-gray-600 dark:text-neutral-400 flex-shrink-0">
          {collapsed ? <ChevronRight size={ICON.sm} /> : <ChevronDown size={ICON.sm} />}
        </span>
        <span className="text-gray-600 dark:text-neutral-400 flex-shrink-0">
          {collapsed ? <Folder size={ICON.sm} /> : <FolderOpen size={ICON.sm} />}
        </span>
        <NameField name={name} editing={renaming} className="text-body text-gray-700 dark:text-neutral-300 font-medium"
          onDone={(n) => { setRenaming(false); if (n !== null) renameGroup(groupId, n) }} />
        <span className="text-xs text-gray-600 dark:text-neutral-400 flex-shrink-0 mr-1">{members.length}</span>
        {!renaming && <RenameButton onClick={() => setRenaming(true)} />}
        <button title={allVisible ? 'Hide group' : 'Show group'}
          onClick={(e) => { e.stopPropagation(); setPathsVisible(ids, !allVisible) }} className={iconBtn}>
          {allVisible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
        </button>
        <button title="Delete group" onClick={(e) => { e.stopPropagation(); applyPathEdit({ deleteIds: ids }) }} className={deleteBtn}>
          <Trash2 size={ICON.sm} />
        </button>
      </div>
      {/* Member paths, in the file's own groups where it had any */}
      {!collapsed && <SourceItems items={sourceTree(members)} open={openSource} onToggle={toggleSource} />}
    </li>
  )
}

/** `paths` as the list draws them: group folders first, then the loose ones, by name. */
function PathTree({ paths, openSource, toggleSource }: {
  paths: ImportedPath[]; openSource: ReadonlySet<string>; toggleSource: (id: string) => void
}) {
  // Either axis makes a folder: an import/shape group, or a group the user tied
  // together — and a path in both is listed under the user's, which is the outer
  // one (groupKeyOf).
  const groupMap = new Map<string, ImportedPath[]>()
  const ungrouped: ImportedPath[] = []
  for (const p of paths) {
    const key = groupKeyOf(p)
    if (!key) { ungrouped.push(p); continue }
    const g = groupMap.get(key)
    if (g) g.push(p); else groupMap.set(key, [p])
  }
  // A user group has no name of its own unless the user gave it one (`groupLabels`): it
  // is whatever was put in it, so it is labelled for what it is, its count beside it.
  const groupNameOf = (groupId: string) => {
    const first = groupMap.get(groupId)![0]
    return outerGroupOf(first) === groupId ? first.groupLabels?.[groupId] ?? 'Group' : first.groupName ?? groupId
  }
  const groupOrder = [...groupMap.keys()].sort((a, b) => byName(groupNameOf(a), groupNameOf(b)))
  ungrouped.sort((a, b) => byName(a.name, b.name))
  return (
    <>
      {groupOrder.map((groupId) => (
        <GroupFolder key={groupId} groupId={groupId} name={groupNameOf(groupId)} members={groupMap.get(groupId)!}
          openSource={openSource} toggleSource={toggleSource} />
      ))}
      {/* Ungrouped paths (shapes, pen tool, etc.) */}
      {ungrouped.map((p) => <PathRow key={p.id} p={p} />)}
    </>
  )
}

export default function PathsPanel() {
  const paths = usePathsStore((s) => s.paths)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const doubleSided = useWorkpieceStore((s) => s.doubleSided)
  const { cells, cell: activeCell } = useActiveSheet()
  // Which of the file's own groups are open — closed unless opened, and per session.
  const [openSource, setOpenSource] = useState<ReadonlySet<string>>(new Set())
  const toggleSource = (id: string) => setOpenSource((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  // Folded sheets, by cell key. View state only.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const toggleFold = (key: string) => setFolded((f) => {
    const next = new Set(f)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  // The highlight never outlives the list (a click on a tab swaps it for another view).
  useEffect(() => () => hover([]), [])

  // The paths by the sheet each lies on, in the sheets' reading order. A sheet holding
  // only hidden paths is not one of `cells` (hidden paths claim no sheet) and comes last.
  const stock = { widthMM, heightMM }
  const bySheet = new Map<string, { cell: Cell; paths: ImportedPath[] }>()
  for (const p of paths) {
    const cell = pathCell(p, stock), key = cellKey(cell)
    const g = bySheet.get(key)
    if (g) g.paths.push(p); else bySheet.set(key, { cell, paths: [p] })
  }
  const numberOf = (c: Cell) => cells.findIndex((x) => sameCell(x, c))
  const sheets = [...bySheet.entries()].map(([key, g]) => ({ key, ...g, k: numberOf(g.cell) }))
    .sort((a, b) => (a.k < 0 ? Infinity : a.k) - (b.k < 0 ? Infinity : b.k))
  const { setPathsVisible } = usePathsStore.getState()

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Path list */}
      <p className="px-3 pt-2 pb-1 text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider">Paths</p>

      {paths.length === 0 ? (
        <div className="px-3 py-6 text-body text-gray-600 dark:text-neutral-400 text-center">
          <Layers size={ICON.lg} className="mx-auto mb-2 opacity-30" />
          No paths yet. Use the Import button in the toolbar.
        </div>
      ) : sheets.length <= 1 ? (
        <ul className="px-2 pb-2 space-y-0.5" onMouseLeave={() => hover([])}>
          <PathTree paths={paths} openSource={openSource} toggleSource={toggleSource} />
        </ul>
      ) : (
        <ul className="px-2 pb-2 space-y-1" onMouseLeave={() => hover([])}>
          {sheets.map((g) => {
            const name = g.k >= 0 ? sheetName(g.cell, g.k, doubleSided) : 'Hidden, off the sheets'
            const open = !folded.has(g.key)
            const ids = g.paths.map((p) => p.id)
            const n = ids.length
            const allVisible = g.paths.every((p) => p.visible)
            const active = sameCell(g.cell, activeCell)
            return (
              <li key={g.key}>
                <div onClick={() => toggleFold(g.key)}
                  onMouseEnter={() => hover(ids)} onMouseLeave={() => hover([])}
                  title={`${name} — ${n} path${n === 1 ? '' : 's'}${active ? '. The sheet Simulate plays.' : ''}\nClick to ${open ? 'fold' : 'unfold'}`}
                  className="group flex items-center gap-1 h-7 px-1 rounded cursor-pointer select-none bg-gray-200/70 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-800 dark:text-neutral-200">
                  {open ? <ChevronDown size={ICON.sm} className="flex-shrink-0" /> : <ChevronRight size={ICON.sm} className="flex-shrink-0" />}
                  {open ? <FolderOpen size={ICON.sm} className="flex-shrink-0 text-gray-500 dark:text-neutral-400" /> : <Folder size={ICON.sm} className="flex-shrink-0 text-gray-500 dark:text-neutral-400" />}
                  <span className={`flex-1 min-w-0 truncate text-[12px] ${active ? 'font-bold' : 'font-semibold'}`}>{name}</span>
                  <span className="text-xs text-gray-600 dark:text-neutral-400 flex-shrink-0 mr-1">{n}</span>
                  <button title={allVisible ? `Hide all ${n} on ${name}` : `Show all ${n} on ${name}`}
                    onClick={(e) => { e.stopPropagation(); setPathsVisible(ids, !allVisible) }} className={iconBtn}>
                    {allVisible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                  </button>
                </div>
                {open && (
                  <ul className="pl-2 mt-0.5 space-y-0.5">
                    <PathTree paths={g.paths} openSource={openSource} toggleSource={toggleSource} />
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}

    </div>
  )
}
