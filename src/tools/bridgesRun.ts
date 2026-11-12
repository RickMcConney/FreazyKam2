// Writing the sheet's BRIDGES (cam/bridges) and rebuilding the cuts they change.
//
// One recorded step — the workpiece setting — and the regeneration after it, which writes
// only derived state and so lands in that step's snapshot: one undo takes the bridges back
// and the toolpaths the step rebuilt with them.
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolpathStore, pathIdsOf, type AnyOperation } from '../store/toolpathStore'
import { regenerateMany } from '../cam/regenerate'
import { placeBridges, planSlugStrips, BRIDGE_DEFAULTS, type BridgeSet, type BridgeLine } from '../cam/bridges'
import { useUIStore } from '../store/uiStore'
import { bridgedOps, holdableParts, holdableHoles, cutterRadiusFor } from './bridgeParts'
export { bridgedOps, holdableParts, holdableHoles, cutterRadiusFor }
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { buildHoldIndex, type HoldIndex } from '../cam/bridgePick'

/** A network of bridges joining the parts among `paths` (`holdableParts`) — `count` joins to
 *  each — and `count` strips into the slug of each hole in them (`holdableHoles`), replacing
 *  the ones an earlier Apply laid. Strips placed or moved BY HAND (`manual`) stay exactly
 *  where they are — a new strip that would land on one is left out — and take the new width
 *  and height, which belong to the set. Returns the set, or null when there was nothing to hold. */
export function applyBridges(paths: ImportedPath[], widthMM: number, heightMM: number, count: number): BridgeSet | null {
  const wp = useWorkpieceStore.getState()
  const ops = useToolpathStore.getState().operations
  const parts = holdableParts(paths, ops, wp.thicknessMM, heightMM)
  if (parts.length === 0) return null
  const holes = holdableHoles(paths, parts, ops, wp.thicknessMM, heightMM)
  // The cutter's reach: the widest one cutting round these parts (1/8" when nothing cuts
  // them yet).
  const toolRadiusMM = cutterRadiusFor([...parts, ...holes].map((p) => p.id))
  const slugs = planSlugStrips(holes, [...parts, ...holes], { count, widthMM, toolRadiusMM })
  const kept = (wp.bridges?.lines ?? []).filter((l) => l.manual)
  // A planned strip whose middle lies on a hand-placed one would be that strip twice.
  const onKept = (l: BridgeLine) => kept.some((k) => distToLine((l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2, k) < widthMM)
  const planned = [...placeBridges(parts, wp, { count, widthMM, toolRadiusMM }), ...slugs.map((s) => s.line)].filter((l) => !onKept(l))
  const lines = [...kept, ...planned]
  if (lines.length === 0) return null
  const pathIds = [...new Set([...(kept.length > 0 ? wp.bridges!.pathIds : []), ...parts.map((p) => p.id), ...slugs.map((s) => s.hole)])]
  const set: BridgeSet = { lines, widthMM, heightMM, pathIds }
  wp.setBridges(set)
  regenerateMany(bridgedOps(useToolpathStore.getState().operations))
  return set
}

function distToLine(x: number, y: number, l: BridgeLine): number {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1, l2 = dx * dx + dy * dy
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - l.x1) * dx + (y - l.y1) * dy) / l2)) : 0
  return Math.hypot(x - l.x1 - u * dx, y - l.y1 - u * dy)
}

export function removeBridges(): void {
  const wp = useWorkpieceStore.getState()
  if (!wp.bridges) return
  wp.setBridges(null)
  regenerateMany(bridgedOps(useToolpathStore.getState().operations))
}

// ─── One strip at a time: click-to-place and drag (cam/bridgePick) ──────────────────────────

/** The parts and holes a hand-placed strip may hold, among the visible paths — or among
 *  them ALL (`withHidden`), for judging which strips still touch something on show. */
function holdsNow(withHidden: boolean): { parts: ImportedPath[]; holes: ImportedPath[] } {
  const paths = usePathsStore.getState().paths.filter((p) => (withHidden || (p.visible && !p.hidden)) && !p.imageSrc && !p.stlSrc)
  const wp = useWorkpieceStore.getState()
  // The strips' height: the set's, else what click-to-place would give a first one.
  const h = holdHeightNow()
  const ops = useToolpathStore.getState().operations
  const parts = holdableParts(paths, ops, wp.thicknessMM, h)
  return { parts, holes: holdableHoles(paths, parts, ops, wp.thicknessMM, h) }
}

// Built once per document state — a drag asks on every mouse move, a nest is thousands of
// outlines. Paths and ops are replaced, never mutated, so identity says whether it is stale.
// `hold` is the strips' height: it decides which cuts are deep enough to count (holdsNow).
type IndexMemo = { paths: unknown; ops: unknown; w: number; h: number; t: number; hold: number; index: HoldIndex }
const indexMemo: [IndexMemo | null, IndexMemo | null] = [null, null]
const holdHeightNow = () => useWorkpieceStore.getState().bridges?.heightMM ?? useUIStore.getState().tabPlace?.heightMM ?? BRIDGE_DEFAULTS.heightMM
export function holdIndexNow(withHidden = false): HoldIndex {
  const paths = usePathsStore.getState().paths
  const ops = useToolpathStore.getState().operations
  const { widthMM: w, heightMM: h, thicknessMM: t } = useWorkpieceStore.getState()
  const slot = withHidden ? 1 : 0
  const m = indexMemo[slot], hold = holdHeightNow()
  if (m && m.paths === paths && m.ops === ops && m.w === w && m.h === h && m.t === t && m.hold === hold) return m.index
  const { parts, holes } = holdsNow(withHidden)
  const index = buildHoldIndex(parts, { widthMM: w, heightMM: h }, holes)
  indexMemo[slot] = { paths, ops, w, h, t, hold, index }
  return index
}

// The box a toolpath covers, kept per segments array (replaced, never mutated).
const boxes = new WeakMap<object, { minX: number; minY: number; maxX: number; maxY: number } | null>()
function opBox(op: AnyOperation) {
  if (boxes.has(op.segments)) return boxes.get(op.segments)!
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const g of op.segments) {
    if (g.toolChange) continue
    if (g.x < minX) minX = g.x; if (g.x > maxX) maxX = g.x
    if (g.y < minY) minY = g.y; if (g.y > maxY) maxY = g.y
  }
  const b = minX === Infinity ? null : { minX, minY, maxX, maxY }
  boxes.set(op.segments, b)
  return b
}

/**
 * Regenerate the cuts a change to `lines` can reach — every bridged op whose toolpath comes
 * within a strip's half width and the cutter of one of them, plus the ops of the parts named.
 * Not every bridged op on the sheet: one strip moved on a nest of thousands of parts would
 * rebuild them all. Not only the two parts it joins either: a hand-placed strip may graze a
 * third part's cut, and a cut left ungenerated would go through it.
 */
function regenerateNear(lines: BridgeLine[], halfWidthMM: number, partIds: string[]): void {
  const reach = halfWidthMM + 10
  const ids = new Set(partIds)
  const hit = bridgedOps(useToolpathStore.getState().operations).filter((op) => {
    if (pathIdsOf(op).some((id) => ids.has(id))) return true
    const b = opBox(op)
    return !!b && lines.some((l) =>
      Math.max(l.x1, l.x2) + reach >= b.minX && Math.min(l.x1, l.x2) - reach <= b.maxX &&
      Math.max(l.y1, l.y2) + reach >= b.minY && Math.min(l.y1, l.y2) - reach <= b.maxY)
  })
  if (hit.length > 0) regenerateMany(hit)
}

/** Add one strip joining `a` to `b` (a part id, or the frame) — the first one starts the set. */
export function addStrip(line0: BridgeLine, a: string, b: string, widthMM: number, heightMM: number): void {
  const line: BridgeLine = { ...line0, manual: true }
  const wp = useWorkpieceStore.getState()
  const cur = wp.bridges
  const ids = [a, ...(b === 'frame' ? [] : [b])]
  const next: BridgeSet = cur
    ? { ...cur, lines: [...cur.lines, line], pathIds: [...new Set([...cur.pathIds, ...ids])] }
    : { lines: [line], widthMM, heightMM, pathIds: ids }
  wp.setBridges(next)
  regenerateNear([line], next.widthMM / 2, ids)
}

/** Move strip `i` to `line` (a drag's release). It is hand-placed from then on. */
export function moveStrip(i: number, line0: BridgeLine): void {
  const line: BridgeLine = { ...line0, manual: true }
  const wp = useWorkpieceStore.getState()
  const cur = wp.bridges
  if (!cur || !cur.lines[i]) return
  const old = cur.lines[i]
  wp.setBridges({ ...cur, lines: cur.lines.map((l, k) => (k === i ? line : l)) })
  regenerateNear([old, line], cur.widthMM / 2, [])
}

/** Take strip `i` away; the last one takes the set with it. */
export function removeStrip(i: number): void {
  const wp = useWorkpieceStore.getState()
  const cur = wp.bridges
  if (!cur || !cur.lines[i]) return
  const old = cur.lines[i]
  const lines = cur.lines.filter((_, k) => k !== i)
  wp.setBridges(lines.length > 0 ? { ...cur, lines } : null)
  regenerateNear([old], cur.widthMM / 2, [])
}
