import { useEffect, useRef, useState } from 'react'
import {
  Circle, RefreshCw, Target, CircleDot, Layers, Star, Box,
  Image as ImageIcon,
  FileCode, Wrench, Loader2, AlertCircle, Eye, EyeOff, ArrowRightLeft, Combine, GripVertical, X, CircleSlash, Route,
  ChevronDown, ChevronRight, Folder, FolderOpen, Pencil,
} from 'lucide-react'
import { ICON } from '../theme'
import { FlutingIcon } from './pathToolIcons'
import { useToolpathStore, batchOf, pathIdsOf, nothingToCut, GCODE_IMPORT_TOOL_ID, type AnyOperation } from '../store/toolpathStore'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { useUIStore } from '../store/uiStore'
import { OP_TYPE_COLORS, TOOL_BAND_HUES } from '../colors'
import { InlayIcon } from './MachinePanel'
import { toolRuns, groupedByTool, sameOrder, reorderedFor, groupBySheet, type Run } from './operationsOrder'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { opRunTimesS, fmtDuration, fmtDurationShort } from '../cam/opTime'
import { cellKey, opCell, opCentre, sameCell, STOCK_CELL, type Cell, type Stock } from '../cam/sheets'
import { pathCell, sheetName, useActiveSheet } from '../canvas/useSheets'

// The PROGRAM list, in the sidebar's Toolpaths view: one row per operation, in the
// order the machine will run them, each with its run time and its share of the job.
// (It was a strip of chips under the canvas; on a real project with many toolpaths the
// chips shrank to icons and every time was a hover away, so it moved here, where a row
// has room to say it. The logic is the strip's — only the layout changed.)
//
// It is deliberately not the Objects strip. That one is the document — chips sit where the edit
// happened, and reordering operations appends a new event rather than moving one. This
// list is the other ordering: `toolpathStore.operations`, which is what generateGcode
// walks. Dragging here reorders the program and records one `op.reorder` event; the chip
// that created the operation stays where it is in history.
//
// Tool runs are DERIVED — a run is a maximal stretch of consecutive same-tool ops, never
// a stored grouping. That matters: the ops list is flat and new operations append to the
// end, so a list can read A, B, A and cost three tool changes. A view that groups by tool
// id shows two tidy groups and hides the third change; this one draws what the machine
// actually does, which is also what "Group by tool" fixes.
//
// On a MULTI-SHEET job the list is folders, one per sheet (cam/sheets), because each sheet
// is its own file on the machine: what runs on a sheet is the SUBSEQUENCE of the program
// lying on it, so its tool runs and tool changes are counted inside its folder and never
// across a sheet boundary. A drag stays inside the folder it started in — the sheet an op
// cuts on is where it LIES, so dropping it in another folder could not move it there.
//
// Hovering a row, a run header or a folder header lights its source paths up on the
// canvas (`uiStore.hoverOpIds`, drawn by HoverHighlightLayer), so a toolpath can be found
// on a crowded drawing before it is clicked to edit.

type ChipIcon = React.ComponentType<{ size?: number; style?: React.CSSProperties }>

// Same per-op icons as the operations menu and the timeline chips.
const OP_ICONS: Record<string, ChipIcon> = {
  profile: Circle, trochoidal: RefreshCw, pocket: Target, drill: CircleDot,
  surface: Layers, vcarve: Star, inlay: InlayIcon, profile3d: Box, gcode: FileCode,
  photovcarve: ImageIcon, fluting: FlutingIcon,
}

// Band tint for a tool. Keyed by the tool's position in the library rather than a hash of
// its id, so two tools can't collide on the same hue while both are in use. Imported
// G-code (no tool) gets a neutral grey.
function bandStyle(toolId: string, tools: Tool[], dark: boolean): React.CSSProperties {
  if (toolId === GCODE_IMPORT_TOOL_ID) {
    return dark
      ? { backgroundColor: 'rgb(255 255 255 / 0.06)', borderColor: 'rgb(255 255 255 / 0.14)' }
      : { backgroundColor: 'rgb(0 0 0 / 0.05)', borderColor: 'rgb(0 0 0 / 0.12)' }
  }
  const idx = tools.findIndex((t) => t.id === toolId)
  const hue = TOOL_BAND_HUES[(idx >= 0 ? idx : 0) % TOOL_BAND_HUES.length]
  // Light theme tints toward a deeper, less saturated wash so chip text keeps its
  // contrast; dark theme needs a brighter, slightly stronger one to register at all.
  return dark
    ? { backgroundColor: `hsl(${hue} 70% 60% / 0.16)`, borderColor: `hsl(${hue} 70% 60% / 0.38)` }
    : { backgroundColor: `hsl(${hue} 65% 45% / 0.12)`, borderColor: `hsl(${hue} 65% 40% / 0.35)` }
}

function toolLabel(toolId: string, tool: Tool | undefined): string {
  if (toolId === GCODE_IMPORT_TOOL_ID) return 'Imported G-code'
  if (!tool) return 'Unknown tool'
  return `${tool.name} Ø${tool.diameterMM}`
}

function moveOps(ids: string[], to: number): void {
  const ops = useToolpathStore.getState().operations
  const next = reorderedFor(ops, ids, to)
  if (!sameOrder(next, ops)) useToolpathStore.getState().reorderOperations(next)
}

// Imported G-code has no editable form, so its chip carries what the (now retired)
// Paths-panel info block showed: which file it came from and how much motion it holds.
function gcodeDetail(op: AnyOperation): string | null {
  if (op.type !== 'gcode') return null
  const cut = op.segments.filter((seg) => !seg.rapid).length
  const rapid = op.segments.length - cut
  return `${op.filename} — ${cut.toLocaleString()} cut, ${rapid.toLocaleString()} rapid moves (read-only)`
}

/**
 * How long each operation runs (`cam/opTime.ts`), recomputed once edits settle.
 *
 * Writing and parsing the whole program costs 5–40 ms on the largest projects measured,
 * which is nothing once but a lot to pay on every store write while a batch Generate is
 * landing one op after another — so it waits for the program to stop changing. Keyed on
 * everything the estimate reads: the ops, the tools, the post-processor, and the machine
 * settings auto-feeds computes from.
 */
function useOpRunTimes(operations: AnyOperation[], tools: Tool[]): Map<string, number> {
  const profile = usePostProcessorStore((s) => s.profiles.find((p) => p.id === s.activeId))
  const material = useWorkpieceStore((s) => s.material)
  const rigidity = useWorkpieceStore((s) => s.machineRigidity)
  const maxFeed = useWorkpieceStore((s) => s.maxFeedMmMin)
  const minRpm = useWorkpieceStore((s) => s.minSpindleRpm)
  const maxRpm = useWorkpieceStore((s) => s.maxSpindleRpm)
  const autoFeed = useWorkpieceStore((s) => s.autoFeedEnabled)
  const [times, setTimes] = useState<Map<string, number>>(() => new Map())
  useEffect(() => {
    const t = setTimeout(() => {
      const toolsById = Object.fromEntries(tools.map((x) => [x.id, x]))
      setTimes(opRunTimesS(operations, toolsById, usePostProcessorStore.getState().getActiveProfile()))
    }, 300)
    return () => clearTimeout(t)
  }, [operations, tools, profile, material, rigidity, maxFeed, minRpm, maxRpm, autoFeed])
  return times
}

// One line per fact, worst news first. A failure is the reason someone hovers a ringed
// row, so it leads and says what it costs — an errored op has no segments, and
// generateGcode only emits ops that are 'done', so it is silently absent from the
// exported program rather than cutting anything.
function opTitle(op: AnyOperation, noCut: boolean, timeS: number | undefined, share: number): string {
  return [
    op.status === 'error'
      ? `⚠ Failed to generate: ${op.errorMessage ?? 'unknown error'}\nThis operation is NOT in the exported G-code.`
      : null,
    op.status === 'needs-update' ? '⚠ Needs regenerating — excluded from the exported G-code until you do.' : null,
    !op.visible ? 'Hidden — excluded from the exported G-code.' : null,
    // Not a failure, and it must not read as one: thin shapes leave the end mill nothing
    // the V-bit has not already cut, so the op is empty by design.
    noCut ? 'Nothing to cut — the V-bit clears this completely, so it is left out of the G-code and its tool is never called for.' : null,
    op.name,
    gcodeDetail(op),
    // Timed like the export dialog's total it adds up to — by the machine's planner
    // (Machine Motion settings) — with no time for tool changes.
    timeS !== undefined && timeS > 0 ? `${fmtDuration(timeS)} to run — ${Math.round(share * 100)}% of the program` : null,
    'Click to edit · Drag to reorder · Shift-click to hide · ✎ to rename',
  ].filter(Boolean).join('\n')
}

const pct = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`)

// Row controls: in the row's own space (a list has the width a strip did not), shown on
// hover — in place of the row's time, which hides meanwhile so the buttons can be big
// enough and far enough apart to hit (still in the tooltip and the totals). Their mousedown stops there — the row itself is a drag handle, and grabbing the
// eye must not start a reorder.
function RowButton({ title, onClick, className, children }: {
  title: string; onClick: () => void; className: string; children: React.ReactNode
}) {
  return (
    <button title={title}
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`flex items-center justify-center w-6 h-6 rounded flex-shrink-0 text-gray-500 dark:text-neutral-400 ${className}`}>
      {children}
    </button>
  )
}

function OpRow({ op, sheet, dragging, noCut, timeS, share, onGrab, onHover }: {
  op: AnyOperation
  /** Its sheet's key — a drag only drops among rows of the sheet it started on. */
  sheet: string
  /** Pointer in (the op's id, to light its paths up on the canvas) or out ([]). */
  onHover: (ids: string[]) => void
  dragging: boolean
  /** Generated to nothing because its linked half cuts it all — see `nothingToCut`. */
  noCut: boolean
  /** Estimated run time, when the op is in the program and it has been worked out. */
  timeS: number | undefined
  /** That time as a fraction of the whole program's. */
  share: number
  onGrab: (e: React.MouseEvent) => void
}) {
  const Icon = OP_ICONS[op.type] ?? Wrench
  const color = OP_TYPE_COLORS[op.type] ?? '#94a3b8'
  // A hidden operation is not just dimmed on the canvas — generateGcode skips it, so it
  // is missing from the exported program. Faded and dashed so that reads at a glance.
  const hidden = !op.visible
  const ring = op.status === 'error' ? 'ring-1 ring-red-500/70' : op.status === 'needs-update' ? 'ring-1 ring-amber-500/70' : ''
  const timed = timeS !== undefined && timeS > 0
  // RENAMING, in place. The name is what the G-code calls this section (its `=== name ===`
  // comment, and the "Op 3 of 7: name" a controller displays while it runs), so a name the
  // operator recognises is worth having. One recorded step (updateOperation), nothing
  // regenerated; a blank or unchanged name changes nothing.
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(op.name)
  const commitName = () => {
    setRenaming(false)
    const name = draft.trim()
    if (name && name !== op.name) useToolpathStore.getState().updateOperation(op.id, { name, nameIsCustom: true })
  }
  return (
    <div data-op-id={op.id} data-sheet={sheet} onMouseDown={renaming ? undefined : onGrab} title={renaming ? undefined : opTitle(op, noCut, timeS, share)}
      onMouseEnter={() => onHover([op.id])} onMouseLeave={() => onHover([])}
      className={[
        'group relative flex items-center gap-1.5 pl-1 pr-1 h-7 rounded cursor-grab active:cursor-grabbing',
        'bg-white/70 dark:bg-neutral-900/60 hover:bg-white dark:hover:bg-neutral-700 border',
        hidden ? 'border-dashed border-gray-300 dark:border-neutral-600' : 'border-transparent',
        dragging ? 'opacity-30' : '', ring,
      ].join(' ')}
      style={{ borderLeftColor: color, borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
      {/* The share of the job as a faint bar under the row: the long operations stand
          out down the list without reading a single number. */}
      {timed && !hidden && (
        <div className="absolute left-0 bottom-0 h-0.5 rounded-full pointer-events-none" style={{ width: `${Math.max(2, share * 100)}%`, backgroundColor: color, opacity: 0.55 }} />
      )}
      <span className={['flex items-center gap-1.5 flex-1 min-w-0', hidden ? 'opacity-40' : noCut ? 'opacity-60' : ''].join(' ')}>
        <Icon size={13} style={{ color }} />
        {renaming ? (
          // The row is a drag handle and a click opens the form: the field keeps both to itself.
          <input autoFocus value={draft} aria-label="Toolpath name"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitName()
              else if (e.key === 'Escape') { setDraft(op.name); setRenaming(false) }
            }}
            onBlur={commitName}
            className="flex-1 min-w-0 px-1 h-5 rounded border border-blue-500 bg-white dark:bg-neutral-900 text-body text-gray-900 dark:text-neutral-100 focus:outline-none" />
        ) : (
          <span className="flex-1 min-w-0 truncate text-body text-gray-800 dark:text-neutral-200">{op.name}</span>
        )}
        {op.status === 'generating' && <Loader2 size={11} className="animate-spin text-blue-400 flex-shrink-0" />}
        {op.status === 'needs-update' && <AlertCircle size={11} className="text-amber-600 dark:text-amber-500 flex-shrink-0" />}
        {op.status === 'error' && <AlertCircle size={11} className="text-red-600 dark:text-red-500 flex-shrink-0" />}
        {noCut && <CircleSlash size={11} className="text-gray-500 dark:text-neutral-400 flex-shrink-0" />}
        {hidden && <EyeOff size={11} className="text-gray-500 dark:text-neutral-400 flex-shrink-0" />}
        {timed && (
          <span className="flex-shrink-0 text-[11px] tabular-nums text-right text-gray-600 dark:text-neutral-400 group-hover:hidden">
            {fmtDurationShort(timeS!)}<span className="inline-block w-9 text-gray-500 dark:text-neutral-500">{pct(share)}</span>
          </span>
        )}
      </span>
      <span className={renaming ? 'hidden' : 'hidden group-hover:flex items-center gap-1.5'}>
        <RowButton title="Rename — the name the G-code and the machine's display show for this toolpath"
          onClick={() => { setDraft(op.name); setRenaming(true) }} className="hover:text-blue-600 dark:hover:text-blue-300">
          <Pencil size={15} />
        </RowButton>
        <RowButton title={hidden ? 'Show — include in exported G-code' : 'Hide — exclude from exported G-code'}
          onClick={() => useToolpathStore.getState().toggleVisibility(op.id)} className="hover:text-blue-600 dark:hover:text-blue-300">
          {hidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </RowButton>
        <RowButton title={`Delete "${op.name}"`} onClick={() => useToolpathStore.getState().deleteOperation(op.id)}
          className="hover:text-red-600 dark:hover:text-red-300">
          <X size={15} />
        </RowButton>
      </span>
    </div>
  )
}

/** The sheet an op cuts on: where its toolpath lies, else where its first path does. */
function opSheet(op: AnyOperation, pathById: Map<string, ImportedPath>, stock: Stock): Cell {
  if (opCentre(op)) return opCell(op, stock)
  // No toolpath (failed, or not generated yet): it belongs where its geometry is, not on
  // sheet 1, or a failed part on sheet 3 would be listed with the wrong file.
  for (const id of pathIdsOf(op)) { const p = pathById.get(id); if (p) return pathCell(p, stock) }
  return STOCK_CELL
}

export default function ToolpathsPanel() {
  const operations = useToolpathStore((s) => s.operations)
  const tools = useToolStore((s) => s.tools)
  const darkMode = useUIStore((s) => s.darkMode)
  const paths = usePathsStore((s) => s.paths)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const doubleSided = useWorkpieceStore((s) => s.doubleSided)
  const { cells, cell: activeCell } = useActiveSheet()

  const listRef = useRef<HTMLDivElement>(null)
  // Gesture state in a ref (the window listeners read it mid-drag), mirrored into state
  // only for what has to re-render: the ghosted source rows and the drop indicator.
  const dragRef = useRef<{ ids: string[]; sheet: string; startY: number; moved: boolean; to: number } | null>(null)
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [dropY, setDropY] = useState<number | null>(null)
  // Two-click confirm for deleting a whole run — one row's × is cheap to undo, several
  // operations at once is worth a second of thought. Keyed by sheet and run index; cleared
  // on a timer so a stray click doesn't leave the list armed.
  const [confirmRun, setConfirmRun] = useState<string | null>(null)
  useEffect(() => {
    if (confirmRun === null) return
    const t = setTimeout(() => setConfirmRun(null), 3000)
    return () => clearTimeout(t)
  }, [confirmRun])
  // Folded sheets, by cell key. View state only — a fold changes nothing in the program.
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const toggleFold = (key: string) => setFolded((f) => {
    const n = new Set(f)
    if (n.has(key)) n.delete(key); else n.add(key)
    return n
  })

  // The canvas highlight follows the pointer — but not through a drag, where it would
  // flicker over every row passed, and never outlives the list (a click opens a form).
  const hover = (ids: string[]) => { if (!dragRef.current?.moved) useUIStore.getState().setHoverOpIds(ids) }
  useEffect(() => () => useUIStore.getState().setHoverOpIds([]), [])

  const runTimes = useOpRunTimes(operations, tools)
  // Only for an op still in the state it was timed in: one being regenerated has no
  // honest time until the next estimate lands.
  const timeOf = (op: AnyOperation) => (op.status === 'done' && op.visible ? runTimes.get(op.id) : undefined)
  const totalTimeS = [...runTimes.values()].reduce((a, b) => a + b, 0)
  const shareOf = (op: AnyOperation) => (totalTimeS > 0 ? (timeOf(op) ?? 0) / totalTimeS : 0)

  const stock: Stock = { widthMM, heightMM }
  const pathById = new Map(paths.map((p) => [p.id, p]))
  const cellOf = (op: AnyOperation) => opSheet(op, pathById, stock)
  const sheets = groupBySheet(operations, cellOf, cells, cellKey)
  const foldered = sheets.length > 1
  const sheetNumber = (c: Cell) => cells.findIndex((x) => sameCell(x, c))

  // Tool changes are per sheet — each sheet is its own file, so the last tool of one is
  // never "changed" into the first of the next.
  const changesIn = (ops: AnyOperation[]) => Math.max(0, toolRuns(ops).length - 1)
  const toolChanges = sheets.reduce((n, g) => n + changesIn(g.ops), 0)
  const staleCount = operations.filter((o) => o.status === 'needs-update').length
  // What grouping would save. Grouping the whole list groups every sheet's subsequence
  // too (a tool contiguous in the whole is contiguous in any part of it), so the per-sheet
  // count after it is each sheet's minimum. Zero means nothing to offer: hidden.
  const grouped = groupedByTool(operations)
  const groupedChanges = groupBySheet(grouped, cellOf, cells, cellKey).reduce((n, g) => n + changesIn(g.ops), 0)
  const savedChanges = toolChanges - groupedChanges
  const indexOf = (id: string) => operations.findIndex((o) => o.id === id)

  // Drop position from the pointer: among the rows of the dragged sheet only, the first
  // row whose midpoint is below the cursor — returned as an index into the WHOLE program
  // (what reorderedFor moves within), plus the y to draw the indicator at (list-relative,
  // so it follows scroll).
  //
  // The y needs a correction at run boundaries. Tool-change markers are DERIVED from the
  // resulting order, so one sitting in the gap now is not necessarily where it will be
  // after the drop: dropping an A-tool op into the A|B gap joins it to run A, and the
  // marker ends up BELOW it. Drawing the indicator at the next row's top edge — past the
  // marker — promises a landing spot on the wrong side of it. So once the index is known,
  // place the line on the side of the marker the operation will actually land.
  const dropAt = (clientY: number, sheet: string, draggedToolId?: string): { index: number; y: number } => {
    const list = listRef.current
    if (!list) return { index: operations.length, y: 0 }
    const rows = Array.from(list.querySelectorAll<HTMLElement>(`[data-op-id][data-sheet="${sheet}"]`))
    if (rows.length === 0) return { index: -1, y: 0 }
    const box = list.getBoundingClientRect()
    const rel = (clientEdge: number) => clientEdge - box.top + list.scrollTop

    let at = rows.length
    let y = 0
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (clientY < r.top + r.height / 2) { at = i; y = rel(r.top) - 2; break }
    }
    if (at === rows.length) y = rel(rows[rows.length - 1].getBoundingClientRect().bottom) + 2
    const below = rows[at]?.dataset.opId
    const above = rows[at - 1]?.dataset.opId
    const index = below ? indexOf(below) : indexOf(above!) + 1

    const aboveTool = above ? operations[indexOf(above)]?.toolId : undefined
    const belowTool = below ? operations[indexOf(below)]?.toolId : undefined
    if (draggedToolId && aboveTool && belowTool && aboveTool !== belowTool) {
      const marker = list.querySelector<HTMLElement>(`[data-boundary="${below}"]`)
      if (marker) {
        const m = marker.getBoundingClientRect()
        // Same tool as the run above → it joins that run, before the marker.
        if (draggedToolId === aboveTool) y = rel(m.top) - 2
        // Neither side's tool → it becomes a run of its own and the one marker becomes
        // two, with the operation between them. The marker's middle is that spot.
        else if (draggedToolId !== belowTool) y = rel(m.top + m.height / 2)
        // Same tool as the run below → after the marker, where the row edge already put it.
      }
    }
    return { index, y }
  }

  // One handler for every grab: a row drags itself, a run header its whole block.
  const beginDrag = (ids: string[], sheet: string) => (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    // Shift-click (or Alt-click) is the fast path for hiding — one event for the whole
    // grabbed set, so shift-clicking a run header toggles that tool's work in a single step.
    if (e.shiftKey || e.altKey) {
      const ops = useToolpathStore.getState().operations.filter((o) => ids.includes(o.id))
      if (ops.length > 0) useToolpathStore.getState().setOperationsVisible(ids, !ops.every((o) => o.visible))
      return
    }
    dragRef.current = { ids, sheet, startY: e.clientY, moved: false, to: -1 }
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      // 4 px of travel separates a drag from a click, same threshold the canvas uses.
      if (!d.moved && Math.abs(e.clientY - d.startY) < 4) return
      if (!d.moved) { d.moved = true; setDraggingIds(d.ids); useUIStore.getState().setHoverOpIds([]) }
      const dragged = useToolpathStore.getState().operations.find((o) => o.id === d.ids[0])
      const { index, y } = dropAt(e.clientY, d.sheet, dragged?.toolId)
      d.to = index
      setDropY(index >= 0 ? y : null)
    }
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      setDraggingIds([])
      setDropY(null)
      if (!d) return
      if (d.moved) {
        if (d.to >= 0) moveOps(d.ids, d.to)
        return
      }
      // No travel: a plain click. Select the paths the operation is built from — so the
      // canvas shows WHICH geometry this row cuts — and open its edit form.
      //
      // The whole BATCH's paths, not this one operation's. This list is the program, so
      // it draws a row per operation, but the form the click opens edits every operation
      // the same Generate click made (`batchOf`) — and ProfileForm and DrillForm read
      // their path list back OUT of the selection, where one member's path would read as
      // "the other four were taken away".
      const ops = useToolpathStore.getState().operations
      const op = ops.find((o) => o.id === d.ids[0])
      if (op) {
        const live = new Set(usePathsStore.getState().paths.map((p) => p.id))
        const ids = [...new Set(batchOf(op, ops).flatMap(pathIdsOf))].filter((id) => live.has(id))
        if (ids.length > 0) usePathsStore.getState().setSelectedIds(ids)
      }
      const ui = useUIStore.getState()
      ui.closeDrawPanels()
      ui.setSidebarTab('draw')
      ui.setRequestEditOpId(d.ids[0])
      // After the request, which clears it: closing this form comes back here.
      ui.setReturnToToolpaths(true)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  })

  if (operations.length === 0) {
    return (
      <div className="px-3 py-6 text-body text-gray-600 dark:text-neutral-400 text-center">
        <Route size={ICON.lg} className="mx-auto mb-2 opacity-30" />
        No toolpaths yet — generate one from CAM Operations in the Draw tab.
      </div>
    )
  }

  // One sheet's tool runs, as bands with tool-change markers between them.
  const renderRuns = (runs: Run[], sheet: string) => runs.map((run, ri) => {
    const tool = tools.find((t) => t.id === run.toolId)
    const runIds = run.ops.map((o) => o.id)
    const runVisible = run.ops.every((o) => o.visible)
    const runTimeS = run.ops.reduce((t, o) => t + (timeOf(o) ?? 0), 0)
    const n = run.ops.length
    const confirmKey = `${sheet}:${ri}`
    return (
      <div key={`${run.toolId}-${ri}`}>
        {/* Tool change between runs — at full weight because it is the expensive thing in
            the program, and the count of them is what reordering is usually trying to
            reduce. Named by the run's first op, which is how dropAt finds it. */}
        {ri > 0 && (
          <div data-boundary={run.ops[0].id} title={`Tool change → ${toolLabel(run.toolId, tool)}`}
            className="flex items-center gap-1.5 mb-1 px-2 py-0.5 rounded border border-orange-500/50 bg-orange-500/10 text-orange-600 dark:text-orange-400 text-[12px]">
            <ArrowRightLeft size={11} /> Tool change
          </div>
        )}
        <div className="rounded border p-1 space-y-0.5" style={bandStyle(run.toolId, tools, darkMode)}>
          {/* The run header drags the whole block — moving a tool's worth of work is the
              common case, and doing it row by row would pass through orders with MORE
              tool changes than either end state. */}
          <div onMouseDown={beginDrag(runIds, sheet)}
            onMouseEnter={() => hover(runIds)} onMouseLeave={() => hover([])}
            title={`${toolLabel(run.toolId, tool)} — drag to move all ${n} operation${n === 1 ? '' : 's'}`}
            className="group/run flex items-center gap-1 h-6 px-0.5 cursor-grab active:cursor-grabbing">
            <GripVertical size={12} className="flex-shrink-0 opacity-50" />
            <span className="flex-1 min-w-0 truncate text-[12px] font-semibold text-gray-700 dark:text-neutral-200">
              {toolLabel(run.toolId, tool)}
            </span>
            <span className="hidden group-hover/run:flex items-center gap-1.5 mr-1.5">
              {/* One event for the whole run rather than one per operation. */}
              <RowButton title={runVisible ? `Hide all ${n} — excluded from exported G-code` : `Show all ${n}`}
                onClick={() => useToolpathStore.getState().setOperationsVisible(runIds, !runVisible)}
                className="hover:text-blue-600 dark:hover:text-blue-300">
                {runVisible ? <EyeOff size={15} /> : <Eye size={15} />}
              </RowButton>
            </span>
            <RowButton
              title={confirmRun === confirmKey ? `Click again to delete all ${n} operation${n === 1 ? '' : 's'}` : `Delete all ${n} operation${n === 1 ? '' : 's'} on this tool`}
              onClick={() => {
                if (confirmRun !== confirmKey) { setConfirmRun(confirmKey); return }
                setConfirmRun(null)
                useToolpathStore.getState().deleteOperations(runIds)
              }}
              className={confirmRun === confirmKey ? '!flex text-white bg-red-500' : 'hidden group-hover/run:flex hover:text-red-600 dark:hover:text-red-300'}>
              <X size={15} />
            </RowButton>
            {runTimeS > 0 && (
              <span className="flex-shrink-0 text-[11px] tabular-nums text-right font-medium text-gray-700 dark:text-neutral-300 group-hover/run:hidden"
                title={`${fmtDuration(runTimeS)} on this tool — ${pct(runTimeS / totalTimeS)} of the program`}>
                {fmtDurationShort(runTimeS)}<span className="inline-block w-9 text-gray-500 dark:text-neutral-400">{pct(runTimeS / totalTimeS)}</span>
              </span>
            )}
          </div>
          {run.ops.map((op) => (
            <OpRow key={op.id} op={op} sheet={sheet}
              dragging={draggingIds.includes(op.id)}
              noCut={nothingToCut(op, operations)}
              timeS={timeOf(op)}
              share={shareOf(op)}
              onGrab={beginDrag([op.id], sheet)}
              onHover={hover} />
          ))}
        </div>
      </div>
    )
  })

  return (
    <div className="flex flex-col h-full min-h-0 select-none">
      {/* The program at a glance: what it costs in tool changes and time, and the one
          action that cuts tool changes. */}
      <div className="sticky top-0 z-20 flex items-center gap-2 px-3 py-1.5 border-b border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-900 text-[12px] text-gray-600 dark:text-neutral-400 flex-shrink-0">
        <span className="font-mono" title={`${operations.length} operations, ${toolChanges} tool change${toolChanges === 1 ? '' : 's'}`
          + (foldered ? ` over ${sheets.length} sheets` : '')
          + (totalTimeS > 0 ? `\n${fmtDuration(totalTimeS)} to run the program (no time for tool changes)` : '')}>
          {operations.length} op{operations.length === 1 ? '' : 's'} · {toolChanges} TC
          {totalTimeS > 0 && <> · <span className="text-gray-800 dark:text-neutral-200">{fmtDuration(totalTimeS)}</span></>}
        </span>
        {staleCount > 0 && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-500"
            title={`${staleCount} operation${staleCount === 1 ? '' : 's'} need regenerating`}>
            <AlertCircle size={12} />{staleCount}
          </span>
        )}
        <span className="flex-1" />
        {/* Explicit, undoable regroup — one op.reorder event. */}
        {savedChanges > 0 && (
          <button
            onClick={() => { if (!sameOrder(grouped, operations)) useToolpathStore.getState().reorderOperations(grouped) }}
            title={`Group each tool's operations together — ${toolChanges} tool change${toolChanges === 1 ? '' : 's'} becomes ${groupedChanges}`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-orange-600 dark:text-orange-400 border border-orange-500/40 hover:bg-orange-500/10">
            <Combine size={12} />Group by tool −{savedChanges} TC
          </button>
        )}
      </div>

      <div ref={listRef} onMouseLeave={() => hover([])}
        className="relative flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
        {/* Drop indicator — absolutely positioned so inserting it never reflows the rows
            out from under the pointer mid-drag. */}
        {dropY !== null && (
          <div className="absolute left-1 right-1 h-0.5 bg-blue-500 rounded pointer-events-none z-10" style={{ top: dropY }} />
        )}
        {!foldered
          ? renderRuns(toolRuns(operations), sheets[0]?.key ?? cellKey(STOCK_CELL))
          : sheets.map((g) => {
            const k = sheetNumber(g.cell)
            const name = k >= 0 ? sheetName(g.cell, k, doubleSided) : 'Sheet ?'
            const open = !folded.has(g.key)
            const ids = g.ops.map((o) => o.id)
            const n = g.ops.length
            const tc = changesIn(g.ops)
            const visible = g.ops.every((o) => o.visible)
            const sheetTimeS = g.ops.reduce((t, o) => t + (timeOf(o) ?? 0), 0)
            const active = sameCell(g.cell, activeCell)
            const FolderIcon = open ? FolderOpen : Folder
            return (
              <div key={g.key} className="space-y-1">
                <div onClick={() => toggleFold(g.key)}
                  onMouseEnter={() => hover(ids)} onMouseLeave={() => hover([])}
                  title={`${name} — ${n} operation${n === 1 ? '' : 's'}, ${tc} tool change${tc === 1 ? '' : 's'}`
                    + (sheetTimeS > 0 ? `, ${fmtDuration(sheetTimeS)}` : '')
                    + `\nIts own G-code file.${active ? ' The sheet Simulate plays.' : ''}\nClick to ${open ? 'fold' : 'unfold'}`}
                  className="group/sheet flex items-center gap-1 h-7 px-1 rounded cursor-pointer bg-gray-200/70 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-800 dark:text-neutral-200">
                  {open ? <ChevronDown size={12} className="flex-shrink-0" /> : <ChevronRight size={12} className="flex-shrink-0" />}
                  <FolderIcon size={13} className="flex-shrink-0 text-gray-500 dark:text-neutral-400" />
                  <span className={`truncate text-[12px] ${active ? 'font-bold' : 'font-semibold'}`}>{name}</span>
                  <span className="flex-1 min-w-0 truncate text-[11px] text-gray-500 dark:text-neutral-400">
                    {n} op{n === 1 ? '' : 's'} · {tc} TC
                  </span>
                  <span className="hidden group-hover/sheet:flex items-center gap-1.5">
                    <RowButton title={visible ? `Hide all ${n} on ${name} — excluded from exported G-code` : `Show all ${n} on ${name}`}
                      onClick={() => useToolpathStore.getState().setOperationsVisible(ids, !visible)}
                      className="hover:text-blue-600 dark:hover:text-blue-300">
                      {visible ? <EyeOff size={15} /> : <Eye size={15} />}
                    </RowButton>
                  </span>
                  {sheetTimeS > 0 && (
                    <span className="flex-shrink-0 text-[11px] tabular-nums text-right font-medium text-gray-700 dark:text-neutral-300 group-hover/sheet:hidden">
                      {fmtDurationShort(sheetTimeS)}<span className="inline-block w-9 text-gray-500 dark:text-neutral-400">{pct(sheetTimeS / totalTimeS)}</span>
                    </span>
                  )}
                </div>
                {open && <div className="pl-2 space-y-1">{renderRuns(toolRuns(g.ops), g.key)}</div>}
              </div>
            )
          })}
      </div>
    </div>
  )
}
