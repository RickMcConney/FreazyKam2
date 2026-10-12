import { describe, it, expect, vi } from 'vitest'

// The load-time merge lives on the store's persist API, which zustand only attaches when
// there is a storage to persist to — node has none, so give it one before the store loads.
vi.hoisted(() => {
  const mem = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
  }
})

import { usePostProcessorStore, BUILTIN_PROFILES, linksAsRapids, type PostProcessorProfile } from './postProcessorStore'

// The load-time merge of saved profiles with the shipped presets.
const merge = (persisted: unknown) => {
  const opts = usePostProcessorStore.persist.getOptions()
  return opts.merge!(persisted, usePostProcessorStore.getState()) as ReturnType<typeof usePostProcessorStore.getState>
}

describe('the FluidNC presets', () => {
  it('ships FluidNC in mm and inches, listed first, with links as straight-line rapids', () => {
    expect(BUILTIN_PROFILES[0].id).toBe('fluidnc-mm')
    const mm = BUILTIN_PROFILES.find((p) => p.id === 'fluidnc-mm')!
    const inch = BUILTIN_PROFILES.find((p) => p.id === 'fluidnc-in')!
    expect(mm.unitMode).toBe('mm')
    expect(inch.unitMode).toBe('in')
    expect(linksAsRapids(mm)).toBe(true)
    expect(linksAsRapids(inch)).toBe(true)
    // Manual tool change pauses rather than relying on an ATC being configured.
    expect(mm.toolChangeGcode).toContain('M0')
  })

  it('is what a new install starts on', () => {
    expect(merge(undefined).activeId).toBe('fluidnc-mm')
  })

  it('is added to an existing install without moving its selection or touching its own profiles', () => {
    // Saved before the FluidNC presets existed: the Grbl presets plus a profile of the user's.
    const mine: PostProcessorProfile = { ...BUILTIN_PROFILES.find((p) => p.id === 'grbl-mm')!, id: 'pp-mine', name: 'My Jackpot', builtin: undefined }
    const oldBuiltins = BUILTIN_PROFILES.filter((p) => !p.id.startsWith('fluidnc'))
    const saved = {
      profiles: [...oldBuiltins, mine],
      activeId: 'pp-mine',
      seededBuiltinIds: oldBuiltins.map((p) => p.id),
    }
    const s = merge(saved)
    expect(s.activeId).toBe('pp-mine')
    expect(s.profiles.find((p) => p.id === 'pp-mine')).toEqual(mine)
    expect(s.profiles.some((p) => p.id === 'fluidnc-mm')).toBe(true)
    expect(s.profiles.some((p) => p.id === 'fluidnc-in')).toBe(true)
  })

  it('stays gone once a user has deleted it', () => {
    const saved = {
      profiles: BUILTIN_PROFILES.filter((p) => p.id !== 'fluidnc-in'),
      activeId: 'fluidnc-mm',
      seededBuiltinIds: BUILTIN_PROFILES.map((p) => p.id),
    }
    expect(merge(saved).profiles.some((p) => p.id === 'fluidnc-in')).toBe(false)
  })
})
