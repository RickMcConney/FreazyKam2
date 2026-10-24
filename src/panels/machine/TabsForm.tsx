// ─── Tabs form ────────────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, GenerateBtn, LengthInput } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle, Trash2 } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useTabStore } from '../../store/tabStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { regenerateAffected, regenerateAffectedMany } from '../../cam/regenerate'
import { applyBridges, removeBridges, freedParts } from '../../tools/bridgesRun'
import { useToolpathStore } from '../../store/toolpathStore'
import { BRIDGE_DEFAULTS } from '../../cam/bridges'

// Two ways to hold parts down. TABS belong to one path. HOLDING STRIPS belong to the sheet:
// strips right across it that every through-cut lifts over (cam/bridges.ts, where they are
// called bridges), the only thing that holds a tight nest — there the waste a tab would hold a
// part to is itself cut loose. The UI never says "bridge": the Profile form's "Bridge Gaps
// Through Waste" CUTS through waste, the opposite of leaving a strip standing.
type HoldMode = 'tabs' | 'bridges'

interface TabsFormState {
  count: number
  lengthMM: number
  heightMM: number
  bridgeWidthMM: number
  /** Over several paths, which way to hold them; one path always takes tabs. */
  mode: HoldMode
}

export function TabsForm({ onClose }: { onClose: () => void }) {
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const tabs = useTabStore((s) => s.tabs)
  const applyTabsMany = useTabStore((s) => s.applyTabsMany)
  const deleteTab = useTabStore((s) => s.deleteTab)
  const deleteTabsOf = useTabStore((s) => s.deleteTabsOf)
  const bridges = useWorkpieceStore((s) => s.bridges)
  const units = useWorkpieceStore((s) => s.units)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)

  const [form, setForm] = useState<TabsFormState>(() => {
    const saved = load('tabs') as Partial<TabsFormState> | null
    return {
      count: saved?.count ?? 4,
      lengthMM: saved?.lengthMM ?? 5,
      heightMM: saved?.heightMM ?? BRIDGE_DEFAULTS.heightMM,
      bridgeWidthMM: saved?.bridgeWidthMM ?? bridges?.widthMM ?? BRIDGE_DEFAULTS.widthMM,
      mode: saved?.mode ?? 'bridges',
    }
  })

  // Every selected path with an outline to put tabs on — a picture or an STL model has
  // none. A sheet of parts is tabbed in one click, as one undo step (applyTabsMany).
  const byId = new Map(paths.map((p) => [p.id, p]))
  const targets = selectedIds.flatMap((id) => {
    const p = byId.get(id)
    return p && !p.imageSrc && !p.stlSrc ? [p] : []
  })
  const targetIds = new Set(targets.map((p) => p.id))
  const singlePath = targets.length === 1 ? targets[0] : null
  const mode: HoldMode = targets.length > 1 ? form.mode : 'tabs'
  // The per-tab rows are for one path; over several the form says how many there are.
  const targetTabs = tabs.filter((t) => targetIds.has(t.pathId))
  const pathTabs = singlePath ? targetTabs : []
  const tabsOn = new Map<string, number>()
  for (const t of targetTabs) tabsOn.set(t.pathId, (tabsOn.get(t.pathId) ?? 0) + 1)

  function up<K extends keyof TabsFormState>(k: K, v: TabsFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleApply() {
    if (targets.length === 0) return
    if (mode === 'bridges') applyBridges(targets, form.bridgeWidthMM, form.heightMM, form.count)
    else {
      applyTabsMany(targets, form.count, form.lengthMM, form.heightMM)
      regenerateAffectedMany(targets.map((p) => p.id))
    }
    save('tabs', form)
  }

  function handleDelete(id: string) {
    deleteTab(id)
    if (singlePath) regenerateAffected(singlePath.id)
  }

  function handleClearAll() {
    if (targets.length === 0) return
    deleteTabsOf(targets.map((p) => p.id))
    regenerateAffectedMany(targets.map((p) => p.id))
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'
  const labelCls = 'block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1'
  const clearBtnCls = 'w-full py-1 rounded text-label border border-gray-400 dark:border-neutral-600 text-gray-600 dark:text-neutral-400 hover:text-red-400 hover:border-red-400 transition-colors'
  const lineCount = bridges?.lines.length ?? 0
  // Strips join only the parts some cut sets free — not the labels and holes a drag box
  // catches with them (freedParts).
  const operations = useToolpathStore((s) => s.operations)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const joinable = mode === 'bridges' ? freedParts(targets, operations, thicknessMM).length : 0

  return (
    <FormShell title="Tabs" onClose={onClose}>
      <div>
        <div className={labelCls}>Path</div>
        {singlePath ? (
          <PathChip path={singlePath} label="selected" />
        ) : targets.length > 1 ? (
          <p className="text-body text-gray-700 dark:text-neutral-300">{targets.length} selected paths</p>
        ) : (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select one or more paths first</p>
        )}
      </div>
      {targets.length > 1 && (
        <div>
          <div className={labelCls}>Hold With</div>
          <div className="flex gap-1">
            {(['bridges', 'tabs'] as const).map((m) => (
              <button key={m} onClick={() => up('mode', m)}
                className={[
                  'flex-1 py-1 text-body rounded border transition-colors',
                  mode === m
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-gray-50 dark:bg-neutral-900 border-gray-400 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
                ].join(' ')}>
                {m === 'bridges' ? 'Joined by strips' : 'Tabs on each path'}
              </button>
            ))}
          </div>
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
            {mode === 'bridges'
              ? 'Short holding strips join each part to its neighbours, square across the gaps, so every part hangs through the others on the sheet\'s edge. Each join is a tab on the part. Holes cut through them.'
              : 'Each path gets its own tabs. On a tight nest a neighbour\'s cut can sweep them away — use holding strips there.'}
          </p>
        </div>
      )}
      {/* The count is tabs on each path, or the joins each part makes into the network — each
          join is a tab on it, so it is the same question either way. */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="tabs-count" className={labelCls}>{mode === 'bridges' ? 'Joins Per Part' : 'Count'}</label>
          <NumericInput id="tabs-count" value={form.count} min={1} max={20} step={1} integer
            onChange={(v) => up('count', v)}
            className={inputCls} />
        </div>
        <div>
          <label htmlFor="tabs-height" className={labelCls}>Height</label>
          <LengthInput id="tabs-height" valueMM={form.heightMM} minMM={0.1} stepMM={0.5}
            onChangeMM={(v) => up('heightMM', v)} className={inputCls} />
        </div>
      </div>
      {mode === 'tabs' ? (
        <div>
          <label htmlFor="tabs-length" className={labelCls}>Length</label>
          <LengthInput id="tabs-length" valueMM={form.lengthMM} minMM={0.5} stepMM={1}
            onChangeMM={(v) => up('lengthMM', v)} className={inputCls} />
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">Tab width along the path edge</p>
        </div>
      ) : (
        <div>
          <label htmlFor="bridge-width" className={labelCls}>Width</label>
          <LengthInput id="bridge-width" valueMM={form.bridgeWidthMM} minMM={0.5} stepMM={1}
            onChangeMM={(v) => up('bridgeWidthMM', v)} className={inputCls} />
          <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">How wide each strip is across the gap it joins</p>
        </div>
      )}
      {mode === 'bridges' && (
        <p className="text-label text-gray-600 dark:text-neutral-400">
          {joinable === 0
            ? 'None of the selected paths is cut through the stock yet — profile the parts first.'
            : `Joining ${joinable} part${joinable !== 1 ? 's' : ''} cut through the stock${joinable < targets.length ? ` — the other ${targets.length - joinable} selected paths (labels, holes) are left out` : ''}.`}
        </p>
      )}
      <GenerateBtn disabled={targets.length === 0 || (mode === 'bridges' && joinable === 0)} generating={false} onClick={handleApply}
        label={mode === 'bridges' ? (lineCount > 0 ? 'Re-place Strips' : 'Place Strips')
          : targets.length > 1 ? `Apply Tabs to ${targets.length} Paths` : 'Apply Tabs'} />
      {mode === 'bridges' && bridges && lineCount > 0 && (
        <div className="space-y-1">
          <p className="text-label text-gray-600 dark:text-neutral-400">
            {lineCount} holding strip{lineCount !== 1 ? 's' : ''}, {fmtLen(bridges.widthMM, units)} wide and {fmtLen(bridges.heightMM, units)} high.
            Re-placing replaces them all.
          </p>
          <button onClick={removeBridges} className={clearBtnCls}>Remove Strips</button>
        </div>
      )}
      {mode === 'tabs' && pathTabs.length > 0 && (
        <div className="space-y-1">
          <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider">
            Current Tabs <span className="normal-case text-gray-500 dark:text-neutral-400">({pathTabs.length})</span>
          </div>
          {pathTabs.map((tab, i) => (
            <div key={tab.id} className="flex items-center gap-1.5 text-body text-gray-700 dark:text-neutral-300 bg-gray-50 dark:bg-neutral-900 rounded px-2 py-1">
              <span className="flex-1">Tab {i + 1} — {(tab.t * 100).toFixed(0)}% along path</span>
              <button onClick={() => handleDelete(tab.id)}
                className="p-0.5 rounded hover:bg-red-900/40 text-gray-600 dark:text-neutral-400 hover:text-red-400 transition-colors flex-shrink-0">
                <Trash2 size={ICON.xs} />
              </button>
            </div>
          ))}
          <button onClick={handleClearAll} className={clearBtnCls}>Clear All Tabs</button>
        </div>
      )}
      {/* Several paths: no per-tab rows (hundreds of them), just the count and a clear. */}
      {!singlePath && targetTabs.length > 0 && (
        <div className="space-y-1">
          <p className="text-label text-gray-600 dark:text-neutral-400">
            {targetTabs.length} tab{targetTabs.length !== 1 ? 's' : ''} on {tabsOn.size} of the {targets.length} selected paths
          </p>
          <button onClick={handleClearAll} className={clearBtnCls}>Clear Tabs on {targets.length} Paths</button>
        </div>
      )}
      {targets.length > 1 && (
        <PathListSection count={targets.length} toggle>
          {targets.map((p) => {
            const n = tabsOn.get(p.id) ?? 0
            return <PathChip key={p.id} path={p} label={n > 0 ? `${n} tab${n !== 1 ? 's' : ''}` : undefined} />
          })}
        </PathListSection>
      )}
    </FormShell>
  )
}
