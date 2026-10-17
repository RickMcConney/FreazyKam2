import { describe, it, expect } from 'vitest'
import { parseGcode } from './gcodeParser'
import { findRapidGouges } from './rapidGouge'
import { Heightfield } from './heightfield'

// 100 × 100 × 10 stock, origin at its bottom-left corner, Z0 the stock top. A 6 mm end mill.
const STOCK = { widthMM: 100, heightMM: 100, thicknessMM: 10, orgX: 0, orgY: 0 }
const TOOL = '; Tool: 6mm End Mill  dia 6.000mm  flutes:2'
const gouges = (...lines: string[]) => {
  const p = parseGcode([TOOL, ...lines].join('\n'), 5)
  return findRapidGouges(p.segments, p.toolStates, STOCK).map((g) => ({ line: g.lineIdx, depth: +g.depthMM.toFixed(2) }))
}
// A slot along y = 50 from x = 20 to x = 80, 3 mm deep, entered and left at safe height.
const SLOT = ['G0 X20 Y50 Z5', 'G1 Z-3 F300', 'G1 X80 F1000', 'G0 Z5']

describe('findRapidGouges — G0 moves that cut into the stock', () => {
  it('flags a rapid plunge into uncut stock, with how deep it went', () => {
    expect(gouges('G0 X50 Y20 Z5', 'G0 Z-2', 'G1 Z-3 F300')).toEqual([{ line: 2, depth: 2 }])
  })

  it('flags a rapid moving sideways through stock at depth', () => {
    expect(gouges(...SLOT, 'G0 X20 Y50 Z-1', 'G0 X20 Y20 Z-1')).toEqual([{ line: 6, depth: 1 }])
  })

  it('leaves alone rapids above the stock, however low they come over it', () => {
    expect(gouges('G0 X10 Y10 Z5', 'G0 X90 Y90 Z0.1', 'G0 Z0')).toEqual([])
  })

  it('leaves alone a stay-down link riding over floor the program has already cut', () => {
    expect(gouges(...SLOT.slice(0, 3), 'G0 Z-2.5', 'G0 X20 Y50 Z-2.5', 'G1 Z-3 F300')).toEqual([])
  })

  it('does not count a plunge into a cleared slot that grazes its wall by less than the grid can place', () => {
    // 0.15 mm off the line the slot was cut on: the rim reaches that far into the wall, and
    // the carve's coverage margin a cell further — which, measured as the most removed from
    // one cell, read as the whole 3 mm wall.
    expect(gouges(...SLOT, 'G0 X60 Y50.15 Z5', 'G0 Z-3')).toEqual([])
  })

  it('still counts one that goes into the wall by more than that', () => {
    expect(gouges(...SLOT, 'G0 X60 Y52 Z5', 'G0 Z-3')).toEqual([{ line: 6, depth: 3 }])
  })

  it('judges a rapid against what the program cut BEFORE it, not after', () => {
    // The same rapid is clear once the slot exists, and flagged when it comes first.
    expect(gouges('G0 X50 Y50 Z5', 'G0 Z-2.5', 'G0 Z5', ...SLOT)).toEqual([{ line: 2, depth: 2.5 }])
  })

  it('carves a rapid that cut AT ITS REAL SIZE, so a second one inside its footprint is clear', () => {
    // 0.4 mm over: inside what the first one's 6 mm cut, outside the slimmer tool it is judged with.
    expect(gouges('G0 X50 Y20 Z5', 'G0 Z-2', 'G0 Z5', 'G0 X50.4', 'G0 Z-2')).toEqual([{ line: 2, depth: 2 }])
  })

  it('judges a V-bit by its cone: a rapid in the V-groove it cut is clear, one beside it is not', () => {
    const v = ['; Tool: 60 V  dia 12.000mm  flutes:2', '; vbit-angle:30.000']
    const run = (...l: string[]) => {
      const p = parseGcode([...v, ...l].join('\n'), 5)
      return findRapidGouges(p.segments, p.toolStates, STOCK).map((g) => g.lineIdx)
    }
    const groove = ['G0 X20 Y50 Z5', 'G1 Z-3 F300', 'G1 X80 F1000']
    expect(run(...groove, 'G0 Z-2.5', 'G0 X20 Z-2.5')).toEqual([])
    expect(run(...groove, 'G0 Z5', 'G0 X20 Y60', 'G0 Z-2.5')).toEqual([7])
  })
})

describe('Heightfield.carve marks — which surface a rapid left, as the 3D view draws it red', () => {
  const field = () => new Heightfield({ NX: 101, NY: 101, sx: 0.5, sy: 0.5, gx0: 0, gy0: 0, T: 10, orgX: 0, orgY: 0 })
  const at = (hf: Heightfield, x: number, y: number) => Math.round(y / hf.sy) * hf.NX + Math.round(x / hf.sx)
  const end = (hf: Heightfield, mark: Uint8Array, x: number, y: number, z: number, value: number) =>
    hf.carve(x, y, x, y, 5, z, undefined, false, 6, 0, 0, mark, value)

  it('marks what a rapid lowers, and only that', () => {
    const hf = field(), mark = new Uint8Array(hf.NX * hf.NY)
    end(hf, mark, 25, 25, -2, 255)
    expect(mark[at(hf, 25, 25)]).toBe(255)
    expect(mark[at(hf, 40, 40)]).toBe(0)
  })

  it('clears the mark where a later cut goes deeper — that stock was going anyway', () => {
    const hf = field(), mark = new Uint8Array(hf.NX * hf.NY)
    end(hf, mark, 25, 25, -2, 255)
    end(hf, mark, 25, 25, -3, 0)
    expect(mark[at(hf, 25, 25)]).toBe(0)
  })

  it('clears it where a later cut reaches the SAME surface — a pocket pass cutting the floor a rapid got to first', () => {
    const hf = field(), mark = new Uint8Array(hf.NX * hf.NY)
    end(hf, mark, 25, 25, -3, 255)
    end(hf, mark, 25, 25, -3, 0)
    expect(mark[at(hf, 25, 25)]).toBe(0)
  })

  it('keeps it where nothing later reaches below the rapid — damage the part keeps', () => {
    const hf = field(), mark = new Uint8Array(hf.NX * hf.NY)
    end(hf, mark, 25, 25, -2, 255)
    end(hf, mark, 25, 25, -1, 0)
    expect(mark[at(hf, 25, 25)]).toBe(255)
  })
})
