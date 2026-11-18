import type { ToolState } from '../sim/gcodeParser'
import type { FluteHelix } from '../cam/geom'

/** What the 3D view's tool mesh is built from, read off a sim tool state, and the cache key
 *  that says when it must be rebuilt. ONE reading for the playback loop and the initial
 *  indicator: two copies had drifted (one passed a corner radius for every type), and a
 *  type added to one would change the mesh the first time playback crossed a segment. */
export interface ToolMeshParams {
  type: 'flat' | 'vbit' | 'taper' | 'ball' | 'bull' | 'drill'
  diamMM: number
  /** Included angle, degrees; 60 when the tool has none. */
  angleDeg: number
  fluteCount: number
  tipDiaMM: number
  /** A bull nose's corner radius; 0 for every other type. */
  cornerMM: number
  helix: FluteHelix
  key: string
}

export function toolMeshParams(ts: ToolState): ToolMeshParams {
  let type: ToolMeshParams['type'] = 'flat', angleDeg = 60, cornerMM = 0
  const tipDiaMM = ts.toolTipRadiusMM ? ts.toolTipRadiusMM * 2 : 0
  if (ts.toolVbitHalfAngleTan) {
    type = tipDiaMM > 0 ? 'taper' : 'vbit'
    angleDeg = Math.atan(ts.toolVbitHalfAngleTan) * (180 / Math.PI) * 2
  } else if (ts.toolBallNose) {
    type = 'ball'
  } else if (ts.toolCornerRadiusMM) {
    type = 'bull'
    cornerMM = ts.toolCornerRadiusMM
  } else if (ts.toolDrill) {
    type = 'drill'
  }
  const diamMM = ts.toolDiameterMM, fluteCount = ts.fluteCount, helix = ts.toolHelix ?? 'up'
  // The tip is part of the shape, so it belongs in the key — without it a taper and a
  // V-bit of the same diameter and angle share a mesh.
  const key = `${type}|${diamMM}|${angleDeg}|${fluteCount}|${tipDiaMM}|${cornerMM}|${helix}`
  return { type, diamMM, angleDeg, fluteCount, tipDiaMM, cornerMM, helix, key }
}
