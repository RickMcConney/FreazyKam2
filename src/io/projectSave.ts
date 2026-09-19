import { useProjectStore } from '../store/projectStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useTabStore } from '../store/tabStore'
import { useConstraintsStore } from '../store/constraintsStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { sanitizeFileName } from './filename'
import { downloadText } from './download'

// v3: the `timeline` block is GONE. It held an event log so undo history could
// survive save/load, back when undo replayed that log; undo is a snapshot stack
// of live objects now, which no file can hold, so history is session-scoped and
// the block had nothing left to do but bloat the file. What it also carried —
// the parameters generated paths could be re-edited from — moved onto the paths
// themselves, and `io/migrateProvenance.ts` hoists it out of v2 files on load.
// v4 added `constraints`; v5 is the same block holding POLAR ones — a distance
// and an angle in a single constraint per pair, in place of the separate X and Y
// distances v4 wrote (see store/constraints.ts, and `migrateConstraints` in
// projectLoad for what an old file becomes). A v3 file has no constraints at
// all, so the migration for it is a default value rather than a migration.
export const PROJECT_VERSION = 5

export function buildProjectData() {
  const { name } = useProjectStore.getState()
  const {
    widthMM, heightMM, thicknessMM, units, origin, zOrigin, material,
    tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
    machineRigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, autoFeedEnabled,
    safeHeightMM, spindleType,
  } = useWorkpieceStore.getState()
  const { tools } = useToolStore.getState()
  const { paths } = usePathsStore.getState()
  const { operations: rawOps } = useToolpathStore.getState()
  // Strip computed segments — they're regenerated on load. Imported G-code text is
  // session-only too: the project file does not carry imported programs.
  const operations = rawOps.map(({ segments: _segs, status: _status, ...op }) => ({
    ...(op.type === 'gcode' ? { ...op, gcode: undefined } : op),
    segments: [] as typeof _segs,
    status: 'needs-update' as const,
  }))
  const { profiles, activeId } = usePostProcessorStore.getState()
  const { tabs } = useTabStore.getState()
  const { constraints } = useConstraintsStore.getState()

  return {
    version: PROJECT_VERSION,
    name,
    workpiece: {
      widthMM, heightMM, thicknessMM, units, origin, zOrigin, material,
      tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
      machineRigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, autoFeedEnabled,
      safeHeightMM, spindleType,
    },
    tools,
    paths,
    operations,
    postProcessors: { profiles, activeId },
    tabs,
    constraints,
  }
}

// Save the project as a downloadable .fkam file. When `explicitName` is given
// (from the save dialog) it becomes the project's name first, so the toolbar
// header and the embedded project name both reflect it.
export function saveProject(explicitName?: string) {
  if (explicitName !== undefined) useProjectStore.getState().setName(explicitName)
  const data = buildProjectData()
  const safeName = sanitizeFileName(data.name || 'project')
  const json = JSON.stringify(data, null, 2)
  downloadText(json, `${safeName}.fkam`, 'application/json')
  useProjectStore.getState().markClean()
  useTimelineStore.getState().markSaved()
}
