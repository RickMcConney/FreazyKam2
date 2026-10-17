// What each path tool DOES when it makes something new — the step after its geometry is
// worked out: the new paths, what they were made from (`definition`, which is what lets
// the result's chip reopen the form on it), and the one recorded edit that puts them in
// the document. The forms call these for a fresh Apply, and so does the MCP bridge
// (mcp/commands.ts), so a path made by either is the same object. Each form keeps its own
// EDIT mode — reworking an existing result from its chip — which is about a person
// clicking the result, not about what the result is.

import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { nextPathColor, type PathDefinition } from '../importers/svgImporter'
import { uid } from '../uid'
import { getMultiBBox, extractRectInfo } from '../canvas/selectionUtils'
import { planOffset, planFields, type OffsetFormState } from './offsetPlan'
import { OFFSETTABLE_SHAPES } from './shapeOffset'
import { applyBooleanOp, type BooleanOpType } from './booleanOps'
import { computePatternInstances, patternCopies, type PatternParams } from './patternOp'
import { layoutAlongPath, type AlongPathOptions } from './alongPath'
import { textGlyphRuns, loadFont, isFontLoaded, type TextParams } from '../shapes/textGenerator'
import {
  applyCornerTreatments, getTreatableCorners, pathSimilarityTransform, transformPathBySimilarity,
  type CornerTreatmentType,
} from './cornerTreatment'
import { DEFAULT_TRACE, type TraceParams, type TraceResult } from './imageTrace'
import { loadImageLuminance } from '../io/imageLuminance'
import { runInWorkerFor } from '../workers/workerClient'
import { traceColors } from './traceColors'

/** A path tool's answer: what it added, or why it added nothing — said in the form's words. */
export type ToolResult = { paths: ImportedPath[] } | { error: string }

// ─── Offset ────────────────────────────────────────────────────────────────────

export const OFFSET_DEFAULTS: OffsetFormState = { distanceMM: 5, cornerStyle: 'miter', keepShape: false, keepGenerated: true }

/** Why `src` gave no offset under `form`. */
export function offsetFailure(src: ImportedPath, form: OffsetFormState): string {
  return form.keepGenerated && src.shapeParams && OFFSETTABLE_SHAPES.has(src.shapeParams.type)
    ? `${src.name} cannot be inset that far`
    : form.keepShape && !src.shapeParams
      ? `${src.name} cannot shrink that far by scaling`
      : `Offset produced no geometry for ${src.name}`
}

/** Offset each source into a new path, one definition for the lot; selected. */
export function createOffsets(sources: ImportedPath[], form: OffsetFormState): ToolResult {
  const defId = uid('def')
  const newPaths: ImportedPath[] = []
  for (const p of sources) {
    const plan = planOffset(p, form)
    if (!plan) continue
    newPaths.push({
      id: uid('path-offset'), name: `${p.name} offset`, d: plan.d, visible: true, color: nextPathColor(),
      ...planFields(plan),
      definition: { id: defId, kind: 'offset', sourceId: p.id, ...form },
    })
  }
  if (newPaths.length === 0) return { error: sources.length === 1 ? offsetFailure(sources[0], form) : 'Offset produced no geometry' }
  const store = usePathsStore.getState()
  store.addPaths(newPaths, { source: 'offset' })
  store.setSelectedIds(newPaths.map((p) => p.id))
  return { paths: newPaths }
}

// ─── Boolean ───────────────────────────────────────────────────────────────────

export const booleanLabel = (op: BooleanOpType) => op.charAt(0).toUpperCase() + op.slice(1)

/**
 * Combine the sources into one result path, IN ORDER (subtract keeps the first and cuts
 * the rest away). ONE atomic edit — one chip, one undo step: add the result, soft-hide the
 * sources, select the result.
 */
export function createBoolean(sources: ImportedPath[], op: BooleanOpType): ToolResult {
  if (sources.length < 2) return { error: 'A boolean needs 2 or more paths' }
  const result = applyBooleanOp(op, sources.map((p) => p.d))
  if ('error' in result) return { error: result.error }
  if (!result.resultD) return { error: 'Result is empty' }
  const newPath: ImportedPath = {
    id: uid('path-bool'), name: `${booleanLabel(op)} result`, d: result.resultD, visible: true, color: nextPathColor(),
    definition: { id: uid('def'), kind: 'boolean', op, sourceIds: sources.map((p) => p.id) },
  }
  usePathsStore.getState().applyPathEdit({
    gesture: 'boolean',
    add: [newPath],
    updates: sources.map((p) => ({ id: p.id, d: p.d, hidden: true })),
    selectAfter: [newPath.id],
  })
  return { paths: [newPath] }
}

// ─── Pattern ───────────────────────────────────────────────────────────────────

export const PATTERN_DEFAULTS = {
  mode: 'linear' as 'linear' | 'circular',
  linParams: { rows: 2, cols: 3, xGapMM: 5, yGapMM: 5 },
  cirParams: { count: 6, radiusMM: 30, startAngleDeg: 0, endAngleDeg: 360, rotateItems: true },
}

/** The copies a pattern of `sources` makes — everything but the original — or why it makes none. */
export function patternDefs(sources: ImportedPath[], params: PatternParams): { defs: ReturnType<typeof patternCopies> } | { error: string } {
  const instances = computePatternInstances(params, getMultiBBox(sources.map((p) => p.d)))
  if (instances.length === 0) return { error: 'Pattern produced no instances' }
  // [0] is the original itself, for both kinds — a circular pattern's count includes it.
  const instancesToCreate = instances.slice(1)
  if (instancesToCreate.length === 0) return { error: 'A pattern of one is just the original' }
  // A COPY IS THE SHAPE IT WAS COPIED FROM. patternCopies carries the whole
  // identity across — parameters, placement, the shared groupId that makes a
  // train track's body, grooves and treads ONE part — with a fresh group per
  // instance so patterning a group does not grow the group being patterned.
  // Without it the copies were loose outlines, and nesting a patterned track
  // laid every groove out as a part of its own.
  const defs = patternCopies(sources, instancesToCreate)
  if (defs.length === 0) return { error: 'Pattern produced no geometry' }
  return { defs }
}

export function createPattern(sources: ImportedPath[], params: PatternParams): ToolResult {
  const r = patternDefs(sources, params)
  if ('error' in r) return r
  const definition: PathDefinition = { id: uid('def'), kind: 'pattern', sourceIds: sources.map((p) => p.id), params }
  const newPaths: ImportedPath[] = r.defs.map((def) => ({ ...def, id: uid('path-pattern'), definition }))
  usePathsStore.getState().addPaths(newPaths, { source: 'pattern' })
  return { paths: newPaths }
}

// ─── Text along a path ─────────────────────────────────────────────────────────

export const ALONG_DEFAULTS: AlongPathOptions = { side: 'out', at: 0.5, spacingMM: 0, gapMM: 0, rotate: true }

/** The text laid along `guideD` as one d string; null while its font has yet to load. */
export function alongResult(params: TextParams, guideD: string, opts: AlongPathOptions): string | null {
  const runs = textGlyphRuns(params)
  if (!runs) return null
  return layoutAlongPath(runs, params.fontSize, guideD, opts)
}

/**
 * Lay a Text object along a guide path as a new path; the text itself is soft-hidden, in
 * the same edit. Loads the text's font first if it has not been.
 */
export async function createTextAlong(text: ImportedPath, guide: ImportedPath, opts: AlongPathOptions): Promise<ToolResult> {
  if (text.shapeParams?.type !== 'text') return { error: `${text.name} is not a Text object` }
  const params = text.shapeParams as TextParams
  if (!isFontLoaded(params.fontFamily)) await loadFont(params.fontFamily)
  const d = alongResult(params, guide.d, opts)
  if (!d) return { error: `The text could not be laid along ${guide.name}` }
  return { paths: [addTextAlong(text, guide, opts, d)] }
}

/** Add `d` — the text laid along the guide — as the result path, hiding the text, in one edit. */
export function addTextAlong(text: ImportedPath, guide: ImportedPath, opts: AlongPathOptions, d: string): ImportedPath {
  const definition: PathDefinition = { id: uid('def'), kind: 'along', sourceId: text.id, guideId: guide.id, params: opts }
  // A group of one, so the form's preview can hide it while it is being edited.
  const made: ImportedPath = {
    id: uid('path-along'), name: `${text.name} on path`, d, visible: true, color: text.color,
    groupId: uid('grp-along'), groupName: `${text.name} on path`, definition,
  }
  usePathsStore.getState().applyPathEdit({
    gesture: 'along',
    add: [made],
    updates: [{ id: text.id, d: text.d, hidden: true }],
    selectAfter: [made.id],
  })
  return made
}

// ─── Corners ───────────────────────────────────────────────────────────────────

export type CornerTreatments = Map<number, { type: CornerTreatmentType; radiusMM: number }>

/**
 * The outline a path's corners are cut from, and the treatments already on it. The recipe
 * lives on the path (`ImportedPath.corners`) and is RESUMED when it still reproduces the
 * path — directly, or through a move, rotate, mirror or uniform scale, which carries the
 * outline by the same transform and scales the radii with it. Anything else changed the
 * corners themselves, and the path's own outline starts fresh.
 */
export function cornerSession(path: ImportedPath): { baseD: string; treatments: CornerTreatments; resumed: boolean } {
  const saved = path.corners
  if (saved) {
    const replay = applyCornerTreatments(saved.baseD, new Map(saved.treatments))
    if (replay === path.d) return { baseD: saved.baseD, treatments: new Map(saved.treatments), resumed: true }
    const sim = pathSimilarityTransform(replay, path.d)
    if (sim) {
      return {
        baseD: transformPathBySimilarity(saved.baseD, sim),
        treatments: new Map(saved.treatments.map(([i, p]) => [i, { ...p, radiusMM: p.radiusMM * sim.scale }])),
        resumed: true,
      }
    }
  }
  return { baseD: path.d, treatments: new Map(), resumed: false }
}

/** The corners of `baseD` a treatment can go on, by index. */
export const treatableCorners = (baseD: string) => getTreatableCorners(baseD)

/**
 * Treat `targets` (every treatable corner when empty) with `choice` — 'none' restores them
 * sharp — on top of the treatments already there, and write the path with its whole
 * recipe: the outline it was cut from and every corner's treatment, so a later edit
 * re-cuts the ORIGINAL corner rather than rounding a round one. Returns the new treatments.
 */
export function applyCorners(
  path: ImportedPath, session: { baseD: string; treatments: CornerTreatments },
  targets: number[], choice: CornerTreatmentType | 'none', radiusMM: number,
): CornerTreatments {
  const treatments: CornerTreatments = new Map(session.treatments)
  const idxs = targets.length > 0 ? targets : getTreatableCorners(session.baseD).map((c) => c.idx)
  for (const idx of idxs) {
    if (choice === 'none') treatments.delete(idx)
    else treatments.set(idx, { type: choice, radiusMM })
  }
  const newD = applyCornerTreatments(session.baseD, treatments)
  if (newD !== path.d) {
    const corner = [...treatments].map(([idx, p]) => ({ idx, ...p }))
    usePathsStore.getState().batchUpdatePaths([{ id: path.id, d: newD, shapeParams: null, corner, cornerBaseD: session.baseD }], 'corner')
  }
  return treatments
}

// ─── Trace ─────────────────────────────────────────────────────────────────────

export { DEFAULT_TRACE }

/** The paths one trace result becomes: a layer per tone, one group, one definition. */
export function tracePaths(source: ImportedPath, r: TraceResult, params: TraceParams, defId: string, groupId: string): ImportedPath[] {
  const multi = r.thresholds.length > 1
  const centerline = params.mode === 'centerline'
  const colors = traceColors(r.levels, r.thresholds.length)
  return r.ds.map((d, i) => ({
    id: uid('path-trace'), name: `${source.name} ${multi ? `tone ${r.levels[i]}` : centerline ? 'line' : 'trace'} ${i + 1}`, d, visible: true, color: colors[i],
    groupId, groupName: `${source.name} trace`,
    // Each tone level is a LAYER, so Select Only → Layers picks one out to pocket or
    // inlay on its own, and the canvas colours them apart.
    ...(multi ? { layer: `Tone ${r.levels[i]}` } : {}),
    definition: { id: defId, kind: 'trace', sourceId: source.id, params },
  }))
}

/** Trace an imported picture into new paths (on a worker); the picture is hidden under them. */
export async function createTrace(source: ImportedPath, params: TraceParams, job: string): Promise<ToolResult> {
  if (!source.imageSrc) return { error: `${source.name} is not an imported picture` }
  const rect = extractRectInfo(source.d)
  if (!rect) return { error: 'This image is no longer a rectangle — undo the edit that reshaped it, or re-import the image' }
  const image = await loadImageLuminance(source.imageSrc)
  const r = await runInWorkerFor(job, 'traceImage', image, rect, params)
  if (r.ds.length === 0) return { error: 'Nothing to trace at this threshold — move it, or switch Dark/Light' }
  const newPaths = tracePaths(source, r, params, uid('def'), uid('grp-trace'))
  const store = usePathsStore.getState()
  store.addPaths(newPaths, { source: 'trace' })
  // The picture sits under its own trace and hides it; Show Image brings it back.
  store.setPathsVisible([source.id], false)
  store.setSelectedIds(newPaths.map((p) => p.id))
  return { paths: newPaths }
}
