import { describe, it, expect } from 'vitest'
import { stockRectInWork } from './stockMap'

describe('stockRectInWork', () => {
  it('puts a bottom-left origin at the stock corner: the stock spans 0→W, 0→H', () => {
    expect(stockRectInWork('bottom-left', 300, 200)).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 200 })
  })

  it('centres the stock on work zero for a centre origin', () => {
    expect(stockRectInWork('center', 300, 200)).toEqual({ minX: -150, minY: -100, maxX: 150, maxY: 100 })
  })

  it('puts a top-right origin at the back-right corner (Y-up: the stock lies at negative X and Y)', () => {
    expect(stockRectInWork('top-right', 300, 200)).toEqual({ minX: -300, minY: -200, maxX: 0, maxY: 0 })
  })
})
