// Macros — G-code the user sends often (a probe routine, a park position, a spindle warm-up),
// saved under a name and sent with one click. Below the overrides in the Machine tab's
// control column. A macro's lines go out one after another, each once the controller has
// taken the last; STOP, feed hold, reset or a lost connection end it there (see runMacro).
// Kept with the machine's settings, and carried in a settings file's Machine tab section.

import { useState } from 'react'
import { Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { ICON } from '../theme'
import { useMachineStore, macroLines, type Macro } from '../machine/machineStore'

interface Props { sectionCls: string; headCls: string }

const btnCls = 'flex items-center gap-1 px-2 py-0.5 rounded text-xs border border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-transparent'
const iconBtn = 'p-1 rounded text-gray-600 dark:text-neutral-400 hover:bg-gray-200 dark:hover:bg-neutral-700 hover:text-gray-800 dark:hover:text-neutral-100'
const inputCls = 'w-full px-2 py-1 rounded border border-gray-400 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-gray-800 dark:text-neutral-200 text-xs'

export default function MacrosSection({ sectionCls, headCls }: Props) {
  const m = useMachineStore()
  // The macro being edited: an id, 'new' for one being added, or null.
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  // Delete is two clicks on the same row, as on the SD card.
  const [armed, setArmed] = useState<string | null>(null)
  const connected = m.link === 'connected'
  const jobRunning = connected && m.position.sd !== null
  const canRun = connected && !jobRunning && m.macroRunning === null

  return (
    <section className={sectionCls}>
      <div className={`${headCls} flex items-center`}>
        <span className="flex-1">Macros</span>
        <button className={`${btnCls} normal-case tracking-normal font-normal`} onClick={() => setEditing('new')} disabled={editing !== null}
          title="Save G-code you send often under a name, to send with one click">
          <Plus size={ICON.xs} /> Add
        </button>
      </div>
      <div className="px-3 py-2 space-y-1">
        {editing === 'new' && (
          <MacroForm onCancel={() => setEditing(null)}
            onSave={(v) => { m.addMacro(v); setEditing(null) }} />
        )}
        {m.macros.length === 0 && editing !== 'new' && (
          <p className="text-xs text-gray-600 dark:text-neutral-400">
            No macros yet. <span className="font-semibold">Add</span> one to keep G-code you send often — a park
            position, a probe routine, a spindle warm-up — a click away.
          </p>
        )}
        {m.macros.map((mac) => editing === mac.id ? (
          <MacroForm key={mac.id} initial={mac} onCancel={() => setEditing(null)}
            onSave={(v) => { m.updateMacro(mac.id, v); setEditing(null) }} />
        ) : (
          <div key={mac.id} className="group flex items-center gap-1">
            <button className={`${btnCls} flex-1 min-w-0 justify-start h-7`} disabled={!canRun}
              onClick={() => void m.runMacro(mac.id)}
              title={!connected ? 'Connect first'
                : jobRunning ? 'Not while a job is running'
                : m.macroRunning ? 'Another macro is still sending'
                : `Send:\n${macroLines(mac.gcode).join('\n')}`}>
              <Play size={ICON.xs} className="flex-shrink-0" />
              <span className="truncate">{m.macroRunning === mac.id ? `${mac.name} — sending…` : mac.name}</span>
            </button>
            <button className={`${iconBtn} opacity-0 group-hover:opacity-100 focus:opacity-100`} title="Edit"
              onClick={() => setEditing(mac.id)} disabled={editing !== null}>
              <Pencil size={ICON.sm} />
            </button>
            {armed === mac.id ? (
              <button className="px-1.5 h-7 rounded text-xs bg-red-600 text-white" onMouseLeave={() => setArmed(null)}
                onClick={() => { setArmed(null); m.deleteMacro(mac.id) }}>Delete?</button>
            ) : (
              <button className={`${iconBtn} opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-500`} title="Delete"
                onClick={() => setArmed(mac.id)}>
                <Trash2 size={ICON.sm} />
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function MacroForm({ initial, onSave, onCancel }: {
  initial?: Macro
  onSave: (v: { name: string; gcode: string }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [gcode, setGcode] = useState(initial?.gcode ?? '')
  const lines = macroLines(gcode).length
  const ok = name.trim() !== '' && lines > 0
  return (
    <div className="space-y-1 rounded border border-blue-500 p-2"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}>
      <input className={inputCls} autoFocus placeholder="Name, e.g. Park at back" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea className={`${inputCls} font-mono`} rows={4} placeholder={'One command per line, e.g.\nG53 G0 Z-5\nG53 G0 X0 Y-10'}
        value={gcode} onChange={(e) => setGcode(e.target.value)} />
      <div className="flex items-center gap-1">
        <span className="flex-1 text-[10px] text-gray-500 dark:text-neutral-500">
          {lines} line{lines === 1 ? '' : 's'} · blank lines and ; comments are skipped
        </span>
        <button className={btnCls} onClick={onCancel}>Cancel</button>
        <button className={`${btnCls} border-blue-500`} disabled={!ok} onClick={() => onSave({ name: name.trim(), gcode })}>Save</button>
      </div>
    </div>
  )
}
