// THE REGISTRATION HOLES DRILL THEMSELVES (cam/doubleSided, cam/tiling).
//
// A double-sided job's dowel holes and a tiled job's pin holes are part of the job, not
// something to remember to set up: forgetting them is a board that cannot be flipped or
// slid. So every hole path has its drill op made, kept at the job's depth and tool, kept in
// ONE batch, and kept FIRST in the program — whenever the job, the stock thickness, the
// paths or the tool library change. Nothing to click. The holes moving is already covered
// (a path edit regenerates the ops on it); this covers everything else.
//
// The writes are UNRECORDED and made in a microtask after the change that called for them,
// so they fold into that change's own undo step (the timeline settles a batch with no
// record of its own into the state at the cursor — see timelineStore's mirror). Undo takes
// the job and its drilling back together; it never meets the drilling as a step of its own
// that would only be put back again.

import { useWorkpieceStore } from '../store/workpieceStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore, type AddPayload, type AnyOperation } from '../store/toolpathStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { extractCircles } from '../canvas/selectionUtils'
import { seedStepDownMM } from '../cam/feeds'
import { drillPathItem, HELICAL_TOOL_TYPES } from '../panels/machine/opDefaults'
import { dowelDepthMM, normalizeDoubleSided } from '../cam/doubleSided'
import { normalizeTiling, stationDepthMM, stationTile } from '../cam/tiling'
import { uid } from '../uid'

/** Smaller than the hole by at least this, or a helix has no room to move. */
const HOLE_CLEARANCE_MM = 0.5

/**
 * The end mill that bores a job's holes: its own choice while that still fits the SMALL
 * hole, else the largest end mill that does (the fastest bore). Undefined when none fits.
 */
export function holeTool(tools: Tool[], toolId: string | undefined, smallDiaMM: number): Tool | undefined {
  const fits = (t: Tool) => HELICAL_TOOL_TYPES.includes(t.type) && t.diameterMM <= smallDiaMM - HOLE_CLEARANCE_MM
  const chosen = toolId ? tools.find((t) => t.id === toolId) : undefined
  if (chosen && fits(chosen)) return chosen
  return tools.filter(fits).sort((a, b) => b.diameterMM - a.diameterMM)[0]
}

/** One set of registration holes: a path each, each with its own name and depth. */
interface HoleJob { pathIds: string[]; names: string[]; depthsMM: number[]; tool: Tool | undefined }

/** The registration hole sets the document has, with the depth and tool each is drilled with. */
export function holeJobs(): HoleJob[] {
  const wp = useWorkpieceStore.getState()
  const tools = useToolStore.getState().tools
  const live = new Set(usePathsStore.getState().paths.map((p) => p.id))
  const jobs: HoleJob[] = []
  const ds = normalizeDoubleSided(wp.doubleSided)
  if (ds?.dowelPathId && live.has(ds.dowelPathId)) {
    jobs.push({ pathIds: [ds.dowelPathId], names: ['Dowel Holes'], depthsMM: [dowelDepthMM(ds, wp.thicknessMM)], tool: holeTool(tools, ds.toolId, ds.pin1DiaMM) })
  }
  const t = normalizeTiling(wp.tiling)
  if (t) {
    // Each station keeps its OWN index — its name and depth — when another's path is missing.
    const stations = (t.pinPathIds ?? []).map((id, k) => ({ id, k })).filter((s) => live.has(s.id))
    jobs.push({
      pathIds: stations.map((s) => s.id),
      names: stations.map((s) => `Tile Pins ${s.k + 1} — tile ${stationTile(s.k) + 1}`),
      depthsMM: stations.map((s) => stationDepthMM(t, s.k, wp.thicknessMM)),
      tool: holeTool(tools, t.toolId, t.pin1DiaMM),
    })
  }
  return jobs
}

const pathIdOf = (op: AnyOperation) => (op as { pathId?: string }).pathId

/** Is this operation the drilling of a registration hole set? */
export function isRegistrationOp(op: AnyOperation, jobs: HoleJob[] = holeJobs()): boolean {
  const id = pathIdOf(op)
  return op.type === 'drill' && !!id && jobs.some((j) => j.pathIds.includes(id))
}

/** Make, update, batch and order the drilling of every registration hole set. */
export function syncRegistrationOps(): void {
  const jobs = holeJobs()
  if (jobs.length === 0) return
  const store = () => useToolpathStore.getState()
  const paths = new Map(usePathsStore.getState().paths.map((p) => [p.id, p]))
  const touched = new Set<string>()

  for (const job of jobs) {
    const tool = job.tool
    if (!tool) continue
    const add: AddPayload[] = []
    const changed: { id: string; updates: Partial<AnyOperation> }[] = []
    job.pathIds.forEach((id, k) => {
      const path = paths.get(id)
      if (!path) return
      const name = `${job.names[k]} (${tool.name})`
      const op = store().operations.find((o) => o.type === 'drill' && pathIdOf(o) === id)
      const depthMM = job.depthsMM[k]
      const settings = { toolId: tool.id, depthMM, stepDownMM: seedStepDownMM(tool), stepDownManual: false, startFrom: { mode: 'stock' as const } }
      if (!op) {
        const item = drillPathItem(path, extractCircles(path), tool, 'helical')
        add.push({ type: 'drill', name, ...settings, ...item.fields } as AddPayload)
      } else if (op.type === 'drill' && (op.toolId !== tool.id || Math.abs(op.depthMM - depthMM) > 1e-6 || op.drillMode !== 'helical')) {
        const item = drillPathItem(path, extractCircles(path), tool, 'helical')
        changed.push({ id: op.id, updates: { name, ...settings, ...item.fields } as Partial<AnyOperation> })
        touched.add(op.id)
      }
    })
    for (const id of add.length > 0 ? store().addOperations(add, { record: false }) : []) touched.add(id)
    if (changed.length > 0) store().updateOperations(changed, { record: false })

    // ONE batch: stations added since, or made by an older build, join the rest.
    const mine = store().operations.filter((o) => o.type === 'drill' && job.pathIds.includes(pathIdOf(o) ?? ''))
    const batchId = mine.find((o) => o.batchId)?.batchId ?? (mine.length > 1 ? uid('batch') : undefined)
    const strays = batchId ? mine.filter((o) => o.batchId !== batchId) : []
    if (strays.length > 0) store().updateOperations(strays.map((o) => ({ id: o.id, updates: { batchId } })), { record: false })
  }

  // FIRST in the program: the holes are drilled before anything is cut loose or the board
  // moves. A plain write, folded into the step like the rest.
  const ops = store().operations
  const reg = ops.filter((o) => isRegistrationOp(o, jobs))
  if (reg.length > 0 && !reg.every((o, i) => ops[i] === o)) {
    store().replaceOperations([...reg, ...ops.filter((o) => !reg.includes(o))])
  }

  if (touched.size > 0) {
    const toRun = store().operations.filter((o) => touched.has(o.id))
    void import('../cam/regenerate').then((m) => m.regenerateMany(toRun))
  }
}

/**
 * Keep the drilling in step from now on: after any change to a job, the stock thickness,
 * the paths or the tools. Coalesced into one microtask per turn. Returns an unsubscribe.
 */
export function installRegistrationSync(): () => void {
  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; syncRegistrationOps() })
  }
  const hasJob = () => { const w = useWorkpieceStore.getState(); return !!(w.doubleSided || w.tiling) }
  const unsubWP = useWorkpieceStore.subscribe((s, p) => {
    if (s.doubleSided !== p.doubleSided || s.tiling !== p.tiling || s.thicknessMM !== p.thicknessMM) schedule()
  })
  const unsubPaths = usePathsStore.subscribe((s, p) => { if (s.paths !== p.paths && hasJob()) schedule() })
  const unsubTools = useToolStore.subscribe((s, p) => { if (s.tools !== p.tools && hasJob()) schedule() })
  schedule()
  return () => { unsubWP(); unsubPaths(); unsubTools() }
}
