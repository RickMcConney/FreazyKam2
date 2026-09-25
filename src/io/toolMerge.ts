import type { Tool } from '../store/toolStore'
import type { AnyOperation } from '../store/toolpathStore'
import { uid } from '../uid'

/**
 * Bring an opened project's tools into the user's library WITHOUT replacing it.
 *
 * The tool library is the user's MACHINE — the cutters in their rack, with the feeds
 * they run them at — and it persists in localStorage for that reason. Opening a project
 * used to `setTools(file.tools)`, so a file a friend sent quietly became your library
 * from then on (review2 A3). Now only what the file's operations actually cut with comes
 * across, and nothing already in the library is overwritten:
 *
 * - a tool the library does not have is added as it is;
 * - a tool the library has under the same id with the same CUTTING SHAPE is the
 *   library's own — its name and feeds are the user's, and win;
 * - a tool whose id is taken by a DIFFERENT shape (their `default-1` was re-sized to a
 *   1/8" bit) is added under a fresh id, and the operations are pointed at it. Using the
 *   library's tool there would cut every one of those toolpaths with the wrong bit.
 *
 * A tool the file names but does not carry is left as a dangling id, as before: the
 * operation then reports its tool as missing rather than borrowing some other one.
 */
export function mergeProjectTools(
  library: Tool[], fileTools: Tool[], operations: AnyOperation[],
): { tools: Tool[]; operations: AnyOperation[]; added: number; renamed: number } {
  const used = new Set(operations.flatMap(toolIdsOf))
  const mine = new Map(library.map((t) => [t.id, t]))
  const remap = new Map<string, string>()
  const addedTools: Tool[] = []
  let renamed = 0
  for (const t of fileTools) {
    if (!used.has(t.id) || remap.has(t.id)) continue
    const have = mine.get(t.id)
    if (!have) { addedTools.push(t); mine.set(t.id, t); continue }
    if (sameCut(have, t)) continue
    const id = uid('tool')
    remap.set(t.id, id)
    addedTools.push({ ...t, id })
    renamed++
  }
  return {
    tools: addedTools.length > 0 ? [...library, ...addedTools] : library,
    operations: remap.size > 0 ? operations.map((op) => remapToolIds(op, remap)) : operations,
    added: addedTools.length,
    renamed,
  }
}

/**
 * Whether two tools cut the same shape. What a toolpath is computed from — the type,
 * the diameter, the cone angle of a V-bit or taper, and a taper's length (it sets how
 * wide the taper opens out: `maxCutRadiusMM`). Name, flutes, rpm and feeds are how the
 * user RUNS the tool, and are theirs to keep.
 */
export function sameCut(a: Tool, b: Tool): boolean {
  if (a.type !== b.type || a.diameterMM !== b.diameterMM) return false
  if ((a.type === 'vbit' || a.type === 'taper') && a.vbitAngleDeg !== b.vbitAngleDeg) return false
  if (a.type === 'taper' && a.maxDepthMM !== b.maxDepthMM) return false
  return true
}

// The same rule `mergeWithDefaults` re-validates form state by: `toolId`, or any field
// ending in `ToolId` (an inlay's pocket and V-bit tools, profile3d's roughing tool).
const isToolField = (key: string) => key === 'toolId' || key.endsWith('ToolId')

function toolIdsOf(op: AnyOperation): string[] {
  return Object.entries(op)
    .filter(([k, v]) => isToolField(k) && typeof v === 'string')
    .map(([, v]) => v as string)
}

function remapToolIds(op: AnyOperation, remap: Map<string, string>): AnyOperation {
  const out: Record<string, unknown> = { ...op }
  let changed = false
  for (const [k, v] of Object.entries(op)) {
    if (isToolField(k) && typeof v === 'string' && remap.has(v)) { out[k] = remap.get(v); changed = true }
  }
  // A saved toolpath names its tool change by id too; left alone, the G-code would
  // announce the library's tool while cutting with the file's.
  if (op.segments?.some((s) => s.toolChange && remap.has(s.toolChange))) {
    out.segments = op.segments.map((s) =>
      s.toolChange && remap.has(s.toolChange) ? { ...s, toolChange: remap.get(s.toolChange) } : s)
    changed = true
  }
  return changed ? out as unknown as AnyOperation : op
}
