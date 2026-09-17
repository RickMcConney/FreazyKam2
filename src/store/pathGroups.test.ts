import { describe, it, expect } from 'vitest'
import { expandUserGroups, groupKeyOf, outerGroupOf } from './pathGroups'
import type { ImportedPath } from '../importers/svgImporter'

const path = (p: Partial<ImportedPath> & { id: string }): ImportedPath => ({
  name: p.id, d: 'M0,0 L1,0 L1,1 Z', visible: true, color: '#888', ...p,
})

const doc = [
  path({ id: 'a', userGroups: ['g1'] }),
  path({ id: 'loose' }),
  path({ id: 'b', userGroups: ['g1'] }),
  path({ id: 'c', userGroups: ['g2'] }),
]

describe('user groups', () => {
  it('takes the whole group when one member is picked', () => {
    expect(expandUserGroups(['b'], doc)).toEqual(['a', 'b'])
  })

  // Document order, not click order: the expansion is a set of objects, and a
  // duplicated id would be selected twice and moved twice by a drag.
  it('never repeats an id, and keeps document order', () => {
    expect(expandUserGroups(['b', 'a', 'loose'], doc)).toEqual(['a', 'loose', 'b'])
  })

  it('leaves a selection that touches no group alone', () => {
    expect(expandUserGroups(['loose'], doc)).toEqual(['loose'])
  })

  it('expands each group the selection touches', () => {
    expect(expandUserGroups(['a', 'c'], doc)).toEqual(['a', 'b', 'c'])
  })

  // Groups NEST, and only the OUTERMOST one is what a click selects — grouping a
  // group with a shape and ungrouping again has to give back that group and that
  // shape, not three loose paths, which is what a flat model did.
  it('selects the outermost group, not the one inside it', () => {
    const nested = [
      path({ id: 'a', userGroups: ['outer', 'inner'] }),
      path({ id: 'b', userGroups: ['outer', 'inner'] }),
      path({ id: 'shape', userGroups: ['outer'] }),
      path({ id: 'elsewhere', userGroups: ['inner'] }), // an id reused elsewhere must not join in
    ]
    expect(expandUserGroups(['shape'], nested)).toEqual(['a', 'b', 'shape'])
    expect(outerGroupOf(nested[0])).toBe('outer')
    // With the outer level taken off, the inner group is what a click finds.
    // Ungroup takes one level off the members of the group it touched, only.
    const ungrouped = nested.map((p) => outerGroupOf(p) === 'outer'
      ? { ...p, userGroups: p.userGroups!.slice(1) } : p)
    expect(expandUserGroups(['a'], ungrouped)).toEqual(['a', 'b', 'elsewhere'])
    expect(expandUserGroups(['shape'], ungrouped)).toEqual(['shape'])
  })

  // A path can be in an import/shape group AND a user group; the user's is the
  // outer one, so that is the row it is listed and acted on under.
  it('lists a grouped shape part under the user group, not its shape group', () => {
    expect(groupKeyOf(path({ id: 'g', groupId: 'gear', userGroups: ['g1'] }))).toBe('g1')
    expect(groupKeyOf(path({ id: 'g', groupId: 'gear' }))).toBe('gear')
    expect(groupKeyOf(path({ id: 'g' }))).toBeUndefined()
  })
})
