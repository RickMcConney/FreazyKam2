import { regenerateAll } from '../cam/regenerate'
import { abortGeneration } from '../workers/abortGeneration'
import { useProjectStore } from '../store/projectStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { usePostProcessorStore, type PostProcessorProfile } from '../store/postProcessorStore'
import { useSimStore } from '../store/simStore'
import { useUIStore } from '../store/uiStore'
import { useCanvasStore } from '../store/canvasStore'
import { useTabStore, type Tab } from '../store/tabStore'
import { PROJECT_VERSION } from './projectSave'
import { useConstraintsStore } from '../store/constraintsStore'
import type { Constraint } from '../store/constraints'
import { useTimelineStore } from '../timeline/timelineStore'
import { migrateProvenance } from './migrateProvenance'
import type { ImportedPath } from '../store/pathsStore'
import type { AnyOperation } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { Units, OriginPosition, ZOrigin, Material } from '../store/workpieceStore'
import type { SpindleType } from '../store/spindle'

interface SavedWorkpiece {
  widthMM: number
  heightMM: number
  thicknessMM: number
  units: Units
  origin: OriginPosition
  zOrigin?: ZOrigin
  material: Material
  tableLimitWidthMM: number
  tableLimitHeightMM: number
  tableLimitDepthMM: number
  machineRigidity?: number
  maxFeedMmMin?: number
  minSpindleRpm?: number
  maxSpindleRpm?: number
  autoFeedEnabled?: boolean
  safeHeightMM?: number
  spindleType?: SpindleType
}

export interface ProjectData {
  version: number
  name: string
  workpiece: SavedWorkpiece
  tools: Tool[]
  paths: ImportedPath[]
  operations: AnyOperation[]
  postProcessors?: {
    profiles: PostProcessorProfile[]
    activeId: string
  }
  tabs?: Tab[]
  // v4 and later. A v3 or earlier project has none, and a v4 one holds them in
  // the pre-polar shape `migrateConstraints` reads.
  constraints?: (Constraint | LegacyConstraint)[]
  // v2 ONLY, and never written again: the operation timeline. It is not restored
  // — undo is a snapshot stack now and history starts at the load — but it is
  // still READ once, to hoist the provenance of generated paths onto the paths
  // themselves. See io/migrateProvenance.ts.
  timeline?: { events?: unknown }
}

/** A file that cannot be opened as a project, with a message fit for the status bar. */
export class ProjectFileError extends Error {}

// Every operation type this version can generate, exported or display. Typed as a Record
// over the union so a new operation type is a compile error here until it is listed.
const OP_TYPES: Record<AnyOperation['type'], true> = {
  profile: true, pocket: true, drill: true, surface: true, vcarve: true, photovcarve: true,
  inlay: true, profile3d: true, trochoidal: true, gcode: true,
}

/** A project file, validated and migrated, and not yet installed anywhere. */
interface ParsedProject {
  name: string
  workpiece: Partial<SavedWorkpiece>
  tools: Tool[]
  paths: ImportedPath[]
  operations: AnyOperation[]
  postProcessors?: ProjectData['postProcessors']
  tabs: Tab[]
  constraints: Constraint[]
  /** Upgrades made to an older file, for the status line. */
  migrated: { stamped: number; clocks: number }
  /** The file was written by a newer version than this one. */
  newerVersion: boolean
  /** Operations of a type this version does not know, left out. */
  droppedOps: number
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Read a project file's contents WITHOUT touching the app — validate it, migrate it, and
 * hand back exactly what will be installed. Throws `ProjectFileError` for anything that
 * cannot be opened.
 *
 * This is split from the install so a bad file fails BEFORE the open document is let go
 * of. Loading used to write the stores one after another as it read the file, so a file
 * that broke halfway (a path with no outline, a list that was not a list) left the new
 * stock under the old drawing, or the new paths under the old operations — and, from the
 * autosave restore at boot, cleared the recovery snapshot on the way out.
 *
 * Only the shape everything downstream DEPENDS on is checked: that the lists are lists,
 * and that each path, operation, tool and tab carries the ids and the outline the rest of
 * the app looks things up by. Settings with a default are left to the install below.
 */
export function parseProject(data: unknown): ParsedProject {
  if (!isObj(data)) throw new ProjectFileError('this is not a FreazyKam project')
  const list = <T,>(field: string, what: string, valid: (v: Record<string, unknown>) => boolean): T[] => {
    const v = data[field]
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) throw new ProjectFileError(`its ${what} list is damaged`)
    v.forEach((item, i) => {
      if (!isObj(item) || !valid(item)) throw new ProjectFileError(`${what} ${i + 1} is damaged`)
    })
    return v as T[]
  }
  const str = (v: unknown) => typeof v === 'string'

  const version = typeof data.version === 'number' ? data.version : 0
  const workpiece = isObj(data.workpiece) ? data.workpiece as Partial<SavedWorkpiece> : {}
  const tools = list<Tool>('tools', 'tool', (t) => str(t.id))
  const rawPaths = list<ImportedPath>('paths', 'path', (p) => str(p.id) && str(p.d))
  const allOps = list<AnyOperation>('operations', 'operation', (o) => str(o.id) && str(o.type))
  const tabs = list<Tab>('tabs', 'tab', (t) => str(t.id) && str(t.pathId))
  const constraints = list<Constraint | LegacyConstraint>('constraints', 'constraint', (c) => str(c.id))

  // A newer version's operation type cannot be generated, shown or exported here, and
  // would trip the first switch over op.type that meets it. Leave it out, and say so.
  const known = allOps.filter((op) => op.type in OP_TYPES)
  // Dropped pocket strategies — the offset-ring spiral (2026-07) and the Adaptive2d port
  // (2026-09); rewrite the stored id so the operation form shows a valid selection instead
  // of an empty one.
  const operations = known.map((op) => {
    if (op.type !== 'pocket') return op
    const s = op.strategy as string
    if (s === 'spiral' || s === 'spiralOffset') return { ...op, strategy: 'morph' as const }
    if (s === 'adaptive') return { ...op, strategy: 'adaptive2' as const }
    return op
  })

  // v2 and earlier kept a generated path's parameters in the event log rather than on the
  // path. Hoisted here so an old project opens with its offsets, patterns, booleans and
  // clocks still editable.
  const timeline = isObj(data.timeline) ? data.timeline : undefined
  let migrated
  try {
    migrated = migrateProvenance(rawPaths, timeline?.events)
  } catch {
    throw new ProjectFileError('its drawing history could not be read')
  }

  const post = isObj(data.postProcessors) ? data.postProcessors as ProjectData['postProcessors'] : undefined
  return {
    name: str(data.name) ? data.name as string : '',
    workpiece,
    tools,
    paths: migrated.paths,
    operations,
    postProcessors: Array.isArray(post?.profiles) ? post : undefined,
    tabs,
    constraints: migrateConstraints(constraints),
    migrated: { stamped: migrated.stamped, clocks: migrated.clocks },
    newerVersion: version > PROJECT_VERSION,
    droppedOps: allOps.length - known.length,
  }
}

// Exported so the toolpath audit can load a saved .fkam through the real code path.
//
// `fileName` (the .fkam's own name, extension included or not) is the authority for the
// project name — rename the file on disk and the app follows. The `name` stored inside the
// file is only a fallback for callers that have no file name to offer.
//
// Throws `ProjectFileError`, with the open document untouched, when the file cannot be read.
export function loadProject(data: ProjectData | unknown, fileName?: string) {
  installProject(parseProject(data), fileName)
}

function installProject(project: ParsedProject, fileName?: string) {
  leaveDocument()
  const wp = project.workpiece
  // A number the file actually holds, or the default — a hand-edited "300" or null must not
  // reach the stock size.
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const wps = useWorkpieceStore.getState()
  wps.setWidth(num(wp.widthMM, 300))
  wps.setHeight(num(wp.heightMM, 200))
  wps.setThickness(num(wp.thicknessMM, 18))
  wps.setUnits(wp.units ?? 'mm')
  wps.setOrigin(wp.origin ?? 'bottom-left')
  wps.setZOrigin(wp.zOrigin ?? 'top')
  wps.setMaterial(wp.material ?? 'mdf')
  wps.setTableLimitWidth(num(wp.tableLimitWidthMM, 800))
  wps.setTableLimitHeight(num(wp.tableLimitHeightMM, 600))
  wps.setTableLimitDepth(num(wp.tableLimitDepthMM, 70))
  wps.setMachineRigidity(num(wp.machineRigidity, 3))
  wps.setMaxFeed(num(wp.maxFeedMmMin, 3000))
  wps.setMinSpindleRpm(num(wp.minSpindleRpm, 8000))
  wps.setMaxSpindleRpm(num(wp.maxSpindleRpm, 24000))
  wps.setAutoFeedEnabled(wp.autoFeedEnabled ?? false)
  // Absent in projects saved before these were added to the file format — keep
  // the machine-local (localStorage) values instead of resetting to defaults.
  if (typeof wp.safeHeightMM === 'number' && Number.isFinite(wp.safeHeightMM)) wps.setSafeHeight(wp.safeHeightMM)
  if (wp.spindleType !== undefined) wps.setSpindleType(wp.spindleType)

  if (project.tools.length > 0) useToolStore.getState().setTools(project.tools)
  usePathsStore.getState().replacePaths(project.paths)
  useToolpathStore.getState().replaceOperations(project.operations)
  const nameFromFile = fileName?.replace(/\.[^.]+$/, '').trim()
  useProjectStore.getState().setName(nameFromFile || project.name || 'Untitled Project')

  if (project.postProcessors?.profiles?.length) {
    usePostProcessorStore.getState().replaceState(
      project.postProcessors.profiles,
      project.postProcessors.activeId,
    )
  }

  useTabStore.getState().replaceTabs(project.tabs)
  // After the paths: `replacePaths` drops constraints whose ends are not in the
  // document it was given, which is exactly what the OUTGOING project's
  // constraints are by then.
  useConstraintsStore.getState().replaceConstraints(project.constraints)

  useProjectStore.getState().markClean()
  // History is session-scoped: a snapshot stack holds live objects, which no file
  // can carry, so undo starts here rather than unwinding into the file's past.
  useTimelineStore.getState().resetToCurrentState()
  // The loaded drawing can be anywhere on (or off) the stock, and the view was framing
  // the last one.
  useCanvasStore.getState().requestFit()
  const { stamped, clocks } = project.migrated
  // One status line, so the warning that loses something wins over the upgrade note.
  if (project.newerVersion || project.droppedOps > 0) {
    const dropped = project.droppedOps > 0
      ? ` ${project.droppedOps} operation${project.droppedOps > 1 ? 's' : ''} of a kind this version does not have ${project.droppedOps > 1 ? 'were' : 'was'} left out.`
      : ''
    useUIStore.getState().showStatus(
      `This project was saved by a newer version of FreazyKam — anything this version does not know about is not shown, and saving will drop it.${dropped}`,
      'warn',
    )
  } else if (stamped > 0 || clocks > 0) {
    const bits = [
      stamped > 0 ? `${stamped} generated path${stamped > 1 ? 's' : ''}` : '',
      clocks > 0 ? `${clocks} clock${clocks > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' and ')
    useUIStore.getState().showStatus(`Upgraded an older project — ${bits} can be edited from their chips again.`, 'info')
  }
  regenerateAll()
}

// A v4 constraint: separate X, Y and plain-distance kinds, one number each.
type LegacyConstraint = {
  id: string
  kind: 'distance' | 'distX' | 'distY'
  from: Constraint['from']
  to: Constraint['to']
  valueMM: number
}

/**
 * v4 constraints read as polar ones.
 *
 * An X or a Y distance becomes a distance held at the axis angle its sign
 * implies — 40 mm at 0° for `distX: 40`, at 180° for `distX: -40` — which is
 * what the parts were actually standing at, so nothing moves on load. It holds
 * MORE than the old one did (the free axis is now pinned too), and that is the
 * honest reading: there is no polar constraint that says "hold X and leave Y
 * alone", and quietly dropping the constraint instead would open the project
 * with parts that look right and are no longer held.
 */
function migrateConstraints(saved: (Constraint | LegacyConstraint)[] | undefined): Constraint[] {
  if (!saved) return []
  return saved.map((c) => {
    if (!('kind' in c)) return c
    const { kind, valueMM, ...rest } = c
    if (kind === 'distance') return { ...rest, distanceMM: valueMM }
    const along = kind === 'distX' ? 0 : 90
    return {
      ...rest,
      distanceMM: Math.abs(valueMM),
      angleDeg: valueMM < 0 ? along + 180 : along,
    }
  })
}

/**
 * Let go of the open document, ahead of installing another one — New Project, a project
 * load, an autosave restore. Both callers go through here so they cannot drift again:
 * newProject grew a hand-written list of panels to close (after the clock designer stayed
 * open over the empty project, still holding the spec of a clock that no longer existed)
 * and loadProject never had one, so opening a file left the old document's designer,
 * machine form or node-edit session open over the new one.
 *
 * Must run BEFORE the stores are replaced: the epoch bump is what stops an open node-edit
 * session from committing its old nodes into the incoming document (see
 * useNodeEditSession), and the generation abort must land before a running job can write
 * segments into it.
 */
function leaveDocument(): void {
  // A generation still running would keep a core busy for the rest of its solve and then
  // write segments computed from paths that are about to be gone.
  abortGeneration()
  // Put the simulator away rather than letting a regenerate invalidate it: a different
  // project's program is not a change to this one, so it must not arm the auto-reload
  // (sim/simAutoReload.ts).
  useSimStore.getState().clearSim()
  useProjectStore.getState().bumpDocumentEpoch()
  useUIStore.getState().closeDocumentUi()
}

/**
 * Is there anything on screen that a New Project would throw away for good? The document
 * itself is the answer — an empty one has nothing to lose, and a saved one is on disk under
 * its own name — so this is the timeline's own dirty test (cursor !== savedSeq, the same one
 * autosave writes into its snapshot), plus "is the document non-empty at all" for the case
 * where the timeline has not recorded anything yet.
 */
export function hasUnsavedWork(): boolean {
  const tl = useTimelineStore.getState()
  if (tl.cursor === tl.savedSeq) return false
  return (
    usePathsStore.getState().paths.length > 0 ||
    useToolpathStore.getState().operations.length > 0
  )
}

/**
 * New Project, with the discard confirmed first — what the toolbar button and Ctrl+N call.
 *
 * The button sits alongside Open and Save and Ctrl+N is a slip away from the chords next to
 * it, and New Project is NOT recoverable: it calls resetToCurrentState, which drops every
 * recorded event, so Ctrl+Z afterwards has nothing to undo. (An App.tsx comment used to
 * claim otherwise.) A user hit it by accident and lost their work.
 *
 * The dialog only appears when there IS work to lose: over an empty or already-saved
 * document the question has one answer, and a dialog in front of that is a step to get past
 * rather than a decision — the same reasoning as the autosave restore (io/autosave.ts).
 */
export function requestNewProject(): void {
  if (!hasUnsavedWork()) { newProject(); return }
  useUIStore.getState().setConfirmNewProject(true)
}

export function newProject() {
  useUIStore.getState().setConfirmNewProject(false)
  leaveDocument()
  useUIStore.getState().setWorkspaceTab('2d')
  useUIStore.getState().setSidebarTab('draw')
  useUIStore.getState().setHelpOpen(false)
  usePathsStore.getState().replacePaths([])
  useToolpathStore.getState().replaceOperations([])
  useTabStore.getState().replaceTabs([])
  useConstraintsStore.getState().replaceConstraints([])
  useProjectStore.getState().setName('Untitled Project')
  useProjectStore.getState().markClean()
  useTimelineStore.getState().resetToCurrentState()
  useCanvasStore.getState().requestFit()
  // Workpiece settings (size, origin, thickness, material) are persisted in
  // localStorage and intentionally kept across new projects.
}

/**
 * Ask for a .fkam and open it. Always RESOLVES — a file that cannot be opened is reported on
 * the status bar here, in one place, and the open document is left exactly as it was. (The
 * Toolbar used to swallow the rejection and Ctrl+O left it unhandled, so a damaged file did
 * nothing at all as far as the user could see.)
 */
export function openProjectFile(): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.fkam,.json'
    // Closing the picker without choosing fires `cancel`, not `change`.
    input.oncancel = () => resolve()
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) { resolve(); return }
      try {
        const text = await file.text()
        let data: unknown
        try {
          data = JSON.parse(text)
        } catch {
          throw new ProjectFileError('this is not a FreazyKam project')
        }
        loadProject(data, file.name)
      } catch (err) {
        console.error('Project load failed:', err)
        const why = err instanceof ProjectFileError ? err.message : 'it could not be read'
        useUIStore.getState().showStatus(`Could not open ${file.name} — ${why}.`, 'error')
      }
      resolve()
    }
    input.click()
  })
}
