import { useMemo } from 'react'
import { NumericInput } from '../components/NumericInput'
import { NUMERIC_HINT } from '../components/parseNumeric'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { ICON } from '../theme'
import { useToolStore, type Tool, type ToolType, type ToolSortKey } from '../store/toolStore'
import { includedAngleDeg, maxCutRadiusMM } from '../cam/geom'
import { useWorkpieceStore, toMM, fromMM, type Units } from '../store/workpieceStore'
import { spindleDialLabel, type SpindleType } from '../store/spindle'
import endmillIcon from '../icons/endmill.svg'
import ballnoseIcon from '../icons/ballnose.svg'
import vbitIcon from '../icons/vbit.svg'
import taperIcon from '../icons/taper.svg'
import drillIcon from '../icons/drill.svg'

const TOOL_TYPE_ICON: Record<ToolType, string> = {
  endmill: endmillIcon,
  ballnose: ballnoseIcon,
  vbit: vbitIcon,
  taper: taperIcon,
  drill: drillIcon,
}

type SortKey = ToolSortKey

// Step-down and cutting direction are not tool properties: the step-down comes
// from auto feeds (or the operation's own field) and the direction is per
// operation, so both were edited here and then ignored. They are gone from
// `Tool` — a form's initial step-down now comes from `seedStepDownMM(tool)`.
const COLUMNS: { key: keyof Omit<Tool, 'id'>; label: string; title: string; width: string; unit?: string; numeric?: boolean; sort?: SortKey }[] = [
  { key: 'name',        label: 'Name',    title: 'Tool name — click to sort', width: 'w-40', sort: 'name' },
  { key: 'type',        label: 'Type',    title: 'Tool type — click to sort', width: 'w-28', sort: 'type' },
  { key: 'diameterMM',  label: 'Ø',       title: 'Diameter — click to sort',  width: 'w-20', numeric: true, sort: 'diameter' },
  { key: 'fluteCount',  label: 'Flutes',  title: 'Number of flutes',          width: 'w-16', numeric: true },
  { key: 'rpm',         label: 'RPM',     title: 'Spindle speed (RPM)',       width: 'w-20', numeric: true },
  { key: 'xyFeedMmMin', label: 'XY Feed', title: 'XY feed rate (mm/min)',     width: 'w-20', numeric: true },
  { key: 'zFeedMmMin',  label: 'Z Feed',  title: 'Plunge feed rate (mm/min)', width: 'w-20', numeric: true },
  { key: 'maxDepthMM',  label: 'Max Z',   title: 'Maximum cut depth of this tool',    width: 'w-18', numeric: true },
]

// Group tools the way the type dropdown is ordered rather than alphabetically —
// the point of a type sort is to put all the ball noses together, and this keeps
// like cutters adjacent instead of interleaving by first letter.
const TYPE_ORDER: ToolType[] = ['endmill', 'ballnose', 'vbit', 'taper', 'drill']

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

// Read-only length for a derived hint — the editable fields go through DimInput.
function fmtDim(mm: number, units: Units): string {
  const v = fromMM(mm, units)
  return `${v.toFixed(units === 'in' ? 3 : 2)} ${units === 'in' ? 'in' : 'mm'}`
}

function ToolRow({ tool, units, spindleType, selected }: { tool: Tool; units: Units; spindleType: SpindleType; selected: boolean }) {
  const { updateTool, deleteTool, selectTool, tools } = useToolStore()
  const up = (updates: Partial<Omit<Tool, 'id'>>) => updateTool(tool.id, updates)
  const canDelete = tools.length > 1
  const dialLabel = spindleDialLabel(spindleType, tool.rpm)

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
        <img src={TOOL_TYPE_ICON[tool.type]} alt={tool.type} title={tool.type} className="h-8 w-20 object-contain" />
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
            up(seed !== undefined && !tool.vbitAngleDeg ? { type, vbitAngleDeg: seed } : { type })
          }} className={cellCls + ' bg-gray-100 dark:bg-neutral-800'}>
          <option value="endmill">End Mill</option>
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
        <NumericInput value={tool.rpm} min={0} step={100}
          onChange={(rpm) => up({ rpm })}
          className={cellCls + ' text-right'} title={NUMERIC_HINT} />
        {dialLabel && (
          <div className="text-label text-gray-600 dark:text-neutral-400 text-right px-1 mt-0.5">{dialLabel}</div>
        )}
      </td>
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
                sold. The suffix says which one this row is in; includedAngleDeg()
                is what everything downstream reads. A taper's angles are small,
                so it steps by 1° where a V-bit steps by 5°. */}
            <div className="flex items-baseline gap-1">
              <NumericInput
                value={tool.vbitAngleDeg ?? (tool.type === 'taper' ? 5 : 60)}
                min={tool.type === 'taper' ? 0.5 : 5}
                max={tool.type === 'taper' ? 60 : 175}
                step={tool.type === 'taper' ? 1 : 5}
                onChange={(vbitAngleDeg) => up({ vbitAngleDeg })}
                className={cellCls + ' text-right'}
                title={NUMERIC_HINT}
              />
              <span className="text-label text-gray-600 dark:text-neutral-400 whitespace-nowrap">
                {tool.type === 'taper' ? '/side' : 'incl'}
              </span>
            </div>
            {tool.type === 'taper' && (
              // The number that actually decides whether this bit can cut the job,
              // and it is derived from all three columns so it exists nowhere else.
              <div className="text-label text-gray-600 dark:text-neutral-400 px-1 mt-0.5 whitespace-nowrap">
                Ø{fmtDim(2 * maxCutRadiusMM(tool), units)} at depth · {includedAngleDeg(tool)}° incl
              </div>
            )}
          </>
        ) : (
          <span className="text-gray-600 dark:text-neutral-400 px-1">—</span>
        )}
      </td>
      <td className="px-2 py-1 text-center">
        {/* stopPropagation: the row's select would otherwise fire after the
            delete and leave selectedToolId pointing at the removed tool. */}
        <button onClick={(e) => { e.stopPropagation(); if (canDelete) deleteTool(tool.id) }} disabled={!canDelete}
          title={canDelete ? 'Delete tool' : 'Cannot delete the last tool'}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-600 dark:text-neutral-400 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
          <Trash2 size={ICON.sm} />
        </button>
      </td>
    </tr>
  )
}

export default function ToolLibraryPanel() {
  const { tools, addTool, selectedToolId, sortBy, setSortBy } = useToolStore()
  const selectedTool = tools.find((t) => t.id === selectedToolId) ?? null
  const units = useWorkpieceStore((s) => s.units)
  const spindleType = useWorkpieceStore((s) => s.spindleType)
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
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
        <span className="text-body font-semibold text-gray-500 dark:text-neutral-400 uppercase tracking-wider">
          Tool Library — {tools.length} tool{tools.length !== 1 ? 's' : ''}
        </span>
        <button onClick={addTool}
          title={selectedTool
            ? `Add a copy of "${selectedTool.name}" — click the selected row to deselect and add a plain end mill instead`
            : 'Add a new end mill'}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-body bg-gray-200 dark:bg-neutral-700 hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-700 dark:text-neutral-300 transition-colors">
          <Plus size={ICON.sm} />
          Add Tool
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-body" style={{ minWidth: '760px' }}>
          <thead>
            <tr className="border-b border-gray-200 dark:border-neutral-600 sticky top-0 bg-gray-100 dark:bg-neutral-800">
              <th className="px-2 py-1.5 w-24" />
              {COLUMNS.map((col) => (
                <th key={col.key} title={col.title}
                  onClick={col.sort ? () => clickSort(col.sort!) : undefined}
                  className={`px-2 py-1.5 ${col.numeric ? 'text-right' : 'text-left'} text-label font-semibold uppercase tracking-wider whitespace-nowrap select-none ${
                    col.sort
                      ? 'cursor-pointer hover:text-gray-600 dark:hover:text-neutral-300 ' +
                        (sortBy?.key === col.sort ? 'text-gray-600 dark:text-neutral-300' : 'text-gray-600 dark:text-neutral-400')
                      : 'text-gray-600 dark:text-neutral-400'
                  }`}>
                  {col.label}
                  {(col.key === 'diameterMM' || col.key === 'maxDepthMM') && (
                    <span className="ml-0.5 text-gray-600 dark:text-neutral-400 normal-case font-normal tracking-normal">{lenUnit}</span>
                  )}
                  {(col.key === 'xyFeedMmMin' || col.key === 'zFeedMmMin') && (
                    <span className="ml-0.5 text-gray-600 dark:text-neutral-400 normal-case font-normal tracking-normal">{feedUnit}</span>
                  )}
                  {sortBy && sortBy.key === col.sort && (
                    sortBy.dir === 'asc'
                      ? <ChevronUp size={ICON.xs} className="inline-block ml-0.5 -mt-0.5" />
                      : <ChevronDown size={ICON.xs} className="inline-block ml-0.5 -mt-0.5" />
                  )}
                </th>
              ))}
              <th title="V-bit full included angle (V-bit only)"
                className="px-2 py-1.5 text-right text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider whitespace-nowrap select-none">
                Angle<span className="ml-0.5 normal-case font-normal tracking-normal">°</span>
              </th>
              <th className="px-2 py-1.5 w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((tool) => (
              <ToolRow key={tool.id} tool={tool} units={units} spindleType={spindleType}
                selected={tool.id === selectedToolId} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
