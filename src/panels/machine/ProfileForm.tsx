// ─── Profile form ─────────────────────────────────────────────────────────────
import { FormShell, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, LengthInput, FormError, useBatchGenerate, generateLabel, NoPathBanner, CheckRow, BatchPathList } from './shared'
import { reviseBatch } from './reviseBatch'
import { type StartFrom, profileCutMarginMM } from '../../cam/startHeight'
import { useState } from 'react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type CutSide, type ProfileOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { seedStepDownMM } from '../../cam/feeds'
import { maxCutRadiusMM, toolRadiusAtHeight } from '../../cam/geom'

interface ProfileFormState {
  toolId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  rampIn: boolean
  allowanceMM: number
  startFrom: StartFrom
}

export function ProfileForm({ onClose, editOp }: { onClose: () => void; editOp?: ProfileOperation }) {
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

  // A profile follows the path with the side of the tool, so it needs a side-cutting
  // edge — a drill has none. Tapered tools stay: the taper hint below explains the
  // wall a V-bit or ball nose leaves.
  const cutters = toolsOfType(tools, ['endmill', 'ballnose', 'vbit', 'taper'])
  const defaultTool = cutters[0]
  const [form, setForm] = useState<ProfileFormState>(() => {
    const base = editOp ? {
      toolId: editOp.toolId, side: editOp.side, depthMM: editOp.depthMM,
      stepDownMM: editOp.stepDownMM, direction: editOp.direction, rampIn: editOp.rampIn ?? false,
      allowanceMM: editOp.allowanceMM ?? 0,
      // Legacy ops stay on stock top — see PocketForm.
      startFrom: editOp.startFrom ?? { mode: 'stock' },
    } : { ...mergeWithDefaults(load('profile'), {
      toolId: defaultTool?.id ?? '',
      side: 'outside' as CutSide,
      // A profile typically cuts the part free, so default to the full stock
      // thickness rather than the tool's max flute depth.
      depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
      stepDownMM: seedStepDownMM(defaultTool),
      direction: 'climb' as CuttingDirection,
      rampIn: false,
      allowanceMM: 0,
      // Deliberately not carried over from the saved defaults — see PocketForm.
      startFrom: { mode: 'auto' } as StartFrom,
    }, tools), startFrom: { mode: 'auto' } as StartFrom }
    return { ...base, toolId: pickToolId(base.toolId, cutters) }
  })
  const { generating, errorMsg, generate } = useBatchGenerate('profile', 'profile')
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click — profiling five
  // selected paths at once is one decision, so changing the depth afterwards is one edit.
  const editBatch = editOp ? (batchOf(editOp, operations) as ProfileOperation[]) : []
  const editPairs = editBatch.flatMap((op) => {
    const path = paths.find((p) => p.id === op.pathId)
    return path ? [{ op, path }] : []
  })
  // While a batch is open for editing, the canvas selection is the set of paths it
  // covers — shift-click one in, shift-click one out. Only the Regenerate click below
  // acts on it; an empty selection means the user clicked away, not that the batch
  // should be emptied. See reviseBatch.
  const rev = reviseBatch(editPairs, (e) => e.path, editOp ? selPaths : [])
  const selectedPaths = editOp ? [...rev.keep.map((e) => e.path), ...rev.add] : selPaths
  const addedIds = new Set(rev.add.map((p) => p.id))
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // How far the tool reaches past the path — the same definition the stamp and the
  // staleness check use, so the start height previewed here is the one generated.
  const cutMarginMM = profileCutMarginMM(form.side, selectedTool, form.allowanceMM)
  // See PocketForm: ops this session already generated are not cuts preceding themselves.
  const selfOpId = editOp?.id ?? session.firstLiveOpId()
  const startZ = useStartZ(form.startFrom, selectedPaths[0]?.d ?? '', cutMarginMM, selfOpId)
  // A tapered/round tool that never reaches full diameter at this depth offsets by less
  // than its radius, so the wall it leaves is a taper that meets the path at the surface.
  // Say so — otherwise the toolpath just looks like it's in the wrong place.
  const cutRadiusMM = selectedTool ? toolRadiusAtHeight(selectedTool, form.depthMM) : 0
  // Compared against the tool's WIDEST cutting radius, not `diameterMM / 2` — a taper
  // stores its tip there, and at any depth it cuts wider than that, so the old test
  // could never fire for one.
  const profileNoun = selectedTool?.type === 'vbit' ? 'V'
    : selectedTool?.type === 'taper' ? 'taper' : 'ball'
  const taperHint = selectedTool && form.side !== 'centerline'
    && cutRadiusMM < maxCutRadiusMM(selectedTool) - 1e-6
    ? `Offset ${fmtLen(cutRadiusMM, units)} — the ${profileNoun} profile at ${fmtLen(form.depthMM, units)} deep, so the cut meets the path at the start surface and the wall below is tapered.`
    : null
  // What the allowance does to the number the calipers read. The wall moves by the
  // allowance, so the MEASURED size moves by twice it — that factor of two is the whole
  // reason this line is here, and it is what the finishing pass at 0 gives back.
  const a = form.allowanceMM
  const opening = form.side === 'inside'
  const allowanceHint = a === 0
    ? 'Stock left on the wall for a finishing pass; negative cuts past the line.'
    : a > 0
      ? `${fmtLen(a, units)} on the wall — the ${opening ? 'opening' : 'part'} cuts ${fmtLen(2 * a, units)} ${opening ? 'under' : 'over'}size until a second pass at 0 cleans it.`
      : `Cuts ${fmtLen(-a, units)} past the line — the ${opening ? 'opening' : 'part'} comes out ${fmtLen(-2 * a, units)} ${opening ? 'over' : 'under'}size.`
  const updating = !editOp && selectedPaths.length > 0 && selectedPaths.every((p) => session.liveOpId(p.id))

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: seedStepDownMM(t) }))
  }

  function up<K extends keyof ProfileFormState>(k: K, v: ProfileFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (selectedPaths.length === 0 || !selectedTool) return
    const tool = selectedTool
    const { toolId, side, depthMM, stepDownMM, direction, rampIn, allowanceMM, startFrom } = form
    const item = (path: ImportedPath, op?: ProfileOperation) =>
      ({ key: path.id, op, name: `Profile: ${path.name} (${tool.name})`, fields: { pathId: path.id } })
    await generate({
      settings: { toolId, side, depthMM, stepDownMM, direction, rampIn, allowanceMM, startFrom },
      items: editOp
        ? [...rev.keep.map(({ op, path }) => item(path, op)), ...rev.add.map((path) => item(path))]
        : selectedPaths.map((path) => item(path)),
      session, editOp, dropIds: rev.drop.map((e) => e.op.id),
    }, form)
  }

  return (
    <FormShell title={editOp ? `Edit Profile${selectedPaths.length > 1 ? ` — ${selectedPaths.length} paths` : ''}` : 'New Profile'} onClose={onClose}>
      {selectedPaths.length === 0 && <NoPathBanner editing={!!editOp} />}
      <ToolSelector tools={cutters} value={form.toolId} onChange={handleToolChange} />
      <ToggleRow label="Cut Side" options={['inside', 'outside', 'centerline'] as CutSide[]} value={form.side} onChange={(v) => up('side', v)} />
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={selfOpId} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} startZMM={startZ.zMM} />
      {taperHint && (
        <p className="text-label text-gray-500 dark:text-neutral-400 normal-case">{taperHint}</p>
      )}
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      {/* Hidden for centerline: there is no side for stock to be left on, and a field that
          silently does nothing is worse than an absent one. */}
      {form.side !== 'centerline' && (
        <div>
          <label htmlFor="profile-stock-allowance" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Stock Allowance</label>
          <LengthInput id="profile-stock-allowance" valueMM={form.allowanceMM} minMM={-5} maxMM={5} stepMM={0.05}
            onChangeMM={(v) => up('allowanceMM', v)} />
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            {allowanceHint}
          </p>
        </div>
      )}
      <CheckRow id="profile-ramp-in" checked={form.rampIn} onChange={(v) => up('rampIn', v)}
        label="Ramp In" hint="2× dia, 50% feed" />
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
