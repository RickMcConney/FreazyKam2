// THE TOOLPATH REGISTRY: one entry per toolpath type, saying everything a caller outside
// the form needs to make one — its settings (with what each must be and what it means),
// which tools it may use, and how a set of paths becomes its operations. The MCP bridge
// builds its toolpath tools FROM this (src/mcp/tools.ts, src/mcp/commands.ts), so a type
// added here reaches Claude with no change there, and a setting added to an entry is
// validated, documented and accepted everywhere at once.
//
// What an entry plans is what its form's Generate would make: the form's own new-op
// defaults with the user's saved form settings over them (opDefaults.ts, shared with the
// forms), the same path filtering, the same batch items. The forms still own their EDIT
// flow — selection revision, the session that remembers what a Generate made — which is
// about a person clicking, not about what an operation is.

import type { Tool, CuttingDirection } from '../../store/toolStore'
import type { CutSide, AddPayload, AnyOperation } from '../../store/toolpathStore'
import type { ImportedPath } from '../../importers/svgImporter'
import type { PocketStrategy } from '../../cam/pocket'
import { seedStepDownMM } from '../../cam/feeds'
import { mergeWithDefaults } from '../../store/formDefaultsStore'
import { includedAngleDeg } from '../../cam/geom'
import { extractCircles } from '../../canvas/selectionUtils'
import type { BatchItem } from './batchGenerate'
import { groupPathsByContainment, skipOpenPaths } from './containment'
import { outermostPaths } from './selectionKinds'
import {
  toolsOfType, pickToolId, profileFormDefaults, pocketFormDefaults, vcarveFormDefaults, drillFormDefaults, drillPathItem,
  trochoidalFormDefaults, trochoidalToolSeeds, surfaceFormDefaults, flutingFormDefaults, flutingProfileOf, FLUTING_TOOL_TYPES,
  photoVcarveFormDefaults, norm180, profile3dFormDefaults, profile3dOpFields, profile3dSettingsOf, inlayTools, inlayFormDefaults,
  PROFILE_TOOL_TYPES, POCKET_TOOL_TYPES, VCARVE_TOOL_TYPES, HELICAL_TOOL_TYPES, TROCHOIDAL_TOOL_TYPES, SURFACE_TOOL_TYPES,
  PHOTO_VCARVE_TOOL_TYPES, PROFILE3D_FINISH_TOOL_TYPES, PROFILE3D_ROUGH_TOOL_TYPES, type Profile3dSettings,
  PROFILE_KEY, savedProfileFor,
} from './opDefaults'
import { useToolpathStore, INLAY_NO_FINISH, type InlayOperation, type Profile3dOperation } from '../../store/toolpathStore'
import { runInlayGenerate, inlayEditGroup, type InlaySettings } from '../../tools/inlayRun'

export interface SettingSpec {
  type: 'number' | 'boolean' | 'string'
  enum?: readonly string[]
  description: string
  /** The value must be greater than this. */
  exclusiveMinimum?: number
  minimum?: number
  maximum?: number
  /** The value must be a whole multiple of this. */
  multipleOf?: number
  /** Set only when the toolpath is made; the reason is what an update is told. */
  createOnly?: string
  /** Means something only with this — "a roughing tool", "a depth-map picture". Documented,
   *  and accepted (ignored) without it, as the form keeps a hidden field's value. */
  onlyWith?: string
  /** A tool id other than the main `toolId`: the tools it may name, given the settings so far. */
  toolsFor?: (tools: Tool[], s: Record<string, unknown>) => Tool[]
}

/** What one Generate will make. */
export interface ToolpathPlan {
  /** Written to every operation of the batch. */
  settings: Record<string, unknown>
  /** One per operation, in cut order. */
  items: BatchItem[]
  tool: Tool
  /** What the form's rules left out, and why — said back so the caller is not surprised. */
  skipped: string[]
}

/** Where a plan reads the user's library, stock and saved form settings from. */
export interface PlanContext {
  tools: Tool[]
  thicknessMM: number
  /** The form's saved defaults (`formDefaultsStore.load`). */
  saved: (formKey: string) => Record<string, unknown> | null
  /** Every path in the document — for settings that name one (a 3D Profile's boundary). */
  allPaths?: ImportedPath[]
}

/** What a type with its own Generate made. */
export interface CreateResult {
  created: string[]
  failed: { toolpath: string; error: string }[]
  skipped: string[]
}

export interface ToolpathKind {
  type: AddPayload['type']
  /** One line: what this toolpath does. */
  summary: string
  /** What `pathIds` means for this type. */
  paths: string
  settings: Record<string, SettingSpec>
  /** Takes bare `points` (mm) as well as paths. */
  points?: string
  /** Takes no paths at all — it works on the whole stock. */
  noPaths?: boolean
  /** The tools this type may cut with, given the settings so far. */
  allowedTools: (tools: Tool[], s: Record<string, unknown>) => Tool[]
  plan: (paths: ImportedPath[], s: Record<string, unknown>, ctx: PlanContext, points: { x: number; y: number }[]) => ToolpathPlan
  /** Fields an existing operation re-seeds from a new tool (beyond the step-down every type
   *  reseeds) — unless the same call sets them. */
  followTool?: (tool: Tool) => Record<string, unknown>
  /** A type whose operations are not one batch item per path (an inlay's linked pairs and
   *  cut-outs) makes them itself, the way its form does. Plain types leave this out and are
   *  made by runBatchGenerate from `plan`. */
  create?: (paths: ImportedPath[], s: Record<string, unknown>, ctx: PlanContext) => Promise<CreateResult>
  /** Likewise for changing an existing operation's settings; resolves once regenerated. */
  update?: (op: AnyOperation, s: Record<string, unknown>, ctx: PlanContext) => Promise<void>
}

// ─── Shared setting specs ──────────────────────────────────────────────────────

const TOOL_ID: SettingSpec = { type: 'string', description: 'Tool library id (see list_tools / toolpath_defaults)' }
const DEPTH: SettingSpec = { type: 'number', exclusiveMinimum: 0, description: 'Total depth of cut, mm below where the cut starts' }
const STEP_DOWN: SettingSpec = { type: 'number', exclusiveMinimum: 0, description: 'Depth per pass, mm. Left out: seeded from the tool, as the form does' }
const DIRECTION: SettingSpec = { type: 'string', enum: ['climb', 'conventional'], description: 'Cutting direction' }
const RAMP_IN: SettingSpec = { type: 'boolean', description: 'Ramp into each pass instead of plunging' }
const ALLOWANCE: SettingSpec = { type: 'number', description: 'Stock left on the wall, mm; negative cuts past the line' }

/** The tool asked for, or the form's default, among those this type allows. */
export function chooseTool(kind: ToolpathKind, tools: Tool[], s: Record<string, unknown>, fallbackId: string): Tool {
  const allowed = kind.allowedTools(tools, s)
  const what = kind.type === 'drill' && s.drillMode === 'helical' ? 'helical drill' : kind.type
  if (allowed.length === 0) throw new Error(`The tool library has no tool a ${what} can cut with.`)
  const id = typeof s.toolId === 'string' ? s.toolId : pickToolId(fallbackId, allowed)
  const tool = allowed.find((t) => t.id === id)
  if (!tool) throw new Error(`A ${what} cannot use tool "${id}". It can use: ${allowed.map((t) => `${t.id} (${t.name})`).join(', ')}.`)
  return tool
}

/** A changed tool reseeds the step-down unless one was given — as the form's tool picker does. */
const stepDownFor = (s: Record<string, unknown>, tool: Tool, baseToolId: string, base: number) =>
  (s.stepDownMM as number | undefined) ?? (s.toolId !== undefined || tool.id !== baseToolId ? seedStepDownMM(tool) : base)

const startFrom = { mode: 'auto' as const }

// ─── The kinds ───────────────────────────────────────────────────────────────────

const profile: ToolpathKind = {
  type: 'profile',
  summary: 'Cut along each path: inside it, outside it, or on the line.',
  paths: 'One toolpath per path. An outside profile skips paths lying inside other selected paths (their holes).',
  settings: {
    toolId: TOOL_ID,
    side: { type: 'string', enum: ['inside', 'outside', 'centerline'], description: 'Which side of the line the tool runs on' },
    depthMM: DEPTH,
    stepDownMM: STEP_DOWN,
    direction: DIRECTION,
    rampIn: RAMP_IN,
    allowanceMM: ALLOWANCE,
    cornerToleranceMM: { type: 'number', minimum: 0, description: 'Round sharp corners of the tool path by at most this, mm; 0 = sharp' },
    finishPassMM: { type: 'number', minimum: 0, description: 'Stock the depth passes leave for one full-depth finishing pass, mm; 0 = no finishing pass' },
    springPass: { type: 'boolean', description: 'With a finishing pass: cut it twice' },
  },
  allowedTools: (tools) => toolsOfType(tools, PROFILE_TOOL_TYPES),
  plan(paths, s, ctx) {
    // The named side's own saved settings, as the form takes them (opDefaults
    // `savedProfileFor`); a side never generated falls back on the last profile's.
    const saved = savedProfileFor(ctx.saved, s.side as CutSide | undefined) ?? ctx.saved(PROFILE_KEY)
    const base = mergeWithDefaults(saved, profileFormDefaults(this.allowedTools(ctx.tools, s)[0], ctx.thicknessMM), ctx.tools)
    const tool = chooseTool(this, ctx.tools, s, base.toolId)
    const side = (s.side ?? base.side) as CutSide
    const centerline = side === 'centerline'
    const finishPassMM = centerline ? 0 : (s.finishPassMM as number | undefined) ?? (base.finishPass ? base.finishPassMM : 0)
    const skipped: string[] = []
    // The same two filters the form applies — see ProfileForm.
    let use = paths
    if (!centerline) {
      const r = skipOpenPaths(use)
      if (r.skipped) skipped.push(`${r.skipped} open path(s) — an ${side} cut needs a closed shape; use side "centerline" to follow a stroke`)
      use = r.closed
    }
    if (side === 'outside') {
      const r = outermostPaths(use)
      if (r.skipped) skipped.push(`${r.skipped} path(s) inside another selected path — an outside cut goes round the part, not its holes; profile those separately with side "inside"`)
      use = r.outer
    }
    return {
      tool, skipped,
      settings: {
        toolId: tool.id, side, depthMM: s.depthMM ?? base.depthMM,
        stepDownMM: stepDownFor(s, tool, base.toolId, base.stepDownMM), stepDownManual: s.stepDownMM !== undefined,
        direction: (s.direction ?? base.direction) as CuttingDirection, rampIn: s.rampIn ?? base.rampIn,
        allowanceMM: s.allowanceMM ?? base.allowanceMM,
        cornerToleranceMM: centerline ? 0 : (s.cornerToleranceMM as number | undefined) ?? (base.roundCorners ? base.cornerToleranceMM : 0),
        finishPassMM, springPass: finishPassMM > 0 && ((s.springPass ?? base.springPass) as boolean),
        sharedLines: false, bridgeMaxMM: 0, startFrom,
      },
      items: use.map((p) => ({ key: p.id, name: `Profile: ${p.name} (${tool.name})`, fields: { pathId: p.id } })),
    }
  },
}

const pocket: ToolpathKind = {
  type: 'pocket',
  summary: 'Clear the area inside each closed path to a depth.',
  paths: 'One toolpath per boundary; selected paths inside a boundary become its islands (left standing).',
  settings: {
    toolId: TOOL_ID,
    strategy: { type: 'string', enum: ['hybrid', 'raster', 'contour', 'morph', 'adaptive'], description: 'Clearing pattern; hybrid is "auto" in the app' },
    depthMM: DEPTH,
    stepDownMM: STEP_DOWN,
    stepoverPercent: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Distance between passes, % of the tool diameter' },
    passAngleDeg: { type: 'number', description: 'Raster angle, degrees' },
    autoAngle: { type: 'boolean', description: 'Let hybrid choose the raster angle (overrides passAngleDeg)' },
    direction: DIRECTION,
    rampIn: RAMP_IN,
    allowanceMM: ALLOWANCE,
    invert: { type: 'boolean', description: 'Read nested outlines the other way round: boundaries become islands', createOnly: 'it changes which paths are boundaries and which are islands; delete this pocket and create it again instead' },
  },
  allowedTools: (tools) => toolsOfType(tools, POCKET_TOOL_TYPES),
  plan(paths, s, ctx) {
    const base = mergeWithDefaults(ctx.saved('pocket'), pocketFormDefaults(this.allowedTools(ctx.tools, s)[0], ctx.thicknessMM), ctx.tools)
    const tool = chooseTool(this, ctx.tools, s, base.toolId)
    const r = skipOpenPaths(paths)
    const invert = (s.invert as boolean | undefined) ?? false
    return {
      tool,
      skipped: r.skipped ? [`${r.skipped} open path(s) — a pocket needs closed shapes`] : [],
      settings: {
        toolId: tool.id, strategy: (s.strategy ?? base.strategy) as PocketStrategy, depthMM: s.depthMM ?? base.depthMM,
        stepDownMM: stepDownFor(s, tool, base.toolId, base.stepDownMM), stepDownManual: s.stepDownMM !== undefined,
        stepoverPercent: s.stepoverPercent ?? base.stepoverPercent, passAngleDeg: s.passAngleDeg ?? base.passAngleDeg,
        autoAngle: s.autoAngle ?? base.autoAngle, direction: s.direction ?? base.direction, rampIn: s.rampIn ?? base.rampIn,
        allowanceMM: s.allowanceMM ?? base.allowanceMM, invert, startFrom,
      },
      items: groupPathsByContainment(r.closed, { invert }).map(({ boundary, islands }) => ({
        key: boundary.id, name: `Pocket: ${boundary.name} (${tool.name})`,
        fields: { pathId: boundary.id, islandIds: islands.map((p) => p.id) },
      })),
    }
  },
}

const vcarve: ToolpathKind = {
  type: 'vcarve',
  summary: 'Carve inside each closed path with a V-bit or taper, deeper where the shape is wider.',
  paths: 'One toolpath per boundary; selected paths inside a boundary become its islands.',
  settings: {
    toolId: { ...TOOL_ID, description: 'A V-bit or taper; the carve angle is the bit\'s' },
    maxDepthMM: { type: 'number', exclusiveMinimum: 0, description: 'Deepest the carve may go, mm' },
  },
  allowedTools: (tools) => toolsOfType(tools, VCARVE_TOOL_TYPES),
  // The angle is the bit's, never the op's — see VCarveForm.
  followTool: (tool) => ({ angleDeg: includedAngleDeg(tool) }),
  plan(paths, s, ctx) {
    const base = mergeWithDefaults(ctx.saved('vcarve'), vcarveFormDefaults(this.allowedTools(ctx.tools, s)[0], ctx.thicknessMM), ctx.tools)
    const tool = chooseTool(this, ctx.tools, s, base.toolId)
    const r = skipOpenPaths(paths)
    return {
      tool,
      skipped: r.skipped ? [`${r.skipped} open path(s) — a vcarve needs closed shapes`] : [],
      settings: { toolId: tool.id, angleDeg: includedAngleDeg(tool), maxDepthMM: s.maxDepthMM ?? base.maxDepthMM, startFrom },
      items: groupPathsByContainment(r.closed).map(({ boundary, islands }) => ({
        key: boundary.id, name: `V-Carve: ${boundary.name} (${tool.name})`,
        fields: { pathId: boundary.id, islandIds: islands.map((p) => p.id) },
      })),
    }
  },
}

const drill: ToolpathKind = {
  type: 'drill',
  summary: 'Drill holes: peck at each circle\'s centre, or bore each circle to size (helical).',
  paths: 'Paths whose circles are the holes — every circle in a path is one hole, one toolpath per path.',
  points: 'Peck only: hole centres in mm, as {x, y}',
  settings: {
    toolId: { ...TOOL_ID, description: 'Peck: any tool that plunges (a drill bit is best). Helical: an end mill' },
    drillMode: { type: 'string', enum: ['peck', 'helical'], description: 'peck = plunge at each centre; helical = spiral down to bore the circle to size', createOnly: 'it changes how every hole is cut; delete this drill toolpath and create it again instead' },
    depthMM: DEPTH,
    stepDownMM: STEP_DOWN,
  },
  // A peck drill plunges, so anything goes; a helical bore cuts with the side.
  allowedTools: (tools, s) => s.drillMode === 'helical' ? toolsOfType(tools, HELICAL_TOOL_TYPES) : tools,
  plan(paths, s, ctx, points) {
    const base = mergeWithDefaults(ctx.saved('drill'), drillFormDefaults(ctx.tools[0], ctx.thicknessMM), ctx.tools)
    const drillMode = (s.drillMode ?? base.drillMode) as 'peck' | 'helical'
    const tool = chooseTool(this, ctx.tools, { ...s, drillMode }, base.toolId)
    const skipped: string[] = []
    const items: BatchItem[] = []
    for (const path of paths) {
      // A path is not one hole: one circle per SUBPATH (extractCircles), one op per path.
      const holes = extractCircles(path)
      if (holes.length === 0) { skipped.push(`"${path.name}" has no circles to drill`); continue }
      items.push(drillPathItem(path, holes, tool, drillMode))
    }
    if (points.length > 0) {
      if (drillMode !== 'peck') throw new Error('Points can only be peck drilled; a helical bore needs a circle to know its size.')
      items.push({ key: 'peck', name: `Peck Drill (${tool.name}) ×${points.length}`, fields: { drillMode: 'peck', points } })
    }
    return {
      tool, skipped, items,
      settings: {
        toolId: tool.id, depthMM: s.depthMM ?? base.depthMM, drillMode,
        stepDownMM: stepDownFor(s, tool, base.toolId, base.stepDownMM), stepDownManual: s.stepDownMM !== undefined, startFrom,
      },
    }
  },
}

const trochoidal: ToolpathKind = {
  type: 'trochoidal',
  summary: 'Cut along each path in small overlapping loops, so the tool is never buried in a full-width slot — for slots and hard material.',
  paths: 'One toolpath per path; a centerline cut can follow an open stroke.',
  settings: {
    toolId: TOOL_ID,
    side: { type: 'string', enum: ['inside', 'outside', 'centerline'], description: 'Which side of the line the loops run on; centerline cuts a slot centred on the line' },
    depthMM: DEPTH,
    stepDownMM: STEP_DOWN,
    direction: DIRECTION,
    trochStepMM: { type: 'number', exclusiveMinimum: 0, description: 'Advance per loop, mm. Left out: 15% of the tool diameter' },
    trochRadiusMM: { type: 'number', exclusiveMinimum: 0, description: 'Loop amplitude, mm. Left out: half the tool diameter' },
    finishingPass: { type: 'boolean', description: 'Finish the wall with one clean pass after the loops' },
    rampIn: RAMP_IN,
  },
  allowedTools: (tools) => toolsOfType(tools, TROCHOIDAL_TOOL_TYPES),
  // The loops scale with the cutter, so a new tool reseeds them — as the form's tool picker does.
  followTool: (tool) => trochoidalToolSeeds(tool),
  plan(paths, s, ctx) {
    const base = mergeWithDefaults(ctx.saved('trochoidal'), trochoidalFormDefaults(this.allowedTools(ctx.tools, s)[0], ctx.thicknessMM), ctx.tools)
    const tool = chooseTool(this, ctx.tools, s, base.toolId)
    const seeds = s.toolId !== undefined || tool.id !== base.toolId ? trochoidalToolSeeds(tool) : base
    const side = (s.side ?? base.side) as CutSide
    // A sided cut needs a closed shape; a centerline one follows a stroke — see TrochoidalForm.
    const r = side === 'centerline' ? { closed: paths, skipped: 0 } : skipOpenPaths(paths)
    return {
      tool,
      skipped: r.skipped ? [`${r.skipped} open path(s) — an ${side} cut needs a closed shape; use side "centerline" to follow a stroke`] : [],
      settings: {
        toolId: tool.id, side, depthMM: s.depthMM ?? base.depthMM,
        stepDownMM: stepDownFor(s, tool, base.toolId, base.stepDownMM), stepDownManual: s.stepDownMM !== undefined,
        direction: (s.direction ?? base.direction) as CuttingDirection,
        trochStepMM: s.trochStepMM ?? seeds.trochStepMM, trochRadiusMM: s.trochRadiusMM ?? seeds.trochRadiusMM,
        finishingPass: s.finishingPass ?? base.finishingPass, rampIn: s.rampIn ?? base.rampIn,
      },
      items: r.closed.map((p) => ({ key: p.id, name: `Trochoidal: ${p.name} (${tool.name})`, fields: { pathId: p.id } })),
    }
  },
}

const fluting: ToolpathKind = {
  type: 'fluting',
  summary: 'Carve along each path on its centreline with a V-bit or ball nose, the depth following a height profile along the path — a flute that swells from nothing at its ends to full depth.',
  paths: 'One toolpath per path; open strokes are the usual case. The profile runs from each path\'s start to its end.',
  settings: {
    toolId: TOOL_ID,
    depthMM: { ...DEPTH, description: 'The deepest the flute goes, mm below the surface; the profile is fractions of this' },
    stepDownMM: STEP_DOWN,
    smooth: { type: 'boolean', description: 'Smooth curve between the profile\'s breakpoints rather than straight lines' },
    reverse: { type: 'boolean', description: 'Run the profile from each path\'s end instead of its start' },
  },
  allowedTools: (tools) => toolsOfType(tools, FLUTING_TOOL_TYPES),
  plan(paths, s, ctx) {
    const base = mergeWithDefaults(ctx.saved('fluting'), flutingFormDefaults(this.allowedTools(ctx.tools, s)[0]), ctx.tools)
    const tool = chooseTool(this, ctx.tools, s, base.toolId)
    return {
      tool, skipped: [],
      settings: {
        toolId: tool.id, depthMM: s.depthMM ?? base.depthMM,
        stepDownMM: stepDownFor(s, tool, base.toolId, base.stepDownMM), stepDownManual: s.stepDownMM !== undefined,
        // The profile is drawn in the form; Claude gets the one the user last drew.
        profile: flutingProfileOf(base.profile), smooth: s.smooth ?? base.smooth, reverse: s.reverse ?? base.reverse,
      },
      items: paths.map((p) => ({ key: p.id, name: `Fluting: ${p.name} (${tool.name})`, fields: { pathId: p.id } })),
    }
  },
}

const surface: ToolpathKind = {
  type: 'surface',
  summary: 'Face the whole top of the stock flat, in parallel passes.',
  paths: 'Takes no paths — it covers the whole stock.',
  noPaths: true,
  settings: {
    toolId: { ...TOOL_ID, description: 'An end mill (a flat bottom); a surfacing bit is ideal' },
    depthMM: { ...DEPTH, description: 'How much to take off the top, mm' },
    stepDownMM: STEP_DOWN,
    stepoverPercent: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Distance between passes, % of the tool diameter' },
    passAngleDeg: { type: 'number', description: 'Direction of the passes, degrees' },
  },
  allowedTools: (tools) => toolsOfType(tools, SURFACE_TOOL_TYPES),
  plan(_paths, s, ctx) {
    const base = mergeWithDefaults(ctx.saved('surface'), surfaceFormDefaults(this.allowedTools(ctx.tools, s)[0]), ctx.tools)
    const tool = chooseTool(this, ctx.tools, s, base.toolId)
    return {
      tool, skipped: [],
      settings: {
        toolId: tool.id, depthMM: s.depthMM ?? base.depthMM,
        stepDownMM: stepDownFor(s, tool, base.toolId, base.stepDownMM), stepDownManual: s.stepDownMM !== undefined,
        stepoverPercent: s.stepoverPercent ?? base.stepoverPercent, passAngleDeg: s.passAngleDeg ?? base.passAngleDeg,
      },
      items: [{ key: 'surface', name: `Surface (${tool.name})`, fields: {} }],
    }
  },
}

const photovcarve: ToolpathKind = {
  type: 'photovcarve',
  summary: 'Carve an imported photo as V-grooves whose depth follows its brightness (dark = deep).',
  paths: 'Imported pictures — one toolpath each.',
  settings: {
    toolId: { ...TOOL_ID, description: 'A V-bit; its angle sets the groove width' },
    passAngleDeg: { type: 'number', minimum: 0, maximum: 175, multipleOf: 5, description: 'Direction of the groove lines, degrees' },
    minDepthMM: { type: 'number', minimum: 0, description: 'Depth for white, mm' },
    maxDepthMM: { type: 'number', exclusiveMinimum: 0, description: 'Depth for black, mm — also sets the line spacing (the deepest groove\'s width), so it is the resolution' },
  },
  allowedTools: (tools) => toolsOfType(tools, PHOTO_VCARVE_TOOL_TYPES),
  // The angle is a property of the grind, not of the operation — same as V-Carve.
  followTool: (tool) => ({ angleDeg: tool.vbitAngleDeg ?? 60 }),
  plan(paths, s, ctx) {
    const base = mergeWithDefaults(ctx.saved('photovcarve'), photoVcarveFormDefaults(this.allowedTools(ctx.tools, s)[0], ''), ctx.tools)
    const tool = chooseTool(this, ctx.tools, s, base.toolId)
    const minDepthMM = (s.minDepthMM as number | undefined) ?? base.minDepthMM
    const maxDepthMM = (s.maxDepthMM as number | undefined) ?? base.maxDepthMM
    if (!(maxDepthMM > minDepthMM)) throw new Error(`"maxDepthMM" (${maxDepthMM}) must be deeper than "minDepthMM" (${minDepthMM}).`)
    const images = paths.filter((p) => !!p.imageSrc)
    return {
      tool,
      skipped: paths.filter((p) => !p.imageSrc).map((p) => `"${p.name}" is not an imported picture`),
      settings: {
        toolId: tool.id, angleDeg: tool.vbitAngleDeg ?? 60, passAngleDeg: norm180((s.passAngleDeg as number | undefined) ?? base.passAngleDeg),
        minDepthMM, maxDepthMM, startFrom,
      },
      items: images.map((p) => ({ key: p.id, name: `Photo V-Carve: ${p.name} (${tool.name})`, fields: { pathId: p.id } })),
    }
  },
}

const ROUGHING = 'a roughing tool (roughingToolId)'
const DEPTH_MAP = 'a depth-map picture'
const profile3dRough = (tools: Tool[]) => toolsOfType(tools, PROFILE3D_ROUGH_TOOL_TYPES)

const profile3d: ToolpathKind = {
  type: 'profile3d',
  summary: 'Carve a 3D model — an imported STL, or a picture read as a depth map (light = high) — with a finishing pass and an optional roughing pass.',
  paths: 'Imported STL models or pictures — one toolpath each.',
  settings: {
    toolId: { ...TOOL_ID, description: 'Finishing tool: a ball nose, bull nose or taper' },
    stepoverPercent: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Finishing stepover, % of the tool diameter' },
    finishStrategy: { type: 'string', enum: ['raster', 'waterline'], description: 'raster = parallel passes; waterline = contours at each height (STL only — a depth map is always rastered)' },
    boundary: { type: 'string', enum: ['model', 'stock', 'path'], description: 'What the carve is confined to; path = boundaryPathId' },
    boundaryPathId: { type: 'string', description: 'A closed path around the model to confine the carve to', onlyWith: 'boundary "path"' },
    modelTopMM: { type: 'number', minimum: 0, description: 'Sink the model\'s top this far below the stock top, mm; 0 = flush' },
    rasterAngleDeg: { type: 'number', description: 'Direction of the finishing passes, degrees' },
    maxDepthMM: { type: 'number', exclusiveMinimum: 0, description: 'Deepest the carve may go, mm' },
    reliefDepthMM: { type: 'number', exclusiveMinimum: 0, description: 'Height of the relief from black to white, mm', onlyWith: DEPTH_MAP },
    invertDepth: { type: 'boolean', description: 'Dark is high instead of low', onlyWith: DEPTH_MAP },
    roughingToolId: { type: 'string', description: 'Roughing tool (a ball nose, bull nose or end mill) to clear most of the stock first; "" for none', toolsFor: profile3dRough },
    roughingStepoverPercent: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Roughing stepover, %', onlyWith: ROUGHING },
    roughingStepDownMM: { type: 'number', exclusiveMinimum: 0, description: 'Roughing depth per pass, mm', onlyWith: ROUGHING },
    roughingStockAllowanceMM: { type: 'number', minimum: 0, description: 'Stock the roughing pass leaves for the finish, mm', onlyWith: ROUGHING },
    roughingRasterAngleDeg: { type: 'number', description: 'Roughing pass direction, degrees; left out = finishing angle + 90', onlyWith: ROUGHING },
  },
  allowedTools: (tools) => toolsOfType(tools, PROFILE3D_FINISH_TOOL_TYPES),
  plan(paths, s, ctx) {
    const base = mergeWithDefaults(ctx.saved('profile3d'), profile3dFormDefaults(this.allowedTools(ctx.tools, s)[0], ctx.thicknessMM, ''), ctx.tools)
    const tool = chooseTool(this, ctx.tools, s, base.toolId)
    const roughs = profile3dRough(ctx.tools)
    // A saved roughing tool that has gone falls back as the form does; one ASKED for must exist.
    const asked = s.roughingToolId as string | undefined
    const roughingToolId = asked !== undefined ? asked : (base.roughingToolId === '' ? '' : pickToolId(base.roughingToolId, roughs))
    const roughing = roughingToolId ? roughs.find((t) => t.id === roughingToolId) : undefined
    if (roughingToolId && !roughing) {
      throw new Error(`A 3D Profile cannot rough with tool "${roughingToolId}". It can use: ${roughs.map((t) => `${t.id} (${t.name})`).join(', ') || 'no tool in the library'}.`)
    }
    const form = {
      ...base, ...s, toolId: tool.id, roughingToolId,
      // A saved boundary path is an id from the session it was saved in — see Profile3dForm.
      ...(s.boundary === undefined && base.boundary === 'path' ? { boundary: 'model' as const, boundaryPathId: '' } : {}),
      stepDownManual: s.roughingStepDownMM !== undefined,
    } as Profile3dSettings
    if (form.boundary === 'path' && !ctx.allPaths?.some((p) => p.id === form.boundaryPathId)) {
      if (ctx.allPaths) throw new Error('boundary "path" needs "boundaryPathId": a closed path around the model.')
    }
    const skipped: string[] = []
    const items: BatchItem[] = []
    for (const p of paths) {
      const isModel = !!p.imageSrc || (!!p.stlSrc && !!p.stlModelBounds)
      if (!isModel) { skipped.push(`"${p.name}" is not an imported STL model or picture`); continue }
      const fields = profile3dOpFields(form, p, tool, roughing)
      items.push({ key: p.id, name: fields.name, fields })
    }
    // What an STL model would get — the operation's settings as the caller sees them.
    const { name: _n, pathId: _p, ...settings } = profile3dOpFields(form, { id: '', name: '', d: '', visible: true, color: '' }, tool, roughing)
    return { tool, skipped, items, settings: { ...settings, roughingToolId: roughing ? roughingToolId : '' } }
  },
  // The name carries both tools, so a change of either renames it; the rest is the same
  // mapping a new one gets — what the form's Regenerate writes.
  async update(op, s, ctx) {
    const path = ctx.allPaths?.find((p) => p.id === (op as Profile3dOperation).pathId)
    if (!path) throw new Error('The model this 3D Profile carves no longer exists.')
    // Read back exactly as the form's edit mode reads it — see profile3dSettingsOf.
    const current = profile3dSettingsOf(op as Profile3dOperation)
    const plan = this.plan([path], { ...current, ...s }, ctx, [])
    const fields = plan.items[0]?.fields
    if (!fields) throw new Error(plan.skipped.join('; '))
    const store = useToolpathStore.getState()
    store.updateOperation(op.id, { ...fields, name: plan.items[0].name, status: 'generating' } as Partial<AnyOperation>)
    const { regenerateOperation } = await import('../../cam/regenerate')
    await regenerateOperation(op.id)
  },
}

const inlay: ToolpathKind = {
  type: 'inlay',
  summary: 'Cut one half of an inlay: the female socket, or the male plug that fills it, with V-bit walls that close up as the plug is pressed in. Make both halves (two calls, role female then male) from the same design.',
  paths: 'The design — one inlay per boundary; selected paths inside a boundary are its islands (left standing in the socket, holes in the plug). Open paths are skipped.',
  settings: {
    vbitToolId: { type: 'string', description: 'Wall tool: a V-bit or taper (sloped walls that close up), an end mill (flat walls), or "none" to rough only', toolsFor: (tools) => inlayTools(tools).finishers },
    pocketToolId: { type: 'string', description: 'Roughing end mill that clears the floor', toolsFor: (tools) => inlayTools(tools).endmills },
    pocketDepthMM: { type: 'number', exclusiveMinimum: 0, description: 'Socket depth, mm' },
    stepDownMM: STEP_DOWN,
    stepoverPercent: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Roughing stepover, %' },
    glueLineMM: { type: 'number', minimum: 0, description: 'Gap left under the plug for glue, mm' },
    clearanceMM: { type: 'number', minimum: 0, description: 'Side clearance between plug and socket, mm' },
    vFloorStepMM: { type: 'number', exclusiveMinimum: 0, description: 'Female: spacing of the V-bit\'s floor-finishing loops, mm' },
    role: { type: 'string', enum: ['female', 'male'], description: 'female = the socket, male = the plug', createOnly: 'a socket and a plug are different cuts; delete this inlay and create the other half' },
    rampIn: RAMP_IN,
    mirrorX: { type: 'boolean', description: 'Male: mirror the plug, for a board that is turned over to glue in' },
    invert: { type: 'boolean', description: 'Read nested outlines the other way round', createOnly: 'it changes which paths are the part; delete this inlay and create it again instead' },
    cutout: { type: 'boolean', description: 'Male: draw a cut-out outline round the plug and add a through profile that frees it' },
  },
  allowedTools: (tools) => inlayTools(tools).endmills,
  plan(paths, s, ctx) {
    const { vbits, endmills, finishers } = inlayTools(ctx.tools)
    const base = mergeWithDefaults(ctx.saved('inlay'), inlayFormDefaults(vbits[0] ?? finishers[0], endmills[0]), ctx.tools)
    const pocketToolId = (s.pocketToolId as string | undefined) ?? pickToolId(base.pocketToolId, endmills)
    const pocket = endmills.find((t) => t.id === pocketToolId)
    if (!pocket) throw new Error(`An inlay's roughing tool must be an end mill. It can use: ${endmills.map((t) => `${t.id} (${t.name})`).join(', ') || 'no end mill in the library'}.`)
    // "None" is an explicit choice, not a stale id — never coerce it to a real tool.
    const vbitToolId = (s.vbitToolId as string | undefined)
      ?? (base.vbitToolId === INLAY_NO_FINISH ? INLAY_NO_FINISH : (pickToolId(base.vbitToolId, finishers) || INLAY_NO_FINISH))
    if (vbitToolId !== INLAY_NO_FINISH && !finishers.some((t) => t.id === vbitToolId)) {
      throw new Error(`An inlay's wall tool must be a V-bit, taper or end mill, or "none". It can use: ${finishers.map((t) => `${t.id} (${t.name})`).join(', ')}.`)
    }
    const settings: InlaySettings = {
      ...(base as InlaySettings), ...(s as Partial<InlaySettings>), pocketToolId, vbitToolId,
      stepDownMM: (s.stepDownMM as number | undefined) ?? (pocketToolId !== base.pocketToolId ? seedStepDownMM(pocket) : base.stepDownMM),
      stepDownManual: s.stepDownMM !== undefined,
      invert: (s.invert as boolean | undefined) ?? false,
    }
    const r = skipOpenPaths(paths)
    return { tool: pocket, skipped: r.skipped ? [`${r.skipped} open path(s) — an inlay needs closed shapes`] : [], items: [], settings: settings as unknown as Record<string, unknown> }
  },
  async create(paths, s, ctx) {
    const plan = this.plan(paths, s, ctx, [])
    const form = plan.settings as unknown as InlaySettings
    const closed = skipOpenPaths(paths).closed
    const groups = groupPathsByContainment(closed, { invert: form.invert })
    if (groups.length === 0) return { created: [], failed: [], skipped: plan.skipped }
    const finishIsNone = form.vbitToolId === INLAY_NO_FINISH
    const before = new Set(useToolpathStore.getState().operations.map((o) => o.id))
    const failed: CreateResult['failed'] = []
    await runInlayGenerate({
      form, groups, selPaths: closed, vbitTool: finishIsNone ? null : ctx.tools.find((t) => t.id === form.vbitToolId),
      pocketTool: plan.tool, finishIsNone,
      // No memory of an earlier Generate: always fresh operations.
      session: { liveOpId: () => undefined, remember: () => {}, forget: () => {} },
      groupKey: (id) => id, staleOps: [], staleDeleteIds: [],
      reportError: (opId, err) => {
        const name = useToolpathStore.getState().operations.find((o) => o.id === opId)?.name ?? opId
        failed.push({ toolpath: name, error: err instanceof Error ? err.message : String(err) })
      },
      onDone: () => {},
    })
    return { created: useToolpathStore.getState().operations.filter((o) => !before.has(o.id)).map((o) => o.id), failed, skipped: plan.skipped }
  },
  // An edit regenerates the pair (and the male's cut-out) the way the form's edit does.
  async update(op, s, ctx) {
    const editOp = op as InlayOperation
    const group = inlayEditGroup(editOp, ctx.allPaths ?? [])
    if (!group) throw new Error('The design this inlay was cut from no longer exists.')
    const current: Partial<InlaySettings> = {
      vbitToolId: editOp.vbitToolId, pocketToolId: editOp.pocketToolId, pocketDepthMM: editOp.pocketDepthMM,
      stepDownMM: editOp.stepDownMM, stepoverPercent: editOp.stepoverPercent, glueLineMM: editOp.glueLineMM,
      clearanceMM: editOp.clearanceMM, vFloorStepMM: editOp.vFloorStepMM, role: editOp.role, rampIn: editOp.rampIn ?? false,
      mirrorX: editOp.mirrorX ?? false, cutout: !!editOp.bandId,
    }
    const plan = this.plan([], { ...current, ...s, stepDownMM: s.stepDownMM ?? (s.pocketToolId !== undefined ? undefined : current.stepDownMM) }, ctx, [])
    const form = { ...(plan.settings as unknown as InlaySettings), stepDownManual: s.stepDownMM !== undefined || (editOp.stepDownManual ?? false) }
    const finishIsNone = form.vbitToolId === INLAY_NO_FINISH
    await runInlayGenerate({
      form, groups: [group], selPaths: [], editOp, editBoundary: group.boundary,
      vbitTool: finishIsNone ? null : ctx.tools.find((t) => t.id === form.vbitToolId), pocketTool: plan.tool, finishIsNone,
      session: { liveOpId: () => undefined, remember: () => {}, forget: () => {} },
      groupKey: (id) => id, staleOps: [], staleDeleteIds: [], reportError: () => {}, onDone: () => {},
    })
  },
}

export const TOOLPATH_KINDS: Record<string, ToolpathKind> = { profile, pocket, vcarve, drill, trochoidal, fluting, surface, photovcarve, profile3d, inlay }

/** The entry for `type`, or an error listing the ones there are. */
export function toolpathKind(type: unknown): ToolpathKind {
  const kind = typeof type === 'string' && Object.prototype.hasOwnProperty.call(TOOLPATH_KINDS, type) ? TOOLPATH_KINDS[type] : undefined
  if (!kind) throw new Error(`"type" must be one of ${Object.keys(TOOLPATH_KINDS).join(', ')} (got ${JSON.stringify(type)}).`)
  return kind
}

/**
 * `raw` checked against the type's settings: unknown keys, wrong types, bad choices and
 * out-of-range numbers are refused BY NAME — a typo silently ignored would cut the
 * default instead. `update` also refuses the settings only a new toolpath can take.
 */
export function checkSettings(kind: ToolpathKind, raw: unknown, update = false): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('"settings" must be an object.')
  for (const [k, v] of Object.entries(raw)) {
    const spec = kind.settings[k]
    if (!spec) throw new Error(`A ${kind.type} has no setting "${k}". Its settings are: ${Object.keys(kind.settings).join(', ')}.`)
    if (update && spec.createOnly) throw new Error(`"${k}" can't be changed: ${spec.createOnly}.`)
    if (typeof v !== spec.type || (spec.type === 'number' && !Number.isFinite(v))) {
      throw new Error(`"${k}" must be a ${spec.type} (got ${JSON.stringify(v)}).`)
    }
    if (spec.enum && !spec.enum.includes(v as string)) throw new Error(`"${k}" must be one of ${spec.enum.join(', ')} (got ${JSON.stringify(v)}).`)
    if (typeof v === 'number') {
      if (spec.exclusiveMinimum !== undefined && !(v > spec.exclusiveMinimum)) throw new Error(`"${k}" must be more than ${spec.exclusiveMinimum}.`)
      if (spec.minimum !== undefined && v < spec.minimum) throw new Error(`"${k}" must be at least ${spec.minimum}.`)
      if (spec.maximum !== undefined && v > spec.maximum) throw new Error(`"${k}" must be at most ${spec.maximum}.`)
      if (spec.multipleOf !== undefined && Math.abs(v / spec.multipleOf - Math.round(v / spec.multipleOf)) > 1e-9) {
        throw new Error(`"${k}" must be a multiple of ${spec.multipleOf}.`)
      }
    }
  }
  return raw as Record<string, unknown>
}
