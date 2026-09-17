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

// Exported so the toolpath audit can load a saved .fkam through the real code path.
//
// `fileName` (the .fkam's own name, extension included or not) is the authority for the
// project name — rename the file on disk and the app follows. The `name` stored inside the
// file is only a fallback for callers that have no file name to offer.
export function loadProject(data: ProjectData, fileName?: string) {
  // Same reason as newProject: this replaces the paths every in-flight generation was
  // computed from, and it ends by regenerating everything anyway.
  abortGeneration()
  // Put the simulator away rather than letting the regenerate below invalidate it: a
  // different project's program is not a change to this one, so it must not arm the
  // auto-reload (sim/simAutoReload.ts).
  useSimStore.getState().clearSim()
  const wp = data.workpiece ?? {}
  const wps = useWorkpieceStore.getState()
  wps.setWidth(wp.widthMM ?? 300)
  wps.setHeight(wp.heightMM ?? 200)
  wps.setThickness(wp.thicknessMM ?? 18)
  wps.setUnits(wp.units ?? 'mm')
  wps.setOrigin(wp.origin ?? 'bottom-left')
  wps.setZOrigin(wp.zOrigin ?? 'top')
  wps.setMaterial(wp.material ?? 'mdf')
  wps.setTableLimitWidth(wp.tableLimitWidthMM ?? 800)
  wps.setTableLimitHeight(wp.tableLimitHeightMM ?? 600)
  wps.setTableLimitDepth(wp.tableLimitDepthMM ?? 70)
  wps.setMachineRigidity(wp.machineRigidity ?? 3)
  wps.setMaxFeed(wp.maxFeedMmMin ?? 3000)
  wps.setMinSpindleRpm(wp.minSpindleRpm ?? 8000)
  wps.setMaxSpindleRpm(wp.maxSpindleRpm ?? 24000)
  wps.setAutoFeedEnabled(wp.autoFeedEnabled ?? false)
  // Absent in projects saved before these were added to the file format — keep
  // the machine-local (localStorage) values instead of resetting to defaults.
  if (wp.safeHeightMM !== undefined) wps.setSafeHeight(wp.safeHeightMM)
  if (wp.spindleType !== undefined) wps.setSpindleType(wp.spindleType)

  if (Array.isArray(data.tools) && data.tools.length > 0) {
    useToolStore.getState().setTools(data.tools)
  }
  // v2 and earlier kept a generated path's parameters in the event log rather
  // than on the path. Hoist them before the paths go in, so an old project opens
  // with its offsets, patterns, booleans and clocks still editable.
  const migrated = migrateProvenance(data.paths ?? [], data.timeline?.events)
  usePathsStore.getState().replacePaths(migrated.paths)
  // The offset-ring spiral pocket strategy was dropped in 2026-07; rewrite the stored id so
  // the operation form shows a valid selection instead of an empty one.
  const operations = (data.operations ?? []).map(op => {
    if (op.type !== 'pocket') return op
    const legacy = (op.strategy as string) === 'spiral' || (op.strategy as string) === 'spiralOffset'
    return legacy ? { ...op, strategy: 'morph' as const } : op
  })
  useToolpathStore.getState().replaceOperations(operations)
  const nameFromFile = fileName?.replace(/\.[^.]+$/, '').trim()
  useProjectStore.getState().setName(nameFromFile || data.name || 'Untitled Project')

  if (data.postProcessors?.profiles?.length) {
    usePostProcessorStore.getState().replaceState(
      data.postProcessors.profiles,
      data.postProcessors.activeId,
    )
  }

  useTabStore.getState().replaceTabs(data.tabs ?? [])
  // After the paths: `replacePaths` drops constraints whose ends are not in the
  // document it was given, which is exactly what the OUTGOING project's
  // constraints are by then.
  useConstraintsStore.getState().replaceConstraints(migrateConstraints(data.constraints))

  useProjectStore.getState().markClean()
  // History is session-scoped: a snapshot stack holds live objects, which no file
  // can carry, so undo starts here rather than unwinding into the file's past.
  useTimelineStore.getState().resetToCurrentState()
  if (migrated.stamped > 0 || migrated.clocks > 0) {
    const bits = [
      migrated.stamped > 0 ? `${migrated.stamped} generated path${migrated.stamped > 1 ? 's' : ''}` : '',
      migrated.clocks > 0 ? `${migrated.clocks} clock${migrated.clocks > 1 ? 's' : ''}` : '',
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

export function newProject() {
  // Before anything is cleared: a generation still running would otherwise keep a core
  // busy for the rest of its solve and then write segments into the fresh project.
  abortGeneration()
  useSimStore.getState().clearSim()
  useUIStore.getState().setWorkspaceTab('2d')
  useUIStore.getState().setSidebarTab('draw')
  // Every panel goes, not a hand-written list of them: the clock designer was
  // missing from that list and stayed open over the empty project, still holding
  // the spec of a clock that no longer existed.
  useUIStore.getState().closeDrawPanels()
  useUIStore.getState().setTabsFormActive(false)
  useUIStore.getState().setHelpOpen(false)
  useUIStore.getState().setEscapementInfoOpen(false)
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

export function openProjectFile(): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.fkam,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) { resolve(); return }
      try {
        const text = await file.text()
        const data = JSON.parse(text) as ProjectData
        loadProject(data, file.name)
        resolve()
      } catch (err) {
        console.error('Project load failed:', err)
        reject(err)
      }
    }
    input.click()
  })
}
