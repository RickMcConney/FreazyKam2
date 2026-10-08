import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../cam/regenerate')

import {
  planRestoreTools, applyToolReplace, planRestoreBuiltins, applyRestoreBuiltins,
  planRestoreMachine, applyRestoreMachine, planToolReplace, applySettings,
} from './settingsFile'
import { parseSettings } from './settingsMerge'
import { useToolStore, DEFAULT_TOOLS, type Tool } from '../store/toolStore'
import { usePostProcessorStore, BUILTIN_PROFILES } from '../store/postProcessorStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'

const myTool = (id: string, name: string, dia = 4): Tool =>
  ({ id, name, type: 'endmill', diameterMM: dia, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 10 })
// An operation needs only its tool id for these: that is all the keep rule reads.
const opUsing = (toolId: string) => ({ id: `op-${toolId}`, type: 'profile', toolId }) as unknown as AnyOperation

beforeEach(() => {
  useToolStore.setState({ tools: [myTool('t1', 'Mine A'), myTool('t2', 'Mine B'), myTool('default-1', 'Re-sized default', 9)] })
  useToolpathStore.getState().replaceOperations([])
})

describe('restoring the default tools', () => {
  it('puts the factory tools back, removing the user\'s', () => {
    const plan = planRestoreTools()
    applyToolReplace(plan)
    expect(useToolStore.getState().tools.map((t) => t.name)).toEqual(DEFAULT_TOOLS.map((t) => t.name))
    expect(plan.removed).toEqual(['Mine A', 'Mine B', 'Re-sized default'])
    expect(plan.added).toEqual(DEFAULT_TOOLS.map((t) => t.name))
  })

  it('keeps every tool the open project cuts with, under its own id, so no operation loses its tool', () => {
    useToolpathStore.getState().replaceOperations([opUsing('t2'), opUsing('default-1')])
    const plan = planRestoreTools()
    applyToolReplace(plan)
    const tools = useToolStore.getState().tools
    expect(plan.kept).toEqual(['Mine B', 'Re-sized default'])
    expect(tools.find((t) => t.id === 't2')?.name).toBe('Mine B')
    // The in-use tool keeps 'default-1'; the factory 1/4" end mill that wanted it moves aside.
    expect(tools.find((t) => t.id === 'default-1')?.diameterMM).toBe(9)
    expect(tools.filter((t) => t.name === DEFAULT_TOOLS[0].name)).toHaveLength(1)
    expect(tools).toHaveLength(DEFAULT_TOOLS.length + 2)
  })

  it('does not count a tool as kept when the defaults already hold it exactly', () => {
    useToolStore.setState({ tools: [{ ...DEFAULT_TOOLS[0] }] })
    useToolpathStore.getState().replaceOperations([opUsing(DEFAULT_TOOLS[0].id)])
    expect(planRestoreTools().kept).toEqual([])
  })

  it('a library that is already the defaults plans no change at all', () => {
    useToolStore.setState({ tools: DEFAULT_TOOLS.map((t) => ({ ...t })) })
    const plan = planRestoreTools()
    expect([plan.added, plan.removed, plan.kept]).toEqual([[], [], []])
  })

  it('a planned restore changes nothing until it is applied', () => {
    const before = useToolStore.getState().tools
    planRestoreTools()
    expect(useToolStore.getState().tools).toBe(before)
  })
})

describe('restoring the built-in post-processors', () => {
  it('resets edited built-ins, brings back deleted ones, and keeps the user\'s own', () => {
    const [first, second] = BUILTIN_PROFILES
    const mine = { ...first, id: 'pp-mine', name: 'My FluidNC', builtin: undefined }
    usePostProcessorStore.setState({ profiles: [{ ...first, startGcode: 'G90 (edited)' }, mine], activeId: 'pp-mine' })
    const plan = planRestoreBuiltins()
    expect(plan.reset).toEqual([first.name])
    expect(plan.returned).toContain(second.name)
    expect(plan.keptOwn).toEqual(['My FluidNC'])
    applyRestoreBuiltins(plan)
    const st = usePostProcessorStore.getState()
    expect(st.profiles.find((p) => p.id === first.id)?.startGcode).toBe(first.startGcode)
    expect(st.profiles).toHaveLength(BUILTIN_PROFILES.length + 1)
    expect(st.activeId).toBe('pp-mine')
  })

  it('reports nothing to reset when the built-ins are already factory', () => {
    usePostProcessorStore.setState({ profiles: BUILTIN_PROFILES.map((b) => ({ ...b })) })
    const plan = planRestoreBuiltins()
    expect([plan.reset, plan.returned, plan.keptOwn]).toEqual([[], [], []])
  })
})

describe('restoring the machine settings', () => {
  it('lists each changed setting as now → default, and resets only machine fields, not the stock', () => {
    const factory = useWorkpieceStore.getInitialState()
    useWorkpieceStore.setState({ maxFeedMmMin: 4321, spindleType: 'dewalt-compact', widthMM: 555 })
    const lines = planRestoreMachine()
    expect(lines).toContain(`Max feed: 4321 → ${factory.maxFeedMmMin} mm/min`)
    expect(lines).toContain(`Spindle type: dewalt-compact → ${factory.spindleType}`)
    applyRestoreMachine()
    expect(useWorkpieceStore.getState()).toMatchObject({ maxFeedMmMin: factory.maxFeedMmMin, spindleType: factory.spindleType, widthMM: 555 })
  })
})

describe('replacing from a settings file', () => {
  it('replaces the tool library with the file\'s, keeping tools in use', () => {
    useToolpathStore.getState().replaceOperations([opUsing('t1')])
    const file = parseSettings(JSON.stringify({ format: 'freazykam-settings', version: 1, sections: { tools: [myTool('f1', 'From file')] } }))
    expect(planToolReplace([myTool('f1', 'From file')]).kept).toEqual(['Mine A'])
    applySettings(file, ['tools'], { tools: 'replace' })
    expect(useToolStore.getState().tools.map((t) => t.name)).toEqual(['From file', 'Mine A'])
  })

  it('replaces the post-processors with the file\'s and makes one of them active', () => {
    const p = { ...BUILTIN_PROFILES[0], id: 'pp-x', name: 'Only one' }
    const file = parseSettings(JSON.stringify({ format: 'freazykam-settings', version: 1, sections: { postProcessors: { profiles: [p] } } }))
    applySettings(file, ['postProcessors'], { postProcessors: 'replace' })
    const st = usePostProcessorStore.getState()
    expect(st.profiles.map((x) => x.name)).toEqual(['Only one'])
    expect(st.activeId).toBe('pp-x')
  })
})
