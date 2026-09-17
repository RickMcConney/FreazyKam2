// ─── Boolean form ────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToggleRow, GenerateBtn } from './shared'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { regenerateAffected } from '../../cam/regenerate'
import { applyBooleanOp, type BooleanOpType } from '../../tools/booleanOps'
import { nextPathColor } from '../../importers/svgImporter'
import { uid } from '../../uid'

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
  const applyPathEdit = usePathsStore((s) => s.applyPathEdit)
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
    const result = applyBooleanOp(form.opType, sourcePaths.map((p) => p.d))
    if ('error' in result) { setError(result.error); return }
    if (!result.resultD) { setError('Result is empty'); return }
    const label = form.opType.charAt(0).toUpperCase() + form.opType.slice(1)

    if (editCtx && def) {
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
      return
    }

    const newPath = {
      id: uid('path-bool'),
      name: `${label} result`,
      d: result.resultD,
      visible: true,
      color: nextPathColor(),
      definition: {
        id: uid('def'), kind: 'boolean' as const,
        op: form.opType, sourceIds: sourcePaths.map((p) => p.id),
      },
    }
    // ONE atomic edit (= one timeline chip, one undo step): add the result,
    // soft-hide the source paths, select the result.
    applyPathEdit({
      gesture: 'boolean',
      add: [newPath],
      updates: sourcePaths.map((p) => ({ id: p.id, d: p.d, hidden: true })),
      selectAfter: [newPath.id],
    })
    save('boolean', form)
  }

  return (
    <FormShell title={editCtx ? 'Edit Boolean' : 'Boolean'} onClose={onClose}>
      <div>
        <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          {editCtx ? 'Source paths' : <>Paths {sourcePaths.length > 0 && <span className="normal-case text-gray-500 dark:text-neutral-400">({sourcePaths.length} selected)</span>}</>}
        </div>
        {canApply ? (
          <div className="space-y-0.5">
            {sourcePaths.map((p, i) => (
              <PathChip key={p.id} path={p} label={i === 0
                ? (form.opType === 'subtract' ? 'primary (kept)' : 'primary')
                : (form.opType === 'subtract' ? 'tool (cut away)' : 'operand')} />
            ))}
          </div>
        ) : (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> {editCtx ? 'Source paths no longer exist' : 'Select 2 or more paths first'}
          </p>
        )}
        {editCtx && !resultExists && (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1 mt-1"><AlertCircle size={ICON.sm} /> Result path no longer exists</p>
        )}
      </div>
      <ToggleRow label="Operation" options={['union', 'intersect', 'subtract'] as BooleanOpType[]} value={form.opType} onChange={(v) => setForm((f) => ({ ...f, opType: v }))} />
      {error && <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn
        disabled={!canApply || (!!editCtx && !resultExists)}
        generating={false}
        onClick={handleApply}
        label={editCtx ? 'Update Boolean' : 'Apply Boolean'}
      />
    </FormShell>
  )
}
