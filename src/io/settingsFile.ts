// The settings file (`.fkset`): everything the browser keeps for this user — machine,
// tools, post-processors, last-used form values, Machine tab, interface — in one JSON file, to
// carry to another browser, share a post-processor, or send along with a bug report.
//
// It is NOT a project. A `.fkam` carries the machine half too, but a project load
// deliberately installs only the document (io/CLAUDE.md: a file a friend sent must not
// make their machine yours), so "save an empty project" could never move settings.
// Here every section is the user's choice on import: tools and post-processors MERGE
// (settingsMerge.ts — nothing of theirs is overwritten), the rest REPLACE and start
// unticked. The pure half lives in settingsMerge.ts.

import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolStore, DEFAULT_TOOLS, type Tool } from '../store/toolStore'
import { usePostProcessorStore, BUILTIN_PROFILES, type PostProcessorProfile } from '../store/postProcessorStore'
import { useToolpathStore } from '../store/toolpathStore'
import { toolIdsOf } from './toolMerge'
import { useFormDefaultsStore } from '../store/formDefaultsStore'
import { useMachineStore } from '../machine/machineStore'
import { useUIStore } from '../store/uiStore'
import { BUILD_DATE } from '../version'
import { uid } from '../uid'
import { downloadText } from './download'
import { sanitizeFileName } from './filename'
import {
  SETTINGS_FORMAT, SETTINGS_VERSION, mergeByName, parseSettings, pickKnown,
  type MergeResult, type SectionKey, type SettingsFile,
} from './settingsMerge'

export const SETTINGS_EXT = '.fkset'

const MACHINE_KEYS = [
  'tableLimitWidthMM', 'tableLimitHeightMM', 'tableLimitDepthMM',
  'machineRigidity', 'maxFeedMmMin', 'minSpindleRpm', 'maxSpindleRpm', 'spindleType', 'autoFeedEnabled',
  'accelXYMmS2', 'accelZMmS2', 'maxRateZMmMin', 'junctionDeviationMM',
] as const
const STOCK_KEYS = ['widthMM', 'heightMM', 'thicknessMM', 'units', 'origin', 'zOrigin', 'material', 'safeHeightMM'] as const
const MACHINE_TAB_KEYS = ['address', 'jogStepIndex', 'jogStepIndexZ', 'jogFeedXY', 'jogFeedZ', 'hasHoming'] as const
// What uiStore persists (its partialize), and nothing it does not.
const INTERFACE_KEYS = ['penCurveType', 'lastShapeType', 'timelineOpen', 'pathsView', 'darkMode', 'shapeFromCenter'] as const

const pick = (state: object, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, (state as Record<string, unknown>)[k]]))

function fileOf(sections: SettingsFile['sections']): string {
  const file: SettingsFile = { format: SETTINGS_FORMAT, version: SETTINGS_VERSION, savedAt: new Date().toISOString(), build: BUILD_DATE, sections }
  return JSON.stringify(file, null, 2)
}

/** Everything, as the browser has it now. */
export function buildSettings(): string {
  const { profiles, activeId } = usePostProcessorStore.getState()
  return fileOf({
    tools: useToolStore.getState().tools,
    postProcessors: { profiles, activeId },
    machine: pick(useWorkpieceStore.getState(), MACHINE_KEYS),
    stock: pick(useWorkpieceStore.getState(), STOCK_KEYS),
    formDefaults: useFormDefaultsStore.getState().defaults,
    machineTab: pick(useMachineStore.getState(), MACHINE_TAB_KEYS),
    interface: pick(useUIStore.getState(), INTERFACE_KEYS),
  })
}

export function exportSettings() {
  const day = new Date().toISOString().slice(0, 10)
  downloadText(buildSettings(), `freazykam-settings-${day}${SETTINGS_EXT}`, 'application/json')
  useUIStore.getState().showStatus('Settings exported — the file is in your downloads.', 'info')
}

/** One post-processor alone, for sharing: a settings file with just that section. */
export function exportPostProcessor(profile: PostProcessorProfile) {
  downloadText(fileOf({ postProcessors: { profiles: [profile] } }), `${sanitizeFileName(profile.name, 'post-processor')}${SETTINGS_EXT}`, 'application/json')
  useUIStore.getState().showStatus(`Exported "${profile.name}" — the file is in your downloads.`, 'info')
}

/** The whole tool library alone, as a tool set to share: a settings file with just that section. */
export function exportTools() {
  const tools = useToolStore.getState().tools
  const day = new Date().toISOString().slice(0, 10)
  downloadText(fileOf({ tools }), `freazykam-tools-${day}${SETTINGS_EXT}`, 'application/json')
  useUIStore.getState().showStatus(`Exported ${tools.length} tool${tools.length === 1 ? '' : 's'} — the file is in your downloads.`, 'info')
}

/**
 * Pick a file for ONE section's own tab — the tool library's or the post-processors'.
 * Null (after saying why) when it has none of that section; a file with other sections
 * in it gives only this one up from there, the rest being Setup's business.
 */
export async function pickSectionFile(key: 'tools' | 'postProcessors'): Promise<SettingsFile | null> {
  const file = await pickSettingsFile()
  if (!file) return null
  if (!file.sections[key]) {
    useUIStore.getState().showStatus(`That settings file has no ${key === 'tools' ? 'tools' : 'post-processors'} in it — import it from Setup to bring in the rest.`, 'warn')
    return null
  }
  return file
}

/** Ask for a `.fkset` and parse it. Resolves null (after saying why) when there is nothing usable. */
export function pickSettingsFile(): Promise<SettingsFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `${SETTINGS_EXT},.json`
    input.oncancel = () => resolve(null)
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) { resolve(null); return }
      try {
        resolve(parseSettings(await file.text()))
      } catch (e) {
        useUIStore.getState().showStatus(`Could not import ${file.name} — ${(e as Error).message}.`, 'error')
        resolve(null)
      }
    }
    input.click()
  })
}

// A tool or profile from a file is only installed whole: every field the app's own has,
// of the same type, else it is left out — a half-read post-processor would write half a
// program. `optional` fields are taken when present and valid, never required.
function wholeLike<T extends object>(template: T, v: unknown, optional: string[] = []): T | null {
  const known = pickKnown(template as Record<string, unknown>, v)
  for (const k of Object.keys(template)) if (!optional.includes(k) && !(k in known)) return null
  return known as T
}

const TOOL_TEMPLATE: Tool = { id: '', name: '', type: 'endmill', diameterMM: 0, fluteCount: 0, rpm: 0, xyFeedMmMin: 0, zFeedMmMin: 0, maxDepthMM: 0 }
// What makes two tools the same tool: exactly what the import brings in, and no more.
const TOOL_KEYS = [...Object.keys(TOOL_TEMPLATE), 'vbitAngleDeg']

function toolsIn(v: unknown): Tool[] {
  if (!Array.isArray(v)) return []
  const out: Tool[] = []
  for (const raw of v) {
    const t = wholeLike(TOOL_TEMPLATE, raw)
    if (!t) continue
    const angle = (raw as { vbitAngleDeg?: unknown }).vbitAngleDeg
    out.push(typeof angle === 'number' && Number.isFinite(angle) ? { ...t, vbitAngleDeg: angle } : t)
  }
  return out
}

const ppKeys = () => Object.keys(usePostProcessorStore.getState().profiles[0] ?? {})

function profilesIn(v: unknown): PostProcessorProfile[] {
  const list = (v as { profiles?: unknown })?.profiles
  const template = usePostProcessorStore.getState().profiles[0]
  if (!Array.isArray(list) || !template) return []
  return list.map((p) => wholeLike(template, p, ['builtin'])).filter((p): p is PostProcessorProfile => !!p)
}

/**
 * What importing a merge section WOULD do, worked out against the library as it is and
 * changing nothing — the same merge `applySettings` then runs, so the preview and the
 * import cannot disagree.
 */
export function planMerge(file: SettingsFile, key: 'tools' | 'postProcessors'): MergeResult<{ id: string; name: string }> {
  return key === 'tools'
    ? mergeByName(useToolStore.getState().tools, toolsIn(file.sections.tools), () => uid('tool'), TOOL_KEYS)
    : mergeByName(usePostProcessorStore.getState().profiles, profilesIn(file.sections.postProcessors), () => uid('pp'), ppKeys())
}

/** One line for a merge plan: "2 new, 1 as a copy, 10 already in yours". */
export function planSummary(r: { added: string[]; copied: string[]; same: number }): string {
  return [
    r.added.length && `${r.added.length} new`,
    r.copied.length && `${r.copied.length} as a copy`,
    r.same && `${r.same} already in yours`,
  ].filter(Boolean).join(', ') || 'nothing in it'
}

/** What each section of `file` holds, as the import dialog lists it. */
export function describeSection(file: SettingsFile, key: SectionKey): string {
  if (key !== 'tools' && key !== 'postProcessors') return ''
  const r = planMerge(file, key)
  const adds = r.added.length + r.copied.length
  // Always both counts, the to-add one even at 0: "13 already in yours · 0 to add" is
  // the answer to "will this give me two of everything?", which is the question asked.
  return [
    r.same && `${r.same} already in yours`,
    `${adds} to add${r.copied.length ? ` (${r.copied.length} as a copy)` : ''}`,
  ].filter(Boolean).join(' · ')
}

/** What REPLACING a library from this file would do, for the import dialog's row. */
export function describeReplace(file: SettingsFile, key: 'tools' | 'postProcessors'): string {
  if (key === 'tools') {
    const p = planToolReplace(toolsIn(file.sections.tools))
    return `yours (${useToolStore.getState().tools.length}) swapped for the file's ${p.incoming}${p.kept.length ? ` · ${p.kept.length} the project uses kept` : ''}`
  }
  const p = planProfileReplace(file)
  return `yours (${usePostProcessorStore.getState().profiles.length}) swapped for the file's ${p.incoming}`
}

/** Whether importing this merge section would add anything at all. */
export function sectionAddsAnything(file: SettingsFile, key: 'tools' | 'postProcessors'): boolean {
  const r = planMerge(file, key)
  return r.added.length + r.copied.length > 0
}

// ─── Replace and restore ──────────────────────────────────────────────────────
// Both swap a whole list for another, so both are planned first, shown in a confirm
// that says exactly what changes, and only then applied — the plan IS what is applied.

export type MergeMode = 'merge' | 'replace'

/** Tool ids the open project's operations cut with. */
function toolIdsInUse(): Set<string> {
  return new Set(useToolpathStore.getState().operations.flatMap(toolIdsOf))
}

const sameTool = (a: Tool, b: Tool) => TOOL_KEYS.every((k) => (a as unknown as Record<string, unknown>)[k] === (b as unknown as Record<string, unknown>)[k]) && a.name === b.name

export interface ToolReplacePlan {
  list: Tool[]
  incoming: number    // tools the new list brings
  added: string[]     // tools of the new list the user does not already have exactly
  kept: string[]      // the user's tools kept because the open project cuts with them
  removed: string[]   // the user's tools that go
}

/**
 * The library as it would be with `target` in place of it. A tool the open project
 * cuts with is KEPT, under its own id — each operation names its tool by id, and a
 * library replaced from under it would leave every one of them with a missing tool. A
 * target tool that happens to share a kept tool's id moves to a fresh one.
 */
export function planToolReplace(target: Tool[]): ToolReplacePlan {
  const inUse = toolIdsInUse()
  const mine = useToolStore.getState().tools
  const kept = mine.filter((t) => inUse.has(t.id) && !target.some((x) => x.id === t.id && sameTool(x, t)))
  const keptIds = new Set(kept.map((t) => t.id))
  const list = [...target.map((t) => (keptIds.has(t.id) ? { ...t, id: uid('tool') } : { ...t })), ...kept]
  // Gone = not kept, and not in the new list exactly. By content, not id: a re-sized
  // `default-1` is replaced by the factory `default-1`, and that is a tool lost.
  return {
    list, incoming: target.length, kept: kept.map((t) => t.name),
    added: target.filter((x) => !mine.some((t) => sameTool(x, t))).map((t) => t.name),
    removed: mine.filter((t) => !keptIds.has(t.id) && !target.some((x) => sameTool(x, t))).map((t) => t.name),
  }
}

export const planRestoreTools = () => planToolReplace(DEFAULT_TOOLS)

export function applyToolReplace(plan: ToolReplacePlan) {
  const { selectedToolId } = useToolStore.getState()
  useToolStore.setState({ tools: plan.list, selectedToolId: plan.list.some((t) => t.id === selectedToolId) ? selectedToolId : null })
}

export interface ProfileReplacePlan {
  list: PostProcessorProfile[]
  activeId: string
  incoming: number
  removed: string[]
}

/** The post-processor list as it would be with the file's in place of it. */
export function planProfileReplace(file: SettingsFile): ProfileReplacePlan {
  const target = profilesIn(file.sections.postProcessors).map((p) => ({ ...p }))
  const mine = usePostProcessorStore.getState()
  const fileActive = (file.sections.postProcessors as { activeId?: unknown } | undefined)?.activeId
  const activeId = target.find((p) => p.id === fileActive)?.id ?? target.find((p) => p.id === mine.activeId)?.id ?? target[0]?.id ?? mine.activeId
  return { list: target, activeId, incoming: target.length, removed: mine.profiles.filter((p) => !target.some((t) => t.id === p.id)).map((p) => p.name) }
}

export interface BuiltinRestorePlan {
  list: PostProcessorProfile[]
  reset: string[]      // built-ins the user edited, put back to factory
  returned: string[]   // built-ins the user deleted, brought back
  keptOwn: string[]    // the user's own profiles, untouched
}

/**
 * Every built-in back to factory and every deleted one back; the user's own profiles
 * stay, after the built-ins. Nothing else is touched.
 */
export function planRestoreBuiltins(): BuiltinRestorePlan {
  const mine = usePostProcessorStore.getState().profiles
  const builtinIds = new Set(BUILTIN_PROFILES.map((b) => b.id))
  const own = mine.filter((p) => !builtinIds.has(p.id))
  const reset: string[] = [], returned: string[] = []
  for (const b of BUILTIN_PROFILES) {
    const had = mine.find((p) => p.id === b.id)
    if (!had) returned.push(b.name)
    else if (contentOf(had) !== contentOf(b) || had.name !== b.name) reset.push(had.name === b.name ? b.name : `${had.name} → ${b.name}`)
  }
  return { list: [...BUILTIN_PROFILES.map((b) => ({ ...b })), ...own], reset, returned, keptOwn: own.map((p) => p.name) }
}

const contentOf = (p: PostProcessorProfile) => JSON.stringify(ppKeys().filter((k) => k !== 'id' && k !== 'name' && k !== 'builtin').map((k) => (p as unknown as Record<string, unknown>)[k] ?? null))

export function applyRestoreBuiltins(plan: BuiltinRestorePlan) {
  const { activeId } = usePostProcessorStore.getState()
  usePostProcessorStore.setState({
    profiles: plan.list,
    activeId: plan.list.some((p) => p.id === activeId) ? activeId : plan.list[0].id,
    seededBuiltinIds: [...new Set([...usePostProcessorStore.getState().seededBuiltinIds, ...BUILTIN_PROFILES.map((b) => b.id)])],
  })
}

// How the machine settings read in a confirm: name and unit, so "Max feed 4321 → 3000
// mm/min" says what will change. Shown in mm, as stored.
const MACHINE_LABELS: Record<typeof MACHINE_KEYS[number], [string, string]> = {
  tableLimitWidthMM: ['Table width', 'mm'], tableLimitHeightMM: ['Table depth', 'mm'], tableLimitDepthMM: ['Z travel', 'mm'],
  machineRigidity: ['Rigidity', ''], maxFeedMmMin: ['Max feed', 'mm/min'], minSpindleRpm: ['Min spindle', 'rpm'],
  maxSpindleRpm: ['Max spindle', 'rpm'], spindleType: ['Spindle type', ''], autoFeedEnabled: ['Auto feeds', ''],
  accelXYMmS2: ['Accel X/Y', 'mm/s²'], accelZMmS2: ['Accel Z', 'mm/s²'], maxRateZMmMin: ['Z max rate', 'mm/min'],
  junctionDeviationMM: ['Junction deviation', 'mm'],
}

/** Each machine setting that differs from the factory value, as "Name: now → default". */
export function planRestoreMachine(): string[] {
  const now = useWorkpieceStore.getState() as unknown as Record<string, unknown>
  const factory = useWorkpieceStore.getInitialState() as unknown as Record<string, unknown>
  const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v))
  return MACHINE_KEYS.filter((k) => now[k] !== factory[k]).map((k) => {
    const [label, unit] = MACHINE_LABELS[k]
    return `${label}: ${show(now[k])} → ${show(factory[k])}${unit ? ` ${unit}` : ''}`
  })
}

export function applyRestoreMachine() {
  useWorkpieceStore.setState(pick(useWorkpieceStore.getInitialState(), MACHINE_KEYS))
}

/** Install the chosen sections. Returns one line per section saying what happened. */
export function applySettings(file: SettingsFile, keys: SectionKey[], modes: Partial<Record<'tools' | 'postProcessors', MergeMode>> = {}): string[] {
  const out: string[] = []
  const s = file.sections
  const merged = (what: string, r: { added: string[]; copied: string[]; same: number }) => {
    const bits = [
      r.added.length && `${r.added.length} added`,
      r.copied.length && `${r.copied.length} brought in as a copy (${r.copied.join(', ')})`,
      r.same && `${r.same} already here`,
    ].filter(Boolean)
    out.push(`${what}: ${bits.join(', ') || 'nothing to add'}`)
  }
  for (const key of keys) {
    if (s[key] === undefined) continue
    switch (key) {
      case 'tools': {
        if (modes.tools === 'replace') {
          const plan = planToolReplace(toolsIn(s.tools))
          if (!plan.incoming) break
          applyToolReplace(plan)
          out.push(`Tools: replaced with the file's ${plan.incoming}${plan.kept.length ? `, ${plan.kept.length} this project uses kept` : ''}`)
          break
        }
        const r = planMerge(file, 'tools')
        useToolStore.setState({ tools: r.list as Tool[] })
        merged('Tools', r)
        break
      }
      case 'postProcessors': {
        if (modes.postProcessors === 'replace') {
          const plan = planProfileReplace(file)
          if (!plan.incoming) break
          usePostProcessorStore.setState({ profiles: plan.list, activeId: plan.activeId })
          out.push(`Post-processors: replaced with the file's ${plan.incoming}`)
          break
        }
        const r = planMerge(file, 'postProcessors')
        // Show the first one that came in, so a shared profile is on screen at once.
        const first = r.list.find((p) => p.name === (r.added[0] ?? r.copied[0]))
        usePostProcessorStore.setState({ profiles: r.list as PostProcessorProfile[], ...(first ? { activeId: first.id } : {}) })
        merged('Post-processors', r)
        break
      }
      case 'machine':
        useWorkpieceStore.setState(pickKnown(pick(useWorkpieceStore.getState(), MACHINE_KEYS), s.machine))
        out.push('Machine settings replaced')
        break
      case 'stock': {
        // Through the setters, which record the change: the stock is part of the open
        // document, so this import must be one the user can undo.
        const ws = useWorkpieceStore.getState()
        const v = pickKnown(pick(ws, STOCK_KEYS), s.stock) as Partial<Record<typeof STOCK_KEYS[number], never>>
        if (v.widthMM !== undefined) ws.setWidth(v.widthMM)
        if (v.heightMM !== undefined) ws.setHeight(v.heightMM)
        if (v.thicknessMM !== undefined) ws.setThickness(v.thicknessMM)
        if (v.units !== undefined) ws.setUnits(v.units)
        if (v.origin !== undefined) ws.setOrigin(v.origin)
        if (v.zOrigin !== undefined) ws.setZOrigin(v.zOrigin)
        if (v.material !== undefined) ws.setMaterial(v.material)
        if (v.safeHeightMM !== undefined) ws.setSafeHeight(v.safeHeightMM)
        out.push('Stock defaults replaced')
        break
      }
      case 'formDefaults': {
        const d = s.formDefaults
        if (d && typeof d === 'object' && !Array.isArray(d)) {
          useFormDefaultsStore.setState({ defaults: d as Record<string, Record<string, unknown>> })
          out.push('Last-used form values replaced')
        }
        break
      }
      case 'machineTab':
        // Never mid-connection: the address of a live link is not this file's to change.
        useMachineStore.setState(pickKnown(pick(useMachineStore.getState(), MACHINE_TAB_KEYS.filter((k) => k !== 'address' || useMachineStore.getState().link === 'disconnected')), s.machineTab))
        out.push('Machine tab settings replaced')
        break
      case 'interface':
        useUIStore.setState(pickKnown(pick(useUIStore.getState(), INTERFACE_KEYS), s.interface))
        out.push('Interface settings replaced')
        break
    }
  }
  return out
}
