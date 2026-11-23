import { describe, it, expect } from 'vitest'
import type { ImportedPath } from '../importers/svgImporter'
import { generateShapeD } from '../shapes/shapeGenerators'
import { computePatternInstances, patternCopies, type PatternParams } from '../tools/patternOp'
import { getMultiBBox } from '../canvas/selectionUtils'
import { patternBodyKeys, patternCentreOf, patternOriginalsInSelection, weldingPatternIds } from './patternBodies'
import {
  allAnchorCandidates, bodyKeyOf, pickedConstraint, solveConstraints, solveInnerConstraints, widenToPatternBodies,
  type Constraint,
} from './constraints'

const STOCK = { widthMM: 300, heightMM: 200 }

function circle(id: string, cx: number, cy: number, radius = 3): ImportedPath {
  const shapeParams = { type: 'circle' as const, cx, cy, radius }
  return { id, name: id, visible: true, color: '#000', d: generateShapeD(shapeParams), shapeParams }
}
function plate(id: string, x: number, y: number, w: number, h: number): ImportedPath {
  return { id, name: id, visible: true, color: '#000', d: `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z` }
}

/**
 * A pattern made the way the Pattern form makes one: the source stays, and the
 * copies come out of `patternCopies` carrying the definition. A circular pattern's
 * centre is `radiusMM` to the LEFT of the source, so a bolt circle centred on
 * (cx, cy) starts from a hole at (cx + r, cy).
 */
function pattern(sources: ImportedPath[], params: PatternParams, defId = 'def1'): ImportedPath[] {
  const bbox = getMultiBBox(sources.map((s) => s.d))
  const copies = patternCopies(sources, computePatternInstances(params, bbox).slice(1))
  const definition = { id: defId, kind: 'pattern' as const, sourceIds: sources.map((s) => s.id), params }
  return copies.map((c, i) => ({ ...c, id: `${defId}-c${i + 1}`, definition }) as ImportedPath)
}
const ring = (count: number, r: number, extra: Partial<Extract<PatternParams, { type: 'circular' }>> = {}): PatternParams =>
  ({ type: 'circular', count, radiusMM: r, startAngleDeg: 0, endAngleDeg: 360, rotateItems: false, ...extra })

function boltCircle(cx: number, cy: number, r: number, count: number, defId = 'def1', srcId = 'h0') {
  const src = circle(srcId, cx + r, cy)
  return [src, ...pattern([src], ring(count, r), defId)]
}

describe('a pattern is one body', () => {
  it('puts the source and every copy in one body, and nothing else', () => {
    const paths = [plate('plate', 0, 0, 100, 100), ...boltCircle(50, 50, 30, 6)]
    const keys = paths.map((p) => bodyKeyOf(p, paths))
    expect(new Set(keys.slice(1)).size).toBe(1)
    expect(keys[0]).toBe('plate')
    expect(patternBodyKeys(paths).has('plate')).toBe(false)
  })

  it('joins two patterns that share a path into one body', () => {
    // A grid of the bolt circle's first copy: the copy is a source of the second pattern.
    const first = boltCircle(50, 50, 30, 4, 'defA')
    const second = pattern([first[1]], { type: 'linear', rows: 1, cols: 2, xGapMM: 5, yGapMM: 0 }, 'defB')
    const paths = [...first, ...second]
    expect(new Set(paths.map((p) => bodyKeyOf(p, paths)))).toEqual(new Set(['pattern:defA']))
  })

  it('still lets a user group win over the pattern', () => {
    const paths = boltCircle(50, 50, 30, 4).map((p) => ({ ...p, userGroups: ['g'] }))
    expect(new Set(paths.map((p) => bodyKeyOf(p, paths)))).toEqual(new Set(['g']))
  })
})

describe('the centre of a circular pattern', () => {
  it('is the centre the bolt circle was turned about', () => {
    const c = patternCentreOf(boltCircle(50, 40, 30, 6), 'h0')!
    expect(c.x).toBeCloseTo(50, 6)
    expect(c.y).toBeCloseTo(40, 6)
  })

  it('is right for an odd count, where the middle of the box is not the centre', () => {
    const paths = boltCircle(50, 40, 30, 5)
    const c = patternCentreOf(paths, 'h0')!
    expect(c.x).toBeCloseTo(50, 6)
    expect(c.y).toBeCloseTo(40, 6)
    // …which is the whole reason it is offered: the box centre is a few mm off.
    expect(Math.abs(getMultiBBox(paths.map((p) => p.d))!.cx - 50)).toBeGreaterThan(1)
  })

  it('survives a copy deleted by hand', () => {
    const paths = boltCircle(50, 40, 30, 6).filter((p) => p.id !== 'def1-c2')
    const c = patternCentreOf(paths, 'h0')!
    expect(c.x).toBeCloseTo(50, 6)
    expect(c.y).toBeCloseTo(40, 6)
  })

  it('is the midpoint of the two holes of a full circle of two', () => {
    const c = patternCentreOf(boltCircle(50, 40, 30, 2), 'h0')!
    expect(c.x).toBeCloseTo(50, 6)
    expect(c.y).toBeCloseTo(40, 6)
  })

  it('is the centre of an arc as well', () => {
    const src = circle('h0', 80, 40)
    const paths = [src, ...pattern([src], ring(3, 30, { endAngleDeg: 90 }))]
    const c = patternCentreOf(paths, 'h0')!
    expect(c.x).toBeCloseTo(50, 6)
    expect(c.y).toBeCloseTo(40, 6)
  })

  it('reads an assembly one item per instance', () => {
    // A hole with a slot beside it, turned round as a pair.
    // The pattern turns about the WHOLE selection's centre less the radius: the
    // pair spans 77..90, centre 83.5, so the circle's centre is at 53.5.
    const a = circle('a', 80, 40), b = plate('b', 86, 38, 4, 4)
    const paths = [a, b, ...pattern([a, b], ring(4, 30, { rotateItems: true }))]
    const c = patternCentreOf(paths, 'a')!
    expect(c.x).toBeCloseTo(53.5, 4)
    expect(c.y).toBeCloseTo(40, 4)
  })

  it('gives up on an assembly once a copy is gone, rather than reading the wrong items', () => {
    const a = circle('a', 80, 40), b = plate('b', 86, 38, 4, 4)
    // Copies run a, b, a, b, a, b: dropping one b shifts every item after it.
    const copies = pattern([a, b], ring(4, 30, { rotateItems: true })).filter((p) => p.id !== 'def1-c2')
    expect(patternCentreOf([a, b, ...copies], 'a')).toBeNull()
  })

  it('is nothing for a grid, or for a path that is no pattern’s source', () => {
    const src = circle('h0', 10, 10)
    const grid = [src, ...pattern([src], { type: 'linear', rows: 2, cols: 2, xGapMM: 5, yGapMM: 5 })]
    expect(patternCentreOf(grid, 'h0')).toBeNull()
    expect(patternCentreOf(boltCircle(50, 40, 30, 6), 'def1-c1')).toBeNull()
  })
})

describe('a bolt circle held to the centre of its plate', () => {
  const centreOfPlate = { kind: 'path' as const, id: 'plate', anchor: 'center' as const }
  const centreOfHoles = { kind: 'pattern' as const, id: 'h0' }

  it('offers the pattern centre as a constraint point, in place of the box centre on top of it', () => {
    const paths = [plate('plate', 0, 0, 100, 80), ...boltCircle(150, 40, 30, 6)]
    const body = bodyKeyOf(paths[1], paths)
    const mine = allAnchorCandidates(paths).filter((c) => c.body === body && Math.hypot(c.x - 150, c.y - 40) < 1e-3)
    expect(mine.map((c) => c.ref)).toEqual([centreOfHoles])
  })

  it('moves every hole with the plate, and keeps the circle round', () => {
    // Made where it stands (off to the side), then the plate is dragged 40 right, 5 up.
    const before = [plate('plate', 0, 0, 100, 80), ...boltCircle(150, 40, 30, 6)]
    const c = pickedConstraint(before, centreOfPlate, centreOfHoles, STOCK, 'xy', 'k')!
    expect(solveConstraints(before, [c], STOCK).moves).toEqual([])
    const after = [plate('plate', 40, 5, 100, 80), ...before.slice(1)]
    const sol = solveConstraints(after, [c], STOCK, ['plate'])
    expect(sol.moves).toHaveLength(1)
    expect(sol.moves[0].pathIds.sort()).toEqual(before.slice(1).map((p) => p.id).sort())
    expect(sol.moves[0].dx).toBeCloseTo(40, 6)
    expect(sol.moves[0].dy).toBeCloseTo(5, 6)
  })

  it('brings a re-run bolt circle back onto the plate when everything else is held', () => {
    // Centred on the plate, then re-run at a bigger radius: the source stays put,
    // so the centre lands 10 mm to its left — off the plate's centre. FIVE holes,
    // so the box's middle is not the centre and only the real one gives 10.
    const first = [plate('plate', 0, 0, 100, 80), ...boltCircle(50, 40, 30, 5)]
    const c = pickedConstraint(first, centreOfPlate, centreOfHoles, STOCK, 'xy', 'k')!
    const src = first[1]
    const rerun = [first[0], src, ...pattern([src], ring(5, 40))]
    expect(patternCentreOf(rerun, 'h0')!.x).toBeCloseTo(40, 6)
    const sol = solveConstraints(rerun, [c], STOCK, ['plate'])
    const holes = sol.moves.find((m) => m.pathIds.includes('h0'))!
    expect(holes.dx).toBeCloseTo(10, 6)
    expect(sol.moves.some((m) => m.pathIds.includes('plate'))).toBe(false)
  })

  it('drags the whole pattern when one hole of it is dragged, but only once it is held', () => {
    const paths = [plate('plate', 0, 0, 100, 80), ...boltCircle(50, 40, 30, 4)]
    const all = paths.slice(1).map((p) => p.id)
    expect(widenToPatternBodies(paths, [], ['def1-c2'])).toEqual(['def1-c2'])
    const c: Constraint = pickedConstraint(paths, centreOfPlate, centreOfHoles, STOCK, 'xy', 'k')!
    expect(widenToPatternBodies(paths, [c], ['def1-c2']).sort()).toEqual(all.sort())
    expect(widenToPatternBodies(paths, [c], ['plate'])).toEqual(['plate'])
  })
})

describe('which shape is tagged as a pattern’s original', () => {
  const paths = boltCircle(50, 40, 30, 4)
  const all = paths.map((p) => p.id)

  it('tags the original when it is selected with its copies, as the pattern’s chip selects them', () => {
    expect(patternOriginalsInSelection(paths, all)).toEqual(['h0'])
  })

  it('tags nothing when the original is selected on its own, or only copies are', () => {
    expect(patternOriginalsInSelection(paths, ['h0'])).toEqual([])
    expect(patternOriginalsInSelection(paths, all.slice(1))).toEqual([])
  })

  it('tags the whole first pattern as the original of a pattern made from it', () => {
    const grid = pattern(paths, { type: 'linear', rows: 1, cols: 2, xGapMM: 10, yGapMM: 0 }, 'def2')
    const doc = [...paths, ...grid]
    expect(patternOriginalsInSelection(doc, [...all, ...grid.map((p) => p.id)])).toEqual(all)
  })
})

describe('a pattern of a plate AND the bolt circle held to it', () => {
  // The plate is a big circle; the bolt circle is held to its centre; then the two
  // are patterned together as one assembly.
  const plateC = circle('C', 50, 40, 45)
  const holes = boltCircle(50, 40, 30, 4)
  const held: Constraint = {
    id: 'k', mode: 'xy', offsetXMM: 0, offsetYMM: 0,
    from: { kind: 'path', id: 'C', anchor: 'center' }, to: { kind: 'pattern', id: 'h0' },
  }
  const assembly = [plateC, ...holes]
  const copies = pattern(assembly, { type: 'linear', rows: 1, cols: 2, xGapMM: 10, yGapMM: 0 }, 'def2')
  const doc = [...assembly, ...copies]

  it('welds the assembly into one body to everything outside it', () => {
    expect(new Set(doc.map((p) => bodyKeyOf(p, doc))).size).toBe(1)
    expect([...weldingPatternIds(doc)]).toEqual(['def2'])
    // A pattern of ONE thing extends it rather than welding: the bolt circle itself.
    expect(weldingPatternIds(doc).has('def1')).toBe(false)
  })

  it('still solves the constraint inside the assembly: the bolt circle moves, the plate stays, the copies wait', () => {
    const moved = { ...held, offsetXMM: 5 }
    const sol = solveInnerConstraints(doc, [moved], STOCK, ['C'])
    expect(sol.error).toBeNull()
    expect(sol.moves).toHaveLength(1)
    expect(sol.moves[0].pathIds.sort()).toEqual(holes.map((p) => p.id).sort())
    expect(sol.moves[0].dx).toBeCloseTo(5, 6)
  })
})
