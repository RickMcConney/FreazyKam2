// User groups: which paths the user has tied together, and what that means for
// selection. Pure and free of the store, so the canvas can run it on every click
// and so it can be tested (see ImportedPath.userGroups for the model — a chain,
// outermost first, because groups nest).
import type { ImportedPath } from '../importers/svgImporter'

// The outermost group this path belongs to — the thing a click on it selects.
// The rest of the chain is what Ungroup will reveal.
export function outerGroupOf(p: ImportedPath): string | undefined {
  return p.userGroups?.[0]
}

// Which group a path is listed and acted on UNDER. A path can carry both axes at
// once (a gear the user grouped with something else), and the user group is the
// outer one — so it wins, and the gear's own row is not also offered.
export function groupKeyOf(p: ImportedPath): string | undefined {
  return outerGroupOf(p) ?? p.groupId
}

export function inGroup(p: ImportedPath, groupId: string): boolean {
  return groupKeyOf(p) === groupId
}

// Selecting one member of a user group selects the whole group — that IS the
// group: one thing to click, drag and delete. Only the OUTERMOST group counts;
// an inner one is reached by ungrouping, not by clicking. Document order is
// preserved and no id is repeated; a selection touching no group comes back
// untouched.
export function expandUserGroups(ids: string[], paths: ImportedPath[]): string[] {
  const wanted = new Set(ids)
  const groups = new Set<string>()
  for (const p of paths) {
    const g = outerGroupOf(p)
    if (g && wanted.has(p.id)) groups.add(g)
  }
  if (groups.size === 0) return ids
  return paths
    .filter((p) => {
      const g = outerGroupOf(p)
      return wanted.has(p.id) || (g !== undefined && groups.has(g))
    })
    .map((p) => p.id)
}

// The OBJECTS a selection is made of — what "Scale each" scales about each one's own
// centre. A label drawn as five strokes is one object, not five: scaling each stroke
// about its own middle would leave the letters where they were and fatten them into
// each other.
//
// Strongest tie first: a user group, then a multi-part shape (a gear's parts are one
// gear), then the drawing's own grouping (`sourceGroups` — a DXF block, an SVG <g>),
// then one compound element the importer split (`sourceElement`), else the path alone.
//
// Source groups nest (a label block inside a part block), so the level that counts is
// the first one at which the selection SPLITS: a selection of every part's label splits
// at the part level and gives one object per part, while a selection of one whole
// part — outline at [part], label at [part, label] — never splits and is one object.
export function transformObjects(paths: ImportedPath[]): ImportedPath[][] {
  const sourced = paths.filter((p) => !outerGroupOf(p) && !shapeGroupOf(p) && p.sourceGroups?.length)
  let depth = 0
  for (;;) {
    const first = sourced[0]?.sourceGroups?.[depth]
    if (first === undefined || !sourced.every((p) => p.sourceGroups?.[depth] === first)) break
    depth++
  }
  const splits = new Set(sourced.map((p) => p.sourceGroups?.[depth]).filter((g) => g !== undefined)).size > 1
  const keyOf = (p: ImportedPath): string => {
    const u = outerGroupOf(p)
    if (u) return `u:${u}`
    const s = shapeGroupOf(p)
    if (s) return `s:${s}`
    const g = p.sourceGroups?.[splits ? depth : depth - 1]
    if (g !== undefined) return `g:${g}`
    if (p.sourceElement) return `e:${p.sourceElement}`
    return `p:${p.id}`
  }
  const byKey = new Map<string, ImportedPath[]>()
  for (const p of paths) {
    const k = keyOf(p)
    const list = byKey.get(k)
    if (list) list.push(p); else byKey.set(k, [p])
  }
  return [...byKey.values()]
}

// The group of a multi-part shape (gear, box, clock wheel) — its parts share one set of
// params, so they move as one.
function shapeGroupOf(p: ImportedPath): string | undefined {
  return p.groupId && p.shapePart !== undefined ? p.groupId : undefined
}
