// ─── 3D Profile form ──────────────────────────────────────────────────────────
import { FormShell, AutoStepField, GenerateBtn, useSessionOps, toolsOfType, pickToolId, LengthInput, FormError, useGenerateError, discardFailedOps } from './shared'
import { ToolPicker } from './ToolPicker'
import { useState, useEffect, useMemo } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { NUMERIC_HINT } from '../../components/parseNumeric'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, type AnyOperation, type Profile3dOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { isWorkCancelled } from '../../workers/workerClient'
import { generateOperation } from '../../cam/opJob'
import { effectiveStepDownMM } from '../../cam/feeds'
import { profile3dDepthMM, STOCK_SKIN_MM, modelBelowCut, MODEL_BELOW_CUT_MSG } from '../../cam/profile3d'
import { enclosingBoundaries } from '../../cam/boundaryCandidates'
import { DEFAULT_RELIEF_MM, depthMapFloorLevel } from '../../cam/depthMapMesh'
import { loadImageLuminance } from '../../io/imageLuminance'

interface Profile3dFormState {
  toolId: string
  stepoverPercent: number
  finishStrategy: 'raster' | 'waterline'
  boundary: 'model' | 'stock' | 'path'
  boundaryPathId: string
  modelTopMM: number
  rasterAngleDeg: number
  maxDepthMM: number
  pathId: string
  reliefDepthMM: number         // depth map only
  invertDepth: boolean          // depth map only: dark is high
  roughingToolId: string        // '' = no roughing pass
  roughingStepoverPercent: number
  roughingStepDownMM: number
  roughingStockAllowanceMM: number
  roughingRasterAngleDeg: number | ''  // '' = auto (finishing angle + 90)
}

export function Profile3dForm({ onClose, editOp }: { onClose: () => void; editOp?: Profile3dOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const paths = usePathsStore((s) => s.paths)
  const addOperation = useToolpathStore((s) => s.addOperation)
  const updateOperation = useToolpathStore((s) => s.updateOperation)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)
  const autoFeedEnabled = useWorkpieceStore((s) => s.autoFeedEnabled)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const units = useWorkpieceStore((s) => s.units)

  // Finishing: a ball nose or a taper — profile3d dilates the height map by the tool's
  // own profile, and a taper is a tip ball blended into a cone, so both are gouge-free
  // by the same construction. No fall-back to the whole library; `canGenerate` gates it.
  // The ROUGHING bit is a ball nose or a flat end mill — the two shapes profile3d models
  // a rougher as. Any other type (a V-bit, a drill) would silently become no roughing pass
  // at all, so it is not offered.
  const finishTools = toolsOfType(tools, ['ballnose', 'bullnose', 'taper'])
  const roughTools = toolsOfType(tools, ['ballnose', 'bullnose', 'endmill'])
  const defaultTool = finishTools[0]
  // The model: an STL, or an imported picture read as a depth map (cam/depthMapMesh).
  const stlPaths = paths.filter((p) => !!p.stlSrc)
  const imagePaths = paths.filter((p) => !!p.imageSrc)
  const modelPaths = [...stlPaths, ...imagePaths]

  const [form, setForm] = useState<Profile3dFormState>(() => {
    const base: Profile3dFormState = editOp ? {
      toolId: editOp.toolId,
    stepoverPercent: editOp.stepoverPercent,
    finishStrategy: editOp.finishStrategy === 'raster' || !editOp.finishStrategy ? 'raster' : 'waterline',
    boundary: editOp.boundary ?? 'model',
    boundaryPathId: editOp.boundaryPathId ?? '',
    modelTopMM: editOp.modelTopMM ?? 0,
    rasterAngleDeg: editOp.rasterAngleDeg,
    maxDepthMM: editOp.maxDepthMM,
    pathId: editOp.pathId,
    reliefDepthMM: editOp.reliefDepthMM ?? DEFAULT_RELIEF_MM,
    invertDepth: !!editOp.invertDepth,
    roughingToolId: editOp.roughingToolId ?? '',
    roughingStepoverPercent: editOp.roughingStepoverPercent ?? 60,
    roughingStepDownMM: editOp.roughingStepDownMM ?? 2,
    roughingStockAllowanceMM: editOp.roughingStockAllowanceMM ?? 0.3,
    roughingRasterAngleDeg: editOp.roughingRasterAngleDeg ?? '',
  } : mergeWithDefaults(load('profile3d'), {
    toolId: defaultTool?.id ?? '',
    stepoverPercent: 20,
    finishStrategy: 'raster' as 'raster' | 'waterline',
    boundary: 'model' as 'model' | 'stock' | 'path',
    boundaryPathId: '',
    modelTopMM: 0,
    rasterAngleDeg: 0,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    maxDepthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    pathId: modelPaths[0]?.id ?? '',
    reliefDepthMM: DEFAULT_RELIEF_MM,
    invertDepth: false,
    roughingToolId: '',
    roughingStepoverPercent: 60,
    roughingStepDownMM: 2,
    roughingStockAllowanceMM: 0.3,
    roughingRasterAngleDeg: '' as number | '',
  }, tools)
    // A saved default's boundary path is an id from the session it was saved in. Kept, it
    // showed "Model box" in the select (no option matched) while the form still said
    // 'path', and Generate was disabled with nothing visible to say why.
    const staleBoundary = base.boundary === 'path' && !paths.some((p) => p.id === base.boundaryPathId)
    return { ...base,
      ...(staleBoundary ? { boundary: 'model' as const, boundaryPathId: '' } : {}),
      toolId: pickToolId(base.toolId, finishTools),
      // '' is "no roughing pass" — an explicit choice, not a stale id.
      roughingToolId: base.roughingToolId === '' ? '' : pickToolId(base.roughingToolId, roughTools) }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
  const session = useSessionOps()

  // Sync pathId: saved defaults use session-specific path IDs that become stale on reload.
  // Also handles importing a model after the form is already open.
  useEffect(() => {
    if (!modelPaths.find((p) => p.id === form.pathId)) {
      const first = modelPaths[0]
      if (first) setForm((f) => ({ ...f, pathId: first.id }))
    }
  }, [modelPaths.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTool = tools.find((t) => t.id === form.toolId)
  const selectedPath = paths.find((p) => p.id === form.pathId)
  const isDepthMap = !!selectedPath?.imageSrc
  const hasModel = !!selectedPath && (isDepthMap || (!!selectedPath.stlSrc && !!selectedPath.stlModelBounds))
  // A depth map is finished by raster only: waterline ran out of memory on one. The form
  // keeps its own choice, so going back to an STL brings Waterline back.
  const strategy = isDepthMap ? 'raster' : form.finishStrategy
  // The picture's background level, as the carve will find it (cam/depthMapMesh) — shown so
  // the floor is not a silent guess. Decoded through the same cache the generate uses.
  const [floorLevel, setFloorLevel] = useState<number | null>(null)
  const imageSrc = selectedPath?.imageSrc
  useEffect(() => {
    setFloorLevel(null)
    if (!imageSrc) return
    let live = true
    loadImageLuminance(imageSrc).then((img) => { if (live) setFloorLevel(depthMapFloorLevel(img, form.invertDepth)) }, () => {})
    return () => { live = false }
  }, [imageSrc, form.invertDepth])
  // Offered as a boundary: the (up to three) closed paths that completely enclose the
  // model, tightest first. The one this op already uses stays on the list whatever it has
  // since become, so opening an op never quietly swaps its boundary.
  const boundaryPaths = useMemo(() => {
    const fits = selectedPath ? enclosingBoundaries(paths, selectedPath) : []
    const current = form.boundary === 'path' ? paths.find((p) => p.id === form.boundaryPathId) : undefined
    return current && !fits.includes(current) ? [...fits, current] : fits
  }, [paths, selectedPath, form.boundary, form.boundaryPathId])
  const roughingTool = form.roughingToolId ? tools.find((t) => t.id === form.roughingToolId) : undefined
  const hasRoughing = !!form.roughingToolId

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId }))
  }

  function up<K extends keyof Profile3dFormState>(k: K, v: Profile3dFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (!selectedTool || !selectedPath || !hasModel) return
    setGenerating(true)
    clearError()
    // Re-Generate for a model this form already generated for updates that op in place.
    const existingId = editOp ? undefined : session.liveOpId(form.pathId)
    const updateId = editOp?.id ?? existingId
    const opName = hasRoughing
      ? `3D Profile: ${selectedPath.name} (rough: ${roughingTool?.name ?? ''} / finish: ${selectedTool.name})`
      : `3D Profile: ${selectedPath.name} (${selectedTool.name})`

    // WRITE THE SETTINGS, THEN GENERATE FROM THE OPERATION — see PhotoVCarveForm. This
    // form generated first and stored afterwards, so an edit that picked a different model
    // cut it onto an operation still naming the old one.
    // The op's settings, written the same way whether it is new or edited: an unused
    // roughing or boundary field is cleared, not left behind from an earlier setting.
    const settings = {
      name: opName,
      toolId: form.toolId,
      pathId: form.pathId,
      reliefDepthMM: isDepthMap ? form.reliefDepthMM : undefined,
      invertDepth: isDepthMap && form.invertDepth ? true : undefined,
      stepoverPercent: form.stepoverPercent,
      finishStrategy: strategy,
      boundary: form.boundary,
      boundaryPathId: form.boundary === 'path' ? form.boundaryPathId : undefined,
      modelTopMM: form.modelTopMM > 0 ? form.modelTopMM : undefined,
      rasterAngleDeg: form.rasterAngleDeg,
      maxDepthMM: form.maxDepthMM,
      roughingToolId: hasRoughing ? form.roughingToolId : undefined,
      roughingStepoverPercent: hasRoughing ? form.roughingStepoverPercent : undefined,
      roughingStepDownMM: hasRoughing ? form.roughingStepDownMM : undefined,
      roughingStockAllowanceMM: hasRoughing ? form.roughingStockAllowanceMM : undefined,
      roughingRasterAngleDeg: hasRoughing && form.roughingRasterAngleDeg !== '' ? form.roughingRasterAngleDeg : undefined,
    } satisfies Partial<Profile3dOperation>
    let opId: string
    if (updateId) {
      updateOperation(updateId, { ...settings, status: 'generating' } as Partial<AnyOperation>)
      opId = updateId
    } else {
      opId = addOperation({ ...settings, type: 'profile3d' })
      // Remembered before generating, so a re-Generate after a cancel updates this op
      // rather than adding a second one.
      session.remember(form.pathId, opId)
      updateOperation(opId, { status: 'generating' })
    }

    setTimeout(async () => {
      try {
        // The STL decode, the outline check and the roughing parameters all live in the
        // shared call (cam/opJob), exactly as an automatic regenerate runs them.
        await generateOperation(opId)
        save('profile3d', form)
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

  const depthCutMM = profile3dDepthMM(form.maxDepthMM, thicknessMM)
  const nothingReached = modelBelowCut(form.modelTopMM, depthCutMM)
  const canGenerate = !nothingReached && !!selectedTool && (selectedTool.type === 'ballnose' || selectedTool.type === 'bullnose' || selectedTool.type === 'taper') && hasModel && !generating && form.maxDepthMM > 0
    && (!isDepthMap || form.reliefDepthMM > 0)
    && (form.boundary !== 'path' || boundaryPaths.some((p) => p.id === form.boundaryPathId))

  return (
    <FormShell title={editOp ? 'Edit 3D Profile' : 'New 3D Profile'} onClose={onClose}>
      {/* Model: an STL, or a picture read as a depth map */}
      <div>
        <label htmlFor="p3d-stl-model" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Model</label>
        {modelPaths.length === 0 ? (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> Import an STL or a depth map image first
          </p>
        ) : (
          <select id="p3d-stl-model"
            value={form.pathId}
            onChange={(e) => up('pathId', e.target.value)}
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
          >
            {stlPaths.length > 0 && <optgroup label="STL">
              {stlPaths.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>}
            {imagePaths.length > 0 && <optgroup label="Depth map image">
              {imagePaths.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>}
          </select>
        )}
      </div>

      {/* A depth map's height comes from brightness: how tall, and which way up */}
      {isDepthMap && (
        <div>
          <label htmlFor="p3d-relief" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Relief Depth</label>
          <LengthInput id="p3d-relief" valueMM={form.reliefDepthMM} minMM={0.1} stepMM={0.5}
            onChangeMM={(v) => up('reliefDepthMM', v)} />
          <label className="flex items-center gap-2 mt-1 text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
            <input type="checkbox" checked={form.invertDepth}
              onChange={(e) => up('invertDepth', e.target.checked)} />
            Dark is high
          </label>
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            {form.invertDepth ? 'Black' : 'White'} is the top of the relief; the background is {fmtLen(form.reliefDepthMM, units)} below it, and anything {form.invertDepth ? 'lighter' : 'darker'} is cut flat there.
            {floorLevel !== null && <> Background: grey {form.invertDepth ? 255 - floorLevel : floorLevel}{form.invertDepth ? ' and above' : ' and below'}.</>}
          </p>
          {form.modelTopMM + form.reliefDepthMM > depthCutMM + 1e-9 && !nothingReached && (
            <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
              <AlertCircle size={10} className="shrink-0" /> Deeper than Max Depth — the lowest parts are cut flat at {fmtLen(depthCutMM, units)}
            </p>
          )}
        </div>
      )}

      {/* Where the cut may go */}
      <div>
        <label htmlFor="p3d-boundary" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Boundary</label>
        <select id="p3d-boundary"
          value={form.boundary === 'path' ? `path:${form.boundaryPathId}` : form.boundary}
          onChange={(e) => {
            const v = e.target.value
            if (v.startsWith('path:')) setForm((f) => ({ ...f, boundary: 'path', boundaryPathId: v.slice(5) }))
            else setForm((f) => ({ ...f, boundary: v as 'model' | 'stock' }))
          }}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
        >
          <option value="model">Model box</option>
          <option value="stock">Stock</option>
          {boundaryPaths.map((p) => (
            <option key={p.id} value={`path:${p.id}`}>{p.name}</option>
          ))}
        </select>
        {boundaryPaths.length === 0 && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            Draw a closed shape around the model to clear to it.
          </p>
        )}
        {form.boundary !== 'model' && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            The tool stays inside; around the model it cuts down to the model's base.
          </p>
        )}
        {form.boundary === 'path' && !boundaryPaths.some((p) => p.id === form.boundaryPathId) && (
          <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" /> Pick a path
          </p>
        )}
      </div>

      {/* How far below the stock top the model sits */}
      <div>
        <label htmlFor="p3d-model-top" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Model Top Below Stock</label>
        <LengthInput id="p3d-model-top" valueMM={form.modelTopMM} minMM={0} stepMM={0.5}
          onChangeMM={(v) => up('modelTopMM', v)} />
      </div>

      {/* ── Roughing pass (optional) ─────────────────────────────────────────── */}
      <div className="border border-gray-400 dark:border-neutral-700 rounded p-2 space-y-2">
        <div>
          <label htmlFor="p3d-roughing-tool-optional" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
            Roughing Tool <span className="normal-case text-gray-600 dark:text-neutral-400">(optional)</span>
          </label>
          <ToolPicker id="p3d-roughing-tool-optional"
            tools={roughTools}
            value={form.roughingToolId}
            onChange={(id) => up('roughingToolId', id)}
            none={{ value: '', label: '— None (single-pass) —' }} />
        </div>

        {hasRoughing && (
          <>
            <div>
              <label htmlFor="p3d-roughing-stepover" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
                Roughing Stepover
              </label>
              <div className="flex items-center gap-1">
                <NumericInput id="p3d-roughing-stepover"
                  value={form.roughingStepoverPercent}
                  min={5} max={100} step={5}
                  onChange={(v) => up('roughingStepoverPercent', v)}
                  className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
                />
                <span className="text-label text-gray-600 dark:text-neutral-400">%</span>
                {roughingTool && (
                  <span className="text-label text-gray-600 dark:text-neutral-400 ml-1">
                    ({fmtLen(roughingTool.diameterMM * form.roughingStepoverPercent / 100, units)})
                  </span>
                )}
              </div>
            </div>
            {autoFeedEnabled && roughingTool ? (
              <AutoStepField label="Roughing Step Down" valueMM={effectiveStepDownMM(roughingTool, form.roughingStepDownMM, profile3dDepthMM(form.maxDepthMM, thicknessMM))} />
            ) : (
              <div>
                <label htmlFor="p3d-roughing-step-down" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
                  Roughing Step Down
                </label>
                <LengthInput id="p3d-roughing-step-down" valueMM={form.roughingStepDownMM} minMM={0.1} maxMM={50} stepMM={0.5}
                  onChangeMM={(v) => up('roughingStepDownMM', v)} />
              </div>
            )}
            <div>
              <label htmlFor="p3d-roughing-angle" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
                Roughing Angle
              </label>
              <div className="flex items-center gap-1">
                {/* Blank means auto, so this is the one numeric field that can legally
                    be emptied — `onEmpty` is what says so. `value` is the angle auto
                    resolves to, which is what a stepper nudges off. */}
                <NumericInput id="p3d-roughing-angle"
                  value={form.roughingRasterAngleDeg === '' ? form.rasterAngleDeg + 90 : form.roughingRasterAngleDeg}
                  isEmpty={form.roughingRasterAngleDeg === ''}
                  onEmpty={() => up('roughingRasterAngleDeg', '')}
                  min={-180} max={180} step={15}
                  placeholder={`auto (${form.rasterAngleDeg + 90}°)`}
                  onChange={(v) => up('roughingRasterAngleDeg', v)}
                  title={NUMERIC_HINT}
                  className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
                />
                <span className="text-label text-gray-600 dark:text-neutral-400">°</span>
              </div>
            </div>
            <div>
              <label htmlFor="p3d-stock-allowance" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
                Stock Allowance
              </label>
              <LengthInput id="p3d-stock-allowance" valueMM={form.roughingStockAllowanceMM} minMM={0} maxMM={2} stepMM={0.1}
                onChangeMM={(v) => up('roughingStockAllowanceMM', v)} />
            </div>
            <p className="text-label text-blue-400 dark:text-blue-500">
              Roughing makes multiple passes at increasing depth; finishing cleans up to final surface
            </p>
          </>
        )}
      </div>

      {/* ── Finishing bit ────────────────────────────────────────────────────── */}
      <div>
        <label htmlFor="p3d-f7" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          {hasRoughing ? 'Finishing Tool' : 'Tool'}
        </label>
        <ToolPicker id="p3d-f7"
          tools={finishTools}
          value={form.toolId}
          onChange={handleToolChange}
          emptyText="No ball nose, bull nose or taper — add one in the Tool Library"
          label={(t) => `${t.name} (Ø${fmtLen(t.diameterMM, units)}${t.type === 'taper' ? ' tip' : ''})`} />
      </div>
      {selectedTool && selectedTool.type === 'taper' && (
        // The stepover comes off the TIP, so a fine taper asks for a great many passes.
        <p className="text-label text-gray-600 dark:text-neutral-400">
          Taper: passes are spaced off the Ø{fmtLen(selectedTool.diameterMM, units)} tip.
        </p>
      )}
      {selectedTool && selectedTool.type !== 'ballnose' && selectedTool.type !== 'bullnose' && selectedTool.type !== 'taper' && (
        <p className="text-label text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.xs} /> 3D Profile needs a ball nose, bull nose or taper tool
        </p>
      )}

      {/* Stepover */}
      <div>
        <label htmlFor="p3d-xy" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          {hasRoughing ? 'Finishing Stepover' : 'Stepover'} (XY)
        </label>
        <div className="flex items-center gap-1">
          <NumericInput id="p3d-xy"
            value={form.stepoverPercent}
            min={1} max={100} step={5}
            onChange={(v) => up('stepoverPercent', v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-600 dark:text-neutral-400">%</span>
          {selectedTool && (
            <span className="text-label text-gray-600 dark:text-neutral-400 ml-1">
              ({fmtLen(selectedTool.diameterMM * form.stepoverPercent / 100, units)})
            </span>
          )}
        </div>
      </div>

      {/* Finishing strategy */}
      <div>
        <label htmlFor="p3d-finish-strategy" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          {hasRoughing ? 'Finishing Strategy' : 'Strategy'}
        </label>
        <select id="p3d-finish-strategy"
          value={strategy}
          onChange={(e) => up('finishStrategy', e.target.value as 'raster' | 'waterline')}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
        >
          <option value="raster">Raster</option>
          <option value="waterline" disabled={isDepthMap}>Waterline</option>
        </select>
        {isDepthMap && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            A depth map is finished with Raster.
          </p>
        )}
      </div>

      {/* Raster angle */}
      {strategy === 'raster' && <div>
        <label htmlFor="p3d-angle" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Angle</label>
        <div className="flex items-center gap-1">
          <NumericInput id="p3d-angle"
            value={form.rasterAngleDeg}
            min={-90} max={90} step={15}
            onChange={(v) => up('rasterAngleDeg', v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-600 dark:text-neutral-400">°</span>
        </div>
      </div>}

      {/* Max depth */}
      <div>
        <label htmlFor="p3d-max-depth" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Max Depth</label>
        <LengthInput id="p3d-max-depth" valueMM={form.maxDepthMM} minMM={0.1} stepMM={0.5}
          onChangeMM={(v) => up('maxDepthMM', v)} />
        {nothingReached && (
          <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" /> {MODEL_BELOW_CUT_MSG}
          </p>
        )}
        {depthCutMM < form.maxDepthMM && (
          <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Deeper than the stock — cuts to {fmtLen(depthCutMM, units)}, leaving a {fmtLen(STOCK_SKIN_MM, units)} skin
          </p>
        )}
        {selectedTool && form.maxDepthMM > selectedTool.maxDepthMM && (
          <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Exceeds tool Max Z ({fmtLen(selectedTool.maxDepthMM, units)})
          </p>
        )}
      </div>

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
