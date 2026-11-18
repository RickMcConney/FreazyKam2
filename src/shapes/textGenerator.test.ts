// Font loading: what happens when a fetch fails. Fonts come over the network (or out of the
// service worker's cache), so fetch is stubbed with the real font file from public/.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadFont, isFontLoaded } from './textGenerator'

afterEach(() => { vi.unstubAllGlobals() })

describe('loadFont', () => {
  it('tries again after a failed fetch instead of remembering the failure for the session', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (calls++ === 0) throw new TypeError('Failed to fetch')     // offline, once
      const bytes = readFileSync(`public${decodeURIComponent(url)}`)
      return new Response(bytes)
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadFont('Roboto')
    expect(isFontLoaded('Roboto')).toBe(false)
    await loadFont('Roboto')
    expect(isFontLoaded('Roboto')).toBe(true)
    expect(calls).toBe(2)
  })
})
