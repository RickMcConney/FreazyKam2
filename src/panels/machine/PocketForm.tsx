// ─── Pocket form ──────────────────────────────────────────────────────────────
import { FormShell, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, LengthInput, FormError, FormNotice, useBatchGenerate, generateLabel, NoPathBanner, CheckRow, BatchPathList } from './shared'
import { type StartFrom } from '../../cam/startHeight'
import { useEffect, useState } from 'react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type PocketOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { useUIStore } from '../../store/uiStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { generateOperation } from '../../cam/opJob'
import type { PocketNote, PocketStrategy } from '../../cam/pocket'

// The strategy toggle's wording, shared with the fallback notice below it: a message naming
// a strategy by an id that is not the word on the button is no help.
const STRATEGY_LABELS: Partial<Record<PocketStrategy, string>> = { hybrid: 'auto', adaptive2: 'adaptive' }
import { seedStepDownMM } from '../../cam/feeds'
import { groupPathsByContainment } from './containment'
import { reviseGroupBatch } from './reviseBatch'

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
  // Region picking is on for as long as the form is open: a click inside an area the
  // drawn lines enclose makes a closed path of it and selects it, while a click on a line
  // still selects that path (cam/regionPick.ts, CanvasStage). Only an idle canvas is taken
  // over — picking a draw tool still works, and region picking resumes when it finishes.
  const activeTool = useUIStore((s) => s.activeTool)
  useEffect(() => {
    if (activeTool === 'select') useUIStore.getState().setActiveTool('region')
  }, [activeTool])
  useEffect(() => () => {
    if (useUIStore.getState().activeTool === 'region') useUIStore.getState().setActiveTool('select')
  }, [])
  const operations = useToolpathStore((s) => s.operations)
  const load = useFormDefaultsStore((s) => s.load)
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
  const { generating, errorMsg, generate } = useBatchGenerate('pocket', 'pocket')
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
  const adaptiveStrategy = form.strategy === 'adaptive2'
  const autoPassAngle = form.strategy === 'hybrid' && form.autoAngle

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: seedStepDownMM(t) }))
  }

  function handleStrategyChange(strategy: PocketStrategy) {
    const adaptive = strategy === 'adaptive2'
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
    setNoticeMsg(null)
    const forceStrategy = e?.altKey === true
    // The strategies are named for the user here, not in cam/pocket.ts: the toggle shows
    // hybrid as "auto", and a message naming a word that is not on the button is no help.
    const noteFallback = (note: PocketNote) => {
      // Anything else (an area too narrow for the tool) has no banner wording of its
      // own here — the status bar's short line says it.
      if (note.kind !== 'strategy-fallback') { useUIStore.getState().showStatus(note.short, 'warn'); return }
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
    const { toolId, strategy, depthMM, stepDownMM, stepoverPercent, passAngleDeg, autoAngle, direction, rampIn, allowanceMM, invert, startFrom } = form
    await generate({
      settings: { toolId, strategy, depthMM, stepDownMM, stepoverPercent, passAngleDeg, autoAngle, direction, rampIn, allowanceMM, invert, startFrom },
      // islandIds rides on every write, not only a revision: a kept boundary whose island
      // set changed keeps its operation, and this is the only thing about it that moves.
      items: groups.map(({ boundary, islands, op }) => ({
        key: boundary.id, op, name: `Pocket: ${boundary.name} (${tool.name})`,
        fields: { pathId: boundary.id, islandIds: islands.map((p) => p.id) },
      })),
      session, editOp, dropIds: rev.drop.map((m) => m.op.id),
      // Boundaries this session made that the current grouping no longer has — switching
      // Invert Pocket turns every boundary into an island and vice versa, so the whole set
      // is replaced, as a revision of the Generate that made them.
      replace: staleOps.map((e) => ({ opId: e.opId, key: e.key })),
      // Generated from the settings just written, like every other op — Alt-click is the
      // one input that is not a setting. A strategy that declined the shape and fell back
      // is reported: the user chose it.
      run: async (opId) => {
        const { notes } = await generateOperation(opId, { forceStrategy })
        for (const note of notes) noteFallback(note)
      },
    }, form)
  }

  return (
    <FormShell title={editOp ? `Edit Pocket${groups.length > 1 ? ` — ${groups.length} paths` : ''}` : 'New Pocket'} onClose={onClose}>
      {groups.length === 0 && <NoPathBanner editing={!!editOp} closed />}
      <ToolSelector tools={cutters} value={form.toolId} onChange={handleToolChange} />
      {/* Nested outlines alternate solid/hole, so there are two valid readings of the same
          selection and only the user knows which one is the part. Shown when EDITING too:
          the operation stores which reading it used (`invert`), so the box reopens saying
          what this pocket did, and flipping it re-reads the same paths the other way up.
          It was hidden here while it was inert. */}
      {nested && (
        <CheckRow id="pocket-invert" checked={form.invert} onChange={(v) => up('invert', v)} label="Invert Pocket" />
      )}
      {/* 'hybrid' is shown as "Auto" — it picks per area: raster the open ground, contour
          around islands, adaptive on the junctions between them. Listed first as the one to
          reach for by default.
          'adaptive2' is the raster-marching engine and is what the UI shows as "adaptive"
          (the id outlived the Adaptive2d port it replaced).
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
      <CheckRow id="pocket-ramp-in" checked={form.rampIn} onChange={(v) => up('rampIn', v)}
        label="Ramp In" hint="2× dia, 50% feed" />
      <FormNotice msg={noticeMsg} />
      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={groups.length === 0 || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={generateLabel(!!editOp, updating)}
        title="Alt-click to force the selected strategy on shapes it would otherwise decline"
      />
      <BatchPathList groups={groups} addedIds={rev.addedIds} removed={rev.removed} editing={!!editOp} />
    </FormShell>
  )
}
