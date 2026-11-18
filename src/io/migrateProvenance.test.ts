// Reading provenance out of a v2 file's event log. The log no longer exists anywhere but in
// old files, so these events are written out by hand in the shapes those files hold.
import { describe, it, expect } from 'vitest'
import { migrateProvenance } from './migrateProvenance'
import type { ImportedPath } from '../importers/svgImporter'

const path = (id: string): ImportedPath => ({ id, name: id, d: 'M0,0 L10,0 L10,10 Z', visible: true, color: '#888' })

describe('migrateProvenance — booleans', () => {
  it('stamps the path a recorded boolean added as that boolean of the paths it updated', () => {
    const { paths, stamped } = migrateProvenance([path('a'), path('b'), path('r')], [
      { kind: 'paths.edit', id: 'ev1', gesture: 'boolean', boolOp: 'subtract', updates: [{ id: 'a' }, { id: 'b' }], add: [{ id: 'r' }] },
    ])
    expect(stamped).toBe(1)
    expect(paths[2].definition).toEqual({ id: 'ev1', kind: 'boolean', op: 'subtract', sourceIds: ['a', 'b'] })
  })

  it('leaves a path added by any other edit without provenance — a weld, or a shape growing a part', () => {
    const { paths, stamped } = migrateProvenance([path('a'), path('w'), path('g1'), path('spokes')], [
      { kind: 'paths.edit', id: 'ev1', gesture: 'weld', updates: [{ id: 'a' }], add: [{ id: 'w' }] },
      // As scratch/clock.fkam holds it: an escapement edit that added its Spokes part.
      { kind: 'paths.edit', id: 'ev2', label: 'Escapement', updates: [{ id: 'g1' }], add: [{ id: 'spokes' }] },
    ])
    expect(stamped).toBe(0)
    expect(paths.every((p) => p.definition === undefined)).toBe(true)
  })
})
