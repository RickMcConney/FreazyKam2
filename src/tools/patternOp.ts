// Pattern tools: linear grid and circular array.
// Each returns a list of (d, dx, dy, angleDeg) transforms to apply to source paths.

import { getMultiBBox, type TransformStep, type BBox } from '../canvas/selectionUtils'
import type { ImportedPath } from '../importers/svgImporter'
import { copyPathsUnderSteps, type PathCopy } from './pathCopy'

interface LinearPatternParams {
  type: 'linear'
  rows: number
  cols: number
  xSpacingMM: number
  ySpacingMM: number
}

interface CircularPatternParams {
  type: 'circular'
  count: number
  radiusMM: number
  startAngleDeg: number
  endAngleDeg: number  // if == startAngleDeg + 360, full circle
  rotateItems: boolean // whether each item is rotated to face outward
}

export type PatternParams = LinearPatternParams | CircularPatternParams

export interface PatternInstance {
  dx: number
  dy: number
  angleDeg: number  // extra rotation (0 for linear, tangent for circular if rotateItems)
  row?: number
  col?: number
  index?: number
}

// Returns transforms for all pattern instances (including the original at [0]).
// Caller is responsible for applying them to each source path.
export function computePatternInstances(params: PatternParams): PatternInstance[] {
  if (params.type === 'linear') {
    const instances: PatternInstance[] = []
    for (let row = 0; row < params.rows; row++) {
      for (let col = 0; col < params.cols; col++) {
        instances.push({
          dx: col * params.xSpacingMM,
          dy: row * params.ySpacingMM,
          angleDeg: 0,
          row,
          col,
        })
      }
    }
    return instances
  } else {
    // Circular pattern
    const { count, radiusMM, startAngleDeg, endAngleDeg, rotateItems } = params
    if (count <= 0) return []
    const isFullCircle = Math.abs((endAngleDeg - startAngleDeg) % 360) < 0.01 || count === 1
    const instances: PatternInstance[] = []
    const totalAngle = isFullCircle ? 360 : (endAngleDeg - startAngleDeg)
    const step = count > 1 ? totalAngle / count : 0

    for (let i = 0; i < count; i++) {
      const angleDeg = startAngleDeg + i * step
      const rad = angleDeg * Math.PI / 180
      const dx = radiusMM * Math.cos(rad)
      const dy = radiusMM * Math.sin(rad)
      instances.push({
        dx,
        dy,
        angleDeg: rotateItems ? angleDeg : 0,
        index: i,
      })
    }
    return instances
  }
}


// ─── Copies that are still the shapes they were copied from ───────────────────

/**
 * The transform ONE pattern instance applies, as a step recipe rather than as
 * baked geometry — which is what lets a copy keep its shape parameters and its
 * placement (see copyPathsUnderSteps).
 *
 * The rotation pivot is the bounding box of the WHOLE selection, not of each
 * path in turn. Per-path pivots were what the baked version used, and for a
 * single path the two agree; for an assembly they do not, and turning each part
 * about its own middle takes the assembly apart.
 */
export function patternInstanceSteps(inst: PatternInstance, bbox: BBox | null): TransformStep[] {
  const steps: TransformStep[] = [{ kind: 'translate', dx: inst.dx, dy: inst.dy }]
  if (inst.angleDeg !== 0 && bbox) {
    steps.push({ kind: 'rotate', cx: bbox.cx + inst.dx, cy: bbox.cy + inst.dy, angle: inst.angleDeg })
  }
  return steps
}

/**
 * Build the copies for a pattern: every instance × every source path.
 *
 * Ordered instance-major so a whole instance is contiguous, which is what lets
 * the edit path reuse result ids by index.
 */
export function patternCopies(sources: ImportedPath[], instances: PatternInstance[]): PathCopy[] {
  const bbox = getMultiBBox(sources.map((s) => s.d))
  return instances.flatMap((inst) => copyPathsUnderSteps(
    sources,
    patternInstanceSteps(inst, bbox),
    inst.index !== undefined ? `${inst.index + 1}` : `r${inst.row}c${inst.col}`,
  ))
}
