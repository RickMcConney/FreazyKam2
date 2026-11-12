// What a save writes, a load must read back: the flags that say "the user did this by hand".
import { describe, it, expect, vi } from 'vitest'
import { buildProjectData } from './projectSave'
import { loadProject } from './projectLoad'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useTabStore } from '../store/tabStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { useWorkpieceStore } from '../store/workpieceStore'

vi.mock('../cam/regenerate')

const PART: ImportedPath = { id: 'p1', name: 'Part', d: 'M 0 0 L 50 0 L 50 50 L 0 50 Z', color: '#fff', visible: true } as ImportedPath

function saveAndReload() {
  const file = JSON.parse(JSON.stringify(buildProjectData()))
  // Everything a load must put back is emptied first, so nothing passes by being left over.
  usePathsStore.setState({ paths: [], selectedIds: [] })
  useTabStore.setState({ tabs: [] })
  useToolpathStore.setState({ operations: [] })
  useWorkpieceStore.setState({ bridges: null })
  loadProject(file, 'roundtrip.fkam')
}

describe('a .fkam save and load keeps what was done by hand', () => {
  it('keeps a hand-placed tab marked as hand-placed, and an applied one unmarked', () => {
    usePathsStore.setState({ paths: [PART], selectedIds: [] })
    useTabStore.setState({ tabs: [
      { id: 'hand', pathId: 'p1', t: 0.1, lengthMM: 3, heightMM: 1, manual: true },
      { id: 'even', pathId: 'p1', t: 0.6, lengthMM: 3, heightMM: 1 },
    ] })
    saveAndReload()
    const tabs = useTabStore.getState().tabs
    expect(tabs.find((t) => t.id === 'hand')).toMatchObject({ t: 0.1, manual: true })
    expect(tabs.find((t) => t.id === 'even')?.manual).toBeUndefined()
  })

  it('keeps a hand-placed strip marked as hand-placed, and a network one unmarked', () => {
    usePathsStore.setState({ paths: [PART], selectedIds: [] })
    useWorkpieceStore.setState({ bridges: {
      widthMM: 5, heightMM: 2, pathIds: ['p1'],
      lines: [{ x1: 49, y1: 20, x2: 70, y2: 20, manual: true }, { x1: 49, y1: 40, x2: 70, y2: 40 }],
    } })
    saveAndReload()
    expect(useWorkpieceStore.getState().bridges?.lines).toEqual([
      { x1: 49, y1: 20, x2: 70, y2: 20, manual: true }, { x1: 49, y1: 40, x2: 70, y2: 40 },
    ])
  })

  it('keeps a toolpath name the user typed marked as theirs', () => {
    usePathsStore.setState({ paths: [PART], selectedIds: [] })
    useToolpathStore.setState({ operations: [{
      id: 'o1', type: 'profile', name: 'Front panel', nameIsCustom: true, toolId: 't1', pathId: 'p1',
      side: 'outside', depthMM: 18, status: 'done', segments: [], color: '#000', visible: true,
    } as unknown as AnyOperation] })
    saveAndReload()
    expect(useToolpathStore.getState().operations[0]).toMatchObject({ name: 'Front panel', nameIsCustom: true })
  })
})
