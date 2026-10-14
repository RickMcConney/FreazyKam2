// What the drawing's author said each path is for. A DXF puts every entity on a named
// layer, and an SVG drawn for a cutter usually codes it by stroke colour — the Charizard
// sheet carries CUT_OUTER / CUT_INNER / LABELS on its layers and red / blue / black on its
// strokes, which is exactly the outline / hole / label split the Select Only bar otherwise
// has to guess from geometry. So the importers keep it (`ImportedPath.layer`), the bar
// offers it, and the canvas draws each layer of an import in a colour of its own.

import { PATH_COLOR, LAYER_COLORS } from '../colors'
import type { ImportedPath } from './svgImporter'

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff',
  fuchsia: '#ff00ff', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', navy: '#000080', olive: '#808000', teal: '#008080',
}

/**
 * One spelling per colour, so `#F00`, `red` and `rgb(255,0,0)` are one layer. Null for
 * `none`, `transparent`, `currentColor`, a gradient (`url(...)`) or anything unreadable —
 * none of those says what a path is for.
 */
export function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw) return null
  const c = raw.trim().toLowerCase()
  if (!c || c === 'none' || c === 'transparent' || c === 'currentcolor' || c.startsWith('url(')) return null
  if (NAMED[c]) return NAMED[c]
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c)
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`
  if (/^#[0-9a-f]{6}$/.test(c)) return c
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c)
  if (m) return '#' + [m[1], m[2], m[3]].map((v) => Math.min(255, +v).toString(16).padStart(2, '0')).join('')
  return null
}

/** Does this layer tag name a colour (an SVG stroke) rather than a layer? */
export const isColorTag = (layer: string) => /^#[0-9a-f]{6}$/.test(layer)

/** WCAG relative luminance of an sRGB colour, channels 0–1. */
function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function hslToRgb(hue: number, sat: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * sat
  const x = c * (1 - Math.abs((hue % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x]
    : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x]
  return [r + m, g + m, b + m]
}

/**
 * The luminance a path is drawn at. Paths sit on the stock, which runs from near-white
 * (light theme, pale wood) to near-black (dark theme, dark wood); contrast against white is
 * 1.05 / (Y + 0.05) and against black (Y + 0.05) / 0.05, and the two meet near 0.2 — about
 * 3.5 : 1 either way.
 */
const TARGET_LUMINANCE = 0.2

/**
 * A file colour, made visible on both canvases: HUE AND SATURATION KEPT, so red stays red,
 * and the lightness set so the colour has `TARGET_LUMINANCE`. A fixed HSL lightness band
 * was tried first and is the wrong measure: at the same HSL lightness pure blue is a
 * twelfth as bright as pure green, so blue vanished on the dark canvas while green
 * vanished on the light one. Luminance is what the eye sees. Black and white come out as
 * the same mid grey.
 */
export function readableColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  const l0 = (max + min) / 2
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1))
  const hue = d === 0 ? 0
    : max === r ? ((g - b) / d + 6) % 6
    : max === g ? (b - r) / d + 2
    : (r - g) / d + 4
  // Luminance rises with lightness at a fixed hue and saturation, so bisect for it.
  let lo = 0, hi = 1
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (luminance(...hslToRgb(hue, sat, mid)) < TARGET_LUMINANCE) lo = mid; else hi = mid
  }
  return '#' + hslToRgb(hue, sat, (lo + hi) / 2)
    .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
}

/**
 * Draw each layer of one import in its own colour. Only when there are at least two — a
 * one-layer file keeps the app's ordinary path colour. The FILE'S colour wherever it has
 * one, made readable: a layer that IS a colour (an SVG stroke), or a named layer the file
 * gives a colour to (`fileColors` — a DXF's LAYER table). A button saying "Red" with a
 * blue dot beside it, or a DXF drawn in other colours than in the CAD program it came
 * from, is worse than no colour at all. A layer with no colour takes the app's palette,
 * in order of first appearance, so the same file always comes in the same colours.
 */
export function colorByLayer(paths: ImportedPath[], fileColors: ReadonlyMap<string, string> = new Map()): void {
  const order: string[] = []
  for (const p of paths) if (p.layer !== undefined && !order.includes(p.layer)) order.push(p.layer)
  if (order.length < 2) return
  const own = (l: string) => (isColorTag(l) ? l : fileColors.get(l))
  const uncoloured = order.filter((l) => !own(l))
  for (const p of paths) {
    const c = p.layer === undefined ? undefined : own(p.layer)
    p.color = p.layer === undefined ? PATH_COLOR
      : c ? readableColor(c)
      : LAYER_COLORS[uncoloured.indexOf(p.layer) % LAYER_COLORS.length]
  }
}

const COLOR_NAME: Record<string, string> = {
  '#000000': 'Black', '#ffffff': 'White', '#ff0000': 'Red', '#00ff00': 'Green', '#008000': 'Green',
  '#0000ff': 'Blue', '#ffff00': 'Yellow', '#00ffff': 'Cyan', '#ff00ff': 'Magenta', '#ffa500': 'Orange',
  '#800080': 'Purple', '#808080': 'Grey', '#c0c0c0': 'Silver', '#800000': 'Maroon', '#000080': 'Navy',
  '#808000': 'Olive', '#008080': 'Teal',
}

/** How a layer tag reads on a button: a layer's own name, or a colour's name (or its hex). */
export function layerLabel(layer: string): string {
  return isColorTag(layer) ? COLOR_NAME[layer] ?? layer : layer
}
