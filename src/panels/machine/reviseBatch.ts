import type { ImportedPath } from '../../store/pathsStore'

// ─── Which paths a batch of operations covers ─────────────────────────────────
// A profile and a drill each hold ONE `pathId`, so the thing that has a set of paths is
// the batch — every operation one Generate click made. While that batch is open in its
// form the canvas selection IS that set: shift-click a path in, shift-click one out. But
// nothing moves until Regenerate is pressed, so a selection made by mistake costs nothing
// but the selection.
//
// AN EMPTY SELECTION IS NOT AN EMPTY BATCH. Clicking blank canvas clears the selection,
// and reading that as "delete every operation in this batch" would turn the commonest
// misclick in the app into lost work. So an empty selection leaves the batch exactly as it
// stands — which also means none of this is live until the user selects something.
export function reviseBatch<T>(
  members: T[],
  pathOf: (m: T) => ImportedPath | undefined,
  selection: ImportedPath[],
): { keep: T[]; drop: T[]; add: ImportedPath[]; revising: boolean } {
  if (selection.length === 0) return { keep: members, drop: [], add: [], revising: false }
  const sel = new Set(selection.map((p) => p.id))
  const covered = new Set(members.flatMap((m) => { const p = pathOf(m); return p ? [p.id] : [] }))
  return {
    // A member whose path is no longer in the document is never dropped by this. It is
    // missing from the selection because it is missing from the canvas, and deleting the
    // operation for that would be a deletion the user never asked for.
    keep: members.filter((m) => { const p = pathOf(m); return !p || sel.has(p.id) }),
    drop: members.filter((m) => { const p = pathOf(m); return !!p && !sel.has(p.id) }),
    add: selection.filter((p) => !covered.has(p.id)),
    revising: true,
  }
}

// ─── The same, for the forms whose operation is a boundary AND its islands ─────
// A pocket and a v-carve do not have one path per operation, and — unlike a profile —
// which path is the boundary and which are islands is READ OFF THE GEOMETRY rather than
// chosen. So a revision here re-runs that same reading over the new selection, the one the
// first Generate already used, and matches what comes back against the operations by
// boundary: a path shift-clicked inside an existing pocket becomes an ISLAND of it, by the
// rule that made it one the first time.
//
// The regrouping runs ONLY when the selection actually differs from what the batch covers,
// or when the caller says the RULE has changed (`force`) — flipping Invert Pocket reads the
// same paths the other way up. A Regenerate pressed to pick up a new depth must not
// re-derive a grouping nobody asked to change: the same paths can legitimately group more
// than one way, and the operation records which way it went, not how to get back there.
export interface PathGroup { boundary: ImportedPath; islands: ImportedPath[] }

export function reviseGroupBatch<M extends PathGroup>(
  members: M[],
  selection: ImportedPath[],
  regroup: (paths: ImportedPath[]) => PathGroup[],
  opts: { force?: boolean } = {},
): {
  revising: boolean
  keep: { member: M; group: PathGroup }[]
  add: PathGroup[]
  drop: M[]
  /** Paths the selection brings in, for marking the chips that stand for them. */
  addedIds: Set<string>
  /** Paths the batch covers that the revision no longer machines — deselected, or left out
   *  by the regrouping itself (an inverted pocket's outermost path becomes the field). */
  removed: ImportedPath[]
} {
  const asIs = () => ({
    revising: false,
    keep: members.map((m) => ({ member: m, group: { boundary: m.boundary, islands: m.islands } })),
    add: [] as PathGroup[],
    drop: [] as M[],
    addedIds: new Set<string>(),
    removed: [] as ImportedPath[],
  })
  // An empty selection is not an empty batch — see reviseBatch.
  if (selection.length === 0) return asIs()
  const covered = new Set(members.flatMap((m) => [m.boundary.id, ...m.islands.map((p) => p.id)]))
  const sel = new Set(selection.map((p) => p.id))
  if (!opts.force && sel.size === covered.size && [...sel].every((id) => covered.has(id))) return asIs()

  const groups = regroup(selection)
  const byBoundary = new Map(groups.map((g) => [g.boundary.id, g]))
  const keep = members.flatMap((m) => {
    const group = byBoundary.get(m.boundary.id)
    return group ? [{ member: m, group }] : []
  })
  const kept = new Set(keep.map((k) => k.group.boundary.id))
  // What the new grouping actually machines. Asking this rather than "is it still
  // selected" is what catches the path a REGROUPING drops while leaving it selected: flip
  // Invert Pocket and the old boundary becomes the field, cut by nothing.
  const inGroups = new Set(groups.flatMap((g) => [g.boundary.id, ...g.islands.map((p) => p.id)]))
  const seen = new Set<string>()
  return {
    revising: true,
    keep,
    // A group the regrouping produced that no operation covers — either a path that was
    // not in the batch at all, or one that WAS an island and is now a boundary of its own.
    add: groups.filter((g) => !kept.has(g.boundary.id)),
    drop: members.filter((m) => !byBoundary.has(m.boundary.id)),
    addedIds: new Set(selection.filter((p) => !covered.has(p.id)).map((p) => p.id)),
    removed: members.flatMap((m) => [m.boundary, ...m.islands])
      .filter((p) => !inGroups.has(p.id) && !seen.has(p.id) && (seen.add(p.id), true)),
  }
}
