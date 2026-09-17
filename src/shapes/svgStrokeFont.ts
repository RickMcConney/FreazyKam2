// Single-line fonts shipped in the SVG-font format (e.g. Relief SingleLine, OFL).
//
// Unlike the single-line *TTF* (which encodes each stroke as a degenerate
// out-and-back contour — fine to display but cuts every stroke twice), the SVG
// font stores true single-pass open strokes. We parse it into the same
// opentype.js-compatible shim the rest of the text pipeline consumes, so it flows
// through generateTextD / FontSelect with no special-casing.
//
// Glyph `d` strings use relative + curve commands in y-up font space. We normalise
// them to absolute with parseD/stringifyD and flatten curves to polylines with
// flattenPath, emitting open M/L strokes (which is what engraving wants).

import { parseD, stringifyD } from '../importers/svgImporter'
import { flattenPath, type Pt2 } from '../cam/pathFlattener'

// Chord tolerance for flattening glyph curves, in font units (em = 1000). At a 10mm
// cap that's ~0.007mm; at 100mm ~0.07mm — smooth across the useful size range.
const FLATTEN_TOL = 0.5

interface SvgGlyph { advance: number; polylines: Pt2[][] }  // font units, y-up

interface PathCommand { type: 'M' | 'L'; x: number; y: number }

class StrokePath {
  commands: PathCommand[] = []
  getBoundingBox() {
    if (this.commands.length === 0) return { x1: 0, y1: 0, x2: 0, y2: 0 }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const c of this.commands) {
      if (c.x < x1) x1 = c.x; if (c.x > x2) x2 = c.x
      if (c.y < y1) y1 = c.y; if (c.y > y2) y2 = c.y
    }
    return { x1, y1, x2, y2 }
  }
  toPathData(precision = 2) {
    const r = (n: number) => +n.toFixed(precision)
    return this.commands.map((c) => `${c.type}${r(c.x)} ${r(c.y)}`).join('')
  }
}

export interface SvgStrokeShimFont {
  unitsPerEm: number
  ascender: number
  descender: number
  tables: { os2: { sCapHeight: number } }
  getPath(text: string, x: number, y: number, fontSize: number): StrokePath
}

function num(s: string | null, fallback: number): number {
  const v = s == null ? NaN : parseFloat(s)
  return Number.isFinite(v) ? v : fallback
}

function buildShim(doc: Document): SvgStrokeShimFont {
  const face = doc.querySelector('font-face')
  const fontEl = doc.querySelector('font')
  const upem = num(face?.getAttribute('units-per-em') ?? null, 1000)
  const cap = num(face?.getAttribute('cap-height') ?? null, upem * 0.7)
  const desc = num(face?.getAttribute('descent') ?? null, -upem * 0.2)
  const defaultAdv = num(fontEl?.getAttribute('horiz-adv-x') ?? null, upem)
  let spaceAdv = defaultAdv

  const glyphs = new Map<string, SvgGlyph>()
  doc.querySelectorAll('glyph').forEach((g) => {
    const u = g.getAttribute('unicode')
    if (!u || [...u].length !== 1) return  // skip ligatures / unmapped
    const advance = num(g.getAttribute('horiz-adv-x'), defaultAdv)
    if (u === ' ') { spaceAdv = advance; return }
    const rawD = g.getAttribute('d')
    if (!rawD) return
    let polylines: Pt2[][] = []
    try {
      polylines = flattenPath(stringifyD(parseD(rawD)), FLATTEN_TOL)
    } catch { polylines = [] }
    glyphs.set(u, { advance, polylines })
  })

  return {
    unitsPerEm: upem,
    ascender: cap,
    descender: desc,
    tables: { os2: { sCapHeight: cap } },
    // Matches opentype.js getPath: baseline at (px,py), scaled to fontSize, with
    // above-baseline points at NEGATIVE y (SVG fonts are y-up, so we negate).
    getPath(text: string, px: number, py: number, fontSize: number): StrokePath {
      const scale = fontSize / upem
      const path = new StrokePath()
      let penX = 0
      for (const ch of text) {
        if (ch === '\n') continue
        if (ch === ' ') { penX += spaceAdv; continue }
        const g = glyphs.get(ch)
        if (!g) { penX += spaceAdv; continue }
        for (const pl of g.polylines) {
          for (let i = 0; i < pl.length; i++) {
            path.commands.push({
              type: i === 0 ? 'M' : 'L',
              x: px + (penX + pl[i][0]) * scale,
              y: py - pl[i][1] * scale,
            })
          }
        }
        penX += g.advance
      }
      return path
    },
  }
}

// ── Loading / caching ─────────────────────────────────────────────────────────

const cache = new Map<string, SvgStrokeShimFont>()
const promises = new Map<string, Promise<SvgStrokeShimFont | null>>()

export async function loadSvgStrokeShim(url: string): Promise<SvgStrokeShimFont | null> {
  const cached = cache.get(url)
  if (cached) return cached
  const pending = promises.get(url)
  if (pending) return pending

  const p = (async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml')
    const shim = buildShim(doc)
    cache.set(url, shim)
    return shim
  })().catch((err) => { promises.delete(url); throw err })

  promises.set(url, p)
  return p
}
