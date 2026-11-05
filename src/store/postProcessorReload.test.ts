import { describe, it, expect, vi, beforeEach } from 'vitest'

// Real loads against real storage. The merge is pinned in postProcessorStore.test.ts, but a
// merge's result only counts once it is SAVED, and zustand does not save after a load.
const mem = vi.hoisted(() => {
  const mem = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
  }
  return mem
})

const KEY = 'freazykam-postprocessors'
const load = async () => {
  vi.resetModules()
  return import('./postProcessorStore')
}
const stored = () => JSON.parse(mem.get(KEY)!).state

describe('loading the app against saved profiles', () => {
  beforeEach(() => mem.clear())

  async function olderInstall() {
    const { BUILTIN_PROFILES, profilePrint } = await load()
    const older = { ...BUILTIN_PROFILES[0], endGcode: 'M30 (older release)' }
    mem.set(KEY, JSON.stringify({
      state: {
        profiles: [older, ...BUILTIN_PROFILES.slice(1)],
        activeId: older.id,
        seededBuiltinIds: BUILTIN_PROFILES.map((p) => p.id),
        builtinPrints: { [older.id]: profilePrint(older) },
      },
      version: 0,
    }))
    return BUILTIN_PROFILES[0]
  }

  it('writes an updated preset back, so the update lands once', async () => {
    const factory = await olderInstall()
    const first = await load()
    expect(first.usePostProcessorStore.getState().updatedBuiltins).toEqual([factory.name])
    expect(stored().profiles[0].endGcode).toBe(factory.endGcode)
  })

  it('announces an update on one load only', async () => {
    await olderInstall()
    await load()
    const second = await load()
    expect(second.usePostProcessorStore.getState().updatedBuiltins).toEqual([])
  })

  it('records an up-to-date install from before fingerprints on its first load', async () => {
    const { BUILTIN_PROFILES, profilePrint } = await load()
    mem.set(KEY, JSON.stringify({
      state: { profiles: BUILTIN_PROFILES, activeId: BUILTIN_PROFILES[0].id, seededBuiltinIds: BUILTIN_PROFILES.map((p) => p.id) },
      version: 0,
    }))
    await load()
    expect(stored().builtinPrints[BUILTIN_PROFILES[0].id]).toBe(profilePrint(BUILTIN_PROFILES[0]))
  })

  it('leaves the user\'s selection where it was', async () => {
    const factory = await olderInstall()
    const { usePostProcessorStore } = await load()
    expect(usePostProcessorStore.getState().activeId).toBe(factory.id)
  })
})
