import { regenerateOperation } from './regenerate'
import { useToolpathStore, withPending, type AnyOperation } from '../store/toolpathStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore } from '../store/toolStore'
import { resolveStartZForOp } from './startHeight'
import { cellKey, cellOffset, opCell, type Cell } from './sheets'
import { pathCell } from '../canvas/useSheets'

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

// ─── The chain ─────────────────────────────────────────────────────────────────────
//
// ONE WALK, used by both `entryHintAt` and `optimizeStartPoints`: the second exists to find
// every op NOT generated with the hint the first would have given it, so the two must agree
// exactly, and as two hand-kept copies of one loop they could only drift.
//
// A CURSOR PER SHEET (cam/sheets). Each sheet is its own program, cut from its own corner,
// so an op chains to the one before it ON ITS SHEET, and the first op on a sheet has no
// predecessor. One chain through every sheet handed the first part of sheet 2 the place
// sheet 1 finished — a different board, in a frame the machine never sees.
//
// An op's sheet comes from its SOURCE PATH, because the hint is asked for before the op is
// generated and a new op has no toolpath to say where it is; an op with no path (surfacing,
// a hand-placed peck) goes by its toolpath.

type Cursor = XY & { havePredecessor: boolean }

function chainWalker() {
  const wp = useWorkpieceStore.getState()
  const org = originWorldXY(wp.origin, wp.widthMM, wp.heightMM)
  const pathsById = new Map(usePathsStore.getState().paths.map((p) => [p.id, p]))
  const cursors = new Map<string, Cursor>()
  const cellOf = (op: AnyOperation): Cell => {
    const pathId = 'pathId' in op ? (op.pathId as string | undefined) : undefined
    const path = pathId ? pathsById.get(pathId) : undefined
    return path ? pathCell(path, wp) : opCell(op, wp)
  }
  const cursorOf = (op: AnyOperation): Cursor => {
    const cell = cellOf(op)
    const key = cellKey(cell)
    let c = cursors.get(key)
    if (!c) {
      // The chain starts at the machine origin, which on another sheet is that sheet's
      // corner-relative origin — where the program for it will put the tool.
      const off = cellOffset(cell, wp)
      c = { x: org.x + off.x, y: org.y + off.y, havePredecessor: false }
      cursors.set(key, c)
    }
    return c
  }
  return {
    /** The hint `op` should be generated with: where the op before it on its sheet left the
     *  tool, or nothing when it is the first there. */
    hintFor(op: AnyOperation): XY | undefined {
      const c = cursorOf(op)
      return c.havePredecessor ? { x: c.x, y: c.y } : undefined
    },
    /** `op` is in the program (done): the tool on its sheet is now where it leaves. */
    pass(op: AnyOperation): void {
      const c = cursorOf(op)
      const e = exitOf(op, c.x, c.y)
      c.x = e.x; c.y = e.y; c.havePredecessor = true
    },
  }
}

/**
 * The entry hint for `opId`: where the operation before it in cut order, on the same sheet,
 * finished.
 *
 * Undefined when nothing precedes it — the first operation has no predecessor to chain to,
 * and hinting it at the workpiece origin would only drag its start toward a corner for no
 * reason. Call this before generating an operation and pass the result as `startNear`.
 */
export function entryHintAt(opId: string): XY | undefined {
  const chain = chainWalker()
  // Through the batch buffer: inside a batch Generate the op just before this one has
  // finished, but its toolpath may not have been written to the store yet.
  for (const stored of useToolpathStore.getState().operations) {
    const op = withPending(stored)
    if (op.id === opId) return chain.hintFor(op)
    if (op.status !== 'done') continue
    chain.pass(op)
  }
  return undefined
}

const sameHint = (a: XY | undefined, b: XY | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

export async function optimizeStartPoints(): Promise<void> {
  const { widthMM, heightMM, safeHeightMM } = useWorkpieceStore.getState()
  const chain = chainWalker()

  const operations = useToolpathStore.getState().operations

  for (const op of operations) {
    // AN OPERATION ALREADY MARKED STALE IS REGENERATED HERE TOO — it is the case this pass
    // exists for. It used to skip everything that was not `done`, so an op flagged
    // `needs-update` (by revalidateStartHeights when the pocket it sits in changed depth,
    // or by setSegments when its floor moved while it generated) was the one op this
    // backstop never looked at, and the export then left it out for not being done: a
    // V-carve in a pocket vanished from the simulation until it was regenerated by hand.
    // Regenerated in program order, so the floor it sits on has been rebuilt first.
    // Pinned by `npx vite-node scripts/sim-stale-regen.mts`.
    const stale = useToolpathStore.getState().operations.find((o) => o.id === op.id)?.status === 'needs-update'
    if (op.status !== 'done' && !stale) continue

    // Types whose output cannot depend on the entry hint: surfacing and inlay carry their
    // own entry, 3D profile, photo v-carve and imported G-code ignore startNear entirely
    // (a raster field starts at a corner of the image, wherever the tool came from).
    // Regenerating them for a hint would cost their full generation and change nothing,
    // so they only move the cursor along — unless they are stale anyway.
    if (op.type === 'surface' || op.type === 'inlay' || op.type === 'profile3d' || op.type === 'photovcarve' || op.type === 'gcode') {
      if (stale) await regenerateOperation(op.id)
      const updated = useToolpathStore.getState().operations.find((o) => o.id === op.id)
      if (updated?.status !== 'done') continue
      chain.pass(updated)
      continue
    }

    // Exactly the hint entryHintAt would have produced for this operation, so an operation
    // generated through that path matches and is left alone.
    const want = {
      entryHint: chain.hintFor(op),
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
    if (stale || !cur || startZDrifted || Math.abs(cur.safeHeightMM - safeHeightMM) > 1e-9 || !sameHint(cur.entryHint, want.entryHint)) {
      useToolpathStore.getState().updateOperation(op.id, { entryHint: want.entryHint })
      await regenerateOperation(op.id)   // stamps generatedWith with what it actually used
    }

    const updated = useToolpathStore.getState().operations.find((o) => o.id === op.id)
    // Still not done (its tool was deleted, or the regenerate failed): it is not in the
    // program, so it is not where the tool leaves from either.
    if (updated?.status !== 'done') continue
    chain.pass(updated)
  }
}
