// Where the stock lies in WORK coordinates, for the go-to map on the Machine tab.
//
// The work zero is set by the user at the stock's origin point (the same corner,
// edge midpoint or centre the toolpaths are posted from — workpieceStore.origin),
// so the stock spans from −origin to size − origin on each axis.

import type { OriginPosition } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'

export interface Rect { minX: number; minY: number; maxX: number; maxY: number }

export function stockRectInWork(origin: OriginPosition, widthMM: number, heightMM: number): Rect {
  const o = originWorldXY(origin, widthMM, heightMM)
  return { minX: 0 - o.x, minY: 0 - o.y, maxX: widthMM - o.x, maxY: heightMM - o.y }
}
