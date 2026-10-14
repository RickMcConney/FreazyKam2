// The Generate button of every path-driven machine form.
//
// Profile, Trochoidal, Pocket and V-Carve each wrote this out by hand — the new-op branch,
// the edit branch, the cancel and failure rules — and each wrote its operation's settings
// out FOUR times (new payload, the payload for a path added while editing, the update of
// an op this form already made, the update of an edited op). That is how the forms
// drifted: two of them remembered a new op only once it had generated, so cancelling a
// Generate left an op the form had forgotten and the next click made a second one, and
// the same two deleted a failed op with one undo step per failure. Now a form says what
// its settings ARE, once, and this decides what happens to them.
//
// A plain module rather than a hook so a harness can drive it against the real stores
// (`npx vite-node scripts/batch-generate.mts`); `useBatchGenerate` in shared.tsx is the
// React wrapper.

import { useToolpathStore, beginDerivedBatch, endDerivedBatch, bufferDerived, type AddPayload, type AnyOperation } from '../../store/toolpathStore'
import { useUIStore } from '../../store/uiStore'
import { isWorkCancelled } from '../../workers/workerClient'
import { generateOperation, showGenNotes } from '../../cam/opJob'
import { stopsSoFar } from '../../workers/abortGeneration'
import { entryHintAt } from '../../cam/startOptimizer'

/** One thing to cut: a path, or a boundary with its islands. */
export interface BatchItem {
  /** What the form session remembers the op by — the path (or boundary) id. */
  key: string
  /** The op's name, used when it is created and when a New-mode Generate updates it. */
  name: string
  /** Fields that belong to this item rather than to the form: `pathId`, `islandIds`. */
  fields: Record<string, unknown>
  /** Edit mode: the batch member already cutting this item. Absent = added to the batch. */
  op?: AnyOperation
}

/** The slice of `useSessionOps()` a Generate needs. */
export interface BatchSession {
  liveOpId: (key: string) => string | undefined
  remember: (key: string, opId: string) => void
  forget: (keys: string[]) => void
}

export interface BatchGenerateArgs {
  type: AddPayload['type']
  /** The form's settings — written to every op in the batch, new or existing. */
  settings: Record<string, unknown>
  items: BatchItem[]
  session: BatchSession
  /** Edit mode: the op the form was opened on. Its batch is what `items` revise. */
  editOp?: AnyOperation
  /** Edit mode: ops of the batch whose paths the selection dropped. */
  dropIds?: string[]
  /**
   * New mode: ops this session made that the current reading of the selection no longer
   * has (Pocket's Invert toggle turns every boundary into an island). They are replaced
   * by the new ones in one step rather than left behind as a second set.
   */
  replace?: { opId: string; key: string }[]
  /** Generate one op. Defaults to `generateOperation`; Pocket passes its Alt-click override. */
  run?: (opId: string) => Promise<void>
  /** Reports a failed op; `useGenerateError`'s `report`. */
  onError: (opId: string, err: unknown) => void
}

const newPayload = (a: BatchGenerateArgs, it: BatchItem): AddPayload =>
  ({ name: it.name, type: a.type, ...a.settings, ...it.fields }) as AddPayload

/**
 * Create or update the batch's operations and generate them one by one, in item order.
 *
 * - A cancel abandons the rest of the Generate; the ops keep their slots (marked
 *   needs-update by the cancel) and are remembered, so Generate picks them back up.
 * - A failure is reported and the loop carries on. An op THIS click created that failed
 *   is removed again at the end — an operation with no toolpath is not a thing in the
 *   document — but one that already existed keeps its slot and its error.
 */
export async function runBatchGenerate(a: BatchGenerateArgs): Promise<void> {
  const store = () => useToolpathStore.getState()
  const run = a.run ?? ((id: string) => generateOperation(id).then(({ notes }) => showGenNotes(notes)))
  const createdIds: string[] = []
  let batching = false
  const stopsAtStart = stopsSoFar()
  try {
    // (op id, fields to write before generating) in cut order.
    let jobs: { opId: string; write: Record<string, unknown> }[]

    if (a.editOp) {
      // Paths the selection added to the batch, or took out of it, land HERE — on the
      // Regenerate click, in one store action — and never while the selection is made.
      const kept = a.items.filter((it) => it.op)
      const added = a.items.filter((it) => !it.op)
      const dropIds = a.dropIds ?? []
      let addedIds: string[] = []
      if (dropIds.length > 0 || added.length > 0) {
        addedIds = store().reviseBatchPaths({
          anchorId: a.editOp.id, deleteIds: dropIds, add: added.map((it) => newPayload(a, it)),
        })
      }
      const live = new Set(store().operations.map((o) => o.id))
      jobs = [
        ...kept.map((it) => ({ opId: it.op!.id, write: { ...a.settings, ...it.fields } })),
        ...added.flatMap((it, i) => live.has(addedIds[i]) ? [{ opId: addedIds[i], write: { ...a.settings, ...it.fields } }] : []),
      ]
      // The chip that opened the form may be the one just deselected. Re-anchor on a member
      // that still exists, or the form falls back to "New …" holding a selection it has
      // already cut.
      if (dropIds.includes(a.editOp.id) && jobs.length > 0) {
        useUIStore.getState().setRequestEditOpId(jobs[0].opId)
      }
    } else {
      // Every new op goes in ONE store call: a Generate over several paths is one decision,
      // so it is one undo step carrying one batchId — which is what lets editing it later
      // cover all of them at once. Re-Generate on an item this form already generated
      // updates that op in place.
      const existing = a.items.map((it) => a.session.liveOpId(it.key))
      const payloads = a.items.flatMap((it, i) => existing[i] ? [] : [newPayload(a, it)])
      const replace = a.replace ?? []
      // Paths ADDED to the selection after this form already generated JOIN that batch:
      // it is still one decision, and the Objects strip draws one chip per batch — a
      // second addOperations here gave the same five profiles two chips, "×2" and "×3".
      const anchor = existing.find((id) => id !== undefined)
      const newIds = replace.length > 0
        ? store().replaceGeneratedOperations({ anchorId: replace[0].opId, deleteIds: replace.map((r) => r.opId), add: payloads })
        : anchor && payloads.length > 0
          ? store().reviseBatchPaths({ anchorId: anchor, deleteIds: [], add: payloads })
          : store().addOperations(payloads)
      if (replace.length > 0) a.session.forget(replace.map((r) => r.key))
      let next = 0
      jobs = a.items.map((it, i) => {
        const had = existing[i]
        if (had) return { opId: had, write: { name: it.name, ...a.settings, ...it.fields } }
        const opId = newIds[next++]
        a.session.remember(it.key, opId)
        createdIds.push(opId)
        return { opId, write: {} } // created from these very settings a moment ago
      })
    }

    // ONE store write for the whole batch's settings and status, and the toolpaths as a
    // derived batch (toolpathStore): writing each op as it went repainted every toolpath on
    // the canvas once per op, which over a few hundred labels was most of the Generate.
    // Writing every op's settings up front changes nothing a generation reads — an op's
    // start height looks only at the ops BEFORE it, whose settings it always saw written.
    const live = new Set(store().operations.map((o) => o.id))
    jobs = jobs.filter((j) => live.has(j.opId))
    store().updateOperations(jobs.map(({ opId, write }) =>
      ({ id: opId, updates: { ...write, status: 'generating' } as Partial<AnyOperation> })))
    beginDerivedBatch()
    batching = true
    for (const { opId } of jobs) {
      // Stopped while no job was in a worker to be terminated: what has not started yet
      // is left needs-update, exactly as a stop mid-job leaves it.
      if (stopsSoFar() !== stopsAtStart) {
        const left = jobs.slice(jobs.findIndex((j) => j.opId === opId)).map((j) => ({ id: j.opId, updates: { status: 'needs-update' } as Partial<AnyOperation> }))
        store().updateOperations(left, { record: false })
        break
      }
      // Chain to where the previous operation finishes, at generation time — read through
      // the buffer, since that op's toolpath may not have been written yet.
      bufferDerived(opId, { entryHint: entryHintAt(opId) })
      try {
        // Generated from the settings just written — the same call an automatic
        // regenerate makes (cam/opJob), so the two cannot drift.
        await run(opId)
      } catch (err) {
        if (isWorkCancelled(err)) break
        a.onError(opId, err)
      }
    }
  } finally {
    if (batching) endDerivedBatch()
    discardFailedOps(createdIds)
  }
}

/** Delete the ops among `createdIds` that ended in error — in one step. */
export function discardFailedOps(createdIds: string[]) {
  if (createdIds.length === 0) return
  const { operations, deleteOperations } = useToolpathStore.getState()
  const failed = createdIds.filter((id) => operations.find((o) => o.id === id)?.status === 'error')
  if (failed.length > 0) deleteOperations(failed)
}
