import { describe, it, expect } from 'vitest'
import { jogCommand, JOG_STEPS_MM, zeroCommand, goToCommands, homeCommand, OVERRIDE, zMoveCommand } from './jog'

describe('jogCommand', () => {
  it('names relative distance mode and mm units on every jog, so the controller modal state cannot change its meaning', () => {
    expect(jogCommand({ x: 10 }, 1000)).toBe('$J=G91 G21 X10 F1000')
  })

  it('combines axes into one diagonal move, signs kept (Y-up: -Y moves toward the front)', () => {
    expect(jogCommand({ x: -1, y: 1.5 }, 500)).toBe('$J=G91 G21 X-1 Y1.5 F500')
  })

  it('sends nothing for a zero move or a non-positive feed', () => {
    expect(jogCommand({}, 1000)).toBeNull()
    expect(jogCommand({ z: 1 }, 0)).toBeNull()
  })
})

describe('JOG_STEPS_MM', () => {
  it('sends the smallest inch step as 0.0254 mm, not rounded to 0.025', () => {
    expect(jogCommand({ x: JOG_STEPS_MM.in[0] }, 100)).toBe('$J=G91 G21 X0.0254 F100')
    expect(jogCommand({ x: JOG_STEPS_MM.in[2] }, 100)).toBe('$J=G91 G21 X2.54 F100')
  })
})

describe('zeroCommand', () => {
  it('zeroes only the named axis, in the ACTIVE coordinate system (P0), not a fixed G54', () => {
    expect(zeroCommand(['x'])).toBe('G10 L20 P0 X0')
    expect(zeroCommand(['z'])).toBe('G10 L20 P0 Z0')
  })

  it('sends nothing when no axis is named', () => {
    expect(zeroCommand([])).toBeNull()
  })
})

describe('goToCommands', () => {
  it('moves X and Y as one absolute (G90) mm jog in work coordinates, leaving Z alone', () => {
    expect(goToCommands(50, -12.5, 1000)).toEqual(['$J=G90 G21 X50 Y-12.5 F1000'])
  })

  it('raises Z to the lift height BEFORE the XY move, at the Z feed, so the tool is not dragged across the stock', () => {
    expect(goToCommands(10, 20, 1000, { z: 5, feedZ: 300 })).toEqual([
      '$J=G90 G21 Z5 F300',
      '$J=G90 G21 X10 Y20 F1000',
    ])
  })

  it('sends nothing for a non-positive feed or a non-finite target', () => {
    expect(goToCommands(1, 1, 0)).toEqual([])
    expect(goToCommands(NaN, 1, 1000)).toEqual([])
  })
})

describe('homeCommand', () => {
  it('runs the whole configured cycle when no axis is named, and one axis when one is', () => {
    expect(homeCommand()).toBe('$H')
    expect(homeCommand('z')).toBe('$HZ')
  })
})

describe('OVERRIDE', () => {
  it('uses the Grbl 1.1 realtime bytes: feed 0x90–0x94, rapid 0x95–0x97, spindle 0x99–0x9D', () => {
    expect(OVERRIDE.feed.reset.charCodeAt(0)).toBe(0x90)
    expect(OVERRIDE.feed.plus10.charCodeAt(0)).toBe(0x91)
    expect(OVERRIDE.feed.minus1.charCodeAt(0)).toBe(0x94)
    expect(OVERRIDE.rapid[100].charCodeAt(0)).toBe(0x95)
    expect(OVERRIDE.rapid[25].charCodeAt(0)).toBe(0x97)
    expect(OVERRIDE.spindle.reset.charCodeAt(0)).toBe(0x99)
    expect(OVERRIDE.spindle.minus1.charCodeAt(0)).toBe(0x9d)
  })
})

describe('zMoveCommand', () => {
  it('moves Z alone to an absolute work height as a jog, leaving X and Y where they are', () => {
    expect(zMoveCommand(5, 300)).toBe('$J=G90 G21 Z5 F300')
  })

  it('sends nothing for a non-positive feed', () => {
    expect(zMoveCommand(5, 0)).toBeNull()
  })
})
