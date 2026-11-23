import type { ImportedPath } from '../importers/svgImporter'
import { getBBox, getMultiBBox } from '../canvas/selectionUtils'
import { computePatternInstances, patternCopies } from './patternOp'

// ─── A pattern follows its source ─────────────────────────────────────────────
//
// RESIZE THE HOLE AND EVERY COPY OF IT RESIZES. A pattern is a recipe over its
// sources (`definition`), and the copies used to be rebuilt only when the Pattern
// form was reopened and applied — so stepping the original circle's diameter left
// five holes at the old size until the user thought to do that by hand.
//
// Run as a PRE-PASS on the paths as they will be, beside the constraint solve
// (pathsStore), so the copies change in the SAME edit: one undo step, and the
// constraint solve after it sees the pattern as it now stands.
//
// What counts as a change is a RESHAPE, not a move: a source whose box keeps its
// size has only been dragged, and dragging the original hole of a bolt circle on its
// own has always left the copies where they were — re-running the pattern would
// carry the whole circle along with it. Nor does an edit that touches the copies
// as well (the Pattern form's own re-run, a drag of the whole pattern) re-run it:
// that edit already says where the copies go.

/** Below this two box sizes are the same — the 0.0001 mm grid a `d` keeps, and some. */
const SAME_SIZE_MM = 5e-4

function reshaped(before: ImportedPath | undefined, after: ImportedPath): boolean {
  if (!before || before.d === after.d) return false
  const a = getBBox(before.d), b = getBBox(after.d)
  if (!a || !b) return true
  return Math.abs(a.width - b.width) > SAME_SIZE_MM || Math.abs(a.height - b.height) > SAME_SIZE_MM
}

/**
 * Re-run every pattern a reshaped source of this edit feeds — and every pattern
 * built on THOSE, in order.
 *
 * `editedIds` are the paths this edit itself wrote. What sets a pattern off:
 *  - one of its sources RESHAPED by the edit (a move alone does not — see above);
 *  - one of its sources a COPY that another pattern's re-run has just rewritten,
 *    moved or reshaped: that copy is generator output, so wherever the generator
 *    put it is where the pattern built on it has to follow;
 *  - one of its sources a copy the edit rewrote AS a pattern's output (its
 *    definition is new — the Pattern form's Apply), for the same reason.
 *
 * ONE PATTERN AT A TIME, A PATTERN BEFORE ANYTHING BUILT ON IT, each from the
 * paths as they stand after the ones before it. Re-running them in rounds read a
 * second pattern's sources before the first had been rebuilt — a pattern made of a
 * whole bolt circle (original and copies) was rebuilt in the same round as the
 * circle, from the circle's OLD copies, and never again.
 *
 * A pattern that has lost a copy by hand is not re-run: copies are matched to
 * instances by position in the document, so once one is gone every copy after it
 * would take its neighbour's place — `skipped` names it so the user can be told to
 * reopen it, which rebuilds the missing one.
 */
export function followPatternSources(
  before: readonly ImportedPath[],
  after: ImportedPath[],
  editedIds: readonly string[],
  /** `editedIds` were moved by the CONSTRAINT SOLVE, not by the user: any change
   *  counts, a move included. The solve moving a source is the layout changing (a
   *  welded assembly's own constraint re-solved), not someone dragging the original
   *  out of its pattern. */
  opts: { anyChange?: boolean } = {},
): { paths: ImportedPath[]; refreshedIds: string[]; skipped: string[] } {
  const none = { paths: after, refreshedIds: [] as string[], skipped: [] as string[] }
  if (editedIds.length === 0 || !after.some((p) => p.definition?.kind === 'pattern')) return none
  // Every pattern, what it is made from, and which pattern made each copy.
  const sourcesOf = new Map<string, string[]>()
  const producer = new Map<string, string>()
  for (const p of after) {
    const def = p.definition
    if (def?.kind !== 'pattern') continue
    producer.set(p.id, def.id)
    if (!sourcesOf.has(def.id)) sourcesOf.set(def.id, def.sourceIds)
  }
  const allSources = new Set([...sourcesOf.values()].flat())
  // Only a path some pattern is MADE FROM can set one off, so the boxes of
  // everything else a big drag touches are never measured.
  const prev = new Map(before.map((p) => [p.id, p]))
  const edited = new Set(editedIds)
  const changed = new Set<string>()
  for (const p of after) {
    if (!edited.has(p.id) || !allSources.has(p.id)) continue
    const was = prev.get(p.id)
    const regenerated = p.definition?.kind === 'pattern' && was !== undefined
      && JSON.stringify(was.definition) !== JSON.stringify(p.definition)
    if (opts.anyChange ? was !== undefined && was.d !== p.d : regenerated || reshaped(was, p)) changed.add(p.id)
  }
  if (changed.size === 0) return none

  // Which patterns this reaches: set off directly, or built on one that is.
  const affected = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const [defId, srcs] of sourcesOf) {
      if (affected.has(defId)) continue
      if (srcs.some((s) => changed.has(s) || affected.has(producer.get(s) ?? ''))) { affected.add(defId); grew = true }
    }
  }

  let paths = after
  const refreshed: string[] = []
  const skipped: string[] = []
  const done = new Set<string>()
  // Bounded by the number of patterns: each pass settles at least one, or stops.
  for (let progress = true; progress;) {
    progress = false
    for (const defId of affected) {
      if (done.has(defId)) continue
      const srcs = sourcesOf.get(defId)!
      // Not until every pattern it is built on has been settled.
      if (srcs.some((s) => { const up = producer.get(s); return up !== undefined && up !== defId && affected.has(up) && !done.has(up) })) continue
      done.add(defId)
      progress = true
      const copies = paths.filter((p) => p.definition?.kind === 'pattern' && p.definition.id === defId)
      // The edit itself wrote these copies (the form's Apply, a drag of the whole
      // pattern): it has already said where they go.
      if (copies.length === 0 || copies.some((c) => edited.has(c.id))) continue
      const def = copies[0].definition
      if (def?.kind !== 'pattern') continue
      const byId = new Map(paths.map((p) => [p.id, p]))
      const sources = def.sourceIds.flatMap((id) => { const p = byId.get(id); return p ? [p] : [] })
      if (sources.length !== def.sourceIds.length) continue
      const made = patternCopies(sources,
        computePatternInstances(def.params, getMultiBBox(sources.map((s) => s.d))).slice(1))
      if (made.length !== copies.length) { skipped.push(defId); continue }
      // Exactly the Pattern form's rebuild: the copy is REPLACED by what the recipe
      // makes now, keeping only its id (so operations on it still point at it) and
      // its definition.
      const replace = new Map<string, ImportedPath>()
      copies.forEach((c, i) => {
        const fresh = { ...c, ...made[i], id: c.id, definition: c.definition } as ImportedPath
        if (fresh.d === c.d) return
        replace.set(c.id, fresh)
        refreshed.push(c.id)
      })
      if (replace.size > 0) paths = paths.map((p) => replace.get(p.id) ?? p)
    }
  }
  return refreshed.length > 0 || skipped.length > 0 ? { paths, refreshedIds: refreshed, skipped } : none
}
