// What each source of an Offset becomes under the form's settings — a generated shape
// with new parameters, or an outline — kept apart from the form so the rules can be tested.

import type { ImportedPath } from '../importers/svgImporter'
import type { ShapeParams } from '../shapes/shapeGenerators'
import type { TransformStep } from '../canvas/selectionUtils'
import { applyOffset, type OffsetCornerStyle } from './offsetOp'
import { applyScaleOffset } from './scaleOffset'
import { offsetGeneratedShape } from './shapeOffset'

export interface OffsetFormState {
  distanceMM: number
  cornerStyle: OffsetCornerStyle
  /** Scale to a mean gap instead of offsetting exactly — keeps the shape, not the gap. */
  keepShape: boolean
  /** A generated shape stays that shape, with new parameters (tools/shapeOffset). */
  keepGenerated: boolean
}

/** One source's result under the form's settings: the outline, or why there is none. */
export function offsetResult(d: string, form: OffsetFormState): string | null {
  if (form.keepShape) return applyScaleOffset(d, form.distanceMM)?.d ?? null
  return applyOffset(d, { distanceMM: form.distanceMM, cornerStyle: form.cornerStyle }) || null
}

/** What one source becomes. A generated shape that stays itself carries its new
 *  parameters and its placement (its `d` went back out through that placement);
 *  everything else is a plain outline, with neither. */
export interface OffsetPlan {
  kind: 'exact' | 'near' | 'scaled' | 'outline'
  d: string
  shapeParams?: ShapeParams
  placement?: TransformStep[]
  fromCenter?: boolean
  minGapMM?: number
  maxGapMM?: number
}

export function planOffset(src: ImportedPath, form: OffsetFormState): OffsetPlan | null {
  if (form.keepGenerated && src.shapeParams) {
    const r = offsetGeneratedShape(src, form.distanceMM)
    if (r.kind === 'none') return null
    if (r.kind !== 'outline') {
      return {
        ...r, placement: src.placement, fromCenter: src.fromCenter,
        ...(r.kind === 'scaled' ? { minGapMM: r.minGapMM, maxGapMM: r.maxGapMM } : {}),
      }
    }
  }
  // Keep shape is for plain outlines only. A shape that can stay itself has Keep generated
  // shapes, which does the same scaling where scaling is the answer and keeps the
  // parameters; any other generator (a gear's teeth) gets nothing sensible from being
  // scaled to an average gap, so it takes the ordinary offset.
  const d = offsetResult(src.d, src.shapeParams ? { ...form, keepShape: false } : form)
  return d ? { kind: 'outline', d } : null
}

/** The path fields a plan sets — and clears, so a reworked result that drops back to an
 *  outline does not keep parameters that no longer describe it. */
export const planFields = (plan: OffsetPlan) => ({
  shapeParams: plan.shapeParams, placement: plan.placement, fromCenter: plan.fromCenter,
})
