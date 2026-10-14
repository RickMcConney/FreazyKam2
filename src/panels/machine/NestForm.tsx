// ─── Nest form ────────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react'
import { AlertCircle, Loader2, Square } from 'lucide-react'
import { useGenProgressStore } from '../../store/genProgressStore'
import { FormShell, PathChip, PathListSection, ToggleRow, LengthInput, FormNotice, GenerateBtn, ToolSelector, toolsOfType, pickToolId, CheckRow, FIELD_CLS } from './shared'
import { useToolStore } from '../../store/toolStore'
import { ICON } from '../../theme'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, useSelectedPaths, type ImportedPath } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { applyTransformStep, placedAngleDeg, type TransformStep } from '../../canvas/selectionUtils'
import { groupPathsForNesting, nestIsStale, type NestItem } from '../../tools/nestOp'
import { copyPathsUnderSteps } from '../../tools/pathCopy'
import { copyOperationsForParts, type PartCopy } from '../../tools/copyOperations'
import { useToolpathStore, pathIdsOf } from '../../store/toolpathStore'
import { regenerateMany } from '../../cam/regenerate'
import { NumericInput } from '../../components/NumericInput'
import { useTabStore } from '../../store/tabStore'
import { uid } from '../../uid'
import { runInWorkerFor, cancelWork, isWorkCancelled } from '../../workers/workerClient'
import type { PathUpdate } from '../../store/pathsStore'
import type { FillParams, PathDefinition } from '../../importers/svgImporter'

// How finely a part may be turned. "None" is first because it is the only answer
// for stock with a grain direction or a figure to keep aligned — nesting is a
// material-saving tool, not a licence to rotate a board's worth of parts across
// the grain, and a machinist reaching for it on plywood wants a different answer
// from one reaching for it on MDF.
type RotOption = 'none' | '90' | '45' | '15'
const ROT_STEP: Record<RotOption, number> = { none: 0, '90': 90, '45': 45, '15': 15 }
const ROT_LABEL: Record<RotOption, string> = { none: 'None', '90': '90°', '45': '45°', '15': '15°' }
const rotOptionOf = (stepDeg: number): RotOption =>
  stepDeg === 90 ? '90' : stepDeg === 45 ? '45' : stepDeg === 15 ? '15' : 'none'

/**
 * FINE ROTATION IS FOR SMALL NESTS. Every finer step multiplies the orientations each
 * part is tried in (4 at 90°, 8 at 45°, 24 at 15°) and adds a coarser grid to the
 * multi-start besides, while the material it saves over 90° is small — on the
 * 127-part Charizard nest onto half sheets, 45° took 12.9 s against 6.0 s at 90° and
 * used the same three sheets. So past this many parts only None and 90° are offered, and
 * a saved 45° or 15° nests at 90° without being forgotten: the next small project still
 * opens on it.
 *
 * NESTING IN BATCHES IS NOT A FASTER WAY ROUND IT — measured. Batches of 30 with the
 * earlier batches as obstacles were SLOWER at both 90° and 45° (8.1 / 10.9 s against 6.0
 * at 90°; 13.7 / 19.6 against 12.9 at 45°) and saved no sheet: every batch starts again at
 * sheet 1 and searches the full early sheets, which is exactly the cost the row check
 * took out of one big nest, and every batch re-runs the multi-start.
 */
const FINE_ROTATION_MAX_PARTS = 30

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

/** The worker key a nest runs under — what its Stop button cancels (see cancelWork). */
const NEST_JOB = 'nest'

interface NestFormState {
  spacingMM: number
  marginMM: number
  rotation: RotOption
  packFrom: 'left' | 'bottom'
  useHoles: boolean
  avoidOthers: boolean
  /** Carry what will not fit onto more sheets of the same stock, laid out below it. */
  multiSheet: boolean
  /** Repeat the one selected part until the stock is full — see canFill. */
  fillStock: boolean
  /** Parts on the stock after a fill, the original included. 0 = as many as fit. */
  fillCount: number
  /** Give every copy the operations the part already has. */
  copyToolpaths: boolean
  /** Place parts exactly one cutter apart so their outside profiles share lines. */
  sharedLines: boolean
  /** The cutter whose diameter is the gap when `sharedLines` is on. */
  sharedToolId: string
}

const FALLBACK: NestFormState = {
  spacingMM: 3, marginMM: 3, rotation: '90', packFrom: 'left', useHoles: false,
  avoidOthers: true, multiSheet: true, fillStock: false, fillCount: 0, copyToolpaths: true, sharedLines: false, sharedToolId: '',
}

interface NestReport {
  placed: number
  total: number
  /** How many parts the fill pass ADDED to the document. 0 for a plain nest. */
  copies: number
  /** The fill stopped at its copy limit rather than filling the stock. */
  fillLimited: boolean
  /** A count was asked for and the stock took this many fewer. */
  fillShort: number
  /** Operations made for the copies, and the part's operations that could not be copied. */
  opsCopied: number
  opsSkipped: number
  usedWidthMM: number
  usedHeightMM: number
  utilization: number
  unplaced: number
  /** Sheets of stock the nest used (cam/sheets) — more than one only with `multiSheet`. */
  sheets: number
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
    const base = { ...FALLBACK, ...(load('nest') as Partial<NestFormState> | null) }
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
    runNest()
      .catch((e) => {
        // Stopped by the user: the drawing is untouched, which is all there is to say.
        if (isWorkCancelled(e)) { useUIStore.getState().showStatus('Nest stopped — nothing moved'); return }
        setError(e instanceof Error ? e.message : 'Nesting failed')
      })
      .finally(() => setRunning(false))
  }

  async function runNest() {
    const paths = usePathsStore.getState().paths
    // The old copies of a fill being edited are about to go, so they are neither
    // obstacles nor nested — the new fill is laid out as if they were not there.
    const replacedIds = fillCopies.map((p) => p.id)
    const selected = new Set([...selPaths.map((p) => p.id), ...replacedIds])
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
    const nestParams = {
      sheetWidthMM: widthMM,
      sheetHeightMM: heightMM,
      spacingMM: gapMM,
      marginMM: form.marginMM,
      ...(sharing ? { snapGapMM: gapMM } : {}),
      rotationStepDeg: ROT_STEP[rotation],
      packFrom: form.packFrom,
      useHoles: form.useHoles,
      obstacles,
      fill: filling,
      ...(filling && form.fillCount > 0 ? { fillCount: form.fillCount } : {}),
    }
    // MORE SHEETS for what will not fit on one (tools/nestOp nestSheets) — never for a
    // fill, which is one part repeated across one sheet.
    const result = filling || !form.multiSheet
      ? { ...(await runInWorkerFor(NEST_JOB, 'nest', items, nestParams)), sheets: 1 }
      : await runInWorkerFor(NEST_JOB, 'nestSheets', items, nestParams)

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
    const partCopies: PartCopy[] = []
    // WHAT MADE THE COPIES rides on each of them, as a pattern's does: the chip
    // that reopens this form is found through it, and the settings come back
    // from it. An edit keeps the id, so the chip stays where it was.
    const fillParamsNow: FillParams = {
      count: form.fillCount, spacingMM: form.spacingMM, marginMM: form.marginMM,
      rotationStepDeg: ROT_STEP[rotation], packFrom: form.packFrom, useHoles: form.useHoles,
      avoidOthers: form.avoidOthers, copyToolpaths: form.copyToolpaths,
      ...(sharing ? { sharedToolId: sharedTool!.id } : {}),
    }
    const definition: PathDefinition | undefined = filling
      ? { id: editCtx?.defId ?? uid('def'), kind: 'fill', sourceIds: groups[0].ids, params: fillParamsNow }
      : undefined
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
        const pathIds = new Map<string, string>()
        copyPathsUnderSteps(sources, steps, `${copyN + 1}`).forEach((c, i) => {
          const id = uid('path-nest')
          pathIds.set(sources[i].id, id)
          add.push({ ...c, id, definition: definition && { ...definition, copy: copyN + 1 } })
        })
        // Copies are made from the part as it LAY, so `steps` alone carries each
        // source path onto its copy — which is what a drill op's points need.
        partCopies.push({ pathIds, steps })
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
    if (updates.length === 0 && add.length === 0 && replacedIds.length === 0) return

    // NESTING THE SAME PARTS TWICE MUST BE ALLOWED TO CHANGE NOTHING, and must
    // SAY so. The nest is decided by the parts' shapes, not by where they happen
    // to be lying, so a second run with the same settings lands them exactly
    // where the first one did — which from the outside is indistinguishable from
    // a button that did not work, and was read as one. Writing it as an edit
    // anyway would be worse: an undo step that undoes nothing visible.
    const unchanged = add.length === 0 && replacedIds.length === 0 && result.placements.every(
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
        // The copies an edited fill replaces go in the same edit, and their
        // operations with them (applyPathEdit drops what was built on a path).
        deleteIds: replacedIds,
        gesture: rotated ? 'transform' : 'move',
        ...(add.length > 0 || replacedIds.length > 0
          ? { label: editCtx ? 'Update nest' : 'Fill stock', selectAfter: [...updates.map((u) => u.id), ...add.map((p) => p.id)] }
          : {}),
      })
    }
    // THE COPIES' OPERATIONS land in the same step as the copies: written raw,
    // straight after the edit, so the timeline folds them into the snapshot the
    // edit just recorded and one undo takes paths and toolpaths off together.
    // HOLDING TABS belong to the path, as Duplicate treats them, so every copy
    // gets its part's — whatever "copy toolpaths" says. A tab is a fraction of
    // the way round its path, which a rotate or a move leaves where it was, so
    // it needs only its own id and the copy's path. Written before the copied
    // operations generate, so a profile on a copy cuts round its tabs.
    if (partCopies.length > 0) {
      const ts = useTabStore.getState()
      const copiedTabs = partCopies.flatMap((c) => ts.tabs
        .filter((t) => c.pathIds.has(t.pathId))
        .map((t) => ({ ...t, id: uid('tab'), pathId: c.pathIds.get(t.pathId)! })))
      if (copiedTabs.length > 0) ts.replaceTabs([...ts.tabs, ...copiedTabs])
    }
    let opsCopied = 0
    let opsSkipped = 0
    if (filling && form.copyToolpaths && partCopies.length > 0) {
      const tp = useToolpathStore.getState()
      const r = copyOperationsForParts(tp.operations, groups[0].ids, partCopies, uid)
      opsSkipped = r.skipped.length
      if (r.created.length > 0 || r.extended.length > 0) {
        tp.replaceOperations(r.operations)
        const ids = new Set([...r.created, ...r.extended])
        regenerateMany(r.operations.filter((op) => ids.has(op.id)))
        opsCopied = r.created.length
      }
    }
    setReport({
      placed: onStock.length,
      total: filling ? onStock.length : items.length,
      copies: add.length,
      fillLimited: result.fillLimited === true,
      fillShort: filling && form.fillCount > 0 && onStock.length < form.fillCount ? form.fillCount - onStock.length : 0,
      opsCopied,
      opsSkipped,
      usedWidthMM: result.usedWidthMM,
      usedHeightMM: result.usedHeightMM,
      utilization: result.utilization,
      unplaced: result.unplacedIds.length,
      sheets: result.sheets,
      unchanged,
    })
    useUIStore.getState().showStatus(
      unchanged
        ? 'Already nested — nothing moved'
        : filling
          ? `Filled the stock with ${onStock.length} part${onStock.length === 1 ? '' : 's'} — ${add.length} added`
            + (opsCopied > 0 ? `, ${opsCopied} toolpath${opsCopied === 1 ? '' : 's'} copied` : '')
          : `Nested ${onStock.length} of ${items.length} part${items.length === 1 ? '' : 's'}`
            + (result.sheets > 1 ? ` on ${result.sheets} sheets` : ''),
      result.unplacedIds.length > 0 ? 'warn' : 'info',
    )
    save('nest', form)
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
              title="Parts that will not fit go onto more sheets of the same stock, laid out below it. Each sheet is simulated and exported on its own.">
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
      <PathListSection count={selPaths.length}>
        {selPaths.map((p) => <PathChip key={p.id} path={p} label={editCtx ? 'original' : undefined} />)}
      </PathListSection>
    </FormShell>
  )
}
