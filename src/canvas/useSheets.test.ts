import { describe, it, expect } from 'vitest'
import { simProgramIsStale } from './useSheets'

describe('when the loaded program belongs to another sheet', () => {
  const a = { col: 0, row: 0 }
  const b = { col: 0, row: 1 }

  it('is stale while a generated program is for another sheet than the one on show', () => {
    expect(simProgramIsStale(a, true, b)).toBe(true)
  })

  it('is not stale once the program for the sheet on show has loaded', () => {
    expect(simProgramIsStale(b, true, { col: 0, row: 1 })).toBe(false)
  })

  // An imported .gcode file is in its own coordinates and belongs to no sheet.
  it('never counts an imported program as stale, whichever sheet is on show', () => {
    expect(simProgramIsStale(a, false, b)).toBe(false)
  })
})
