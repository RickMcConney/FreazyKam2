// ─── Profile form ─────────────────────────────────────────────────────────────
import { FormShell, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, LengthInput, FormError, FormNotice, useBatchGenerate, generateLabel, NoPathBanner, CheckRow, BatchPathList } from './shared'
import { reviseBatch } from './reviseBatch'
import { skipOpenPaths, skippedOpenMsg } from './containment'
import { outermostPaths } from './selectionKinds'
import { type StartFrom, profileCutMarginMM } from '../../cam/startHeight'
import { useState } from 'react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type CutSide, type ProfileOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { seedStepDownMM } from '../../cam/feeds'
import { DEFAULT_BRIDGE_MAX_MM, DEFAULT_CORNER_TOLERANCE_MM, DEFAULT_FINISH_PASS_MM, PROFILE_TOOL_TYPES, profileFormDefaults, profileSaveKeys, savedProfileFor } from './opDefaults'
import { maxCutRadiusMM, toolRadiusAtHeight } from '../../cam/geom'

interface ProfileFormState {
  toolId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  /** The step-down was typed over the auto one (see BaseOperation.stepDownManual). */
  stepDownManual: boolean
  direction: CuttingDirection
  rampIn: boolean
  allowanceMM: number
  roundCorners: boolean
  cornerToleranceMM: number
  /** FINISHING PASS — stored on the op as `finishPassMM` (0 = off) and `springPass`. */
  finishPass: boolean
  finishPassMM: number
  springPass: boolean
  /** OPTIMIZE PATH — outside profiles of several paths only. Stored on the op as `sharedLines`. */
  sharedLines: boolean
  /** With it on: whether the routing may cut through waste to join toolpaths, and how far. */
  bridgeGaps: boolean
  bridgeMaxMM: number
  startFrom: StartFrom
}

export function ProfileForm({ onClose, editOp }: { onClose: () => void; editOp?: ProfileOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const paths = usePathsStore((s) => s.paths)
  // PICK ORDER, not z-order: operations are cut in the order they were created
  // (see cam/startOptimizer), so the order the paths were clicked in IS the order the
  // machine will run them. Selecting three circles 1, 2, 3 cuts them 1, 2, 3.
  const allSelPaths = useSelectedPathsInOrder()
  const operations = useToolpathStore((s) => s.operations)
  const load = useFormDefaultsStore((s) => s.load)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const units = useWorkpieceStore((s) => s.units)

  // A profile needs a side-cutting edge — see PROFILE_TOOL_TYPES.
  const cutters = toolsOfType(tools, PROFILE_TOOL_TYPES)
  const defaultTool = cutters[0]
  const [form, setForm] = useState<ProfileFormState>(() => {
    const base = editOp ? {
      toolId: editOp.toolId, side: editOp.side, depthMM: editOp.depthMM,
      stepDownMM: editOp.stepDownMM, stepDownManual: editOp.stepDownManual ?? false, direction: editOp.direction, rampIn: editOp.rampIn ?? false,
      allowanceMM: editOp.allowanceMM ?? 0,
      // A profile saved before the option existed has none, and stays unrounded.
      roundCorners: (editOp.cornerToleranceMM ?? 0) > 0,
      cornerToleranceMM: (editOp.cornerToleranceMM ?? 0) > 0 ? editOp.cornerToleranceMM! : DEFAULT_CORNER_TOLERANCE_MM,
      finishPass: (editOp.finishPassMM ?? 0) > 0,
      finishPassMM: (editOp.finishPassMM ?? 0) > 0 ? editOp.finishPassMM! : DEFAULT_FINISH_PASS_MM,
      springPass: editOp.springPass ?? false,
      sharedLines: editOp.sharedLines ?? false,
      bridgeGaps: (editOp.bridgeMaxMM ?? 0) > 0,
      bridgeMaxMM: (editOp.bridgeMaxMM ?? 0) > 0 ? editOp.bridgeMaxMM! : DEFAULT_BRIDGE_MAX_MM,
      // Legacy ops stay on stock top — see PocketForm.
      startFrom: editOp.startFrom ?? { mode: 'stock' },
    } : { ...mergeWithDefaults(savedProfileFor(load), profileFormDefaults(defaultTool, thicknessMM), tools), startFrom: { mode: 'auto' } as StartFrom, stepDownManual: false }
    return { ...base, toolId: pickToolId(base.toolId, cutters) }
  })
  // A sided cut needs an interior to be on a side of, so open paths in the selection (a
  // label inside each part) are left out rather than failing their operations — see
  // skipOpenPaths. A centerline cut follows a stroke, so it keeps them.
  const { closed: sidedPaths, skipped: skippedOpen } = form.side === 'centerline'
    ? { closed: allSelPaths, skipped: 0 }
    : skipOpenPaths(allSelPaths)
  // And an OUTSIDE cut goes round the part, not round its holes and lettering: cutting
  // outside a hole widens it by a tool diameter, which is never what selecting a whole
  // part meant. The Select Only bar is how to cut the inner paths on purpose.
  const { outer: selPaths, skipped: skippedInner } = form.side === 'outside'
    ? outermostPaths(sidedPaths)
    : { outer: sidedPaths, skipped: 0 }
  const { generating, errorMsg, generate } = useBatchGenerate<ProfileFormState>('profile', profileSaveKeys)
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click — profiling five
  // selected paths at once is one decision, so changing the depth afterwards is one edit.
  const editBatch = editOp ? (batchOf(editOp, operations) as ProfileOperation[]) : []
  const editPairs = editBatch.flatMap((op) => {
    const path = paths.find((p) => p.id === op.pathId)
    return path ? [{ op, path }] : []
  })
  // While a batch is open for editing, the canvas selection is the set of paths it
  // covers — shift-click one in, shift-click one out. Only the Regenerate click below
  // acts on it; an empty selection means the user clicked away, not that the batch
  // should be emptied. See reviseBatch.
  const rev = reviseBatch(editPairs, (e) => e.path, editOp ? selPaths : [])
  // A SHARED-LINE profile is one operation over a whole sheet (`pathId` + `pathIds`), so
  // editing it revises that list rather than a batch: the selection is the sheet, and an
  // empty selection — a click on blank canvas — leaves the sheet alone.
  const sharedEdit = !!editOp?.sharedLines && !!editOp.pathIds
  const sheetPaths = sharedEdit
    ? [editOp!.pathId, ...editOp!.pathIds!].flatMap((id) => paths.find((p) => p.id === id) ?? [])
    : []
  const selectedPaths = sharedEdit
    ? (selPaths.length > 0 ? selPaths : sheetPaths)
    : editOp ? [...rev.keep.map((e) => e.path), ...rev.add] : selPaths
  const sheetIds = new Set(sheetPaths.map((p) => p.id))
  const selectedIds = new Set(selectedPaths.map((p) => p.id))
  const addedIds = sharedEdit
    ? new Set(selectedPaths.filter((p) => !sheetIds.has(p.id)).map((p) => p.id))
    : new Set(rev.add.map((p) => p.id))
  const removedPaths = sharedEdit ? sheetPaths.filter((p) => !selectedIds.has(p.id)) : rev.drop.map((e) => e.path)
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // Not on a centerline cut (no wall) and not with Optimize Path (its routed network has no
  // finishing pass of its own); both hide the controls, and a hidden setting must not act.
  const finishing = form.finishPass && form.side !== 'centerline'
    && !(form.side === 'outside' && selectedPaths.length > 1 && form.sharedLines)
  // How far the tool reaches past the path — the same definition the stamp and the
  // staleness check use, so the start height previewed here is the one generated.
  const cutMarginMM = profileCutMarginMM(form.side, selectedTool, form.allowanceMM, finishing ? form.finishPassMM : 0)
  // See PocketForm: ops this session already generated are not cuts preceding themselves.
  const selfOpId = editOp?.id ?? session.firstLiveOpId()
  const startZ = useStartZ(form.startFrom, selectedPaths[0]?.d ?? '', cutMarginMM, selfOpId)
  // A tapered/round tool that never reaches full diameter at this depth offsets by less
  // than its radius, so the wall it leaves is a taper that meets the path at the surface.
  // Say so — otherwise the toolpath just looks like it's in the wrong place.
  const cutRadiusMM = selectedTool ? toolRadiusAtHeight(selectedTool, form.depthMM) : 0
  // Compared against the tool's WIDEST cutting radius, not `diameterMM / 2` — a taper
  // stores its tip there, and at any depth it cuts wider than that, so the old test
  // could never fire for one.
  const profileNoun = selectedTool?.type === 'vbit' ? 'V'
    : selectedTool?.type === 'taper' ? 'taper' : 'ball'
  const taperHint = selectedTool && form.side !== 'centerline'
    && cutRadiusMM < maxCutRadiusMM(selectedTool) - 1e-6
    ? `Offset ${fmtLen(cutRadiusMM, units)} — the ${profileNoun} profile at ${fmtLen(form.depthMM, units)} deep, so the cut meets the path at the start surface and the wall below is tapered.`
    : null
  // What the allowance does to the number the calipers read. The wall moves by the
  // allowance, so the MEASURED size moves by twice it — that factor of two is the whole
  // reason this line is here, and it is what the finishing pass at 0 gives back.
  const a = form.allowanceMM
  const opening = form.side === 'inside'
  const allowanceHint = a === 0
    ? 'Stock left on the wall for a finishing pass; negative cuts past the line.'
    : a > 0
      ? `${fmtLen(a, units)} on the wall — the ${opening ? 'opening' : 'part'} cuts ${fmtLen(2 * a, units)} ${opening ? 'under' : 'over'}size until a second pass at 0 cleans it.`
      : `Cuts ${fmtLen(-a, units)} past the line — the ${opening ? 'opening' : 'part'} comes out ${fmtLen(-2 * a, units)} ${opening ? 'over' : 'under'}size.`
  const updating = !editOp && selectedPaths.length > 0 && selectedPaths.every((p) => session.liveOpId(p.id))
  // Optimize Path routes the outside cuts of several parts as one network. Corner rounding
  // is off and hidden while it is on: it moves a corner of one part's cut path off the line
  // its neighbour shares. Stock allowance stays — it moves every cut path alike.
  const canShare = form.side === 'outside' && selectedPaths.length > 1
  const sharing = canShare && form.sharedLines
  // Ticking or unticking it on an existing profile changes what KIND of operation it is —
  // one per part, or one for the whole sheet — so a Regenerate then replaces the batch with
  // the other kind, in the same program slot and as one step (reviseBatchPaths).
  const converting = !!editOp && sharing !== sharedEdit

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: seedStepDownMM(t), stepDownManual: false }))
  }

  function up<K extends keyof ProfileFormState>(k: K, v: ProfileFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  // A NEW profile switching side takes that side's own saved settings — its tool, depth and
  // the rest (opDefaults `savedProfileFor`); a side never generated keeps what the form has.
  // An EDITED one only changes side: that is adjusting this operation, and swapping its tool
  // and depth out from under it would be a surprise. Start From stays, and the step-down
  // goes back to auto as it does for any new operation (see StepDownField).
  function changeSide(side: CutSide) {
    const own = editOp ? null : savedProfileFor(load, side)
    if (!own) { up('side', side); return }
    setForm((f) => {
      const merged = mergeWithDefaults<ProfileFormState & Record<string, unknown>>(own, { ...f }, tools)
      return { ...merged, side, startFrom: f.startFrom, stepDownManual: false, toolId: pickToolId(merged.toolId, cutters) }
    })
  }

  async function handleGenerate() {
    if (selectedPaths.length === 0 || !selectedTool) return
    const tool = selectedTool
    const { toolId, side, depthMM, stepDownMM, stepDownManual, direction, rampIn, allowanceMM, startFrom } = form
    const cornerToleranceMM = form.roundCorners && side !== 'centerline' && !sharing ? form.cornerToleranceMM : 0
    const finishPassMM = finishing ? form.finishPassMM : 0
    const springPass = finishing && form.springPass
    if (sharing) {
      const [first, ...rest] = selectedPaths
      const bridgeMaxMM = form.bridgeGaps ? form.bridgeMaxMM : 0
      await generate({
        settings: { toolId, side: 'outside', depthMM, stepDownMM, stepDownManual, direction, rampIn, allowanceMM, cornerToleranceMM: 0, finishPassMM: 0, springPass: false, sharedLines: true, bridgeMaxMM, startFrom },
        items: [{
          key: sharedEdit ? editOp!.id : `shared:${selectedPaths.map((p) => p.id).sort().join(',')}`,
          op: sharedEdit ? editOp : undefined,
          name: `Profile: ${selectedPaths.length} parts, optimized (${tool.name})`,
          fields: { pathId: first.id, pathIds: rest.map((p) => p.id) },
        }],
        session, editOp,
        // One op per part becoming one for the sheet: every member of the batch goes.
        dropIds: converting ? editBatch.map((o) => o.id) : [],
      }, form)
      return
    }
    const item = (path: ImportedPath, op?: ProfileOperation) =>
      ({ key: path.id, op, name: `Profile: ${path.name} (${tool.name})`, fields: { pathId: path.id } })
    await generate({
      settings: { toolId, side, depthMM, stepDownMM, stepDownManual, direction, rampIn, allowanceMM, cornerToleranceMM, finishPassMM, springPass, sharedLines: false, bridgeMaxMM: 0, startFrom },
      items: converting
        // The sheet becoming one op per part: every part is a new op, and the sheet goes.
        ? selectedPaths.map((path) => item(path))
        : editOp
          ? [...rev.keep.map(({ op, path }) => item(path, op)), ...rev.add.map((path) => item(path))]
          : selectedPaths.map((path) => item(path)),
      session, editOp, dropIds: converting ? [editOp!.id] : rev.drop.map((e) => e.op.id),
    }, form)
  }

  return (
    <FormShell title={editOp ? `Edit Profile${selectedPaths.length > 1 ? ` — ${selectedPaths.length} paths` : ''}` : 'New Profile'} onClose={onClose}>
      {selectedPaths.length === 0 && <NoPathBanner editing={!!editOp} />}
      <ToolSelector tools={cutters} value={form.toolId} onChange={handleToolChange} />
      <ToggleRow label="Cut Side" options={['inside', 'outside', 'centerline'] as CutSide[]} value={form.side} onChange={changeSide} />
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={selfOpId} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        stepManual={form.stepDownManual} onStepManual={(v) => up('stepDownManual', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} startZMM={startZ.zMM} />
      {taperHint && (
        <p className="text-label text-gray-500 dark:text-neutral-400 normal-case">{taperHint}</p>
      )}
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      {/* Hidden for centerline: there is no side for stock to be left on, and a field that
          silently does nothing is worse than an absent one. */}
      {canShare && (
        <div>
          <CheckRow id="profile-shared-lines" checked={form.sharedLines} onChange={(v) => up('sharedLines', v)}
            label="Optimize Path" hint="one routed cut for all parts" />
          {form.sharedLines && (
            <>
              <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
                One operation for the whole sheet. The cuts are joined into as few continuous
                toolpaths as possible, carrying straight on through junctions so the machine need
                not slow for a corner, and the tool stays down in kerf already cut instead of
                lifting. Where two parts stand exactly one cutter apart (Nest with Shared Lines)
                the line between them is cut once. Corner rounding is off.
              </p>
              <div className="mt-1.5">
                <CheckRow id="profile-bridge-gaps" checked={form.bridgeGaps} onChange={(v) => up('bridgeGaps', v)}
                  label="Bridge Gaps Through Waste" hint="joins toolpaths" />
                {form.bridgeGaps && (
                  <>
                    <LengthInput id="profile-bridge-max" valueMM={form.bridgeMaxMM} minMM={1} maxMM={500} stepMM={1}
                      onChangeMM={(v) => up('bridgeMaxMM', v)} />
                    <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
                      May cut straight across a gap between two parts, up to {fmtLen(form.bridgeMaxMM, units)},
                      when that joins two toolpaths and saves time. Never closer to a part than its own
                      cut, never through a tab, never out into free stock. Waste a bridge cuts free is
                      not held — use tape or clamps. Bridges show orange in the preview.
                    </p>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {form.side !== 'centerline' && (
        <div>
          <label htmlFor="profile-stock-allowance" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Stock Allowance</label>
          <LengthInput id="profile-stock-allowance" valueMM={form.allowanceMM} minMM={-5} maxMM={5} stepMM={0.05}
            onChangeMM={(v) => up('allowanceMM', v)} />
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            {allowanceHint}
          </p>
        </div>
      )}
      {/* Hidden for centerline (no wall to finish) and for Optimize Path, whose routed
          network cuts each line once and has no finishing lap of its own. */}
      {form.side !== 'centerline' && !sharing && (
        <div>
          <CheckRow id="profile-finish-pass" checked={form.finishPass} onChange={(v) => up('finishPass', v)}
            label="Finishing Pass" hint="one last pass at full depth" />
          {form.finishPass && (
            <>
              <LengthInput id="profile-finish-pass-mm" valueMM={form.finishPassMM} minMM={0.05} maxMM={3} stepMM={0.05}
                onChangeMM={(v) => up('finishPassMM', v)} />
              <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
                The depth passes stay {fmtLen(form.finishPassMM, units)} off the wall; one pass at full
                depth then takes it off, so the wall is cut in a single light sweep with no step
                lines. It runs after every depth pass, so a part is finished while its tabs still
                hold it — without tabs, hold it down some other way.
              </p>
              <div className="mt-1.5">
                <CheckRow id="profile-spring-pass" checked={form.springPass} onChange={(v) => up('springPass', v)}
                  label="Spring Pass" hint="repeat it once" />
              </div>
            </>
          )}
        </div>
      )}
      {/* Also hidden for centerline: there is no part side to pull the path away from. */}
      {form.side !== 'centerline' && !sharing && (
        <div>
          <CheckRow id="profile-round-corners" checked={form.roundCorners} onChange={(v) => up('roundCorners', v)}
            label="Round Inside Corners" hint="so the machine need not stop" />
          {form.roundCorners && (
            <>
              <LengthInput id="profile-corner-tolerance" valueMM={form.cornerToleranceMM} minMM={0.01} maxMM={2} stepMM={0.05}
                onChangeMM={(v) => up('cornerToleranceMM', v)} />
              <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
                The tool is round, so an inside corner already has its radius. Rounding the
                path lets the machine keep its feed through the corner instead of braking
                with the spindle running. It can leave up to {fmtLen(form.cornerToleranceMM, units)} in
                the bottom of a corner, never cut into the part.
              </p>
            </>
          )}
        </div>
      )}
      <CheckRow id="profile-ramp-in" checked={form.rampIn} onChange={(v) => up('rampIn', v)}
        label="Ramp In" hint="2× dia, 50% feed" />
      <FormNotice msg={skippedInner === 0
        ? skippedOpenMsg(skippedOpen, `an ${form.side} profile`)
        : `${skippedInner + skippedOpen} paths skipped (${skippedInner} inside other shapes${skippedOpen ? `, ${skippedOpen} open` : ''}) — `
          + 'an outside profile cuts round the outermost closed shapes. Use Select Only to cut the rest.'} />
      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={selectedPaths.length === 0 || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={generateLabel(!!editOp, updating)}
      />
      <BatchPathList groups={selectedPaths.map((boundary) => ({ boundary, islands: [] }))}
        addedIds={addedIds} removed={removedPaths} editing={!!editOp} />
    </FormShell>
  )
}
