// Ordering maths for the Toolpaths list (ToolpathsPanel). Pure so the index arithmetic — the part that
// is easy to get subtly wrong and impossible to eyeball — is unit-testable without React.
import type { AnyOperation } from '../store/toolpathStore'

export interface Run { toolId: string; ops: AnyOperation[] }

/**
 * Maximal stretches of CONSECUTIVE same-tool operations.
 *
 * Consecutive, not "all ops with this tool id": the ops list is flat and new operations
 * append to the end, so it can read A, B, A. That costs three tool changes, and a view
 * that groups by tool id (the Paths panel) draws two groups and hides the third.
 */
export function toolRuns(operations: AnyOperation[]): Run[] {
  const runs: Run[] = []
  for (const op of operations) {
    const last = runs[runs.length - 1]
    if (last && last.toolId === op.toolId) last.ops.push(op)
    else runs.push({ toolId: op.toolId, ops: [op] })
  }
  return runs
}

/** Tool changes the program will perform, which is one fewer than its runs. */
export const toolChangeCount = (operations: AnyOperation[]): number =>
  Math.max(0, toolRuns(operations).length - 1)

/**
 * Ops rearranged so each tool's operations are contiguous, keeping the order the tools
 * first appear and the relative order within each tool. The fewest tool changes reachable
 * without reordering anything beyond what grouping demands.
 */
export function groupedByTool(ops: AnyOperation[]): AnyOperation[] {
  const order: string[] = []
  const byTool = new Map<string, AnyOperation[]>()
  for (const op of ops) {
    if (!byTool.has(op.toolId)) { byTool.set(op.toolId, []); order.push(op.toolId) }
    byTool.get(op.toolId)!.push(op)
  }
  return order.flatMap((t) => byTool.get(t)!)
}

export const sameOrder = (a: AnyOperation[], b: AnyOperation[]): boolean =>
  a.length === b.length && a.every((o, i) => o.id === b[i].id)

/**
 * `ids` moved so they sit at index `to` of the CURRENT list.
 *
 * `to` counts positions in the pre-move list — that is what the drop indicator is drawn
 * between — so items pulled out from before it have to be discounted, or every drag to
 * the right lands one slot short. Ids keep their existing relative order, which is what
 * makes dragging a whole run a block move rather than a shuffle.
 */
export function reorderedFor(ops: AnyOperation[], ids: string[], to: number): AnyOperation[] {
  const idSet = new Set(ids)
  const moving = ops.filter((o) => idSet.has(o.id))
  if (moving.length === 0) return ops
  const rest = ops.filter((o) => !idSet.has(o.id))
  const clamped = Math.max(0, Math.min(ops.length, to))
  const removedBefore = ops.slice(0, clamped).filter((o) => idSet.has(o.id)).length
  const at = clamped - removedBefore
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)]
}

export interface SheetGroup<C> { cell: C; key: string; ops: AnyOperation[] }

/**
 * The program split by sheet, for the Toolpaths list's folders. Each sheet is its own
 * file on the machine (`buildGcodeInputs`), so what runs on it is the SUBSEQUENCE of the
 * program on that sheet — program order is kept inside each group, and tool runs and tool
 * changes are counted per group, never across a sheet boundary.
 *
 * Groups come in `cells` order (the sheets' reading order, "Sheet k + 1" everywhere) and
 * only for sheets with something on them. An op whose cell is not in `cells` gets a group
 * after them rather than vanishing from the list.
 */
export function groupBySheet<C>(ops: AnyOperation[], cellOf: (op: AnyOperation) => C, cells: C[], keyOf: (c: C) => string): SheetGroup<C>[] {
  const byKey = new Map<string, SheetGroup<C>>()
  for (const op of ops) {
    const cell = cellOf(op)
    const key = keyOf(cell)
    let g = byKey.get(key)
    if (!g) { g = { cell, key, ops: [] }; byKey.set(key, g) }
    g.ops.push(op)
  }
  const order = new Map(cells.map((c, i) => [keyOf(c), i]))
  return [...byKey.values()].sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity))
}
