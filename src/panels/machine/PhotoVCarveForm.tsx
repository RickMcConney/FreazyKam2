// ─── Photo V-Carve form ───────────────────────────────────────────────────────
import { FormShell, ToolSelector, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, LengthInput, FormError, useGenerateError, discardFailedOps } from './shared'
import { type StartFrom } from '../../cam/startHeight'
import { useState, useEffect } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, type AnyOperation, type PhotoVCarveOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen, lenValue } from '../../store/workpieceStore'
import { isWorkCancelled } from '../../workers/workerClient'
import { generateOperation } from '../../cam/opJob'
import { extractRectInfo } from '../../canvas/selectionUtils'
import { grooveWidthMM, lineSpacingMM } from '../../cam/photoVcarve'

interface PhotoVCarveFormState {
  toolId: string
  pathId: string
  passAngleDeg: number
  minDepthMM: number
  maxDepthMM: number
  startFrom: StartFrom
}

// Raster lines are undirected — 200° and 20° lay down the same lines — so every angle has an
// equivalent in [0, 180), which is the range the slider offers.
function norm180(deg: number) {
  const d = ((deg % 180) + 180) % 180
  return Math.round(d / 5) * 5 % 180
}

export function PhotoVCarveForm({ onClose, editOp }: { onClose: () => void; editOp?: PhotoVCarveOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const paths = usePathsStore((s) => s.paths)
  const addOperation = useToolpathStore((s) => s.addOperation)
  const updateOperation = useToolpathStore((s) => s.updateOperation)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
  const units = useWorkpieceStore((s) => s.units)

  // V-bits only — the groove width the line spacing is derived from is 2·d·tan(θ/2), which
  // exists only for a cone. See VCarveForm on the dropped fall-back to every tool.
  const vbits = toolsOfType(tools, ['vbit'])
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
    } : mergeWithDefaults(load('photovcarve'), {
      toolId: defaultTool?.id ?? '',
      pathId: imagePaths[0]?.id ?? '',
      passAngleDeg: 0,
      // White cuts nothing, black cuts 0.6 mm. Shallow on purpose: the depth sets the line
      // spacing, so this is the resolution control — 0.6 mm on a 60° bit gives 0.69 mm lines.
      minDepthMM: 0,
      maxDepthMM: 0.6,
      // Deliberately not carried over from the saved defaults — see PocketForm.
      startFrom: { mode: 'auto' } as StartFrom,
    }, tools)
    // An op or saved default from before the slider can hold any angle in ±180. Fold it into
    // the slider's half turn rather than let the control clamp it to a different raster.
    return {
      ...init,
      toolId: pickToolId(init.toolId, vbits),
      passAngleDeg: norm180(init.passAngleDeg),
      ...(editOp ? {} : { startFrom: { mode: 'auto' as const } }),
    }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
  const session = useSessionOps()

  // Saved defaults carry a path id from a previous session, which no longer exists — and
  // an image imported while this form is open should be picked up (same as Profile3dForm).
  useEffect(() => {
    if (!imagePaths.find((p) => p.id === form.pathId)) {
      const first = imagePaths[0]
      if (first) setForm((f) => ({ ...f, pathId: first.id }))
    }
  }, [imagePaths.length]) // eslint-disable-line react-hooks/exhaustive-deps

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
    setGenerating(true)
    clearError()
    // Re-Generate for an image this form already carved updates that op in place.
    const existingId = editOp ? undefined : session.liveOpId(form.pathId)
    const updateId = editOp?.id ?? existingId
    const opName = `Photo V-Carve: ${selectedPath.name} (${selectedTool.name})`

    // WRITE THE SETTINGS, THEN GENERATE FROM THE OPERATION — the order every other form
    // uses, and the only one in which the toolpath is by construction what the operation
    // says. This form used to generate first and store the settings afterwards, so an
    // edit that picked a different image carved the new picture onto an operation still
    // naming the old one, and the next automatic regenerate carved the old one again.
    let opId: string
    if (updateId) {
      updateOperation(updateId, {
        toolId: form.toolId, pathId: form.pathId, angleDeg, passAngleDeg: form.passAngleDeg,
        minDepthMM: form.minDepthMM, maxDepthMM: form.maxDepthMM,
        startFrom: form.startFrom,
        name: opName, status: 'generating',
      } as Partial<AnyOperation>)
      opId = updateId
    } else {
      opId = addOperation({
        name: opName,
        type: 'photovcarve',
        toolId: form.toolId,
        pathId: form.pathId,
        angleDeg,
        passAngleDeg: form.passAngleDeg,
        minDepthMM: form.minDepthMM,
        maxDepthMM: form.maxDepthMM,
        startFrom: form.startFrom,
      })
      // Remembered before generating, so a re-Generate after a cancel updates this op
      // rather than adding a second one.
      session.remember(form.pathId, opId)
      updateOperation(opId, { status: 'generating' })
    }

    setTimeout(async () => {
      try {
        // The start height, the image decode and the rectangle check all live in the
        // shared call (cam/opJob), exactly as an automatic regenerate runs them.
        await generateOperation(opId)
        save('photovcarve', form)
      } catch (err) {
        if (!isWorkCancelled(err)) {
          reportError(opId, err)
          // A Generate that failed leaves nothing behind — but only an op this click made.
          if (!updateId) discardFailedOps([opId])
        }
      } finally {
        setGenerating(false)
      }
    }, 0)
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
