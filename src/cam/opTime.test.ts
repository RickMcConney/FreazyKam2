import { describe, it, expect, beforeEach } from 'vitest'
import { opRunTimesS, fmtDurationShort } from './opTime'
import { generateGcode, generateGcodeWithOps } from './gcode'
import { parseGcode } from '../sim/gcodeParser'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import type { Tool } from '../store/toolStore'
import type { AnyOperation, MotionSegment, ProfileOperation } from '../store/toolpathStore'

const POST: PostProcessorProfile = {
  id: 'test-post', name: 'Test Post', unitMode: 'mm', commentStyle: 'semicolon',
  startGcode: 'G21\nG90', endGcode: 'M5\nG0 Z10\nM30', toolChangeGcode: 'M5\nM0',
  spindleOnTemplate: 'M3 S{s}', spindleOffGcode: 'M5',
  rapidTemplate: 'G0 X{x} Y{y} Z{z}', cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
  arcCWTemplate: 'G2 X{x} Y{y} Z{z} I{i} J{j} F{f}', arcCCWTemplate: 'G3 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  outputArcs: true,
}
const TOOL: Tool = {
  id: 't1', name: 'Test End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const TOOLS = { t1: TOOL }

const cut = (x: number, y: number, z: number): MotionSegment => ({ x, y, z, rapid: false })
const rapid = (x: number, y: number, z: number): MotionSegment => ({ x, y, z, rapid: true })
// A straight groove `len` mm long starting at (x, y): rapid over, plunge 1 mm, cut, lift.
const groove = (x: number, y: number, len: number): MotionSegment[] =>
  [rapid(x, y, 5), cut(x, y, -1), cut(x + len, y, -1), rapid(x + len, y, 5)]
function op(id: string, segments: MotionSegment[], over: Partial<ProfileOperation> = {}): AnyOperation {
  return {
    id, name: `Profile ${id}`, type: 'profile', toolId: 't1', pathId: 'p1',
    side: 'outside', depthMM: 1, stepDownMM: 1, direction: 'climb', rampIn: false,
    status: 'done', segments, color: '#fff', visible: true, ...over,
  }
}

beforeEach(() => {
  // autoFeedEnabled=false + no feed cap: the tool's stored feeds, verbatim.
  useWorkpieceStore.setState({
    widthMM: 200, heightMM: 100, thicknessMM: 12,
    origin: 'bottom-left', zOrigin: 'top', spindleType: 'vfd',
    autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

describe('opRunTimesS — how long each operation runs', () => {
  it('adds up to the whole program\'s estimate, move for move', () => {
    const ops = [op('a', groove(10, 10, 100)), op('b', groove(10, 50, 20)), op('c', groove(150, 80, 5))]
    const times = opRunTimesS(ops, TOOLS, POST)
    const whole = parseGcode(generateGcode(ops, TOOLS, 'x', POST)).totalTimeS
    expect([...times.keys()]).toEqual(['a', 'b', 'c'])
    expect([...times.values()].reduce((s, t) => s + t, 0)).toBeCloseTo(whole, 9)
  })

  it('still adds up when the post\'s start and end blocks move the machine', () => {
    const post = { ...POST, startGcode: 'G21\nG90\nG0 Z40', endGcode: 'M5\nG0 X0 Y0 Z40\nM30' }
    const ops = [op('a', groove(10, 10, 50)), op('b', groove(120, 60, 20))]
    const times = opRunTimesS(ops, TOOLS, post)
    const whole = parseGcode(generateGcode(ops, TOOLS, 'x', post)).totalTimeS
    expect([...times.values()].reduce((s, t) => s + t, 0)).toBeCloseTo(whole, 9)
  })

  it('charges an operation its own cutting — a 100 mm groove at F1000 is six seconds of it', () => {
    // Each alone, from the same start, so the approach and the lift are identical and the
    // difference is exactly the extra 90 mm of cutting.
    const long = opRunTimesS([op('g', groove(10, 10, 100))], TOOLS, POST).get('g')!
    const short = opRunTimesS([op('g', groove(10, 10, 10))], TOOLS, POST).get('g')!
    expect(long).toBeGreaterThan(6)
    expect(long - short).toBeCloseTo(90 / 1000 * 60, 6)
  })

  it('charges the transit INTO an operation to that operation, not to the one before it', () => {
    // Same groove for b; only how far it lies from where a finished changes.
    const near = opRunTimesS([op('a', groove(10, 10, 10)), op('b', groove(25, 10, 10))], TOOLS, POST)
    const far = opRunTimesS([op('a', groove(10, 10, 10)), op('b', groove(180, 90, 10))], TOOLS, POST)
    expect(far.get('a')).toBeCloseTo(near.get('a')!, 9)
    expect(far.get('b')!).toBeGreaterThan(near.get('b')!)
  })

  it('leaves out what is not in the exported program — hidden, not generated, failed', () => {
    const times = opRunTimesS([
      op('shown', groove(10, 10, 10)),
      op('hidden', groove(10, 20, 10), { visible: false }),
      op('stale', groove(10, 30, 10), { status: 'needs-update' }),
      op('failed', [], { status: 'error' }),
    ], TOOLS, POST)
    expect([...times.keys()]).toEqual(['shown'])
  })

  it('knows where each operation\'s section starts: on its own header line', () => {
    const ops = [op('a', groove(10, 10, 10)), op('b', groove(10, 50, 10))]
    const { gcode, opStarts } = generateGcodeWithOps(ops, TOOLS, 'x', POST)
    const lines = gcode.split('\n')
    expect(opStarts.map((s) => lines[s.line])).toEqual(['; === Profile a ===', '; === Profile b ==='])
    expect(gcode).toBe(generateGcode(ops, TOOLS, 'x', POST))
  })
})

describe('fmtDurationShort — a run time that fits on a chip', () => {
  it('reads in seconds under a minute, whole minutes under an hour, then hours and minutes', () => {
    // 3599 s rounds to 60 minutes, which is an hour — never "60m".
    expect([0, 40.4, 59.4, 60, 192, 3599, 3600, 3900].map(fmtDurationShort))
      .toEqual(['', '40s', '59s', '1m', '3m', '1h 0m', '1h 0m', '1h 5m'])
  })
})
