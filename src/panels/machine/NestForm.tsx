// ─── Nest form ────────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { FormShell, PathChip, ToggleRow, LengthInput, FormNotice, GenerateBtn } from './shared'
import { ICON } from '../../theme'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, useSelectedPaths, type ImportedPath } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { applyTransformStep, placedAngleDeg, type TransformStep } from '../../canvas/selectionUtils'
import { groupPathsForNesting, nestIsStale, type NestItem } from '../../tools/nestOp'
import { copyPathsUnderSteps } from '../../tools/pathCopy'
import { uid } from '../../uid'
import { runInWorkerFor } from '../../workers/workerClient'
import type { PathUpdate } from '../../store/pathsStore'

// How finely a part may be turned. "None" is first because it is the only answer
// for stock with a grain direction or a figure to keep aligned — nesting is a
// material-saving tool, not a licence to rotate a board's worth of parts across
// the grain, and a machinist reaching for it on plywood wants a different answer
// from one reaching for it on MDF.
type RotOption = 'none' | '90' | '45' | '15'
const ROT_STEP: Record<RotOption, number> = { none: 0, '90': 90, '45': 45, '15': 15 }
const ROT_LABEL: Record<RotOption, string> = { none: 'None', '90': '90°', '45': '45°', '15': '15°' }

interface NestFormState {
  spacingMM: number
  marginMM: number
  rotation: RotOption
  packFrom: 'left' | 'bottom'
  useHoles: boolean
  avoidOthers: boolean
  /** Repeat the one selected part until the stock is full — see canFill. */
  fillStock: boolean
}

const FALLBACK: NestFormState = {
  spacingMM: 3, marginMM: 3, rotation: '90', packFrom: 'left', useHoles: false,
  avoidOthers: true, fillStock: false,
}

interface NestReport {
  placed: number
  total: number
  /** How many parts the fill pass ADDED to the document. 0 for a plain nest. */
  copies: number
  /** The fill stopped at its copy limit rather than filling the stock. */
  fillLimited: boolean
  usedWidthMM: number
  usedHeightMM: number
  utilization: number
  unplaced: number
  /** The nest came out where everything already was — see runNest. */
  unchanged: boolean
}

/**
 * How far a part already stands turned, out of its placement recipe: the angle of
 * the transformed x-axis, the same reading the Properties panel's Angle field
 * gives. Handed to the nest so its rotation grid is absolute — see
 * NestItem.currentAngleDeg.
 */
function placedAngleOf(path: { placement?: TransformStep[] } | undefined): number {
  return placedAngleDeg(path?.placement)
}

export function NestForm({ onClose }: { onClose: () => void }) {
  const selPaths = useSelectedPaths()
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
  const units = useWorkpieceStore((s) => s.units)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)

  const [form, setForm] = useState<NestFormState>(() => ({ ...FALLBACK, ...(load('nest') as Partial<NestFormState> | null) }))
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<NestReport | null>(null)
  const [running, setRunning] = useState(false)

  // What will actually be moved as one piece — a gear's parts, a user group, a
  // plate and the holes drawn inside it. Worth showing before the button is
  // pressed: "9 paths → 4 parts" is the whole of what the user needs to check.
  const groups = useMemo(() => groupPathsForNesting(selPaths), [selPaths])
  const canApply = groups.length > 0 && widthMM > 0 && heightMM > 0
  // ONE PART, or "as many as will fit" has no answer — which of a mixed set
  // would it make more of? So the option appears only when the selection comes
  // to a single part, and a selection that grows past one turns it off rather
  // than leaving a checkbox on that does nothing.
  const canFill = groups.length === 1
  const filling = canFill && form.fillStock

  const up = <K extends keyof NestFormState>(k: K, v: NestFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  function handleNest() {
    setError(null)
    setReport(null)
    if (!canApply) return
    setRunning(true)
    runNest()
      .catch((e) => setError(e instanceof Error ? e.message : 'Nesting failed'))
      .finally(() => setRunning(false))
  }

  async function runNest() {
    const paths = usePathsStore.getState().paths
    const selected = new Set(selPaths.map((p) => p.id))
    // Read BEFORE the await, and the updates below are built from this snapshot:
    // the nest is a transform per part, so it has to be applied to the geometry
    // it was computed from. That also means an edit made to a nested part while the
    // worker ran would be silently REVERTED — the update writes the snapshot's `d`
    // back — so the result is checked against the live store before it lands (below).
    // A path deleted meanwhile simply drops out (the `if (!path) continue`).
    const byIdPre = new Map(paths.map((p) => [p.id, p]))
    const epoch = useProjectStore.getState().documentEpoch
    const items: NestItem[] = groups.map((g, i) => ({
      id: `g${i}`,
      rings: g.rings,
      currentAngleDeg: placedAngleOf(byIdPre.get(g.ids[0])),
    }))

    // Anything NOT being nested but still on the stock is stock that is already
    // spoken for. Optional because the reverse case exists too — a border or a
    // background outline drawn over the whole sheet would otherwise leave
    // nowhere at all to put anything.
    //
    // THROUGH THE SAME GROUPING AS THE SELECTION, which is not a tidiness point.
    // A hole is a region an item's rings enclose an even number of times, so a
    // ring and the circle drawn inside it are only a hole once they are ONE item
    // — and taking obstacles a path at a time made each of them its own filled
    // disc instead. The effect was that "nest inside holes" worked on a part in
    // the selection and silently did not on the identical part left out of it.
    const obstacles = form.avoidOthers
      ? groupPathsForNesting(paths.filter((p) => !selected.has(p.id) && p.visible && !p.hidden))
          .map((g) => g.rings)
          .filter((rings) => rings.length > 0)
      : undefined

    // ON A WORKER, like every other long solve in the app. The nest rasterizes
    // the whole stock once per part per orientation, so a sheet of nineteen
    // tracks at 15° is seconds of straight-line arithmetic — on the UI thread
    // that is the browser's "page unresponsive" dialog, which is exactly what it
    // put up. Nothing here touches the DOM or the stores, so it moves across
    // whole: rings in, transforms out.
    const result = await runInWorkerFor(undefined, 'nest', items, {
      sheetWidthMM: widthMM,
      sheetHeightMM: heightMM,
      spacingMM: form.spacingMM,
      marginMM: form.marginMM,
      rotationStepDeg: ROT_STEP[form.rotation],
      packFrom: form.packFrom,
      useHoles: form.useHoles,
      obstacles,
      fill: filling,
    })

    // THE DRAWING MAY HAVE MOVED ON while the worker ran. Paths are replaced, never
    // mutated, so a nested part that is not the same object any more was edited — a
    // drag, a point edit, a parameter step — and applying the nest to the snapshot
    // would throw that edit away. With "avoid other paths" on, ANY path edit can have
    // moved an obstacle the nest packed around. A different document (New, Open, an
    // autosave restore) can bring the same ids back, so the epoch is checked as well.
    // Refused rather than re-based: the nest was solved for the old geometry.
    if (useProjectStore.getState().documentEpoch !== epoch
      || nestIsStale(paths, usePathsStore.getState().paths, groups.flatMap((g) => g.ids), form.avoidOthers)) {
      setError('The drawing changed while nesting — run Nest again.')
      return
    }

    const onStock = result.placements.filter((p) => p.onStock)
    if (onStock.length === 0) {
      setError(
        obstacles?.length
          ? 'Nothing fits on the stock — try a smaller spacing or margin, or turn off "Avoid other paths".'
          : 'Nothing fits on the stock — try a smaller spacing or margin, or larger stock.',
      )
      return
    }

    // ONE batch, so the whole nest is one undo step. Each part carries its own
    // recipe (`transforms`), which is what keeps a rotated shape's parameters
    // alive: applyPathEdit spills a rotation into the placement rather than
    // baking it away — see store/CLAUDE.md.
    const byId = byIdPre
    const updates: PathUpdate[] = []
    const add: ImportedPath[] = []
    let rotated = false
    for (const pl of result.placements) {
      // `g3` in a plain nest, `g3#7` when filling — the part, and which copy of
      // it. Copy 0 is the one the document already has; the rest have to be made.
      const hash = pl.id.indexOf('#')
      const g = groups[Number((hash < 0 ? pl.id : pl.id.slice(0, hash)).slice(1))]
      if (!g) continue
      const copyN = hash < 0 ? 0 : Number(pl.id.slice(hash + 1))
      const steps: TransformStep[] = []
      if (pl.angleDeg !== 0) steps.push({ kind: 'rotate', angle: pl.angleDeg, cx: pl.pivotX, cy: pl.pivotY })
      steps.push({ kind: 'translate', dx: pl.dx, dy: pl.dy })
      if (pl.angleDeg !== 0) rotated = true
      if (copyN > 0) {
        // Through the same copier the pattern tool uses, so a filled sheet of
        // train tracks is a sheet of TRACKS — each copy its own object, with its
        // own group, its parameters intact and its parts tied together. Copying
        // the geometry alone would hand the next nest thirty loose grooves.
        const sources = g.ids.flatMap((id) => { const p = byId.get(id); return p ? [p] : [] })
        for (const c of copyPathsUnderSteps(sources, steps, `${copyN + 1}`)) {
          add.push({ ...c, id: uid('path-nest') })
        }
        continue
      }
      for (const id of g.ids) {
        const path = byId.get(id)
        if (!path) continue
        // Folded here rather than through applyTransformSteps because the SIGNAL
        // matters as much as the geometry: a rotate reports `shapeParams: null`
        // to say the parameters could not absorb it, and a translate folded on
        // top of that reports `undefined`, which reads as "nothing to say" and
        // would leave a turned shape with parameters describing it unturned.
        let d = path.d
        let shapeParams = path.shapeParams
        let spilled = false
        for (const step of steps) {
          const r = applyTransformStep({ d, shapeParams, placement: path.placement }, step)
          if (r.shapeParams === null) spilled = true
          d = r.d
          shapeParams = r.shapeParams ?? undefined
        }
        updates.push({ id, d, shapeParams: spilled ? null : shapeParams, transforms: steps })
      }
    }
    if (updates.length === 0 && add.length === 0) return

    // NESTING THE SAME PARTS TWICE MUST BE ALLOWED TO CHANGE NOTHING, and must
    // SAY so. The nest is decided by the parts' shapes, not by where they happen
    // to be lying, so a second run with the same settings lands them exactly
    // where the first one did — which from the outside is indistinguishable from
    // a button that did not work, and was read as one. Writing it as an edit
    // anyway would be worse: an undo step that undoes nothing visible.
    const unchanged = add.length === 0 && result.placements.every(
      (pl) => Math.abs(pl.angleDeg) < 1e-6 && Math.abs(pl.dx) < 1e-4 && Math.abs(pl.dy) < 1e-4,
    )
    if (!unchanged) {
      // Moves and copies in ONE edit, so one undo takes the fill back off the
      // stock whole. The copies join the selection, which is what makes a second
      // Nest press mean "re-nest this sheet" rather than "nest one part among a
      // crowd of obstacles it cannot get past".
      usePathsStore.getState().applyPathEdit({
        updates,
        add,
        gesture: rotated ? 'transform' : 'move',
        ...(add.length > 0
          ? { label: 'Fill stock', selectAfter: [...updates.map((u) => u.id), ...add.map((p) => p.id)] }
          : {}),
      })
    }
    setReport({
      placed: onStock.length,
      total: filling ? onStock.length : items.length,
      copies: add.length,
      fillLimited: result.fillLimited === true,
      usedWidthMM: result.usedWidthMM,
      usedHeightMM: result.usedHeightMM,
      utilization: result.utilization,
      unplaced: result.unplacedIds.length,
      unchanged,
    })
    useUIStore.getState().showStatus(
      unchanged
        ? 'Already nested — nothing moved'
        : filling
          ? `Filled the stock with ${onStock.length} part${onStock.length === 1 ? '' : 's'} — ${add.length} added`
          : `Nested ${onStock.length} of ${items.length} part${items.length === 1 ? '' : 's'}`,
      result.unplacedIds.length > 0 ? 'warn' : 'info',
    )
    save('nest', form)
  }

  return (
    <FormShell title="Nest" onClose={onClose}>
      <div>
        <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Paths{groups.length > 0 && (
            <span className="normal-case text-gray-500 dark:text-neutral-400">
              {' '}({selPaths.length} → {groups.length} part{groups.length === 1 ? '' : 's'})
            </span>
          )}
        </div>
        {selPaths.length > 0 ? (
          <div className="space-y-0.5 max-h-40 overflow-y-auto">
            {selPaths.map((p) => <PathChip key={p.id} path={p} />)}
          </div>
        ) : (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> Select the paths to nest
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="nest-spacing" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Part Gap</label>
          <LengthInput id="nest-spacing" valueMM={form.spacingMM} minMM={0} stepMM={0.5}
            onChangeMM={(mm) => up('spacingMM', mm)} />
        </div>
        <div>
          <label htmlFor="nest-margin" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Edge Margin</label>
          <LengthInput id="nest-margin" valueMM={form.marginMM} minMM={0} stepMM={0.5}
            onChangeMM={(mm) => up('marginMM', mm)} />
        </div>
      </div>

      <div>
        <ToggleRow label="Rotation Step"
          options={['none', '90', '45', '15'] as const}
          labels={ROT_LABEL}
          value={form.rotation}
          onChange={(v) => up('rotation', v)} />
        {/* "45°" reads as a LIMIT — up to 45° — and it is not one; it is the step
            of the grid of orientations a part may be turned to, so 45° allows a
            half turn and 15° allows everything 45° does. Said in the panel
            because the difference decides whether the setting looks broken. */}
        <p className="text-label text-gray-600 dark:text-neutral-400 normal-case mt-1">
          {form.rotation === 'none'
            ? 'Parts are turned back to the way they were drawn — for stock with a grain to follow.'
            : `Parts may be turned to any multiple of ${ROT_LABEL[form.rotation]}. Finer steps pack a little tighter and take longer.`}
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
          <div className="flex items-center gap-2">
            <input type="checkbox" id="nest-fill" checked={form.fillStock}
              onChange={(e) => up('fillStock', e.target.checked)} className="accent-blue-500" />
            <label htmlFor="nest-fill" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer"
              title="Repeat the selected part until no more will fit">
              Fill stock with copies
            </label>
          </div>
          <p className="text-label text-gray-600 dark:text-neutral-400 normal-case mt-1">
            As many copies of the part as the stock will take, at the same gaps.
            Each copy is an object in its own right — cut it, move it or delete it
            like any other.
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
      </div>

      {report && (
        <p className="text-body text-gray-700 dark:text-neutral-300">
          {report.unchanged
            ? 'Already nested'
            : report.copies > 0
              ? `Filled the stock with ${report.placed} parts — ${report.copies} added`
              : `Nested ${report.placed} of ${report.total}`} into{' '}
          {fmtLen(report.usedWidthMM, units, 1)} × {fmtLen(report.usedHeightMM, units, 1)} —
          parts cover {(report.utilization * 100).toFixed(0)}% of the stock.
          {report.unchanged && ' This is the same arrangement, so nothing moved.'}
        </p>
      )}
      <FormNotice msg={
        report && report.fillLimited
          ? `Stopped at ${report.placed} copies — the stock would take more. Select one of them and fill again for another batch.`
          : report && report.unplaced > 0
            ? `${report.unplaced} part${report.unplaced === 1 ? '' : 's'} would not fit — parked to the right of the stock.`
            : null} />
      {error && (
        <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5">
          <AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}
        </p>
      )}

      <GenerateBtn disabled={!canApply || running} generating={running} onClick={handleNest}
        label={filling ? 'Fill Stock' : 'Nest on Stock'}
        title={widthMM > 0 && heightMM > 0 ? `Stock ${fmtLen(widthMM, units, 1)} × ${fmtLen(heightMM, units, 1)}` : 'Set the stock size first'} />
    </FormShell>
  )
}
