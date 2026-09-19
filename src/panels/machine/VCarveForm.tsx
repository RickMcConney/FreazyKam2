// ─── V-Carve form ────────────────────────────────────────────────────────────
import { FormShell, ToolSelector, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, LengthInput, FormError, useBatchGenerate, generateLabel, NoPathBanner, BatchPathList } from './shared'
import { type StartFrom } from '../../cam/startHeight'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, batchOf, type VCarveOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { includedAngleDeg, isVCutter, tipBallRadiusMM, toolRadiusAtHeight } from '../../cam/geom'
import { groupPathsByContainment } from './containment'
import { reviseGroupBatch } from './reviseBatch'

interface VCarveFormState {
  toolId: string
  maxDepthMM: number
  startFrom: StartFrom
}

export function VCarveForm({ onClose, editOp }: { onClose: () => void; editOp?: VCarveOperation }) {
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

  // Only a tapered wall carves a V: the cone angle IS the op, and Generate below is already
  // gated on it. The list used to fall back to every tool when the library had no V-bit,
  // which offered drills for a cut they can't make. A taper qualifies — it is the same cone
  // with a ball on the tip, so a stroke narrower than the tip comes out round-bottomed
  // instead of pointed rather than being cut wrong.
  const vbits = toolsOfType(tools, ['vbit', 'taper'])
  const defaultTool = vbits[0]
  const [form, setForm] = useState<VCarveFormState>(() => {
    const base = editOp
      ? { toolId: editOp.toolId, maxDepthMM: editOp.maxDepthMM, startFrom: editOp.startFrom ?? { mode: 'stock' as const } }
      : { ...mergeWithDefaults(load('vcarve'), {
          toolId: defaultTool?.id ?? '',
          // Default to the full stock thickness; the tool's max Z is only a warning.
          maxDepthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
          // Deliberately not carried over from the saved defaults — see PocketForm.
          startFrom: { mode: 'auto' } as StartFrom,
        }, tools), startFrom: { mode: 'auto' as const } }
    return { ...base, toolId: pickToolId(base.toolId, vbits) }
  })
  const { generating, errorMsg, generate } = useBatchGenerate('vcarve', 'vcarve')
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click — see PocketForm.
  const editBatch = editOp ? (batchOf(editOp, operations) as VCarveOperation[]) : []
  const editGroups = editBatch.flatMap((op) => {
    const boundary = paths.find((p) => p.id === op.pathId)
    return boundary
      ? [{ op, boundary, islands: paths.filter((p) => op.islandIds.includes(p.id)) }]
      : []
  })
  // While a batch is open for editing the canvas selection is the set of paths it carves,
  // re-read for boundaries and islands by the same containment rule the first Generate
  // used — see PocketForm and reviseGroupBatch.
  const rev = reviseGroupBatch(editGroups, editOp ? selPaths : [], (sel) => groupPathsByContainment(sel))
  const editRevised = [
    ...rev.keep.map((k) => ({ op: k.member.op as VCarveOperation | undefined, boundary: k.group.boundary, islands: k.group.islands })),
    ...rev.add.map((g) => ({ op: undefined as VCarveOperation | undefined, boundary: g.boundary, islands: g.islands })),
  ]
  const groups = editOp
    ? editRevised
    : groupPathsByContainment(selPaths).map((g) => ({ ...g, op: undefined }))
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // Angle always comes from the selected bit — it's a property of the grind, not the op.
  // includedAngleDeg normalises the two conventions the library stores (a V-bit's included
  // angle, a taper's per-side), so everything downstream sees one meaning.
  const angleDeg = selectedTool ? includedAngleDeg(selectedTool) : 60
  const tipDiaMM = selectedTool ? 2 * tipBallRadiusMM(selectedTool) : 0
  // Margin 0: a v-carve is bounded by the outline it carves — the widest part of the cone
  // lands ON the outline, never outside it.
  // See PocketForm: ops this session already generated are not cuts preceding themselves.
  const selfOpId = editOp?.id ?? session.firstLiveOpId()
  const startZ = useStartZ(form.startFrom, groups[0]?.boundary.d ?? '', 0, selfOpId)
  const updating = !editOp && groups.length > 0 && groups.every(({ boundary }) => session.liveOpId(boundary.id))

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId }))
  }

  function up<K extends keyof VCarveFormState>(k: K, v: VCarveFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (groups.length === 0 || !selectedTool) return
    const tool = selectedTool
    await generate({
      settings: { toolId: form.toolId, angleDeg, maxDepthMM: form.maxDepthMM, startFrom: form.startFrom },
      // islandIds rides on every write, not only a revision: a kept boundary whose island
      // set changed keeps its operation, and this is the only thing about it that moves.
      items: groups.map(({ boundary, islands, op }) => ({
        key: boundary.id, op, name: `V-Carve: ${boundary.name} (${tool.name})`,
        fields: { pathId: boundary.id, islandIds: islands.map((p) => p.id) },
      })),
      session, editOp, dropIds: rev.drop.map((m) => m.op.id),
    }, form)
  }

  return (
    <FormShell title={editOp ? `Edit V-Carve${groups.length > 1 ? ` — ${groups.length} paths` : ''}` : 'New V-Carve'} onClose={onClose}>
      {groups.length === 0 && <NoPathBanner editing={!!editOp} closed />}
      <ToolSelector tools={vbits} value={form.toolId} onChange={handleToolChange} />
      {(!selectedTool || !isVCutter(selectedTool)) && (
        <p className="text-label text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.xs} /> V-Carve requires a V-bit or taper tool.
        </p>
      )}
      {selectedTool && isVCutter(selectedTool) && (
        <p className="text-label text-gray-600 dark:text-neutral-400">
          {selectedTool.type === 'taper'
            ? `Taper: ${selectedTool.vbitAngleDeg ?? 5}° per side, Ø${fmtLen(tipDiaMM, units)} tip (set on tool)`
            : `V-bit angle: ${angleDeg}° (set on tool)`}
        </p>
      )}
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={selfOpId} />
      <div>
        <label htmlFor="vcarve-max-depth" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Max Depth</label>
        <LengthInput id="vcarve-max-depth" valueMM={form.maxDepthMM} minMM={0.1} stepMM={0.5}
          onChangeMM={(v) => up('maxDepthMM', v)} />
        {/* Reach from stock top: starting on a pocket floor adds that much to the total. */}
        {selectedTool && form.maxDepthMM - startZ.zMM > selectedTool.maxDepthMM && (
          <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Exceeds tool Max Z ({fmtLen(selectedTool.maxDepthMM, units)})
          </p>
        )}
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
          Cuts at most {fmtLen(selectedTool ? 2 * toolRadiusAtHeight(selectedTool, form.maxDepthMM) : 0, units)} wide at full depth.
        </p>
      </div>
      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={groups.length === 0 || !selectedTool || generating || form.maxDepthMM <= 0 || !isVCutter(selectedTool)}
        generating={generating}
        onClick={handleGenerate}
        label={generateLabel(!!editOp, updating)}
      />
      <BatchPathList groups={groups} addedIds={rev.addedIds} removed={rev.removed} editing={!!editOp} />
    </FormShell>
  )
}
