import { flattenPath } from '../cam/pathFlattener'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'

export type OffsetCornerStyle = 'miter' | 'round' | 'square'

export interface OffsetOpParams {
  distanceMM: number        // positive = outset, negative = inset
  cornerStyle: OffsetCornerStyle
  joinPaths?: boolean       // if true, merge all subpaths into one result
}

const JOIN_TYPE: Record<OffsetCornerStyle, JoinType> = {
  miter:  JoinType.Miter,
  round:  JoinType.Round,
  square: JoinType.Square,
}

function pathToD(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return ''
  const parts = [`M ${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)}`]
  for (let i = 1; i < pts.length; i++) {
    parts.push(`L ${pts[i].x.toFixed(4)} ${pts[i].y.toFixed(4)}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

export function applyOffset(d: string, params: OffsetOpParams): string {
  const subpaths = flattenPath(d, 0.05)
  const paths = subpaths.map(sp => sp.map(([x, y]) => ({ x, y })))

  const result = inflatePathsD(
    paths,
    params.distanceMM,
    JOIN_TYPE[params.cornerStyle],
    EndType.Polygon,
    // miterLimit = max ratio of miter-length to offset distance before Clipper
    // squares the corner off. Clipper's default (2) squares any corner sharper
    // than 60°, which mangles sharp points like star tips. 10 keeps points sharp
    // down to ~11.5° interior angle while still capping near-degenerate spikes.
    10, // miterLimit
    6,  // precision: decimal places used for internal integer scaling
  )

  return result.map(pathToD).filter(Boolean).join(' ')
}
