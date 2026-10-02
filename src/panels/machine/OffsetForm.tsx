// ─── Offset form ──────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToggleRow, GenerateBtn, LengthInput, CheckRow } from './shared'
import { useMemo, useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import type { OffsetCornerStyle } from '../../tools/offsetOp'
import { applyScaleOffset, isExactGap } from '../../tools/scaleOffset'
import { OFFSETTABLE_SHAPES } from '../../tools/shapeOffset'
import { planOffset, planFields, type OffsetFormState, type OffsetPlan } from '../../tools/offsetPlan'
import type { ShapeParams } from '../../shapes/shapeGenerators'
import { useWorkpieceStore, fmtLen, lenValue } from '../../store/workpieceStore'
import { nextPathColor, type PathDefinition } from '../../importers/svgImporter'
import { uid } from '../../uid'

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
    // An offset saved before generated shapes kept their parameters was an outline,
    // so it reopens as one: Update must not quietly turn it into something else.
    if (defParams) return { distanceMM: defParams.distanceMM, cornerStyle: defParams.cornerStyle, keepShape: defParams.keepShape ?? false, keepGenerated: defParams.keepGenerated ?? false }
    if (editCtx) return { distanceMM: 5, cornerStyle: 'miter', keepShape: false, keepGenerated: true }
    const saved = load('offset') as Partial<OffsetFormState> | null
    return {
      distanceMM: saved?.distanceMM ?? 5,
      cornerStyle: saved?.cornerStyle ?? 'miter',
      keepShape: saved?.keepShape ?? false,
      keepGenerated: saved?.keepGenerated ?? true,
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

  // Keep shape's distance is a MEAN, so the form says what gap it really leaves — the
  // smallest and largest over every source — before anything is applied.
  const units = useWorkpieceStore((s) => s.units)
  const sourceKey = sourcePaths.map((p) => p.d).join('\n')
  // What every source becomes, worked out live so the form can say it before Apply.
  const plans = useMemo(
    () => sourcePaths.map((p) => ({ path: p, plan: planOffset(p, form) })),
    [form, sourceKey], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const anyGenerated = sourcePaths.some((p) => p.shapeParams && OFFSETTABLE_SHAPES.has(p.shapeParams.type))
  // The outline settings only matter to the sources that come out as outlines — and Keep
  // shape only to the plain ones among them (see planOffset).
  const isOutline = (plan: OffsetPlan | null) => !plan || plan.kind === 'outline'
  const anyPlain = sourcePaths.some((p) => !p.shapeParams)
  const anyCornered = plans.some(({ path, plan }) => isOutline(plan) && (path.shapeParams || !form.keepShape))
  const namesOf = (kind: OffsetPlan['kind']) =>
    plans.filter(({ plan }) => plan?.kind === kind).map(({ path }) => path.name).join(', ')

  const gapRange = useMemo(() => {
    if (!form.keepShape || form.distanceMM === 0) return null
    let lo = Infinity, hi = -Infinity
    for (const { path } of plans) {
      if (path.shapeParams) continue   // not scaled by Keep shape — see planOffset
      const r = applyScaleOffset(path.d, form.distanceMM)
      if (!r) return 'unreachable' as const
      lo = Math.min(lo, r.minGapMM); hi = Math.max(hi, r.maxGapMM)
    }
    return isFinite(lo) ? { lo, hi } : null
  }, [form.keepShape, form.distanceMM, plans])
  const scaledGap = (() => {
    const s = plans.flatMap(({ plan }) => plan?.kind === 'scaled' ? [plan] : [])
    if (s.length === 0) return null
    return { lo: Math.min(...s.map((p) => p.minGapMM!)), hi: Math.max(...s.map((p) => p.maxGapMM!)) }
  })()

  function up<K extends keyof OffsetFormState>(k: K, v: OffsetFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  const noGeometry = (src: ImportedPath) => form.keepGenerated && src.shapeParams && OFFSETTABLE_SHAPES.has(src.shapeParams.type)
    ? `${src.name} cannot be inset that far`
    : form.keepShape && !src.shapeParams
      ? `${src.name} cannot shrink that far by scaling`
      : `Offset produced no geometry for ${src.name}`

  function handleApply() {
    setError(null)

    if (editCtx) {
      // Rework in place: recompute each result from its source and restamp the
      // definition with the new parameters. No chip to amend — the chip shows
      // that an offset happened, the objects carry what it was.
      const updates: { id: string; d: string; definition: PathDefinition; shapeParams: ShapeParams | null; fields: Omit<ImportedPath, 'id'> }[] = []
      for (const pair of livePairs) {
        const src = paths.find((p) => p.id === pair.sourceId)!
        const plan = planOffset(src, form)
        if (!plan) { setError(noGeometry(src)); return }
        const { id: _id, ...old } = paths.find((p) => p.id === pair.resultId)!
        const fields = planFields(plan)
        updates.push({
          id: pair.resultId, d: plan.d,
          definition: { id: editCtx.defId, kind: 'offset', sourceId: pair.sourceId, ...form },
          shapeParams: fields.shapeParams ?? null,
          fields: { ...old, ...fields },
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
      const plan = planOffset(p, form)
      if (!plan) continue
      newPaths.push({
        id: uid('path-offset'), name: `${p.name} offset`, d: plan.d, visible: true, color: nextPathColor(),
        ...planFields(plan),
        definition: { id: defId, kind: 'offset', sourceId: p.id, ...form },
      })
    }
    if (newPaths.length === 0) { setError(sourcePaths.length === 1 ? noGeometry(sourcePaths[0]) : 'Offset produced no geometry'); return }
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
      {anyGenerated && (
        <div className="space-y-0.5">
          <CheckRow id="offset-keep-generated" checked={form.keepGenerated} onChange={(v) => up('keepGenerated', v)}
            label="Keep generated shapes" hint="new parameters, still editable" />
          {form.keepGenerated && (
            <div className="text-label text-gray-600 dark:text-neutral-400 space-y-0.5">
              {namesOf('exact') && <p>{namesOf('exact')} — exact</p>}
              {namesOf('near') && <p>{namesOf('near')} — straight edges exact, curves follow the shape</p>}
              {namesOf('scaled') && scaledGap && <p>{namesOf('scaled')} — scaled, gap {lenValue(scaledGap.lo, units)}–{fmtLen(scaledGap.hi, units)}</p>}
            </div>
          )}
        </div>
      )}
      {anyPlain && <>
      <CheckRow id="offset-keep-shape" checked={form.keepShape} onChange={(v) => up('keepShape', v)}
        label="Keep shape" hint="scale to an average gap" />
      {form.keepShape && (
        gapRange === 'unreachable'
          ? <p className="text-label text-amber-600 dark:text-amber-400">Cannot shrink that far by scaling</p>
          : gapRange && <p className="text-label text-gray-600 dark:text-neutral-400">
              {isExactGap(gapRange.lo, gapRange.hi)
                ? <>Gap {fmtLen((gapRange.lo + gapRange.hi) / 2, units)} everywhere — exact</>
                : <>Gap {lenValue(gapRange.lo, units)}–{fmtLen(gapRange.hi, units)} — not exact, use a plain offset for clearances</>}
            </p>
      )}
      </>}
      {anyCornered && (
        <ToggleRow label="Corner Style" options={['miter', 'round', 'square'] as OffsetCornerStyle[]} value={form.cornerStyle} onChange={(v) => up('cornerStyle', v)} />
      )}
      {error && <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label={editCtx ? 'Update Offset' : 'Apply Offset'} />
    </FormShell>
  )
}
