import { Fragment, useMemo, useState } from 'react'
import { NumericInput } from '../components/NumericInput'
import { NUMERIC_HINT } from '../components/parseNumeric'
import { ChevronDown, ChevronUp, CopyPlus, Folder, FolderInput, FolderOpen, FolderPlus, Import, ListRestart, Plus, Share, Trash2, X } from 'lucide-react'
import { RestoreToolsButton } from '../components/RestoreButtons'
import { applyDeleteFolder, exportToolFolder, pickToolFile, planDeleteFolder, type FolderDeletePlan, type ToolFileImport } from '../io/settingsFile'
import ToolImportDialog from '../components/ToolImportDialog'
import ConfirmSettingsDialog from '../components/ConfirmSettingsDialog'
import { useUIStore } from '../store/uiStore'
import { ICON } from '../theme'
import { useToolStore, folderNames, folderOf, MY_TOOLS, type Tool, type ToolType, type ToolSortKey } from '../store/toolStore'
import { useWorkpieceStore, toMM, fromMM, type Units } from '../store/workpieceStore'
import { SPINDLE_INFO, spindleDialSetting, type SpindleType } from '../store/spindle'
import { TOOL_TYPE_ICON, TYPE_ORDER } from './toolTypes'

type SortKey = ToolSortKey

// Step-down and cutting direction are not tool properties: the step-down comes
// from auto feeds (or the operation's own field) and the direction is per
// operation, so both were edited here and then ignored. They are gone from
// `Tool` — a form's initial step-down now comes from `seedStepDownMM(tool)`.
// THE TABLE IS FIXED-LAYOUT, every column a set width but Name, which takes the rest.
// Left to size itself it went wrong both ways: first it squeezed the columns to fit, and
// since the fields fill their cells a 5-digit RPM came out as "1800" with its last digit
// cut off — which reads as a valid speed. Then minimum widths only made it grow, because
// an <input> claims ~170 px of content whatever its column, and the table ran off the
// panel with the tool pictures squeezed out. Widths fit the value plus its stepper
// arrows; the table's minWidth (TABLE_MIN_W) keeps Name usable, and a window narrower
// than that scrolls sideways rather than clipping a number.
const COLUMNS: { key: keyof Omit<Tool, 'id'>; label: string; title: string; w?: string; unit?: string; numeric?: boolean; sort?: SortKey }[] = [
  { key: 'name',        label: 'Name',    title: 'Tool name — click to sort', sort: 'name' },
  { key: 'type',        label: 'Type',    title: 'Tool type — click to sort', w: '8.5rem', sort: 'type' },
  { key: 'diameterMM',  label: 'Ø',       title: 'Diameter — click to sort',  w: '5.5rem', numeric: true, sort: 'diameter' },
  { key: 'fluteCount',  label: 'Flutes',  title: 'Number of flutes',          w: '4rem', numeric: true },
  { key: 'chipLoadMM',  label: 'Chip',    title: 'Rated chip load per tooth — the maker\'s recommendation. Fixed: Auto Feeds never goes above it, and the chip check warns when your feed and RPM run the bit too hot or too cold against it. Clear it for no rating.', w: '5.5rem', numeric: true },
  { key: 'rpm',         label: 'RPM',     title: 'Spindle speed (RPM)',       w: '6rem', numeric: true },
  { key: 'xyFeedMmMin', label: 'XY Feed', title: 'XY feed rate (mm/min)',     w: '6.5rem', numeric: true },
  { key: 'zFeedMmMin',  label: 'Z Feed',  title: 'Plunge feed rate (mm/min)', w: '6rem', numeric: true },
  { key: 'maxDepthMM',  label: 'Max Z',   title: 'Maximum cut depth of this tool',    w: '5rem', numeric: true },
]
// Picture 5 + the columns above 47 + Angle/R 5 + actions 5.5 = 62.5, and at least 9 for
// Name: 71.5rem (1144 px); a spindle with a speed dial adds the 3.5rem Dial column. Since
// the Chip column that no longer fits beside the sidebar in a 1400 px window (1080 px of
// panel): the table scrolls sideways there rather than clip a number.
const TABLE_MIN_W = '71.5rem'
const DIAL_W = 3.5

const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

const COMPARE: Record<SortKey, (a: Tool, b: Tool) => number> = {
  name: byName,
  type: (a, b) => (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || byName(a, b),
  // Two cutters of the same nominal size (a 1/4" end mill and a 1/4" ball nose)
  // stay grouped by type, so a diameter sort reads as a rack of sizes.
  diameter: (a, b) => (a.diameterMM - b.diameterMM) || (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || byName(a, b),
}

function sortTools(tools: Tool[], key: SortKey, dir: 'asc' | 'desc'): Tool[] {
  const sorted = [...tools].sort(COMPARE[key])
  return dir === 'asc' ? sorted : sorted.reverse()
}

const cellCls = 'bg-transparent border-0 text-body text-gray-800 dark:text-neutral-200 w-full focus:outline-none focus:ring-1 focus:ring-blue-500 rounded px-1 py-0.5'

// A numeric input whose value is stored in mm but displayed/edited in the user's
// chosen units. `kind` only affects the inch-mode arrow-key step (lengths want a
// fine step, feed rates a coarse one); mm mode keeps each field's original step.
function DimInput({ valueMM, onChangeMM, minMM, stepMM, kind, units, title }: {
  valueMM: number
  onChangeMM: (mm: number) => void
  minMM: number
  stepMM: number
  kind: 'length' | 'feed'
  units: Units
  title?: string
}) {
  const step = units === 'in' ? (kind === 'feed' ? 1 : 0.001) : stepMM
  return (
    <NumericInput
      value={fromMM(valueMM, units)}
      min={fromMM(minMM, units)}
      step={step}
      onChange={(v) => onChangeMM(toMM(v, units))}
      className={cellCls + ' text-right'}
      title={title ? `${title} — ${NUMERIC_HINT}` : NUMERIC_HINT}
    />
  )
}


const NEW_FOLDER = 'new'

// The row actions (move, copy, delete) and the folder tabs run a size above the panel's
// usual ICON.sm: they are the controls this table is worked with, not decoration.
const ROW_ICON = 20
const FOLDER_ICON = 18

function ToolRow({ tool, units, spindleType, selected, folders, onNewFolder }: {
  tool: Tool; units: Units; spindleType: SpindleType; selected: boolean
  folders: string[]                 // every folder there is, '' (My Tools) first
  onNewFolder: (toolId: string) => void
}) {
  const { updateTool, deleteTool, selectTool, copyToMyTools, moveToFolder, tools } = useToolStore()
  const up = (updates: Partial<Omit<Tool, 'id'>>) => updateTool(tool.id, updates)
  const canDelete = tools.length > 1
  const hasDial = !!SPINDLE_INFO[spindleType].dial
  const dial = spindleDialSetting(spindleType, tool.rpm)

  return (
    // Clicking anywhere in the row selects it — including inside a cell's input,
    // so editing a field also makes that tool the one Add Tool copies. Clicking
    // the selected row again clears the selection, which is how you get back to
    // adding a plain new tool instead of a copy — but only from bare row area,
    // since clicking into a field of the selected row is editing, not toggling.
    <tr onClick={(e) => {
        const onControl = !!(e.target as HTMLElement).closest('input, select, button')
        selectTool(selected && !onControl ? null : tool.id)
      }}
      className={`border-b border-gray-300/60 dark:border-neutral-700/60 group cursor-pointer ${
        selected ? 'bg-blue-600/20' : 'hover:bg-gray-100/40 dark:hover:bg-neutral-800/40'
      }`}>
      <td className="px-2 py-1">
        <img src={TOOL_TYPE_ICON[tool.type]} alt={tool.type} title={tool.type} className="h-8 w-16 object-contain" />
      </td>
      <td className="px-2 py-1">
        <input type="text" value={tool.name} onChange={(e) => up({ name: e.target.value })} className={cellCls} />
      </td>
      <td className="px-2 py-1">
        <select value={tool.type} onChange={(e) => {
            const type = e.target.value as ToolType
            // Seed the angle in the convention the new type is READ in — 60°
            // included for a V-bit, 5° per side for a taper. Seeding a taper
            // with 60 would make a 120° included cone.
            const seed = type === 'vbit' ? 60 : type === 'taper' ? 5 : undefined
            // A bull nose starts with a quarter of its diameter as corner radius — plainly
            // neither flat nor ball, so the corner reads as something to set.
            if (type === 'bullnose' && !(tool.cornerRadiusMM && tool.cornerRadiusMM > 0)) {
              up({ type, cornerRadiusMM: Math.round(tool.diameterMM / 4 * 1000) / 1000 })
              return
            }
            up(seed !== undefined && !tool.vbitAngleDeg ? { type, vbitAngleDeg: seed } : { type })
          }} className={cellCls + ' bg-gray-100 dark:bg-neutral-800'}>
          <option value="endmill">End Mill</option>
          <option value="bullnose">Bull Nose</option>
          <option value="ballnose">Ball Nose</option>
          <option value="vbit">V-bit</option>
          <option value="taper">Taper End Mill</option>
          <option value="drill">Drill</option>
        </select>
      </td>
      <td className="px-2 py-1">
        <DimInput valueMM={tool.diameterMM} onChangeMM={(mm) => up({ diameterMM: mm })}
          minMM={0.1} stepMM={0.001} kind="length" units={units}
          title={tool.type === 'taper' ? 'Tip diameter — the ball ground on the tip' : undefined} />
      </td>
      <td className="px-2 py-1">
        <NumericInput value={tool.fluteCount} min={1} step={1} integer
          onChange={(fluteCount) => up({ fluteCount })}
          className={cellCls + ' text-right'} title={NUMERIC_HINT} />
      </td>
      <td className="px-2 py-1">
        {tool.type === 'drill' ? (
          // A drill plunges; it takes no side-cutting chip to rate.
          <div className="text-right pr-[19px] text-gray-600 dark:text-neutral-400">—</div>
        ) : (
          // In the display units, like every length here; blank means no rating.
          <NumericInput
            value={fromMM(tool.chipLoadMM ?? 0, units)}
            isEmpty={tool.chipLoadMM === undefined}
            placeholder="—"
            onEmpty={() => up({ chipLoadMM: undefined })}
            min={0.0001}
            step={units === 'in' ? 0.0001 : 0.001}
            onChange={(v) => up({ chipLoadMM: toMM(v, units) })}
            className={cellCls + ' text-right'}
            title={`Rated chip load (${units === 'in' ? 'in' : 'mm'} per tooth) — blank for no rating — ${NUMERIC_HINT}`} />
        )}
      </td>
      <td className="px-2 py-1">
        <NumericInput value={tool.rpm} min={0} step={100}
          onChange={(rpm) => up({ rpm })}
          className={cellCls + ' text-right'} title={NUMERIC_HINT} />
      </td>
      {/* The dial setting has a column of its own: as a second line under the RPM it
          was the one thing making every row taller than one field. */}
      {hasDial && (
        <td className="px-2 py-1 text-right text-gray-600 dark:text-neutral-400 tabular-nums">{dial ?? '—'}</td>
      )}
      <td className="px-2 py-1">
        <DimInput valueMM={tool.xyFeedMmMin} onChangeMM={(mm) => up({ xyFeedMmMin: mm })}
          minMM={0} stepMM={10} kind="feed" units={units} />
      </td>
      <td className="px-2 py-1">
        <DimInput valueMM={tool.zFeedMmMin} onChangeMM={(mm) => up({ zFeedMmMin: mm })}
          minMM={1} stepMM={10} kind="feed" units={units} />
      </td>
      <td className="px-2 py-1">
        <DimInput valueMM={tool.maxDepthMM} onChangeMM={(mm) => up({ maxDepthMM: mm })}
          minMM={0.01} stepMM={0.5} kind="length" units={units} />
      </td>
      <td className="px-2 py-1">
        {tool.type === 'vbit' || tool.type === 'taper' ? (
          <>
            {/* One column, two conventions — because that is how the two bits are
                sold. The number stands bare, as the bit is sold, and the tooltip says
                which convention the row is in. includedAngleDeg() is what everything
                downstream reads. A taper's angles are small, so it steps by 1° where a
                V-bit steps by 5°. */}
            <NumericInput
              value={tool.vbitAngleDeg ?? (tool.type === 'taper' ? 5 : 60)}
              min={tool.type === 'taper' ? 0.5 : 5}
              max={tool.type === 'taper' ? 60 : 175}
              step={tool.type === 'taper' ? 1 : 5}
              onChange={(vbitAngleDeg) => up({ vbitAngleDeg })}
              className={cellCls + ' text-right'}
              title={`${tool.type === 'taper' ? 'Angle per side' : 'Included angle'} — ${NUMERIC_HINT}`}
            />
          </>
        ) : tool.type === 'bullnose' ? (
          // A bull nose has no angle; its one shape number is the corner radius, which
          // shares the column rather than widening the table for one type.
          <DimInput valueMM={tool.cornerRadiusMM ?? 0} onChangeMM={(mm) => up({ cornerRadiusMM: Math.min(mm, tool.diameterMM / 2) })}
            minMM={0} stepMM={0.5} kind="length" units={units}
            title={`Corner radius (${units === 'in' ? 'in' : 'mm'}) — 0 is a flat end mill, half the Ø a ball nose`} />
        ) : (
          // Right-aligned under the angles, which end left of NumericInput's stepper:
          // the field's own px-1 plus the stepper's ml-1 + 11 px chevrons = 19 px.
          <div className="text-right pr-[19px] text-gray-600 dark:text-neutral-400">—</div>
        )}
      </td>
      <td className="px-2 py-1 text-center whitespace-nowrap">
        {/* Move to another folder: a native select laid invisibly over the icon, so the
            menu is the platform's own and needs no popover of ours. Folder options are
            'f:'-prefixed because My Tools is the folder '' — the same as the placeholder,
            so picking it would not register as a change. */}
        <span className="relative inline-block opacity-0 group-hover:opacity-100 focus-within:opacity-100 p-0.5 rounded text-gray-600 dark:text-neutral-400 hover:text-blue-500 hover:bg-blue-900/20 transition-colors"
          title="Move to another folder">
          <FolderInput size={ROW_ICON} />
          <select value="" aria-label="Move to another folder"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              if (e.target.value === NEW_FOLDER) { onNewFolder(tool.id); return }
              const to = e.target.value.slice(2)
              moveToFolder(tool.id, to)
              useUIStore.getState().showStatus(`Moved "${tool.name}" to ${to || MY_TOOLS}.`, 'info')
            }}
            className="absolute inset-0 opacity-0 cursor-pointer w-full">
            <option value="" disabled>Move to…</option>
            {folders.filter((f) => f !== folderOf(tool)).map((f) => (
              <option key={f || '(mine)'} value={`f:${f}`}>{f || MY_TOOLS}</option>
            ))}
            <option value={NEW_FOLDER}>New folder…</option>
          </select>
        </span>
        {folderOf(tool) !== '' && (
          // A catalogue is for browsing; the bits the user actually owns belong in their rack.
          <button onClick={(e) => { e.stopPropagation(); copyToMyTools(tool.id) }}
            title={`Copy to ${MY_TOOLS} — this folder keeps its own`}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-600 dark:text-neutral-400 hover:text-blue-500 hover:bg-blue-900/20 transition-colors">
            <CopyPlus size={ROW_ICON} />
          </button>
        )}
        {/* stopPropagation: the row's select would otherwise fire after the
            delete and leave selectedToolId pointing at the removed tool. */}
        <button onClick={(e) => { e.stopPropagation(); if (canDelete) deleteTool(tool.id) }} disabled={!canDelete}
          title={canDelete ? 'Delete tool' : 'Cannot delete the last tool'}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-600 dark:text-neutral-400 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
          <Trash2 size={ROW_ICON} />
        </button>
      </td>
    </tr>
  )
}

const headBtnCls = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-body bg-gray-200 dark:bg-neutral-700 hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-700 dark:text-neutral-300 transition-colors'

export default function ToolLibraryPanel() {
  const { tools: allTools, addTool, selectedToolId, sortBy, setSortBy, openFolder: wantFolder, setOpenFolder, renameFolder } = useToolStore()
  const folders = useMemo(() => folderNames(allTools), [allTools])
  // A folder emptied (its last tool deleted) no longer exists — show My Tools.
  const openFolder = wantFolder && folders.includes(wantFolder) ? wantFolder : ''
  const tools = useMemo(() => allTools.filter((t) => folderOf(t) === openFolder), [allTools, openFolder])
  const selectedTool = tools.find((t) => t.id === selectedToolId) ?? null
  const [importing, setImporting] = useState<ToolFileImport | null>(null)
  const [deleting, setDeleting] = useState<FolderDeletePlan | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  // A tool waiting for a name for the folder it is being moved into ("New folder…").
  const [newFolderFor, setNewFolderFor] = useState<string | null>(null)
  const moveToFolder = useToolStore((s) => s.moveToFolder)
  const folderLabel = openFolder || MY_TOOLS
  const units = useWorkpieceStore((s) => s.units)
  const spindleType = useWorkpieceStore((s) => s.spindleType)
  const hasDial = !!SPINDLE_INFO[spindleType].dial
  const lenUnit = units === 'in' ? 'in' : 'mm'
  const feedUnit = units === 'in' ? 'in/min' : 'mm/min'

  // Display-only sort: `tools` keeps its own (creation) order, which is what
  // `addTool` appends to and what a third click returns the table to. The choice
  // lives in the persisted store, not local state — otherwise every row jumped
  // back to creation order on the next visit to the panel.
  const rows = useMemo(() => (sortBy ? sortTools(tools, sortBy.key, sortBy.dir) : tools), [tools, sortBy])
  const clickSort = (key: SortKey) =>
    setSortBy(sortBy?.key !== key ? { key, dir: 'asc' } : sortBy.dir === 'asc' ? { key, dir: 'desc' } : null)

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-neutral-900">
      {importing && <ToolImportDialog file={importing} onClose={() => setImporting(null)} />}
      {deleting && (
        <ConfirmSettingsDialog title={`Delete the folder "${deleting.folder}"?`} confirmLabel="Delete folder"
          intro={`Its tools are removed from the library. ${MY_TOOLS} and your other folders are not touched.`}
          groups={[
            { heading: `Deleted (${deleting.removed.length})`, items: deleting.removed.map((t) => t.name), tone: 'remove' },
            { heading: `Kept — the open project cuts with ${deleting.kept.length === 1 ? 'it' : 'them'} (${deleting.kept.length})`, items: deleting.kept.map((t) => t.name), tone: 'keep' },
          ]}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const ok = applyDeleteFolder(deleting)
            const kept = deleting.kept.length ? ` — ${deleting.kept.length} the open project cuts with kept` : ''
            useUIStore.getState().showStatus(ok
              ? `Deleted ${deleting.removed.length} tool${deleting.removed.length === 1 ? '' : 's'} from "${deleting.folder}"${kept}.`
              : `"${deleting.folder}" holds every tool in the library — add one to ${MY_TOOLS} before deleting it.`, ok ? 'info' : 'warn')
          }} />
      )}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
        <span className="text-body font-semibold text-gray-500 dark:text-neutral-400 uppercase tracking-wider">
          Tool Library — {folderLabel} — {tools.length} tool{tools.length !== 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-2">
        <RestoreToolsButton className={headBtnCls}
          title="Put back the tools FreazyKam comes with in My Tools — imported folders are not touched; shows what will be removed and kept first">
          <ListRestart size={ICON.sm} />
          Restore Defaults
        </RestoreToolsButton>
        <button onClick={async () => { const f = await pickToolFile(); if (f) setImporting(f) }}
          title="Import a tool set — a .fkset or a Fusion 360 tool library (.json) — into a folder of its own; your tools are not touched"
          className={headBtnCls}>
          <Import size={ICON.sm} />
          Import
        </button>
        <button onClick={() => exportToolFolder(openFolder)}
          title={`Export the ${tools.length} tools in "${folderLabel}" to a .fkset file, to share or keep`}
          className={headBtnCls}>
          <Share size={ICON.sm} />
          Export
        </button>
        <button onClick={addTool}
          title={selectedTool
            ? `Add a copy of "${selectedTool.name}" — click the selected row to deselect and add a plain end mill instead`
            : 'Add a new end mill'}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-body bg-gray-200 dark:bg-neutral-700 hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-700 dark:text-neutral-300 transition-colors">
          <Plus size={ICON.sm} />
          Add Tool
        </button>
        </div>
      </div>

      {/* The folders. My Tools is always first and is the user's own; every other folder
          is a tool set imported beside it. The open one renames on double-click. */}
      {(folders.length > 0 || openFolder || newFolderFor) && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0 overflow-x-auto">
          {['', ...folders].map((f) => {
            const open = f === openFolder
            const n = allTools.filter((t) => folderOf(t) === f).length
            return renaming !== null && f !== '' && f === renaming ? (
              <input key={f} autoFocus defaultValue={f}
                onBlur={(e) => { if (e.target.value.trim()) renameFolder(f, e.target.value); setRenaming(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null) }
                }}
                className="px-2 py-0.5 rounded text-body bg-white dark:bg-neutral-900 border border-blue-500 text-gray-900 dark:text-neutral-100 focus:outline-none w-48" />
            ) : (
              // An imported folder's tab carries its own delete, shown on hover (always on
              // the open one) — the bar's Delete button alone sat far from the tabs and only
              // for the open folder. My Tools has none: it is the user's own and always exists.
              <div key={f || '(mine)'} className={`group/tab flex items-center rounded transition-colors ${
                  open ? 'bg-blue-600 text-white' : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700'
                }`}>
                <button onClick={() => setOpenFolder(f)}
                  onDoubleClick={() => { if (f) setRenaming(f) }}
                  title={f ? `${f} — double-click to rename` : 'Your own tools'}
                  className={`flex items-center gap-1.5 py-0.5 text-body whitespace-nowrap ${f ? 'pl-2.5 pr-1' : 'px-2.5'}`}>
                  {open ? <FolderOpen size={FOLDER_ICON} /> : <Folder size={FOLDER_ICON} />}
                  {f || MY_TOOLS}
                  <span className={open ? 'text-blue-100' : 'text-gray-500 dark:text-neutral-500'}>{n}</span>
                </button>
                {f && (
                  <button onClick={() => setDeleting(planDeleteFolder(f))}
                    title={`Delete the folder "${f}" and its tools`}
                    className={`mr-1 p-0.5 rounded hover:bg-red-600 hover:text-white transition-opacity ${
                      open ? 'opacity-80' : 'opacity-0 group-hover/tab:opacity-100'
                    }`}>
                    <X size={ICON.sm} />
                  </button>
                )}
              </div>
            )
          })}
          {newFolderFor && (
            <span className="flex items-center gap-1 text-gray-700 dark:text-neutral-300">
              <FolderPlus size={FOLDER_ICON} />
              <input autoFocus placeholder="New folder name"
                onBlur={(e) => {
                  const name = e.target.value.trim()
                  const tool = allTools.find((t) => t.id === newFolderFor)
                  if (name && tool) {
                    moveToFolder(tool.id, name)
                    useUIStore.getState().showStatus(`Moved "${tool.name}" to ${name}.`, 'info')
                  }
                  setNewFolderFor(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') { e.stopPropagation(); (e.target as HTMLInputElement).value = ''; (e.target as HTMLInputElement).blur() }
                }}
                className="px-2 py-0.5 rounded text-body bg-white dark:bg-neutral-900 border border-blue-500 text-gray-900 dark:text-neutral-100 focus:outline-none w-48" />
            </span>
          )}
          {openFolder && (
            <button onClick={() => setDeleting(planDeleteFolder(openFolder))}
              title={`Delete the folder "${openFolder}" and its tools`}
              className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-body text-gray-600 dark:text-neutral-400 hover:text-red-400 hover:bg-red-900/20 transition-colors whitespace-nowrap">
              <Trash2 size={ICON.sm} />
              Delete folder
            </button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-body" style={{ minWidth: hasDial ? `calc(${TABLE_MIN_W} + ${DIAL_W}rem)` : TABLE_MIN_W }}>
          <thead>
            <tr className="border-b border-gray-200 dark:border-neutral-600 sticky top-0 bg-gray-100 dark:bg-neutral-800">
              <th className="px-2 py-1.5" style={{ width: '5.5rem' }} />
              {COLUMNS.map((col) => (
                <Fragment key={col.key}>
                <th title={col.title} style={col.w ? { width: col.w } : undefined}
                  onClick={col.sort ? () => clickSort(col.sort!) : undefined}
                  className={`px-2 py-1.5 align-bottom ${col.numeric ? 'text-right' : 'text-left'} text-label font-semibold uppercase tracking-wider select-none ${
                    col.sort
                      ? 'cursor-pointer hover:text-gray-600 dark:hover:text-neutral-300 ' +
                        (sortBy?.key === col.sort ? 'text-gray-600 dark:text-neutral-300' : 'text-gray-600 dark:text-neutral-400')
                      : 'text-gray-600 dark:text-neutral-400'
                  }`}>
                  {col.label}
                  {(col.key === 'diameterMM' || col.key === 'maxDepthMM') && (
                    <span className="block text-gray-600 dark:text-neutral-400 normal-case font-normal tracking-normal">{lenUnit}</span>
                  )}
                  {col.key === 'chipLoadMM' && (
                    <span className="block text-gray-600 dark:text-neutral-400 normal-case font-normal tracking-normal">{lenUnit}/tooth</span>
                  )}
                  {(col.key === 'xyFeedMmMin' || col.key === 'zFeedMmMin') && (
                    <span className="block text-gray-600 dark:text-neutral-400 normal-case font-normal tracking-normal">{feedUnit}</span>
                  )}
                  {sortBy && sortBy.key === col.sort && (
                    sortBy.dir === 'asc'
                      ? <ChevronUp size={ICON.xs} className="inline-block ml-0.5 -mt-0.5" />
                      : <ChevronDown size={ICON.xs} className="inline-block ml-0.5 -mt-0.5" />
                  )}
                </th>
                {col.key === 'rpm' && hasDial && (
                  <th title={`Speed dial setting on the ${SPINDLE_INFO[spindleType].label}, to the half detent`}
                    style={{ width: `${DIAL_W}rem` }}
                    className="px-2 py-1.5 align-bottom text-right text-label font-semibold uppercase tracking-wider select-none text-gray-600 dark:text-neutral-400">
                    Dial
                  </th>
                )}
                </Fragment>
              ))}
              <th title="V-bit: included angle · Taper: angle per side · Bull nose: corner radius" style={{ width: '5rem' }}
                className="px-2 py-1.5 text-right text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider whitespace-nowrap select-none">
                Angle<span className="ml-0.5 normal-case font-normal tracking-normal">° / R</span>
              </th>
              {/* Named, because the icons under it only show on hover — unlabelled, the
                  column read as empty space after the table. */}
              <th title="Move to another folder · Copy to My Tools · Delete — hover a row to see them"
                style={{ width: '5.5rem' }}
                className="px-2 py-1.5 text-center text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider whitespace-nowrap select-none">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((tool) => (
              <ToolRow key={tool.id} tool={tool} units={units} spindleType={spindleType}
                selected={tool.id === selectedToolId} folders={['', ...folders]} onNewFolder={setNewFolderFor} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
