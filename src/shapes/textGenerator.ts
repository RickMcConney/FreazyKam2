import * as opentype from 'opentype.js'
import { loadSvgStrokeShim } from './svgStrokeFont'

export interface TextParams {
  type: 'text'
  x: number
  y: number
  text: string
  fontSize: number
  fontFamily: string
}

const BASE = import.meta.env.BASE_URL

// `svg` marks a single-stroke font in the SVG-font format (value = asset URL). It
// renders as open strokes — ideal for engraving — and flows through the same
// getPath() interface as the TTF/WOFF outline fonts loaded from `url`.
export interface FontDef { label: string; family: string; url?: string; svg?: string }

// The single-stroke face, named so anything that needs engravable text for its
// own reasons (the gear's tooth-count number) asks for it by this constant rather
// than by a string literal that can drift from the AVAILABLE_FONTS entry.
export const SINGLE_LINE_FONT_FAMILY = 'Relief SingleLine'

export const AVAILABLE_FONTS: FontDef[] = [
  { label: 'Roboto', family: 'Roboto', url: `${BASE}fonts/Roboto-Regular.ttf` },
  { label: 'AV Hershey Complex Heavy', family: 'AV Hershey Complex Heavy', url: `${BASE}fonts/AVHersheyComplexHeavy.ttf` },
  { label: 'AV Hershey Simplex Light', family: 'AV Hershey Simplex Light', url: `${BASE}fonts/AVHersheySimplexLight.ttf` },
{ label: 'Comic Sans MS', family: 'Comic Sans MS', url: `${BASE}fonts/Comic%20Sans%20MS.ttf` },
  { label: 'Courier New Bold', family: 'Courier New Bold', url: `${BASE}fonts/Courier%20New%20Bold.ttf` },
  { label: 'Times New Roman', family: 'Times New Roman', url: `${BASE}fonts/Times%20New%20Roman.ttf` },
  { label: 'Roboto Mono', family: 'Roboto Mono', url: `${BASE}fonts/roboto-mono-regular.woff` },
  { label: 'Open Sans', family: 'Open Sans', url: `${BASE}fonts/open-sans-regular.woff` },
  // Single-stroke engraving font (Relief SingleLine, OFL) — open strokes ideal for V-bit/engrave
  { label: 'Relief SingleLine (single-line)', family: SINGLE_LINE_FONT_FAMILY, svg: `${BASE}fonts/ReliefSingleLineSVG-Regular.svg` },
]

/** True for single-stroke faces (SVG-stroke) — text renders as open strokes. */
export function isSingleStrokeFont(family: string): boolean {
  return !!AVAILABLE_FONTS.find((f) => f.family === family)?.svg
}

export const DEFAULT_FONT_FAMILY = 'Roboto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fontCache = new Map<string, any>()
const fontPromises = new Map<string, Promise<void>>()

export async function loadFont(family: string): Promise<void> {
  if (fontCache.has(family)) return
  const existing = fontPromises.get(family)
  if (existing) return existing

  const def = AVAILABLE_FONTS.find((f) => f.family === family)
  if (!def) return

  const p = (async () => {
    try {
      // Single-stroke SVG-font face (e.g. Relief SingleLine).
      if (def.svg) {
        const shim = await loadSvgStrokeShim(def.svg)
        if (!shim) throw new Error(`SVG stroke font "${def.svg}" not found`)
        fontCache.set(family, shim)
        return
      }
      const res = await fetch(def.url!)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      const font = opentype.parse(buf)
      fontCache.set(family, font)
    } catch (err) {
      console.warn(`[textGenerator] Failed to load font "${family}":`, err)
    }
  })()

  fontPromises.set(family, p)
  return p
}

export function isFontLoaded(family: string): boolean {
  return fontCache.has(family)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getFont(family: string): any | null {
  return fontCache.get(family) ?? null
}

export function preloadFonts(): void {
  for (const { family } of AVAILABLE_FONTS) {
    loadFont(family)
  }
}

function f(n: number): string {
  return String(+n.toFixed(4))
}

/** Generate SVG d string from TextParams in CNC Y-up space. Returns '' if font not loaded yet. */
export function generateTextD(params: TextParams): string {
  const font = fontCache.get(params.fontFamily) ?? fontCache.get(DEFAULT_FONT_FAMILY)
  if (!font || !params.text.trim()) return ''

  // Scale so cap height (not em-square) matches params.fontSize.
  // sCapHeight is in font units; fall back to ascender if absent.
  const capHeight: number = font.tables?.os2?.sCapHeight || font.ascender
  const scaledSize = params.fontSize * (font.unitsPerEm / capHeight)

  // getPath returns path in screen Y-down coords; we flip Y for CNC Y-up
  const path = font.getPath(params.text, 0, 0, scaledSize)
  const { x: bx, y: by } = params

  const cmds: string[] = []
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case 'M':
        cmds.push(`M${f(bx + cmd.x)},${f(by - cmd.y)}`)
        break
      case 'L':
        cmds.push(`L${f(bx + cmd.x)},${f(by - cmd.y)}`)
        break
      case 'C':
        cmds.push(
          `C${f(bx + cmd.x1)},${f(by - cmd.y1)},${f(bx + cmd.x2)},${f(by - cmd.y2)},${f(bx + cmd.x)},${f(by - cmd.y)}`
        )
        break
      case 'Q':
        cmds.push(`Q${f(bx + cmd.x1)},${f(by - cmd.y1)},${f(bx + cmd.x)},${f(by - cmd.y)}`)
        break
      case 'Z':
        cmds.push('Z')
        break
    }
  }
  return cmds.join(' ')
}
