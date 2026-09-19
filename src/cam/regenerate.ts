import { isWorkCancelled } from '../workers/workerClient'
import { useToolpathStore, refsPathId, type AnyOperation } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { useSimStore } from '../store/simStore'
import { useUIStore } from '../store/uiStore'
import { generateOperation } from './opJob'

// The automatic regeneration — an edit to a path, a tab, a start reference or the undo
// history made an operation stale and nobody clicked Generate. What it runs is exactly
// what a form runs (see opJob.ts); the only thing that differs is where a failure goes.
export async function regenerateOperation(opId: string): Promise<void> {
  const { operations, updateOperation, setError } = useToolpathStore.getState()
  const op = operations.find((o) => o.id === opId)
  if (!op) return
  // Checked before the status write: an op whose tool has been deleted is left as it is
  // rather than marked generating with nothing to generate it.
  if (!useToolStore.getState().tools.some((t) => t.id === op.toolId)) return

  updateOperation(opId, { status: 'generating' })
  // An inlay's generation writes its linked half too, so that half is generating as well —
  // and if this fails, it has to be settled with it rather than left `generating` forever.
  const partnerId = op.type === 'inlay' ? op.linkedOpId : undefined
  const partner = partnerId ? operations.find((o) => o.id === partnerId && o.type === 'inlay') : undefined
  if (partner) updateOperation(partner.id, { status: 'generating' })

  try {
    const { notes } = await generateOperation(opId)
    // No op-name prefix: StatusBar truncates, and a name like
    // 'Pocket: Path 1 (1/8" End Mill)' consumes the whole line before the note starts.
    for (const note of notes) useUIStore.getState().showStatus(note.short, 'warn')
  } catch (err) {
    // A cancelled regenerate is not a failure: abortGeneration has already settled the
    // op's status, and the state it was computing against is gone.
    if (isWorkCancelled(err)) return
    const msg = err instanceof Error ? err.message : 'Generation failed'
    setError(opId, msg)
    if (partner) setError(partner.id, msg)
    // Nobody clicked anything, so there is no form banner to carry this: an edit to a
    // path silently broke an operation that was already generated. The status bar is the
    // only place the user will see it.
    useUIStore.getState().showStatus(`${op.name}: ${msg}`, 'error')
  }
}

// Regenerate every operation referencing ANY of the given paths, each op once.
// Multi-path gestures (move a pocket boundary + its islands, rotate a
// selection) must use this rather than calling regenerateAffected per path —
// an op referencing several of the paths would otherwise regenerate once per
// path, multiplying seconds-long adaptive/morph generations (bugs.md H1).
export function regenerateAffectedMany(pathIds: string[]): void {
  if (pathIds.length === 0) return
  const { operations } = useToolpathStore.getState()
  const affected = operations.filter((op) => pathIds.some((id) => refsPathId(op, id)))
  if (affected.length > 0) {
    useSimStore.getState().invalidateSim()
    regenerateMany(affected)
  }
  // Moving or reshaping a path moves the FLOOR of any pocket built on it, and the ops
  // sitting in that pocket don't reference the path at all — they'd never appear in
  // `affected`. Ops already regenerating above are skipped (only 'done' ops can go stale)
  // and re-stamp themselves when they finish.
  useToolpathStore.getState().revalidateStartHeights()
}

export function regenerateAffected(pathId: string): void {
  regenerateAffectedMany([pathId])
}

export function regenerateAll(): void {
  const { operations } = useToolpathStore.getState()
  if (operations.length > 0) useSimStore.getState().invalidateSim()
  regenerateMany(operations)
}

/**
 * Regenerate each of `ops` — ONE generation per inlay pair.
 *
 * Both halves of a linked inlay are produced by a single call that writes both ops, and
 * both halves reference the same paths, so every sweep used to submit the pair twice: two
 * of the slowest jobs in the app, on two threads, computing the same thing. The second is
 * dropped here; the first marks and writes its partner (see regenerateOperation).
 */
export function regenerateMany(ops: AnyOperation[]): void {
  const submitted = new Set<string>()
  for (const op of ops) {
    if (op.type === 'inlay' && op.linkedOpId && submitted.has(op.linkedOpId)) continue
    submitted.add(op.id)
    void regenerateOperation(op.id)
  }
}
