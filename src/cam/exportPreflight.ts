import { useToolpathStore } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useWorkpieceStore, MATERIAL_INFO } from '../store/workpieceStore'
import { feedsForTool, targetChipLoad, rigidityFeedFactor, feedDiameterMM } from './feeds'
import { generateGcode } from './gcode'
import { parseGcode } from '../sim/gcodeParser'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'

interface PreflightWarning {
  level: 'warn' | 'info'
  text: string
}

interface PreflightTool {
  name: string
  diameterMM: number
  rpm: number
}

export interface ExportPreflight {
  hasToolpaths: boolean
  units: 'mm' | 'in'
  machine: {
    profileName: string
    outputUnits: 'mm' | 'in'
    origin: string
    zOrigin: 'top' | 'bottom'
    safeHeightMM: number
    maxFeedMmMin: number
    minSpindleRpm: number
    maxSpindleRpm: number
    rigidity: number
    autoFeed: boolean
  }
  stock: { widthMM: number; heightMM: number; thicknessMM: number }
  job: {
    operationCount: number
    tools: PreflightTool[]
    spindleSpeeds: number[]
    extents: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null
    deepestCutMM: number
    estimatedTimeS: number
  }
  warnings: PreflightWarning[]
}

// Gather a summary + safety warnings for the toolpaths about to be exported.
// Mirrors the operation filter used by generateGcode so the report matches the
// file that will actually be written.
export function buildExportPreflight(): ExportPreflight {
  const { operations } = useToolpathStore.getState()
  const { tools } = useToolStore.getState()
  const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
  const profile = usePostProcessorStore.getState().getActiveProfile()
  const wp = useWorkpieceStore.getState()
  const {
    widthMM, heightMM, thicknessMM, origin, zOrigin, units, material,
    maxFeedMmMin, minSpindleRpm, maxSpindleRpm, safeHeightMM, machineRigidity, autoFeedEnabled,
    tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
  } = wp

  const fmt = (mm: number) => (units === 'in' ? `${(mm / 25.4).toFixed(3)}"` : `${mm.toFixed(1)} mm`)
  // These warnings are read while deciding whether to run a job, so the grammar has to
  // hold at n = 1 rather than fall back to "operation(s)".
  const nS = (n: number) => (n === 1 ? '' : 's')
  const nIsAre = (n: number) => (n === 1 ? 'is' : 'are')

  const doneOps = operations.filter(
    (o) => o.visible && o.status === 'done' && o.segments.length > 0 && o.type !== 'gcode'
  )

  // Distinct tools in order of first use (roughing tool first for 3D profiles).
  const usedToolIds: string[] = []
  const addTool = (id?: string) => {
    if (id && toolsById[id] && !usedToolIds.includes(id)) usedToolIds.push(id)
  }
  for (const op of doneOps) {
    if (op.type === 'profile3d' && op.roughingToolId) addTool(op.roughingToolId)
    addTool(op.toolId)
  }
  const toolList: PreflightTool[] = usedToolIds.map((id) => {
    const t = toolsById[id]
    return { name: t.name, diameterMM: t.diameterMM, rpm: feedsForTool(t).rpm }
  })
  const spindleSpeeds = [...new Set(toolList.map((t) => t.rpm))].sort((a, b) => a - b)
  const tooFastTools = usedToolIds.filter((id) => feedsForTool(toolsById[id]).spindleTooFast)

  // Extents in machine coordinates (relative to the work origin, matching the
  // exported G-code). Span is origin-independent so it's used for table checks.
  const org = originWorldXY(origin, widthMM, heightMM)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  // Raw workpiece-coord extents (stock is [0,W] × [0,H]) for the out-of-stock check.
  let wpMinX = Infinity, wpMaxX = -Infinity, wpMinY = Infinity, wpMaxY = -Infinity
  for (const op of doneOps) {
    for (const s of op.segments) {
      const mx = s.x - org.x, my = s.y - org.y
      if (mx < minX) minX = mx
      if (mx > maxX) maxX = mx
      if (my < minY) minY = my
      if (my > maxY) maxY = my
      if (s.z < minZ) minZ = s.z
      if (s.z > maxZ) maxZ = s.z
      if (s.x < wpMinX) wpMinX = s.x
      if (s.x > wpMaxX) wpMaxX = s.x
      if (s.y < wpMinY) wpMinY = s.y
      if (s.y > wpMaxY) wpMaxY = s.y
    }
  }
  const hasExtents = doneOps.length > 0 && Number.isFinite(minX)
  const extents = hasExtents ? { minX, maxX, minY, maxY, minZ, maxZ } : null
  const deepestCutMM = hasExtents ? Math.max(0, -minZ) : 0
  const spanX = hasExtents ? maxX - minX : 0
  const spanY = hasExtents ? maxY - minY : 0

  // Run-time estimate: generate the G-code and run it through the same parser the
  // simulator uses (programmed feeds + a fixed rapid rate). It ignores accel/decel,
  // so it's a floor — real cuts on a hobby machine run a bit longer.
  const estimatedTimeS = doneOps.length > 0
    ? parseGcode(generateGcode(operations, toolsById, 'estimate', profile)).totalTimeS
    : 0

  const warnings: PreflightWarning[] = []

  // Operations that will NOT be in the file. `doneOps` is the export filter, so anything
  // an operation-shaped thing that isn't in it is silently missing from the job — a pocket
  // too small for its cutter leaves that detail uncut with nothing in the G-code to say
  // so. Imported G-code operations are never exported by design, so they aren't reported.
  const exportable = operations.filter((o) => o.type !== 'gcode')
  const named = (ops: typeof operations, max = 4) =>
    ops.slice(0, max).map((o) => o.name).join(', ') + (ops.length > max ? `, +${ops.length - max} more` : '')

  const failed = exportable.filter((o) => o.visible && o.status === 'error')
  if (failed.length > 0) {
    // One representative message: a run of failures over the same selection is almost
    // always the same cause (usually "too small for the selected tool diameter").
    const reason = failed.find((o) => o.errorMessage)?.errorMessage
    warnings.push({
      level: 'warn',
      text: `${failed.length} operation${nS(failed.length)} failed to generate and ${nIsAre(failed.length)} NOT in this file — ${named(failed)}.` +
        (reason ? ` First error: "${reason}".` : '') +
        ` Whatever ${failed.length === 1 ? 'it was' : 'they were'} meant to cut will be left uncut.`,
    })
  }

  const stale = exportable.filter((o) => o.visible && o.status === 'needs-update')
  if (stale.length > 0) {
    warnings.push({
      level: 'warn',
      text: `${stale.length} operation${nS(stale.length)} need${stale.length === 1 ? 's' : ''} regenerating and ${nIsAre(stale.length)} NOT in this file — ${named(stale)}. ` +
        `Regenerate ${stale.length === 1 ? 'it' : 'them'} before running this job.`,
    })
  }

  const ungenerated = exportable.filter(
    (o) => o.visible && (o.status === 'pending' || o.status === 'generating' || (o.status === 'done' && o.segments.length === 0))
  )
  if (ungenerated.length > 0) {
    warnings.push({
      level: 'warn',
      text: `${ungenerated.length} operation${nS(ungenerated.length)} ${ungenerated.length === 1 ? 'has' : 'have'} no toolpath and ${nIsAre(ungenerated.length)} NOT in this file — ${named(ungenerated)}.`,
    })
  }

  const hiddenOps = exportable.filter((o) => !o.visible)
  if (hiddenOps.length > 0) {
    // Deliberate, so info rather than warn — but it still changes what gets cut.
    warnings.push({
      level: 'info',
      text: `${hiddenOps.length} hidden operation${nS(hiddenOps.length)} ${nIsAre(hiddenOps.length)} excluded from this file — ${named(hiddenOps)}.`,
    })
  }

  // Toolpath crosses the stock edge — the bit will cut into the spoilboard or air.
  const tol = 0.01
  if (hasExtents && (wpMinX < -tol || wpMinY < -tol || wpMaxX > widthMM + tol || wpMaxY > heightMM + tol)) {
    warnings.push({
      level: 'warn',
      text: `Toolpath extends outside the stock (${fmt(widthMM)} × ${fmt(heightMM)}). ` +
        `The tool will cut beyond the stock — reposition the geometry or enlarge the workpiece.`,
    })
  }

  if (spindleSpeeds.length > 1) {
    warnings.push({
      level: 'info',
      text: `This job uses ${spindleSpeeds.length} different spindle speeds (${spindleSpeeds.join(', ')} RPM). ` +
        `If your machine can't set spindle speed from G-code, set it by hand at each change.`,
    })
  }

  if (toolList.length > 1) {
    warnings.push({
      level: 'info',
      text: `This job uses ${toolList.length} tools — ${toolList.length - 1} tool change${nS(toolList.length - 1)} required. ` +
        `Swap the tool and re-zero Z when the program pauses.`,
    })
  }

  if (tableLimitWidthMM > 0 && spanX > tableLimitWidthMM) {
    warnings.push({ level: 'warn', text: `Toolpath X span ${fmt(spanX)} exceeds the table travel of ${fmt(tableLimitWidthMM)}.` })
  }
  if (tableLimitHeightMM > 0 && spanY > tableLimitHeightMM) {
    warnings.push({ level: 'warn', text: `Toolpath Y span ${fmt(spanY)} exceeds the table travel of ${fmt(tableLimitHeightMM)}.` })
  }
  if (tableLimitDepthMM > 0 && deepestCutMM > tableLimitDepthMM) {
    warnings.push({ level: 'warn', text: `Deepest cut ${fmt(deepestCutMM)} exceeds the max Z travel of ${fmt(tableLimitDepthMM)}.` })
  }

  if (deepestCutMM > thicknessMM + 1e-3) {
    warnings.push({
      level: 'info',
      text: `Deepest cut ${fmt(deepestCutMM)} goes through the ${fmt(thicknessMM)} stock — use a spoilboard or tabs to hold the part.`,
    })
  }

  if (tooFastTools.length > 0) {
    warnings.push({
      level: 'warn',
      text: `The spindle can't run slow enough for the material's safe surface speed on ${tooFastTools.length} tool${nS(tooFastTools.length)} — ` +
        `risk of overheating/built-up edge. Use a smaller bit or a slower spindle.`,
    })
  }

  // Chip-load sanity per tool: judge the exported feed's chip load against the
  // rigidity-adjusted target the same way the simulator's gauge does. Chips that
  // are too large can break the bit or stall the spindle; chips that are too small
  // make the edge rub and overheat. (Drills cut by plunging, not feed-per-tooth
  // side load, so they're excluded.)
  const hardness = MATERIAL_INFO[material].hardness
  const heavyTools: string[] = []
  const rubbingTools: string[] = []
  for (const id of usedToolIds) {
    const t = toolsById[id]
    if (t.type === 'drill') continue
    const f = feedsForTool(t)
    const flutes = t.fluteCount > 0 ? t.fluteCount : 1
    if (f.rpm <= 0 || f.xyFeedMmMin <= 0) continue
    const aimFz = targetChipLoad(t.type, feedDiameterMM(t), hardness) * rigidityFeedFactor(machineRigidity)
    if (aimFz <= 0) continue
    const ratio = (f.xyFeedMmMin / (f.rpm * flutes)) / aimFz
    if (ratio > 1.4) heavyTools.push(t.name)
    else if (ratio < 0.75) rubbingTools.push(t.name)
  }
  if (heavyTools.length > 0) {
    warnings.push({
      level: 'warn',
      text: `Chip load is too high on ${heavyTools.length} tool${nS(heavyTools.length)} (${heavyTools.join(', ')}) — ` +
        `the chips are too large for the programmed feed and speed, risking tool breakage or a stalled spindle. ` +
        `Lower the feed or raise the RPM${autoFeedEnabled ? '' : ' (or turn on auto feeds & speeds)'}.`,
    })
  }
  if (rubbingTools.length > 0) {
    warnings.push({
      level: 'warn',
      text: `Chip load is too low on ${rubbingTools.length} tool${nS(rubbingTools.length)} (${rubbingTools.join(', ')}) — ` +
        `the tool will rub instead of cut and run hot. ` +
        `Raise the feed or lower the RPM${autoFeedEnabled ? '' : ' (or turn on auto feeds & speeds)'}.`,
    })
  }

  // Inlay male/female overlap: a male plug and its female pocket must be cut at
  // separate spots on the stock. If both roles are present and their toolpaths
  // overlap in XY, the user likely ran "inlay in place" without moving the male
  // copy, so the plug sits on top of the pocket.
  type BB = { mnx: number; mny: number; mxx: number; mxy: number }
  const opBBox = (op: { segments: { x: number; y: number }[] }): BB | null => {
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity
    for (const s of op.segments) {
      if (s.x < mnx) mnx = s.x
      if (s.x > mxx) mxx = s.x
      if (s.y < mny) mny = s.y
      if (s.y > mxy) mxy = s.y
    }
    return Number.isFinite(mnx) ? { mnx, mny, mxx, mxy } : null
  }
  const bbOverlap = (a: BB, b: BB): boolean => {
    const ix = Math.min(a.mxx, b.mxx) - Math.max(a.mnx, b.mnx)
    const iy = Math.min(a.mxy, b.mxy) - Math.max(a.mny, b.mny)
    if (ix <= 0 || iy <= 0) return false
    const minArea = Math.min((a.mxx - a.mnx) * (a.mxy - a.mny), (b.mxx - b.mnx) * (b.mxy - b.mny))
    return minArea > 0 && (ix * iy) / minArea > 0.25
  }
  const femaleBoxes = doneOps.filter((o) => o.type === 'inlay' && o.role === 'female').map(opBBox)
  const maleBoxes = doneOps.filter((o) => o.type === 'inlay' && o.role === 'male').map(opBBox)
  const inlayOverlap = femaleBoxes.some((f) => f && maleBoxes.some((m) => m && bbOverlap(f, m)))
  if (inlayOverlap) {
    warnings.push({
      level: 'warn',
      text: `An inlay plug (male) and pocket (female) toolpath overlap on the stock — they must be cut at ` +
        `separate positions. If you used "inlay in place", duplicate the male part and move it clear of the ` +
        `female pocket before exporting.`,
    })
  }

  if (profile.unitMode !== units) {
    warnings.push({
      level: 'info',
      text: `Display units (${units}) differ from the post-processor output units (${profile.unitMode}). The file will be in ${profile.unitMode}.`,
    })
  }

  return {
    hasToolpaths: doneOps.length > 0,
    units,
    machine: {
      profileName: profile.name,
      outputUnits: profile.unitMode,
      origin,
      zOrigin,
      safeHeightMM,
      maxFeedMmMin,
      minSpindleRpm,
      maxSpindleRpm,
      rigidity: machineRigidity,
      autoFeed: autoFeedEnabled,
    },
    stock: { widthMM, heightMM, thicknessMM },
    job: {
      operationCount: doneOps.length,
      tools: toolList,
      spindleSpeeds,
      extents,
      deepestCutMM,
      estimatedTimeS,
    },
    warnings,
  }
}
