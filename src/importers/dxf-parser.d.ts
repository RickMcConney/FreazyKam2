declare module 'dxf-parser' {
  interface DxfPoint { x: number; y: number; z?: number }

  interface BaseEntity { type: string; layer?: string; handle?: string }

  interface LineEntity extends BaseEntity { type: 'LINE'; vertices: DxfPoint[] }

  interface LwpolylineEntity extends BaseEntity {
    type: 'LWPOLYLINE'
    vertices: DxfPoint[]
    shape: boolean
  }

  interface PolylineEntity extends BaseEntity {
    type: 'POLYLINE'
    vertices: DxfPoint[]
    shape: boolean
  }

  interface ArcEntity extends BaseEntity {
    type: 'ARC'
    center: DxfPoint
    radius: number
    startAngle: number
    endAngle: number
  }

  interface CircleEntity extends BaseEntity {
    type: 'CIRCLE'
    center: DxfPoint
    radius: number
  }

  interface SplineEntity extends BaseEntity {
    type: 'SPLINE'
    controlPoints: DxfPoint[]
    degree: number
    knots?: number[]
    closed?: boolean
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
