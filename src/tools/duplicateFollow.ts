import type { ImportedPath } from '../importers/svgImporter'
import type { TransformStep } from '../canvas/selectionUtils'
import { pathSimilarityTransform } from './cornerTreatment'
import { getBBox } from '../canvas/selectionUtils'

// ─── A duplicate follows its original ─────────────────────────────────────────
//
// A LINKED COPY IS ITS ORIGINAL, MOVED AND TURNED. Nothing more is known or needed.
// When the original changes SHAPE, the copy becomes the original's new state carried
// by the same rigid motion — R, found by matching the two OUTLINES point for point
// (`pathSimilarityTransform`), and applied through the very code a drag or a rotate
// uses (`transformPath`, supplied by the store), which already knows every way a
// shape can be stored: parameters, placement, corner recipes, a boolean's flattened
// result, a pen path, a gear's parts.
//
// That is the whole design, and it is deliberately REPRESENTATION-BLIND. An earlier
// version reproduced a change per kind of shape — parameters one way, corners another
// — and each kind it did not know about (a boolean result, then the next) was a gap
// found by a user. Here a kind of shape needs nothing: every shape has an outline,
// and every shape can be moved.
//
// What counts:
//  - The ORIGINAL changed shape when its new outline is not a rigid image of its old
//    one. A move or a turn of the original moves no copy.
//  - A copy is LINKED while it was never unlinked (`copyOf.unlinked`, set by the
//    Unlink button) AND its outline is a rigid image of the original's (before this
//    edit). The second is what keeps old projects safe — a copy edited long ago no
//    longer matches — and point-for-point matching is what makes it exact: a turned
//    copy of a square reads as turned, not as an unturned square.
//  - The user RESHAPING a copy unlinks it (`copyOf.unlinked`), unless the copy still
//    matches the original as the original now stands (the two resized together). A
//    move, a turn or a mirror of the copy is not a reshape.
//
// The link: `copyOf`, stamped by Duplicate and the stamp tool on every path a click
// copies — a copied boolean's hidden operands too, so a copy is linked whatever it is
// made of. Older documents recorded it as `definition: { kind: 'duplicate' }`, which
// is still read. Paste records nothing: the clipboard crosses documents.

/** Applies steps to a path the way a gesture does — params, placement, corners and all. */
export type TransformPath = (p: ImportedPath, steps: TransformStep[]) => ImportedPath

/** What a path carries as its SHAPE — taken from the original when a copy follows it.
 *  Everything else (id, name, colour, groups, its own recipe and link) is the copy's.
 *  A NEW FIELD THAT DESCRIBES A SHAPE BELONGS HERE, and it is the only place it has to go. */
const SHAPE_FIELDS = ['d', 'shapeParams', 'placement', 'corners', 'scalePct', 'fromCenter'] as const

/** The original `p` was copied from, and whether it has been unlinked. */
export function linkOf(p: ImportedPath): { sourceId: string; unlinked: boolean } | null {
  if (p.copyOf) return { sourceId: p.copyOf.sourceId, unlinked: !!p.copyOf.unlinked }
  const def = p.definition
  return def?.kind === 'duplicate' ? { sourceId: def.sourceId, unlinked: !!def.unlinked } : null
}

/** `p` with its link marked unlinked, in whichever field records it. */
export function unlinked(p: ImportedPath): ImportedPath {
  const l = linkOf(p)
  if (!l) return p
  return { ...p, copyOf: { sourceId: l.sourceId, unlinked: true } }
}

/**
 * Is this a size change, or only the 0.0001 mm grid a `d` string is rounded to? A
 * turn re-rounds every coordinate, which reads back as a scale a millionth off 1; what
 * counts is how far that scale moves the shape's far side, in mm — the same 0.001 mm
 * the outline matcher allows each point.
 */
function sameSize(scale: number, d: string): boolean {
  const b = getBBox(d)
  const reach = b ? Math.hypot(b.width, b.height) : 0
  return Math.abs(scale - 1) * Math.max(reach, 1) <= 1e-3
}

/** The rigid motion carrying `a` onto `b` as transform steps, or null when `b` is not
 *  `a` moved, turned or mirrored (a different shape, or a different size). */
export function rigidSteps(a: string, b: string): TransformStep[] | null {
  const sim = pathSimilarityTransform(a, b)
  if (!sim || !sameSize(sim.scale, a)) return null
  const [ma, mb, mc, md, me, mf] = sim.mat
  const det = ma * md - mb * mc
  const steps: TransformStep[] = []
  let deg: number
  if (det < 0) {
    // A mirror: x → −x about the origin first, then the turn.
    steps.push({ kind: 'mirror', axis: 'x', cx: 0, cy: 0 })
    deg = Math.atan2(-mb, -ma) * 180 / Math.PI
  } else {
    deg = Math.atan2(mb, ma) * 180 / Math.PI
  }
  if (Math.abs(deg) > 1e-9) steps.push({ kind: 'rotate', angle: deg, cx: 0, cy: 0 })
  if (me !== 0 || mf !== 0) steps.push({ kind: 'translate', dx: me, dy: mf })
  return steps
}

const isRigidImage = (a: string, b: string) => {
  const sim = pathSimilarityTransform(a, b)
  return !!sim && sameSize(sim.scale, a)
}

/** The original `p` follows right now, or null — never unlinked, still here, and `p`
 *  still its shape. */
export function linkedOriginalOf(paths: readonly ImportedPath[], p: ImportedPath): ImportedPath | null {
  const l = linkOf(p)
  if (!l || l.unlinked) return null
  const orig = paths.find((q) => q.id === l.sourceId)
  return orig && isRigidImage(orig.d, p.d) ? orig : null
}

/** The copies that follow `originalId` right now — directly, not through a copy. */
export function linkedCopiesOf(paths: readonly ImportedPath[], originalId: string): ImportedPath[] {
  const orig = paths.find((p) => p.id === originalId)
  if (!orig) return []
  return paths.filter((p) => {
    const l = linkOf(p)
    return !!l && !l.unlinked && l.sourceId === originalId && isRigidImage(orig.d, p.d)
  })
}

/**
 * WHAT A SELECTION IS TIED TO, for the canvas to show (DesignLayer). Two answers, one
 * per direction a change travels:
 *  - `originals`: the shape each selected linked copy follows — the one to edit to
 *    change them all. Drawn green (ORIGINAL_COLOR), as a pattern's original is.
 *  - `copies`: every linked copy a change to the selection would reshape, through
 *    copies of copies too, since a change travels down the whole chain. Drawn dashed.
 * Only while something linked is selected; a copy that no longer matches is in neither,
 * because it will not change.
 */
export function linkHighlights(
  paths: readonly ImportedPath[],
  selectedIds: readonly string[],
): { originals: string[]; copies: string[] } {
  if (selectedIds.length === 0 || !paths.some((p) => linkOf(p))) return { originals: [], copies: [] }
  const byId = new Map(paths.map((p) => [p.id, p]))
  const originals = new Set<string>()
  for (const id of selectedIds) {
    const p = byId.get(id)
    const o = p ? linkedOriginalOf(paths, p) : null
    if (o) originals.add(o.id)
  }
  const copies = new Set<string>()
  const queue = [...selectedIds]
  const seen = new Set(queue)
  while (queue.length > 0) {
    for (const c of linkedCopiesOf(paths, queue.shift()!)) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      // Never a selected path: the walk starts with all of them already seen.
      copies.add(c.id)
      queue.push(c.id)
    }
  }
  return { originals: [...originals], copies: [...copies] }
}

/**
 * Bring every linked copy of a reshaped original into line, and unlink a copy the user
 * has reshaped. A copy of a copy follows in turn. Pure but for `transformPath`.
 */
export function followDuplicates(
  before: readonly ImportedPath[],
  after: ImportedPath[],
  editedIds: readonly string[],
  transformPath: TransformPath,
): { paths: ImportedPath[]; refreshedIds: string[]; unlinkedIds: string[] } {
  const none = { paths: after, refreshedIds: [] as string[], unlinkedIds: [] as string[] }
  if (editedIds.length === 0 || !after.some((p) => linkOf(p))) return none
  const prev = new Map(before.map((p) => [p.id, p]))
  const now = new Map(after.map((p) => [p.id, p]))
  const edited = new Set(editedIds)
  const replace = new Map<string, ImportedPath>()
  const unlinkedIds: string[] = []

  // A copy the user reshaped stops following — unless it still matches its original
  // as the original now stands (the two were resized together).
  for (const id of editedIds) {
    const p = now.get(id), was = prev.get(id)
    const l = p && linkOf(p)
    if (!p || !was || !l || l.unlinked || was.d === p.d || isRigidImage(was.d, p.d)) continue
    const orig = now.get(l.sourceId)
    if (orig && isRigidImage(orig.d, p.d)) continue
    replace.set(id, unlinked(p))
    unlinkedIds.push(id)
  }

  // Copies by original, once.
  const copiesOf = new Map<string, ImportedPath[]>()
  for (const p of after) {
    const l = linkOf(p)
    if (!l || l.unlinked) continue
    const list = copiesOf.get(l.sourceId)
    if (list) list.push(p); else copiesOf.set(l.sourceId, [p])
  }

  // The originals this edit reshaped, then whatever their copies' reshaping reaches.
  const refreshed: string[] = []
  const queue: { before: ImportedPath; after: ImportedPath }[] = []
  for (const id of editedIds) {
    const a = now.get(id), b = prev.get(id)
    if (a && b && a.d !== b.d && !isRigidImage(b.d, a.d)) queue.push({ before: b, after: a })
  }
  const seen = new Set<string>()
  while (queue.length > 0) {
    const { before: ob, after: oa } = queue.shift()!
    if (seen.has(oa.id)) continue
    seen.add(oa.id)
    for (const d0 of copiesOf.get(oa.id) ?? []) {
      if (edited.has(d0.id)) continue
      const dupBefore = prev.get(d0.id) ?? d0
      // R: how the copy stood relative to the original before this edit — or not
      // linked at all, if it was not the original's shape.
      const steps = rigidSteps(ob.d, dupBefore.d)
      if (!steps) continue
      const shape: Partial<ImportedPath> = {}
      for (const k of SHAPE_FIELDS) (shape as Record<string, unknown>)[k] = oa[k]
      const base = { ...d0, ...shape } as ImportedPath
      const next = steps.length > 0 ? transformPath(base, steps) : base
      if (next.d === d0.d) continue
      replace.set(d0.id, next)
      refreshed.push(d0.id)
      queue.push({ before: dupBefore, after: next })
    }
  }
  if (replace.size === 0) return none
  return { paths: after.map((p) => replace.get(p.id) ?? p), refreshedIds: refreshed, unlinkedIds }
}
