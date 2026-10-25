// Shared widgets used by the operation forms (extracted from MachinePanel — tofix.md R1).
// ─── Shared sub-components ───────────────────────────────────────────────────
import { createContext, useContext, useEffect, useMemo, useState, useId } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { NUMERIC_HINT } from '../../components/parseNumeric'
import { ICON } from '../../theme'
import { AlertCircle, AlertTriangle, Loader2, RotateCcw, Square } from 'lucide-react'
import { abortGeneration } from '../../workers/abortGeneration'
import { useUIStore } from '../../store/uiStore'
import type { Tool } from '../../store/toolStore'
import { ToolPicker } from './ToolPicker'
import { useWorkpieceStore, fromMM, toMM, fmtLen, lenValue, inchStepFor } from '../../store/workpieceStore'
import { useGenProgressStore } from '../../store/genProgressStore'
import { useToolpathStore } from '../../store/toolpathStore'
import { effectiveStepDownMM } from '../../cam/feeds'
import { resolveStartZ, listFlatFloorOps, type StartFrom, type StartZ } from '../../cam/startHeight'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { runBatchGenerate, type BatchGenerateArgs } from './batchGenerate'
import { useExcludedPaths, togglePathInSelection, watchSelectionForExclusions, placeExcluded, type ExcludedPath } from './pathExclusion'

// Tracks operations created by this form instance, keyed by target (path/group id), so a
// repeat Generate on the same target updates the existing operation instead of adding a
// duplicate. The map survives selection changes but not closing the form; entries whose
// operation has since been deleted (or undone away) are treated as absent.
export function useSessionOps() {
  const operations = useToolpathStore((s) => s.operations)
  const [byKey, setByKey] = useState<Record<string, string>>({})
  const isLive = (id: string | undefined): id is string =>
    !!id && operations.some((o) => o.id === id)
  return {
    liveOpId: (key: string): string | undefined => {
      const id = byKey[key]
      return isLive(id) ? id : undefined
    },
    remember: (key: string, opId: string) => setByKey((m) => ({ ...m, [key]: opId })),
    // Everything this form session created that still exists. A form needs the whole set,
    // not just the entry for one key, when the keys themselves can change under it — see
    // the Invert Pocket toggle in PocketForm, which re-reads the SAME selection into a
    // different set of boundaries.
    liveEntries: (): { key: string; opId: string }[] =>
      Object.entries(byKey).flatMap(([key, id]) => (isLive(id) ? [{ key, opId: id }] : [])),
    // Earliest live op of this session in PROGRAM order — the one to hand the start-height
    // resolver as "this operation", since it ignores that op and everything after it. A
    // form that has already generated is looking at ops it is about to overwrite; without
    // this they count as preceding cuts and a pocket reads its own floor as its start
    // height (a 5 mm pocket resolving to Z −5).
    firstLiveOpId: (): string | undefined => {
      const ids = new Set(Object.values(byKey))
      return operations.find((o) => ids.has(o.id))?.id
    },
    forget: (keys: string[]) => setByKey((m) => {
      const next = { ...m }
      for (const k of keys) delete next[k]
      return next
    }),
  }
}

export function FormShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useExcludedPathsScope()
  return (
    <div className="border border-gray-400 dark:border-neutral-600 rounded-lg mx-3 mt-3 mb-2 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-200 dark:bg-neutral-800 border-b border-gray-300 dark:border-neutral-600">
        <span className="text-body font-semibold text-gray-700 dark:text-neutral-300">{title}</span>
        <button onClick={onClose} className="text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 text-sm leading-none">✕</button>
      </div>
      <div className="p-3 space-y-2.5">{children}</div>
    </div>
  )
}

// `label` is only for a distinction the list can't otherwise show — "island" against a
// boundary. Plain membership needs no label: everything in the list is selected, so
// saying so on every row is noise.
// `state` marks a path the next Generate will ADD to the operation or take AWAY from it —
// see reviseBatch. A chip with no state is one that is simply there, which is every chip
// outside an edit whose selection has been changed.
export function PathChip({ path, label, state, index }: {
  path: ImportedPath
  label?: string
  /** `excluded`: clicked out of the selection in this list (see PathListSection), shown so
   *  it can be clicked back in. Struck through like `removed`, without its − sign, which
   *  means "the next Regenerate takes this out of the batch". */
  state?: 'added' | 'removed' | 'excluded'
  /** Position in CUT order, 1-based. Set on the top-level entries of a list of more than
   *  one, so the order the paths were picked in — which is the order they will be cut
   *  (see useSelectedPathsInOrder) — can be read off the form instead of the G-code. */
  index?: number
}) {
  const tone = state === 'added'
    ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/40'
    : state === 'removed' || state === 'excluded'
      ? 'text-gray-500 dark:text-neutral-500 bg-gray-100 dark:bg-neutral-800 line-through'
      : 'text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800'
  const toggle = usePathToggle(path.id)
  return (<>
    <div className={`text-body rounded px-2 py-1 flex items-center gap-1.5 ${tone} ${toggle.className}`}
      {...toggle.props}>
      {state && state !== 'excluded' && <span className="flex-shrink-0 no-underline">{state === 'added' ? '+' : '−'}</span>}
      {index !== undefined && (
        <span className="flex-shrink-0 tabular-nums text-gray-500 dark:text-neutral-400 no-underline">{index}.</span>
      )}
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: path.color }} />
      <span className="truncate">{path.name}</span>
      {label && <span className="text-gray-600 dark:text-neutral-400 flex-shrink-0">({label})</span>}
    </div>
    <ExcludedAfter id={path.id} />
  </>)
}

// What the pending revision will do, under the path list of a form that is EDITING a
// batch. With nothing pending it says how to make something pending instead: the
// mechanism is a shift-click on the canvas, which nothing else in the form would tell
// you about.
export function PathRevisionHint({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) {
    return (
      <p className="text-label text-gray-600 dark:text-neutral-400 normal-case mt-1">
        Shift-click on the canvas to add or remove paths, then Regenerate.
      </p>
    )
  }
  const bits = [
    added > 0 ? `${added} path${added > 1 ? 's' : ''} added` : '',
    removed > 0 ? `${removed} removed` : '',
  ].filter(Boolean).join(', ')
  return (
    <p className="text-label text-amber-600 dark:text-amber-400 normal-case mt-1">
      {bits} — Regenerate Toolpath to apply.
    </p>
  )
}

// ─── Click a path in the list to take it out of the selection, or put it back ────────
// The state and its rules are in `pathExclusion.ts`; what is here draws them.

const NO_EXCLUDED: ExcludedPath[] = []
const NO_IDS: string[] = []
const NO_PATHS: ImportedPath[] = []

/** Ids clicked out of the open form's path list — a form leaves them out of its own
 *  `removed` rows, since the list already draws each one where it was. */
export function useExcludedPathIds(): Set<string> {
  const entries = useExcludedPaths((s) => s.entries)
  return useMemo(() => new Set(entries.map((e) => e.id)), [entries])
}

// The row drawn above `el` in its list, read off the DOM at the click: only the rendered
// list knows the order the form chose to draw its rows in.
function rowAbove(el: HTMLElement): string | null {
  const rows = [...(el.closest('[data-path-list]')?.querySelectorAll<HTMLElement>('[data-path-id]') ?? [])]
  const i = rows.indexOf(el)
  return i > 0 ? rows[i - 1].dataset.pathId ?? null : null
}

function useExcludedPathsScope(): void {
  useEffect(() => watchSelectionForExclusions(), [])
}

// What a toggleable list hands its rows, worked out ONCE per list in PathListSection: null
// outside one, so a chip outside a PathListSection — the Tabs and point-edit forms'
// "selected" chip — stays inert, and so does a list showing an edited operation's SAVED
// sources. The rows read only this, never the stores: each row subscribing for itself was a
// `selectedIds.includes` per row per selection change — O(n²), with 890 rows on the
// Charizard sheet — and every chip on every form subscribing to every path edit.
interface PathListCtx {
  selected: Set<string>
  /** The excluded paths to draw straight after each row (null = above the first). */
  below: Map<string | null, ImportedPath[]>
}
const PathToggleContext = createContext<PathListCtx | null>(null)

/** Click handling for one row of a toggleable path list; inert outside one. */
export function usePathToggle(id: string): { className: string; props: React.HTMLAttributes<HTMLDivElement> & { 'data-path-id': string } } {
  const ctx = useContext(PathToggleContext)
  if (!ctx) return { className: '', props: { 'data-path-id': id } }
  return {
    className: 'cursor-pointer hover:ring-1 hover:ring-gray-400 dark:hover:ring-neutral-500',
    props: {
      'data-path-id': id,
      onClick: (e) => togglePathInSelection(id, rowAbove(e.currentTarget)),
      title: ctx.selected.has(id) ? 'Click to leave this path out' : 'Click to put this path back',
    },
  }
}

// The excluded paths that were drawn straight below `id` — rendered by the row for `id`
// itself, so they keep their place in the list. Each is a PathChip, so a run of them
// clicked out one after another chains down from the first.
export function ExcludedAfter({ id }: { id: string | null }) {
  const here = useContext(PathToggleContext)?.below.get(id)
  if (!here) return null
  return <>{here.map((p) => <PathChip key={p.id} path={p} state="excluded" />)}</>
}

// The path list every operation form ends with: same header, same divider, same placement
// under the Generate button, whatever the form. Forms differ only in the chips they put
// inside — a pocket labels its islands, a profile has nothing to add.
//
// The list SCROLLS IN PLACE past a capped height: a nest or a batch of a few hundred paths
// otherwise made the whole sidebar scroll, and reading down the list pushed the form's own
// controls — Generate included — off the top. The header stays put above the scroller.
//
// `toggle`: the list shows the SELECTION, so a click on a row takes that path out of it or
// puts it back (see togglePathInSelection), and a path clicked out stays in its row.
// `listed` names the UNSELECTED paths the form draws rows for itself — an edited batch's
// struck-through `removed` members — since an excluded path may sit below one of them.
export function PathListSection({ count, toggle = false, listed, children }: {
  count: number
  toggle?: boolean
  listed?: Iterable<string>
  children: React.ReactNode
}) {
  const entries = useExcludedPaths((s) => (toggle ? s.entries : NO_EXCLUDED))
  // Only a toggleable list reads the selection and the paths at all.
  const selectedIds = usePathsStore((s) => (toggle ? s.selectedIds : NO_IDS))
  const paths = usePathsStore((s) => (toggle && entries.length > 0 ? s.paths : NO_PATHS))
  // By content: a form hands a fresh `listed` array on every render.
  const listedKey = [...(listed ?? [])].join('\n')
  const { ctx, orphans } = useMemo(() => {
    if (!toggle) return { ctx: null, orphans: [] }
    const selected = new Set(selectedIds)
    const drawn = new Set(listedKey ? listedKey.split('\n') : [])
    const placed = placeExcluded(entries, paths, selected, drawn)
    const orphans = placed.get(undefined) ?? []
    placed.delete(undefined)
    return { ctx: { selected, below: placed as Map<string | null, ImportedPath[]> }, orphans }
  }, [toggle, selectedIds, entries, paths, listedKey])
  if (count === 0 && entries.length === 0) return null
  return (
    <div className="pt-1 border-t border-gray-300 dark:border-neutral-700">
      <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
        Paths{count > 1 && <span className="normal-case text-gray-500 dark:text-neutral-400"> ({count})</span>}
        {toggle && <span className="normal-case tracking-normal text-gray-500 dark:text-neutral-400"> · click to include/exclude</span>}
      </div>
      <PathToggleContext.Provider value={ctx}>
        <div data-path-list className="space-y-0.5 max-h-[30vh] overflow-y-auto overscroll-contain">
          {/* Excluded from the very top of the list: nothing is drawn above them. */}
          <ExcludedAfter id={null} />
          {children}
          {orphans.map((p) => <PathChip key={p.id} path={p} state="excluded" />)}
        </div>
      </PathToggleContext.Provider>
    </div>
  )
}


// Defined beside the forms' new-op defaults so the MCP bridge can use them too.
export { toolsOfType, pickToolId } from './opDefaults'

export function ToolSelector({ tools, value, onChange }: {
  tools: Tool[]
  value: string
  onChange: (id: string) => void
}) {
  const id = useId()
  return (
    <div>
      <label className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1" htmlFor={id}>Tool</label>
      <ToolPicker id={id} tools={tools} value={value} onChange={onChange} />
    </div>
  )
}

export function ToggleRow<T extends string>({ label, options, value, onChange, labels }: {
  label: string
  options: readonly T[]
  /** Null: nothing picked yet — no option is lit, and picking one is the action. */
  value: T | null
  onChange: (v: T) => void
  labels?: Partial<Record<T, string>>
}) {
  const groupId = useId()
  return (
    <div>
      <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1" id={groupId}>{label}</div>
      <div className="flex gap-1" role="group" aria-labelledby={groupId}>
        {options.map((o) => (
          <button key={o} onClick={() => onChange(o)}
            className={[
              'flex-1 py-1 text-body rounded border transition-colors capitalize',
              value === o
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-50 dark:bg-neutral-900 border-gray-400 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
            ].join(' ')}>
            {labels?.[o] ?? o}
          </button>
        ))}
      </div>
    </div>
  )
}



// The class every numeric field in every operation form wears. Exported so a form that
// lays its own field out still matches the ones built from LengthInput.
export const FIELD_CLS = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'

// A length field: held in mm, shown and typed in the user's chosen units.
//
// Bounds and step are given in MM and converted here, so no call site has to decide which
// space its limits live in — the hand-rolled conversions elsewhere in the app get that
// wrong (an inch-mode `min={0.1}` is a 2.54 mm floor, not 0.1 mm). Form state stays in mm
// throughout; only the display changes, so saved defaults and generated toolpaths are
// unaffected by the toggle.
export function LengthInput({ id, valueMM, onChangeMM, minMM, maxMM, stepMM = 0.5, className }: {
  /** Forwarded to the underlying input so a <label htmlFor> can point at it. */
  id?: string
  valueMM: number
  onChangeMM: (mm: number) => void
  minMM?: number
  maxMM?: number
  stepMM?: number
  className?: string
}) {
  const units = useWorkpieceStore((s) => s.units)
  return (
    <NumericInput
      id={id}
      value={fromMM(valueMM, units)}
      min={minMM === undefined ? undefined : fromMM(minMM, units)}
      max={maxMM === undefined ? undefined : fromMM(maxMM, units)}
      step={units === 'in' ? inchStepFor(stepMM) : stepMM}
      unit={units}
      onChange={(v) => onChangeMM(toMM(v, units))}
      className={className ?? FIELD_CLS}
      title={NUMERIC_HINT}
    />
  )
}

// Read-only display for an auto-calculated step-down (shown when auto feed is on).
export function AutoStepField({ label, valueMM }: { label: string; valueMM: number }) {
  const units = useWorkpieceStore((s) => s.units)
  return (
    <div>
      <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
        {label} <span className="text-blue-500 dark:text-blue-400 normal-case">(auto)</span>
      </div>
      <div className="flex items-center gap-1">
        <div className="flex-1 bg-gray-100 dark:bg-neutral-800 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-500 dark:text-neutral-400 min-w-0 font-mono">
          {lenValue(valueMM, units)}
        </div>
        <span className="flex-shrink-0 text-label text-gray-600 dark:text-neutral-400 select-none">{units}</span>
      </div>
    </div>
  )
}

// Resolves the surface an operation starts from, live, as the form is edited. Cheap —
// preceding flat-floor ops only, bbox-rejected before any polygon work (see startHeight.ts).
export function useStartZ(
  startFrom: StartFrom | undefined,
  footprintD: string,
  cutMarginMM: number,
  opId?: string,
): StartZ {
  const operations = useToolpathStore((s) => s.operations)
  const paths = usePathsStore((s) => s.paths)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  return useMemo(
    () => resolveStartZ({ startFrom, footprintD, cutMarginMM, opId }, operations, paths, { widthMM, heightMM }),
    [startFrom, footprintD, cutMarginMM, opId, operations, paths, widthMM, heightMM],
  )
}

// "Start" picker: a reference, not a raw number. Auto is the default and needs no input;
// the resolved height is always shown next to it so the value is visible and explained.
export function StartRow({ value, onChange, resolved, opId }: {
  value?: StartFrom
  onChange: (v: StartFrom) => void
  resolved: StartZ
  opId?: string
}) {
  const operations = useToolpathStore((s) => s.operations)
  const paths = usePathsStore((s) => s.paths)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const units = useWorkpieceStore((s) => s.units)
  const candidates = useMemo(
    () => listFlatFloorOps(operations, paths, { widthMM, heightMM }, opId),
    [operations, paths, widthMM, heightMM, opId],
  )

  const mode = value ?? { mode: 'auto' as const }
  const selected = mode.mode === 'op' ? `op:${mode.opId}` : mode.mode

  const startId = useId()
  return (
    <div>
      <label className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1" htmlFor={startId}>
        Start <span className={`normal-case ${resolved.zMM < 0 ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-neutral-400'}`}>
          Z {fmtLen(resolved.zMM, units)}
        </span>
      </label>
      <div className="flex items-center gap-1">
        <select
          id={startId}
          value={selected}
          onChange={(e) => {
            const v = e.target.value
            if (v.startsWith('op:')) onChange({ mode: 'op', opId: v.slice(3) })
            else if (v === 'manual') onChange({ mode: 'manual', zMM: resolved.zMM })
            else onChange({ mode: v as 'auto' | 'stock' })
          }}
          className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
        >
          <option value="auto">Auto (from earlier cuts)</option>
          <option value="stock">Stock top</option>
          {candidates.map((c) => (
            <option key={c.opId} value={`op:${c.opId}`}>Floor of {c.name} ({fmtLen(c.zMM, units)})</option>
          ))}
          <option value="manual">Custom…</option>
        </select>
        {mode.mode === 'manual' && (
          <>
            <LengthInput valueMM={mode.zMM} maxMM={0} stepMM={0.5}
              onChangeMM={(v) => onChange({ mode: 'manual', zMM: Math.min(0, v) })}
              className="w-20 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
          </>
        )}
      </div>
      {/* Where the number came from. On auto this is the debugging line: it says which
          operation's floor was picked, or why none was — "nothing cut here yet" (no
          overlapping earlier cut) vs "reaches uncut stock" (overlapping, but this cut
          extends past its edge). */}
      {mode.mode === 'auto' && (
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">{resolved.label}</p>
      )}
      {mode.mode === 'manual' && mode.zMM < 0 && (
        <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
          <AlertCircle size={10} className="shrink-0" />
          Nothing checks this — over uncut stock the first pass cuts full depth.
        </p>
      )}
    </div>
  )
}

/**
 * A step-down field that knows about Auto Feeds. Off: a plain field holding the user's value.
 * On: shows the auto-calculated value, EDITABLE — typing over it pins the typed value for
 * this operation (`BaseOperation.stepDownManual`), the label turns "(manual)" and an Auto
 * button puts it back. No trip to Setup to turn Auto Feeds off for every operation just to
 * change one. Without `onManual` it stays the read-only auto field it used to be.
 */
export function StepDownField({ label = 'Step Down', stepDownMM, onStep, autoMM, manual = false, onManual, minMM = 0.01, maxMM }: {
  label?: string
  stepDownMM: number
  onStep: (v: number) => void
  /** The auto-calculated step-down, or null when Auto Feeds is off (or there is no tool). */
  autoMM: number | null
  manual?: boolean
  onManual?: (manual: boolean) => void
  minMM?: number
  maxMM?: number
}) {
  const units = useWorkpieceStore((s) => s.units)
  const id = useId()
  if (autoMM != null && onManual) {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider" htmlFor={id}>
            {label}{' '}
            {manual
              ? <span className="text-amber-600 dark:text-amber-500 normal-case">(manual)</span>
              : <span className="text-blue-500 dark:text-blue-400 normal-case">(auto)</span>}
          </label>
          {manual && (
            <button type="button" onClick={() => onManual(false)}
              title={`Back to the auto-calculated step down (${fmtLen(autoMM, units)})`}
              className="flex items-center gap-0.5 text-label text-blue-600 dark:text-blue-400 hover:underline">
              <RotateCcw size={10} /> Auto
            </button>
          )}
        </div>
        <LengthInput id={id} valueMM={manual ? stepDownMM : autoMM} minMM={minMM} maxMM={maxMM} stepMM={0.5}
          onChangeMM={(v) => { onStep(v); if (!manual) onManual(true) }} />
        {manual && (
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">Auto would use {fmtLen(autoMM, units)}</p>
        )}
      </div>
    )
  }
  if (autoMM != null) return <AutoStepField label={label} valueMM={autoMM} />
  return (
    <div>
      <label className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1" htmlFor={id}>{label}</label>
      <LengthInput id={id} valueMM={stepDownMM} minMM={minMM} maxMM={maxMM} stepMM={0.5} onChangeMM={onStep} />
    </div>
  )
}

export function DepthRow({ depthMM, stepDownMM, onDepth, onStep, stepManual = false, onStepManual, maxDepthMM, tool, engagementFraction, startZMM = 0 }: {
  depthMM: number; stepDownMM: number
  onDepth: (v: number) => void; onStep: (v: number) => void
  // With Auto Feeds on, typing over the auto step-down pins the typed value for this
  // operation (`BaseOperation.stepDownManual`) and Auto puts it back — no trip to Setup
  // to turn Auto Feeds off for every operation just to change one. A form that does not
  // pass `onStepManual` keeps the read-only auto field.
  stepManual?: boolean
  onStepManual?: (manual: boolean) => void
  maxDepthMM?: number
  tool?: Tool
  // Radial engagement (WOC / D); low values (trochoidal) let the auto step-down go deeper.
  // Omit for full-slot ops so the displayed value matches the generated one.
  engagementFraction?: number
  // Surface the cut starts from. Depth is measured from there, so both warnings below
  // have to test the TOTAL reach from stock top, not the depth field alone.
  startZMM?: number
}) {
  // When auto feed is on the step-down is computed and shown read-only. The parent
  // form subscribes to the whole workpiece store, so this recomputes live as the
  // user changes rigidity / material / max feed.
  const autoFeedEnabled = useWorkpieceStore((s) => s.autoFeedEnabled)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const units = useWorkpieceStore((s) => s.units)
  const autoStepDownMM = autoFeedEnabled && tool ? effectiveStepDownMM(tool, stepDownMM, depthMM, engagementFraction) : null
  // Reach from the stock top: an op starting 2 mm down needs 2 mm more tool than its
  // depth field says, and gets 2 mm closer to the spoilboard.
  const totalDepthMM = Math.abs(Math.min(0, startZMM)) + depthMM
  const depthExceeds = maxDepthMM != null && totalDepthMM > maxDepthMM
  // Guard against plunging past the bottom of the stock into the spoilboard.
  const pastStockMM = thicknessMM > 0 ? totalDepthMM - thicknessMM : 0
  const cutsPastStock = pastStockMM > 0.001
  const depthId = useId()
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1" htmlFor={depthId}>Depth</label>
        <LengthInput id={depthId} valueMM={depthMM} minMM={0.01} stepMM={0.5} onChangeMM={onDepth} />
        {depthExceeds && (
          <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Exceeds tool Max Z ({fmtLen(maxDepthMM, units)})
          </p>
        )}
        {cutsPastStock && (
          <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            {fmtLen(pastStockMM, units)} past stock bottom ({fmtLen(thicknessMM, units)})
          </p>
        )}
      </div>
      <StepDownField stepDownMM={stepDownMM} onStep={onStep} autoMM={autoStepDownMM}
        manual={stepManual} onManual={onStepManual} />
    </div>
  )
}

/**
 * Why a Generate failed, in the form that asked for it.
 *
 * Every failure also reaches the status bar (see `toolpathStore.setError`), but that
 * message is transient and sits at the far end of the window from the button that was
 * just clicked. Four of the fourteen forms had a banner of their own and the rest had
 * nothing, so whether a failure was explained depended on which form you were in. One
 * definition, rendered by every form, directly above its Generate button.
 */
/**
 * A form's non-fatal banner: the Generate worked, but not the way the user asked for it.
 *
 * Amber and a triangle, so it cannot be mistaken for FormError below it — nothing failed
 * and nothing needs fixing, but a strategy the user chose on purpose was not the one that
 * ran, and silently machining something else is how a surprise ends up on the spindle.
 * Also published to the status bar, which is where an AUTOMATIC regeneration reports (no
 * form is open then, because nobody clicked anything) — but that is one truncating
 * transient line, so a user watching the panel they just clicked in would miss it.
 */
export function FormNotice({ msg }: { msg: string | null }) {
  if (!msg) return null
  return (
    <p className="text-body text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
      <AlertTriangle size={ICON.sm} className="mt-0.5 shrink-0" />{msg}
    </p>
  )
}

export function FormError({ msg }: { msg: string | null }) {
  if (!msg) return null
  return (
    <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5">
      <AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{msg}
    </p>
  )
}

export { discardFailedOps } from './batchGenerate'

/**
 * `[message, report, clear]` for a form's Generate.
 *
 * `report` marks the operation failed — which publishes the status-bar message and
 * clears its segments — and hands back the text for the banner, so the two can never
 * disagree about what went wrong. Call `clear()` at the top of a Generate.
 */
export function useGenerateError(): [string | null, (opId: string, err: unknown) => string, () => void] {
  const [msg, setMsg] = useState<string | null>(null)
  const report = (opId: string, err: unknown) => {
    const text = err instanceof Error ? err.message : 'Generation failed'
    useToolpathStore.getState().setError(opId, text)
    setMsg(text)
    return text
  }
  return [msg, report, () => setMsg(null)]
}

// `onClick` receives the mouse event so a form can read modifiers — PocketForm uses
// alt-click to force a strategy the shape would otherwise decline. Handlers that take no
// argument stay assignable, so the other forms are unaffected.
/**
 * The form's Generate button, which IS its progress bar while it runs — and, beside it, a
 * STOP. A long generation (a 3D profile, an adaptive pocket, a few hundred labels) was
 * stoppable only by undoing or opening another project, which nobody would look for.
 *
 * Stop is `abortGeneration`, the same abort undo uses: the workers are terminated (the
 * only real stop — a solve never yields), operations that finished keep their
 * toolpaths, and the one cut short is left NEEDS-UPDATE rather than failed — the user
 * stopped it, nothing went wrong — and the form still remembers it, so Generate picks it
 * back up. Every generate loop already treats the cancel as a stop, not a failure.
 */
export function GenerateBtn({ disabled, generating, onClick, label = 'Generate Toolpath', title }: { disabled: boolean; generating: boolean; onClick: (e: React.MouseEvent) => void; label?: string; title?: string }) {
  // Progress is only published once a generation has been running long enough to be worth
  // showing (see genProgressStore); short ones keep the plain spinner.
  const pct = useGenProgressStore((s) => s.overall)
  const stage = useGenProgressStore((s) => s.label)
  const showBar = generating && pct !== null

  const main = (
    <button onClick={onClick} disabled={disabled || generating} title={title}
      className="relative flex-1 min-w-0 py-1.5 rounded text-body font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5 overflow-hidden">
      {/* Fill behind the label, so the button itself is the progress bar. */}
      {showBar && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-blue-400/60 transition-[width] duration-150 ease-linear"
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      )}
      <span className="relative flex items-center gap-1.5 truncate">
        {generating && <Loader2 size={ICON.sm} className="animate-spin shrink-0" />}
        {generating
          ? showBar
            ? `${stage ? `${stage} · ` : ''}${Math.round(pct * 100)}%`
            : 'Generating…'
          : label}
      </span>
    </button>
  )
  if (!generating) return <div className="flex">{main}</div>
  return (
    <div className="flex gap-1.5">
      {/* Generating is not disabled-looking: it is the progress, so it stays at full colour. */}
      <div className="flex-1 min-w-0 flex [&>button:disabled]:opacity-100 [&>button:disabled]:cursor-default">{main}</div>
      <button onClick={() => { if (abortGeneration() === 0) useUIStore.getState().showStatus('Generation stopped') }} title="Stop generating — finished toolpaths are kept; the rest are left to regenerate"
        className="shrink-0 px-2.5 py-1.5 rounded text-body font-medium bg-red-600 hover:bg-red-500 text-white transition-colors flex items-center gap-1.5">
        <Square size={ICON.sm} className="fill-current" />Stop
      </button>
    </div>
  )
}

// ─── The batch Generate (see batchGenerate.ts) ────────────────────────────────

/**
 * A form's Generate: `generate(args, form)` runs `runBatchGenerate` with the form's own
 * error banner, and saves `form` as the defaults for the next one — under `formKey`, or under
 * every key it returns for this form (Profile keeps a set per cut side, `profileSaveKeys`).
 */
export function useBatchGenerate<F extends object>(type: BatchGenerateArgs['type'], formKey: string | ((form: F) => string[])) {
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
  const save = useFormDefaultsStore((s) => s.save)
  const generate = async (args: Omit<BatchGenerateArgs, 'type' | 'onError'>, form: F) => {
    clearError()
    setGenerating(true)
    try {
      await runBatchGenerate({ ...args, type, onError: reportError })
    } finally {
      setGenerating(false)
      for (const key of typeof formKey === 'string' ? [formKey] : formKey(form)) save(key, form)
    }
  }
  return { generating, errorMsg, generate }
}

/** The Generate button's words: an edited batch regenerates, a repeat click updates. */
export function generateLabel(editing: boolean, updating: boolean): string {
  return editing ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'
}

/** Shown above the form while there is nothing to cut. */
export function NoPathBanner({ editing, closed = false }: { editing: boolean; closed?: boolean }) {
  return (
    <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
      <AlertCircle size={ICON.sm} /> {editing ? 'Path not found' : closed ? 'Select a closed path first' : 'Select a path first'}
    </p>
  )
}

/** A labelled checkbox — Ramp In, Finishing pass, Invert Pocket. */
export function CheckRow({ id, checked, onChange, label, hint }: {
  id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <input type="checkbox" id={id} checked={checked}
        onChange={(e) => onChange(e.target.checked)} className="accent-blue-500" />
      <label htmlFor={id} className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
        {label}{hint && <> <span className="text-gray-600 dark:text-neutral-400 normal-case">({hint})</span></>}
      </label>
    </div>
  )
}

/**
 * The paths a batch cuts, below the Generate button — see PathListSection. A single-path
 * form passes each path as a boundary with no islands. Islands keep their label because
 * that is a real distinction; nothing else needs one.
 */
export function BatchPathList({ groups, addedIds, removed, editing }: {
  groups: { boundary: ImportedPath; islands: ImportedPath[] }[]
  addedIds: Set<string>
  removed: ImportedPath[]
  editing: boolean
}) {
  // A member clicked out in the list is drawn in its own row by the list (ExcludedAfter);
  // only one taken out on the canvas joins the removed rows at the end.
  const excludedIds = useExcludedPathIds()
  const removedRows = removed.filter((p) => !excludedIds.has(p.id))
  return (
    <PathListSection count={groups.reduce((n, g) => n + 1 + g.islands.length, 0)}
      toggle listed={removedRows.map((p) => p.id)}>
      {groups.map(({ boundary, islands }, gi) => (
        <div key={boundary.id} className="space-y-0.5">
          <PathChip path={boundary} index={groups.length > 1 ? gi + 1 : undefined}
            state={addedIds.has(boundary.id) ? 'added' : undefined} />
          {islands.map((p) => (
            <PathChip key={p.id} path={p} label="island" state={addedIds.has(p.id) ? 'added' : undefined} />
          ))}
        </div>
      ))}
      {removedRows.map((p) => <PathChip key={p.id} path={p} state="removed" />)}
      {editing && <PathRevisionHint added={addedIds.size} removed={removed.length} />}
    </PathListSection>
  )
}
