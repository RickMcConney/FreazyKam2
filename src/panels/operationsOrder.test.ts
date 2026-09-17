import { describe, it, expect } from 'vitest'
import { toolRuns, toolChangeCount, groupedByTool, sameOrder, reorderedFor } from './operationsOrder'
import type { AnyOperation } from '../store/toolpathStore'

// Only id + toolId matter to the ordering maths; the rest satisfies PocketOperation.
const op = (id: string, toolId: string): AnyOperation => ({
  id, name: id, type: 'pocket', toolId, status: 'done', segments: [], color: '#f00', visible: true,
  pathId: `p-${id}`, islandIds: [], depthMM: 2, stepDownMM: 1, stepoverPercent: 40,
  passAngleDeg: 0, direction: 'climb', strategy: 'raster', rampIn: false,
})

const ids = (ops: AnyOperation[]) => ops.map((o) => o.id).join(' ')

describe('toolRuns', () => {
  it('splits on every tool change, not by tool id', () => {
    // The case the Paths panel hides: it groups A with A and shows two groups, while the
    // machine changes tools three times.
    const ops = [op('a1', 'A'), op('b1', 'B'), op('a2', 'A')]
    expect(toolRuns(ops).map((r) => r.toolId)).toEqual(['A', 'B', 'A'])
    expect(toolChangeCount(ops)).toBe(2)
  })

  it('merges consecutive same-tool ops into one run', () => {
    const ops = [op('a1', 'A'), op('a2', 'A'), op('b1', 'B')]
    const runs = toolRuns(ops)
    expect(runs.map((r) => r.ops.length)).toEqual([2, 1])
    expect(toolChangeCount(ops)).toBe(1)
  })

  it('a single tool costs no tool changes', () => {
    expect(toolChangeCount([op('a1', 'A'), op('a2', 'A')])).toBe(0)
    expect(toolChangeCount([])).toBe(0)
  })
})

describe('groupedByTool', () => {
  it('makes each tool contiguous, keeping first-appearance and within-tool order', () => {
    const ops = [op('a1', 'A'), op('b1', 'B'), op('a2', 'A'), op('b2', 'B')]
    expect(ids(groupedByTool(ops))).toBe('a1 a2 b1 b2')
    expect(toolChangeCount(groupedByTool(ops))).toBe(1)
  })

  it('leaves an already-grouped program untouched', () => {
    const ops = [op('a1', 'A'), op('a2', 'A'), op('b1', 'B')]
    expect(sameOrder(groupedByTool(ops), ops)).toBe(true)
  })
})

describe('reorderedFor', () => {
  const ops = [op('a', 'A'), op('b', 'B'), op('c', 'C'), op('d', 'D')]

  it('moves an op to the front', () => {
    expect(ids(reorderedFor(ops, ['c'], 0))).toBe('c a b d')
  })

  it('moves an op to the end', () => {
    expect(ids(reorderedFor(ops, ['a'], 4))).toBe('b c d a')
  })

  // The off-by-one this arithmetic exists for: dropping at index 3 means "before d" in
  // the list the operator is looking at, and pulling `a` out first shifts everything left.
  it('drops rightwards land where the indicator was drawn', () => {
    expect(ids(reorderedFor(ops, ['a'], 3))).toBe('b c a d')
    expect(ids(reorderedFor(ops, ['b'], 3))).toBe('a c b d')
  })

  it('dropping either side of its own position is a no-op', () => {
    expect(ids(reorderedFor(ops, ['b'], 1))).toBe('a b c d')
    expect(ids(reorderedFor(ops, ['b'], 2))).toBe('a b c d')
  })

  it('moves a whole run as a block, keeping its internal order', () => {
    const runOps = [op('a1', 'A'), op('a2', 'A'), op('b1', 'B'), op('c1', 'C')]
    expect(ids(reorderedFor(runOps, ['a1', 'a2'], 4))).toBe('b1 c1 a1 a2')
    expect(ids(reorderedFor(runOps, ['a1', 'a2'], 3))).toBe('b1 a1 a2 c1')
  })

  it('gathers a non-contiguous selection at the drop point', () => {
    expect(ids(reorderedFor(ops, ['a', 'c'], 4))).toBe('b d a c')
  })

  it('clamps out-of-range targets instead of dropping ops', () => {
    expect(ids(reorderedFor(ops, ['a'], 99))).toBe('b c d a')
    expect(ids(reorderedFor(ops, ['d'], -5))).toBe('d a b c')
  })

  it('returns the list unchanged when nothing matches', () => {
    expect(reorderedFor(ops, ['nope'], 2)).toBe(ops)
  })

  // Dragging a run onto a same-tool run is how a tool change disappears.
  it('merging two runs of the same tool removes a tool change', () => {
    const split = [op('a1', 'A'), op('b1', 'B'), op('a2', 'A')]
    expect(toolChangeCount(split)).toBe(2)
    expect(toolChangeCount(reorderedFor(split, ['a2'], 1))).toBe(1)
  })
})
