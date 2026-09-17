import { describe, it, expect } from 'vitest'
import { parsePaths, remapForPaste, serializePaths, type ClipboardPayload } from './pathClipboard'
import type { ImportedPath } from '../importers/svgImporter'
import type { Tab } from '../store/tabStore'

const path = (p: Partial<ImportedPath> & { id: string }): ImportedPath => ({
  name: p.id, d: 'M0,0 L10,0 L10,10 Z', visible: true, color: '#888', ...p,
})

const payloadOf = (paths: ImportedPath[], tabs: Tab[] = []): ClipboardPayload =>
  parsePaths(serializePaths(paths, tabs))!

describe('the path clipboard', () => {
  it('only recognises its own text', () => {
    expect(parsePaths('')).toBeNull()
    expect(parsePaths('M0,0 L10,10')).toBeNull()
    expect(parsePaths('{"kind":"something/else","paths":[]}')).toBeNull()
    expect(parsePaths('{ not json')).toBeNull()
    // …and a payload with nothing in it is nothing to paste.
    expect(parsePaths(serializePaths([], []))).toBeNull()
    expect(parsePaths(serializePaths([path({ id: 'a' })], []))).not.toBeNull()
  })

  // Every id is reissued — a paste is a new object even when the original is
  // still in the document — and nothing carried in from another project can
  // collide with what is already here.
  it('reissues every path id', () => {
    const { paths } = remapForPaste(payloadOf([path({ id: 'a' }), path({ id: 'b' })]), new Set())
    expect(paths.map((p) => p.id)).not.toContain('a')
    expect(paths.map((p) => p.id)).not.toContain('b')
    expect(new Set(paths.map((p) => p.id)).size).toBe(2)
  })

  // THE POINT OF THE FEATURE: what was shared must go on being shared, or a
  // pasted gear arrives as three unrelated paths that no longer regenerate
  // together — and a pasted clock as loose wheels that are no longer one clock.
  it('keeps a group a group, and a clock a clock', () => {
    const gear = ['teeth', 'bore', 'spokes'].map((part) => path({
      id: `g-${part}`, groupId: 'grp', groupName: 'Gear', shapePart: part,
      clockId: 'clk', clockPart: 'great', userGroups: ['outer', 'inner'],
    }))
    const { paths } = remapForPaste(payloadOf(gear), new Set())
    const [a, b, c] = paths
    expect(a.groupId).toBe(b.groupId)
    expect(b.groupId).toBe(c.groupId)
    expect(a.groupId).not.toBe('grp')
    expect(a.clockId).toBe(b.clockId)
    expect(a.clockId).not.toBe('clk')
    // A user group is a CHAIN, and every level is remapped — consistently, and
    // never onto each other.
    expect(a.userGroups).toEqual(b.userGroups)
    expect(a.userGroups).toHaveLength(2)
    expect(a.userGroups).not.toContain('outer')
    expect(a.userGroups![0]).not.toBe(a.userGroups![1])
    // What is not an id is carried through untouched.
    expect(paths.map((p) => p.shapePart)).toEqual(['teeth', 'bore', 'spokes'])
    expect(a.groupName).toBe('Gear')
  })

  // Provenance only survives if what it came from came too: a form reopens over
  // its SOURCES, and with those left behind the chip is a lie. The geometry is
  // still good — it just stops claiming it can be regenerated.
  it('keeps a definition only when its sources were copied too', () => {
    const src = path({ id: 'src' })
    const copy = path({
      id: 'pat',
      definition: { id: 'd1', kind: 'pattern', sourceIds: ['src'], params: { type: 'linear', rows: 1, cols: 2, xSpacingMM: 10, ySpacingMM: 0 } },
    })
    const withSource = remapForPaste(payloadOf([src, copy]), new Set()).paths
    const def = withSource[1].definition
    expect(def?.kind).toBe('pattern')
    expect(def?.id).not.toBe('d1')
    // …and it names the pasted source, not the one left behind.
    if (def?.kind !== 'pattern') throw new Error('lost the definition')
    expect(def.sourceIds).toEqual([withSource[0].id])

    const alone = remapForPaste(payloadOf([copy]), new Set()).paths
    expect(alone[0].definition).toBeUndefined()
    expect(alone[0].d).toBe(copy.d)          // the geometry is untouched
  })

  // Pasting back into the project it was copied from nudges the copy clear —
  // landing exactly on the original looks like nothing happened. Into ANOTHER
  // project it lands where it was drawn, which is where it belongs on the stock.
  it('offsets a paste back into the same project, and only that', () => {
    const p = path({ id: 'a', shapeParams: { type: 'circle', cx: 10, cy: 10, radius: 5 } })
    const same = remapForPaste(payloadOf([p]), new Set(['a'])).paths[0]
    expect(same.d).not.toBe(p.d)
    // The params move WITH the geometry, or the next spinner step puts the copy
    // back on top of the original.
    if (same.shapeParams?.type !== 'circle') throw new Error('lost the params')
    expect(same.shapeParams.cx).toBe(15)
    expect(same.shapeParams.cy).toBe(15)

    const elsewhere = remapForPaste(payloadOf([p]), new Set(['other'])).paths[0]
    expect(elsewhere.d).toBe(p.d)
    if (elsewhere.shapeParams?.type !== 'circle') throw new Error('lost the params')
    expect(elsewhere.shapeParams.cx).toBe(10)
  })

  // A corner treatment is a recipe over an untreated outline, so BOTH have to
  // move — otherwise the copy's radii re-cut corners at the original's position.
  it('moves a corner recipe with the geometry', () => {
    const p = path({ id: 'a', corners: { baseD: 'M0,0 L10,0 L10,10 Z', treatments: [[0, { type: 'chamfer', radiusMM: 2 }]] } })
    const moved = remapForPaste(payloadOf([p]), new Set(['a'])).paths[0]
    expect(moved.corners!.baseD).not.toBe(p.corners!.baseD)
    expect(moved.corners!.treatments).toEqual(p.corners!.treatments)
  })

  // Tabs belong TO a path and reference nothing else, so they travel with it —
  // repointed at the pasted path, with ids of their own.
  it('carries holding tabs, repointed at the pasted path', () => {
    const p = path({ id: 'a' })
    const tabs: Tab[] = [
      { id: 't1', pathId: 'a', t: 0.25, lengthMM: 6, heightMM: 2 },
      { id: 't2', pathId: 'elsewhere', t: 0.5, lengthMM: 6, heightMM: 2 },
    ]
    // The one on another path never made it onto the clipboard…
    const payload = payloadOf([p], tabs)
    expect(payload.tabs).toHaveLength(1)
    const out = remapForPaste(payload, new Set())
    expect(out.tabs).toHaveLength(1)
    expect(out.tabs[0].pathId).toBe(out.paths[0].id)
    expect(out.tabs[0].id).not.toBe('t1')
    expect(out.tabs[0].t).toBe(0.25)
  })
})
