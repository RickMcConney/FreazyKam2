import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CopyPlus, Folder, FolderOpen, Search } from 'lucide-react'
import { ICON } from '../../theme'
import { useToolStore, folderOf, MY_TOOLS, type Tool } from '../../store/toolStore'
import { useWorkpieceStore, fmtLen, fromMM } from '../../store/workpieceStore'
import { TOOL_TYPE_ICON, TOOL_TYPE_LABEL, TYPE_ORDER } from '../toolTypes'

// A form's tool picker, in two halves.
//
// THE DROPDOWN IS SHORT ON PURPOSE: My Tools — the user's own rack, what nearly every pick
// comes from — then the few catalogue bits used lately, then "Browse library…". A vendor
// catalogue is 80 bits, and as options of a native select it buried the user's own six.
// The current tool is always listed, wherever it is filed, or the select would show blank.
//
// BROWSE LIBRARY opens a dialog with room to compare: folders down the side, a search
// across all of them, and the numbers that tell two near-identical bits apart. Only the
// tools this form can cut with are offered — the same `tools` the dropdown gets.

const BROWSE = '\u0000browse'
const selectCls = 'w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 disabled:opacity-60'

export function ToolPicker({ id, tools, value, onChange, none, emptyText, label }: {
  id?: string
  tools: Tool[]                                // the tools this form can use
  value: string
  onChange: (id: string) => void
  none?: { value: string; label: string }      // a "no tool" choice ahead of the tools
  emptyText?: string                           // shown, disabled, when there is no tool to pick
  label?: (t: Tool) => string
}) {
  const units = useWorkpieceStore((s) => s.units)
  const recentIds = useToolStore((s) => s.recentToolIds)
  const noteToolUsed = useToolStore((s) => s.noteToolUsed)
  const [browsing, setBrowsing] = useState(false)
  const text = label ?? ((t: Tool) => `${t.name} (Ø${fmtLen(t.diameterMM, units)})`)

  const mine = tools.filter((t) => folderOf(t) === '')
  // Recent catalogue bits, newest first, then the current tool if it is not among them.
  const others = useMemo(() => {
    const byId = new Map(tools.map((t) => [t.id, t]))
    const list = recentIds.map((r) => byId.get(r)).filter((t): t is Tool => !!t && folderOf(t) !== '')
    const cur = byId.get(value)
    if (cur && folderOf(cur) !== '' && !list.includes(cur)) list.unshift(cur)
    return list
  }, [tools, recentIds, value])
  const canBrowse = tools.length > mine.length + others.length || tools.some((t) => folderOf(t) !== '')

  const pick = (id: string) => {
    onChange(id)
    if (tools.some((t) => t.id === id)) noteToolUsed(id)
  }

  return (
    <>
      <select id={id} value={value} disabled={tools.length === 0 && !none} className={selectCls}
        onChange={(e) => { if (e.target.value === BROWSE) setBrowsing(true); else pick(e.target.value) }}>
        {tools.length === 0 && !none && <option value="">{emptyText ?? 'No suitable tool — add one in the Tool Library'}</option>}
        {none && <option value={none.value}>{none.label}</option>}
        {others.length > 0 ? (<>
          {mine.length > 0 && (
            <optgroup label={MY_TOOLS}>{mine.map((t) => <option key={t.id} value={t.id}>{text(t)}</option>)}</optgroup>
          )}
          <optgroup label="Recent from other folders">
            {others.map((t) => <option key={t.id} value={t.id}>{text(t)} — {folderOf(t)}</option>)}
          </optgroup>
        </>) : mine.map((t) => <option key={t.id} value={t.id}>{text(t)}</option>)}
        {canBrowse && <option value={BROWSE}>Browse library…</option>}
      </select>
      {browsing && <ToolBrowserDialog tools={tools} value={value} onPick={pick} onClose={() => setBrowsing(false)} />}
    </>
  )
}

const byLibraryOrder = (a: Tool, b: Tool) =>
  (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || (a.diameterMM - b.diameterMM)
  || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

function ToolBrowserDialog({ tools, value, onPick, onClose }: {
  tools: Tool[]
  value: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  const units = useWorkpieceStore((s) => s.units)
  const copyToMyTools = useToolStore((s) => s.copyToMyTools)
  const folders = useMemo(() => {
    const named = [...new Set(tools.map(folderOf).filter((f) => f !== ''))]
    return ['', ...named]
  }, [tools])
  const current = tools.find((t) => t.id === value)
  const [folder, setFolder] = useState(current ? folderOf(current) : '')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  // A search looks in every folder — finding a bit is the point, not knowing where it is.
  const rows = useMemo(() => tools
    .filter((t) => (q ? t.name.toLowerCase().includes(q) : folderOf(t) === folder))
    .sort(byLibraryOrder), [tools, folder, q])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const choose = (id: string) => { onPick(id); onClose() }
  const len = (mm: number) => fmtLen(mm, units)
  const feed = (mm: number) => `${Math.round(fromMM(mm, units) * (units === 'in' ? 10 : 1)) / (units === 'in' ? 10 : 1)}`
  const th = 'px-2 py-1.5 text-left text-label font-semibold uppercase tracking-wider text-gray-600 dark:text-neutral-400 whitespace-nowrap'

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[min(980px,94vw)] h-[min(640px,86vh)] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">Choose a tool</h2>
          <div className="ml-auto flex items-center gap-1.5 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 w-72 focus-within:border-blue-500">
            <Search size={ICON.sm} className="text-gray-500 dark:text-neutral-500" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search every folder"
              className="flex-1 bg-transparent text-body text-gray-900 dark:text-neutral-100 focus:outline-none" />
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-52 flex-shrink-0 border-r border-gray-200 dark:border-neutral-700 overflow-y-auto py-1">
            {folders.map((f) => {
              const open = !q && f === folder
              const n = tools.filter((t) => folderOf(t) === f).length
              return (
                <button key={f || '(mine)'} onClick={() => { setFolder(f); setQuery('') }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-body text-left ${
                    open ? 'bg-blue-600 text-white' : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700'
                  }`}>
                  {open ? <FolderOpen size={18} /> : <Folder size={18} />}
                  <span className="flex-1 truncate">{f || MY_TOOLS}</span>
                  <span className={open ? 'text-blue-100' : 'text-gray-500 dark:text-neutral-500'}>{n}</span>
                </button>
              )
            })}
          </div>

          <div className="flex-1 overflow-auto">
            {rows.length === 0 ? (
              <p className="p-4 text-body text-gray-600 dark:text-neutral-400">
                {q ? `No tool this operation can use matches "${query.trim()}".` : 'No tool in this folder suits this operation.'}
              </p>
            ) : (
              <table className="w-full border-collapse text-body">
                <thead className="sticky top-0 bg-gray-100 dark:bg-neutral-800">
                  <tr className="border-b border-gray-200 dark:border-neutral-600">
                    <th className={th} style={{ width: '4.5rem' }} />
                    <th className={th}>Name</th>
                    {q && <th className={th}>Folder</th>}
                    <th className={th}>Type</th>
                    <th className={th + ' text-right'}>Ø</th>
                    <th className={th + ' text-right'}>Angle</th>
                    <th className={th + ' text-right'}>Flutes</th>
                    <th className={th + ' text-right'}>RPM</th>
                    <th className={th + ' text-right'}>Feed {units === 'in' ? 'in' : 'mm'}/min</th>
                    <th className={th} style={{ width: '2.5rem' }} />
                  </tr>
                </thead>
                <tbody className="text-gray-700 dark:text-neutral-300">
                  {rows.map((t) => (
                    <tr key={t.id} onClick={() => choose(t.id)}
                      title={`Use ${t.name}`}
                      className={`group border-b border-gray-200/70 dark:border-neutral-700/60 cursor-pointer ${
                        t.id === value ? 'bg-blue-600/20' : 'hover:bg-gray-100 dark:hover:bg-neutral-700/60'
                      }`}>
                      <td className="px-2 py-1"><img src={TOOL_TYPE_ICON[t.type]} alt="" className="h-7 w-14 object-contain" /></td>
                      <td className="px-2 py-1 text-gray-900 dark:text-neutral-100">{t.name}</td>
                      {q && <td className="px-2 py-1 text-gray-600 dark:text-neutral-400 whitespace-nowrap">{folderOf(t) || MY_TOOLS}</td>}
                      <td className="px-2 py-1 text-gray-700 dark:text-neutral-300 whitespace-nowrap">{TOOL_TYPE_LABEL[t.type]}</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">{len(t.diameterMM)}{t.type === 'taper' ? ' tip' : ''}</td>
                      <td className="px-2 py-1 text-right">{t.type === 'vbit' || t.type === 'taper' ? `${t.vbitAngleDeg ?? ''}°` : '—'}</td>
                      <td className="px-2 py-1 text-right">{t.fluteCount}</td>
                      <td className="px-2 py-1 text-right">{t.rpm}</td>
                      <td className="px-2 py-1 text-right">{t.type === 'drill' ? '—' : feed(t.xyFeedMmMin)}</td>
                      <td className="px-2 py-1 text-center">
                        {folderOf(t) !== '' && (
                          // Pick it AND file it as one the user owns — from then on it is in
                          // the short dropdown with the rest of their rack.
                          <button title={`Copy to ${MY_TOOLS} and use the copy`}
                            onClick={(e) => { e.stopPropagation(); const id = copyToMyTools(t.id); if (id) choose(id) }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-600 dark:text-neutral-400 hover:text-blue-500 hover:bg-blue-900/20 transition-colors">
                            <CopyPlus size={20} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-200 dark:border-neutral-700 text-label text-gray-600 dark:text-neutral-400">
          <span>Only tools this operation can cut with are listed. Click a row to use it.</span>
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
