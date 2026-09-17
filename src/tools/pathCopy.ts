// Copying an OBJECT — a shape, a group, an assembly — under a transform.
//
// Shared by the pattern tool and by the nest's fill-the-stock pass, because the
// hard part is the same for both and it is not the geometry: a copy has to come
// out as the same KIND of thing its source was. See PathCopy for what that
// means and what it cost when the copies were geometry alone.

import {
  applyTransformStep, foldPlacement, isPlacementOnly, type TransformStep,
} from '../canvas/selectionUtils'
import type { ImportedPath } from '../importers/svgImporter'
import { uid } from '../uid'

/**
 * Everything a copy inherits from its source, bar its own id and whatever
 * `definition` the tool making it stamps on.
 *
 * PATTERN COPIES USED TO BE `{ name, d, visible, color }` AND NOTHING ELSE,
 * which made every one of them a loose outline. It shows up first in nesting: a
 * train track is a MULTI-PART shape — body, grooves, treads, all carrying one
 * `shapeParams` and tied together by a shared `groupId` — and a pattern of six
 * tracks arrived as thirty-odd unrelated paths, so the nest treated each groove
 * as a part in its own right and scattered a track's cuts across the stock. It
 * also cost the copies their parameters (a patterned gear would not reopen on
 * its module) and their user groups.
 */
export type PathCopy = Omit<ImportedPath, 'id' | 'definition'>

const stepsAppliedToD = (d: string, steps: TransformStep[]): string =>
  steps.reduce((acc, step) => applyTransformStep({ d: acc }, step).d, d)

/**
 * One copy of `sources`, moved by `steps`.
 *
 * The transform arrives as a step RECIPE rather than as baked geometry, which is
 * what lets the copy keep its shape parameters and its placement — see
 * applyTransformStep and the three-way choice below.
 *
 * The copy gets its OWN identity: a fresh `groupId`, a fresh chain of
 * `userGroups`, a fresh `clockId`, for the reason `duplicateSelected` gives —
 * copies of a group are their own group, or copying one grew the thing being
 * copied. The remap is keyed by the OLD id, so paths that shared a group in the
 * source share one in the copy and paths that did not still do not.
 */
export function copyPathsUnderSteps(
  sources: ImportedPath[],
  steps: TransformStep[],
  nameSuffix: string,
): PathCopy[] {
  const remap = new Map<string, string>()
  const remapped = (old: string | undefined, prefix: string): string | undefined => {
    if (!old) return undefined
    const found = remap.get(old)
    if (found) return found
    const made = uid(prefix)
    remap.set(old, made)
    return made
  }
  return sources.map((src) => {
    // The same three-way choice batchUpdatePaths makes for a live drag, and for
    // the same reason: parameters are never lost to a gesture. A rotation they
    // cannot absorb SPILLS into the placement recipe, and a multi-part shape
    // repositions through its placement always — its parts share one set of
    // parameters, so absorbing a move into them would move every part.
    let d = src.d
    let shapeParams = src.shapeParams
    let spilled = false
    for (const step of steps) {
      const r = applyTransformStep({ d, shapeParams, placement: src.placement }, step)
      if (r.shapeParams === null) spilled = true
      d = r.d
      shapeParams = r.shapeParams ?? undefined
    }
    const reposition = spilled
      || src.shapeParams === undefined
      || (isPlacementOnly(steps) && (src.shapePart !== undefined || (src.placement?.length ?? 0) > 0))
    return {
      name: `${src.name} ${nameSuffix}`,
      d,
      visible: true,
      color: src.color,
      shapeParams: reposition ? src.shapeParams : shapeParams,
      placement: reposition ? foldPlacement(src, steps) : src.placement,
      shapePart: src.shapePart,
      groupId: remapped(src.groupId, src.shapePart !== undefined ? 'shape-group' : 'group'),
      groupName: src.groupName,
      userGroups: src.userGroups?.map((g) => remapped(g, 'ugroup')!),
      clockId: remapped(src.clockId, 'clock'),
      clockPart: src.clockPart,
      clockSpec: src.clockSpec,
      fromCenter: src.fromCenter,
      // Radii ride through untouched: neither caller scales, so every corner is
      // still the corner it was, cut to the same radius, on a base outline that
      // has moved with the copy.
      corners: src.corners
        ? { baseD: stepsAppliedToD(src.corners.baseD, steps), treatments: src.corners.treatments }
        : undefined,
    }
  })
}
