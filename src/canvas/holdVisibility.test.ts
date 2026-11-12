import { describe, it, expect } from 'vitest'
import { cutHiddenPathIds, partsOut, stripsShown } from './holdVisibility'
import { buildHoldIndex } from '../cam/bridgePick'
import { OVERLAP_MM } from '../cam/bridges'
import type { AnyOperation } from '../store/toolpathStore'
import type { ImportedPath } from '../store/pathsStore'

const op = (pathId: string, visible: boolean, type = 'profile') => ({ id: `${pathId}-${type}-${visible}`, type, pathId, visible }) as unknown as AnyOperation
const rect = (x: number, y: number, w: number, h: number) => `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
const path = (id: string, d: string, visible = true) => ({ id, name: id, d, color: '#000', visible }) as ImportedPath

describe('which parts are out — nothing left on show for a tab or strip to hold', () => {
  it('counts a part whose every profile is hidden from the program', () => {
    expect(cutHiddenPathIds([op('a', false), op('a', false, 'trochoidal'), op('b', true)])).toEqual(['a'])
  })

  it('keeps a part with one profile still shown, and one not profiled at all', () => {
    expect(cutHiddenPathIds([op('a', false), op('a', true)])).toEqual([])
    expect(cutHiddenPathIds([op('a', false, 'pocket')])).toEqual([])
  })

  it('counts a part whose path is hidden, whatever its toolpaths', () => {
    const out = partsOut([path('a', rect(0, 0, 10, 10), false), path('b', rect(20, 0, 10, 10))], '')
    expect([...out]).toEqual(['a'])
  })
})

describe('which strips are drawn', () => {
  // A | gap | B, a strip across the gap; and a stub from B out into open stock.
  const A = path('A', rect(10, 10, 60, 60)), B = path('B', rect(76, 10, 60, 60))
  const ix = buildHoldIndex([A, B], { widthMM: 300, heightMM: 100 })
  const across = { x1: 70 - OVERLAP_MM, y1: 40, x2: 76 + OVERLAP_MM, y2: 40 }
  const stub = { x1: 136 - OVERLAP_MM, y1: 40, x2: 156, y2: 40 }

  it('keeps a strip between a part that is out and one still on show', () => {
    expect(stripsShown([across], ix, new Set(['A']))).toEqual([true])
  })

  it('drops a strip once every part it touches is out', () => {
    expect(stripsShown([across], ix, new Set(['A', 'B']))).toEqual([false])
  })

  it('drops a stub into open stock with its one part — the edge of the sheet is not a part', () => {
    expect(stripsShown([across, stub], ix, new Set(['B']))).toEqual([true, false])
  })
})
