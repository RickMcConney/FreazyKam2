import { describe, it, expect } from 'vitest'
import { parsePrb, probeDownCommand, zOffsetFromProbe, probeAlarmMessage } from './probe'
import { parseStatus, applyStatus, EMPTY_POSITION } from './status'

// Formats as FluidNC's source writes them (Report.cpp, MotionControl.cpp, GCode.cpp).
describe('reading a probe report', () => {
  it('reads the machine position and the success flag', () => {
    expect(parsePrb('[PRB:12.000,-3.500,-10.025:1]')).toEqual({ mpos: [12, -3.5, -10.025], ok: true })
    expect(parsePrb('[PRB:0.000,0.000,0.000:0]')).toEqual({ mpos: [0, 0, 0], ok: false })
  })

  it('takes a report from a machine with more than three axes', () => {
    expect(parsePrb('[PRB:1.000,2.000,3.000,90.000:1]')!.mpos).toEqual([1, 2, 3, 90])
  })

  it('is not fooled by other bracketed messages', () => {
    expect(parsePrb('[MSG:INFO: Probe offset applied:]')).toBeNull()
    expect(parsePrb('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]')).toBeNull()
    expect(parsePrb('<Idle|MPos:0,0,0>')).toBeNull()
  })
})

describe('the probe commands', () => {
  it('probes down in absolute work Z, in mm, at the feed', () => {
    expect(probeDownCommand(-25, 100)).toBe('G90 G21 G38.2 Z-25 F100')
  })

  it('sets the offset so the plate\'s top reads as its thickness — Z0 on the stock beneath it', () => {
    // Touched at machine Z −10.025 with a 10 mm plate: the stock top is machine Z −20.025.
    expect(zOffsetFromProbe(-10.025, 10)).toBe('G10 L2 P0 Z-20.025')
  })


  it('says what a probing alarm means, and nothing for other alarms', () => {
    expect(probeAlarmMessage(4, 25)).toMatch(/already touching/)
    expect(probeAlarmMessage(5, 25)).toMatch(/never touched in 25 mm/)
    expect(probeAlarmMessage(1, 25)).toBeNull()
  })
})

describe('the probe input in a status report', () => {
  const pos = (line: string) => applyStatus(EMPTY_POSITION, parseStatus(line)!)

  it('is on while Pn: lists P, toolsetter or limit pins beside it or not', () => {
    expect(pos('<Idle|MPos:0,0,0|FS:0,0|Pn:P>').probe).toBe(true)
    expect(pos('<Idle|MPos:0,0,0|FS:0,0|Pn:XPT>').probe).toBe(true)
  })

  it('is off when Pn: is absent — FluidNC sends it only while an input is on', () => {
    const touching = pos('<Idle|MPos:0,0,0|FS:0,0|Pn:P>')
    expect(applyStatus(touching, parseStatus('<Idle|MPos:0,0,0|FS:0,0>')!).probe).toBe(false)
    expect(pos('<Idle|MPos:0,0,0|FS:0,0|Pn:XT>').probe).toBe(false)
  })
})
