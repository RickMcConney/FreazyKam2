// What each path in a selection IS, read off the geometry: a part's outline, a hole in it,
// or a label engraved on it. The machine panel's selection bar narrows a selection to one
// of these, so a sheet of labelled parts can be profiled, engraved and drilled from one
// selection — each operation takes its share instead of every path.
//
// Nothing in an import says which is which: an SVG or DXF hands over a flat list of
// outlines and strokes, and the importer splits each compound path into one path per
// subpath, so even a label arrives as one path per stroke. Three readings sort them:
//
//  - NESTING. A path's container is the smallest CLOSED path in the selection whose
//    material holds it (even-odd, from `interiorPoint` — never a centroid). A closed path
//    with no container is an OUTLINE. An open stroke has no interior to probe, so a point
//    ON it stands for it: the slash through a label's 0 is a two-point line.
//  - STROKES ARE LABELS. An open path engraves along its line; it can be nothing else.
//  - A CLOSED GLYPH SITS AMONG STROKES. The 0's oval is a closed ring and, by nesting
//    alone, a hole. What gives it away is its company: it lies within a letter-gap of the
//    label's strokes, inside the same part, and is about their size. Closed paths meeting
//    that test join the label, transitively, so "80" with one stroke still comes out whole.
//    The size rule is what keeps a large cutout beside a label from being swallowed by it,
//    and a CIRCLE never joins — a drilled hole can sit closer to a label than its letters
//    sit to each other. A label made only of closed glyphs with no stroke anywhere (a lone
//    "D"), or a perfectly round glyph, cannot be told from a hole this way and reads as one.

import { interiorPoint } from '../../cam/geom'
import { isOpenSubpath } from '../../cam/pathFlattener'
import type { ImportedPath } from '../../store/pathsStore'
import { flattenCached, insideCompound } from './containment'

export type PathKind = 'outline' | 'hole' | 'label' | 'other'

export const PATH_KIND_ORDER: PathKind[] = ['outline', 'hole', 'label', 'other']

type Pt = [number, number]
interface Meta {
  subs: Pt[][]
  open: boolean
  probe: Pt
  minX: number; minY: number; maxX: number; maxY: number
  area: number
  size: number
  round: boolean
}

/** A drilled hole: one closed subpath whose every vertex sits on one circle, to 5%. Not
 *  `extractCircles`, which asks only for a square bounding box and so takes a square. */
function isRound(subs: Pt[][], open: boolean): boolean {
  if (open || subs.length !== 1 || subs[0].length < 8) return false
  const pts = subs[0]
  let cx = 0, cy = 0
  for (const [x, y] of pts) { cx += x; cy += y }
  cx /= pts.length; cy /= pts.length
  const rs = pts.map(([x, y]) => Math.hypot(x - cx, y - cy))
  const r = rs.reduce((a, b) => a + b, 0) / rs.length
  return r > 0 && rs.every((v) => Math.abs(v - r) <= 0.05 * r)
}

function metaOf(p: ImportedPath): Meta | null {
  if (p.imageSrc || p.stlSrc) return null
  const subs = flattenCached(p).filter((s) => s.length >= 2)
  if (subs.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of subs) for (const [x, y] of s) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const open = subs.some(isOpenSubpath)
  const first = subs[0]
  const probe: Pt | null = open
    ? [(first[0][0] + first[1][0]) / 2, (first[0][1] + first[1][1]) / 2]
    : interiorPoint(subs)
  if (!probe) return null
  const w = maxX - minX, h = maxY - minY
  return { subs, open, probe, minX, minY, maxX, maxY, area: w * h, size: Math.max(w, h), round: isRound(subs, open) }
}

/** Each path's container: the smallest closed path in the list whose material holds it. */
function containers(paths: ImportedPath[], meta: (Meta | null)[]): number[] {
  return paths.map((_, i) => {
    const m = meta[i]
    if (!m) return -1
    let best = -1
    for (let j = 0; j < paths.length; j++) {
      const o = meta[j]
      if (j === i || !o || o.open || o.area <= m.area) continue
      if (m.minX < o.minX || m.maxX > o.maxX || m.minY < o.minY || m.maxY > o.maxY) continue
      if (!insideCompound(m.probe[0], m.probe[1], o.subs)) continue
      if (best < 0 || o.area < meta[best]!.area) best = j
    }
    return best
  })
}

/** Gap within which a closed glyph counts as part of the label beside it — three quarters
 *  of a glyph. A letter space in a single-stroke font is about half (2 mm between 4 mm
 *  letters on the Charizard sheet), and a stroke can stop short of its letter's cell, so
 *  a bowl in a vertical label there sat 4 mm from the nearest stroke beside it. */
const gapFor = (m: Meta) => Math.max(0.5, 0.75 * m.size)

function near(a: Meta, b: Meta, gap: number): boolean {
  return a.minX - gap <= b.maxX && b.minX - gap <= a.maxX && a.minY - gap <= b.maxY && b.minY - gap <= a.maxY
}

/** What each path is, keyed by id. See the header. */
export function classifyPaths(paths: ImportedPath[]): Map<string, PathKind> {
  const meta = paths.map(metaOf)
  const parent = containers(paths, meta)
  const root = paths.map((_, i) => { let r = i; while (parent[r] >= 0) r = parent[r]; return r })
  const kinds: PathKind[] = paths.map((_, i) => {
    const m = meta[i]
    if (!m) return 'other'
    if (m.open) return 'label'
    return parent[i] < 0 ? 'outline' : 'hole'
  })
  // WHERE THE DRAWING SAYS, BELIEVE IT. A compound element the importer split into several
  // paths (`sourceElement`) — an SVG label is one <path> holding all its strokes — is one
  // drawn thing: if any of it is a stroke it is a label, closed letters and all, and if
  // none of it is, nearness to some other label's strokes does not make it one.
  const strokedElements = new Set<string>()
  paths.forEach((p, i) => { if (p.sourceElement && meta[i]?.open) strokedElements.add(p.sourceElement) })
  paths.forEach((p, i) => { if (p.sourceElement && meta[i] && strokedElements.has(p.sourceElement)) kinds[i] = 'label' })
  // Otherwise grow each label out to the closed glyphs among its strokes, until nothing
  // more joins.
  let grew = true
  while (grew) {
    grew = false
    for (let i = 0; i < paths.length; i++) {
      if (kinds[i] !== 'hole' || paths[i].sourceElement) continue
      const m = meta[i]!
      // A circle is a hole even beside a label: one on that sheet sits 2 mm from a stroke.
      if (m.round) continue
      for (let j = 0; j < paths.length; j++) {
        if (kinds[j] !== 'label' || root[j] !== root[i]) continue
        const l = meta[j]!
        if (m.size > 2 * l.size) continue
        if (!near(m, l, Math.max(gapFor(m), gapFor(l)))) continue
        kinds[i] = 'label'
        grew = true
        break
      }
    }
  }
  return new Map(paths.map((p, i) => [p.id, kinds[i]]))
}

/**
 * Does the Select Only bar's narrowing still describe the selection? Exactly what it
 * narrowed to, yes. And also when the FORM'S PATH LIST has since clicked paths out of it
 * (or back in) without leaving it: that is refining the narrowed set, not replacing it, and
 * dropping the narrowing there lost the bar's ↺ All. Anything else that changes the
 * selection — a canvas click, even onto one of the narrowed paths — is a new selection, and
 * the bar reads it afresh rather than going on claiming a choice nobody is looking at.
 */
export function narrowingHolds(selected: string[], applied: string[], byPathList: boolean): boolean {
  if (selected.length === applied.length && selected.every((id, i) => id === applied[i])) return true
  if (!byPathList) return false
  const inside = new Set(applied)
  return selected.every((id) => inside.has(id))
}

/**
 * The paths no other closed path in the list contains — what an OUTSIDE profile cuts
 * round. Cutting outside a hole or a glyph widens it by a tool diameter, which is never
 * what selecting a whole part meant.
 */
export function outermostPaths<T extends ImportedPath>(paths: T[]): { outer: T[]; skipped: number } {
  const parent = containers(paths, paths.map(metaOf))
  const outer = paths.filter((_, i) => parent[i] < 0)
  return { outer, skipped: paths.length - outer.length }
}
