// ─── Nest form ────────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react'
import { AlertCircle, Loader2, Square } from 'lucide-react'
import { useGenProgressStore } from '../../store/genProgressStore'
import { FormShell, PathChip, PathListSection, ToggleRow, LengthInput, FormNotice, GenerateBtn, ToolSelector, toolsOfType, pickToolId, CheckRow, FIELD_CLS } from './shared'
import { useToolStore } from '../../store/toolStore'
import { ICON } from '../../theme'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { groupPathsForNesting } from '../../tools/nestOp'
import { useToolpathStore, pathIdsOf } from '../../store/toolpathStore'
import { NumericInput } from '../../components/NumericInput'
import { cancelWork, isWorkCancelled } from '../../workers/workerClient'
import { runNest, NEST_JOB, NEST_DEFAULTS, ROT_LABEL, rotOptionOf, FINE_ROTATION_MAX_PARTS, type NestFormState, type NestReport, type RotOption } from '../../tools/nestRun'

/**
 * Edit mode (Fill chip click): re-run a fill with new settings. Identified by the
 * DEFINITION id every copy of one fill shares; the original part and the settings
 * come back off the copies, so the form needs nothing else. The old copies — and the
 * operations made for them — are replaced in the same edit, and the definition id
 * is kept so the chip keeps its place in the strip.
 */
export interface NestEditCtx {
  defId: string
}

export function NestForm({ onClose, editCtx }: { onClose: () => void; editCtx?: NestEditCtx }) {
  const livePaths = usePathsStore((s) => s.paths)
  const selection = useSelectedPaths()
  // In edit mode the subject is the fill's ORIGINAL part, not the selection (the
  // chip selects the copies too), and the copies are what will be replaced.
  const fillCopies = useMemo(
    () => (editCtx ? livePaths.filter((p) => p.definition?.id === editCtx.defId) : []),
    [editCtx, livePaths],
  )
  const fillDef = fillCopies[0]?.definition
  const fillParams = fillDef?.kind === 'fill' ? fillDef : null
  const fillSources = useMemo(
    () => (fillParams ? fillParams.sourceIds.flatMap((id) => livePaths.filter((p) => p.id === id)) : []),
    [fillParams, livePaths],
  )
  const selPaths = editCtx ? fillSources : selection
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
  const units = useWorkpieceStore((s) => s.units)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)

  const [form, setForm] = useState<NestFormState>(() => {
    const base = { ...NEST_DEFAULTS, ...(load('nest') as Partial<NestFormState> | null) }
    if (!fillParams) return base
    const p = fillParams.params
    return {
      ...base, fillStock: true, fillCount: p.count, spacingMM: p.spacingMM, marginMM: p.marginMM,
      rotation: rotOptionOf(p.rotationStepDeg), packFrom: p.packFrom, useHoles: p.useHoles,
      avoidOthers: p.avoidOthers, sharedLines: !!p.sharedToolId, sharedToolId: p.sharedToolId ?? base.sharedToolId,
      copyToolpaths: p.copyToolpaths,
    }
  })
  // SHARED LINES: the gap IS the cutter. Two parts exactly one diameter apart have outside
  // cut paths that coincide along facing edges, which is what lets a shared-line profile
  // cut that line once. End mills only — a V-bit's or ball nose's cut width depends on depth.
  const cutters = toolsOfType(useToolStore((s) => s.tools), ['endmill'])
  const sharedTool = cutters.find((t) => t.id === pickToolId(form.sharedToolId, cutters))
  const sharing = form.sharedLines && !!sharedTool
  const gapMM = sharing ? sharedTool!.diameterMM : form.spacingMM
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<NestReport | null>(null)
  const [running, setRunning] = useState(false)
  const progress = useGenProgressStore((s) => s.byOp[NEST_JOB])

  // What will actually be moved as one piece — a gear's parts, a user group, a
  // plate and the holes drawn inside it. Worth showing before the button is
  // pressed: "9 paths → 4 parts" is the whole of what the user needs to check.
  const groups = useMemo(() => groupPathsForNesting(selPaths), [selPaths])
  const canApply = groups.length > 0 && widthMM > 0 && heightMM > 0
  const fineRotation = groups.length <= FINE_ROTATION_MAX_PARTS
  // What this nest turns parts by: the setting, held to 90° on a big nest (see above).
  const rotation: RotOption = !fineRotation && (form.rotation === '45' || form.rotation === '15') ? '90' : form.rotation
  // ONE PART, or "as many as will fit" has no answer — which of a mixed set
  // would it make more of? So the option appears only when the selection comes
  // to a single part, and a selection that grows past one turns it off rather
  // than leaving a checkbox on that does nothing.
  const canFill = groups.length === 1
  const filling = canFill && (form.fillStock || !!editCtx)
  // The operations already built on the part — what "copy toolpaths" will carry.
  // Only those built from the part ALONE: see copyOperationsForParts.
  const operations = useToolpathStore((s) => s.operations)
  const partOps = useMemo(() => {
    if (!canFill) return []
    const part = new Set(groups[0].ids)
    return operations.filter((op) => {
      const ids = pathIdsOf(op)
      return ids.length > 0 && ids.every((id) => part.has(id))
    })
  }, [canFill, groups, operations])

  const up = <K extends keyof NestFormState>(k: K, v: NestFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  function handleNest() {
    setError(null)
    setReport(null)
    if (!canApply) return
    setRunning(true)
    runNest({
      form, groups, selPaths, fillCopies, editDefId: editCtx?.defId, widthMM, heightMM, gapMM,
      sharing, sharedTool, rotation, filling,
    })
      .then((out) => {
        if ('error' in out) setError(out.error)
        else if ('report' in out) { setReport(out.report); save('nest', form) }
      })
      .catch((e) => {
        // Stopped by the user: the drawing is untouched, which is all there is to say.
        if (isWorkCancelled(e)) { useUIStore.getState().showStatus('Nest stopped — nothing moved'); return }
        setError(e instanceof Error ? e.message : 'Nesting failed')
      })
      .finally(() => setRunning(false))
  }


  return (
    <FormShell title={editCtx ? 'Edit Nest' : 'Nest'} onClose={onClose}>
      {selPaths.length > 0 ? (
        groups.length > 0 && (
          <p className="text-label text-gray-600 dark:text-neutral-400">
            {selPaths.length} path{selPaths.length === 1 ? '' : 's'} → {groups.length} part{groups.length === 1 ? '' : 's'}
          </p>
        )
      ) : (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.sm} /> {editCtx ? 'The original part of this nest has been deleted' : 'Select the paths to nest'}
        </p>
      )}

      <div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="nest-shared" checked={form.sharedLines}
            onChange={(e) => up('sharedLines', e.target.checked)} className="accent-blue-500" />
          <label htmlFor="nest-shared" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer"
            title="Place parts one cutter apart so neighbours share a cut">
            Shared lines
          </label>
        </div>
        {form.sharedLines && (
          <div className="mt-1 space-y-1">
            {cutters.length > 0
              ? <ToolSelector tools={cutters} value={sharedTool?.id ?? ''} onChange={(id) => up('sharedToolId', id)} />
              : <p className="text-body text-amber-600 dark:text-amber-400">Add an end mill to the tool library first.</p>}
            <p className="text-label text-gray-600 dark:text-neutral-400 normal-case">
              Parts are packed and then slid together until their straight edges stand exactly
              {sharedTool ? ` ${fmtLen(sharedTool.diameterMM, units)}` : ' one cutter'} apart — the
              cutter's width. Profile them outside with the same tool and Optimize Path on, and the
              line between two neighbours is cut once. Curved edges never share a line.
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="nest-spacing" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Part Gap</label>
          {sharing
            ? <p id="nest-spacing" className="text-body text-gray-700 dark:text-neutral-300 py-1">{fmtLen(gapMM, units)} (cutter)</p>
            : <LengthInput id="nest-spacing" valueMM={form.spacingMM} minMM={0} stepMM={0.5}
                onChangeMM={(mm) => up('spacingMM', mm)} />}
        </div>
        <div>
          <label htmlFor="nest-margin" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Edge Margin</label>
          <LengthInput id="nest-margin" valueMM={form.marginMM} minMM={0} stepMM={0.5}
            onChangeMM={(mm) => up('marginMM', mm)} />
        </div>
      </div>

      <div>
        <ToggleRow label="Rotation Step"
          options={fineRotation ? (['none', '90', '45', '15'] as const) : (['none', '90'] as const)}
          labels={ROT_LABEL}
          value={rotation}
          onChange={(v) => up('rotation', v)} />
        {/* "45°" reads as a LIMIT — up to 45° — and it is not one; it is the step
            of the grid of orientations a part may be turned to, so 45° allows a
            half turn and 15° allows everything 45° does. Said in the panel
            because the difference decides whether the setting looks broken. */}
        <p className="text-label text-gray-600 dark:text-neutral-400 normal-case mt-1">
          {rotation === 'none'
            ? 'Parts are turned back to the way they were drawn — for stock with a grain to follow.'
            : `Parts may be turned to any multiple of ${ROT_LABEL[rotation]}. Finer steps pack a little tighter and take longer.`}
          {!fineRotation && ` 45° and 15° are offered for up to ${FINE_ROTATION_MAX_PARTS} parts — on ${groups.length} they take several times as long for little material saved.`}
        </p>
      </div>

      <div>
        <ToggleRow label="Pack From"
          options={['left', 'bottom'] as const}
          labels={{ left: 'Left Edge', bottom: 'Bottom Edge' }}
          value={form.packFrom}
          onChange={(v) => up('packFrom', v)} />
        <p className="text-label text-gray-600 dark:text-neutral-400 normal-case mt-1">
          {form.packFrom === 'left'
            ? 'The offcut is left as a full-height strip off the end of the board.'
            : 'The offcut is left as a full-width band along the top of the stock.'}
        </p>
      </div>

      {canFill && (
        <div>
          {/* An edited fill IS a fill: there is no unticking it from here — that
              is deleting the chip. */}
          {!editCtx && (
            <div className="flex items-center gap-2">
              <input type="checkbox" id="nest-fill" checked={form.fillStock}
                onChange={(e) => up('fillStock', e.target.checked)} className="accent-blue-500" />
              <label htmlFor="nest-fill" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer"
                title="Repeat the selected part until no more will fit">
                Fill stock with copies
              </label>
            </div>
          )}
          {filling && (
            <div className="mt-1.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <label htmlFor="nest-count" className="text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider w-16 shrink-0">
                  Parts
                </label>
                <NumericInput id="nest-count" value={form.fillCount > 0 ? form.fillCount : 2} min={2} step={1} integer
                  isEmpty={form.fillCount <= 0} placeholder="as many as fit"
                  onEmpty={() => up('fillCount', 0)}
                  onChange={(v) => up('fillCount', Math.max(2, Math.round(v)))}
                  title="How many parts on the stock, the original included — leave blank to fill it"
                  className={FIELD_CLS} />
              </div>
              {partOps.length > 0 && (
                <CheckRow id="nest-copy-ops" checked={form.copyToolpaths}
                  onChange={(v) => up('copyToolpaths', v)}
                  label={`Copy its ${partOps.length} toolpath${partOps.length === 1 ? '' : 's'} to every copy`} />
              )}
            </div>
          )}
          <p className="text-label text-gray-600 dark:text-neutral-400 normal-case mt-1">
            {form.fillCount > 0
              ? `${form.fillCount} of the part, the original included, at the same gaps — fewer if the stock will not take them.`
              : 'As many copies of the part as the stock will take, at the same gaps.'}
            {' '}Each copy is an object in its own right — cut it, move it or delete it
            like any other.
            {filling && partOps.length > 0 && form.copyToolpaths
              && ' Copied toolpaths join the original\'s batch, so editing one edits them all.'}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <input type="checkbox" id="nest-holes" checked={form.useHoles}
            onChange={(e) => up('useHoles', e.target.checked)} className="accent-blue-500" />
          <label htmlFor="nest-holes" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer"
            title="Small parts may be placed in the holes of larger ones — saves material, but the offcut comes out in pieces">
            Nest inside holes
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="nest-avoid" checked={form.avoidOthers}
            onChange={(e) => up('avoidOthers', e.target.checked)} className="accent-blue-500" />
          <label htmlFor="nest-avoid" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer"
            title="Treat paths that are not selected as stock already taken">
            Avoid other paths
          </label>
        </div>
        {!filling && (
          <div className="flex items-center gap-2">
            <input type="checkbox" id="nest-sheets" checked={form.multiSheet}
              onChange={(e) => up('multiSheet', e.target.checked)} className="accent-blue-500" />
            <label htmlFor="nest-sheets" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer"
              title="Parts that will not fit go onto more sheets of the same stock, in a grid beside and below it — as square as the number of sheets allows. Each sheet is simulated and exported on its own.">
              Use more sheets
            </label>
          </div>
        )}
      </div>

      {report && (
        <p className="text-body text-gray-700 dark:text-neutral-300">
          {report.unchanged
            ? 'Already nested'
            : report.copies > 0
              ? `Filled the stock with ${report.placed} parts — ${report.copies} added`
                + (report.opsCopied > 0 ? `, with ${report.opsCopied} toolpath${report.opsCopied === 1 ? '' : 's'}` : '')
              : `Nested ${report.placed} of ${report.total}`}
          {report.sheets > 1
            ? ` on ${report.sheets} sheets — the first is ${(report.utilization * 100).toFixed(0)}% covered.`
            : <> into {fmtLen(report.usedWidthMM, units, 1)} × {fmtLen(report.usedHeightMM, units, 1)} — parts cover {(report.utilization * 100).toFixed(0)}% of the stock.</>}
          {report.unchanged && ' This is the same arrangement, so nothing moved.'}
        </p>
      )}
      <FormNotice msg={
        report && report.fillLimited
          ? `Stopped at ${report.placed} copies — the stock would take more. Select one of them and fill again for another batch.`
          : report && report.fillShort > 0
            ? `Only ${report.placed} fit on the stock — ${report.fillShort} short of the ${report.placed + report.fillShort} asked for.`
          : report && report.opsSkipped > 0
            ? `${report.opsSkipped} toolpath${report.opsSkipped === 1 ? ' was' : 's were'} not copied — an inlay is cut as a pair, so apply it to the copies yourself.`
          : report && report.unplaced > 0
            ? `${report.unplaced} part${report.unplaced === 1 ? '' : 's'} would not fit`
              + (report.sheets > 1 || form.multiSheet ? ' even on an empty sheet' : '')
              + ' — parked above the stock.'
            : null} />
      {error && (
        <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5">
          <AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}
        </p>
      )}

      {/* A nest of a hundred-odd parts at fine rotation runs for a while, and the only way
          to stop a worker mid-solve is to terminate it — cancelWork stops this nest and
          nothing else generating alongside it. Nothing has been applied until it returns,
          so a stopped nest leaves the drawing exactly as it was. */}
      {running ? (
        <div className="flex gap-1.5">
          {/* The bar: parts placed so far, and where the nest has got to (tools/nestOp
              nestSheets). Its own entry in the progress store, keyed by the nest's job. */}
          <div className="relative flex-1 min-w-0 py-1.5 rounded text-body font-medium bg-blue-600 text-white overflow-hidden flex items-center justify-center">
            {progress && (
              <span aria-hidden className="absolute inset-y-0 left-0 bg-blue-400/60 transition-[width] duration-150 ease-linear"
                style={{ width: `${Math.round(progress.frac * 100)}%` }} />
            )}
            <span className="relative flex items-center gap-1.5 truncate">
              <Loader2 size={ICON.sm} className="animate-spin shrink-0" />
              {progress ? `${progress.label ? `${progress.label} · ` : ''}${Math.round(progress.frac * 100)}%` : 'Nesting…'}
            </span>
          </div>
          <button onClick={() => cancelWork(NEST_JOB)} title="Stop this nest — nothing in the drawing moves"
            className="shrink-0 px-2.5 py-1.5 rounded text-body font-medium bg-red-600 hover:bg-red-500 text-white transition-colors flex items-center gap-1.5">
            <Square size={ICON.sm} className="fill-current" />Stop
          </button>
        </div>
      ) : (
        <GenerateBtn disabled={!canApply} generating={false} onClick={handleNest}
          label={editCtx ? 'Update Nest' : filling ? 'Fill Stock' : 'Nest on Stock'}
          title={widthMM > 0 && heightMM > 0 ? `Stock ${fmtLen(widthMM, units, 1)} × ${fmtLen(heightMM, units, 1)}` : 'Set the stock size first'} />
      )}
      {/* Below the button, where every form keeps its path list (PathListSection). */}
      <PathListSection count={selPaths.length} toggle={!editCtx}>
        {selPaths.map((p) => <PathChip key={p.id} path={p} label={editCtx ? 'original' : undefined} />)}
      </PathListSection>
    </FormShell>
  )
}
