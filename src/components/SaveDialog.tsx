import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useSaveDialogStore } from '../store/saveDialogStore'
import { useProjectStore } from '../store/projectStore'
import { saveProject } from '../io/projectSave'
import { exportGcode } from '../io/gcodeExport'
import { sanitizeFileName } from '../io/filename'

const META = {
  project: { title: 'Save Project', ext: '.fkam', verb: 'Save' },
  gcode:   { title: 'Export G-code', ext: '.gcode', verb: 'Export' },
} as const

// Filename prompt shown before a project save or G-code export. Pre-fills the
// current project name, lets the user rename, and confirms with Enter. For a
// project save the chosen name also becomes the project name in the toolbar.
export default function SaveDialog() {
  const { open, kind, closeSaveDialog } = useSaveDialogStore()
  const projectName = useProjectStore((s) => s.name)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setDraft(projectName === 'Untitled Project' ? '' : projectName)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [open, projectName])

  if (!open) return null
  const meta = META[kind]

  function confirm() {
    const name = sanitizeFileName(draft, 'project')
    if (kind === 'project') {
      saveProject(name) // updates the project name (toolbar header) and downloads .fkam
    } else {
      void exportGcode(name)
    }
    closeSaveDialog()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); confirm() }
    if (e.key === 'Escape') { e.preventDefault(); closeSaveDialog() }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={closeSaveDialog}
    >
      <div
        className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[420px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">{meta.title}</h2>
          <button
            onClick={closeSaveDialog}
            className="text-gray-600 hover:text-gray-800 dark:hover:text-neutral-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-2">
          <label htmlFor="save-file-name" className="text-sm text-gray-600 dark:text-neutral-400">File name</label>
          <div className="flex items-center">
            <input
              id="save-file-name"
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="project"
              className="flex-1 text-sm bg-gray-100 dark:bg-neutral-700 text-gray-900 dark:text-neutral-100 rounded-l px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
            <span className="text-sm text-gray-500 dark:text-neutral-400 bg-gray-200 dark:bg-neutral-600 px-2.5 py-1.5 rounded-r border-l border-gray-300 dark:border-neutral-500">
              {meta.ext}
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-neutral-700">
          <button
            onClick={closeSaveDialog}
            className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            {meta.verb}
          </button>
        </div>
      </div>
    </div>
  )
}
