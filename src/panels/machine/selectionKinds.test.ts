import { describe, it, expect } from 'vitest'
import { classifyPaths, narrowingHolds, outermostPaths } from './selectionKinds'
import type { ImportedPath } from '../../store/pathsStore'

const mk = (id: string, d: string): ImportedPath =>
  ({ id, name: id, d, visible: true, color: '#fff' } as ImportedPath)

const rectD = (x: number, y: number, w: number, h: number) =>
  `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
const circleD = (cx: number, cy: number, r: number, n = 36) =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return `${i === 0 ? 'M' : 'L'} ${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`
  }).join(' ') + ' Z'

// One part from the Charizard sheet, as the importer hands it over: the outline, a drilled
// hole, and the label "10" split one path per stroke — the 1 an open stroke, the 0 a
// closed ring with its slash a separate two-point line.
const part = () => [
  mk('outline', rectD(0, 0, 100, 60)),
  mk('hole', circleD(80, 45, 1.6)),
  mk('one', 'M 10 10 L 11 9 L 11 15'),
  mk('zero', 'M 14 9 L 18 9 L 18 15 L 14 15 Z'),
  mk('slash', 'M 14.5 9.5 L 17.5 14.5'),
]

describe('classifyPaths', () => {
  it('reads a labelled part as its outline, its hole and its lettering', () => {
    const k = classifyPaths(part())
    expect(Object.fromEntries(k)).toEqual({
      outline: 'outline', hole: 'hole', one: 'label', zero: 'label', slash: 'label',
    })
  })

  it('calls a closed letter a hole when no stroke of its label is beside it', () => {
    const k = classifyPaths([mk('outline', rectD(0, 0, 100, 60)), mk('zero', 'M 14 9 L 18 9 L 18 15 L 14 15 Z')])
    expect(k.get('zero')).toBe('hole')
  })

  // On the real sheet a drilled hole sits 2 mm from a stroke — closer than the letters sit
  // to each other — so nearness alone would engrave a drill hole as lettering.
  it('keeps a circle a hole even when it sits right beside a label', () => {
    const k = classifyPaths([
      mk('outline', rectD(0, 0, 100, 60)),
      mk('one', 'M 10 10 L 11 9 L 11 15'),
      mk('hole', circleD(14, 12, 1.6)),
    ])
    expect(k.get('hole')).toBe('hole')
  })

  it('does not let a label swallow a cutout much bigger than its letters', () => {
    const k = classifyPaths([
      mk('outline', rectD(0, 0, 100, 60)),
      mk('one', 'M 10 10 L 11 9 L 11 15'),
      mk('slot', rectD(13, 5, 30, 12)),
    ])
    expect(k.get('slot')).toBe('hole')
  })

  it('does not join a closed letter to a label in a different part', () => {
    const k = classifyPaths([
      mk('a', rectD(0, 0, 17, 20)),
      mk('one', 'M 15 10 L 16 9 L 16 15'),
      mk('b', rectD(17.5, 0, 20, 20)),
      // 2.5 mm from the stroke — near enough to join, were the two in one part.
      mk('zero', 'M 18.5 9 L 21.5 9 L 21.5 15 L 18.5 15 Z'),
    ])
    expect(k.get('zero')).toBe('hole')
  })

  // A stroke bounds no region, so nothing is inside it — however it curls round.
  it('does not treat a shape enclosed by an open stroke as inside it', () => {
    const k = classifyPaths([mk('u', 'M 0 50 L 0 0 L 50 0 L 50 50'), mk('box', rectD(10, 10, 20, 20))])
    expect(k.get('box')).toBe('outline')
  })
})

// An SVG label is one <path> of all its strokes; the importer splits it and marks the
// pieces with one sourceElement. The element decides, not nearness.
describe('classifyPaths — a split element', () => {
  it('reads every piece of an element holding a stroke as the label, however far its letters stand', () => {
    const k = classifyPaths([
      mk('outline', rectD(0, 0, 100, 60)),
      { ...mk('one', 'M 10 10 L 11 9 L 11 15'), sourceElement: 'lbl' },
      { ...mk('far-zero', 'M 60 9 L 64 9 L 64 15 L 60 15 Z'), sourceElement: 'lbl' },
    ])
    expect(k.get('far-zero')).toBe('label')
  })

  it('does not let a stroke-less element be pulled into a label beside it', () => {
    const k = classifyPaths([
      mk('outline', rectD(0, 0, 100, 60)),
      mk('one', 'M 10 10 L 11 9 L 11 15'),
      { ...mk('cutout', 'M 14 9 L 18 9 L 18 15 L 14 15 Z'), sourceElement: 'cutouts' },
    ])
    expect(k.get('cutout')).toBe('hole')
  })
})

describe('outermostPaths', () => {
  it('keeps only what no other closed path in the list contains', () => {
    const { outer, skipped } = outermostPaths([...part(), mk('other-part', rectD(120, 0, 50, 50))])
    expect(outer.map((p) => p.id)).toEqual(['outline', 'other-part'])
    expect(skipped).toBe(4)
  })

  it('treats holes selected on their own as outermost', () => {
    expect(outermostPaths([mk('h1', circleD(10, 10, 2)), mk('h2', circleD(20, 10, 2))]).skipped).toBe(0)
  })
})

// Review L3: narrow to Labels, then click one label out in the form's path list — the bar
// must still be narrowed, with ↺ All to put the whole selection back.
describe('when Select Only still counts as narrowed', () => {
  const applied = ['a', 'b', 'c']
  it('while the selection is exactly what it narrowed to', () => {
    expect(narrowingHolds(['a', 'b', 'c'], applied, false)).toBe(true)
  })
  it('after the form\'s path list clicks paths out of it, or back in', () => {
    expect(narrowingHolds(['a', 'c'], applied, true)).toBe(true)
    expect(narrowingHolds([], applied, true)).toBe(true)
  })
  it('not when the path list brings in a path from outside it', () => {
    expect(narrowingHolds(['a', 'b', 'c', 'x'], applied, true)).toBe(false)
  })
  // A click on the canvas is a new selection, even when it lands on a narrowed path.
  it('not when anything else changes the selection, even to a part of it', () => {
    expect(narrowingHolds(['a'], applied, false)).toBe(false)
  })
})
