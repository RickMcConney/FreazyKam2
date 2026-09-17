export interface JSPolySegment {
  point0: { x: number; y: number; radius: number }
  point1: { x: number; y: number; radius: number }
}

export interface JSPolyAPI {
  construct_medial_axis(
    boundary: { x: number; y: number }[],
    holes: { x: number; y: number }[][],
    discretizeThreshold?: number,
    discretizeMethod?: number,
    filteringAngle?: number,
    pointpointSegmentationThreshold?: number,
    numberUsage?: number,
    debugFlags?: { no_parabola: boolean; show_sites: boolean } | null,
    intermediateDebugData?: null
  ): JSPolySegment[]
}

export declare const jspoly: JSPolyAPI
