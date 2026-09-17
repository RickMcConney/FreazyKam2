import * as THREE from 'three'
import type { Material } from '../store/workpieceStore'
import { MATERIAL_COLORS } from '../colors'

// ─── Stock textures ────────────────────────────────────────────────────────
//
// Wood materials and the two metals use real CC0 photo textures bundled in
// public/textures/wood/ (sources in the README there — Poly Haven + ambientCG,
// all seamless 1K tiles, grain and brush lines running along +X, which is the
// convention every mapping below assumes). MDF, plastics and "other" get a
// small procedurally generated tile: speckle for MDF, subtle brushed/flat noise
// for the rest, tinted from MATERIAL_COLORS so they match the 2D renderer.
//
// Everything that maps these textures uses planar world-mm UVs (u = localX,
// v = localY on faces; u = along-edge, v = height on walls) divided by the
// material's tile size, so grain scale is physical and continuous across the
// heightfield surface, the apron, and the walls.
//
// Photo textures load asynchronously: the texture starts as a flat tile of the
// material's base color and swaps to the loaded image in place. ThreeView's
// render loop is render-on-demand, so it registers a listener to repaint when
// a load lands.

// World size (mm) one texture tile covers, when nothing better is known — used
// by the procedural tiles, whose noise has no physical size of its own.
export const DEFAULT_TILE_MM = 128

// World size (mm) of the real area each photo tile covers, so grain renders
// life-sized. Taken from the source library's published dimensions where they
// exist; the rest are estimates and marked as such. Two numbers because the
// sample is not always square — Wood095 is a 2:1 image of a 2:1 area, and
// mapping it over a square patch of stock would stretch the figure.
//
// These are much larger than DEFAULT_TILE_MM, so a photo tile spread over a
// small workpiece is magnified: texel density runs 0.4–2 px/mm against the
// 8 px/mm the old 128 mm mapping gave. That is the honest cost of correct
// scale at 1K, and the fix if it reads soft is a higher-resolution source, not
// a smaller tile.
const TILE_MM: Partial<Record<Material, [number, number]>> = {
  pine:     [800, 800],    // ambientCG: 80 × 80 cm
  oak:      [1830, 1830],  // Poly Haven: 1830 mm
  walnut:   [2000, 1938],  // Poly Haven: 2000 mm, less the de-seamed strip (see README)
  cherry:   [2430, 2430],  // Poly Haven: 2430 mm
  plywood:  [500, 500],    // Poly Haven: 500 mm
  cedar:    [800, 800],    // estimated — ambientCG publishes no size for Wood030
  maple:    [800, 400],    // estimated — Wood095 likewise; image is 2:1, so area is
  aluminum: [400, 400],    // estimated — a brushed lay has no meaningful true size
  brass:    [400, 400],
}

// Physical (u, v) extent in mm of one tile of this material's texture.
export function woodTileMM(m: Material): [number, number] {
  return TILE_MM[m] ?? [DEFAULT_TILE_MM, DEFAULT_TILE_MM]
}

// Photo texture per material; absent = procedural.
const WOOD_FILES: Partial<Record<Material, string>> = {
  pine:     'pine.jpg',      // ambientCG Wood092
  cedar:    'cedar.jpg',     // ambientCG Wood030
  oak:      'oak.jpg',       // Poly Haven oak_veneer_01
  maple:    'maple.jpg',     // ambientCG Wood095
  walnut:   'walnut.jpg',    // Poly Haven dark_wood
  cherry:   'cherry.jpg',    // Poly Haven rosewood_veneer1
  plywood:  'plywood.jpg',   // Poly Haven plywood
  aluminum: 'brushed-metal.jpg',  // ambientCG Metal009, recolored below
  brass:    'brushed-metal.jpg',  // same tile, different tint
}

// Procedural finish for materials without a photo texture.
const PROCEDURAL: Record<string, { kind: 'speckle' } | { kind: 'flat'; streak: number }> = {
  mdf:   { kind: 'speckle' },
  hdpe:  { kind: 'flat', streak: 0.015 },
  other: { kind: 'flat', streak: 0.015 },
}

// Materials whose photo tile is recolored to their MATERIAL_COLORS hue on load.
// Brushed aluminum and brass differ in color and reflectance, not in surface
// structure — same abrasive, same lay — so one brushed-metal photo drives both,
// and they come out as a matched pair in a way two unrelated photos never would.
const TINTED: Partial<Record<Material, true>> = { aluminum: true, brass: true }

let onTextureLoaded: (() => void) | null = null

// ThreeView registers a repaint trigger here (render-on-demand loop).
export function setWoodTextureListener(cb: (() => void) | null) {
  onTextureLoaded = cb
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Tileable 2D noise as a sum of cosines with integer frequencies (periodic by
// construction). Returns a row evaluator: fills `out[i]` with the value at
// (i/N, y01), normalized to ~unit RMS.
function makeNoiseRows(
  rng: () => number,
  count: number,
  fxMax: number, fyMin: number, fyMax: number,
  N: number,
): (y01: number, out: Float32Array) => void {
  const comps: { fy: number; phase: number; amp: number; cosA: Float32Array; sinA: Float32Array }[] = []
  let sq = 0
  for (let k = 0; k < count; k++) {
    const fx = Math.round(rng() * fxMax)
    const fy = fyMin + Math.round(rng() * (fyMax - fyMin))
    const amp = 1 / (1 + 0.1 * (fx + fy))
    sq += amp * amp / 2
    const cosA = new Float32Array(N)
    const sinA = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * fx * i) / N
      cosA[i] = Math.cos(a)
      sinA[i] = Math.sin(a)
    }
    comps.push({ fy, phase: rng() * Math.PI * 2, amp, cosA, sinA })
  }
  const inv = 1 / Math.sqrt(sq)
  return (y01, out) => {
    out.fill(0)
    for (const c of comps) {
      const b = 2 * Math.PI * c.fy * y01 + c.phase
      const cB = c.amp * Math.cos(b)
      const sB = c.amp * Math.sin(b)
      for (let i = 0; i < N; i++) out[i] += c.cosA[i] * cB - c.sinA[i] * sB
    }
    for (let i = 0; i < N; i++) out[i] *= inv
  }
}

// Recolor a loaded photo tile to the material's own hue, keeping its texture.
// Luminance is normalized against the tile's own mean before it multiplies the
// base color, so the brush marks survive at full strength and the average lands
// exactly on MATERIAL_COLORS — the same relationship the procedural tiles have,
// which is what keeps a photo material and a procedural one looking related.
// The tile is same-origin, so the canvas is never tainted.
function tintToMaterial(img: HTMLImageElement, m: Material): HTMLCanvasElement {
  const base = MATERIAL_COLORS[m].three
  const br = (base >> 16) & 255
  const bg = (base >> 8) & 255
  const bb = base & 255

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = image.data
  const lum = (i: number) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += lum(i)
  const mean = sum / (d.length / 4) || 1
  for (let i = 0; i < d.length; i += 4) {
    const k = lum(i) / mean
    d[i]     = Math.min(255, br * k)
    d[i + 1] = Math.min(255, bg * k)
    d[i + 2] = Math.min(255, bb * k)
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

// Small canvas tile: flat base color, or base color + procedural finish.
function makeCanvas(m: Material, size: number, procedural: boolean): HTMLCanvasElement {
  const base = MATERIAL_COLORS[m].three
  const br = (base >> 16) & 255
  const bg = (base >> 8) & 255
  const bb = base & 255

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!

  const p = PROCEDURAL[m]
  if (!procedural || !p) {
    ctx.fillStyle = `rgb(${br},${bg},${bb})`
    ctx.fillRect(0, 0, size, size)
    return canvas
  }

  const rng = mulberry32(hashStr(m))
  const img = ctx.createImageData(size, size)
  const data = img.data
  // tone = broad variation; streak = fine brushed lines along X (low fx, high fy).
  const toneRow   = makeNoiseRows(rng, 16, 4, 1, 6, size)
  const streakRow = makeNoiseRows(rng, 20, 3, 14, 44, size)
  const tone = new Float32Array(size)
  const streak = new Float32Array(size)
  for (let j = 0; j < size; j++) {
    const y = j / size
    toneRow(y, tone)
    streakRow(y, streak)
    for (let i = 0; i < size; i++) {
      let b = p.kind === 'speckle'
        ? 1 + 0.05 * tone[i] + 0.1 * (rng() - 0.5)
        : 1 + 0.03 * tone[i] + p.streak * streak[i] + 0.02 * (rng() - 0.5)
      b = Math.max(0.7, Math.min(1.3, b))
      const k = (j * size + i) * 4
      data[k]     = Math.min(255, br * b)
      data[k + 1] = Math.min(255, bg * b)
      data[k + 2] = Math.min(255, bb * b)
      data[k + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

const cache = new Map<Material, THREE.Texture>()

// Session-cached (never disposed by consumers — shared across rebuilds).
export function getWoodTexture(m: Material): THREE.Texture {
  let tex = cache.get(m)
  if (tex) return tex

  const file = WOOD_FILES[m]
  // Photo textures start as a flat base-color tile so there's no black flash,
  // then the loaded image is swapped in place.
  tex = new THREE.Texture(makeCanvas(m, file ? 8 : 256, !file))
  tex.needsUpdate = true
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  cache.set(m, tex)

  if (file) {
    const img = new Image()
    img.onload = () => {
      tex!.image = TINTED[m] ? tintToMaterial(img, m) : img
      // The GL texture was allocated at the placeholder's size (immutable
      // storage) — dispose so the next render reallocates at the image's size
      // instead of a failing texSubImage2D upload.
      tex!.dispose()
      tex!.needsUpdate = true
      onTextureLoaded?.()
    }
    img.onerror = () => console.warn(`[woodTexture] failed to load ${img.src}`)
    img.src = `${import.meta.env.BASE_URL}textures/wood/${file}`
  }
  return tex
}
