import { describe, it, expect, afterEach } from 'vitest'
import { claimTabId, type TabClaim } from './tabClaim'

// Node has a real BroadcastChannel, delivered between instances in one process —
// which is all two tabs of one origin are to each other here.

const KEY = 'kam:autosaveTab'
let channel = 0
let open: TabClaim[] = []
afterEach(() => { for (const c of open) c.close(); open = [] })

/** One tab's sessionStorage. Duplicating a tab copies it. */
const storage = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
  }
}

let n = 0
const tab = (store: ReturnType<typeof storage>, channelName: string) => {
  const c = claimTabId({ storage: store, key: KEY, channelName, makeId: () => `id-${++n}`, waitMs: 50 })
  open.push(c)
  return c
}

describe('claimTabId', () => {
  it('gives a fresh tab a new id, remembered for its reloads', async () => {
    const name = `t${++channel}`
    const s = storage()
    const a = tab(s, name)
    expect(await a.id).toBe(a.inheritedId)
    expect(s.getItem(KEY)).toBe(a.inheritedId)
  })

  it('keeps the id across a reload when no other tab holds it', async () => {
    const name = `t${++channel}`
    const s = storage({ [KEY]: 'id-reloaded' })
    const a = tab(s, name)
    expect(a.inheritedId).toBe('id-reloaded')
    expect(await a.id).toBe('id-reloaded')
  })

  it('moves a duplicated tab to its own id, and leaves the original where it was', async () => {
    const name = `t${++channel}`
    const s = storage({ [KEY]: 'id-orig' })
    const orig = tab(s, name)
    expect(await orig.id).toBe('id-orig')

    // Chrome's Duplicate tab: the copy boots with a COPY of the session storage.
    const copyStore = storage({ [KEY]: 'id-orig' })
    const copy = tab(copyStore, name)
    // It reads the original's snapshot (a copy of the project)…
    expect(copy.inheritedId).toBe('id-orig')
    // …and writes under an id of its own, remembered for its own reloads.
    const mine = await copy.id
    expect(mine).not.toBe('id-orig')
    expect(copyStore.getItem(KEY)).toBe(mine)
    expect(s.getItem(KEY)).toBe('id-orig')
  })

  it('never leaves two tabs that boot at once sharing an id', async () => {
    // Either may give way — or both, which only orphans a record that ages out.
    const name = `t${++channel}`
    const a = tab(storage({ [KEY]: 'id-shared' }), name)
    const b = tab(storage({ [KEY]: 'id-shared' }), name)
    const ids = await Promise.all([a.id, b.id])
    expect(new Set(ids).size).toBe(2)
  })

  it('degrades to a throwaway id when storage is blocked', async () => {
    const a = claimTabId({ storage: null, key: KEY, channelName: `t${++channel}`, makeId: () => 'id-temp' })
    expect(a.inheritedId).toBe('id-temp')
    expect(await a.id).toBe('id-temp')
  })
})
