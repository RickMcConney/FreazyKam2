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

import { usePostProcessorStore, BUILTIN_PROFILES, linksAsRapids, profilePrint, type PostProcessorProfile } from './postProcessorStore'

// The load-time merge of saved profiles with the shipped presets.
const merge = (persisted: unknown) => {
  const opts = usePostProcessorStore.persist.getOptions()
  return opts.merge!(persisted, usePostProcessorStore.getState()) as ReturnType<typeof usePostProcessorStore.getState>
}

// What a save writes, for the state after a merge or an edit.
const saved = (state: ReturnType<typeof usePostProcessorStore.getState>) =>
  usePostProcessorStore.persist.getOptions().partialize!(state) as ReturnType<typeof usePostProcessorStore.getState>

describe('a built-in the user already has, when a new version ships', () => {
  const factory = BUILTIN_PROFILES[0]
  // An older release of the first preset, as a browser saved it.
  const older: PostProcessorProfile = { ...factory, endGcode: 'M30 (older release)' }
  const others = BUILTIN_PROFILES.slice(1)
  const install = (mine: PostProcessorProfile, prints?: Record<string, string>) => ({
    profiles: [mine, ...others],
    activeId: mine.id,
    seededBuiltinIds: BUILTIN_PROFILES.map((p) => p.id),
    ...(prints ? { builtinPrints: prints } : {}),
  })

  it('reaches a copy that was never edited, in the same place in the list', () => {
    const s = merge(install(older, { [older.id]: profilePrint(older) }))
    expect(s.profiles[0]).toEqual(factory)
    expect(s.activeId).toBe(factory.id)
    expect(s.updatedBuiltins).toEqual([factory.name])
  })

  it('reaches it when only the name changed', () => {
    const renamed = { ...factory, name: 'Older name' }
    expect(merge(install(renamed, { [renamed.id]: profilePrint(renamed) })).profiles[0].name).toBe(factory.name)
  })

  it('leaves a copy the user edited exactly as they left it', () => {
    const edited = { ...older, startGcode: 'G90 (mine)' }
    const s = merge(install(edited, { [edited.id]: profilePrint(older) }))
    expect(s.profiles[0]).toEqual(edited)
    expect(s.updatedBuiltins).toEqual([])
  })

  it('leaves a copy from before fingerprints alone, there being no way to tell if it was edited', () => {
    const s = merge(install(older))
    expect(s.profiles[0]).toEqual(older)
    expect(s.updatedBuiltins).toEqual([])
  })

  it('announces nothing for a copy that is already current', () => {
    expect(merge(install(factory, { [factory.id]: profilePrint(factory) })).updatedBuiltins).toEqual([])
  })

  it('does not bring back a preset the user deleted', () => {
    const s = merge({ profiles: others, activeId: others[0].id, seededBuiltinIds: BUILTIN_PROFILES.map((p) => p.id), builtinPrints: {} })
    expect(s.profiles.some((p) => p.id === factory.id)).toBe(false)
  })

  it('never touches a profile of the user\'s own, whatever it is called', () => {
    const mine = { ...older, id: 'pp-mine', builtin: undefined }
    const s = merge({ ...install(older), profiles: [mine, ...others, older], builtinPrints: { 'pp-mine': profilePrint(mine) } })
    expect(s.profiles[0]).toEqual(mine)
  })

  it('remembers an up-to-date copy, so an install from before fingerprints joins in from now on', () => {
    const s = saved(merge(install(factory)))
    expect(s.builtinPrints[factory.id]).toBe(profilePrint(factory))
  })

  it('keeps an edited copy marked as edited across saves, so it can never pass as untouched', () => {
    const edited = { ...older, startGcode: 'G90 (mine)' }
    const s = saved(merge(install(edited, { [edited.id]: profilePrint(older) })))
    expect(s.builtinPrints[factory.id]).toBe(profilePrint(older))
  })

  it('counts a Reset as untouched again: a copy restored to factory takes later versions', () => {
    const edited = { ...older, startGcode: 'G90 (mine)' }
    const after = merge(install(edited, { [edited.id]: profilePrint(older) }))
    const s = saved({ ...after, profiles: [{ ...factory }, ...others] })
    expect(s.builtinPrints[factory.id]).toBe(profilePrint(factory))
  })

  it('does not save the list of names to announce, or it would announce them on every load', () => {
    expect('updatedBuiltins' in saved(merge(install(older, { [older.id]: profilePrint(older) })))).toBe(false)
  })
})

describe('a profile\'s fingerprint', () => {
  const p = BUILTIN_PROFILES[0]

  it('does not depend on the order a save wrote the keys in', () => {
    const shuffled = Object.fromEntries(Object.entries(p).reverse()) as unknown as PostProcessorProfile
    expect(profilePrint(shuffled)).toBe(profilePrint(p))
  })

  it('changes with any G-code', () => {
    expect(profilePrint({ ...p, endGcode: `${p.endGcode}\nM2` })).not.toBe(profilePrint(p))
  })

  it('tells a stated default from a field a save left out only when it has a value', () => {
    expect(profilePrint({ ...p, thumbnails: undefined })).toBe(profilePrint(p))
  })
})

describe('the LowRider 4 preset', () => {
  const lr = BUILTIN_PROFILES.find((p) => p.id === 'lowrider4-mm')!

  it('ships in mm, right after the stock FluidNC presets, which stay first', () => {
    expect(BUILTIN_PROFILES.map((p) => p.id).slice(0, 3)).toEqual(['fluidnc-mm', 'fluidnc-in', 'lowrider4-mm'])
    expect(lr.name).toBe('LowRider (mm)')
    expect(lr.unitMode).toBe('mm')
  })

  it('runs its links as rapids, being FluidNC underneath', () => {
    expect(linksAsRapids(lr)).toBe(true)
  })

  it('switches the router on pin 27 and probes Z, at the start and at every tool change', () => {
    expect(lr.startGcode).toContain('G38.2 Z-110 F200 P0.5')
    expect(lr.startGcode).toContain('M62 P1')
    expect(lr.toolChangeGcode.indexOf('M63 P1')).toBeLessThan(lr.toolChangeGcode.indexOf('G38.2'))
    expect(lr.toolChangeGcode.indexOf('G38.2')).toBeLessThan(lr.toolChangeGcode.indexOf('M62 P1'))
    expect(lr.endGcode).toContain('M63 P1')
  })

  it('probes at one spot, so every tool is zeroed against the same surface', () => {
    const spot = /G0 (X\S+ Y\S+) F/
    expect(lr.startGcode.match(spot)?.[1]).toBe('X10 Y10')
    expect(lr.toolChangeGcode.match(spot)?.[1]).toBe('X10 Y10')
  })

  it('names the new bit in the tool change prompt', () => {
    expect(lr.toolChangeGcode).toContain('{tool}')
  })

  it('reaches an existing install at the end of its list, leaving its selection alone', () => {
    const others = BUILTIN_PROFILES.filter((p) => p.id !== 'lowrider4-mm')
    const s = merge({ profiles: others, activeId: 'grbl-mm', seededBuiltinIds: others.map((p) => p.id) })
    expect(s.activeId).toBe('grbl-mm')
    expect(s.profiles[s.profiles.length - 1].id).toBe('lowrider4-mm')
  })
})

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
