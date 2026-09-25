// Exporting paths as DXF.
//
// The sibling of `svgExport.ts`, for the CAD/CAM and laser tools that take DXF and not SVG.
// No flip is needed: DXF is Y-up in real units, exactly like CNC space, so a path at
// (120, 40) is written at (120, 40) and `$INSUNITS = 4` says those are millimetres —
// which is also what stops this app's own importer asking for units on the way back.
//
// EVERY SUBPATH IS ONE POLYLINE, AND ITS ARCS RIDE IN THE BULGES. A bulge is tan(θ/4), θ
// the arc's included angle, signed positive for counter-clockwise — the maths the
// importer's `polyToD` inverts (review2 B2). A circular arc therefore goes out EXACT; a
// bézier or an elliptical arc has no polyline form and is flattened to `CURVE_TOL_MM`.
//
// R12 POLYLINE/VERTEX, NOT LWPOLYLINE. They carry the same vertices and bulges, but an
// R12 file may be nothing more than a header and an ENTITIES section, and every reader
// takes it — AutoCAD included. An R2000 file (the first with LWPOLYLINE) is only valid
// with handles, the tables and the OBJECTS section, and AutoCAD refuses a minimal one.
// `$INSUNITS` is an R2000 variable; the R12 readers that do not know it skip it.
//
// Everything goes on layer 0: the importer reads no layers, and a CAM or laser tool
// assigns its own.

import type { ImportedPath } from '../importers/svgImporter'
import { walkPath, flattenPath } from '../cam/pathFlattener'

/** How closely a bézier or an elliptical arc is followed by the polyline standing for it, mm. */
export const CURVE_TOL_MM = 0.01

interface Vertex { x: number; y: number; bulge: number }
interface Poly { verts: Vertex[]; closed: boolean }

const EPS = 1e-9
const same = (a: { x: number; y: number }, x: number, y: number) =>
  Math.abs(a.x - x) < 1e-7 && Math.abs(a.y - y) < 1e-7

/**
 * A d-string (CNC mm, Y-up) as polylines — one per subpath, circular arcs as bulges.
 * Exported for the tests; `pathsToDxf` is the file.
 */
export function dToPolylines(d: string): Poly[] {
  const out: Poly[] = []
  let cur: Poly | null = null
  let px = 0, py = 0     // the current point

  const start = (x: number, y: number) => {
    finish()
    cur = { verts: [{ x, y, bulge: 0 }], closed: false }
  }
  const finish = () => {
    if (cur && cur.verts.length >= 2) out.push(cur)
    cur = null
  }
  // A segment from the current point to (x, y); `bulge` belongs to the vertex it STARTS at.
  const to = (x: number, y: number, bulge = 0) => {
    if (!cur) cur = { verts: [{ x: px, y: py, bulge: 0 }], closed: false }  // drawing on after a Z
    if (!same({ x: px, y: py }, x, y)) {
      cur.verts[cur.verts.length - 1].bulge = bulge
      cur.verts.push({ x, y, bulge: 0 })
    }
    px = x; py = y
  }
  // A curve with no polyline form: its flattened points, the first being the current point.
  const flat = (d1: string) => {
    const pts = flattenPath(d1, CURVE_TOL_MM)[0] ?? []
    for (let i = 1; i < pts.length; i++) to(pts[i][0], pts[i][1])
  }

  walkPath(d, {
    move(x, y) { start(x, y); px = x; py = y },
    line(x, y) { to(x, y) },
    cubic(cx, cy, x1, y1, x2, y2, x, y) { flat(`M${cx},${cy} C${x1},${y1} ${x2},${y2} ${x},${y}`) },
    quad(cx, cy, x1, y1, x, y) { flat(`M${cx},${cy} Q${x1},${y1} ${x},${y}`) },
    arc(cx, cy, rx, ry, ang, lg, sw, x, y) {
      const chord = Math.hypot(x - cx, y - cy)
      if (chord < EPS) return
      rx = Math.abs(rx); ry = Math.abs(ry)
      if (rx < EPS || ry < EPS) { to(x, y); return }  // SVG: a zero radius is a straight line
      if (Math.abs(rx - ry) > 1e-6 * Math.max(rx, ry)) {
        flat(`M${cx},${cy} A${rx},${ry},${ang},${lg},${sw},${x},${y}`)
        return
      }
      // Circular. A radius too small for the chord is scaled up to it, as SVG does,
      // so the short arc is a half turn. sweep = 1 is CCW in Y-up, which is a positive bulge.
      const half = Math.asin(Math.min(1, chord / (2 * rx)))
      const theta = lg ? 2 * Math.PI - 2 * half : 2 * half
      to(x, y, (sw ? 1 : -1) * Math.tan(theta / 4))
    },
    close(mx, my) {
      if (cur) {
        const c: Poly = cur
        // An explicit segment back to the start already drew the closing edge; drop the
        // duplicate vertex. Its predecessor keeps the bulge of that edge, which is exactly
        // the bulge a closed polyline reads for its closing segment.
        const last = c.verts[c.verts.length - 1]
        if (c.verts.length > 1 && same(last, c.verts[0].x, c.verts[0].y)) c.verts.pop()
        c.closed = true
        finish()
      }
      px = mx; py = my
    },
  })
  finish()
  return out
}

/** Numbers as a DXF file carries them: plain decimals, no exponent, no `-0`. */
function num(v: number, dp = 6): string {
  const r = +v.toFixed(dp)
  return String(r === 0 ? 0 : r)
}

/** The paths as an R12 DXF document, in millimetres, at their own CNC coordinates. */
export function pathsToDxf(paths: ImportedPath[]): string {
  const polys = paths.flatMap((p) => dToPolylines(p.d))

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const { verts } of polys) for (const v of verts) {
    x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y)
  }
  if (!isFinite(x0)) { x0 = y0 = x1 = y1 = 0 }

  // Group code / value pairs, one per line each.
  const g: string[] = []
  const pair = (code: number, value: string | number) => { g.push(String(code), String(value)) }

  pair(0, 'SECTION'); pair(2, 'HEADER')
  pair(9, '$ACADVER'); pair(1, 'AC1009')
  pair(9, '$INSUNITS'); pair(70, 4)        // millimetres
  pair(9, '$MEASUREMENT'); pair(70, 1)     // metric
  pair(9, '$EXTMIN'); pair(10, num(x0)); pair(20, num(y0)); pair(30, 0)
  pair(9, '$EXTMAX'); pair(10, num(x1)); pair(20, num(y1)); pair(30, 0)
  pair(0, 'ENDSEC')

  pair(0, 'SECTION'); pair(2, 'ENTITIES')
  for (const { verts, closed } of polys) {
    pair(0, 'POLYLINE'); pair(8, '0')
    pair(66, 1)                              // vertices follow
    pair(10, 0); pair(20, 0); pair(30, 0)
    pair(70, closed ? 1 : 0)
    for (const v of verts) {
      pair(0, 'VERTEX'); pair(8, '0')
      pair(10, num(v.x)); pair(20, num(v.y)); pair(30, 0)
      // The bulge wants more digits than a coordinate: it scales the whole arc's sagitta.
      if (Math.abs(v.bulge) > EPS) pair(42, num(v.bulge, 10))
    }
    pair(0, 'SEQEND'); pair(8, '0')
  }
  pair(0, 'ENDSEC')
  pair(0, 'EOF')
  return g.join('\n') + '\n'
}
