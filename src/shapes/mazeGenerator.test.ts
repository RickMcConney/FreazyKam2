import { describe, it, expect } from 'vitest'
import { generateMazeD, mazeGrid } from './mazeGenerator'
import { generateShapeD } from './shapeGenerators'
import { flattenPath } from '../cam/pathFlattener'
import { getBBox } from '../canvas/selectionUtils'

const base = { x: 10, y: 20, w: 150, h: 120, spacing: 12, corner: 4, seed: 1, loops: 0 }

// Walk the emitted geometry back into the corridor graph it stands for. Only
// valid with corner=0: with fillets on, a turn's vertices sit off the grid.
// Straight runs are collapsed into one segment, so each is expanded again.
function graphOf(p: typeof base) {
  const g = mazeGrid(p.w, p.h, p.spacing)
  const polys = flattenPath(generateMazeD({ ...p, corner: 0 }), 0.05)
  const cells = new Set<number>()
  const links = new Map<string, number>()
  let offGrid = 0
  for (const poly of polys) {
    let prev: number | null = null
    for (const [x, y] of poly) {
      const i = Math.round((x - p.x) / g.dx), j = Math.round((y - p.y) / g.dy)
      // The lead-in and lead-out run one pitch OUTSIDE the grid — not corridors,
      // so they break the chain rather than inventing a cell and a link.
      if (j < 0 || j >= g.rows) { prev = null; continue }
      if (Math.abs(p.x + i * g.dx - x) > 1e-6 || Math.abs(p.y + j * g.dy - y) > 1e-6) offGrid++
      const n = j * g.cols + i
      cells.add(n)
      if (prev !== null && prev !== n) {
        const pi = prev % g.cols, pj = (prev - pi) / g.cols
        const step = pj === j ? Math.sign(i - pi) : Math.sign(j - pj) * g.cols
        for (let a: number = prev; a !== n; a += step) {
          const b = a + step
          cells.add(a); cells.add(b)
          const k = a < b ? `${a}-${b}` : `${b}-${a}`
          links.set(k, (links.get(k) ?? 0) + 1)
        }
      }
      prev = n
    }
  }
  return { g, cells, links, offGrid, trails: polys.length }
}

// Ends of the emitted geometry that touch nothing else — a groove that simply
// stops. `head` says which end of `polys[a]` this is, so its own first (or last)
// segment is not counted as something it touches; with braiding a trail can pass
// through the same cell twice, so the corridor an end joins may be its own.
function freeEnds(polys: number[][][]): number[][] {
  const out: number[][] = []
  for (let a = 0; a < polys.length; a++) {
    for (const head of [true, false]) {
      const e = head ? polys[a][0] : polys[a][polys[a].length - 1]
      let best = Infinity
      for (let b = 0; b < polys.length; b++) {
        for (let k = 1; k < polys[b].length; k++) {
          if (b === a && (head ? k <= 2 : k >= polys[b].length - 2)) continue
          const [x1, y1] = polys[b][k - 1], [x2, y2] = polys[b][k]
          const vx = x2 - x1, vy = y2 - y1
          const L2 = vx * vx + vy * vy
          const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((e[0] - x1) * vx + (e[1] - y1) * vy) / L2))
          best = Math.min(best, Math.hypot(e[0] - (x1 + t * vx), e[1] - (y1 + t * vy)))
        }
      }
      if (best > 0.05) out.push(e)
    }
  }
  return out
}

describe('mazeGrid', () => {
  it('rounds the pitch UP from the requested spacing, never down', () => {
    // Thin walls are the failure that breaks the part, so the pitch may only
    // ever err coarse.
    for (const w of [50, 97.3, 150, 301]) {
      for (const s of [3, 7.5, 12, 25.4]) {
        const g = mazeGrid(w, w, s)
        expect(g.dx, `${w}mm at ${s}mm spacing`).toBeGreaterThanOrEqual(s - 1e-9)
      }
    }
  })

  it('caps the cell count by coarsening, never by cropping', () => {
    const g = mazeGrid(1200, 1200, 0.5)
    expect(g.cols * g.rows).toBeLessThanOrEqual(6000)
    expect(g.dx).toBeGreaterThan(0.5)
    expect(g.dx * (g.cols - 1)).toBeCloseTo(1200, 6)   // still spans the full size
  })

  it('always has at least a 2×2 grid', () => {
    const g = mazeGrid(5, 5, 50)
    expect(g.cols).toBe(2)
    expect(g.rows).toBe(2)
  })
})

describe('generateMazeD', () => {
  it('stays one connected tree, with each corridor cut exactly once', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const { g, cells, links, offGrid } = graphOf({ ...base, seed })
      // Trimming border dead ends takes leaves off the spanning tree, so some
      // cells lose their groove — but what is left is still a TREE over the
      // cells it reaches (N cells, N−1 corridors: connected and acyclic), which
      // is what keeps exactly one route from the entrance to the exit.
      expect(links.size, `seed ${seed}`).toBe(cells.size - 1)
      // …and no trail may retrace one (that would be air-cutting an open groove).
      expect([...links.values()].every((v) => v === 1), `seed ${seed}`).toBe(true)
      // Trimming may not eat the maze: it only ever walks in from the border.
      expect(cells.size / (g.cols * g.rows), `seed ${seed}`).toBeGreaterThan(0.75)
      expect(offGrid).toBe(0)
    }
  })

  it('opens the border in exactly two places, one lead in and one lead out', () => {
    // A dead end on a border cell reaches the boundary line and stops, which
    // reads as a way in; a maze with nine of them has no start and no end.
    for (const loops of [0, 0.6]) {
      for (const seed of [1, 2, 3, 7, 42, 1234, 99999]) {
        const p = { ...base, seed, loops }
        const polys = flattenPath(generateMazeD(p), 0.02) as number[][][]
        const free = freeEnds(polys)
        const above = free.filter((e) => e[1] > p.y + p.h + 1e-6)
        const below = free.filter((e) => e[1] < p.y - 1e-6)
        const onEdge = free.filter((e) =>
          Math.abs(e[0] - p.x) < 1e-6 || Math.abs(e[0] - (p.x + p.w)) < 1e-6 ||
          Math.abs(e[1] - p.y) < 1e-6 || Math.abs(e[1] - (p.y + p.h)) < 1e-6)
        expect(above.length, `seed ${seed} loops ${loops}`).toBe(1)
        expect(below.length, `seed ${seed} loops ${loops}`).toBe(1)
        expect(onEdge, `seed ${seed} loops ${loops}`).toEqual([])
        // Every other free end is a dead end well inside the maze.
        expect(free.length).toBeGreaterThan(2)
      }
    }
  })

  it('runs each lead a full grid pitch clear of the maze', () => {
    // Half a corridor of overhang would read as a fillet, not as a way in.
    const g = mazeGrid(base.w, base.h, base.spacing)
    const polys = flattenPath(generateMazeD(base), 0.02) as number[][][]
    const free = freeEnds(polys)
    const above = free.find((e) => e[1] > base.y + base.h + 1e-6)!
    const below = free.find((e) => e[1] < base.y - 1e-6)!
    expect(above[1]).toBeCloseTo(base.y + base.h + g.dy, 6)
    expect(below[1]).toBeCloseTo(base.y - g.dy, 6)
    // …and both leave from a cell centre, not from between two corridors.
    for (const e of [above, below]) {
      const i = (e[0] - base.x) / g.dx
      expect(Math.abs(i - Math.round(i))).toBeLessThan(1e-6)
    }
  })

  it('braiding adds corridors and strands fewer cells, never more', () => {
    // Braiding reopens dead ends, and a dead end that no longer exists is one
    // fewer to trim off the border — so a braided maze reaches at least as much
    // of the grid as the plain one, never less.
    const plain = graphOf(base)
    const braided = graphOf({ ...base, loops: 0.6 })
    expect(braided.cells.size).toBeGreaterThanOrEqual(plain.cells.size)
    expect(braided.links.size).toBeGreaterThan(plain.links.size)
    expect([...braided.links.values()].every((v) => v === 1)).toBe(true)
  })

  it('is a pure function of the seed', () => {
    expect(generateMazeD(base)).toBe(generateMazeD({ ...base }))
    expect(generateMazeD({ ...base, seed: 2 })).not.toBe(generateMazeD(base))
  })

  it('spans exactly x..x+w, and overhangs y..y+h by the two leads alone', () => {
    // The drag box IS the maze extent — shapeParamsFromDrag depends on it — so
    // the corridors fill it exactly. The leads are the one thing outside it:
    // they run off the top and bottom edges by a pitch, and nothing else does.
    const g = mazeGrid(base.w, base.h, base.spacing)
    const b = getBBox(generateMazeD({ ...base, corner: 0 }))!
    expect(b.minX).toBeCloseTo(base.x, 6)
    expect(b.maxX).toBeCloseTo(base.x + base.w, 6)
    expect(b.minY).toBeCloseTo(base.y - g.dy, 6)
    expect(b.maxY).toBeCloseTo(base.y + base.h + g.dy, 6)
  })

  it('every branch end meets the corridor it joins', () => {
    // A filleted turn leaves the junction a tangent length short, so a branch
    // that merely stopped at the cell centre would end `corner` mm from the arc
    // — a gap the ball only grazes, leaving a ridge across the branch mouth.
    // The only ends allowed to stand free are real dead ends.
    for (const corner of [2, 4, 6]) {
      for (const seed of [1, 7, 42]) {
        const p = { ...base, corner, seed }
        const polys = flattenPath(generateMazeD(p), 0.02)
        const g = mazeGrid(p.w, p.h, p.spacing)
        // Cell degree, straight off the reconstructed graph.
        const deg = new Map<string, number>()
        for (const k of graphOf(p).links.keys())
          for (const n of k.split('-')) deg.set(n, (deg.get(n) ?? 0) + 1)
        expect([...deg.values()].filter((v) => v === 1).length).toBeGreaterThan(0)

        for (let a = 0; a < polys.length; a++) {
          for (const end of [polys[a][0], polys[a][polys[a].length - 1]]) {
            // The lead-in and lead-out end in mid air on purpose.
            if (end[1] > p.y + p.h + 1e-6 || end[1] < p.y - 1e-6) continue
            const i = Math.round((end[0] - p.x) / g.dx)
            const j = Math.round((end[1] - p.y) / g.dy)
            const onCentre = Math.hypot(p.x + i * g.dx - end[0], p.y + j * g.dy - end[1]) < 1e-6
            if (onCentre && deg.get(String(j * g.cols + i)) === 1) continue  // real dead end
            let best = Infinity
            for (let b = 0; b < polys.length; b++) {
              if (b === a) continue
              for (let k = 1; k < polys[b].length; k++) {
                const [x1, y1] = polys[b][k - 1], [x2, y2] = polys[b][k]
                const vx = x2 - x1, vy = y2 - y1
                const L2 = vx * vx + vy * vy
                const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((end[0] - x1) * vx + (end[1] - y1) * vy) / L2))
                best = Math.min(best, Math.hypot(end[0] - (x1 + t * vx), end[1] - (y1 + t * vy)))
              }
            }
            // Flattening tolerance is 0.02, so touching reads as ~0.
            expect(best, `corner=${corner} seed=${seed} end ${end}`).toBeLessThan(0.05)
          }
        }
      }
    }
  })

  it('emits open subpaths — it is a skeleton, not an outline', () => {
    expect(generateMazeD(base)).not.toMatch(/Z/)
  })

  it('never fillets wider than half the pitch', () => {
    // A bigger arc would swing the centreline into the neighbouring corridor
    // and cut through the wall between them.
    const g = mazeGrid(base.w, base.h, base.spacing)
    const cap = Math.min(g.dx, g.dy) / 2
    const d = generateMazeD({ ...base, corner: 500 })
    const radii = [...d.matchAll(/A([\d.]+),/g)].map((m) => parseFloat(m[1]))
    expect(radii.length).toBeGreaterThan(0)
    expect(Math.max(...radii)).toBeLessThanOrEqual(cap + 1e-9)
  })

  it('is reachable through generateShapeD', () => {
    expect(generateShapeD({ type: 'maze', ...base })).toBe(generateMazeD(base))
  })
})
