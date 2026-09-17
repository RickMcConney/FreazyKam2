// ─── Offset form ──────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToggleRow, GenerateBtn, LengthInput } from './shared'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import { applyOffset, type OffsetCornerStyle } from '../../tools/offsetOp'
import { nextPathColor, type PathDefinition } from '../../importers/svgImporter'
import { uid } from '../../uid'

interface OffsetFormState {
  distanceMM: number
  cornerStyle: OffsetCornerStyle
}

// Edit mode (offset-chip click): recompute the SAME offset paths from their
// sources with new parameters. Identified by the DEFINITION id every result of
// one Apply shares — the pairs and the parameters are read back off the live
// paths, so what is reworked is what is actually in the document rather than a
// snapshot taken when the chip was recorded.
export interface OffsetEditCtx {
  defId: string
}

export function OffsetForm({ onClose, editCtx }: { onClose: () => void; editCtx?: OffsetEditCtx }) {
  const paths = usePathsStore((s) => s.paths)
  const addPaths = usePathsStore((s) => s.addPaths)
  const selPaths = useSelectedPaths()
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)

  // Every path this definition produced, and the parameters it was produced with.
  const defPaths = editCtx ? paths.filter((p) => p.definition?.id === editCtx.defId) : []
  const def0 = defPaths.find((p) => p.definition?.kind === 'offset')?.definition
  const defParams = def0?.kind === 'offset' ? def0 : null

  const [form, setForm] = useState<OffsetFormState>(() => {
    if (defParams) return { distanceMM: defParams.distanceMM, cornerStyle: defParams.cornerStyle }
    if (editCtx) return { distanceMM: 5, cornerStyle: 'miter' }
    const saved = load('offset') as { distanceMM?: number; cornerStyle?: OffsetCornerStyle } | null
    return {
      distanceMM: saved?.distanceMM ?? 5,
      cornerStyle: saved?.cornerStyle ?? 'miter',
    }
  })
  const [error, setError] = useState<string | null>(null)

  const livePairs = defPaths.flatMap((p) => {
    const def = p.definition
    return def?.kind === 'offset' && paths.some((q) => q.id === def.sourceId)
      ? [{ sourceId: def.sourceId, resultId: p.id }]
      : []
  })
  const sourcePaths = editCtx
    ? livePairs.flatMap((pair) => { const p = paths.find((x) => x.id === pair.sourceId); return p ? [p] : [] })
    : selPaths
  const canApply = editCtx ? livePairs.length >= 1 : sourcePaths.length >= 1

  function up<K extends keyof OffsetFormState>(k: K, v: OffsetFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleApply() {
    setError(null)

    if (editCtx) {
      // Rework in place: recompute each result from its source and restamp the
      // definition with the new parameters. No chip to amend — the chip shows
      // that an offset happened, the objects carry what it was.
      const updates: { id: string; d: string; definition: PathDefinition }[] = []
      for (const pair of livePairs) {
        const src = paths.find((p) => p.id === pair.sourceId)!
        const d = applyOffset(src.d, { distanceMM: form.distanceMM, cornerStyle: form.cornerStyle })
        if (!d) { setError(`Offset produced no geometry for ${src.name}`); return }
        updates.push({
          id: pair.resultId, d,
          definition: { id: editCtx.defId, kind: 'offset', sourceId: pair.sourceId, ...form },
        })
      }
      usePathsStore.getState().rewriteGeneratedRaw({ updates })
      regenerateAffectedMany(updates.map((u) => u.id))
      useUIStore.getState().showStatus('Offset updated', 'info')
      save('offset', form)
      return
    }

    const defId = uid('def')
    const newPaths: ImportedPath[] = []
    for (const p of sourcePaths) {
      const resultD = applyOffset(p.d, { distanceMM: form.distanceMM, cornerStyle: form.cornerStyle })
      if (!resultD) continue
      newPaths.push({
        id: uid('path-offset'), name: `${p.name} offset`, d: resultD, visible: true, color: nextPathColor(),
        definition: { id: defId, kind: 'offset', sourceId: p.id, ...form },
      })
    }
    if (newPaths.length === 0) { setError('Offset produced no geometry'); return }
    addPaths(newPaths, { source: 'offset' })
    usePathsStore.getState().setSelectedIds(newPaths.map((p) => p.id))
    save('offset', form)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'

  return (
    <FormShell title={editCtx ? 'Edit Offset' : 'Offset'} onClose={onClose}>
      <div>
        <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          {editCtx ? 'Source paths' : 'Paths'}
        </div>
        {canApply ? (
          <div className="space-y-0.5">
            {sourcePaths.map((p) => <PathChip key={p.id} path={p} label={editCtx ? 'source' : 'selected'} />)}
          </div>
        ) : (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> {editCtx ? 'Source or result paths no longer exist' : 'Select a path first'}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="offset-distance" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Distance</label>
        <LengthInput id="offset-distance" valueMM={form.distanceMM} stepMM={0.5}
          onChangeMM={(v) => up('distanceMM', v)} className={inputCls} />
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">Positive = outset, negative = inset</p>
      </div>
      <ToggleRow label="Corner Style" options={['miter', 'round', 'square'] as OffsetCornerStyle[]} value={form.cornerStyle} onChange={(v) => up('cornerStyle', v)} />
      {error && <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label={editCtx ? 'Update Offset' : 'Apply Offset'} />
    </FormShell>
  )
}
