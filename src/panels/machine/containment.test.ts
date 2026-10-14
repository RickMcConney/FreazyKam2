import { describe, it, expect } from 'vitest'
import { groupPathsByContainment, skipOpenPaths, isOpenPath } from './containment'
import type { ImportedPath } from '../../store/pathsStore'

const mk = (id: string, d: string): ImportedPath =>
  ({ id, name: id, d, visible: true, color: '#fff' } as ImportedPath)

// The two shapes from scratch/vcarveerror.fkam: a path and its 3 mm inward offset,
// selected together and V-carved. Both are boundary + island; only the second one was
// grouped that way before, because containment used the vertex-mean centroid.
const W_OUTER = 'M 110 220 L 135 150 L 165 150 L 175 210 L 200 210 L 210 150 L 240 150 L 250 235 Z'
const W_INNER = 'M 162.4586 153 L 172.4586 213 L 202.5414 213 L 212.5414 153 L 237.3323 153 ' +
                'L 246.5813 231.6165 L 114.1060 217.4228 L 137.1142 153 Z'
const QUAD_OUTER = 'M 136 128 L 136 78 L 214 78 L 214 130 Z'
const QUAD_INNER = 'M 211 81 L 211 126.9221 L 139 125.0759 L 139 81 Z'

describe('groupPathsByContainment', () => {
  // Regression: the W's vertex mean lands at (185.6, 185.9), in the notch under the
  // middle peak — outside the W — so the nested offset read as a second boundary and
  // got its own V-carve instead of becoming the island that bounds the first.
  it('nests a path inside a concave (W-shaped) parent', () => {
    const groups = groupPathsByContainment([mk('outer', W_OUTER), mk('inner', W_INNER)])
    expect(groups).toHaveLength(1)
    expect(groups[0].boundary.id).toBe('outer')
    expect(groups[0].islands.map((p) => p.id)).toEqual(['inner'])
  })

  it('nests a path inside a convex parent', () => {
    const groups = groupPathsByContainment([mk('outer', QUAD_OUTER), mk('inner', QUAD_INNER)])
    expect(groups).toHaveLength(1)
    expect(groups[0].boundary.id).toBe('outer')
    expect(groups[0].islands.map((p) => p.id)).toEqual(['inner'])
  })

  it('keeps two disjoint shapes as separate boundaries when selected together', () => {
    const groups = groupPathsByContainment([
      mk('w', W_OUTER), mk('w-in', W_INNER), mk('q', QUAD_OUTER), mk('q-in', QUAD_INNER),
    ])
    expect(groups.map((g) => [g.boundary.id, g.islands.map((p) => p.id)]))
      .toEqual([['w', ['w-in']], ['q', ['q-in']]])
  })

  // Four concentric rectangles, the shape of scratch/pocketerror.fkam. Even-odd: the
  // outermost region is solid, the next in is a hole, the one inside that is solid again.
  // Regression: only depth-0 paths were returned as boundaries, so this produced ONE group
  // (r0 with island r1) and dropped r2 and r3 on the floor.
  const rect = (i: number, s: number): ImportedPath =>
    mk(`r${i}`, `M ${-s} ${-s} L ${s} ${-s} L ${s} ${s} L ${-s} ${s} Z`)
  const nest = [rect(0, 40), rect(1, 30), rect(2, 20), rect(3, 10)]

  it('alternates levels of a nested selection, outermost solid', () => {
    expect(groupPathsByContainment(nest).map((g) => [g.boundary.id, g.islands.map((p) => p.id)]))
      .toEqual([['r0', ['r1']], ['r2', ['r3']]])
  })

  it('inverts to the levels the default reading treats as holes', () => {
    expect(groupPathsByContainment(nest, { invert: true }).map((g) => [g.boundary.id, g.islands.map((p) => p.id)]))
      .toEqual([['r1', ['r2']], ['r3', []]])
  })

  it('inverting an un-nested selection yields nothing to machine', () => {
    // Every path is depth 0, so there is no alternate level — the form keeps the toggle
    // visible rather than leaving the user stranded with no operations.
    expect(groupPathsByContainment([rect(0, 40)], { invert: true })).toEqual([])
    const disjoint = [mk('a', 'M 0 0 L 10 0 L 10 10 L 0 10 Z'), mk('b', 'M 50 0 L 60 0 L 60 10 L 50 10 Z')]
    expect(groupPathsByContainment(disjoint, { invert: true })).toEqual([])
  })

  it('alternates independently down each branch of the tree', () => {
    // r0 ⊃ {r1 ⊃ r2, sibling}: the sibling is depth 1, so it is r0's island and not a
    // boundary, while r2 at depth 2 is a boundary in its own right.
    const sibling = mk('sib', 'M 25 25 L 35 25 L 35 35 L 25 35 Z')
    const groups = groupPathsByContainment([rect(0, 40), rect(1, 30), rect(2, 20), sibling])
    expect(groups.map((g) => [g.boundary.id, g.islands.map((p) => p.id)]))
      .toEqual([['r0', ['r1', 'sib']], ['r2', []]])
  })

  it('does not nest side-by-side shapes that merely overlap bboxes', () => {
    // Two overlapping squares: neither bbox contains the other, so neither is an island.
    const a = mk('a', 'M 0 0 L 40 0 L 40 40 L 0 40 Z')
    const b = mk('b', 'M 20 20 L 60 20 L 60 60 L 20 60 Z')
    expect(groupPathsByContainment([a, b]).map((g) => g.boundary.id)).toEqual(['a', 'b'])
  })
})

// A sheet of parts, each with a single-stroke label inside it: the everyday mixed selection.
const PART_A = 'M 0 0 L 50 0 L 50 30 L 0 30 Z'
const LABEL_A = 'M 10 10 L 20 20 L 30 10'
const PART_B = 'M 60 0 L 110 0 L 110 30 L 60 30 Z'
const LABEL_B = 'M 70 10 L 90 10'

describe('skipOpenPaths', () => {
  it('reads a path as open when any drawn subpath has ends that do not meet', () => {
    expect(isOpenPath(mk('a', PART_A))).toBe(false)
    expect(isOpenPath(mk('l', LABEL_A))).toBe(true)
    expect(isOpenPath(mk('mixed', `${PART_A} ${LABEL_A}`))).toBe(true)
  })

  it('drops the open labels from a mixed selection and counts them', () => {
    const { closed, skipped } = skipOpenPaths([
      mk('a', PART_A), mk('la', LABEL_A), mk('b', PART_B), mk('lb', LABEL_B),
    ])
    expect(closed.map((p) => p.id)).toEqual(['a', 'b'])
    expect(skipped).toBe(2)
  })

  // Without the skip, the label groups as an island of its part and the pocket refuses it.
  it('leaves each part a boundary with no open island once the labels are skipped', () => {
    const { closed } = skipOpenPaths([mk('a', PART_A), mk('la', LABEL_A), mk('b', PART_B), mk('lb', LABEL_B)])
    expect(groupPathsByContainment(closed).map((g) => [g.boundary.id, g.islands.length]))
      .toEqual([['a', 0], ['b', 0]])
  })

  it('returns an all-open selection whole so the cut can say why it refuses', () => {
    const { closed, skipped } = skipOpenPaths([mk('la', LABEL_A), mk('lb', LABEL_B)])
    expect(closed.map((p) => p.id)).toEqual(['la', 'lb'])
    expect(skipped).toBe(0)
  })
})
