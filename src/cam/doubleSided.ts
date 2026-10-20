// A DOUBLE-SIDED JOB: cut side A, turn the board over on two dowel pins, cut side B.
//
// SIDE B IS A SHEET (cam/sheets). It is the cell beside the stock on the side the board
// turns towards — to the right for a left-right flip, below for a top-bottom one — and
// it shows the board AS THE OPERATOR SEES IT AFTER THE FLIP. So what is drawn there is
// already in side-B machine coordinates, and its program is the plain shift every sheet
// gets: toolpaths are NEVER mirrored, because a mirrored toolpath turns a climb cut into a
// conventional one and every G2 into a G3. Only two things know about the mirror: the
// guide (side A drawn faintly onto side B) and Send to Other Side.
//
// TWO PINS ON THE FLIP AXIS, OF DIFFERENT SIZES. A point on the axis stays put under the
// flip, so the holes drilled on side A are still over the pins after it. Where the pins sit
// cannot stop a wrong flip: every wrong way to put the board back — the other flip, or a
// half turn face up — keeps the distance between the two holes, so the board still drops
// onto the pins, just slid along the axis. What those wrong ways do is SWAP the holes end
// for end, so with one pin bigger than the other the big pin meets the small hole and the
// board will not go on. (Three pins with unequal gaps do the same, but a third pin sits
// further into the sheet, where the parts are.) The form refuses sizes that differ by
// less than MIN_PIN_SIZE_DIFF_MM.
//
// The pins are fixed to the MACHINE, not to the stock's edge, so side B keeps side A's XY
// zero. Z is whatever the Stock tab says: re-zero on the new face for a top-of-stock zero,
// nothing to do for a bottom (spoilboard) one.

import { cellOffset, cellOfPoint, type Cell, type Stock } from './sheets'
import type { TransformStep } from '../canvas/selectionUtils'

/** Which way the board turns over. */
export type FlipDirection = 'left-right' | 'top-bottom'

export interface DoubleSided {
  flip: FlipDirection
  /** Pin 1's diameter — the SMALL pin. */
  pin1DiaMM: number
  /** Pin 2's diameter — the BIG pin. The difference is what stops a wrong flip; see the header. */
  pin2DiaMM: number
  /** Pin 1's distance from the axis's START (the bottom end for a left-right flip, the left for top-bottom). */
  pin1MM: number
  /** Pin 2's distance from the axis's FAR end. */
  pin2MM: number
  /** How deep the dowel holes go into the spoilboard, past the bottom of the stock. */
  spoilDepthMM: number
  /** The "Dowel Holes" path the form made, when it has made one. */
  dowelPathId?: string
  /** The end mill that bores the holes; absent = the largest that fits (tools/registrationOps). */
  toolId?: string
}

/** The least size difference that keeps the big pin out of the small hole. */
export const MIN_PIN_SIZE_DIFF_MM = 1

// 8 and 10 mm: dowel sizes sold everywhere, and both bigger than a 1/4" end mill, so the
// commonest bit in the shop can bore them helically.
export const DOUBLE_SIDED_DEFAULTS: Omit<DoubleSided, 'flip'> = {
  pin1DiaMM: 8, pin2DiaMM: 10, pin1MM: 20, pin2MM: 20, spoilDepthMM: 8,
}

/**
 * A stored setting as this build reads it: any field missing or not a number takes its
 * default. Earlier builds of this session had ONE pin size (`pinDiaMM`), and briefly a
 * third pin (`pin3MM`, from the far end — the far pin is pin 2 again).
 */
export function normalizeDoubleSided(raw: unknown): DoubleSided | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const D = DOUBLE_SIDED_DEFAULTS
  return {
    flip: r.flip === 'top-bottom' ? 'top-bottom' : 'left-right',
    pin1DiaMM: num(r.pin1DiaMM, num(r.pinDiaMM, D.pin1DiaMM)),
    pin2DiaMM: num(r.pin2DiaMM, D.pin2DiaMM),
    pin1MM: num(r.pin1MM, D.pin1MM),
    pin2MM: num(r.pin3MM, num(r.pin2MM, D.pin2MM)),
    spoilDepthMM: num(r.spoilDepthMM, D.spoilDepthMM),
    ...(typeof r.dowelPathId === 'string' ? { dowelPathId: r.dowelPathId } : {}),
    ...(typeof r.toolId === 'string' ? { toolId: r.toolId } : {}),
  }
}

/** The sheet side B is cut on. Side A is always the stock. */
export function backCell(flip: FlipDirection): Cell {
  return flip === 'left-right' ? { col: 1, row: 0 } : { col: 0, row: 1 }
}

export interface Pin { x: number; y: number; diaMM: number }

/** The two pins on side A (the stock's own coordinates): the small one, then the big one. */
export function pinCentres(ds: Pick<DoubleSided, 'flip' | 'pin1MM' | 'pin2MM' | 'pin1DiaMM' | 'pin2DiaMM'>, s: Stock): [Pin, Pin] {
  const at = (t: number, diaMM: number): Pin => ds.flip === 'left-right'
    ? { x: s.widthMM / 2, y: t, diaMM }
    : { x: t, y: s.heightMM / 2, diaMM }
  return [at(ds.pin1MM, ds.pin1DiaMM), at(axisLengthMM(ds.flip, s) - ds.pin2MM, ds.pin2DiaMM)]
}

/** The length of the flip axis across the stock. */
export function axisLengthMM(flip: FlipDirection, s: Stock): number {
  return flip === 'left-right' ? s.heightMM : s.widthMM
}

/** What is wrong with this pin layout, or null. */
export function pinProblem(ds: DoubleSided, s: Stock): string | null {
  if (!(ds.pin1DiaMM > 0) || !(ds.pin2DiaMM > 0)) return 'Each pin needs a diameter.'
  if (ds.pin1MM < ds.pin1DiaMM / 2 || ds.pin2MM < ds.pin2DiaMM / 2) return 'A pin hole runs off the edge of the stock.'
  const [a, b] = pinCentres(ds, s)
  if (Math.hypot(b.x - a.x, b.y - a.y) < (a.diaMM + b.diaMM) / 2 + 1) return 'The pin holes overlap — move the pins further apart.'
  if (ds.pin2DiaMM - ds.pin1DiaMM < MIN_PIN_SIZE_DIFF_MM) {
    return `Pin 2 must be at least ${MIN_PIN_SIZE_DIFF_MM} mm bigger than pin 1 — with pins the same size the board would also fit turned the wrong way.`
  }
  return null
}

/** The dowel holes as one path of two circles, each its own pin's size. */
export function dowelHolesD(ds: DoubleSided, s: Stock, circleD: (cx: number, cy: number, r: number) => string): string {
  return pinCentres(ds, s).map((c) => circleD(c.x, c.y, c.diaMM / 2)).join(' ')
}

/** The centre line a cell's paths are mirrored about to reach the other side. */
function centreLineStep(flip: FlipDirection, cell: Cell, s: Stock): TransformStep {
  const o = cellOffset(cell, s)
  return flip === 'left-right'
    ? { kind: 'mirror', axis: 'x', cx: o.x + s.widthMM / 2, cy: o.y + s.heightMM / 2 }
    : { kind: 'mirror', axis: 'y', cx: o.x + s.widthMM / 2, cy: o.y + s.heightMM / 2 }
}

/**
 * The transform that carries a path from the side it is on to the other one: mirrored
 * about its own sheet's flip axis, then moved onto the other sheet. The same two steps
 * either way, so sending a path over and back puts it exactly where it was.
 */
export function otherSideSteps(flip: FlipDirection, from: Cell, s: Stock): TransformStep[] {
  const back = backCell(flip)
  const onBack = from.col === back.col && from.row === back.row
  const a = cellOffset(from, s)
  const b = cellOffset(onBack ? { col: 0, row: 0 } : back, s)
  return [centreLineStep(flip, from, s), { kind: 'translate', dx: b.x - a.x, dy: b.y - a.y }]
}

/**
 * The guide's placement: side A drawn on side B as the board will be seen after the flip.
 * As a Konva group transform inside the Y-flipped layer — `x' = x0 + sx·x`, `y' = y0 + sy·y`.
 */
export function guideTransform(flip: FlipDirection, s: Stock): { x: number; y: number; scaleX: number; scaleY: number } {
  const o = cellOffset(backCell(flip), s)
  return flip === 'left-right'
    ? { x: o.x + s.widthMM, y: o.y, scaleX: -1, scaleY: 1 }
    : { x: o.x, y: o.y + s.heightMM, scaleX: 1, scaleY: -1 }
}

/**
 * A box's image on the OTHER side of the board — where the guide draws a side-A shape on
 * side B, or where a side-B shape lies on side A — or null for a box on neither. The flip
 * is a mirror about a line a whole sheet apart, `v → c − v` along one axis with c the same
 * both ways, so one formula carries a box over and back.
 */
export function otherSideBox(
  flip: FlipDirection, s: Stock, b: { minX: number; minY: number; maxX: number; maxY: number },
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const cell = cellOfPoint((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, s)
  const back = backCell(flip)
  const onA = cell.col === 0 && cell.row === 0
  const onB = cell.col === back.col && cell.row === back.row
  if (!onA && !onB) return null
  const g = guideTransform(flip, s)
  return flip === 'left-right'
    ? { minX: g.x - b.maxX, maxX: g.x - b.minX, minY: b.minY, maxY: b.maxY }
    : { minX: b.minX, maxX: b.maxX, minY: g.y - b.maxY, maxY: g.y - b.minY }
}

/** How deep the dowel holes are drilled: through the stock and into the spoilboard. */
export function dowelDepthMM(ds: DoubleSided, thicknessMM: number): number {
  return thicknessMM + ds.spoilDepthMM
}
