import { describe, it, expect } from 'vitest'
import { activeSpindleReversed, forSpindle, opsWithSpindleHand } from './spindleHand'
import { BUILTIN_PROFILES } from '../store/postProcessorStore'
import type { AnyOperation } from '../store/toolpathStore'

const m3 = { ...BUILTIN_PROFILES[0], id: 'm3', spindleOnTemplate: 'M3 S{s}' }
const m4 = { ...BUILTIN_PROFILES[0], id: 'm4', spindleOnTemplate: 'M4 S{s}' }

describe('the spindle\'s hand', () => {
  it('reads the ACTIVE post\'s spindle-on line, not any other', () => {
    expect(activeSpindleReversed({ profiles: [m3, m4], activeId: 'm3' })).toBe(false)
    expect(activeSpindleReversed({ profiles: [m3, m4], activeId: 'm4' })).toBe(true)
  })

  it('every shipped post starts the spindle clockwise', () => {
    for (const p of BUILTIN_PROFILES) expect(activeSpindleReversed({ profiles: [p], activeId: p.id })).toBe(false)
  })

  it('swaps climb and conventional on M4 only', () => {
    expect(forSpindle('climb', false)).toBe('climb')
    expect(forSpindle('conventional', false)).toBe('conventional')
    expect(forSpindle('climb', true)).toBe('conventional')
    expect(forSpindle('conventional', true)).toBe('climb')
  })

  it('regenerates the cuts with a hand on a spindle change — and leaves the rest, and a zigzag 3D Profile, alone', () => {
    const op = (o: object) => o as AnyOperation
    const ops = [
      op({ id: 'p', type: 'profile' }), op({ id: 'k', type: 'pocket' }), op({ id: 't', type: 'trochoidal' }),
      op({ id: 'd', type: 'drill' }), op({ id: 'v', type: 'vcarve' }),
      op({ id: '3m', type: 'profile3d' }),                                              // saved before the setting: mixed
      op({ id: '3x', type: 'profile3d', finishDirection: 'mixed' }),
      op({ id: '3c', type: 'profile3d', finishDirection: 'climb' }),
      op({ id: '3r', type: 'profile3d', roughingToolId: 'r', roughingDirection: 'conventional' }),
      op({ id: '3n', type: 'profile3d', roughingDirection: 'climb' }),                   // no roughing tool: no roughing
    ]
    expect(opsWithSpindleHand(ops).map((o) => o.id)).toEqual(['p', 'k', 't', '3c', '3r'])
  })
})
