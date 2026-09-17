// Audit a saved .fkam project — test support, not shipped UI code.
//
// Loads the project through the real loader, REGENERATES every operation with the current
// code (so the audit tests today's toolpaths, not the segments frozen in the file), emits
// G-code, and scores the sim's height map against what each operation was supposed to
// remove. See toolpathAudit.ts for the scoring method.
//
// Regeneration normally runs in a Worker; under node we swap in an in-process worker that
// calls the very same handler table (workers/handlers.ts) synchronously.
import { readFileSync } from 'node:fs'
import { loadProject, type ProjectData } from '../io/projectLoad'
import { regenerateOperation } from '../cam/regenerate'
import { __setWorkerFactoryForTests } from '../workers/workerClient'
import { handlers } from '../workers/handlers'
import { resolveStartZ } from '../cam/startHeight'
import { generateGcode } from '../cam/gcode'
import { useToolpathStore } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore } from '../store/toolStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { AUDIT_POST, auditGcode, offsetRegion, regionFromPaths, type AuditResult, type OpIntent } from './toolpathAudit'
import type { AnyOperation } from '../store/toolpathStore'


function installInProcessWorker() {
  __setWorkerFactoryForTests(() => {
    const w = {
      onmessage: null as ((e: MessageEvent<never>) => void) | null,
      onerror: null as ((e: { message?: string }) => void) | null,
      postMessage(msg: { id: number; fn: string; args: unknown[] }) {
        let payload: unknown
        try {
          payload = { id: msg.id, result: (handlers as Record<string, (...a: never[]) => unknown>)[msg.fn](...(msg.args as never[])) }
        } catch (err) {
          payload = { id: msg.id, error: String(err) }
        }
        // Async so the client's bookkeeping matches the real postMessage round trip.
        queueMicrotask(() => w.onmessage?.({ data: payload } as MessageEvent<never>))
      },
      terminate() {},
    }
    return w
  })
}

/** What each operation type is supposed to remove. Unmodeled types are carved but not scored. */
function intentFor(op: AnyOperation): OpIntent | null {
  const { paths } = usePathsStore.getState()
  const { tools } = useToolStore.getState()
  const tool = tools.find(t => t.id === op.toolId)
  if (!tool) return null
  const base = { id: op.id, name: op.name, type: op.type, toolRadiusMM: tool.diameterMM / 2 }

  if (op.type === 'pocket') {
    const boundary = paths.find(p => p.id === op.pathId)
    if (!boundary) return null
    const islandDs = op.islandIds.flatMap(id => {
      const p = paths.find(x => x.id === id)
      return p ? [p.d] : []
    })
    const raw = regionFromPaths(boundary.d, islandDs)
    const allowance = op.allowanceMM ?? 0
    // depthMM here is total reach from stock top, so an op that starts on an earlier
    // floor is expected to leave its own floor that much deeper.
    const { widthMM, heightMM } = useWorkpieceStore.getState()
    const startZ = resolveStartZ(
      { startFrom: op.startFrom, footprintD: boundary.d, cutMarginMM: 0, opId: op.id },
      useToolpathStore.getState().operations, paths, { widthMM, heightMM },
    ).zMM
    return {
      ...base,
      region: allowance !== 0 ? offsetRegion(raw, -allowance) : raw,
      depthMM: op.depthMM - startZ,
    }
  }

  // Profile/drill/vcarve/inlay/surfacing: cut shape isn't a flat-bottomed region (tabs,
  // tapered walls, per-pixel depth), so they're carved into the map but not scored.
  return { ...base, region: null, depthMM: 'depthMM' in op ? (op.depthMM as number) : 0 }
}

export interface ProjectAuditResult extends AuditResult {
  projectName: string
  opCount: number
  errors: string[]
}

/** Load a .fkam file, regenerate it, and audit the result. */
export async function auditProjectFile(filePath: string, opts: { cellMM?: number } = {}): Promise<ProjectAuditResult> {
  installInProcessWorker()
  const data = JSON.parse(readFileSync(filePath, 'utf8')) as ProjectData
  loadProject(data, filePath.split('/').pop())

  const errors: string[] = []
  const ops = useToolpathStore.getState().operations
  for (const op of ops) {
    try {
      await regenerateOperation(op.id)
    } catch (e) {
      errors.push(`${op.type} "${op.name}": ${String(e)}`)
    }
  }

  const fresh = useToolpathStore.getState().operations
  for (const op of fresh) {
    if (op.errorMessage) errors.push(`${op.type} "${op.name}": ${op.errorMessage}`)
    if (!op.segments || op.segments.length === 0) errors.push(`${op.type} "${op.name}": produced no motion`)
  }

  const toolsById = Object.fromEntries(useToolStore.getState().tools.map(t => [t.id, t]))
  const gcode = generateGcode(fresh, toolsById, data.name ?? 'audit', AUDIT_POST)
  const intents = fresh
    .filter(op => op.visible !== false)
    .map(intentFor)
    .filter((i): i is OpIntent => i !== null)

  const { widthMM: W, heightMM: H, thicknessMM: T } = useWorkpieceStore.getState()
  const segmentCount = fresh.reduce((n, op) => n + (op.segments?.length ?? 0), 0)
  const result = auditGcode(gcode, intents, W, H, T, segmentCount, opts.cellMM)

  return { ...result, projectName: data.name ?? '(unnamed)', opCount: fresh.length, errors }
}
