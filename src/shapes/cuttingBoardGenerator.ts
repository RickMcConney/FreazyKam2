// ─── Cutting board ────────────────────────────────────────────────────────────
//
// A board is not one cut, so this emits a COMPOUND path: the outline, then the
// juice groove, then the hand slot / hanging hole. They want different tools and
// different depths — profile the outline, run the groove with a core box bit a
// few mm deep, drill or bore the hole — so the intended workflow is to draw the
// board, then double-click it to split the compound path and give each piece its
// own operation.
//
// The board lies ALONG X — it is a landscape board, and its handle end is the
// right end. A paddle reaches out past it in +X; hand slots stand off it (and
// off the left end) by `handleInset`, leaving a rail to curl your fingers over.
//
// Everything is built by boolean, not by cases. A handle is UNIONED onto the
// body, and the junction it leaves is rounded by a morphological CLOSING —
// dilate by f, erode by f — which fills every concave corner with a tangent arc
// of radius f and leaves convex corners exactly as they were. That is what lets
// a paddle blend into a square board, an ellipse and a cask with the same four
// lines, instead of one hand-solved fillet per (body × handle) pair.
//
// The juice groove is the CUTTING FIELD offset inward by `grooveInset`, which is
// a TRUE offset (clipper2), not a scaled-down copy of the outline — those differ
// everywhere the outline is curved, and the whole point of the groove is to sit
// a constant distance from the edge so the router can follow it at a constant
// depth from a bearing or a fence.
//
// The field is not the outline. A paddle ADDS material, so the groove is taken
// before it is attached and stops at the neck the way it should. Hand slots take
// a strip of board out of service, so that whole end strip is cut OUT of the
// field: the groove then rings the middle and the slots sit in plain wood
// outside it, instead of the groove crossing a slot and draining through it.
//
// Features that could land somewhere silly (a hand slot on a board too small
// for it, a hanging hole that would break into the groove) are SLID along a
// search direction until they clear both, and dropped entirely if they never
// do — see `placeFeature`. An omitted hole is obvious on the canvas; a hole
// that breaches the groove is not obvious until the board is glued up.
//
// Windings follow the repo convention: outline CCW, everything inside it CW.
// The groove is CW too, so that anything reading the compound path as regions
// treats it as a hole rather than as a second outer boundary — but it is a
// PATH, not a region: it wants its own op, not a pocket.

import { pointInPolygon, ptSegDistSq } from '../cam/geom'
import {
  type Pt, clamp, roundRectRing, ellipseRing,
  boolRings, inflateRings, roundConcave, roundConvex, ringToD,
} from './polyOps'

export type BoardShape = 'rect' | 'oval' | 'barrel'
export type BoardHandle = 'none' | 'paddle' | 'grips' | 'slot'

export interface CuttingBoardSpec {
  x: number; y: number
  /** The CUTTING FIELD — a paddle protrudes past it. */
  w: number; h: number
  shape: BoardShape
  /** Corner radius on `rect`, bow depth on `barrel`, unused on `oval`. */
  corner: number
  handle: BoardHandle
  /** Paddle: neck width. Slots: slot length (across the board). */
  handleW: number
  /** Paddle: how far it reaches past the end. Slots: slot width. */
  handleL: number
  /** Slots only: the rail left between the board's edge and the slot. */
  handleInset: number
  hole: boolean
  holeDia: number
  groove: boolean
  grooveInset: number
}

// `corner` and the two handle sizes each mean something different depending on
// the shape/handle they belong to, so the panels label them for what they do
// rather than for the field they are stored in. Kept beside the params they
// describe so the two panels can't drift apart. `null` = the field does not
// apply and is hidden.
export const BOARD_EDGE_LABEL: Record<BoardShape, string | null> = {
  rect: 'Corner', barrel: 'Bow', oval: null,
}
export const BOARD_HANDLE_LABELS: Record<BoardHandle, [string, string] | null> = {
  none: null,
  paddle: ['Neck W', 'Length'],
  grips: ['Slot L', 'Slot W'],
  slot: ['Slot L', 'Slot W'],
}

/** Handles whose slots stand off the board edge by `handleInset`. */
export const BOARD_HANDLE_HAS_INSET: Record<BoardHandle, boolean> = {
  none: false, paddle: false, grips: true, slot: true,
}

// `handleW`/`handleL` mean different things per handle — a paddle's 60×110 neck
// read as a slot is a 60 mm hand opening 110 mm wide, which is not a handle at
// all. Switching type therefore reseeds them, so each one lands on something
// that looks like the thing it is named after.
export const BOARD_HANDLE_DEFAULTS: Record<BoardHandle, { handleW: number; handleL: number }> = {
  none:   { handleW: 60, handleL: 110 },
  paddle: { handleW: 60, handleL: 110 },
  grips:  { handleW: 110, handleL: 26 },
  slot:   { handleW: 110, handleL: 26 },
}

const CLEARANCE = 3       // material a feature must leave to an edge or groove
const GROOVE_CORNER = 10  // smallest radius the groove is allowed to turn on

// ─── Placement ────────────────────────────────────────────────────────────────

/** Min distance from a point to a closed polyline. */
function distToRing(px: number, py: number, ring: Pt[]): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, ptSegDistSq(px, py, ring[j][0], ring[j][1], ring[i][0], ring[i][1]))
  }
  return Math.sqrt(best)
}

/**
 * Slide a feature along its search direction until every point of it sits inside
 * the outline and clear of both the outline and the groove; null if it never
 * does. Dropping a feature that will not fit beats emitting one that breaks into
 * the groove — the first is visible on the canvas, the second is visible after
 * glue-up.
 */
function placeFeature(
  build: (t: number) => Pt[], steps: number,
  outline: Pt[][], groove: Pt[][],
): Pt[] | null {
  for (let s = 0; s <= steps; s++) {
    const ring = build(s / Math.max(1, steps))
    let ok = true
    for (const [px, py] of ring) {
      if (!outline.some((o) => pointInPolygon(px, py, o))) { ok = false; break }
      if (outline.some((o) => distToRing(px, py, o) < CLEARANCE)) { ok = false; break }
      if (groove.some((g) => distToRing(px, py, g) < CLEARANCE)) { ok = false; break }
    }
    if (ok) return ring
  }
  return null
}

// ─── Body ─────────────────────────────────────────────────────────────────────

function bodyRings(p: CuttingBoardSpec): Pt[][] {
  const { x, y, w, h } = p
  switch (p.shape) {
    case 'oval':
      return [ellipseRing(x + w / 2, y + h / 2, w / 2, h / 2)]
    case 'barrel': {
      const bow = clamp(p.corner, 0, Math.min(w, h) * 0.3)
      if (bow < 0.05) return [roundRectRing(x, y, w, h, 0)]
      // A core `bow` shallower top and bottom, with a full-height ellipse
      // unioned on: the ellipse stands proud at mid-length and tucks inside at
      // the ends, which is the cask profile — and the board lies along X, so
      // the bulge belongs on the LONG sides, not the short ones. Its two shallow
      // crossings per side are concave, so the closing sweeps them out.
      const core = roundRectRing(x, y + bow, w, h - 2 * bow, Math.min(bow, w / 2, (h - 2 * bow) / 2))
      const lens = ellipseRing(x + w / 2, y + h / 2, w / 2, h / 2)
      return roundConcave(boolRings('union', [core], [lens]), bow * 0.9)
    }
    default:
      return [roundRectRing(x, y, w, h, clamp(p.corner, 0, Math.min(w, h) / 2))]
  }
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

export function generateCuttingBoardD(p0: CuttingBoardSpec): string {
  const p: CuttingBoardSpec = {
    ...p0,
    w: Math.max(10, p0.w), h: Math.max(10, p0.h),
    handleW: Math.max(2, p0.handleW), handleL: Math.max(2, p0.handleL),
  }
  const { x, y, w, h } = p
  const cy = y + h / 2, right = x + w

  const body = bodyRings(p)
  let outline = body
  // The groove rings the CUTTING FIELD, which is not the outline. A paddle ADDS
  // material and must not drag the groove out along the neck; hand slots take a
  // strip of the board out of service and must push it back in, or the groove
  // runs straight across them and drains through the board.
  let field = body
  const holes: Pt[][] = []

  if (p.handle === 'paddle') {
    const hw = clamp(p.handleW, 4, h * 0.9)   // neck width, across the board
    const hl = Math.max(4, p.handleL)         // how far it reaches past the end
    const bury = Math.min(hw, w * 0.5)        // how far the neck runs into the body
    const neck = roundRectRing(right - bury, cy - hw / 2, hl + bury, hw, hw / 2)
    // Generous enough to read as a blend, but never wider than the shoulder it
    // has to land on, nor deeper than the handle is long.
    const fillet = Math.min(hw * 0.5, ((h - hw) / 2) * 0.8, hl * 0.8)
    outline = roundConcave(boolRings('union', body, [neck]), fillet)
  } else if (p.handle === 'slot' || p.handle === 'grips') {
    // Slots run ACROSS the board (their long axis is Y) and stand off the edge
    // by `handleInset`, so the strip left outboard of one is the rail your
    // fingers curl over. One slot hangs the board from its right end; two make
    // it a carry board.
    const len = clamp(p.handleW, 10, h * 0.75)      // along the board's height
    const wid = clamp(p.handleL, 6, w * 0.25)       // across it
    const gap = Math.max(CLEARANCE, p.handleInset)
    const ends: (1 | -1)[] = p.handle === 'grips' ? [-1, 1] : [1]
    for (const dir of ends) {
      const outer = dir > 0 ? right - gap : x + gap   // the slot's edge-side face
      // Slide inboard: on a curved body the board is too narrow to take the slot
      // right out at the end, and inboard is the only direction with more room.
      const slot = placeFeature(
        (t) => {
          const x0 = dir > 0 ? outer - wid - t * w * 0.25 : outer + t * w * 0.25
          return roundRectRing(x0, cy - len / 2, wid, len, wid / 2)
        },
        24, outline, [],
      )
      if (!slot) continue
      holes.push(slot)
      // Retire the whole end strip the slot sits in, out to past the board's
      // edge so the difference can never leave a hole in the field.
      const xs = slot.map((q) => q[0])
      const inner = dir > 0 ? Math.min(...xs) - CLEARANCE : Math.max(...xs) + CLEARANCE
      const strip = dir > 0
        ? roundRectRing(inner, y - h, right - inner + w, 3 * h, 0)
        : roundRectRing(x - w, y - h, inner - x + w, 3 * h, 0)
      field = boolRings('difference', field, [strip])
      // The strip is cut square, which would hand the groove a sharp inside
      // corner — something no core box bit can produce. Opening the field first
      // means the groove turns on an arc the tool can actually follow. Corners
      // already rounder than this survive untouched, so a board with a generous
      // `corner` still shows it through.
      field = roundConvex(field, clamp(p.grooveInset, 1, Math.min(w, h) / 2 - 1) + GROOVE_CORNER)
    }
  }

  const groove = p.groove && field.length > 0
    ? inflateRings(field, -clamp(p.grooveInset, 1, Math.min(w, h) / 2 - 1))
    : []

  // A hand slot already hangs the board, so it suppresses the hanging hole
  // rather than competing with it for the same end — which is why the panel
  // hides the checkbox there.
  if (p.hole && p.handle !== 'slot' && p.handle !== 'grips') {
    const dia = Math.max(2, p.holeDia)
    if (p.handle === 'paddle') {
      // Dead centre of the handle's round end — the one placement that leaves an
      // even wall all the way round.
      const hw = clamp(p.handleW, 4, h * 0.9)
      const hl = Math.max(4, p.handleL)
      const r = Math.min(dia, hw - 2 * CLEARANCE) / 2
      if (r > 0.5) holes.push(ellipseRing(right + hl - hw / 2, cy, r, r))
    } else {
      // No handle to put it in, so it goes in the top-left corner and walks in
      // along the diagonal until it clears the edge and the groove. The corner
      // is the only place with room on a grooved board: the groove turns inside
      // the corner, so the diagonal gap there is wider than the inset.
      const r = dia / 2
      const hole = placeFeature(
        (t) => {
          const d = r + CLEARANCE + t * Math.min(w, h) * 0.45
          return ellipseRing(x + d, y + h - d, r, r)
        },
        28, outline, groove,
      )
      if (hole) holes.push(hole)
    }
  }

  const parts: string[] = []
  for (const r of outline) parts.push(ringToD(r, true))
  for (const r of groove) parts.push(ringToD(r, false))
  for (const r of holes) parts.push(ringToD(r, false))
  return parts.join(' ')
}
