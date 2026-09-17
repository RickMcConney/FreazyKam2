import { describe, it, expect } from 'vitest'
import {
  solveConstraints, measureBetween, bodyKeyOf, planConstraints, runPlan,
  constraintsForSelection, constraintsHiddenBySelection, constraintsInFocus,
  bodiesMovingWith, groundedAxes,
  anchorCandidates, allAnchorCandidates, nearestCandidate, constraintChains,
  constraintEnds, solveInnerConstraints,
  type Constraint,
} from './constraints'
import type { ImportedPath } from '../importers/svgImporter'
import { getMultiBBox, rotateAroundD } from '../canvas/selectionUtils'

// A box of side `w`×`h` with its low corner at (x, y).
function box(id: string, x: number, y: number, w = 10, h = 10, extra: Partial<ImportedPath> = {}): ImportedPath {
  return {
    id, name: id, visible: true, color: '#000',
    d: `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`,
    ...extra,
  }
}

const STOCK = { widthMM: 300, heightMM: 200 }

/** Translate one of `box`'s d-strings — what baking a drag does to it. */
function shiftD(d: string, dx: number, dy: number): string {
  let i = 0
  return d.replace(/-?[\d.]+/g, (n) => String(+n + (i++ % 2 === 0 ? dx : dy)))
}
const centre = (id: string) => ({ kind: 'path' as const, id, anchor: 'center' as const })

/** A part-to-part constraint holding whichever halves are given. */
function con(
  id: string, from: string, to: string,
  hold: { distanceMM?: number; angleDeg?: number },
): Constraint {
  return { id, from: centre(from), to: centre(to), ...hold }
}

/** The moves keyed by body, for readable assertions. */
function movesOf(paths: ImportedPath[], cs: Constraint[], anchors: string[] = []) {
  const sol = solveConstraints(paths, cs, STOCK, anchors)
  return { sol, by: new Map(sol.moves.map((m) => [m.bodyKey, m])) }
}

describe('measureBetween', () => {
  it('reports the centre-to-centre distance two parts currently stand at', () => {
    // centres (5,5) and (35,45): 30 across, 40 up.
    const v = measureBetween([box('a', 0, 0), box('b', 30, 40)], centre('a'), centre('b'), STOCK)
    expect(v!.distanceMM).toBeCloseTo(50, 9)
  })

  it('reports the angle CCW from +X, the app’s convention everywhere else', () => {
    const v = measureBetween([box('a', 0, 0), box('b', 0, 40)], centre('a'), centre('b'), STOCK)
    expect(v!.angleDeg).toBeCloseTo(90, 9)
  })

  it('reads a part to the LEFT as 180°, not as a negative distance', () => {
    const v = measureBetween([box('a', 100, 0), box('b', 20, 0)], centre('a'), centre('b'), STOCK)
    expect(v!.distanceMM).toBeCloseTo(80, 9)
    expect(Math.abs(v!.angleDeg)).toBeCloseTo(180, 9)
  })

  it('measures a stock edge perpendicularly, whatever the part’s other coordinate', () => {
    const v = measureBetween(
      [box('a', 25, 150)],
      { kind: 'stock', edge: 'left' }, { kind: 'path', id: 'a', anchor: 'minX' }, STOCK)
    expect(v!.distanceMM).toBeCloseTo(25, 9)
  })

  it('measures a bounding-box edge, not only its centre', () => {
    const v = measureBetween(
      [box('a', 0, 0), box('b', 50, 0)],
      { kind: 'path', id: 'a', anchor: 'maxX' }, { kind: 'path', id: 'b', anchor: 'minX' }, STOCK)
    // a's right edge is at 10, b's left edge at 50: a 40 mm gap.
    expect(v!.distanceMM).toBeCloseTo(40, 9)
  })
})

describe('solveConstraints', () => {
  it('moves the driven part onto the stated distance and leaves the driver alone', () => {
    const { by } = movesOf([box('a', 0, 0), box('b', 30, 0)], [con('c', 'a', 'b', { distanceMM: 100 })])
    expect(by.has('a')).toBe(false)
    expect(by.get('b')).toMatchObject({ dx: 70, dy: 0 })
  })

  it('holds the direction the parts already stand in when only the distance is held', () => {
    // Centres 30 across and 40 up — 50 apart. Doubling to 100 must keep the
    // 3-4-5 direction, not collapse it onto an axis.
    const { by } = movesOf([box('a', 0, 0), box('b', 30, 40)], [con('c', 'a', 'b', { distanceMM: 100 })])
    expect(by.get('b')!.dx).toBeCloseTo(30, 9)
    expect(by.get('b')!.dy).toBeCloseTo(40, 9)
  })

  it('swings a part round to a stated angle at its existing radius', () => {
    // b sits 50 mm to the right of a; asked for 90°, it goes 50 mm above it.
    const { by } = movesOf([box('a', 0, 0), box('b', 50, 0)], [con('c', 'a', 'b', { angleDeg: 90 })])
    expect(by.get('b')!.dx).toBeCloseTo(-50, 9)
    expect(by.get('b')!.dy).toBeCloseTo(50, 9)
  })

  it('places a part outright when both halves are held', () => {
    const { by } = movesOf([box('a', 0, 0), box('b', 0, 0)],
      [con('c', 'a', 'b', { distanceMM: 100, angleDeg: 0 })])
    expect(by.get('b')!.dx).toBeCloseTo(100, 9)
    expect(by.get('b')!.dy).toBeCloseTo(0, 9)
  })

  it('emits nothing at all when the constraint is already satisfied', () => {
    const sol = solveConstraints([box('a', 0, 0), box('b', 100, 0)],
      [con('c', 'a', 'b', { distanceMM: 100, angleDeg: 0 })], STOCK)
    expect(sol.moves).toEqual([])
    expect(sol.error).toBeNull()
  })

  it('is idempotent: re-solving after applying its own move asks for nothing more', () => {
    const paths = [box('a', 0, 0), box('b', 30, 0)]
    const cs = [con('c', 'a', 'b', { distanceMM: 100 })]
    const mv = solveConstraints(paths, cs, STOCK).moves[0]
    const moved = [paths[0], box('b', 30 + mv.dx, mv.dy)]
    expect(solveConstraints(moved, cs, STOCK).moves).toEqual([])
  })

  it('leaves a part alone when it is off by less than the d-string grid can hold', () => {
    // A d-string keeps 4 decimals, so a 0.0003 mm correction bakes back onto the
    // same grid point and the next solve asks for it again — on every edit.
    const hold = con('k', 'a', 'b', { distanceMM: 50, angleDeg: 0 })
    expect(movesOf([box('a', 0, 0), box('b', 50.0003, 0)], [hold]).sol.moves).toHaveLength(0)
    // …while a real miss, still well under what anyone could cut, is corrected.
    const { by } = movesOf([box('a', 0, 0), box('b', 50.002, 0)], [hold])
    expect(by.get('b')!.dx).toBeCloseTo(-0.002, 6)
  })

  it('positions a part from the stock edge without needing another part', () => {
    const { by } = movesOf([box('a', 5, 60)], [{
      id: 's', distanceMM: 25,
      from: { kind: 'stock', edge: 'left' },
      to: { kind: 'path', id: 'a', anchor: 'minX' },
    }])
    expect(by.get('a')).toMatchObject({ dx: 20, dy: 0 })
  })

  it('lets one part be held off two different stock edges at once', () => {
    // The case a single combined graph would have refused: left and bottom are
    // different axes, and each takes one of the part's two freedoms.
    const { sol, by } = movesOf([box('a', 5, 60)], [
      {
        id: 'l', distanceMM: 25,
        from: { kind: 'stock', edge: 'left' }, to: { kind: 'path', id: 'a', anchor: 'minX' },
      },
      {
        id: 'b', distanceMM: 10,
        from: { kind: 'stock', edge: 'bottom' }, to: { kind: 'path', id: 'a', anchor: 'minY' },
      },
    ])
    expect(sol.error).toBeNull()
    expect(by.get('a')).toMatchObject({ dx: 20, dy: -50 })
  })

  // THE ONE THAT PINS THE WALK ORDER. A single constraint resolves correctly
  // whatever order the bodies are visited in, so only a chain can catch an
  // ordering bug: c is placed relative to b, and b has itself just moved.
  it('resolves a chain against each neighbour’s already-solved position', () => {
    const paths = [box('a', 0, 0), box('b', 10, 0), box('c', 20, 0)]
    const { sol, by } = movesOf(paths, [
      con('bc', 'b', 'c', { distanceMM: 50, angleDeg: 0 }),
      con('ab', 'a', 'b', { distanceMM: 70, angleDeg: 0 }),
    ])
    expect(sol.error).toBeNull()
    // a stays at centre 5; b goes to centre 75 (+60); c to centre 125 (+100).
    // Solved in the wrong order c would aim at b's OLD centre of 15 and land at
    // 65, a dx of 40 — which is what makes this test worth having.
    expect(by.get('b')).toMatchObject({ dx: 60, dy: 0 })
    expect(by.get('c')).toMatchObject({ dx: 100, dy: 0 })
  })

  it('refuses a second constraint between the same pair', () => {
    const sol = solveConstraints([box('a', 0, 0), box('b', 30, 0)], [
      con('c1', 'a', 'b', { distanceMM: 50 }),
      con('c2', 'a', 'b', { distanceMM: 90 }),
    ], STOCK)
    expect(sol.moves).toEqual([])
    expect(sol.error).toMatch(/over-constrained/i)
    expect(sol.badIds.sort()).toEqual(['c1', 'c2'])
  })

  it('refuses a loop, however the constraints in it are written round', () => {
    const sol = solveConstraints([box('a', 0, 0), box('b', 30, 0)], [
      con('ab', 'a', 'b', { distanceMM: 50 }),
      con('ba', 'b', 'a', { distanceMM: 80 }),
    ], STOCK)
    expect(sol.moves).toEqual([])
    expect(sol.error).toMatch(/over-constrained/i)
    expect(sol.badIds.sort()).toEqual(['ab', 'ba'])
  })

  it('refuses a triangle — three links among three parts is one too many', () => {
    const paths = [box('a', 0, 0), box('b', 30, 0), box('c', 60, 0)]
    const sol = solveConstraints(paths, [
      con('ab', 'a', 'b', { distanceMM: 30 }),
      con('bc', 'b', 'c', { distanceMM: 30 }),
      con('ca', 'c', 'a', { distanceMM: 30 }),
    ], STOCK)
    expect(sol.error).toMatch(/over-constrained/i)
  })

  it('ALLOWS one part linked to two others — that is a chain, not a clash', () => {
    // a—c and b—c is a tree: walked from a it places c and then b, walked from b
    // it places c and then a. Only a cycle is over-constrained.
    const paths = [box('a', 0, 0), box('b', 30, 0), box('c', 60, 0)]
    const { sol } = movesOf(paths, [
      con('ac', 'a', 'c', { distanceMM: 50 }),
      con('bc', 'b', 'c', { distanceMM: 90 }),
    ], ['a'])
    expect(sol.error).toBeNull()
  })

  it('ignores a constraint whose part has gone rather than reporting an error', () => {
    const sol = solveConstraints([box('a', 0, 0)],
      [con('c', 'a', 'gone', { distanceMM: 50 })], STOCK)
    expect(sol).toEqual({ moves: [], error: null, badIds: [] })
  })

  it('ignores a constraint holding neither a distance nor an angle', () => {
    const sol = solveConstraints([box('a', 0, 0), box('b', 30, 0)],
      [con('c', 'a', 'b', {})], STOCK)
    expect(sol).toEqual({ moves: [], error: null, badIds: [] })
  })

  it('ignores a constraint whose two ends are the same body', () => {
    const sol = solveConstraints([box('a', 0, 0)], [{
      id: 'c', distanceMM: 50,
      from: { kind: 'path', id: 'a', anchor: 'minX' },
      to: { kind: 'path', id: 'a', anchor: 'maxX' },
    }], STOCK)
    expect(sol.moves).toEqual([])
    expect(sol.error).toBeNull()
  })
})

describe('bodies', () => {
  it('moves every part of a multi-part shape together', () => {
    const paths = [
      box('teeth', 30, 0, 10, 10, { groupId: 'g1', shapePart: 'teeth' }),
      box('bore', 33, 3, 4, 4, { groupId: 'g1', shapePart: 'bore' }),
      box('a', 0, 0),
    ]
    const { by } = movesOf(paths, [con('c', 'a', 'teeth', { distanceMM: 100, angleDeg: 0 })])
    const mv = by.get('g1')!
    expect(mv.pathIds.sort()).toEqual(['bore', 'teeth'])
    // The anchor is the whole GROUP's bbox — 30..40 across, centre 35 — so the
    // move is to centre 105.
    expect(mv.dx).toBeCloseTo(70, 9)
  })

  it('takes a user group as one body, outermost group first', () => {
    expect(bodyKeyOf(box('a', 0, 0, 10, 10, { userGroups: ['outer', 'inner'] }))).toBe('outer')
  })

  // ─── Grouping the two parts a constraint holds ─────────────────────────────
  //
  // Reported from the app: constrain two shapes, group them, and the dimension
  // on canvas went wrong while the panel still read right. The group became the
  // body, so BOTH ends resolved to the group's own bounding box and landed on
  // the same point — a dot in the middle, reading zero.

  const GROUPED = [
    box('a', 10, 10, 20, 20, { userGroups: ['g1'] }),
    box('b', 60, 10, 20, 20, { userGroups: ['g1'] }),
  ]
  const UNGROUPED = [box('a', 10, 10, 20, 20), box('b', 60, 10, 20, 20)]
  const AB = { id: 'c', from: centre('a'), to: centre('b'), distanceMM: 50, angleDeg: 0 }

  it('draws a constraint between two grouped parts where the parts actually are', () => {
    const ends = constraintEnds(GROUPED, AB, STOCK)!
    expect(ends.p).toEqual({ x: 20, y: 20 })
    expect(ends.q).toEqual({ x: 70, y: 20 })
  })

  it('reads the same figures grouped as ungrouped — grouping measures nothing new', () => {
    expect(constraintEnds(GROUPED, AB, STOCK)).toEqual(constraintEnds(UNGROUPED, AB, STOCK))
    expect(measureBetween(GROUPED, centre('a'), centre('b'), STOCK))
      .toEqual(measureBetween(UNGROUPED, centre('a'), centre('b'), STOCK))
  })

  it('still reads a MULTI-PART shape as one object when the constraint is inside one body', () => {
    // The narrowing goes to the OBJECT, not to the bare path: a gear is seven
    // paths, and its anchor is the whole gear's box however it has been grouped.
    // Teeth 30..40 and hub 40..50 make one shape spanning 30..50, centre 40 —
    // deliberately NOT the teeth path's own centre of 35, which is what a
    // narrowing that stopped at the bare path would report.
    const paths = [
      box('a', 0, 0, 10, 10, { userGroups: ['g1'] }),
      box('teeth', 30, 0, 10, 10, { groupId: 'gear', userGroups: ['g1'] }),
      box('hub', 40, 0, 10, 10, { groupId: 'gear', userGroups: ['g1'] }),
    ]
    const ends = constraintEnds(paths, {
      id: 'c', from: centre('a'), to: centre('teeth'), distanceMM: 30, angleDeg: 0,
    }, STOCK)!
    expect(ends.q).toEqual({ x: 40, y: 5 })
  })

  it('leaves a constraint reaching OUT of a group reading the whole group', () => {
    // Nothing narrows here — only the inside-one-body case does — so a group
    // held off a loose part still measures from the group's own box, 10..80.
    const paths = [box('z', 200, 10, 10, 10), ...GROUPED]
    const ends = constraintEnds(paths, {
      id: 'c', from: centre('z'), to: centre('a'), distanceMM: 10,
    }, STOCK)!
    expect(ends.q).toEqual({ x: 45, y: 20 })
  })

  it('does not move anything in the BODY solve: a body is rigid', () => {
    expect(solveConstraints(GROUPED, [AB], STOCK).moves).toEqual([])
    expect(solveConstraints(GROUPED, [AB], STOCK).error).toBeNull()
  })

  // ─── A constraint beats the group it is inside ─────────────────────────────
  //
  // Reported from the app, straight after the drawing was fixed: the dimension
  // now updated when the number was typed and the shape sat still, because the
  // group had become the body and a body is rigid. Grouping is a way of handling
  // several shapes at once, not a weld. `solveInnerConstraints` gives a body's
  // internal constraints their own solve over the OBJECTS inside it, run by
  // `enforceConstraints` as a second pass over what the first one left.

  const FAR = { ...AB, distanceMM: 80 }

  it('moves the far shape when the number is changed on a constraint inside a group', () => {
    // a's centre is at 20 and b's at 70. Asking for 80 moves b 30 to the right.
    const moves = solveInnerConstraints(GROUPED, [FAR], STOCK, ['a']).moves
    expect(moves).toEqual([{ bodyKey: 'b', pathIds: ['b'], dx: 30, dy: 0 }])
  })

  it('moves it exactly as it would have before the two were grouped', () => {
    expect(solveInnerConstraints(GROUPED, [FAR], STOCK, ['a']).moves)
      .toEqual(solveConstraints(UNGROUPED, [FAR], STOCK, ['a']).moves)
  })

  it('stays idempotent — a satisfied constraint inside a group emits nothing', () => {
    expect(solveInnerConstraints(GROUPED, [AB], STOCK).moves).toEqual([])
  })

  it('leaves a group with no constraints inside it entirely alone', () => {
    const outward: Constraint = {
      id: 'c', from: centre('z'), to: centre('a'), distanceMM: 10, angleDeg: 0,
    }
    expect(solveInnerConstraints([box('z', 200, 10), ...GROUPED], [outward], STOCK).moves).toEqual([])
  })

  it('carries the group\u2019s other members with the group, not with the inner constraint', () => {
    // The two passes divide the work: the body solve puts the whole group where
    // the stock edge says (free member and all), and only then does the inner
    // one slide `b` along inside it. A member no constraint names must not be
    // left behind by the inner pass.
    const paths = [
      box('a', 10, 10, 20, 20, { userGroups: ['g1'] }),
      box('b', 60, 10, 20, 20, { userGroups: ['g1'] }),
      box('free', 150, 10, 20, 20, { userGroups: ['g1'] }),
    ]
    const cs: Constraint[] = [FAR, {
      id: 'edge', from: { kind: 'stock', edge: 'left' },
      to: { kind: 'path', id: 'a', anchor: 'minX' }, distanceMM: 100,
    }]
    const outer = solveConstraints(paths, cs, STOCK).moves
    expect(outer).toEqual([{ bodyKey: 'g1', pathIds: ['a', 'b', 'free'], dx: 90, dy: 0 }])
    const moved = paths.map((p) => ({ ...p, d: shiftD(p.d, 90, 0) }))
    expect(solveInnerConstraints(moved, cs, STOCK).moves)
      .toEqual([{ bodyKey: 'b', pathIds: ['b'], dx: 30, dy: 0 }])
  })

  it('keeps a MULTI-PART shape whole while the group around it comes apart', () => {
    // The inner solve's unit is the OBJECT. A gear grouped with a plate is still
    // one gear: constrain the plate to it and all of the gear's paths move.
    const paths = [
      box('plate', 0, 0, 10, 10, { userGroups: ['g1'] }),
      box('teeth', 30, 0, 10, 10, { groupId: 'gear', userGroups: ['g1'] }),
      box('hub', 40, 0, 10, 10, { groupId: 'gear', userGroups: ['g1'] }),
    ]
    const moves = solveInnerConstraints(paths, [{
      id: 'c', from: centre('plate'), to: centre('teeth'), distanceMM: 50, angleDeg: 0,
    }], STOCK, ['plate']).moves
    // The gear spans 30..50, centre 40; from the plate's centre at 5 that is 35,
    // so reaching 50 moves the WHOLE gear 15 to the right.
    expect(moves).toEqual([{ bodyKey: 'gear', pathIds: ['teeth', 'hub'], dx: 15, dy: 0 }])
  })

  it('drives a whole user group from a constraint on any one of its members', () => {
    const paths = [
      box('a', 0, 0),
      box('p', 30, 0, 10, 10, { userGroups: ['ug'] }),
      box('q', 45, 0, 10, 10, { userGroups: ['ug'] }),
    ]
    const { by } = movesOf(paths, [{
      id: 'c', distanceMM: 100, angleDeg: 0,
      from: centre('a'), to: { kind: 'path', id: 'p', anchor: 'minX' },
    }])
    expect(by.get('ug')!.pathIds.sort()).toEqual(['p', 'q'])
    // The group's bbox runs 30..55; its minX is 30, and it has to reach 105.
    expect(by.get('ug')!.dx).toBeCloseTo(75, 9)
  })
})

// A chain: a — b — c, each link 50 mm along +X.
const CHAIN: Constraint[] = [
  con('ab', 'a', 'b', { distanceMM: 50, angleDeg: 0 }),
  con('bc', 'b', 'c', { distanceMM: 50, angleDeg: 0 }),
]
const CHAIN_PATHS = [box('a', 0, 0), box('b', 50, 0), box('c', 100, 0)]

describe('a chain has no root — it solves from whatever was dragged', () => {
  // THE ONE RICK ASKED FOR. a—b—c, and the user grabs the MIDDLE one. Under a
  // directed model only `a` could be dragged: b and c followed it, and dragging
  // b itself snapped straight back, because the walk always began at the body
  // nothing pointed at. Anchored at b, a and c both follow instead.
  it('carries the parts on BOTH sides when the middle of a chain is dragged', () => {
    // b has already been dragged 25 mm right; a and c have not moved.
    const dragged = [box('a', 0, 0), box('b', 75, 0), box('c', 100, 0)]
    const { sol, by } = movesOf(dragged, CHAIN, ['b'])
    expect(sol.error).toBeNull()
    expect(by.has('b')).toBe(false)          // the anchor stays put
    expect(by.get('a')).toMatchObject({ dx: 25, dy: 0 })
    expect(by.get('c')).toMatchObject({ dx: 25, dy: 0 })
  })

  it('keeps the left-to-right order when the chain is dragged from its far end', () => {
    // Run backwards, an angle constraint has to be read as its reverse — `to`
    // is 0° from `from`, so `from` is 180° from `to`. Reusing the angle
    // unchanged puts a and b on the WRONG SIDE of c, which is exactly what a
    // row of parts must never do.
    const dragged = [box('a', 0, 0), box('b', 50, 0), box('c', 140, 0)]
    const { by } = movesOf(dragged, CHAIN, ['c'])
    expect(by.has('c')).toBe(false)
    expect(by.get('b')).toMatchObject({ dx: 40, dy: 0 })
    expect(by.get('a')).toMatchObject({ dx: 40, dy: 0 })
  })

  it('still walks from the driving end when nothing was dragged', () => {
    // No anchor — a load, or a bare re-solve. It falls back to the body no
    // constraint drives, so an unanchored solve is deterministic.
    const paths = [box('a', 0, 0), box('b', 10, 0), box('c', 20, 0)]
    const { by } = movesOf(paths, CHAIN)
    expect(by.has('a')).toBe(false)
    expect(by.get('b')).toMatchObject({ dx: 40, dy: 0 })
  })

  it('lets the stock overrule a drag — ground is ground', () => {
    const cs: Constraint[] = [{
      id: 's', distanceMM: 20,
      from: { kind: 'stock', edge: 'left' }, to: { kind: 'path', id: 'a', anchor: 'minX' },
    }]
    // Dragged to 60 despite being pinned 20 mm in from the left edge.
    const { by } = movesOf([box('a', 60, 0)], cs, ['a'])
    expect(by.get('a')).toMatchObject({ dx: -40, dy: 0 })
  })

  it('leaves the axis the stock does not hold free to be dragged', () => {
    const cs: Constraint[] = [{
      id: 's', distanceMM: 20,
      from: { kind: 'stock', edge: 'left' }, to: { kind: 'path', id: 'a', anchor: 'minX' },
    }]
    // Dragged straight up: x is pinned and already right, y is nobody's business.
    expect(movesOf([box('a', 20, 90)], cs, ['a']).sol.moves).toEqual([])
  })
})

describe('which constraints a selection is asking about', () => {
  it('shows only the pair’s own constraint when two parts are selected', () => {
    // The bug this exists for: with b and c picked, "everything touching the
    // selection" also listed a→b, so editing the first row moved a and b while
    // the parts actually selected stood still.
    expect(constraintsForSelection(CHAIN_PATHS, CHAIN, ['b', 'c']).map((c) => c.id)).toEqual(['bc'])
  })

  it('shows every constraint holding a part when that part is selected alone', () => {
    expect(constraintsForSelection(CHAIN_PATHS, CHAIN, ['b']).map((c) => c.id).sort())
      .toEqual(['ab', 'bc'])
  })

  it('counts the constraints a two-part selection is leaving out', () => {
    expect(constraintsHiddenBySelection(CHAIN_PATHS, CHAIN, ['b', 'c'])).toBe(1)
    expect(constraintsHiddenBySelection(CHAIN_PATHS, CHAIN, ['b'])).toBe(0)
  })

  it('keeps a stock constraint with the one part it holds', () => {
    const paths = [box('a', 0, 0), box('b', 50, 0)]
    const cs: Constraint[] = [{
      id: 's', distanceMM: 20,
      from: { kind: 'stock', edge: 'left' }, to: { kind: 'path', id: 'a', anchor: 'minX' },
    }]
    expect(constraintsForSelection(paths, cs, ['a']).map((c) => c.id)).toEqual(['s'])
    // The stock end is ground, so "both ends selected" only asks about the part.
    expect(constraintsForSelection(paths, cs, ['a', 'b']).map((c) => c.id)).toEqual(['s'])
  })

  it('groups a multi-part shape’s parts into one body, so any part shows the shape’s constraints', () => {
    const paths = [
      box('a', 0, 0),
      box('teeth', 50, 0, 10, 10, { groupId: 'g', shapePart: 'teeth' }),
      box('bore', 53, 3, 4, 4, { groupId: 'g', shapePart: 'bore' }),
    ]
    const cs = [con('g1', 'a', 'teeth', { distanceMM: 50 })]
    // Picked by its BORE, which the constraint never names.
    expect(constraintsForSelection(paths, cs, ['a', 'bore']).map((c) => c.id)).toEqual(['g1'])
  })
})

describe('what a drag is about to move', () => {
  it('reaches through the whole chain in both directions', () => {
    expect([...bodiesMovingWith(CHAIN_PATHS, CHAIN, 'b')].sort()).toEqual(['a', 'c'])
    expect([...bodiesMovingWith(CHAIN_PATHS, CHAIN, 'a')].sort()).toEqual(['b', 'c'])
  })

  it('is empty for a part nothing is tied to', () => {
    expect(bodiesMovingWith([box('z', 0, 0)], CHAIN, 'z').size).toBe(0)
  })

  it('names the axes the stock is holding, which no drag can argue with', () => {
    const cs: Constraint[] = [{
      id: 's', distanceMM: 20,
      from: { kind: 'stock', edge: 'bottom' }, to: { kind: 'path', id: 'a', anchor: 'minY' },
    }]
    expect([...groundedAxes([box('a', 0, 0)], cs, 'a')]).toEqual(['y'])
    expect(groundedAxes(CHAIN_PATHS, CHAIN, 'b').size).toBe(0)
  })
})

describe('the live drag preview and the solve that lands agree', () => {
  // THE ONE THAT KEEPS THE PREVIEW HONEST. A drag previews `runPlan` against the
  // OLD geometry with the drag as an offset; mouse-up bakes the drag into `d`
  // and then runs the SAME plan with no offset. Those two have to come to the
  // same place, or every drag of a constrained part ends in a jump. They share
  // an implementation, and this is what says so.
  function previewVsCommit(paths: ImportedPath[], cs: Constraint[], grabbed: string[], dx: number, dy: number) {
    // What the canvas draws mid-drag: the plan built before the drag, run with
    // the drag delta as the anchors' offset.
    const { plan } = planConstraints(paths, cs, STOCK, grabbed)
    const preview = new Map(runPlan(plan!, { dx, dy }).map((m) => [m.bodyKey, m]))

    // What lands: the dragged paths rewritten, then a plain solve over them.
    const moved = paths.map((p) => grabbed.includes(p.id)
      ? { ...p, d: shiftD(p.d, dx, dy) }
      : p)
    const commit = new Map(solveConstraints(moved, cs, STOCK, grabbed).moves.map((m) => [m.bodyKey, m]))

    return { preview, commit }
  }

  it('lands a follower exactly where the preview drew it', () => {
    const paths = [box('a', 0, 0), box('b', 50, 0)]
    const cs = [con('c', 'a', 'b', { distanceMM: 50, angleDeg: 0 })]
    const { preview, commit } = previewVsCommit(paths, cs, ['a'], 30, 12)
    // b follows a: it must end 50 mm to a's right, wherever a was dragged to.
    expect(preview.get('b')!.dx).toBeCloseTo(commit.get('b')!.dx, 9)
    expect(preview.get('b')!.dy).toBeCloseTo(commit.get('b')!.dy, 9)
    expect(preview.get('b')!.dx).toBeCloseTo(30, 9)
    expect(preview.get('b')!.dy).toBeCloseTo(12, 9)
  })

  it('agrees along a chain grabbed by its middle', () => {
    const { preview, commit } = previewVsCommit(CHAIN_PATHS, CHAIN, ['b'], 25, 0)
    for (const key of ['a', 'c']) {
      expect(preview.get(key)!.dx).toBeCloseTo(commit.get(key)!.dx, 9)
      expect(preview.get(key)!.dy).toBeCloseTo(commit.get(key)!.dy, 9)
    }
  })

  it('previews the stock overruling the drag, so a pinned part does not jump', () => {
    // Dragged 40 right and 15 up while pinned 20 mm in from the left edge: the
    // preview has to show x snapping back and y following, or the part sits
    // under the cursor and then leaps when the mouse comes up.
    const paths = [box('a', 20, 0)]
    const cs: Constraint[] = [{
      id: 's', distanceMM: 20,
      from: { kind: 'stock', edge: 'left' }, to: { kind: 'path', id: 'a', anchor: 'minX' },
    }]
    const { plan } = planConstraints(paths, cs, STOCK, ['a'])
    const preview = runPlan(plan!, { dx: 40, dy: 15 })
    const mv = preview.find((m) => m.bodyKey === 'a')!
    expect(mv.dx).toBeCloseTo(0, 9)     // net: dragged 40, corrected -40
    expect(mv.dy).toBeCloseTo(15, 9)    // free in Y

    const moved = [{ ...paths[0], d: shiftD(paths[0].d, 40, 15) }]
    expect(solveConstraints(moved, cs, STOCK, ['a']).moves[0].dx).toBeCloseTo(-40, 9)
  })

  it('previews nothing at all when the drag disturbs no constraint', () => {
    const paths = [box('a', 0, 0), box('b', 50, 0), box('z', 200, 0)]
    const cs = [con('c', 'a', 'b', { distanceMM: 50, angleDeg: 0 })]
    // `z` is in nobody's constraint, so its plan has no anchor to seed.
    const { plan } = planConstraints(paths, cs, STOCK, ['z'])
    expect(runPlan(plan!, { dx: 30, dy: 30 })).toEqual([])
  })
})

describe('X/Y offsets, for a hole in the corner of a plate', () => {
  // Rick's case, and the reason the mode exists: a hole is dimensioned "15 in
  // from that edge and 20 down from this one", two numbers read straight off a
  // drawing. As a distance and an angle that is arithmetic nobody should do.
  const plate = () => box('plate', 0, 0, 200, 100)
  const hole = (x: number, y: number) => box('hole', x, y, 6, 6)
  const cornerCon = (x: number | undefined, y: number | undefined): Constraint => ({
    id: 'k', mode: 'xy',
    from: { kind: 'path', id: 'plate', anchor: 'minXmaxY' },   // top-left
    to: { kind: 'path', id: 'hole', anchor: 'center' },
    ...(x === undefined ? {} : { offsetXMM: x }),
    ...(y === undefined ? {} : { offsetYMM: y }),
  })

  it('places a hole by two independent offsets from a corner', () => {
    // The plate's top-left corner is (0, 100). Asked for 15 right and 20 down,
    // the hole's centre must land at (15, 80).
    const { sol, by } = movesOf([plate(), hole(0, 0)], [cornerCon(15, -20)])
    expect(sol.error).toBeNull()
    // The hole starts with its centre at (3, 3).
    expect(by.get('hole')!.dx).toBeCloseTo(12, 9)
    expect(by.get('hole')!.dy).toBeCloseTo(77, 9)
  })

  it('reaches a corner that no edge anchor could stand in for', () => {
    // `minX` is the MIDPOINT of the left edge — (0, 50) on this plate — so
    // without corner anchors the same constraint would land 50 mm out in Y.
    const v = measureBetween(
      [plate()],
      { kind: 'path', id: 'plate', anchor: 'minXmaxY' },
      { kind: 'path', id: 'plate', anchor: 'minX' }, STOCK)
    expect(v!.offsetXMM).toBeCloseTo(0, 9)
    expect(v!.offsetYMM).toBeCloseTo(-50, 9)
  })

  it('holds X and leaves Y alone when only the X offset is set', () => {
    const { by } = movesOf([plate(), hole(50, 30)], [cornerCon(15, undefined)])
    expect(by.get('hole')!.dx).toBeCloseTo(15 - 53, 9)
    expect(by.get('hole')!.dy).toBeCloseTo(0, 9)
  })

  it('is created from what is already there, so it moves nothing', () => {
    const paths = [plate(), hole(12, 77)]
    const now = measureBetween(paths,
      { kind: 'path', id: 'plate', anchor: 'minXmaxY' },
      { kind: 'path', id: 'hole', anchor: 'center' }, STOCK)!
    const made: Constraint = {
      id: 'k', mode: 'xy',
      from: { kind: 'path', id: 'plate', anchor: 'minXmaxY' },
      to: { kind: 'path', id: 'hole', anchor: 'center' },
      offsetXMM: now.offsetXMM, offsetYMM: now.offsetYMM,
    }
    expect(solveConstraints(paths, [made], STOCK).moves).toEqual([])
  })

  it('reverses its offsets when the walk arrives from the far end', () => {
    // Drag the HOLE, and the plate follows — which means the constraint is read
    // backwards, and both offsets change sign. Without that the plate lands on
    // the wrong side of the hole, the same failure the angle had.
    const paths = [plate(), hole(12, 77)]
    const dragged = paths.map((p) => p.id === 'hole' ? { ...p, d: shiftD(p.d, 30, 10) } : p)
    const { by } = movesOf(dragged, [cornerCon(15, -20)], ['hole'])
    expect(by.has('hole')).toBe(false)
    expect(by.get('plate')!.dx).toBeCloseTo(30, 9)
    expect(by.get('plate')!.dy).toBeCloseTo(10, 9)
  })

  it('states the same gap either way, so switching mode moves nothing', () => {
    const paths = [box('a', 0, 0), box('b', 40, 30)]
    const now = measureBetween(paths, centre('a'), centre('b'), STOCK)!
    const polar: Constraint = { id: 'p', from: centre('a'), to: centre('b'), distanceMM: now.distanceMM, angleDeg: now.angleDeg }
    const cart: Constraint = { id: 'p', mode: 'xy', from: centre('a'), to: centre('b'), offsetXMM: now.offsetXMM, offsetYMM: now.offsetYMM }
    expect(solveConstraints(paths, [polar], STOCK).moves).toEqual([])
    expect(solveConstraints(paths, [cart], STOCK).moves).toEqual([])
  })
})

describe('picking a constraint point on canvas', () => {
  const plate = () => box('plate', 0, 0, 200, 100)

  it('offers every bbox anchor, so a corner can be clicked directly', () => {
    const got = anchorCandidates([plate()], 'plate')
    expect(got.filter((c) => c.kind === 'corner')).toHaveLength(4)
    expect(got.filter((c) => c.kind === 'edge')).toHaveLength(4)
    expect(got.filter((c) => c.kind === 'center')).toHaveLength(1)
  })

  it('puts each marker exactly where the constraint will measure from', () => {
    // The marker and the dimension must agree, or the line jumps away from the
    // point that was clicked.
    const paths = [plate()]
    const got = anchorCandidates(paths, 'plate')
    for (const cand of got) {
      const v = measureBetween(paths, cand.ref, cand.ref, STOCK)!
      expect(v.distanceMM).toBeCloseTo(0, 9)
    }
    const topLeft = got.find((c) => c.ref.kind === 'path' && c.ref.anchor === 'minXmaxY')!
    expect([topLeft.x, topLeft.y]).toEqual([0, 100])
  })

  it('offers a round part’s centre as its own candidate', () => {
    // A circle drawn as a square bbox is not round; a real circle is. Use the
    // generator's own output rather than a box.
    const d = 'M 50 30 A 20 20 0 1 0 10 30 A 20 20 0 1 0 50 30 Z'
    const circle: ImportedPath = { id: 'c', name: 'c', visible: true, color: '#000', d }
    // A lone circle's bbox centre IS its centre, so one marker covers it — see
    // addCircleOf. What matters is that the point is offered at all.
    const got = anchorCandidates([circle], 'c')
    const centre = nearestCandidate(got, 30, 30, 0.5)
    expect(centre).not.toBeNull()
  })

  it('reaches a big circle’s centre, which is nowhere near its outline', () => {
    // THE BUG THIS EXISTS FOR. Finding the path under the cursor first and then
    // offering its anchors only works near an OUTLINE — on a 100 mm circle the
    // centre is 50 mm from any of it, so it could not be picked at all. The
    // index is over POINTS, so the centre is found on its own terms.
    const d = 'M 150 100 A 50 50 0 1 0 50 100 A 50 50 0 1 0 150 100 Z'
    const big: ImportedPath = { id: 'big', name: 'big', visible: true, color: '#000', d }
    const all = allAnchorCandidates([big])
    const hit = nearestCandidate(all, 100, 100, 1)
    expect(hit).not.toBeNull()
    expect(hit!.x).toBeCloseTo(100, 1)
    expect(hit!.y).toBeCloseTo(100, 1)
  })

  it('indexes every part, and tags each point with the body it belongs to', () => {
    const all = allAnchorCandidates([plate(), box('other', 400, 400)])
    expect(new Set(all.map((c) => c.body))).toEqual(new Set(['plate', 'other']))
    expect(all.filter((c) => c.body === 'plate')).toHaveLength(9)
  })

  it('puts no second marker on a square’s centre', () => {
    // extractCircles judges roundness by bbox aspect, so a square reads as a
    // circle — and its "centre" landed exactly on the centre anchor, winning the
    // nearest-point search with a marker that meant nothing.
    const all = allAnchorCandidates([box('sq', 0, 0, 40, 40)])
    expect(all).toHaveLength(9)
    expect(all.some((c) => c.kind === 'circle')).toBe(false)
  })

  it('counts a multi-part shape’s bbox anchors once, and keeps each part’s circle', () => {
    // The bore sits off the body's own centre, which is what makes it a point
    // worth offering — see addCircleOf for the coincident case.
    const bore = 'M 90 70 A 10 10 0 1 0 70 70 A 10 10 0 1 0 90 70 Z'
    const paths: ImportedPath[] = [
      box('teeth', 0, 0, 100, 100, { groupId: 'g', shapePart: 'teeth' }),
      { id: 'bore', name: 'bore', visible: true, color: '#000', d: bore, groupId: 'g', shapePart: 'bore' },
    ]
    const all = allAnchorCandidates(paths)
    // One set of nine for the body — not nine per part — plus the bore's centre.
    expect(all.filter((c) => c.kind !== 'circle')).toHaveLength(9)
    expect(all.filter((c) => c.kind === 'circle')).toHaveLength(1)
    expect(all.every((c) => c.body === 'g')).toBe(true)
  })

  it('takes the nearest candidate within tolerance, and none outside it', () => {
    const got = anchorCandidates([plate()], 'plate')
    expect(nearestCandidate(got, 2, 2, 5)!.ref).toMatchObject({ anchor: 'minXminY' })
    expect(nearestCandidate(got, 60, 60, 5)).toBeNull()
  })
})

describe('one chip per chain', () => {
  it('gathers a whole chain into one group', () => {
    const chains = constraintChains(CHAIN_PATHS, CHAIN)
    expect(chains).toHaveLength(1)
    expect(chains[0].constraints.map((c) => c.id).sort()).toEqual(['ab', 'bc'])
    expect(chains[0].bodies.sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps unconnected constraints apart', () => {
    const paths = [box('a', 0, 0), box('b', 50, 0), box('c', 0, 50), box('d', 50, 50)]
    const chains = constraintChains(paths, [
      con('ab', 'a', 'b', { distanceMM: 50 }),
      con('cd', 'c', 'd', { distanceMM: 50 }),
    ])
    expect(chains).toHaveLength(2)
  })

  it('keeps a chain’s key when the chain grows, whatever it grows to include', () => {
    // Built BACKWARDS on purpose: c→b first, then b→a. Keying by the smallest
    // body would name the chain 'c' at first and 'a' once it grew — a chip that
    // renames itself is a new object as far as the strip is concerned, and the
    // whole premise there is that an edit CHANGES a chip rather than adding one.
    const first = [con('cb', 'c', 'b', { distanceMM: 50 })]
    const grown = [...first, con('ba', 'b', 'a', { distanceMM: 50 })]
    expect(constraintChains(CHAIN_PATHS, grown)[0].key)
      .toBe(constraintChains(CHAIN_PATHS, first)[0].key)
  })

  it('merges two chains into one chip, keeping the older key', () => {
    const paths = [box('a', 0, 0), box('b', 50, 0), box('c', 100, 0)]
    const ab = con('ab', 'a', 'b', { distanceMM: 50 })
    const cd = con('cd', 'c', 'a', { distanceMM: 50 })
    const before = constraintChains(paths, [ab])[0].key
    const joined = constraintChains(paths, [ab, cd])
    expect(joined).toHaveLength(1)
    expect(joined[0].key).toBe(before)
  })

  it('does not tie two parts together just because both are held off the stock', () => {
    const paths = [box('a', 0, 0), box('b', 90, 0)]
    const chains = constraintChains(paths, [
      { id: 'sa', distanceMM: 20, from: { kind: 'stock', edge: 'left' }, to: { kind: 'path', id: 'a', anchor: 'minX' } },
      { id: 'sb', distanceMM: 90, from: { kind: 'stock', edge: 'left' }, to: { kind: 'path', id: 'b', anchor: 'minX' } },
    ])
    expect(chains).toHaveLength(2)
  })
})

// ─── Turned parts ─────────────────────────────────────────────────────────────
//
// The case these exist for: four holes constrained to the corners of a mounting
// plate. They followed a SCALE correctly and flew apart under a ROTATE, because
// an axis-aligned box round a tilted rectangle grows by √2 and its corners stand
// out in empty space where the geometry is not.

// A d-string holds 4 decimal places (`fmt` in svgImporter), so a coordinate that
// has been through one rotation is good to about 1e-4 mm and no better. That is
// the real tolerance of the geometry, not a slack figure: these compare to 1e-3.
const MM = 3

/** Rotate a point `deg` CCW about a pivot — the test's own arithmetic, so an
 *  expectation is never the implementation restated. */
function rot(p: { x: number; y: number }, pivot: { x: number; y: number }, deg: number) {
  const r = deg * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r)
  const dx = p.x - pivot.x, dy = p.y - pivot.y
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos }
}

/** The same part, standing turned — geometry AND the placement that records it,
 *  which is exactly what baking a rotate gesture leaves behind. */
function turned(p: ImportedPath, deg: number, cx: number, cy: number): ImportedPath {
  return {
    ...p,
    d: rotateAroundD(p.d, cx, cy, deg),
    placement: [{ kind: 'rotate', angle: deg, cx, cy }],
  }
}

/** Where a body's centre now sits, for reading a solve's answer back. */
function centreAfter(paths: ImportedPath[], id: string, mv?: { dx: number; dy: number }) {
  const bb = getMultiBBox(paths.filter((p) => p.id === id).map((p) => p.d))!
  return { x: bb.cx + (mv?.dx ?? 0), y: bb.cy + (mv?.dy ?? 0) }
}

const PLATE = box('p', 0, 0, 100, 60)
const PLATE_CORNER = { x: 100, y: 60 }
const PLATE_MID = { x: 50, y: 30 }
/** A hole 10 in from the top-right corner, both ways. */
const HOLE = box('h', 85, 45)
const CORNER_REF = { kind: 'path' as const, id: 'p', anchor: 'maxXmaxY' as const }
const INSET: Constraint = {
  id: 'k', mode: 'xy', from: CORNER_REF, to: centre('h'), offsetXMM: -10, offsetYMM: -10,
}

describe('an anchor on a turned part', () => {
  it('is the part’s own corner, not a corner of the box the world draws round it', () => {
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    const want = rot(PLATE_CORNER, PLATE_MID, 30)
    const got = anchorCandidates([plate], 'p').find((a) =>
      a.ref.kind === 'path' && a.ref.anchor === 'maxXmaxY')!
    expect(got.x).toBeCloseTo(want.x, MM)
    expect(got.y).toBeCloseTo(want.y, MM)
    // And it is NOT where the axis-aligned box puts it, which is the whole
    // point: that corner is 15 mm out in open air at this angle.
    const boxed = getMultiBBox([plate.d])!
    expect(Math.hypot(boxed.maxX - want.x, boxed.maxY - want.y)).toBeGreaterThan(5)
  })

  it('measures the offset along the part’s own axes, so a created constraint holds what it reads', () => {
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    // The hole carried round with the plate by hand: its inset is unchanged as
    // the plate sees it, so that is what a fresh measurement has to report.
    const hole = { ...HOLE, d: rotateAroundD(HOLE.d, PLATE_MID.x, PLATE_MID.y, 30) }
    const v = measureBetween([plate, hole], CORNER_REF, centre('h'), STOCK)!
    expect(v.offsetXMM).toBeCloseTo(-10, MM)
    expect(v.offsetYMM).toBeCloseTo(-10, MM)
    expect(v.frameDeg).toBeCloseTo(30, 6)
  })
})

describe('rotating the part a chain hangs off', () => {
  it('leaves everything alone while nothing has turned', () => {
    const { sol } = movesOf([PLATE, HOLE], [INSET], ['p'])
    expect(sol.moves).toHaveLength(0)
  })

  it('carries the hole round to the turned corner, still 10 in along each edge', () => {
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    const { by } = movesOf([plate, HOLE], [INSET], ['p'])
    const corner = rot(PLATE_CORNER, PLATE_MID, 30)
    const inset = rot({ x: -10, y: -10 }, { x: 0, y: 0 }, 30)
    const got = centreAfter([plate, HOLE], 'h', by.get('h'))
    expect(got.x).toBeCloseTo(corner.x + inset.x, MM)
    expect(got.y).toBeCloseTo(corner.y + inset.y, MM)
  })

  it('would put the hole somewhere else entirely if the offset stayed world-axis', () => {
    // Pins the frame rotation itself: with the offset read in world axes the
    // hole lands 10 left and 10 below the corner instead of along the edges,
    // which is 7 mm away at 30° and looks plausible on screen.
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    const { by } = movesOf([plate, HOLE], [INSET], ['p'])
    const corner = rot(PLATE_CORNER, PLATE_MID, 30)
    const got = centreAfter([plate, HOLE], 'h', by.get('h'))
    expect(Math.hypot(got.x - (corner.x - 10), got.y - (corner.y - 10))).toBeGreaterThan(5)
  })

  it('turns the hole with the plate when the angle between them is held', () => {
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    const { by } = movesOf([plate, HOLE], [{ ...INSET, alignDeg: 0 }], ['p'])
    const mv = by.get('h')!
    expect(mv.rotDeg).toBeCloseTo(30, 6)
    // About the point the constraint measures TO, so the turn cannot disturb
    // the slide that put it there.
    expect(mv.pivot!.x).toBeCloseTo(90, MM)
    expect(mv.pivot!.y).toBeCloseTo(50, MM)
  })

  it('holds whatever angle the parts were created at, not zero', () => {
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    const hole = turned(HOLE, 15, 90, 50)
    const { by } = movesOf([plate, hole], [{ ...INSET, alignDeg: 45 }], ['p'])
    // The hole stands at 15° and has to reach 30 + 45 = 75°.
    expect(by.get('h')!.rotDeg).toBeCloseTo(60, 6)
  })

  it('asks for no turn once the parts already stand at the held angle', () => {
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    const hole = turned(HOLE, 30, 90, 50)
    const { by } = movesOf([plate, hole], [{ ...INSET, alignDeg: 0 }], ['p'])
    expect(by.get('h')?.rotDeg).toBeUndefined()
  })

  it('never turns a body whose own parts disagree about which way it faces', () => {
    // Its angle is a fallback, not a fact (see bodyFrame) — turning it by a
    // made-up figure would turn it again by the same figure on the next edit,
    // and a solve that does not converge spins the part off the stock.
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    const twoWays = [
      { ...turned(box('h1', 85, 45), 10, 90, 50), groupId: 'g' },
      { ...turned(box('h2', 85, 45), 70, 90, 50), groupId: 'g' },
    ]
    const c: Constraint = {
      ...INSET, to: { kind: 'path', id: 'h1', anchor: 'center' }, alignDeg: 0,
    }
    const { by } = movesOf([plate, ...twoWays], [c], ['p'])
    expect(by.get('g')!.rotDeg).toBeUndefined()
  })

  // A circle looks the same at every angle, so the angle its recipe reads is an
  // accident of how it was copied — and must not stop a group of holes turning.
  const roundHole = (id: string, recipeDeg: number): ImportedPath => ({
    ...turned({
      id, name: id, visible: true, color: '#000',
      d: 'M 92 50 A 2 2 0 0 1 88 50 A 2 2 0 0 1 92 50 Z',
      shapeParams: { type: 'circle', cx: 90, cy: 50, radius: 2 },
    }, recipeDeg, 90, 50),
    userGroups: ['holes'],
  })
  const TO_HOLES: Constraint = { ...INSET, to: { kind: 'circle', id: 'r1' }, alignDeg: 0 }

  it('turns a group of round holes whose recipes read different angles', () => {
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    const holes = [roundHole('r1', 10), roundHole('r2', 70)]
    const { by } = movesOf([plate, ...holes], [TO_HOLES], ['p'])
    // Its first part reads 10°, so it has 20° to go to stand at the plate's 30°.
    expect(by.get('holes')!.rotDeg).toBeCloseTo(20, 6)
  })

  it('asks the round holes for no further turn once every recipe carries the plate’s', () => {
    const plate = turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y)
    const holes = [roundHole('r1', 30), roundHole('r2', 90)]
    const { by } = movesOf([plate, ...holes], [TO_HOLES], ['p'])
    expect(by.get('holes')?.rotDeg).toBeUndefined()
  })
})

// ─── Mirrored parts ───────────────────────────────────────────────────────────
//
// The case these exist for: a frame and its holes copied and mirrored as a set.
// A frame that knew only the angle read every Y offset and every held angle of
// the mirrored copy with the wrong sign, so the next edit ANYWHERE in the
// document moved the copy's holes into mirror image — out of the part.

/** The same part, mirrored left-for-right about x = `cx` — geometry AND the
 *  placement step that records it, as the Flip button leaves them. */
function mirrored(p: ImportedPath, cx: number): ImportedPath {
  let i = 0
  return {
    ...p,
    d: p.d.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, (n) => String(i++ % 2 === 0 ? 2 * cx - +n : +n)),
    placement: [...(p.placement ?? []), { kind: 'mirror', axis: 'x', cx, cy: 0 }],
  }
}

describe('a mirrored part', () => {
  it('keeps every number when a turned plate and its hole are mirrored together', () => {
    const plate = mirrored(turned(PLATE, 30, PLATE_MID.x, PLATE_MID.y), 200)
    const hole = mirrored(turned(HOLE, 30, PLATE_MID.x, PLATE_MID.y), 200)
    const v = measureBetween([plate, hole], CORNER_REF, centre('h'), STOCK)!
    expect(v.offsetXMM).toBeCloseTo(-10, MM)
    expect(v.offsetYMM).toBeCloseTo(-10, MM)
    expect(v.alignDeg).toBeCloseTo(0, 6)
    // Nothing left to do but the 4-decimal rounding of the d-strings (see MM):
    // no turn, and no slide worth the name. Read with the mirror ignored, the
    // hole slid 20 mm across the plate and turned.
    const { by } = movesOf([plate, hole], [{ ...INSET, alignDeg: 0 }], ['p'])
    const mv = by.get('h')
    expect(mv?.rotDeg).toBeUndefined()
    expect(Math.hypot(mv?.dx ?? 0, mv?.dy ?? 0)).toBeLessThan(1e-3)
  })

  it('carries the hole to the mirrored corner when the plate alone is mirrored', () => {
    const plate = mirrored(PLATE, 200)
    const { by } = movesOf([plate, HOLE], [INSET], ['p'])
    // The hole sat 10 in from the top-right corner at (90, 50); mirrored about
    // x = 200 that corner is the one at x = 300, and the hole goes with it.
    const got = centreAfter([plate, HOLE], 'h', by.get('h'))
    expect(got.x).toBeCloseTo(310, MM)
    expect(got.y).toBeCloseTo(50, MM)
  })

  it('reads the angle held between two mirrored parts the way round it was made', () => {
    const hole = turned(HOLE, 15, 90, 50)
    expect(measureBetween([PLATE, hole], CORNER_REF, centre('h'), STOCK)!.alignDeg).toBeCloseTo(15, 6)
    const both = [mirrored(PLATE, 200), mirrored(hole, 200)]
    expect(measureBetween(both, CORNER_REF, centre('h'), STOCK)!.alignDeg).toBeCloseTo(15, 6)
    const { by } = movesOf(both, [{ ...INSET, alignDeg: 15 }], ['p'])
    const mv = by.get('h')
    expect(mv?.rotDeg).toBeUndefined()
    expect(Math.hypot(mv?.dx ?? 0, mv?.dy ?? 0)).toBeLessThan(1e-3)
  })
})

describe('what the panel lists and the canvas draws', () => {
  // One function, because two would eventually answer differently and the user
  // would have no way to tell which of the two was lying.
  const PLATE_AND_HOLES = [
    box('plate', 0, 0, 100, 60), box('h1', 5, 5), box('h2', 85, 5),
    box('h3', 5, 45), box('h4', 85, 45),
  ]
  const FOUR = ['h1', 'h2', 'h3', 'h4'].map((h, i): Constraint => ({
    id: `k${i}`, mode: 'xy', from: centre('plate'), to: centre(h), offsetXMM: 0, offsetYMM: 0,
  }))

  it('shows one corner’s one constraint when that corner is the selection', () => {
    const shown = constraintsInFocus(PLATE_AND_HOLES, FOUR, { selectedIds: ['h2'] })
    expect(shown.map((c) => c.id)).toEqual(['k1'])
  })

  it('shows all four when the plate they hang off is the selection', () => {
    const shown = constraintsInFocus(PLATE_AND_HOLES, FOUR, { selectedIds: ['plate'] })
    expect(shown).toHaveLength(4)
  })

  it('falls back to what was selected when the tool was entered', () => {
    // The tool clears the selection, so this is the only record of the part the
    // user was working on.
    const shown = constraintsInFocus(PLATE_AND_HOLES, FOUR, { selectedIds: [], subjectIds: ['h4'] })
    expect(shown.map((c) => c.id)).toEqual(['k3'])
  })

  it('prefers the constraint just made over the subject, and shows its whole chain', () => {
    const shown = constraintsInFocus(PLATE_AND_HOLES, FOUR,
      { selectedIds: [], subjectIds: ['h4'], focusConstraintId: 'k0' })
    expect(shown).toHaveLength(4)
  })

  it('shows nothing at all rather than every constraint in the document', () => {
    expect(constraintsInFocus(PLATE_AND_HOLES, FOUR, { selectedIds: [] })).toEqual([])
  })
})
