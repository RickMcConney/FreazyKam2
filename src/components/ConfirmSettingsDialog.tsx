import { useEffect } from 'react'
import { exportSettings } from '../io/settingsFile'

export interface ChangeGroup {
  heading: string
  items: string[]
  tone?: 'remove' | 'keep' | 'change'
}

const TONE: Record<NonNullable<ChangeGroup['tone']>, string> = {
  remove: 'text-red-700 dark:text-red-400',
  keep: 'text-green-700 dark:text-green-400',
  change: 'text-gray-900 dark:text-neutral-100',
}

// The confirm before a restore or a replace: these change SETTINGS, which undo does not
// cover, so the dialog says exactly what will be reset, what comes back, what is kept
// and what goes — and offers a backup first. A plan that changes nothing says so and
// offers only Close.
export default function ConfirmSettingsDialog({ title, intro, groups, confirmLabel, onConfirm, onClose }: {
  title: string
  intro?: string
  groups: ChangeGroup[]
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}) {
  const shown = groups.filter((g) => g.items.length)
  const changes = shown.some((g) => g.tone !== 'keep')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[460px] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">{changes ? title : 'Nothing to change'}</h2>
        </div>

        <div className="px-5 py-4 text-sm text-gray-600 dark:text-neutral-400 space-y-3 max-h-[60vh] overflow-y-auto">
          {changes && intro && <p>{intro}</p>}
          {!changes && <p>These settings are already as they would be — there is nothing to change.</p>}
          {shown.map((g) => (
            <div key={g.heading}>
              <p className={`font-medium ${TONE[g.tone ?? 'change']}`}>{g.heading}</p>
              <ul className="mt-1 ml-4 list-disc text-gray-700 dark:text-neutral-300">
                {g.items.map((it) => <li key={it}>{it}</li>)}
              </ul>
            </div>
          ))}
          {changes && <p className="text-xs">This can't be undone with Undo. Export a backup first if you might want these back.</p>}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-gray-200 dark:border-neutral-700">
          {changes && (
            <button onClick={exportSettings} title="Download every setting as it is now, as a .fkset file you can import to get them back"
              className="px-3 py-1.5 text-sm rounded text-blue-700 dark:text-sky-400 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors">
              Export a backup
            </button>
          )}
          <span className="flex-1" />
          <button onClick={onClose} autoFocus
            className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors">
            {changes ? 'Cancel' : 'Close'}
          </button>
          {changes && (
            <button onClick={() => { onConfirm(); onClose() }}
              className="px-3 py-1.5 text-sm rounded bg-red-600 hover:bg-red-700 text-white transition-colors">
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
