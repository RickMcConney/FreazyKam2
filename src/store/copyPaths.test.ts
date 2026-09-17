import { describe, it, expect } from 'vitest'
import { copyPaths, withHiddenSources, ingredientsOf } from './copyPaths'
import type { ImportedPath } from '../importers/svgImporter'
import type { Tab } from './tabStore'
import type { Constraint } from './constraints'

const path = (p: Partial<ImportedPath> & { id: string }): ImportedPath => ({
  name: p.id, d: 'M0,0 L10,0 L10,10 Z', visible: true, color: '#888', ...p,
})

const DUPLICATE = { offsetMM: 5, pathIdPrefix: 'path-dup', rename: (n: string) => `${n} copy`, lostRecipe: 'copied-from' } as const
const PASTE = { offsetMM: 0, pathIdPrefix: 'path-paste', lostRecipe: 'drop' } as const

describe('withHiddenSources', () => {
  it('pulls in the hidden operands of a boolean, transitively, in document order', () => {
    const a = path({ id: 'a', hidden: true })
    const b = path({ id: 'b', hidden: true })
    const inner = path({ id: 'inner', hidden: true, definition: { id: 'd0', kind: 'boolean', op: 'union', sourceIds: ['a', 'b'] } })
    const c = path({ id: 'c', hidden: true })
    const outer = path({ id: 'outer', definition: { id: 'd1', kind: 'boolean', op: 'subtract', sourceIds: ['inner', 'c'] } })
    const picked = withHiddenSources(['outer'], [a, b, inner, c, outer])
    expect(picked.map((p) => p.id)).toEqual(['a', 'b', 'inner', 'c', 'outer'])
  })

  it('leaves a VISIBLE source behind — the user manages that one themselves', () => {
    const src = path({ id: 'src' })
    const off = path({ id: 'off', definition: { id: 'd', kind: 'offset', sourceId: 'src', distanceMM: 2, cornerStyle: 'round' } })
    expect(withHiddenSources(['off'], [src, off]).map((p) => p.id)).toEqual(['off'])
  })

  it('never pulls in the source of a duplicate, which is history rather than an ingredient', () => {
    expect(ingredientsOf({ id: 'd', kind: 'duplicate', sourceId: 'x', offsetMM: 5 })).toEqual([])
    const orig = path({ id: 'orig', hidden: true })
    const dup = path({ id: 'dup', definition: { id: 'd', kind: 'duplicate', sourceId: 'orig', offsetMM: 5 } })
    expect(withHiddenSources(['dup'], [orig, dup]).map((p) => p.id)).toEqual(['dup'])
  })
})

describe('copyPaths', () => {
  // The drift this module ended: Duplicate left a path's holding tabs behind while Paste
  // carried them. Now one routine carries them for both.
  it('carries holding tabs for a duplicate, repointed at the copy with ids of their own', () => {
    const p = path({ id: 'a' })
    const tabs: Tab[] = [
      { id: 't1', pathId: 'a', t: 0.25, lengthMM: 6, heightMM: 2 },
      { id: 't2', pathId: 'other', t: 0.5, lengthMM: 6, heightMM: 2 },
    ]
    const out = copyPaths([p], tabs, [], DUPLICATE)
    expect(out.tabs).toHaveLength(1)
    expect(out.tabs[0].pathId).toBe(out.paths[0].id)
    expect(out.tabs[0].id).not.toBe('t1')
    expect(out.tabs[0].t).toBe(0.25)
  })

  // The other drift: a boolean copied WITH its hidden operands keeps its recipe, pointing at
  // the copied operands — for a paste now exactly as for a duplicate.
  it('keeps a boolean recipe pointing at the copied operands, whichever gesture copied it', () => {
    const a = path({ id: 'a', hidden: true })
    const b = path({ id: 'b', hidden: true })
    const res = path({ id: 'res', definition: { id: 'd1', kind: 'boolean', op: 'subtract', sourceIds: ['a', 'b'] } })
    for (const opts of [DUPLICATE, PASTE]) {
      const out = copyPaths(withHiddenSources(['res'], [a, b, res]), [], [], opts)
      const copy = out.paths.find((p) => p.definition?.kind === 'boolean')!
      if (copy.definition?.kind !== 'boolean') throw new Error('lost the recipe')
      expect(copy.definition.id).not.toBe('d1')
      expect(copy.definition.sourceIds).toEqual([out.newIdOf.get('a'), out.newIdOf.get('b')])
    }
  })

  it('records where a recipe-less duplicate came from, and drops the recipe on a paste', () => {
    const src = path({ id: 'src' })
    const off = path({ id: 'off', definition: { id: 'd', kind: 'offset', sourceId: 'src', distanceMM: 2, cornerStyle: 'round' } })
    const dup = copyPaths([off], [], [], DUPLICATE).paths[0]
    expect(dup.definition).toMatchObject({ kind: 'duplicate', sourceId: 'off', offsetMM: 5 })
    const pasted = copyPaths([off], [], [], PASTE).paths[0]
    expect(pasted.definition).toBeUndefined()
    // A pasted duplicate keeps "copied from" only when what it names came too.
    const dupDef = path({ id: 'dd', definition: { id: 'x', kind: 'duplicate', sourceId: 'src', offsetMM: 5 } })
    const both = copyPaths([src, dupDef], [], [], PASTE)
    expect(both.paths[1].definition).toMatchObject({ kind: 'duplicate', sourceId: both.newIdOf.get('src') })
    expect(copyPaths([dupDef], [], [], PASTE).paths[0].definition).toBeUndefined()
  })

  it('carries a constraint only when both ends were copied, a stock edge counting as copied', () => {
    const a = path({ id: 'a' }), b = path({ id: 'b' })
    const between = { id: 'c1', from: { kind: 'path', id: 'a' }, to: { kind: 'path', id: 'b' } } as unknown as Constraint
    const toStock = { id: 'c2', from: { kind: 'stock', edge: 'left' }, to: { kind: 'path', id: 'a' } } as unknown as Constraint
    const toOutside = { id: 'c3', from: { kind: 'path', id: 'a' }, to: { kind: 'path', id: 'z' } } as unknown as Constraint
    const out = copyPaths([a, b], [], [between, toStock, toOutside], DUPLICATE)
    expect(out.constraints.map((c) => c.id)).not.toContain('c1')
    expect(out.constraints).toHaveLength(2)
    const [c1, c2] = out.constraints as unknown as { from: { kind: string; id?: string }; to: { id: string } }[]
    expect(c1.from.id).toBe(out.newIdOf.get('a'))
    expect(c1.to.id).toBe(out.newIdOf.get('b'))
    expect(c2.from.kind).toBe('stock')
    expect(c2.to.id).toBe(out.newIdOf.get('a'))
  })

  it('names and nudges a duplicate, and leaves a zero-offset paste where it was drawn', () => {
    const p = path({ id: 'a', shapeParams: { type: 'circle', cx: 10, cy: 10, radius: 5 } })
    const dup = copyPaths([p], [], [], DUPLICATE).paths[0]
    expect(dup.name).toBe('a copy')
    expect(dup.d).not.toBe(p.d)
    if (dup.shapeParams?.type !== 'circle') throw new Error('lost the params')
    expect(dup.shapeParams.cx).toBe(15)
    const pasted = copyPaths([p], [], [], PASTE).paths[0]
    expect(pasted.name).toBe('a')
    expect(pasted.d).toBe(p.d)
  })
})
