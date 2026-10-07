import { describe, it, expect } from 'vitest'
import { parseStatus, applyStatus, EMPTY_POSITION, holdComplete } from './status'

describe('parseStatus', () => {
  it('reads state, machine position, feed/speed and work offset from a FluidNC report', () => {
    const r = parseStatus('<Idle|MPos:10.000,-5.500,-2.250|FS:0,0|WCO:1.000,2.000,3.000>')
    expect(r).toEqual({ state: 'Idle', mpos: [10, -5.5, -2.25], feed: 0, spindle: 0, wco: [1, 2, 3] })
  })

  it('separates a sub-state from the state name (Hold:0, Door:1)', () => {
    const r = parseStatus('<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>')!
    expect(r.state).toBe('Hold')
    expect(r.subState).toBe('0')
  })

  it('reads a WPos report and a bare F feed field', () => {
    const r = parseStatus('<Run|WPos:1.5,2.5,-0.1|F:1200>')!
    expect(r.wpos).toEqual([1.5, 2.5, -0.1])
    expect(r.feed).toBe(1200)
  })

  it('rejects lines that are not status reports (ok, [GC:...], ALARM:)', () => {
    expect(parseStatus('ok')).toBeNull()
    expect(parseStatus('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]')).toBeNull()
    expect(parseStatus('ALARM:1')).toBeNull()
  })
})

describe('parseStatus SD progress', () => {
  it('reads the percent and the file of a running SD job, a comma in the name kept', () => {
    expect(parseStatus('<Run|MPos:0,0,0|FS:500,0|SD:45.20,/jobs/a,b.nc>')!.sd).toEqual({ percent: 45.2, file: '/jobs/a,b.nc' })
  })
})

describe('applyStatus', () => {
  it('derives the work position as MPos minus the work offset', () => {
    const p = applyStatus(EMPTY_POSITION, parseStatus('<Idle|MPos:10,20,-5|FS:0,0|WCO:2,3,-1>')!)
    expect(p.wpos).toEqual([8, 17, -4])
  })

  it('keeps the last work offset when a report omits WCO, as Grbl does on most reports', () => {
    const first = applyStatus(EMPTY_POSITION, parseStatus('<Idle|MPos:0,0,0|FS:0,0|WCO:5,5,5>')!)
    const next = applyStatus(first, parseStatus('<Jog|MPos:10,0,0|FS:500,0>')!)
    expect(next.wco).toEqual([5, 5, 5])
    expect(next.wpos).toEqual([5, -5, -5])
    expect(next.state).toBe('Jog')
  })

  it('derives the machine position from a WPos report plus the work offset', () => {
    const first = applyStatus(EMPTY_POSITION, parseStatus('<Idle|WPos:0,0,0|FS:0,0|WCO:5,6,7>')!)
    expect(first.mpos).toEqual([5, 6, 7])
  })

  it('re-derives the work position when only the work offset changes (zeroing an axis)', () => {
    const first = applyStatus(EMPTY_POSITION, parseStatus('<Idle|MPos:10,10,10|FS:0,0|WCO:0,0,0>')!)
    const zeroed = applyStatus(first, { state: 'Idle', wco: [10, 0, 0] })
    expect(zeroed.wpos).toEqual([0, 10, 10])
  })
})

describe('applyStatus SD progress', () => {
  it('clears the job progress on a report without it, since the job has ended', () => {
    const running = applyStatus(EMPTY_POSITION, parseStatus('<Run|MPos:0,0,0|SD:10.00,/a.nc>')!)
    expect(running.sd).toEqual({ percent: 10, file: '/a.nc' })
    expect(applyStatus(running, parseStatus('<Idle|MPos:0,0,0>')!).sd).toBeNull()
  })
})

describe('override percentages', () => {
  it('reads feed, rapid and spindle overrides from the Ov field', () => {
    expect(parseStatus('<Run|MPos:0,0,0|Ov:120,50,90>')!.ov).toEqual({ feed: 120, rapid: 50, spindle: 90 })
  })

  it('keeps the last overrides when a report leaves the field out, as most do', () => {
    const p = applyStatus(EMPTY_POSITION, parseStatus('<Run|MPos:0,0,0|Ov:120,50,90>')!)
    expect(applyStatus(p, parseStatus('<Run|MPos:1,0,0>')!).ov).toEqual({ feed: 120, rapid: 50, spindle: 90 })
  })
})

describe('holdComplete', () => {
  it('is true only once a feed hold has fully stopped (Hold:0), when a reset cancels without an alarm', () => {
    expect(holdComplete(parseStatus('<Hold:0|MPos:0,0,0>')!)).toBe(true)
  })

  it('is false while the hold is still decelerating (Hold:1), when a reset would throw ALARM:3', () => {
    expect(holdComplete(parseStatus('<Hold:1|MPos:0,0,0>')!)).toBe(false)
  })

  it('is false while running, and for a door hold', () => {
    expect(holdComplete(parseStatus('<Run|MPos:0,0,0>')!)).toBe(false)
    expect(holdComplete(parseStatus('<Door:0|MPos:0,0,0>')!)).toBe(false)
  })
})
