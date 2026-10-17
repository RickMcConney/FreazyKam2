// The nest itself, out of the form: the parts a selection groups into are laid out on the
// stock (on a worker), and moved — or, filling, copied — in ONE recorded edit. The Nest
// form and the MCP bridge both run it, so a nest from either is the same nest.

import type { Tool } from '../store/toolStore'
import { usePathsStore, type ImportedPath, type PathUpdate } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useProjectStore } from '../store/projectStore'
import { applyTransformStep, placedAngleDeg, type TransformStep } from '../canvas/selectionUtils'
import { groupPathsForNesting, nestIsStale, type NestItem } from './nestOp'
import { copyPathsUnderSteps } from './pathCopy'
import { copyOperationsForParts, type PartCopy } from './copyOperations'
import { useToolpathStore } from '../store/toolpathStore'
import { regenerateMany } from '../cam/regenerate'
import { useTabStore } from '../store/tabStore'
import { uid } from '../uid'
import { runInWorkerFor } from '../workers/workerClient'
import type { FillParams, PathDefinition } from '../importers/svgImporter'

/** The worker key a nest runs under — what its Stop button cancels (see cancelWork). */
export const NEST_JOB = 'nest'

// How finely a part may be turned. "None" is first because it is the only answer
// for stock with a grain direction or a figure to keep aligned — nesting is a
// material-saving tool, not a licence to rotate a board's worth of parts across
// the grain, and a machinist reaching for it on plywood wants a different answer
// from one reaching for it on MDF.
export type RotOption = 'none' | '90' | '45' | '15'
export const ROT_STEP: Record<RotOption, number> = { none: 0, '90': 90, '45': 45, '15': 15 }
export const ROT_LABEL: Record<RotOption, string> = { none: 'None', '90': '90°', '45': '45°', '15': '15°' }
export const rotOptionOf = (stepDeg: number): RotOption =>
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
export const FINE_ROTATION_MAX_PARTS = 30

export interface NestFormState {
  spacingMM: number
  marginMM: number
  rotation: RotOption
  packFrom: 'left' | 'bottom'
  useHoles: boolean
  avoidOthers: boolean
  /** Carry what will not fit onto more sheets of the same stock, beside and below it. */
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

export const NEST_DEFAULTS: NestFormState = {
  spacingMM: 3, marginMM: 3, rotation: '90', packFrom: 'left', useHoles: false,
  avoidOthers: true, multiSheet: true, fillStock: false, fillCount: 0, copyToolpaths: true, sharedLines: false, sharedToolId: '',
}

export interface NestReport {
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
export function placedAngleOf(path: { placement?: TransformStep[] } | undefined): number {
  return placedAngleDeg(path?.placement)
}

/** What a nest is run with: the form's settings, and what it has worked out from them. */
export interface NestRunInput {
  form: NestFormState
  /** The parts — groupPathsForNesting of the selection. */
  groups: ReturnType<typeof groupPathsForNesting>
  selPaths: ImportedPath[]
  /** Editing a fill: its old copies, which the new fill replaces. */
  fillCopies: ImportedPath[]
  /** Editing a fill: its definition id, which the new copies keep. */
  editDefId?: string
  widthMM: number
  heightMM: number
  /** The gap between parts: the spacing, or the cutter when sharing lines. */
  gapMM: number
  sharing: boolean
  sharedTool?: Tool
  /** The rotation actually used (a big nest is held to 90° — see FINE_ROTATION_MAX_PARTS). */
  rotation: RotOption
  filling: boolean
}

/** A nest's outcome: what it did, why it could not, or that there was nothing to move. */
export type NestOutcome = { report: NestReport } | { error: string } | { none: true }

export async function runNest(input: NestRunInput): Promise<NestOutcome> {
  const { form, groups, selPaths, fillCopies, widthMM, heightMM, gapMM, sharing, rotation, filling, sharedTool } = input
  const editCtx = input.editDefId ? { defId: input.editDefId } : undefined
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
    return { error: 'The drawing changed while nesting — run Nest again.' }
  }

  const onStock = result.placements.filter((p) => p.onStock)
  if (onStock.length === 0) {
    return {
      error: obstacles?.length
        ? 'Nothing fits on the stock — try a smaller spacing or margin, or turn off "Avoid other paths".'
        : 'Nothing fits on the stock — try a smaller spacing or margin, or larger stock.',
    }
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
  if (updates.length === 0 && add.length === 0 && replacedIds.length === 0) return { none: true }

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
  const report: NestReport = {
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
  }
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
  return { report }
}
