// The folders inside an import in the paths list: the file's own grouping (`sourceGroups`,
// an SVG <g> or a DXF block per part), named as the file named it (`sourceGroupNames`).
//
// EVERY NAMED GROUP IS A FOLDER, even one holding a single path: a part with no label of
// its own (just an outline) is known by its name and nothing else, and the name is what
// assembly goes by. Showing a group of one as a bare row dropped exactly those names.
// The one level skipped is an UNNAMED group holding everything — an SVG wrapped in a
// single anonymous <g> would otherwise put the whole drawing one folder further down for
// nothing. A named one stays: a file of one part is that part, and its name still counts.

import type { ImportedPath } from '../store/pathsStore'

export interface SourceFolder {
  kind: 'folder'
  id: string
  name: string
  /** Every path at any depth inside — what the folder's eye, delete and click act on. */
  paths: ImportedPath[]
  items: SourceItem[]
}
export type SourceItem = SourceFolder | { kind: 'path'; path: ImportedPath }

/** `paths` as a tree of folders and rows, in document order. */
export function sourceTree(paths: ImportedPath[], depth = 0): SourceItem[] {
  // Skip every unnamed level at which a single group holds the lot.
  for (;;) {
    const first = paths[0]?.sourceGroups?.[depth]
    if (first === undefined || paths[0].sourceGroupNames?.[depth]) break
    if (!paths.every((p) => p.sourceGroups?.[depth] === first)) break
    depth++
  }
  const items: SourceItem[] = []
  const folderOf = new Map<string, { name: string; paths: ImportedPath[] }>()
  for (const p of paths) {
    const g = p.sourceGroups?.[depth]
    if (g === undefined) { items.push({ kind: 'path', path: p }); continue }
    let f = folderOf.get(g)
    if (!f) {
      f = { name: p.sourceGroupNames?.[depth] || 'Group', paths: [] }
      folderOf.set(g, f)
      // A placeholder, filled in below once the folder has all its paths.
      items.push({ kind: 'folder', id: g, name: f.name, paths: f.paths, items: [] })
    }
    f.paths.push(p)
  }
  return items.map((it) => (it.kind === 'path' ? it : { ...it, items: sourceTree(it.paths, depth + 1) }))
}
