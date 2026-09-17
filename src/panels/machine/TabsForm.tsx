// ─── Tabs form ────────────────────────────────────────────────────────────────
import { FormShell, PathChip, GenerateBtn, LengthInput } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle, Trash2 } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useTabStore } from '../../store/tabStore'
import { regenerateAffected } from '../../cam/regenerate'

interface TabsFormState {
  count: number
  lengthMM: number
  heightMM: number
}

export function TabsForm({ onClose }: { onClose: () => void }) {
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const tabs = useTabStore((s) => s.tabs)
  const applyTabs = useTabStore((s) => s.applyTabs)
  const deleteTab = useTabStore((s) => s.deleteTab)
  const deletePathTabs = useTabStore((s) => s.deletePathTabs)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)

  const [form, setForm] = useState<TabsFormState>(() => {
    const saved = load('tabs') as { count?: number; lengthMM?: number; heightMM?: number } | null
    return {
      count: saved?.count ?? 4,
      lengthMM: saved?.lengthMM ?? 5,
      heightMM: saved?.heightMM ?? 2,
    }
  })

  const singlePath = selectedIds.length === 1 ? paths.find((p) => p.id === selectedIds[0]) ?? null : null
  const pathTabs = singlePath ? tabs.filter((t) => t.pathId === singlePath.id) : []

  function up<K extends keyof TabsFormState>(k: K, v: TabsFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleApply() {
    if (!singlePath) return
    applyTabs(singlePath.id, form.count, singlePath.d, form.lengthMM, form.heightMM)
    regenerateAffected(singlePath.id)
    save('tabs', form)
  }

  function handleDelete(id: string) {
    deleteTab(id)
    if (singlePath) regenerateAffected(singlePath.id)
  }

  function handleClearAll() {
    if (!singlePath) return
    deletePathTabs(singlePath.id)
    regenerateAffected(singlePath.id)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'

  return (
    <FormShell title="Tabs" onClose={onClose}>
      <div>
        <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Path</div>
        {singlePath ? (
          <PathChip path={singlePath} label="selected" />
        ) : (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a single path first</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="tabs-count" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Count</label>
          <NumericInput id="tabs-count" value={form.count} min={1} max={20} step={1} integer
            onChange={(v) => up('count', v)}
            className={inputCls} />
        </div>
        <div>
          <label htmlFor="tabs-height" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Height</label>
          <LengthInput id="tabs-height" valueMM={form.heightMM} minMM={0.1} stepMM={0.5}
            onChangeMM={(v) => up('heightMM', v)} className={inputCls} />
        </div>
      </div>
      <div>
        <label htmlFor="tabs-length" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Length</label>
        <LengthInput id="tabs-length" valueMM={form.lengthMM} minMM={0.5} stepMM={1}
          onChangeMM={(v) => up('lengthMM', v)} className={inputCls} />
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">Tab width along the path edge</p>
      </div>
      <GenerateBtn disabled={!singlePath} generating={false} onClick={handleApply} label="Apply Tabs" />
      {pathTabs.length > 0 && (
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
          <button onClick={handleClearAll}
            className="w-full py-1 rounded text-label border border-gray-400 dark:border-neutral-600 text-gray-600 dark:text-neutral-400 hover:text-red-400 hover:border-red-400 transition-colors">
            Clear All Tabs
          </button>
        </div>
      )}
    </FormShell>
  )
}
