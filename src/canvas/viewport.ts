import { majorStepMM, minorStepMM } from './gridUtils'
import { RULER_W, RULER_H } from './types'
import type { CrossPathView } from './useNodeEditSession'

// The view of the drawing: where CNC mm land on the stage, and how far it may zoom. Pure
// arithmetic, no React — the state lives in useCanvasView.

export interface Viewport {
  x: number
  y: number
  scale: number
}

// Slack the Fit button leaves around the workpiece.
const FIT_MARGIN = 0.85
// How far past a full fit the wheel may keep zooming out. Must be BELOW FIT_MARGIN, or
// the wheel's floor lands above the zoom the Fit button produces and scrolling out stops
// while still more zoomed in than Fit.
const ZOOM_OUT_SLACK = 0.4
// Highest zoom (px/mm) any gesture may reach.
export const MAX_ZOOM = 500

// Fits a box of CNC mm to the drawing area — the stock, or every sheet of a multi-sheet
// nest (cam/sheets `layoutExtent`), whose box starts left of or below the origin.
export function fitViewport(sw: number, sh: number, box: { minX: number; minY: number; maxX: number; maxY: number }): Viewport {
  const uw = sw - RULER_W
  const uh = sh - RULER_H
  const ww = box.maxX - box.minX
  const wh = box.maxY - box.minY
  const scale = Math.min(uw / ww, uh / wh) * FIT_MARGIN
  return {
    scale,
    x: RULER_W + (uw - ww * scale) / 2 - box.minX * scale,
    y: RULER_H + uh - (uh - wh * scale) / 2 + box.minY * scale,
  }
}

// Smallest zoom (px/mm) the wheel may reach, so the view can't shrink to a speck.
//
// Sized off whichever is larger, the table or the WORKPIECE — and the workpiece is EVERY
// SHEET when a nest has spread the parts over several (cam/sheets): sized off the stock
// alone, a grid of sheets could never be seen at once. a workpiece can legitimately
// be set bigger than the configured table limits, and clamping to the table alone made it
// impossible to zoom out far enough to see all of it. The slack factor then lets the view
// pull back past a bare fit — without it the floor sat above the zoom the Fit button
// produces (which carries FIT_MARGIN), so scrolling out stopped while still more zoomed in
// than Fit. Falls back to a tiny floor if sizes aren't known yet.
export function minZoomScale(
  sw: number, sh: number, tableW: number, tableH: number, wpW: number, wpH: number,
): number {
  const uw = sw - RULER_W
  const uh = sh - RULER_H
  const w = Math.max(tableW, wpW)
  const h = Math.max(tableH, wpH)
  if (uw <= 0 || uh <= 0 || w <= 0 || h <= 0) return 0.01
  return Math.max(0.01, Math.min(uw / w, uh / h) * ZOOM_OUT_SLACK)
}

export function screenToCNC(sx: number, sy: number, vp: Viewport): { x: number; y: number } {
  return { x: (sx - vp.x) / vp.scale, y: (vp.y - sy) / vp.scale }
}

// What the canvas is showing, in CNC mm. The weld/connect candidate gatherer
// takes it so a document full of gears does not offer a target for every node
// in it — see collectCrossPathEntries.
export function visibleCNC(
  vp: Viewport,
  size: { width: number; height: number },
  near: { x: number; y: number },
): CrossPathView {
  const a = screenToCNC(0, 0, vp)
  const b = screenToCNC(size.width, size.height, vp)
  return {
    minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
    scale: vp.scale, near,
  }
}

export function snapPoint(
  cnc: { x: number; y: number },
  vp: Viewport,
  units: 'mm' | 'in',
  orgWorld: { x: number; y: number },
): { x: number; y: number } {
  const step = minorStepMM(majorStepMM(vp.scale, units), units)
  if (step <= 0) return cnc
  return {
    x: Math.round((cnc.x - orgWorld.x) / step) * step + orgWorld.x,
    y: Math.round((cnc.y - orgWorld.y) / step) * step + orgWorld.y,
  }
}
