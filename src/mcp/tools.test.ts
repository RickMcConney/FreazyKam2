import { describe, it, expect, vi } from 'vitest'

vi.mock('../cam/regenerate') // it reaches for the worker pool

const { TOOLS } = await import('./tools')
const { commands } = await import('./commands')
const { TOOLPATH_KINDS } = await import('../panels/machine/toolpathKinds')

describe('the tools the tab declares to the MCP server', () => {
  it('every declared tool runs a command of the same name', () => {
    expect(TOOLS.map((t) => t.name).filter((n) => !(n in commands))).toEqual([])
  })

  it('every command but status is declared — status is the server\'s own get_status', () => {
    const declared = new Set(TOOLS.map((t) => t.name))
    expect(Object.keys(commands).filter((c) => c !== 'status' && !declared.has(c))).toEqual([])
  })

  it('no tool claims get_status, which the server answers itself while no tab is connected', () => {
    expect(TOOLS.map((t) => t.name)).not.toContain('get_status')
  })

  it('every tool takes an object, as MCP requires', () => {
    expect(TOOLS.filter((t) => t.inputSchema.type !== 'object').map((t) => t.name)).toEqual([])
  })

  it('create_toolpath offers every type in the registry, and documents every setting of each', () => {
    const create = TOOLS.find((t) => t.name === 'create_toolpath')!
    const type = (create.inputSchema.properties as Record<string, { enum: string[] }>).type
    expect(type.enum).toEqual(Object.keys(TOOLPATH_KINDS))
    for (const kind of Object.values(TOOLPATH_KINDS)) {
      for (const key of Object.keys(kind.settings)) expect(create.description).toContain(`    ${key} (`)
    }
  })
})
