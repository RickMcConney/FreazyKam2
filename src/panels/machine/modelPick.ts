// Which model a 3D Profile cuts, and how the Model list names them.
//
// A model is an ordinary path, so it can be duplicated — a rosette on each face of a
// double-sided board is the case that found this. The form used to start on the FIRST
// model in the drawing whatever was selected, and the list showed the copies under one
// name, so the toolpath landed on the original with no way to tell from the form.

interface Named { id: string; name: string }

/**
 * The model to cut: a selected one first (the form follows the selection like every
 * other), else the one already chosen while it still exists, else the first.
 */
export function pickModelPathId(models: Named[], selectedIds: readonly string[], current: string): string {
  const selected = models.find((m) => selectedIds.includes(m.id))
  if (selected) return selected.id
  if (models.some((m) => m.id === current)) return current
  return models[0]?.id ?? ''
}

/**
 * What the Model list calls each model: its name — and, where two share a name, where each
 * is (`where`, e.g. its sheet), then a number if that still does not tell them apart.
 */
export function modelLabels<T extends Named>(models: T[], where: (m: T) => string): Map<string, string> {
  const byName = new Map<string, T[]>()
  for (const m of models) byName.set(m.name, [...(byName.get(m.name) ?? []), m])
  const labels = new Map<string, string>()
  for (const [name, same] of byName) {
    if (same.length === 1) { labels.set(same[0].id, name); continue }
    const places = same.map(where)
    same.forEach((m, i) => {
      const clash = places.filter((p) => p === places[i]).length > 1
      const n = same.slice(0, i + 1).filter((_, j) => places[j] === places[i]).length
      labels.set(m.id, `${name} — ${places[i]}${clash ? ` #${n}` : ''}`)
    })
  }
  return labels
}
