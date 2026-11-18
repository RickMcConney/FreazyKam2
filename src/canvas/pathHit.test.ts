import { describe, it, expect } from 'vitest'
import { closestVisiblePath } from './pathHit'
import { flattenPath } from '../cam/pathFlattener'
import { ptSegDistSq } from '../cam/geom'
import type { ImportedPath } from '../store/pathsStore'

// The box pre-filter in closestVisiblePath is a pure speed-up: these hold it to the plain
// walk over every segment of every path that it replaced.
function bruteForce(px: number, py: number, paths: ImportedPath[], threshold: number,
  getPolys: (p: ImportedPath) => [number, number][][]): ImportedPath | null {
  let best: ImportedPath | null = null
  let bestDist = threshold
  for (const p of paths) {
    let minSq = Infinity
    for (const poly of getPolys(p)) {
      for (let i = 1; i < poly.length; i++) {
        minSq = Math.min(minSq, ptSegDistSq(px, py, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]))
      }
    }
    if (Math.sqrt(minSq) < bestDist) { bestDist = Math.sqrt(minSq); best = p }
  }
  return best
}

const circle = (cx: number, cy: number, r: number) =>
  `M${cx + r} ${cy} A${r} ${r} 0 0 1 ${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy} Z`

describe('closestVisiblePath', () => {
  // A nest-like sheet: circles, overlapping rectangles, and a curve whose box is much
  // bigger than its outline, so the box test is often close and sometimes wrong-looking.
  const paths: ImportedPath[] = []
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 60; i++) {
    const x = rnd() * 200, y = rnd() * 200
    const d = i % 3 === 0 ? circle(x, y, 1 + rnd() * 10)
      : i % 3 === 1 ? `M${x} ${y} L${x + rnd() * 30} ${y} L${x + rnd() * 30} ${y + rnd() * 30} L${x} ${y + rnd() * 20} Z`
      : `M${x} ${y} C${x + 40} ${y + 60} ${x - 30} ${y + 50} ${x + 20} ${y}`
    paths.push({ id: 'p' + i, name: 'p' + i, d, visible: true, color: '#000' } as ImportedPath)
  }
  const tol = 0.05
  const flat = new Map<ImportedPath, [number, number][][]>()
  const getPolys = (p: ImportedPath) => { let f = flat.get(p); if (!f) { f = flattenPath(p.d, tol); flat.set(p, f) } return f }

  it('picks exactly the path the full walk picks, at 2000 points over the sheet and its edges', () => {
    for (let k = 0; k < 2000; k++) {
      const px = -20 + rnd() * 260, py = -20 + rnd() * 260
      for (const threshold of [0.5, 3, 50]) {
        expect(closestVisiblePath(px, py, paths, threshold, getPolys)?.id)
          .toBe(bruteForce(px, py, paths, threshold, getPolys)?.id)
      }
    }
  })

  it('picks the same path for points lying exactly on an outline', () => {
    for (const p of paths.slice(0, 20)) {
      const [x, y] = getPolys(p)[0][0]
      expect(closestVisiblePath(x, y, paths, 1, getPolys)?.id).toBe(bruteForce(x, y, paths, 1, getPolys)?.id)
    }
  })

  it('never flattens a path whose box is out of reach', () => {
    const asked = new Set<string>()
    const counting = (p: ImportedPath) => { asked.add(p.id); return getPolys(p) }
    const far = { id: 'far', name: 'far', d: circle(1000, 1000, 5), visible: true, color: '#000' } as ImportedPath
    const near = { id: 'near', name: 'near', d: circle(0, 0, 5), visible: true, color: '#000' } as ImportedPath
    expect(closestVisiblePath(5, 0.2, [far, near], 1, counting)?.id).toBe('near')
    expect(asked.has('far')).toBe(false)
  })
})
