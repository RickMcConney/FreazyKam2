// ONE COPY OF A SET OF PATHS — shared by Duplicate (Ctrl+D) and Paste (Ctrl+V).
//
// These were two hand-kept copies of the same remap, one in pathsStore.duplicateSelected
// and one in pathClipboard.remapForPaste, whose comments said "same rule, same words" three
// times over — and they had already drifted: Duplicate left a path's holding tabs behind
// where Paste carried them, and Copy put a boolean on the clipboard without the hidden
// operands it is made from, so a pasted boolean arrived as dead outline where a duplicated
// one reopened in its form.
//
// The work is the ID REMAP, not the transfer. Every id is reissued, and reissued
// CONSISTENTLY through one map keyed by the old id — a gear's parts share a `groupId`, a
// clock's a `clockId`, a user group is a chain, a generator call's outputs share a
// `definition.id` — so what was shared goes on being shared and nothing joins the thing it
// was copied from. Path ids are reserved FIRST, because a definition's sources are path ids
// and must come out as the same new ids as the paths they name.
//
// Pure: no stores, so both callers and the tests hand it exactly what it works on.
// (tools/pathCopy.ts is a different job — a copy moved by a transform recipe for the pattern
// tool and the nest's fill — and shares only the reissue-by-old-id idea.)

import { uid } from '../uid'
import { translateD } from '../canvas/selectionUtils'
import { translateShapeParams } from '../shapes/shapeGenerators'
import type { ImportedPath, PathDefinition } from '../importers/svgImporter'
import type { Tab } from './tabStore'
import type { Constraint } from './constraints'

/**
 * The paths a generator recipe is MADE FROM — the ones it has to have with it to be
 * regenerated. A `duplicate` names where a copy came from, which is history rather than an
 * ingredient: nothing regenerates a duplicate, so it never pulls its source along.
 */
export function ingredientsOf(def: PathDefinition | undefined): string[] {
  if (!def || def.kind === 'duplicate') return []
  return def.kind === 'pattern' || def.kind === 'boolean' ? def.sourceIds : [def.sourceId]
}

/**
 * The selection plus the HIDDEN paths it is generated from, transitively, in document
 * order (so the copies keep the originals' z-order among themselves).
 *
 * A generator does not consume its sources — BooleanForm soft-hides its operands and offset
 * and pattern keep theirs — so they are still there to copy, and copying them is what makes
 * a copy of a boolean a real one: its own operands, and a definition pointing at those.
 * Only HIDDEN sources come along: a hidden one is the generator's own machinery, while a
 * source the user has made visible is an object they manage themselves, and copying one
 * shape must not put two more on the canvas. Transitive because an operand can itself be a
 * boolean result with operands of its own.
 */
export function withHiddenSources(selectedIds: readonly string[], paths: readonly ImportedPath[]): ImportedPath[] {
  const byId = new Map(paths.map((p) => [p.id, p]))
  const picked = new Set(selectedIds)
  const queue = [...selectedIds]
  while (queue.length > 0) {
    const p = byId.get(queue.pop()!)
    if (!p) continue
    for (const id of ingredientsOf(p.definition)) {
      const src = byId.get(id)
      if (!src || picked.has(id) || !src.hidden) continue
      picked.add(id)
      queue.push(id)
    }
  }
  return paths.filter((p) => picked.has(p.id))
}

/** Which constraints travel with a set of paths: both ends copied, or it stays behind. A
 *  stock edge counts as copied — it is ground, and every project has one. A constraint with
 *  one end left behind is not a copy of anything selected, and re-pointing it at what stayed
 *  would drag the ORIGINAL about when the copy is moved. */
export function constraintsWithin(constraints: readonly Constraint[], ids: ReadonlySet<string>): Constraint[] {
  const inSet = (r: Constraint['from']) => r.kind === 'stock' || ids.has(r.id)
  return constraints.filter((c) => inSet(c.from) && inSet(c.to))
}

export interface CopyPathsOptions {
  /** How far every copy is nudged, in mm on both axes. 0 leaves the geometry untouched. */
  offsetMM: number
  /** Id prefix for the new paths: `path-dup`, `path-paste`. */
  pathIdPrefix: string
  /** Name for a copy; unchanged when omitted. */
  rename?: (name: string) => string
  /**
   * What a copy whose recipe could NOT come with it records.
   *
   * `copied-from`: that it is a duplicate OF THE PATH IT WAS COPIED FROM — right for
   * Duplicate, where that path is in this document. `drop`: nothing — right for Paste, whose
   * source may be in another project entirely; there a `duplicate` definition survives only
   * when the path it names was pasted too.
   */
  lostRecipe: 'copied-from' | 'drop'
}

export interface CopyPathsResult {
  paths: ImportedPath[]
  tabs: Tab[]
  constraints: Constraint[]
  /** Old path id → new path id. */
  newIdOf: Map<string, string>
}

/**
 * Copies of `paths`, with every id reissued consistently, nudged by `offsetMM`, plus the
 * holding tabs and constraints that belong to them. `tabs` and `constraints` may be the
 * whole document's; only those tied to the copied paths are carried.
 */
export function copyPaths(
  paths: readonly ImportedPath[],
  tabs: readonly Tab[],
  constraints: readonly Constraint[],
  opts: CopyPathsOptions,
): CopyPathsResult {
  // One new id per old id, whatever kind of id it is — issued once and reused, which is
  // what keeps a group a group.
  const fresh = new Map<string, string>()
  const reissue = (old: string | undefined, prefix: string): string | undefined => {
    if (!old) return undefined
    const seen = fresh.get(old)
    if (seen) return seen
    const made = uid(prefix)
    fresh.set(old, made)
    return made
  }

  // Reserved first: a definition's sources are path ids.
  const newIdOf = new Map(paths.map((p) => [p.id, reissue(p.id, opts.pathIdPrefix)!]))
  // Every recipe-less copy of one Copy/Duplicate records the same "copied from" definition
  // id — they were one gesture.
  const copiedFromDefId = uid('def')
  const shift = opts.offsetMM

  const out = paths.map((p) => {
    const copy: ImportedPath = {
      ...p,
      id: newIdOf.get(p.id)!,
      name: opts.rename ? opts.rename(p.name) : p.name,
      groupId: reissue(p.groupId, 'shape-group'),
      clockId: reissue(p.clockId, 'clock'),
      // Every level is remapped, so copies come out nested exactly as the originals are —
      // and as their OWN groups, or copying a group grew the thing being copied.
      userGroups: p.userGroups?.map((g) => reissue(g, 'ugroup')!),
      definition: undefined,
    }

    // WHETHER THE COPY KEEPS ITS RECIPE is one question: did everything it is made of come
    // too? If so it is genuinely that generator run over ITS OWN operands — definition id
    // reissued, sources pointed at the copies. If not, the geometry is still perfectly good;
    // it just stops claiming it can be regenerated.
    const def = p.definition
    const ingredients = ingredientsOf(def)
    if (def && ingredients.length > 0 && ingredients.every((id) => newIdOf.has(id))) {
      copy.definition = {
        ...def,
        id: reissue(def.id, 'def')!,
        ...(def.kind === 'pattern' || def.kind === 'boolean'
          ? { sourceIds: def.sourceIds.map((id) => newIdOf.get(id)!) }
          : { sourceId: newIdOf.get((def as { sourceId: string }).sourceId)! }),
      } as PathDefinition
    } else if (opts.lostRecipe === 'copied-from') {
      copy.definition = { id: copiedFromDefId, kind: 'duplicate', sourceId: p.id, offsetMM: shift }
    } else if (def?.kind === 'duplicate' && newIdOf.has(def.sourceId)) {
      copy.definition = { ...def, id: reissue(def.id, 'def')!, sourceId: newIdOf.get(def.sourceId)! }
    }

    if (shift !== 0) {
      copy.d = translateD(p.d, shift, shift)
      // WHERE THE NUDGE GOES DEPENDS ON WHAT DRAWS `d`. A shape with a PLACEMENT has `d` =
      // its definition put through that recipe, so the nudge belongs at the END of the
      // recipe; moving the definition instead comes back out through a rotation as a shift
      // in some other direction entirely. Without a placement the parameters ARE the
      // position, and they have to move or the copy's next spinner step puts it back on top
      // of the original.
      if (p.placement?.length) {
        copy.placement = [...p.placement, { kind: 'translate', dx: shift, dy: shift }]
      } else if (p.shapeParams) {
        copy.shapeParams = translateShapeParams(p.shapeParams, shift, shift)
      }
      // The corner recipe is stated against its own base outline, so that moves with the
      // path too, or reopening the form re-cuts the corners where the original stands.
      if (p.corners) copy.corners = { ...p.corners, baseD: translateD(p.corners.baseD, shift, shift) }
    }
    return copy
  })

  // Holding tabs belong TO a path and reference nothing else, so they travel with it —
  // repointed at the copy, with ids of their own.
  const outTabs = tabs
    .filter((t) => newIdOf.has(t.pathId))
    .map((t) => ({ ...t, id: uid('tab'), pathId: newIdOf.get(t.pathId)! }))

  const ids = new Set(newIdOf.keys())
  const outConstraints = constraintsWithin(constraints, ids).map((c) => {
    const end = (r: Constraint['from']) => (r.kind === 'stock' ? r : { ...r, id: newIdOf.get(r.id)! })
    return { ...c, id: uid('con'), from: end(c.from), to: end(c.to) }
  })

  return { paths: out, tabs: outTabs, constraints: outConstraints, newIdOf }
}
