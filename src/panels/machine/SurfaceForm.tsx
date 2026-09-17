// ─── Surface form ─────────────────────────────────────────────────────────────
import { FormShell, ToolSelector, DepthRow, GenerateBtn, useSessionOps, toolsOfType, pickToolId, FormError, useGenerateError, discardFailedOps } from './shared'
import { useState } from 'react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, type AnyOperation, type SurfaceOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { isWorkCancelled } from '../../workers/workerClient'
import { generateOperation } from '../../cam/opJob'
import { seedStepDownMM } from '../../cam/feeds'

interface SurfaceFormState {
  toolId: string
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
}

export function SurfaceForm({ onClose, editOp }: { onClose: () => void; editOp?: SurfaceOperation }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const tools = useToolStore((s) => s.tools)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const units = useWorkpieceStore((s) => s.units)
  const addOperation = useToolpathStore((s) => s.addOperation)
  const updateOperation = useToolpathStore((s) => s.updateOperation)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)

  // Surfacing has to leave a flat face across the whole slab, so it's end mills only:
  // a ball nose leaves scallops between passes and a V-bit leaves ridges.
  const endMills = toolsOfType(tools, ['endmill'])
  const defaultTool = endMills[0]
  const [form, setForm] = useState<SurfaceFormState>(() => {
    const base = editOp ? {
      toolId: editOp.toolId, depthMM: editOp.depthMM, stepDownMM: editOp.stepDownMM,
      stepoverPercent: editOp.stepoverPercent, passAngleDeg: editOp.passAngleDeg,
    } : mergeWithDefaults(load('surface'), {
      toolId: defaultTool?.id ?? '',
      depthMM: seedStepDownMM(defaultTool),
      stepDownMM: seedStepDownMM(defaultTool),
      stepoverPercent: 40,
      passAngleDeg: 0,
    }, tools)
    return { ...base, toolId: pickToolId(base.toolId, endMills) }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
  const session = useSessionOps()
  const selectedTool = tools.find((t) => t.id === form.toolId)
  const updating = !editOp && !!session.liveOpId('surface')

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: seedStepDownMM(t) }))
  }

  function up<K extends keyof SurfaceFormState>(k: K, v: SurfaceFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    clearError()
    if (!selectedTool) return
    setGenerating(true)
    if (editOp) {
      updateOperation(editOp.id, {
        toolId: form.toolId, depthMM: form.depthMM, stepDownMM: form.stepDownMM,
        stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg, status: 'generating',
      } as Partial<AnyOperation>)
      try {
        // Generated from the settings just written — the same call an automatic
        // regenerate makes (cam/opJob).
        await generateOperation(editOp.id)
      } catch (err) {
        if (!isWorkCancelled(err)) reportError(editOp.id, err)
      }
      setGenerating(false)
      save('surface', form)
      return
    }
    // Re-Generate after this form already made a surface op updates it in place.
    const existingId = session.liveOpId('surface')
    const name = `Surface (${selectedTool.name})`
    const opId = existingId ?? addOperation({
      name,
      type: 'surface',
      toolId: form.toolId,
      depthMM: form.depthMM,
      stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent,
      passAngleDeg: form.passAngleDeg,
    })
    if (!existingId) session.remember('surface', opId)
    updateOperation(opId, existingId ? {
      name, toolId: form.toolId, depthMM: form.depthMM, stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg, status: 'generating',
    } as Partial<AnyOperation> : { status: 'generating' })
    try {
      await generateOperation(opId)
    } catch (err) {
      if (!isWorkCancelled(err)) reportError(opId, err)
    }
    // A Generate that failed leaves nothing behind — but only for the op this click
    // created; a re-Generate over an existing one keeps it and its error.
    if (!existingId) discardFailedOps([opId])
    setGenerating(false)
    save('surface', form)
  }

  return (
    <FormShell title={editOp ? 'Edit Surface' : 'New Surface'} onClose={onClose}>
      <div className="text-label text-gray-600 dark:text-neutral-400 bg-gray-50 dark:bg-neutral-900 rounded px-2 py-1.5">
        Covers stock: {fmtLen(widthMM, units)} × {fmtLen(heightMM, units)}
      </div>
      <ToolSelector tools={endMills} value={form.toolId} onChange={handleToolChange} />
      <div>
        <label htmlFor="surface-stepover" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Stepover <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input id="surface-stepover"
          type="range" min={10} max={90} step={5}
          value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      <div>
        <label htmlFor="surface-angle" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Angle <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.passAngleDeg}°</span>
        </label>
        <input id="surface-angle"
          type="range" min={0} max={180} step={5}
          value={form.passAngleDeg}
          onChange={(e) => up('passAngleDeg', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      <DepthRow
        depthMM={form.depthMM}
        stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)}
        onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM}
        tool={selectedTool}
      />
      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={!selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}
