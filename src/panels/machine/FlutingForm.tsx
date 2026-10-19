// ─── Fluting form ─────────────────────────────────────────────────────────────
import { FormShell, ToolSelector, DepthRow, GenerateBtn, useSessionOps, toolsOfType, pickToolId, FormError, useBatchGenerate, generateLabel, NoPathBanner, CheckRow, BatchPathList } from './shared'
import { reviseBatch } from './reviseBatch'
import { useState } from 'react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, batchOf, type FlutingOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { seedStepDownMM } from '../../cam/feeds'
import { toolRadiusAtHeight } from '../../cam/geom'
import type { FluteBreakpoint } from '../../cam/fluting'
import { FLUTING_TOOL_TYPES, flutingFormDefaults, flutingProfileOf } from './opDefaults'
import { FluteProfileEditor } from './FluteProfileEditor'

interface FlutingFormState {
  toolId: string
  depthMM: number
  stepDownMM: number
  /** The step-down was typed over the auto one (see BaseOperation.stepDownManual). */
  stepDownManual: boolean
  profile: FluteBreakpoint[]
  smooth: boolean
  reverse: boolean
}

export function FlutingForm({ onClose, editOp }: { onClose: () => void; editOp?: FlutingOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const paths = usePathsStore((s) => s.paths)
  // PICK ORDER is cut order — see TrochoidalForm.
  const selPaths = useSelectedPathsInOrder()
  const operations = useToolpathStore((s) => s.operations)
  const load = useFormDefaultsStore((s) => s.load)
  const units = useWorkpieceStore((s) => s.units)

  const cutters = toolsOfType(tools, FLUTING_TOOL_TYPES)
  const [form, setForm] = useState<FlutingFormState>(() => {
    const base = editOp ? {
      toolId: editOp.toolId, depthMM: editOp.depthMM, stepDownMM: editOp.stepDownMM,
      stepDownManual: editOp.stepDownManual ?? false, profile: editOp.profile,
      smooth: editOp.smooth, reverse: editOp.reverse ?? false,
    } : mergeWithDefaults(load('fluting'), flutingFormDefaults(cutters[0]), tools)
    return {
      ...base, profile: flutingProfileOf(base.profile),
      stepDownManual: editOp ? base.stepDownManual : false, toolId: pickToolId(base.toolId, cutters),
    }
  })
  const { generating, errorMsg, generate } = useBatchGenerate('fluting', 'fluting')
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click — see PocketForm.
  const editBatch = editOp ? (batchOf(editOp, operations) as FlutingOperation[]) : []
  const editPairs = editBatch.flatMap((op) => {
    const path = paths.find((p) => p.id === op.pathId)
    return path ? [{ op, path }] : []
  })
  // While a batch is open for editing the canvas selection is the set of paths it cuts —
  // see ProfileForm and reviseBatch.
  const rev = reviseBatch(editPairs, (e) => e.path, editOp ? selPaths : [])
  const selectedPaths = editOp ? [...rev.keep.map((e) => e.path), ...rev.add] : selPaths
  const addedIds = new Set(rev.add.map((p) => p.id))
  const selectedTool = tools.find((t) => t.id === form.toolId)
  const updating = !editOp && selectedPaths.length > 0 && selectedPaths.every((p) => session.liveOpId(p.id))

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: seedStepDownMM(t), stepDownManual: false }))
  }

  function up<K extends keyof FlutingFormState>(k: K, v: FlutingFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (selectedPaths.length === 0 || !selectedTool) return
    const tool = selectedTool
    const { toolId, depthMM, stepDownMM, stepDownManual, profile, smooth, reverse } = form
    const item = (path: ImportedPath, op?: FlutingOperation) =>
      ({ key: path.id, op, name: `Fluting: ${path.name} (${tool.name})`, fields: { pathId: path.id } })
    await generate({
      settings: { toolId, depthMM, stepDownMM, stepDownManual, profile, smooth, reverse },
      items: editOp
        ? [...rev.keep.map(({ op, path }) => item(path, op)), ...rev.add.map((path) => item(path))]
        : selectedPaths.map((path) => item(path)),
      session, editOp, dropIds: rev.drop.map((e) => e.op.id),
    }, form)
  }

  // Width of the groove at its deepest, which is what shows on the finished face.
  const widestMM = selectedTool ? 2 * toolRadiusAtHeight(selectedTool, form.depthMM) : 0

  return (
    <FormShell title={editOp ? `Edit Fluting${selectedPaths.length > 1 ? ` — ${selectedPaths.length} paths` : ''}` : 'New Fluting'} onClose={onClose}>
      {selectedPaths.length === 0 && <NoPathBanner editing={!!editOp} />}
      <ToolSelector tools={cutters} value={form.toolId} onChange={handleToolChange} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        stepManual={form.stepDownManual} onStepManual={(v) => up('stepDownManual', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} />
      {selectedTool && (
        <p className="text-label text-gray-600 dark:text-neutral-400 -mt-1">
          Groove {fmtLen(widestMM, units)} wide at full depth
        </p>
      )}
      <FluteProfileEditor profile={form.profile} smooth={form.smooth} depthMM={form.depthMM}
        onChange={(p) => up('profile', p)} />
      <CheckRow id="flute-smooth" checked={form.smooth} onChange={(v) => up('smooth', v)}
        label="Smooth" hint="curve through the points, never past them" />
      <CheckRow id="flute-reverse" checked={form.reverse} onChange={(v) => up('reverse', v)}
        label="Reverse" hint="profile starts at the path's end" />
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
