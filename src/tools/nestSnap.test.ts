import { describe, it, expect, beforeEach } from 'vitest'
import { snapToGap, type SnapParams } from './nestSnap'
import { nest, type NestPlacement } from './nestOp'
import { generateSharedLineProfile } from '../cam/sharedLineProfile'
import { takeNotes } from '../cam/notes'
import type { Pt2 } from '../cam/pathFlattener'
import type { Tool } from '../store/toolStore'

const rect = (x: number, y: number, w: number, h: number): Pt2[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
const toD = (ring: Pt2[]) => `M ${ring.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`

function place(ring: Pt2[], p: NestPlacement): Pt2[] {
  const t = (p.angleDeg * Math.PI) / 180
  const cos = Math.cos(t), sin = Math.sin(t)
  return ring.map(([x, y]) => {
    const dx = x - p.pivotX, dy = y - p.pivotY
    return [p.pivotX + cos * dx - sin * dy + p.dx, p.pivotY + sin * dx + cos * dy + p.dy] as Pt2
  })
}

const box = (r: Pt2[]) => ({
  minX: Math.min(...r.map((p) => p[0])), maxX: Math.max(...r.map((p) => p[0])),
  minY: Math.min(...r.map((p) => p[1])), maxY: Math.max(...r.map((p) => p[1])),
})

/** Clear distance between two axis-aligned boxes; negative when they overlap. */
function boxGap(a: ReturnType<typeof box>, b: ReturnType<typeof box>): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX)
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY)
  return dx >= 0 && dy >= 0 ? Math.hypot(dx, dy) : Math.max(dx, dy)
}

const RATES = { rapidMmMin: 3000, accelMmS2: 200, junctionDeviationMM: 0.01 }
const SHEET: SnapParams = { gapMM: 6, sheetWidthMM: 200, sheetHeightMM: 100, marginMM: 2, packFrom: 'left' }

beforeEach(() => { takeNotes() })

describe('snapToGap', () => {
  it('a part slides left until its outline stands exactly one gap from its neighbour', () => {
    const shifts = snapToGap([
      { id: 'a', rings: [rect(2, 2, 20, 20)] },
      { id: 'b', rings: [rect(28.4, 2, 20, 20)] },
    ], [], SHEET)
    expect(shifts.has('a')).toBe(false)
    expect(shifts.get('b')!.dx).toBeCloseTo(-0.4, 9)
    expect(shifts.get('b')!.dy).toBe(0)
  })

  it('a part slides down to the margin when nothing is in the way', () => {
    const shifts = snapToGap([{ id: 'a', rings: [rect(2, 7.5, 20, 20)] }], [], SHEET)
    expect(shifts.get('a')).toEqual({ dx: 0, dy: -5.5 })
  })

  it('a part slides past a neighbour it only grazes along a parallel edge', () => {
    // b's cut path touches a's along the line between them; sliding down along it is free.
    const shifts = snapToGap([
      { id: 'a', rings: [rect(2, 2, 20, 20)] },
      { id: 'b', rings: [rect(28, 30, 20, 20)] },
    ], [], { ...SHEET, packFrom: 'bottom' })
    expect(shifts.get('b')).toEqual({ dx: 0, dy: -28 })
  })

  it('a part slides up against another path it must avoid, not through it', () => {
    const shifts = snapToGap([{ id: 'a', rings: [rect(40, 2, 20, 20)] }], [[rect(2, 2, 20, 20)]], SHEET)
    expect(shifts.get('a')!.dx).toBeCloseTo(-12, 9)
  })

  it('a neighbour\'s point meeting a flat edge stops the slide, though no corner of the sliding part touches it', () => {
    // A small arrow pointing right at a's left edge: only the arrow's tip can meet a.
    const arrow: Pt2[] = [[2, 8], [20, 10], [2, 12]]
    const shifts = snapToGap([{ id: 'a', rings: [rect(40, 2, 20, 18)] }], [[arrow]], SHEET)
    // a's cut path reaches 3 mm left of it; the arrow's tip sticks out past its own mitre.
    const dx = shifts.get('a')!.dx
    expect(dx).toBeLessThan(-10)
    expect(40 + dx).toBeGreaterThan(20)
  })

  it('a part sitting in another part\'s hole stays where it is, and so does the part around it', () => {
    const frame = [rect(10, 10, 60, 60), rect(25, 25, 30, 30)]
    const shifts = snapToGap([
      { id: 'frame', rings: frame },
      { id: 'inner', rings: [rect(35, 35, 10, 10)] },
    ], [], SHEET)
    expect(shifts.size).toBe(0)
  })
})

describe('nest with snapGapMM', () => {
  const tool: Tool = {
    id: 't', name: 't', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000,
    xyFeedMmMin: 2000, zFeedMmMin: 400, maxDepthMM: 30,
  }
  const parts = [rect(0, 0, 40, 25), rect(0, 0, 40, 25), rect(0, 0, 30, 25), rect(0, 0, 30, 25)]
  const run = (snapGapMM?: number) => nest(parts.map((rings, i) => ({ id: `p${i}`, rings: [rings] })), {
    sheetWidthMM: 300, sheetHeightMM: 100, spacingMM: 6, marginMM: 3, rotationStepDeg: 0, useHoles: false,
    ...(snapGapMM ? { snapGapMM } : {}),
  })
  const placed = (r: ReturnType<typeof run>) => r.placements.map((p) => place(parts[Number(p.id.slice(1))], p))

  it('facing edges of snapped parts stand exactly one cutter apart, and none are closer', () => {
    const rings = placed(run(6))
    const gaps: number[] = []
    for (let i = 0; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) gaps.push(boxGap(box(rings[i]), box(rings[j])))
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(6 - 1e-9)
    expect(gaps.filter((g) => Math.abs(g - 6) < 1e-6).length).toBeGreaterThanOrEqual(3)
  })

  it('without snapping the raster leaves gaps over a cutter wide, so nothing is shared', () => {
    const rings = placed(run())
    const r = generateSharedLineProfile(rings.map((ring) => ({ d: toD(ring) })), tool,
      { side: 'outside', depthMM: 6, stepDownMM: 3, direction: 'climb' }, RATES)
    expect(r.sharedLengthMM).toBe(0)
  })

  it('the shared-line profile of a snapped nest shares lines between the parts', () => {
    const rings = placed(run(6))
    const r = generateSharedLineProfile(rings.map((ring) => ({ d: toD(ring) })), tool,
      { side: 'outside', depthMM: 6, stepDownMM: 3, direction: 'climb' }, RATES)
    expect(takeNotes()).toEqual([])
    expect(r.sharedLengthMM).toBeGreaterThan(60)
  })

  it('every snapped part stays on the stock inside the margin', () => {
    for (const ring of placed(run(6))) {
      const b = box(ring)
      expect(b.minX).toBeGreaterThanOrEqual(3 - 1e-9)
      expect(b.minY).toBeGreaterThanOrEqual(3 - 1e-9)
      expect(b.maxX).toBeLessThanOrEqual(297 + 1e-9)
      expect(b.maxY).toBeLessThanOrEqual(97 + 1e-9)
    }
  })
})
