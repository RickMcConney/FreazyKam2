import { describe, it, expect } from 'vitest'
import { globalStepUndoable, globalStepRedoable } from './localHistory'

// Point edit's join/split writes ONE global event, and its local undo replays the
// timeline's. That replay must only happen while the gesture's event is still where the
// gesture left it — otherwise an unrelated edit recorded meanwhile is what gets undone.
describe('point-edit global steps', () => {
  const a = { n: 'a' }, join = { n: 'join' }, other = { n: 'op edit' }

  it('undoes the gesture when its event is still on top of where it began', () => {
    expect(globalStepUndoable([a, join], 2, a)).toBe(true)
    expect(globalStepUndoable([join], 1, null)).toBe(true)   // began at genesis
  })

  it('refuses when anything was recorded on top of the gesture', () => {
    expect(globalStepUndoable([a, join, other], 3, a)).toBe(false)
  })

  it('refuses when the gesture merged into an older event (nothing of its own to undo)', () => {
    expect(globalStepUndoable([{ n: 'a merged' }], 1, a)).toBe(false)
  })

  it('still recognises the step after old history is shed — identity, not cursor number', () => {
    // `a` was at index 4 when the gesture began; the history has since shed 4 events.
    expect(globalStepUndoable([a, join], 2, a)).toBe(true)
  })

  it('redoes only onto the same branch it undid', () => {
    expect(globalStepRedoable([a, join], 1, a, join)).toBe(true)
    // A record after the undo truncated the branch and put a different event there.
    expect(globalStepRedoable([a, other], 1, a, join)).toBe(false)
    expect(globalStepRedoable([a, join], 1, a, undefined)).toBe(false)
  })
})
