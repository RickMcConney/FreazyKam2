import type { ImportedPath } from '../importers/svgImporter'
import { extractCircles } from '../canvas/selectionUtils'
import { flattenPath, signedArea } from '../cam/pathFlattener'

// ─── A pattern is one body ────────────────────────────────────────────────────
//
// A PATTERN'S SOURCE AND ITS COPIES MOVE AS ONE THING under a constraint, the way
// a gear's seven paths do — but WITHOUT a group. Grouping was the workaround and it
// cost the pattern: the group sat over the pattern's definition and the form could
// no longer re-run it. The copies already share `definition.id`; the source does
// not carry the definition at all (it is item 0, the user's own path), so it is
// found through `sourceIds`. Two patterns sharing a path — a grid of a bolt
// circle's copies, or two patterns off one source — are one body, transitively.
//
// And a CIRCULAR pattern has a point no outline has: the centre it was turned
// about. That is what a bolt circle is dimensioned from, so it is offered as a
// constraint point (`patternCentreOf`). Worked out from where the items STAND,
// not from the stored radius and the source's box: the items are what gets cut,
// and the circle through them is the same under any turn the body is given —
// the stored formula is only true while the pattern stands as it was made.

/** Body key for every path that belongs to some pattern. Cached per paths array —
 *  the store hands out a new array on every edit, so the cache never goes stale. */
const KEYS = new WeakMap<readonly ImportedPath[], { keys: Map<string, string>; welding: Set<string> }>()

/**
 * TWO KINDS OF PATTERN, by what it was made from.
 *
 * Made from ONE thing — a hole, a gear, or a whole earlier pattern — it extends
 * that thing: source and copies are one body, as above.
 *
 * Made from SEVERAL things that are bodies of their own — a plate AND the bolt
 * circle held to it, patterned together — it WELDS them: they still move as one
 * body to everything outside (the pattern's copies are copies of the assembly, and
 * dragging one part of it apart from the rest would leave the copies describing
 * something that no longer exists). But the constraints BETWEEN those things are
 * the assembly's own layout, and welding them made those constraints dead: they
 * both ended in one body, so the solve dropped them and typing a new distance
 * moved nothing. So a welding pattern is the same thing a user group is to a
 * constraint — a container the inner solve looks through (`weldingPatternIds`,
 * `solveInnerConstraints`) — and the pattern is re-run from wherever that solve
 * leaves its sources.
 */
function analyse(paths: readonly ImportedPath[]): { keys: Map<string, string>; welding: Set<string> } {
  const hit = KEYS.get(paths)
  if (hit) return hit
  const live = new Set(paths.map((p) => p.id))
  const byId = new Map(paths.map((p) => [p.id, p]))
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let at = k
    while ((parent.get(at) ?? at) !== at) at = parent.get(at)!
    parent.set(k, at)
    return at
  }
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  // Every pattern, with its live sources; each owns its copies from the start.
  const defs = new Map<string, string[]>()
  for (const p of paths) {
    const def = p.definition
    if (def?.kind !== 'pattern') continue
    if (!defs.has(def.id)) defs.set(def.id, def.sourceIds.filter((s) => live.has(s)))
    union('def:' + def.id, p.id)
  }
  // The body a source stands in WITHOUT any welding: whatever the joins so far
  // have made it part of, else its shape group, else itself.
  const plainKey = (id: string) => parent.has(id) ? find(id) : 'obj:' + (byId.get(id)?.groupId ?? id)
  // A pattern joins its sources once they are all one body; joining one can make
  // another's sources one body, so round until nothing changes.
  const joined = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const [defId, srcs] of defs) {
      if (joined.has(defId) || srcs.length === 0) continue
      if (new Set(srcs.map(plainKey)).size > 1) continue
      for (const s of srcs) union('def:' + defId, s)
      joined.add(defId)
      grew = true
    }
  }
  const welding = new Set([...defs.keys()].filter((d) => !joined.has(d) && (defs.get(d)?.length ?? 0) > 0))
  // …and to everything outside, a welding pattern is still one body.
  for (const d of welding) for (const s of defs.get(d)!) union('def:' + d, s)

  // Keyed by the SMALLEST DEFINITION ID in the set — deterministic whichever way
  // the unions fell — and prefixed, never a bare path id: a path id is somebody's
  // own body key, and a key that could collide with one would merge two bodies.
  const keyOfRoot = new Map<string, string>()
  for (const k of parent.keys()) {
    if (!k.startsWith('def:')) continue
    const r = find(k), id = k.slice(4)
    const was = keyOfRoot.get(r)
    if (was === undefined || id < was) keyOfRoot.set(r, id)
  }
  const keys = new Map<string, string>()
  for (const p of paths) {
    if (!parent.has(p.id)) continue
    const key = keyOfRoot.get(find(p.id))
    if (key !== undefined) keys.set(p.id, 'pattern:' + key)
  }
  const out = { keys, welding }
  KEYS.set(paths, out)
  return out
}

/** The pattern body each path belongs to, if any. */
export function patternBodyKeys(paths: readonly ImportedPath[]): Map<string, string> {
  return analyse(paths).keys
}

/** The patterns made from several bodies at once — see `analyse`. */
export function weldingPatternIds(paths: readonly ImportedPath[]): Set<string> {
  return analyse(paths).welding
}

/**
 * The selected paths to tag as a pattern's ORIGINAL: a source of some pattern, in
 * a selection that also holds at least one of that pattern's copies — the
 * pattern's chip, or the form's own selection after an Apply. DesignLayer draws these
 * green (ORIGINAL_COLOR) rather than in the selection colour. A pattern's chip
 * selects the original with the copies (they are one thing), and at a glance the
 * eight holes then look alike; the original is the one whose Properties edit them
 * all. An original selected ON ITS OWN is not tagged: Properties already says
 * what it is.
 */
export function patternOriginalsInSelection(paths: readonly ImportedPath[], selectedIds: readonly string[]): string[] {
  const sel = new Set(selectedIds)
  const out = new Set<string>()
  for (const p of paths) {
    const def = p.definition
    if (def?.kind !== 'pattern' || !sel.has(p.id)) continue
    for (const s of def.sourceIds) if (sel.has(s)) out.add(s)
  }
  return paths.filter((p) => out.has(p.id)).map((p) => p.id)
}

/** Where one pattern item stands: a round one's centre, else the centroid of its
 *  largest ring — both turn exactly with the item, which a bounding-box centre
 *  does not. */
function itemPoint(p: ImportedPath): { x: number; y: number } | null {
  const circles = extractCircles(p)
  if (circles.length > 0) {
    const c = circles.reduce((a, b) => (b.radiusMM > a.radiusMM ? b : a))
    return { x: c.cx, y: c.cy }
  }
  let best: { a: number; x: number; y: number } | null = null
  for (const ring of flattenPath(p.d, 0.05)) {
    const a = signedArea(ring)
    if (Math.abs(a) < 1e-12 || (best && Math.abs(a) <= Math.abs(best.a))) continue
    let cx = 0, cy = 0
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length]
      const k = x0 * y1 - x1 * y0
      cx += (x0 + x1) * k
      cy += (y0 + y1) * k
    }
    best = { a, x: cx / (6 * a), y: cy / (6 * a) }
  }
  return best ? { x: best.x, y: best.y } : null
}

/** Below this two items stand in the same place — a pattern of radius 0. */
const SAME_MM = 1e-6

/**
 * The centre of the circular pattern `sourceId` is the (first) source of, or null
 * — not a circular pattern, or too little of it left to say.
 *
 * The CIRCLE THROUGH THE ITEMS: three of them, spread as wide as they go, fix it
 * exactly and survive a copy deleted by hand. Two items on a full circle stand
 * opposite each other, so their midpoint. A pattern of several sources is read one
 * item per INSTANCE — the copies are made instance-major, one run of
 * `sourceIds.length` per item — and only while that still adds up.
 */
export function patternCentreOf(paths: readonly ImportedPath[], sourceId: string): { x: number; y: number } | null {
  const copies = paths.filter((p) => p.definition?.kind === 'pattern'
    && p.definition.params.type === 'circular' && p.definition.sourceIds[0] === sourceId)
  if (copies.length === 0) return null
  const def = copies[0].definition!
  if (def.kind !== 'pattern' || def.params.type !== 'circular') return null
  const mine = copies.filter((p) => p.definition!.id === def.id)
  const source = paths.find((p) => p.id === sourceId)
  if (!source) return null
  const n = def.sourceIds.length
  if (mine.length % n !== 0) return null
  const items = [source, ...mine.filter((_, i) => i % n === 0)]
  const pts = items.flatMap((p) => { const q = itemPoint(p); return q ? [q] : [] })
  if (pts.length === 0) return null
  const p0 = pts[0]
  const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
  const far = pts.reduce((a, b) => (d2(b, p0) > d2(a, p0) ? b : a))
  if (d2(far, p0) < SAME_MM ** 2) return { ...p0 }
  const { startAngleDeg: s, endAngleDeg: e } = def.params
  const fullCircle = Math.abs((e - s) % 360) < 0.01
  const cross = (q: { x: number; y: number }) => (far.x - p0.x) * (q.y - p0.y) - (far.y - p0.y) * (q.x - p0.x)
  const third = pts.reduce((a, b) => (Math.abs(cross(b)) > Math.abs(cross(a)) ? b : a))
  // Collinear: two items, or a row. Only a full circle's two opposite items say where its middle is.
  if (Math.abs(cross(third)) < 1e-9 * Math.max(1, d2(far, p0))) {
    return fullCircle && pts.length === 2 ? { x: (p0.x + far.x) / 2, y: (p0.y + far.y) / 2 } : null
  }
  // Circumcentre of p0, far, third.
  const ax = p0.x, ay = p0.y, bx = far.x, by = far.y, cx = third.x, cy = third.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  return {
    x: (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d,
    y: (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d,
  }
}
