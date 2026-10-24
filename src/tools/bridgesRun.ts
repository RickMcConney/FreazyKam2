// Writing the sheet's BRIDGES (cam/bridges) and rebuilding the cuts they change.
//
// One recorded step — the workpiece setting — and the regeneration after it, which writes
// only derived state and so lands in that step's snapshot: one undo takes the bridges back
// and the toolpaths the step rebuilt with them.
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolpathStore, pathIdsOf, type AnyOperation } from '../store/toolpathStore'
import { regenerateMany } from '../cam/regenerate'
import { placeBridges, type BridgeSet } from '../cam/bridges'
import { useToolStore } from '../store/toolStore'
import { maxCutRadiusMM } from '../cam/geom'

/** The operations a bridge can change: every cut round an outline that is not an inside one. */
export function bridgedOps(ops: readonly AnyOperation[]): AnyOperation[] {
  return ops.filter((op) => (op.type === 'profile' || op.type === 'trochoidal') && op.side !== 'inside')
}

/**
 * Of `paths`, the PARTS — the ones some cut sets free: an outside or centerline cut, through
 * the stock. A drag box over a sheet catches its labels and holes as well, and joining those
 * put two joins on every stroke and every hole, each running out to its own part's edge and
 * leaving a tab there: dozens on a part that needed two, and a part's count met by joins to
 * its own labels that held it to nothing.
 */
export function freedParts<P extends { id: string }>(paths: P[], ops: readonly AnyOperation[], thicknessMM: number): P[] {
  const freed = new Set(bridgedOps(ops)
    .filter((op) => 'depthMM' in op && (op as { depthMM: number }).depthMM >= thicknessMM - 1e-6)
    .flatMap((op) => pathIdsOf(op)))
  return paths.filter((p) => freed.has(p.id))
}

/** A network of bridges joining the parts among `paths` (`freedParts`) — `count` joins to
 *  each — replacing any the sheet had. Returns the set, or null when there was nothing to join. */
export function applyBridges(paths: { id: string; d: string }[], widthMM: number, heightMM: number, count: number): BridgeSet | null {
  const wp = useWorkpieceStore.getState()
  const parts = freedParts(paths, useToolpathStore.getState().operations, wp.thicknessMM)
  if (parts.length === 0) return null
  // The cutter's reach: the widest one cutting round these parts (1/8" when nothing cuts
  // them yet).
  const ids = new Set(parts.map((p) => p.id))
  const tools = useToolStore.getState().tools
  const radii = bridgedOps(useToolpathStore.getState().operations)
    .filter((op) => pathIdsOf(op).some((id) => ids.has(id)))
    .map((op) => { const t = tools.find((x) => x.id === op.toolId); return t ? maxCutRadiusMM(t) : 0 })
  const toolRadiusMM = radii.length > 0 ? Math.max(...radii) : 3.175 / 2
  const lines = placeBridges(parts, wp, { count, widthMM, toolRadiusMM })
  if (lines.length === 0) return null
  const set: BridgeSet = { lines, widthMM, heightMM, pathIds: parts.map((p) => p.id) }
  wp.setBridges(set)
  regenerateMany(bridgedOps(useToolpathStore.getState().operations))
  return set
}

export function removeBridges(): void {
  const wp = useWorkpieceStore.getState()
  if (!wp.bridges) return
  wp.setBridges(null)
  regenerateMany(bridgedOps(useToolpathStore.getState().operations))
}
