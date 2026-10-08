// Jogging. A `$J=` line is Grbl's jog command: it runs as a jog (cancellable with
// JOG_CANCEL, refused outside Idle/Jog, never touches the modal state of a job),
// and it carries its own modes. Every jog we send names BOTH:
//   G91 — the move is relative, whatever G90/G91 the controller was left in
//   G21 — the numbers are mm, whatever the toolbar's mm/in toggle says
// so a jog cannot be misread by the controller's current modal state.

export const JOG_CANCEL = '\x85'

export interface JogMove { x?: number; y?: number; z?: number }

// Four places, trailing zeros trimmed: 0.001" is 0.0254 mm, and three places would
// drop 0.4 µm on every click of the smallest inch step.
const fmt = (v: number) => String(Number(v.toFixed(4)))

/** `$J=G91 G21 X10 Y-1.5 F1000` — distances and feed in mm, mm/min. */
export function jogCommand(move: JogMove, feedMMPerMin: number): string | null {
  const words: string[] = []
  if (move.x) words.push(`X${fmt(move.x)}`)
  if (move.y) words.push(`Y${fmt(move.y)}`)
  if (move.z) words.push(`Z${fmt(move.z)}`)
  if (!words.length || !(feedMMPerMin > 0)) return null
  return `$J=G91 G21 ${words.join(' ')} F${Math.round(feedMMPerMin)}`
}

/** Jog step sizes offered in each unit system, in mm. */
export const JOG_STEPS_MM: Record<'mm' | 'in', number[]> = {
  mm: [0.1, 1, 10, 50],
  in: [0.001, 0.01, 0.1, 1].map((i) => i * 25.4),
}

// Z's own steps: finer at the top end than XY's, since Z travel is a few tens of mm
// and a 50 mm step there is only ever a crash. Index for index the inch row matches
// the mm one (0.2" ≈ 5 mm), so flipping units lands on the matching size.
export const JOG_STEPS_Z_MM: Record<'mm' | 'in', number[]> = {
  mm: [0.1, 0.5, 1, 5],
  in: [0.005, 0.02, 0.05, 0.2].map((i) => i * 25.4),
}

export type Axis = 'x' | 'y' | 'z'

/**
 * `G10 L20 P0 X0` — make the current position the work zero on the named axes.
 * P0 is the ACTIVE coordinate system (G54 unless the user picked another), so
 * zeroing never silently writes to a system the job will not run in.
 */
export function zeroCommand(axes: Axis[]): string | null {
  if (!axes.length) return null
  return `G10 L20 P0 ${axes.map((a) => `${a.toUpperCase()}0`).join(' ')}`
}

/**
 * The jogs that take the tool to work position (x, y): an absolute (G90) jog in
 * work coordinates, so the stop button cancels it like any other jog. When
 * `liftToZ` is given, Z rises to it FIRST, so the tool is not dragged across the
 * stock — the caller passes it only when the tool is below that height.
 */
export function goToCommands(
  x: number, y: number, feedXY: number,
  lift?: { z: number; feedZ: number },
): string[] {
  if (!(feedXY > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return []
  const cmds: string[] = []
  const l = lift && zMoveCommand(lift.z, lift.feedZ)
  if (l) cmds.push(l)
  cmds.push(`$J=G90 G21 X${fmt(x)} Y${fmt(y)} F${Math.round(feedXY)}`)
  return cmds
}

/**
 * `$H` runs the machine's whole homing cycle, in the order its config gives;
 * `$HX` homes one axis. A machine with no switches refuses both (error:5).
 */
export function homeCommand(axis?: Axis): string {
  return axis ? `$H${axis.toUpperCase()}` : '$H'
}

// Override realtime bytes (Grbl 1.1 / FluidNC): acted on at once, mid-move, and
// reported back in the status `Ov:` field. Feed and spindle step by 10% or 1%
// (the controller clamps to 10–200%); rapid takes one of three fixed levels.
export const OVERRIDE = {
  feed: { reset: '\x90', plus10: '\x91', minus10: '\x92', plus1: '\x93', minus1: '\x94' },
  spindle: { reset: '\x99', plus10: '\x9A', minus10: '\x9B', plus1: '\x9C', minus1: '\x9D' },
  rapid: { 100: '\x95', 50: '\x96', 25: '\x97' },
} as const

export type OverrideStep = 'reset' | 'plus10' | 'minus10' | 'plus1' | 'minus1'

/** `$J=G90 G21 Z5 F300` — Z alone to an absolute work height, as a cancellable jog. */
export function zMoveCommand(z: number, feedZ: number): string | null {
  if (!(feedZ > 0) || !Number.isFinite(z)) return null
  return `$J=G90 G21 Z${fmt(z)} F${Math.round(feedZ)}`
}
