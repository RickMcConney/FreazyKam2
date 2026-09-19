// Which autosave record is THIS tab's — surviving a reload, but not shared with a copy.
//
// The id lives in `sessionStorage` (see io/autosave.ts for why), and Chrome's
// "Duplicate tab" COPIES a tab's session storage: the copy boots holding the
// original's id, and the two would then overwrite each other's snapshot, which is
// the very fight the per-tab key exists to end. Nothing in the storage itself can
// tell the two apart, so a tab that inherited an id asks the other tabs whether one
// of them already has it, and takes a fresh id if one does.
//
// The copy still READS the inherited id — a duplicated tab opening a copy of the
// project is what "duplicate" means — and only writes under its own. So `inheritedId`
// is available at once for the boot-time read, and `id` settles once the question
// has been asked.
//
// A tab still asking gives way to ANY other tab holding its id, and only a settled
// tab answers. Two tabs booting at once (a restored session) may then both give way
// — which costs nothing: each has already read the snapshot, writes its own copy
// under its new id as soon as autosave arms, and the old record ages out.

export interface TabClaim {
  /** The id this tab booted with — what its snapshot, if any, was saved under. */
  inheritedId: string
  /** The id to write under from now on: `inheritedId`, unless a live tab already owns it. */
  id: Promise<string>
  /** Stop answering other tabs. The page keeps its claim open for its whole life. */
  close(): void
}

type Msg = { kind: 'who' | 'mine'; id: string }

export interface ClaimOptions {
  /** `null` when web storage is blocked: the tab gets a throwaway id and asks nobody. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  key: string
  channelName: string
  makeId: () => string
  /** How long to wait for an owner to answer. An answer arrives in a few ms. */
  waitMs?: number
}

export function claimTabId({ storage, key, channelName, makeId, waitMs = 150 }: ClaimOptions): TabClaim {
  let inherited: string | null = null
  try {
    inherited = storage ? storage.getItem(key) : null
  } catch { storage = null }
  if (!storage) {
    const id = makeId()
    return { inheritedId: id, id: Promise.resolve(id), close: () => {} }
  }

  let id = inherited ?? makeId()
  const inheritedId = id
  const remember = (v: string) => { try { storage!.setItem(key, v) } catch { /* see above */ } }
  if (!inherited) remember(id)

  let channel: BroadcastChannel | null = null
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null
  } catch { channel = null }
  if (!channel) return { inheritedId, id: Promise.resolve(id), close: () => {} }

  // A fresh id is nobody else's, so there is nothing to ask — only to answer.
  let probing = inherited !== null
  let settle: (v: string) => void = () => {}
  const settled = new Promise<string>((resolve) => { settle = resolve })
  let timer: ReturnType<typeof setTimeout> | undefined

  const finish = () => { probing = false; clearTimeout(timer); settle(id) }
  const yieldId = () => {
    id = makeId()
    remember(id)
    finish()
  }

  const ch = channel
  // A channel never hears its own posts, so every message here is another tab's.
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data
    if (!m || m.id !== id) return
    // A settled tab has been writing under this id and keeps it, telling the asker so.
    // A tab still asking gives way — to an owner's answer, or to another asker.
    if (!probing) {
      if (m.kind === 'who') ch.postMessage({ kind: 'mine', id } satisfies Msg)
    } else {
      yieldId()
    }
  }

  if (probing) {
    ch.postMessage({ kind: 'who', id } satisfies Msg)
    timer = setTimeout(finish, waitMs)
  } else {
    finish()
  }

  return { inheritedId, id: settled, close: () => { clearTimeout(timer); finish(); ch.close() } }
}
