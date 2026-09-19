// Point adapters between this codebase's `Pt2` rings ([x, y] pairs, CNC mm) and the
// `{x, y}` objects clipper2-ts takes and returns.
//
// These were hand-copied into five files. They are trivial, but they are the seam where a
// ring's REPRESENTATION changes, and two things about that seam are worth stating once:
//
//   Winding is the caller's business. Clipper reads a compound region as CCW outers plus
//   CW holes, so anything building one pairs `toCP` with `ensureWinding` (pathFlattener) —
//   the adapter deliberately does not orient, because only the caller knows which ring is
//   the boundary and which are the islands.
//
//   Clipper returns rings OPEN — no repeated first vertex. `fromCP` still strips one, for
//   the same reason `stripClosingDuplicate` exists at all: a closing duplicate is a
//   zero-length edge, and zero-length edges reach the tangent and normal maths downstream
//   as a divide by zero. It is a guard on the boundary, not a transformation.

import { stripClosingDuplicate } from './geom'
import type { Pt2 } from './pathFlattener'

/** A ring as clipper2-ts wants it. */
export type CPRing = { x: number; y: number }[]

/** `Pt2` ring → clipper ring. Winding is left exactly as given. */
export const toCP = (pts: Pt2[]): CPRing => pts.map(([x, y]) => ({ x, y }))

/** Clipper ring → `Pt2` ring, without a closing duplicate vertex. */
export const fromCP = (r: CPRing): Pt2[] => stripClosingDuplicate(r.map(({ x, y }) => [x, y] as Pt2))
