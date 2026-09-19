// Flatten SVG path d-strings (in CNC mm, Y-up) to polyline sub-paths.
// All commands assumed absolute (as produced by svgImporter's stringifyD).

export type Pt2 = [number, number]

function dist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-20) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

function cubicFlat(
  p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number, p3x: number, p3y: number,
  tol: number, pts: Pt2[], depth = 0
) {
  if (depth > 12 || (dist(p1x, p1y, p0x, p0y, p3x, p3y) <= tol && dist(p2x, p2y, p0x, p0y, p3x, p3y) <= tol)) {
    pts.push([p3x, p3y])
    return
  }
  const m01x = (p0x+p1x)/2, m01y = (p0y+p1y)/2
  const m12x = (p1x+p2x)/2, m12y = (p1y+p2y)/2
  const m23x = (p2x+p3x)/2, m23y = (p2y+p3y)/2
  const m012x = (m01x+m12x)/2, m012y = (m01y+m12y)/2
  const m123x = (m12x+m23x)/2, m123y = (m12y+m23y)/2
  const mx = (m012x+m123x)/2, my = (m012y+m123y)/2
  cubicFlat(p0x, p0y, m01x, m01y, m012x, m012y, mx, my, tol, pts, depth+1)
  cubicFlat(mx, my, m123x, m123y, m23x, m23y, p3x, p3y, tol, pts, depth+1)
}

function quadFlat(
  p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number,
  tol: number, pts: Pt2[], depth = 0
) {
  if (depth > 12 || dist(p1x, p1y, p0x, p0y, p2x, p2y) <= tol) {
    pts.push([p2x, p2y])
    return
  }
  const m01x = (p0x+p1x)/2, m01y = (p0y+p1y)/2
  const m12x = (p1x+p2x)/2, m12y = (p1y+p2y)/2
  const mx = (m01x+m12x)/2, my = (m01y+m12y)/2
  quadFlat(p0x, p0y, m01x, m01y, mx, my, tol, pts, depth+1)
  quadFlat(mx, my, m12x, m12y, p2x, p2y, tol, pts, depth+1)
}

interface ArcCentre {
  cx: number; cy: number
  rxA: number; ryA: number
  cosP: number; sinP: number
  theta1: number; dTheta: number
}

// SVG endpoint → centre parameterisation (SVG implementation notes F.6.5), radii scaled up
// when they cannot span the chord. Null for a zero-length arc. Shared by the flattener and
// `pathExtents` so the two cannot disagree about which ellipse an arc is on.
function arcCenter(
  x0: number, y0: number,
  rx: number, ry: number, phi: number,
  largeArc: number, sweep: number,
  x1: number, y1: number,
): ArcCentre | null {
  if (Math.hypot(x0 - x1, y0 - y1) < 1e-10) return null
  const sinP = Math.sin(phi * Math.PI / 180)
  const cosP = Math.cos(phi * Math.PI / 180)
  const dx2 = (x0 - x1) / 2, dy2 = (y0 - y1) / 2
  const x1p = cosP * dx2 + sinP * dy2
  const y1p = -sinP * dx2 + cosP * dy2
  let rxA = Math.abs(rx), ryA = Math.abs(ry)
  const lam = (x1p * x1p) / (rxA * rxA) + (y1p * y1p) / (ryA * ryA)
  if (lam > 1) { const l = Math.sqrt(lam); rxA *= l; ryA *= l }
  const num = Math.max(0, rxA*rxA*ryA*ryA - rxA*rxA*y1p*y1p - ryA*ryA*x1p*x1p)
  const den = rxA*rxA*y1p*y1p + ryA*ryA*x1p*x1p
  const sq = Math.sqrt(num / Math.max(den, 1e-20)) * (largeArc === sweep ? -1 : 1)
  const cxp = sq * rxA * y1p / ryA
  const cyp = -sq * ryA * x1p / rxA
  const cx = cosP * cxp - sinP * cyp + (x0 + x1) / 2
  const cy = sinP * cxp + cosP * cyp + (y0 + y1) / 2
  const ux = (x1p - cxp) / rxA, uy = (y1p - cyp) / ryA
  const vx = (-x1p - cxp) / rxA, vy = (-y1p - cyp) / ryA
  let theta1 = Math.atan2(uy, ux)
  let dTheta = Math.atan2(vy * ux - vx * uy, ux * vx + uy * vy)
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI
  return { cx, cy, rxA, ryA, cosP, sinP, theta1, dTheta }
}

function arcFlat(
  x0: number, y0: number,
  rx: number, ry: number, phi: number,
  largeArc: number, sweep: number,
  x1: number, y1: number,
  pts: Pt2[],
  tol: number
) {
  // A zero radius makes the arc a straight line to its endpoint (SVG implementation notes
  // F.6.2). The centre arithmetic below divides by the radii, so without this every point
  // of it came out NaN — and a NaN vertex poisons whatever consumes the ring (offsets,
  // areas, containment). Pushed even for a zero-length arc, exactly as pathExtents counts
  // it, so the two still agree on which subpaths hold two points.
  if (rx === 0 || ry === 0) { pts.push([x1, y1]); return }
  const a = arcCenter(x0, y0, rx, ry, phi, largeArc, sweep, x1, y1)
  if (!a) return
  const { cx, cy, rxA, ryA, cosP, sinP, theta1, dTheta } = a
  // Chord-error formula: thetaPerStep = 2*acos(1 − tol/r) where r = max radius.
  // Using max(rxA, ryA) is conservative — guarantees chord error ≤ tol everywhere
  // on the arc, including the gentlest (largest-radius) part of an ellipse.
  const r = Math.max(rxA, ryA)
  const thetaPerStep = 2 * Math.acos(Math.max(-1, 1 - tol / r))
  const steps = Math.max(4, Math.ceil(Math.abs(dTheta) / Math.max(thetaPerStep, 1e-3)))
  for (let i = 1; i <= steps; i++) {
    const theta = theta1 + (i / steps) * dTheta
    const cosT = Math.cos(theta), sinT = Math.sin(theta)
    pts.push([cosP * rxA * cosT - sinP * ryA * sinT + cx, sinP * rxA * cosT + cosP * ryA * sinT + cy])
  }
}

export function parseNums(s: string): number[] {
  return (s.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number)
}

export function flattenPath(d: string, tolerance = 0.1): Pt2[][] {
  const subpaths: Pt2[][] = []
  let current: Pt2[] = []
  let cx = 0, cy = 0, mx = 0, my = 0
  let prevCx2 = 0, prevCy2 = 0, prevIsC = false
  let prevQx1 = 0, prevQy1 = 0, prevIsQ = false

  const tokens = d.match(/[MLCSQTAZmlcsqtaz][^MLCSQTAZmlcsqtaz]*/g) ?? []

  function pushSub() {
    if (current.length >= 2) subpaths.push(current)
    current = []
  }

  for (const token of tokens) {
    const cmd = token[0]
    const n = parseNums(token.slice(1))

    switch (cmd) {
      case 'M': {
        pushSub()
        current.push([n[0], n[1]])
        cx = mx = n[0]; cy = my = n[1]
        for (let i = 2; i < n.length; i += 2) { cx = n[i]; cy = n[i+1]; current.push([cx, cy]) }
        prevIsC = false; prevIsQ = false; break
      }
      case 'L': {
        for (let i = 0; i < n.length; i += 2) { cx = n[i]; cy = n[i+1]; current.push([cx, cy]) }
        prevIsC = false; prevIsQ = false; break
      }
      case 'C': {
        for (let i = 0; i < n.length; i += 6) {
          const x1=n[i], y1=n[i+1], x2=n[i+2], y2=n[i+3], x=n[i+4], y=n[i+5]
          cubicFlat(cx, cy, x1, y1, x2, y2, x, y, tolerance, current)
          prevCx2 = x2; prevCy2 = y2; prevIsC = true; prevIsQ = false
          cx = x; cy = y
        }
        break
      }
      case 'S': {
        for (let i = 0; i < n.length; i += 4) {
          const x1 = prevIsC ? 2*cx - prevCx2 : cx
          const y1 = prevIsC ? 2*cy - prevCy2 : cy
          const x2=n[i], y2=n[i+1], x=n[i+2], y=n[i+3]
          cubicFlat(cx, cy, x1, y1, x2, y2, x, y, tolerance, current)
          prevCx2 = x2; prevCy2 = y2; prevIsC = true; prevIsQ = false
          cx = x; cy = y
        }
        break
      }
      case 'Q': {
        for (let i = 0; i < n.length; i += 4) {
          const x1=n[i], y1=n[i+1], x=n[i+2], y=n[i+3]
          quadFlat(cx, cy, x1, y1, x, y, tolerance, current)
          prevQx1 = x1; prevQy1 = y1; prevIsQ = true; prevIsC = false
          cx = x; cy = y
        }
        break
      }
      case 'T': {
        for (let i = 0; i < n.length; i += 2) {
          const x1 = prevIsQ ? 2*cx - prevQx1 : cx
          const y1 = prevIsQ ? 2*cy - prevQy1 : cy
          const x=n[i], y=n[i+1]
          quadFlat(cx, cy, x1, y1, x, y, tolerance, current)
          prevQx1 = x1; prevQy1 = y1; prevIsQ = true; prevIsC = false
          cx = x; cy = y
        }
        break
      }
      case 'A': {
        for (let i = 0; i < n.length; i += 7) {
          arcFlat(cx, cy, n[i], n[i+1], n[i+2], n[i+3], n[i+4], n[i+5], n[i+6], current, tolerance)
          cx = n[i+5]; cy = n[i+6]
        }
        prevIsC = false; prevIsQ = false; break
      }
      case 'Z': {
        if (current.length >= 2) current.push([mx, my])  // close the loop so the closing segment is present
        pushSub()
        cx = mx; cy = my
        prevIsC = false; prevIsQ = false; break
      }
    }
  }
  pushSub()
  return subpaths
}

// Parameter values in (0, 1) where one axis of a cubic Bézier has zero derivative.
// B'(t)/3 = a·t² + b·t + c; the roots use the stable form q = −(b + sign(b)·√disc)/2,
// t = q/a and c/q, which stays accurate when a is tiny (a near-quadratic cubic) and
// degrades to the linear root −c/b when a is exactly zero.
function cubicAxisExtrema(p0: number, p1: number, p2: number, p3: number, out: number[]): void {
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  const disc = b * b - 4 * a * c
  if (disc < 0) return
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(disc))
  if (a !== 0) { const t = q / a; if (t > 0 && t < 1) out.push(t) }
  if (q !== 0) { const t = c / q; if (t > 0 && t < 1) out.push(t) }
}

const TAU = 2 * Math.PI

/**
 * Exact axis-aligned extents of a path — `[minX, minY, maxX, maxY]`, or null when nothing
 * is drawn.
 *
 * NOT the extents of `flattenPath`'s output. A flattened curve stops subdividing once its
 * control points sit within the tolerance of the chord, so the extreme of a bulge can lie
 * up to ~¾·tol outside every emitted point. Here each segment contributes its endpoints plus
 * the points where its derivative vanishes on each axis, which are the true extremes.
 *
 * The bookkeeping MIRRORS flattenPath — same tokeniser, same S/T reflection, same rule
 * that a subpath counts only once it holds two points, same closing point on Z — so the
 * two always describe the same geometry and differ only by the flattening error. Both read an
 * arc with a zero radius as a straight line to its endpoint (SVG spec).
 */
export function pathExtents(d: string): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  // The current subpath's box and how many points flattenPath would hold for it.
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity
  let count = 0
  let cx = 0, cy = 0, mx = 0, my = 0
  let prevCx2 = 0, prevCy2 = 0, prevIsC = false
  let prevQx1 = 0, prevQy1 = 0, prevIsQ = false
  const ts: number[] = []

  const extend = (x: number, y: number) => {
    if (x < sMinX) sMinX = x
    if (x > sMaxX) sMaxX = x
    if (y < sMinY) sMinY = y
    if (y > sMaxY) sMaxY = y
  }
  const point = (x: number, y: number) => { extend(x, y); count++ }
  const pushSub = () => {
    if (count >= 2) {
      if (sMinX < minX) minX = sMinX
      if (sMaxX > maxX) maxX = sMaxX
      if (sMinY < minY) minY = sMinY
      if (sMaxY > maxY) maxY = sMaxY
    }
    sMinX = sMinY = Infinity
    sMaxX = sMaxY = -Infinity
    count = 0
  }
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    ts.length = 0
    cubicAxisExtrema(cx, x1, x2, x, ts)
    cubicAxisExtrema(cy, y1, y2, y, ts)
    for (const t of ts) {
      const mt = 1 - t
      const k0 = mt * mt * mt, k1 = 3 * mt * mt * t, k2 = 3 * mt * t * t, k3 = t * t * t
      extend(k0 * cx + k1 * x1 + k2 * x2 + k3 * x, k0 * cy + k1 * y1 + k2 * y2 + k3 * y)
    }
    point(x, y)
  }
  const quad = (x1: number, y1: number, x: number, y: number) => {
    const denX = cx - 2 * x1 + x, denY = cy - 2 * y1 + y
    for (const t of [denX !== 0 ? (cx - x1) / denX : -1, denY !== 0 ? (cy - y1) / denY : -1]) {
      if (!(t > 0 && t < 1)) continue
      const mt = 1 - t
      extend(mt * mt * cx + 2 * mt * t * x1 + t * t * x, mt * mt * cy + 2 * mt * t * y1 + t * t * y)
    }
    point(x, y)
  }
  const arc = (rx: number, ry: number, phi: number, lg: number, sw: number, x: number, y: number) => {
    if (rx === 0 || ry === 0) { point(x, y); return }
    const a = arcCenter(cx, cy, rx, ry, phi, lg, sw, x, y)
    if (!a) return   // zero-length: flattenPath emits nothing either
    const { rxA, ryA, cosP, sinP, theta1, dTheta } = a
    // dx/dθ = 0 and dy/dθ = 0 on the rotated ellipse, each with its opposite point.
    const thX = Math.atan2(-sinP * ryA, cosP * rxA)
    const thY = Math.atan2(cosP * ryA, sinP * rxA)
    for (const th of [thX, thX + Math.PI, thY, thY + Math.PI]) {
      const along = dTheta >= 0
        ? ((th - theta1) % TAU + TAU) % TAU
        : ((theta1 - th) % TAU + TAU) % TAU
      if (along > Math.abs(dTheta)) continue
      const cosT = Math.cos(th), sinT = Math.sin(th)
      extend(cosP * rxA * cosT - sinP * ryA * sinT + a.cx, sinP * rxA * cosT + cosP * ryA * sinT + a.cy)
    }
    point(x, y)
  }

  const tokens = d.match(/[MLCSQTAZmlcsqtaz][^MLCSQTAZmlcsqtaz]*/g) ?? []
  for (const token of tokens) {
    const cmd = token[0]
    const n = parseNums(token.slice(1))
    switch (cmd) {
      case 'M': {
        pushSub()
        point(n[0], n[1])
        cx = mx = n[0]; cy = my = n[1]
        for (let i = 2; i < n.length; i += 2) { cx = n[i]; cy = n[i + 1]; point(cx, cy) }
        prevIsC = false; prevIsQ = false; break
      }
      case 'L': {
        for (let i = 0; i < n.length; i += 2) { cx = n[i]; cy = n[i + 1]; point(cx, cy) }
        prevIsC = false; prevIsQ = false; break
      }
      case 'C': {
        for (let i = 0; i < n.length; i += 6) {
          cubic(n[i], n[i + 1], n[i + 2], n[i + 3], n[i + 4], n[i + 5])
          prevCx2 = n[i + 2]; prevCy2 = n[i + 3]; prevIsC = true; prevIsQ = false
          cx = n[i + 4]; cy = n[i + 5]
        }
        break
      }
      case 'S': {
        for (let i = 0; i < n.length; i += 4) {
          const x1 = prevIsC ? 2 * cx - prevCx2 : cx
          const y1 = prevIsC ? 2 * cy - prevCy2 : cy
          cubic(x1, y1, n[i], n[i + 1], n[i + 2], n[i + 3])
          prevCx2 = n[i]; prevCy2 = n[i + 1]; prevIsC = true; prevIsQ = false
          cx = n[i + 2]; cy = n[i + 3]
        }
        break
      }
      case 'Q': {
        for (let i = 0; i < n.length; i += 4) {
          quad(n[i], n[i + 1], n[i + 2], n[i + 3])
          prevQx1 = n[i]; prevQy1 = n[i + 1]; prevIsQ = true; prevIsC = false
          cx = n[i + 2]; cy = n[i + 3]
        }
        break
      }
      case 'T': {
        for (let i = 0; i < n.length; i += 2) {
          const x1 = prevIsQ ? 2 * cx - prevQx1 : cx
          const y1 = prevIsQ ? 2 * cy - prevQy1 : cy
          quad(x1, y1, n[i], n[i + 1])
          prevQx1 = x1; prevQy1 = y1; prevIsQ = true; prevIsC = false
          cx = n[i]; cy = n[i + 1]
        }
        break
      }
      case 'A': {
        for (let i = 0; i < n.length; i += 7) {
          arc(n[i], n[i + 1], n[i + 2], n[i + 3], n[i + 4], n[i + 5], n[i + 6])
          cx = n[i + 5]; cy = n[i + 6]
        }
        prevIsC = false; prevIsQ = false; break
      }
      case 'Z': {
        if (count >= 2) point(mx, my)
        pushSub()
        cx = mx; cy = my
        prevIsC = false; prevIsQ = false; break
      }
    }
  }
  pushSub()
  return isFinite(minX) ? [minX, minY, maxX, maxY] : null
}


// Fit a circle through 3 points. Returns null if collinear or radius < 0.1mm.
function circleFrom3Pts(a: Pt2, b: Pt2, c: Pt2): { cx: number; cy: number; r: number } | null {
  const ax = b[0] - a[0], ay = b[1] - a[1]
  const bx = c[0] - a[0], by = c[1] - a[1]
  const D = 2 * (ax * by - ay * bx)
  if (Math.abs(D) < 1e-10) return null
  const ux = (by * (ax * ax + ay * ay) - ay * (bx * bx + by * by)) / D
  const uy = (ax * (bx * bx + by * by) - bx * (ax * ax + ay * ay)) / D
  const r = Math.hypot(ux, uy)
  if (r < 0.1) return null
  return { cx: a[0] + ux, cy: a[1] + uy, r }
}

export type ArcFitSeg = { x: number; y: number; arc?: { cx: number; cy: number; cw: boolean } }

// True if the G2/G3 arc (centre cx,cy, radius r, from pts[lo] to pts[hi] swept in
// the `cw` direction) stays within a small tolerance of the source polyline
// pts[lo..hi]. Samples the swept arc — using the SAME start→end sweep convention as
// the gcode emitter and sim parser — and checks each sample is near the polyline. A
// wrong sweep direction makes the arc trace the major (long-way-round) arc, whose
// samples land far from the path, so this rejects it. `v0` marches forward so the
// scan is ~O(steps + span), not O(steps·span).
function arcHugsPolyline(
  pts: Pt2[], lo: number, hi: number,
  cx: number, cy: number, r: number, cw: boolean, tol: number,
): boolean {
  const s = pts[lo], e = pts[hi]
  const a0 = Math.atan2(s[1] - cy, s[0] - cx)
  let a1 = Math.atan2(e[1] - cy, e[0] - cx)
  const isFull = Math.abs(s[0] - e[0]) < 1e-6 && Math.abs(s[1] - e[1]) < 1e-6
  if (isFull) a1 = a0 + (cw ? -2 * Math.PI : 2 * Math.PI)
  else if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
  else { if (a1 <= a0) a1 += 2 * Math.PI }

  const sweep = Math.abs(a1 - a0)
  const steps = Math.max(6, Math.ceil(sweep / (Math.PI / 45)))  // ~4° spacing
  const maxDev = Math.max(0.15, tol * 3)

  let v0 = lo
  for (let k = 1; k < steps; k++) {
    const a = a0 + (a1 - a0) * (k / steps)
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r
    let dmin = Infinity, vClosest = v0
    for (let v = v0; v < hi; v++) {
      const d = dist(px, py, pts[v][0], pts[v][1], pts[v + 1][0], pts[v + 1][1])
      if (d < dmin) { dmin = d; vClosest = v }
      else if (d > dmin + maxDev) break  // distance climbing past the local min — stop
    }
    if (dmin > maxDev) return false
    v0 = vClosest  // arc & polyline both advance lo→hi, so never look back
  }

  // Reverse check: every source vertex must also lie ON the emitted arc. The forward scan
  // alone passes trivially whenever the sweep is too SHORT — a 2° arc sits right on top of
  // the path next to its start while the other 358° of the loop go uncut.
  const aLo = Math.min(a0, a1), aHi = Math.max(a0, a1)
  const TWO_PI = 2 * Math.PI
  for (let v = lo; v <= hi; v++) {
    let a = Math.atan2(pts[v][1] - cy, pts[v][0] - cx)
    a = aLo + (((a - aLo) % TWO_PI) + TWO_PI) % TWO_PI
    const d = a <= aHi
      ? Math.abs(Math.hypot(pts[v][0] - cx, pts[v][1] - cy) - r)   // within the sweep
      : Math.min(Math.hypot(pts[v][0] - s[0], pts[v][1] - s[1]),   // past an end
                 Math.hypot(pts[v][0] - e[0], pts[v][1] - e[1]))
    if (d > maxDev) return false
  }
  return true
}

// Convert a polyline to a list of G1/G2/G3 motion endpoints.
// Arc spans where all points fit within `tol` of a circle are collapsed to a single arc segment.
// The first point of `pts` is the current position (not emitted); segments cover pts[1..n-1].
//
// `maxSpan` caps how many points a single arc may absorb. The fit re-validates the
// whole candidate span on every growth step (O(span²) per arc), so on long smooth
// runs (spiral/morph/adaptive pockets) an uncapped span makes this quadratic in the
// run length. Capping bounds the cost to O(n·maxSpan); a longer-than-cap arc is just
// emitted as a few arcs instead of one. Default Infinity keeps prior callers exact.
//
// The standard cap, shared by the gcode emitter and profile generation: 256
// bounds the quadratic re-validation while still merging genuinely long arcs
// into a handful of G2/G3 moves (bugs.md H4).
export const ARC_FIT_MAX_SPAN = 256

export function arcFitPolyline(pts: Pt2[], tol: number, maxSpan = Infinity): ArcFitSeg[] {
  const result: ArcFitSeg[] = []
  const n = pts.length
  let i = 0
  while (i < n - 1) {
    let bestJ = -1
    let bestCircle: { cx: number; cy: number; r: number } | null = null
    const jCap = Math.min(n - 1, i + maxSpan)
    for (let j = Math.min(i + 2, n - 1); j <= jCap; j++) {
      const mid = (i + j) >> 1
      const c = circleFrom3Pts(pts[i], pts[mid], pts[j])
      if (!c) break
      let ok = true
      for (let k = i + 1; k <= j; k++) {
        if (Math.abs(Math.hypot(pts[k][0] - c.cx, pts[k][1] - c.cy) - c.r) > tol) {
          ok = false
          break
        }
      }
      if (ok) { bestJ = j; bestCircle = c }
      else break
    }
    if (bestJ >= i + 3 && bestCircle) {
      const s = pts[i], e = pts[bestJ], m = pts[(i + bestJ) >> 1]
      // Sagitta = bow height from midpoint to chord.  Near-zero = effectively straight.
      const sagitta = dist(m[0], m[1], s[0], s[1], e[0], e[1])
      // Local circle from first three interior points — this approximates the true arc.
      // pts[i] must also lie on this circle; if it doesn't, pts[i] is a line endpoint
      // adjacent to the arc start (arc tangent point), not the arc start itself.
      const localC = circleFrom3Pts(pts[i + 1], pts[i + 2], pts[i + 3])
      const startOnArc = localC !== null &&
        Math.abs(Math.hypot(s[0] - localC.cx, s[1] - localC.cy) - localC.r) <= tol
      // Reject spans containing sharp corners (polygon vertices lying on circumscribed circle).
      // Real flattened arcs have tiny per-segment direction changes; polygon corners are ≥60°.
      let hasSharpCorner = false
      for (let k = i + 1; k < bestJ; k++) {
        const ax = pts[k][0] - pts[k - 1][0], ay = pts[k][1] - pts[k - 1][1]
        const bx = pts[k + 1][0] - pts[k][0], by = pts[k + 1][1] - pts[k][1]
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
        if (la < 1e-10 || lb < 1e-10) continue
        if ((ax * bx + ay * by) / (la * lb) < 0.707) { hasSharpCorner = true; break } // > 45°
      }
      // Sweep direction from the polyline's OWN travel around the fitted centre,
      // accumulated vertex by vertex. The signed area of triangle (s,m,e) only settles the
      // winding for spans under a half turn: on a near-closed ring s and e nearly coincide,
      // the triangle collapses, and a wrong flag makes the emitted arc take the 2° short way
      // round instead of the 358° path — silently dropping the whole loop.
      let sweep = 0
      let aPrev = Math.atan2(s[1] - bestCircle.cy, s[0] - bestCircle.cx)
      for (let k = i + 1; k <= bestJ; k++) {
        const a = Math.atan2(pts[k][1] - bestCircle.cy, pts[k][0] - bestCircle.cx)
        let d = a - aPrev
        if (d > Math.PI) d -= 2 * Math.PI
        else if (d < -Math.PI) d += 2 * Math.PI
        sweep += d
        aPrev = a
      }
      const cw = sweep < 0
      // Final guard: the *emitted* G2/G3 arc (start→end in the cw direction) must
      // actually hug the source polyline. The checks above only prove the vertices
      // sit on the fitted circle — they don't catch a wrong sweep direction, which
      // makes the controller/sim trace the major arc and bulge far outside the path
      // (most common on near-straight spans where the 3-point winding is ambiguous).
      if (sagitta > 0.05 && startOnArc && !hasSharpCorner &&
          arcHugsPolyline(pts, i, bestJ, bestCircle.cx, bestCircle.cy, bestCircle.r, cw, tol)) {
        result.push({ x: e[0], y: e[1], arc: { cx: bestCircle.cx, cy: bestCircle.cy, cw } })
        i = bestJ
      } else {
        result.push({ x: pts[i + 1][0], y: pts[i + 1][1] })
        i++
      }
    } else {
      result.push({ x: pts[i + 1][0], y: pts[i + 1][1] })
      i++
    }
  }
  return result
}

// Iterative Ramer-Douglas-Peucker simplification.
// Reduces a dense polyline to the minimum set of points that deviate no more
// than `tol` from the original curve. Runs in O(n log n) average.
export function douglasPeucker(pts: Pt2[], tol: number): Pt2[] {
  const n = pts.length
  if (n <= 2) return [...pts]
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!
    if (hi <= lo + 1) continue
    const ax = pts[lo][0], ay = pts[lo][1], bx = pts[hi][0], by = pts[hi][1]
    let maxD = 0, split = lo
    for (let i = lo + 1; i < hi; i++) {
      const d = dist(pts[i][0], pts[i][1], ax, ay, bx, by)
      if (d > maxD) { maxD = d; split = i }
    }
    if (maxD > tol) {
      keep[split] = 1
      stack.push([lo, split], [split, hi])
    }
  }
  return pts.filter((_, i) => keep[i])
}


// Compute signed area via shoelace (positive = CCW in Y-up system)
export function signedArea(pts: Pt2[]): number {
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return area / 2
}

// Rotate a closed polyline so the point nearest (x, y) becomes first.
export function rotatePolylineNear(pts: Pt2[], x: number, y: number): Pt2[] {
  let best = 0, bestDist = Infinity
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i][0] - x) ** 2 + (pts[i][1] - y) ** 2
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best === 0 ? pts : [...pts.slice(best), ...pts.slice(0, best)]
}

// Ensure polygon has the requested winding. Returns input unchanged or reversed.
export function ensureWinding(pts: Pt2[], wantCCW: boolean): Pt2[] {
  const isCCW = signedArea(pts) >= 0
  return isCCW === wantCCW ? pts : [...pts].reverse()
}

// ─── Self-intersection splitting ──────────────────────────────────────────────
// Used by VCarve, Profile, and Pocket to decompose self-touching or self-crossing
// polygons (e.g. letter K, figure-8) into simple loops before passing to JSPoly
// or Clipper2, both of which expect non-self-intersecting input.

export function sharesVertex(a: Pt2[], b: Pt2[], tol = 0.01): boolean {
  for (const pa of a) {
    for (const pb of b) {
      if (Math.abs(pa[0] - pb[0]) < tol && Math.abs(pa[1] - pb[1]) < tol) return true
    }
  }
  return false
}

function splitSelfTouching(pts: Pt2[], tol = 0.01): Pt2[][] {
  const n = pts.length
  const checkLen = (n > 1 &&
    Math.abs(pts[0][0] - pts[n-1][0]) < tol &&
    Math.abs(pts[0][1] - pts[n-1][1]) < tol) ? n - 1 : n
  if (checkLen < 3) return [pts]

  // Small loops (incl. the leaves of a deep split recursion): plain scan —
  // the grid build costs more than it saves below ~a hundred points.
  if (checkLen < 128) {
    for (let i = 0; i < checkLen - 2; i++) {
      for (let j = i + 2; j < checkLen; j++) {
        if (Math.abs(pts[i][0] - pts[j][0]) < tol && Math.abs(pts[i][1] - pts[j][1]) < tol) {
          const loop1 = pts.slice(i, j + 1)
          const loop2 = [...pts.slice(j, checkLen), ...pts.slice(0, i + 1)]
          return [...splitSelfTouching(loop1, tol), ...splitSelfTouching(loop2, tol)]
        }
      }
    }
    return [pts]
  }

  // Uniform tol-sized grid over the vertices so each i only tests vertices in
  // its 3×3 cell neighborhood — the all-pairs scan was O(n²) per subpath per
  // generation even with no coincident vertices at all (bugs.md H3). Taking
  // the smallest qualifying j for the smallest i preserves the original
  // nested-loop pair order exactly, so the recursion (and every toolpath
  // built from it) is unchanged.
  const grid = new Map<string, number[]>()
  for (let j = 0; j < checkLen; j++) {
    const key = `${Math.floor(pts[j][0] / tol)}|${Math.floor(pts[j][1] / tol)}`
    const list = grid.get(key)
    if (list) list.push(j); else grid.set(key, [j])
  }
  for (let i = 0; i < checkLen - 2; i++) {
    const cx = Math.floor(pts[i][0] / tol)
    const cy = Math.floor(pts[i][1] / tol)
    let bestJ = -1
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(`${cx + dx}|${cy + dy}`)
        if (!list) continue
        for (const j of list) {
          if (j < i + 2 || (bestJ !== -1 && j >= bestJ)) continue
          if (Math.abs(pts[i][0] - pts[j][0]) < tol && Math.abs(pts[i][1] - pts[j][1]) < tol) bestJ = j
        }
      }
    }
    if (bestJ !== -1) {
      const loop1 = pts.slice(i, bestJ + 1)
      const loop2 = [...pts.slice(bestJ, checkLen), ...pts.slice(0, i + 1)]
      return [...splitSelfTouching(loop1, tol), ...splitSelfTouching(loop2, tol)]
    }
  }
  return [pts]
}

function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): Pt2 | null {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
  if (Math.abs(denom) < 1e-10) return null
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom
  const s = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom
  if (t <= 1e-9 || t >= 1 - 1e-9 || s <= 1e-9 || s >= 1 - 1e-9) return null
  return [ax + t * (bx - ax), ay + t * (by - ay)]
}

function splitAtIntersections(pts: Pt2[], tol = 0.01): Pt2[][] {
  const n = pts.length
  const isClosedDup = n > 1 &&
    Math.abs(pts[0][0] - pts[n-1][0]) < tol &&
    Math.abs(pts[0][1] - pts[n-1][1]) < tol
  const poly = isClosedDup ? pts.slice(0, -1) : pts
  const m = poly.length
  if (m < 4) return [pts]

  // Small loops (incl. the leaves of a deep split recursion): plain scan —
  // the bbox/grid build costs more than it saves below ~a hundred segments.
  if (m < 128) {
    for (let i = 0; i < m; i++) {
      const i1 = (i + 1) % m
      for (let j = i + 2; j < m; j++) {
        const j1 = (j + 1) % m
        if (j1 === i) continue
        const X = segIntersect(
          poly[i][0], poly[i][1], poly[i1][0], poly[i1][1],
          poly[j][0], poly[j][1], poly[j1][0], poly[j1][1],
        )
        if (!X) continue
        const loop1: Pt2[] = [X, ...poly.slice(i1, j + 1), X]
        const loop2: Pt2[] = [...poly.slice(0, i1), X, ...(j1 > 0 ? poly.slice(j1) : []), poly[0]]
        return [...splitAtIntersections(loop1, tol), ...splitAtIntersections(loop2, tol)]
      }
    }
    return [pts]
  }

  // Per-segment bboxes + a uniform grid over them: only pairs whose bboxes
  // share a cell reach segIntersect. The all-pairs scan was O(n²) — millions
  // of segIntersect calls per generation on a smooth 0.05-tolerance boundary
  // with no self-intersections at all (bugs.md H3). Candidates are tested in
  // ascending j for ascending i, matching the original nested-loop order, so
  // the first intersection found — and the whole recursion — is identical.
  const minXs = new Float64Array(m), maxXs = new Float64Array(m)
  const minYs = new Float64Array(m), maxYs = new Float64Array(m)
  let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity
  for (let i = 0; i < m; i++) {
    const i1 = (i + 1) % m
    minXs[i] = Math.min(poly[i][0], poly[i1][0]); maxXs[i] = Math.max(poly[i][0], poly[i1][0])
    minYs[i] = Math.min(poly[i][1], poly[i1][1]); maxYs[i] = Math.max(poly[i][1], poly[i1][1])
    if (minXs[i] < gMinX) gMinX = minXs[i]; if (maxXs[i] > gMaxX) gMaxX = maxXs[i]
    if (minYs[i] < gMinY) gMinY = minYs[i]; if (maxYs[i] > gMaxY) gMaxY = maxYs[i]
  }
  const cell = Math.max(gMaxX - gMinX, gMaxY - gMinY, 1e-9) / 64
  const cellRange = (i: number): [number, number, number, number] => [
    Math.floor((minXs[i] - gMinX) / cell), Math.floor((maxXs[i] - gMinX) / cell),
    Math.floor((minYs[i] - gMinY) / cell), Math.floor((maxYs[i] - gMinY) / cell),
  ]
  const grid = new Map<number, number[]>()
  for (let i = 0; i < m; i++) {
    const [cx0, cx1, cy0, cy1] = cellRange(i)
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = cx * 128 + cy
        const list = grid.get(key)
        if (list) list.push(i); else grid.set(key, [i])
      }
    }
  }

  const candidates: number[] = []
  const seen = new Uint8Array(m)
  for (let i = 0; i < m; i++) {
    const i1 = (i + 1) % m
    candidates.length = 0
    const [cx0, cx1, cy0, cy1] = cellRange(i)
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const list = grid.get(cx * 128 + cy)
        if (!list) continue
        for (const j of list) {
          if (j < i + 2 || (j + 1) % m === i || seen[j]) continue
          if (minXs[j] > maxXs[i] || maxXs[j] < minXs[i] ||
              minYs[j] > maxYs[i] || maxYs[j] < minYs[i]) continue
          seen[j] = 1
          candidates.push(j)
        }
      }
    }
    candidates.sort((a, b) => a - b)
    for (const j of candidates) seen[j] = 0
    for (const j of candidates) {
      const j1 = (j + 1) % m
      const X = segIntersect(
        poly[i][0], poly[i][1], poly[i1][0], poly[i1][1],
        poly[j][0], poly[j][1], poly[j1][0], poly[j1][1],
      )
      if (!X) continue
      const loop1: Pt2[] = [X, ...poly.slice(i1, j + 1), X]
      const loop2: Pt2[] = [...poly.slice(0, i1), X, ...(j1 > 0 ? poly.slice(j1) : []), poly[0]]
      return [...splitAtIntersections(loop1, tol), ...splitAtIntersections(loop2, tol)]
    }
  }
  return [pts]
}

// Convenience: split any self-touching or self-crossing subpaths into simple loops.
/**
 * Does this subpath draw a STROKE rather than a region — i.e. do its ends fail to meet?
 *
 * The distinction matters because `splitSelfIntersecting` treats every subpath as
 * implicitly closed: hand it a U and it returns the U joined mouth-to-mouth, which is a
 * perfectly good ring of the wrong shape. Anything that clears or carries an AREA has to
 * ask this first, or it silently machines something the user did not draw.
 *
 * A subpath of under two points draws nothing at all and counts as open — it cannot be
 * followed as a stroke either.
 */
export function isOpenSubpath(sp: Pt2[]): boolean {
  return sp.length < 2 ||
    Math.hypot(sp[sp.length - 1][0] - sp[0][0], sp[sp.length - 1][1] - sp[0][1]) >= 1e-6
}

/**
 * Refuse a path that does not bound a region, and say what to do about it.
 *
 * Everything that CLEARS or CARRIES an area — pocket, v-carve, trochoidal, inlay —
 * runs its input through `splitSelfIntersecting`, which closes every subpath
 * implicitly. So an open path is not rejected downstream, it is quietly closed off and
 * machined: a U-shaped path pocketed as a filled square, with no error and a toolpath
 * that looks entirely reasonable on the canvas. This is the only point at which a
 * stroke and a region can still be told apart, so each of those entry points asks here
 * first.
 *
 * Subpaths of under two points draw nothing and are ignored — a stray moveto in an
 * imported file is not something to fail a job over.
 *
 * `cut` names the operation ("a pocket"), `remedy` says what to do, and `noun` names
 * the offender when it is not the main path ("Island path").
 */
export function requireClosedSubpaths(
  subpaths: Pt2[][],
  opts: { cut: string; remedy: string; noun?: string },
): void {
  const drawn = subpaths.filter((sp) => sp.length >= 2)
  const open = drawn.filter(isOpenSubpath)
  if (open.length === 0) return
  const noun = opts.noun ?? 'Path'
  throw new Error(open.length === drawn.length
    ? `${noun} is open — ${opts.cut} needs a closed shape. ${opts.remedy}`
    : `${noun} has ${open.length} of ${drawn.length} subpaths open — ${opts.cut} needs closed `
      + `shapes, and an open one is closed off as though its ends were joined. ${opts.remedy}`)
}

export function splitSelfIntersecting(subpaths: Pt2[][]): Pt2[][] {
  return subpaths
    .filter(s => s.length >= 3)
    .flatMap(s => splitSelfTouching(s))
    .filter(s => s.length >= 3)
    .flatMap(s => splitAtIntersections(s))
    .filter(s => s.length >= 3)
}

