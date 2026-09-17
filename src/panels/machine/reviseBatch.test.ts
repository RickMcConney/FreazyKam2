import { describe, it, expect } from 'vitest'
import { reviseBatch, reviseGroupBatch } from './reviseBatch'
import type { ImportedPath } from '../../store/pathsStore'

const p = (id: string) => ({ id, name: id, d: '', color: '#fff' } as unknown as ImportedPath)
// A batch member is anything with a source path — a profile op, a drill op — so the
// helper is exercised through the shape they share.
const member = (path: ImportedPath | undefined) => ({ path })
const pathOf = (m: { path: ImportedPath | undefined }) => m.path

describe('reviseBatch', () => {
  it('leaves the batch untouched when nothing is selected, rather than dropping every member', () => {
    const members = [member(p('a')), member(p('b'))]
    const r = reviseBatch(members, pathOf, [])
    expect(r.revising).toBe(false)
    expect(r.keep).toEqual(members)
    expect(r.drop).toEqual([])
    expect(r.add).toEqual([])
  })

  it('drops the member whose path was deselected and adds the one shift-clicked in', () => {
    const a = p('a'), b = p('b'), c = p('c')
    const ma = member(a), mb = member(b)
    const r = reviseBatch([ma, mb], pathOf, [a, c])
    expect(r.revising).toBe(true)
    expect(r.keep).toEqual([ma])
    expect(r.drop).toEqual([mb])
    expect(r.add).toEqual([c])
  })

  it('never drops a member whose path has left the document — it is unselected only because it is not there', () => {
    const a = p('a')
    const orphan = member(undefined)
    const r = reviseBatch([member(a), orphan], pathOf, [a])
    expect(r.drop).toEqual([])
    expect(r.keep).toContain(orphan)
  })

  it('adds nothing for a path the batch already covers, however the selection is ordered', () => {
    const a = p('a'), b = p('b')
    const r = reviseBatch([member(b), member(a)], pathOf, [a, b])
    expect(r.add).toEqual([])
    expect(r.drop).toEqual([])
    expect(r.keep).toHaveLength(2)
  })

  it('keeps at least one member whenever the selection is non-empty, so a revision can never empty the batch', () => {
    const a = p('a'), z = p('z')
    const r = reviseBatch([member(a)], pathOf, [z])
    expect(r.keep.length + r.add.length).toBeGreaterThan(0)
  })
})

describe('reviseGroupBatch', () => {
  const g = (boundary: ImportedPath, islands: ImportedPath[] = []) => ({ boundary, islands })
  const op = (boundary: ImportedPath, islands: ImportedPath[] = []) => ({ boundary, islands, op: { id: `op-${boundary.id}` } })
  // Stands in for groupPathsByContainment: the first path is the boundary, the rest islands.
  const nest = (sel: ImportedPath[]) => (sel.length === 0 ? [] : [g(sel[0], sel.slice(1))])

  it('leaves the batch untouched when nothing is selected', () => {
    const a = p('a'), b = p('b')
    const members = [op(a, [b])]
    const r = reviseGroupBatch(members, [], nest)
    expect(r.revising).toBe(false)
    expect(r.keep.map((k) => k.member)).toEqual(members)
    expect(r.add).toEqual([])
    expect(r.drop).toEqual([])
  })

  it('does not regroup when the selection is exactly what the batch already covers', () => {
    // The guard that keeps a Regenerate pressed for a new depth from silently
    // restructuring an inverted pocket: the regrouper is never called at all.
    const a = p('a'), b = p('b')
    let called = 0
    const r = reviseGroupBatch([op(a, [b])], [b, a], (sel) => { called++; return nest(sel) })
    expect(called).toBe(0)
    expect(r.revising).toBe(false)
  })

  it('makes a path shift-clicked into an existing boundary an ISLAND, not a second operation', () => {
    const a = p('a'), b = p('b')
    const r = reviseGroupBatch([op(a)], [a, b], nest)
    expect(r.revising).toBe(true)
    expect(r.add).toEqual([])
    expect(r.drop).toEqual([])
    expect(r.keep).toHaveLength(1)
    expect(r.keep[0].group.islands.map((i) => i.id)).toEqual(['b'])
    expect([...r.addedIds]).toEqual(['b'])
  })

  it('reports an island shift-clicked off as removed, and keeps its boundary operation', () => {
    const a = p('a'), b = p('b')
    const r = reviseGroupBatch([op(a, [b])], [a], nest)
    expect(r.keep).toHaveLength(1)
    expect(r.keep[0].group.islands).toEqual([])
    expect(r.removed.map((x) => x.id)).toEqual(['b'])
    expect(r.drop).toEqual([])
  })

  it('drops the operation whose boundary left the selection and adds one for the new boundary', () => {
    const a = p('a'), c = p('c')
    const members = [op(a)]
    const r = reviseGroupBatch(members, [c], nest)
    expect(r.drop).toEqual(members)
    expect(r.add.map((x) => x.boundary.id)).toEqual(['c'])
    expect(r.removed.map((x) => x.id)).toEqual(['a'])
  })
})

describe('reviseGroupBatch under a changed grouping rule', () => {
  const g = (boundary: ImportedPath, islands: ImportedPath[] = []) => ({ boundary, islands })
  const op = (boundary: ImportedPath, islands: ImportedPath[] = []) => ({ boundary, islands, op: { id: `op-${boundary.id}` } })
  // Stands in for Invert Pocket: the same two paths read the other way up.
  const inverted = (sel: ImportedPath[]) => (sel.length < 2 ? [] : [g(sel[1], [])])

  it('regroups the same selection when the caller forces it, which is what Invert Pocket does', () => {
    const a = p('a'), b = p('b')
    const r = reviseGroupBatch([op(a, [b])], [a, b], inverted, { force: true })
    expect(r.revising).toBe(true)
    expect(r.add.map((x) => x.boundary.id)).toEqual(['b'])
    expect(r.drop.map((m) => m.op.id)).toEqual(['op-a'])
  })

  it('reports the path a regrouping stopped machining as removed even though it is still selected', () => {
    const a = p('a'), b = p('b')
    const r = reviseGroupBatch([op(a, [b])], [a, b], inverted, { force: true })
    expect(r.removed.map((x) => x.id)).toEqual(['a'])
  })
})
