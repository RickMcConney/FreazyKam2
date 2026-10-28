import { describe, it, expect } from 'vitest'
import { axisPieces } from './gcodeTokens'

describe('axisPieces — the viewer colours a line\'s axis words', () => {
  it('marks each X, Y and Z word with its axis and leaves the rest as text', () => {
    expect(axisPieces('G1 X10.000 Y-2.5 Z-1.000 F800')).toEqual([
      { text: 'G1 ' }, { text: 'X10.000', axis: 'x' }, { text: ' ' }, { text: 'Y-2.5', axis: 'y' },
      { text: ' ' }, { text: 'Z-1.000', axis: 'z' }, { text: ' F800' },
    ])
  })

  it('reads a compact line, lower case and spaced words too', () => {
    expect(axisPieces('X20.000')).toEqual([{ text: 'X20.000', axis: 'x' }])
    expect(axisPieces('g0 z 5')).toEqual([{ text: 'g0 ' }, { text: 'z 5', axis: 'z' }])
  })

  it('never colours a letter inside a comment', () => {
    expect(axisPieces('M0 (MSG, T2 1/8 X 1/2 - change tool)')).toEqual([{ text: 'M0 (MSG, T2 1/8 X 1/2 - change tool)' }])
    expect(axisPieces('G0 Z10.000 ; retract to Z 10')).toEqual([
      { text: 'G0 ' }, { text: 'Z10.000', axis: 'z' }, { text: ' ; retract to Z 10' },
    ])
  })

  it('gives back the line exactly when the pieces are joined', () => {
    for (const l of ['', 'G2 X1 Y2 I3 J4', '(Stock: XMIN=0 XMAX=120)', 'G1X1Y2Z3']) {
      expect(axisPieces(l).map((p) => p.text).join('')).toBe(l)
    }
  })
})
