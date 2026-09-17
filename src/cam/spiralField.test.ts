import { describe, it, expect } from 'vitest'
import { fieldCellFor, MAX_FIELD_CELLS } from './spiralField'

// Same sizing as solveField's gridAt: one-cell margin each side plus the closing node.
const cellsAt = (spanX: number, spanY: number, c: number) =>
  (Math.ceil(spanX / c) + 3) * (Math.ceil(spanY / c) + 3)

describe('fieldCellFor', () => {
  it('solves an ordinary pocket at exactly the requested cell', () => {
    // 300 × 200 mm at the 0.25 mm floor is ~962k cells — well inside the budget, so the
    // morph field must come out byte-identical to before the budget existed.
    expect(fieldCellFor(300, 200, 0.25)).toBe(0.25)
  })

  it('coarsens a full sheet with a small tool until the finest grid fits the cell budget', () => {
    // 2440 × 1220 mm with a 2 mm tool (cell 0.25) is 47.6 million cells uncapped.
    expect(cellsAt(2440, 1220, 0.25)).toBeGreaterThan(MAX_FIELD_CELLS)
    const c = fieldCellFor(2440, 1220, 0.25)
    expect(c).toBeGreaterThan(0.25)
    expect(cellsAt(2440, 1220, c)).toBeLessThanOrEqual(MAX_FIELD_CELLS)
  })

  it('coarsens no further than one 1.4× step past the budget', () => {
    const c = fieldCellFor(2440, 1220, 0.25)
    expect(cellsAt(2440, 1220, c / 1.4)).toBeGreaterThan(MAX_FIELD_CELLS)
  })
})
