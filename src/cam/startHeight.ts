// Start-cut height — "which surface does this operation begin from?"
//
// Engraving letters into the floor of a 2 mm pocket has to start at Z = -2, not at the
// stock top. Rather than ask the user for a number (wrong by 2 mm in the wrong direction
// is a full-depth plunge into solid stock), an operation stores a REFERENCE — `StartFrom`
// — and the height is resolved from the operations that precede it, every time it
// generates. Change the pocket's depth later and the engraving follows it.
//
// SAFETY INVARIANT: no operation ever ADDS material, so any op this resolver ignores can
// only make the answer HIGHER than the real surface. Too high costs an air pass; too low
// is a crash. That is what lets the candidate filter below be as crude as it likes —
// preceding ops only, flat floors only, bbox rejection — without ever being unsafe.
//
// Deliberately NOT modelled (each one errs high, i.e. safe): v-carve, photo v-carve and
// 3D surfaces (not flat — a photo carve leaves a groove field, not a floor), PECK-drilled
// holes (a drill point leaves a cone, and reporting its full depth as a floor would read
// LOW by the point length), profile slots (a tool-width band, rarely what anything starts
// from), imported G-code (opaque).
// The stock model in the simulator is the backstop that sees all of those.
//
// A HELICALLY bored hole IS modelled: an end mill takes the whole disc out to a flat
// bottom, so a smaller hole (or a pocket, or an engraving) placed inside one starts from
// that bottom rather than from stock top.
import polygonClipping, { type MultiPolygon, type Ring } from 'polygon-clipping'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { classifySubpaths, interiorPoint, pointInPolygon, maxCutRadiusMM } from './geom'
import { flattenPath, splitSelfIntersecting, ensureWinding, type Pt2 } from './pathFlattener'
import type { AnyOperation, CutSide } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { ImportedPath } from '../store/pathsStore'

export type StartFrom =
  | { mode: 'auto' }                      // resolve from preceding operations (default)
  | { mode: 'stock' }                     // stock top, Z = 0
  | { mode: 'op'; opId: string }          // the floor of one named operation
  | { mode: 'manual'; zMM: number }       // an explicit Z the user typed

export interface StartZ {
  /** Absolute CNC Z of the surface the cut starts from — 0 at stock top, negative below. */
  zMM: number
  /** Operation the height came from, when it came from one. */
  sourceOpId?: string
  /** Provenance, for the form: "Stock top", "Floor of Pocket: Rect", "Custom". */
  label: string
}

export const STOCK_TOP: StartZ = { zMM: 0, label: 'Stock top' }

// Slivers this small are float noise from the clipper, not real uncovered ground.
const EPS_AREA_MM2 = 0.01

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function ringOf(pts: Pt2[]): Ring {
  const ring = pts.map(([x, y]) => [x, y] as [number, number])
  if (ring.length > 1) {
    const [x0, y0] = ring[0]
    const [xl, yl] = ring[ring.length - 1]
    if (Math.abs(x0 - xl) < 1e-9 && Math.abs(y0 - yl) < 1e-9) ring.pop()
  }
  return ring
}

// A path's filled area as a MultiPolygon. classifySubpaths resolves which subpaths are
// holes, so a compound path (text, a glyph with counters) contributes its counters as
// holes rather than as extra filled blobs.
function areaOfD(d: string): MultiPolygon {
  const rings = splitSelfIntersecting(flattenPath(d, 0.1))
  return classifySubpaths(rings)
    .map(({ outer, holes }) => [ringOf(outer), ...holes.map(ringOf)].filter(r => r.length >= 3))
    .filter(poly => poly.length > 0)
}

function bboxOf(mp: MultiPolygon): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const poly of mp) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

function areaOf(mp: MultiPolygon): number {
  let total = 0
  for (const poly of mp) for (const ring of poly) {
    let a = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1])
    }
    total += Math.abs(a) / 2
  }
  return total
}

function rectPoly(minX: number, minY: number, maxX: number, maxY: number): MultiPolygon {
  return [[[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]]]
}

// Grow a filled area outwards by `delta`. Rings go in with the winding Clipper expects
// (outers CCW, holes CW) and come back as a flat ring list, which classifySubpaths
// re-nests into outer/hole polygons — the same containment pass the rest of the CAM uses.
function inflateArea(mp: MultiPolygon, delta: number): MultiPolygon | null {
  if (delta <= 1e-9 || mp.length === 0) return mp
  const input = mp.flatMap((poly) =>
    poly.map((ring, i) => {
      const pts = ring.map(([x, y]) => [x, y] as Pt2)
      const oriented = ensureWinding(pts, i === 0)   // ring 0 is the outer, the rest are holes
      return oriented.map(([x, y]) => ({ x, y }))
    })
  )
  const grown = safeClip(() => {
    const out = inflatePathsD(input, delta, JoinType.Round, EndType.Polygon, 4, 6)
    const rings = out.map((p) => p.map(({ x, y }) => [x, y] as Pt2)).filter((p) => p.length >= 3)
    return classifySubpaths(rings)
      .map(({ outer, holes }) => [ringOf(outer), ...holes.map(ringOf)].filter((r) => r.length >= 3))
      .filter((poly) => poly.length > 0)
  })
  // No fallback to the un-grown area on failure — a smaller footprint is EASIER to cover,
  // which would hand back a deeper start than the geometry justifies. null → stock top.
  return grown
}

// Clipper calls throw on degenerate input; a failure here must fall back to "stock top",
// never to a deeper guess.
function safeClip(fn: () => MultiPolygon): MultiPolygon | null {
  try { return fn() } catch { return null }
}

/** Is the point inside the filled area — inside some polygon's outer ring and none of its
 *  holes? Same even-odd convention as the rest of the CAM. */
function pointInArea(x: number, y: number, mp: MultiPolygon): boolean {
  for (const poly of mp) {
    const [outer, ...holes] = poly
    if (!outer || outer.length < 3) continue
    if (!pointInPolygon(x, y, outer as Pt2[])) continue
    if (holes.some((h) => h.length >= 3 && pointInPolygon(x, y, h as Pt2[]))) continue
    return true
  }
  return false
}

// ─── Floors ───────────────────────────────────────────────────────────────────

export interface Floor { z: number; area: MultiPolygon; opId: string; opName: string }

/** Whether an op is the KIND that leaves a flat floor — no geometry, just its type. */
function leavesFlatFloor(op: AnyOperation): boolean {
  return op.type === 'pocket' || op.type === 'surface' ||
    (op.type === 'inlay' && op.role === 'female' && op.phase === 'endmill') ||
    (op.type === 'drill' && op.drillMode === 'helical')
}

/** The holes a helical drill bores, as (centre, radius) — `helicalHoles` when the op has
 *  it, otherwise the singular fields an op saved before that list carries. That fallback
 *  reads the hole as the TOOL-CENTRE radius, one tool radius smaller than the bore, which
 *  under-reports the floor: a smaller area is harder to cover, so the miss is an air pass,
 *  never a plunge (see the safety invariant at the top of this file). */
function helicalHolesOf(op: AnyOperation): { cx: number; cy: number; radiusMM: number }[] {
  if (op.type !== 'drill' || op.drillMode !== 'helical') return []
  if (op.helicalHoles?.length) return op.helicalHoles
  if (op.helicalCenterX === undefined || !op.helicalRadius) return []
  return [{ cx: op.helicalCenterX, cy: op.helicalCenterY ?? 0, radiusMM: op.helicalRadius }]
}

// A bore's floor is its own disc and nothing else. Deliberately NOT areaOfD of the source
// path: a path is not one hole — a plate with four bolt circles in it flattens to a plate
// with four holes, whose FILLED area is the plate, which is exactly the ground the drill
// did not touch. One un-nested polygon per hole is the cleared region itself. Overlapping
// discs need no union here; every consumer below clips this through polygon-clipping,
// which normalises its inputs.
function discAreas(holes: { cx: number; cy: number; radiusMM: number }[]): MultiPolygon {
  const SIDES = 64
  return holes.filter((h) => h.radiusMM > 1e-9).map((h) => {
    const ring: Ring = []
    for (let i = 0; i < SIDES; i++) {
      const a = (2 * Math.PI * i) / SIDES
      ring.push([h.cx + h.radiusMM * Math.cos(a), h.cy + h.radiusMM * Math.sin(a)])
    }
    return [ring]
  })
}

/**
 * The flat floor an operation leaves behind, or null if it doesn't leave one, given the
 * floors of every operation BEFORE it.
 *
 * Depth is measured from wherever that operation started, so the floor needs the op's own
 * start height — resolved against `preceding` alone. That is what makes the whole thing a
 * forward pass: an op can only ever sit on ground that earlier ops left, so walking the
 * program once in order and carrying the floors along answers everything, with no
 * recursion to memoise and no cycle to guard against.
 *
 * The region is the op's nominal cleared area, NOT its tool-reachable opening — a pocket
 * with a radius bigger than an inside corner leaves stock there that this over-reports.
 * That's the one place the resolver can read low, and it needs the footprint to reach
 * into a corner the previous tool couldn't; the simulator's stock model is what catches it.
 */
function floorLeftBy(
  op: AnyOperation,
  preceding: Floor[],
  pathById: Map<string, ImportedPath>,
  stock: Stock,
): FloorRow {
  const common = { opId: op.id, opName: op.name }

  if (op.type === 'pocket' || (op.type === 'inlay' && op.role === 'female' && op.phase === 'endmill')) {
    const boundary = pathById.get(op.pathId)
    if (!boundary) return { floor: null }
    const depth = op.type === 'pocket' ? op.depthMM : op.pocketDepthMM
    let area = areaOfD(boundary.d)
    if (area.length === 0) return { floor: null }
    const islands = op.islandIds.flatMap((id) => { const p = pathById.get(id); return p ? areaOfD(p.d) : [] })
    if (islands.length > 0) {
      const cut = safeClip(() => polygonClipping.difference(area, ...islands))
      if (!cut) return { floor: null }
      area = cut
    }
    // Same inputs the op's own generation used (margin 0, its own boundary) — so the
    // floor reported here is the Z its G-code actually reaches. Keep the answer, not just the number: this is the same question generation asks
    // about the op (its own boundary, margin 0, its own reference), and answering it is
    // the expensive half of building the table. Handing it back instead of recomputing it
    // halves the start-height cost of a Generate over a whole drawing.
    const own = queryStartZ({ startFrom: op.startFrom, footprintD: boundary.d, cutMarginMM: 0 }, preceding)
    return {
      floor: { ...common, z: own.zMM - Math.abs(depth), area },
      own: { startZ: own, footprintD: boundary.d, sfKey: startFromKey(op.startFrom) },
    }
  }

  // A helical bore takes the whole disc out to a flat bottom, so it leaves a floor like a
  // round pocket does — which is what lets a smaller hole drilled inside a bigger one start
  // from the bigger one's bottom instead of from stock top.
  if (op.type === 'drill') {
    const holes = helicalHolesOf(op)
    if (holes.length === 0) return { floor: null }
    const area = discAreas(holes)
    if (area.length === 0) return { floor: null }
    // The floor is at the op's OWN start minus its depth, so this has to be the same
    // question generation asks — which for a drill is `startInputForOp`: the source path,
    // and stock top when there isn't one. Answering it differently here is the crash
    // direction, since a start this reads deeper than generation used puts the floor
    // deeper than the hole really goes.
    const boundary = op.pathId ? pathById.get(op.pathId) : undefined
    if (!boundary) return { floor: { ...common, z: -Math.abs(op.depthMM), area } }
    const own = queryStartZ({ startFrom: op.startFrom, footprintD: boundary.d, cutMarginMM: 0 }, preceding)
    return {
      floor: { ...common, z: own.zMM - Math.abs(op.depthMM), area },
      own: { startZ: own, footprintD: boundary.d, sfKey: startFromKey(op.startFrom) },
    }
  }

  // Surfacing always runs from the stock top — it has no start reference of its own.
  if (op.type === 'surface') {
    return { floor: { ...common, z: -Math.abs(op.depthMM), area: rectPoly(0, 0, stock.widthMM, stock.heightMM) } }
  }

  return { floor: null }
}

/** One operation's contribution to the table: the floor it leaves, and — for the ops that
 *  leave one — the start height it was itself resolved to on the way there. */
interface FloorRow {
  floor: Floor | null
  own?: { startZ: StartZ; footprintD: string; sfKey: string }
}

/**
 * Every operation's floor, in program order — index i holds op i's floor, or null where it
 * leaves none. Built in one forward pass: op i is resolved against floors 0…i-1, which are
 * already final by the time it is reached.
 */
function buildFloors(ops: AnyOperation[], pathById: Map<string, ImportedPath>, stock: Stock): FloorRow[] {
  const rows: FloorRow[] = []
  const soFar: Floor[] = []
  for (const op of ops) {
    const row = leavesFlatFloor(op) ? floorLeftBy(op, soFar, pathById, stock) : { floor: null }
    rows.push(row)
    if (row.floor) soFar.push(row.floor)
  }
  return rows
}

// ─── Cross-call memo ──────────────────────────────────────────────────────────
//
// Building the table costs a polygon union + difference per floor-leaving op, and the
// callers are anything but one-shot: the pocket form resolves once per Generate, and
// useStartZ + listFlatFloorOps re-resolve on every render, which every store write during
// a generation run triggers. Generating 26 nested pockets ran 3302 of those unions instead
// of 26 — 34 s of polygon clipping (scratch/dog.fkam) — before any of this existed.
//
// So the table is memoised, and dropped whole whenever anything a floor could depend on
// changes. What it depends on is each op's floor-defining SETTINGS and the geometry of the
// paths they name — not segments, status or entry hints, which is exactly why a run of
// setSegments calls can share it.
//
// Invalidation is deliberately all-or-nothing and errs on the side of dropping too much: a
// stale floor reads as a surface that isn't there, and reading a surface too LOW is the
// crash direction (see the safety invariant at the top of this file).

// A path object is replaced, never mutated, when its geometry changes, so object identity
// stands in for the d string without hashing tens of kB of it per call.
let pathSerialCounter = 0
const pathSerials = new WeakMap<ImportedPath, number>()
function pathSerial(p: ImportedPath | undefined): number {
  if (!p) return -1
  let s = pathSerials.get(p)
  if (s === undefined) { s = ++pathSerialCounter; pathSerials.set(p, s) }
  return s
}

const startFromKey = (sf: StartFrom | undefined): string =>
  sf === undefined ? '-' : sf.mode === 'op' ? `o${sf.opId}` : sf.mode === 'manual' ? `m${sf.zMM}` : sf.mode[0]

/** Everything about one op that its floor — and therefore any later op's — depends on. */
function floorSig(op: AnyOperation, pathById: Map<string, ImportedPath>): string {
  if (op.type === 'pocket' || (op.type === 'inlay' && op.role === 'female' && op.phase === 'endmill')) {
    const depth = op.type === 'pocket' ? op.depthMM : op.pocketDepthMM
    const islands = op.islandIds.map((id) => pathSerial(pathById.get(id))).join('.')
    return `${op.id}p${pathSerial(pathById.get(op.pathId))}/${islands}/${depth}/${startFromKey(op.startFrom)}`
  }
  if (op.type === 'surface') return `${op.id}s${op.depthMM}`
  if (op.type === 'drill' && op.drillMode === 'helical') {
    // The holes are stored ON the op (re-derived from the path at generation), so the path
    // serial alone would not see a circle that moved before the next Generate — and the
    // footprint the op's own start resolves against is the path, so both belong here.
    const holes = helicalHolesOf(op).map((h) => `${h.cx},${h.cy},${h.radiusMM}`).join(';')
    return `${op.id}h${pathSerial(op.pathId ? pathById.get(op.pathId) : undefined)}/${op.depthMM}/${startFromKey(op.startFrom)}/${holes}`
  }
  return `${op.id}-`
}

interface FloorTable {
  /** Parallel to the ops list: index i is op i's row. */
  floors: FloorRow[]
  /** Op id → its position, so a caller's `opId` becomes a prefix length. */
  indexById: Map<string, number>
}

let memoKey: string | null = null
let memoTable: FloorTable = { floors: [], indexById: new Map() }
// Resolved answers, under the same key as the floors they were derived from. Two levels
// so the footprint — a whole path d string, tens of kB — is never concatenated into a
// key: the cheap part of the question picks the inner map, and the d string is only ever
// looked up, which V8 does against its cached hash.
let memoAnswers = new Map<string, Map<string, StartZ>>()
let memoAnswerCount = 0

// Identity fast path. Every store replaces its array rather than mutating it, so the same
// `ops` and `paths` objects mean the same content — and the callers ask repeatedly between
// writes (useStartZ and listFlatFloorOps on every render, resolveStartZForOp once per op in
// a revalidate sweep). Without this, each of those calls rebuilds the memo key: a
// path-id map over every path in the document plus a signature per operation.
let lastOps: AnyOperation[] | null = null
let lastPaths: ImportedPath[] | null = null
let lastStock = ''

/** The floor table for this exact (ops, paths, stock) state, rebuilt when any of it moves. */
function tableFor(ops: AnyOperation[], paths: ImportedPath[], stock: Stock): FloorTable {
  const stockKey = `${stock.widthMM}x${stock.heightMM}`
  if (memoKey !== null && ops === lastOps && paths === lastPaths && stockKey === lastStock) return memoTable
  const table = sharedTable(ops, new Map(paths.map((p) => [p.id, p])), stock)
  lastOps = ops
  lastPaths = paths
  lastStock = stockKey
  return table
}

function sharedTable(ops: AnyOperation[], pathById: Map<string, ImportedPath>, stock: Stock): FloorTable {
  let key = `${stock.widthMM}x${stock.heightMM}`
  for (const op of ops) key += '|' + floorSig(op, pathById)
  if (key !== memoKey) {
    memoKey = key
    memoAnswers = new Map()
    memoAnswerCount = 0
    memoTable = {
      floors: buildFloors(ops, pathById, stock),
      indexById: new Map(ops.map((op, i) => [op.id, i])),
    }
  }
  return memoTable
}

/** Test/harness hook: forget the memo so the next call rebuilds from scratch. */
export function __resetStartZMemo(): void {
  memoKey = null
  memoTable = { floors: [], indexById: new Map() }
  memoAnswers = new Map()
  memoAnswerCount = 0
  lastOps = null
  lastPaths = null
  lastStock = ''
}

// ─── Resolution ───────────────────────────────────────────────────────────────

export interface Stock { widthMM: number; heightMM: number }

/** Preceding ops that leave a flat floor — the pickable entries in the Start dropdown. */
export function listFlatFloorOps(
  ops: AnyOperation[],
  paths: ImportedPath[],
  stock: Stock,
  opId?: string,
): { opId: string; name: string; zMM: number }[] {
  return precedingFloors(ops, paths, stock, opId)
    .filter((f) => f.z < 0)
    .map((f) => ({ opId: f.opId, name: f.opName, zMM: f.z }))
}

/**
 * Floors of the ops strictly before `opId`, in program order. An unknown (or omitted) id
 * means every op counts — a form asking about an operation that does not exist yet.
 */
function precedingFloors(ops: AnyOperation[], paths: ImportedPath[], stock: Stock, opId?: string): Floor[] {
  const table = tableFor(ops, paths, stock)
  return floorsBefore(table, opId !== undefined ? table.indexById.get(opId) : undefined)
}

function floorsBefore(table: FloorTable, idx: number | undefined): Floor[] {
  const end = idx ?? table.floors.length
  const out: Floor[] = []
  for (let i = 0; i < end; i++) { const f = table.floors[i].floor; if (f) out.push(f) }
  return out
}

export interface ResolveInput {
  startFrom?: StartFrom
  /** Boundary path of the operation being generated. */
  footprintD: string
  /**
   * How far the cut reaches BEYOND that path — 0 for a pocket or a v-carve (both stay
   * inside their outline), the tool diameter for an outside profile, the radius for a
   * centerline one. It grows the footprint polygon, so it must be the real overhang and
   * not just "the tool radius": every mm here is a mm of extra ground that has to be
   * covered before auto will start below stock top.
   */
  cutMarginMM: number
  /** Id of the op being generated; it and everything after it are ignored. Omit for a new op. */
  opId?: string
}

/**
 * Resolve the Z the cut starts from. Never throws: anything it can't work out returns
 * stock top, which is always the safe answer.
 */
export function resolveStartZ(
  input: ResolveInput,
  ops: AnyOperation[],
  paths: ImportedPath[],
  stock: Stock,
): StartZ {
  // No reference at all = stock top, NOT auto. Operations saved before start heights
  // existed have no `startFrom`, and a project must emit the same G-code it always did;
  // auto is only ever applied when something explicitly asked for it (the forms write
  // `{ mode: 'auto' }` on every op they create).
  const mode = input.startFrom ?? { mode: 'stock' }
  if (mode.mode === 'stock') return STOCK_TOP
  if (mode.mode === 'manual') return { zMM: Math.min(0, mode.zMM), label: 'Custom' }

  const table = tableFor(ops, paths, stock)
  const idx = input.opId !== undefined ? table.indexById.get(input.opId) : undefined
  // The forward pass already answered this exact question on its way to building this op's
  // floor — same boundary, same reference, no overhang. Generation then asks it again, and
  // that second ask was half the start-height cost of a Generate over a whole drawing.
  const own = idx !== undefined ? table.floors[idx].own : undefined
  if (own && input.cutMarginMM === 0 && input.footprintD === own.footprintD &&
      startFromKey(input.startFrom) === own.sfKey) return own.startZ

  const preceding = floorsBefore(table, idx)
  // Repeat resolves of the SAME question are the common case, not an edge one: useStartZ
  // re-runs on every render with the form's own unchanged footprint. The table makes the
  // floors free but the footprint clip against them is still ~20 ms, so the answer itself
  // is memoised too — under the same key, so it dies with the floors it was derived from.
  const answerKey = `${mode.mode === 'op' ? mode.opId : 'a'} ${input.opId ?? ''} ${input.cutMarginMM}`
  let byFootprint = memoAnswers.get(answerKey)
  const hit = byFootprint?.get(input.footprintD)
  if (hit) return hit

  const answer = queryStartZ(input, preceding)
  // Bounded: a session of edits would otherwise accumulate one entry per version of every
  // path. Dropping the lot is fine — the floors, which are the expensive part, survive.
  if (memoAnswerCount > 400) { memoAnswers.clear(); memoAnswerCount = 0; byFootprint = undefined }
  if (!byFootprint) { byFootprint = new Map(); memoAnswers.set(answerKey, byFootprint) }
  byFootprint.set(input.footprintD, answer)
  memoAnswerCount++
  return answer
}

/**
 * The whole start-height question, against a fixed set of preceding floors: pure, no
 * stores, no memo, no ops list. Both entry points funnel through here — the forward pass
 * asking what an op sits on, and a caller asking about an arbitrary footprint.
 */
function queryStartZ(
  input: { startFrom?: StartFrom; footprintD: string; cutMarginMM: number },
  preceding: Floor[],
): StartZ {
  const mode = input.startFrom ?? { mode: 'stock' }
  if (mode.mode === 'stock') return STOCK_TOP
  if (mode.mode === 'manual') return { zMM: Math.min(0, mode.zMM), label: 'Custom' }

  if (mode.mode === 'op') {
    // Only backwards: a reference to a later op (or a deleted one) has no floor to stand
    // on, and stock top is the safe reading.
    const floor = preceding.find((f) => f.opId === mode.opId)
    if (!floor) return STOCK_TOP
    return { zMM: floor.z, sourceOpId: floor.opId, label: `Floor of ${floor.opName}` }
  }

  // ── auto ──
  // Nothing before this operation left a flat floor, so the answer is stock top and no
  // geometry has to be touched to know it. This is the whole answer for the first
  // operation in a project, and it skips flattening the footprint — which for a traced
  // outline is the most expensive part of a resolve that was always going to return 0.
  if (preceding.length === 0) return { zMM: 0, label: 'Stock top — nothing cut here yet' }

  // Footprint: the path's own filled outline, grown by however far the cut reaches past it.
  // The outline and not its bounding box — a bbox squares off every curve, and the corners
  // it invents stick outside a round pocket even when the real cut is comfortably inside,
  // which silently demoted the answer to stock top.
  const footprint = inflateArea(areaOfD(input.footprintD), Math.max(0, input.cutMarginMM))
  if (!footprint) return STOCK_TOP
  const bb = bboxOf(footprint)
  if (!bb) return STOCK_TOP

  // Candidates: preceding floors whose bbox overlaps the footprint. This is the rejection
  // that keeps the whole thing at "free" — the real polygon work below only ever runs on
  // the handful that survive (usually zero or one).
  const candidates: Floor[] = []
  for (const floor of preceding) {
    if (floor.z >= 0) continue
    const fb = bboxOf(floor.area)
    if (!fb) continue
    if (fb.maxX < bb.minX || fb.minX > bb.maxX || fb.maxY < bb.minY || fb.minY > bb.maxY) continue
    candidates.push(floor)
  }
  if (candidates.length === 0) return { zMM: 0, label: 'Stock top — nothing cut here yet' }

  // Cheap proof of uncut stock before any boolean: if an interior point of the footprint
  // lies outside every candidate floor, the footprint is not covered and the answer is
  // stock top. One point test per candidate instead of a union and a difference — and it
  // is the answer for the everyday case, a drawing pocketed in one go where each shape
  // sits in a HOLE of the shape around it. Only ever reads HIGH: a point that lands
  // exactly on a floor's edge reads as uncovered, which is the safe direction.
  const probes = footprint.map((poly) => interiorPoint(poly.map((r) => r.map(([x, y]) => [x, y] as Pt2))))
  for (const probe of probes) {
    if (!probe) continue
    if (!candidates.some((c) => pointInArea(probe[0], probe[1], c.area))) {
      return { zMM: 0, label: 'Stock top — part of this reaches uncut stock' }
    }
  }

  // Any part of the footprint over uncut stock and the answer is stock top — the tool
  // would meet full-height material there whatever the rest of it sits over.
  // One candidate is the overwhelmingly common case (48 of 51 resolves on the dog file),
  // and a union of one area is that area — the clipper normalises its inputs anyway, so
  // the difference below sees the same thing either way.
  const covered = candidates.length === 1
    ? candidates[0].area
    : safeClip(() => polygonClipping.union(candidates[0].area, ...candidates.slice(1).map((c) => c.area)))
  if (!covered) return STOCK_TOP
  const uncovered = safeClip(() => polygonClipping.difference(footprint, covered))
  if (!uncovered) return STOCK_TOP
  if (areaOf(uncovered) > EPS_AREA_MM2) {
    return { zMM: 0, label: `Stock top — ${areaOf(uncovered).toFixed(1)} mm² of this reaches uncut stock` }
  }

  // Residual height at a point is the DEEPEST floor covering it (the last cut wins), and
  // the start height is the highest of those over the footprint. So walk the levels
  // shallowest first and take the first one that still owns ground the footprint touches
  // after the deeper floors have been subtracted from it.
  const levels = [...new Set(candidates.map((c) => c.z))].sort((a, b) => b - a)
  for (const level of levels) {
    const atLevel = candidates.filter((c) => c.z === level)
    const deeper = candidates.filter((c) => c.z < level)
    const union = safeClip(() => polygonClipping.union(atLevel[0].area, ...atLevel.slice(1).map((c) => c.area)))
    if (!union) return STOCK_TOP
    const exclusive = deeper.length === 0
      ? union
      : safeClip(() => polygonClipping.difference(union, ...deeper.map((c) => c.area)))
    if (!exclusive) return STOCK_TOP
    if (exclusive.length === 0) continue
    const hit = safeClip(() => polygonClipping.intersection(exclusive, footprint))
    if (!hit) return STOCK_TOP
    if (areaOf(hit) > EPS_AREA_MM2) {
      const src = atLevel[0]
      return {
        zMM: level,
        sourceOpId: src.opId,
        label: atLevel.length === 1 ? `Floor of ${src.opName}` : `Floor of ${src.opName} +${atLevel.length - 1}`,
      }
    }
  }

  return STOCK_TOP
}

// ─── Per-operation convenience ────────────────────────────────────────────────

/**
 * The resolver inputs for an existing operation, or null when the operation type has no
 * start-height support (drill, surfacing, trochoidal, inlay, 3D, imported G-code — those
 * always run from the stock top).
 *
 * One definition of "what does this op sit on", used by generation, by the stamp that
 * records what generation used, and by the staleness check that compares the two. They
 * cannot drift apart into disagreeing about an op's start height.
 */
/** One closed circle per point, as a compound d string — a set of clicked holes. */
function discsD(points: { x: number; y: number }[], r: number): string {
  return points.map(({ x, y }) =>
    `M ${x - r} ${y} A ${r} ${r} 0 1 0 ${x + r} ${y} A ${r} ${r} 0 1 0 ${x - r} ${y} Z`).join(' ')
}

/**
 * How far past its outline a profile's TOOL reaches — the margin its footprint is grown by
 * when working out what surface it starts on. The one definition: ProfileForm previews the
 * start height with it and `startInputForOp` stamps and re-checks with it, and the two
 * copies this replaces had already drifted once (over the allowance).
 *
 * The width is the tool's WIDEST cutting diameter, `2 · maxCutRadiusMM`, not `diameterMM`:
 * a taper stores its TIP there. With the tip, a taper profile running close to a pocket's
 * wall had a footprint that fitted inside the pocket, resolved to the pocket floor, and
 * started its first pass there while the body of the bit reached over the wall into stock
 * at full height — reading too LOW, the crash direction. A wider footprint can only read
 * higher, so the widest diameter is also the safe one.
 *
 * Outside: a full diameter past the path, plus the stock left on the wall. Centerline: half
 * a diameter. Inside: nothing — unless a NEGATIVE allowance carries the tool past the line,
 * which is the only way an inside cut reaches outside it at all.
 */
export function profileCutMarginMM(side: CutSide, tool: Tool | undefined, allowanceMM = 0): number {
  const dia = tool ? 2 * maxCutRadiusMM(tool) : 0
  return side === 'outside' ? Math.max(0, dia + allowanceMM)
    : side === 'centerline' ? dia / 2
    : Math.max(0, -allowanceMM)
}

export function startInputForOp(
  op: AnyOperation,
  paths: ImportedPath[],
  tools: Tool[],
): ResolveInput | null {
  if (op.type !== 'pocket' && op.type !== 'vcarve' && op.type !== 'profile'
      && op.type !== 'photovcarve' && op.type !== 'drill') return null
  const path = paths.find((p) => p.id === op.pathId)
  // A drill op need not have a path at all: peck points are clicked on the canvas. Its
  // footprint is then the holes themselves, each a disc of the tool — small, but it is
  // what decides whether those points land on a pocket floor or on bare stock.
  if (!path) {
    if (op.type !== 'drill' || op.points.length === 0) return null
    const drillTool = tools.find((t) => t.id === op.toolId)
    const r = drillTool ? maxCutRadiusMM(drillTool) : 0
    if (r <= 0) return null
    return { startFrom: op.startFrom, footprintD: discsD(op.points, r), cutMarginMM: 0, opId: op.id }
  }
  // Pocket, v-carve and photo v-carve stay inside their outline (the photo's own rectangle,
  // which is where its raster lines are clipped); a profile swings the tool outside it.
  // A drill stays inside its own circle: the bore's wall IS the path.
  const cutMarginMM = op.type === 'profile'
    ? profileCutMarginMM(op.side, tools.find((t) => t.id === op.toolId), op.allowanceMM ?? 0)
    : 0
  return { startFrom: op.startFrom, footprintD: path.d, cutMarginMM, opId: op.id }
}

/** Resolved start Z for an existing operation; 0 for types with no start-height support. */
export function resolveStartZForOp(
  op: AnyOperation,
  ops: AnyOperation[],
  paths: ImportedPath[],
  stock: Stock,
  tools: Tool[],
): StartZ {
  const input = startInputForOp(op, paths, tools)
  if (!input) return STOCK_TOP
  return resolveStartZ(input, ops, paths, stock)
}
