// ─── Trochoidal form ──────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, PathRevisionHint, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, toolsOfType, pickToolId, LengthInput, FormError, useGenerateError } from './shared'
import { reviseBatch } from './reviseBatch'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type CutSide, type AnyOperation, type TrochoidalOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { isWorkCancelled } from '../../workers/workerClient'
import { generateOperation } from '../../cam/opJob'
import { entryHintAt } from '../../cam/startOptimizer'
import { trochoidalEngagementFraction, seedStepDownMM } from '../../cam/feeds'

interface TrochoidalFormState {
  toolId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  trochStepMM: number
  trochRadiusMM: number
  finishingPass: boolean
  rampIn: boolean
}

export function TrochoidalForm({ onClose, editOp }: { onClose: () => void; editOp?: TrochoidalOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const paths = usePathsStore((s) => s.paths)
  // PICK ORDER, not z-order: operations are cut in the order they were created
  // (see cam/startOptimizer), so the order the paths were clicked in IS the order the
  // machine will run them. Selecting three circles 1, 2, 3 cuts them 1, 2, 3.
  const selPaths = useSelectedPathsInOrder()
  const addOperations = useToolpathStore((s) => s.addOperations)
  const updateOperation = useToolpathStore((s) => s.updateOperation)
  const deleteOperation = useToolpathStore((s) => s.deleteOperation)
  const reviseBatchPaths = useToolpathStore((s) => s.reviseBatchPaths)
  const operations = useToolpathStore((s) => s.operations)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const units = useWorkpieceStore((s) => s.units)

  // Trochoidal cuts the whole width with the side of the tool — a drill can't, and a
  // V-bit's width changes with depth, so the trochoid radius wouldn't mean anything.
  const cutters = toolsOfType(tools, ['endmill', 'ballnose'])
  const defaultTool = cutters[0]
  const [form, setForm] = useState<TrochoidalFormState>(() => {
    const base = editOp ? {
      toolId: editOp.toolId, side: editOp.side, depthMM: editOp.depthMM,
      stepDownMM: editOp.stepDownMM, direction: editOp.direction,
      trochStepMM: editOp.trochStepMM, trochRadiusMM: editOp.trochRadiusMM,
      finishingPass: editOp.finishingPass, rampIn: editOp.rampIn ?? false,
    } : mergeWithDefaults(load('trochoidal'), {
      toolId: defaultTool?.id ?? '',
      side: 'outside' as CutSide,
      // Default to the full stock thickness; the tool's max Z is only a warning.
      depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
      stepDownMM: seedStepDownMM(defaultTool),
      direction: 'climb' as CuttingDirection,
      trochStepMM: (defaultTool?.diameterMM ?? 6) * 0.15,
      trochRadiusMM: (defaultTool?.diameterMM ?? 6) * 0.5,
      finishingPass: true,
      rampIn: false,
    }, tools)
    return { ...base, toolId: pickToolId(base.toolId, cutters) }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click — see PocketForm.
  const editBatch = editOp ? (batchOf(editOp, operations) as TrochoidalOperation[]) : []
  const editPairs = editBatch.flatMap((op) => {
    const path = paths.find((p) => p.id === op.pathId)
    return path ? [{ op, path }] : []
  })
  // While a batch is open for editing the canvas selection is the set of paths it cuts —
  // see ProfileForm and reviseBatch. Only the Regenerate click below acts on it.
  const rev = reviseBatch(editPairs, (e) => e.path, editOp ? selPaths : [])
  const selectedPaths = editOp ? [...rev.keep.map((e) => e.path), ...rev.add] : selPaths
  const addedIds = new Set(rev.add.map((p) => p.id))
  const selectedTool = tools.find((t) => t.id === form.toolId)
  const updating = !editOp && selectedPaths.length > 0 && selectedPaths.every((p) => session.liveOpId(p.id))

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({
      ...f, toolId,
      stepDownMM: seedStepDownMM(t),
      trochStepMM: parseFloat((t.diameterMM * 0.15).toFixed(3)),
      trochRadiusMM: parseFloat((t.diameterMM * 0.5).toFixed(3)),
    }))
  }

  function up<K extends keyof TrochoidalFormState>(k: K, v: TrochoidalFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (selectedPaths.length === 0 || !selectedTool) return
    const tool = selectedTool
    setGenerating(true)
    clearError()
    let failed = false
    try {
      if (editOp) {
        // Paths the selection added to this batch, or took out of it, land HERE — on the
        // Regenerate click, in one store action. See ProfileForm.
        let pairs = rev.keep
        if (rev.drop.length > 0 || rev.add.length > 0) {
          const newIds = reviseBatchPaths({
            anchorId: editOp.id,
            deleteIds: rev.drop.map((e) => e.op.id),
            add: rev.add.map((path) => ({
              name: `Trochoidal: ${path.name} (${tool.name})`,
              type: 'trochoidal' as const,
              toolId: form.toolId,
              pathId: path.id,
              side: form.side,
              depthMM: form.depthMM,
              stepDownMM: form.stepDownMM,
              direction: form.direction,
              trochStepMM: form.trochStepMM,
              trochRadiusMM: form.trochRadiusMM,
              finishingPass: form.finishingPass,
              rampIn: form.rampIn,
            })),
          })
          const live = useToolpathStore.getState().operations
          pairs = [...rev.keep, ...rev.add.flatMap((path, i) => {
            const op = live.find((o) => o.id === newIds[i]) as TrochoidalOperation | undefined
            return op ? [{ op, path }] : []
          })]
        }
        for (const { op } of pairs) {
          // Chain to where the previous operation finishes, at generation time.
          const hint = entryHintAt(op.id)
          updateOperation(op.id, {
            entryHint: hint,
            toolId: form.toolId, side: form.side, depthMM: form.depthMM,
            stepDownMM: form.stepDownMM, direction: form.direction,
            trochStepMM: form.trochStepMM, trochRadiusMM: form.trochRadiusMM,
            finishingPass: form.finishingPass, rampIn: form.rampIn, status: 'generating',
          } as Partial<AnyOperation>)
          try {
            // Generated from the settings just written — the same call an automatic
            // regenerate makes (cam/opJob), so the two cannot drift.
            await generateOperation(op.id)
          } catch (err) {
            // A cancel abandons the whole Generate, not just this path.
            if (isWorkCancelled(err)) break
            reportError(op.id, err)
            failed = true
          }
        }
        // See ProfileForm: the chip that opened this form may be the one just deselected.
        if (rev.drop.some((e) => e.op.id === editOp.id) && pairs.length > 0) {
          useUIStore.getState().setRequestEditOpId(pairs[0].op.id)
        }
      } else {
        // One addOperations call for the whole selection — see PocketForm.
        const newPayloads: Parameters<typeof addOperations>[0] = []
        const slots = selectedPaths.map((path) => {
          const existingId = session.liveOpId(path.id)
          if (existingId) return existingId
          return newPayloads.push({
            name: `Trochoidal: ${path.name} (${tool.name})`,
            type: 'trochoidal',
            toolId: form.toolId,
            pathId: path.id,
            side: form.side,
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            direction: form.direction,
            trochStepMM: form.trochStepMM,
            trochRadiusMM: form.trochRadiusMM,
            finishingPass: form.finishingPass,
            rampIn: form.rampIn,
          }) - 1
        })
        const newIds = addOperations(newPayloads)
        for (let pi = 0; pi < selectedPaths.length; pi++) {
          const path = selectedPaths[pi]
          const slot = slots[pi]
          const existingId = typeof slot === 'string' ? slot : undefined
          const opId = existingId ?? newIds[slot as number]
          const name = `Trochoidal: ${path.name} (${tool.name})`
          const hint = entryHintAt(opId)
          updateOperation(opId, existingId ? {
            entryHint: hint,
            name, toolId: form.toolId, side: form.side, depthMM: form.depthMM,
            stepDownMM: form.stepDownMM, direction: form.direction,
            trochStepMM: form.trochStepMM, trochRadiusMM: form.trochRadiusMM,
            finishingPass: form.finishingPass, rampIn: form.rampIn, status: 'generating',
          } as Partial<AnyOperation> : { entryHint: hint, status: 'generating' })
          try {
            await generateOperation(opId)
            if (!existingId) session.remember(path.id, opId)
          } catch (err) {
            // Cancelled ops keep their slot (cancelGenerating marks them needs-update)
            // rather than being deleted — Generate again picks them straight back up.
            if (isWorkCancelled(err)) break
            // A Generate that failed leaves nothing behind: an operation with no
            // toolpath is not a thing in the document, so one this click CREATED is
            // removed again. One that already existed keeps its slot and its error —
            // deleting a user's operation because a re-Generate failed would be worse
            // than leaving it there to be fixed.
            reportError(opId, err)
            if (!existingId) deleteOperation(opId)
            failed = true
          }
        }
      }
    } finally {
      setGenerating(false)
      if (!failed) { save('trochoidal', form) }
    }
  }

  return (
    <FormShell title={editOp ? `Edit Trochoidal${selectedPaths.length > 1 ? ` — ${selectedPaths.length} paths` : ''}` : 'New Trochoidal'} onClose={onClose}>
      {selectedPaths.length === 0 && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a path first'}</p>
      )}
      <ToolSelector tools={cutters} value={form.toolId} onChange={handleToolChange} />
      <ToggleRow label="Cut Side" options={['inside', 'outside', 'centerline'] as CutSide[]} value={form.side} onChange={(v) => up('side', v)} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool}
        engagementFraction={selectedTool ? trochoidalEngagementFraction(selectedTool, form.trochStepMM) : undefined} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="troch-loop-amplitude" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Loop Amplitude</label>
          <LengthInput id="troch-loop-amplitude" valueMM={form.trochRadiusMM} minMM={0.1} stepMM={0.1}
            onChangeMM={(v) => up('trochRadiusMM', v)} />
        </div>
        <div>
          <label htmlFor="troch-step-loop" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Step / Loop</label>
          <LengthInput id="troch-step-loop" valueMM={form.trochStepMM} minMM={0.01} stepMM={0.05}
            onChangeMM={(v) => up('trochStepMM', v)} />
        </div>
      </div>
      <p className="text-label text-gray-600 dark:text-neutral-400 -mt-1">
        Cuts {fmtLen(form.trochRadiusMM * 2, units)} wide · {selectedTool ? Math.round(form.trochStepMM / selectedTool.diameterMM * 100) : '—'}% tool dia per loop
      </p>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="troch-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="troch-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-600 dark:text-neutral-400 normal-case">(spiral down over 2× dia, 50% feed)</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="troch-finishing" checked={form.finishingPass}
          onChange={(e) => up('finishingPass', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="troch-finishing" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Finishing pass <span className="text-gray-600 dark:text-neutral-400 normal-case">(clean sweep after loops)</span>
        </label>
      </div>
      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={selectedPaths.length === 0 || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
      />
      {/* Below the button — see PathListSection. */}
      <PathListSection count={selectedPaths.length}>
        {selectedPaths.map((p, i) => (
          <PathChip key={p.id} path={p} index={selectedPaths.length > 1 ? i + 1 : undefined}
            state={addedIds.has(p.id) ? 'added' : undefined} />
        ))}
        {rev.drop.map(({ path }) => <PathChip key={path.id} path={path} state="removed" />)}
        {editOp && <PathRevisionHint added={rev.add.length} removed={rev.drop.length} />}
      </PathListSection>
    </FormShell>
  )
}
