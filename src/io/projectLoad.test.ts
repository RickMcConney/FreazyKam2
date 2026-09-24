import { describe, it, expect } from 'vitest'
import { parseProject, ProjectFileError } from './projectLoad'
import { PROJECT_VERSION } from './projectSave'

// A minimal project as buildProjectData writes one.
const good = () => ({
  version: PROJECT_VERSION,
  name: 'Sign',
  workpiece: { widthMM: 300, heightMM: 200, thicknessMM: 18 },
  tools: [{ id: 't1', name: 'End Mill' }],
  paths: [{ id: 'p1', name: 'Outline', d: 'M0 0 L10 0 L10 10 Z', color: '#fff', visible: true }],
  operations: [{ id: 'o1', type: 'pocket', toolId: 't1', pathId: 'p1', islandIds: [], strategy: 'raster' }],
  tabs: [{ id: 'tab1', pathId: 'p1', t: 0.5, lengthMM: 3, heightMM: 1 }],
  constraints: [],
})

const reason = (data: unknown): string => {
  try { parseProject(data) } catch (e) {
    expect(e).toBeInstanceOf(ProjectFileError)
    return (e as Error).message
  }
  throw new Error('expected parseProject to refuse the file')
}

describe('parseProject — refuses a file the app could not stand on', () => {
  it('refuses something that is not a project object at all', () => {
    for (const bad of [null, 42, 'text', [1, 2]]) expect(reason(bad)).toBe('this is not a FreazyKam project')
  })

  it('refuses a list that is not a list, naming which', () => {
    expect(reason({ ...good(), paths: { p1: {} } })).toBe('its path list is damaged')
    expect(reason({ ...good(), operations: 'none' })).toBe('its operation list is damaged')
  })

  it('refuses a path with no outline or no id, naming which one (1-based)', () => {
    const paths = [...good().paths, { id: 'p2', name: 'Broken' }]
    expect(reason({ ...good(), paths })).toBe('path 2 is damaged')
    expect(reason({ ...good(), paths: [{ d: 'M0 0 L1 1' }] })).toBe('path 1 is damaged')
  })

  it('refuses an operation, tool or tab without the ids everything looks it up by', () => {
    expect(reason({ ...good(), operations: [{ id: 'o1' }] })).toBe('operation 1 is damaged')
    expect(reason({ ...good(), tools: [{ name: 'no id' }] })).toBe('tool 1 is damaged')
    expect(reason({ ...good(), tabs: [{ id: 'tab1' }] })).toBe('tab 1 is damaged')
  })
})

describe('parseProject — reads what it can', () => {
  it('reads a well-formed file through unchanged', () => {
    const p = parseProject(good())
    expect(p.paths.map((x) => x.id)).toEqual(['p1'])
    expect(p.operations.map((x) => x.id)).toEqual(['o1'])
    expect(p.tabs).toHaveLength(1)
    expect([p.newerVersion, p.droppedOps]).toEqual([false, 0])
  })

  it('treats a missing list as empty, as older files have none', () => {
    const { tabs: _t, constraints: _c, tools: _to, ...old } = good()
    const p = parseProject(old)
    expect([p.tabs, p.constraints, p.tools]).toEqual([[], [], []])
  })

  it('flags a file from a newer version and leaves out operation kinds it does not know', () => {
    const data = {
      ...good(),
      version: PROJECT_VERSION + 1,
      operations: [...good().operations, { id: 'o2', type: 'laserEtch', toolId: 't1' }],
    }
    const p = parseProject(data)
    expect(p.newerVersion).toBe(true)
    expect(p.droppedOps).toBe(1)
    expect(p.operations.map((o) => o.id)).toEqual(['o1'])
  })

  it('still rewrites the dropped spiral pocket strategy to morph', () => {
    const data = { ...good(), operations: [{ ...good().operations[0], strategy: 'spiralOffset' }] }
    expect((parseProject(data).operations[0] as { strategy: string }).strategy).toBe('morph')
  })

  it('rewrites the dropped Adaptive2d pocket strategy to adaptive2', () => {
    const data = { ...good(), operations: [{ ...good().operations[0], strategy: 'adaptive' }] }
    expect((parseProject(data).operations[0] as { strategy: string }).strategy).toBe('adaptive2')
  })

  it('reads a v4 X-distance constraint as a polar one', () => {
    const data = { ...good(), constraints: [{ id: 'c1', kind: 'distX', from: { kind: 'stock' }, to: { kind: 'path', id: 'p1' }, valueMM: -40 }] }
    expect(parseProject(data).constraints[0]).toMatchObject({ distanceMM: 40, angleDeg: 180 })
  })
})
