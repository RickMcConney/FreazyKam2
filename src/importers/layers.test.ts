import { describe, it, expect } from 'vitest'
import { normalizeColor, colorByLayer, layerLabel, readableColor } from './layers'
import { inkOf, inkLayer, type Ink } from './svgImporter'
import { PATH_COLOR } from '../colors'
import type { ImportedPath } from './svgImporter'

describe('normalizeColor', () => {
  it('spells one colour one way, however the file wrote it', () => {
    for (const c of ['#F00', '#ff0000', 'red', 'rgb(255, 0, 0)', ' RED ']) expect(normalizeColor(c)).toBe('#ff0000')
  })
  it('reads no colour out of none, currentColor, a gradient or nonsense', () => {
    for (const c of ['none', 'currentColor', 'url(#g1)', 'transparent', 'notacolour', '', null]) expect(normalizeColor(c)).toBeNull()
  })
})

describe('layerLabel', () => {
  it('names a colour tag, and leaves a layer name as it is', () => {
    expect(layerLabel('#ff0000')).toBe('Red')
    expect(layerLabel('#123456')).toBe('#123456')
    expect(layerLabel('LABELS')).toBe('LABELS')
  })
})

describe('colorByLayer', () => {
  const p = (layer?: string): ImportedPath => ({ id: Math.random().toString(), name: '', d: '', visible: true, color: PATH_COLOR, ...(layer ? { layer } : {}) })
  it('gives each layer its own colour, in order of first appearance, and untagged paths the usual one', () => {
    const paths = [p('A'), p('B'), p('A'), p()]
    colorByLayer(paths)
    expect(paths[0].color).toBe(paths[2].color)
    expect(paths[1].color).not.toBe(paths[0].color)
    expect(paths[3].color).toBe(PATH_COLOR)
  })
})

// The SVG importer needs a browser DOMParser, which a node test does not have — so the
// inheritance rule is checked against stand-in elements carrying just what it reads.
const el = (attrs: Record<string, string>): Element => ({
  getAttribute: (n: string) => attrs[n] ?? null,
  getAttributeNS: () => null,
}) as unknown as Element
const tagOf = (...chain: Record<string, string>[]) => inkLayer(chain.reduce<Ink>((ink, a) => inkOf(el(a), ink), {}))

// The Charizard SVG: a "Red" button carried a blue dot because colour layers were handed
// palette colours in order of appearance.
describe('colour layers on the canvas', () => {
  const p = (layer: string): ImportedPath => ({ id: Math.random().toString(), name: '', d: '', visible: true, color: PATH_COLOR, layer })
  it('draws a colour layer in its own colour, made readable', () => {
    const paths = [p('#ff0000'), p('#0000ff')]
    colorByLayer(paths)
    expect(paths.map((x) => x.color)).toEqual([readableColor('#ff0000'), readableColor('#0000ff')])
    expect(hueOf(paths[0].color)).toBeCloseTo(0, 0)
    expect(hueOf(paths[1].color)).toBeCloseTo(240, 0)
  })
  it('draws a named layer in the colour the file gives it, and the palette only where it gives none', () => {
    const paths = [p('CUT_OUTER'), p('LABELS'), p('SHEET')]
    colorByLayer(paths, new Map([['CUT_OUTER', '#ff0000'], ['LABELS', '#00ff00']]))
    expect(paths.map((x) => x.color)).toEqual([readableColor('#ff0000'), readableColor('#00ff00'), PATH_COLOR])
  })
})

// WCAG relative luminance and HSL hue, measured independently of the code under test.
const lum = (hex: string) => {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const hueOf = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b)
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return h * 60
}

// Blue was hard to see on the dark canvas and green on the light one: at one HSL lightness
// pure blue is a twelfth as bright as pure green.
describe('readableColor', () => {
  const FILE_COLOURS = ['#ff0000', '#0000ff', '#00ff00', '#000000', '#ffffff', '#ff00ff', '#000080', '#ffa500']
  it('brings every colour to the same brightness, so each shows on both canvases', () => {
    for (const c of FILE_COLOURS) expect(lum(readableColor(c))).toBeCloseTo(0.2, 1)
  })
  it('keeps each colour its own hue — red stays red, blue blue, green green', () => {
    for (const c of ['#ff0000', '#0000ff', '#00ff00', '#ff00ff', '#000080', '#ffa500']) {
      expect(Math.abs(hueOf(readableColor(c)) - hueOf(c))).toBeLessThan(2)
    }
  })
  it('makes black and white the same mid grey', () => {
    expect(readableColor('#000000')).toBe(readableColor('#ffffff'))
    expect(hueOf(readableColor('#000000'))).toBe(0)
  })
  it('lightens blue and darkens green — the two that were lost', () => {
    expect(lum(readableColor('#0000ff'))).toBeGreaterThan(lum('#0000ff'))
    expect(lum(readableColor('#00ff00'))).toBeLessThan(lum('#00ff00'))
  })
})

describe('SVG layer tags', () => {
  it('tags a path by its stroke, from the attribute or from its style', () => {
    expect(tagOf({ stroke: '#FF0000' })).toBe('#ff0000')
    expect(tagOf({ style: 'fill:none;stroke:#0000ff;stroke-width:0.1' })).toBe('#0000ff')
  })
  it('inherits a stroke set on a group, and lets a child override it', () => {
    expect(tagOf({ stroke: 'red' }, {})).toBe('#ff0000')
    expect(tagOf({ stroke: 'red' }, { stroke: 'blue' })).toBe('#0000ff')
  })
  // Without the fall-back a path with stroke="none" would still read its group's colour.
  it('falls back to the fill when the stroke is none', () => {
    expect(tagOf({ stroke: 'red' }, { stroke: 'none', fill: '#00ff00' })).toBe('#00ff00')
  })
  it('prefers the Inkscape layer a path sits in over its colour', () => {
    expect(tagOf({ 'inkscape:groupmode': 'layer', 'inkscape:label': 'Labels' }, { stroke: 'red' })).toBe('Labels')
  })
  it('tags nothing when the file says nothing', () => {
    expect(tagOf({}, {})).toBeUndefined()
  })
})
