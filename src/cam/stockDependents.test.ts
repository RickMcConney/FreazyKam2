import { describe, it, expect } from 'vitest'
import { opsAffectedByStockChange, type StockDims } from './stockDependents'
import type { AnyOperation } from '../store/toolpathStore'

const stock: StockDims = { widthMM: 300, heightMM: 200, thicknessMM: 18, origin: 'bottom-left' }
const op = (o: Partial<AnyOperation> & { id: string; type: AnyOperation['type'] }) => o as AnyOperation
const p3d = (id: string, extra: object = {}) => op({ id, type: 'profile3d', maxDepthMM: 10, ...extra } as Partial<AnyOperation> & { id: string; type: 'profile3d' })
const ids = (ops: AnyOperation[]) => ops.map((o) => o.id)

describe('opsAffectedByStockChange', () => {
  it('a surface op follows the stock outline and origin, as it always has', () => {
    const ops = [op({ id: 's', type: 'surface' })]
    expect(ids(opsAffectedByStockChange(ops, stock, { ...stock, widthMM: 250 }))).toEqual(['s'])
    expect(ids(opsAffectedByStockChange(ops, stock, { ...stock, origin: 'center' }))).toEqual(['s'])
    expect(ids(opsAffectedByStockChange(ops, stock, { ...stock, thicknessMM: 5 }))).toEqual([])
  })

  it('a 3D profile bounded by the stock is rebuilt when the stock outline changes', () => {
    const ops = [p3d('stockBound', { boundary: 'stock' }), p3d('modelBound', { boundary: 'model' }), p3d('pathBound', { boundary: 'path' })]
    expect(ids(opsAffectedByStockChange(ops, stock, { ...stock, heightMM: 150 }))).toEqual(['stockBound'])
  })

  it('a thinner stock rebuilds every 3D profile whose depth it now clamps, bounded or not', () => {
    // 10 mm deep: an 18 mm stock leaves it alone; a 6 mm one clamps it to 5.5 mm.
    const ops = [p3d('a'), p3d('b', { boundary: 'stock' })]
    expect(ids(opsAffectedByStockChange(ops, stock, { ...stock, thicknessMM: 6 }))).toEqual(['a', 'b'])
  })

  it('a thickness change that does not move the depth clamp rebuilds nothing', () => {
    // Slow to generate, so 18 → 25 mm under a 10 mm cut must not set one off.
    expect(ids(opsAffectedByStockChange([p3d('a')], stock, { ...stock, thicknessMM: 25 }))).toEqual([])
  })

  it('other operation types never depend on the stock', () => {
    const ops = [op({ id: 'p', type: 'pocket' }), op({ id: 'v', type: 'vcarve' })]
    expect(ids(opsAffectedByStockChange(ops, stock, { widthMM: 1, heightMM: 1, thicknessMM: 1, origin: 'center' }))).toEqual([])
  })
})
