import type { AnyOperation } from '../store/toolpathStore'
import { profile3dDepthMM } from './profile3d'

/** The stock dimensions an operation's toolpath can depend on. */
export interface StockDims { widthMM: number; heightMM: number; thicknessMM: number; origin: string }

/**
 * The operations a change of stock from `prev` to `next` leaves stale.
 *
 * A Surface op covers the whole stock. A 3D Profile depends on it in two ways: a 'stock'
 * boundary IS the stock's outline, and every 3D Profile's depth is held above the stock's
 * bottom (`profile3dDepthMM`) — a thinner stock left the old toolpath cutting past the
 * skin, the through-cut the skin exists to prevent. A thickness change only counts where
 * it moves that clamp: a 3D Profile is the slowest generation in the app, and one well
 * inside the stock is not rebuilt for nothing.
 */
export function opsAffectedByStockChange(ops: AnyOperation[], prev: StockDims, next: StockDims): AnyOperation[] {
  const outline = next.widthMM !== prev.widthMM || next.heightMM !== prev.heightMM
  return ops.filter((op) => {
    if (op.type === 'surface') return outline || next.origin !== prev.origin
    if (op.type === 'profile3d') {
      if (outline && op.boundary === 'stock') return true
      return profile3dDepthMM(op.maxDepthMM, prev.thicknessMM) !== profile3dDepthMM(op.maxDepthMM, next.thicknessMM)
    }
    return false
  })
}
