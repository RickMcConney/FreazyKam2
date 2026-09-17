import { describe, it, expect } from 'vitest'
import {
  parseDToNodes,
  nodesToD,
  removeNode,
  insertNodeOnSegment,
  nearestSegmentOnPath,
  weldNodes,
  splitCompoundPath,
  type PathNode,
  toggleNodeCurvature,
  connectEndpointToInterior,
  joinPaths,
  joinPathsConnect,
  endpointToMidpointWeld,
  deleteSegment,
} from './nodeUtils'

describe('parseDToNodes', () => {
  it('parses a closed polygon', () => {
    const { nodes, closed } = parseDToNodes('M0,0 L10,0 L10,5 Z')
    expect(closed).toBe(true)
    expect(nodes).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
    ])
  })

  it('parses an open polyline', () => {
    const { nodes, closed } = parseDToNodes('M0,0 L10,0 L10,5')
    expect(closed).toBe(false)
    expect(nodes.length).toBe(3)
  })

  it('detects implicit close when the last node returns to the start', () => {
    const { nodes, closed } = parseDToNodes('M0,0 L10,0 L5,5 L0,0')
    expect(closed).toBe(true)
    expect(nodes.length).toBe(3) // coincident closing node dropped
  })

  it('attaches cubic control points as handles', () => {
    const { nodes } = parseDToNodes('M0,0 C1,2 3,4 5,6')
    expect(nodes[0].handleOut).toEqual({ x: 1, y: 2 })
    expect(nodes[1].handleIn).toEqual({ x: 3, y: 4 })
    expect(nodes[1].x).toBe(5)
    expect(nodes[1].y).toBe(6)
  })
})

describe('nodesToD round-trip', () => {
  it('is structurally stable through parse → stringify → parse', () => {
    const d = 'M 0 0 C 1 2 3 4 5 6 L 10 0 Z'
    const first = parseDToNodes(d)
    const second = parseDToNodes(nodesToD(first.nodes, first.closed))
    expect(second.closed).toBe(first.closed)
    expect(second.nodes).toEqual(first.nodes)
  })

  it('emits L for handle-less segments and C when either handle exists', () => {
    const nodes: PathNode[] = [
      { x: 0, y: 0, handleOut: { x: 1, y: 1 } },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]
    const d = nodesToD(nodes, false)
    expect(d).toBe('M 0 0 C 1 1 5 0 5 0 L 10 0')
  })

  it('closes with Z for straight closing segments', () => {
    const nodes: PathNode[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }]
    expect(nodesToD(nodes, true)).toBe('M 0 0 L 10 0 L 5 5 Z')
  })
})

describe('removeNode', () => {
  it('removes the node at the index', () => {
    const nodes: PathNode[] = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]
    expect(removeNode(nodes, 1)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }])
  })
})

describe('insertNodeOnSegment', () => {
  it('inserts on a straight segment at the clicked point without inventing handles', () => {
    const nodes: PathNode[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
    const out = insertNodeOnSegment(nodes, 0, 5, 0.2, false)
    expect(out.length).toBe(3)
    expect(out[0]).toEqual({ x: 0, y: 0, handleOut: undefined })
    expect(out[2]).toEqual({ x: 10, y: 0, handleIn: undefined })
    expect(out[1].x).toBeCloseTo(5, 1)
    expect(out[1].y).toBeCloseTo(0)
    expect(out[1].handleIn).toBeUndefined()
    expect(out[1].handleOut).toBeUndefined()
  })

  it('splits a curved segment keeping endpoints fixed and adding handles', () => {
    const nodes: PathNode[] = [
      { x: 0, y: 0, handleOut: { x: 3, y: 5 } },
      { x: 10, y: 0, handleIn: { x: 7, y: 5 } },
    ]
    const out = insertNodeOnSegment(nodes, 0, 5, 3.75, false)
    expect(out.length).toBe(3)
    expect(out[0].x).toBe(0)
    expect(out[2].x).toBe(10)
    // symmetric curve, click at the apex → midpoint of the cubic at t=0.5
    expect(out[1].x).toBeCloseTo(5, 1)
    expect(out[1].y).toBeCloseTo(3.75, 1)
    expect(out[1].handleIn).toBeDefined()
    expect(out[1].handleOut).toBeDefined()
  })

  it('rejects the nonexistent wrap segment of an open path', () => {
    const nodes: PathNode[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
    expect(insertNodeOnSegment(nodes, 1, 5, 0, false)).toBe(nodes)
  })
})

describe('nearestSegmentOnPath', () => {
  const square: PathNode[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]

  it('finds the nearest side of a closed square', () => {
    expect(nearestSegmentOnPath(square, true, 5, -1)?.segIdx).toBe(0)
    expect(nearestSegmentOnPath(square, true, 11, 5)?.segIdx).toBe(1)
    // closing segment (left side) only exists because the path is closed
    expect(nearestSegmentOnPath(square, true, -1, 5)?.segIdx).toBe(3)
  })

  it('excludes the closing segment for open paths', () => {
    const res = nearestSegmentOnPath(square, false, -1, 5)
    expect(res?.segIdx).not.toBe(3)
  })

  it('returns null for a single node', () => {
    expect(nearestSegmentOnPath([{ x: 0, y: 0 }], false, 0, 0)).toBeNull()
  })
})

describe('weldNodes', () => {
  it('welding the two endpoints of an open path closes it', () => {
    const nodes: PathNode[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0.1, y: 0.1 },
    ]
    const res = weldNodes(nodes, 3, 0, false)
    expect(res.closed).toBe(true)
    expect(res.nodes.length).toBe(3)
    // merged node sits at the target's position
    expect(res.nodes[0]).toMatchObject({ x: 0, y: 0 })
  })
})

describe('splitCompoundPath', () => {
  it('splits at each M into subpath d strings', () => {
    const parts = splitCompoundPath('M0,0 L10,0 Z M20,20 L30,20')
    expect(parts.length).toBe(2)
    expect(parts[0].startsWith('M')).toBe(true)
    expect(parts[1]).toContain('20')
  })

  it('returns a single entry for a simple path', () => {
    expect(splitCompoundPath('M0,0 L10,0 Z').length).toBe(1)
  })
})


// ─── Point-edit surgery ───────────────────────────────────────────────────────
// Every function below rewrites a path the user is looking at, and several of them
// SPLIT one into two. They are pure over PathNode[], so they can be checked exactly.

const P = (x: number, y: number, extra: Partial<PathNode> = {}): PathNode => ({ x, y, ...extra })
/** A straight open run of four nodes, so positions read as indices × 10. */
const RUN = [P(0, 0), P(10, 0), P(20, 0), P(30, 0)]
/** The same, every node carrying handles, so handle bookkeeping is visible. */
const RUN_H = [
  P(0, 0, { handleOut: { x: 2, y: 2 } }),
  P(10, 0, { handleIn: { x: 8, y: 2 }, handleOut: { x: 12, y: 2 } }),
  P(20, 0, { handleIn: { x: 18, y: 2 }, handleOut: { x: 22, y: 2 } }),
  P(30, 0, { handleIn: { x: 28, y: 2 } }),
]
const xy = (nodes: PathNode[]) => nodes.map((n) => [n.x, n.y])

describe('toggleNodeCurvature', () => {
  it('gives a corner symmetric handles off its neighbours\' chord', () => {
    // The Catmull-Rom sixth, so the curve through the node is smooth and the two
    // handles are collinear with it.
    const out = toggleNodeCurvature([P(0, 0), P(10, 10), P(20, 0)], 1, false)[1]
    expect(out.handleIn).toEqual({ x: 10 - 20 / 6, y: 10 })
    expect(out.handleOut).toEqual({ x: 10 + 20 / 6, y: 10 })
  })

  it('turns a smooth node back into a corner', () => {
    const smooth = toggleNodeCurvature(RUN, 1, false)
    expect(toggleNodeCurvature(smooth, 1, false)[1]).toEqual({ x: 10, y: 0 })
  })

  it('gives an open path\'s ends only the handle they can have', () => {
    // A first node has nothing behind it and a last has nothing ahead, so each gets
    // one handle, a third of the way to its only neighbour.
    expect(toggleNodeCurvature(RUN, 0, false)[0]).toEqual({ x: 0, y: 0, handleOut: { x: 10 / 3, y: 0 } })
    expect(toggleNodeCurvature(RUN, 3, false)[3]).toEqual({ x: 30, y: 0, handleIn: { x: 30 - 10 / 3, y: 0 } })
  })

  it('wraps round to find both neighbours on a closed path', () => {
    // Node 0 of a closed square has node 3 behind it, so it gets a full pair.
    const sq = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)]
    const out = toggleNodeCurvature(sq, 0, true)[0]
    expect(out.handleIn).toBeDefined()
    expect(out.handleOut).toBeDefined()
  })

  it('leaves the nodes alone for an index that is not there', () => {
    expect(toggleNodeCurvature(RUN, 9, false)).toBe(RUN)
    expect(toggleNodeCurvature(RUN, -1, false)).toBe(RUN)
  })
})

describe('connectEndpointToInterior', () => {
  it('closes a loop from an endpoint back to an interior node, leaving the tail behind', () => {
    const { loopNodes, remainNodes } = connectEndpointToInterior(RUN_H, 0, 2)!
    expect(xy(loopNodes)).toEqual([[0, 0], [10, 0], [20, 0]])
    expect(xy(remainNodes)).toEqual([[20, 0], [30, 0]])
  })

  it('drops the handles that pointed across the cut', () => {
    // The junction node appears in BOTH halves, and each copy keeps only the handle
    // belonging to its own side — the other one aimed at geometry that is now in the
    // other path, and would render as a stray arm.
    const { loopNodes, remainNodes } = connectEndpointToInterior(RUN_H, 0, 2)!
    expect(loopNodes[loopNodes.length - 1].handleOut).toBeUndefined()
    expect(remainNodes[0].handleIn).toBeUndefined()
  })

  it('works from the far endpoint too', () => {
    const { loopNodes, remainNodes } = connectEndpointToInterior(RUN_H, 3, 1)!
    expect(xy(loopNodes)).toEqual([[10, 0], [20, 0], [30, 0]])
    expect(xy(remainNodes)).toEqual([[0, 0], [10, 0]])
    expect(loopNodes[0].handleIn).toBeUndefined()
    expect(remainNodes[remainNodes.length - 1].handleOut).toBeUndefined()
  })

  it('refuses anything but an endpoint joined to an interior node', () => {
    expect(connectEndpointToInterior(RUN_H, 1, 2)).toBeNull()   // source is interior
    expect(connectEndpointToInterior(RUN_H, 0, 3)).toBeNull()   // target is an endpoint
    expect(connectEndpointToInterior(RUN_H, 0, 0)).toBeNull()
  })
})

describe('joinPaths', () => {
  const A = [P(0, 0), P(10, 0)]
  const B = [P(12, 5), P(20, 5)]

  it('MERGES the two junction nodes into one, at the target\'s position', () => {
    // This is the drag-weld: the two nodes were dragged together, so they become one.
    // Contrast joinPathsConnect below, which keeps both.
    expect(xy(joinPaths(A, 1, false, B, 0, false)!)).toEqual([[0, 0], [12, 5], [20, 5]])
  })

  it('takes the incoming handle from A and the outgoing one from B', () => {
    const a = [P(0, 0), P(10, 0, { handleIn: { x: 8, y: 1 } })]
    const b = [P(12, 5, { handleOut: { x: 14, y: 6 } }), P(20, 5)]
    const merged = joinPaths(a, 1, false, b, 0, false)![1]
    expect(merged).toEqual({ x: 12, y: 5, handleIn: { x: 8, y: 1 }, handleOut: { x: 14, y: 6 } })
  })

  it('reverses whichever path is facing the wrong way', () => {
    expect(xy(joinPaths(A, 0, false, B, 0, false)!)).toEqual([[10, 0], [12, 5], [20, 5]])
    expect(xy(joinPaths(A, 1, false, B, 1, false)!)).toEqual([[0, 0], [20, 5], [12, 5]])
  })

  it('opens a closed path at the join and keeps every one of its segments', () => {
    // The closing segment becomes the last segment of the combined path rather than
    // being silently dropped — the user can trim whichever seam they don't want.
    const closedB = [P(0, 10), P(10, 10), P(10, 20), P(0, 20)]
    expect(xy(joinPaths(A, 1, false, closedB, 2, true)!))
      .toEqual([[0, 0], [10, 20], [0, 20], [0, 10], [10, 10], [10, 20]])
  })

  it('refuses a closed source, a stub, or an interior target on an open path', () => {
    expect(joinPaths(A, 1, true, B, 0, false)).toBeNull()
    expect(joinPaths([P(0, 0)], 0, false, B, 0, false)).toBeNull()
    expect(joinPaths(A, 1, false, [P(0, 0), P(1, 1), P(2, 2)], 1, false)).toBeNull()
  })
})

describe('joinPathsConnect', () => {
  it('KEEPS both junction nodes — they are at different places', () => {
    // Connect-click joins two nodes the user picked without moving either, so a
    // merge would silently drag one of them onto the other.
    const A = [P(0, 0), P(10, 0)]
    const B = [P(12, 5), P(20, 5)]
    expect(xy(joinPathsConnect(A, 1, B, 0, false)!)).toEqual([[0, 0], [10, 0], [12, 5], [20, 5]])
  })

  it('refuses a stub or an interior target on an open path', () => {
    expect(joinPathsConnect([P(0, 0)], 0, [P(1, 1), P(2, 2)], 0, false)).toBeNull()
    expect(joinPathsConnect([P(0, 0), P(1, 0)], 1, [P(0, 0), P(1, 1), P(2, 2)], 1, false)).toBeNull()
  })
})

describe('endpointToMidpointWeld', () => {
  const RUN5 = [P(0, 0), P(10, 0), P(20, 0), P(30, 0), P(40, 0)]

  it('splits the path into the loop the weld makes and the tail left over', () => {
    const { loopNodes, remainNodes } = endpointToMidpointWeld(RUN5, 0, 2)!
    expect(xy(loopNodes)).toEqual([[20, 0], [10, 0]])      // the round trip, closed
    expect(xy(remainNodes)).toEqual([[20, 0], [30, 0], [40, 0]])
  })

  it('works from the far endpoint too', () => {
    const { loopNodes, remainNodes } = endpointToMidpointWeld(RUN5, 4, 2)!
    expect(xy(loopNodes)).toEqual([[20, 0], [30, 0]])
    expect(xy(remainNodes)).toEqual([[0, 0], [10, 0], [20, 0]])
  })

  it('refuses a weld that would make a loop of fewer than two nodes', () => {
    expect(endpointToMidpointWeld(RUN5, 0, 1)).toBeNull()
    expect(endpointToMidpointWeld(RUN5, 4, 3)).toBeNull()
  })

  it('refuses an interior source or an endpoint target', () => {
    expect(endpointToMidpointWeld(RUN5, 2, 1)).toBeNull()
    expect(endpointToMidpointWeld(RUN5, 0, 4)).toBeNull()
  })
})

describe('weldNodes — beyond closing a path', () => {
  it('puts the merged node at the TARGET\'s position', () => {
    // The node being dragged lands on the one it was dropped onto, not half-way.
    const { nodes } = weldNodes(RUN, 0, 2, false)
    expect(nodes[1]).toMatchObject({ x: 20, y: 0 })
    expect(nodes).toHaveLength(3)
  })

  it('keeps a closed path closed when welding two of its interior nodes', () => {
    expect(weldNodes(RUN, 1, 2, true).closed).toBe(true)
  })

  it('clears the handle left dangling by the removed endpoint', () => {
    // The node that becomes the new first/last inherits a handle from the segment
    // that no longer exists, and it would draw as an arm pointing at nothing.
    const { nodes, closed } = weldNodes(RUN_H, 0, 2, false)
    expect(closed).toBe(false)
    expect(nodes[0].handleIn).toBeUndefined()
  })
})

describe('deleteSegment', () => {
  it('opens a closed path and restarts it after the cut', () => {
    const r = deleteSegment(RUN, 1, true)
    expect(r.closed).toBe(false)
    expect(r.secondPath).toBeNull()
    expect(xy(r.nodes)).toEqual([[20, 0], [30, 0], [0, 0], [10, 0]])
  })

  it('splits an open path into two at the cut', () => {
    const r = deleteSegment(RUN, 1, false)
    expect(xy(r.nodes)).toEqual([[0, 0], [10, 0]])
    expect(xy(r.secondPath!)).toEqual([[20, 0], [30, 0]])
  })

  it('drops a stub too short to be a path', () => {
    // Cutting the first segment leaves a single node in front of it, which is not a
    // path — the remainder becomes the whole result rather than an empty first half.
    expect(xy(deleteSegment(RUN, 0, false).nodes)).toEqual([[10, 0], [20, 0], [30, 0]])
    expect(deleteSegment(RUN, 0, false).secondPath).toBeNull()
    expect(xy(deleteSegment(RUN, 2, false).nodes)).toEqual([[0, 0], [10, 0], [20, 0]])
    expect(deleteSegment(RUN, 2, false).secondPath).toBeNull()
  })

  it('clears the handles that shaped the deleted segment', () => {
    const r = deleteSegment(RUN_H, 1, false)
    expect(r.nodes[r.nodes.length - 1].handleOut).toBeUndefined()
    expect(r.secondPath![0].handleIn).toBeUndefined()
  })
})
