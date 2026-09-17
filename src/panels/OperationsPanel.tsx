import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown, ChevronUp, Circle, RefreshCw, Target, CircleDot, Layers, Star, Box,
  Image as ImageIcon,
  FileCode, Wrench, Loader2, AlertCircle, Eye, EyeOff, ArrowRightLeft, Combine, GripVertical, X,
} from 'lucide-react'
import { useToolpathStore, batchOf, pathIdsOf, GCODE_IMPORT_TOOL_ID, type AnyOperation } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { useUIStore } from '../store/uiStore'
import { OP_TYPE_COLORS, TOOL_BAND_HUES } from '../colors'
import { InlayIcon } from './MachinePanel'
import { BottomTabs } from './BottomTabs'
import { toolRuns, groupedByTool, sameOrder, reorderedFor } from './operationsOrder'

// The PROGRAM strip: one chip per operation, in the order the machine will run them,
// docked under the 2D canvas next to the timeline.
//
// It is deliberately not the timeline. The timeline is a log — chips sit where the edit
// happened, and reordering operations appends a new event rather than moving one. This
// strip is the other ordering: `toolpathStore.operations`, which is what generateGcode
// walks. Dragging here reorders the program and records one `op.reorder` event; the chip
// that created the operation stays where it is in history.
//
// Tool runs are DERIVED — a run is a maximal stretch of consecutive same-tool ops, never
// a stored grouping. That matters: the ops list is flat and new operations append to the
// end, so a list can read A, B, A and cost three tool changes. A view that groups by tool
// id (as the Paths panel does) shows two tidy groups and hides the third change; this one
// draws what the machine actually does, which is also what "Minimise tool changes" fixes.

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

// Hover controls sit ON the chip so they never take layout space (the strip is dense and
// chips must not resize under the pointer mid-drag). Their mousedown stops there — the
// chip itself is a drag handle, and grabbing the eye must not start a reorder.
//
// Geometry matches the timeline chip's remove button exactly (16 px, hung off the top
// corner, 10 px glyph) so the two strips read as one system. The colours are the stronger
// treatment: full-strength border, near-max-contrast ink in both themes, and a solid fill
// on hover rather than a tint.
function ChipButton({ title, onClick, className, children }: {
  title: string
  onClick: () => void
  className: string
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={[
        'absolute -top-1.5 z-10 hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full shadow-sm',
        'border border-gray-400 dark:border-neutral-400',
        'bg-white dark:bg-neutral-800 text-gray-800 dark:text-neutral-100',
        className,
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// Imported G-code has no editable form, so its chip carries what the (now retired)
// Paths-panel info block showed: which file it came from and how much motion it holds.
function gcodeDetail(op: AnyOperation): string | null {
  if (op.type !== 'gcode') return null
  const cut = op.segments.filter((seg) => !seg.rapid).length
  const rapid = op.segments.length - cut
  return `${op.filename} — ${cut.toLocaleString()} cut, ${rapid.toLocaleString()} rapid moves (read-only)`
}

function OpChip({ op, dragging, compact, onGrab }: {
  op: AnyOperation
  dragging: boolean
  compact: boolean
  onGrab: (e: React.MouseEvent) => void
}) {
  const Icon = OP_ICONS[op.type] ?? Wrench
  const color = OP_TYPE_COLORS[op.type] ?? '#94a3b8'
  // A hidden operation is not just dimmed on the canvas — generateGcode skips it, so it
  // is missing from the exported program. Drawn dashed and faded so that reads at a
  // glance here, in the order where its absence matters. The fade is applied to the chip's
  // CONTENT, not the chip: opacity on the container would create a group its own buttons
  // can't escape, which is what made the un-hide eye nearly invisible on a hidden chip.
  const hidden = !op.visible

  const statusRing =
    op.status === 'error' ? 'ring-2 ring-red-500/60'
      : op.status === 'needs-update' ? 'ring-2 ring-amber-500/60'
        : ''

  return (
    <div
      data-op-id={op.id}
      onMouseDown={onGrab}
      // One line per fact, worst news first. A failure is the reason someone hovers a
      // ringed chip, so it leads and says what it costs — an errored op has no segments,
      // and generateGcode only emits ops that are 'done', so it is silently absent from
      // the exported program rather than cutting anything.
      title={[
        op.status === 'error'
          ? `⚠ Failed to generate: ${op.errorMessage ?? 'unknown error'}\nThis operation is NOT in the exported G-code.`
          : null,
        op.status === 'needs-update'
          ? '⚠ Needs regenerating — excluded from the exported G-code until you do.'
          : null,
        hidden ? 'Hidden — excluded from the exported G-code.' : null,
        op.name,
        gcodeDetail(op),
        'Drag to reorder · Alt-click to hide',
      ].filter(Boolean).join('\n')}
      className={[
        'group relative flex items-center gap-1 px-1.5 h-6 rounded border text-[13px] flex-shrink-0 cursor-grab active:cursor-grabbing',
        'bg-white/60 dark:bg-neutral-900/60 hover:bg-white dark:hover:bg-neutral-700',
        hidden ? 'border-dashed' : 'border-solid',
        'border-gray-300 dark:border-neutral-600',
        dragging ? 'opacity-30' : '',
        statusRing,
      ].join(' ')}
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
    >
      {/* Compact drops the name AND the inline status icons — the ring already says
          needs-update/error and the dashed faded chip already says hidden, so those icons
          are duplicates paying for themselves in width. Everything stays in the tooltip. */}
      <span className={['flex items-center gap-1 min-w-0', hidden ? 'opacity-40' : ''].join(' ')}>
        <Icon size={12} style={{ color }} />
        {!compact && <>
          <span className="max-w-[130px] truncate text-gray-700 dark:text-neutral-300">{op.name}</span>
          {op.status === 'generating' && <Loader2 size={10} className="animate-spin text-blue-400" />}
          {op.status === 'needs-update' && <AlertCircle size={10} className="text-amber-600 dark:text-amber-500" />}
          {op.status === 'error' && <AlertCircle size={10} className="text-red-600 dark:text-red-500" />}
          {hidden && <EyeOff size={10} className="text-gray-600 dark:text-neutral-400" />}
        </>}
        {compact && op.status === 'generating' && <Loader2 size={10} className="animate-spin text-blue-400" />}
      </span>

      <ChipButton
        title={hidden ? 'Show — include in exported G-code' : 'Hide — exclude from exported G-code'}
        onClick={() => useToolpathStore.getState().toggleVisibility(op.id)}
        className="-left-1.5 hover:text-white hover:bg-blue-500 hover:border-blue-500"
      >
        {hidden ? <Eye size={10} /> : <EyeOff size={10} />}
      </ChipButton>
      <ChipButton
        title={`Delete "${op.name}"`}
        onClick={() => useToolpathStore.getState().deleteOperation(op.id)}
        className="-right-1.5 hover:text-white hover:bg-red-500 hover:border-red-500"
      >
        <X size={10} />
      </ChipButton>
    </div>
  )
}

export default function OperationsPanel() {
  const operations = useToolpathStore((s) => s.operations)
  const tools = useToolStore((s) => s.tools)
  const timelineOpen = useUIStore((s) => s.timelineOpen)
  const setTimelineOpen = useUIStore((s) => s.setTimelineOpen)
  const darkMode = useUIStore((s) => s.darkMode)

  const stripRef = useRef<HTMLDivElement>(null)
  // Gesture state in a ref (the window listeners read it mid-drag), mirrored into state
  // only for what has to re-render: the ghosted source chips and the drop indicator.
  const dragRef = useRef<{ ids: string[]; startX: number; moved: boolean; to: number } | null>(null)
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [dropX, setDropX] = useState<number | null>(null)
  // Two-click confirm for deleting a whole run — one chip's × is cheap to undo, several
  // operations at once is worth a second of thought. Keyed by run index; cleared on a
  // timer so a stray click doesn't leave the strip armed.
  const [stripW, setStripW] = useState(0)
  const [confirmRun, setConfirmRun] = useState<number | null>(null)
  // Track the strip's width so chips can drop their labels before overflowing.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const ro = new ResizeObserver(() => setStripW(strip.clientWidth))
    ro.observe(strip)
    setStripW(strip.clientWidth)
    return () => ro.disconnect()
  }, [timelineOpen])

  useEffect(() => {
    if (confirmRun === null) return
    const t = setTimeout(() => setConfirmRun(null), 3000)
    return () => clearTimeout(t)
  }, [confirmRun])

  const runs = toolRuns(operations)
  const toolChanges = Math.max(0, runs.length - 1)
  const staleCount = operations.filter((o) => o.status === 'needs-update').length
  // What grouping would save. Zero means the program is already at its minimum, so the
  // button has nothing to offer and stays hidden.
  const grouped = groupedByTool(operations)
  const savedChanges = toolChanges - Math.max(0, toolRuns(grouped).length - 1)

  // Same deal as the timeline strip: estimate the fully-labelled width and, when it
  // wouldn't fit, collapse EVERY chip to icon-only rather than truncating some — a strip
  // of mixed widths is harder to read than a strip of icons, and the tool-change markers
  // are what has to stay legible at a glance. Estimated (13 px font ≈ 6.8 px/char, names
  // truncate at 130 px) rather than measured, so there's no measure-render-measure loop
  // and no flip-flopping at the boundary.
  const CHIP_CHROME_W = 34   // icon + padding + border + gap
  const TOOL_CHANGE_W = 34   // marker + its margins
  const RUN_LABEL_W = 14     // the grip + band padding under every run
  const labeledW = operations.reduce((w, op) => w + CHIP_CHROME_W + Math.min(130, op.name.length * 6.8), 0)
    + toolChanges * TOOL_CHANGE_W + runs.length * RUN_LABEL_W
  const compact = stripW > 0 && labeledW > stripW

  // Drop position from the pointer: the index of the first chip whose midpoint is right of
  // the cursor, plus the x to draw the indicator at (strip-relative, so it follows scroll).
  //
  // The x needs a correction at run boundaries. Tool-change markers are DERIVED from the
  // resulting order, so one sitting in the gap now is not necessarily where it will be
  // after the drop: dropping an A-tool op into the A|B gap joins it to run A, and the
  // marker ends up to its RIGHT. Drawing the indicator at the next chip's left edge —
  // past the marker — promises a landing spot on the wrong side of it. So once the index
  // is known, place the line on the side of the marker the operation will actually land.
  const dropAt = (clientX: number, draggedToolId?: string): { index: number; x: number } => {
    const strip = stripRef.current
    if (!strip) return { index: operations.length, x: 0 }
    const chips = Array.from(strip.querySelectorAll<HTMLElement>('[data-op-id]'))
    const stripBox = strip.getBoundingClientRect()
    const rel = (clientEdge: number) => clientEdge - stripBox.left + strip.scrollLeft

    let index = chips.length
    let x = 0
    let found = false
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i].getBoundingClientRect()
      if (clientX < r.left + r.width / 2) { index = i; x = rel(r.left) - 2; found = true; break }
    }
    if (!found) {
      const last = chips[chips.length - 1]?.getBoundingClientRect()
      x = last ? rel(last.right) + 2 : 0
    }

    const leftTool = operations[index - 1]?.toolId
    const rightTool = operations[index]?.toolId
    if (draggedToolId && leftTool && rightTool && leftTool !== rightTool) {
      const marker = strip.querySelector<HTMLElement>(`[data-boundary="${index}"]`)
      if (marker) {
        const m = marker.getBoundingClientRect()
        // Same tool as the run on the left → it joins that run, before the marker.
        if (draggedToolId === leftTool) x = rel(m.left) - 2
        // Neither side's tool → it becomes a run of its own and the one marker becomes
        // two, with the operation between them. The marker's middle is that spot.
        else if (draggedToolId !== rightTool) x = rel(m.left + m.width / 2)
        // Same tool as the run on the right → after the marker, which is where the chip
        // edge already put it.
      }
    }
    return { index, x }
  }

  // One handler for both grabs: a chip drags itself, a run header drags its whole block.
  const beginDrag = (ids: string[]) => (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    // Alt-click is the fast path for hiding — one event for the whole grabbed set, so
    // alt-clicking a run header toggles that tool's work in a single chip.
    if (e.altKey) {
      const ops = useToolpathStore.getState().operations.filter((o) => ids.includes(o.id))
      if (ops.length > 0) useToolpathStore.getState().setOperationsVisible(ids, !ops.every((o) => o.visible))
      return
    }
    dragRef.current = { ids, startX: e.clientX, moved: false, to: -1 }
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      // 4 px of travel separates a drag from a click, same threshold the canvas uses.
      if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return
      if (!d.moved) { d.moved = true; setDraggingIds(d.ids) }
      const dragged = useToolpathStore.getState().operations.find((o) => o.id === d.ids[0])
      const { index, x } = dropAt(e.clientX, dragged?.toolId)
      d.to = index
      setDropX(x)
    }
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      setDraggingIds([])
      setDropX(null)
      if (!d) return
      if (d.moved) {
        if (d.to >= 0) moveOps(d.ids, d.to)
        return
      }
      // No travel: a plain click. Select the paths the operation is built from — so the
      // canvas shows WHICH geometry this chip cuts — and open its edit form.
      //
      // The whole BATCH's paths, not this one operation's. This strip is the program, so
      // it draws a chip per operation, but the form the click opens edits every operation
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
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  })

  if (!timelineOpen) {
    return (
      <div className="flex items-center h-[22px] px-2 gap-2 border-t border-gray-300 dark:border-neutral-700 bg-gray-200 dark:bg-neutral-800 flex-shrink-0 select-none">
        <button
          onClick={() => setTimelineOpen(true)}
          className="flex items-center gap-1 text-[13px] text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200"
          title="Show operations"
        >
          <ChevronUp size={13} />
          Ops{operations.length > 0 ? ` · ${operations.length}` : ''}
        </button>
      </div>
    )
  }

  const btnCls = 'p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 hover:bg-gray-300 dark:hover:bg-neutral-700'

  return (
    <div className="border-t border-gray-300 dark:border-neutral-700 bg-gray-200 dark:bg-neutral-800 flex-shrink-0 select-none">
      <div className="flex items-center h-14 px-2 gap-2">
        <BottomTabs />

        {/* Top padding is what the buttons hanging off each chip's top corner overhang
            INTO. The timeline strip gets that for free — its chips are vertically centred
            with slack either side — but here each run is a chip row plus a tool header
            beneath it, which uses the slack up. So: align to the top and pad above by more
            than the 6 px overhang. The run header is a FIXED 16 px (see below), so the
            whole thing is 6 pad + 2 band + 24 chips + 16 header + 2 band = 50 of the
            56 px row, hover or not. Without the padding the overhang leaves the box and,
            since
            `overflow-x-auto` computes overflow-y to auto too, the whole row scrolls. */}
        <div ref={stripRef} className="relative flex-1 flex items-start pt-1.5 gap-1 overflow-x-auto px-1 min-w-0 h-full">
          {/* Drop indicator — absolutely positioned so inserting it never reflows the
              chips out from under the pointer mid-drag. */}
          {dropX !== null && (
            <div className="absolute top-1 bottom-1 w-0.5 bg-blue-500 rounded pointer-events-none z-10" style={{ left: dropX }} />
          )}
          {operations.length === 0 ? (
            <span className="self-center text-[13px] text-gray-600 dark:text-neutral-400">
              No operations yet — generate a toolpath from CAM Operations in the Draw tab.
            </span>
          ) : (
            runs.map((run, ri) => {
              const tool = tools.find((t) => t.id === run.toolId)
              // Ops index this run starts at — the insertion index of the boundary its
              // tool-change marker sits in, which is how dropAt finds the marker.
              const runStart = runs.slice(0, ri).reduce((n, r) => n + r.ops.length, 0)
              const runIds = run.ops.map((o) => o.id)
              const runVisible = run.ops.every((o) => o.visible)
              return (
                <div key={`${run.toolId}-${ri}`} className="flex items-start gap-1 flex-shrink-0">
                  {/* Tool change between runs — drawn at full weight because it is the
                      expensive thing in the program, and the count of them is exactly
                      what reordering is usually trying to reduce. */}
                  {ri > 0 && (
                    <div
                      data-boundary={runStart}
                      title={`Tool change → ${toolLabel(run.toolId, tool)}`}
                      // self-center against the run wrapper, whose height is the band's —
                      // the strip aligns runs to the top so the chips clear their hover
                      // buttons, which would otherwise leave this marker hanging at the
                      // top rather than sitting between the two bands it separates.
                      className="self-center flex items-center gap-1 px-1.5 h-6 mx-0.5 rounded border border-orange-500/50 bg-orange-500/10 text-orange-600 dark:text-orange-400 text-[13px] flex-shrink-0"
                    >
                      <ArrowRightLeft size={11} />
                    </div>
                  )}
                  <div
                    className="flex flex-col rounded border px-1 py-0.5"
                    style={bandStyle(run.toolId, tools, darkMode)}
                  >
                    <div className="flex items-center gap-1">
                      {run.ops.map((op) => (
                        <OpChip
                          key={op.id}
                          op={op}
                          dragging={draggingIds.includes(op.id)}
                          compact={compact}
                          onGrab={beginDrag([op.id])}
                        />
                      ))}
                    </div>
                    {/* The run header drags the whole block — moving a tool's worth of
                        work is the common case, and doing it chip by chip would pass
                        through orders with MORE tool changes than either end state. */}
                    {/* Fixed height: the hover controls are taller than the label, so
                        without it the row grew on hover — shoving the label down and out
                        of the bar. Sized to the controls, not the text. */}
                    {/* The WHOLE header row is the run's drag handle — the strip is dense
                        and a 9 px grip is a hard target, so anywhere under the chips
                        works. The two controls stop the mousedown so pressing one doesn't
                        start a drag instead. */}
                    <div
                      onMouseDown={beginDrag(runIds)}
                      title={`${toolLabel(run.toolId, tool)} — drag to move all ${run.ops.length} operation${run.ops.length === 1 ? '' : 's'}`}
                      className="group/run flex items-center gap-0.5 h-4 cursor-grab active:cursor-grabbing"
                    >
                      <span className="flex items-center gap-0.5 text-[11px] leading-none font-medium text-gray-600 dark:text-neutral-300 truncate min-w-0">
                        <GripVertical size={9} className="flex-shrink-0 opacity-60" />
                        {/* Hidden when compact: a flex column is as wide as its widest
                            child, so this label would set the run's width once the chips
                            above it collapse to icons — undoing the saving. The grip
                            stays and the row's tooltip still names the tool. */}
                        {!compact && <span className="truncate">{toolLabel(run.toolId, tool)}</span>}
                      </span>
                      {/* One event for the whole run rather than one per operation. */}
                      <button
                        title={runVisible
                          ? `Hide all ${run.ops.length} — excluded from exported G-code`
                          : `Show all ${run.ops.length}`}
                        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                        onClick={() => useToolpathStore.getState().setOperationsVisible(runIds, !runVisible)}
                        className="hidden group-hover/run:flex items-center flex-shrink-0 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-600 dark:hover:text-blue-300"
                      >
                        {runVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                      <button
                        title={confirmRun === ri
                          ? `Click again to delete all ${run.ops.length} operation${run.ops.length === 1 ? '' : 's'}`
                          : `Delete all ${run.ops.length} operation${run.ops.length === 1 ? '' : 's'} on this tool`}
                        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                        onClick={() => {
                          if (confirmRun !== ri) { setConfirmRun(ri); return }
                          setConfirmRun(null)
                          useToolpathStore.getState().deleteOperations(runIds)
                        }}
                        className={[
                          'items-center flex-shrink-0 rounded',
                          confirmRun === ri
                            ? 'flex text-white bg-red-500'
                            : 'hidden group-hover/run:flex text-gray-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-300',
                        ].join(' ')}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Explicit, undoable regroup — one op.reorder event. The Paths panel does this
            silently as a side effect of any move, which is how an order nobody chose
            ends up in the G-code. */}
        {savedChanges > 0 && (
          <button
            onClick={() => { if (!sameOrder(grouped, operations)) useToolpathStore.getState().reorderOperations(grouped) }}
            title={`Group each tool's operations together — ${toolChanges} tool change${toolChanges === 1 ? '' : 's'} becomes ${toolChanges - savedChanges}`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[13px] text-orange-600 dark:text-orange-400 border border-orange-500/40 hover:bg-orange-500/10 flex-shrink-0"
          >
            <Combine size={12} />−{savedChanges} TC
          </button>
        )}

        <span className="text-[13px] text-gray-500 dark:text-neutral-400 font-mono px-1 flex-shrink-0"
          title={`${operations.length} operations, ${toolChanges} tool change${toolChanges === 1 ? '' : 's'}`}>
          {operations.length} op{operations.length === 1 ? '' : 's'} · {toolChanges} TC
        </span>
        {staleCount > 0 && (
          <span className="flex items-center gap-1 text-[13px] text-amber-600 dark:text-amber-500 flex-shrink-0"
            title={`${staleCount} operation${staleCount === 1 ? '' : 's'} need regenerating`}>
            <AlertCircle size={12} />{staleCount}
          </span>
        )}
        <button className={btnCls} title="Hide panel" onClick={() => setTimelineOpen(false)}>
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  )
}
