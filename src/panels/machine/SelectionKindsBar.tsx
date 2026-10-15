// Narrow the selection by what its paths ARE: by the LAYER the drawing's author put them on
// (a DXF layer, an SVG stroke colour — see importers/layers.ts), or by the outline / hole /
// label reading of their geometry (selectionKinds) for a file that says nothing.
//
// It works on the CANVAS SELECTION rather than as a filter inside each form, because every
// path-driven form already reads the selection — and in an edit, the selection IS the batch
// being revised (reviseBatch). A filter of its own in each form would have been four copies
// of hidden state the canvas does not show; narrowing the selection shows exactly what the
// next Generate will cut, and every form follows it with nothing to wire up.
//
// The bar remembers the selection it narrowed so ↺ All can put it back. That memory lasts
// only while the selection is still the one the bar made: select anything else and the bar
// reads the new selection afresh. Chosen buttons combine as a UNION, across both rows.

import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { ICON } from '../../theme'
import { layerLabel } from '../../importers/layers'
import { classifyPaths, narrowingHolds, PATH_KIND_ORDER, type PathKind } from './selectionKinds'
import { isListSelection } from './pathExclusion'

const KIND_LABEL: Record<PathKind, string> = { outline: 'Outlines', hole: 'Holes', label: 'Labels', other: 'Other' }
const KIND_HINT: Record<PathKind, string> = {
  outline: 'Closed shapes nothing else in the selection contains — the part edges',
  hole: 'Closed shapes inside a part that are not lettering — circles and cutouts',
  label: 'Open strokes, and the closed letters set among them',
  other: 'Images, models and paths with nothing drawn',
}

/** `kind:outline`, or `layer:LABELS` — `layer:` alone for paths on no layer. */
type Key = string
const kindKey = (k: PathKind): Key => `kind:${k}`
const layerKey = (p: ImportedPath): Key => `layer:${p.layer ?? ''}`

interface Narrowed { base: string[]; applied: string[]; keys: Key[] }
interface Button { key: Key; label: string; hint: string; count: number; swatch?: string }


const btnCls = (on: boolean) => [
  'flex items-center justify-center gap-1 px-2 py-1 text-body rounded border transition-colors grow',
  on
    ? 'bg-blue-600 border-blue-500 text-white'
    : 'bg-gray-50 dark:bg-neutral-900 border-gray-400 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
].join(' ')

export function SelectionKindsBar() {
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const setSelectedIds = usePathsStore((s) => s.setSelectedIds)
  const [narrow, setNarrow] = useState<Narrowed | null>(null)
  const narrowed = narrow !== null && narrowingHolds(selectedIds, narrow.applied, isListSelection(selectedIds))
  // The selection moved on without the bar: forget the one it narrowed.
  useEffect(() => { if (narrow && !narrowed) setNarrow(null) }, [narrow, narrowed])

  const sourceIds = narrowed ? narrow.base : selectedIds
  // THE SELECTED PATH OBJECTS, kept as the same array until one of them changes. Paths are
  // replaced, never mutated, so identity says exactly when a selected path was edited; keyed
  // on the whole `paths` array instead, an edit to ANY path — a drag ending, a nest landing —
  // re-ran the classifier (O(n²) in the selection) over 890 untouched paths on the
  // Charizard sheet.
  const byId = useMemo(() => new Map(paths.map((p) => [p.id, p])), [paths])
  const lastSource = useRef<ImportedPath[]>([])
  const fresh = sourceIds.flatMap((id) => byId.get(id) ?? [])
  const source = fresh.length === lastSource.current.length && fresh.every((p, i) => p === lastSource.current[i])
    ? lastSource.current
    : (lastSource.current = fresh)
  const kinds = useMemo(() => classifyPaths(source), [source])
  const { live, keysOf, layerRow, kindRow } = useMemo(() => {
    const keysOf = new Map(source.map((p) => [p.id, [layerKey(p), kindKey(kinds.get(p.id)!)]]))

    const layers = new Map<Key, Button>()
    for (const p of source) {
      const key = layerKey(p)
      const b = layers.get(key)
      if (b) { b.count++; continue }
      layers.set(key, {
        key, count: 1, swatch: p.color,
        label: p.layer === undefined ? 'No layer' : layerLabel(p.layer),
        hint: p.layer === undefined ? 'Paths the file put on no layer' : `Paths the file put on ${layerLabel(p.layer)}`,
      })
    }
    const kindRow: Button[] = PATH_KIND_ORDER.flatMap((k) => {
      const count = source.filter((p) => kinds.get(p.id) === k).length
      return count > 0 ? [{ key: kindKey(k), label: KIND_LABEL[k], hint: KIND_HINT[k], count }] : []
    })
    // In DOCUMENT order — where each layer first appears among all the paths, which for an
    // import is the file's own order — never selection order. The selection is pick order,
    // so a rubber band and a run of shift-clicks over the same paths listed the same layers
    // in different orders, and the buttons swapped places under the cursor. No layer last.
    const firstAt = new Map<Key, number>()
    paths.forEach((p, i) => { const k = layerKey(p); if (!firstAt.has(k)) firstAt.set(k, i) })
    const layerRow = [...layers.values()].sort((a, b) =>
      (a.key === 'layer:' ? 1 : 0) - (b.key === 'layer:' ? 1 : 0) || firstAt.get(a.key)! - firstAt.get(b.key)!)
    return { live: source.map((p) => p.id), keysOf, layerRow, kindRow }
  }, [paths, source, kinds])

  const rows = [layerRow, kindRow].filter((r) => r.length >= 2)
  if (!narrowed && rows.length === 0) return null

  function pick(key: Key, extend: boolean) {
    const current = narrowed ? narrow!.keys : []
    const next = extend
      ? (current.includes(key) ? current.filter((k) => k !== key) : [...current, key])
      : [key]
    const applied = live.filter((id) => keysOf.get(id)!.some((k) => next.includes(k)))
    // Nothing chosen, or a choice that covers everything: that is the whole selection again.
    if (next.length === 0 || applied.length === live.length) { restore(); return }
    setSelectedIds(applied)
    setNarrow({ base: live, applied, keys: next })
  }
  function restore() {
    setSelectedIds(live)
    setNarrow(null)
  }

  const row = (buttons: Button[]) => (
    <div className="flex flex-wrap gap-1" role="group">
      {buttons.map((b) => (
        <button key={b.key} onClick={(e) => pick(b.key, e.shiftKey)}
          title={`${b.hint}. Shift-click to add to what is already chosen.`}
          className={btnCls(narrowed && narrow!.keys.includes(b.key))}>
          {b.swatch && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: b.swatch }} />}
          {b.label} {b.count}
        </button>
      ))}
    </div>
  )

  return (
    <div className="px-3 py-2 border-b border-gray-300 dark:border-neutral-700 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider">Select Only</span>
        {narrowed && (
          <button onClick={restore} title="Put back the whole selection"
            className="flex items-center gap-1 text-label text-blue-600 dark:text-blue-400 hover:underline">
            <RotateCcw size={ICON.sm} />All {live.length}
          </button>
        )}
      </div>
      {rows.map((r, i) => <div key={i}>{row(r)}</div>)}
    </div>
  )
}
