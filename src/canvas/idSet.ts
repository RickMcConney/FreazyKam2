/**
 * One Set of ids per ids ARRAY, handed out again for the same array. A drag builds a new
 * LiveTransform on every frame from the same gesture-long id list; with the same Set each
 * time, a reader can tell "the same paths are moving" by identity instead of re-walking
 * every path (DesignLayer's moving key). The Set must not be mutated by anyone holding it.
 */
const cache = new WeakMap<readonly string[], Set<string>>()

export function idSet(ids: readonly string[]): Set<string> {
  let s = cache.get(ids)
  if (!s) { s = new Set(ids); cache.set(ids, s) }
  return s
}
