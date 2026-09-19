import { describe, it, expect } from 'vitest'
import { importDxf } from './dxfImporter'

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
})
