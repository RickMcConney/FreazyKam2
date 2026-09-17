// Shared widgets used by the operation forms (extracted from MachinePanel — tofix.md R1).
// ─── Shared sub-components ───────────────────────────────────────────────────
import { useMemo, useState, useId } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { NUMERIC_HINT } from '../../components/parseNumeric'
import { ICON } from '../../theme'
import { AlertCircle, AlertTriangle, Loader2 } from 'lucide-react'
import type { Tool, ToolType } from '../../store/toolStore'
import { useWorkpieceStore, fromMM, toMM, fmtLen, lenValue, inchStepFor } from '../../store/workpieceStore'
import { useGenProgressStore } from '../../store/genProgressStore'
import { useToolpathStore } from '../../store/toolpathStore'
import { effectiveStepDownMM } from '../../cam/feeds'
import { resolveStartZ, listFlatFloorOps, type StartFrom, type StartZ } from '../../cam/startHeight'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'

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
  state?: 'added' | 'removed'
  /** Position in CUT order, 1-based. Set on the top-level entries of a list of more than
   *  one, so the order the paths were picked in — which is the order they will be cut
   *  (see useSelectedPathsInOrder) — can be read off the form instead of the G-code. */
  index?: number
}) {
  const tone = state === 'added'
    ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/40'
    : state === 'removed'
      ? 'text-gray-500 dark:text-neutral-500 bg-gray-100 dark:bg-neutral-800 line-through'
      : 'text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800'
  return (
    <div className={`text-body rounded px-2 py-1 flex items-center gap-1.5 ${tone}`}>
      {state && <span className="flex-shrink-0 no-underline">{state === 'added' ? '+' : '−'}</span>}
      {index !== undefined && (
        <span className="flex-shrink-0 tabular-nums text-gray-500 dark:text-neutral-400 no-underline">{index}.</span>
      )}
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: path.color }} />
      <span className="truncate">{path.name}</span>
      {label && <span className="text-gray-600 dark:text-neutral-400 flex-shrink-0">({label})</span>}
    </div>
  )
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

// The path list every operation form ends with: same header, same divider, same placement
// under the Generate button, whatever the form. Forms differ only in the chips they put
// inside — a pocket labels its islands, a profile has nothing to add.
export function PathListSection({ count, children }: { count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <div className="pt-1 border-t border-gray-300 dark:border-neutral-700">
      <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
        Paths{count > 1 && <span className="normal-case text-gray-500 dark:text-neutral-400"> ({count})</span>}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}


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

export function ToolSelector({ tools, value, onChange }: {
  tools: Tool[]
  value: string
  onChange: (id: string) => void
}) {
  const units = useWorkpieceStore((s) => s.units)
  const id = useId()
  return (
    <div>
      <label className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1" htmlFor={id}>Tool</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={tools.length === 0}
        className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
      >
        {tools.length === 0 && <option value="">No suitable tool — add one in the Tool Library</option>}
        {tools.map((t) => (
          <option key={t.id} value={t.id}>{t.name} (Ø{fmtLen(t.diameterMM, units)})</option>
        ))}
      </select>
    </div>
  )
}

export function ToggleRow<T extends string>({ label, options, value, onChange, labels }: {
  label: string
  options: readonly T[]
  value: T
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

export function DepthRow({ depthMM, stepDownMM, onDepth, onStep, maxDepthMM, tool, engagementFraction, startZMM = 0 }: {
  depthMM: number; stepDownMM: number
  onDepth: (v: number) => void; onStep: (v: number) => void
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
  const stepId = useId()
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
      {autoStepDownMM != null ? (
        <AutoStepField label="Step Down" valueMM={autoStepDownMM} />
      ) : (
        <div>
          <label className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1" htmlFor={stepId}>Step Down</label>
          <LengthInput id={stepId} valueMM={stepDownMM} minMM={0.01} stepMM={0.5} onChangeMM={onStep} />
        </div>
      )}
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

/**
 * Throw away the operations THIS Generate created that failed.
 *
 * An operation with no toolpath is not a thing in the document — `generateGcode` skips
 * it, and a chip standing for a cut that does not exist is worse than no chip. So a
 * failed Generate leaves nothing behind. Pass only the ids this click CREATED: an
 * operation that already existed keeps its slot and its error message, because deleting
 * a user's operation because a re-Generate failed would be the worse of the two wrongs.
 */
export function discardFailedOps(createdIds: string[]) {
  if (createdIds.length === 0) return
  const { operations, deleteOperations } = useToolpathStore.getState()
  const failed = createdIds.filter((id) => operations.find((o) => o.id === id)?.status === 'error')
  if (failed.length > 0) deleteOperations(failed)
}

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
export function GenerateBtn({ disabled, generating, onClick, label = 'Generate Toolpath', title }: { disabled: boolean; generating: boolean; onClick: (e: React.MouseEvent) => void; label?: string; title?: string }) {
  // Progress is only published once a generation has been running long enough to be worth
  // showing (see genProgressStore); short ones keep the plain spinner.
  const pct = useGenProgressStore((s) => s.overall)
  const stage = useGenProgressStore((s) => s.label)
  const showBar = generating && pct !== null

  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className="relative w-full py-1.5 rounded text-body font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5 overflow-hidden">
      {/* Fill behind the label, so the button itself is the progress bar. */}
      {showBar && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-blue-400/60 transition-[width] duration-150 ease-linear"
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      )}
      <span className="relative flex items-center gap-1.5">
        {generating && <Loader2 size={ICON.sm} className="animate-spin" />}
        {generating
          ? showBar
            ? `${stage ? `${stage} · ` : ''}${Math.round(pct * 100)}%`
            : 'Generating…'
          : label}
      </span>
    </button>
  )
}
