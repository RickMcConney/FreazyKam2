// Analytic engagement area for the FreeCAD-derived adaptive engine (./engine.ts).
//
// Upstream (Adaptive2d::CalcCutArea) measures "area inside the new tool disk D2, outside the
// previous disk D1 and outside the cleared polygons C" with a vertical sweep: every polygon
// vertex and circle crossing becomes a slab boundary, and every slab re-scans every edge —
// O(E²) per call, and the engine makes a few calls per tool step. Here the same area comes
// from Green's theorem over the boundary of K ∩ C, where K = D2 \ D1:
//
//   area(K \ C) = area(K) − area(K ∩ C)
//   area(K ∩ C) = ∮ over (∂C ∩ K)  +  ∮ over (∂K ∩ C)        (each with its own orientation)
//
// ∂C ∩ K is each cleared edge clipped to an interval in t (a quadratic per circle); ∂K ∩ C is
// the two arcs of K split at their crossings with C. Which sub-arcs lie inside C needs no
// point-in-polygon test: crossing a C edge where the edge LEAVES the disk means the CCW walk
// round the circle ENTERS C (C is on the left of its edges). That flag comes from classifying
// the edge endpoints inside/outside the circle, which is exact here — tool centres and polygon
// vertices are integers, and the circle is perturbed to r² − ½ so no vertex can ever lie on it.
// Everything is computed relative to c2, which also makes the line through c2 and c1 (the
// climb/conventional split) contribute nothing to the boundary integral.
//
// Cost is O(E) per call, with a bounding-box reject that discards most edges in a few compares.
//
// All coordinates are the engine's scaled integers.

/** A flat edge list: edge k is (e[4k], e[4k+1]) → (e[4k+2], e[4k+3]), cleared region on the left. */
export interface EdgeSet { e: Float64Array; n: number }

const TWO_PI = 2 * Math.PI

// Crossing scratch, one list per circle. Grown on demand; the engine is single-threaded.
let ang2 = new Float64Array(64), flg2 = new Uint8Array(64)
let ang1 = new Float64Array(64), flg1 = new Uint8Array(64)
let n2 = 0, n1 = 0
function push2(a: number, f: number): void {
  if (n2 === ang2.length) { const a2 = new Float64Array(n2 * 2); a2.set(ang2); ang2 = a2; const f2 = new Uint8Array(n2 * 2); f2.set(flg2); flg2 = f2 }
  ang2[n2] = a; flg2[n2++] = f
}
function push1(a: number, f: number): void {
  if (n1 === ang1.length) { const a2 = new Float64Array(n1 * 2); a2.set(ang1); ang1 = a2; const f2 = new Uint8Array(n1 * 2); f2.set(flg1); flg1 = f2 }
  ang1[n1] = a; flg1[n1++] = f
}

let ordScratch = new Int32Array(64)
let delScratch = new Float64Array(64)

/** ∫ over the parts of the CCW arc [lo, lo+W] that lie inside C, of ½(x dy − y dx), for the
 *  circle at (cx, cy) (relative to c2) of radius √r2. `constInside` is the status of the whole
 *  circle when it has no crossings at all. */
function arcInside(
  ang: Float64Array, flg: Uint8Array, n: number,
  cx: number, cy: number, r2: number, rp: number,
  lo: number, W: number, constInside: () => boolean,
): number {
  if (W <= 0) return 0
  const seg = (a: number, b: number): number =>
    0.5 * (r2 * (b - a) + rp * (cx * (Math.sin(b) - Math.sin(a)) - cy * (Math.cos(b) - Math.cos(a))))
  if (n === 0) return constInside() ? seg(lo, lo + W) : 0
  if (ordScratch.length < n) { ordScratch = new Int32Array(n * 2); delScratch = new Float64Array(n * 2) }
  // Angular offset of every crossing from lo, in [0, 2π).
  let last = 0
  for (let k = 0; k < n; k++) {
    let d = (ang[k] - lo) % TWO_PI
    if (d < 0) d += TWO_PI
    delScratch[k] = d
    ordScratch[k] = k
    if (d > delScratch[last]) last = k
  }
  // Insertion sort — crossing counts are tiny.
  for (let i = 1; i < n; i++) {
    const v = ordScratch[i], dv = delScratch[v]
    let j = i - 1
    while (j >= 0 && delScratch[ordScratch[j]] > dv) { ordScratch[j + 1] = ordScratch[j]; j-- }
    ordScratch[j + 1] = v
  }
  // Status at lo is set by the last crossing before it, going round.
  let inside = flg[last] === 1
  let cur = 0, sum = 0
  for (let i = 0; i < n; i++) {
    const k = ordScratch[i]
    const d = delScratch[k]
    if (d > W) break
    if (inside && d > cur) sum += seg(lo + cur, lo + d)
    inside = flg[k] === 1
    cur = d
  }
  if (inside && W > cur) sum += seg(lo + cur, lo + W)
  return sum
}

/** Non-zero winding of the edge set around (px, py), edges given relative to (ox, oy). */
function windingAt(es: EdgeSet, ox: number, oy: number, px: number, py: number): boolean {
  const e = es.e
  let w = 0
  for (let k = 0, m = es.n * 4; k < m; k += 4) {
    const ay = e[k + 1] - oy, by = e[k + 3] - oy
    if ((ay <= py) === (by <= py)) continue
    const ax = e[k] - ox, bx = e[k + 2] - ox
    const x = ax + (py - ay) * (bx - ax) / (by - ay)
    if (x > px) w += by > ay ? 1 : -1
  }
  return w !== 0
}

/** Result buffer, reused — read both fields before the next call. */
export const cutAreaOut = { area: 0, conv: 0 }

/** Area of (D(c2, R) \ D(c1, R)) \ C, and the part of it left of the motion c1 → c2 (the
 *  conventional-milling side for a climb-natural engine). Written into `cutAreaOut`. */
export function cutArea(es: EdgeSet, c1x: number, c1y: number, c2x: number, c2y: number, R: number): void {
  const ex = c1x - c2x, ey = c1y - c2y            // c1 relative to c2
  const d = Math.hypot(ex, ey)
  if (d < 1e-7) { cutAreaOut.area = 0; cutAreaOut.conv = 0; return }
  const r2 = R * R - 0.5, rp = Math.sqrt(r2)
  const ux = -ex / d, uy = -ey / d                  // motion direction
  const twoR = 2 * rp
  const overlap = d < twoR
  const areaK = overlap
    ? Math.PI * r2 - (2 * r2 * Math.acos(d / twoR) - 0.5 * d * Math.sqrt(4 * r2 - d * d))
    : Math.PI * r2

  // Bounding box of D2 ∪ D1, relative to c2.
  const bx0 = Math.min(0, ex) - rp, bx1 = Math.max(0, ex) + rp
  const by0 = Math.min(0, ey) - rp, by1 = Math.max(0, ey) + rp

  n2 = 0; n1 = 0
  let edgeSum = 0, edgeSumH = 0
  const e = es.e
  for (let k = 0, m = es.n * 4; k < m; k += 4) {
    const ax = e[k] - c2x, ay = e[k + 1] - c2y, bx = e[k + 2] - c2x, by = e[k + 3] - c2y
    if ((ax < bx0 && bx < bx0) || (ax > bx1 && bx > bx1) || (ay < by0 && by < by0) || (ay > by1 && by > by1)) continue
    const dx = bx - ax, dy = by - ay
    const a = dx * dx + dy * dy
    if (a === 0) continue

    // ── D2 (centre at origin) ──
    let s2 = 1, e2 = 0                               // in-disk interval [s2, e2], empty if s2 > e2
    {
      const pa = ax * ax + ay * ay, pb = bx * bx + by * by
      const aIn = pa < r2, bIn = pb < r2
      const b = 2 * (ax * dx + ay * dy), c = pa - r2
      if (aIn && bIn) { s2 = 0; e2 = 1 } else {
        const disc = b * b - 4 * a * c
        if (disc > 0) {
          const sq = Math.sqrt(disc)
          const tL = (-b - sq) / (2 * a), tR = (-b + sq) / (2 * a)
          if (aIn) {
            const t = Math.min(1, Math.max(0, tR))
            s2 = 0; e2 = t
            push2(Math.atan2(ay + t * dy, ax + t * dx), 1)
          } else if (bIn) {
            const t = Math.min(1, Math.max(0, tL))
            s2 = t; e2 = 1
            push2(Math.atan2(ay + t * dy, ax + t * dx), 0)
          } else if (tL > 0 && tR < 1) {
            s2 = tL; e2 = tR
            push2(Math.atan2(ay + tL * dy, ax + tL * dx), 0)
            push2(Math.atan2(ay + tR * dy, ax + tR * dx), 1)
          }
        }
      }
    }

    // ── D1 (centre at c1 − c2) ──
    let s1 = 1, e1 = 0
    if (overlap) {
      const qax = ax - ex, qay = ay - ey, qbx = bx - ex, qby = by - ey
      const pa = qax * qax + qay * qay, pb = qbx * qbx + qby * qby
      const aIn = pa < r2, bIn = pb < r2
      if (aIn && bIn) { s1 = 0; e1 = 1 } else {
        const b = 2 * (qax * dx + qay * dy), c = pa - r2
        const disc = b * b - 4 * a * c
        if (disc > 0) {
          const sq = Math.sqrt(disc)
          const tL = (-b - sq) / (2 * a), tR = (-b + sq) / (2 * a)
          if (aIn) {
            const t = Math.min(1, Math.max(0, tR))
            s1 = 0; e1 = t
            push1(Math.atan2(qay + t * dy, qax + t * dx), 1)
          } else if (bIn) {
            const t = Math.min(1, Math.max(0, tL))
            s1 = t; e1 = 1
            push1(Math.atan2(qay + t * dy, qax + t * dx), 0)
          } else if (tL > 0 && tR < 1) {
            s1 = tL; e1 = tR
            push1(Math.atan2(qay + tL * dy, qax + tL * dx), 0)
            push1(Math.atan2(qay + tR * dy, qax + tR * dx), 1)
          }
        }
      }
    }

    // ── edge pieces inside K = [s2,e2] \ [s1,e1] ──
    if (s2 >= e2) continue
    const f0 = ux * ay - uy * ax, f1 = ux * dy - uy * dx   // cross(u, P(t)) = f0 + t f1 ; left ⇔ > 0
    const piece = (s: number, t: number): void => {
      if (t <= s) return
      const px = ax + s * dx, py = ay + s * dy, qx = ax + t * dx, qy = ay + t * dy
      edgeSum += 0.5 * (px * qy - qx * py)
      // clip to the left half-plane
      let hs = s, ht = t
      if (f1 === 0) { if (f0 <= 0) return } else {
        const tz = -f0 / f1
        if (f1 > 0) { if (tz > hs) hs = tz } else { if (tz < ht) ht = tz }
      }
      if (ht <= hs) return
      const hpx = ax + hs * dx, hpy = ay + hs * dy, hqx = ax + ht * dx, hqy = ay + ht * dy
      edgeSumH += 0.5 * (hpx * hqy - hqx * hpy)
    }
    if (s1 >= e1 || e1 <= s2 || s1 >= e2) piece(s2, e2)
    else { piece(s2, Math.min(e2, s1)); piece(Math.max(s2, e1), e2) }
  }

  // ── arcs of ∂K inside C ──
  const phi1 = Math.atan2(ey, ex)                  // direction of c1 seen from c2
  const phiU = phi1 + Math.PI                      // motion direction
  const alpha = overlap ? Math.acos(d / twoR) : 0
  const in2 = (): boolean => windingAt(es, c2x, c2y, rp * Math.cos(phiU), rp * Math.sin(phiU))
  const in1 = (): boolean => windingAt(es, c2x, c2y, ex + rp * Math.cos(phiU), ey + rp * Math.sin(phiU))
  // D2 arc outside D1: (φ1+α, φ1+2π−α); its left half: (φU, φU+π−α).
  const I2 = arcInside(ang2, flg2, n2, 0, 0, r2, rp, phi1 + alpha, TWO_PI - 2 * alpha, in2)
  const I2H = arcInside(ang2, flg2, n2, 0, 0, r2, rp, phiU, Math.PI - alpha, in2)
  // D1 arc inside D2: (φU−α, φU+α), walked clockwise; its left half: (φU, φU+α).
  let I1 = 0, I1H = 0
  if (overlap) {
    I1 = arcInside(ang1, flg1, n1, ex, ey, r2, rp, phiU - alpha, 2 * alpha, in1)
    I1H = arcInside(ang1, flg1, n1, ex, ey, r2, rp, phiU, alpha, in1)
  }

  const kc = edgeSum + I2 - I1
  const kch = edgeSumH + I2H - I1H
  cutAreaOut.area = Math.max(0, areaK - kc)
  cutAreaOut.conv = Math.max(0, 0.5 * areaK - kch)
}

/** Area of the disk D(c, r) outside C. */
export function diskUncutArea(es: EdgeSet, cx: number, cy: number, r: number): number {
  const r2 = r * r - 0.5, rp = Math.sqrt(Math.max(r2, 0))
  if (rp <= 0) return 0
  n2 = 0
  let edgeSum = 0
  const e = es.e
  for (let k = 0, m = es.n * 4; k < m; k += 4) {
    const ax = e[k] - cx, ay = e[k + 1] - cy, bx = e[k + 2] - cx, by = e[k + 3] - cy
    if ((ax < -rp && bx < -rp) || (ax > rp && bx > rp) || (ay < -rp && by < -rp) || (ay > rp && by > rp)) continue
    const dx = bx - ax, dy = by - ay
    const a = dx * dx + dy * dy
    if (a === 0) continue
    const pa = ax * ax + ay * ay, pb = bx * bx + by * by
    const aIn = pa < r2, bIn = pb < r2
    let s = 1, t = 0
    if (aIn && bIn) { s = 0; t = 1 } else {
      const b = 2 * (ax * dx + ay * dy), c = pa - r2
      const disc = b * b - 4 * a * c
      if (disc > 0) {
        const sq = Math.sqrt(disc)
        const tL = (-b - sq) / (2 * a), tR = (-b + sq) / (2 * a)
        if (aIn) { const u = Math.min(1, Math.max(0, tR)); s = 0; t = u; push2(Math.atan2(ay + u * dy, ax + u * dx), 1) }
        else if (bIn) { const u = Math.min(1, Math.max(0, tL)); s = u; t = 1; push2(Math.atan2(ay + u * dy, ax + u * dx), 0) }
        else if (tL > 0 && tR < 1) {
          s = tL; t = tR
          push2(Math.atan2(ay + tL * dy, ax + tL * dx), 0)
          push2(Math.atan2(ay + tR * dy, ax + tR * dx), 1)
        }
      }
    }
    if (t > s) {
      const px = ax + s * dx, py = ay + s * dy, qx = ax + t * dx, qy = ay + t * dy
      edgeSum += 0.5 * (px * qy - qx * py)
    }
  }
  const I = arcInside(ang2, flg2, n2, 0, 0, r2, rp, 0, TWO_PI, () => windingAt(es, cx, cy, rp, 0))
  return Math.max(0, Math.PI * r2 - (edgeSum + I))
}

/** Is (px, py) inside C? */
export function pointInEdges(es: EdgeSet, px: number, py: number): boolean {
  return windingAt(es, 0, 0, px, py)
}
