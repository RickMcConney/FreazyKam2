import type { AnyOperation } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import { effectiveStepDownMM } from './feeds'

/**
 * The toolpaths whose AUTO step-down would come out different now — after a change to
 * what auto feeds work it out from (the material's hardness, the machine's rigidity, the
 * Auto Feeds switch itself).
 *
 * The step-down is baked into the toolpath when it is generated, so changing the
 * material left every toolpath cutting the old material's passes. Regenerating every
 * auto-step-down op instead would be hundreds of generations for nothing whenever the
 * answer is capped by the bit (a 1/8" end mill in 3 mm stock is 1.5 mm in every wood).
 *
 * So each generation records the step-downs it asked for, inputs and answer
 * (`GeneratedWith.stepDowns`, written by `generateOperation`), and this asks them again.
 * Recorded rather than re-derived per operation type, so there is no second table of
 * "which depth, which engagement" to drift from the generator's. An op generated before
 * the record existed has none and is left alone — it says nothing about what it used.
 */
export function opsWithStaleStepDown(ops: AnyOperation[], tools: Tool[]): AnyOperation[] {
  const byId = new Map(tools.map((t) => [t.id, t]))
  return ops.filter((op) => {
    if (op.status !== 'done') return false
    return (op.generatedWith?.stepDowns ?? []).some((s) => {
      const tool = byId.get(s.toolId)
      return !!tool && Math.abs(effectiveStepDownMM(tool, s.userMM, s.depthMM, s.engagement) - s.mm) > 1e-9
    })
  })
}
