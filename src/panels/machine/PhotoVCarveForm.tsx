// ─── Photo V-Carve form ───────────────────────────────────────────────────────
import { FormShell, ToolSelector, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, LengthInput, FormError, useSingleGenerate } from './shared'
import { type StartFrom } from '../../cam/startHeight'
import { useState, useEffect } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { type PhotoVCarveOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen, lenValue } from '../../store/workpieceStore'
import { extractRectInfo } from '../../canvas/selectionUtils'
import { grooveWidthMM, lineSpacingMM } from '../../cam/photoVcarve'
import { PHOTO_VCARVE_TOOL_TYPES, photoVcarveFormDefaults, norm180 } from './opDefaults'

interface PhotoVCarveFormState {
  toolId: string
  pathId: string
  passAngleDeg: number
  minDepthMM: number
  maxDepthMM: number
  startFrom: StartFrom
}


export function PhotoVCarveForm({ onClose, editOp }: { onClose: () => void; editOp?: PhotoVCarveOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const paths = usePathsStore((s) => s.paths)
  const load = useFormDefaultsStore((s) => s.load)
  const units = useWorkpieceStore((s) => s.units)

  // V-bits only — see PHOTO_VCARVE_TOOL_TYPES.
  const vbits = toolsOfType(tools, PHOTO_VCARVE_TOOL_TYPES)
  const defaultTool = vbits[0]
  const imagePaths = paths.filter((p) => !!p.imageSrc)

  const [form, setForm] = useState<PhotoVCarveFormState>(() => {
    const init = editOp ? {
      toolId: editOp.toolId,
      pathId: editOp.pathId,
      passAngleDeg: editOp.passAngleDeg,
      minDepthMM: editOp.minDepthMM,
      maxDepthMM: editOp.maxDepthMM,
      startFrom: editOp.startFrom ?? { mode: 'stock' as const },
    } : mergeWithDefaults(load('photovcarve'), photoVcarveFormDefaults(defaultTool, imagePaths[0]?.id ?? ''), tools)
    // An op or saved default from before the slider can hold any angle in ±180. Fold it into
    // the slider's half turn rather than let the control clamp it to a different raster.
    return {
      ...init,
      toolId: pickToolId(init.toolId, vbits),
      passAngleDeg: norm180(init.passAngleDeg),
      ...(editOp ? {} : { startFrom: { mode: 'auto' as const } }),
    }
  })
  const session = useSessionOps()
  const { generating, errorMsg, generate } = useSingleGenerate<PhotoVCarveFormState>('photovcarve', 'photovcarve', session)

  // Saved defaults carry a path id from a previous session, which no longer exists — and
  // an image imported while this form is open should be picked up (same as Profile3dForm).
  // Keyed on the IDS, not the count: one edit that swaps a picture for another (an undo
  // and a re-import, a delete and an add in one step) leaves the count alone, and the form
  // kept pointing at the deleted one with Generate disabled and nothing to say why.
  const imageIdsKey = imagePaths.map((p) => p.id).join()
  useEffect(() => {
    if (!imagePaths.find((p) => p.id === form.pathId)) {
      const first = imagePaths[0]
      if (first) setForm((f) => ({ ...f, pathId: first.id }))
    }
  }, [imageIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTool = tools.find((t) => t.id === form.toolId)
  const selectedPath = paths.find((p) => p.id === form.pathId)
  // The angle is a property of the grind, not of the operation — same as V-Carve.
  const angleDeg = selectedTool?.vbitAngleDeg ?? 60
  // Derived, not chosen: the deepest groove's width. Shown so the operator can see what
  // the depth just bought them in resolution.
  const spacingMM = lineSpacingMM(form.maxDepthMM, angleDeg)
  const rect = selectedPath ? extractRectInfo(selectedPath.d) : null
  // Same count the generator lays down: the image's extent measured ACROSS the raster
  // lines, so turning the angle changes it.
  const th = form.passAngleDeg * Math.PI / 180
  const bandMM = rect ? Math.abs(rect.widthMM * Math.sin(th)) + Math.abs(rect.heightMM * Math.cos(th)) : 0
  const lineCount = rect ? Math.max(1, Math.floor(bandMM / spacingMM) + 1) : 0
  // Margin 0: the raster is clipped to the picture's own rectangle. See VCarveForm for
  // why an op this session already generated is not a cut preceding itself.
  const selfOpId = editOp?.id ?? session.liveOpId(form.pathId)
  const startZ = useStartZ(form.startFrom, selectedPath?.d ?? '', 0, selfOpId)

  function up<K extends keyof PhotoVCarveFormState>(k: K, v: PhotoVCarveFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (!selectedTool || !selectedPath?.imageSrc) return
    // Settings are written to the operation, then it is generated from them (cam/opJob) —
    // the only order in which the toolpath is by construction what the operation says.
    // Re-Generate for an image this form already carved updates that op in place.
    void generate({
      key: form.pathId,
      name: `Photo V-Carve: ${selectedPath.name} (${selectedTool.name})`,
      settings: {
        toolId: form.toolId, pathId: form.pathId, angleDeg, passAngleDeg: form.passAngleDeg,
        minDepthMM: form.minDepthMM, maxDepthMM: form.maxDepthMM, startFrom: form.startFrom,
      },
      editOp,
    }, form)
  }

  const canGenerate = !!selectedTool && selectedTool.type === 'vbit' && !!selectedPath?.imageSrc
    && !generating && form.maxDepthMM > 0

  return (
    <FormShell title={editOp ? 'Edit Photo V-Carve' : 'New Photo V-Carve'} onClose={onClose}>
      {/* Source image */}
      <div>
        <label htmlFor="photov-image" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Image</label>
        {imagePaths.length === 0 ? (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> Import a PNG, JPEG or WebP first
          </p>
        ) : (
          <select id="photov-image"
            value={form.pathId}
            onChange={(e) => up('pathId', e.target.value)}
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
          >
            {imagePaths.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        {rect && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            {fmtLen(rect.widthMM, units, 1)} × {fmtLen(rect.heightMM, units, 1)} on the stock — resize it on the canvas
          </p>
        )}
      </div>

      <ToolSelector tools={vbits} value={form.toolId} onChange={(id) => up('toolId', id)} />
      {selectedTool && selectedTool.type !== 'vbit' && (
        <p className="text-label text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.xs} /> Photo V-Carve requires a V-bit tool.
        </p>
      )}
      {selectedTool?.type === 'vbit' && (
        <p className="text-label text-gray-600 dark:text-neutral-400">
          V-bit angle: {angleDeg}° (set on tool)
        </p>
      )}

      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={selfOpId} />

      {/* Raster angle — a slider over half a turn, same control as the pocket pass angle.
          Lines have no direction of their own, so 180° is 0° again and the range covers
          every distinct raster orientation. */}
      <div>
        <label htmlFor="photov-angle" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Angle <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.passAngleDeg}°</span>
        </label>
        <input id="photov-angle"
          type="range" min={0} max={180} step={5}
          value={form.passAngleDeg}
          onChange={(e) => up('passAngleDeg', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>

      {/* Depth range — the greyscale maps onto this band */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="photov-depth-at-white" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Depth at White</label>
          <LengthInput id="photov-depth-at-white" valueMM={form.minDepthMM} minMM={0} stepMM={0.1}
            onChangeMM={(v) => up('minDepthMM', v)} />
        </div>
        <div>
          <label htmlFor="photov-depth-at-black" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Depth at Black</label>
          <LengthInput id="photov-depth-at-black" valueMM={form.maxDepthMM} minMM={0.05} stepMM={0.1}
            onChangeMM={(v) => up('maxDepthMM', v)} />
        </div>
      </div>
      {/* Line spacing is not a setting — it IS the width of the deepest groove, so the
          darkest lines just meet and nothing is cut twice. Shown, not editable: the depth
          above is the resolution control, and this is what it bought. */}
      <div>
        <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Line Spacing <span className="text-blue-500 dark:text-blue-400 normal-case">(from depth)</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex-1 bg-gray-100 dark:bg-neutral-800 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-500 dark:text-neutral-400 min-w-0 font-mono">
            {lenValue(spacingMM, units)}
          </div>
          <span className="flex-shrink-0 text-label text-gray-600 dark:text-neutral-400 select-none">{units}</span>
          {lineCount > 0 && (
            <span className="text-label text-gray-600 dark:text-neutral-400 ml-1">({lineCount} lines)</span>
          )}
        </div>
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
          Grooves run {fmtLen(grooveWidthMM(form.minDepthMM, angleDeg), units)}–{fmtLen(spacingMM, units)} wide, so a shallower
          carve is a finer one. A deeper carve has more contrast and fewer, wider lines.
        </p>
      </div>
      {/* Reach from stock top: carving into a pocket floor adds that much to the total. */}
      {selectedTool && form.maxDepthMM - startZ.zMM > selectedTool.maxDepthMM && (
        <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1">
          <AlertCircle size={10} className="shrink-0" />
          Exceeds tool Max Z ({fmtLen(selectedTool.maxDepthMM, units)})
        </p>
      )}

      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={!canGenerate}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : session.liveOpId(form.pathId) ? 'Update Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}
