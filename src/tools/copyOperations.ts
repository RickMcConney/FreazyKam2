// Copying a part's OPERATIONS along with the part.
//
// Fill-the-stock makes copies of one part, and a part that has already been
// given its toolpaths — a pocket, a drilling, an outside profile — is a part the
// user has already said how to cut. Making them select thirty copies and apply
// the same three operations again is busywork with a way to get it wrong, so the
// operations come along: every operation built ONLY from the part's paths is
// cloned onto each copy, its path references remapped to the copy's.
//
// Pure: operations in, operations out. The caller writes the list and
// regenerates what it names.

import { transformPoint, type TransformStep } from '../canvas/selectionUtils'
import { pathIdsOf, type AnyOperation } from '../store/toolpathStore'

/** One copy of the part: which path became which, and how it was moved there. */
export interface PartCopy {
  /** Source path id → the copy's path id, for every path of the part. */
  pathIds: Map<string, string>
  /** The steps that carried the source onto the copy (rotate/translate). */
  steps: TransformStep[]
}

export interface OperationCopies {
  /** The whole program, copies in place. */
  operations: AnyOperation[]
  /** Ids of the operations made — every one needs generating. */
  created: string[]
  /** Existing operations that took the copies in rather than being copied (a shared-line sheet). */
  extended: string[]
  /** Operations on the part that could NOT be carried, and so were left alone. */
  skipped: AnyOperation[]
}

const movePoint = (x: number, y: number, steps: TransformStep[]) =>
  steps.reduce((p, s) => (s.kind === 'mirror' ? p : transformPoint(p.x, p.y, s)), { x, y })

/**
 * Clone every operation built only from `partIds` onto each of `copies`.
 *
 * WHICH OPERATIONS: one whose source paths are ALL in the part. An operation
 * that also names a path outside it — a pocket whose island is another part, a
 * sheet profile over the whole nest — is about more than this part, and a copy
 * of it would either machine the original's neighbour again or need a neighbour
 * the copy does not have.
 *
 * Two kinds are handled differently, both for a reason:
 * - an OPTIMIZE PATH profile (`sharedLines`) is ONE operation for a whole sheet,
 *   so it takes the copies into its own `pathIds` instead of being cloned —
 *   thirty one-part "sheets" would route nothing and share nothing;
 * - an INLAY is a female/male PAIR cut to fit each other (`linkedOpId`) and its
 *   halves come from separate boards, so a fill of one half is not a fill of the
 *   pair. It is skipped and reported.
 *
 * THE COPIES JOIN THE SOURCE'S BATCH, minting one when the source was alone.
 * A batch is what a form edits as one decision, so changing the pocket depth on
 * any part of the filled sheet changes it on all of them, and the strip shows one
 * chip rather than one per copy. Each copy sits directly after its source in
 * the program, copies in order, so the job still runs operation by operation —
 * every pocket, then every profile — and tool changes do not multiply.
 *
 * A `startFrom: { mode: 'op' }` naming another operation of the same part is
 * pointed at THAT operation's copy on the same copy of the part: engraving in a
 * pocket must start from its own pocket's floor, not the original's.
 */
export function copyOperationsForParts(
  ops: AnyOperation[],
  partIds: Iterable<string>,
  copies: PartCopy[],
  newId: (prefix: string) => string,
): OperationCopies {
  const part = new Set(partIds)
  const ofPart = (op: AnyOperation): boolean => {
    const ids = pathIdsOf(op)
    return ids.length > 0 && ids.every((id) => part.has(id))
  }
  const sources = ops.filter(ofPart)
  const skipped = sources.filter((op) => op.type === 'inlay' || op.type === 'gcode')
  const isSheet = (op: AnyOperation): boolean => op.type === 'profile' && !!op.sharedLines
  const sheets = new Set(sources.filter(isSheet).map((op) => op.id))
  const cloned = sources.filter((op) => !skipped.some((s) => s.id === op.id) && !sheets.has(op.id))
  if (copies.length === 0 || (cloned.length === 0 && sheets.size === 0)) {
    return { operations: ops, created: [], extended: [], skipped }
  }

  // Ids first, so a startFrom on one copy can name another copy.
  const copyIdOf = new Map<string, string[]>()
  for (const op of cloned) copyIdOf.set(op.id, copies.map(() => newId('op')))

  // A source that was created alone has no batch to share; mint one for it.
  const batchOf = new Map<string, string>()
  for (const op of cloned) batchOf.set(op.id, op.batchId ?? newId('batch'))

  const make = (src: AnyOperation, n: number): AnyOperation => {
    const { pathIds: map, steps } = copies[n]
    const re = (id: string): string => map.get(id) ?? id
    const op: Record<string, unknown> = {
      ...src,
      id: copyIdOf.get(src.id)![n],
      status: 'pending',
      segments: [],
      batchId: batchOf.get(src.id),
    }
    // Generation state belongs to the source's segments, not to the copy.
    delete op.errorMessage
    delete op.generatedWith
    delete op.entryHint
    if ('pathId' in src && src.pathId) op.pathId = re(src.pathId)
    if ('islandIds' in src && src.islandIds) op.islandIds = src.islandIds.map(re)
    if ('pathIds' in src && src.pathIds) op.pathIds = src.pathIds.map(re)
    if (src.type === 'profile3d' && src.boundaryPathId) op.boundaryPathId = re(src.boundaryPathId)
    if (src.type === 'drill') {
      // Re-derived from the path at generation whenever it holds circles; moved
      // anyway, so a path that does not still drills where the copy is.
      op.points = src.points.map((p) => movePoint(p.x, p.y, steps))
      if (src.helicalHoles) {
        op.helicalHoles = src.helicalHoles.map((h) => {
          const c = movePoint(h.cx, h.cy, steps)
          return { cx: c.x, cy: c.y, radiusMM: h.radiusMM }
        })
      }
      if (src.helicalCenterX !== undefined && src.helicalCenterY !== undefined) {
        const c = movePoint(src.helicalCenterX, src.helicalCenterY, steps)
        op.helicalCenterX = c.x
        op.helicalCenterY = c.y
      }
    }
    if (src.startFrom?.mode === 'op') {
      const target = copyIdOf.get(src.startFrom.opId)
      if (target) op.startFrom = { mode: 'op', opId: target[n] }
    }
    return op as unknown as AnyOperation
  }

  const created: string[] = []
  const extended: string[] = []
  const operations: AnyOperation[] = []
  for (const op of ops) {
    if (copyIdOf.has(op.id)) {
      const batchId = batchOf.get(op.id)!
      operations.push(op.batchId === batchId ? op : { ...op, batchId })
      for (let n = 0; n < copies.length; n++) {
        const c = make(op, n)
        operations.push(c)
        created.push(c.id)
      }
    } else if (sheets.has(op.id) && op.type === 'profile') {
      const more = copies.flatMap((c) => [op.pathId, ...(op.pathIds ?? [])].map((id) => c.pathIds.get(id) ?? id))
      operations.push({ ...op, pathIds: [...(op.pathIds ?? []), ...more] })
      extended.push(op.id)
    } else {
      operations.push(op)
    }
  }
  return { operations, created, extended, skipped }
}
