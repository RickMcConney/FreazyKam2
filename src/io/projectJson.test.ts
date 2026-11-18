import { describe, it, expect } from 'vitest'
import { projectJson } from './projectJson'

const path = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: 'Path "' + id + '"', d: 'M0,0 L10,0 L10,10 Z', ...extra })

describe('projectJson — the autosave payload is exactly the .fkam JSON', () => {
  it('equals JSON.stringify of the project, quotes, unicode, undefined fields and all', () => {
    const data = {
      version: 5, name: 'a "quoted" \\ name ✓',
      workpiece: { widthMM: 300, doubleSided: undefined },
      tools: [{ id: 't', name: '"paths":"x"' }],
      paths: [path('a'), path('b', { stlSrc: 'data:model/stl;base64,' + 'A'.repeat(5000), hidden: undefined }), path('c')],
      operations: [], tabs: [], constraints: [],
    }
    expect(projectJson(data).json).toBe(JSON.stringify(data))
  })
  it('equals it with no paths, too', () => {
    const data = { version: 5, name: 'empty', paths: [] as object[], tabs: [] }
    expect(projectJson(data).json).toBe(JSON.stringify(data))
  })
  it('reuses an unchanged path object, and a replaced one is seen as a change', () => {
    const a = path('a'), b = path('b')
    const base = { version: 5, name: 'p', paths: [a, b] }
    const first = projectJson(base)
    expect(projectJson({ ...base, paths: [a, b] }).hash).toBe(first.hash)
    const b2 = { ...b, d: 'M1,0 L10,0 L10,10 Z' }
    const moved = projectJson({ ...base, paths: [a, b2] })
    expect(moved.hash).not.toBe(first.hash)
    expect(moved.json).toBe(JSON.stringify({ ...base, paths: [a, b2] }))
  })
  it('a change outside the paths changes the fingerprint', () => {
    const a = path('a')
    expect(projectJson({ version: 5, name: 'p', paths: [a] }).hash).not.toBe(projectJson({ version: 5, name: 'q', paths: [a] }).hash)
  })
})
