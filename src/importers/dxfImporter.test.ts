import { describe, it, expect } from 'vitest'
import { importDxf, describeSkipped } from './dxfImporter'
import { getBBox } from '../canvas/selectionUtils'

// Minimal R12-style DXF: an ENTITIES section with the given entities, $INSUNITS=4 (mm).
function dxf(...entities: string[][]): string {
  const head = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES']
  const tail = ['0', 'ENDSEC', '0', 'EOF']
  return [...head, ...entities.flat(), ...tail].join('\n')
}
const line = (x1: number, y1: number, x2: number, y2: number) =>
  ['0', 'LINE', '8', '0', '10', `${x1}`, '20', `${y1}`, '30', '0', '11', `${x2}`, '21', `${y2}`, '31', '0']
// Angles in DEGREES, as a DXF file stores them.
const arc = (cx: number, cy: number, r: number, a0: number, a1: number) =>
  ['0', 'ARC', '8', '0', '10', `${cx}`, '20', `${cy}`, '30', '0', '40', `${r}`, '50', `${a0}`, '51', `${a1}`]

// A 20×10 rectangle whose top-right corner is a 2 mm CCW fillet (0° → 90°).
const filletedRect = [
  line(0, 0, 20, 0),
  line(20, 0, 20, 8),
  arc(18, 8, 2, 0, 90),
  line(18, 10, 0, 10),
  line(0, 10, 0, 0),
]

describe('importDxf', () => {
  it('reads ARC angles as degrees in the file, so the arc lands on its true endpoints', () => {
    const { paths } = importDxf(dxf(arc(0, 0, 10, 0, 90)), 'g')
    expect(paths).toHaveLength(1)
    // Starts at (10,0), sweeps CCW (sweep=1) a quarter turn to (0,10).
    expect(paths[0].d).toBe('M10,0 A10,10,0,0,1,0,10')
  })

  it('stitches lines joined by fillet arcs into one closed path', () => {
    const { paths } = importDxf(dxf(...filletedRect), 'g')
    expect(paths).toHaveLength(1)
    expect(paths[0].d).toMatch(/Z$/)
    expect(paths[0].d).toContain('A2,2,0,0,1,18,10')
  })

  it('flips the sweep of an arc walked backwards, keeping it the same arc', () => {
    // Same outline, entities ordered so the walk meets the arc from its end.
    const { paths } = importDxf(dxf(line(0, 10, 18, 10), ...filletedRect.filter((_, i) => i !== 3)), 'g')
    expect(paths).toHaveLength(1)
    expect(paths[0].d).toMatch(/Z$/)
    expect(paths[0].d).toContain('A2,2,0,0,0,20,8')
  })

  it('ignores a line drawn twice instead of walking back along the copy', () => {
    const { paths } = importDxf(dxf(...filletedRect, line(0, 0, 0, 10)), 'g')
    expect(paths).toHaveLength(1)
    expect(paths[0].d).toMatch(/Z$/)
  })

  it('closes a loop at its start even when a third edge meets there', () => {
    const { paths } = importDxf(dxf(...filletedRect, line(0, 0, -5, -5)), 'g')
    expect(paths.filter((p) => /Z$/.test(p.d))).toHaveLength(1)
    expect(paths.find((p) => !/Z$/.test(p.d))?.d).toBe('M0,0 L-5,-5')
  })

  it('imports a 360° arc as a closed circle', () => {
    const { paths } = importDxf(dxf(arc(5, 5, 3, 0, 360)), 'g')
    expect(paths).toHaveLength(1)
    expect(paths[0].d).toMatch(/Z$/)
  })

  // A closed 10×10 square as one LWPOLYLINE, the side from (10,0) up to (10,10) carrying
  // `bulge` (group 42 on its START vertex). ±1 is a half circle: tan(180°/4) = 1.
  const bulgedSquare = (bulge: number) => ['0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0',
    '10', '10', '20', '0', '42', `${bulge}`,
    '10', '10', '20', '10',
    '10', '0', '20', '10']

  it('reads a polyline bulge as an arc, not as its chord — positive swings CCW', () => {
    const { paths } = importDxf(dxf(bulgedSquare(1)), 'g')
    expect(paths).toHaveLength(1)
    // CCW from (10,0) to (10,10) about (10,5) passes through (15,5): out of the square.
    expect(paths[0].d).toBe('M0,0 L10,0 A5,5,0,0,1,10,10 L0,10 Z')
    expect(getBBox(paths[0].d)!.maxX).toBeCloseTo(15, 3)
  })

  it('swings a negative bulge CW, into the square', () => {
    const { paths } = importDxf(dxf(bulgedSquare(-1)), 'g')
    expect(paths[0].d).toContain('A5,5,0,0,0,10,10')
    expect(getBBox(paths[0].d)!.maxX).toBeCloseTo(10, 3)
  })

  it('bulges the closing segment of a closed polyline from its LAST vertex', () => {
    // Quarter arc (bulge tan(90°/4)) on the side from (0,10) back to (0,0).
    const q = Math.tan(Math.PI / 8)
    const { paths } = importDxf(dxf(['0', 'LWPOLYLINE', '8', '0', '90', '3', '70', '1',
      '10', '0', '20', '0', '10', '10', '20', '0', '10', '0', '20', '10', '42', `${q}`]), 'g')
    const r = 10 / (2 * Math.sin(Math.PI / 4))
    expect(paths[0].d).toMatch(new RegExp(`L0,10 A${+r.toFixed(4)},${+r.toFixed(4)},0,0,1,0,0 Z$`))
  })
})

// ─── Blocks, mirrored entities, and what is left out ─────────────────────────

// A file with a BLOCKS section. `units` is $INSUNITS (4 = mm, 1 = inch).
function dxfWithBlocks(blocks: { name: string; base?: [number, number]; entities: string[][] }[], entities: string[][], units = 4): string {
  const head = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', `${units}`, '0', 'ENDSEC']
  const blk = ['0', 'SECTION', '2', 'BLOCKS', ...blocks.flatMap((b) => [
    '0', 'BLOCK', '8', '0', '2', b.name, '70', '0',
    '10', `${b.base?.[0] ?? 0}`, '20', `${b.base?.[1] ?? 0}`, '30', '0', '3', b.name,
    ...b.entities.flat(), '0', 'ENDBLK', '8', '0']), '0', 'ENDSEC']
  const ent = ['0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC', '0', 'EOF']
  return [...head, ...blk, ...ent].join('\n')
}
const insert = (name: string, x: number, y: number, o: { rot?: number; sx?: number; sy?: number; cols?: number; colGap?: number; z?: number } = {}) => [
  '0', 'INSERT', '8', '0', '2', name, '10', `${x}`, '20', `${y}`, '30', '0',
  ...(o.sx !== undefined ? ['41', `${o.sx}`] : []), ...(o.sy !== undefined ? ['42', `${o.sy}`] : []),
  ...(o.rot !== undefined ? ['50', `${o.rot}`] : []),
  ...(o.cols !== undefined ? ['70', `${o.cols}`, '44', `${o.colGap ?? 0}`] : []),
  ...(o.z !== undefined ? ['210', '0', '220', '0', '230', `${o.z}`] : []),
]
// A closed 10×10 square as one LWPOLYLINE, corner at (x,y).
const square = (x: number, y: number) => ['0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
  '10', `${x}`, '20', `${y}`, '10', `${x + 10}`, '20', `${y}`, '10', `${x + 10}`, '20', `${y + 10}`, '10', `${x}`, '20', `${y + 10}`]
const bb = (d: string) => { const b = getBBox(d)!; return [b.minX, b.minY, b.maxX, b.maxY].map((v) => +v.toFixed(4)) }

describe('importDxf — blocks (INSERT)', () => {
  it('places a block at its insert point, scaled then rotated about its base point', () => {
    // Base (5,0): the block's geometry is measured from there, so the square's corner at
    // (5,0) lands exactly on the insert point before scale and rotation.
    const { paths, skipped } = importDxf(dxfWithBlocks(
      [{ name: 'SQ', base: [5, 0], entities: [square(5, 0)] }],
      [insert('SQ', 100, 50, { sx: 2, sy: 2, rot: 90 })]), 'g')
    expect(paths).toHaveLength(1)
    // 20×20 after scale, turned 90° CCW about (100,50): it now spans x 80…100, y 50…70.
    expect(bb(paths[0].d)).toEqual([80, 50, 100, 70])
    expect(skipped).toEqual({})
  })

  it('imports every cell of an arrayed insert', () => {
    const { paths } = importDxf(dxfWithBlocks([{ name: 'SQ', entities: [square(0, 0)] }],
      [insert('SQ', 0, 0, { cols: 3, colGap: 25 })]), 'g')
    expect(paths.map((p) => bb(p.d)[0])).toEqual([0, 25, 50])
  })

  it('measures the insert point in the file\'s units, not in mm', () => {
    // Inches: a 10" square inserted at (1",0) sits at 25.4 mm.
    const { paths } = importDxf(dxfWithBlocks([{ name: 'SQ', entities: [square(0, 0)] }],
      [insert('SQ', 1, 0)], 1), 'g')
    expect(bb(paths[0].d)).toEqual([25.4, 0, 279.4, 254])
  })

  it('stitches a block\'s lines and arcs into one outline, and follows nested blocks', () => {
    const { paths } = importDxf(dxfWithBlocks([
      { name: 'PART', entities: filletedRect },
      { name: 'OUTER', entities: [insert('PART', 100, 0)] },
    ], [insert('OUTER', 0, 100)]), 'g')
    expect(paths).toHaveLength(1)
    expect(paths[0].d).toMatch(/Z$/)
    expect(bb(paths[0].d)).toEqual([100, 100, 120, 110])
  })

  it('reports a missing block, and stops a block that inserts itself', () => {
    const { paths, skipped } = importDxf(dxfWithBlocks(
      [{ name: 'LOOP', entities: [square(0, 0), insert('LOOP', 20, 0)] }],
      [insert('NOPE', 0, 0), insert('LOOP', 0, 0)]), 'g')
    expect(skipped['missing block']).toBe(1)
    expect(skipped['block nested too deep']).toBe(1)
    expect(paths.length).toBeGreaterThan(1)
  })

  it('caps a block that inserts itself several times, which would multiply at every level', () => {
    // Three self-inserts under the depth guard alone is 3^16 ≈ 43 million entities.
    const { skipped } = importDxf(dxfWithBlocks(
      [{ name: 'THREE', entities: [line(0, 0, 1, 0), insert('THREE', 2, 0), insert('THREE', 0, 2), insert('THREE', 2, 2)] }],
      [insert('THREE', 0, 0)]), 'g')
    expect(skipped['block expansion over the limit']).toBeGreaterThan(0)
  })
})

describe('importDxf — mirrored entities (extrusion 0,0,−1)', () => {
  const z = ['210', '0', '220', '0', '230', '-1']
  it('mirrors an ARC\'s X, and keeps it the same arc — its CCW turns CW in the world', () => {
    // OCS: centre (10,0), r 5, 0°→90°, from (15,0) to (10,5). World: centre (−10,0), from
    // (−15,0) to (−10,5) the other way round — i.e. CCW from (−10,5) to (−15,0).
    const { paths } = importDxf(dxf([...arc(10, 0, 5, 0, 90), ...z]), 'g')
    expect(paths[0].d).toBe('M-10,5 A5,5,0,0,1,-15,0')
  })

  it('mirrors a CIRCLE, which the parser gives no extrusion for — read from the raw file by handle', () => {
    const circle = ['0', 'CIRCLE', '5', '2A', '8', '0', '10', '10', '20', '0', '30', '0', '40', '2', ...z]
    expect(bb(importDxf(dxf(circle), 'g').paths[0].d)).toEqual([-12, -2, -8, 2])
  })

  it('mirrors an LWPOLYLINE with its bulges swinging the right way', () => {
    // (0,0)→(10,0) with bulge 1: in the OCS a half circle below the chord, through (5,−5).
    // Mirrored it runs (0,0)→(−10,0) and must STILL pass through y = −5, not +5.
    const pl = ['0', 'LWPOLYLINE', '8', '0', '90', '2', '70', '0', '10', '0', '20', '0', '42', '1', '10', '10', '20', '0', ...z]
    expect(bb(importDxf(dxf(pl), 'g').paths[0].d)).toEqual([-10, -5, 0, 0])
  })

  it('mirrors an INSERT, carrying its whole block across', () => {
    const { paths } = importDxf(dxfWithBlocks([{ name: 'SQ', entities: [square(0, 0)] }],
      [insert('SQ', 30, 0, { z: -1 })]), 'g')
    expect(bb(paths[0].d)).toEqual([-40, 0, -30, 10])
  })

  it('leaves a LINE alone — it is in world coordinates whatever its extrusion says', () => {
    const { paths } = importDxf(dxf([...line(0, 0, 10, 0), ...z]), 'g')
    expect(paths[0].d).toBe('M0,0 L10,0')
  })

  it('skips and reports an entity on a TILTED plane rather than flattening it', () => {
    const tilted = [...arc(0, 0, 5, 0, 90), '210', '0.6', '220', '0', '230', '0.8']
    const { paths, skipped } = importDxf(dxf(tilted), 'g')
    expect(paths).toEqual([])
    expect(skipped).toEqual({ 'arc (tilted)': 1 })
  })
})

describe('importDxf — reports what it leaves out', () => {
  it('counts text, hatches and the like by what the user calls them', () => {
    const text = (t: string) => ['0', t, '8', '0', '10', '0', '20', '0', '30', '0', '40', '5', '1', 'Hi']
    const { paths, skipped } = importDxf(dxf(square(0, 0), text('TEXT'), text('MTEXT'), ['0', 'POINT', '8', '0', '10', '1', '20', '1', '30', '0']), 'g')
    expect(paths).toHaveLength(1)
    expect(skipped).toEqual({ text: 2, point: 1 })
    expect(describeSkipped(skipped)).toBe('2 text, 1 point')
  })
})
