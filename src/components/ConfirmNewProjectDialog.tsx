import { useEffect } from 'react'
import { useUIStore } from '../store/uiStore'
import { useProjectStore } from '../store/projectStore'
import { newProject } from '../io/projectLoad'
import { triggerProjectSave } from '../io/fileSystem'

// Discard confirmation for New Project. Driven by uiStore.confirmNewProject so both
// entry points (toolbar button, Ctrl+N) raise the same dialog — see requestNewProject
// (io/projectLoad.ts), which is also what decides the dialog is worth showing at all.
// Renders nothing when nothing is waiting.
export default function ConfirmNewProjectDialog() {
  const open = useUIStore((s) => s.confirmNewProject)
  const setOpen = useUIStore((s) => s.setConfirmNewProject)
  const projectName = useProjectStore((s) => s.name)

  // Escape cancels. Bound on the window rather than on the dialog so it works wherever
  // the focus sits, and in the capture phase so it lands before App's own document-wide
  // key handler (which would read the bare Escape as "leave the current tool").
  // Enter cancels too, via autoFocus on Cancel — the safe default for a destructive
  // confirmation is the one that changes nothing.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[420px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">Start a New Project?</h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <p className="text-sm text-gray-600 dark:text-neutral-400">
            <span className="font-medium text-gray-900 dark:text-neutral-100">{projectName}</span> has
            unsaved changes. Starting a new project discards them, and this cannot be undone.
          </p>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-neutral-700">
          <button
            onClick={() => setOpen(false)}
            autoFocus
            className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors"
          >
            Cancel
          </button>
          <button
            // Saves and leaves the document alone. New Project afterwards is then clean,
            // so requestNewProject lets it through without asking again.
            onClick={() => { setOpen(false); void triggerProjectSave() }}
            className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors"
          >
            Save First…
          </button>
          <button
            onClick={() => newProject()}
            className="px-3 py-1.5 text-sm rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
          >
            Discard and Start New
          </button>
        </div>
      </div>
    </div>
  )
}
