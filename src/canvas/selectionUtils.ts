import { pathExtents } from '../cam/pathFlattener'
import { parseD, stringifyD, applyMat, type Mat6, type ImportedPath } from '../importers/svgImporter'
import { splitCompoundPath } from './nodeUtils'
import { generateShapeD, translateShapeParams, scaleShapeParams, shapeDisplayName, type ShapeParams } from '../shapes/shapeGenerators'
import type { PathEditGesture } from '../timeline/events'
import { outerGroupOf } from '../store/pathGroups'

// ─── Drag-box selection ───────────────────────────────────────────────────────
//
// A rubber band answers one of two questions and they are not the same one. On a
// crowded drawing "everything this box runs across" is what picks a row of parts
// out of a nest; "these things and nothing they overlap" is what picks one wheel
// out from under the arbor crossing it. CAD has settled which gesture means
// which and the hand remembers it: drawn RIGHTWARDS the box catches anything it
// TOUCHES, drawn back to the LEFT it catches only what lies wholly INSIDE.
//
// Read off x alone, not off the diagonal. Every drag then has an answer — a box
// dragged straight down or straight up has no second axis to ask — and it is the
// half of the gesture people actually remember.

/** Whether a drag box selects only what it wholly contains (drawn right to left). */
export function dragBoxEncloses(box: { sx: number; ex: number }): boolean {
  return box.ex < box.sx
}

/**
 * Drop from an expanded selection every user group with a part left outside.
 *
 * A group is ONE object — one chip, one row, one thing to drag — so "wholly
 * inside" is a question about the whole of it. `expandUserGroups` has to run
 * FIRST (a group half inside would otherwise come back as its enclosed parts,
 * which is not something the user can see or click), and this then takes back the
 * groups it should not have pulled in.
 *
 * `inside` is what the box actually caught. Anything not on the canvas is not in
 * the running either way, so a hidden member cannot hold its group out.
 */
export function wholeGroupsOnly(
  ids: string[],
  inside: ImportedPath[],
  paths: ImportedPath[],
): string[] {
  const caught = new Set(inside.map((p) => p.id))
  const partial = new Set<string>()
  for (const p of paths) {
    if (!p.visible || p.hidden) continue
    const g = outerGroupOf(p)
    if (g && !caught.has(p.id)) partial.add(g)
  }
  if (partial.size === 0) return ids
  const byId = new Map(paths.map((p) => [p.id, p]))
  return ids.filter((id) => {
    const p = byId.get(id)
    const g = p && outerGroupOf(p)
    return !(g && partial.has(g))
  })
}

export interface BBox {
  minX: number; minY: number; maxX: number; maxY: number
  width: number; height: number; cx: number; cy: number
}

// EXACT, NOT FLATTENED. This used to take the min/max of `flattenPath(d, 0.5)`, and a
// flattened curve stops subdividing once its control points are within the tolerance of the
// chord — so the extreme of a bulge could sit up to ~0.37 mm outside the box. Circles and
// axis-aligned shapes never showed it (their extremes are segment endpoints); a rotated
// ellipse, a glyph or a spline did, and every constraint anchored to a box corner, every
// Properties X/Y/W/H and every snap guide carried the error.
//
// Cached on the d string, which is what decides the answer (paths are replaced, never
// mutated): a selection's box is asked for on every render of the panels that show it.
// Entries are tuples and each call builds a fresh BBox, so no caller can corrupt the cache.
const BBOX_CACHE_MAX = 256
const bboxCache = new Map<string, [number, number, number, number] | null>()

export function getBBox(d: string): BBox | null {
  let ext = bboxCache.get(d)
  if (ext === undefined) {
    ext = pathExtents(d)
    if (bboxCache.size >= BBOX_CACHE_MAX) bboxCache.delete(bboxCache.keys().next().value!)
    bboxCache.set(d, ext)
  }
  if (!ext) return null
  const [minX, minY, maxX, maxY] = ext
  const width = maxX - minX, height = maxY - minY
  return { minX, minY, maxX, maxY, width, height, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

export function getMultiBBox(ds: string[]): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const d of ds) {
    const b = getBBox(d)
    if (!b) continue
    if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX
    if (b.minY < minY) minY = b.minY; if (b.maxY > maxY) maxY = b.maxY
  }
  if (!isFinite(minX)) return null
  const width = maxX - minX, height = maxY - minY
  return { minX, minY, maxX, maxY, width, height, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

/**
 * The same bounding box, measured in a frame turned `angleDeg` CCW.
 *
 * The box comes back IN THAT FRAME — a corner of it is a point in the turned
 * frame, and `rotatePointAbout(pt, {x:0,y:0}, angleDeg)` is what carries it back
 * out to the world. An axis-aligned box round a tilted part is not the part's
 * box: turn a rectangle 45° and the world-axis box grows by √2 with its corners
 * out in empty space, which is exactly what a constraint hung off a corner has
 * to avoid. Measured about the ORIGIN so the caller's inverse is the same
 * rotation about the origin and there is no pivot to agree on.
 *
 * Costs one extra parse/stringify per path over `getMultiBBox`, and only when
 * the part actually stands turned — a square part takes the same road it always
 * did, to the digit.
 */
export function getMultiBBoxAt(ds: string[], angleDeg: number): BBox | null {
  if (Math.abs(angleDeg) < 1e-9) return getMultiBBox(ds)
  return getMultiBBox(ds.map((d) => rotateAroundD(d, 0, 0, -angleDeg)))
}

/** Rotate a point `angleDeg` CCW about `pivot`. CNC Y-up, so CCW is positive. */
export function rotatePointAbout(
  p: { x: number; y: number },
  pivot: { x: number; y: number },
  angleDeg: number,
): { x: number; y: number } {
  if (Math.abs(angleDeg) < 1e-12) return p
  const r = angleDeg * Math.PI / 180
  const cos = Math.cos(r), sin = Math.sin(r)
  const dx = p.x - pivot.x, dy = p.y - pivot.y
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos }
}

/**
 * HOW FAR A PART STANDS TURNED, in degrees CCW, read off its placement.
 *
 * The angle of the transformed x-axis, which is exact over rotates, mirrors and
 * uniform scales and is the nearest honest single number over a skew or a
 * stretch. A path with no placement has no way to know and reads 0 — a rotation
 * baked into a polyline is unrecoverable from the polyline.
 *
 * Three callers now (the properties panel's Angle field, the nest's rotation
 * grid, and the frame a constraint measures in), which is one more than a
 * copied-out `atan2(b, a)` survives.
 */
export function placedAngleDeg(steps: TransformStep[] | undefined): number {
  if (!steps?.length) return 0
  const [a, b] = placementMat(steps)
  const deg = Math.atan2(b, a) * 180 / Math.PI
  return Math.abs(deg) < 1e-9 ? 0 : deg
}

function translateMat(dx: number, dy: number): Mat6 {
  return [1, 0, 0, 1, dx, dy]
}

// CCW rotation in CNC Y-up space
function rotateMat(cx: number, cy: number, angleDeg: number): Mat6 {
  const r = angleDeg * Math.PI / 180
  const cos = Math.cos(r), sin = Math.sin(r)
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]
}

function scaleMat(ax: number, ay: number, sx: number, sy: number): Mat6 {
  return [sx, 0, 0, sy, ax - sx * ax, ay - sy * ay]
}

// kx = horizontal shear (X shift per unit Y), ky = vertical shear (Y shift per unit X), both around (ax, ay)
function skewMat(kx: number, ky: number, ax: number, ay: number): Mat6 {
  return [1, ky, kx, 1, -kx * ay, -ky * ax]
}

// axis 'x' negates X (horizontal flip); axis 'y' negates Y (vertical flip)
function mirrorMat(axis: 'x' | 'y', cx: number, cy: number): Mat6 {
  return scaleMat(cx, cy, axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1)
}

export function translateD(d: string, dx: number, dy: number): string {
  return stringifyD(applyMat(parseD(d), translateMat(dx, dy)))
}

export function scaleAroundD(d: string, ax: number, ay: number, sx: number, sy: number): string {
  return stringifyD(applyMat(parseD(d), scaleMat(ax, ay, sx, sy)))
}

export function rotateAroundD(d: string, cx: number, cy: number, angleDeg: number): string {
  return stringifyD(applyMat(parseD(d), rotateMat(cx, cy, angleDeg)))
}

export function mirrorD(d: string, axis: 'x' | 'y', cx: number, cy: number): string {
  return stringifyD(applyMat(parseD(d), mirrorMat(axis, cx, cy)))
}

export function skewAroundD(d: string, kx: number, ky: number, ax: number, ay: number): string {
  return stringifyD(applyMat(parseD(d), skewMat(kx, ky, ax, ay)))
}

// A geometric transform gesture's inputs, kept separate from its baked
// result. Timeline paths.edit events for move/scale/rotate/skew/mirror store
// these (timeline/events.ts's PathUpdate.transforms) so replay can recompute
// d/shapeParams against whatever the path's CURRENT geometry is at that point
// in the fold — composable on top of upstream edits — instead of stamping
// back a stale absolute d baked at record time against the OLD geometry.
export type TransformStep =
  | { kind: 'translate'; dx: number; dy: number }
  | { kind: 'scale'; sx: number; sy: number; ax: number; ay: number }
  | { kind: 'rotate'; angle: number; cx: number; cy: number }
  | { kind: 'skew'; kx: number; ky: number; ax: number; ay: number }
  | { kind: 'mirror'; axis: 'x' | 'y'; cx: number; cy: number }

// Compose two Mat6es where `m1` is applied first, then `m2` — i.e. the
// single matrix equivalent to point => m2(m1(point)).
function composeMat6(m1: Mat6, m2: Mat6): Mat6 {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a2 * a1 + c2 * b1, b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1, b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2, b2 * e1 + d2 * f1 + f2,
  ]
}

function matForStep(step: TransformStep): Mat6 {
  switch (step.kind) {
    case 'translate': return translateMat(step.dx, step.dy)
    case 'rotate': return rotateMat(step.cx, step.cy, step.angle)
    case 'scale': return scaleMat(step.ax, step.ay, step.sx, step.sy)
    case 'skew': return skewMat(step.kx, step.ky, step.ax, step.ay)
    case 'mirror': return mirrorMat(step.axis, step.cx, step.cy)
  }
}

// A chain of transform steps composes into ONE affine map, which always has
// exactly one canonical decomposition into scale, shear, rotation, optional
// reflection, and a net translation — so a merged chip like
// Move→Rotate→Scale→Move has one true set of net parameters, not four
// independent ones. Standard QR-style (Gram-Schmidt) decomposition of the
// composed matrix's linear part.
//
// Scale/rotate/mirror pivot at the selection's OWN bounding-box center
// (`bbox`) — not the CNC origin — so "rotate in place" actually looks and
// edits like rotating in place; skew pivots at the bbox's bottom edge (its
// horizontal shear has a fixed line, and the object's base is the more
// useful thing to hold still than its center). Whatever position error
// these anchor choices would otherwise introduce is folded into the final
// translate step, so the result is exact regardless of which points are
// chosen — see the two composeMat6 calls below: build the transform WITHOUT
// its translate, then the translate is just "what's left over" between that
// and the true composed translation.
//
// `bbox` is only a FALLBACK pivot, used when `steps` introduces a scale/
// rotate/skew for the first time. When `steps` already contains one (e.g.
// merging a fresh drag into a chip that already has a scale step), that
// step's own ax/ay or cx/cy is reused instead — re-anchoring an EXISTING
// scale/rotate to a fresh bbox (which has already moved by whatever this
// chip's translate so far amounts to) double-counts that movement once
// scaled: e.g. a chip already at scale=2, dx=100 merging a further +1mm
// drag would come out as dx=202, not 101, because the "current" bbox center
// used as the new pivot is itself 100mm downstream of the pivot the
// existing scale was actually anchored to.
export function consolidateSteps(steps: TransformStep[], bbox: BBox): TransformStep[] {
  if (steps.length === 0) return steps
  let m: Mat6 = [1, 0, 0, 1, 0, 0]
  for (const step of steps) m = composeMat6(m, matForStep(step))
  const [a, b, c, d, e, f] = m

  const det = a * d - b * c
  const mirror = det < 0
  // factor out a Y-axis reflection so the rest decomposes as a proper rotation
  const rb = mirror ? -b : b, rd = mirror ? -d : d

  const EPS = 1e-9
  const scaleX = Math.hypot(a, rb)
  if (scaleX < EPS) return steps
  const a1 = a / scaleX, b1 = rb / scaleX
  // Gram-Schmidt: project out the (now-unit) first axis to get the second's
  // perpendicular component — its length is scaleY, the leftover dot product
  // is the shear.
  const shearRaw = a1 * c + b1 * rd
  const c2 = c - shearRaw * a1, d2 = rd - shearRaw * b1
  const scaleY = Math.hypot(c2, d2)
  if (scaleY < EPS) return steps
  let angleDeg = Math.atan2(b1, a1) * 180 / Math.PI
  const kx = shearRaw / scaleY // reproduces shearRaw via Scale(scaleX,scaleY) then Skew(kx, 0), both about the same anchor

  // Any reflection has two equally valid representations 180° apart:
  // Mirror('y') at this angle, or Mirror('x') at angle-180 (since
  // Mirror('x') = Rotate(180)∘Mirror('y')). Always normalizing to 'y' would
  // show a spurious ~180° rotation for a plain axis-'x' mirror with no
  // actual rotation involved — pick whichever axis needs the SMALLER
  // rotation so "just mirrored" reads as just mirrored.
  let mirrorAxis: 'x' | 'y' = 'y'
  if (mirror) {
    const norm180 = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180
    const altAngle = norm180(angleDeg - 180)
    if (Math.abs(altAngle) < Math.abs(angleDeg)) { mirrorAxis = 'x'; angleDeg = altAngle }
  }

  const existingScale = steps.find((s) => s.kind === 'scale')
  const existingRotate = steps.find((s) => s.kind === 'rotate')
  const existingSkew = steps.find((s) => s.kind === 'skew')
  const scalePivot = existingScale?.kind === 'scale' ? { x: existingScale.ax, y: existingScale.ay }
    : existingRotate?.kind === 'rotate' ? { x: existingRotate.cx, y: existingRotate.cy }
    : { x: bbox.cx, y: bbox.cy }
  const skewPivot = existingSkew?.kind === 'skew' ? { x: existingSkew.ax, y: existingSkew.ay } : { x: bbox.cx, y: bbox.minY }

  const result: TransformStep[] = []
  if (Math.abs(scaleX - 1) > EPS || Math.abs(scaleY - 1) > EPS) {
    result.push({ kind: 'scale', ax: scalePivot.x, ay: scalePivot.y, sx: scaleX, sy: scaleY })
  }
  if (Math.abs(kx) > EPS) result.push({ kind: 'skew', ax: skewPivot.x, ay: skewPivot.y, kx, ky: 0 })
  if (Math.abs(angleDeg) > EPS) result.push({ kind: 'rotate', cx: scalePivot.x, cy: scalePivot.y, angle: angleDeg })
  if (mirror) result.push({ kind: 'mirror', axis: mirrorAxis, cx: scalePivot.x, cy: scalePivot.y })

  // The steps above reproduce the target linear part exactly (pivot choice
  // never affects the linear part — only its translation offset), so the
  // remaining translation is just the difference between what they produce
  // and the true composed translation.
  let partial: Mat6 = [1, 0, 0, 1, 0, 0]
  for (const step of result) partial = composeMat6(partial, matForStep(step))
  result.push({ kind: 'translate', dx: e - partial[4], dy: f - partial[5] })
  return result
}

// What a canonical step list should be labeled as in the timeline — 'move'
// etc. when only one KIND of change is actually non-identity, 'transform'
// once more than one is (e.g. mirroring a chip that already had a move).
// consolidateSteps always includes a translate step even when dx/dy end up
// ~0 (so replay has somewhere to put drift-correction), so that one alone
// needs an explicit magnitude check — scale/skew/rotate/mirror are already
// only present in `steps` when genuinely non-identity.
export function gestureForSteps(steps: TransformStep[]): PathEditGesture {
  const EPS = 1e-6
  const kinds = new Set<PathEditGesture>()
  for (const step of steps) {
    if (step.kind === 'translate') {
      if (Math.abs(step.dx) > EPS || Math.abs(step.dy) > EPS) kinds.add('move')
    } else {
      kinds.add(step.kind)
    }
  }
  if (kinds.size === 1) return [...kinds][0]
  return kinds.size === 0 ? 'move' : 'transform'
}

// Apply one transform step to a path's CURRENT d/shapeParams. Shared by every
// live baking site (CanvasStage drag handlers, PropertiesPanel rotate/mirror)
// so they all compute byte-identical results.
export function applyTransformStep(
  path: Pick<ImportedPath, 'd' | 'shapeParams' | 'placement'>,
  step: TransformStep,
): { d: string; shapeParams: ShapeParams | null | undefined; name?: string } {
  switch (step.kind) {
    case 'translate': {
      const d = translateD(path.d, step.dx, step.dy)
      const shapeParams = path.shapeParams ? translateShapeParams(path.shapeParams, step.dx, step.dy) : undefined
      return { d, shapeParams }
    }
    case 'scale': {
      // A PLACED shape's `d` is placement ∘ definition, so a scale stated in
      // world coordinates has to be re-stated in DEFINITION ones before the
      // params can absorb it, or regenerating from them drops the placement and
      // the shape snaps back to un-rotated. Writing the placement as an affine
      // M and the scale about A as S, the identity S_A ∘ M = M ∘ S_{M⁻¹A} holds
      // for ANY M when the scale is UNIFORM (both sides come to sRx + A + s(t−A)
      // — conformality is never needed, only that s is a scalar). It fails for a
      // non-uniform scale unless M keeps the axes, since that needs R⁻¹SR to
      // stay diagonal — so a stretched, rotated shape is baked, as it always was.
      const placed = (path.placement?.length ?? 0) > 0
      const uniform = Math.abs(Math.abs(step.sx) - Math.abs(step.sy)) <= 0.001
      const anchor = placed && uniform
        ? unplacePoint({ x: step.ax, y: step.ay }, path.placement)
        : { x: step.ax, y: step.ay }
      const newShapeParams = path.shapeParams && !(placed && !uniform)
        ? scaleShapeParams(path.shapeParams, anchor.x, anchor.y, step.sx, step.sy)
        : path.shapeParams ? null : undefined
      // When params are valid, regenerate d from them to preserve exact geometry (arcs stay circular)
      const d = newShapeParams != null
        ? applyPlacementD(generateShapeD(newShapeParams), path.placement)
        : scaleAroundD(path.d, step.ax, step.ay, step.sx, step.sy)
      const typeChanged = newShapeParams && path.shapeParams && newShapeParams.type !== path.shapeParams.type
      const name = typeChanged ? shapeDisplayName(newShapeParams!.type) : undefined
      return { d, shapeParams: newShapeParams === null ? null : newShapeParams, name }
    }
    case 'rotate':
      return { d: rotateAroundD(path.d, step.cx, step.cy, step.angle), shapeParams: null }
    case 'skew':
      return { d: skewAroundD(path.d, step.kx, step.ky, step.ax, step.ay), shapeParams: null }
    case 'mirror':
      return { d: mirrorD(path.d, step.axis, step.cx, step.cy), shapeParams: null }
  }
}

// Folds a sequence of steps, threading the intermediate d/shapeParams through
// each one — used when a "Transform" chip merges several gesture kinds.
//
// A `null` from ANY step survives to the result. It is the signal that the
// parameters could not absorb the sequence and it has to SPILL into `placement`
// (`applyUpdateToPath`). Threading it on as `undefined` lost it to the very next
// step: the constraint solve's rotate-then-translate came out as "params
// untouched", so the turn was baked into `d` and recorded nowhere — the solver
// then read the part as standing at 0° and turned it again on every edit.
export function applyTransformSteps(
  path: Pick<ImportedPath, 'd' | 'shapeParams'>,
  steps: TransformStep[],
): { d: string; shapeParams: ShapeParams | null | undefined; name?: string } {
  let cur: Pick<ImportedPath, 'd' | 'shapeParams'> = path
  let name: string | undefined
  let spilled = false
  for (const step of steps) {
    const r = applyTransformStep(cur, step)
    if (r.shapeParams === null) spilled = true
    cur = { d: r.d, shapeParams: r.shapeParams ?? undefined }
    if (r.name !== undefined) name = r.name
  }
  return { d: cur.d, shapeParams: spilled ? null : cur.shapeParams, name }
}

// ── Placement ────────────────────────────────────────────────────────────────
// A multi-part shape (a gear and its pinion) regenerates every part from ONE
// shared set of params, so a part that has been dragged somewhere has nowhere
// to record that fact — its own copy of the params used to be translated, the
// group's copies then disagreed, and the next parameter step regenerated the
// whole group from one of them and threw the arrangement away.
//
// ImportedPath.placement is that missing slot: where the part sits relative to
// where its definition nominally puts it. `d` remains the baked result of
// definition-then-placement, so no reader downstream (CAM, canvas, sim) is
// aware of the split — only the writers are.

// Repositioning gestures, which move a part without changing what it IS.
// Scale is deliberately absent: scaling a gear scales its module, so it edits
// the DEFINITION and goes on rewriting shapeParams as it always has.
const PLACEMENT_KINDS: ReadonlySet<TransformStep['kind']> = new Set(['translate', 'rotate', 'mirror', 'skew'])

export function isPlacementOnly(steps: TransformStep[] | undefined): boolean {
  return !!steps && steps.length > 0 && steps.every((s) => PLACEMENT_KINDS.has(s.kind))
}

// The single affine map a placement recipe amounts to.
export function placementMat(steps: TransformStep[] | undefined): Mat6 {
  let m: Mat6 = [1, 0, 0, 1, 0, 0]
  if (steps) for (const step of steps) m = composeMat6(m, matForStep(step))
  return m
}

// The point a placement recipe MAPS TO `p` — i.e. where `p` was before the
// recipe carried it out. `applyTransformStep` needs it to state a scale in
// DEFINITION coordinates when the shape it is scaling has been placed.
export function unplacePoint(
  p: { x: number; y: number },
  steps: TransformStep[] | undefined,
): { x: number; y: number } {
  const [a, b, c, d, e, f] = placementMat(steps)
  const det = a * d - b * c
  if (!isFinite(det) || Math.abs(det) < 1e-12) return p
  const px = p.x - e, py = p.y - f
  return { x: (d * px - c * py) / det, y: (a * py - b * px) / det }
}

// Carry freshly generated definition geometry out to where the part actually
// sits. Geometry only — a placement never touches params, which is the whole
// point of keeping the two apart.
export function applyPlacementD(d: string, steps: TransformStep[] | undefined): string {
  if (!steps || steps.length === 0) return d
  return stringifyD(applyMat(parseD(d), placementMat(steps)))
}

// Fold a new repositioning gesture into a part's existing placement, keeping
// it consolidated so a session of dragging stays one canonical recipe rather
// than an ever-growing list (see consolidateSteps).
export function foldPlacement(
  path: Pick<ImportedPath, 'd' | 'placement'>,
  steps: TransformStep[],
): TransformStep[] {
  const chained = [...(path.placement ?? []), ...steps]
  // consolidateSteps only consults the bbox as a FALLBACK pivot, for a
  // scale/rotate/skew appearing in the chain for the first time; every step
  // reaching here already carries its own pivot, so this is belt-and-braces.
  const bbox = getBBox(path.d)
  return bbox ? consolidateSteps(chained, bbox) : chained
}

// Apply a live transform to a single CNC-space point
export function transformPoint(
  x: number, y: number,
  transform: { kind: 'translate'; dx: number; dy: number }
           | { kind: 'scale'; sx: number; sy: number; ax: number; ay: number }
           | { kind: 'rotate'; angle: number; cx: number; cy: number }
           | { kind: 'skew'; kx: number; ky: number; ax: number; ay: number }
): { x: number; y: number } {
  switch (transform.kind) {
    case 'translate':
      return { x: x + transform.dx, y: y + transform.dy }
    case 'scale':
      return { x: transform.ax + transform.sx * (x - transform.ax), y: transform.ay + transform.sy * (y - transform.ay) }
    case 'rotate': {
      const r = transform.angle * Math.PI / 180
      const cos = Math.cos(r), sin = Math.sin(r)
      const dx = x - transform.cx, dy = y - transform.cy
      return { x: transform.cx + cos * dx - sin * dy, y: transform.cy + sin * dx + cos * dy }
    }
    case 'skew':
      return {
        x: x + transform.kx * (y - transform.ay),
        y: transform.ky * (x - transform.ax) + y,
      }
  }
}

/** The placement of an image- or STL-backed path's bounding rectangle. */
export interface RectInfo {
  p0: { x: number; y: number } // first corner (conceptual bottom-left when rotation = 0)
  widthMM: number              // length of the p0→p1 edge
  heightMM: number             // length of the p1→p2 edge
  rotationDeg: number          // angle of the p0→p1 edge, CCW from +X in CNC Y-up
}

// An image-backed path IS a rectangle — importFile writes four corners — and its picture
// is pinned to those corners: bottom edge along p0→p1, top edge one heightMM away on the
// CCW side. Both the canvas (DesignLayer) and the photo V-carve toolpath read the
// placement through this one function, so what is carved is what is drawn, rotation
// included. Returns null for anything that isn't four corners.
export function extractRectInfo(d: string): RectInfo | null {
  const cmds = parseD(d)
  const pts: { x: number; y: number }[] = []
  for (const cmd of cmds) {
    if (cmd.t === 'M' || cmd.t === 'L') {
      pts.push({ x: cmd.x, y: cmd.y })
      if (pts.length === 4) break
    }
  }
  if (pts.length < 4) return null
  const widthMM = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
  const heightMM = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y)
  if (widthMM < 0.001 || heightMM < 0.001) return null
  // A RECTANGLE, not merely four corners. The picture and the carve are an unskewed
  // rectangle of these edge lengths, so on a parallelogram (a skew, or a turned image
  // stretched along one world axis) or a dragged corner the outline and the picture sat
  // in different places — and the "no longer a rectangle" error could never fire. The
  // tolerances are well clear of what 4-decimal d-strings do to a real rectangle.
  const ux = (pts[1].x - pts[0].x) / widthMM, uy = (pts[1].y - pts[0].y) / widthMM
  const vx = (pts[2].x - pts[1].x) / heightMM, vy = (pts[2].y - pts[1].y) / heightMM
  if (Math.abs(ux * vx + uy * vy) > 1e-3) return null
  const cornerTol = 1e-3 * Math.max(widthMM, heightMM) + 1e-3
  if (Math.hypot(pts[3].x - (pts[0].x + pts[2].x - pts[1].x), pts[3].y - (pts[0].y + pts[2].y - pts[1].y)) > cornerTol) return null
  const rotationDeg = (Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180) / Math.PI
  return { p0: pts[0], widthMM, heightMM, rotationDeg }
}

export interface CircleInfo { cx: number; cy: number; radiusMM: number }

/** One subpath's circle, from its bounding box. Null unless it is round. */
function circleFromD(d: string): CircleInfo | null {
  const bb = getBBox(d)
  if (!bb) return null
  const rx = (bb.maxX - bb.minX) / 2
  const ry = (bb.maxY - bb.minY) / 2
  if (Math.max(rx, ry) < 0.001) return null
  if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.08) {
    return { cx: bb.cx, cy: bb.cy, radiusMM: (rx + ry) / 2 }
  }
  return null
}

/**
 * EVERY circle in a path — one per subpath.
 *
 * A path is not one hole. A gear's pin holes, a bolt circle, an SVG whose circles
 * came in as a single compound path: all of them are N round subpaths under one id,
 * and the drill modes want each. Deriving the circle from the WHOLE path's bounding
 * box instead is not a near miss, it is a hole the size of the whole ring drilled at
 * its centre — which is exactly what a pinion's eight pin holes came out as.
 *
 * `shapeParams` is trusted only when the path really is one subpath: a gear's parts
 * all carry the gear's params, so a params check alone would call the pin-hole ring
 * a circle.
 */
export function extractCircles(path: ImportedPath): CircleInfo[] {
  const subDs = splitCompoundPath(path.d)
  // A PLACED shape's parameters describe its DEFINITION, not what is drawn: the
  // recipe carries it out to where it sits, and may turn or shear it on the way.
  // So a circle rotated about anything but its own middle has moved, and a
  // skewed one is an ellipse — while its params still say "circle at cx,cy".
  // Read the outline instead, which is the same rule as `a path is not a hole`.
  const placed = (path.placement?.length ?? 0) > 0
  if (subDs.length <= 1 && !placed) {
    if (path.shapeParams?.type === 'circle') {
      return [{ cx: path.shapeParams.cx, cy: path.shapeParams.cy, radiusMM: path.shapeParams.radius }]
    }
    if (path.shapeParams?.type === 'ellipse') {
      const { cx, cy, rx, ry } = path.shapeParams
      if (Math.abs(rx - ry) / Math.max(rx, ry, 0.001) < 0.05) return [{ cx, cy, radiusMM: (rx + ry) / 2 }]
    }
  }
  return subDs.flatMap((d) => {
    const c = circleFromD(d)
    return c ? [c] : []
  })
}

