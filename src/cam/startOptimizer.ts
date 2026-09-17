import { regenerateOperation } from './regenerate'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore } from '../store/toolStore'
import { resolveStartZForOp } from './startHeight'

// Chain the operations so each one starts near where the previous finished, cutting the
// rapid between them. The entry point is an input to generation, not something that can be
// patched onto finished segments, so an operation whose entry moves has to be regenerated.
//
// The hint is therefore applied WHEN AN OPERATION IS GENERATED (`entryHintAt`, called by
// the machine forms), not retro-fitted afterwards. Operations are cut in the order they
// were created, so at the moment one is generated its predecessor's exit is already known.
// `optimizeStartPoints` then has nothing to do on the common path: it walks the same chain,
// finds every operation already generated with the hint it would have asked for, and
// regenerates none of them. It still exists because some things do invalidate the chain —
// reordering, editing an earlier operation, or changing the safe height — and then it
// rebuilds exactly the operations affected.

type XY = { x: number; y: number }

/** Where an operation leaves the tool: its last rapid, or failing that the cut point
 *  nearest where it started. */
function exitOf(op: AnyOperation, fromX: number, fromY: number): XY {
  const exitSeg = [...op.segments].reverse().find((s) => s.rapid)
  if (exitSeg) return { x: exitSeg.x, y: exitSeg.y }
  if (op.type === 'vcarve') return { x: fromX, y: fromY }
  let nearX = fromX, nearY = fromY, bestDist = Infinity
  for (const seg of op.segments) {
    if (seg.rapid) continue
    const d = (seg.x - fromX) ** 2 + (seg.y - fromY) ** 2
    if (d < bestDist) { bestDist = d; nearX = seg.x; nearY = seg.y }
  }
  return { x: nearX, y: nearY }
}

/**
 * The entry hint for `opId`: where the operation before it in cut order finished.
 *
 * Undefined when nothing precedes it — the first operation has no predecessor to chain to,
 * and hinting it at the workpiece origin would only drag its start toward a corner for no
 * reason. Call this before generating an operation and pass the result as `startNear`.
 */
export function entryHintAt(opId: string): XY | undefined {
  const { operations } = useToolpathStore.getState()
  const { widthMM, heightMM, origin } = useWorkpieceStore.getState()
  const org = originWorldXY(origin, widthMM, heightMM)
  let cx = org.x, cy = org.y
  let havePredecessor = false

  for (const op of operations) {
    if (op.id === opId) return havePredecessor ? { x: cx, y: cy } : undefined
    if (op.status !== 'done') continue
    const e = exitOf(op, cx, cy)
    cx = e.x; cy = e.y
    havePredecessor = true
  }
  return undefined
}

const sameHint = (a: XY | undefined, b: XY | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

export async function optimizeStartPoints(): Promise<void> {
  const { widthMM, heightMM, origin } = useWorkpieceStore.getState()
  const { safeHeightMM } = useWorkpieceStore.getState()
  const org = originWorldXY(origin, widthMM, heightMM)
  let cx = org.x, cy = org.y
  let havePredecessor = false

  const operations = useToolpathStore.getState().operations

  for (const op of operations) {
    if (op.status !== 'done') continue

    // Types whose output cannot depend on the entry hint: surfacing and inlay carry their
    // own entry, 3D profile, photo v-carve and imported G-code ignore startNear entirely
    // (a raster field starts at a corner of the image, wherever the tool came from).
    // Regenerating them for a hint would cost their full generation and change nothing,
    // so they only move the cursor along.
    if (op.type === 'surface' || op.type === 'inlay' || op.type === 'profile3d' || op.type === 'photovcarve' || op.type === 'gcode') {
      const e = exitOf(op, cx, cy)
      cx = e.x; cy = e.y
      havePredecessor = true
      continue
    }

    // Exactly the hint entryHintAt would have produced for this operation, so an operation
    // generated through that path matches and is left alone.
    const want = {
      entryHint: havePredecessor ? { x: cx, y: cy } : undefined,
      safeHeightMM,
    }

    // Re-read: an earlier operation in this loop may have been regenerated since the
    // snapshot above was taken.
    const live = useToolpathStore.getState().operations.find((o) => o.id === op.id)
    const cur = live?.generatedWith
    // Start height belongs in this comparison for the same reason safe height does: it is
    // decided OUTSIDE the operation, so an op can go stale without anything about it
    // changing. This is the backstop that makes a wrong Z impossible to export — the
    // store's marking is what makes it VISIBLE, but reaching here regenerates regardless.
    const liveOps = useToolpathStore.getState().operations
    const wantStartZ = live
      ? resolveStartZForOp(live, liveOps, usePathsStore.getState().paths,
          { widthMM, heightMM }, useToolStore.getState().tools).zMM
      : 0
    const startZDrifted = !!cur && Math.abs((cur.startZMM ?? 0) - wantStartZ) > 1e-9
    if (!cur || startZDrifted || Math.abs(cur.safeHeightMM - safeHeightMM) > 1e-9 || !sameHint(cur.entryHint, want.entryHint)) {
      useToolpathStore.getState().updateOperation(op.id, { entryHint: want.entryHint })
      await regenerateOperation(op.id)   // stamps generatedWith with what it actually used
    }

    const updated = useToolpathStore.getState().operations.find((o) => o.id === op.id)
    const e = exitOf(updated ?? op, cx, cy)
    cx = e.x; cy = e.y
    havePredecessor = true
  }
}
