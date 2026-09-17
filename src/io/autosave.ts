import { buildProjectData } from './projectSave'
import { loadProject, type ProjectData } from './projectLoad'
import { useConstraintsStore } from '../store/constraintsStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useTabStore } from '../store/tabStore'
import { useProjectStore } from '../store/projectStore'
import { useTimelineStore } from '../timeline/timelineStore'

// ─────────────────────────────────────────────────────────────────────────────
// Crash / tab-discard recovery.
//
// The document stores (paths, toolpaths, tabs, timeline, project) are NOT
// persisted — only the machine-local ones (ui, workpiece, tools, post-
// processors, form defaults) are, so any page load comes back with the stock
// and the tool library intact and the drawing gone. That reads as "my paths
// vanished" rather than "the app restarted", which is what makes it alarming.
//
// The page load itself is usually not the user's doing: Chrome's Memory Saver
// discards background tabs under memory pressure and re-navigates the URL when
// you focus them again, and this app is a fat target for that heuristic (a live
// WebGL context, several Konva canvases plus the cut-trail raster, and a worker
// pool sized to hardwareConcurrency). The dev server's full-reload does the
// same thing.
//
// So: mirror buildProjectData() into IndexedDB, and PUT IT BACK on boot — not
// offer it back. There was a modal asking first, and the question had only one
// answer: the snapshot exists because the session ended without the user's say-
// so, so it stood between them and their own work with an empty screen as the
// only alternative. New Project is the way to an empty screen, and always was.
//
// IndexedDB, not localStorage: a project with any real number of paths blows
// past the ~5 MB localStorage quota, and localStorage writes are synchronous on
// the main thread.
//
// visibilitychange is the hook that matters. `beforeunload` does NOT fire when
// a tab is discarded, and by the time `freeze` fires the page can no longer
// finish async work. `visibilitychange → hidden` fires the moment you switch
// away — minutes before any discard — which leaves the IDB write all the time
// it needs.
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'freazykam'
const DB_VERSION = 1
const STORE = 'autosave'
/** Every snapshot written before the store was keyed per tab. */
const LEGACY_KEY = 'session'
/** Where a tab remembers which snapshot is its own. */
const TAB_ID_KEY = 'kam:autosaveTab'
/** A record nothing has rewritten in this long belongs to a tab that is gone. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// ─── One snapshot per TAB ────────────────────────────────────────────────────
//
// Two projects open side by side is a real way to work — it is how a shape is
// copied from one to another, the clipboard carrying the app's own objects
// across (io/pathClipboard.ts) — and one shared key made the two tabs fight over
// it: whichever edited last owned the snapshot, and a reload in the other one
// replaced its project with its neighbour's.
//
// The key is therefore a TAB id held in `sessionStorage`, which is exactly the
// scope wanted and the only web storage that has it: private to one tab, and
// surviving both a reload and a discard (the browser keeps a discarded tab's
// session storage, which is what makes recovery from a discard work at all). A
// NEW tab gets a new id, finds no snapshot, and opens the empty project it was
// asked for.
//
// Two consequences worth knowing. A tab CLOSED with unsaved work leaves a record
// nothing will ever ask for again — reopening it with ctrl+shift+T brings the
// same session storage back and does restore it, but a fresh tab will not, by
// design. And such records are pruned by age rather than tracked: a live tab
// rewrites its own on the next edit, so pruning one costs nothing, while a dead
// tab's is landfill.

let tabIdCache: string | null = null

function tabKey(): string {
  if (tabIdCache) return tabIdCache
  let id: string | null = null
  try {
    id = sessionStorage.getItem(TAB_ID_KEY)
    if (!id) {
      id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      sessionStorage.setItem(TAB_ID_KEY, id)
    }
  } catch {
    // Storage blocked. A per-load id means this session protects nothing across
    // a reload — which is the same ground IndexedDB is almost certainly on in
    // that browser anyway. It degrades to "no recovery", never to "the wrong
    // project".
    id = `tab-noresume-${Math.random().toString(36).slice(2, 10)}`
  }
  tabIdCache = id
  return id
}

// Long enough that a drag or a burst of generation writes lands as one snapshot;
// short enough that little is lost. The flush on hide covers the tab-switch case
// regardless, so this only bounds what a hard crash costs.
const DEBOUNCE_MS = 3000

/** Everything the restore prompt needs, so boot never parses the payload. */
export interface SnapshotMeta {
  savedAt: number
  /** Was the document unsaved when this was written? A clean one is not offered back. */
  dirty: boolean
  name: string
  pathCount: number
  opCount: number
}

export type SnapshotRecord = SnapshotMeta & { json: string }

// ─── IndexedDB ───────────────────────────────────────────────────────────────
// Hand-rolled rather than a dependency: one store, one key, three operations.
// Every failure path resolves to null instead of rejecting — a browser with
// storage blocked (private mode, "block third-party cookies" on some setups)
// must lose autosave, not the app.

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

// Resolves on transaction COMPLETE, not on request success. A request succeeds
// before the transaction commits, and the whole point of the hide-flush is that
// the bytes are on disk before the tab is discarded — so the write is not done
// until the commit says so.
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDB().then((db) => {
    if (!db) return null
    return new Promise<T | null>((resolve) => {
      let result: T | null = null
      try {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => { result = req.result }
        t.oncomplete = () => resolve(result)
        // Quota exceeded lands here. Nothing to do but keep the old snapshot.
        t.onerror = () => resolve(null)
        t.onabort = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  })
}

export async function readSnapshot(): Promise<SnapshotRecord | null> {
  const mine = await tx<SnapshotRecord>('readonly', (s) => s.get(tabKey()) as IDBRequest<SnapshotRecord>)
  if (mine) return mine
  // THE PRE-TAB RECORD IS ADOPTED ONCE, by whichever tab boots first after the
  // upgrade, and then deleted so no second tab picks it up. Without this the
  // change to per-tab keys would silently throw away whatever was in flight when
  // the app was updated — the one moment this whole file exists to protect.
  const legacy = await tx<SnapshotRecord>('readonly', (s) => s.get(LEGACY_KEY) as IDBRequest<SnapshotRecord>)
  if (!legacy) return null
  await tx('readwrite', (s) => s.delete(LEGACY_KEY) as IDBRequest<undefined>)
  return legacy
}

export function clearSnapshot(): Promise<void> {
  return tx('readwrite', (s) => s.delete(tabKey()) as IDBRequest<undefined>).then(() => undefined)
}

/**
 * Drop the records of tabs that are never coming back.
 *
 * By AGE, and pruning a record whose tab is still open costs nothing: that tab
 * rewrites its own on the next edit. The cursor holds one record at a time
 * rather than `getAll()`, which would pull every payload — megabytes each — into
 * memory at once, in a tab that is being blamed for its memory use to begin
 * with.
 */
export function pruneSnapshots(): Promise<void> {
  return openDB().then((db) => {
    if (!db) return
    return new Promise<void>((resolve) => {
      try {
        const cutoff = Date.now() - MAX_AGE_MS
        const t = db.transaction(STORE, 'readwrite')
        const req = t.objectStore(STORE).openCursor()
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) return
          const rec = cur.value as SnapshotRecord | undefined
          if (rec && typeof rec.savedAt === 'number' && rec.savedAt < cutoff) cur.delete()
          cur.continue()
        }
        t.oncomplete = () => resolve()
        t.onerror = () => resolve()
        t.onabort = () => resolve()
      } catch { resolve() }
    })
  })
}

/** Parse a snapshot's payload back into the same shape a .fkam file carries. */
export function snapshotData(rec: SnapshotRecord): ProjectData {
  return JSON.parse(rec.json) as ProjectData
}

/**
 * Put a snapshot back into the document. Returns false if it could not be read.
 *
 * The caller says so in the status bar and arms autosave; this only touches the
 * document.
 */
export function applySnapshot(rec: SnapshotRecord): boolean {
  try {
    // No file name — the snapshot's own `name` is the authority, since it is the
    // name the project already had when it was lost.
    loadProject(snapshotData(rec))
    // loadProject marks the document clean — correct for a file on disk, wrong
    // here. This one matches nothing on disk, so it stays unsaved until the user
    // actually saves it; otherwise the next snapshot is written clean and a
    // second discard loses the work for good.
    useTimelineStore.getState().markUnsaved()
    return true
  } catch (err) {
    console.error('[autosave] restore failed', err)
    void clearSnapshot()
    return false
  }
}

/**
 * Did the browser THROW THIS TAB AWAY and reload it under us?
 *
 * Only the wording of the restore message turns on this — the restore happens
 * either way — but it is worth naming, because a discard is the one ending the
 * user has no memory of at all: Chrome's Memory Saver does it to background tabs
 * under memory pressure, and this app is a fat target (a live WebGL context,
 * several Konva canvases and a worker pool per core).
 *
 * Chrome and Edge only; everywhere else it reads false and the message says
 * "your last session", which is true whatever ended it.
 */
export function tabWasDiscarded(): boolean {
  return (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true
}

// ─── The autosave loop ───────────────────────────────────────────────────────

// Writes are gated until boot has read the snapshot back. Without this, mounting
// over a fresh empty document would immediately overwrite the very snapshot that
// is about to be restored.
let armed = false
let timer: ReturnType<typeof setTimeout> | undefined
let writing = false
let pending = false
// Fingerprint of the last payload written, so an unchanged document is not
// re-written. buildProjectData strips computed segments and flattens status, so
// every snapshot taken during a long generation is byte-identical to the one
// taken before it started — and the worker reports progress often enough that
// this would otherwise push the whole project to disk repeatedly for nothing.
// A hash rather than the string itself: holding a second copy of a multi-MB
// payload alive between writes is exactly the memory pressure that gets this
// tab discarded in the first place.
let lastHash = ''
/** `lastHash` for a document that has been emptied — see the flush below. */
const EMPTY = '::empty'

function fingerprint(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${s.length}:${(h >>> 0).toString(36)}`
}

export function armAutosave() {
  armed = true
}

async function flush() {
  if (!armed) return
  // One write at a time: a hide-flush landing on top of a debounce-flush would
  // otherwise race, and the loser could be the newer of the two.
  if (writing) { pending = true; return }
  writing = true
  try {
    const paths = usePathsStore.getState().paths
    // Once armed, an empty document means the user emptied it (New Project, or
    // deleting everything) — so drop the snapshot rather than restoring work on
    // the next boot that was deliberately abandoned. `schedule` sends this case
    // straight here rather than debouncing it, for the reason given there.
    if (documentIsEmpty()) {
      // New Project writes five stores in a row and every one of them schedules,
      // so this arrives several times over for one click. The sentinel makes the
      // rest no-ops — and it is a sentinel rather than '' because '' also means
      // "nothing written yet", and those two must not be confused after a load.
      if (lastHash === EMPTY) return
      lastHash = EMPTY
      await clearSnapshot()
      return
    }
    const data = buildProjectData() // already strips computed segments
    // The one real cost in here. Storing the object directly would skip it, but
    // structured clone would throw on anything non-cloneable that ever ends up
    // on a path, and a string is exactly the .fkam bytes — same format, no
    // second serialization path to keep in step.
    const json = JSON.stringify(data)
    const tl = useTimelineStore.getState()
    // `dirty` is part of the identity: a save changes nothing in the payload but
    // must still be recorded, or a saved project stays on offer as unsaved work.
    const hash = `${fingerprint(json)}:${tl.cursor !== tl.savedSeq}`
    if (hash === lastHash) return
    const rec: SnapshotRecord = {
      savedAt: Date.now(),
      dirty: tl.cursor !== tl.savedSeq,
      name: data.name,
      pathCount: paths.length,
      opCount: useToolpathStore.getState().operations.length,
      json,
    }
    await tx('readwrite', (s) => s.put(rec, tabKey()) as IDBRequest<IDBValidKey>)
    lastHash = hash
  } catch (err) {
    console.warn('[autosave] snapshot write failed', err)
  } finally {
    writing = false
    if (pending) { pending = false; void flush() }
  }
}

type Watchable<T> = { subscribe: (l: (s: T, p: T) => void) => () => void }

/** Fire `onChange` only when `pick` actually changes identity. */
function watch<T>(store: Watchable<T>, pick: (s: T) => unknown, onChange: () => void) {
  return store.subscribe((s, p) => { if (pick(s) !== pick(p)) onChange() })
}

/** Is there anything left to come back to? */
function documentIsEmpty(): boolean {
  return usePathsStore.getState().paths.length === 0
    && useToolpathStore.getState().operations.length === 0
}

export function installAutosave(): () => void {
  const schedule = () => {
    if (!armed) return
    clearTimeout(timer)
    // AN EMPTIED DOCUMENT IS FLUSHED AT ONCE, never in three seconds' time.
    // Emptying it — New Project, or deleting everything — is the one edit whose
    // entire meaning is "there is nothing here to come back to", and the
    // commonest thing to do immediately afterwards is reload. That reload beat
    // the debounce, and the `pagehide` flush behind it is an async IndexedDB
    // delete racing the page's own teardown, which it loses: the abandoned
    // project came back from the dead on the next boot. Writing takes as long as
    // it takes, but the DELETE has to be already in flight before the user's
    // hand reaches F5.
    if (documentIsEmpty()) { void flush(); return }
    timer = setTimeout(() => { void flush() }, DEBOUNCE_MS)
  }

  const unsubs = [
    watch(usePathsStore, (s) => s.paths, schedule),
    watch(useToolpathStore, (s) => s.operations, schedule),
    watch(useTabStore, (s) => s.tabs, schedule),
    // A constraint edit can move nothing at all (deleting one, or adding one at
    // the distance the parts already stand at), so the paths watch above would
    // miss it and the snapshot would go stale in exactly the case where the
    // user has changed the document and can see no difference.
    watch(useConstraintsStore, (s) => s.constraints, schedule),
    watch(useProjectStore, (s) => s.name, schedule),
    // Not a document change, but it flips `dirty` — rewrite so a project saved
    // and then discarded is not offered back as unsaved work.
    watch(useTimelineStore, (s) => s.savedSeq, schedule),
  ]
  // Workpiece and tools are deliberately not watched: both are persisted to
  // localStorage on their own, so they survive the reload that loses everything
  // else, and buildProjectData picks up their current values on the next write.

  const onHide = () => {
    if (document.visibilityState !== 'hidden') return
    clearTimeout(timer)
    void flush()
  }
  const onPageHide = () => { clearTimeout(timer); void flush() }

  document.addEventListener('visibilitychange', onHide)
  window.addEventListener('pagehide', onPageHide)

  return () => {
    armed = false
    clearTimeout(timer)
    for (const u of unsubs) u()
    document.removeEventListener('visibilitychange', onHide)
    window.removeEventListener('pagehide', onPageHide)
  }
}
