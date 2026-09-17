// ─── Profile form ─────────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, PathRevisionHint, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, LengthInput, FormError, useGenerateError } from './shared'
import { reviseBatch } from './reviseBatch'
import { type StartFrom } from '../../cam/startHeight'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type CutSide, type AnyOperation, type ProfileOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { isWorkCancelled } from '../../workers/workerClient'
import { generateOperation } from '../../cam/opJob'
import { entryHintAt } from '../../cam/startOptimizer'
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
  const addOperations = useToolpathStore((s) => s.addOperations)
  const updateOperation = useToolpathStore((s) => s.updateOperation)
  const deleteOperation = useToolpathStore((s) => s.deleteOperation)
  const reviseBatchPaths = useToolpathStore((s) => s.reviseBatchPaths)
  const operations = useToolpathStore((s) => s.operations)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
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
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
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
  // Outside cuts reach a full diameter past the path (radius of offset + radius of tool),
  // centerline half that, inside not at all. An allowance moves the toolpath further off
  // the line on its own side, so it adds to an outside cut's reach — and a NEGATIVE one
  // on an inside cut can carry the tool past the line, which is the only way an inside
  // cut has any reach at all.
  const cutMarginMM = form.side === 'outside' ? Math.max(0, (selectedTool?.diameterMM ?? 0) + form.allowanceMM)
    : form.side === 'centerline' ? (selectedTool?.diameterMM ?? 0) / 2
    : Math.max(0, -form.allowanceMM)
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
    setGenerating(true)
    clearError()
    let failed = false
    try {
      if (editOp) {
        // Paths the selection added to this batch, or took out of it, land HERE — on the
        // Regenerate click, in one store action — and never while the selection is made.
        let pairs = rev.keep
        if (rev.drop.length > 0 || rev.add.length > 0) {
          const newIds = reviseBatchPaths({
            anchorId: editOp.id,
            deleteIds: rev.drop.map((e) => e.op.id),
            add: rev.add.map((path) => ({
              name: `Profile: ${path.name} (${tool.name})`,
              type: 'profile' as const,
              toolId: form.toolId,
              pathId: path.id,
              side: form.side,
              depthMM: form.depthMM,
              stepDownMM: form.stepDownMM,
              direction: form.direction,
              rampIn: form.rampIn,
              allowanceMM: form.allowanceMM,
              startFrom: form.startFrom,
            })),
          })
          const live = useToolpathStore.getState().operations
          pairs = [...rev.keep, ...rev.add.flatMap((path, i) => {
            const op = live.find((o) => o.id === newIds[i]) as ProfileOperation | undefined
            return op ? [{ op, path }] : []
          })]
        }
        for (const { op } of pairs) {
          // Chain to where the previous operation finishes, at generation time.
          const hint = entryHintAt(op.id)
          updateOperation(op.id, {
            entryHint: hint,
            toolId: form.toolId, side: form.side, depthMM: form.depthMM,
            stepDownMM: form.stepDownMM, direction: form.direction, rampIn: form.rampIn,
            allowanceMM: form.allowanceMM,
            startFrom: form.startFrom, status: 'generating',
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
        // The chip that opened this form may be the one just deselected. Re-anchor on a
        // member that still exists, or the form falls back to "New Profile" holding a
        // selection it has already cut.
        if (rev.drop.some((e) => e.op.id === editOp.id) && pairs.length > 0) {
          useUIStore.getState().setRequestEditOpId(pairs[0].op.id)
        }
      } else {
        // One addOperations call for the whole selection: one timeline chip, one shared
        // batchId, and therefore one thing to edit later.
        const newPayloads: Parameters<typeof addOperations>[0] = []
        const slots = selectedPaths.map((path) => {
          // Re-Generate on a path this form already generated updates that op in place.
          const existingId = session.liveOpId(path.id)
          if (existingId) return existingId
          return newPayloads.push({
            name: `Profile: ${path.name} (${tool.name})`,
            type: 'profile',
            toolId: form.toolId,
            pathId: path.id,
            side: form.side,
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            direction: form.direction,
            rampIn: form.rampIn,
            allowanceMM: form.allowanceMM,
            startFrom: form.startFrom,
          }) - 1
        })
        const newIds = addOperations(newPayloads)
        for (let pi = 0; pi < selectedPaths.length; pi++) {
          const path = selectedPaths[pi]
          const slot = slots[pi]
          const existingId = typeof slot === 'string' ? slot : undefined
          const opId = existingId ?? newIds[slot as number]
          const name = `Profile: ${path.name} (${tool.name})`
          const hint = entryHintAt(opId)
          updateOperation(opId, existingId ? {
            entryHint: hint,
            name, toolId: form.toolId, side: form.side, depthMM: form.depthMM,
            stepDownMM: form.stepDownMM, direction: form.direction, rampIn: form.rampIn,
            allowanceMM: form.allowanceMM,
            startFrom: form.startFrom, status: 'generating',
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
      if (!failed) { save('profile', form) }
    }
  }

  return (
    <FormShell title={editOp ? `Edit Profile${selectedPaths.length > 1 ? ` — ${selectedPaths.length} paths` : ''}` : 'New Profile'} onClose={onClose}>
      {selectedPaths.length === 0 && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a path first'}</p>
      )}
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
      <div className="flex items-center gap-2">
        <input type="checkbox" id="profile-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="profile-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-600 dark:text-neutral-400 normal-case">(2× dia, 50% feed)</span>
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
