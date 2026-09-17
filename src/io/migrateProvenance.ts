// Hoisting provenance out of a saved event log and onto the objects.
//
// Up to .fkam v2 the parameters a generated path could be re-edited from lived in
// the timeline: an offset's distance on the `paths.add` event that made it, a
// boolean's operand on the `paths.edit`, a clock's whole spec on its own
// `clock.design` chip. Those now live on the paths themselves
// (`ImportedPath.definition` / `.clockSpec`), and the log is no longer saved at
// all — so an old project would open with its geometry intact but its offsets,
// patterns, booleans and clocks no longer editable, silently.
//
// This reads the old log ONCE at load and stamps what it finds onto the paths,
// after which the log is discarded. It never overwrites provenance a path already
// carries: a file saved between the two changes has the new fields AND the old
// events, and the object is the authority.

import type { ImportedPath, PathDefinition } from '../importers/svgImporter'
import type { ClockSpec } from '../shapes/clockTrain'
import type { OffsetCornerStyle } from '../tools/offsetOp'
import type { PatternParams } from '../tools/patternOp'
import type { BooleanOpType } from '../tools/booleanOps'

// The legacy event shapes, structurally — these types no longer exist in
// timeline/events.ts, and a migration has to describe what it reads rather than
// borrow a definition that has moved on without it.
interface LegacyPathRef { id: string }
interface LegacyEvent {
  kind: string
  id?: string
  paths?: LegacyPathRef[]
  add?: LegacyPathRef[]
  updates?: { id: string }[]
  offset?: { pairs: { sourceId: string; resultId: string }[]; distanceMM: number; cornerStyle: OffsetCornerStyle }
  pattern?: { sourceIds: string[]; params: PatternParams }
  duplicate?: { pairs: { sourceId: string; resultId: string }[]; offsetMM: number }
  boolOp?: BooleanOpType
  clockId?: string
  spec?: ClockSpec
}

export interface MigrationResult {
  paths: ImportedPath[]
  /** How many paths gained provenance, for the status line. */
  stamped: number
  clocks: number
}

export function migrateProvenance(paths: ImportedPath[], events: unknown): MigrationResult {
  if (!Array.isArray(events) || events.length === 0) return { paths, stamped: 0, clocks: 0 }

  const defById = new Map<string, PathDefinition>()
  const specByClock = new Map<string, ClockSpec>()

  for (const raw of events as LegacyEvent[]) {
    if (!raw || typeof raw !== 'object') continue
    // One generator call = one definition id, and the event's own id is exactly
    // that: a stable identifier shared by everything it produced.
    const defId = raw.id ?? `def-${defById.size}`

    if (raw.offset) {
      for (const pair of raw.offset.pairs ?? []) {
        defById.set(pair.resultId, {
          id: defId, kind: 'offset', sourceId: pair.sourceId,
          distanceMM: raw.offset.distanceMM, cornerStyle: raw.offset.cornerStyle,
        })
      }
    }
    if (raw.pattern) {
      for (const p of raw.paths ?? []) {
        defById.set(p.id, {
          id: defId, kind: 'pattern',
          sourceIds: raw.pattern.sourceIds ?? [], params: raw.pattern.params,
        })
      }
    }
    if (raw.duplicate) {
      for (const pair of raw.duplicate.pairs ?? []) {
        defById.set(pair.resultId, {
          id: defId, kind: 'duplicate', sourceId: pair.sourceId, offsetMM: raw.duplicate.offsetMM,
        })
      }
    }
    // A boolean's result is the path the edit ADDED; its sources are the paths it
    // updated (which it hid).
    if (raw.kind === 'paths.edit' && raw.add?.length) {
      for (const a of raw.add) {
        defById.set(a.id, {
          id: defId, kind: 'boolean', op: raw.boolOp ?? 'union',
          sourceIds: (raw.updates ?? []).map((u) => u.id),
        })
      }
    }
    // Later chips win: a clock re-run through the designer recorded its new spec
    // after the old one, and the last is what the parts were built from.
    if (raw.kind === 'clock.design' && raw.clockId && raw.spec) {
      specByClock.set(raw.clockId, raw.spec)
    }
  }

  let stamped = 0
  const clocks = new Set<string>()
  const out = paths.map((p) => {
    const def = p.definition ?? defById.get(p.id)
    const spec = p.clockSpec ?? (p.clockId ? specByClock.get(p.clockId) : undefined)
    if (def === p.definition && spec === p.clockSpec) return p
    if (def !== p.definition) stamped++
    if (spec !== p.clockSpec && p.clockId) clocks.add(p.clockId)
    return { ...p, ...(def ? { definition: def } : {}), ...(spec ? { clockSpec: spec } : {}) }
  })

  return { paths: out, stamped, clocks: clocks.size }
}
