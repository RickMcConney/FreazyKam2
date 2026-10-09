import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../cam/regenerate')

import { existsSync, readFileSync } from 'fs'
import { fromFusionLibrary, isFusionLibrary } from './fusionTools'
import {
  readToolFile, planToolFolderImport, applyToolFolderImport, planRestoreTools, applyToolReplace,
  planDeleteFolder, applyDeleteFolder, applySettings,
} from './settingsFile'
import { mergeIntoFolders, parseSettings } from './settingsMerge'
import { useToolStore, DEFAULT_TOOLS, folderOf, type Tool } from '../store/toolStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { includedAngleDeg } from '../cam/geom'

// A real vendor catalogue, kept in the gitignored scratch/ — the tests that read it skip without it.
const IDC_PATH = new URL('../../scratch/bits/IDCWoodcraftFusion360Library.json', import.meta.url)
const HAVE_IDC = existsSync(IDC_PATH)
const IDC = HAVE_IDC ? JSON.parse(readFileSync(IDC_PATH, 'utf8')) : null

// One Fusion record, in inches, as Fusion writes it.
const fusion = (type: string, geometry: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  data: [{
    type, unit: 'inches', description: `A ${type}`, vendor: 'Acme', geometry,
    'start-values': { presets: [{ n: 18000, v_f: 60, v_f_plunge: 15 }] }, ...extra,
  }],
  version: 36,
})
let n = 0
const mint = () => `t${n++}`
const one = (data: unknown) => fromFusionLibrary(data, mint).tools[0]

const myTool = (id: string, name: string, extra: Partial<Tool> = {}): Tool =>
  ({ id, name, type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 10, ...extra })

describe('reading a Fusion 360 tool library', () => {
  it('recognises a Fusion library and not a FreazyKam settings file', () => {
    expect(isFusionLibrary(fusion('flat end mill', { DC: 0.25 }))).toBe(true)
    expect(isFusionLibrary({ format: 'freazykam-settings', sections: {} })).toBe(false)
  })

  it('converts inches to mm, and feeds from the first preset in units per minute', () => {
    const t = one(fusion('flat end mill', { DC: 0.25, NOF: 3, LCF: 1 }))
    expect(t).toMatchObject({ type: 'endmill', diameterMM: 6.35, fluteCount: 3, rpm: 18000, xyFeedMmMin: 1524, zFeedMmMin: 381, maxDepthMM: 25.4 })
  })

  it('takes a millimetre library as it is', () => {
    const d = fusion('flat end mill', { DC: 6, LCF: 20 })
    d.data[0].unit = 'millimeters'
    expect(one(d)).toMatchObject({ diameterMM: 6, maxDepthMM: 20, xyFeedMmMin: 60 })
  })

  it('reads a chamfer mill as a V-bit whose included angle is twice Fusion\'s per-side TA', () => {
    const t = one(fusion('chamfer mill', { DC: 0.5, TA: 45, LCF: 0.067 }))
    expect(t.type).toBe('vbit')
    expect(includedAngleDeg(t)).toBe(90)
  })

  it('gives a V-bit the depth of its cone, not the catalogue\'s flute length', () => {
    // A 90° ½" V-bit's cone is ¼" deep whatever LCF says.
    expect(one(fusion('chamfer mill', { DC: 0.5, TA: 45, LCF: 0.067 })).maxDepthMM).toBeCloseTo(6.35, 3)
  })

  it('reads a tapered mill as a taper: tip diameter from RE, the angle per side as it is, the flute length as its taper length', () => {
    const t = one(fusion('tapered mill', { DC: 0.25, TA: 5, RE: 0.0312, LCF: 1.125 }))
    expect(t).toMatchObject({ type: 'taper', vbitAngleDeg: 5, maxDepthMM: 28.575 })
    expect(t.diameterMM).toBeCloseTo(1.585, 3)
    expect(includedAngleDeg(t)).toBe(10)
  })

  it('gives a drill no side feed', () => {
    expect(one(fusion('drill', { DC: 0.25, LCF: 1 })).xyFeedMmMin).toBe(0)
  })

  it('skips a tool it has no shape for, and says which and why', () => {
    const r = fromFusionLibrary(fusion('radius mill', { DC: 0.25, RE: 0.125 }), mint)
    expect(r.tools).toEqual([])
    expect(r.skipped).toEqual([{ name: 'A radius mill', why: expect.stringContaining('radius mill') }])
  })

  it('reads a bull nose (a bowl bit) as a bull nose, keeping its corner radius', () => {
    const r = fromFusionLibrary(fusion('bull nose end mill', { DC: 1, RE: 0.375 }), mint)
    expect(r.tools[0]).toMatchObject({ type: 'bullnose', diameterMM: 25.4, cornerRadiusMM: 9.525 })
    expect(r.notes).toEqual([])
  })

  it('skips a bull nose whose corner is wider than the bit', () => {
    const r = fromFusionLibrary(fusion('bull nose end mill', { DC: 0.5, RE: 0.375 }), mint)
    expect(r.tools).toEqual([])
    expect(r.skipped[0].why).toMatch(/corner radius/)
  })

  it.skipIf(!HAVE_IDC)('reads the IDC Woodcraft catalogue: 79 tools, the two round-overs skipped, every name unique, folder named for the vendor', () => {
    const r = fromFusionLibrary(IDC, mint)
    expect(r.tools).toHaveLength(79)
    expect(r.skipped.map((s) => s.name)).toEqual(['1/8" Radius Round Over', '1/4" Radius Round Over'])
    expect(new Set(r.tools.map((t) => t.name)).size).toBe(79)
    expect(r.vendor).toBe('IDC Woodcraft')
  })
})

describe('merging tools a folder at a time', () => {
  it('does not treat a same-named tool in another folder as a clash', () => {
    const r = mergeIntoFolders([myTool('a', '1/4" End Mill')], [myTool('b', '1/4" End Mill', { folder: 'Acme', rpm: 9000 })], mint)
    expect(r.added).toEqual(['1/4" End Mill'])
    expect(r.copied).toEqual([])
  })

  it('skips a tool already in its folder exactly, and copies one that differs', () => {
    const lib = [myTool('a', 'X', { folder: 'Acme' })]
    expect(mergeIntoFolders(lib, [myTool('z', 'X', { folder: 'Acme' })], mint).same).toBe(1)
    expect(mergeIntoFolders(lib, [myTool('z', 'X', { folder: 'Acme', rpm: 1 })], mint).copied).toEqual(['X (imported)'])
  })

  it('reissues an incoming id the library uses in ANY folder', () => {
    const r = mergeIntoFolders([myTool('a', 'Mine')], [myTool('a', 'Theirs', { folder: 'Acme' })], () => 'fresh')
    expect(r.list.map((t) => t.id)).toEqual(['a', 'fresh'])
  })
})

describe('importing a tool file into a folder', () => {
  beforeEach(() => {
    useToolStore.setState({ tools: [myTool('m1', 'Mine')], openFolder: '' })
    useToolpathStore.getState().replaceOperations([])
  })

  it.skipIf(!HAVE_IDC)('files every tool in the named folder and leaves My Tools as it was', () => {
    const f = readToolFile('IDC.json', JSON.stringify(IDC))
    expect(f.folder).toBe('IDC Woodcraft')
    applyToolFolderImport(f.tools, f.folder)
    const tools = useToolStore.getState().tools
    expect(tools.filter((t) => folderOf(t) === '')).toEqual([myTool('m1', 'Mine')])
    expect(tools.filter((t) => folderOf(t) === 'IDC Woodcraft')).toHaveLength(79)
    expect(useToolStore.getState().openFolder).toBe('IDC Woodcraft')
  })

  it.skipIf(!HAVE_IDC)('adds nothing when the same catalogue is imported into the same folder again', () => {
    const f = readToolFile('IDC.json', JSON.stringify(IDC))
    applyToolFolderImport(f.tools, f.folder)
    const again = readToolFile('IDC.json', JSON.stringify(IDC))
    const plan = planToolFolderImport(again.tools, again.folder)
    expect(plan.added.length + plan.copied.length).toBe(0)
    expect(plan.same).toBe(79)
  })

  it('reads a .fkset into the folder named for the file', () => {
    const text = JSON.stringify({ format: 'freazykam-settings', version: 1, sections: { tools: [myTool('x', 'Shared')] } })
    const f = readToolFile('friend tools.fkset', text)
    expect(f.folder).toBe('friend tools')
    applyToolFolderImport(f.tools, f.folder)
    expect(useToolStore.getState().tools.find((t) => t.name === 'Shared')?.folder).toBe('friend tools')
  })

  it('keeps a bull nose\'s corner radius through a .fkset', () => {
    const text = JSON.stringify({ format: 'freazykam-settings', version: 1, sections: { tools: [myTool('x', 'Bowl', { type: 'bullnose', cornerRadiusMM: 9.525 })] } })
    expect(readToolFile('bowl.fkset', text).tools[0]).toMatchObject({ type: 'bullnose', cornerRadiusMM: 9.525 })
  })

  it('"My Tools" as the folder name means the user\'s own, the folder field left absent', () => {
    applyToolFolderImport([myTool('x', 'Loose')], 'My Tools')
    expect('folder' in useToolStore.getState().tools.find((t) => t.name === 'Loose')!).toBe(false)
  })
})

describe('folders and the rest of the library', () => {
  beforeEach(() => {
    useToolStore.setState({ tools: [myTool('m1', 'Mine'), myTool('v1', 'Cat A', { folder: 'Acme' }), myTool('v2', 'Cat B', { folder: 'Acme' })], openFolder: 'Acme' })
    useToolpathStore.getState().replaceOperations([])
  })

  it('restoring the defaults replaces My Tools and keeps every imported folder', () => {
    applyToolReplace(planRestoreTools())
    const tools = useToolStore.getState().tools
    expect(tools.filter((t) => folderOf(t) === '').map((t) => t.name)).toEqual(DEFAULT_TOOLS.map((t) => t.name))
    expect(tools.filter((t) => folderOf(t) === 'Acme').map((t) => t.id)).toEqual(['v1', 'v2'])
  })

  it('deleting a folder keeps a tool the open project cuts with', () => {
    useToolpathStore.getState().replaceOperations([{ id: 'op', type: 'profile', toolId: 'v2' } as unknown as AnyOperation])
    const plan = planDeleteFolder('Acme')
    expect(plan.removed.map((t) => t.id)).toEqual(['v1'])
    applyDeleteFolder(plan)
    expect(useToolStore.getState().tools.map((t) => t.id)).toEqual(['m1', 'v2'])
  })

  it('moving a tool to another folder keeps its id, so operations still find it', () => {
    useToolStore.getState().moveToFolder('v1', 'Shop')
    expect(useToolStore.getState().tools.find((t) => t.id === 'v1')?.folder).toBe('Shop')
  })

  it('moving a tool to "My Tools" files it as the user\'s own, the folder field absent', () => {
    useToolStore.getState().moveToFolder('v1', 'My Tools')
    expect('folder' in useToolStore.getState().tools.find((t) => t.id === 'v1')!).toBe(false)
  })

  it('refuses to delete a folder holding every tool in the library, changing nothing', () => {
    useToolStore.setState({ tools: [myTool('v1', 'Cat A', { folder: 'Acme' })] })
    expect(applyDeleteFolder(planDeleteFolder('Acme'))).toBe(false)
    expect(useToolStore.getState().tools.map((t) => t.id)).toEqual(['v1'])
  })

  it('a whole-settings import keeps each tool in its folder, merging only within it', () => {
    const file = parseSettings(JSON.stringify({ format: 'freazykam-settings', version: 1, sections: { tools: [
      myTool('n1', 'Mine', { folder: 'Acme' }),
      myTool('n2', 'Cat A', { folder: 'Acme' }),
    ] } }))
    applySettings(file, ['tools'])
    const tools = useToolStore.getState().tools
    // "Mine" goes into Acme beside the user's own "Mine", not as "Mine (imported)".
    expect(tools.map((t) => `${folderOf(t)}/${t.name}`)).toEqual(['/Mine', 'Acme/Cat A', 'Acme/Cat B', 'Acme/Mine'])
  })
})

describe('the tool picker\'s memory', () => {
  beforeEach(() => {
    useToolStore.setState({ tools: [myTool('m1', 'Mine'), myTool('v1', 'Cat A', { folder: 'Acme' })], recentToolIds: [] })
  })

  it('keeps recently picked tools newest first, each once', () => {
    const { noteToolUsed } = useToolStore.getState()
    noteToolUsed('a'); noteToolUsed('b'); noteToolUsed('a')
    expect(useToolStore.getState().recentToolIds).toEqual(['a', 'b'])
  })

  it('remembers only the last eight', () => {
    for (let i = 0; i < 10; i++) useToolStore.getState().noteToolUsed(`t${i}`)
    expect(useToolStore.getState().recentToolIds).toEqual(['t9', 't8', 't7', 't6', 't5', 't4', 't3', 't2'])
  })

  it('copying a catalogue bit to My Tools hands back the copy\'s id, so the picker can use it', () => {
    const id = useToolStore.getState().copyToMyTools('v1')
    const copy = useToolStore.getState().tools.find((t) => t.id === id)
    expect(copy).toMatchObject({ name: 'Cat A' })
    expect(id).not.toBe('v1')
    expect('folder' in copy!).toBe(false)
  })
})
