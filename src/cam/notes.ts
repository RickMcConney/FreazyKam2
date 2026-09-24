// Non-fatal notes from a generation — what a generator did that the user did not ask for.
//
// A strategy that declined a shape and fell back, a v-carve region the medial axis could
// not be built for, an inlay sub-cut that was too small for its tool: the op still
// generates, so there is no error to carry it, and silently machining something other
// than what was asked is how a surprise ends up on the spindle. Each used to be either a
// pocket-only module global or a console line nobody sees.
//
// Ambient, like `progress.ts`, and for the same reason: generators run inside a worker,
// one job at a time, and nest (inlay calls pocket and v-carve several times over), so
// threading a collector through every signature would touch every generator for the sake
// of a side channel. The worker handler clears it before a job and drains it after
// (workers/handlers.ts); harnesses that call generators directly can ignore it.

/**
 * `kind` rather than a string to match on: the status bar takes `short`, one truncating
 * line (keep it under ~55 characters), while a form's banner can say more and knows the
 * user-facing names of things.
 */
export interface GenNote {
  kind: 'strategy-fallback' | 'region-skipped' | 'subcut-skipped'
  short: string
}

const pending: GenNote[] = []

/** Record a note. An identical one already pending is not repeated — a generator that
 *  runs once per depth level or per region would otherwise say the same thing N times. */
export function addNote(note: GenNote): void {
  if (!pending.some((n) => n.kind === note.kind && n.short === note.short)) pending.push(note)
}

/** Everything noted since the last take, and clear. */
export function takeNotes(): GenNote[] {
  return pending.splice(0, pending.length)
}
