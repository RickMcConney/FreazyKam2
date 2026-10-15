import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { usePathsStore } from '../../store/pathsStore'
import { useExcludedPaths, togglePathInSelection, watchSelectionForExclusions, placeExcluded, isListSelection } from './pathExclusion'

const sel = () => usePathsStore.getState().selectedIds
const setSel = (ids: string[]) => usePathsStore.getState().setSelectedIds(ids)
const excluded = () => useExcludedPaths.getState().entries.map((e) => e.id)

let stop: () => void
beforeEach(() => {
  usePathsStore.setState({ paths: [], selectedIds: ['a', 'b', 'c', 'd'] })
  stop = watchSelectionForExclusions()
})
afterEach(() => stop())

describe('clicking a path in a form\'s path list', () => {
  it('takes a selected path out of the selection and remembers it as excluded', () => {
    togglePathInSelection('b', 'a')
    expect(sel()).toEqual(['a', 'c', 'd'])
    expect(excluded()).toEqual(['b'])
  })

  // Pick order is cut order: clicked back in, a path is cut where it was, not last.
  it('puts an excluded path back in its place in the pick order, not at the end', () => {
    togglePathInSelection('b', 'a')
    togglePathInSelection('b', null)
    expect(sel()).toEqual(['a', 'b', 'c', 'd'])
    expect(excluded()).toEqual([])
  })

  it('puts it back after the nearest earlier path still selected when its neighbour is out too', () => {
    togglePathInSelection('b', 'a')
    togglePathInSelection('c', 'b')
    togglePathInSelection('c', null)
    expect(sel()).toEqual(['a', 'c', 'd'])
  })

  // What the Select Only bar asks, to keep its narrowing through a click here (L3).
  it('marks the selection it wrote as its own, until anything else writes one', () => {
    togglePathInSelection('b', 'a')
    expect(isListSelection(sel())).toBe(true)
    togglePathInSelection('b', null)
    expect(isListSelection(sel())).toBe(true)
    setSel([...sel(), 'e'])
    expect(isListSelection(sel())).toBe(false)
  })

  it('remembers its excluded paths even when the last selected path is clicked out', () => {
    for (const id of ['a', 'b', 'c', 'd']) togglePathInSelection(id, null)
    expect(sel()).toEqual([])
    expect(excluded()).toEqual(['a', 'b', 'c', 'd'])
  })
})

// Review M2: the excluded rows belong to the selection they were clicked out of.
describe('when something else changes the selection', () => {
  it('keeps the excluded paths through a shift-click that only ADDS a path', () => {
    togglePathInSelection('b', 'a')
    setSel([...sel(), 'e'])
    expect(excluded()).toEqual(['b'])
  })

  it('forgets them when the selection is REPLACED — another batch opened in the same form', () => {
    togglePathInSelection('b', 'a')
    setSel(['x', 'y'])
    expect(excluded()).toEqual([])
  })

  it('forgets them when the selection is CUT — Select Only, or a shift-click that removes', () => {
    togglePathInSelection('b', 'a')
    setSel(['a', 'c'])
    expect(excluded()).toEqual([])
  })

  it('forgets them on a click on blank canvas', () => {
    togglePathInSelection('b', 'a')
    setSel([])
    expect(excluded()).toEqual([])
  })

  it('forgets them when the form closes', () => {
    togglePathInSelection('b', 'a')
    stop()
    expect(excluded()).toEqual([])
    stop = watchSelectionForExclusions()
  })
})

describe('where the list draws a path that was clicked out', () => {
  const p = (id: string) => ({ id, name: id, d: 'M 0 0 L 1 1', color: '#000', visible: true })
  const paths = ['a', 'b', 'c', 'd'].map(p)
  const ids = (m: Map<string | null | undefined, { id: string }[]>, k: string | null | undefined) => (m.get(k) ?? []).map((x) => x.id)

  it('in the row it was in — straight after the row that was above it', () => {
    const m = placeExcluded([{ id: 'b', after: 'a', selAfter: 'a' }], paths, new Set(['a', 'c', 'd']), new Set())
    expect(ids(m, 'a')).toEqual(['b'])
    expect(ids(m, undefined)).toEqual([])
  })

  it('in a run, each after the one clicked out before it', () => {
    const m = placeExcluded([
      { id: 'b', after: 'a', selAfter: 'a' }, { id: 'c', after: 'b', selAfter: 'a' },
    ], paths, new Set(['a', 'd']), new Set())
    expect(ids(m, 'a')).toEqual(['b'])
    expect(ids(m, 'b')).toEqual(['c'])
  })

  // Otherwise nothing draws it, and it cannot be clicked back in.
  it('at the end of the list when the row above it is no longer drawn', () => {
    const m = placeExcluded([{ id: 'b', after: 'gone', selAfter: 'gone' }], paths, new Set(['a']), new Set())
    expect(ids(m, undefined)).toEqual(['b'])
  })

  it('after a struck-through row the form draws itself — an edited batch\'s removed member', () => {
    const m = placeExcluded([{ id: 'c', after: 'b', selAfter: 'a' }], paths, new Set(['a']), new Set(['b']))
    expect(ids(m, 'b')).toEqual(['c'])
  })

  it('not at all once it is back in the selection — the form draws it then', () => {
    const m = placeExcluded([{ id: 'b', after: 'a', selAfter: 'a' }], paths, new Set(['a', 'b']), new Set())
    expect(m.size).toBe(0)
  })
})
