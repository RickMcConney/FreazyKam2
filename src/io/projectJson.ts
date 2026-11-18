// The project as the .fkam JSON string, with each path's JSON cached on the path OBJECT.
// Paths are replaced, never mutated (store/CLAUDE.md), so an unchanged path's text — an
// STL or a photo is its base64 bytes, hundreds of MB — is serialised and hashed once and
// then reused by every later autosave. The result is exactly `JSON.stringify(data)`:
// an array stringifies as '[' + its elements' own JSON joined by ',' + ']', so splicing
// the cached fragments in where the paths go gives the same bytes. Pinned by
// projectJson.test.ts.

const frags = new WeakMap<object, { json: string; hash: string }>()

/** FNV-1a over the UTF-16 code units, with the length: a fingerprint, not a digest. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${s.length}:${(h >>> 0).toString(36)}`
}

function fragmentOf(p: object): { json: string; hash: string } {
  let f = frags.get(p)
  if (!f) {
    const json = JSON.stringify(p)
    f = { json, hash: fingerprint(json) }
    frags.set(p, f)
  }
  return f
}

// What stands in for the paths while the rest is stringified. Looked for together with its
// key: inside any JSON string a quote is escaped, so an unescaped `"paths":"…"` can only be
// the real key and this marker.
const MARK = '@@fkam:autosave:paths@@'

/**
 * `data` as JSON (byte-identical to `JSON.stringify(data)`), plus a fingerprint of it that
 * costs only the non-path part and one short line per path when the paths are unchanged.
 * Two equal payloads always give equal fingerprints; a change gives a different one but for
 * a hash collision, which an autosave can afford (it only skips a write).
 */
export function projectJson<T extends { paths: readonly object[] }>(data: T): { json: string; hash: string } {
  const rest = JSON.stringify({ ...data, paths: MARK })
  const anchor = '"paths":' + JSON.stringify(MARK)
  const at = rest.indexOf(anchor)
  if (at < 0) { const json = JSON.stringify(data); return { json, hash: fingerprint(json) } }   // not reachable: the key is always written
  const parts = data.paths.map(fragmentOf)
  const head = rest.slice(0, at + '"paths":'.length)
  const tail = rest.slice(at + anchor.length)
  const json = head + '[' + parts.map((f) => f.json).join(',') + ']' + tail
  const hash = `${fingerprint(head + tail)}/${parts.length}:${fingerprint(parts.map((f) => f.hash).join(','))}`
  return { json, hash }
}
