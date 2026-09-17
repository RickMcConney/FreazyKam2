import React, { useId } from 'react'
import { Copy, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { ICON } from '../theme'
import {
  usePostProcessorStore,
  type PostProcessorProfile,
  type CommentStyle,
} from '../store/postProcessorStore'

const inputCls =
  'w-full bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-600 rounded px-2 py-1 text-body text-gray-800 dark:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500'

const textareaCls =
  'w-full bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-600 rounded px-2 py-1.5 text-body text-gray-800 dark:text-neutral-200 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y min-h-[64px]'

const labelCls = 'block text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  /** Exactly one form control — Field owns the id and injects it, so the label
   *  can point at it without every call site having to invent one. */
  children: React.ReactElement
}) {
  const id = useId()
  return (
    <div>
      <label className={labelCls} htmlFor={id}>{label}</label>
      {hint && <p className="text-label text-gray-600 dark:text-neutral-400 mb-1">{hint}</p>}
      {React.cloneElement(children, { id } as Partial<unknown>)}
    </div>
  )
}

function ProfileEditor({ profile }: { profile: PostProcessorProfile }) {
  const { updateProfile } = usePostProcessorStore()
  const up = (updates: Partial<Omit<PostProcessorProfile, 'id'>>) =>
    updateProfile(profile.id, updates)

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-3 gap-3 items-end">
        <div className="col-span-1">
          <Field label="Name" hint="Written into the file header">
            <input type="text" value={profile.name} onChange={(e) => up({ name: e.target.value })} className={inputCls} />
          </Field>
        </div>
        <div>
          <Field label="Unit mode" hint="Sets coordinates and emits G20/G21">
            <select value={profile.unitMode} onChange={(e) => up({ unitMode: e.target.value as 'mm' | 'in' })} className={inputCls}>
              <option value="mm">mm</option>
              <option value="in">inches</option>
            </select>
          </Field>
        </div>
        <div>
          <Field label="Comment style" hint="Style for generated comments">
            <select value={profile.commentStyle} onChange={(e) => up({ commentStyle: e.target.value as CommentStyle })} className={inputCls}>
              <option value="semicolon">; Semicolon</option>
              <option value="parenthesis">( Parenthesis )</option>
              <option value="none">None</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Start G-code" hint="Emitted once at job start, after G20/G21">
          <textarea value={profile.startGcode} onChange={(e) => up({ startGcode: e.target.value })} className={textareaCls} rows={8} />
        </Field>
        <Field label="End G-code" hint="Emitted once at job end">
          <textarea value={profile.endGcode} onChange={(e) => up({ endGcode: e.target.value })} className={textareaCls} rows={8} />
        </Field>
      </div>

      <Field label="Tool change G-code" hint="Emitted before each new tool">
        <textarea value={profile.toolChangeGcode} onChange={(e) => up({ toolChangeGcode: e.target.value })} className={textareaCls} rows={2} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Spindle on" hint="Placeholders: {s} = spindle speed">
          <input type="text" value={profile.spindleOnTemplate} onChange={(e) => up({ spindleOnTemplate: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Spindle off" hint="Emitted to stop the spindle">
          <input type="text" value={profile.spindleOffGcode} onChange={(e) => up({ spindleOffGcode: e.target.value })} className={inputCls} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Rapid move" hint="Placeholders: {x} {y} {z}">
          <input type="text" value={profile.rapidTemplate} onChange={(e) => up({ rapidTemplate: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Cut move" hint="Placeholders: {x} {y} {z} {f}">
          <input type="text" value={profile.cutTemplate} onChange={(e) => up({ cutTemplate: e.target.value })} className={inputCls} />
        </Field>
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={profile.outputArcs} onChange={(e) => up({ outputArcs: e.target.checked })} className="accent-blue-500" />
          <span className="text-body text-gray-700 dark:text-neutral-300">Output arc moves (G2/G3)</span>
        </label>
      </div>

      {profile.outputArcs && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Arc CW (G2)" hint="{x} {y} {i} {j} {f}">
            <input type="text" value={profile.arcCWTemplate} onChange={(e) => up({ arcCWTemplate: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Arc CCW (G3)" hint="{x} {y} {i} {j} {f}">
            <input type="text" value={profile.arcCCWTemplate} onChange={(e) => up({ arcCCWTemplate: e.target.value })} className={inputCls} />
          </Field>
        </div>
      )}
    </div>
  )
}

export default function PostProcessorPanel() {
  const { profiles, activeId, setActiveId, addProfile, duplicateProfile, deleteProfile, resetProfile } = usePostProcessorStore()
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0]

  return (
    <div className="flex h-full bg-gray-50 dark:bg-neutral-900">
      {/* Profile list sidebar */}
      <div className="w-52 flex flex-col flex-shrink-0 border-r border-gray-300 dark:border-neutral-700">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
          <span className="text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider">Profiles</span>
          <div className="flex gap-1">
            <button onClick={addProfile} title="New profile" className="p-0.5 rounded text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700 transition-colors">
              <Plus size={ICON.sm} />
            </button>
            <button onClick={() => duplicateProfile(activeId)} title="Duplicate profile" className="p-0.5 rounded text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700 transition-colors">
              <Copy size={ICON.sm} />
            </button>
            <button onClick={() => deleteProfile(activeId)} disabled={profiles.length <= 1} title={profiles.length <= 1 ? 'Cannot delete the last profile' : 'Delete profile'} className="p-0.5 rounded text-gray-600 dark:text-neutral-400 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <Trash2 size={ICON.sm} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {profiles.map((p) => (
            <button key={p.id} onClick={() => setActiveId(p.id)}
              className={[
                'w-full text-left px-3 py-2 text-body transition-colors',
                p.id === activeId
                  ? 'bg-blue-600/20 text-blue-300 border-r-2 border-blue-500'
                  : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 hover:text-gray-900 dark:hover:text-neutral-100',
              ].join(' ')}
            >
              <div className="font-medium truncate">{p.name}</div>
              <div className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">{p.unitMode}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
          <span className="flex items-center gap-2">
            <span className="text-body font-semibold text-gray-700 dark:text-neutral-300">{active.name}</span>
            {active.builtin && (
              <span className="text-label text-gray-600 dark:text-neutral-400 border border-gray-300 dark:border-neutral-600 rounded px-1.5 py-0.5 uppercase tracking-wider">Built-in</span>
            )}
          </span>
          <span className="flex items-center gap-3">
            {active.builtin && (
              <button
                onClick={() => resetProfile(active.id)}
                title="Reset this built-in profile to its factory defaults"
                className="flex items-center gap-1 text-label text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 transition-colors"
              >
                <RotateCcw size={ICON.sm} /> Reset
              </button>
            )}
            <span className="text-label text-gray-600 dark:text-neutral-400">
              Placeholders: {'{x}'} {'{y}'} {'{z}'} {'{f}'} {'{s}'}
            </span>
          </span>
        </div>
        <ProfileEditor profile={active} />
      </div>
    </div>
  )
}
