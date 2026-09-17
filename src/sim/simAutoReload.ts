import { generateGcode } from '../cam/gcode'
import { buildGcodeInputs } from '../io/gcodeExport'
import { useProjectStore } from '../store/projectStore'
import { useSimStore } from '../store/simStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'

/**
 * Keep the simulator in step with the program while its controls are on screen.
 *
 * Once the player is up, it is answering a question about the whole program — so an
 * operation that is regenerated, retimed, hidden, reordered or deleted while it sits there
 * makes what it shows wrong, and re-pressing Simulate is the user doing bookkeeping the app
 * can do itself. When the program settles, this rebuilds the G-code and reloads it; the
 * reload parks the clock at the end (see `simStore.loadGcode`), so the player comes back
 * showing the finished part, exactly as a manual Simulate would.
 *
 * Nothing happens unless the simulator is showing a program the app generated —
 * `autoReload` is set by `loadGcode`, cleared by `clearSim` and by an imported .gcode file
 * (which nothing here could rebuild), and survives the `invalidateSim` that regeneration
 * does to the stale program, which is the whole reason that flag exists.
 *
 * Two things keep it from thrashing:
 *  - it never rebuilds while any operation is `pending`/`generating`. A form that creates
 *    26 pockets marks them all pending up front, so the burst is one rebuild at the end,
 *    not 26. The store write that finishes the last one re-schedules us.
 *  - the rebuild is keyed on what actually reaches the G-code (which done+visible ops, in
 *    order, with which tool and which segments). Editing a setting without regenerating
 *    leaves the emitted program identical, so it reloads nothing.
 */

// Time to wait after the last operations change before rebuilding. Long enough that a
// gesture writing several ops in a row costs one rebuild, short enough to feel immediate.
const SETTLE_MS = 200

// The parts of an operation the emitted G-code is built from — the same ops generateGcode
// walks, in the same order, including its skip of imported G-code ops. Segments are
// compared by identity: store updates replace op objects rather than mutating them, so a
// regenerated op arrives with a fresh array and an untouched one does not.
function programKey(ops: AnyOperation[]): unknown[] {
  const key: unknown[] = []
  for (const op of ops) {
    if (!op.visible || op.status !== 'done' || op.segments.length === 0) continue
    if (op.type === 'gcode') continue
    key.push(op.id, op.name, op.toolId, op.segments,
      op.type === 'profile3d' ? op.roughingToolId : undefined)
  }
  return key
}

function sameKey(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

let timer: ReturnType<typeof setTimeout> | null = null
let building = false
let dirty = false
let lastKey: unknown[] = []

function schedule() {
  // Armed only while the player is showing a generated program — an imported one, or none
  // at all, means leave the simulator alone.
  if (!useSimStore.getState().autoReload) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void rebuild() }, SETTLE_MS)
}

async function rebuild(): Promise<void> {
  if (building) { dirty = true; return }
  const sim = useSimStore.getState()
  if (!sim.autoReload) return

  const ops = useToolpathStore.getState().operations
  // Still working: the store write that settles the last operation brings us back.
  if (ops.some((o) => o.status === 'pending' || o.status === 'generating')) return

  const key = programKey(ops)
  // Nothing left to simulate (every operation deleted or hidden): put the player away
  // rather than loading an empty program, and stop arming reloads for it.
  if (key.length === 0) {
    lastKey = key
    useSimStore.getState().clearSim()
    return
  }
  if (sim.gcode && sameKey(key, lastKey)) return

  building = true
  try {
    const { operations, toolsById, profile } = await buildGcodeInputs()
    // buildGcodeInputs awaits optimizeStartPoints, which can regenerate operations whose
    // entry point moved. If it did, that store write has re-scheduled us and the ops it
    // started are in flight — drop this build rather than emitting a half-generated one.
    if (operations.some((o) => o.status === 'pending' || o.status === 'generating')) return
    const gcode = generateGcode(operations, toolsById, useProjectStore.getState().name, profile)
    useSimStore.getState().loadGcode(gcode)
  } catch {
    // A failed rebuild is not worth a status message: the operations panel already shows
    // whatever went wrong with the operation, and the player simply stays as it was.
  } finally {
    building = false
    if (dirty) { dirty = false; schedule() }
  }
}

/** Install the subscriptions. Returns an unsubscribe for React's effect cleanup. */
export function installSimAutoReload(): () => void {
  const unsubOps = useToolpathStore.subscribe(schedule)
  // Every load — ours, the Simulate button, an imported .gcode file — is the point the
  // player's contents match the program, so it defines what "unchanged" means from here.
  const unsubSim = useSimStore.subscribe((s, prev) => {
    if (s.gcode !== prev.gcode && s.gcode) {
      lastKey = programKey(useToolpathStore.getState().operations)
    }
  })
  return () => {
    unsubOps()
    unsubSim()
    if (timer) { clearTimeout(timer); timer = null }
  }
}
