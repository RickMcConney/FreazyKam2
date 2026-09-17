import type { ImportedPath } from '../importers/svgImporter'
import type { PathUpdate } from '../store/pathsStore'
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'
import type { Tab } from '../store/tabStore'
import { constraintName, type Constraint } from '../store/constraints'
import { shapeDisplayName, type ShapeParams } from '../shapes/shapeGenerators'
import type { Units, OriginPosition, ZOrigin, Material } from '../store/workpieceStore'

// Omit distributed over a union (plain Omit collapses AnyOperation to common keys)
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

// An operation as stored in timeline events and checkpoints: settings only.
// segments/status/errorMessage are derived, so a recorded payload omits them.
// Exception: 'gcode' ops keep their segments — they came from a parsed file and
// cannot be regenerated from the op's settings.
export type SerializedOperation = DistributiveOmit<AnyOperation, 'segments' | 'status' | 'errorMessage'> & {
  segments?: MotionSegment[]
}

export function serializeOp(op: AnyOperation): SerializedOperation {
  const { segments, status: _status, errorMessage: _err, ...rest } = op
  return op.type === 'gcode' ? { ...rest, segments } : rest
}

export function hydrateOp(sop: SerializedOperation): AnyOperation {
  const segments = sop.segments ?? []
  return {
    ...sop,
    segments,
    status: sop.type === 'gcode' && segments.length > 0 ? 'done' : 'needs-update',
  } as AnyOperation
}

// Fields regenerate/setSegments/optimizeStartPoints write back onto ops
// outside any user action (entryHint is rewritten on EVERY sim run / G-code
// export). They are stripped from op.update event payloads, so a derived write
// never shows up as a chip.
export const DERIVED_OP_KEYS = ['status', 'segments', 'errorMessage', 'helicalHoles', 'helicalCenterX', 'helicalCenterY', 'helicalRadius', 'entryHint', 'generatedWith'] as const

// An op reduced to the fields a recorded payload actually carries. Live ops hold
// state no event records, so comparing a raw op against a recorded one always
// reports a difference once the project has been used:
// - visible: IS recorded (op.setVisible) but stays out of the comparison, so a
//   visibility toggle does not read as a settings change.
// - entryHint/generatedWith: written by optimizeStartPoints before a sim run or
//   G-code export
// - helicalHoles + helicalCenterX/Y/helicalRadius: written back by regenerate with
//   { record: false } — they are DERIVED from the source path's circles
export function comparableOp(op: SerializedOperation): Record<string, unknown> {
  const { visible: _v, entryHint: _eh, generatedWith: _gw, ...rest } = op as SerializedOperation & { visible?: boolean }
  if (rest.type === 'drill') {
    delete rest.helicalCenterX
    delete rest.helicalCenterY
    delete rest.helicalRadius
  }
  return rest as Record<string, unknown>
}

// Do two ops carry the same recorded settings? Key-wise rather than
// JSON.stringify over the whole object: spread-built ops ({ ...o, ...updates })
// can legitimately differ in key ORDER, which whole-object stringify would
// report as a difference.
export function sameOpSettings(a: SerializedOperation, b: SerializedOperation): boolean {
  const ca = comparableOp(a)
  const cb = comparableOp(b)
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)])
  for (const k of keys) {
    const va = ca[k], vb = cb[k]
    if (va === vb) continue                                  // fast path: primitives + identity
    if (JSON.stringify(va) !== JSON.stringify(vb)) return false
  }
  return true
}

export type PathsAddSource = 'import' | 'shape' | 'pen' | 'text' | 'duplicate' | 'boolean' | 'offset' | 'pattern' | 'paste'

// What kind of gesture produced a paths.edit event — names the chip and picks
// its icon. Display metadata only.
// 'transform' is synthetic: timelineStore's coalesce() stamps it on a chip
// that chained two or more DIFFERENT pure-geometry gestures (e.g. Move then
// Rotate on the same path, nothing else in between) into one entry.
export type PathEditGesture = 'move' | 'scale' | 'rotate' | 'skew' | 'mirror' | 'transform' | 'corner' | 'points' | 'join' | 'weld' | 'trim' | 'text' | 'boolean'

export const GESTURE_LABELS: Record<PathEditGesture, string> = {
  move: 'Move',
  scale: 'Scale',
  rotate: 'Rotate',
  skew: 'Skew',
  mirror: 'Mirror',
  transform: 'Transform',
  corner: 'Corner',
  points: 'Edit Points',
  join: 'Join',
  weld: 'Weld',
  trim: 'Trim',
  text: 'Text',
  boolean: 'Boolean',
}

// Pure-geometry transform gestures: each one fully rewrites a path's `d` from
// its own inputs, so a chain of these on the same path set with nothing else
// in between (no other selection, no other edit) has no use for its
// intermediate steps — only the net result matters. timelineStore's
// coalesce() merges runs of these into one chip regardless of how much time
// passes between them, unlike the generic keystroke-rate coalescing.
export const TRANSFORM_GESTURES: ReadonlySet<PathEditGesture> = new Set(['move', 'scale', 'rotate', 'skew', 'mirror', 'transform'])

// Project-scoped workpiece settings (machine-local settings — table limits,
// rigidity, feeds, spindle, safe height — stay out of the timeline).
export interface WorkpieceEventChanges {
  widthMM?: number
  heightMM?: number
  thicknessMM?: number
  units?: Units
  origin?: OriginPosition
  zOrigin?: ZOrigin
  material?: Material
}

export interface TimelineEventBase {
  seq: number               // 1-based, monotonic; seq === index + 1
  id: string                // uid('ev')
  t: number                 // epoch ms (display + coalescing window)
  label: string             // human-readable: "Rotate 2 paths", "Add Pocket op"
  selectionAfter: string[]  // pathsStore.selectedIds after the event
  gestureId?: string        // shared across events emitted by one user gesture
}

export type TimelineEventPayload =
  // ---- paths ----
  | { kind: 'paths.add'; paths: ImportedPath[]; source?: PathsAddSource }
  | { kind: 'paths.edit'; updates: PathUpdate[]; add?: ImportedPath[]; deleteIds?: string[]; gesture?: PathEditGesture }
  | { kind: 'paths.split'; pathId: string; subPaths: ImportedPath[]; opsAfter: SerializedOperation[] | null }
  | { kind: 'paths.setHidden'; ids: string[]; hidden: boolean }
  | { kind: 'shape.params'; pathId: string; params: ShapeParams }
  // ---- CAM operations ----
  // opType on update/delete is display metadata (chip icon/label survives the
  // op being gone) — replay ignores it.
  // `linked` carries the sibling ops created by the SAME Generate click — an inlay's
  // roughing + finishing phases are two operations but one user action, and the
  // timeline records actions. `op` is the one a chip click opens for editing.
  | { kind: 'op.add'; op: SerializedOperation; linked?: SerializedOperation[] }
  | { kind: 'op.update'; opId: string; opType?: string; updates: Partial<SerializedOperation> }
  | { kind: 'op.delete'; opIds: string[]; opType?: string }
  | { kind: 'op.reorder'; order: string[] }
  // Hiding an operation is not a view toggle: generateGcode skips invisible ops, so it
  // decides what lands in the exported program. Recorded for that reason — it undoes, and
  // replay restores it instead of quietly showing everything again.
  | { kind: 'op.setVisible'; opIds: string[]; visible: boolean; opType?: string }
  // ---- tabs ----
  | { kind: 'tabs.apply'; pathId: string; tabs: Tab[] }  // replaces all tabs of pathId
  | { kind: 'tabs.delete'; tabIds: string[] }
  | { kind: 'tabs.moveT'; tabId: string; t01: number }
  // ---- constraints ----
  // A constraint is not a property of either path it joins, so it is its own
  // object with its own events — see store/constraints.ts.
  | { kind: 'constraint.add'; constraint: Constraint }
  | { kind: 'constraint.update'; constraintId: string; changes: Partial<Omit<Constraint, 'id'>> }
  | { kind: 'constraint.delete'; constraintIds: string[] }
  // ---- project ----
  | { kind: 'workpiece.set'; changes: WorkpieceEventChanges }

export type TimelineEvent = TimelineEventBase & TimelineEventPayload

// Runtime registry of event kinds this build can replay. The project loader
// rejects a saved timeline containing unknown kinds (from a newer version)

export const OP_DISPLAY_NAMES: Record<string, string> = {
  profile: 'Profile',
  trochoidal: 'Trochoidal',
  pocket: 'Pocket',
  drill: 'Drill',
  surface: 'Surface',
  vcarve: 'V-Carve',
  photovcarve: 'Photo V-Carve',
  inlay: 'Inlay',
  profile3d: '3D Profile',
  gcode: 'G-code',
}

export const opDisplayName = (type: string | undefined): string =>
  (type && OP_DISPLAY_NAMES[type]) || 'Operation'

// Chip labels name the THING, not the verb — "Circle", "Pocket" — matching
// the names used in the shape panel and the CAM operations menu.
export function labelFor(ev: TimelineEventPayload): string {
  switch (ev.kind) {
    case 'paths.add': {
      const n = ev.paths.length
      switch (ev.source) {
        case 'import': return n === 1 ? 'Import' : `Import ×${n}`
        case 'shape':
        case 'text': {
          const t = ev.paths[0]?.shapeParams?.type
          return t ? shapeDisplayName(t) : ev.source === 'text' ? 'Text' : 'Shape'
        }
        case 'pen': return 'Pen Path'
        case 'duplicate': return n === 1 ? 'Duplicate' : `Duplicate ×${n}`
        case 'boolean': return 'Boolean'
        case 'offset': return n === 1 ? 'Offset' : `Offset ×${n}`
        case 'pattern': return `Pattern ×${n}`
        default: return n === 1 ? 'Path' : `${n} Paths`
      }
    }
    case 'paths.edit': {
      if (ev.gesture) return GESTURE_LABELS[ev.gesture]
      const nUpd = ev.updates.length
      const nDel = ev.deleteIds?.length ?? 0
      const nAdd = ev.add?.length ?? 0
      if (nDel > 0 && nUpd === 0 && nAdd === 0) return `Delete ${nDel === 1 ? 'path' : `${nDel} paths`}`
      if (nUpd > 0 && nDel === 0 && nAdd === 0) return `Edit ${nUpd === 1 ? 'path' : `${nUpd} paths`}`
      return 'Modify paths'
    }
    case 'paths.split': return 'Split path'
    case 'paths.setHidden': return ev.hidden ? 'Hide paths' : 'Show path'
    case 'shape.params': return shapeDisplayName(ev.params.type)
    case 'op.add': return opDisplayName(ev.op.type)
    case 'op.update': return opDisplayName(ev.opType)
    case 'op.delete': return ev.opIds.length === 1 ? `Delete ${opDisplayName(ev.opType)}` : `Delete ${ev.opIds.length} Operations`
    case 'op.reorder': return 'Reorder Operations'
    case 'op.setVisible': {
      const what = ev.opIds.length === 1 ? opDisplayName(ev.opType) : `${ev.opIds.length} Operations`
      return ev.visible ? `Show ${what}` : `Hide ${what}`
    }
    case 'tabs.apply': return `Tabs ×${ev.tabs.length}`
    case 'tabs.delete': return ev.tabIds.length === 1 ? 'Delete tab' : `Delete ${ev.tabIds.length} tabs`
    case 'tabs.moveT': return 'Move tab'
    case 'constraint.add': return constraintName(ev.constraint)
    case 'constraint.update': return 'Constraint'
    case 'constraint.delete':
      return ev.constraintIds.length === 1 ? 'Delete constraint' : `Delete ${ev.constraintIds.length} constraints`
    case 'workpiece.set': {
      const keys = Object.keys(ev.changes)
      const dims = ['widthMM', 'heightMM', 'thicknessMM']
      if (keys.length > 0 && keys.every((k) => dims.includes(k))) return 'Stock Size'
      if (keys.length === 1) {
        if (keys[0] === 'units') return 'Units'
        if (keys[0] === 'origin') return 'Origin'
        if (keys[0] === 'zOrigin') return 'Z Origin'
        if (keys[0] === 'material') return 'Material'
      }
      return 'Stock'
    }
  }
}

// Broad family used for chip coloring in the timeline UI.
export type EventFamily = 'path' | 'op' | 'tab' | 'project'

export function familyOf(kind: TimelineEvent['kind']): EventFamily {
  if (kind.startsWith('paths.') || kind === 'shape.params') return 'path'
  if (kind.startsWith('op.')) return 'op'
  if (kind.startsWith('tabs.')) return 'tab'
  // A constraint is drawn attached to the parts it joins, so it reads as
  // something done TO them rather than as a thing of its own.
  if (kind.startsWith('constraint.')) return 'path'
  return 'project'
}
