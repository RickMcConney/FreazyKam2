import { describe, it, expect } from 'vitest'
import { pathsToSvg } from './svgExport'
import { parseD, applyMat, stringifyD, svgToCncMat, type ImportedPath } from '../importers/svgImporter'
import { flattenPath } from '../cam/pathFlattener'

const path = (p: Partial<ImportedPath> & { id: string; d: string }): ImportedPath => ({
  name: p.id, visible: true, color: '#3b82f6', ...p,
})

const STOCK = { widthMM: 300, heightMM: 200 }

/** The `d` of the nth `<path>` in an exported document. */
function dOf(svg: string, n = 0): string {
  const all = [...svg.matchAll(/ d="([^"]+)"/g)]
  return all[n][1]
}

/** Read the exported file back the way `importSvg` does: its own page size and
 *  viewBox, through its own transform. This is the round trip, minus the DOM —
 *  the unit tests run in node, where there is no DOMParser to hand the real
 *  importer. */
function reimport(svg: string, n = 0): string {
  const w = Number(/width="([\d.]+)mm"/.exec(svg)![1])
  const h = Number(/height="([\d.]+)mm"/.exec(svg)![1])
  const [vbX, vbY, vbW, vbH] = /viewBox="([^"]+)"/.exec(svg)![1].split(/\s+/).map(Number)
  return stringifyD(applyMat(parseD(dOf(svg, n)), svgToCncMat(w, h, vbX, vbY, vbW, vbH)))
}

const pts = (d: string) => flattenPath(d, 0.01).flat()

describe('SVG export', () => {
  it('states millimetres, with the stock as the page', () => {
    const svg = pathsToSvg([path({ id: 'a', d: 'M0,0 L10,0 L10,10 Z' })], STOCK)
    // Real-world units on width/height are what stop the importer asking for a
    // PPI, and a viewBox that matches them is what makes one unit one mm.
    expect(svg).toContain('width="300mm"')
    expect(svg).toContain('height="200mm"')
    expect(svg).toContain('viewBox="0 0 300 200"')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    // Cut lines, not filled shapes.
    expect(svg).toContain('fill="none"')
    expect(svg).toContain('stroke="#3b82f6"')
  })

  // THE POINT OF THE FILE FORMAT CHOICE: what goes out comes back where it was.
  it('round-trips a path to its own coordinates', () => {
    for (const d of [
      'M0,0 L10,0 L10,10 Z',                                  // at the origin
      'M120,40 L180,40 L180,90 L120,90 Z',                    // out on the stock
      'M10,10 C20,40 60,40 70,10',                            // curves
      'M-20,-15 L5,-15 L5,5 Z',                               // off the stock, below it
    ]) {
      const back = reimport(pathsToSvg([path({ id: 'a', d })], STOCK))
      const a = pts(d), b = pts(back)
      expect(b).toHaveLength(a.length)
      for (let i = 0; i < a.length; i++) {
        expect(b[i][0]).toBeCloseTo(a[i][0], 6)
        expect(b[i][1]).toBeCloseTo(a[i][1], 6)
      }
    }
  })

  // A mirror flips an arc's SWEEP, and getting that wrong turns a bulge into a
  // dish — which the geometry check above would catch, but only if arcs are in
  // it. `applyMat` owns the rule; this is here to be sure the export goes
  // through it rather than doing its own arithmetic.
  it('flips arc sweeps, and flips them back', () => {
    const d = 'M10,50 A20,20 0 0 1 50,50 L50,20 Z'
    const svg = pathsToSvg([path({ id: 'a', d })], STOCK)
    const out = parseD(dOf(svg)).find((c) => c.t === 'A')!
    const src = parseD(d).find((c) => c.t === 'A')!
    if (out.t !== 'A' || src.t !== 'A') throw new Error('lost the arc')
    expect(out.sw).toBe(1 - src.sw)
    const back = pts(reimport(svg))
    const orig = pts(d)
    for (let i = 0; i < orig.length; i++) {
      expect(back[i][0]).toBeCloseTo(orig[i][0], 6)
      expect(back[i][1]).toBeCloseTo(orig[i][1], 6)
    }
  })

  // Names ride on `inkscape:label`, never on `id`: the importer prefers `id`
  // when both are present, and an id is an XML name — no spaces — so a real
  // name would come back mangled.
  it('carries the name where the importer will look for it', () => {
    const svg = pathsToSvg([path({ id: 'a', name: 'Great Wheel teeth', d: 'M0,0 L1,1' })], STOCK)
    expect(svg).toContain('inkscape:label="Great Wheel teeth"')
    expect(svg).toContain('xmlns:inkscape=')
    expect(svg).not.toMatch(/ id="/)
    // …and anything XML-unsafe in a name is escaped rather than breaking the file.
    expect(pathsToSvg([path({ id: 'a', name: 'A & <B>', d: 'M0,0 L1,1' })], STOCK))
      .toContain('inkscape:label="A &amp; &lt;B&gt;"')
  })

  it('writes one element per path, in order', () => {
    const svg = pathsToSvg([
      path({ id: 'a', d: 'M0,0 L10,0' }),
      path({ id: 'b', d: 'M0,20 L10,20' }),
    ], STOCK)
    expect([...svg.matchAll(/<path /g)]).toHaveLength(2)
    expect(pts(reimport(svg, 1))[0][1]).toBeCloseTo(20, 6)
  })
})
