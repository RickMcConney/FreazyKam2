// WHICH WAY THE SPINDLE TURNS DECIDES WHICH WAY "CLIMB" GOES.
//
// Every generator works in M3 terms — a clockwise spindle, seen from above — where climb
// keeps the uncut stock on the RIGHT of the feed: clockwise round an outside, anticlockwise
// round a pocket (`profile.ts`, `pocket.ts`, `trochoidal.ts`, `passHand` in profile3d.ts).
// A spindle started with M4 turns the other way, and the same path is then the other hand.
// So on an M4 post an operation's climb is handed to the generators as conventional and
// vice versa, here, where the operation meets the generator — the generators run in workers
// and never see the post processor, and nothing downstream needs to know.
//
// The spindle's sense is read off the active post processor's spindle-on line
// (`spindleIsReversed`). Changing it changes the toolpaths of every operation with a hand,
// so App regenerates those (`opsWithSpindleHand`).

import type { CuttingDirection } from '../store/toolStore'
import type { AnyOperation } from '../store/toolpathStore'
import { spindleIsReversed, type PostProcessorProfile } from '../store/postProcessorStore'

/** Whether the active post processor in `s` starts the spindle anticlockwise (M4). */
export function activeSpindleReversed(s: { profiles: PostProcessorProfile[]; activeId: string }): boolean {
  const p = s.profiles.find((q) => q.id === s.activeId) ?? s.profiles[0]
  return !!p && spindleIsReversed(p.spindleOnTemplate)
}

/** An operation's direction in the M3 terms the generators read it in. */
export function forSpindle(dir: CuttingDirection, reversed: boolean): CuttingDirection {
  if (!reversed) return dir
  return dir === 'climb' ? 'conventional' : 'climb'
}

/** The operations whose toolpath turns the other way when the spindle does: every profile,
 *  pocket and trochoidal, and a 3D Profile with a one-hand finish or roughing. A mixed 3D
 *  Profile zigzags whichever way the spindle turns. */
export function opsWithSpindleHand(ops: AnyOperation[]): AnyOperation[] {
  return ops.filter((op) => {
    if (op.type === 'profile' || op.type === 'pocket' || op.type === 'trochoidal') return true
    if (op.type === 'profile3d') {
      const oneHand = (d: string | undefined) => d === 'climb' || d === 'conventional'
      return oneHand(op.finishDirection) || (!!op.roughingToolId && oneHand(op.roughingDirection))
    }
    return false
  })
}
