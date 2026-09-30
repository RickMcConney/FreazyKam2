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
//   batches   — the trail IN CUT ORDER, as runs of one heat colour (see below). Inside
//               a batch, polylines are grouped by stroke width, rounded to 0.1 mm: a
//               V-bit's cut width tracks its depth, so a depth-varying pass produces a
//               new width every few segments, and grouping means one beginPath+stroke
//               per DISTINCT width instead of one per run of segments. Order inside a
//               batch cannot matter — it is all one opaque colour — but order BETWEEN
//               batches does, because the raster paints a cool band UNDER what is there
//               and a hot one over it (`heatOnTop`), and those two rules only give one
//               picture if both paths apply them in the same sequence. Grouping the
//               whole trail by colour instead painted
//               every green stroke over every red one in the finished view, while
//               playback, painting in cut order, showed the red — so the hot spots
//               appeared as the program played and vanished when it finished. A
//               one-colour program is one batch, exactly the old grouping.
//   frustums  — segments whose start and end widths differ by more than the rounding
//               (a plunge, a ramp, a steep V-carve descent). A stroke can't taper, so
//               these are filled as trapezoids.
//
// THE HEAT MAP. Each cut is coloured by its chip load against the same aim the
// simulator's gauge uses — at the speed the machine really reaches there (the planner's
// trapezoid on each segment, sim/motionPlanner.ts), not the F word. A move's speed
// changes along it, so it is cut into pieces where it ramps up and down and each piece
// takes the band of its own average speed: a long pass reads green with a red end where
// it slows into a corner. Band 0 is a cut the gauge does not judge — a plunge, a ramp or
// helix going down, a drill, a program with no spindle speed — drawn neutral.
//
// Rewinding the scrubber, loading another program, moving the work origin or changing
// what the heat is judged against drops everything and replays — correctness first;
// those are not per-frame events.

import { vRadiusAtHeightMM } from '../cam/geom'
import { aimChipLoad } from '../cam/feeds'
import type { Material } from '../store/workpieceStore'
import { segTool, toolTypeOf, feedDiameterOf, type SimSegment, type ToolState } from './gcodeParser'

export interface FrustumSeg {
  x0: number; y0: number; w0: number
  x1: number; y1: number; w1: number
  band: number
}

/** What a chip is judged against — the simulator's gauge's own inputs. */
export interface HeatSpec {
  material: Material
  rigidity: number
}

export const HEAT_NEUTRAL = 0

/**
 * The heat band of a chip `ratio` × the aimed chip. The rubbing edge (0.75) and the
 * heavy edge (1.4) are the gauge's; below 0.75 it is graded, because how far short of
 * the chip a cut falls is the whole question the map is there to answer.
 */
export function heatBand(ratio: number): number {
  if (ratio < 0.35) return 1
  if (ratio < 0.55) return 2
  if (ratio < 0.75) return 3
  if (ratio <= 1.4) return 4
  return 5
}

/**
 * Whether a band is painted OVER what is already there (a chip worth seeing — too thin
 * or too heavy) or UNDER it (the sweet spot, and cuts the gauge does not judge). The cut
 * is as wide as the tool, so a hot corner a millimetre long is followed within the
 * brush's own radius by the green of the same pass getting back up to speed; painted in
 * cut order, that green covered all but a crescent of it. Painted under, it cannot.
 */
export const heatOnTop = (band: number): boolean => band !== HEAT_NEUTRAL && band !== 4

// A ramp is cut into pieces no longer than this, so the colour follows the speed.
const RAMP_PIECE_MM = 0.5
const MAX_RAMP_PIECES = 6

/**
 * A cutting move as [from, to, band] pieces, as fractions of its length. Adjacent pieces
 * of one band are merged, so a move that never leaves a band is one piece.
 */
export function heatPieces(seg: SimSegment, toolStates: ToolState[], heat: HeatSpec | null): [number, number, number][] {
  const whole = (band: number): [number, number, number][] => [[0, 1, band]]
  if (!heat) return whole(HEAT_NEUTRAL)
  // Judged exactly as the gauge judges a move: not going down, a tool that cuts sideways,
  // a spindle speed and flutes to divide by.
  if (seg.z < seg.prevZ - 1e-3) return whole(HEAT_NEUTRAL)
  const ts = segTool(seg, toolStates)
  const type = toolTypeOf(ts)
  if (type === 'drill' || !(ts.spindleRpm > 0) || !(ts.fluteCount > 0)) return whole(HEAT_NEUTRAL)
  const aim = aimChipLoad(type, feedDiameterOf(ts), heat.material, heat.rigidity)
  const perSec = (ts.spindleRpm * ts.fluteCount) / 60   // teeth per second
  const bandAt = (speedMmS: number) => heatBand(speedMmS / perSec / aim)

  const L = Math.hypot(seg.x - seg.prevX, seg.y - seg.prevY, seg.z - seg.prevZ)
  const a = seg.acc
  if (a === undefined || !Number.isFinite(a) || L <= 0) {
    return whole(bandAt((seg.vc ?? seg.feedRateMmMin / 60)))
  }
  const v0 = seg.v0!, vc = seg.vc!, v1 = seg.v1!
  const dAcc = Math.min(L, (vc * vc - v0 * v0) / (2 * a))
  const dDec = Math.min(L - dAcc, (vc * vc - v1 * v1) / (2 * a))
  const out: [number, number, number][] = []
  const add = (d0: number, d1: number, band: number) => {
    if (d1 - d0 <= 1e-9) return
    const last = out[out.length - 1]
    if (last && last[2] === band) last[1] = d1 / L
    else out.push([d0 / L, d1 / L, band])
  }
  // Average speed over [da, db] of a ramp starting at speed u: distance over time.
  const ramp = (start: number, len: number, u: number, sign: 1 | -1) => {
    const n = Math.max(1, Math.min(MAX_RAMP_PIECES, Math.ceil(len / RAMP_PIECE_MM)))
    for (let k = 0; k < n; k++) {
      const da = (k / n) * len, db = ((k + 1) / n) * len
      const va = Math.sqrt(Math.max(0, u * u + sign * 2 * a * da))
      const vb = Math.sqrt(Math.max(0, u * u + sign * 2 * a * db))
      const dt = Math.abs(vb - va) / a
      add(start + da, start + db, bandAt(dt > 0 ? (db - da) / dt : va))
    }
  }
  ramp(0, dAcc, v0, 1)
  add(dAcc, L - dDec, bandAt(vc))
  ramp(L - dDec, dDec, vc, -1)
  if (out.length === 0) return whole(bandAt(vc))
  out[out.length - 1][1] = 1
  return out
}

/** A run of the trail in one heat colour: polylines by rounded width, and tapers. */
export interface TrailBatch {
  band: number
  /** Rounded stroke width (mm) → flat [x0,y0,x1,y1,…] polylines to stroke at it. */
  byWidth: Map<number, number[][]>
  frustums: FrustumSeg[]
}

const newBatch = (band: number): TrailBatch => ({ band, byWidth: new Map(), frustums: [] })

// The batch to add a `band` piece to: the last one if it is that colour, else a new one.
function batchFor(list: TrailBatch[], band: number): TrailBatch {
  const last = list[list.length - 1]
  if (last && last.band === band) return last
  const b = newBatch(band)
  list.push(b)
  return b
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
  /** Everything cut so far, in cut order — paint the batches in sequence. */
  readonly batches: TrailBatch[] = []

  // What was cut since the last drain, in the same form — so a consumer that has
  // already drawn everything before it (TrailRaster) can paint just the difference.
  // Same geometry as `batches`, not a substitute for it: the full set is still needed
  // whenever the consumer has to start over.
  readonly pendingBatches: TrailBatch[] = []

  // Bumped whenever the trail starts over (rewind, new program, moved origin), so a
  // consumer can tell "more was cut" from "everything you drew is wrong".
  private _generation = 0
  get generation(): number { return this._generation }

  private _segments: SimSegment[] | null = null
  private _toolStates: ToolState[] | null = null
  private _heat: HeatSpec | null = null
  private _ox = 0
  private _oy = 0
  private _nextIdx = 0
  // The polyline still being extended, and the batch it lives in. Already inside that
  // batch's byWidth bucket — appending to it appends to what will be drawn, so there is
  // nothing to flush. Only ever the LAST batch's, or cut order would be lost.
  private _open: { batch: TrailBatch; width: number; pts: number[] } | null = null

  /**
   * Everything cut up to and including `upToIdx` (-1 = nothing yet), coloured by chip
   * load against `heat` — or all neutral without one.
   */
  sync(segments: SimSegment[], upToIdx: number, ox: number, oy: number, toolStates: ToolState[], heat: HeatSpec | null = null): void {
    // A different program, the same one drawn against a different origin, or judged
    // against another material or machine, shares nothing with what is accumulated.
    // Store identity, not contents: every store replaces these arrays rather than
    // mutating them.
    const heatChanged = (heat?.material ?? null) !== (this._heat?.material ?? null) ||
      (heat?.rigidity ?? null) !== (this._heat?.rigidity ?? null)
    if (segments !== this._segments || toolStates !== this._toolStates || ox !== this._ox || oy !== this._oy || heatChanged) {
      this.reset()
      this._segments = segments
      this._toolStates = toolStates
      this._heat = heat ? { ...heat } : null
      this._ox = ox
      this._oy = oy
    } else if (upToIdx + 1 < this._nextIdx) {
      this.reset()   // scrubbed backwards — replay from the start
    }

    const end = Math.min(upToIdx, segments.length - 1)
    for (let i = this._nextIdx; i <= end; i++) this._append(segments[i], toolStates, this._heat)
    this._nextIdx = Math.max(this._nextIdx, end + 1)
  }

  reset(): void {
    this.batches.length = 0
    this.drainPending()
    this._nextIdx = 0
    this._open = null
    this._generation++
  }

  /** Forget the pending delta — call once it has been drawn. */
  drainPending(): void {
    this.pendingBatches.length = 0
  }

  private _append(seg: SimSegment, toolStates: ToolState[], heat: HeatSpec | null): void {
    // Above the surface at both ends, or a rapid: nothing was removed.
    if (seg.rapid || (seg.prevZ >= -0.001 && seg.z >= -0.001)) { this._open = null; return }

    const w0 = effectiveCutWidthAt(seg, seg.prevZ, toolStates)
    const w1 = effectiveCutWidthAt(seg, seg.z, toolStates)
    const x0 = seg.prevX + this._ox, y0 = seg.prevY + this._oy
    const x1 = seg.x + this._ox,     y1 = seg.y + this._oy

    if (Math.abs(w0 - w1) >= WIDTH_STEP_MM) {
      // A changing width is a cut going down or coming up — the gauge never judges it.
      const f = { x0, y0, w0, x1, y1, w1, band: HEAT_NEUTRAL }
      batchFor(this.batches, HEAT_NEUTRAL).frustums.push(f)
      batchFor(this.pendingBatches, HEAT_NEUTRAL).frustums.push(f)
      this._open = null
      return
    }

    const w = roundWidth((w0 + w1) / 2)
    for (const [f0, f1, band] of heatPieces(seg, toolStates, heat)) {
      const ax = x0 + (x1 - x0) * f0, ay = y0 + (y1 - y0) * f0
      const bx = x0 + (x1 - x0) * f1, by = y0 + (y1 - y0) * f1
      // The delta always carries this piece on its own, whether it extended a polyline
      // or started one: round caps make a lone piece join its neighbours exactly as it
      // would inside the polyline.
      push(batchFor(this.pendingBatches, band).byWidth, w, [ax, ay, bx, by])

      const batch = batchFor(this.batches, band)
      if (this._open && this._open.batch === batch && this._open.width === w) {
        this._open.pts.push(bx, by)
        continue
      }
      const pts = [ax, ay, bx, by]
      push(batch.byWidth, w, pts)
      this._open = { batch, width: w, pts }
    }
  }
}
