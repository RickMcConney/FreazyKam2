// What a NEW operation starts from, per form — the fallback each form merges the user's
// saved form defaults over (`mergeWithDefaults`). Plain functions, no React, so the MCP
// bridge (mcp/commands.ts) creates an operation from exactly what the form would have
// shown: the same seed values, and the same rules for which tools an op may use.

import type { Tool, ToolType, CuttingDirection } from '../../store/toolStore'
import type { CutSide } from '../../store/toolpathStore'
import type { StartFrom } from '../../cam/startHeight'
import type { PocketStrategy } from '../../cam/pocket'
import { seedStepDownMM } from '../../cam/feeds'
import type { ImportedPath } from '../../store/pathsStore'
import type { CircleInfo } from '../../canvas/selectionUtils'
import type { BatchItem } from './batchGenerate'
import type { Profile3dOperation } from '../../store/toolpathStore'
import { isVCutter } from '../../cam/geom'
import { DEFAULT_RELIEF_MM } from '../../cam/depthMapMesh'
import { DEFAULT_V_FLOOR_STEP_MM } from '../../cam/inlay'
import type { FluteBreakpoint } from '../../cam/fluting'

// Which tool types an operation can physically be cut with. A drill only plunges —
// it has no usable side-cutting edge — so it can never follow a profile or a
// trochoid; surfacing wants a flat bottom across the whole face, which a ball nose
// or V-bit can't leave. A form filters its dropdown with `toolsOfType` AND runs its
// initial id through `pickToolId`: saved form defaults and older projects can name
// a tool the op has no business using, and filtering alone would leave the select
// blank while Generate quietly went ahead with that tool.
export function toolsOfType(tools: Tool[], types: readonly ToolType[]): Tool[] {
  return tools.filter((t) => types.includes(t.type))
}

export function pickToolId(preferred: string | undefined, allowed: Tool[]): string {
  return allowed.some((t) => t.id === preferred) ? preferred! : (allowed[0]?.id ?? '')
}

// A profile follows the path with the side of the tool, so it needs a side-cutting
// edge — a drill has none. Tapered tools stay: the taper hint explains the wall a
// V-bit or ball nose leaves.
export const PROFILE_TOOL_TYPES: readonly ToolType[] = ['endmill', 'bullnose', 'ballnose', 'vbit', 'taper']
export const POCKET_TOOL_TYPES: readonly ToolType[] = ['endmill', 'bullnose', 'ballnose']
export const VCARVE_TOOL_TYPES: readonly ToolType[] = ['vbit', 'taper']

// A bridge long enough to join parts packed a few cutters apart, short enough that a
// stray one across a big gap of good stock is not on offer.
export const DEFAULT_BRIDGE_MAX_MM = 20

// A new profile rounds its inside corners, by at most this much. Large enough that the
// rounding arcs survive the G-code writer as G2/G3 (it fits arcs to 0.1 mm and needs a
// radius over 0.1 mm to do it) even at a 60° corner, where the arc's radius equals the
// deviation; small enough that the bottom of a corner barely changes.
export const DEFAULT_CORNER_TOLERANCE_MM = 0.2

// Stock the depth passes leave for the finishing pass: enough that the last pass cuts
// everywhere on the wall, past the tool's deflection and the depth passes' step lines,
// light enough to leave a clean wall.
export const DEFAULT_FINISH_PASS_MM = 0.3

export function profileFormDefaults(defaultTool: Tool | undefined, thicknessMM: number) {
  return {
    toolId: defaultTool?.id ?? '',
    side: 'outside' as CutSide,
    // A profile typically cuts the part free, so default to the full stock
    // thickness rather than the tool's max flute depth.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: seedStepDownMM(defaultTool),
    stepDownManual: false,
    direction: 'climb' as CuttingDirection,
    rampIn: false,
    allowanceMM: 0,
    roundCorners: true,
    cornerToleranceMM: DEFAULT_CORNER_TOLERANCE_MM,
    finishPass: false,
    finishPassMM: DEFAULT_FINISH_PASS_MM,
    springPass: false,
    sharedLines: false,
    bridgeGaps: false,
    bridgeMaxMM: DEFAULT_BRIDGE_MAX_MM,
    // Deliberately not carried over from the saved defaults — see PocketForm.
    startFrom: { mode: 'auto' } as StartFrom,
  }
}

export function pocketFormDefaults(defaultTool: Tool | undefined, thicknessMM: number) {
  return {
    toolId: defaultTool?.id ?? '',
    // 'hybrid' — shown as "Auto". Note this is only the default for a FIRST pocket: the
    // form-defaults store replays whatever was last used after that.
    strategy: 'hybrid' as PocketStrategy,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: seedStepDownMM(defaultTool),
    stepDownManual: false,
    stepoverPercent: 40,
    passAngleDeg: 0,
    autoAngle: true,
    direction: 'climb' as CuttingDirection,
    rampIn: false,
    allowanceMM: 0,
    // Never restored from the saved form defaults: a start reference belongs to the
    // operation it was chosen for, and replaying an old one onto a new pocket is exactly
    // the "silently starts 2 mm down over solid stock" case this design exists to avoid.
    startFrom: { mode: 'auto' } as StartFrom,
    // Not restored from the saved defaults either, and for the same reason: it belongs to
    // the selection it was chosen for. Replaying an inverted pocket onto an un-nested
    // selection would silently produce no operations at all.
    invert: false,
  }
}

export function vcarveFormDefaults(defaultTool: Tool | undefined, thicknessMM: number) {
  return {
    toolId: defaultTool?.id ?? '',
    // Default to the full stock thickness; the tool's max Z is only a warning.
    maxDepthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    // Deliberately not carried over from the saved defaults — see PocketForm.
    startFrom: { mode: 'auto' } as StartFrom,
  }
}

// Peck plunges straight down the axis, so any tool that can plunge is fair game — a drill
// bit above all. Helical bores the hole with the SIDE of the tool while it ramps, which
// is an end mill's job: a drill bit has no side edge (the form already refused to
// generate one), and a V-bit or ball nose would cut a cone or a rounded bottom rather
// than a straight-walled hole.
export const HELICAL_TOOL_TYPES: readonly ToolType[] = ['endmill']

export function drillFormDefaults(defaultTool: Tool | undefined, thicknessMM: number) {
  return {
    toolId: defaultTool?.id ?? '',
    drillMode: 'peck' as 'peck' | 'helical',
    startFrom: { mode: 'auto' as const } as StartFrom,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: seedStepDownMM(defaultTool),
    stepDownManual: false,
  }
}

/**
 * One path's holes as a drill batch item, read the way `mode` reads them — one op per
 * path. The holes ride as FIELDS, not settings: editing a batch rewrites its depth and
 * tool, but every op keeps the holes it was built from.
 */
export function drillPathItem(path: ImportedPath, holes: CircleInfo[], tool: Tool, mode: 'peck' | 'helical'): BatchItem {
  return mode === 'helical' ? {
    key: path.id,
    name: `Helical Drill: ${path.name} (${tool.name})${holes.length > 1 ? ` ×${holes.length}` : ''}`,
    fields: {
      drillMode: 'helical', points: [], pathId: path.id, helicalHoles: holes,
      helicalCenterX: holes[0].cx, helicalCenterY: holes[0].cy,
      helicalRadius: Math.max(0, holes[0].radiusMM - tool.diameterMM / 2),
    },
  } : {
    key: path.id,
    name: `Peck Drill: ${path.name} (${tool.name}) ×${holes.length}`,
    fields: { drillMode: 'peck', points: holes.map((h) => ({ x: h.cx, y: h.cy })), pathId: path.id },
  }
}

// Trochoidal cuts the whole width with the side of the tool — a drill can't, and a
// V-bit's width changes with depth, so the trochoid radius wouldn't mean anything.
export const TROCHOIDAL_TOOL_TYPES: readonly ToolType[] = ['endmill', 'bullnose', 'ballnose']

export function trochoidalFormDefaults(defaultTool: Tool | undefined, thicknessMM: number) {
  return {
    toolId: defaultTool?.id ?? '',
    side: 'outside' as CutSide,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: seedStepDownMM(defaultTool),
    stepDownManual: false,
    direction: 'climb' as CuttingDirection,
    trochStepMM: (defaultTool?.diameterMM ?? 6) * 0.15,
    trochRadiusMM: (defaultTool?.diameterMM ?? 6) * 0.5,
    finishingPass: true,
    rampIn: false,
  }
}

/** The loop sizes a trochoidal re-seeds when its tool changes — both scale with the cutter. */
export function trochoidalToolSeeds(tool: Tool) {
  return {
    trochStepMM: parseFloat((tool.diameterMM * 0.15).toFixed(3)),
    trochRadiusMM: parseFloat((tool.diameterMM * 0.5).toFixed(3)),
  }
}

// Fluting cuts ON the line, so the groove's section is the tool's own: a V-bit or taper
// leaves a V, a ball nose a round-bottomed flute. A flat end mill would leave a square
// step wherever the depth changes, so it is not offered.
export const FLUTING_TOOL_TYPES: readonly ToolType[] = ['vbit', 'taper', 'ballnose']

/** A new flute: full depth through the middle, tapering out to nothing at both ends. */
export const DEFAULT_FLUTE_PROFILE: FluteBreakpoint[] = [
  { t: 0, depth: 0 }, { t: 0.2, depth: 1 }, { t: 0.8, depth: 1 }, { t: 1, depth: 0 },
]

/** A stored or saved profile, or the default one when it is not a usable list of breakpoints. */
export function flutingProfileOf(v: unknown): FluteBreakpoint[] {
  const ok = Array.isArray(v) && v.length >= 2 &&
    v.every((p) => p && typeof p === 'object' && Number.isFinite(p.t) && Number.isFinite(p.depth))
  return ok ? (v as FluteBreakpoint[]).map((p) => ({ t: p.t, depth: p.depth })) : DEFAULT_FLUTE_PROFILE
}

export function flutingFormDefaults(defaultTool: Tool | undefined) {
  return {
    toolId: defaultTool?.id ?? '',
    // A flute is a decorative groove, not a cut through: a few mm, capped by the bit.
    depthMM: Math.min(3, defaultTool?.maxDepthMM ?? 3),
    stepDownMM: seedStepDownMM(defaultTool),
    stepDownManual: false,
    profile: DEFAULT_FLUTE_PROFILE,
    smooth: true,
    reverse: false,
  }
}

// Surfacing has to leave a flat face across the whole slab, so it's end mills only:
// a ball nose leaves scallops between passes and a V-bit leaves ridges.
export const SURFACE_TOOL_TYPES: readonly ToolType[] = ['endmill']

export function surfaceFormDefaults(defaultTool: Tool | undefined) {
  return {
    toolId: defaultTool?.id ?? '',
    depthMM: seedStepDownMM(defaultTool),
    stepDownMM: seedStepDownMM(defaultTool),
    stepDownManual: false,
    stepoverPercent: 40,
    passAngleDeg: 0,
  }
}

// ─── Photo V-Carve ───────────────────────────────────────────────────────────────

// V-bits only — the groove width the line spacing is derived from is 2·d·tan(θ/2), which
// exists only for a cone. See VCarveForm on the dropped fall-back to every tool.
export const PHOTO_VCARVE_TOOL_TYPES: readonly ToolType[] = ['vbit']

export function photoVcarveFormDefaults(defaultTool: Tool | undefined, firstImageId: string) {
  return {
    toolId: defaultTool?.id ?? '',
    pathId: firstImageId,
    passAngleDeg: 0,
    // White cuts nothing, black cuts 0.6 mm. Shallow on purpose: the depth sets the line
    // spacing, so this is the resolution control — 0.6 mm on a 60° bit gives 0.69 mm lines.
    minDepthMM: 0,
    maxDepthMM: 0.6,
    // Deliberately not carried over from the saved defaults — see PocketForm.
    startFrom: { mode: 'auto' } as StartFrom,
  }
}

// Raster lines are undirected — 200° and 20° lay down the same lines — so every angle has an
// equivalent in [0, 180), which is the range the slider offers.
export function norm180(deg: number) {
  const d = ((deg % 180) + 180) % 180
  return Math.round(d / 5) * 5 % 180
}

// ─── 3D Profile ──────────────────────────────────────────────────────────────────

export const PROFILE3D_FINISH_TOOL_TYPES: readonly ToolType[] = ['ballnose', 'bullnose', 'taper']
export const PROFILE3D_ROUGH_TOOL_TYPES: readonly ToolType[] = ['ballnose', 'bullnose', 'endmill']

export interface Profile3dSettings {
  toolId: string
  stepoverPercent: number
  finishStrategy: 'raster' | 'waterline'
  boundary: 'model' | 'stock' | 'path'
  boundaryPathId: string
  modelTopMM: number
  rasterAngleDeg: number
  maxDepthMM: number
  pathId: string
  reliefDepthMM: number         // depth map only
  invertDepth: boolean          // depth map only: dark is high
  roughingToolId: string        // '' = no roughing pass
  roughingStepoverPercent: number
  roughingStepDownMM: number
  /** The roughing step-down was typed over the auto one (BaseOperation.stepDownManual — the
   *  roughing pass is this operation's only step-down). */
  stepDownManual: boolean
  roughingStockAllowanceMM: number
  roughingRasterAngleDeg: number | ''  // '' = auto (finishing angle + 90)
}

export function profile3dFormDefaults(defaultTool: Tool | undefined, thicknessMM: number, firstModelId: string) {
  return {
    toolId: defaultTool?.id ?? '',
    stepoverPercent: 20,
    finishStrategy: 'raster' as 'raster' | 'waterline',
    boundary: 'model' as 'model' | 'stock' | 'path',
    boundaryPathId: '',
    modelTopMM: 0,
    rasterAngleDeg: 0,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    maxDepthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    pathId: firstModelId,
    reliefDepthMM: DEFAULT_RELIEF_MM,
    invertDepth: false,
    roughingToolId: '',
    roughingStepoverPercent: 60,
    roughingStepDownMM: 2,
    stepDownManual: false,
    roughingStockAllowanceMM: 0.3,
    roughingRasterAngleDeg: '' as number | '',
  }
}

/**
 * An existing 3D Profile read back as settings — what its form reopens on, and what an edit
 * starts from. A field the op does not carry (roughing on one made without it) takes the
 * form's fallback: a blank roughing stepover would mean no roughing pass at all.
 */
export function profile3dSettingsOf(op: Profile3dOperation): Profile3dSettings {
  return {
    toolId: op.toolId,
    stepoverPercent: op.stepoverPercent,
    finishStrategy: op.finishStrategy === 'raster' || !op.finishStrategy ? 'raster' : 'waterline',
    boundary: op.boundary ?? 'model',
    boundaryPathId: op.boundaryPathId ?? '',
    modelTopMM: op.modelTopMM ?? 0,
    rasterAngleDeg: op.rasterAngleDeg,
    maxDepthMM: op.maxDepthMM,
    pathId: op.pathId,
    reliefDepthMM: op.reliefDepthMM ?? DEFAULT_RELIEF_MM,
    invertDepth: !!op.invertDepth,
    roughingToolId: op.roughingToolId ?? '',
    roughingStepoverPercent: op.roughingStepoverPercent ?? 60,
    roughingStepDownMM: op.roughingStepDownMM ?? 2,
    stepDownManual: op.stepDownManual ?? false,
    roughingStockAllowanceMM: op.roughingStockAllowanceMM ?? 0.3,
    roughingRasterAngleDeg: op.roughingRasterAngleDeg ?? '',
  }
}

/**
 * The operation a 3D Profile's settings make, for the model `path`. Written the same way
 * whether it is new or edited: an unused roughing or boundary field is cleared, not left
 * behind from an earlier setting. A depth map is always rastered.
 */
export function profile3dOpFields(form: Profile3dSettings, path: ImportedPath, finish: Tool, roughing: Tool | undefined) {
  const isDepthMap = !!path.imageSrc
  const hasRoughing = !!form.roughingToolId
  return {
    name: hasRoughing
      ? `3D Profile: ${path.name} (rough: ${roughing?.name ?? ''} / finish: ${finish.name})`
      : `3D Profile: ${path.name} (${finish.name})`,
    toolId: form.toolId,
    pathId: path.id,
    reliefDepthMM: isDepthMap ? form.reliefDepthMM : undefined,
    invertDepth: isDepthMap && form.invertDepth ? true : undefined,
    stepoverPercent: form.stepoverPercent,
    finishStrategy: isDepthMap ? 'raster' as const : form.finishStrategy,
    boundary: form.boundary,
    boundaryPathId: form.boundary === 'path' ? form.boundaryPathId : undefined,
    modelTopMM: form.modelTopMM > 0 ? form.modelTopMM : undefined,
    rasterAngleDeg: form.rasterAngleDeg,
    maxDepthMM: form.maxDepthMM,
    roughingToolId: hasRoughing ? form.roughingToolId : undefined,
    roughingStepoverPercent: hasRoughing ? form.roughingStepoverPercent : undefined,
    roughingStepDownMM: hasRoughing ? form.roughingStepDownMM : undefined,
    stepDownManual: hasRoughing && form.stepDownManual ? true : undefined,
    roughingStockAllowanceMM: hasRoughing ? form.roughingStockAllowanceMM : undefined,
    roughingRasterAngleDeg: hasRoughing && form.roughingRasterAngleDeg !== '' ? form.roughingRasterAngleDeg : undefined,
  } satisfies Partial<Profile3dOperation>
}

// ─── Inlay ───────────────────────────────────────────────────────────────────────

// An inlay only fits if both halves are cut with a known wall and a flat floor, so both
// lists are strict — no fallback to the whole library when one comes up empty. Roughing
// clears the socket / frees the plug: end mills only, since a ball nose leaves a
// scalloped floor for the plug to bottom on and a drill can't clear at all. The finish
// tool cuts the WALL, and there are exactly two wall shapes the fit maths knows: sloped
// (V-bit) and flat (end mill).
export function inlayTools(tools: Tool[]) {
  return {
    vbits: tools.filter((t) => isVCutter(t)),
    endmills: toolsOfType(tools, ['endmill']),
    finishers: toolsOfType(tools, ['endmill', 'vbit', 'taper']),
  }
}

export function inlayFormDefaults(defaultVbit: Tool | undefined, defaultEndmill: Tool | undefined) {
  return {
    vbitToolId: defaultVbit?.id ?? '',
    pocketToolId: defaultEndmill?.id ?? '',
    pocketDepthMM: 5,
    stepDownMM: seedStepDownMM(defaultEndmill),
    stepDownManual: false,
    stepoverPercent: 40,
    glueLineMM: 0.2,
    clearanceMM: 0.1,
    vFloorStepMM: DEFAULT_V_FLOOR_STEP_MM,
    role: 'female' as const,
    rampIn: false,
    mirrorX: false,
    // A grouping choice, never a stored op field — inverting just reads the same selection
    // into a different set of boundaries, so the ops that come out are ordinary ones.
    // Deliberately not restored from saved defaults: which half of a nested selection is
    // the part is a property of THAT selection, not a preference.
    invert: false,
    cutout: true,
  }
}
