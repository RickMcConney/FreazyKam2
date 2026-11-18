// Point-edit weld/connect targets (`collectCrossPathEntries`, `refineCrossEntry`). A closed
// path offers every node and a gear has thousands, so a few gears once produced tens of
// thousands of rings on one endpoint mousedown and took the tab down. The fix is to
// gather against the VIEWPORT: drop what is off screen, thin to one per 8 px of screen,
// cap at 500 keeping the nearest — and never thin an open path's two endpoints.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { collectCrossPathEntries, refineCrossEntry, type CrossPathView } from './useNodeEditSession'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))

const path = (id: string, d: string, over: Partial<ImportedPath> = {}): ImportedPath =>
  ({ id, name: id, d, color: '#000', visible: true, ...over })
const square = (x: number, y: number, s: number) => `M ${x} ${y} L ${x + s} ${y} L ${x + s} ${y + s} L ${x} ${y + s} Z`
/** A closed polygon of n nodes on a circle — a stand-in for a gear's rim. */
const ring = (cx: number, cy: number, r: number, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return `${i === 0 ? 'M' : 'L'} ${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`
  }).join(' ') + ' Z'

const setPaths = (paths: ImportedPath[]) => usePathsStore.setState({ paths, selectedIds: [] })
const view = (over: Partial<CrossPathView> = {}): CrossPathView =>
  ({ minX: -1000, minY: -1000, maxX: 1000, maxY: 1000, scale: 10, near: { x: 0, y: 0 }, ...over })

beforeEach(() => setPaths([]))

describe('which nodes a path offers as weld targets', () => {
  it('a closed path offers every node, an open one only its two endpoints', () => {
    setPaths([path('sq', square(0, 0, 10)), path('line', 'M 50 0 L 60 0 L 70 5 L 80 0')])
    const e = collectCrossPathEntries(null)
    expect(e.filter((x) => x.pathId === 'sq').map((x) => x.nodeIdx)).toEqual([0, 1, 2, 3])
    expect(e.filter((x) => x.pathId === 'line').map((x) => [x.x, x.y])).toEqual([[50, 0], [80, 0]])
  })

  it('the path being edited, an invisible path and a soft-hidden path offer nothing', () => {
    setPaths([
      path('self', square(0, 0, 10)),
      path('off', square(20, 0, 10), { visible: false }),
      path('operand', square(40, 0, 10), { hidden: true }),
      path('other', square(60, 0, 10)),
    ])
    expect(new Set(collectCrossPathEntries('self').map((x) => x.pathId))).toEqual(new Set(['other']))
  })

  it('an edited path is reparsed, not served from the cache under its id', () => {
    setPaths([path('sq', square(0, 0, 10))])
    collectCrossPathEntries(null)
    setPaths([path('sq', square(100, 100, 10))])
    expect(collectCrossPathEntries(null)[0]).toMatchObject({ x: 100, y: 100 })
  })
})

describe('gathering against the viewport', () => {
  it('drops closed-path nodes off screen, but keeps those within one weld radius (16 px) of the edge', () => {
    // scale 10 px/mm: the margin is 1.6 mm. Nodes at x = 0, 10 and the view ends at x = 8.5.
    setPaths([path('sq', square(0, 0, 10))])
    const near = collectCrossPathEntries(null, view({ minX: -5, maxX: 8.5 }))
    expect(near.map((x) => x.x).sort()).toEqual([0, 0, 10, 10])
    const far = collectCrossPathEntries(null, view({ minX: -5, maxX: 8.3 }))
    expect(far.map((x) => x.x)).toEqual([0, 0])
  })

  it('never culls an open path\'s endpoints, even off screen', () => {
    setPaths([path('line', 'M 500 500 L 600 500')])
    expect(collectCrossPathEntries(null, view({ minX: 0, minY: 0, maxX: 10, maxY: 10 }))).toHaveLength(2)
  })

  it('thins a closed path to one node per 8 px of screen — zoomed out a gear rim offers a handful, zoomed in all of it', () => {
    // 360 nodes on r = 10: neighbours 0.175 mm apart.
    setPaths([path('gear', ring(0, 0, 10, 360))])
    const zoomedIn = collectCrossPathEntries(null, view({ scale: 100 }))     // cell 0.08 mm
    const zoomedOut = collectCrossPathEntries(null, view({ scale: 2 }))      // cell 4 mm
    expect(zoomedIn).toHaveLength(360)
    expect(zoomedOut.length).toBeGreaterThan(4)
    expect(zoomedOut.length).toBeLessThan(40)
  })

  it('thins per path: two shapes lying exactly on top of each other are both offered', () => {
    setPaths([path('a', square(0, 0, 10)), path('b', square(0, 0, 10))])
    const e = collectCrossPathEntries(null, view({ scale: 0.1 }))           // whole square in one cell
    expect(e.map((x) => x.pathId).sort()).toEqual(['a', 'b'])
  })

  it('caps at 500, keeping every open endpoint and the closed nodes NEAREST the dragged node', () => {
    const lines = Array.from({ length: 10 }, (_, i) => path(`l${i}`, `M ${i * 10} 900 L ${i * 10 + 5} 900`))
    setPaths([...lines, path('gear', ring(0, 0, 100, 2000))])
    const e = collectCrossPathEntries(null, view({ scale: 1000, near: { x: 100, y: 0 } }))
    expect(e).toHaveLength(500)
    expect(e.filter((x) => !x.closed)).toHaveLength(20)
    // The 480 kept rim nodes are the ones round the point nearest (100, 0): none on the far side.
    const kept = e.filter((x) => x.closed)
    expect(Math.max(...kept.map((x) => Math.hypot(x.x - 100, x.y)))).toBeLessThan(80)
  })
})

describe('refineCrossEntry — a thinned-away node is still where the weld lands', () => {
  it('moves a closed-path target to whichever of its nodes is nearest the cursor', () => {
    setPaths([path('gear', ring(0, 0, 10, 360))])
    const target = collectCrossPathEntries(null, view({ scale: 2 }))[0]
    const at = { x: 10 * Math.cos(0.3), y: 10 * Math.sin(0.3) }
    const r = refineCrossEntry(target, at)
    expect(Math.hypot(r.x - at.x, r.y - at.y)).toBeLessThan(0.09)
    expect(r.nodes[r.nodeIdx]).toMatchObject({ x: r.x, y: r.y })
  })

  it('leaves an open-path endpoint alone — only the two ends may be joined to', () => {
    setPaths([path('line', 'M 0 0 L 10 0 L 20 0')])
    const end = collectCrossPathEntries(null)[0]
    expect(refineCrossEntry(end, { x: 10, y: 0 })).toBe(end)
  })
})
