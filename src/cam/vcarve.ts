// V-carve toolpath using the medial axis (Voronoi-based) algorithm from JSPoly.
//
// Pipeline:
//  1. Flatten path → polylines; classify into (outer, holes[]) regions.
//  2. Scale coordinates ×SCALE so JSPoly gets integer precision.
//  3. Compute medial axis via JSPoly.construct_medial_axis().
//  4. Prune noisy leaf branches that arise from curve discretization.
//  5. Build a graph of skeleton segments; traverse with a Dijkstra-based
//     Euler-path algorithm (ported from vcarve.js) to minimise rapid travel.
//  6. Convert each skeleton point: r (scaled radius) → Z depth by asking the tool
//     how far below the surface its tip sits when its profile is `r` wide there —
//     f(r) in cam/geom.ts — capped at maxDepth. For a V-bit that is the familiar
//     r/tan(halfAngle); a taper adds the ball on its tip, which is why a stroke
//     narrower than the taper comes out round-bottomed instead of pointed.

import { classifySubpaths, centroidX, isVCutter, tipBallRadiusMM, vProfileHeightMM, vRadiusAtHeightMM } from './geom'
import { jspoly as JSPOLY } from './lib/jspoly.js'
// jspoly.js's internal methods reference `JSPoly` as a bare global (written for <script> context).
// In ES module scope it's never defined, so we pin it on globalThis once at import time.
;(globalThis as any).JSPoly = JSPOLY
import { flattenPath, splitSelfIntersecting, requireClosedSubpaths, type Pt2 } from './pathFlattener'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

const SCALE = 100 // 1 mm → 100 integer units; gives 0.01 mm precision for JSPoly

// ─── Public interface ─────────────────────────────────────────────────────────

export interface VCarveParams {
  angleDeg: number    // full included angle of the V-bit (e.g. 60)
  maxDepthMM: number
  islandDs: string[]  // additional paths treated as holes
  startNear?: { x: number; y: number }  // CNC mm — where the tool is before this operation
  zStartMM?: number   // male text inlay: shift the Z=0 plane down by this amount before computing depth
  safeHeightMM?: number
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface Seg { point0: { x: number; y: number; radius: number }; point1: { x: number; y: number; radius: number } }
interface XY  { x: number; y: number }
interface GraphNode { id: string; x: number; y: number; r: number; connections: Set<string>; visited: boolean }
type Graph = Record<string, { node: string; weight: number }[]>
interface TPoint { x: number; y: number; r: number }

// ─── PriorityQueue (min-heap) ─────────────────────────────────────────────────

class PriorityQueue {
  private values: { val: string; priority: number }[] = []
  get size() { return this.values.length }

  enqueue(val: string, priority: number) {
    this.values.push({ val, priority })
    this._bubbleUp()
  }

  dequeue() {
    if (!this.values.length) return null
    const min = this.values[0]
    const end = this.values.pop()!
    if (this.values.length) { this.values[0] = end; this._sinkDown() }
    return min
  }

  private _bubbleUp() {
    let idx = this.values.length - 1
    const el = this.values[idx]
    while (idx > 0) {
      const pIdx = Math.floor((idx - 1) / 2)
      const par = this.values[pIdx]
      if (el.priority >= par.priority) break
      this.values[pIdx] = el; this.values[idx] = par; idx = pIdx
    }
  }

  private _sinkDown() {
    let idx = 0
    const len = this.values.length
    const el = this.values[0]
    while (true) {
      const lIdx = 2 * idx + 1, rIdx = 2 * idx + 2
      let swap: number | null = null
      if (lIdx < len && this.values[lIdx].priority < el.priority) swap = lIdx
      if (rIdx < len) {
        const rp = this.values[rIdx].priority
        if ((swap === null && rp < el.priority) || (swap !== null && rp < this.values[lIdx].priority)) swap = rIdx
      }
      if (swap === null) break
      this.values[idx] = this.values[swap]; this.values[swap] = el; idx = swap
    }
  }
}

// ─── Graph utilities (ported from vcarve.js) ──────────────────────────────────

// Walk the predecessor chain back from `target` to `start`. Returns null when
// the chain breaks before reaching `start` — the caller steps along the path
// from its own current node, so a partial path (one that doesn't begin at
// `start`) would silently cut a straight line from the tool's real position to
// somewhere in the middle of the skeleton. Dijkstra only calls this for nodes
// it actually reached, so this is a guard, not an expected outcome.
function reconstructPath(predecessors: Map<string, string>, start: string, target: string): string[] | null {
  const path: string[] = []
  let cur: string | undefined = target
  while (cur !== undefined) {
    path.unshift(cur)
    if (cur === start) return path
    cur = predecessors.get(cur)
  }
  return null
}

function dijkstraToAnyTarget(graph: Graph, startNode: string, targetSet: Set<string>) {
  const distances = new Map<string, number>()
  const predecessors = new Map<string, string>()
  const pq = new PriorityQueue()
  distances.set(startNode, 0)
  pq.enqueue(startNode, 0)

  while (pq.size) {
    const { val: cur, priority: curDist } = pq.dequeue()!
    if (targetSet.has(cur)) {
      return { path: reconstructPath(predecessors, startNode, cur), distance: distances.get(cur)!, targetId: cur }
    }
    if (curDist > (distances.get(cur) ?? Infinity)) continue
    for (const { node, weight } of (graph[cur] ?? [])) {
      const nd = curDist + weight
      if (nd < (distances.get(node) ?? Infinity)) {
        distances.set(node, nd); predecessors.set(node, cur); pq.enqueue(node, nd)
      }
    }
  }

  return { path: null as string[] | null, distance: Infinity, targetId: null as string | null }
}

function nodeKey(x: number, y: number): string {
  return `${x.toFixed(1)},${y.toFixed(1)}`
}

function buildGraph(segs: Seg[]): { nodeMap: Map<string, GraphNode>; graph: Graph } {
  const nodeMap = new Map<string, GraphNode>()
  const graph: Graph = {}

  for (const seg of segs) {
    const k0 = nodeKey(seg.point0.x, seg.point0.y)
    const k1 = nodeKey(seg.point1.x, seg.point1.y)

    if (!nodeMap.has(k0)) {
      nodeMap.set(k0, { id: k0, x: seg.point0.x, y: seg.point0.y, r: seg.point0.radius, connections: new Set(), visited: false })
      graph[k0] = []
    }
    if (!nodeMap.has(k1)) {
      nodeMap.set(k1, { id: k1, x: seg.point1.x, y: seg.point1.y, r: seg.point1.radius, connections: new Set(), visited: false })
      graph[k1] = []
    }

    if (k0 !== k1) {
      const n0 = nodeMap.get(k0)!, n1 = nodeMap.get(k1)!
      if (!n0.connections.has(k1)) {
        n0.connections.add(k1); n1.connections.add(k0)
        const dist = Math.hypot(n0.x - n1.x, n0.y - n1.y)
        graph[k0].push({ node: k1, weight: dist })
        graph[k1].push({ node: k0, weight: dist })
      }
    }
  }

  return { nodeMap, graph }
}

function findNearestNode(nodeMap: Map<string, GraphNode>, refX: number, refY: number): GraphNode | null {
  let min = Infinity, start: GraphNode | null = null
  nodeMap.forEach(p => {
    const d = Math.hypot(p.x - refX, p.y - refY)
    if (d < min) { min = d; start = p }
  })
  return start
}

function findClosestUnvisited(cur: GraphNode, nodeMap: Map<string, GraphNode>): GraphNode | null {
  let min = Infinity, target: GraphNode | null = null
  nodeMap.forEach(p => {
    if (!p.visited && p.id !== cur.id) {
      const d = Math.hypot(p.x - cur.x, p.y - cur.y)
      if (d < min) { min = d; target = p }
    }
  })
  return target
}

function findTargetNodes(nodeMap: Map<string, GraphNode>, cur: GraphNode): GraphNode[] {
  const targets: GraphNode[] = []
  nodeMap.forEach(p => { if (!p.visited && p.connections.size === 1) targets.push(p) })
  if (targets.length === 0) {
    const fallback = findClosestUnvisited(cur, nodeMap)
    if (fallback) targets.push(fallback)
  }
  return targets
}

function findClosestTarget(curId: string, nodeMap: Map<string, GraphNode>, graph: Graph) {
  const curNode = nodeMap.get(curId)!
  const targets = findTargetNodes(nodeMap, curNode)
  if (!targets.length) return { target: null, path: null }

  const targetSet = new Set(targets.map(t => t.id))
  const result = dijkstraToAnyTarget(graph, curId, targetSet)
  if (!result.path || !result.targetId) return { target: null, path: null }
  return { target: nodeMap.get(result.targetId) ?? null, path: result.path }
}

function findStartNodes(nodeMap: Map<string, GraphNode>, refX = 0, refY = 0): GraphNode[] {
  const starts: GraphNode[] = []
  nodeMap.forEach(n => { if (n.connections.size === 1) starts.push(n) })

  if (!starts.length) {
    // No leaf nodes (closed loops like O) — start from the node nearest to the entry position
    const fallback = findNearestNode(nodeMap, refX, refY)
    return fallback ? [fallback] : []
  }

  if (starts.length <= 4) return starts

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  starts.forEach(n => {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y)
  })
  const corners = [
    { x: minX, y: minY }, { x: maxX, y: minY },
    { x: minX, y: maxY }, { x: maxX, y: maxY },
  ]
  const seen = new Set<string>()
  const result: GraphNode[] = []
  for (const corner of corners) {
    let best: GraphNode | null = null, bestD = Infinity
    for (const n of starts) {
      const d = Math.hypot(n.x - corner.x, n.y - corner.y)
      if (d < bestD) { bestD = d; best = n }
    }
    if (best && !seen.has(best.id)) { seen.add(best.id); result.push(best) }
  }
  return result
}

function makeEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function findPossiblePath(
  nodeMap: Map<string, GraphNode>,
  graph: Graph,
  startNode: GraphNode,
): { toolpath: TPoint[]; travelDistance: number } {
  nodeMap.forEach(n => { n.visited = false })

  const toolpath: TPoint[] = []
  const traversed = new Set<string>()
  let travel = 0
  let node = startNode

  node.visited = true
  toolpath.push({ x: node.x, y: node.y, r: node.r })

  let result = findClosestTarget(node.id, nodeMap, graph)

  while (result.target && result.path && result.path.length > 1) {
    const path = result.path
    let prevId = node.id
    for (let i = 1; i < path.length; i++) {
      const next = nodeMap.get(path[i])!
      next.visited = true
      travel += Math.hypot(next.x - node.x, next.y - node.y)
      toolpath.push({ x: next.x, y: next.y, r: next.r })
      traversed.add(makeEdgeKey(prevId, path[i]))
      prevId = path[i]
      node = next
    }
    result = findClosestTarget(node.id, nodeMap, graph)
  }

  // Second pass: cover any edges not yet traversed (handles loops/cycles).
  const untraversed = new Map<string, { from: string; to: string }>()
  nodeMap.forEach((n, key) => {
    n.connections.forEach(connId => {
      const ek = makeEdgeKey(key, connId)
      if (!traversed.has(ek) && !untraversed.has(ek)) untraversed.set(ek, { from: key, to: connId })
    })
  })

  while (untraversed.size > 0) {
    const endpoints = new Set<string>()
    for (const { from, to } of untraversed.values()) { endpoints.add(from); endpoints.add(to) }

    if (!endpoints.has(node.id)) {
      const nav = dijkstraToAnyTarget(graph, node.id, endpoints)
      if (!nav.path || nav.path.length < 2) break
      for (let i = 1; i < nav.path.length; i++) {
        const nxt = nodeMap.get(nav.path[i])!
        const ek = makeEdgeKey(nav.path[i - 1], nav.path[i])
        toolpath.push({ x: nxt.x, y: nxt.y, r: nxt.r })
        traversed.add(ek); untraversed.delete(ek)
        travel += Math.hypot(nxt.x - node.x, nxt.y - node.y)
        node = nxt
      }
    }

    let advanced = false
    for (const connId of node.connections) {
      const ek = makeEdgeKey(node.id, connId)
      if (untraversed.has(ek)) {
        const far = nodeMap.get(connId)!
        toolpath.push({ x: far.x, y: far.y, r: far.r })
        traversed.add(ek); untraversed.delete(ek)
        travel += Math.hypot(far.x - node.x, far.y - node.y)
        node = far
        advanced = true
        break
      }
    }
    if (!advanced) continue
  }

  return { toolpath, travelDistance: travel }
}

// entrySX/entrySY are in scaled units (mm × SCALE)
function findBestPath(segs: Seg[], entrySX = 0, entrySY = 0): TPoint[] {
  if (!segs.length) return []
  const { nodeMap, graph } = buildGraph(segs)
  const startNodes = findStartNodes(nodeMap, entrySX, entrySY)

  let bestPath: TPoint[] = []
  let bestCost = Infinity
  for (const startNode of startNodes) {
    const entryDist = Math.hypot(startNode.x - entrySX, startNode.y - entrySY)
    const { toolpath, travelDistance } = findPossiblePath(nodeMap, graph, startNode)
    const totalCost = travelDistance + entryDist
    if (totalCost < bestCost) { bestCost = totalCost; bestPath = toolpath }
  }
  return bestPath
}

// ─── Branch pruning (ported from toolPath.js) ────────────────────────────────

// Removes noisy short branches produced by curve discretization.
// Leaf endpoints with a very small radius that sit near short outline segments
// (indicating a curve rather than a sharp corner) are pruned back to the nearest junction.
//
// A leaf is only noise when the outline is locally *smooth* — short segments alone
// don't prove that: genuine corners between two curves (Roboto lowercase terminals,
// j/y tail tips) also adjoin short flattened segments. A real corner has a large
// tangent break at its vertex, while flattening noise on a smooth curve stays small.
// The break must be measured over a ±TURN_WINDOW arc-length window, not one vertex
// pair: font outlines contain near-duplicate vertices (Bézier joins) that split a
// corner's angle across two vertices — Roboto 't' reads 15° at a single vertex but
// 94° over the window, while smooth-curve windows stay under 17°.
const SHARP_CORNER_TURN = 25 * Math.PI / 180
const TURN_WINDOW = 0.15 * SCALE

// Direction change of the outline across vertex vi, measured between the points
// ±window arc length away along the ring (0 = straight through).
function windowTurnAt(ring: XY[], vi: number, window: number): number {
  const dir = (step: 1 | -1): XY | null => {
    const n = ring.length
    const v = ring[vi]
    let acc = 0
    let prev = v
    for (let s = 1; s <= n; s++) {
      const p = ring[(((vi + step * s) % n) + n) % n]
      acc += Math.hypot(p.x - prev.x, p.y - prev.y)
      prev = p
      if (acc >= window) return { x: p.x - v.x, y: p.y - v.y }
    }
    return null
  }
  const din = dir(-1), dout = dir(1)
  if (!din || !dout) return 0
  const a1 = Math.atan2(-din.y, -din.x) // incoming direction (window point → vertex)
  const a2 = Math.atan2(dout.y, dout.x)
  let t = Math.abs(a2 - a1)
  if (t > Math.PI) t = 2 * Math.PI - t
  return t
}

function pruneNoisyBranches(segs: Seg[], path: XY[], holes: XY[][], maxRadius: number): Seg[] {
  const outlines = [path, ...holes]
  const { nodeMap } = buildGraph(segs)

  const leafsToCheck: { key: string; x: number; y: number }[] = []
  nodeMap.forEach((n, key) => {
    if (n.connections.size === 1 && n.r < maxRadius * 0.1) leafsToCheck.push({ key, x: n.x, y: n.y })
  })

  const minSegLength = maxRadius * 0.8
  const pruneKeys = new Set<string>()

  for (const leaf of leafsToCheck) {
    let bestDist = Infinity, bestSegLen = 0
    let bestOutline: XY[] | null = null, bestIdx = -1

    for (const outline of outlines) {
      const nVerts = outline.length
      for (let pi = 0; pi < nVerts - 1; pi++) {
        const p1 = outline[pi], p2 = outline[(pi + 1) % nVerts]
        const d1 = Math.hypot(leaf.x - p1.x, leaf.y - p1.y)
        const d2 = Math.hypot(leaf.x - p2.x, leaf.y - p2.y)

        if (Math.min(d1, d2) < bestDist) {
          bestDist = Math.min(d1, d2)
          const closestIdx = d1 < d2 ? pi : (pi + 1) % nVerts
          const prev = outline[(closestIdx - 1 + nVerts) % nVerts]
          const curr = outline[closestIdx]
          const next = outline[(closestIdx + 1) % nVerts]
          const len1 = Math.hypot(curr.x - prev.x, curr.y - prev.y)
          const len2 = Math.hypot(next.x - curr.x, next.y - curr.y)
          bestSegLen = Math.max(len1, len2)
          bestOutline = outline
          bestIdx = closestIdx
        }
      }
    }

    const turn = bestOutline ? windowTurnAt(bestOutline, bestIdx, TURN_WINDOW) : 0
    if (turn < SHARP_CORNER_TURN && bestSegLen < minSegLength) pruneKeys.add(leaf.key)
  }

  if (!pruneKeys.size) return segs

  const segByNode: Record<string, number[]> = {}
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    const k0 = nodeKey(s.point0.x, s.point0.y)
    const k1 = nodeKey(s.point1.x, s.point1.y)
    ;(segByNode[k0] ??= []).push(i)
    ;(segByNode[k1] ??= []).push(i)
  }

  // Walk inward from each noise leaf and cut the chain back to the nearest JUNCTION.
  //
  // The walk is staged, not applied as it goes, because a chain is only a *branch* when
  // something else carries on past its far end. Reaching another leaf instead means the
  // walk has traversed the whole connected component: on a simple shape — a leaf, a petal,
  // an oval — the medial axis is one unbranched chain from tip to tip with no junction
  // anywhere, so applying the removal deletes the entire toolpath for that shape. That is
  // what "pruneNoisyBranches removed all segments" was, and where a shape survived it did
  // so with a stub of spine and a fraction of its depth (scratch/verror.fkam: 4 of 17
  // traced leaf shapes, three carving 1.4–1.8 mm deep instead of the full 3 mm).
  //
  // Genuine discretization noise is unaffected: a noise spur hangs OFF the spine, so its
  // walk ends at the junction where it meets it and still prunes.
  //
  // Bounded by length as well, because "ends at a junction" is not enough on its own. A
  // shape whose axis forks near one tip gives the walk a junction to stop at only after it
  // has run the entire spine, so a misjudged tip took 56 of 60 segments with it and left
  // the fork — a 2 mm stub carving 1.6 mm deep on a 10 mm shape. Noise is by definition a
  // small part of what it is noise on: a flattening spur is a fraction of a percent of the
  // axis, so a quarter is an order of magnitude of headroom and still far below anything
  // load-bearing.
  const MAX_PRUNE_FRACTION = 0.25
  const segLen = (s: Seg) => Math.hypot(s.point1.x - s.point0.x, s.point1.y - s.point0.y)
  const totalLen = segs.reduce((a, s) => a + segLen(s), 0)

  const removeSet = new Set<number>()
  for (const startKey of pruneKeys) {
    const chain: number[] = []
    const staged = new Set<number>()
    let current = startKey
    let currentNode = nodeMap.get(current)
    let reachedJunction = false
    while (currentNode && currentNode.connections.size <= 2) {
      const segIndices = segByNode[current]
      if (!segIndices) break
      let nextKey: string | null = null
      for (const si of segIndices) {
        if (!removeSet.has(si) && !staged.has(si)) {
          staged.add(si)
          chain.push(si)
          const seg = segs[si]
          const k0 = nodeKey(seg.point0.x, seg.point0.y)
          const k1 = nodeKey(seg.point1.x, seg.point1.y)
          nextKey = k0 === current ? k1 : k0
        }
      }
      if (!nextKey) break
      current = nextKey
      currentNode = nodeMap.get(current)
      if (currentNode && currentNode.connections.size > 2) { reachedJunction = true; break }
    }
    const chainLen = chain.reduce((a, si) => a + segLen(segs[si]), 0)
    if (reachedJunction && chainLen <= totalLen * MAX_PRUNE_FRACTION) {
      for (const si of chain) removeSet.add(si)
    }
  }

  return segs.filter((_, i) => !removeSet.has(i))
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function generateVCarve(
  d: string,
  tool: Tool,
  params: VCarveParams,
): Promise<MotionSegment[]> {
  if (!isVCutter(tool)) throw new Error('V-Carve requires a V-bit tool')

  const halfAngle = (params.angleDeg / 2) * (Math.PI / 180)
  const tanHalfAngle = Math.tan(halfAngle)
  if (tanHalfAngle < 1e-6) throw new Error('Invalid V-bit angle')

  // The ball ground on a taper's tip; 0 for a V-bit, which then reduces every
  // formula below to exactly the cone laws this file has always used.
  const tipR = tipBallRadiusMM(tool)
  // Depth below the surface at a skeleton point of clearance radius `rScaled`.
  const depthAtRadius = (rScaled: number) => vProfileHeightMM(rScaled / SCALE, tanHalfAngle, tipR)

  // Maximum tool radius in scaled units (used for pruning thresholds)
  const maxRadiusScaled = vRadiusAtHeightMM(params.maxDepthMM, tanHalfAngle, tipR) * SCALE

  // A v-carve cuts the MEDIAL AXIS of a region — the ridge equidistant from its walls —
  // so it needs walls on every side. An open path has none, and closing it implicitly
  // carves the medial axis of a shape that was never drawn.
  const flat = flattenPath(d, 0.05)
  requireClosedSubpaths(flat, {
    cut: 'a V-carve',
    remedy: 'Close the path, or use a centerline profile with the V-bit to cut a groove along it.',
  })
  const allSubpathsPt2 = splitSelfIntersecting(flat)
  if (!allSubpathsPt2.length) throw new Error('No geometry found in path')

  const islandPt2: Pt2[][] = []
  for (const iD of params.islandDs) {
    const islandFlat = flattenPath(iD, 0.05)
    requireClosedSubpaths(islandFlat, {
      cut: 'a V-carve', noun: 'Island path',
      remedy: 'Close the path, or take it out of the islands.',
    })
    for (const sub of splitSelfIntersecting(islandFlat)) {
      if (sub.length >= 3) islandPt2.push(sub)
    }
  }

  const regions = classifySubpaths([...allSubpathsPt2, ...islandPt2])
  // Sort regions left-to-right by centroid X so text cuts in reading order
  regions.sort((a, b) => centroidX(a.outer) - centroidX(b.outer))

  // Current cutter position in scaled units — used to pick the best start node per region
  let curSX = (params.startNear?.x ?? 0) * SCALE
  let curSY = (params.startNear?.y ?? 0) * SCALE

  const zStart = params.zStartMM ?? 0
  const safeZ = params.safeHeightMM ?? 5

  const segs: MotionSegment[] = []

  const zAtRadius = (rScaled: number) => -Math.min(zStart + depthAtRadius(rScaled), params.maxDepthMM)

  // Z ALONG A MEDIAL EDGE IS NOT A STRAIGHT LINE FOR A TAPER, and the machine interpolates
  // it as one. A V-bit's depth law r/tanθ is linear in the clearance radius, and the radius
  // runs linearly along a medial edge, so the two emitted endpoints describe the whole move
  // exactly. A taper's law is an ARC wherever the bit is riding its tip ball — and f is
  // convex, so the straight chord across that arc runs DEEPER than the profile, and deeper
  // means WIDER. The small radii that put the tool on its ball are exactly the ones at
  // sharp corners, so the whole error collects there: a 5°/side taper with a 1 mm tip cut
  // 0.18–0.37 mm outside the shape at the point of a star, a wedge and an L, where the
  // same shapes came out exact with a V-bit.
  //
  // So bisect the move until the chord follows the profile. The test is in CUT WIDTH, not
  // in Z: near the tip the profile is nearly flat, where a Z error of a few microns is a
  // wide miss. Both `r` and XY run linearly along the edge, so the midpoint of a run is an
  // honest sample of it. Gated on tipR — a V-bit inserts nothing and its output is
  // unchanged, byte for byte.
  // Bisection alone is not enough, because it only samples the MIDDLE of a run. The ball
  // arc lives at radii below `kneeR` and that can be a few percent of a long medial edge —
  // on a 60 mm wedge the midpoint error read 0.0075 mm, under tolerance, while the first
  // 3 % of the move was cutting 0.4 mm outside the shape. So split each run at the knee
  // first: what is left either side is the smooth arc or the straight cone, and on those
  // the midpoint IS representative.
  const CHORD_TOL_MM = 0.01
  const MAX_BISECT = 10
  const widthAtZ = (z: number) => vRadiusAtHeightMM(-z, tanHalfAngle, tipR)
  const kneeRScaled = (tipR / Math.sqrt(1 + tanHalfAngle * tanHalfAngle)) * SCALE   // r·cosθ

  function emitRun(a: TPoint, za: number, b: TPoint, zb: number, out: MotionSegment[]) {
    const lo = Math.min(a.r, b.r), hi = Math.max(a.r, b.r)
    if (lo < kneeRScaled && kneeRScaled < hi) {
      const t = (kneeRScaled - a.r) / (b.r - a.r)
      const knee: TPoint = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), r: kneeRScaled }
      const zk = zAtRadius(kneeRScaled)
      refineRun(a, za, knee, zk, out, 0)
      out.push({ x: knee.x / SCALE, y: knee.y / SCALE, z: zk, rapid: false })
      refineRun(knee, zk, b, zb, out, 0)
    } else {
      refineRun(a, za, b, zb, out, 0)
    }
  }

  function refineRun(a: TPoint, za: number, b: TPoint, zb: number, out: MotionSegment[], depth: number) {
    if (depth >= MAX_BISECT) return
    const mr = (a.r + b.r) / 2
    const zTrue = zAtRadius(mr)
    // Where both ends are already at max depth this is 0 and the run stops splitting.
    if (Math.abs(widthAtZ((za + zb) / 2) - widthAtZ(zTrue)) <= CHORD_TOL_MM) return
    const mid: TPoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: mr }
    refineRun(a, za, mid, zTrue, out, depth + 1)
    out.push({ x: mid.x / SCALE, y: mid.y / SCALE, z: zTrue, rapid: false })
    refineRun(mid, zTrue, b, zb, out, depth + 1)
  }

  // flattenPath adds a closing duplicate for Z paths (first === last).
  // JSPoly expects an open polygon ring — strip the duplicate if present.
  const toScaledXY = (pts: Pt2[]): XY[] => {
    let out = pts.map(([x, y]) => ({ x: x * SCALE, y: y * SCALE }))
    if (out.length > 1) {
      const f = out[0], l = out[out.length - 1]
      if (Math.abs(f.x - l.x) < 0.5 && Math.abs(f.y - l.y) < 0.5) out = out.slice(0, -1)
    }
    return out
  }

  for (const { outer, holes } of regions) {
    const scaledOuter = toScaledXY(outer)
    const scaledHoles = holes.map(toScaledXY)

    if (scaledOuter.length < 3) continue

    let jsSegs: Seg[] = []
    try {
      jsSegs = JSPOLY.construct_medial_axis(
        scaledOuter,
        scaledHoles,
        0.1,              // discretize threshold
        2,                // CENTRAL_ANGLE method
        7 * Math.PI / 8, // filtering angle (exclude near-tangent edges)
      )
    } catch (e) {
      console.error('JSPoly medial axis error:', e)
      continue
    }
    if (!jsSegs.length) {
      console.warn('JSPoly returned no segments for region', scaledOuter.length, 'pts')
      continue
    }

    jsSegs = pruneNoisyBranches(jsSegs, scaledOuter, scaledHoles, maxRadiusScaled)
    if (!jsSegs.length) {
      console.warn('pruneNoisyBranches removed all segments')
      continue
    }

    const toolpath = findBestPath(jsSegs, curSX, curSY)
    if (!toolpath.length) continue

    const first = toolpath[0]
    const firstZ = zAtRadius(first.r)

    segs.push({ x: first.x / SCALE, y: first.y / SCALE, z: safeZ, rapid: true })
    segs.push({ x: first.x / SCALE, y: first.y / SCALE, z: firstZ, rapid: false })

    let prev = first, prevZ = firstZ
    for (let i = 1; i < toolpath.length; i++) {
      const pt = toolpath[i]
      const z = zAtRadius(pt.r)
      // The machine drives Z linearly between the points we emit. For a V-bit that is
      // exact; for a taper it is not, and the error lands on sharp corners — see
      // refineRun. Nothing is inserted for a V-bit.
      if (tipR > 0) emitRun(prev, prevZ, pt, z, segs)
      segs.push({ x: pt.x / SCALE, y: pt.y / SCALE, z, rapid: false })
      prev = pt; prevZ = z
    }

    const last = toolpath[toolpath.length - 1]
    segs.push({ x: last.x / SCALE, y: last.y / SCALE, z: safeZ, rapid: true })

    // Update current position to this region's exit for the next region's start selection
    curSX = last.x
    curSY = last.y
  }

  if (!segs.length) throw new Error('Could not compute V-Carve medial axis — check that the selected path is a closed shape')

  return segs
}

