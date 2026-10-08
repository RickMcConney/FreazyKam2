import { useEffect, useState } from 'react'
import { useUIStore } from '../store/uiStore'
import { applySettings, describeReplace, describeSection, exportSettings, sectionAddsAnything, type MergeMode } from '../io/settingsFile'
import { SETTINGS_SECTIONS, type SectionKey, type SettingsFile } from '../io/settingsMerge'

// What a settings file holds, one checkbox a section, before anything changes. The tool
// library and post-processors can be ADDED to (the default — they start ticked when that
// would add something) or REPLACED, for moving your own setup to a new browser, where
// adding would leave two sets. The other sections only replace, and start unticked: they
// swap the user's own machine, stock defaults or interface for the file's, which is right
// for a backup and wrong for a file a friend sent. Any replace turns the button red and
// offers a backup first, since settings are not covered by Undo.
export default function ImportSettingsDialog({ file, onClose }: { file: SettingsFile; onClose: () => void }) {
  const present = SETTINGS_SECTIONS.filter((s) => file.sections[s.key] !== undefined)
  // Merge sections start ticked only when they would add something: one that would add
  // nothing has nothing to tick for.
  const [chosen, setChosen] = useState<Set<SectionKey>>(() => new Set(present
    .filter((s) => s.mode === 'merge' && sectionAddsAnything(file, s.key as 'tools' | 'postProcessors'))
    .map((s) => s.key)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const [modes, setModes] = useState<Record<'tools' | 'postProcessors', MergeMode>>({ tools: 'merge', postProcessors: 'merge' })
  const setMode = (k: 'tools' | 'postProcessors', m: MergeMode) => {
    setModes((x) => ({ ...x, [k]: m }))
    // Choosing Replace is choosing to import it.
    if (m === 'replace') setChosen((c) => new Set(c).add(k))
  }
  const replacing = present.some((s) => chosen.has(s.key) && (s.mode === 'replace' || modes[s.key as 'tools' | 'postProcessors'] === 'replace'))
  const toggle = (k: SectionKey) => setChosen((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const doImport = () => {
    const lines = applySettings(file, present.map((s) => s.key).filter((k) => chosen.has(k)), modes)
    useUIStore.getState().showStatus(lines.length ? `Imported — ${lines.join('; ')}.` : 'Nothing imported.', 'info')
    onClose()
  }
  const saved = file.savedAt ? new Date(file.savedAt).toLocaleString() : null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[460px] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">Import Settings</h2>
          {saved && <p className="text-xs text-gray-500 dark:text-neutral-400 mt-0.5">Exported {saved}{file.build ? ` · FreazyKam build ${file.build}` : ''}</p>}
        </div>

        <div className="px-5 py-4 space-y-3">
          {present.length === 0 && <p className="text-sm text-gray-600 dark:text-neutral-400">This file has no settings in it.</p>}
          {(['merge', 'replace'] as const).map((mode) => {
            const rows = present.filter((s) => s.mode === mode)
            if (!rows.length) return null
            return (
              <div key={mode}>
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-neutral-400 mb-1">
                  {mode === 'merge' ? 'Tools and post-processors' : 'Replace yours'}
                </p>
                <p className="text-xs text-gray-500 dark:text-neutral-400 mb-1.5">
                  {mode === 'merge'
                    ? 'Add: new ones join yours, and one with your name but different contents comes in as a copy. Replace: yours are swapped for the file\'s — tools the open project uses are kept.'
                    : 'Your current settings are swapped for the file\'s.'}
                </p>
                {rows.map((s) => {
                  const lib = s.mode === 'merge' ? s.key as 'tools' | 'postProcessors' : null
                  const detail = lib && modes[lib] === 'replace' ? describeReplace(file, lib) : describeSection(file, s.key)
                  return (
                    <div key={s.key} className="flex items-center gap-2 py-0.5">
                      <label className="flex-1 min-w-0 flex items-center gap-2 text-sm text-gray-800 dark:text-neutral-200 cursor-pointer">
                        <input type="checkbox" checked={chosen.has(s.key)} onChange={() => toggle(s.key)} className="accent-blue-500" />
                        <span className="min-w-0">
                          {s.label}
                          {detail && <span className={`block text-xs ${lib && modes[lib] === 'replace' ? 'text-red-700 dark:text-red-400' : 'text-gray-500 dark:text-neutral-400'}`}>{detail}</span>}
                        </span>
                      </label>
                      {lib && (
                        <div className="flex flex-shrink-0 rounded border border-gray-300 dark:border-neutral-600 overflow-hidden text-xs" role="radiogroup" aria-label={`${s.label}: add or replace`}>
                          {(['merge', 'replace'] as const).map((m) => (
                            <button key={m} role="radio" aria-checked={modes[lib] === m} onClick={() => setMode(lib, m)}
                              className={`px-2 py-0.5 ${modes[lib] === m
                                ? (m === 'replace' ? 'bg-red-600 text-white' : 'bg-blue-600 text-white')
                                : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700'}`}>
                              {m === 'merge' ? 'Add' : 'Replace'}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-gray-200 dark:border-neutral-700">
          {replacing && (
            <button onClick={exportSettings} title="Download every setting as it is now, as a .fkset file you can import to get them back"
              className="px-3 py-1.5 text-sm rounded text-blue-700 dark:text-sky-400 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors">
              Export a backup
            </button>
          )}
          <span className="flex-1" />
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors">
            Cancel
          </button>
          <button onClick={doImport} disabled={chosen.size === 0} autoFocus={!replacing}
            className={`px-3 py-1.5 text-sm rounded text-white disabled:opacity-40 transition-colors ${replacing ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700 disabled:hover:bg-blue-600'}`}>
            {replacing ? 'Import and replace' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
