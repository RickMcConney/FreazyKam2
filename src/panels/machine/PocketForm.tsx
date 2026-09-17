// ─── Pocket form ──────────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, PathRevisionHint, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, LengthInput, FormError, FormNotice, useGenerateError, discardFailedOps } from './shared'
import { type StartFrom } from '../../cam/startHeight'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type AnyOperation, type PocketOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { useUIStore } from '../../store/uiStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { isWorkCancelled } from '../../workers/workerClient'
import { generateOperation } from '../../cam/opJob'
import type { PocketNote, PocketStrategy } from '../../cam/pocket'

// The strategy toggle's wording, shared with the fallback notice below it: a message naming
// a strategy by an id that is not the word on the button is no help.
const STRATEGY_LABELS: Partial<Record<PocketStrategy, string>> = { hybrid: 'auto', adaptive2: 'adaptive' }
import { seedStepDownMM } from '../../cam/feeds'
import { groupPathsByContainment } from './containment'
import { reviseGroupBatch } from './reviseBatch'
import { entryHintAt } from '../../cam/startOptimizer'

interface PocketFormState {
  toolId: string
  strategy: PocketStrategy
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
  autoAngle: boolean
  direction: CuttingDirection
  rampIn: boolean
  allowanceMM: number
  startFrom: StartFrom
  // Which half of a nested selection to clear. Grouping only — it decides how many
  // operations Generate creates, and is not carried on the operations themselves.
  // Unchecked (the default) clears from the outermost outline inward; checked starts one
  // level in and clears what the other reading calls holes.
  invert: boolean
}

export function PocketForm({ onClose, editOp }: { onClose: () => void; editOp?: PocketOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const paths = usePathsStore((s) => s.paths)
  // PICK ORDER, not z-order: operations are cut in the order they were created
  // (see cam/startOptimizer), so the order the paths were clicked in IS the order the
  // machine will run them. Selecting three circles 1, 2, 3 cuts them 1, 2, 3.
  const selPaths = useSelectedPathsInOrder()
  const addOperations = useToolpathStore((s) => s.addOperations)
  const updateOperation = useToolpathStore((s) => s.updateOperation)
  const replaceGeneratedOperations = useToolpathStore((s) => s.replaceGeneratedOperations)
  const reviseBatchPaths = useToolpathStore((s) => s.reviseBatchPaths)
  const operations = useToolpathStore((s) => s.operations)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)

  // Clearing a pocket needs a side-cutting edge, so the same filter as the dropdown
  // picks the default and vets a saved one.
  const cutters = toolsOfType(tools, ['endmill', 'ballnose'])
  const defaultTool = cutters[0]
  const [form, setForm] = useState<PocketFormState>(() => {
    const base = editOp ? {
    toolId: editOp.toolId, strategy: editOp.strategy ?? 'raster',
    depthMM: editOp.depthMM, stepDownMM: editOp.stepDownMM,
    stepoverPercent: editOp.stepoverPercent, passAngleDeg: editOp.passAngleDeg,
    autoAngle: editOp.autoAngle ?? true,
    direction: editOp.direction, rampIn: editOp.rampIn ?? false,
    allowanceMM: editOp.allowanceMM ?? 0,
    // Legacy ops (saved before start heights existed) stay on stock top rather than
    // silently deepening when re-generated; new ops default to auto.
    startFrom: editOp.startFrom ?? { mode: 'stock' },
    // The operation records which half of a nested selection it came from, so the
    // checkbox reopens saying what this pocket actually did. Un-inverted for anything
    // saved before the field existed, which is what those pockets were.
    invert: editOp.invert ?? false,
  } : { ...mergeWithDefaults(load('pocket'), {
    toolId: defaultTool?.id ?? '',
    // 'hybrid' — shown as "Auto". Note this is only the default for a FIRST pocket: the
    // form-defaults store replays whatever was last used after that.
    strategy: 'hybrid' as PocketStrategy,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: seedStepDownMM(defaultTool),
    stepoverPercent: 40,
    passAngleDeg: 0,
    autoAngle: true,
    direction: 'climb' as CuttingDirection,
    rampIn: false,
    allowanceMM: 0,
    // Never restored from the saved form defaults: a start reference belongs to the
    // operation it was chosen for, and replaying an old one onto a new pocket is exactly
    // the "silently starts 2 mm down over solid stock" case this design exists to avoid.
    startFrom: { mode: 'auto' } as StartFrom,
    // Not restored from the saved defaults either, and for the same reason: it belongs to
    // the selection it was chosen for. Replaying an inverted pocket onto an un-nested
    // selection would silently produce no operations at all.
    invert: false,
  }, tools), startFrom: { mode: 'auto' } as StartFrom, invert: false }
    return { ...base, toolId: pickToolId(base.toolId, cutters) }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
  // A Generate that SUCCEEDED but not as asked — today, a strategy that declined the shape.
  // Separate from errorMsg: nothing failed, so nothing is discarded and the operation keeps
  // its toolpath; the user just needs to know a different strategy cut it.
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null)
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click, not just the one
  // that was clicked: applying one pocket to five selected paths is one decision, so
  // changing its depth afterwards should be one edit rather than five identical ones.
  const editBatch = editOp ? (batchOf(editOp, operations) as PocketOperation[]) : []
  const editGroups = editBatch.flatMap((op) => {
    const boundary = paths.find((p) => p.id === op.pathId)
    return boundary
      ? [{ op, boundary, islands: paths.filter((p) => op.islandIds.includes(p.id)) }]
      : []
  })
  // While a batch is open for editing the canvas selection is the set of paths it clears —
  // shift-click one in, shift-click one out, Regenerate to apply. Which of them is the
  // boundary and which are islands is not the user's to say: the selection is re-read by
  // the SAME containment rule the first Generate used, so a path shift-clicked inside an
  // existing pocket becomes an island of it. See reviseGroupBatch.
  // Flipping Invert Pocket while editing changes nothing about the SELECTION but
  // everything about how it reads, so it has to force the regroup that an unchanged
  // selection otherwise skips. Without this the checkbox moved and the pocket did not.
  const invertChanged = !!editOp && form.invert !== (editOp.invert ?? false)
  const rev = reviseGroupBatch(
    editGroups, editOp ? selPaths : [],
    (sel) => groupPathsByContainment(sel, { invert: form.invert }),
    { force: invertChanged },
  )
  const editRevised = [
    ...rev.keep.map((k) => ({ op: k.member.op as PocketOperation | undefined, boundary: k.group.boundary, islands: k.group.islands })),
    ...rev.add.map((g) => ({ op: undefined as PocketOperation | undefined, boundary: g.boundary, islands: g.islands })),
  ]
  const groups = editOp
    ? editRevised
    : groupPathsByContainment(selPaths, { invert: form.invert })
        .map((g) => ({ ...g, op: undefined }))
  // Only worth asking about when the selection actually nests. Once inverted the checkbox
  // has to stay up regardless — that grouping can legitimately have no islands at all
  // (four nested rectangles give a bare middle one), and hiding the row would strand the
  // user with no way to uncheck it.
  const nested = form.invert || groups.some((g) => g.islands.length > 0)
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // One resolve per form render, shared by the Start row and every group generated below.
  // Multi-group selections all share the first group's footprint here; each group re-resolves
  // for real at generation time.
  // Margin 0: a pocket's cutter stays a full radius INSIDE its boundary, so the cleared
  // area never reaches past the path.
  // The ops this form already made are about to be REPLACED by the next Generate, so
  // they must not count as cuts preceding themselves — otherwise a lone 5 mm pocket
  // reads its own floor and the Start row shows Z −5 instead of stock top.
  const selfOpId = editOp?.id ?? session.firstLiveOpId()
  const startZ = useStartZ(form.startFrom, groups[0]?.boundary.d ?? '', 0, selfOpId)
  // Ops this session made from paths that are STILL selected. Scoped to the selection on
  // purpose: re-reading the same paths a different way (Invert Pocket) should replace what
  // it made, but selecting different paths and generating again is a new operation, not a
  // revision of the last one, so ops for deselected paths are left alone.
  const selectedIds = new Set(selPaths.map((p) => p.id))
  const sessionOps = editOp ? [] : session.liveEntries().filter((e) => selectedIds.has(e.key))
  // Boundaries this session already covers but that the current grouping no longer has —
  // inverting turns every boundary into an island and vice versa. Replaced on
  // the next Generate rather than left behind as a second set of pockets.
  const staleOps = sessionOps.filter((e) => !groups.some((g) => g.boundary.id === e.key))
  // "Update" as soon as this session owns anything in the selection, not only when every
  // current boundary has an op: after a toggle, none of them do yet.
  const updating = !editOp && groups.length > 0 && sessionOps.length > 0
  // Only the adaptive engines call this number an engagement — there it is the arc of the
  // cutter kept in the material, held constant by construction, and asking for more than
  // 60% of it is asking the marcher for something it will not hold. Auto (hybrid) spends
  // most of its path rastering and contouring, where the number simply IS the stepover: it
  // takes the same name and the same 10–90% range as those two.
  const adaptiveStrategy = form.strategy === 'adaptive' || form.strategy === 'adaptive2'
  const autoPassAngle = form.strategy === 'hybrid' && form.autoAngle

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: seedStepDownMM(t) }))
  }

  function handleStrategyChange(strategy: PocketStrategy) {
    const adaptive = strategy === 'adaptive' || strategy === 'adaptive2'
    setForm((f) => ({
      ...f,
      strategy,
      stepoverPercent: adaptive
        ? Math.min(Math.max(f.stepoverPercent, 5), 60)
        : Math.min(Math.max(f.stepoverPercent, 10), 90),
    }))
  }

  function up<K extends keyof PocketFormState>(k: K, v: PocketFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  // Alt-click forces the chosen strategy onto a shape it would otherwise decline as a poor
  // fit (see REDUNDANCY_LIMIT in cam/pocket/fieldSpiral). Deliberately a modifier and not a
  // setting: it is an override of a measured verdict, and the path it produces is the one
  // the verdict called not worth cutting. The status warning names the gesture, so it is
  // discoverable exactly when it is relevant.
  async function handleGenerate(e?: React.MouseEvent) {
    clearError()
    setNoticeMsg(null)
    // Ids this click CREATES. A Generate that fails leaves nothing behind, so these are
    // thrown away again in the finally; an op that already existed is never touched.
    const createdIds: string[] = []
    const forceStrategy = e?.altKey === true
    // The strategies are named for the user here, not in cam/pocket.ts: the toggle shows
    // hybrid as "auto", and a message naming a word that is not on the button is no help.
    const noteFallback = (note: PocketNote) => {
      if (note.kind !== 'strategy-fallback') return
      const name = (id: PocketStrategy) => STRATEGY_LABELS[id] ?? id
      const chosen = name(form.strategy)
      setNoticeMsg(
        `${chosen} declined this shape, so ${name('hybrid')} generated it instead. ` +
        // Not "alt-click to force" when they just did: a strategy can decline for a reason
        // the override does not cover (too few rings to nest, a region that collapses), and
        // telling someone to repeat the gesture that did not work is the worst of the two.
        (forceStrategy
          ? `It declined even with Alt held, so the shape is one ${chosen} cannot cut.`
          : `Alt-click Generate to force ${chosen}.`),
      )
      useUIStore.getState().showStatus(note.short, 'warn')
    }
    if (groups.length === 0 || !selectedTool) return
    const tool = selectedTool
    setGenerating(true)
    // Run the (potentially slow, e.g. adaptive) pocket generation off the main thread so the
    // browser stays responsive — same worker pattern as regenerate.ts. Awaiting the worker also
    // lets React paint the 'generating' state, so the old setTimeout(…,0) yield is unnecessary.
    try {
      if (editOp) {
        // Paths the selection added to this batch, or took out of it, land HERE — on the
        // Regenerate click, in one store action. A boundary that KEPT its operation but
        // gained or lost an island needs no new operation, only the `islandIds` the loop
        // below writes anyway.
        let cuts = rev.keep.map((k) => ({ op: k.member.op, boundary: k.group.boundary, islands: k.group.islands }))
        if (rev.drop.length > 0 || rev.add.length > 0) {
          const newIds = reviseBatchPaths({
            anchorId: editOp.id,
            deleteIds: rev.drop.map((m) => m.op.id),
            add: rev.add.map(({ boundary, islands }) => ({
              name: `Pocket: ${boundary.name} (${tool.name})`,
              type: 'pocket' as const,
              toolId: form.toolId,
              strategy: form.strategy,
              pathId: boundary.id,
              islandIds: islands.map((p) => p.id),
              depthMM: form.depthMM,
              stepDownMM: form.stepDownMM,
              stepoverPercent: form.stepoverPercent,
              passAngleDeg: form.passAngleDeg,
              autoAngle: form.autoAngle,
              direction: form.direction,
              rampIn: form.rampIn,
              allowanceMM: form.allowanceMM,
              invert: form.invert,
              startFrom: form.startFrom,
            })),
          })
          const live = useToolpathStore.getState().operations
          cuts = [...cuts, ...rev.add.flatMap((g, i) => {
            const op = live.find((o) => o.id === newIds[i]) as PocketOperation | undefined
            return op ? [{ op, boundary: g.boundary, islands: g.islands }] : []
          })]
        }
        for (const { op, islands } of cuts) {
          // Chain each op to where the previous one finishes, at generation time — so no
          // regeneration is needed before simulating or exporting.
          const hint = entryHintAt(op.id)
          updateOperation(op.id, {
            entryHint: hint,
            toolId: form.toolId, strategy: form.strategy,
            // Written every time, not only when revising: a kept boundary whose island set
            // changed keeps its operation, and this is the only thing about it that moves.
            islandIds: islands.map((p) => p.id),
            depthMM: form.depthMM, stepDownMM: form.stepDownMM,
            // Written here too: this branch used to generate with the form's autoAngle
            // without storing it, so the next automatic regenerate reverted it.
            stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg, autoAngle: form.autoAngle,
            direction: form.direction, rampIn: form.rampIn, allowanceMM: form.allowanceMM,
            invert: form.invert,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation>)
          try {
            // Generated from the settings just written — the same call an automatic
            // regenerate makes (cam/opJob). Alt-click is the one input that is not a setting.
            const { notes } = await generateOperation(op.id, { forceStrategy })
            // A strategy that declined the shape and fell back — say so, the user chose it.
            for (const note of notes) noteFallback(note)
          } catch (err) {
            // A cancel abandons the whole Generate, not just this group — carrying on
            // would immediately queue the next one against the state the user just left.
            if (isWorkCancelled(err)) break
            reportError(op.id, err)
          }
        }
        // See ProfileForm: the chip that opened this form may be the one just deselected.
        if (rev.drop.some((m) => m.op.id === editOp.id) && cuts.length > 0) {
          useUIStore.getState().setRequestEditOpId(cuts[0].op.id)
        }
      } else {
        // Every new op goes in ONE addOperations call: a Generate over several selected
        // paths is a single decision, so it is a single timeline chip carrying a shared
        // batchId — which is what lets the edit above cover all of them at once.
        const newPayloads: Parameters<typeof addOperations>[0] = []
        const slots = groups.map(({ boundary, islands }) => {
          // Re-Generate on a boundary this form already generated updates that op in place.
          const existingId = session.liveOpId(boundary.id)
          if (existingId) return existingId
          return newPayloads.push({
            name: `Pocket: ${boundary.name} (${tool.name})`,
            type: 'pocket',
            toolId: form.toolId,
            strategy: form.strategy,
            pathId: boundary.id,
            islandIds: islands.map((p) => p.id),
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            stepoverPercent: form.stepoverPercent,
            passAngleDeg: form.passAngleDeg,
            autoAngle: form.autoAngle,
            direction: form.direction,
            rampIn: form.rampIn,
            allowanceMM: form.allowanceMM,
            invert: form.invert,
            startFrom: form.startFrom,
          }) - 1
        })
        // Boundaries this session made that the current grouping no longer has — switching
        // Invert Pocket turns every boundary into an island and vice versa, so the whole
        // set is replaced. That is a revision of the Generate that made them, not a
        // deletion and a fresh call, so it amends that one chip instead of adding two more
        // (which is what changing a depth or a strategy already does).
        const newIds = staleOps.length > 0
          ? replaceGeneratedOperations({
              anchorId: staleOps[0].opId,
              deleteIds: staleOps.map((e) => e.opId),
              add: newPayloads,
            })
          : addOperations(newPayloads)
        if (staleOps.length > 0) session.forget(staleOps.map((e) => e.key))
        for (let gi = 0; gi < groups.length; gi++) {
          const { boundary, islands } = groups[gi]
          const slot = slots[gi]
          const existingId = typeof slot === 'string' ? slot : undefined
          const opId = existingId ?? newIds[slot as number]
          const name = `Pocket: ${boundary.name} (${tool.name})`
          if (!existingId) { session.remember(boundary.id, opId); createdIds.push(opId) }
          const hint = entryHintAt(opId)
          updateOperation(opId, existingId ? {
            entryHint: hint,
            name, toolId: form.toolId, strategy: form.strategy,
            islandIds: islands.map((p) => p.id),
            depthMM: form.depthMM, stepDownMM: form.stepDownMM,
            stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg, autoAngle: form.autoAngle,
            direction: form.direction, rampIn: form.rampIn, allowanceMM: form.allowanceMM,
            invert: form.invert,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation> : { entryHint: hint, status: 'generating' })
          try {
            const { notes } = await generateOperation(opId, { forceStrategy })
            // A strategy that declined the shape and fell back — say so, the user chose it.
            for (const note of notes) noteFallback(note)
          } catch (err) {
            if (isWorkCancelled(err)) break
            reportError(opId, err)
          }
        }
      }
    } finally {
      discardFailedOps(createdIds)
      setGenerating(false)
      save('pocket', form)
    }
  }

  return (
    <FormShell title={editOp ? `Edit Pocket${groups.length > 1 ? ` — ${groups.length} paths` : ''}` : 'New Pocket'} onClose={onClose}>
      {groups.length === 0 && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a closed path first'}</p>
      )}
      <ToolSelector tools={cutters} value={form.toolId} onChange={handleToolChange} />
      {/* Nested outlines alternate solid/hole, so there are two valid readings of the same
          selection and only the user knows which one is the part. Shown when EDITING too:
          the operation stores which reading it used (`invert`), so the box reopens saying
          what this pocket did, and flipping it re-reads the same paths the other way up.
          It was hidden here while it was inert. */}
      {nested && (
        <div className="flex items-center gap-2">
          <input type="checkbox" id="pocket-invert" checked={form.invert}
            onChange={(e) => up('invert', e.target.checked)} className="accent-blue-500" />
          <label htmlFor="pocket-invert" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
            Invert Pocket
          </label>
        </div>
      )}
      {/* 'hybrid' is shown as "Auto" — it picks per area: raster the open ground, contour
          around islands, adaptive on the junctions between them. Listed first as the one to
          reach for by default.
          'adaptive' (the old Adaptive2d port) stays hidden — too slow; 'adaptive2' is the
          fast raster-marching engine and is what the UI shows as "adaptive".
          The ids are what saved projects store, so they stay as they are. */}
      <ToggleRow label="Strategy" options={['hybrid', 'raster', 'contour', 'morph', 'adaptive2'] as PocketStrategy[]} value={form.strategy} onChange={handleStrategyChange} labels={STRATEGY_LABELS} />
      <div>
        <label htmlFor="pocket-f1" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          {adaptiveStrategy ? 'Engagement' : 'Stepover'} <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input id="pocket-f1"
          type="range" min={adaptiveStrategy ? 5 : 10} max={adaptiveStrategy ? 60 : 90} step={5}
          value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      {/* Pass angle — the raster strategy, and Auto where it drives the raster sub-areas.
          Auto picks the angle per area that makes its passes longest; pin it when the cut
          direction matters for its own sake (grain, for instance). */}
      {(form.strategy === 'raster' || form.strategy === 'hybrid') && (
        <div>
          <label htmlFor="pocket-angle" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
            Angle <span className="text-gray-500 dark:text-neutral-400 normal-case">{autoPassAngle ? 'auto' : `${form.passAngleDeg}°`}</span>
          </label>
          {form.strategy === 'hybrid' && (
            <div className="flex items-center gap-2 mb-1">
              <input type="checkbox" id="pocket-auto-angle" checked={form.autoAngle}
                onChange={(e) => up('autoAngle', e.target.checked)} className="accent-blue-500" />
              <label htmlFor="pocket-auto-angle" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
                Auto <span className="text-gray-600 dark:text-neutral-400">(longest passes per area)</span>
              </label>
            </div>
          )}
          <input
            id="pocket-angle"
            type="range" min={0} max={180} step={5}
            value={form.passAngleDeg}
            disabled={autoPassAngle}
            onChange={(e) => up('passAngleDeg', parseInt(e.target.value))}
            className="w-full accent-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          />
        </div>
      )}
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={selfOpId} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} startZMM={startZ.zMM} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <div>
        <label htmlFor="pocket-stock-allowance" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Stock Allowance</label>
        <LengthInput id="pocket-stock-allowance" valueMM={form.allowanceMM} minMM={-5} maxMM={5} stepMM={0.05}
          onChangeMM={(v) => up('allowanceMM', v)} />
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">Stock left on walls; negative grows the pocket.</p>
      </div>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="pocket-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="pocket-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-600 dark:text-neutral-400 normal-case">(2× dia, 50% feed)</span>
        </label>
      </div>
      <FormNotice msg={noticeMsg} />
      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={groups.length === 0 || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
        title="Alt-click to force the selected strategy on shapes it would otherwise decline"
      />
      {/* Below the button — see PathListSection. Islands keep their label because that
          is a real distinction; nothing else needs one. */}
      <PathListSection count={groups.reduce((n, g) => n + 1 + g.islands.length, 0)}>
        {groups.map(({ boundary, islands }, gi) => (
          <div key={boundary.id} className="space-y-0.5">
            <PathChip path={boundary} index={groups.length > 1 ? gi + 1 : undefined}
              state={rev.addedIds.has(boundary.id) ? 'added' : undefined} />
            {islands.map((p) => (
              <PathChip key={p.id} path={p} label="island" state={rev.addedIds.has(p.id) ? 'added' : undefined} />
            ))}
          </div>
        ))}
        {rev.removed.map((p) => <PathChip key={p.id} path={p} state="removed" />)}
        {editOp && <PathRevisionHint added={rev.addedIds.size} removed={rev.removed.length} />}
      </PathListSection>
    </FormShell>
  )
}
