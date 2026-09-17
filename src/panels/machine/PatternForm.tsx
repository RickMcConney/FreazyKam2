// ─── Pattern form ─────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToggleRow, GenerateBtn } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import type { PathDefinition } from '../../importers/svgImporter'
import { useUIStore } from '../../store/uiStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import { useWorkpieceStore, fromMM, toMM } from '../../store/workpieceStore'
import { computePatternInstances, patternCopies, type PatternParams } from '../../tools/patternOp'
import { uid } from '../../uid'

interface PatternLinParams { rows: number; cols: number; xSpacingMM: number; ySpacingMM: number }
interface PatternCirParams { count: number; radiusMM: number; startAngleDeg: number; endAngleDeg: number; rotateItems: boolean }
interface PatternFormState {
  mode: 'linear' | 'circular'
  linParams: PatternLinParams
  cirParams: PatternCirParams
}

// Edit mode (pattern-chip click): recompute the pattern from its sources with
// new parameters. Identified by the DEFINITION id every copy of one Apply
// shares; the sources and parameters come back off the live paths. Result ids
// are reused index-by-index so ops on existing copies survive count changes
// where possible — and the copies are found in the DOCUMENT rather than in the
// chip's recorded snapshot, so one deleted by hand is not resurrected.
export interface PatternEditCtx {
  defId: string
}

export function PatternForm({ onClose, editCtx }: { onClose: () => void; editCtx?: PatternEditCtx }) {
  const paths = usePathsStore((s) => s.paths)
  const addPaths = usePathsStore((s) => s.addPaths)
  const selPaths = useSelectedPaths()
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
  const units = useWorkpieceStore((s) => s.units)

  const defPaths = editCtx ? paths.filter((p) => p.definition?.id === editCtx.defId) : []
  const def0 = defPaths.find((p) => p.definition?.kind === 'pattern')?.definition
  const defParams = def0?.kind === 'pattern' ? def0 : null

  const [form, setForm] = useState<PatternFormState>(() => {
    const saved = load('pattern') as Partial<PatternFormState> | null
    const base: PatternFormState = {
      mode: saved?.mode ?? 'linear',
      linParams: saved?.linParams ?? { rows: 2, cols: 3, xSpacingMM: 20, ySpacingMM: 20 },
      cirParams: saved?.cirParams ?? { count: 6, radiusMM: 30, startAngleDeg: 0, endAngleDeg: 360, rotateItems: true },
    }
    if (defParams) {
      const p = defParams.params
      if (p.type === 'linear') {
        return { ...base, mode: 'linear', linParams: { rows: p.rows, cols: p.cols, xSpacingMM: p.xSpacingMM, ySpacingMM: p.ySpacingMM } }
      }
      return { ...base, mode: 'circular', cirParams: { count: p.count, radiusMM: p.radiusMM, startAngleDeg: p.startAngleDeg, endAngleDeg: p.endAngleDeg, rotateItems: p.rotateItems } }
    }
    return base
  })
  const [error, setError] = useState<string | null>(null)

  const selectedPaths = defParams
    ? defParams.sourceIds.flatMap((id) => { const p = paths.find((x) => x.id === id); return p ? [p] : [] })
    : editCtx ? [] : selPaths
  const canApply = selectedPaths.length >= 1

  function upLin<K extends keyof PatternLinParams>(k: K, v: PatternLinParams[K]) {
    setForm((f) => ({ ...f, linParams: { ...f.linParams, [k]: v } }))
  }
  function upCir<K extends keyof PatternCirParams>(k: K, v: PatternCirParams[K]) {
    setForm((f) => ({ ...f, cirParams: { ...f.cirParams, [k]: v } }))
  }

  function handleApply() {
    setError(null)
    const params: PatternParams = form.mode === 'linear'
      ? { type: 'linear' as const, ...form.linParams }
      : { type: 'circular' as const, ...form.cirParams }
    const instances = computePatternInstances(params)
    if (instances.length === 0) { setError('Pattern produced no instances'); return }
    const instancesToCreate = form.mode === 'linear' ? instances.slice(1) : instances
    // A COPY IS THE SHAPE IT WAS COPIED FROM. patternCopies carries the whole
    // identity across — parameters, placement, the shared groupId that makes a
    // train track's body, grooves and treads ONE part — with a fresh group per
    // instance so patterning a group does not grow the group being patterned.
    // Without it the copies were loose outlines, and nesting a patterned track
    // laid every groove out as a part of its own.
    const defs = patternCopies(selectedPaths, instancesToCreate)
    if (defs.length === 0) { setError('Pattern produced no geometry'); return }

    if (editCtx && defParams) {
      // Rework in place: reuse existing result ids by index (ops on surviving
      // copies keep working), add/remove for count changes, restamp the
      // definition. The existing copies come from the live document, so one the
      // user deleted by hand stays deleted instead of being recreated from a
      // chip's snapshot of how things once were.
      const definition: PathDefinition = { id: editCtx.defId, kind: 'pattern', sourceIds: defParams.sourceIds, params }
      const oldPaths = defPaths
      // The copy is rebuilt from the sources, so it REPLACES the old one wholly
      // rather than having new geometry dropped into it: a reworked spacing moves
      // the copy, and its parameters and placement have to move with it or the
      // shape snaps back to where the first Apply put it the moment any parameter
      // is stepped. Only the id survives, which is what keeps existing operations
      // on a copy pointing at it.
      const newPaths: ImportedPath[] = defs.map((def, i) => oldPaths[i]
        ? { ...oldPaths[i], ...def, definition }
        : { ...def, id: uid('path-pattern'), definition })
      const deleteIds = oldPaths.slice(defs.length).map((p) => p.id)
      usePathsStore.getState().rewriteGeneratedRaw({
        updates: newPaths.slice(0, Math.min(oldPaths.length, defs.length))
          .map((p) => ({ id: p.id, d: p.d, name: p.name, definition, fields: p })),
        add: newPaths.slice(oldPaths.length),
        deleteIds,
      })
      usePathsStore.getState().setSelectedIds(newPaths.map((p) => p.id))
      regenerateAffectedMany(newPaths.map((p) => p.id))
      useUIStore.getState().showStatus('Pattern updated', 'info')
      save('pattern', form)
      return
    }

    const definition: PathDefinition = {
      id: uid('def'), kind: 'pattern', sourceIds: selectedPaths.map((p) => p.id), params,
    }
    const newPaths: ImportedPath[] = defs.map((def) => ({
      ...def,
      id: uid('path-pattern'),
      definition,
    }))
    addPaths(newPaths, { source: 'pattern' })
    save('pattern', form)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'
  const u = units

  return (
    <FormShell title={editCtx ? 'Edit Pattern' : 'Pattern'} onClose={onClose}>
      <div>
        <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          {editCtx ? 'Source paths' : 'Paths'}
        </div>
        {canApply ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p) => <PathChip key={p.id} path={p} label={editCtx ? 'source' : 'selected'} />)}
          </div>
        ) : (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> {editCtx ? 'Source paths no longer exist' : 'Select a path first'}
          </p>
        )}
      </div>
      <ToggleRow label="Mode" options={['linear', 'circular'] as const} value={form.mode} onChange={(v) => setForm((f) => ({ ...f, mode: v }))} />
      {form.mode === 'linear' ? (
        <div className="grid grid-cols-2 gap-2">
          {([
            ['Rows', form.linParams.rows, (v: number) => upLin('rows', Math.max(1, Math.round(v))), 1, 1, ''],
            ['Cols', form.linParams.cols, (v: number) => upLin('cols', Math.max(1, Math.round(v))), 1, 1, ''],
            ['X Gap', fromMM(form.linParams.xSpacingMM, u as 'mm' | 'in'), (v: number) => upLin('xSpacingMM', toMM(v, u as 'mm' | 'in')), 0, u === 'in' ? 0.0625 : 1, u],
            ['Y Gap', fromMM(form.linParams.ySpacingMM, u as 'mm' | 'in'), (v: number) => upLin('ySpacingMM', toMM(v, u as 'mm' | 'in')), 0, u === 'in' ? 0.0625 : 1, u],
          ] as [string, number, (v: number) => void, number, number, string][]).map(([lbl, val, fn, min, step, suffix]) => (
            <div key={lbl}>
              <label htmlFor="pattern-f2" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">{lbl}</label>
              <NumericInput id="pattern-f2" value={val} min={min} step={step} unit={suffix || undefined}
                onChange={fn}
                className={inputCls} />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {([
              ['Count', form.cirParams.count, (v: number) => upCir('count', Math.max(2, Math.round(v))), 2, 1, ''],
              ['Radius', fromMM(form.cirParams.radiusMM, u as 'mm' | 'in'), (v: number) => upCir('radiusMM', toMM(v, u as 'mm' | 'in')), 0.1, u === 'in' ? 0.0625 : 1, u],
              ['Start°', form.cirParams.startAngleDeg, (v: number) => upCir('startAngleDeg', v), -360, 5, '°'],
              ['End°',   form.cirParams.endAngleDeg,   (v: number) => upCir('endAngleDeg', v),   -360, 5, '°'],
            ] as [string, number, (v: number) => void, number, number, string][]).map(([lbl, val, fn, min, step, suffix]) => (
              <div key={lbl}>
                <label htmlFor="pattern-f3" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">{lbl}</label>
                <NumericInput id="pattern-f3" value={val} min={min} step={step} unit={suffix || undefined}
                  onChange={fn}
                  className={inputCls} />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="pattern-rotate" checked={form.cirParams.rotateItems}
              onChange={(e) => upCir('rotateItems', e.target.checked)} className="accent-blue-500" />
            <label htmlFor="pattern-rotate" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">Items face outward</label>
          </div>
        </div>
      )}
      {error && <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label={editCtx ? 'Update Pattern' : 'Apply Pattern'} />
    </FormShell>
  )
}
