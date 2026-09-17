import {  signedArea, ensureWinding, type Pt2 } from '../pathFlattener'
import { morphChainToSpiral } from '../spiralMorph'
import { solveField, type FieldGrid } from '../spiralField'
import { traceIsolines } from '../marchingSquares'
import {  JoinType } from 'clipper2-ts'
import {   stripClosingDuplicate, pointInPolygon, interiorPoint } from '../geom'
import type { MotionSegment } from '../../store/toolpathStore'
import { type PocketPlan, type PocketPlanner, _timed, centroidOfRing, compoundFinishRings, emitRampDescent, emitSpiralHelixEntry, growIslands, growRing, insetRing, isTravelSafe, rampLeadIn, ringPerimeter, setGap } from './shared'

// ─── Spiral geometry: loop forest, chains, region clamping ───────────────────────
//
// Turning a set of nested loops into continuous outward spirals: the containment forest
// and its non-branching chains, and the clamping that keeps a morphed spiral off the
// walls and islands (see spiralMorph.ts for the morph itself). This lived in its own
// pocket/spiral.ts while the offset-ring 'spiral' strategy existed; that strategy was
// dropped in 2026-07 and this is now the only consumer, so it lives here.

export interface LoopNode {
  loop: Pt2[]
  centroid: Pt2
  children: LoopNode[]
}

export interface SpiralChain {
  loopsOuterToInner: Pt2[][]
  // True when the chain's innermost loop is a real leaf (a single-lobe center),
  // so the spiral can seed a circular center fill there. False when the inner
  // end is a branch node (the lobes that split off it are separate chains that
  // clear that interior), in which case the spiral must not seed a center.
  innerIsLeaf: boolean
}

function subtreeSize(n: LoopNode): number {
  let s = 1
  for (const c of n.children) s += subtreeSize(c)
  return s
}

// Collapse spurious branches: when a node has several children whose loop centroids
// nearly coincide, they are the SAME lobe split apart by near-duplicate isotherm loops
// (marching-squares over-sampling), not genuinely separate lobes — which would have
// distinct centroids. Keep only the child with the largest subtree per centroid cluster;
// the dropped near-duplicates are covered by the kept chain + the wall finish. Without
// this a near-duplicate ring becomes its own pass (an extra contour overlapping the
// spiral). Recurses so the rule holds at every depth.
export function dedupeForestBranches(roots: LoopNode[], tol: number): void {
  const dedupe = (node: LoopNode) => {
    if (node.children.length > 1) {
      const kept: LoopNode[] = []
      for (const child of [...node.children].sort((a, b) => subtreeSize(b) - subtreeSize(a))) {
        if (kept.some(k => Math.hypot(k.centroid[0] - child.centroid[0], k.centroid[1] - child.centroid[1]) < tol)) continue
        kept.push(child)
      }
      node.children = kept
    }
    for (const c of node.children) dedupe(c)
  }
  for (const r of roots) dedupe(r)
}

// `maxGap` bounds how far apart consecutive loops in one chain may be. The morph
// interpolates between them, so a chain that links two loops further apart than a stepover
// sweeps straight across the stock in between — on a star-in-star that produced a two-loop
// chain whose members were 167 mm apart against a 3 mm stepover, and the morph drove across
// it in one transition. Containment can legitimately produce such a pair: when the loops
// that should sit between them belong to other branches, a loop's nearest CONTAINING loop
// can be far outside it. Splitting there gives the far loop its own chain, so the morph
// only ever interpolates between genuinely adjacent level sets.
export function forestToChains(roots: LoopNode[], maxGap = Infinity): SpiralChain[] {
  const chains: SpiralChain[] = []
  const walk = (start: LoopNode) => {
    const loopsOuterToInner: Pt2[][] = []
    let innerIsLeaf = true
    let node: LoopNode | null = start
    while (node) {
      loopsOuterToInner.push(node.loop)
      if (node.children.length === 1 && setGap([node.children[0].loop], [node.loop]) > maxGap) {
        // Too far to morph across — the child starts a chain of its own.
        innerIsLeaf = false
        walk(node.children[0])
        node = null
      } else if (node.children.length === 1) {
        node = node.children[0]
      } else {
        innerIsLeaf = node.children.length === 0
        for (const c of node.children) walk(c)   // children pushed before parent
        node = null
      }
    }
    chains.push({ loopsOuterToInner, innerIsLeaf })
  }
  for (const r of roots) walk(r)
  return chains
}

export function nearestPointOnRing(px: number, py: number, ring: Pt2[]): Pt2 {
  let best: Pt2 = ring[0]
  let bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    let t = l2 > 1e-12 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const qx = a[0] + t * dx, qy = a[1] + t * dy
    const d = (px - qx) ** 2 + (py - qy) ** 2
    if (d < bestD) { bestD = d; best = [qx, qy] }
  }
  return best
}

// Largest helix radius at `p` that keeps a bored circle clear of every keep-out ring
// (the tool-centre paths along walls/islands), capped at `maxR`. 0 (or negative) when
// there's no room. Shared by both spiral strategies' helix entries.
export function maxClearHelixRadius(p: Pt2, rings: Pt2[][], maxR: number): number {
  let r = maxR
  for (const ring of rings) {
    if (ring.length < 2) continue
    const np = nearestPointOnRing(p[0], p[1], ring)
    r = Math.min(r, Math.hypot(p[0] - np[0], p[1] - np[1]) - 0.1)
  }
  return r
}

// Clamp every spiral point into the cuttable region: a tool centre may never sit
// inside a grown island (would gouge the island) or outside the inset boundary
// (would over-cut the wall). Out-of-region points are snapped to the nearest
// boundary point, so the tool edge lands exactly on the real island/wall edge.
// Long segments are SUBDIVIDED first: clamping only the endpoints lets a chord
// between two legal points pass straight through an island (the morph emits such
// chords when consecutive rings differ around islands) — the subdivided samples
// snap onto the keep-out ring, so the path slides around the island instead.
export function clampSpiralToRegion(spiral: Pt2[], insetBoundary: Pt2[], grownIslands: Pt2[][]): Pt2[] {
  const MAX_SEG = 0.75
  // Where a grown island overlaps the inset boundary (island close to the wall) there is
  // NO legal tool position: island-snap pushes the point outside the pocket, wall-snap
  // pulls it back inside the island ring. Such points return null (dropped); the jump
  // splitter then severs the spiral on each side of the dead zone.
  const TOL = 0.05
  const clampPt = (x: number, y: number): Pt2 | null => {
    let px = x, py = y
    for (const gi of grownIslands) {
      if (gi.length >= 3 && pointInPolygon(px, py, gi)) {
        const n = nearestPointOnRing(px, py, gi)
        px = n[0]; py = n[1]
      }
    }
    if (insetBoundary.length >= 3 && !pointInPolygon(px, py, insetBoundary)) {
      const n = nearestPointOnRing(px, py, insetBoundary)
      px = n[0]; py = n[1]
      // re-validate: the wall snap may have moved the point back into an island ring
      for (const gi of grownIslands) {
        if (gi.length >= 3 && pointInPolygon(px, py, gi)) {
          const nn = nearestPointOnRing(px, py, gi)
          if (Math.hypot(px - nn[0], py - nn[1]) > TOL) return null
        }
      }
    }
    return [px, py]
  }
  const out: Pt2[] = []
  const push = (p: Pt2 | null) => {
    if (!p) return
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) out.push(p)
  }
  for (let i = 0; i < spiral.length; i++) {
    if (i > 0) {
      const [ax, ay] = spiral[i - 1]
      const [bx, by] = spiral[i]
      const n = Math.floor(Math.hypot(bx - ax, by - ay) / MAX_SEG)
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1)
        push(clampPt(ax + (bx - ax) * t, ay + (by - ay) * t))
      }
    }
    push(clampPt(spiral[i][0], spiral[i][1]))
  }
  return out
}

// Clamping can snap neighbouring (densified) samples to opposite sides of a keep-out,
// leaving a chord straight through an island. Legitimate steps are sub-millimetre after
// densification, so any far longer step is such an artifact: split the spiral there and
// keep each contiguous run; runs too short to cut anything are dropped (their crumb is
// swept by the finishing contour).
export function splitClampedSpiral(spiral: Pt2[]): Pt2[][] {
  // Legitimate densified steps are ≤ 0.75 mm; a chord ≤ JUMP across a convex keep-out
  // dips at most ~c²/8r ≈ 0.1 mm into it — below the cut tolerance.
  const JUMP = 1.5
  const runs: Pt2[][] = []
  let run: Pt2[] = []
  for (let i = 0; i < spiral.length; i++) {
    if (i > 0 && Math.hypot(spiral[i][0] - spiral[i - 1][0], spiral[i][1] - spiral[i - 1][1]) > JUMP) {
      if (run.length >= 5) runs.push(run)
      run = []
    }
    run.push(spiral[i])
  }
  if (run.length >= 5) runs.push(run)
  return runs
}

// Keep loops one stepover apart along a chain (ordered outer→inner): from each
// anchor, take the farthest-in loop still within a stepover, then repeat.
export function decimateChain(loops: Pt2[][], stepoverMM: number): Pt2[][] {
  if (loops.length <= 1) return loops
  const kept: Pt2[][] = [loops[0]]
  let anchor = 0, i = 1
  while (i < loops.length) {
    let lastGood = -1, j = i
    while (j < loops.length && setGap([loops[j]], [loops[anchor]]) <= stepoverMM) { lastGood = j; j++ }
    const pick = lastGood === -1 ? i : lastGood
    kept.push(loops[pick])
    anchor = pick
    i = pick + 1
  }
  if (kept[kept.length - 1] !== loops[loops.length - 1]) kept.push(loops[loops.length - 1])
  return kept
}

// How a chain's spiral is entered: 'helix' bores a hole at a point centre; 'ramp'
// descends along the path (island chains / first cut into solid); 'travel' drops
// straight in because the interior is already cleared (branch chains).

// ─── Field-based curvilinear spiral (Bieterman/Leroy) ────────────────────────────
//
// Solves a Poisson "temperature" field over the pocket (0 at the walls, peaking on
// the medial ridge), traces its isotherms as structure curves spaced by the radial
// tool engagement, and morphs them into a curvilinear spiral that starts with a
// helix at the field's peak and works outward to the wall. Unlike the offset-ring
// spiral, the first cut is a helix (not a full-width slot), so engagement stays
// limited — this is the cheap approximation of the adaptive clearing path.
//


// Light Laplacian smoothing of a closed loop — removes the ~1-cell staircase that
// marching squares leaves on the grid, so the isotherm reads as the smooth curve it
// represents. Without this the blocky corners make the corner-fillet smoothing
// explode the point count (and nudge points across walls/islands).
function smoothLoop(loop: Pt2[], iters: number, factor: number): Pt2[] {
  const n = loop.length
  if (n < 5) return loop
  let cur = loop
  for (let it = 0; it < iters; it++) {
    const out: Pt2[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n], p = cur[i], b = cur[(i + 1) % n]
      out[i] = [p[0] + factor * ((a[0] + b[0]) / 2 - p[0]), p[1] + factor * ((a[1] + b[1]) / 2 - p[1])]
    }
    cur = out
  }
  return cur
}

function isothermLoops(g: FieldGrid, level: number): Pt2[][] {
  return traceIsolines(g, level)
    .map(l => smoothLoop(stripClosingDuplicate(l), 2, 0.5))
    .filter(l => l.length >= 3 && Math.abs(signedArea(l)) > 0.01)
}

// Build the structure-curve levels for the merge-tree spiral, ordered outer →
// inner: levels[0] is the inset boundary (the wall), and each subsequent level is
// the isotherm set one stepover further in. Because isotherms of a multi-maximum
// field split into separate loops near the peaks, each level is a *set* of loops;
// buildOffsetForest then turns the nesting/splits into per-seed chains.
//
// Levels are spaced by distance, not by temperature: the field is flat near a
// peak, so a fixed temperature step would leave huge distance gaps there. Levels
// are decimated per chain (below) to one stepover.
//
// Loops are NOT grouped by temperature: around an island the field is annular, so
// one temperature gives two concentric loops (toward the wall, toward the island)
// at very different distances. Instead we extract isotherm loops densely and nest
// them by area/containment — every loop encircling an island encloses its centre,
// so they sort cleanly by size into one chain wall→ridge→island. This is
// topology-agnostic: a simple disk nests the same way.

// True when a majority of `inner`'s sampled vertices lie inside `outer`. Sampling
// ~12 vertices (not one) makes isotherm nesting robust to marching-squares grid
// noise that can place an individual near-wall vertex just outside its true parent.
function loopMostlyInside(inner: Pt2[], outer: Pt2[]): boolean {
  const SAMPLES = 12
  const step = Math.max(1, Math.floor(inner.length / SAMPLES))
  let tested = 0, inCount = 0
  for (let i = 0; i < inner.length; i += step) {
    tested++
    if (pointInPolygon(inner[i][0], inner[i][1], outer)) inCount++
  }
  return tested > 0 && inCount * 2 > tested
}

// Extract the structure curves by MARCHING the temperature level so consecutive
// isotherms land about one stepover apart, instead of tracing a fixed dense ladder and
// throwing most of it away.
//
// The field is flat near a peak and steep near a wall, so a fixed temperature step gives
// wildly uneven distance spacing — which is why the old code traced 120 levels, culled
// near-duplicates by comparing every loop against every kept loop, and then decimated
// what survived. That cull was O(K²) calls to setGap (each ~8k distance evaluations) and
// measured out as the single hottest thing in morph.
//
// Here the step is chosen by feedback instead: trace, measure the gap to the level
// before it, and scale the next temperature increment by how far off a stepover it came
// out. Spacing is then correct BY CONSTRUCTION, so the all-pairs cull is gone — only the
// per-chain decimation stays, to thin lobes that came out over-dense because a different
// lobe on the same level drove the step down.
// How much more path than necessary this shape may force the spiral to cut before the
// strategy declines it. Measured against area/stepover on the dog file: a simple blob
// 1.35x, a plain outline 1.52x, a long slot 2.58x, the full 22-island dog 5.00x. Under 2x
// the smoothness is worth the extra path (that dog's raster wants 1888 lifts against
// morph's 226); at 5x it is not machining, it is polishing air.
export const REDUNDANCY_LIMIT = 2.0

// Set when the march gave up because the shape forces too much redundant path; read by
// planFieldSpiralPocket, which turns it into the caller's fallback + message.
export let lastUnsuitableRatio = 0
export function takeUnsuitableRatio(): number { const r = lastUnsuitableRatio; lastUnsuitableRatio = 0; return r }

// Exported for scripts/morph-chains.mts, which dumps the chain structure this builds —
// the chains are what a cut-order bug is about, and they are invisible in the segments.
export function buildIsothermChains(
  g: FieldGrid, insetBoundary: Pt2[], holes: Pt2[][], stepoverMM: number, wantCCW: boolean,
  /** Area the tool actually clears — the ORIGINAL pocket, not the inset tool-centre region.
   *  Clearing area A at a given stepover needs at least A/stepover of path, and using the
   *  inset area instead makes every small pocket look redundant: its inset is a fraction of
   *  it, while the loops still have to run the full way round. */
  clearedAreaMM2: number,
  /** Infinity when the user has explicitly forced this strategy onto the shape. */
  redundancyLimit: number,
  onProgress?: (frac: number) => void,
): SpiralChain[] {
  const wall = ensureWinding(stripClosingDuplicate(insetBoundary), wantCCW)
  const loops: Pt2[][] = [wall]

  // A level is accepted when its worst-spaced loop sits within a stepover of the level
  // outside it — never under-covered — and no closer than 92% of one.
  //
  // The window is deliberately tight. Every accepted gap below a stepover is a pass the
  // operator did not ask for: a window of [0.6, 1.0] averages 0.8, which is 25% more
  // loops than the requested stepover needs, and that is what made the morph spiral look
  // visibly denser than the setting. Bisection converges fast enough to hold a narrow
  // window, and the fallback below still accepts an over-dense level rather than
  // under-covering if it runs out of tries.
  const GAP_MAX = stepoverMM
  const GAP_MIN = stepoverMM * 0.92

  // How much more path than necessary this shape forces the spiral to cut, before giving up
  // on it. A level is gated on its WORST-spaced point (that is what never under-covers), so
  // wherever the field gradient varies along a loop everything but that point comes out
  // over-dense — and one isotherm around a 22-island outline varies a lot. Measured against
  // area/stepover on the dog file: a simple blob 1.35x, a plain outline 1.52x, a long slot
  // 2.58x, the full 22-island dog 5.00x. Under 2x the smoothness is worth the extra path
  // (the dog's raster wants 1888 lifts against morph's 226); at 5x it is not machining, it
  // is polishing air.
  //
  // Checked from the mean gap, so it costs nothing extra and is known at the FIRST accepted
  // level — the point of the gate is that the user does not wait out a 167 s generate for a
  // strategy that was never going to suit the shape.

  const MAX_LEVELS = 400
  const MAX_RETRIES = 8

  // Reference the spacing against everything already covered, which is the previous
  // level's loops PLUS the domain boundary — the outer wall and every island keep-out.
  // The field is zero on all of them, so they are the T=0 level set, and the finishing
  // pass sweeps them. Measuring against the wall alone stalls the march dead on any
  // pocket with an island: the first isotherm to appear around an island hugs the island
  // and is legitimately half a pocket away from the outer wall, so its gap never comes
  // under a stepover no matter how small the temperature step gets.
  const domain: Pt2[][] = [wall, ...holes.filter(hh => hh.length >= 3)]
  const idealLen = clearedAreaMM2 / stepoverMM
  let tracedLen = 0
  let prev: Pt2[][] = domain
  let level = 0
  let dT = g.tMax / 40          // first guess; carried forward once the march finds its stride

  for (let n = 0; n < MAX_LEVELS && level < g.tMax * 0.999; n++) {
    // Distance from the previous level grows monotonically with the temperature step, so
    // BISECT for a step that lands in the window rather than scaling by the error. A
    // proportional correction overshoots badly here — the field is steep by the wall and
    // flat by the ridge, so the gap is a strongly nonlinear function of the step — and it
    // oscillated (7.2 mm, 1.4, 4.0, 1.1, 5.0 …) without ever landing inside.
    let lo = 0                          // largest step known NOT to under-cover
    let loCand: Pt2[][] | null = null
    let loAt = 0
    let hi = Infinity                   // smallest step known to leave a gap
    let t = dT

    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      const next = Math.min(level + t, g.tMax * 0.999)
      const cand = isothermLoops(g, next).map(lp => ensureWinding(lp, wantCCW))
      if (cand.length === 0) {
        // No contour at this temperature: this step reached past the last peak. A smaller
        // one may still find one, so treat it exactly like an over-large step.
        hi = t
      } else {
        const gap = setGap(cand, prev)
        if (gap <= GAP_MAX) {
          lo = t; loCand = cand; loAt = next
          // In the window, or as deep as the field goes — take it.
          if (gap >= GAP_MIN || next >= g.tMax * 0.999) break
          // Under-dense is safe but wasteful: try to reach further in.
        } else {
          hi = t
        }
      }
      t = Number.isFinite(hi) ? (lo + hi) / 2 : t * 2
      if (t <= 1e-12) break
    }

    // Out of tries still means progress: an over-dense level costs a little extra path,
    // and decimateChain thins it. Only a step that cannot avoid under-covering ends the
    // march — that is the ridge, where there is nothing further in to reach.
    if (!loCand || lo <= 1e-12) break
    // The march walks the temperature from the wall to the ridge, so how far `level` has
    // climbed toward tMax IS the fraction traced.
    onProgress?.(loAt / g.tMax)
    for (const lp of loCand) loops.push(lp)

    // Bail the moment the verdict is already settled. Loop perimeter only accumulates, so
    // once it passes the limit the final ratio cannot come back under it — this reaches the
    // same answer as the check after the march, just without finishing a march whose result
    // is going to be thrown away. That is the whole point of the gate: the user should not
    // wait out a long generate for a strategy that was never going to suit the shape.
    if (idealLen > 0) {
      tracedLen += loCand.reduce((a, lp) => a + ringPerimeter(lp), 0)
      if (tracedLen / idealLen > redundancyLimit) { lastUnsuitableRatio = tracedLen / idealLen; return [] }
    }


    prev = [...domain, ...loCand]
    level = loAt
    dT = lo
  }

  // What this spiral will cost, against what the area needs — measured, not predicted.
  // Every loop is cut once, so the path is their total perimeter; any stepover strategy
  // needs at least area/stepover. The check sits HERE, after the march but before the
  // morph/clamp stage that turns loops into a spiral, because the loops are what the
  // verdict is about and the stages after this one are the expensive ones.
  const spiralLen = loops.reduce((a, lp) => a + ringPerimeter(lp), 0)
  if (idealLen > 0 && spiralLen / idealLen > redundancyLimit) {
    lastUnsuitableRatio = spiralLen / idealLen
    return []
  }

  const kept = loops

  // Nest the loops by containment: parent = the smallest-area placed (larger) loop
  // that contains this loop, by MAJORITY VOTE over sampled vertices — robust to both a
  // concave loop's centroid landing in a notch and a near-wall vertex landing just
  // outside its parent from grid noise. `kept` is in level order, outer to inner, and a
  // loop at a deeper level always lies inside one at a shallower level — so every
  // container is placed before its children.
  const keptAreas = kept.map(l => Math.abs(signedArea(l)))
  const nodes: LoopNode[] = kept.map(l => ({ loop: l, centroid: centroidOfRing(l), children: [] }))
  const roots: LoopNode[] = []
  const orphans: LoopNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    let parent: LoopNode | null = null
    let parentArea = Infinity
    for (let j = 0; j < i; j++) {
      if (keptAreas[j] < parentArea && loopMostlyInside(kept[i], kept[j])) {
        parent = nodes[j]; parentArea = keptAreas[j]
      }
    }
    if (parent) parent.children.push(nodes[i])
    else if (i > 0) orphans.push(nodes[i])
    else roots.push(nodes[i])
  }

  // Belt-and-suspenders: merge any residual near-coincident sibling loops (same lobe)
  // so they don't each become a separate overlapping pass. Genuine lobes have
  // centroids far further apart than one stepover.
  dedupeForestBranches([...roots, ...orphans], stepoverMM)

  // kept[0] is the WALL — the domain the field was solved in — so every isotherm is inside
  // it by construction and this forest can only have ONE root. A loop the vote could not
  // place rides the wall (the outermost level does, at small stepovers: it weaves in and
  // out of the inset ring by a fraction of a millimetre, so most of its vertices sample as
  // outside); it did not escape the pocket. Left as a second root it took the whole nest
  // under it with it, and the wall was then childless — a one-loop chain, which reads as a
  // leaf and therefore SEEDS A CENTRE FILL. That is what made a star bore its middle, drive
  // straight out to the wall, cut a lap round it, and only then come back for the real
  // spiral (fieldSpiral.test.ts pins it; scripts/morph-cut-order.mts finds it end-to-end).
  //
  // Adopted AFTER the dedupe above, and deduped as its own subtree: an orphan is the only
  // record of its level, so it must never be dropped as a near-duplicate of the wall's
  // other children — that would leave its ring of stock uncut.
  for (const o of orphans) nodes[0].children.push(o)

  // Decimate each chain so consecutive kept loops are ≤ one stepover apart.
  return forestToChains(roots, stepoverMM)
    .filter(c => c.loopsOuterToInner.length > 0)
    .map(c => {
      const loops = decimateChain(c.loopsOuterToInner, stepoverMM)
      // The outermost level IS the wall, and the wall is exactly what the finishing pass
      // cuts — `compoundFinishRings` insets the same boundary by the same tool radius — so
      // leaving it in the chain machines it twice: the spiral's last lap, then the finish
      // ring over the top of it. Contour drops its equivalent ring for the same reason
      // (`levels.slice(1)`); this is morph's version of that.
      //
      // The band it used to cover is still covered: the outermost loop left in the chain is
      // within one stepover S of the wall (decimateChain anchored it there) and reaches a
      // tool radius R past itself, while the finishing pass reaches R inward from the wall —
      // so the two meet for any S ≤ 2R, i.e. any stepover up to 100%.
      //
      // Only dropped when something remains to cut: a pocket small enough that the wall is
      // the WHOLE chain is cleared by that lap plus its centre seed, and dropping it would
      // leave the pocket to the finishing pass alone.
      const trimmed = loops.length > 1 && loops[0] === wall ? loops.slice(1) : loops
      return { loopsOuterToInner: trimmed, innerIsLeaf: c.innerIsLeaf }
    })
}

type SpiralEntry = 'helix' | 'ramp' | 'travel'

export const planFieldSpiralPocket: PocketPlanner = (boundary, islands, tool, params, onProgress): PocketPlan | null => {
  const safeZ = params.safeHeightMM ?? 5
  const toolRadius = tool.diameterMM / 2
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const wantCCW = params.direction === 'climb' // inside cut: climb (M3) = CCW travel
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined
  // Coarser chord on the spiral body keeps gcode size sane; sub-0.4 mm facets are
  // invisible on a roughing pass.
  const chordTol = Math.max(0.3, Math.min(0.6, tool.diameterMM * 0.07))

  const plan = ((): { chains: { spiral: Pt2[]; entry: SpiralEntry; helixCenter: Pt2 }[]; finishRings: Pt2[][] } | null => {
    // Round join, matching the island keep-out below: the clamped spiral is snapped
    // onto this ring, and a miter spike at a reflex corner is a tool-centre position
    // that gouges the corner (see insetRing).
    const clearedArea = Math.abs(signedArea(boundary)) -
      islands.reduce((a, i) => a + (i.length >= 3 ? Math.abs(signedArea(i)) : 0), 0)
    const inset = insetRing(boundary, toolRadius, JoinType.Round)
    if (inset.length < 3) return null
    // Round join: the tool-centre path around a convex island corner is an arc of
    // the tool radius, not a sharp mitre — keeps the keep-out free of corners the
    // clamped spiral could chord across.
    const holes = growIslands(islands, toolRadius, JoinType.Round)
    const cell = Math.max(0.25, toolRadius / 4)
    const g = _timed('solveField', () => solveField([inset], holes, cell,
      (f) => onProgress?.(0.55 * f, 'Solving field')))
    if (g.tMax <= 0) return null

    // Isotherm loops → containment nesting → per-region chains (handles islands).
    const chains = _timed('buildIsothermChains', () => buildIsothermChains(g, inset, holes, stepoverMM, wantCCW, clearedArea,
      params.forceStrategy ? Infinity : REDUNDANCY_LIMIT,
      (f) => onProgress?.(0.55 + 0.35 * f, 'Tracing curves')))
    if (chains.length === 0) return null
    // One point guaranteed INSIDE each island — never its centroid, which on a U- or
    // C-shaped island falls in the island's own notch (see interiorPoint). Any point of
    // an island will do: the isotherms live in free space and never cross one, so an
    // island is wholly inside a loop or wholly outside it.
    const islandPoints = islands.flatMap((i) => {
      const p = interiorPoint([i])
      return p ? [p] : []
    })

    const out: { spiral: Pt2[]; entry: SpiralEntry; helixCenter: Pt2 }[] = []
    for (const chain of chains) {
      // A chain whose innermost loop encircles an island wraps a hole, not a point:
      // it must not centre-fill (its "centre" is the solid island) and it enters by
      // ramp (no helix at the island). The morph still spirals around the island.
      // As in spiralPocket: a C-shaped inner loop hugging an island defeats the
      // centroid-containment test while its OWN centroid sits inside the island, so
      // additionally require the seed point to lie in free space.
      const innerLoop = chain.loopsOuterToInner[chain.loopsOuterToInner.length - 1]
      const encirclesIsland = islandPoints.some(c => pointInPolygon(c[0], c[1], innerLoop))
      const innerCentroidPre = centroidOfRing(innerLoop)
      const centroidFree =
        pointInPolygon(innerCentroidPre[0], innerCentroidPre[1], inset) &&
        !holes.some(hh => hh.length >= 3 && pointInPolygon(innerCentroidPre[0], innerCentroidPre[1], hh))
      const seedCenter = chain.innerIsLeaf && !encirclesIsland && centroidFree

      const innerToOuter = [...chain.loopsOuterToInner].reverse()
      // Localized transition (default fraction): stays on-contour most of each turn
      // so coverage holds even where consecutive isotherms differ in extent (arm
      // tips). The entry handles the worst-case entry engagement.
      onProgress?.(0.9 + 0.1 * (out.length / Math.max(1, chains.length)), 'Building spiral')
      const raw = _timed('morphChainToSpiral', () => morphChainToSpiral(innerToOuter, chordTol, stepoverMM, toolRadius, seedCenter))
      // Never let the tool centre enter an island or leave the inset wall; split out any
      // snap-flip chords the clamp left behind.
      const runs = _timed('clampSpiral', () => splitClampedSpiral(clampSpiralToRegion(raw, inset, holes)))
      // Helix at a true point centre; ramp everywhere else. A branch/saddle chain's
      // start is NOT inside its children's cleared lobes (the lobes are deeper in),
      // so a straight plunge there slots at full engagement — always ramp instead.
      // Bore concentric with the innermost loop so the helix meshes with the spiral —
      // but only when its centroid lies INSIDE the loop. A non-convex (L-shaped) loop's
      // centroid falls in a notch outside it; boring there would gouge the wall, so such
      // chains ramp in instead — and only the first run may helix.
      const helixCenter = centroidOfRing(innerLoop)
      const canHelix = seedCenter && pointInPolygon(helixCenter[0], helixCenter[1], innerLoop)
      for (let ri = 0; ri < runs.length; ri++) {
        out.push({ spiral: runs[ri], entry: ri === 0 && canHelix ? 'helix' : 'ramp', helixCenter })
      }
    }
    if (out.length === 0) return null
    // Finish the outer wall and each island wall. Compound inset (round joins, matching
    // this strategy's smooth style) so a near-wall island pinches instead of swinging
    // the tool through the outer wall; islands wound opposite for climb.
    const finishRings = _timed('compoundFinishRings', () => compoundFinishRings(boundary, islands, toolRadius, wantCCW, JoinType.Round))
    return { chains: out, finishRings }
  })()

  if (!plan) return null
  const { chains, finishRings } = plan

  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const travelObstacles = {
    edgeObstacles: [...finishRings, ...islandObstacles],
    solidObstacles: islandObstacles,
    containment: finishRings,
  }

  // Largest helix radius at `p` that keeps the bored circle clear of every wall and
  // island (finishRings are the tool-centre paths along them). 0 if there's no room.
  const safeHelixRadius = (p: Pt2) => maxClearHelixRadius(p, finishRings, toolRadius * 0.9)

  return {
    finishRings,
    travelObstacles,
    emitCuts: (zDepth: number, prevZ: number, incomingPos: Pt2 | null, segs: MotionSegment[]) => {
      let lastPos: Pt2 | null = incomingPos
      let cutAnything = false

      const rampIn = (spiral: Pt2[], start: Pt2, passPrevZ: number) => {
        if (lastPos !== null && !isTravelSafe(lastPos, start, travelObstacles)) {
          segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
        }
        const { touchdown, sampleAt } = rampLeadIn(spiral, true, rampDist ?? 2 * tool.diameterMM)
        segs.push({ x: touchdown[0], y: touchdown[1], z: safeZ, rapid: true })
        segs.push({ x: touchdown[0], y: touchdown[1], z: passPrevZ, rapid: true })
        emitRampDescent(segs, sampleAt, passPrevZ, zDepth, 12)
      }

      for (const { spiral, entry, helixCenter } of chains) {
        const start = spiral[0]
        const passPrevZ = cutAnything ? zDepth : prevZ
        // Bore concentric with the innermost loop so the helix meshes with the spiral.
        const hr = entry === 'helix' ? safeHelixRadius(helixCenter) : 0
        const helixOk = entry === 'helix' && hr >= 0.6
        let cutFrom = 1
        if (helixOk) {
          // Integrated helix entry: bores the centre and ends at the first uncut point,
          // already moving along the spiral — no straight connector, no redundant seed loop.
          if (lastPos !== null && !isTravelSafe(lastPos, start, travelObstacles)) {
            segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
          }
          cutFrom = emitSpiralHelixEntry(spiral, helixCenter, hr, passPrevZ, zDepth, wantCCW, segs, safeZ)
        } else {
          // Ramp down along the spiral start — used for branch/island chains and for any
          // helix start with no room to bore (near a wall or island). Also ends at the
          // spiral start, flowing into it.
          rampIn(spiral, start, passPrevZ)
        }
        for (let i = cutFrom; i < spiral.length; i++) {
          segs.push({ x: spiral[i][0], y: spiral[i][1], z: zDepth, rapid: false })
        }
        lastPos = spiral[spiral.length - 1]
        cutAnything = true
      }
      return lastPos
    },
  }
}

