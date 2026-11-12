// STRIPS FOLLOW THEIR PARTS. A bridge set is lines on the stock, so a part moved after its
// strips were placed left them standing where it had been. `applyPathEdit` — the one door
// every gesture that moves geometry comes through — asks this for the strips' new places and
// writes them in the SAME edit, so one undo takes back the move and the strips together (the
// workpiece is in the snapshot). Undo, redo and loading never come through here: they put
// back a state whose strips already agree with its parts.
//
// Each strip on a changed part is re-fitted by `refitStrip` (cam/bridgePick); strips on
// parts that did not change are left exactly as they are, hand-placed or not.
import type { ImportedPath } from '../importers/svgImporter'
import { useToolpathStore } from '../store/toolpathStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { BridgeSet, BridgeLine } from '../cam/bridges'
import { buildHoldIndex, refitStrip } from '../cam/bridgePick'
import { holdableParts, holdableHoles, cutterRadiusFor } from './bridgeParts'

const drawn = (ps: ImportedPath[]) => ps.filter((p) => p.visible && !p.hidden && !p.imageSrc && !p.stlSrc)

/**
 * The strips after an edit from `before` to `after`: the new set (null when the last strip
 * went) and the parts whose cuts the change reaches — or null when no strip's part changed.
 */
export function refitBridges(before: ImportedPath[], after: ImportedPath[]): { set: BridgeSet | null; touched: string[] } | null {
  const wp = useWorkpieceStore.getState()
  const bridges = wp.bridges
  if (!bridges || bridges.lines.length === 0) return null
  const now = new Map(after.map((p) => [p.id, p]))
  const changed = new Set(before.filter((p) => now.get(p.id)?.d !== p.d).map((p) => p.id))
  if (!bridges.pathIds.some((id) => changed.has(id))) return null
  const ops = useToolpathStore.getState().operations
  const stock = { widthMM: wp.widthMM, heightMM: wp.heightMM }
  const indexOf = (ps: ImportedPath[]) => {
    const parts = holdableParts(ps, ops, wp.thicknessMM, bridges.heightMM)
    return buildHoldIndex(parts, stock, holdableHoles(ps, parts, ops, wp.thicknessMM, bridges.heightMM))
  }
  const oldIx = indexOf(drawn(before)), newIx = indexOf(drawn(after))
  const toolRadiusMM = cutterRadiusFor(bridges.pathIds)
  const lines: BridgeLine[] = []
  const touched = new Set<string>()
  let moved = false
  for (const l of bridges.lines) {
    const r = refitStrip(oldIx, newIx, l, changed, { widthMM: bridges.widthMM, toolRadiusMM })
    if (r === 'keep') { lines.push(l); continue }
    moved = true
    r.ends.forEach((id) => touched.add(id))
    if (r.line) lines.push(l.manual ? { ...r.line, manual: true } : r.line)
  }
  if (!moved) return null
  const ids = new Set(after.map((p) => p.id))
  // A strip re-laid onto a NEW neighbour makes that part one of the set's: without its id
  // here the first check above would not see it move, and the strip would be left behind.
  const pathIds = [...new Set([...bridges.pathIds, ...touched])].filter((id) => ids.has(id))
  return {
    set: lines.length > 0 ? { ...bridges, lines, pathIds } : null,
    touched: [...touched],
  }
}
