declare module 'dxf-parser' {
  interface DxfPoint { x: number; y: number; z?: number }
  /** A polyline vertex. `bulge` = tan(θ/4) of the arc to the NEXT vertex (group 42),
   *  positive CCW; absent when the segment is straight. */
  interface DxfPolyVertex extends DxfPoint { bulge?: number }

  interface BaseEntity { type: string; layer?: string; handle?: string }

  interface LineEntity extends BaseEntity { type: 'LINE'; vertices: DxfPoint[] }

  interface LwpolylineEntity extends BaseEntity {
    type: 'LWPOLYLINE'
    vertices: DxfPolyVertex[]
    shape: boolean
  }

  interface PolylineEntity extends BaseEntity {
    type: 'POLYLINE'
    vertices: DxfPolyVertex[]
    shape: boolean
  }

  interface ArcEntity extends BaseEntity {
    type: 'ARC'
    center: DxfPoint
    radius: number
    startAngle: number  // radians — dxf-parser converts the file's degrees
    endAngle: number
  }

  interface CircleEntity extends BaseEntity {
    type: 'CIRCLE'
    center: DxfPoint
    radius: number
  }

  // The names dxf-parser actually writes (dist/entities/spline.js) — this once said
  // `degree` and `knots`, which nothing sets, so every spline came in as its control
  // polygon. Each list exists only when its group codes were present: a spline drawn
  // through fit points has no controlPoints at all.
  interface SplineEntity extends BaseEntity {
    type: 'SPLINE'
    controlPoints?: DxfPoint[]
    fitPoints?: DxfPoint[]
    degreeOfSplineCurve?: number
    knotValues?: number[]
    closed?: boolean
    periodic?: boolean
  }

  interface EllipseEntity extends BaseEntity {
    type: 'ELLIPSE'
    center: DxfPoint
    majorAxisEndPoint: DxfPoint
    axisRatio: number
    startAngle: number
    endAngle: number
  }

  type DxfEntity =
    | LineEntity
    | LwpolylineEntity
    | PolylineEntity
    | ArcEntity
    | CircleEntity
    | SplineEntity
    | EllipseEntity
    | BaseEntity

  interface DxfHeader { $INSUNITS?: number }

  interface DxfData {
    header: DxfHeader
    entities: DxfEntity[]
  }

  export default class DxfParser {
    parseSync(source: string): DxfData
    parse(source: string, done: (err: Error | null, data: DxfData | null) => void): void
  }
}
