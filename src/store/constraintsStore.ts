import { create } from 'zustand'
import { useTimelineStore } from '../timeline/timelineStore'
import { applyConstraintSolve } from './pathsStore'
import type { Constraint } from './constraints'

// The constraints in the document. See `constraints.ts` for what one IS and why
// it is not a field on the paths it joins.
//
// Every mutating action records a timeline event, for the same reason every
// action in pathsStore does: undo is a snapshot stack, and `record` is what
// takes the snapshot. The event is not replayed — nothing is, since the rewrite
// — it is the history's spine and the chip's label.
//
// `replaceConstraints` is the raw setter, for load machinery and for the
// cleanups that ride along inside somebody else's atomic edit (deleting a path
// drops its constraints; splitting one drops them too). Those record nothing of
// their own on purpose: the edit that caused them has already recorded, and its
// snapshot is taken afterwards, so one undo puts both halves back.

interface ConstraintsState {
  constraints: Constraint[]
  addConstraint: (c: Constraint) => void
  updateConstraint: (id: string, changes: Partial<Omit<Constraint, 'id'>>) => void
  deleteConstraints: (ids: string[]) => void
  replaceConstraints: (constraints: Constraint[]) => void
}

export const useConstraintsStore = create<ConstraintsState>()((set, get) => ({
  constraints: [],

  addConstraint: (c) => {
    set((s) => ({ constraints: [...s.constraints, c] }))
    // Created with the distance the parts ALREADY stand at (see
    // measureConstraint), so this is normally a no-op — but a constraint typed
    // in with a value has to take effect at once, and the solve is idempotent,
    // so it is always run rather than guessed about. Before `record`, so the
    // snapshot that event takes holds the moved geometry.
    applyConstraintSolve(anchorOf(c))
    useTimelineStore.getState().record({ kind: 'constraint.add', constraint: c })
  },

  updateConstraint: (id, changes) => {
    const before = get().constraints.find((c) => c.id === id)
    if (!before) return
    const after = { ...before, ...changes }
    set((s) => ({ constraints: s.constraints.map((c) => c.id === id ? after : c) }))
    // The `from` end is held and the `to` end takes up the change — which is the
    // one question the constraint's direction is still there to answer, now that
    // a DRAG anchors at whatever the user grabbed rather than at a fixed root.
    applyConstraintSolve(anchorOf(after))
    // Coalesced by the timeline like any other run of spinner keystrokes, so
    // dialling a distance is one chip rather than one per digit.
    useTimelineStore.getState().record({ kind: 'constraint.update', constraintId: id, changes })
  },

  deleteConstraints: (ids) => {
    if (ids.length === 0) return
    const doomed = new Set(ids)
    if (!get().constraints.some((c) => doomed.has(c.id))) return
    set((s) => ({ constraints: s.constraints.filter((c) => !doomed.has(c.id)) }))
    // No solve: releasing a part leaves it where it stands, which is what
    // deleting a constraint means. Whatever else is still constrained was
    // already satisfied, so there is nothing for a solve to find.
    useTimelineStore.getState().record({ kind: 'constraint.delete', constraintIds: ids })
  },

  replaceConstraints: (constraints) => set({ constraints }),
}))

/** The path a constraint holds still: its `from` end, unless that is the stock. */
function anchorOf(c: Constraint): string[] {
  return c.from.kind === 'stock' ? [] : [c.from.id]
}

/** Every constraint with an end on any of `pathIds`. */
export function constraintsTouching(constraints: Constraint[], pathIds: Iterable<string>): Constraint[] {
  const ids = new Set(pathIds)
  return constraints.filter((c) =>
    (c.from.kind !== 'stock' && ids.has(c.from.id))
    || (c.to.kind !== 'stock' && ids.has(c.to.id)))
}
