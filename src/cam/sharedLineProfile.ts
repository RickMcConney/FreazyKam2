// ─── Optimized profiles (shared lines, routing, bridges) ──────────────────────
//
// ONE outside profile of a whole sheet of parts, cut as a NETWORK of lines rather than
// part by part — the Profile form's "Optimize Path". Three things make it faster than
// profiling each part on its own, and each is optional in the geometry it is given:
//
// SHARED LINES. Two outlines exactly one cutter diameter apart have outside offsets that
// coincide along every pair of facing parallel edges, so one pass down that line finishes
// BOTH walls. The Nest tool's Shared Lines option places parts at that gap; here the
// coincidence is DETECTED, never assumed — `planCommonLineCut` on the very offsets the cut
// follows — so a sheet nested any other way simply shares nothing and is still routed.
//
// ROUTING. Laid out as one graph (every span of every cut path an edge, each shared span
// once), the cut is a question of how to WALK the graph: at each junction, which lines
// arriving there continue into which. Pairing them straight through avoids a corner the
// machine would slow for; pairing them some other way can join two toolpaths into one.
// `routeNetwork` chooses by what it costs in TIME — a corner's slowdown (the controller's
// junction-deviation rule) on every pass, against the retract, travel and plunges of every
// extra toolpath. Between toolpaths the tool stays down and travels along kerf already cut
// through when that is quicker than lifting (`travel` moves), never over a tab.
//
// BRIDGES (optional, `bridgeMaxMM`). A short straight cut through the WASTE between two
// parts — two rectangles end to end, say — that joins two toolpaths into one. Each is an
// edge the router may use, at the price of cutting it every pass, and uses only when that
// saves time. A bridge never comes closer to any part than the cut path does (so it cannot
// mark one), never crosses a tab, and only joins two DIFFERENT parts' cut paths, so it stays
// in the gaps between them and never runs into the free stock beyond. It does not ask
// whether the waste it cuts off will stay put — hold the sheet down (tape, clamps). Bridge
// moves carry `bridge: true` so the preview can show them.
//
// THE PLAN IS ALL OR NOTHING. If the detection refuses the layout — two cut paths that
// cross, parts that overlap, a line with three owners — every part is cut as an ordinary
// outside profile instead (still in one operation, nearest part next) and a note says why.

import { flattenPath, isOpenSubpath, splitSelfIntersecting, ensureWinding, signedArea, type Pt2 } from './pathFlattener'
import {
  generateProfile, offsetClosedSubpaths, emitProfilePath, designPathAtT, nearestArcLen, tabClearRadiusMM, fitPassCoarse,
  type ProfileParams, type PathEmitContext, type TabRange,
} from './profile'
import { planCommonLineCut, segmentLength, type CommonLineIssue } from './commonLine'
import { arcLengths, interpPt, interiorPoint, pointInPolygon, toolRadiusAtHeight, zPasses, ptSegDistSq } from './geom'
import { addNote } from './notes'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { Tab } from '../store/tabStore'

export interface SharedLinePart {
  d: string
  tabs?: Tab[]
}

/** What the routing needs to know about the machine to price a corner against a toolpath. */
export interface MachineRates {
  /** Rapid rate, mm/min. */
  rapidMmMin: number
  /** XY acceleration, mm/s². */
  accelMmS2: number
  /** The controller's junction deviation, mm — what decides how fast it takes a corner. */
  junctionDeviationMM: number
}

export interface OptimizeOptions {
  /** Longest straight cut through waste the router may add to join two toolpaths. 0 / absent = never. */
  bridgeMaxMM?: number
}

export interface SharedLineResult {
  segments: MotionSegment[]
  /** Length of cut path that is shared, each line counted once (per pass). 0 when nothing is shared. */
  sharedLengthMM: number
  /** How many separate toolpaths the sheet is cut as — each one retract, rapid and set of plunges. */
  toolpaths: number
  /** How many bridges through waste the routing chose. */
  bridges: number
}

/** The matching tolerance between two parts' cut paths. Coincidence itself is capped far finer — see commonLine.ts. */
const MATCH_TOLERANCE_MM = 0.01
/** How near a cut path a tab's projected point must lie to hold that path up. */
const TAB_SNAP_MM = 0.01
/**
 * Two span ends this close are one junction. Not 1e-6: the cut paths come out of Clipper
 * rounded to a 1e-6 mm grid, so the same corner reached from two parts' paths can differ by
 * a grid step in each axis — √2·1e-6 apart — and a merge that tight split one T-junction of
 * a nested sheet into a dead end and a pass-through, costing the routing a toolpath. Still
 * ten times inside the planner's own coincidence cap (MAX_PHYSICAL_COINCIDENCE_MM).
 */
const NODE_MERGE_MM = 1e-4
/** Same factor gcode.ts applies to a `travel` move — so the routing prices it as it will run. */
const TRAVEL_FEED_FACTOR = 2.5

const ISSUE_TEXT: Record<CommonLineIssue['code'], string> = {
  invalid_contour: 'a part outline is degenerate',
  duplicate_contour: 'two parts lie on top of each other',
  self_intersection: 'a cut path crosses itself',
  // The contours are CUT PATHS, so either of these means two parts less than one
  // cutter apart (or overlapping outright) — the user's question is the same.
  crossing: 'two parts are closer than the cutter',
  area_overlap: 'two parts are closer than the cutter',
  ambiguous_shared_line: 'a line is shared by three parts',
}

type XY = { x: number; y: number }

function lastXY(segs: MotionSegment[]): XY | undefined {
  const s = segs[segs.length - 1]
  return s ? { x: s.x, y: s.y } : undefined
}

function segSegDistSq(a: Pt2, b: Pt2, c: Pt2, d: Pt2): number {
  const cross = (o: Pt2, p: Pt2, q: Pt2) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  return Math.min(
    ptSegDistSq(a[0], a[1], c[0], c[1], d[0], d[1]), ptSegDistSq(b[0], b[1], c[0], c[1], d[0], d[1]),
    ptSegDistSq(c[0], c[1], a[0], a[1], b[0], b[1]), ptSegDistSq(d[0], d[1], a[0], a[1], b[0], b[1]),
  )
}

// ─── Time ─────────────────────────────────────────────────────────────────────

/**
 * Seconds a corner costs the machine on ONE pass: braking from the cutting feed to the
 * speed the controller allows through it, and accelerating back. That speed is GRBL's
 * junction-deviation rule, v² = a·δ·s/(1−s) with s = sin(θ/2) and θ the angle between the
 * reversed incoming direction and the outgoing one — straight on costs nothing, a full
 * reversal stops dead. `turnCos` is the cosine of the turn itself (1 = straight on).
 */
export function cornerSeconds(turnCos: number, feedMmMin: number, rates: MachineRates): number {
  const F = feedMmMin / 60
  const a = rates.accelMmS2
  if (!(a > 0) || turnCos >= 1 - 1e-12) return 0
  const s = Math.sqrt(Math.max(0, 0.5 * (1 + turnCos)))  // sin(θ/2), θ between reversed-in and out
  const v = s >= 1 - 1e-12 ? Infinity : Math.sqrt((a * rates.junctionDeviationMM * s) / (1 - s))
  if (v >= F) return 0
  return ((F - v) * (F - v)) / (a * F)
}

/**
 * Estimated run time (minutes) of `segs` starting with the tool at `from` — cutting moves
 * at the tool's feed (scaled by `feedScale` on a ramp, ×2.5 on a `travel`), a straight drop
 * at its plunge feed, rapids at the machine's rapid rate. Corners are not charged. A
 * yardstick for comparing two cuts of the same job, not a promise: cam/opTime.ts is.
 */
export function estimateMinutes(segs: MotionSegment[], from: { x: number; y: number; z: number }, tool: Tool, rapidMmMin: number): number {
  let t = 0
  let px = from.x, py = from.y, pz = from.z
  for (const s of segs) {
    const xy = s.arc ? arcLength(px, py, s) : Math.hypot(s.x - px, s.y - py)
    const dz = Math.abs(s.z - pz)
    if (s.rapid) t += Math.hypot(xy, dz) / rapidMmMin
    else if (xy < 1e-9) t += dz / tool.zFeedMmMin
    else t += Math.hypot(xy, dz) / (tool.xyFeedMmMin * (s.feedScale ?? 1) * (s.travel ? TRAVEL_FEED_FACTOR : 1))
    px = s.x; py = s.y; pz = s.z
  }
  return t
}

function arcLength(px: number, py: number, s: MotionSegment): number {
  const { cx, cy, cw } = s.arc!
  const r = Math.hypot(px - cx, py - cy)
  let sweep = Math.atan2(s.y - cy, s.x - cx) - Math.atan2(py - cy, px - cx)
  if (cw) sweep = -sweep
  if (sweep <= 1e-12) sweep += 2 * Math.PI
  return r * sweep
}

// ─── The network ──────────────────────────────────────────────────────────────

/**
 * A graph of straight spans. Edge `e` runs from node `ends[2e]` to node `ends[2e+1]`;
 * HALF-EDGE `h` is edge `h >> 1` seen from the node at its end `h & 1`, pointing away
 * from that node along `dir[h]`. `owners[n]` are the cut paths a node lies on.
 */
export interface Network {
  nodes: Pt2[]
  ends: number[]
  dir: Pt2[]
  /** Half-edges at each node. */
  at: number[][]
  owners: Set<string>[]
}

export function buildNetwork(spans: [Pt2, Pt2][], spanOwners?: string[][]): Network {
  const net: Network = { nodes: [], ends: [], dir: [], at: [], owners: [] }
  const cells = new Map<string, number[]>()
  const CELL = 1e-3
  const nodeOf = (p: Pt2): number => {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (Math.hypot(net.nodes[i][0] - p[0], net.nodes[i][1] - p[1]) <= NODE_MERGE_MM) return i
      }
    }
    net.nodes.push(p)
    net.at.push([])
    net.owners.push(new Set())
    const k = `${cx},${cy}`
    if (!cells.has(k)) cells.set(k, [])
    cells.get(k)!.push(net.nodes.length - 1)
    return net.nodes.length - 1
  }
  spans.forEach(([a, b], i) => {
    const na = nodeOf(a), nb = nodeOf(b)
    for (const o of spanOwners?.[i] ?? []) { net.owners[na].add(o); net.owners[nb].add(o) }
    addEdge(net, na, nb)
  })
  return net
}

/** Add an edge between two existing nodes; its index, or -1 if they coincide. */
export function addEdge(net: Network, na: number, nb: number): number {
  const a = net.nodes[na], b = net.nodes[nb]
  const L = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (na === nb || L < 1e-9) return -1
  const u: Pt2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  const e = net.ends.length / 2
  net.ends.push(na, nb)
  net.dir.push(u, [-u[0], -u[1]])
  net.at[na].push(2 * e)
  net.at[nb].push(2 * e + 1)
  return e
}

/**
 * Every way to pair up the half-edges at a node, leaving at most one unpaired (an odd
 * node is where a toolpath has to end). Exhaustive up to six — a junction of more lines
 * than that is not a nest — and greedy, straightest first, beyond.
 */
function pairingsAt(hs: number[], straightness: (h1: number, h2: number) => number): [number, number][][] {
  if (hs.length > 6) {
    const out: [number, number][] = []
    const cands = hs.flatMap((h1, i) => hs.slice(i + 1).map((h2) => [h1, h2] as [number, number]))
      .sort((p, q) => straightness(q[0], q[1]) - straightness(p[0], p[1]))
    const used = new Set<number>()
    for (const [h1, h2] of cands) if (!used.has(h1) && !used.has(h2)) { out.push([h1, h2]); used.add(h1); used.add(h2) }
    return [out]
  }
  const out: [number, number][][] = []
  const rec = (rest: number[], acc: [number, number][], skipped: boolean) => {
    if (rest.length === 0) { out.push(acc); return }
    const [h, ...others] = rest
    // Leave `h` unpaired — allowed once, and only where the count is odd.
    if (!skipped && rest.length % 2 === 1) rec(others, acc, true)
    others.forEach((g, i) => rec([...others.slice(0, i), ...others.slice(i + 1)], [...acc, [h, g]], skipped))
  }
  rec(hs, [], false)
  return out
}

/**
 * The toolpaths a pairing makes: each a list of node indices and the edges between them,
 * and whether it closes on itself. Edges not `active` (bridges left out) are not walked.
 */
export function walkTrails(net: Network, partner: Int32Array, active?: Uint8Array): { nodes: number[]; edges: number[]; closed: boolean }[] {
  const seen = new Uint8Array(net.ends.length / 2)
  if (active) for (let e = 0; e < seen.length; e++) if (!active[e]) seen[e] = 1
  const trails: { nodes: number[]; edges: number[]; closed: boolean }[] = []
  const walk = (h0: number) => {
    const nodes = [net.ends[h0]]
    const edges: number[] = []
    let h = h0
    for (;;) {
      seen[h >> 1] = 1
      edges.push(h >> 1)
      const far = h ^ 1
      nodes.push(net.ends[far])
      const next = partner[far]
      if (next < 0) return { nodes, edges, closed: false }
      if (next === h0) return { nodes, edges, closed: true }
      h = next
    }
  }
  // Open toolpaths start at an unpaired half-edge; what is left after them is loops.
  for (let h = 0; h < net.ends.length; h++) if (partner[h] < 0 && !seen[h >> 1]) trails.push(walk(h))
  for (let h = 0; h < net.ends.length; h++) if (!seen[h >> 1]) trails.push(walk(h))
  return trails
}

/**
 * How the lines meeting at each junction continue into each other, and which optional
 * edges (bridges) to cut — chosen for least time. `cornerCost(turnCos)` is what one corner
 * costs (all passes), `trailCost` what one more toolpath costs, `optional` the edges that
 * may be left out with what each costs to cut. Starts from the straightest pairing at every
 * node and no optional edges, then — while either saves time — changes one node's pairing
 * (which is how two toolpaths meeting at a junction get spliced into one), or puts in or
 * takes out one optional edge with the best pairing at its two ends.
 */
export function routeNetwork(
  net: Network, cornerCost: (turnCos: number) => number, trailCost: number, optional: Map<number, number> = new Map(),
): { partner: Int32Array; active: Uint8Array } {
  const E = net.ends.length / 2
  const active = new Uint8Array(E).fill(1)
  for (const e of optional.keys()) active[e] = 0
  const partner = new Int32Array(net.ends.length).fill(-1)
  // Cosine of the turn from arriving along h1 (travelling AGAINST dir[h1]) to leaving along h2.
  const turnCos = (h1: number, h2: number) => -(net.dir[h1][0] * net.dir[h2][0] + net.dir[h1][1] * net.dir[h2][1])
  const optionsAt = (n: number) => pairingsAt(net.at[n].filter((h) => active[h >> 1]), turnCos)
    .map((pairs) => ({ pairs, cost: pairs.reduce((s, [a, b]) => s + cornerCost(turnCos(a, b)), 0) }))
  const options = net.nodes.map((_, n) => optionsAt(n))
  const initial = (ops: { pairs: [number, number][]; cost: number }[]) => {
    // Fewest ends first (an extra end is an extra toolpath), then the cheapest corners.
    let best = 0
    ops.forEach((o, i) => {
      const b = ops[best]
      if (o.pairs.length > b.pairs.length || (o.pairs.length === b.pairs.length && o.cost < b.cost)) best = i
    })
    return best
  }
  const choice = options.map(initial)
  const apply = (n: number) => {
    for (const h of net.at[n]) partner[h] = -1
    for (const [a, b] of options[n][choice[n]]?.pairs ?? []) { partner[a] = b; partner[b] = a }
  }
  options.forEach((_, n) => apply(n))

  const total = () => {
    let t = walkTrails(net, partner, active).length * trailCost
    options.forEach((ops, n) => { t += ops[choice[n]]?.cost ?? 0 })
    for (const [e, c] of optional) if (active[e]) t += c
    return t
  }
  let best = total()
  let improved = true
  for (let round = 0; improved && round < 50; round++) {
    improved = false
    for (let n = 0; n < options.length; n++) {
      if (options[n].length < 2) continue
      const keep = choice[n]
      for (let k = 0; k < options[n].length; k++) {
        if (k === keep) continue
        choice[n] = k
        apply(n)
        const t = total()
        if (t < best - 1e-9) { best = t; improved = true; break }
        choice[n] = keep
        apply(n)
      }
    }
    for (const e of optional.keys()) {
      const u = net.ends[2 * e], v = net.ends[2 * e + 1]
      const saved = { ou: options[u], ov: options[v], cu: choice[u], cv: choice[v] }
      active[e] ^= 1
      options[u] = optionsAt(u)
      options[v] = optionsAt(v)
      let bestT = Infinity, bk = [0, 0]
      for (let i = 0; i < options[u].length; i++) {
        for (let j = 0; j < options[v].length; j++) {
          choice[u] = i; choice[v] = j
          apply(u); apply(v)
          const t = total()
          if (t < bestT) { bestT = t; bk = [i, j] }
        }
      }
      if (bestT < best - 1e-9) {
        best = bestT
        choice[u] = bk[0]; choice[v] = bk[1]
        apply(u); apply(v)
        improved = true
      } else {
        active[e] ^= 1
        options[u] = saved.ou; options[v] = saved.ov
        choice[u] = saved.cu; choice[v] = saved.cv
        apply(u); apply(v)
      }
    }
  }
  return { partner, active }
}

/**
 * Is travelling `kerfMM` along cut kerf at depth quicker than lifting `liftMM` to safe
 * height, a rapid `hopMM` across, and plunging `plungeMM` from safe height to the first
 * pass? Travel runs at the cutting feed ×2.5, as gcode.ts writes it.
 */
export function travelBeatsLift(kerfMM: number, hopMM: number, liftMM: number, plungeMM: number, tool: Tool, rates: MachineRates): boolean {
  const travel = kerfMM / (tool.xyFeedMmMin * TRAVEL_FEED_FACTOR)
  const lift = (2 * liftMM + hopMM) / rates.rapidMmMin + plungeMM / tool.zFeedMmMin
  return travel < lift
}

/**
 * The shortest way from node `from` to node `to` along edges `usable` says the tool may
 * travel down — length in mm and the nodes on the way — or null if there is none.
 */
function kerfRoute(net: Network, from: number, to: number, usable: (e: number) => boolean): { length: number; nodes: number[] } | null {
  if (from === to) return { length: 0, nodes: [from] }
  const dist = new Map<number, number>([[from, 0]])
  const prev = new Map<number, number>()
  const done = new Set<number>()
  for (;;) {
    let n = -1, dn = Infinity
    for (const [k, d] of dist) if (!done.has(k) && d < dn) { n = k; dn = d }
    if (n < 0) return null
    if (n === to) break
    done.add(n)
    for (const h of net.at[n]) {
      if (!usable(h >> 1)) continue
      const m = net.ends[h ^ 1]
      const p = net.nodes[n], q = net.nodes[m]
      const d = dn + Math.hypot(q[0] - p[0], q[1] - p[1])
      if (d < (dist.get(m) ?? Infinity)) { dist.set(m, d); prev.set(m, n) }
    }
  }
  const nodes = [to]
  while (nodes[0] !== from) nodes.unshift(prev.get(nodes[0])!)
  return { length: dist.get(to)!, nodes }
}

// ─── The cut ──────────────────────────────────────────────────────────────────

/**
 * Cut every part as one outside profile, routed as a network — sharing the lines two
 * neighbours' cut paths have in common, and bridging gaps through waste when `options`
 * allows. `params.startNear` is where the tool comes from.
 */
export function generateSharedLineProfile(
  parts: SharedLinePart[], tool: Tool, params: ProfileParams, rates: MachineRates, options: OptimizeOptions = {},
): SharedLineResult {
  const plain = (why: string): SharedLineResult => {
    if (why) addNote({ kind: 'shared-lines', short: why })
    // Still one operation: nearest part next, each cut as an ordinary outside profile.
    const segments: MotionSegment[] = []
    const left = parts.map((_, i) => i)
    let at = params.startNear
    while (left.length) {
      const cuts = left.map((i) => generateProfile(parts[i].d, tool, { ...params, startNear: at }, parts[i].tabs))
      let k = 0
      if (at) {
        const here = at
        const d = (segs: MotionSegment[]) => { const s = segs.find((x) => !x.rapid); return s ? Math.hypot(s.x - here.x, s.y - here.y) : Infinity }
        cuts.forEach((c, i) => { if (d(c) < d(cuts[k])) k = i })
      }
      for (const s of cuts[k]) segments.push(s)
      left.splice(k, 1)
      at = lastXY(segments) ?? at
    }
    return { segments, sharedLengthMM: 0, toolpaths: parts.length, bridges: 0 }
  }

  if (params.side !== 'outside' || parts.length < 2) return plain('')

  // The cut paths, offset exactly as generateProfile offsets them — stock allowance
  // included. Corner rounding is not applied: it moves a corner of one part's path off the
  // line its neighbour shares.
  const delta = toolRadiusAtHeight(tool, params.depthMM) + (params.allowanceMM ?? 0)
  const prepared = parts.map((part) => {
    const flat = flattenPath(part.d, 0.05)
    const closedSubs = splitSelfIntersecting(flat.filter((sp) => !isOpenSubpath(sp)))
    const openSubs = flat.filter(isOpenSubpath)
    return { closedSubs, openSubs, rings: openSubs.length || delta <= 0 ? [] : offsetClosedSubpaths(closedSubs, delta) }
  })
  // An open or empty part: generateProfile says what is wrong with it.
  if (prepared.some((p) => p.rings.length === 0)) return plain('')

  // A cut path inside another part's — a part nested in a hole of another — cannot share
  // anything, and would read as an overlap to the planner. It is cut as a loop of its own.
  const wantCCW = params.direction === 'conventional' // an outside climb cut runs CW
  const rings = prepared.flatMap((p, pi) => p.rings.map((ring, ri) => ({ ring: ensureWinding(ring, wantCCW), id: `${pi}/${ri}` })))
  const inside = new Set<string>()
  for (const a of rings) {
    const ip = interiorPoint([a.ring])
    if (ip && rings.some((b) => b !== a && pointInPolygon(ip[0], ip[1], b.ring))) inside.add(a.id)
  }
  const plan = planCommonLineCut(rings.filter((r) => !inside.has(r.id)).map((r) => ({ id: r.id, points: r.ring })), MATCH_TOLERANCE_MM)
  if (plan.issues.length) return plain(`Shared lines off: ${ISSUE_TEXT[plan.issues[0].code]}`)
  const sharedLengthMM = plan.sharedSegments.reduce((s, x) => s + segmentLength(x), 0)

  // Every tab, as the point on its OWN part's cut path — whichever toolpath runs over that
  // point is the one that has to lift there.
  const startZ = Math.min(0, params.startZMM ?? 0)
  const tabPoints = parts.flatMap((part, pi) => (part.tabs ?? []).flatMap((tab) => {
    const pos = designPathAtT([...prepared[pi].closedSubs, ...prepared[pi].openSubs], tab.t)
    if (!pos) return []
    let best: Pt2 = pos
    let bestD = Infinity
    for (const ring of prepared[pi].rings) {
      const closed = [...ring, ring[0]]
      const { lens } = arcLengths(closed)
      const q = interpPt(closed, lens, nearestArcLen(closed, lens, pos[0], pos[1]))
      const d = Math.hypot(q[0] - pos[0], q[1] - pos[1])
      if (d < bestD) { bestD = d; best = q }
    }
    return [{ q: best, half: tab.lengthMM / 2 + tabClearRadiusMM(tool, tab), tabZ: Math.min(startZ, startZ - params.depthMM + tab.heightMM) }]
  }))
  const onPath = (q: Pt2, pts: Pt2[]) => {
    for (let i = 1; i < pts.length; i++) {
      if (ptSegDistSq(q[0], q[1], pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= TAB_SNAP_MM ** 2) return true
    }
    return false
  }
  const tabRangesOn = (pts: Pt2[], lens: number[]): TabRange[] => tabPoints.flatMap((t) => {
    if (!onPath(t.q, pts)) return []
    const c = nearestArcLen(pts, lens, t.q[0], t.q[1])
    return [{ start: c - t.half, end: c + t.half, tabZ: t.tabZ }]
  })
  const passes = zPasses(params.depthMM, params.stepDownMM, startZ)
  const finalZ = passes[passes.length - 1]
  const safeZ = params.safeHeightMM ?? 5

  const allSpans = [...plan.perimeterSegments, ...plan.sharedSegments]
  const net = buildNetwork(allSpans.map((s) => [s.start, s.end]), allSpans.map((s) => s.ownerIds))
  const baseEdges = net.ends.length / 2

  // Candidate bridges: a straight cut between nodes on two different parts' cut paths, no
  // longer than allowed, that keeps at least the cut path's own distance from every part
  // (it cannot mark one), passes through no other junction, and crosses no tab. Only from
  // a JUNCTION or a real CORNER — a bridge leaving a smooth curve mid-way turns a corner of
  // its own, and a flattened curve is hundreds of such points — and only each node's few
  // shortest, which keeps the routing's search to the bridges that can matter.
  const optional = new Map<number, number>()
  const bridgeMax = options.bridgeMaxMM ?? 0
  if (bridgeMax > 0) {
    const BRIDGES_PER_NODE = 4
    const CORNER_COS = Math.cos((30 * Math.PI) / 180)
    const partsOf = (n: number) => new Set([...net.owners[n]].map((id) => id.slice(0, id.indexOf('/'))))
    const isEnd = (n: number) => {
      const hs = net.at[n]
      if (hs.length !== 2) return true
      return -(net.dir[hs[0]][0] * net.dir[hs[1]][0] + net.dir[hs[0]][1] * net.dir[hs[1]][1]) < CORNER_COS
    }
    const ends = net.nodes.map((_, n) => n).filter(isEnd)
    const outline = prepared.flatMap((p) => p.closedSubs.flatMap((sp) => sp.map((a, i) => [a, sp[(i + 1) % sp.length]] as [Pt2, Pt2])))
    const clear = (delta - 1e-6) ** 2
    const linked = new Set<string>()
    for (let e = 0; e < baseEdges; e++) linked.add(`${Math.min(net.ends[2 * e], net.ends[2 * e + 1])},${Math.max(net.ends[2 * e], net.ends[2 * e + 1])}`)
    const near = new Map<number, { v: number; L: number }[]>()
    for (let i = 0; i < ends.length; i++) {
      const u = ends[i]
      const pu = partsOf(u)
      for (let j = i + 1; j < ends.length; j++) {
        const v = ends[j]
        const a = net.nodes[u], b = net.nodes[v]
        const L = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (L > bridgeMax || L < 1e-6 || linked.has(`${u},${v}`)) continue
        if ([...partsOf(v)].some((p) => pu.has(p))) continue
        for (const [x, y] of [[u, v], [v, u]]) {
          if (!near.has(x)) near.set(x, [])
          near.get(x)!.push({ v: y, L })
        }
      }
    }
    const tried = new Set<string>()
    for (const [u, list] of near) {
      for (const { v, L } of list.sort((p, q) => p.L - q.L).slice(0, BRIDGES_PER_NODE)) {
        const key = `${Math.min(u, v)},${Math.max(u, v)}`
        if (tried.has(key)) continue
        tried.add(key)
        const a = net.nodes[u], b = net.nodes[v]
        if (outline.some(([c, d]) => segSegDistSq(a, b, c, d) < clear)) continue
        if (net.nodes.some((w, k) => k !== u && k !== v && ptSegDistSq(w[0], w[1], a[0], a[1], b[0], b[1]) < 1e-8)) continue
        if (tabPoints.some((t) => ptSegDistSq(t.q[0], t.q[1], a[0], a[1], b[0], b[1]) < t.half ** 2)) continue
        const e = addEdge(net, u, v)
        if (e >= 0) optional.set(e, (60 * passes.length * L) / tool.xyFeedMmMin)
      }
    }
  }

  // Route. A corner is paid on every pass; a toolpath costs its retract and return, its
  // plunges (the whole depth at plunge feed) and a typical hop to the next one.
  const cornerCost = (c: number) => passes.length * cornerSeconds(c, tool.xyFeedMmMin, rates)
  const trailCost = 60 * (params.depthMM / tool.zFeedMmMin + (2 * (safeZ - startZ) + 25) / rates.rapidMmMin)
  const { partner, active } = routeNetwork(net, cornerCost, trailCost, optional)
  const bridgeEdge = (e: number) => e >= baseEdges && active[e] === 1

  type Todo = { pts: Pt2[]; nodes: number[]; edges: number[]; open: boolean }
  const todo: Todo[] = []
  for (const t of walkTrails(net, partner, active)) {
    const pts = t.nodes.map((n) => net.nodes[n])
    if (t.closed) {
      pts.pop() // the walk repeats its first node at the end
      t.nodes.pop()
      // A simple loop is cut the way the profile would cut it — climb or conventional.
      const flip = Math.abs(signedArea(pts)) > 1e-9 && (signedArea(pts) > 0) !== wantCCW
      todo.push(flip
        ? { pts: [...pts].reverse(), nodes: [...t.nodes].reverse(), edges: [...t.edges].reverse(), open: false }
        : { pts, nodes: t.nodes, edges: t.edges, open: false })
    } else todo.push({ pts, nodes: t.nodes, edges: t.edges, open: true })
  }
  for (const r of rings) if (inside.has(r.id)) todo.push({ pts: r.ring, nodes: [], edges: [], open: false })

  const baseCtx: Omit<PathEmitContext, 'params' | 'hasTabs'> = {
    tool, passes, safeZ, startZ, fineFit: false, fitPass: fitPassCoarse, wantCCW, tabRangesOn,
  }
  // Edges the tool may later travel down at depth: cut through, with no tab left standing.
  const cut = new Uint8Array(net.ends.length / 2)
  const tabbed = (e: number) => {
    const a = net.nodes[net.ends[2 * e]], b = net.nodes[net.ends[2 * e + 1]]
    return tabPoints.some((t) => ptSegDistSq(t.q[0], t.q[1], a[0], a[1], b[0], b[1]) < t.half ** 2)
  }
  const nodeAt = (p: XY) => net.nodes.findIndex((q) => Math.hypot(q[0] - p.x, q[1] - p.y) <= NODE_MERGE_MM)

  const segments: MotionSegment[] = []
  const toolpaths = todo.length
  let at = params.startNear
  // Nearest next: a loop from its nearest point, a toolpath from its nearer end — so one
  // that starts where the last finished is cut straight after it.
  while (todo.length) {
    const here: Pt2 = at ? [at.x, at.y] : todo[0].pts[0]
    const dist = (p: Pt2) => Math.hypot(p[0] - here[0], p[1] - here[1])
    let bestI = 0, bestD = Infinity, flip = false, startK = 0
    todo.forEach((c, i) => {
      if (c.open) {
        const d0 = dist(c.pts[0]), d1 = dist(c.pts[c.pts.length - 1])
        if (Math.min(d0, d1) < bestD) { bestD = Math.min(d0, d1); bestI = i; flip = d1 < d0; startK = 0 }
      } else {
        c.pts.forEach((p, k) => { if (dist(p) < bestD) { bestD = dist(p); bestI = i; flip = false; startK = k } })
      }
    })
    const [next] = todo.splice(bestI, 1)
    const pts = flip ? [...next.pts].reverse() : next.pts
    const closedPts = next.open ? pts : [...pts, pts[0]]

    // STAY DOWN when the way from here to the next start is all kerf already cut through:
    // a travel move along it beats lifting, a rapid across and plunging again.
    const startNode = next.nodes.length ? next.nodes[next.open ? (flip ? next.nodes.length - 1 : 0) : startK] : -1
    const last = segments[segments.length - 1]
    const beforeLast = segments[segments.length - 2]
    let kerf: { length: number; nodes: number[] } | null = null
    if (at && startNode >= 0 && last?.rapid && beforeLast && !beforeLast.rapid && Math.abs(beforeLast.z - finalZ) < 1e-9) {
      const from = nodeAt(at)
      if (from >= 0) kerf = kerfRoute(net, from, startNode, (e) => cut[e] === 1)
      if (kerf) {
        const s = net.nodes[startNode]
        if (!travelBeatsLift(kerf.length, Math.hypot(s[0] - at.x, s[1] - at.y), safeZ - finalZ, safeZ - passes[0], tool, rates)) kerf = null
      }
    }

    const emitted: MotionSegment[] = []
    emitProfilePath(emitted, pts, next.open, {
      ...baseCtx,
      params: { ...params, startNear: at },
      hasTabs: tabPoints.some((t) => onPath(t.q, closedPts)),
    })
    if (kerf && emitted[0]?.rapid) {
      segments.pop() // the retract
      for (const n of kerf.nodes.slice(1)) segments.push({ x: net.nodes[n][0], y: net.nodes[n][1], z: finalZ, rapid: false, travel: true })
      emitted.shift() // the rapid to the next start at safe height
    }
    for (const s of emitted) segments.push(s)
    for (const e of next.edges) if (!tabbed(e)) cut[e] = 1
    at = lastXY(segments) ?? at
  }

  // Mark the cutting moves that run along a bridge, so the preview can show them.
  const bridges = [...optional.keys()].filter(bridgeEdge)
  // Bridging asked for and nothing bridged looks exactly like the option being ignored, so
  // say which of the two reasons it was.
  if (bridgeMax > 0 && bridges.length === 0) {
    addNote({
      kind: 'shared-lines',
      short: optional.size === 0
        ? `No bridges: no clear gap between parts under ${+bridgeMax.toFixed(1)} mm`
        : 'No bridges: none would save time here',
    })
  }
  if (bridges.length) {
    const lines = bridges.map((e) => [net.nodes[net.ends[2 * e]], net.nodes[net.ends[2 * e + 1]]] as [Pt2, Pt2])
    for (let i = 1; i < segments.length; i++) {
      const s = segments[i], p = segments[i - 1]
      if (s.rapid || s.travel || s.arc) continue
      const m: Pt2 = [(s.x + p.x) / 2, (s.y + p.y) / 2]
      if (Math.hypot(s.x - p.x, s.y - p.y) < 1e-9) continue
      if (lines.some(([a, b]) => ptSegDistSq(m[0], m[1], a[0], a[1], b[0], b[1]) < 1e-10
        && ptSegDistSq(s.x, s.y, a[0], a[1], b[0], b[1]) < 1e-10 && ptSegDistSq(p.x, p.y, a[0], a[1], b[0], b[1]) < 1e-10)) {
        segments[i] = { ...s, bridge: true }
      }
    }
  }
  return { segments, sharedLengthMM, toolpaths, bridges: bridges.length }
}
