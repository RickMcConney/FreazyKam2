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
