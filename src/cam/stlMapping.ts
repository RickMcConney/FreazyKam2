import type { StlModelBounds } from '../importers/svgImporter'
import type { BBox } from '../canvas/selectionUtils'

/**
 * Where an STL's own coordinates land in CNC space — THE mapping, for everything that reads
 * the model: the height map, the drop-cutter, the floor. The model's XY box is stretched
 * onto its path's box `bbox`, Z is scaled by the mean of the two XY scales, and the model's
 * highest point sits `zOffsetMM` below the stock top (Z = 0). Two copies of this that
 * disagreed would put the finish and the grid it is checked against in different places.
 */
export interface StlToCnc {
  x(stlX: number): number
  y(stlY: number): number
  z(stlZ: number): number
}

export function stlToCnc(bounds: StlModelBounds, bbox: BBox, zOffsetMM = 0): StlToCnc {
  const modelCX = (bounds.minX + bounds.maxX) / 2
  const modelCY = (bounds.minY + bounds.maxY) / 2
  const scaleX = bbox.width / (bounds.maxX - bounds.minX)
  const scaleY = bbox.height / (bounds.maxY - bounds.minY)
  const scaleZ = (scaleX + scaleY) / 2
  return {
    x: (sx) => (sx - modelCX) * scaleX + bbox.cx,
    y: (sy) => (sy - modelCY) * scaleY + bbox.cy,
    z: (sz) => (sz - bounds.maxZ) * scaleZ - zOffsetMM,
  }
}
