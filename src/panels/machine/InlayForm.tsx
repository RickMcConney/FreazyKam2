// ─── Inlay form ───────────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, StepDownField, GenerateBtn, useSessionOps, pickToolId, LengthInput, FormError, FormNotice, useGenerateError } from './shared'
import { ToolPicker } from './ToolPicker'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, INLAY_NO_FINISH, type InlayOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { effectiveStepDownMM, seedStepDownMM } from '../../cam/feeds'
import { includedAngleDeg, isVCutter } from '../../cam/geom'
import { groupPathsByContainment, skipOpenPaths, skippedOpenMsg } from './containment'
import { DEFAULT_V_FLOOR_STEP_MM, vFloorRidgeMM } from '../../cam/inlay'
import { runInlayGenerate, inlayEditGroup, type InlaySettings } from '../../tools/inlayRun'
import { inlayTools, inlayFormDefaults } from './opDefaults'

type InlayFormState = InlaySettings

export function InlayForm({ onClose, editOp }: { onClose: () => void; editOp?: InlayOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const paths = usePathsStore((s) => s.paths)
  // Open paths are left out rather than failing the inlay they land in — see skipOpenPaths.
  const { closed: selPaths, skipped: skippedOpen } = skipOpenPaths(useSelectedPaths())
  const operations = useToolpathStore((s) => s.operations)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
  const autoFeedEnabled = useWorkpieceStore((s) => s.autoFeedEnabled)
  const units = useWorkpieceStore((s) => s.units)

  // An inlay only fits if both halves are cut with a known wall and a flat floor, so both
  // lists are strict — no fallback to the whole library when one comes up empty. Roughing
  // clears the socket / frees the plug: end mills only, since a ball nose leaves a
  // scalloped floor for the plug to bottom on and a drill can't clear at all. The finish
  // tool cuts the WALL, and there are exactly two wall shapes the fit maths knows: sloped
  // (V-bit) and flat (end mill).
  const { vbits, endmills, finishers } = inlayTools(tools)
  const defaultVbit = vbits[0] ?? finishers[0]
  const defaultEndmill = endmills[0]

  const [form, setForm] = useState<InlayFormState>(() => {
    const base = editOp ? {
    vbitToolId: editOp.vbitToolId, pocketToolId: editOp.pocketToolId,
    pocketDepthMM: editOp.pocketDepthMM,
    stepDownMM: editOp.stepDownMM, stepDownManual: editOp.stepDownManual ?? false, stepoverPercent: editOp.stepoverPercent,
    glueLineMM: editOp.glueLineMM, clearanceMM: editOp.clearanceMM,
    vFloorStepMM: editOp.vFloorStepMM ?? DEFAULT_V_FLOOR_STEP_MM,
    role: editOp.role, rampIn: editOp.rampIn ?? false, mirrorX: editOp.mirrorX ?? false,
    invert: false,
    cutout: !!editOp.bandId,
  } : { ...mergeWithDefaults(load('inlay'), inlayFormDefaults(defaultVbit, defaultEndmill), tools), invert: false, stepDownManual: false }
    // "None" is an explicit choice, not a stale id — never coerce it to a real tool.
    return { ...base,
      pocketToolId: pickToolId(base.pocketToolId, endmills),
      vbitToolId: base.vbitToolId === INLAY_NO_FINISH
        ? INLAY_NO_FINISH
        : (pickToolId(base.vbitToolId, finishers) || INLAY_NO_FINISH) }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()

  // Finish = "None": roughing tool only, no separate wall-finish pass. Female → flat-walled
  // pocket; male → flat-walled plug freed by the roughing bit. One operation, no pairing.
  const finishIsNone = form.vbitToolId === INLAY_NO_FINISH
  const vbitTool = finishIsNone ? null : tools.find((t) => t.id === form.vbitToolId)
  const pocketTool = tools.find((t) => t.id === form.pocketToolId)
  const editBoundary = editOp ? paths.find((p) => p.id === editOp.pathId) : null
  const editGroup = editOp && editBoundary ? inlayEditGroup(editOp, paths) : null
  const groups = editGroup ? [editGroup] : groupPathsByContainment(selPaths, { invert: form.invert })
  // Nested outlines alternate solid/hole, so a selection that nests has two valid readings
  // and only the user knows which wood is meant to end up as the plug. Once inverted the
  // row has to stay up whatever the grouping looks like, or there is no way back.
  const nested = form.invert || groups.some((g) => g.islands.length > 0)
  const session = useSessionOps()

  // Session key includes role and pair/solo structure: a female and male op for the same
  // shape is a legit paired workflow, and toggling "None — roughing only" changes the op
  // count, so those combinations create fresh ops instead of updating the counterpart.
  const keyPrefix = `${form.role}:${finishIsNone ? 'solo' : 'pair'}:`
  const groupKey = (boundaryId: string) => `${keyPrefix}${boundaryId}`
  // Ops this form session made, for the SAME role and pairing, from paths still selected.
  // The role has to match: generating a female and then a male for one shape is the normal
  // paired workflow, and those must not read as each other's leftovers.
  const selectedIds = new Set(selPaths.map((p) => p.id))
  const sessionOps = editOp ? [] : session.liveEntries()
    .filter((e) => e.key.startsWith(keyPrefix) && selectedIds.has(e.key.slice(keyPrefix.length)))
  // Boundaries this session already covers that the current grouping no longer has —
  // inverting turns every boundary into an island and vice versa, so the whole set is
  // replaced rather than left behind as a second, contradictory pair of operations.
  const staleOps = sessionOps.filter((e) => !groups.some((g) => g.boundary.id === e.key.slice(keyPrefix.length)))
  // Both phases of a stale pair go: they are one operation to the user.
  const staleDeleteIds = staleOps.flatMap((e) => {
    const op = operations.find((o) => o.id === e.opId) as InlayOperation | undefined
    return op?.linkedOpId ? [e.opId, op.linkedOpId] : [e.opId]
  })
  const updating = !editOp && groups.length > 0 && groups.every(({ boundary }) => {
    const firstId = session.liveOpId(groupKey(boundary.id))
    if (!firstId) return false
    if (finishIsNone) return true
    const first = operations.find((o) => o.id === firstId) as InlayOperation | undefined
    return !!first?.linkedOpId && operations.some((o) => o.id === first.linkedOpId)
  })

  function up<K extends keyof InlayFormState>(k: K, v: InlayFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    clearError()
    if (groups.length === 0 || !pocketTool || (!vbitTool && !finishIsNone)) return
    setGenerating(true)

    void runInlayGenerate({
      form, groups, selPaths, editOp, editBoundary, vbitTool, pocketTool, finishIsNone,
      session, groupKey, staleOps, staleDeleteIds, reportError,
      onDone: () => { setGenerating(false); save('inlay', form) },
    })
  }

  const isEndmillMode = !!vbitTool && !isVCutter(vbitTool)
  const canGenerate = groups.length > 0 && (!!vbitTool || finishIsNone) && !!pocketTool && !generating && form.pocketDepthMM > 0
  const isMale = editOp ? editOp.role === 'male' : form.role === 'male'

  return (
    <FormShell title={editOp ? `Edit Inlay (${editOp.role})` : 'New Inlay'} onClose={onClose}>
      {groups.length === 0 && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a closed path first</p>
      )}
      {/* Roughing tool */}
      <div>
        <label htmlFor="inlay-roughing-tool-end" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Roughing Tool (End Mill)</label>
        <ToolPicker id="inlay-roughing-tool-end"
          tools={endmills}
          value={form.pocketToolId}
          onChange={(id) => {
            const t = tools.find((x) => x.id === id)
            if (t) { up('stepDownMM', seedStepDownMM(t)); up('stepDownManual', false) }
            up('pocketToolId', id)
          }}
          emptyText="No end mill — add one in the Tool Library" />
      </div>
      {/* Finish tool */}
      <div>
        <label htmlFor="inlay-finishing-tool" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Finishing Tool</label>
        {/* None skips the wall-finish pass — the roughing bit alone forms the socket / plug walls. */}
        <ToolPicker id="inlay-finishing-tool"
          tools={finishers}
          value={form.vbitToolId}
          onChange={(id) => up('vbitToolId', id)}
          none={{ value: INLAY_NO_FINISH, label: 'None — roughing only' }} />
        {finishIsNone && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">No finish pass — flat walls left by the roughing tool (corners at its radius).</p>
        )}
        {vbitTool && isVCutter(vbitTool) && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            {vbitTool.type === 'taper' ? 'Taper — sloped bevel walls, rounded at the foot' : 'V-bit — sloped bevel walls'}
          </p>
        )}
        {vbitTool?.type === 'taper' && (
          /* Measured with scripts/inlay-fit.mts: the plug always seats (no interference),
             but the tip ball rounds the foot of the PLUG wall while the socket's own
             rounding sits at its deep end — so the two do not meet at the finished face.
             A V-bit's cone is its own mirror image and closes completely. */
          <p className="text-label text-amber-600 dark:text-amber-500 mt-0.5">
            Leaves a hairline gap around the inlay at the finished face, up to the Ø{fmtLen(vbitTool.diameterMM, units)} tip&rsquo;s radius. A V-bit closes fully.
          </p>
        )}
        {vbitTool && !isVCutter(vbitTool) && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">End mill — flat walls, corners auto-rounded to Ø{fmtLen(vbitTool.diameterMM, units)}</p>
        )}
      </div>
      {vbitTool && isVCutter(vbitTool) && (
        <p className="text-label text-gray-600 dark:text-neutral-400">
          {vbitTool.type === 'taper'
            ? `Taper: ${vbitTool.vbitAngleDeg ?? 5}° per side, Ø${fmtLen(vbitTool.diameterMM, units)} tip (set on tool)`
            : `V-bit angle: ${includedAngleDeg(vbitTool)}° (set on tool)`}
        </p>
      )}
      {/* Depth */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="inlay-inlay-depth" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Inlay Depth</label>
          <LengthInput id="inlay-inlay-depth" valueMM={form.pocketDepthMM} minMM={0.5} stepMM={0.5}
            onChangeMM={(v) => up('pocketDepthMM', v)} />
        </div>
        <StepDownField stepDownMM={form.stepDownMM} onStep={(v) => up('stepDownMM', v)} minMM={0.1}
          autoMM={autoFeedEnabled && pocketTool ? effectiveStepDownMM(pocketTool, form.stepDownMM, form.pocketDepthMM) : null}
          manual={form.stepDownManual} onManual={(v) => up('stepDownManual', v)} />
      </div>
      {/* Stepover */}
      <div>
        <label htmlFor="inlay-stepover" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Stepover <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input id="inlay-stepover" type="range" min={10} max={90} step={5} value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      {/* Glue + clearance */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="inlay-glue-gap" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Glue Gap</label>
          <LengthInput id="inlay-glue-gap" valueMM={form.glueLineMM} minMM={0} stepMM={0.05}
            onChangeMM={(v) => up('glueLineMM', v)} />
        </div>
        <div>
          <label htmlFor="inlay-clearance" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Clearance</label>
          <LengthInput id="inlay-clearance" valueMM={form.clearanceMM} minMM={-1} maxMM={1} stepMM={0.05}
            onChangeMM={(v) => up('clearanceMM', v)} />
        </div>
      </div>
      {/* V-bit floor step (female): how far apart the tip's loops run in the corners the end
          mill cannot reach, and the ridge that leaves — against the glue gap, since a ridge
          under it cannot touch the plug. */}
      {form.role === 'female' && (() => {
        const tanHalf = Math.tan(((vbitTool ? includedAngleDeg(vbitTool) : 60) / 2) * Math.PI / 180)
        const ridge = vFloorRidgeMM(form.vFloorStepMM, tanHalf)
        const tall = ridge > form.glueLineMM + 1e-9
        return (
          <div>
            <label htmlFor="inlay-vfloor-step" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">V-bit Floor Step</label>
            <LengthInput id="inlay-vfloor-step" valueMM={form.vFloorStepMM} minMM={0.01} maxMM={5} stepMM={0.05}
              onChangeMM={(v) => up('vFloorStepMM', v)} />
            <p className={`text-label mt-0.5 ${tall ? 'text-amber-600 dark:text-amber-400' : 'text-gray-600 dark:text-neutral-400'}`}>
              Spacing of the V-bit's passes in corners the end mill can't reach. Leaves ridges {fmtLen(ridge, units, 2)} high
              {tall ? ` — taller than the glue gap, so the plug may sit on them unless they break away` : ' — under the glue gap'}.
            </p>
          </div>
        )
      })()}
      {!editOp && (
        <div>
          <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Generate</div>
          <div className="flex gap-1">
            {(['female', 'male'] as const).map((r) => (
              <button key={r} onClick={() => up('role', r)}
                className={[
                  'flex-1 py-1 text-body rounded border transition-colors capitalize',
                  form.role === r
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-gray-50 dark:bg-neutral-900 border-gray-400 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
                ].join(' ')}>
                {r === 'female' ? 'Female' : 'Male'}
              </button>
            ))}
          </div>
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-1">
            {isEndmillMode
              ? (form.role === 'female' ? 'Socket only — flat pocket, corners rounded to bit radius.' : 'Plug only — flat-sided plug, corners rounded to bit radius.')
              : (form.role === 'female' ? 'Socket only — pocket + V-carved walls.' : 'Plug only — V-carved bevel + profile cutout.')}
          </p>
        </div>
      )}
      {/* Which half of a nested selection is the plug. Same grouping flip as Invert Pocket:
          nested outlines alternate solid/hole, so a field with a design inside it can be
          read either way and only the user knows which wood is meant to show. */}
      {!editOp && nested && (
        <div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="inlay-invert" checked={form.invert}
              onChange={(e) => up('invert', e.target.checked)} className="accent-blue-500" />
            <label htmlFor="inlay-invert" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
              Invert
            </label>
          </div>
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            {form.invert
              ? 'The inner shapes are the plug — they end up in the male board’s wood on a field of the female’s.'
              : 'The field around the inner shapes is the plug — the shapes end up in the female board’s wood.'}
          </p>
        </div>
      )}

      {/* Ramp In — angled/helical entry on roughing pockets and end-mill finish passes */}
      <div className="flex items-center gap-2">
        <input type="checkbox" id="inlay-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="inlay-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-600 dark:text-neutral-400 normal-case">(2× dia, 50% feed)</span>
        </label>
      </div>

      {/* Mirror option — male plug only */}
      {isMale && (
        <div className="flex items-center gap-2">
          <input type="checkbox" id="inlay-mirror" checked={form.mirrorX}
            onChange={(e) => up('mirrorX', e.target.checked)} className="accent-blue-500" />
          <label htmlFor="inlay-mirror" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
            Mirror <span className="text-gray-600 dark:text-neutral-400 normal-case">(flip horizontally — for asymmetric shapes inserted reversed)</span>
          </label>
        </div>
      )}
      {/* Cut-out outline — male only. */}
      {isMale && (
        <div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="inlay-cutout" checked={form.cutout}
              onChange={(e) => up('cutout', e.target.checked)} className="accent-blue-500" />
            <label htmlFor="inlay-cutout" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
              Cut-out Outline <span className="text-gray-600 dark:text-neutral-400 normal-case">(a path round the plug to free it)</span>
            </label>
          </div>
          {form.cutout && (
            <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
              Draws a path round the plug — its own outline for one shape, a band round all of
              them for lettering — clears everything inside it to the plug depth, and adds an
              outside Profile on it right through the stock to cut the piece free. That profile is
              an ordinary operation: open it to add tabs or change its depth. The path is redrawn
              on every Generate; for a boundary of your own, draw it round the plug, select both and
              use Invert.
            </p>
          )}
        </div>
      )}
      {!editOp && <FormNotice msg={skippedOpenMsg(skippedOpen, 'an inlay')} />}
      <FormError msg={errorMsg} />
      <GenerateBtn disabled={!canGenerate} generating={generating} onClick={handleGenerate}
        title={groups.length > 1 ? `Creates ${groups.length * (finishIsNone ? 1 : 2)} operations` : undefined}
        label={editOp
          ? `Regenerate ${editOp.role === 'female' ? 'Female' : 'Male'} Toolpath`
          : `${updating ? 'Update' : 'Generate'} ${form.role === 'female' ? 'Female' : 'Male'} Toolpath`} />
      {/* Below the button — see PathListSection. Islands keep their label because that
          is a real distinction; nothing else needs one. */}
      <PathListSection count={groups.reduce((n, g) => n + 1 + g.islands.length + (isMale && g.field ? 1 : 0), 0)}
        toggle={!editOp}>
        {groups.map(({ boundary, islands, field }) => (
          <div key={boundary.id} className="space-y-0.5">
            <PathChip path={boundary} />
            {islands.map((p) => <PathChip key={p.id} path={p} label="island" />)}
            {/* The male clears the wood between the plug and this path; the female never
                machines outside its socket, so it plays no part there. */}
            {isMale && field && <PathChip path={field} label="field" />}
          </div>
        ))}
      </PathListSection>
    </FormShell>
  )
}
