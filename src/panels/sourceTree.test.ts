import { describe, it, expect } from 'vitest'
import { sourceTree, type SourceItem } from './sourceTree'
import type { ImportedPath } from '../store/pathsStore'

const p = (id: string, groups: string[] = [], names: string[] = groups): ImportedPath =>
  ({ id, name: id, d: '', visible: true, color: '#fff', ...(groups.length ? { sourceGroups: groups, sourceGroupNames: names } : {}) })

/** The tree as nested arrays of names, folders as [name, children]. */
const shape = (items: SourceItem[]): unknown[] =>
  items.map((it) => (it.kind === 'path' ? it.path.id : [it.name, shape(it.items)]))

describe('sourceTree', () => {
  it('puts each part the file grouped in a folder named as the file named it, in document order', () => {
    const tree = sourceTree([p('a1', ['A'], ['L14b']), p('a2', ['A'], ['L14b']), p('loose'), p('b1', ['B'], ['L15b']), p('b2', ['B'], ['L15b'])])
    expect(shape(tree)).toEqual([['L14b', ['a1', 'a2']], 'loose', ['L15b', ['b1', 'b2']]])
  })

  it('skips an unnamed wrapper level that holds the whole drawing', () => {
    const tree = sourceTree([p('a1', ['W', 'A'], ['', 'A']), p('a2', ['W', 'A'], ['', 'A']), p('b1', ['W', 'B'], ['', 'B']), p('b2', ['W', 'B'], ['', 'B'])])
    expect(shape(tree)).toEqual([['A', ['a1', 'a2']], ['B', ['b1', 'b2']]])
  })

  // A part with no label is known only by its name, and assembly goes by it.
  it('keeps the folder of a group with a single path, so its name is not lost', () => {
    expect(shape(sourceTree([p('a', ['A'], ['L47e']), p('b', ['B']), p('b2', ['B'])]))).toEqual([['L47e', ['a']], ['B', ['b', 'b2']]])
  })

  it('keeps a named group even when it holds the whole import — a file of one part', () => {
    expect(shape(sourceTree([p('a', ['A'], ['L14b']), p('b', ['A'], ['L14b'])]))).toEqual([['L14b', ['a', 'b']]])
  })

  it('nests a group inside a group, and calls an unnamed one Group', () => {
    const tree = sourceTree([p('x', ['A', 'H'], ['Part', '']), p('y', ['A', 'H'], ['Part', '']), p('z', ['A'], ['Part']), p('q', ['B'])])
    expect(shape(tree)).toEqual([['Part', [['Group', ['x', 'y']], 'z']], ['B', ['q']]])
  })

  it('gives a folder every path inside it, at any depth', () => {
    const [folder] = sourceTree([p('x', ['A', 'H']), p('y', ['A', 'H']), p('z', ['A']), p('q', ['B'])])
    expect(folder.kind === 'folder' && folder.paths.map((x) => x.id)).toEqual(['x', 'y', 'z'])
  })
})
