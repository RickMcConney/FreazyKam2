// Offsetting a GENERATED shape into the same kind of shape with new parameters.
//
// A circle offset is a circle; a rectangle offset with sharp corners is a rectangle
// 2d wider and taller. Offsetting the OUTLINE throws that away — the result is a dead
// path — and on some shapes it also gives something nobody would call the shape: a
// Sign's coves vanish once the offset passes their radius, leaving steps, bumps or
// chamfers depending on the corner style. So a generated shape is offset in its
// PARAMETERS, and the result is that shape again, still editable in its panel.
//
// Four outcomes, and the form reports which each source got:
//   exact   the new parameters ARE the exact offset (miter corners): rectangle, circle,
//           polygon, star, slot.
//   near    the straight edges are exact and the rest follows the shape's own rule.
//           A rounded rect's and a Sign's corners take radius r + (√2 − 1)·d. The exact
//           offset of a rounded corner is r + d, and on a Sign that made the coves look
//           as if they were growing too fast — each new cove ending square to the old
//           one; (√2 − 1)·d grows them at about half that rate, and the user picked it
//           over keeping r. An ellipse takes rx + d, ry + d (the true offset of an
//           ellipse is not an ellipse).
//   scaled  no parameter offsets exactly (heart, shield): the
//           shape is SCALED until the mean gap is the distance, the way Keep shape does
//           an outline, and its parameters are scaled with it (scaleShapeParams).
//   outline every other generator (OFFSETTABLE_SHAPES), and a shape that cannot stay
//           itself: a multi-part piece (its parameters belong to the group), one whose corners
//           were re-cut, a placement that stretches or skews. The caller offsets the
//           outline the ordinary way.
//
// A placement (rotate, mirror, uniform scale, move) is kept: the parameters are a
// DEFINITION, so the offset is worked out in definition space — divided by the
// placement's scale — and the result is put back through the same placement.

import type { ImportedPath } from '../importers/svgImporter'
import { generateShapeD, scaleShapeParams, type ShapeParams } from '../shapes/shapeGenerators'
import { applyPlacementD, placementMat } from '../canvas/selectionUtils'
import { applyScaleOffset } from './scaleOffset'

export type ShapeOffsetResult =
  | { kind: 'exact' | 'near'; shapeParams: ShapeParams; d: string }
  | { kind: 'scaled'; shapeParams: ShapeParams; d: string; minGapMM: number; maxGapMM: number }
  | { kind: 'outline' }
  /** It stays itself, but an inset this deep leaves nothing of it. */
  | { kind: 'none' }

/** The shapes offered this at all — the plain outlines a border or an inset is drawn
 *  around. The rest (gears, mazes, boards, text, …) are too specific for "the same shape,
 *  a bit bigger" to mean anything, so they are offset as outlines. */
export const OFFSETTABLE_SHAPES = new Set<ShapeParams['type']>([
  'rectangle', 'roundrect', 'inroundrect', 'circle', 'ellipse', 'polygon', 'star', 'heart', 'slot', 'shield',
])

/** Rectangle, circle, polygon, star, slot: exact. Rounded rect, Sign, ellipse: near. */
const NEAR_TYPES = new Set<ShapeParams['type']>(['roundrect', 'inroundrect', 'ellipse'])

/** How fast a rounded rect's or a Sign's corner radius follows the offset — see the header. */
export const CORNER_GROWTH = Math.SQRT2 - 1

/**
 * The parameters offset by `d` mm (positive out), for the shapes whose offset is
 * itself — undefined for any other type, null when an inset leaves nothing.
 */
export function offsetShapeParams(p: ShapeParams, d: number): ShapeParams | null | undefined {
  switch (p.type) {
    case 'rectangle': {
      const w = p.w + 2 * d, h = p.h + 2 * d
      return w > 0 && h > 0 ? { ...p, x: p.x - d, y: p.y - d, w, h } : null
    }
    case 'roundrect':
    case 'inroundrect': {
      const w = p.w + 2 * d, h = p.h + 2 * d
      return w > 0 && h > 0 ? { ...p, x: p.x - d, y: p.y - d, w, h, r: Math.max(0, p.r + CORNER_GROWTH * d) } : null
    }
    case 'circle': {
      const radius = p.radius + d
      return radius > 0 ? { ...p, radius } : null
    }
    case 'ellipse': {
      const rx = p.rx + d, ry = p.ry + d
      return rx > 0 && ry > 0 ? { ...p, rx, ry } : null
    }
    case 'polygon': {
      // Each side moves out d along its normal, so the apothem grows by d and the
      // circumradius by d / cos(π/n).
      const radius = p.radius + d / Math.cos(Math.PI / p.sides)
      return radius > 0 ? { ...p, radius } : null
    }
    case 'star': {
      // Every edge runs from a tip to a valley and moves out d along its normal; by
      // symmetry the new tip and valley stay on their own rays, so each new radius is
      // where that ray meets the moved edge. (Same angles as generateShapeD.)
      const n = p.points
      const a0 = -Math.PI / 2, a1 = -Math.PI / 2 + Math.PI / n
      const T = [p.outerRadius * Math.cos(a0), p.outerRadius * Math.sin(a0)]
      const V = [p.innerRadius * Math.cos(a1), p.innerRadius * Math.sin(a1)]
      // The star is traced CCW, so the outward normal of T→V is (dy, −dx).
      const ex = V[0] - T[0], ey = V[1] - T[1], len = Math.hypot(ex, ey)
      if (len < 1e-9) return null
      const nx = ey / len, ny = -ex / len
      const c = nx * T[0] + ny * T[1] + d
      const k0 = nx * Math.cos(a0) + ny * Math.sin(a0)
      const k1 = nx * Math.cos(a1) + ny * Math.sin(a1)
      if (k0 <= 1e-9 || k1 <= 1e-9) return null
      const outerRadius = c / k0, innerRadius = c / k1
      return outerRadius > 0 && innerRadius > 0 ? { ...p, outerRadius, innerRadius } : null
    }
    case 'slot': {
      // `length` is end to end, so adding 2d keeps the straight run and grows the caps.
      const width = p.width + 2 * d, length = p.length + 2 * d
      return width > 0 ? { ...p, width, length } : null
    }
    default:
      return undefined
  }
}

/** The uniform scale a placement applies, or null if it stretches or skews. */
function placementScale(path: ImportedPath): number | null {
  if (!path.placement?.length) return 1
  const [a, b, c, d] = placementMat(path.placement)
  const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  const turn = Math.abs(a - d) <= tol && Math.abs(b + c) <= tol    // rotate × scale
  const mirror = Math.abs(a + d) <= tol && Math.abs(b - c) <= tol  // … and a flip
  if (!turn && !mirror) return null
  const s = Math.hypot(a, b)
  return s > 1e-12 ? s : null
}

/** `path` offset by `distanceMM` as the shape it was generated as — see the header. */
export function offsetGeneratedShape(path: ImportedPath, distanceMM: number): ShapeOffsetResult {
  const p = path.shapeParams
  if (!p || !OFFSETTABLE_SHAPES.has(p.type) || path.shapePart || path.corners) return { kind: 'outline' }
  const s = placementScale(path)
  if (s === null) return { kind: 'outline' }
  const dd = distanceMM / s
  const place = (np: ShapeParams) => applyPlacementD(generateShapeD(np), path.placement)

  const exact = offsetShapeParams(p, dd)
  if (exact === null) return { kind: 'none' }
  if (exact) return { kind: NEAR_TYPES.has(p.type) ? 'near' : 'exact', shapeParams: exact, d: place(exact) }

  // Scaled about the area centroid of the definition outline, the same solve Keep shape
  // runs on an outline, then the parameters scaled about that same point.
  const fit = applyScaleOffset(generateShapeD(p), dd)
  if (!fit) return { kind: 'none' }
  const scaled = scaleShapeParams(p, fit.cx, fit.cy, fit.scale, fit.scale)
  if (!scaled) return { kind: 'outline' }
  return { kind: 'scaled', shapeParams: scaled, d: place(scaled), minGapMM: fit.minGapMM * s, maxGapMM: fit.maxGapMM * s }
}
