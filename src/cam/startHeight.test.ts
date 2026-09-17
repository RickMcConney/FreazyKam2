import { describe, it, expect } from 'vitest'
import { resolveStartZ, listFlatFloorOps, startInputForOp, resolveStartZForOp } from './startHeight'
import type { AnyOperation } from '../store/toolpathStore'
import type { ImportedPath } from '../store/pathsStore'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STOCK = { widthMM: 200, heightMM: 200 }

const rect = (x: number, y: number, w: number, h: number) =>
  `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`

// Two half-arcs, the same way shapeGenerators emits circles.
const circle = (cx: number, cy: number, r: number) =>
  `M ${cx - r} ${cy} A ${r} ${r} 0 0 0 ${cx + r} ${cy} A ${r} ${r} 0 0 0 ${cx - r} ${cy} Z`

const path = (id: string, d: string): ImportedPath =>
  ({ id, name: id, d, visible: true, color: '#fff' })

const pocket = (
  id: string,
  pathId: string,
  depthMM: number,
  extra: Partial<AnyOperation> = {},
): AnyOperation => ({
  id, name: `Pocket ${id}`, type: 'pocket', toolId: 't', status: 'done', segments: [],
  color: '#f00', visible: true, pathId, islandIds: [], depthMM, stepDownMM: 1,
  stepoverPercent: 40, passAngleDeg: 0, direction: 'climb', strategy: 'raster', rampIn: false,
  ...extra,
} as AnyOperation)

const auto = { mode: 'auto' } as const

// ─── Auto resolution ──────────────────────────────────────────────────────────

describe('resolveStartZ — auto', () => {
  it('starts on the floor of a pocket the footprint sits inside', () => {
    const paths = [path('outer', rect(0, 0, 50, 50)), path('inner', rect(5, 5, 40, 40))]
    const ops = [pocket('op1', 'outer', 2)]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(-2)
    expect(r.sourceOpId).toBe('op1')
  })

  // The bbox of a square inscribed in a round pocket pokes outside it at the corners even
  // though the square itself is well inside — resolving on the outline, not the bbox, is
  // what keeps this from falling back to stock top.
  it('handles a square footprint inside a ROUND pocket', () => {
    const paths = [path('outer', circle(50, 50, 30)), path('inner', rect(35, 35, 30, 30))]
    const ops = [pocket('op1', 'outer', 2)]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(-2)
  })

  it('nested pockets stack: a 2 mm pocket in a 2 mm pocket leaves its floor at -4', () => {
    const paths = [
      path('outer', rect(0, 0, 50, 50)),
      path('middle', rect(5, 5, 40, 40)),
      path('inner', rect(15, 15, 10, 10)),
    ]
    const ops = [pocket('op1', 'outer', 2), pocket('op2', 'middle', 2, { startFrom: auto })]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[2].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(-4)
    expect(r.sourceOpId).toBe('op2')
  })

  it('an inner pocket left on stock top does NOT deepen the floor below it', () => {
    const paths = [
      path('outer', rect(0, 0, 50, 50)),
      path('middle', rect(5, 5, 40, 40)),
      path('inner', rect(15, 15, 10, 10)),
    ]
    // op2 explicitly starts at stock top, so its floor is -2 — the same as op1's.
    const ops = [pocket('op1', 'outer', 2), pocket('op2', 'middle', 2, { startFrom: { mode: 'stock' } })]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[2].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(-2)
  })

  it('falls back to stock top when part of the footprint is over uncut stock', () => {
    const paths = [path('outer', rect(0, 0, 50, 50)), path('inner', rect(40, 40, 30, 30))]
    const ops = [pocket('op1', 'outer', 2)]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(0)
    expect(r.label).toMatch(/uncut stock/)
  })

  it('falls back to stock top when nothing was cut there at all', () => {
    const paths = [path('outer', rect(0, 0, 50, 50)), path('far', rect(100, 100, 10, 10))]
    const ops = [pocket('op1', 'outer', 2)]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(0)
    expect(r.label).toMatch(/nothing cut here yet/)
  })

  // Cut margin is how far the cut reaches PAST the path: an outside profile of a shape
  // that only just fits inside the pocket swings its tool over the uncut wall.
  it('the cut margin can push a footprint past the pocket wall', () => {
    const paths = [path('outer', rect(0, 0, 50, 50)), path('inner', rect(2, 2, 46, 46))]
    const ops = [pocket('op1', 'outer', 2)]
    const inside = resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK)
    const outside = resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 6 }, ops, paths, STOCK)
    expect(inside.zMM).toBe(-2)
    expect(outside.zMM).toBe(0)
  })

  it('a pocket island is not cut, so a footprint over it stays at stock top', () => {
    const paths = [
      path('outer', rect(0, 0, 50, 50)),
      path('island', rect(20, 20, 20, 20)),
      path('inner', rect(24, 24, 12, 12)),
    ]
    const ops = [pocket('op1', 'outer', 2, { islandIds: ['island'] } as Partial<AnyOperation>)]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[2].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(0)
  })

  // Residual height at a point is the DEEPEST floor covering it, and the start is the
  // highest of those over the footprint.
  it('a deeper pocket overlapping a shallower one wins', () => {
    const paths = [path('a', rect(0, 0, 50, 50)), path('b', rect(0, 0, 50, 50)), path('inner', rect(10, 10, 10, 10))]
    const ops = [pocket('op1', 'a', 2), pocket('op2', 'b', 3)]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[2].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(-3)
  })

  it('a footprint spanning two depths takes the shallower one', () => {
    const paths = [
      path('a', rect(0, 0, 30, 50)),    // left half, 2 mm
      path('b', rect(30, 0, 30, 50)),   // right half, 5 mm
      path('inner', rect(20, 20, 20, 10)),  // straddles the seam
    ]
    const ops = [pocket('op1', 'a', 2), pocket('op2', 'b', 5)]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[2].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(-2)
  })

  it('only operations BEFORE this one count', () => {
    const paths = [path('outer', rect(0, 0, 50, 50)), path('inner', rect(5, 5, 40, 40))]
    // The pocket is listed AFTER the op being resolved, so it hasn't run yet.
    const ops = [pocket('me', 'inner', 1, { startFrom: auto }), pocket('op1', 'outer', 2)]
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0, opId: 'me' }, ops, paths, STOCK)
    expect(r.zMM).toBe(0)
  })

  it('ignores operation types that leave no flat floor', () => {
    const paths = [path('outer', rect(0, 0, 50, 50)), path('inner', rect(5, 5, 40, 40))]
    const vcarve = {
      id: 'v1', name: 'V-Carve', type: 'vcarve', toolId: 't', status: 'done', segments: [],
      color: '#0f0', visible: true, pathId: 'outer', islandIds: [], maxDepthMM: 2, angleDeg: 90,
    } as AnyOperation
    const r = resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 }, [vcarve], paths, STOCK)
    expect(r.zMM).toBe(0)
  })
})

// ─── Explicit modes ───────────────────────────────────────────────────────────

describe('resolveStartZ — explicit modes', () => {
  const paths = [path('outer', rect(0, 0, 50, 50)), path('inner', rect(5, 5, 40, 40))]
  const ops = [pocket('op1', 'outer', 2)]

  // Operations saved before start heights existed have no `startFrom`; they must keep
  // emitting exactly the G-code they always did.
  it('a missing startFrom means stock top, not auto', () => {
    const r = resolveStartZ({ footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(0)
  })

  it('stock pins the start at 0 even when a floor is available', () => {
    const r = resolveStartZ({ startFrom: { mode: 'stock' }, footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(0)
  })

  it('op takes the named operation floor without any coverage test', () => {
    const away = [path('outer', rect(0, 0, 50, 50)), path('far', rect(100, 100, 10, 10))]
    const r = resolveStartZ({ startFrom: { mode: 'op', opId: 'op1' }, footprintD: away[1].d, cutMarginMM: 0 }, ops, away, STOCK)
    expect(r.zMM).toBe(-2)
  })

  it('op pointing at a deleted operation falls back to stock top', () => {
    const r = resolveStartZ({ startFrom: { mode: 'op', opId: 'gone' }, footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK)
    expect(r.zMM).toBe(0)
  })

  it('manual is taken as given, clamped to at most stock top', () => {
    expect(resolveStartZ({ startFrom: { mode: 'manual', zMM: -7 }, footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK).zMM).toBe(-7)
    expect(resolveStartZ({ startFrom: { mode: 'manual', zMM: 3 }, footprintD: paths[1].d, cutMarginMM: 0 }, ops, paths, STOCK).zMM).toBe(0)
  })
})

// ─── Dropdown candidates ──────────────────────────────────────────────────────

describe('listFlatFloorOps', () => {
  it('reports each floor at the depth it actually reaches', () => {
    const paths = [path('outer', rect(0, 0, 50, 50)), path('middle', rect(5, 5, 40, 40))]
    const ops = [pocket('op1', 'outer', 2), pocket('op2', 'middle', 2, { startFrom: auto })]
    expect(listFlatFloorOps(ops, paths, STOCK)).toEqual([
      { opId: 'op1', name: 'Pocket op1', zMM: -2 },
      { opId: 'op2', name: 'Pocket op2', zMM: -4 },
    ])
  })

  it('excludes the operation being edited and everything after it', () => {
    const paths = [path('outer', rect(0, 0, 50, 50)), path('middle', rect(5, 5, 40, 40))]
    const ops = [pocket('op1', 'outer', 2), pocket('op2', 'middle', 2)]
    expect(listFlatFloorOps(ops, paths, STOCK, 'op2').map((c) => c.opId)).toEqual(['op1'])
  })
})

// ─── Per-operation inputs ─────────────────────────────────────────────────────
//
// startInputForOp is the single definition of "what does this op sit on", shared by
// generation, by the stamp recording what generation used, and by the staleness check
// comparing the two. If it drifted, those three would disagree about an op's start height.

describe('startInputForOp', () => {
  const paths = [path('outer', rect(0, 0, 50, 50)), path('inner', rect(5, 5, 40, 40))]
  const tools = [{ id: 't', diameterMM: 6 }]

  const profileOp = (side: 'outside' | 'inside' | 'centerline'): AnyOperation => ({
    id: 'pr', name: 'Profile', type: 'profile', toolId: 't', status: 'done', segments: [],
    color: '#00f', visible: true, pathId: 'inner', side, depthMM: 3, stepDownMM: 1,
    direction: 'climb', rampIn: false,
  } as AnyOperation)

  it('pocket and v-carve stay inside their outline (margin 0)', () => {
    expect(startInputForOp(pocket('op1', 'inner', 2), paths, tools)?.cutMarginMM).toBe(0)
    const vcarve = {
      id: 'v', name: 'V', type: 'vcarve', toolId: 't', status: 'done', segments: [], color: '#0f0',
      visible: true, pathId: 'inner', islandIds: [], maxDepthMM: 2, angleDeg: 90,
    } as AnyOperation
    expect(startInputForOp(vcarve, paths, tools)?.cutMarginMM).toBe(0)
  })

  it('profile margin follows the cut side', () => {
    expect(startInputForOp(profileOp('outside'), paths, tools)?.cutMarginMM).toBe(6)
    expect(startInputForOp(profileOp('centerline'), paths, tools)?.cutMarginMM).toBe(3)
    expect(startInputForOp(profileOp('inside'), paths, tools)?.cutMarginMM).toBe(0)
  })

  it('is null for operation types with no start-height support', () => {
    const surface = {
      id: 's', name: 'Surface', type: 'surface', toolId: 't', status: 'done', segments: [], color: '#0ff',
      visible: true, depthMM: 1, stepDownMM: 1, stepoverPercent: 50, passAngleDeg: 0,
    } as AnyOperation
    expect(startInputForOp(surface, paths, tools)).toBeNull()
  })

  const drillOp = (over: Partial<Record<string, unknown>> = {}): AnyOperation => ({
    id: 'd', name: 'Drill', type: 'drill', toolId: 't', status: 'done', segments: [], color: '#0ff',
    visible: true, drillMode: 'peck', points: [], depthMM: 3, stepDownMM: 1, ...over,
  } as AnyOperation)

  it('takes a drill\'s footprint from its source path, with no margin', () => {
    // The bore's wall IS the path — a helical drill never swings outside its circle.
    const input = startInputForOp(drillOp({ pathId: 'inner' }), paths, tools)
    expect(input?.cutMarginMM).toBe(0)
    expect(input?.footprintD).toBe(paths[1].d)
  })

  it('builds a footprint from clicked peck points when there is no path', () => {
    // Hand-placed points have no path to stand for them, but they still have to
    // know whether they land on a pocket floor or on bare stock. The footprint is
    // then the holes themselves: one disc of the tool per point.
    const input = startInputForOp(drillOp({ points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }), paths, tools)
    expect(input?.footprintD).toMatch(/^M 7 10 A 3 3 .* M 17 20 A 3 3 /)
    expect(input?.cutMarginMM).toBe(0)
  })

  it('is null for a drill with neither a path nor any points', () => {
    expect(startInputForOp(drillOp(), paths, tools)).toBeNull()
    expect(startInputForOp(drillOp({ points: [{ x: 1, y: 1 }] }), paths, [{ id: 't', diameterMM: 0 }])).toBeNull()
  })

  it('is null when the source path is gone', () => {
    expect(startInputForOp(pocket('op1', 'missing', 2), paths, tools)).toBeNull()
  })
})

describe('resolveStartZForOp', () => {
  const paths = [
    path('outer', rect(0, 0, 50, 50)),
    path('middle', rect(5, 5, 40, 40)),
    path('inner', rect(15, 15, 10, 10)),
  ]
  const tools = [{ id: 't', diameterMM: 6 }]

  it('resolves a nested chain the same way generation does', () => {
    const op1 = pocket('op1', 'outer', 2)
    const op2 = pocket('op2', 'middle', 2, { startFrom: auto })
    const op3 = pocket('op3', 'inner', 1, { startFrom: auto })
    const ops = [op1, op2, op3]
    expect(resolveStartZForOp(op1, ops, paths, STOCK, tools).zMM).toBe(0)
    expect(resolveStartZForOp(op2, ops, paths, STOCK, tools).zMM).toBe(-2)
    expect(resolveStartZForOp(op3, ops, paths, STOCK, tools).zMM).toBe(-4)
  })

  // The drift the invalidation pass looks for: op3's own settings never changed, but
  // reordering it above op2 puts it on a different floor.
  it('reordering an operation changes what it starts from', () => {
    const op1 = pocket('op1', 'outer', 2)
    const op2 = pocket('op2', 'middle', 2, { startFrom: auto })
    const op3 = pocket('op3', 'inner', 1, { startFrom: auto })
    expect(resolveStartZForOp(op3, [op1, op2, op3], paths, STOCK, tools).zMM).toBe(-4)
    expect(resolveStartZForOp(op3, [op1, op3, op2], paths, STOCK, tools).zMM).toBe(-2)
    expect(resolveStartZForOp(op3, [op3, op1, op2], paths, STOCK, tools).zMM).toBe(0)
  })

  it('deleting the operation underneath raises the start back to stock top', () => {
    const op1 = pocket('op1', 'outer', 2)
    const op3 = pocket('op3', 'inner', 1, { startFrom: auto })
    expect(resolveStartZForOp(op3, [op1, op3], paths, STOCK, tools).zMM).toBe(-2)
    expect(resolveStartZForOp(op3, [op3], paths, STOCK, tools).zMM).toBe(0)
  })

  // ─── Helical bores leave a floor ───────────────────────────────────────────
  //
  // Reported from the app: a small hole placed inside a big one, with the big one drilled
  // first, still started at Z0. An end mill spiralling a hole takes the WHOLE disc out to
  // a flat bottom — it leaves a round pocket — so the small hole starts on that bottom.

  const helical = (
    id: string,
    pathId: string | undefined,
    depthMM: number,
    holes: { cx: number; cy: number; radiusMM: number }[],
    extra: Partial<AnyOperation> = {},
  ): AnyOperation => ({
    id, name: `Bore ${id}`, type: 'drill', toolId: 't', status: 'done', segments: [],
    color: '#0ff', visible: true, drillMode: 'helical', points: [], pathId,
    helicalHoles: holes, depthMM, stepDownMM: 1, ...extra,
  } as AnyOperation)

  it('a hole drilled inside a helically bored hole starts on that bore\'s bottom', () => {
    const drillPaths = [path('big', circle(50, 50, 12)), path('small', circle(50, 50, 4))]
    const big = helical('b1', 'big', 3, [{ cx: 50, cy: 50, radiusMM: 12 }])
    const small = helical('b2', 'small', 5, [{ cx: 50, cy: 50, radiusMM: 4 }], { startFrom: auto })
    expect(resolveStartZForOp(small, [big, small], drillPaths, STOCK, tools).zMM).toBe(-3)
  })

  it('a bore drilled SECOND is not a floor for the one before it', () => {
    const drillPaths = [path('big', circle(50, 50, 12)), path('small', circle(50, 50, 4))]
    const big = helical('b1', 'big', 3, [{ cx: 50, cy: 50, radiusMM: 12 }])
    const small = helical('b2', 'small', 5, [{ cx: 50, cy: 50, radiusMM: 4 }], { startFrom: auto })
    expect(resolveStartZForOp(small, [small, big], drillPaths, STOCK, tools).zMM).toBe(0)
  })

  it('a bore sticking out past the one under it reaches uncut stock, so starts at stock top', () => {
    const drillPaths = [path('big', circle(50, 50, 12)), path('off', circle(60, 50, 4))]
    const big = helical('b1', 'big', 3, [{ cx: 50, cy: 50, radiusMM: 12 }])
    const off = helical('b2', 'off', 5, [{ cx: 60, cy: 50, radiusMM: 4 }], { startFrom: auto })
    expect(resolveStartZForOp(off, [big, off], drillPaths, STOCK, tools).zMM).toBe(0)
  })

  it('a bore in a pocket floor puts ITS floor that much deeper', () => {
    // The bore starts on the pocket floor at -2 and cuts 3 more, so the hole it leaves is
    // at -5 — not at -3. A start height read from its own depth alone would plunge 2 mm
    // of solid stock on anything that followed it into the hole.
    const drillPaths = [
      path('outer', rect(0, 0, 100, 100)),
      path('big', circle(50, 50, 12)),
      path('small', circle(50, 50, 4)),
    ]
    const pkt = pocket('p1', 'outer', 2)
    const big = helical('b1', 'big', 3, [{ cx: 50, cy: 50, radiusMM: 12 }], { startFrom: auto })
    const small = helical('b2', 'small', 5, [{ cx: 50, cy: 50, radiusMM: 4 }], { startFrom: auto })
    const ops = [pkt, big, small]
    expect(resolveStartZForOp(big, ops, drillPaths, STOCK, tools).zMM).toBe(-2)
    expect(resolveStartZForOp(small, ops, drillPaths, STOCK, tools).zMM).toBe(-5)
  })

  it('a PECK hole leaves no floor — its point is a cone, not a flat bottom', () => {
    const drillPaths = [path('big', circle(50, 50, 12)), path('small', circle(50, 50, 4))]
    const peck = {
      id: 'p', name: 'Peck', type: 'drill', toolId: 't', status: 'done', segments: [], color: '#0ff',
      visible: true, drillMode: 'peck', points: [{ x: 50, y: 50 }], pathId: 'big',
      depthMM: 3, stepDownMM: 1,
    } as AnyOperation
    const small = helical('b2', 'small', 5, [{ cx: 50, cy: 50, radiusMM: 4 }], { startFrom: auto })
    expect(resolveStartZForOp(small, [peck, small], drillPaths, STOCK, tools).zMM).toBe(0)
  })

  it('offers a helical bore in the Start dropdown alongside pockets', () => {
    const drillPaths = [path('big', circle(50, 50, 12)), path('small', circle(50, 50, 4))]
    const big = helical('b1', 'big', 3, [{ cx: 50, cy: 50, radiusMM: 12 }])
    const small = helical('b2', 'small', 5, [{ cx: 50, cy: 50, radiusMM: 4 }], { startFrom: auto })
    expect(listFlatFloorOps([big, small], drillPaths, STOCK, 'b2'))
      .toEqual([{ opId: 'b1', name: 'Bore b1', zMM: -3 }])
  })

  it('unsupported types always start at stock top', () => {
    const op1 = pocket('op1', 'outer', 2)
    const drill = {
      id: 'd', name: 'Drill', type: 'drill', toolId: 't', status: 'done', segments: [], color: '#0ff',
      visible: true, drillMode: 'peck', points: [], depthMM: 3, stepDownMM: 1, startFrom: auto,
    } as AnyOperation
    expect(resolveStartZForOp(drill, [op1, drill], paths, STOCK, tools).zMM).toBe(0)
  })
})

// ─── Cross-call floor memo ────────────────────────────────────────────────────
//
// Floors are memoised at module scope across calls (a generation run resolves the same
// chain dozens of times). The memo is keyed on every setting a floor depends on, so what
// these pin is the INVALIDATION: an edit that moves a floor must be seen, and a write that
// cannot move one — segments, status — must not throw the memo away. Each case resolves
// once to warm the memo before the edit, so a stale hit would show up as the old answer.
describe('resolveStartZ — floor memo invalidation', () => {
  const paths = [path('outer', rect(0, 0, 50, 50)), path('inner', rect(10, 10, 20, 20))]

  it('sees a changed depth on the operation underneath', () => {
    expect(resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 },
      [pocket('op1', 'outer', 2)], paths, STOCK).zMM).toBe(-2)
    expect(resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 },
      [pocket('op1', 'outer', 5)], paths, STOCK).zMM).toBe(-5)
  })

  it('sees a changed path under an unchanged operation', () => {
    const ops = [pocket('op1', 'outer', 2)]
    expect(resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 },
      ops, paths, STOCK).zMM).toBe(-2)
    // Same op, same depth — but its boundary no longer reaches the footprint, so the
    // footprint is back over uncut stock.
    const moved = [paths[0] && path('outer', rect(100, 100, 20, 20)), paths[1]] as ImportedPath[]
    expect(resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 },
      ops, moved, STOCK).zMM).toBe(0)
  })

  it('sees a changed island list', () => {
    const withIsland = [path('outer', rect(0, 0, 50, 50)), path('inner', rect(10, 10, 20, 20)),
      path('isl', rect(5, 5, 40, 40))]
    const ops = [pocket('op1', 'outer', 2)]
    expect(resolveStartZ({ startFrom: auto, footprintD: withIsland[1].d, cutMarginMM: 0 },
      ops, withIsland, STOCK).zMM).toBe(-2)
    // The island swallows the ground the footprint sits on, so nothing is cut there.
    const ops2 = [pocket('op1', 'outer', 2, { islandIds: ['isl'] })]
    expect(resolveStartZ({ startFrom: auto, footprintD: withIsland[1].d, cutMarginMM: 0 },
      ops2, withIsland, STOCK).zMM).toBe(0)
  })

  it('sees a changed stock size (surfacing covers the whole blank)', () => {
    const surface = {
      id: 's', name: 'Surface', type: 'surface', toolId: 't', status: 'done', segments: [],
      color: '#0f0', visible: true, depthMM: 1, stepDownMM: 1, stepoverPercent: 40, passAngleDeg: 0,
    } as AnyOperation
    const foot = rect(100, 100, 20, 20)
    expect(resolveStartZ({ startFrom: auto, footprintD: foot, cutMarginMM: 0 },
      [surface], paths, { widthMM: 200, heightMM: 200 }).zMM).toBe(-1)
    // A blank too small to reach the footprint leaves it over uncut stock.
    expect(resolveStartZ({ startFrom: auto, footprintD: foot, cutMarginMM: 0 },
      [surface], paths, { widthMM: 60, heightMM: 60 }).zMM).toBe(0)
  })

  it('keeps the memo across segment and status writes', () => {
    const before = pocket('op1', 'outer', 2)
    expect(resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 },
      [before], paths, STOCK).zMM).toBe(-2)
    // Same floor-defining settings, different segments/status — the answer must not move.
    const after = pocket('op1', 'outer', 2, {
      status: 'needs-update', segments: [{ x: 1, y: 2, z: -2, rapid: false }],
    })
    expect(resolveStartZ({ startFrom: auto, footprintD: paths[1].d, cutMarginMM: 0 },
      [after], paths, STOCK).zMM).toBe(-2)
  })
})
