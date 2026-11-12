// WHICH TABS AND STRIPS ARE WORTH DRAWING. A tab or strip is a note on a CUT: with the part
// hidden, or every profile of it hidden from the program, it holds nothing that will be cut
// and is left on the canvas standing beside nothing. So:
//
//   - a part is OUT when its path is off the canvas, or it has profiles/trochoidals and every
//     one of them is hidden (a part not profiled yet is not out — tabs may come first);
//   - a tab is drawn unless its part is out;
//   - a strip is drawn unless EVERY part it touches is out — a strip from a hidden part to
//     one still being cut is still lifted over by that cut. The sheet's edge is not a part.
import { useToolpathStore, pathIdsOf, type AnyOperation } from '../store/toolpathStore'
import type { ImportedPath } from '../store/pathsStore'
import type { BridgeLine } from '../cam/bridges'
import { stripEnds, type HoldIndex } from '../cam/bridgePick'

/** The paths whose every profile and trochoidal is hidden from the program. */
export function cutHiddenPathIds(ops: readonly AnyOperation[]): string[] {
  const shown = new Set<string>(), hidden = new Set<string>()
  for (const op of ops) {
    if (op.type !== 'profile' && op.type !== 'trochoidal') continue
    for (const id of pathIdsOf(op)) (op.visible ? shown : hidden).add(id)
  }
  return [...hidden].filter((id) => !shown.has(id)).sort()
}

/**
 * The same, as one string: a stable value for a selector, so a layer re-renders when a
 * toolpath is hidden or shown and not on every toolpath that lands during a Generate.
 */
export function useCutHiddenKey(): string {
  return useToolpathStore((s) => cutHiddenPathIds(s.operations).join('|'))
}

/** The ids of the parts that are out (see the header), among `paths`. */
export function partsOut(paths: readonly ImportedPath[], cutHiddenKey: string): Set<string> {
  const out = new Set(cutHiddenKey ? cutHiddenKey.split('|') : [])
  for (const p of paths) if (!p.visible || p.hidden) out.add(p.id)
  return out
}

/** Whether each strip is drawn. `index` must hold the hidden parts too (`holdIndexNow(true)`). */
export function stripsShown(lines: readonly BridgeLine[], index: HoldIndex, out: ReadonlySet<string>): boolean[] {
  return lines.map((l) => {
    const ends = stripEnds(index, l)
    // On no part the index knows: nothing to judge it by, so it stays.
    if (!ends) return true
    const ids = [ends.a, ...(ends.b === 'frame' ? [] : [ends.b])]
    return !ids.every((id) => out.has(id))
  })
}
