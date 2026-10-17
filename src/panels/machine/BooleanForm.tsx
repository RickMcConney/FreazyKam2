// ─── Boolean form ────────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, ToggleRow, GenerateBtn } from './shared'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { regenerateAffected } from '../../cam/regenerate'
import { applyBooleanOp, type BooleanOpType } from '../../tools/booleanOps'
import { booleanLabel, createBoolean } from '../../tools/pathToolActions'

interface BooleanFormState {
  opType: BooleanOpType
}

// Edit mode (boolean-chip click): rework an EXISTING boolean in place — same
// sources, new op type — rather than creating a second result. The result path
// carries which boolean it was and what it was made from, so that is what is
// read and restamped.
export interface BooleanEditCtx {
  resultId: string
}

export function BooleanForm({ onClose, editCtx }: { onClose: () => void; editCtx?: BooleanEditCtx }) {
  const paths = usePathsStore((s) => s.paths)
  // In PICK order: subtract keeps the first and cuts the rest away from it, so
  // z-order would subtract the wrong way round as often as not.
  const selPaths = useSelectedPathsInOrder()
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)

  const resultPath = editCtx ? paths.find((p) => p.id === editCtx.resultId) : undefined
  const def = resultPath?.definition?.kind === 'boolean' ? resultPath.definition : null

  const [form, setForm] = useState<BooleanFormState>(() => {
    if (def) return { opType: def.op }
    if (editCtx) return { opType: 'union' }
    const saved = load('boolean') as { opType?: BooleanOpType } | null
    return { opType: saved?.opType ?? 'union' }
  })
  const [error, setError] = useState<string | null>(null)

  const sourcePaths = def
    ? def.sourceIds.flatMap((id) => { const p = paths.find((x) => x.id === id); return p ? [p] : [] })
    : editCtx ? [] : selPaths
  const canApply = sourcePaths.length >= 2
  const resultExists = !editCtx || !!resultPath

  function handleApply() {
    setError(null)
    if (!editCtx || !def) {
      const r = createBoolean(sourcePaths, form.opType)
      if ('error' in r) { setError(r.error); return }
      save('boolean', form)
      return
    }
    const result = applyBooleanOp(form.opType, sourcePaths.map((p) => p.d))
    if ('error' in result) { setError(result.error); return }
    if (!result.resultD) { setError('Result is empty'); return }
    const label = booleanLabel(form.opType)

    // Rework in place: rewrite the live result path and restamp which boolean
    // it now is — no new event, no new chip.
    usePathsStore.getState().rewriteGeneratedRaw({
      updates: [{
        id: editCtx.resultId, d: result.resultD, name: `${label} result`,
        definition: { ...def, op: form.opType },
      }],
    })
    regenerateAffected(editCtx.resultId)
    useUIStore.getState().showStatus(`Boolean reworked as ${label}`, 'info')
    save('boolean', form)
  }

  return (
    <FormShell title={editCtx ? 'Edit Boolean' : 'Boolean'} onClose={onClose}>
      {!canApply && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.sm} /> {editCtx ? 'Source paths no longer exist' : 'Select 2 or more paths first'}
        </p>
      )}
      {editCtx && !resultExists && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Result path no longer exists</p>
      )}
      <ToggleRow label="Operation" options={['union', 'intersect', 'subtract'] as BooleanOpType[]} value={form.opType} onChange={(v) => setForm((f) => ({ ...f, opType: v }))} />
      {error && <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn
        disabled={!canApply || (!!editCtx && !resultExists)}
        generating={false}
        onClick={handleApply}
        label={editCtx ? 'Update Boolean' : 'Apply Boolean'}
      />
      {/* Below the button, where every form keeps its path list (PathListSection). */}
      {/* Not gated on canApply: a selection clicked down to one path must still list the
          one clicked out, or it could not be clicked back in. */}
      <PathListSection count={sourcePaths.length} toggle={!def && !editCtx}>
        {sourcePaths.map((p, i) => (
          <PathChip key={p.id} path={p} label={i === 0
            ? (form.opType === 'subtract' ? 'primary (kept)' : 'primary')
            : (form.opType === 'subtract' ? 'tool (cut away)' : 'operand')} />
        ))}
      </PathListSection>
    </FormShell>
  )
}
