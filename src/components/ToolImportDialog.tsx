import { useEffect, useId, useMemo, useState } from 'react'
import { useUIStore } from '../store/uiStore'
import { useToolStore, folderNames, MY_TOOLS } from '../store/toolStore'
import { applyToolFolderImport, planSummary, planToolFolderImport, type ToolFileImport } from '../io/settingsFile'

// The Tool Library's import: a tool set lands in a NAMED FOLDER, never loose among the
// user's own tools. The folder starts as the vendor's name (or the file's) and can be
// any folder — an existing one merges by name inside it, so re-importing a catalogue
// adds only what changed. Typing "My Tools" is allowed, and is the one way in to it.
export default function ToolImportDialog({ file, onClose }: { file: ToolFileImport; onClose: () => void }) {
  const tools = useToolStore((s) => s.tools)
  const [folder, setFolder] = useState(file.folder)
  const plan = useMemo(() => planToolFolderImport(file.tools, folder), [file.tools, folder, tools])
  const adds = plan.added.length + plan.copied.length
  const listId = useId()
  const named = folder.trim() !== ''
  const exists = folder.trim() === MY_TOOLS || folderNames(tools).includes(folder.trim())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const doImport = () => {
    const r = applyToolFolderImport(file.tools, folder)
    const skipped = file.skipped.length ? ` · ${file.skipped.length} skipped` : ''
    useUIStore.getState().showStatus(`Imported into "${folder.trim()}" — ${planSummary(r)}${skipped}.`, 'info')
    onClose()
  }

  const list = (names: string[]) => (
    <ul className="mt-1 mb-2 ml-4 list-disc text-gray-700 dark:text-neutral-300 max-h-32 overflow-y-auto">
      {names.map((n) => <li key={n}>{n}</li>)}
    </ul>
  )
  const plural = (n: number) => `${n} tool${n === 1 ? '' : 's'}`

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[460px] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">
            Import {plural(file.tools.length)} from {file.format === 'Fusion 360' ? 'a Fusion 360 library' : 'a tool set'}
          </h2>
          <p className="text-xs text-gray-500 dark:text-neutral-400 truncate" title={file.fileName}>{file.fileName}</p>
        </div>

        <div className="px-5 py-4 text-sm text-gray-600 dark:text-neutral-400">
          <label className="block text-xs uppercase tracking-wider mb-1" htmlFor={listId + '-in'}>Into folder</label>
          <input id={listId + '-in'} list={listId} value={folder} onChange={(e) => setFolder(e.target.value)} autoFocus
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-sm text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500" />
          <datalist id={listId}>
            <option value={MY_TOOLS} />
            {folderNames(tools).map((f) => <option key={f} value={f} />)}
          </datalist>
          <p className="mt-1 mb-3 text-xs">
            {!named ? 'Name the folder the tools go in.'
              : exists ? 'That folder exists — tools it already has are skipped, changed ones come in as a copy.'
              : 'A new folder — your own tools are not touched.'}
          </p>

          {named && (<>
            {plan.added.length > 0 && (<>
              <p>Adds <span className="font-medium text-gray-900 dark:text-neutral-100">{plural(plan.added.length)}</span>:</p>
              {list(plan.added)}
            </>)}
            {plan.copied.length > 0 && (<>
              <p><span className="font-medium text-gray-900 dark:text-neutral-100">{plural(plan.copied.length)}</span> share a name with one in the folder but differ, and come in beside {plan.copied.length === 1 ? 'it' : 'them'} as a copy:</p>
              {list(plan.copied)}
            </>)}
            {plan.same > 0 && <p className="mt-1">{plural(plan.same)} already in the folder exactly, and skipped.</p>}
          </>)}
          {file.skipped.length > 0 && (<>
            <p className="mt-2">Left out — FreazyKam cannot cut with {file.skipped.length === 1 ? 'it' : 'them'}:</p>
            {list(file.skipped.map((s) => `${s.name} — ${s.why}`))}
          </>)}
          {file.notes.length > 0 && (<>
            <p className="mt-2">Approximated:</p>
            {list(file.notes)}
          </>)}
          {file.tools.length === 0 && <p>The file has no tools FreazyKam can use.</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-neutral-700">
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors">
            {adds ? 'Cancel' : 'Close'}
          </button>
          <button onClick={doImport} disabled={!named || adds === 0}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {adds ? `Import ${plural(adds)}` : 'Nothing new'}
          </button>
        </div>
      </div>
    </div>
  )
}
