import { useEffect, useRef, useState } from 'react'
import {
  Circle, RefreshCw, Target, CircleDot, Layers, Star, Box,
  Image as ImageIcon,
  FileCode, Wrench, Loader2, AlertCircle, Eye, EyeOff, ArrowRightLeft, Combine, GripVertical, X, CircleSlash, Route,
} from 'lucide-react'
import { ICON } from '../theme'
import { useToolpathStore, batchOf, pathIdsOf, nothingToCut, GCODE_IMPORT_TOOL_ID, type AnyOperation } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { useUIStore } from '../store/uiStore'
import { OP_TYPE_COLORS, TOOL_BAND_HUES } from '../colors'
import { InlayIcon } from './MachinePanel'
import { toolRuns, groupedByTool, sameOrder, reorderedFor } from './operationsOrder'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { opRunTimesS, fmtDuration, fmtDurationShort } from '../cam/opTime'

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

type ChipIcon = React.ComponentType<{ size?: number; style?: React.CSSProperties }>

// Same per-op icons as the operations menu and the timeline chips.
const OP_ICONS: Record<string, ChipIcon> = {
  profile: Circle, trochoidal: RefreshCw, pocket: Target, drill: CircleDot,
  surface: Layers, vcarve: Star, inlay: InlayIcon, profile3d: Box, gcode: FileCode,
  photovcarve: ImageIcon,
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
    'Click to edit · Drag to reorder · Alt-click to hide',
  ].filter(Boolean).join('\n')
}

const pct = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`)

// Row controls: in the row's own space (a list has the width a strip did not), shown on
// hover. Their mousedown stops there — the row itself is a drag handle, and grabbing the
// eye must not start a reorder.
function RowButton({ title, onClick, className, children }: {
  title: string; onClick: () => void; className: string; children: React.ReactNode
}) {
  return (
    <button title={title}
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`flex items-center justify-center w-5 h-5 rounded flex-shrink-0 text-gray-500 dark:text-neutral-400 ${className}`}>
      {children}
    </button>
  )
}

function OpRow({ op, dragging, noCut, timeS, share, onGrab }: {
  op: AnyOperation
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
  return (
    <div data-op-id={op.id} onMouseDown={onGrab} title={opTitle(op, noCut, timeS, share)}
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
        <span className="flex-1 min-w-0 truncate text-body text-gray-800 dark:text-neutral-200">{op.name}</span>
        {op.status === 'generating' && <Loader2 size={11} className="animate-spin text-blue-400 flex-shrink-0" />}
        {op.status === 'needs-update' && <AlertCircle size={11} className="text-amber-600 dark:text-amber-500 flex-shrink-0" />}
        {op.status === 'error' && <AlertCircle size={11} className="text-red-600 dark:text-red-500 flex-shrink-0" />}
        {noCut && <CircleSlash size={11} className="text-gray-500 dark:text-neutral-400 flex-shrink-0" />}
        {hidden && <EyeOff size={11} className="text-gray-500 dark:text-neutral-400 flex-shrink-0" />}
        {timed && (
          <span className="flex-shrink-0 text-[11px] tabular-nums text-right text-gray-600 dark:text-neutral-400">
            {fmtDurationShort(timeS!)}<span className="inline-block w-9 text-gray-500 dark:text-neutral-500">{pct(share)}</span>
          </span>
        )}
      </span>
      <span className="hidden group-hover:flex items-center">
        <RowButton title={hidden ? 'Show — include in exported G-code' : 'Hide — exclude from exported G-code'}
          onClick={() => useToolpathStore.getState().toggleVisibility(op.id)} className="hover:text-blue-600 dark:hover:text-blue-300">
          {hidden ? <Eye size={12} /> : <EyeOff size={12} />}
        </RowButton>
        <RowButton title={`Delete "${op.name}"`} onClick={() => useToolpathStore.getState().deleteOperation(op.id)}
          className="hover:text-red-600 dark:hover:text-red-300">
          <X size={12} />
        </RowButton>
      </span>
    </div>
  )
}

export default function ToolpathsPanel() {
  const operations = useToolpathStore((s) => s.operations)
  const tools = useToolStore((s) => s.tools)
  const darkMode = useUIStore((s) => s.darkMode)

  const listRef = useRef<HTMLDivElement>(null)
  // Gesture state in a ref (the window listeners read it mid-drag), mirrored into state
  // only for what has to re-render: the ghosted source rows and the drop indicator.
  const dragRef = useRef<{ ids: string[]; startY: number; moved: boolean; to: number } | null>(null)
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [dropY, setDropY] = useState<number | null>(null)
  // Two-click confirm for deleting a whole run — one row's × is cheap to undo, several
  // operations at once is worth a second of thought. Keyed by run index; cleared on a
  // timer so a stray click doesn't leave the list armed.
  const [confirmRun, setConfirmRun] = useState<number | null>(null)
  useEffect(() => {
    if (confirmRun === null) return
    const t = setTimeout(() => setConfirmRun(null), 3000)
    return () => clearTimeout(t)
  }, [confirmRun])

  const runTimes = useOpRunTimes(operations, tools)
  // Only for an op still in the state it was timed in: one being regenerated has no
  // honest time until the next estimate lands.
  const timeOf = (op: AnyOperation) => (op.status === 'done' && op.visible ? runTimes.get(op.id) : undefined)
  const totalTimeS = [...runTimes.values()].reduce((a, b) => a + b, 0)
  const shareOf = (op: AnyOperation) => (totalTimeS > 0 ? (timeOf(op) ?? 0) / totalTimeS : 0)

  const runs = toolRuns(operations)
  const toolChanges = Math.max(0, runs.length - 1)
  const staleCount = operations.filter((o) => o.status === 'needs-update').length
  // What grouping would save. Zero means the program is already at its minimum, so the
  // button has nothing to offer and stays hidden.
  const grouped = groupedByTool(operations)
  const savedChanges = toolChanges - Math.max(0, toolRuns(grouped).length - 1)

  // Drop position from the pointer: the index of the first row whose midpoint is below
  // the cursor, plus the y to draw the indicator at (list-relative, so it follows scroll).
  //
  // The y needs a correction at run boundaries. Tool-change markers are DERIVED from the
  // resulting order, so one sitting in the gap now is not necessarily where it will be
  // after the drop: dropping an A-tool op into the A|B gap joins it to run A, and the
  // marker ends up BELOW it. Drawing the indicator at the next row's top edge — past the
  // marker — promises a landing spot on the wrong side of it. So once the index is known,
  // place the line on the side of the marker the operation will actually land.
  const dropAt = (clientY: number, draggedToolId?: string): { index: number; y: number } => {
    const list = listRef.current
    if (!list) return { index: operations.length, y: 0 }
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-op-id]'))
    const box = list.getBoundingClientRect()
    const rel = (clientEdge: number) => clientEdge - box.top + list.scrollTop

    let index = rows.length
    let y = 0
    let found = false
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (clientY < r.top + r.height / 2) { index = i; y = rel(r.top) - 2; found = true; break }
    }
    if (!found) {
      const last = rows[rows.length - 1]?.getBoundingClientRect()
      y = last ? rel(last.bottom) + 2 : 0
    }

    const aboveTool = operations[index - 1]?.toolId
    const belowTool = operations[index]?.toolId
    if (draggedToolId && aboveTool && belowTool && aboveTool !== belowTool) {
      const marker = list.querySelector<HTMLElement>(`[data-boundary="${index}"]`)
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

  // One handler for both grabs: a row drags itself, a run header drags its whole block.
  const beginDrag = (ids: string[]) => (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    // Alt-click is the fast path for hiding — one event for the whole grabbed set, so
    // alt-clicking a run header toggles that tool's work in a single step.
    if (e.altKey) {
      const ops = useToolpathStore.getState().operations.filter((o) => ids.includes(o.id))
      if (ops.length > 0) useToolpathStore.getState().setOperationsVisible(ids, !ops.every((o) => o.visible))
      return
    }
    dragRef.current = { ids, startY: e.clientY, moved: false, to: -1 }
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      // 4 px of travel separates a drag from a click, same threshold the canvas uses.
      if (!d.moved && Math.abs(e.clientY - d.startY) < 4) return
      if (!d.moved) { d.moved = true; setDraggingIds(d.ids) }
      const dragged = useToolpathStore.getState().operations.find((o) => o.id === d.ids[0])
      const { index, y } = dropAt(e.clientY, dragged?.toolId)
      d.to = index
      setDropY(y)
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

  return (
    <div className="flex flex-col h-full min-h-0 select-none">
      {/* The program at a glance: what it costs in tool changes and time, and the one
          action that cuts tool changes. */}
      <div className="sticky top-0 z-20 flex items-center gap-2 px-3 py-1.5 border-b border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-900 text-[12px] text-gray-600 dark:text-neutral-400 flex-shrink-0">
        <span className="font-mono" title={`${operations.length} operations, ${toolChanges} tool change${toolChanges === 1 ? '' : 's'}`
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
            title={`Group each tool's operations together — ${toolChanges} tool change${toolChanges === 1 ? '' : 's'} becomes ${toolChanges - savedChanges}`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-orange-600 dark:text-orange-400 border border-orange-500/40 hover:bg-orange-500/10">
            <Combine size={12} />Group by tool −{savedChanges} TC
          </button>
        )}
      </div>

      <div ref={listRef} className="relative flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
        {/* Drop indicator — absolutely positioned so inserting it never reflows the rows
            out from under the pointer mid-drag. */}
        {dropY !== null && (
          <div className="absolute left-1 right-1 h-0.5 bg-blue-500 rounded pointer-events-none z-10" style={{ top: dropY }} />
        )}
        {runs.map((run, ri) => {
          const tool = tools.find((t) => t.id === run.toolId)
          // Ops index this run starts at — the insertion index of the boundary its
          // tool-change marker sits in, which is how dropAt finds the marker.
          const runStart = runs.slice(0, ri).reduce((n, r) => n + r.ops.length, 0)
          const runIds = run.ops.map((o) => o.id)
          const runVisible = run.ops.every((o) => o.visible)
          const runTimeS = run.ops.reduce((t, o) => t + (timeOf(o) ?? 0), 0)
          const n = run.ops.length
          return (
            <div key={`${run.toolId}-${ri}`}>
              {/* Tool change between runs — at full weight because it is the expensive
                  thing in the program, and the count of them is what reordering is
                  usually trying to reduce. */}
              {ri > 0 && (
                <div data-boundary={runStart} title={`Tool change → ${toolLabel(run.toolId, tool)}`}
                  className="flex items-center gap-1.5 mb-1 px-2 py-0.5 rounded border border-orange-500/50 bg-orange-500/10 text-orange-600 dark:text-orange-400 text-[12px]">
                  <ArrowRightLeft size={11} /> Tool change
                </div>
              )}
              <div className="rounded border p-1 space-y-0.5" style={bandStyle(run.toolId, tools, darkMode)}>
                {/* The run header drags the whole block — moving a tool's worth of work is
                    the common case, and doing it row by row would pass through orders with
                    MORE tool changes than either end state. */}
                <div onMouseDown={beginDrag(runIds)}
                  title={`${toolLabel(run.toolId, tool)} — drag to move all ${n} operation${n === 1 ? '' : 's'}`}
                  className="group/run flex items-center gap-1 h-6 px-0.5 cursor-grab active:cursor-grabbing">
                  <GripVertical size={12} className="flex-shrink-0 opacity-50" />
                  <span className="flex-1 min-w-0 truncate text-[12px] font-semibold text-gray-700 dark:text-neutral-200">
                    {toolLabel(run.toolId, tool)}
                  </span>
                  <span className="hidden group-hover/run:flex items-center">
                    {/* One event for the whole run rather than one per operation. */}
                    <RowButton title={runVisible ? `Hide all ${n} — excluded from exported G-code` : `Show all ${n}`}
                      onClick={() => useToolpathStore.getState().setOperationsVisible(runIds, !runVisible)}
                      className="hover:text-blue-600 dark:hover:text-blue-300">
                      {runVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                    </RowButton>
                  </span>
                  <RowButton
                    title={confirmRun === ri ? `Click again to delete all ${n} operation${n === 1 ? '' : 's'}` : `Delete all ${n} operation${n === 1 ? '' : 's'} on this tool`}
                    onClick={() => {
                      if (confirmRun !== ri) { setConfirmRun(ri); return }
                      setConfirmRun(null)
                      useToolpathStore.getState().deleteOperations(runIds)
                    }}
                    className={confirmRun === ri ? '!flex text-white bg-red-500' : 'hidden group-hover/run:flex hover:text-red-600 dark:hover:text-red-300'}>
                    <X size={12} />
                  </RowButton>
                  {runTimeS > 0 && (
                    <span className="flex-shrink-0 text-[11px] tabular-nums text-right font-medium text-gray-700 dark:text-neutral-300"
                      title={`${fmtDuration(runTimeS)} on this tool — ${pct(runTimeS / totalTimeS)} of the program`}>
                      {fmtDurationShort(runTimeS)}<span className="inline-block w-9 text-gray-500 dark:text-neutral-400">{pct(runTimeS / totalTimeS)}</span>
                    </span>
                  )}
                </div>
                {run.ops.map((op) => (
                  <OpRow key={op.id} op={op}
                    dragging={draggingIds.includes(op.id)}
                    noCut={nothingToCut(op, operations)}
                    timeS={timeOf(op)}
                    share={shareOf(op)}
                    onGrab={beginDrag([op.id])} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
