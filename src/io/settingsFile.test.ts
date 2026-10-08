import { describe, it, expect, vi } from 'vitest'

vi.mock('../cam/regenerate')

import { buildSettings, applySettings, planMerge } from './settingsFile'
import { parseSettings } from './settingsMerge'
import { useToolStore } from '../store/toolStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useWorkpieceStore } from '../store/workpieceStore'

describe('settings file round trip', () => {
  it('brings back replaced machine settings exactly as they were exported', () => {
    useWorkpieceStore.setState({ maxFeedMmMin: 4321, spindleType: 'dewalt-compact' })
    const file = parseSettings(buildSettings())
    useWorkpieceStore.setState({ maxFeedMmMin: 1000, spindleType: 'vfd' })
    applySettings(file, ['machine'])
    expect(useWorkpieceStore.getState()).toMatchObject({ maxFeedMmMin: 4321, spindleType: 'dewalt-compact' })
  })

  it('leaves a section alone unless it was chosen', () => {
    const file = parseSettings(buildSettings())
    useWorkpieceStore.setState({ maxFeedMmMin: 1234 })
    applySettings(file, ['tools'])
    expect(useWorkpieceStore.getState().maxFeedMmMin).toBe(1234)
  })

  it('adds a changed tool beside the user\'s own instead of overwriting it', () => {
    const file = parseSettings(buildSettings())
    const [first] = useToolStore.getState().tools
    useToolStore.getState().updateTool(first.id, { diameterMM: 9.99 })
    const before = useToolStore.getState().tools.length
    const lines = applySettings(file, ['tools'])
    const tools = useToolStore.getState().tools
    expect(tools.find((t) => t.id === first.id)?.diameterMM).toBe(9.99)
    expect(tools).toHaveLength(before + 1)
    expect(tools[tools.length - 1]).toMatchObject({ name: `${first.name} (imported)`, diameterMM: first.diameterMM })
    expect(lines[0]).toMatch(/1 brought in as a copy/)
  })

  it('the preview changes nothing, and names exactly what the import then adds', () => {
    const file = parseSettings(JSON.stringify({ format: 'freazykam-settings', version: 1, sections: { tools: [
      { ...useToolStore.getState().tools[0], id: 'x1', name: 'Preview Bit A' },
      { ...useToolStore.getState().tools[0], id: 'x2', name: 'Preview Bit B' },
    ] } }))
    const before = useToolStore.getState().tools
    const plan = planMerge(file, 'tools')
    expect(useToolStore.getState().tools).toBe(before)
    expect(plan.added).toEqual(['Preview Bit A', 'Preview Bit B'])
    applySettings(file, ['tools'])
    expect(useToolStore.getState().tools.slice(before.length).map((t) => t.name)).toEqual(plan.added)
  })

  it('re-importing a library saved by an older build adds nothing, though its tools carry fields this build dropped', () => {
    const legacy = useToolStore.getState().tools.map((t) => ({ ...t, direction: 'climb', stepDownMM: 3 }))
    useToolStore.setState({ tools: legacy })
    const file = parseSettings(buildSettings())
    applySettings(file, ['tools'])
    expect(useToolStore.getState().tools).toHaveLength(legacy.length)
  })

  it('imports a shared post-processor and shows it, and a second import of the same file adds nothing', () => {
    const shared = { ...usePostProcessorStore.getState().profiles[0], id: 'pp-friend', name: 'Friend\'s FluidNC', startGcode: 'G21 G90\nM62 P0', builtin: true }
    const file = parseSettings(JSON.stringify({ format: 'freazykam-settings', version: 1, sections: { postProcessors: { profiles: [shared] } } }))
    applySettings(file, ['postProcessors'])
    const st = usePostProcessorStore.getState()
    const got = st.profiles.find((p) => p.name === 'Friend\'s FluidNC')
    expect(got).toMatchObject({ startGcode: 'G21 G90\nM62 P0' })
    expect(got?.builtin).toBeUndefined()
    expect(st.activeId).toBe(got?.id)
    const n = st.profiles.length
    applySettings(file, ['postProcessors'])
    expect(usePostProcessorStore.getState().profiles).toHaveLength(n)
  })

  it('leaves out a post-processor missing a template it needs, rather than writing half a program', () => {
    const { cutTemplate: _c, ...broken } = { ...usePostProcessorStore.getState().profiles[0], id: 'pp-broken', name: 'Broken' }
    const file = parseSettings(JSON.stringify({ format: 'freazykam-settings', version: 1, sections: { postProcessors: { profiles: [broken] } } }))
    applySettings(file, ['postProcessors'])
    expect(usePostProcessorStore.getState().profiles.some((p) => p.name === 'Broken')).toBe(false)
  })
})
