// Pattern tools: linear grid and circular array.
// Each returns a list of (d, dx, dy, angleDeg) transforms to apply to source paths.

import { getMultiBBox, type TransformStep, type BBox } from '../canvas/selectionUtils'
import type { ImportedPath } from '../importers/svgImporter'
import { copyPathsUnderSteps, type PathCopy } from './pathCopy'

/**
 * A grid of copies. The gaps are the clear space BETWEEN copies, measured from the
 * selection's bounding box: each column starts `xGapMM` past the right edge of the one
 * before it, each row `yGapMM` below the bottom of the one above. A gap of 0 makes the
 * boxes touch.
 *
 * Patterns made before that stored a centre-to-centre pitch (`xSpacingMM`/`ySpacingMM`)
 * with rows going UP. Those are still read the old way, so a saved project's pattern
 * means what it did; the form converts one to gaps when it is reopened.
 */
interface LinearPatternParams {
  type: 'linear'
  rows: number
  cols: number
  xGapMM?: number
  yGapMM?: number
  /** Legacy pitch, rows upward — see above. */
  xSpacingMM?: number
  ySpacingMM?: number
}

/** True for a linear pattern saved before gaps: a pitch, rows going up. */
export function isLegacyLinear(p: PatternParams): boolean {
  return p.type === 'linear' && p.xGapMM === undefined && p.xSpacingMM !== undefined
}

interface CircularPatternParams {
  type: 'circular'
  count: number
  radiusMM: number
  startAngleDeg: number
  endAngleDeg: number  // if == startAngleDeg + 360, full circle
  rotateItems: boolean // whether each copy turns with the pattern, or only moves round it
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

// Returns transforms for all pattern instances, the original included at [0] — so the
// caller makes copies of [1…].
// Caller is responsible for applying them to each source path. `bbox` is the
// selection's — a linear pattern's gaps are measured from it.
export function computePatternInstances(params: PatternParams, bbox: BBox | null = null): PatternInstance[] {
  if (params.type === 'linear') {
    const legacy = isLegacyLinear(params)
    const pitchX = legacy ? params.xSpacingMM! : (bbox?.width ?? 0) + (params.xGapMM ?? 0)
    const pitchY = legacy ? params.ySpacingMM ?? 0 : -((bbox?.height ?? 0) + (params.yGapMM ?? 0))
    const instances: PatternInstance[] = []
    for (let row = 0; row < params.rows; row++) {
      for (let col = 0; col < params.cols; col++) {
        instances.push({
          dx: col * pitchX,
          dy: row * pitchY || 0,   // not -0: row 0 times a downward pitch
          angleDeg: 0,
          row,
          col,
        })
      }
    }
    return instances
  } else {
    // Circular pattern. The ORIGINAL is item 0, at 0°: the centre of the circle is `radiusMM`
    // to the LEFT of the selection's centre, and copy i is the original turned i steps about
    // it. Turning about that pivot carries the selection's centre to
    // pivot + r(cos θ, sin θ), i.e. a move of r(cos θ − 1, sin θ) — then, when the items
    // rotate, a turn by θ about the moved centre (patternInstanceSteps), which
    // together are exactly the rigid rotation about the pivot. A NEGATIVE radius puts the
    // pivot to the RIGHT of the selection instead; the same formula holds, and 0 turns the
    // copies in place. A full circle spaces the
    // `count` items evenly; an arc spreads them from Start to End, the last one ON End.
    const { count, radiusMM, startAngleDeg, endAngleDeg, rotateItems } = params
    if (count <= 0) return []
    const isFullCircle = Math.abs((endAngleDeg - startAngleDeg) % 360) < 0.01 || count === 1
    const instances: PatternInstance[] = []
    const step = count <= 1 ? 0
      : isFullCircle ? 360 / count
      : (endAngleDeg - startAngleDeg) / (count - 1)

    for (let i = 0; i < count; i++) {
      const angleDeg = i * step
      const rad = angleDeg * Math.PI / 180
      instances.push({
        dx: radiusMM * (Math.cos(rad) - 1) || 0,
        dy: radiusMM * Math.sin(rad) || 0,
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
