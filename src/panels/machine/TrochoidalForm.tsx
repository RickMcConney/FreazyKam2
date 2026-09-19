// ─── Trochoidal form ──────────────────────────────────────────────────────────
import { FormShell, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, toolsOfType, pickToolId, LengthInput, FormError, useBatchGenerate, generateLabel, NoPathBanner, CheckRow, BatchPathList } from './shared'
import { reviseBatch } from './reviseBatch'
import { useState } from 'react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type CutSide, type TrochoidalOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
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
  const operations = useToolpathStore((s) => s.operations)
  const load = useFormDefaultsStore((s) => s.load)
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
  const { generating, errorMsg, generate } = useBatchGenerate('trochoidal', 'trochoidal')
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
    const { toolId, side, depthMM, stepDownMM, direction, trochStepMM, trochRadiusMM, finishingPass, rampIn } = form
    const item = (path: ImportedPath, op?: TrochoidalOperation) =>
      ({ key: path.id, op, name: `Trochoidal: ${path.name} (${tool.name})`, fields: { pathId: path.id } })
    await generate({
      settings: { toolId, side, depthMM, stepDownMM, direction, trochStepMM, trochRadiusMM, finishingPass, rampIn },
      items: editOp
        ? [...rev.keep.map(({ op, path }) => item(path, op)), ...rev.add.map((path) => item(path))]
        : selectedPaths.map((path) => item(path)),
      session, editOp, dropIds: rev.drop.map((e) => e.op.id),
    }, form)
  }

  return (
    <FormShell title={editOp ? `Edit Trochoidal${selectedPaths.length > 1 ? ` — ${selectedPaths.length} paths` : ''}` : 'New Trochoidal'} onClose={onClose}>
      {selectedPaths.length === 0 && <NoPathBanner editing={!!editOp} />}
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
      <CheckRow id="troch-ramp-in" checked={form.rampIn} onChange={(v) => up('rampIn', v)}
        label="Ramp In" hint="spiral down over 2× dia, 50% feed" />
      <CheckRow id="troch-finishing" checked={form.finishingPass} onChange={(v) => up('finishingPass', v)}
        label="Finishing pass" hint="clean sweep after loops" />
      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={selectedPaths.length === 0 || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={generateLabel(!!editOp, updating)}
      />
      <BatchPathList groups={selectedPaths.map((boundary) => ({ boundary, islands: [] }))}
        addedIds={addedIds} removed={rev.drop.map((e) => e.path)} editing={!!editOp} />
    </FormShell>
  )
}
