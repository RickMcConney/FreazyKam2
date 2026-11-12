// Which paths a bridge set joins and which cuts it changes — pure reads of the stores, kept
// apart from bridgesRun (which pulls in the regenerator) so pathsStore can refit strips
// inside an edit without an import cycle at load (see bridgeRefit).
import { useToolpathStore, pathIdsOf, type AnyOperation } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { maxCutRadiusMM, interiorPoint } from '../cam/geom'
import type { ImportedPath } from '../store/pathsStore'
import { isOpenPath, flattenCached, insideCompound } from '../panels/machine/containment'
import { outermostPaths } from '../panels/machine/selectionKinds'

/** The operations a bridge can change: every profile and trochoidal — inside ones too, which
 *  a strip into a hole's slug holds (cam/bridges planSlugStrips). */
export function bridgedOps(ops: readonly AnyOperation[]): AnyOperation[] {
  return ops.filter((op) => op.type === 'profile' || op.type === 'trochoidal')
}

/**
 * Of `paths`, the PARTS a strip may join. Read off the GEOMETRY, so strips can be placed
 * before the parts are profiled, as tabs can — the strips only take effect on a cut that
 * goes through the stock, which is decided when each cut is generated (opJob), so placing
 * them first changes nothing about the result:
 *
 *   - a CLOSED outline that no other closed outline in `paths` contains (`outermostPaths`):
 *     a drag box over a sheet catches its labels and holes too, and joining those put two
 *     joins on every stroke and every hole, each running out to its own part's edge — dozens
 *     of tabs on a part that needed two. Holes and lettering sit inside their part; a
 *     single-stroke label is open.
 *   - but not one already profiled ONLY too shallow to reach a strip's top (`holdHeightMM`
 *     off the stock's bottom) — an engraved outline, which frees nothing;
 *   - and always one some cut already takes down past that top — through the stock, or to
 *     an onion skin — even nested in another part's hole: the rule this replaced,
 *     which required every part to be profiled before it could be held.
 */
export function holdableParts<P extends ImportedPath>(paths: P[], ops: readonly AnyOperation[], thicknessMM: number, holdHeightMM: number): P[] {
  const through = new Set<string>(), shallow = new Set<string>()
  for (const op of bridgedOps(ops).filter((o) => 'side' in o && o.side !== 'inside')) {
    // Deep enough to reach a strip's top (the stock's bottom + its height, `holdTopZ`): an
    // onion skin is held as well as a cut right through.
    const deep = 'depthMM' in op && (op as { depthMM: number }).depthMM > thicknessMM - holdHeightMM + 1e-6
    for (const id of pathIdsOf(op)) (deep ? through : shallow).add(id)
  }
  const closed = paths.filter((p) => !isOpenPath(p) && (through.has(p.id) || !shallow.has(p.id)))
  const outer = new Set(outermostPaths(closed).outer.map((p) => p.id))
  return paths.filter((p) => through.has(p.id) || outer.has(p.id))
}

/**
 * Of `paths`, the HOLES whose slug a strip may hold (cam/bridges planSlugStrips): a closed
 * outline inside one of `parts`, and either
 *   - cut on the INSIDE deep enough to reach a strip's top (through, or to an onion skin), or
 *   - not cut by anything yet — read off the geometry, as a part is, so strips can be placed
 *     before the holes are profiled.
 * Not one only engraved (a letter's counter, a shallow outline), nor a drilled hole (a drill
 * frees no slug); planSlugStrips skips any too small to matter.
 */
export function holdableHoles<P extends ImportedPath>(paths: P[], parts: ImportedPath[], ops: readonly AnyOperation[], thicknessMM: number, holdHeightMM: number): P[] {
  const deepInside = new Set<string>(), cut = new Set<string>()
  for (const op of ops) {
    for (const id of pathIdsOf(op)) cut.add(id)
    if ((op.type === 'profile' || op.type === 'trochoidal') && op.side === 'inside'
      && op.depthMM > thicknessMM - holdHeightMM + 1e-6) for (const id of pathIdsOf(op)) deepInside.add(id)
  }
  const partIds = new Set(parts.map((p) => p.id))
  const candidates = paths.filter((p) => !partIds.has(p.id) && !isOpenPath(p) && (deepInside.has(p.id) || !cut.has(p.id)))
  if (candidates.length === 0 || parts.length === 0) return []
  // Inside a part: an interior point of the hole in the part (never a centroid — see geom).
  return candidates.filter((h) => {
    const at = interiorPoint(flattenCached(h))
    return !!at && parts.some((p) => insideCompound(at[0], at[1], flattenCached(p)))
  })
}

/** The cutter's reach round `partIds`: the widest one cutting round them (1/8" when nothing
 *  cuts them yet) — how far a strip's lift reaches along their cuts. */
export function cutterRadiusFor(partIds: string[]): number {
  const ids = new Set(partIds)
  const tools = useToolStore.getState().tools
  const radii = bridgedOps(useToolpathStore.getState().operations)
    .filter((op) => pathIdsOf(op).some((id) => ids.has(id)))
    .map((op) => { const t = tools.find((x) => x.id === op.toolId); return t ? maxCutRadiusMM(t) : 0 })
  return radii.length > 0 ? Math.max(...radii) : 3.175 / 2
}

