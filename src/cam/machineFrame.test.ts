import { describe, it, expect, beforeEach } from 'vitest'
import { toMachine, fromMachine, movesToDrawing, MACHINE_X_DIRS, type MachineXDir } from './machineFrame'
import { generateGcode } from './gcode'
import { parseGcode } from '../sim/gcodeParser'
import { useWorkpieceStore, type OriginPosition } from '../store/workpieceStore'
import { useSimStore } from '../store/simStore'
import { BUILTIN_PROFILES, type PostProcessorProfile } from '../store/postProcessorStore'
import type { Tool } from '../store/toolStore'
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'

const FLUIDNC = BUILTIN_PROFILES.find((p) => p.id === 'fluidnc-mm')!
const T1: Tool = { id: 't1', name: 'Quarter End Mill', type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1500, zFeedMmMin: 400, maxDepthMM: 25 }
const T2: Tool = { ...T1, id: 't2', name: 'Eighth End Mill', diameterMM: 3.175, rpm: 22000 }

const cut = (x: number, y: number, z: number, extra: Partial<MotionSegment> = {}): MotionSegment => ({ x, y, z, rapid: false, ...extra })
const rapid = (x: number, y: number, z: number): MotionSegment => ({ x, y, z, rapid: true })

// Lines, a CCW and a CW arc, a helix, a full circle, and a tool change — on a stock that is
// not square, away from the origin, so a swapped axis or a wrong sign shows.
const JOB = (): AnyOperation[] => [{
  id: 'a', name: 'Profile', type: 'profile', toolId: 't1', pathId: 'p', side: 'outside', depthMM: 3, stepDownMM: 1,
  direction: 'climb', rampIn: false, status: 'done', color: '#fff', visible: true,
  segments: [
    rapid(40, 30, 5), cut(40, 30, -1), cut(90, 30, -1),
    cut(110, 50, -1, { arc: { cx: 90, cy: 50, cw: false } }),
    cut(110, 50, -2, { arc: { cx: 100, cy: 50, cw: true } }),
    cut(110, 80, -2), cut(40, 80, -2), rapid(40, 80, 5),
    { x: 40, y: 80, z: 5, rapid: true, toolChange: 't2' },
    rapid(70, 55, 5), cut(70, 55, -1), cut(70, 55, -1, { arc: { cx: 60, cy: 55, cw: true } }), rapid(70, 55, 5),
  ],
} as AnyOperation]

const program = (post: PostProcessorProfile = FLUIDNC) => generateGcode(JOB(), { t1: T1, t2: T2 }, 'frame', post)
const moves = (segs: { x: number; y: number; z: number; prevX: number; prevY: number; prevZ: number; rapid: boolean; feedRateMmMin: number }[]) =>
  segs.map((s) => [s.x, s.y, s.z, s.prevX, s.prevY, s.prevZ, s.rapid, s.feedRateMmMin].map((v) => typeof v === 'number' ? Math.round(v * 1e6) / 1e6 + 0 : v))
const setDir = (machineXDir: MachineXDir) => useWorkpieceStore.setState({ machineXDir })

beforeEach(() => {
  useWorkpieceStore.setState({
    widthMM: 200, heightMM: 120, thicknessMM: 12, origin: 'bottom-left', zOrigin: 'top',
    spindleType: 'vfd', autoFeedEnabled: false, maxFeedMmMin: 0, machineXDir: 'right',
  })
})

describe('machine axes — a turn, never a mirror', () => {
  it('turns the drawing so +X points the chosen way and +Y a quarter turn anticlockwise from it', () => {
    // Where the machine's +X and +Y unit vectors land on the drawing.
    const axes = (d: MachineXDir) => [fromMachine(1, 0, d), fromMachine(0, 1, d)]
    expect(axes('right')).toEqual([[1, 0], [0, 1]])
    expect(axes('up')).toEqual([[0, 1], [-1, 0]])
    expect(axes('left')).toEqual([[-1, 0], [0, -1]])
    expect(axes('down')).toEqual([[0, -1], [1, 0]])
    for (const d of MACHINE_X_DIRS) {
      const [[ax, ay], [bx, by]] = axes(d)
      expect(ax * by - ay * bx, d).toBe(1)   // determinant +1: right-handed, no reflection
    }
  })

  it('takes a point back to exactly where it was', () => {
    for (const d of MACHINE_X_DIRS) {
      for (const [x, y] of [[0, 0], [12.5, -3.25], [-7, 41]]) {
        expect(fromMachine(...toMachine(x, y, d), d), d).toEqual([x, y])
      }
    }
  })
})

describe('the G-code in machine axes, laid back over the drawing', () => {
  for (const d of MACHINE_X_DIRS) {
    it(`parses back onto the same moves as an unturned machine (+X ${d})`, () => {
      const plain = parseGcode(program()).segments
      setDir(d)
      const turned = parseGcode(program()).segments
      movesToDrawing(turned, d)
      expect(moves(turned)).toEqual(moves(plain))
    })
  }

  it('keeps every arc\'s hand — G2 stays G2 — and turns its centre with it', () => {
    const arcs = (g: string) => g.split('\n').filter((l) => /^G[23] /.test(l))
    setDir('up')
    // Drawing (90, 30) → (110, 50) about (90, 50): machine (30, −90) → (50, −110) about (50, −90).
    expect(arcs(program())[0]).toBe('G3 X50.000 Y-110.000 I20.000 J0.000')
    expect(arcs(program()).map((l) => l.slice(0, 2))).toEqual(['G3', 'G2', 'G2'])
  })

  it('does the same when arcs go out as chords', () => {
    const chords = { ...FLUIDNC, outputArcs: false }
    const plain = parseGcode(program(chords)).segments
    setDir('down')
    const turned = parseGcode(program(chords)).segments
    movesToDrawing(turned, 'down')
    expect(moves(turned)).toEqual(moves(plain))
  })

  it('puts the origin corner the user chose on the drawing at machine X0 Y0, whichever way the axes run', () => {
    const xs = { left: 0, center: 100, right: 200 }, ys = { bottom: 0, mid: 60, top: 120 }
    for (const d of MACHINE_X_DIRS) {
      for (const [v, cy] of Object.entries(ys)) for (const [h, cx] of Object.entries(xs)) {
        const origin = (v === 'mid' && h === 'center' ? 'center' : `${v}-${h}`) as OriginPosition
        useWorkpieceStore.setState({ origin, machineXDir: d })
        const op = { ...JOB()[0], segments: [rapid(cx, cy, 5), cut(cx, cy, -1)] } as AnyOperation
        const g = generateGcode([op], { t1: T1 }, 'frame', { ...FLUIDNC, modalOutput: false })
        expect(g, `${d} ${origin}`).toContain('G0 X0.000 Y0.000 Z5.000')
      }
    }
  })

  it('states the stock box in machine axes for the external viewer, and says the axes are turned', () => {
    setDir('up')
    const g = program()
    // Drawing 200 × 120 from its bottom-left: machine X runs 0..120, Y runs −200..0.
    expect(g).toContain('(Stock: XMIN=0 XMAX=120 YMIN=-200 YMAX=0 ZMIN=-12 ZMAX=0)')
    expect(g).toContain('(Machine axes: +X points up on the drawing)')
    setDir('right')
    expect(program()).not.toContain('Machine axes')
  })
})

describe('the simulator lays a loaded program over the drawing', () => {
  it('turns a turned machine\'s program back, so the toolpath lands on its shapes', () => {
    useSimStore.getState().loadGcode(program(), { autoReload: false })
    const plain = moves(useSimStore.getState().segments)
    setDir('left')
    useSimStore.getState().loadGcode(program(), { autoReload: false })
    expect(moves(useSimStore.getState().segments)).toEqual(plain)
    useSimStore.getState().clearSim()
  })
})
