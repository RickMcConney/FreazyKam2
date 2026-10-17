// The 3D sim's tool indicator: a turned solid with real flutes cut into it.
//
// The cutting end is NOT assembled from per-type primitives. Its outline is the tool's own
// profile — `toolProfileHeightMM`, the function the carve and the CAM read — sampled from
// the tip out to the widest cutting radius and turned about the axis, so a V-bit, a taper,
// a ball, a bull nose and an end mill all come from one path and the tool on screen is the
// shape that cut the stock. Flutes are then cut INTO that surface: each vertex's radius is
// pulled in by a gully profile that twists up the tool, so the silhouette shows them, light
// catches the cutting edges, and the spindle spin reads as a turning tool rather than a
// stripe sliding round a cylinder. (Adapted from cnc-gcode-tools' stock-sim.js, MIT.)
//
// Three.js space: tip at Y=0, the tool extending up +Y. A point at angle φ sits at
// (r·cosφ, h, −r·sinφ), so φ increasing is CCW seen from above — the same sense as a
// positive rotation about +Y.
import * as THREE from 'three'
import type { Tool, ToolType } from '../store/toolStore'
import { toolProfileHeightMM, vProfileHeightMM, type FluteHelix } from '../cam/geom'

// Helix angle of spiral flutes. Which way they twist is the bit's FluteHelix (read from its
// name): an UPCUT is right-handed — a flute climbs CCW seen from above, so under M3 (CW) it
// appears to travel UP the tool, carrying chips out; a DOWNCUT is the mirror image and its
// flutes run down into the work; a COMPRESSION bit is upcut for a short length at the tip
// and downcut above it, so its flutes form a chevron that pinches both faces of a sheet.
// A V-bit's flutes are always straight.
const HELIX_DEG = 30
// Gully depth as a fraction of the local radius, and where the land stops and the gully
// starts on the cos() wave — wide gullies between narrow lands with a crisp edge.
const GULLY_DEPTH = 0.42
const LAND_LO = 0.2, LAND_W = 0.55
const SIDES = 96
const STEEL = new THREE.Color(0xb9bec4)
const GULLY = new THREE.Color(0x2a6ea0) // same blue as the src/icons/*.svg flute outlines

// The sim's tool parameters as the library Tool the profile functions take. `diamMM` is
// the WIDEST cutting diameter (the sim's one meaning for a tool diameter), so a taper's
// usable length is worked back from it. A drill's profile there is flat (it plunges, and
// the carve treats it so); drawn, it gets its real 118° point.
function profileTool(type: string, diamMM: number, angleDeg: number, tipDiaMM: number, cornerMM: number): Tool {
  const r = diamMM / 2
  const base = { id: '', name: '', fluteCount: 2, rpm: 0, xyFeedMmMin: 0, zFeedMmMin: 0, maxDepthMM: 0 }
  let t: ToolType = 'endmill'
  let extra: Partial<Tool> = {}
  if (type === 'taper' && tipDiaMM > 0) {
    const tan = Math.tan((angleDeg / 2) * Math.PI / 180)
    t = 'taper'
    extra = { diameterMM: tipDiaMM, vbitAngleDeg: angleDeg / 2, maxDepthMM: vProfileHeightMM(r, tan, tipDiaMM / 2) }
  } else if (type === 'vbit' || type === 'drill') {
    t = 'vbit'
    extra = { vbitAngleDeg: type === 'drill' ? 118 : angleDeg }
  } else if (type === 'ball' || type === 'ballnose') {
    t = 'ballnose'
  } else if (type === 'bull' || type === 'bullnose') {
    t = 'bullnose'
    extra = { cornerRadiusMM: cornerMM }
  }
  return { ...base, type: t, diameterMM: diamMM, ...extra }
}

// The cutting end's outline as (radius, height) pairs from the tip up: the profile from the
// axis out to `r`, resampled evenly by arc length (a ball's rim is near vertical, so even
// steps in radius would leave it faceted), then — when the flutes run past the point the
// profile reaches full width — a separate straight wall. Two pieces, so the edge between a
// flat end and its wall stays sharp.
export function cutterOutline(tool: Tool, r: number, fluteTop: number): { tip: [number, number][]; wall: [number, number][] } {
  const N = 400
  const dense: [number, number][] = []
  for (let i = 0; i <= N; i++) {
    const d = r * i / N
    dense.push([d, toolProfileHeightMM(tool, d)])
  }
  const cum = [0]
  for (let i = 1; i <= N; i++) {
    cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]))
  }
  const flatEnd = dense[N][1] < 1e-9
  const rows = flatEnd ? 6 : 40
  const tip: [number, number][] = []
  for (let k = 0, i = 0; k <= rows; k++) {
    const s = cum[N] * k / rows
    while (i < N - 1 && cum[i + 1] < s) i++
    const span = cum[i + 1] - cum[i]
    const f = span > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / span)) : 0
    tip.push([dense[i][0] + (dense[i + 1][0] - dense[i][0]) * f, dense[i][1] + (dense[i + 1][1] - dense[i][1]) * f])
  }
  const edgeTop = dense[N][1]
  const wall: [number, number][] = []
  if (fluteTop > edgeTop + 1e-6) {
    // Rows close enough together that the helix reads as a smooth twist.
    const n = Math.max(16, Math.min(160, Math.ceil((fluteTop - edgeTop) / (r * 0.12))))
    for (let k = 0; k <= n; k++) wall.push([r, edgeTop + (fluteTop - edgeTop) * k / n])
  }
  return { tip, wall }
}

// One turned piece of the outline as an indexed grid with the flutes cut in. The columns
// wrap (no duplicated seam column), so computeVertexNormals shades it seamlessly.
function flutedGeometry(
  outline: [number, number][], flutes: number, phase: (h: number) => number, fluteTop: number, runout: number,
): THREE.BufferGeometry {
  const rows = outline.length
  const pos = new Float32Array(rows * SIDES * 3)
  const col = new Float32Array(rows * SIDES * 3)
  const c = new THREE.Color()
  for (let i = 0; i < rows; i++) {
    const [rad, h] = outline[i]
    const fade = Math.min(1, Math.max(0, (fluteTop - h) / runout))
    const lead = phase(h)
    for (let s = 0; s < SIDES; s++) {
      const phi = s / SIDES * 2 * Math.PI
      const w = 0.5 + 0.5 * Math.cos(flutes * (phi - lead))
      const u = Math.min(1, Math.max(0, (w - LAND_LO) / LAND_W))
      const g = fade * u * u * (3 - 2 * u)
      const rr = rad * (1 - GULLY_DEPTH * g)
      const k = (i * SIDES + s) * 3
      pos[k] = rr * Math.cos(phi)
      pos[k + 1] = h
      pos[k + 2] = -rr * Math.sin(phi)
      c.copy(STEEL).lerp(GULLY, g)
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b
    }
  }
  const index: number[] = []
  for (let i = 0; i + 1 < rows; i++) {
    for (let s = 0; s < SIDES; s++) {
      const a = i * SIDES + s, b = i * SIDES + (s + 1) % SIDES
      const a2 = a + SIDES, b2 = b + SIDES
      // Wound CCW seen from outside (φ runs CCW from above, rows run up).
      index.push(a, b, b2, a, b2, a2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(index)
  geo.computeVertexNormals()
  return geo
}

// The angle a flute's crest has turned through at height h above the tip.
function flutePhase(helix: FluteHelix, twist: number, upcutLen: number): (h: number) => number {
  switch (helix) {
    case 'straight': return () => 0
    case 'down': return h => -h * twist
    // Turns back at the join, so each flute runs on unbroken from upcut into downcut.
    case 'compression': return h => (h <= upcutLen ? h : 2 * upcutLen - h) * twist
    default: return h => h * twist
  }
}

// Builds a tool indicator group, tip at Y=0, extending up +Y: the fluted cutting end (see
// the header), then a polished steel shank (small tools get a standard ~3.2mm shank) topped
// with a dark collet nut. A taper is drawn from its WIDEST cutting diameter down to its tip
// ball; `diamMM` carries that widest diameter and `tipDiaMM` the ball.
export function buildToolMesh(type: string, diamMM: number, vbitAngleDeg = 60, fluteCount = 2, tipDiaMM = 0, cornerMM = 0, helix: FluteHelix = 'up'): THREE.Object3D {
  const r = Math.max(0.05, diamMM / 2)
  const isV = type === 'vbit' || type === 'taper'
  // Real-world shank sizing: never thinner than ~3.2mm; V-bits step down from a wide
  // cutting diameter to a narrower shank (capped at 80% of the cutting radius so the cone
  // rim always shows).
  const shankR = isV ? Math.max(Math.min(r * 0.8, 3.175), 1.6) : Math.max(r, 1.6)
  const shankH = Math.max(diamMM * 2.5, 12)
  const SEGS = 32

  const opts = { transparent: true, opacity: 0.9 }
  const fluteMat  = new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x555555, shininess: 60, ...opts })
  const shankMat  = new THREE.MeshPhongMaterial({ color: 0xd4d7db, specular: 0x777777, shininess: 90, ...opts })
  const colletMat = new THREE.MeshPhongMaterial({ color: 0x3a3d42, specular: 0x444444, shininess: 70, ...opts })

  const group = new THREE.Group()

  // A V-cutter's flutes end where its cone reaches full width; everything else gets a
  // flute length in proportion (the G-code carries no cutting length).
  const tool = profileTool(type, diamMM, vbitAngleDeg, tipDiaMM, cornerMM)
  const edgeTop = toolProfileHeightMM(tool, r)
  const fluteTop = isV ? edgeTop : Math.max(diamMM * 3, 6, edgeTop)
  const { tip, wall } = cutterOutline(tool, r, fluteTop)
  const flutes = Math.max(1, Math.round(fluteCount) || 2)
  const twist = Math.tan(HELIX_DEG * Math.PI / 180) / r
  // A compression bit's upcut section is short — about one diameter — so it lifts only the
  // bottom face of the sheet; the rest of the flute presses the top face down.
  const upcutLen = Math.max(2, Math.min(diamMM, fluteTop * 0.4))
  const phase = flutePhase(type === 'vbit' ? 'straight' : helix, twist, upcutLen)
  const runout = Math.min(r * 1.5, fluteTop * 0.3)
  for (const piece of [tip, wall]) {
    if (piece.length >= 2) group.add(new THREE.Mesh(flutedGeometry(piece, flutes, phase, fluteTop, runout), fluteMat))
  }
  let y = fluteTop

  // 45° chamfer easing a V-cutter's cone base into its narrower shank — or, for a small
  // bit on a standard shank, from the flutes up to it — instead of a step.
  if (Math.abs(shankR - r) > 0.01) {
    const chamferH = shankR < r ? r - shankR : Math.min(shankR - r, shankH * 0.3)
    const chamferGeo = new THREE.CylinderGeometry(shankR, r, chamferH, SEGS)
    chamferGeo.translate(0, y + chamferH / 2, 0)
    group.add(new THREE.Mesh(chamferGeo, shankMat))
    y += chamferH
  }
  const shankGeo = new THREE.CylinderGeometry(shankR, shankR, shankH, SEGS)
  shankGeo.translate(0, y + shankH / 2, 0)
  group.add(new THREE.Mesh(shankGeo, shankMat))
  y += shankH

  const colletR = shankR * 1.4
  const colletH = Math.max(diamMM * 0.8, 5)
  // Chamfered bottom: truncated cone from shank radius up to full collet radius, then the
  // cylindrical body above it.
  const colletChamferH = colletH * 0.4
  const colletChamferGeo = new THREE.CylinderGeometry(colletR, shankR, colletChamferH, SEGS)
  colletChamferGeo.translate(0, y + colletChamferH / 2, 0)
  group.add(new THREE.Mesh(colletChamferGeo, colletMat))
  const colletBodyH = colletH - colletChamferH
  const colletGeo = new THREE.CylinderGeometry(colletR, colletR, colletBodyH, SEGS)
  colletGeo.translate(0, y + colletChamferH + colletBodyH / 2, 0)
  group.add(new THREE.Mesh(colletGeo, colletMat))

  return group
}
