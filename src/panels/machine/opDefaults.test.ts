import { describe, it, expect, beforeEach } from 'vitest'
import { savedProfileFor, profileSaveKeys, PROFILE_KEY, profileSideKey } from './opDefaults'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import type { CutSide } from '../../store/toolpathStore'

// The two jobs the per-side settings exist for: lettering on the centerline with a V-bit
// 1 mm deep, and cutting the part free on the outside with an end mill at full depth.
const lettering = { side: 'centerline' as CutSide, toolId: 'vbit', depthMM: 1 }
const cutOut = { side: 'outside' as CutSide, toolId: 'endmill-3', depthMM: 6 }

/** A store holding exactly `saved`, as `formDefaultsStore.load` reads it. */
const loader = (saved: Record<string, Record<string, unknown>>) => (key: string) => saved[key] ?? null

describe('a profile\'s saved settings are kept per cut side (savedProfileFor)', () => {
  it('has nothing to offer before any profile has been generated', () => {
    const load = loader({})
    expect(savedProfileFor(load)).toBeNull()
    expect(savedProfileFor(load, 'outside')).toBeNull()
  })

  it('gives each side its own settings, whichever side was generated last', () => {
    // Centerline then outside: outside is the last generated, but centerline keeps its own.
    const load = loader({ [profileSideKey('centerline')]: lettering, [profileSideKey('outside')]: cutOut, [PROFILE_KEY]: cutOut })
    expect(savedProfileFor(load, 'centerline')).toEqual(lettering)
    expect(savedProfileFor(load, 'outside')).toEqual(cutOut)
  })

  it('opens a new form on the side generated last, with that side\'s settings', () => {
    const load = loader({ [profileSideKey('centerline')]: lettering, [profileSideKey('outside')]: cutOut, [PROFILE_KEY]: lettering })
    expect(savedProfileFor(load)).toEqual(lettering)
  })

  it('has nothing for a side never generated, even when another side has settings', () => {
    // So switching to it keeps what the form shows rather than jumping to factory defaults.
    const load = loader({ [profileSideKey('outside')]: cutOut, [PROFILE_KEY]: cutOut })
    expect(savedProfileFor(load, 'inside')).toBeNull()
  })

  describe('settings saved before they were kept per side', () => {
    const load = loader({ [PROFILE_KEY]: cutOut })

    it('belong to the side they were saved on', () => {
      expect(savedProfileFor(load, 'outside')).toEqual(cutOut)
      expect(savedProfileFor(load)).toEqual(cutOut)
    })

    it('do not stand in for a different side', () => {
      expect(savedProfileFor(load, 'centerline')).toBeNull()
    })
  })

  it('prefers a side\'s own settings over older ones saved on the same side', () => {
    const older = { ...cutOut, depthMM: 12 }
    const load = loader({ [PROFILE_KEY]: older, [profileSideKey('outside')]: cutOut })
    expect(savedProfileFor(load, 'outside')).toEqual(cutOut)
  })
})

describe('a profile Generate saves its settings (profileSaveKeys)', () => {
  it('under the last-used key and under its own side', () => {
    expect(profileSaveKeys(lettering)).toEqual([PROFILE_KEY, profileSideKey('centerline')])
  })

  describe('through the real defaults store', () => {
    beforeEach(() => useFormDefaultsStore.setState({ defaults: {} }))
    const generate = (form: { side: CutSide; toolId: string; depthMM: number }) => {
      for (const key of profileSaveKeys(form)) useFormDefaultsStore.getState().save(key, form)
    }
    const load = (key: string) => useFormDefaultsStore.getState().load(key)

    it('brings back each side\'s bit and depth after generating both', () => {
      generate(lettering)
      generate(cutOut)
      expect(savedProfileFor(load, 'centerline')).toEqual(lettering)
      expect(savedProfileFor(load, 'outside')).toEqual(cutOut)
      expect(savedProfileFor(load)).toEqual(cutOut)
    })

    it('replaces a side\'s settings when that side is generated again', () => {
      generate(lettering)
      generate({ ...lettering, depthMM: 0.5 })
      expect(savedProfileFor(load, 'centerline')).toEqual({ ...lettering, depthMM: 0.5 })
    })
  })
})
