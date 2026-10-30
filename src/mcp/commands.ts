// What an MCP client may ask this tab to do. Each command is one tool of the
// freazykam-mcp server (mcp/src/server.ts declares the tool, with its schema and
// description; the command of the same name runs it here, where the project lives).
//
// A plain module, no React, so a Node test or a Playwright script can drive the
// same commands the bridge does. Results must survive JSON.stringify — and are
// read by a model, so name things the way the UI does (Stock, Point, Tool) and
// keep every length in mm.

import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore, pathIdsOf, type AnyOperation } from '../store/toolpathStore'
import { useToolStore, withRatedChip, type Tool, type ToolType } from '../store/toolStore'
import { uid } from '../uid'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useProjectStore } from '../store/projectStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { serializeOp } from '../timeline/events'
import { pathExtents } from '../cam/pathFlattener'
import { regenerateMany } from '../cam/regenerate'
import { generateGcode } from '../cam/gcode'
import { buildExportPreflight } from '../cam/exportPreflight'
import { buildGcodeInputs } from '../io/gcodeExport'
import { buildProjectData } from '../io/projectSave'
import { hasUnsavedWork, loadProject, newProject } from '../io/projectLoad'
import { importSvgText, completeDxfImport, importImageDataUrl } from '../io/importFile'
import { importDxf } from '../importers/dxfImporter'
import { reorderedFor, groupedByTool, sameOrder } from '../panels/operationsOrder'
import { isOpenPath } from '../panels/machine/containment'
import type { ImportedPath } from '../importers/svgImporter'
import { BUILD_DATE } from '../version'
import { useUIStore } from '../store/uiStore'
import { bakePathsStep } from '../store/pathsStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { getMultiBBox, type TransformStep } from '../canvas/selectionUtils'
import { shapeParamsFromConfig, generateShapeD, generateShapeParts, SCALE_LOCKED_SHAPES, type ShapeParams, type ShapeToolConfig, type ShapeType } from '../shapes/shapeGenerators'
import { placeShape } from '../shapes/placeShape'
import type { Material } from '../store/workpieceStore'
import { batchOf } from '../store/toolpathStore'
import { useFormDefaultsStore } from '../store/formDefaultsStore'
import { seedStepDownMM } from '../cam/feeds'
import { generateOperation } from '../cam/opJob'
import { runBatchGenerate } from '../panels/machine/batchGenerate'
import { toolpathKind, checkSettings, chooseTool, type PlanContext } from '../panels/machine/toolpathKinds'
import { useTabStore } from '../store/tabStore'
import { expandUserGroups, outerGroupOf } from '../store/pathsStore'
import {
  OFFSET_DEFAULTS, PATTERN_DEFAULTS, ALONG_DEFAULTS, DEFAULT_TRACE,
  createOffsets, createBoolean, createPattern, createTextAlong, cornerSession, treatableCorners, applyCorners, createTrace,
} from '../tools/pathToolActions'
import { runNest, NEST_DEFAULTS, ROT_STEP, FINE_ROTATION_MAX_PARTS, type NestFormState, type RotOption } from '../tools/nestRun'
import { groupPathsForNesting } from '../tools/nestOp'
import { toolsOfType, pickToolId } from '../panels/machine/opDefaults'
import type { BooleanOpType } from '../tools/booleanOps'
import type { CornerTreatmentType } from '../tools/cornerTreatment'
import type { TraceParams } from '../tools/imageTrace'
import { isWorkCancelled } from '../workers/workerClient'
import { regenerateAffectedMany } from '../cam/regenerate'

export type Command = (params: Record<string, unknown>) => unknown | Promise<unknown>

// ─── Params ────────────────────────────────────────────────────────────────────
// The server validates against its schemas first; these only keep a hand-made call
// (a Playwright script, the console) from reaching the stores with junk.

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  if (typeof v !== 'string' || v === '') throw new Error(`"${key}" must be a non-empty string.`)
  return v
}
function optInt(p: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`"${key}" must be a whole number from ${min} to ${max}.`)
  return v
}
function num(p: Record<string, unknown>, key: string): number {
  const v = p[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${key}" must be a number.`)
  return v
}
function optNum(p: Record<string, unknown>, key: string): number | undefined {
  return p[key] === undefined || p[key] === null ? undefined : num(p, key)
}
function optStrings(p: Record<string, unknown>, key: string): string[] | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new Error(`"${key}" must be a list of ids.`)
  return v
}

/** Round to 0.001 mm — a model reading 37.49999999 wastes attention on nothing. */
const r3 = (n: number) => Math.round(n * 1000) / 1000

// ─── Summaries ─────────────────────────────────────────────────────────────────

function pathSummary(p: ImportedPath, includeGeometry: boolean) {
  const ext = pathExtents(p.d)
  return {
    id: p.id,
    name: p.name,
    shape: p.shapeParams?.type ?? null,
    closed: !isOpenPath(p),
    bboxMM: ext ? { minX: r3(ext[0]), minY: r3(ext[1]), maxX: r3(ext[2]), maxY: r3(ext[3]) } : null,
    visible: p.visible && !p.hidden,
    ...((n) => (n ? { tabs: n } : {}))(useTabStore.getState().getPathTabs(p.id).length),
    ...(p.layer ? { layer: p.layer } : {}),
    // A multi-part shape's parts carry groupName too ("Gear"), and they were not imported.
    ...(p.groupName ? (p.shapePart ? { partOf: p.groupName, part: p.shapePart } : { importedFrom: p.groupName }) : {}),
    ...(p.userGroups?.length ? { group: p.userGroups[0] } : {}),
    // Which part of the DRAWING this path was (a DXF block insert, an SVG <g>): an agent
    // fitting a sheet's labels had only the boxes to go by, took the strokes of a label
    // hanging over a neighbour for the neighbour's, and moved them off with it.
    ...(p.sourceGroups?.length ? { drawnIn: p.sourceGroups[0], ...(p.sourceGroupNames?.[0] ? { drawnInName: p.sourceGroupNames[0] } : {}) } : {}),
    ...(includeGeometry ? { d: p.d, ...(p.shapeParams ? { shapeParams: p.shapeParams } : {}) } : {}),
  }
}

function toolSummary(t: Tool) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    diameterMM: t.diameterMM,
    ...(t.vbitAngleDeg !== undefined && (t.type === 'vbit' || t.type === 'taper')
      ? { angleDeg: t.vbitAngleDeg, angleIs: t.type === 'vbit' ? 'included' : 'per side' } : {}),
    ...(t.cornerRadiusMM !== undefined && t.type === 'bullnose' ? { cornerRadiusMM: t.cornerRadiusMM } : {}),
    flutes: t.fluteCount,
    rpm: t.rpm,
    feedMmMin: t.xyFeedMmMin,
    plungeMmMin: t.zFeedMmMin,
    maxDepthMM: t.maxDepthMM,
    folder: t.folder ?? 'My Tools',
  }
}

/** What the generated toolpath actually does — the numbers worth checking without the segments. */
function cutStats(op: AnyOperation) {
  let cuts = 0, minZ = Infinity, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of op.segments) {
    if (s.rapid || s.toolChange) continue
    cuts++
    if (s.z < minZ) minZ = s.z
    if (s.x < minX) minX = s.x
    if (s.x > maxX) maxX = s.x
    if (s.y < minY) minY = s.y
    if (s.y > maxY) maxY = s.y
  }
  return cuts === 0 ? null : {
    moves: op.segments.length,
    deepestZ: r3(minZ),
    cutExtentsMM: { minX: r3(minX), minY: r3(minY), maxX: r3(maxX), maxY: r3(maxY) },
  }
}

function toolpathSummary(op: AnyOperation, tools: Tool[]) {
  const tool = tools.find((t) => t.id === op.toolId)
  return {
    id: op.id,
    name: op.name,
    type: op.type,
    status: op.status,
    ...(op.errorMessage ? { error: op.errorMessage } : {}),
    visible: op.visible,
    tool: tool ? `${tool.name} (Ø${tool.diameterMM} mm)` : `missing tool ${op.toolId}`,
    pathIds: pathIdsOf(op),
    ...('depthMM' in op && typeof op.depthMM === 'number' ? { depthMM: op.depthMM } : {}),
    ...(op.status === 'done' ? { result: cutStats(op) } : {}),
  }
}

// ─── Waiting for generation ──────────────────────────────────────────────────────

const busy = () => useToolpathStore.getState().operations.some((o) => o.status === 'generating')

/** Resolve once no operation is generating, or reject after `timeoutMs`. */
function waitForGeneration(timeoutMs: number): Promise<void> {
  if (!busy()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`Generation was still running after ${Math.round(timeoutMs / 1000)} s; call list_toolpaths later to see how it finished.`))
    }, timeoutMs)
    const unsub = useToolpathStore.subscribe(() => {
      if (busy()) return
      clearTimeout(timer)
      unsub()
      resolve()
    })
  })
}

/** How long a regenerate may take before we stop waiting — a little under the server's own call timeout. */
const GENERATION_WAIT_MS = 280_000

function generationReport() {
  const { operations } = useToolpathStore.getState()
  const tools = useToolStore.getState().tools
  const count = (s: string) => operations.filter((o) => o.status === s).length
  return {
    done: count('done'),
    failed: count('error'),
    needsUpdate: count('needs-update'),
    toolpaths: operations.map((op) => toolpathSummary(op, tools)),
  }
}

// ─── Commands ───────────────────────────────────────────────────────────────────

export const commands: Record<string, Command> = {
  status: () => {
    const wp = useWorkpieceStore.getState()
    const project = useProjectStore.getState()
    return {
      connected: true,
      build: BUILD_DATE,
      project: { name: project.name, unsavedChanges: hasUnsavedWork() },
      stock: { widthMM: wp.widthMM, heightMM: wp.heightMM, thicknessMM: wp.thicknessMM, material: wp.material, zZeroAt: wp.zOrigin, xyOrigin: wp.origin },
      displayUnits: wp.units,
      postProcessor: usePostProcessorStore.getState().getActiveProfile().name,
      paths: usePathsStore.getState().paths.length,
      toolpaths: useToolpathStore.getState().operations.length,
      generating: busy(),
      conventions:
        'Lengths in mm, Y up, angles in degrees counter-clockwise. TWO XY FRAMES: paths and ' +
        "toolpaths are measured from the stock's bottom-left corner; G-code and export_check " +
        'are relative to the job origin (stock.xyOrigin), so one point can read X 110 in one ' +
        'and X -140 in the other. Z is relative to stock.zZeroAt (top: cuts are negative).',
    }
  },

  list_paths: (p) => {
    const ids = optStrings(p, 'ids')
    const includeGeometry = p.includeGeometry === true
    let paths = usePathsStore.getState().paths
    if (ids) {
      const missing = ids.filter((id) => !paths.some((x) => x.id === id))
      if (missing.length) throw new Error(`No path with id ${missing.join(', ')}.`)
      paths = paths.filter((x) => ids.includes(x.id))
    }
    return { count: paths.length, paths: paths.map((x) => pathSummary(x, includeGeometry)) }
  },

  list_toolpaths: () => generationReport(),

  get_toolpath: (p) => {
    const id = str(p, 'id')
    const op = useToolpathStore.getState().operations.find((o) => o.id === id)
    if (!op) throw new Error(`No toolpath with id ${id}.`)
    const { segments: _segments, ...settings } = serializeOp(op) as Record<string, unknown>
    return {
      ...toolpathSummary(op, useToolStore.getState().tools),
      settings,
    }
  },

  // My Tools by default: an imported catalogue can be 80 bits, which buries the user's
  // own handful — the same reason ToolPicker keeps its list short.
  list_tools: (p) => {
    const { tools } = useToolStore.getState()
    const folderOf = (t: Tool) => t.folder ?? 'My Tools'
    const folder = typeof p.folder === 'string' ? p.folder : 'My Tools'
    const type = typeof p.type === 'string' ? p.type : undefined
    const q = typeof p.search === 'string' ? p.search.toLowerCase() : undefined
    const hits = tools.filter((t) => (folder === 'all' || folderOf(t) === folder)
      && (!type || t.type === type) && (!q || t.name.toLowerCase().includes(q)))
    const folders: Record<string, number> = {}
    for (const t of tools) folders[folderOf(t)] = (folders[folderOf(t)] ?? 0) + 1
    return { folder, folders, tools: hits.map(toolSummary) }
  },

  regenerate: async (p) => {
    const ids = optStrings(p, 'ids')
    const { operations } = useToolpathStore.getState()
    const ops = ids ? operations.filter((o) => ids.includes(o.id)) : operations
    if (ids && ops.length !== ids.length) {
      throw new Error(`No toolpath with id ${ids.filter((id) => !operations.some((o) => o.id === id)).join(', ')}.`)
    }
    regenerateMany(ops)
    await waitForGeneration(GENERATION_WAIT_MS)
    return generationReport()
  },

  get_gcode: async (p) => {
    const sheet = optInt(p, 'sheet', 0, 999)
    const startLine = optInt(p, 'startLine', 1, Number.MAX_SAFE_INTEGER) ?? 1
    const maxLines = optInt(p, 'maxLines', 1, 5000) ?? 300
    const { operations, toolsById, profile, sheet: k, sheets } = await buildGcodeInputs(sheet)
    const gcode = generateGcode(operations, toolsById, useProjectStore.getState().name, profile)
    const lines = gcode.split('\n')
    const slice = lines.slice(startLine - 1, startLine - 1 + maxLines)
    return {
      sheet: k,
      sheets,
      totalLines: lines.length,
      startLine,
      endLine: startLine - 1 + slice.length,
      gcode: slice.join('\n'),
    }
  },

  // The export dialog's review: tools, extents, run time and the safety warnings.
  export_check: () => buildExportPreflight(),

  // The server writes the file (a page cannot); this hands it the text.
  save_project: (p) => ({
    fileText: JSON.stringify(buildProjectData(), null, 2),
    message: `Saved ${String(p.path)} — a copy; the project's saved state in the app is unchanged.`,
  }),

  // The server read the file (a page cannot) and passes its text. Same import as the
  // toolbar's: centred on the stock, one group, selected.
  import_file: (p) => {
    const text = str(p, 'fileText')
    const fileName = str(p, 'fileName')
    let r
    if (/\.svg$/i.test(fileName)) {
      r = importSvgText(text, fileName)
    } else {
      const name = fileName.replace(/\.dxf$/i, '')
      const units = p.units as 'mm' | 'cm' | 'in' | 'ft' | 'm' | undefined
      // A DXF that does not say its units would open the units dialog — with nobody there
      // to answer it. Ask the caller instead.
      if (!units && importDxf(text, name).needsUnitsPrompt) {
        throw new Error('This DXF does not say what units it is in. Ask the user, then call again with units (mm, cm, in, ft or m).')
      }
      r = completeDxfImport(text, name, units)
    }
    if (r.pathIds.length === 0) throw new Error(`Nothing imported: ${r.problem ?? 'no usable paths'}.`)
    return { imported: pathsById(r.pathIds).map((x) => pathSummary(x, false)), ...(r.problem ? { warning: r.problem } : {}) }
  },

  // A picture, read by the server as base64 — sized and centred as the toolbar's Import does.
  import_image: async (p) => {
    const fileName = str(p, 'fileName')
    const ext = fileName.toLowerCase().split('.').pop()
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    const r = await importImageDataUrl(`data:${mime};base64,${str(p, 'fileBase64')}`, fileName)
    if (r.pathIds.length === 0) throw new Error(`Nothing imported: ${r.problem}.`)
    return { imported: pathsById(r.pathIds).map((x) => pathSummary(x, false)), note: 'Trace it (trace_image), carve it (photovcarve), or use it as a depth map (profile3d).' }
  },

  // The server writes the file; this hands it the program — the same text Export writes.
  export_gcode: async (p) => {
    const sheet = optInt(p, 'sheet', 0, 999)
    const { operations, toolsById, profile, sheet: k, sheets, tile } = await buildGcodeInputs(sheet)
    if (sheets > 1 && sheet === undefined) {
      throw new Error(tile !== undefined
        ? `This job is cut in ${sheets} tiles, one program each. Give "sheet" (the tile, 0 to ${sheets - 1}) and export each one.`
        : `This job has ${sheets} sheets of stock, one program each. Give "sheet" (0 to ${sheets - 1}) and export each one.`)
    }
    const gcode = generateGcode(operations, toolsById, useProjectStore.getState().name, profile, { forFile: true })
    const lines = gcode.split('\n').length
    return { fileText: gcode, message: `Wrote ${lines} lines of G-code${sheets > 1 ? ` (sheet ${k + 1} of ${sheets})` : ''} to ${String(p.path)}. Run export_check first if you have not.` }
  },

  // The server read the file (a page cannot) and passes its text.
  open_project: async (p) => {
    let data: unknown
    try { data = JSON.parse(str(p, 'fileText')) } catch { throw new Error('That file is not a FreazyKam project (.fkam is JSON).') }
    if (!data || typeof data !== 'object') throw new Error('That file is not a FreazyKam project.')
    if (hasUnsavedWork() && p.discardUnsaved !== true) {
      throw new Error('The open project has unsaved changes. Ask the user whether to discard them; only then call again with discardUnsaved: true.')
    }
    loadProject(data, typeof p.fileName === 'string' ? p.fileName : undefined)
    await waitForGeneration(GENERATION_WAIT_MS)
    return { opened: useProjectStore.getState().name, ...generationReport() }
  },
}

// ─── Editing ─────────────────────────────────────────────────────────────────────
// Every edit goes through the action the UI's own gesture uses, so it records ONE undo
// step, regenerates the toolpaths it affects, and shows up in the Objects strip like
// anything the user did.

const MATERIALS: readonly Material[] = ['pine', 'cedar', 'basswood', 'oak', 'maple', 'walnut', 'cherry', 'mdf', 'plywood', 'hdpe', 'delrin', 'acrylic', 'aluminum', 'brass', 'other']

/** The paths named by `ids`, all of them, or an error naming the ones that are not there. */
function pathsById(ids: string[]): ImportedPath[] {
  const { paths } = usePathsStore.getState()
  const missing = ids.filter((id) => !paths.some((x) => x.id === id))
  if (missing.length) throw new Error(`No path with id ${missing.join(', ')}.`)
  return paths.filter((x) => ids.includes(x.id))
}

/**
 * A shape type's settings: the shape tool's current defaults for it (what a click on the
 * canvas would place) with `overrides` laid over them. Unknown keys and wrongly-typed
 * values are refused by name — a typo silently ignored would place the default instead.
 */
function shapeConfig(type: ShapeType, overrides: Record<string, unknown>): ShapeToolConfig {
  const config = useUIStore.getState().shapeToolConfig
  const base = config[type] as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in base)) throw new Error(`A ${type} has no setting "${k}". Its settings are: ${Object.keys(base).join(', ')}.`)
    if (base[k] !== undefined && typeof v !== typeof base[k]) throw new Error(`"${k}" must be a ${typeof base[k]} (got ${JSON.stringify(v)}).`)
  }
  return { ...config, [type]: { ...base, ...overrides } }
}

/** Load a font a shape needs BEFORE placing it, so it lands complete instead of being patched later. */
async function fontsFor(type: ShapeType, settings: Record<string, unknown>): Promise<void> {
  if (type !== 'text' && !(type === 'gear' && settings.toothLabel)) return
  const { loadFont, SINGLE_LINE_FONT_FAMILY } = await import('../shapes/textGenerator')
  await loadFont(type === 'text' ? String(settings.fontFamily) : SINGLE_LINE_FONT_FAMILY)
}

/** The selection's centre — what a rotate, scale or mirror turns about unless told otherwise. */
function centreOf(paths: ImportedPath[]): { x: number; y: number } {
  const b = getMultiBBox(paths.map((x) => x.d))
  if (!b) throw new Error('Those paths have no extent to transform about.')
  return { x: b.cx, y: b.cy }
}

/** Where a shape sits — `transform_paths` moves it, so these are never shape settings. */
const POSITION_KEYS = new Set(['type', 'x', 'y', 'cx', 'cy'])

/** Every path of the shape `path` belongs to — a multi-part shape (a gear's teeth, bore, spokes) is one shape. */
function partIdsOf(path: ImportedPath): string[] {
  if (path.shapePart === undefined) return [path.id]
  return usePathsStore.getState().paths.filter((x) => x.groupId === path.groupId && x.shapePart !== undefined).map((x) => x.id)
}

/** The path's shape settings and all its paths; refuses a path that has none. */
function shapeOf(id: string): { path: ImportedPath; params: ShapeParams; partIds: string[] } {
  const [path] = pathsById([id])
  if (!path.shapeParams) {
    throw new Error(`${path.name} has no shape settings: it was imported, drawn with the pen, or made by a path tool. Reshape it with the path tools, or delete it and add_shape a new one.`)
  }
  return { path, params: path.shapeParams, partIds: partIdsOf(path) }
}

/** A shape's settings as a model reads them: everything but its type and position. */
function shapeSettings(params: ShapeParams): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([k]) => !POSITION_KEYS.has(k)))
}

/** The tools in the user's own rack — the folder add_tool and update_tool work in. */
const myTools = () => useToolStore.getState().tools.filter((t) => t.folder === undefined)

const TOOL_TYPES: readonly ToolType[] = ['endmill', 'ballnose', 'bullnose', 'vbit', 'taper', 'drill']

/** The Tool fields a call may set, from its params; refuses a value the library would not hold. */
function toolFields(p: Record<string, unknown>, type: ToolType): Partial<Omit<Tool, 'id'>> {
  const f: Partial<Omit<Tool, 'id'>> = {}
  const pos = (key: string, field: keyof Tool) => {
    const v = optNum(p, key)
    if (v === undefined) return
    if (!(v > 0)) throw new Error(`"${key}" must be more than 0.`)
    ;(f as Record<string, unknown>)[field] = v
  }
  if (typeof p.name === 'string') {
    if (!p.name.trim()) throw new Error('"name" must not be empty.')
    f.name = p.name.trim()
  }
  pos('diameterMM', 'diameterMM'); pos('rpm', 'rpm'); pos('feedMmMin', 'xyFeedMmMin')
  pos('plungeMmMin', 'zFeedMmMin'); pos('maxDepthMM', 'maxDepthMM'); pos('chipLoadMM', 'chipLoadMM')
  const flutes = optInt(p, 'flutes', 1, 12)
  if (flutes !== undefined) f.fluteCount = flutes
  const angle = optNum(p, 'angleDeg')
  if (angle !== undefined) {
    if (type !== 'vbit' && type !== 'taper') throw new Error('"angleDeg" is only for a vbit or a taper.')
    const max = type === 'vbit' ? 180 : 45
    if (!(angle > 0 && angle < max)) throw new Error(`A ${type}'s angle must be between 0 and ${max}° (${type === 'vbit' ? 'included' : 'per side'}).`)
    f.vbitAngleDeg = angle
  }
  const corner = optNum(p, 'cornerRadiusMM')
  if (corner !== undefined) {
    if (type !== 'bullnose') throw new Error('"cornerRadiusMM" is only for a bullnose.')
    if (!(corner > 0)) throw new Error('"cornerRadiusMM" must be more than 0.')
    f.cornerRadiusMM = corner
  }
  return f
}

const editCommands: Record<string, Command> = {
  list_shape_types: () => {
    const config = useUIStore.getState().shapeToolConfig
    return {
      note: 'settings are the shape tool\'s current defaults, in mm and degrees; scaleLocked shapes are a fit and cannot be resized after placing',
      shapes: (Object.keys(config) as ShapeType[]).map((type) => ({
        type, scaleLocked: SCALE_LOCKED_SHAPES.has(type), settings: config[type],
      })),
    }
  },

  add_shape: async (p) => {
    const type = str(p, 'type') as ShapeType
    const config = useUIStore.getState().shapeToolConfig
    if (!Object.prototype.hasOwnProperty.call(config, type)) {
      throw new Error(`No shape type "${type}". Types: ${Object.keys(config).join(', ')}.`)
    }
    const overrides = p.settings && typeof p.settings === 'object' ? p.settings as Record<string, unknown> : {}
    const cfg = shapeConfig(type, overrides)
    await fontsFor(type, cfg[type] as unknown as Record<string, unknown>)
    const params = shapeParamsFromConfig(type, num(p, 'x'), num(p, 'y'), cfg)
    const ids = placeShape(params)
    const added = pathsById(ids)
    const empty = added.filter((x) => !x.d)
    if (empty.length === added.length) throw new Error(`The ${type} came out empty with those settings — nothing was drawn.`)
    return { added: added.map((x) => pathSummary(x, false)) }
  },

  get_shape: (p) => {
    const { path, params, partIds } = shapeOf(str(p, 'id'))
    const config = useUIStore.getState().shapeToolConfig[params.type] as unknown as Record<string, unknown>
    // Settings the shape does not carry yet (an optional one left at its default) can still be set.
    const unset = Object.keys(config).filter((k) => !(k in params))
    return {
      shape: params.type,
      partIds,
      scaleLocked: SCALE_LOCKED_SHAPES.has(params.type),
      ...(path.fromCenter ? { growsFromCentre: true } : {}),
      settings: shapeSettings(params),
      ...(unset.length ? { alsoSettable: Object.fromEntries(unset.map((k) => [k, config[k]])) } : {}),
      paths: pathsById(partIds).map((x) => pathSummary(x, false)),
    }
  },

  // What typing into the Properties panel does: one parameter edit of the whole shape, then the
  // toolpaths that cut any of its paths regenerate (PropertiesPanel's `update`).
  update_shape: async (p) => {
    const { path, params } = shapeOf(str(p, 'id'))
    const settings = p.settings && typeof p.settings === 'object' && !Array.isArray(p.settings) ? p.settings as Record<string, unknown> : null
    if (!settings || Object.keys(settings).length === 0) throw new Error('"settings" must name at least one setting to change (see get_shape).')
    const config = useUIStore.getState().shapeToolConfig[params.type] as unknown as Record<string, unknown>
    const known: Record<string, unknown> = { ...config, ...params }
    for (const [k, v] of Object.entries(settings)) {
      if (POSITION_KEYS.has(k)) throw new Error(`"${k}" is where the shape sits, not a setting — move it with transform_paths.`)
      if (!(k in known)) throw new Error(`A ${params.type} has no setting "${k}". Its settings are: ${Object.keys(shapeSettings(known as ShapeParams)).join(', ')}.`)
      if (known[k] !== undefined && typeof v !== typeof known[k]) throw new Error(`"${k}" must be a ${typeof known[k]} (got ${JSON.stringify(v)}).`)
    }
    const next = { ...params, ...settings } as ShapeParams & Record<string, unknown>
    // A box-shaped shape drawn from its centre keeps its centre as it grows, as the panel's W/H do.
    if (path.fromCenter && 'w' in next && 'x' in next) {
      const old = params as unknown as Record<string, number>
      if (typeof settings.w === 'number') next.x = old.x + (old.w - settings.w) / 2
      if (typeof settings.h === 'number') next.y = old.y + (old.h - settings.h) / 2
    }
    await fontsFor(next.type, next)
    // Empty, or flat in one direction (a width of 0): either way there is nothing to cut.
    const parts = path.shapePart !== undefined ? generateShapeParts(next) : null
    const ds = parts ? parts.map((pt) => pt.d).filter(Boolean) : [generateShapeD(next)].filter(Boolean)
    const box = ds.length ? getMultiBBox(ds) : null
    if (!box || box.width < 0.01 || box.height < 0.01) {
      throw new Error(`With those settings the ${params.type} comes out ${box ? 'flat' : 'empty'}, so nothing was changed.`)
    }
    usePathsStore.getState().updateShapeParams(path.id, next)
    // Read back AFTER the edit: a part can appear (spokes from 0) or vanish (bore to 0).
    const partIds = shapeOf(path.id).partIds
    const opsBefore = useToolpathStore.getState().operations
    regenerateAffectedMany(partIds)
    const affected = opsBefore.filter((o) => partIds.some((id) => pathIdsOf(o).includes(id))).map((o) => o.id)
    await waitForGeneration(GENERATION_WAIT_MS)
    const ops = useToolpathStore.getState().operations.filter((o) => affected.includes(o.id))
    const tools = useToolStore.getState().tools
    return {
      settings: shapeSettings(shapeOf(path.id).params),
      paths: pathsById(partIds).map((x) => pathSummary(x, false)),
      ...(ops.length ? { toolpathsRegenerated: ops.map((o) => toolpathSummary(o, tools)) } : {}),
    }
  },

  group_paths: (p) => {
    const ids = optStrings(p, 'ids')
    if (!ids?.length) throw new Error('"ids" must name at least two paths.')
    const st = usePathsStore.getState()
    // As a click on the canvas does: a part of a multi-part shape brings the whole shape,
    // and a path in a group brings the whole group.
    const members = expandUserGroups([...new Set(pathsById(ids).flatMap(partIdsOf))], st.paths)
    if (members.length < 2) throw new Error('A group needs at least two paths.')
    st.setSelectedIds(members)
    st.groupSelected()
    const grouped = pathsById(members)
    return { group: outerGroupOf(grouped[0]) ?? null, paths: grouped.map((x) => pathSummary(x, false)) }
  },

  ungroup_paths: (p) => {
    const ids = optStrings(p, 'ids')
    if (!ids?.length) throw new Error('"ids" must name at least one path of the group.')
    const st = usePathsStore.getState()
    if (!pathsById(ids).some((x) => outerGroupOf(x))) throw new Error('None of those paths is in a group.')
    // Every member of the groups touched, read before they come apart.
    const members = expandUserGroups(ids, st.paths)
    st.setSelectedIds(ids)
    st.ungroupSelected()
    return { paths: pathsById(members).map((x) => pathSummary(x, false)) }
  },

  add_tool: (p) => {
    const type = str(p, 'type') as ToolType
    if (!TOOL_TYPES.includes(type)) throw new Error(`"type" must be one of ${TOOL_TYPES.join(', ')}.`)
    const f = toolFields(p, type)
    if (!f.name) throw new Error('"name" is required.')
    if (f.diameterMM === undefined) throw new Error('"diameterMM" is required.')
    if ((type === 'vbit' || type === 'taper') && f.vbitAngleDeg === undefined) throw new Error(`A ${type} needs "angleDeg" (${type === 'vbit' ? 'the included angle' : 'the angle per side'}).`)
    if (type === 'bullnose' && f.cornerRadiusMM === undefined) throw new Error('A bullnose needs "cornerRadiusMM".')
    if (myTools().some((t) => t.name.toLowerCase() === f.name!.toLowerCase())) {
      throw new Error(`My Tools already has a tool named "${f.name}" — use update_tool to change it, or pick another name.`)
    }
    // The library's own New tool, as a plain end mill would start, with the call's fields laid over it.
    const tool = withRatedChip({
      id: uid('tool'), name: f.name, type, diameterMM: f.diameterMM,
      fluteCount: 2, rpm: 18000, xyFeedMmMin: 2000, zFeedMmMin: 500, maxDepthMM: 20,
      ...f,
    })
    useToolStore.setState((s) => ({ tools: [...s.tools, tool] }))
    return { added: toolSummary(tool) }
  },

  update_tool: async (p) => {
    const id = str(p, 'id')
    const tool = useToolStore.getState().tools.find((t) => t.id === id)
    if (!tool) throw new Error(`No tool with id ${id}.`)
    if (tool.folder !== undefined) throw new Error(`${tool.name} is in the "${tool.folder}" catalogue, not My Tools — add_tool a copy to My Tools and change that.`)
    const type = p.type === undefined ? tool.type : str(p, 'type') as ToolType
    if (!TOOL_TYPES.includes(type)) throw new Error(`"type" must be one of ${TOOL_TYPES.join(', ')}.`)
    const f = { ...toolFields(p, type), ...(type !== tool.type ? { type } : {}) }
    if (Object.keys(f).length === 0) throw new Error('Name at least one field to change.')
    if (f.name && myTools().some((t) => t.id !== id && t.name.toLowerCase() === f.name!.toLowerCase())) {
      throw new Error(`My Tools already has a tool named "${f.name}".`)
    }
    useToolStore.getState().updateTool(id, f)
    // The library panel leaves toolpaths as they are; here nobody is watching the canvas, and a
    // step-down or a wall width can follow from the tool — so whatever cuts with it regenerates.
    const users = useToolpathStore.getState().operations.filter((o) => o.toolId === id)
    if (users.length) {
      regenerateMany(users)
      await waitForGeneration(GENERATION_WAIT_MS)
    }
    const tools = useToolStore.getState().tools
    const ops = useToolpathStore.getState().operations.filter((o) => users.some((u) => u.id === o.id))
    return {
      updated: toolSummary(tools.find((t) => t.id === id)!),
      ...(ops.length ? { toolpathsRegenerated: ops.map((o) => toolpathSummary(o, tools)) } : {}),
    }
  },

  transform_paths: (p) => {
    const ids = optStrings(p, 'ids')
    if (!ids?.length) throw new Error('"ids" must name at least one path.')
    const paths = pathsById(ids)
    const kind = str(p, 'kind')
    let step: TransformStep
    let gesture: 'move' | 'rotate' | 'scale' | 'mirror'
    if (kind === 'move') {
      const toX = optNum(p, 'toX'), toY = optNum(p, 'toY')
      const c = toX !== undefined || toY !== undefined ? centreOf(paths) : null
      step = {
        kind: 'translate',
        dx: toX !== undefined ? toX - c!.x : optNum(p, 'dx') ?? 0,
        dy: toY !== undefined ? toY - c!.y : optNum(p, 'dy') ?? 0,
      }
      gesture = 'move'
    } else {
      const c = centreOf(paths)
      const cx = optNum(p, 'cx') ?? c.x, cy = optNum(p, 'cy') ?? c.y
      if (kind === 'rotate') {
        step = { kind: 'rotate', angle: num(p, 'angleDeg'), cx, cy }
        gesture = 'rotate'
      } else if (kind === 'scale') {
        const f = optNum(p, 'factor')
        const sx = optNum(p, 'sx') ?? f, sy = optNum(p, 'sy') ?? f
        if (sx === undefined || sy === undefined) throw new Error('A scale needs "factor", or both "sx" and "sy".')
        if (sx <= 0 || sy <= 0) throw new Error('Scale factors must be positive; use kind "mirror" to flip.')
        const locked = paths.filter((x) => x.shapeParams && SCALE_LOCKED_SHAPES.has(x.shapeParams.type))
        if (locked.length) throw new Error(`${locked.map((x) => x.name).join(', ')} cannot be scaled: a ${locked[0].shapeParams!.type} is a fit, sized by its settings.`)
        step = { kind: 'scale', sx, sy, ax: cx, ay: cy }
        gesture = 'scale'
      } else if (kind === 'mirror') {
        const axis = str(p, 'axis')
        if (axis !== 'x' && axis !== 'y') throw new Error('"axis" must be "x" (flip left-right) or "y" (flip top-bottom).')
        step = { kind: 'mirror', axis, cx, cy }
        gesture = 'mirror'
      } else {
        throw new Error(`"kind" must be move, rotate, scale or mirror (got "${kind}").`)
      }
    }
    bakePathsStep(ids, step, gesture)
    return { transformed: pathsById(ids).map((x) => pathSummary(x, false)) }
  },

  delete_paths: (p) => {
    const ids = optStrings(p, 'ids')
    if (!ids?.length) throw new Error('"ids" must name at least one path.')
    pathsById(ids)
    const opsBefore = useToolpathStore.getState().operations.length
    usePathsStore.getState().applyPathEdit({ deleteIds: ids })
    return { deleted: ids.length, toolpathsRemoved: opsBefore - useToolpathStore.getState().operations.length }
  },

  set_stock: (p) => {
    const wp = useWorkpieceStore.getState()
    const w = optNum(p, 'widthMM'), h = optNum(p, 'heightMM'), t = optNum(p, 'thicknessMM')
    for (const [k, v] of [['widthMM', w], ['heightMM', h], ['thicknessMM', t]] as const) {
      if (v !== undefined && v <= 0) throw new Error(`"${k}" must be more than 0.`)
    }
    const material = p.material
    if (material !== undefined && !MATERIALS.includes(material as Material)) {
      throw new Error(`"material" must be one of ${MATERIALS.join(', ')}.`)
    }
    if (w !== undefined) wp.setWidth(w)
    if (h !== undefined) wp.setHeight(h)
    if (t !== undefined) wp.setThickness(t)
    if (material !== undefined) wp.setMaterial(material as Material)
    return commands.status({})
  },

  new_project: (p) => {
    if (hasUnsavedWork() && p.discardUnsaved !== true) {
      throw new Error('The open project has unsaved changes. Ask the user whether to discard them; only then call again with discardUnsaved: true.')
    }
    newProject()
    if (typeof p.name === 'string' && p.name.trim()) useProjectStore.getState().setName(p.name.trim())
    return commands.status({})
  },

  undo: () => {
    const tl = useTimelineStore.getState()
    if (tl.cursor === 0) throw new Error('Nothing to undo.')
    tl.undo()
    return commands.status({})
  },

  redo: () => {
    const tl = useTimelineStore.getState()
    if (tl.cursor >= tl.events.length) throw new Error('Nothing to redo.')
    tl.redo()
    return commands.status({})
  },
}

Object.assign(commands, editCommands)

// ─── Toolpaths ─────────────────────────────────────────────────────────────────────
// Every toolpath type comes from the registry (panels/machine/toolpathKinds.ts): its
// settings, its tools, and how paths become operations — which is what its form's
// Generate would make. Made through the forms' own Generate (runBatchGenerate), so it is
// one undo step and one chip, and an operation that fails is not left behind. The form's
// saved defaults are NOT updated: what the assistant picks for one job is not the user's new
// preference.

function planContext(): PlanContext {
  return {
    tools: useToolStore.getState().tools,
    thicknessMM: useWorkpieceStore.getState().thicknessMM,
    saved: (key) => useFormDefaultsStore.getState().load(key),
    allPaths: usePathsStore.getState().paths,
  }
}

function drillPoints(v: unknown): { x: number; y: number }[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || !v.every((q) => q && typeof q === 'object' && Number.isFinite(q.x) && Number.isFinite(q.y))) {
    throw new Error('"points" must be a list of {"x": mm, "y": mm}.')
  }
  return v.map((q) => ({ x: q.x, y: q.y }))
}

const toolpathCommands: Record<string, Command> = {
  /** What create_toolpath would use for a type if given no settings — the form's starting values. */
  toolpath_defaults: (p) => {
    const kind = toolpathKind(p.type)
    const ctx = planContext()
    const plan = kind.plan([], {}, ctx, [])
    // Only what a caller can set; the rest is bookkeeping the plan adds.
    const settings = Object.fromEntries(Object.keys(kind.settings).flatMap((k) => k in plan.settings ? [[k, plan.settings[k]]] : []))
    const list = (s: Record<string, unknown>) => kind.allowedTools(ctx.tools, s).map((t) => `${t.id} (${t.name})`)
    return {
      type: kind.type,
      summary: kind.summary,
      settings,
      tool: toolSummary(plan.tool),
      toolsAllowed: kind.type === 'drill' ? { peck: list({ drillMode: 'peck' }), helical: list({ drillMode: 'helical' }) } : list({}),
    }
  },

  create_toolpath: async (p) => {
    const kind = toolpathKind(p.type)
    const ids = optStrings(p, 'pathIds') ?? []
    const points = drillPoints(p.points)
    if (points.length > 0 && !kind.points) throw new Error(`"points" is not taken by a ${kind.type}.`)
    if (kind.noPaths && ids.length) throw new Error(`A ${kind.type} takes no paths: ${kind.paths}`)
    if (!kind.noPaths && !ids.length && !points.length) throw new Error(kind.points ? 'Give "pathIds" or "points".' : '"pathIds" must name at least one path.')
    const paths = pathsById(ids).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    const settings = checkSettings(kind, p.settings)
    if (kind.create) {
      // A type with its own Generate (an inlay's linked pairs and cut-outs) makes them itself.
      const r = await kind.create(paths, settings, planContext())
      if (r.created.length === 0 && r.failed.length === 0) throw new Error(`Nothing to cut: ${r.skipped.join('; ') || 'no usable paths'}.`)
      const tools = useToolStore.getState().tools
      const ops = useToolpathStore.getState().operations
      return {
        created: r.created.flatMap((id) => ops.filter((o) => o.id === id)).map((op) => toolpathSummary(op, tools)),
        ...(r.failed.length ? { failed: r.failed, note: 'failed toolpaths were not kept, as in the app' } : {}),
        ...(r.skipped.length ? { skipped: r.skipped } : {}),
      }
    }
    const plan = kind.plan(paths, settings, planContext(), points)
    if (plan.items.length === 0) throw new Error(`Nothing to cut: ${plan.skipped.join('; ') || 'no usable paths'}.`)

    const made: string[] = []
    const errors: { toolpath: string; error: string }[] = []
    const notes: string[] = []
    await runBatchGenerate({
      type: kind.type,
      settings: plan.settings,
      items: plan.items,
      session: { liveOpId: () => undefined, remember: (_key, opId) => { made.push(opId) }, forget: () => {} },
      run: async (opId) => {
        const { notes: n } = await generateOperation(opId)
        notes.push(...n.map((x) => x.short))
      },
      onError: (opId, err) => {
        const name = useToolpathStore.getState().operations.find((o) => o.id === opId)?.name ?? opId
        errors.push({ toolpath: name, error: err instanceof Error ? err.message : String(err) })
      },
    })
    const { operations } = useToolpathStore.getState()
    const tools = useToolStore.getState().tools
    const live = made.flatMap((id) => operations.filter((o) => o.id === id))
    return {
      created: live.map((op) => toolpathSummary(op, tools)),
      ...(errors.length ? { failed: errors, note: 'failed toolpaths were not kept, as in the app' } : {}),
      ...(notes.length ? { notes } : {}),
      ...(plan.skipped.length ? { skipped: plan.skipped } : {}),
    }
  },

  update_toolpath: async (p) => {
    const id = str(p, 'id')
    const { operations } = useToolpathStore.getState()
    const op = operations.find((o) => o.id === id)
    if (!op) throw new Error(`No toolpath with id ${id}.`)
    const kind = toolpathKind(op.type)
    const s = checkSettings(kind, p.settings, true)
    if (Object.keys(s).length === 0) throw new Error('"settings" names nothing to change.')
    if (kind.update) {
      // A type whose edit is more than a settings write (an inlay's pair, a 3D Profile's
      // two-tool name) edits the way its form does.
      await kind.update(op, s, planContext())
      await waitForGeneration(GENERATION_WAIT_MS)
      const ops = useToolpathStore.getState().operations
      const linked = (op as { linkedOpId?: string }).linkedOpId
      return { updated: ops.filter((o) => o.id === op.id || o.id === linked).map((o) => toolpathSummary(o, useToolStore.getState().tools)) }
    }
    const patch: Record<string, unknown> = { ...s }
    if (s.toolId !== undefined) {
      // Judged with the op's own settings (a helical drill still needs an end mill).
      const tool = chooseTool(kind, useToolStore.getState().tools, { ...(op as unknown as Record<string, unknown>), ...s }, '')
      // A depth chosen for one cutter is not one for another — see StepDownField.
      if ('stepDownMM' in kind.settings && s.stepDownMM === undefined) { patch.stepDownMM = seedStepDownMM(tool); patch.stepDownManual = false }
      for (const [k, v] of Object.entries(kind.followTool?.(tool) ?? {})) if (!(k in s)) patch[k] = v
    }
    if (s.stepDownMM !== undefined) patch.stepDownManual = true
    // The form edits every operation one Generate click made, so this does too.
    const batch = batchOf(op, operations)
    // A new tool renames each op that carries the old one's name (toolpathStore.updateOperations).
    useToolpathStore.getState().updateOperations(batch.map((o) => ({ id: o.id, updates: patch as Partial<AnyOperation> })))
    regenerateMany(useToolpathStore.getState().operations.filter((o) => batch.some((b) => b.id === o.id)))
    await waitForGeneration(GENERATION_WAIT_MS)
    const tools = useToolStore.getState().tools
    return {
      updated: useToolpathStore.getState().operations.filter((o) => batch.some((b) => b.id === o.id)).map((o) => toolpathSummary(o, tools)),
    }
  },

  // The program order IS the cut order (generateGcode walks it), so this is how holes get
  // drilled before the part is cut free. One op.reorder, as a drag in the Toolpaths list.
  reorder_toolpaths: (p) => {
    const { operations, reorderOperations } = useToolpathStore.getState()
    let next: AnyOperation[]
    if (p.groupByTool === true) {
      next = groupedByTool(operations)
    } else {
      const ids = optStrings(p, 'ids')
      if (!ids?.length) throw new Error('Give "ids" to move, or groupByTool: true.')
      const missing = ids.filter((id) => !operations.some((o) => o.id === id))
      if (missing.length) throw new Error(`No toolpath with id ${missing.join(', ')}.`)
      const before = p.beforeId
      let to = operations.length
      if (typeof before === 'string') {
        if (ids.includes(before)) throw new Error('"beforeId" cannot be one of the toolpaths being moved.')
        to = operations.findIndex((o) => o.id === before)
        if (to < 0) throw new Error(`No toolpath with id ${before}.`)
      }
      next = reorderedFor(operations, ids, to)
    }
    if (!sameOrder(next, operations)) reorderOperations(next)
    const tools = useToolStore.getState().tools
    return { order: useToolpathStore.getState().operations.map((o) => toolpathSummary(o, tools)).map(({ id, name, tool }) => ({ id, name, tool })) }
  },

  // A hidden toolpath is left out of the exported G-code — which is what hiding is for.
  set_toolpath_visible: (p) => {
    const ids = optStrings(p, 'ids')
    if (!ids?.length) throw new Error('"ids" must name at least one toolpath.')
    if (typeof p.visible !== 'boolean') throw new Error('"visible" must be true or false.')
    const { operations, setOperationsVisible } = useToolpathStore.getState()
    const missing = ids.filter((id) => !operations.some((o) => o.id === id))
    if (missing.length) throw new Error(`No toolpath with id ${missing.join(', ')}.`)
    setOperationsVisible(ids, p.visible)
    return { ids, visible: p.visible }
  },

  delete_toolpaths: (p) => {
    const ids = optStrings(p, 'ids')
    if (!ids?.length) throw new Error('"ids" must name at least one toolpath.')
    const { operations } = useToolpathStore.getState()
    const missing = ids.filter((id) => !operations.some((o) => o.id === id))
    if (missing.length) throw new Error(`No toolpath with id ${missing.join(', ')}.`)
    useToolpathStore.getState().deleteOperations(ids)
    return { deleted: ids.length, toolpathsLeft: useToolpathStore.getState().operations.length }
  },
}

// ─── Tabs ───────────────────────────────────────────────────────────────────────
// Tabs belong to a PATH, not a toolpath: every profile of that path leaves them standing.
// Same store action and regenerate as the Tabs form.

const tabCommands: Record<string, Command> = {
  add_tabs: async (p) => {
    const ids = optStrings(p, 'pathIds')
    if (!ids?.length) throw new Error('"pathIds" must name at least one path.')
    const paths = pathsById(ids)
    const saved = useFormDefaultsStore.getState().load('tabs') as { count?: number; lengthMM?: number; heightMM?: number } | null
    const count = optInt(p, 'count', 1, 20) ?? saved?.count ?? 4
    const lengthMM = optNum(p, 'lengthMM') ?? saved?.lengthMM ?? 5
    const heightMM = optNum(p, 'heightMM') ?? saved?.heightMM ?? 2
    if (lengthMM < 0.5) throw new Error('"lengthMM" must be at least 0.5.')
    if (heightMM < 0.1) throw new Error('"heightMM" must be at least 0.1.')
    // A tab as tall as the cut leaves nothing to cut; say so rather than quietly cutting air.
    const ops = useToolpathStore.getState().operations
    const tooTall = ops.filter((o): o is Extract<AnyOperation, { type: 'profile' | 'trochoidal' }> => (o.type === 'profile' || o.type === 'trochoidal') && ids.includes(o.pathId) && heightMM >= o.depthMM)
    if (tooTall.length) throw new Error(`A ${heightMM} mm tab is as tall as the ${tooTall[0].depthMM} mm cut of ${tooTall[0].name}; make it lower.`)
    useTabStore.getState().applyTabsMany(paths, count, lengthMM, heightMM)
    regenerateAffectedMany(ids)
    await waitForGeneration(GENERATION_WAIT_MS)
    const affected = useToolpathStore.getState().operations.filter((o) => (o.type === 'profile' || o.type === 'trochoidal') && ids.includes(o.pathId))
    return {
      tabs: paths.map((x) => ({ pathId: x.id, name: x.name, count, lengthMM, heightMM })),
      regenerated: affected.map((o) => toolpathSummary(o, useToolStore.getState().tools)),
      ...(affected.length === 0 ? { note: 'No profile cuts these paths yet; the tabs will be used by any profile made later.' } : {}),
    }
  },

  delete_tabs: async (p) => {
    const ids = optStrings(p, 'pathIds')
    if (!ids?.length) throw new Error('"pathIds" must name at least one path.')
    pathsById(ids)
    const { deletePathTabs } = useTabStore.getState()
    for (const id of ids) deletePathTabs(id)
    regenerateAffectedMany(ids)
    await waitForGeneration(GENERATION_WAIT_MS)
    return { deletedTabsFrom: ids.length }
  },
}

Object.assign(commands, toolpathCommands, tabCommands)

// ─── Path tools ────────────────────────────────────────────────────────────────
// Each makes what its form's Apply makes, through the same action (tools/pathToolActions,
// tools/nestRun): one recorded edit, the result re-editable from its chip. Settings left
// out are the form's — its defaults, with the user's last-used values over them.

/** The form's defaults with its saved values over them — those of the same type only. */
function formSettings<T extends object>(formKey: string, defaults: T): T {
  const saved = useFormDefaultsStore.getState().load(formKey) ?? {}
  const out = { ...defaults } as Record<string, unknown>
  for (const [k, v] of Object.entries(defaults)) {
    const sv = (saved as Record<string, unknown>)[k]
    if (sv !== undefined && typeof sv === typeof v && Array.isArray(sv) === Array.isArray(v)) out[k] = sv
  }
  return out as T
}

/** `p[key]` if it is one of `values`, else `fallback`; anything else given is refused by name. */
function choice<T extends string>(p: Record<string, unknown>, key: string, values: readonly T[], fallback: T): T {
  const v = p[key]
  if (v === undefined || v === null) return fallback
  if (!values.includes(v as T)) throw new Error(`"${key}" must be one of ${values.join(', ')} (got ${JSON.stringify(v)}).`)
  return v as T
}
const optBool = (p: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const v = p[key]
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'boolean') throw new Error(`"${key}" must be true or false.`)
  return v
}

/** A tool result: the paths it made, or its error (thrown, so the model reads it as one). */
function made(r: { paths: ImportedPath[] } | { error: string }) {
  if ('error' in r) throw new Error(r.error)
  return { created: r.paths.map((x) => pathSummary(x, false)) }
}

const pathToolCommands: Record<string, Command> = {
  offset_paths: (p) => {
    const sources = pathsById(optStrings(p, 'ids') ?? [])
    if (!sources.length) throw new Error('"ids" must name at least one path.')
    const base = formSettings('offset', OFFSET_DEFAULTS)
    return made(createOffsets(sources, {
      distanceMM: optNum(p, 'distanceMM') ?? base.distanceMM,
      cornerStyle: choice(p, 'cornerStyle', ['miter', 'round', 'square'] as const, base.cornerStyle),
      keepShape: optBool(p, 'keepShape', base.keepShape),
      keepGenerated: optBool(p, 'keepGenerated', base.keepGenerated),
    }))
  },

  boolean_paths: (p) => {
    const ids = optStrings(p, 'ids') ?? []
    // In the order given: subtract keeps the first and cuts the rest away from it.
    const sources = pathsById(ids).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    const op = p.op as BooleanOpType
    if (!['union', 'intersect', 'subtract'].includes(op)) throw new Error('"op" must be union, intersect or subtract.')
    return made(createBoolean(sources, op))
  },

  pattern_paths: (p) => {
    const sources = pathsById(optStrings(p, 'ids') ?? [])
    if (!sources.length) throw new Error('"ids" must name at least one path.')
    const base = formSettings('pattern', PATTERN_DEFAULTS)
    const mode = choice(p, 'mode', ['linear', 'circular'] as const, base.mode)
    const lin = { ...PATTERN_DEFAULTS.linParams, ...base.linParams }
    const cir = { ...PATTERN_DEFAULTS.cirParams, ...base.cirParams }
    const params = mode === 'linear'
      ? {
          type: 'linear' as const,
          rows: optInt(p, 'rows', 1, 100) ?? lin.rows, cols: optInt(p, 'cols', 1, 100) ?? lin.cols,
          xGapMM: optNum(p, 'xGapMM') ?? lin.xGapMM, yGapMM: optNum(p, 'yGapMM') ?? lin.yGapMM,
        }
      : {
          type: 'circular' as const,
          count: optInt(p, 'count', 2, 360) ?? cir.count, radiusMM: optNum(p, 'radiusMM') ?? cir.radiusMM,
          startAngleDeg: optNum(p, 'startAngleDeg') ?? cir.startAngleDeg, endAngleDeg: optNum(p, 'endAngleDeg') ?? cir.endAngleDeg,
          rotateItems: optBool(p, 'rotateItems', cir.rotateItems),
        }
    return made(createPattern(sources, params))
  },

  text_along_path: async (p) => {
    const [text] = pathsById([str(p, 'textId')])
    const [guide] = pathsById([str(p, 'guideId')])
    const base = formSettings('alongpath', ALONG_DEFAULTS)
    const at = optNum(p, 'at') ?? base.at
    if (at < 0 || at > 1) throw new Error('"at" must be from 0 to 1.')
    return made(await createTextAlong(text, guide, {
      side: choice(p, 'side', ['out', 'on', 'in'] as const, base.side),
      at, spacingMM: optNum(p, 'spacingMM') ?? base.spacingMM, gapMM: optNum(p, 'gapMM') ?? base.gapMM,
      rotate: optBool(p, 'rotate', base.rotate),
    }))
  },

  list_corners: (p) => {
    const [path] = pathsById([str(p, 'pathId')])
    const session = cornerSession(path)
    return {
      pathId: path.id,
      corners: treatableCorners(session.baseD).map((c) => ({
        index: c.idx, xMM: r3(c.x), yMM: r3(c.y),
        ...((t) => (t ? { treated: { type: t.type, radiusMM: r3(t.radiusMM) } } : {}))(session.treatments.get(c.idx)),
      })),
    }
  },

  corner_treatment: (p) => {
    const [path] = pathsById([str(p, 'pathId')])
    const base = formSettings('nodeedit', { treatmentType: 'chamfer' as string, radiusMM: 2 })
    const type = choice(p, 'type', ['outerRound', 'innerRound', 'chamfer', 'dogbone', 'none'] as const,
      base.treatmentType as CornerTreatmentType | 'none')
    const radiusMM = optNum(p, 'radiusMM') ?? base.radiusMM
    if (type !== 'none' && !(radiusMM > 0)) throw new Error('"radiusMM" must be more than 0.')
    const session = cornerSession(path)
    const known = new Set(treatableCorners(session.baseD).map((c) => c.idx))
    const targets = (p.corners as unknown[] | undefined) ?? []
    if (!Array.isArray(targets) || !targets.every((i) => Number.isInteger(i) && known.has(i as number))) {
      throw new Error(`"corners" must be corner indexes from list_corners (this path has ${[...known].join(', ') || 'none'}).`)
    }
    const treatments = applyCorners(path, session, targets as number[], type, radiusMM)
    const [after] = pathsById([path.id])
    return { path: pathSummary(after, false), treatedCorners: [...treatments.keys()] }
  },

  nest_paths: async (p) => {
    const selPaths = pathsById(optStrings(p, 'ids') ?? [])
    if (!selPaths.length) throw new Error('"ids" must name the paths to nest.')
    const base = formSettings<NestFormState>('nest', NEST_DEFAULTS)
    const form: NestFormState = {
      ...base,
      spacingMM: optNum(p, 'spacingMM') ?? base.spacingMM,
      marginMM: optNum(p, 'marginMM') ?? base.marginMM,
      rotation: choice(p, 'rotation', ['none', '90', '45', '15'] as const, base.rotation),
      packFrom: choice(p, 'packFrom', ['left', 'bottom'] as const, base.packFrom),
      useHoles: optBool(p, 'useHoles', base.useHoles),
      avoidOthers: optBool(p, 'avoidOthers', base.avoidOthers),
      multiSheet: optBool(p, 'multiSheet', base.multiSheet),
      fillStock: optBool(p, 'fillStock', false),
      fillCount: optInt(p, 'fillCount', 0, 10000) ?? 0,
      copyToolpaths: optBool(p, 'copyToolpaths', base.copyToolpaths),
      sharedLines: optBool(p, 'sharedLines', false),
      sharedToolId: typeof p.sharedToolId === 'string' ? p.sharedToolId : base.sharedToolId,
    }
    // What the form works out from its settings — see NestForm.
    const groups = groupPathsForNesting(selPaths)
    if (groups.length === 0) throw new Error('Those paths make no parts to nest.')
    const { widthMM, heightMM } = useWorkpieceStore.getState()
    const cutters = toolsOfType(useToolStore.getState().tools, ['endmill'])
    const sharedTool = cutters.find((t) => t.id === pickToolId(form.sharedToolId, cutters))
    const sharing = form.sharedLines && !!sharedTool
    if (form.sharedLines && !sharedTool) throw new Error('Shared lines needs an end mill in the tool library.')
    if (form.fillStock && groups.length !== 1) throw new Error(`fillStock repeats ONE part; those paths are ${groups.length} parts.`)
    const rotation: RotOption = groups.length > FINE_ROTATION_MAX_PARTS && (form.rotation === '45' || form.rotation === '15') ? '90' : form.rotation
    let out
    try {
      out = await runNest({
        form, groups, selPaths, fillCopies: [], widthMM, heightMM,
        gapMM: sharing ? sharedTool!.diameterMM : form.spacingMM, sharing, sharedTool,
        rotation, filling: form.fillStock && groups.length === 1,
      })
    } catch (e) {
      if (isWorkCancelled(e)) throw new Error('The nest was stopped — nothing moved.')
      throw e
    }
    if ('error' in out) throw new Error(out.error)
    if ('none' in out) return { moved: 0, note: 'Nothing to move.' }
    return {
      ...out.report,
      ...(rotation !== form.rotation ? { note: `Turned in ${ROT_STEP[rotation]}° steps: finer rotation is only for ${FINE_ROTATION_MAX_PARTS} parts or fewer.` } : {}),
      parts: groups.length,
    }
  },

  trace_image: async (p) => {
    const [source] = pathsById([str(p, 'imageId')])
    const base = formSettings<TraceParams>('trace', DEFAULT_TRACE)
    const params: TraceParams = {
      ...base,
      ...(p.threshold !== undefined ? { threshold: optInt(p, 'threshold', 0, 255)!, autoThreshold: false } : {}),
      autoThreshold: optBool(p, 'autoThreshold', p.threshold !== undefined ? false : base.autoThreshold),
      trace: choice(p, 'trace', ['dark', 'light'] as const, base.trace),
      minSpeckMM: optNum(p, 'minSpeckMM') ?? base.minSpeckMM,
      smoothing: optInt(p, 'smoothing', 0, 100) ?? base.smoothing,
      tones: optInt(p, 'tones', 2, 8) ?? base.tones ?? 2,
      thickenMM: optNum(p, 'thickenMM') ?? base.thickenMM ?? 0,
      mode: choice(p, 'mode', ['outline', 'centerline'] as const, base.mode ?? 'outline'),
    }
    if (params.mode === 'centerline' && (params.tones ?? 2) > 2) throw new Error('A centerline trace is two tones only.')
    delete params.cuts // automatic cuts for the tone count given
    try {
      return made(await createTrace(source, params, 'trace-mcp'))
    } catch (e) {
      if (isWorkCancelled(e)) throw new Error('The trace was stopped.')
      throw e
    }
  },
}

Object.assign(commands, pathToolCommands)

/** Run `method`, or throw an Error whose message goes back to the model verbatim. */
export async function runCommand(method: string, params: unknown): Promise<unknown> {
  // Own keys only — "toString" must not reach Object.prototype.
  const cmd = Object.prototype.hasOwnProperty.call(commands, method) ? commands[method] : undefined
  if (!cmd) throw new Error(`FreazyKam has no command "${method}" — this page may be older than the MCP server; reload it.`)
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
  return await cmd(p)
}
