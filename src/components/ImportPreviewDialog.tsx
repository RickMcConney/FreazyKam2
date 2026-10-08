import { useEffect, useMemo } from 'react'
import { useUIStore } from '../store/uiStore'
import { applySettings, planMerge, planSummary } from '../io/settingsFile'
import type { SettingsFile } from '../io/settingsMerge'

// The check before a tool set or post-processors come in from their own tab: what the
// import WOULD add, worked out by the same merge it then runs, with OK and Cancel. A
// re-import that would add nothing says so and offers only Close — the "two of each
// tool" surprise is exactly what this is here to catch before it lands.
export default function ImportPreviewDialog({ file, sectionKey, onClose }: {
  file: SettingsFile
  sectionKey: 'tools' | 'postProcessors'
  onClose: () => void
}) {
  const plan = useMemo(() => planMerge(file, sectionKey), [file, sectionKey])
  const noun = sectionKey === 'tools' ? 'tool' : 'post-processor'
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`
  const adds = plan.added.length + plan.copied.length

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const doImport = () => {
    const [line] = applySettings(file, [sectionKey])
    useUIStore.getState().showStatus(line ? `Imported — ${line}.` : 'Nothing imported.', 'info')
    onClose()
  }

  const list = (names: string[]) => (
    <ul className="mt-1 mb-2 ml-4 list-disc text-gray-700 dark:text-neutral-300 max-h-32 overflow-y-auto">
      {names.map((n) => <li key={n}>{n}</li>)}
    </ul>
  )

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[420px] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">
            {adds ? `Import ${plural(adds)}?` : `Nothing new to import`}
          </h2>
        </div>

        <div className="px-5 py-4 text-sm text-gray-600 dark:text-neutral-400">
          {plan.added.length > 0 && (<>
            <p>About to add <span className="font-medium text-gray-900 dark:text-neutral-100">{plural(plan.added.length)}</span> you don't have:</p>
            {list(plan.added)}
          </>)}
          {plan.copied.length > 0 && (<>
            <p><span className="font-medium text-gray-900 dark:text-neutral-100">{plural(plan.copied.length)}</span> share a name with one of yours but differ, so {plan.copied.length === 1 ? 'it comes' : 'they come'} in beside {plan.copied.length === 1 ? 'it' : 'them'} as a copy — yours {plan.copied.length === 1 ? 'is' : 'are'} not changed:</p>
            {list(plan.copied)}
          </>)}
          {plan.same > 0 && (
            <p className="mt-1">{plural(plan.same)} in the file {plan.same === 1 ? 'is' : 'are'} already in yours exactly, and will be skipped.</p>
          )}
          {!adds && !plan.same && <p>The file has no usable {noun}s in it.</p>}
          {adds > 0 && <p className="mt-2 text-xs">({planSummary(plan)})</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-neutral-700">
          <button onClick={onClose} autoFocus={!adds}
            className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors">
            {adds ? 'Cancel' : 'Close'}
          </button>
          {adds > 0 && (
            <button onClick={doImport} autoFocus
              className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors">
              OK
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
