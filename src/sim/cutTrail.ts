// ─── Cut trail accumulator (2D simulation) ────────────────────────────────────
//
// The yellow "material removed so far" overlay. It is rebuilt on every animation
// frame, so its cost has to be proportional to what the tool cut SINCE THE LAST
// FRAME — not to everything cut so far. It used to be the latter, which is why a
// long program got slower the further it played: at 74k segments (a 150×100 mm
// photo v-carve) every frame walked all 74k and handed React 8,430 separate line
// nodes to reconcile and Konva 8,430 stroke calls to draw.
//
// So the geometry lives here, in a mutable accumulator the layer only ever appends
// to, and it comes out in a shape the layer can draw in a handful of canvas calls:
//
//   byWidth   — polylines grouped by stroke width, rounded to 0.1 mm. A V-bit's cut
//               width tracks its depth, so a depth-varying pass produces a new width
//               every few segments; grouping by width means one beginPath+stroke per
//               DISTINCT width instead of one per run of segments.
//   frustums  — segments whose start and end widths differ by more than the rounding
//               (a plunge, a ramp, a steep V-carve descent). A stroke can't taper, so
//               these are filled as trapezoids.
//
// Rewinding the scrubber, loading another program, or moving the work origin drops
// everything and replays — correctness first; those are not per-frame events.

import { vRadiusAtHeightMM } from '../cam/geom'
import { segTool, type SimSegment, type ToolState } from './gcodeParser'

export interface FrustumSeg {
  x0: number; y0: number; w0: number
  x1: number; y1: number; w1: number
}

// Cut widths are bucketed to this, in mm. Fine enough that a taper still reads as a
// taper; coarse enough that a long pass shares one stroke.
const WIDTH_STEP_MM = 0.1

// For V-cutter segments, cut width = 2·a(|z|), capped at the tool diameter: a cone of
// 2·|z|·tan for a V-bit, and for a taper the tip ball out to where the cone takes over
// (so a shallow taper pass draws its tip width, not a line).
export function effectiveCutWidthAt(seg: SimSegment, z: number, toolStates: ToolState[]): number {
  const ts = segTool(seg, toolStates)
  const tan = ts.toolVbitHalfAngleTan
  if (tan !== undefined) {
    const rad = vRadiusAtHeightMM(Math.abs(z), tan, ts.toolTipRadiusMM ?? 0)
    return Math.min(2 * rad, ts.toolDiameterMM)
  }
  return ts.toolDiameterMM
}

// Written out rather than `Math.round(w / STEP) * STEP` so the bucket keys stay exact
// tenths instead of 0.30000000000000004.
const roundWidth = (w: number): number => Math.round(w * (1 / WIDTH_STEP_MM)) / (1 / WIDTH_STEP_MM)

function push(map: Map<number, number[][]>, width: number, pts: number[]): void {
  const bucket = map.get(width)
  if (bucket) bucket.push(pts)
  else map.set(width, [pts])
}

export class CutTrail {
  /** Rounded stroke width (mm) → flat [x0,y0,x1,y1,…] polylines to stroke at it. */
  readonly byWidth = new Map<number, number[][]>()
  readonly frustums: FrustumSeg[] = []

  // What was cut since the last drain, in the same form — so a consumer that has
  // already drawn everything before it (TrailRaster) can paint just the difference.
  // Same geometry as byWidth/frustums, not a substitute for it: the full set is still
  // needed whenever the consumer has to start over.
  readonly pendingByWidth = new Map<number, number[][]>()
  readonly pendingFrustums: FrustumSeg[] = []

  // Bumped whenever the trail starts over (rewind, new program, moved origin), so a
  // consumer can tell "more was cut" from "everything you drew is wrong".
  private _generation = 0
  get generation(): number { return this._generation }

  private _segments: SimSegment[] | null = null
  private _toolStates: ToolState[] | null = null
  private _ox = 0
  private _oy = 0
  private _nextIdx = 0
  // The polyline still being extended. Already inside its byWidth bucket — appending
  // to it appends to what will be drawn, so there is nothing to flush.
  private _open: { width: number; pts: number[] } | null = null

  /** Everything cut up to and including `upToIdx` (-1 = nothing yet). */
  sync(segments: SimSegment[], upToIdx: number, ox: number, oy: number, toolStates: ToolState[]): void {
    // A different program, or the same one drawn against a different origin, shares
    // nothing with what is accumulated. Store identity, not contents: every store
    // replaces these arrays rather than mutating them.
    if (segments !== this._segments || toolStates !== this._toolStates || ox !== this._ox || oy !== this._oy) {
      this.reset()
      this._segments = segments
      this._toolStates = toolStates
      this._ox = ox
      this._oy = oy
    } else if (upToIdx + 1 < this._nextIdx) {
      this.reset()   // scrubbed backwards — replay from the start
    }

    const end = Math.min(upToIdx, segments.length - 1)
    for (let i = this._nextIdx; i <= end; i++) this._append(segments[i], toolStates)
    this._nextIdx = Math.max(this._nextIdx, end + 1)
  }

  reset(): void {
    this.byWidth.clear()
    this.frustums.length = 0
    this.drainPending()
    this._nextIdx = 0
    this._open = null
    this._generation++
  }

  /** Forget the pending delta — call once it has been drawn. */
  drainPending(): void {
    this.pendingByWidth.clear()
    this.pendingFrustums.length = 0
  }

  private _append(seg: SimSegment, toolStates: ToolState[]): void {
    // Above the surface at both ends, or a rapid: nothing was removed.
    if (seg.rapid || (seg.prevZ >= -0.001 && seg.z >= -0.001)) { this._open = null; return }

    const w0 = effectiveCutWidthAt(seg, seg.prevZ, toolStates)
    const w1 = effectiveCutWidthAt(seg, seg.z, toolStates)
    const x0 = seg.prevX + this._ox, y0 = seg.prevY + this._oy
    const x1 = seg.x + this._ox,     y1 = seg.y + this._oy

    if (Math.abs(w0 - w1) >= WIDTH_STEP_MM) {
      const f = { x0, y0, w0, x1, y1, w1 }
      this.frustums.push(f)
      this.pendingFrustums.push(f)
      this._open = null
      return
    }

    const w = roundWidth((w0 + w1) / 2)
    // The delta always carries this segment on its own, whether it extended a
    // polyline or started one: round caps make a lone segment join its neighbours
    // exactly as it would inside the polyline.
    push(this.pendingByWidth, w, [x0, y0, x1, y1])

    if (this._open && this._open.width === w) {
      this._open.pts.push(x1, y1)
      return
    }
    const pts = [x0, y0, x1, y1]
    push(this.byWidth, w, pts)
    this._open = { width: w, pts }
  }
}
