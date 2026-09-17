import { describe, it, expect } from 'vitest'
import { buildChips } from './TimelinePanel'
import type { ImportedPath } from '../store/pathsStore'
import type { AnyOperation } from '../store/toolpathStore'

const path = (p: Partial<ImportedPath> & { id: string }): ImportedPath => ({
  name: p.id, d: 'M0,0 L1,0 L1,1 Z', visible: true, color: '#888', ...p,
})

const op = (id: string, name: string, extra: Partial<AnyOperation> = {}): AnyOperation => ({
  id, name, type: 'profile', toolId: 't1', pathId: 'p1', side: 'outside',
  depthMM: 5, stepDownMM: 2, direction: 'climb', rampIn: false,
  segments: [], status: 'done', visible: true, ...extra,
} as unknown as AnyOperation)

describe('the object strip', () => {
  it('gives one chip per loose path and one per operation', () => {
    const chips = buildChips([path({ id: 'a' }), path({ id: 'b' })], [op('o1', 'Profile')])
    expect(chips.map((c) => c.key)).toEqual(['a', 'b', 'o1'])
    expect(chips[2].family).toBe('op')
    expect(chips[2].opIds).toEqual(['o1'])
  })

  // The same complaint the shape groups answer, on the CAM side: profiling five
  // selected paths is one Generate click, and the forms already edit all five
  // through `batchOf`. Five chips said there were five things to go and change.
  it('collapses one Generate over several paths to ONE chip carrying every op', () => {
    const ops = ['o1', 'o2', 'o3'].map((id) => op(id, `Profile: ${id}`, { batchId: 'b1' }))
    const chips = buildChips([], ops)
    expect(chips).toHaveLength(1)
    expect(chips[0].label).toBe('Profile ×3')
    expect(chips[0].opIds).toEqual(['o1', 'o2', 'o3'])
  })

  // Grouped exactly as batchOf groups: a chip that spanned two op types would
  // open a form on ops it cannot edit.
  it('never lets one chip span two operation types', () => {
    const chips = buildChips([], [
      op('o1', 'Profile: a', { batchId: 'b1' }),
      op('o2', 'Pocket: a', { batchId: 'b1', type: 'pocket' } as Partial<AnyOperation>),
    ])
    expect(chips.map((c) => c.opIds)).toEqual([['o1'], ['o2']])
  })

  // A batch of one is just that operation — its own name says which path it cuts,
  // which 'Profile ×1' would throw away.
  it('keeps a lone batched operation under its own name', () => {
    const chips = buildChips([], [op('o1', 'Profile: dog (1/4 EM)', { batchId: 'b1' })])
    expect(chips[0].label).toBe('Profile: dog (1/4 EM)')
  })

  // The whole point of the rewrite: a gear is one thing, not four.
  it('collapses a multi-part shape group to ONE chip carrying all its parts', () => {
    const parts = ['teeth', 'bore', 'spokes'].map((part) => path({
      id: `g-${part}`, groupId: 'grp', groupName: 'Gear', shapePart: part,
      shapeParams: { type: 'gear', cx: 0, cy: 0, module: 4, teeth: 24 } as never,
    }))
    const chips = buildChips(parts, [])
    expect(chips).toHaveLength(1)
    expect(chips[0].label).toBe('Gear')
    expect(chips[0].pathIds).toEqual(['g-teeth', 'g-bore', 'g-spokes'])
  })

  it('collapses an SVG import group to one chip named for the file', () => {
    const imported = ['1', '2', '3'].map((n) => path({ id: `i${n}`, groupId: 'svg', groupName: 'dog' }))
    const chips = buildChips(imported, [])
    expect(chips).toHaveLength(1)
    expect(chips[0].label).toBe('dog')
  })

  // A chip is a click target for editing, so it has to say WHICH path carries
  // the definition its form reopens — and a duplicate has no form.
  it('points a generated chip at the path carrying its definition', () => {
    const chips = buildChips([
      path({ id: 'src' }),
      path({ id: 'off', definition: { id: 'd1', kind: 'offset', sourceId: 'src', distanceMM: 5, cornerStyle: 'miter' } }),
      path({ id: 'dup', definition: { id: 'd2', kind: 'duplicate', sourceId: 'src', offsetMM: 5 } }),
    ], [])
    expect(chips.map((c) => c.editPathId)).toEqual([undefined, 'off', undefined])
    expect(chips[1].label).toBe('Offset')
  })

  // One Apply of a pattern is ONE set of parameters to go back and change, so
  // the copies it made are one chip — the same reasoning as a batch of
  // operations. Copies from a DUPLICATE are not grouped: each is its own object
  // with no form behind it.
  it('collapses the paths one generator call made into one chip', () => {
    const params = { type: 'linear' as const, rows: 1, cols: 3, xSpacingMM: 10, ySpacingMM: 0 }
    const pat = (n: string) => path({ id: n, definition: { id: 'dp', kind: 'pattern' as const, sourceIds: ['src'], params } })
    const chips = buildChips([
      path({ id: 'src' }),
      pat('p1'), pat('p2'),
      path({ id: 'c1', definition: { id: 'dd', kind: 'duplicate', sourceId: 'src', offsetMM: 5 } }),
      path({ id: 'c2', definition: { id: 'dd', kind: 'duplicate', sourceId: 'src', offsetMM: 5 } }),
    ], [])
    expect(chips.map((c) => c.key)).toEqual(['src', 'def:dp', 'c1', 'c2'])
    expect(chips[1].label).toBe('Pattern ×2')
    expect(chips[1].pathIds).toEqual(['p1', 'p2'])
    expect(chips[1].editPathId).toBe('p1')
  })

  // A group is ONE thing — that is what grouping it meant — so it is one chip,
  // and its members' own chips come back when it is ungrouped.
  it('collapses a user group to one chip standing for every member', () => {
    const chips = buildChips([
      path({ id: 'a', userGroups: ['g1'] }),
      path({ id: 'loose' }),
      path({ id: 'b', userGroups: ['g1', 'inner'] }),
    ], [])
    expect(chips.map((c) => c.key)).toEqual(['ugroup:g1', 'loose'])
    expect(chips[0].label).toBe('Group ×2')
    expect(chips[0].pathIds).toEqual(['a', 'b'])
  })

  // Tabs and corner treatments are the two things with parameters that had no
  // chip. Both belong TO a path, so they follow it rather than sitting loose.
  it('puts a tabs chip straight after the path it holds', () => {
    const chips = buildChips([path({ id: 'a' }), path({ id: 'b' })], [], [
      { id: 't1', pathId: 'b', t: 0.1, lengthMM: 6, heightMM: 2 },
      { id: 't2', pathId: 'b', t: 0.6, lengthMM: 6, heightMM: 2 },
    ])
    expect(chips.map((c) => c.key)).toEqual(['a', 'b', 'tabs:b'])
    expect(chips[2].label).toBe('Tabs ×2')
    expect(chips[2].form).toBe('tabs')
    expect(chips[2].pathIds).toEqual(['b'])
  })

  it('gives a corner-treated path a Corners chip', () => {
    const chips = buildChips([path({
      id: 'a',
      corners: { baseD: 'M0,0 L9,0 L9,9 Z', treatments: [[0, { type: 'chamfer', radiusMM: 2 }]] },
    })], [])
    expect(chips.map((c) => c.key)).toEqual(['a', 'corners:a'])
    expect(chips[1].label).toBe('Corner')
    expect(chips[1].form).toBe('nodeedit')
  })

  // An emptied recipe is not a treatment — the chip has to go with it, or
  // deleting the corners would leave a chip standing for nothing.
  it('gives no Corners chip once the treatments are gone', () => {
    const chips = buildChips([path({ id: 'a', corners: { baseD: 'M0,0 L9,0 Z', treatments: [] } })], [])
    expect(chips.map((c) => c.key)).toEqual(['a'])
  })

  it('gives a clock its own chip before its parts, once', () => {
    const wheels = ['great', 'second'].map((w) => path({
      id: `w-${w}`, groupId: `grp-${w}`, groupName: w, clockId: 'clk', clockPart: w,
    }))
    const chips = buildChips(wheels, [])
    expect(chips.map((c) => c.key)).toEqual(['clock:clk', 'grp-great', 'grp-second'])
    expect(chips[0].clockId).toBe('clk')
    // The clock chip stands for no paths of its own — its wheels keep theirs.
    expect(chips[0].pathIds).toEqual([])
  })

  // An edit must CHANGE a chip, never add one: that is the whole complaint the
  // rewrite answers, and it holds because the chip key is the object's identity.
  it('keeps the same chip keys when a path is edited or moved', () => {
    const before = [path({ id: 'a' }), path({ id: 'b' })]
    const after = [
      { ...before[0], d: 'M9,9 L10,9 Z' },
      { ...before[1], placement: [{ kind: 'translate' as const, dx: 5, dy: 5 }] },
    ]
    expect(buildChips(after, []).map((c) => c.key)).toEqual(buildChips(before, []).map((c) => c.key))
  })
})
