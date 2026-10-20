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

  // Thirty copies of a gear are thirty multi-part shapes, each with its own
  // groupId — which on its own would be thirty chips all reopening one fill.
  it('gives a fill ONE chip that reopens it, even when every copy is a multi-part shape', () => {
    const params = {
      count: 0, spacingMM: 3, marginMM: 3, rotationStepDeg: 90, packFrom: 'left' as const,
      useHoles: false, avoidOthers: true, copyToolpaths: true,
    }
    const fill = (id: string, groupId: string) =>
      path({ id, groupId, definition: { id: 'df', kind: 'fill' as const, sourceIds: ['teeth', 'bore'], params } })
    const chips = buildChips([
      path({ id: 'teeth', groupId: 'gear' }), path({ id: 'bore', groupId: 'gear' }),
      fill('t2', 'g2'), fill('b2', 'g2'), fill('t3', 'g3'), fill('b3', 'g3'),
    ], [])
    expect(chips.map((c) => c.key)).toEqual(['gear', 'def:df'])
    expect(chips[1].label).toBe('Nest ×3')
    expect(chips[1].pathIds).toEqual(['teeth', 'bore', 't2', 'b2', 't3', 'b3'])
    expect(chips[1].editPathId).toBe('t2')
  })

  it('does not give a fill\'s copies a tab chip each — the original keeps its own', () => {
    const params = {
      count: 0, spacingMM: 3, marginMM: 3, rotationStepDeg: 90, packFrom: 'left' as const,
      useHoles: false, avoidOthers: true, copyToolpaths: true,
    }
    const fill = (id: string) => path({ id, definition: { id: 'df', kind: 'fill' as const, sourceIds: ['src'], params } })
    const tab = (id: string, pathId: string) => ({ id, pathId, t: 0.5, lengthMM: 5, heightMM: 2 })
    const chips = buildChips([path({ id: 'src' }), fill('c2'), fill('c3')], [], [tab('a', 'src'), tab('b', 'c2'), tab('c', 'c3')])
    expect(chips.filter((c) => c.form === 'tabs').flatMap((c) => c.pathIds)).toEqual(['src'])
  })

  // A plate with text inside it is ONE part to the nest but two objects, and
  // counting objects called a fill of 6 "Nest ×11".
  it('counts a fill in PARTS, however many paths each part is made of', () => {
    const params = {
      count: 3, spacingMM: 3, marginMM: 3, rotationStepDeg: 90, packFrom: 'left' as const,
      useHoles: false, avoidOthers: true, copyToolpaths: true,
    }
    const fill = (id: string, copy: number) =>
      path({ id, definition: { id: 'df', kind: 'fill' as const, sourceIds: ['plate', 'text'], params, copy } })
    const chips = buildChips([
      path({ id: 'plate' }), path({ id: 'text', groupId: 'tg' }),
      fill('plate2', 2), path({ ...fill('text2', 2), groupId: 'tg2' }),
      fill('plate3', 3), path({ ...fill('text3', 3), groupId: 'tg3' }),
    ], [])
    expect(chips.find((c) => c.key === 'def:df')!.label).toBe('Nest ×3')
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

describe("a double-sided or tiled job's chip", () => {
  const tiling = { axis: 'x', maxTravelMM: 200, seamsMM: [150, 300, 450], pin1DiaMM: 8, pin2DiaMM: 10, pinFromStartMM: 20, pin1MM: 20, pin2MM: 20, spoilDepthMM: 8, pinPathIds: ['t1', 't2'] } as const
  const pins = [path({ id: 't1', name: 'Tile Pins 1', registration: 'tile-pins' }), path({ id: 't2', name: 'Tile Pins 2', registration: 'tile-pins' })]
  const drills = [op('d1', 'Tile Pins 1', { type: 'drill', pathId: 't1', batchId: 'b' } as never), op('d2', 'Tile Pins 2', { type: 'drill', pathId: 't2', batchId: 'b' } as never)]

  it('comes first, opens the job’s form, and stands for its holes — which get no chip of their own', () => {
    const chips = buildChips([path({ id: 'part' }), ...pins], [], [], [], 'mm', { tiling: tiling as never })
    expect(chips[0]).toMatchObject({ label: 'Tiling \u00d74', form: 'tiling', pathIds: ['t1', 't2'] })
    expect(chips.map((c) => c.key)).toEqual(['job:tiling', 'part'])
  })

  it('takes the drilling of its holes too, leaving every other operation its own chip', () => {
    const chips = buildChips([path({ id: 'p1' }), ...pins], [...drills, op('cut', 'Profile')], [], [], 'mm', { tiling: tiling as never })
    expect(chips.filter((c) => c.opIds).map((c) => c.opIds)).toEqual([['cut']])
  })

  it('for a double-sided job takes its dowel holes', () => {
    const holes = path({ id: 'dh', name: 'Dowel Holes', registration: 'dowel' })
    const chips = buildChips([path({ id: 'part' }), holes], [], [], [], 'mm', { doubleSided: { flip: 'left-right', dowelPathId: 'dh' } as never })
    expect(chips[0]).toMatchObject({ key: 'job:doublesided', form: 'doublesided', pathIds: ['dh'] })
    expect(chips.map((c) => c.key)).toEqual(['job:doublesided', 'part'])
  })
})
