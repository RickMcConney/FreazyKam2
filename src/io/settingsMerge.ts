// The pure half of the settings file (`.fkset`, see settingsFile.ts): what it holds,
// how one is recognised, and how its tools and post-processors join the user's own.
// No stores here, so all of it is testable as plain data.

export const SETTINGS_FORMAT = 'freazykam-settings'
export const SETTINGS_VERSION = 1

// The sections a settings file can carry, in the order the import dialog lists them.
// MERGE sections add to what the user has and never overwrite it; REPLACE sections are
// the user's one-of-a-kind state, so they can only be swapped whole — and start
// unticked on import, so a file a friend sent cannot quietly make their machine yours.
export const SETTINGS_SECTIONS = [
  { key: 'tools', label: 'Tool library', mode: 'merge' },
  { key: 'postProcessors', label: 'Post-processors', mode: 'merge' },
  { key: 'machine', label: 'Machine (limits, feeds & speeds, motion, spindle)', mode: 'replace' },
  { key: 'stock', label: 'Stock defaults (size, units, origin, material, safe height)', mode: 'replace' },
  { key: 'formDefaults', label: 'Last-used form values (what each form opens with)', mode: 'replace' },
  { key: 'machineTab', label: 'Machine tab (address, jog steps and feeds, limit switches, macros)', mode: 'replace' },
  { key: 'interface', label: 'Interface (dark mode and the like)', mode: 'replace' },
] as const

export type SectionKey = typeof SETTINGS_SECTIONS[number]['key']

export interface SettingsFile {
  format: typeof SETTINGS_FORMAT
  version: number
  savedAt: string
  build?: string
  sections: Partial<Record<SectionKey, unknown>>
}

export class SettingsFileError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Read a settings file, or say plainly what it is instead. A project and a settings
 * file are both JSON and both open from a picker, so each is told apart from the other
 * rather than reported as "damaged".
 */
export function parseSettings(text: string): SettingsFile {
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new SettingsFileError('this is not a FreazyKam settings file') }
  if (!isObj(data)) throw new SettingsFileError('this is not a FreazyKam settings file')
  if (data.format !== SETTINGS_FORMAT) {
    if (Array.isArray(data.paths) || Array.isArray(data.operations)) {
      throw new SettingsFileError('this is a project (.fkam) — open it with Open Project instead')
    }
    throw new SettingsFileError('this is not a FreazyKam settings file')
  }
  if (!isObj(data.sections)) throw new SettingsFileError('its settings are damaged')
  const sections: SettingsFile['sections'] = {}
  for (const { key } of SETTINGS_SECTIONS) if (data.sections[key] !== undefined) sections[key] = data.sections[key]
  return {
    format: SETTINGS_FORMAT,
    version: typeof data.version === 'number' ? data.version : SETTINGS_VERSION,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : '',
    build: typeof data.build === 'string' ? data.build : undefined,
    sections,
  }
}

/** True when `data` (parsed JSON) is a settings file — for the project loader to refuse it by name. */
export function isSettingsData(data: unknown): boolean {
  return isObj(data) && data.format === SETTINGS_FORMAT
}

// Everything but identity: two entries are the SAME thing when every field that
// matters matches, whatever order the keys were written in. `builtin` is a property of
// where a profile came from, not of what it does. With `keys`, only those fields count:
// a library saved by an older build still carries fields this one dropped (tools kept a
// `direction` and a `stepDownMM` for a while), and the import never brings those in —
// comparing them made every tool in a re-imported library read as changed, and the whole
// library came in a second time as copies.
function contentKey(v: Record<string, unknown>, keys?: readonly string[]): string {
  const rest = (keys ?? Object.keys(v)).filter((k) => k !== 'id' && k !== 'name' && k !== 'builtin').sort()
  return JSON.stringify(rest.map((k) => [k, v[k] ?? null]))
}

export interface MergeResult<T> {
  list: T[]
  added: string[]     // names brought in as they were
  copied: string[]    // names that clashed with a different entry, brought in renamed
  same: number        // entries already in the list exactly, skipped
}

/**
 * Join `incoming` to `existing` by NAME, never overwriting:
 * - same name and same contents — already there, skipped;
 * - same name, different contents — added as a copy, "<name> (imported)", so both
 *   stand side by side and the user decides which to keep;
 * - a new name — added as it is.
 * An added entry keeps its id unless the list already uses it, and is never `builtin`:
 * "reset to factory" belongs to the app's own presets, not to a copy of one.
 */
export function mergeByName<T extends { id: string; name: string; builtin?: boolean }>(
  existing: T[], incoming: T[], mintId: () => string, keys?: readonly string[],
): MergeResult<T> {
  const list = [...existing]
  const ids = new Set(list.map((e) => e.id))
  const names = new Set(list.map((e) => e.name))
  const result: MergeResult<T> = { list, added: [], copied: [], same: 0 }
  for (const inc of incoming) {
    const clash = list.filter((e) => e.name === inc.name)
    const want = contentKey(inc as Record<string, unknown>, keys)
    if (clash.some((e) => contentKey(e as Record<string, unknown>, keys) === want)) { result.same++; continue }
    let name = inc.name
    if (clash.length) {
      name = `${inc.name} (imported)`
      for (let n = 2; names.has(name); n++) name = `${inc.name} (imported ${n})`
    }
    const id = ids.has(inc.id) ? mintId() : inc.id
    const entry = { ...inc, id, name } as T
    if ('builtin' in entry) delete (entry as { builtin?: boolean }).builtin
    list.push(entry)
    ids.add(id); names.add(name)
    ;(clash.length ? result.copied : result.added).push(name)
  }
  return result
}

/**
 * The fields of `incoming` that `current` has, with the same type — so a replace
 * section from an older or newer build sets what both know about and leaves the rest,
 * and a damaged value cannot install a string where a number lives.
 */
export function pickKnown(current: Record<string, unknown>, incoming: unknown): Record<string, unknown> {
  if (!isObj(incoming)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in current) || typeof current[k] === 'function') continue
    const cur = current[k]
    if (typeof v !== typeof cur) continue
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    if (isObj(cur) !== isObj(v) || Array.isArray(cur) !== Array.isArray(v)) continue
    out[k] = v
  }
  return out
}

/**
 * `mergeByName`, a FOLDER at a time: an incoming entry is only ever compared with the
 * existing entries of its own folder (absent `folder` being the user's own, My Tools).
 * A vendor catalogue's "1/4" End Mill" is not a clash with the user's — they sit in
 * different folders, and neither is renamed for the other. Ids are unique across the
 * whole list, whichever folder they came in under. New entries are appended in the
 * order they came, so the existing list keeps its order.
 */
export function mergeIntoFolders<T extends { id: string; name: string; folder?: string; builtin?: boolean }>(
  existing: T[], incoming: T[], mintId: () => string, keys?: readonly string[],
): MergeResult<T> {
  const result: MergeResult<T> = { list: [...existing], added: [], copied: [], same: 0 }
  const ids = new Set(existing.map((e) => e.id))
  const folders = [...new Set(incoming.map((t) => t.folder ?? ''))]
  for (const folder of folders) {
    const mine = result.list.filter((e) => (e.folder ?? '') === folder)
    const inc = incoming
      .filter((t) => (t.folder ?? '') === folder)
      .map((t) => {
        const id = ids.has(t.id) ? mintId() : t.id
        ids.add(id)
        return id === t.id ? t : { ...t, id }
      })
    const r = mergeByName(mine, inc, mintId, keys)
    const fresh = r.list.slice(mine.length)
    result.list.push(...fresh)
    result.added.push(...r.added)
    result.copied.push(...r.copied)
    result.same += r.same
  }
  return result
}
